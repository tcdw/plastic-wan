# Admin 配置保存与重启开发计划

## 1. 结论与范围

Plastic Wan 不实现运行时热加载。Admin Panel 保存配置后，服务采用“写入候选配置 → 优雅关闭 → 原地替换当前进程”的完整重启；因此不存在“旧 Agent Session 继续使用旧配置、新 Session 使用新配置”的并存语义。

本计划针对当前单实例服务，不设计多租户、配置世代、配置分布式锁或配置版本仓库。

### 目标

- 让已认证管理员通过 Admin Panel 修改允许的运行策略。
- 修改前完整校验候选配置，避免把不可启动配置直接写入生产文件。
- 保存成功后立即安排一次服务重启。
- 复用 Ctrl+C/SIGTERM 既有 graceful shutdown 语义。
- 保存前保留一份上一份成功配置，启动失败时由管理员显式恢复。
- 为配置变更保留 SQLite 审计记录。

### 非目标

- 不监听 `config.toml` 或 Prompt 文件变化。
- 不在进程内替换 Provider、MCP、Sticker worker 或 AgentRuntime。
- 不自动回滚失败配置。
- 不自动重试失败启动。
- 不允许 Admin 修改 Bot 身份、数据位置或 Admin 监听位置。
- 不支持多个配置版本同时排队生效。

## 2. 已确定的行为契约

### 配置入口

- 唯一自动生效入口是已认证的 Admin 保存 API。
- 直接编辑配置文件不会触发重启；人工编辑后仍需手动重启服务。
- 保存请求必须携带当前运行配置的 `base_config_hash`。
- Hash 不匹配返回 `409 config_changed`；前端必须刷新配置并重新编辑，不静默合并旧 patch。
- 保存期间进程内设置 `restartScheduled`/draining 状态：
  - 后续读请求可继续处理；
  - 第二次保存和其它写操作返回 `409 restart_in_progress`；
  - 不允许两个保存同时安排 exec。

### 编辑协议

使用受限 JSON patch DTO，不接受任意 TOML 文本、任意 JSON Pointer 或完整配置对象。服务端从当前已加载配置构造候选配置，再执行完整 Schema、语义、Prompt 引用和权限校验。

第一版允许修改的内容属于运行策略：

- Telegram Chat/Topic allowlist；
- Bucket 窗口与消息阈值；
- Agent/Vision 的模型选择、轮次、Tool/Send/Token/超时/并发等限制；
- Chat instructions 和全局 Prompt 内容；
- 已配置 Sticker Set；
- 已配置 MCP 的启用状态、Tool allowlist、只读策略、超时、大小和预算；
- retention 策略。

实现时必须把可写路径写成显式白名单，并为 Chat、Topic、Sticker Set、MCP Tool 等集合定义专用 upsert/remove 操作；不得用通用深层 merge 放大授权范围。

以下内容禁止由该 API 修改：

- `version`；
- `data_dir` 与全部 `paths.*`；
- `telegram.token`；
- Provider/API key、SecretRef、Provider endpoint 和其它凭据；
- `admin.enabled`、`admin.host`、`admin.port`、`admin.static_dir`；
- 任何未列入白名单的字段。

Prompt 内容如果通过 API 编辑，必须只写入当前配置已经引用的受控 Prompt 文件；禁止 patch 提供任意文件路径。Prompt 文件的路径解析、symlink/path traversal 检查和原子临时文件写入必须复用配置目录的安全约束。

### 保存响应

保存成功且候选文件已原子提交后，API 返回：

```json
{
  "status": "restart_scheduled",
  "config_hash": "<new hash>"
}
```

HTTP 状态为 `202 Accepted`。响应只承诺候选配置已通过校验、已写入并已安排重启，不承诺新进程已经成功启动。

保存响应写回后异步触发 shutdown；不要等待新进程，也不要让 HTTP 请求跨进程悬挂。

### 进程重启

- 保存请求触发的关闭必须复用 Ctrl+C/SIGTERM 路径。
- Admin HTTP、Scheduler、Sticker worker、MCP、SQLite、ServeLock 按现有 `finally` 顺序清理。
- Scheduler 继续使用现有最多 30 秒的 graceful stop；running Invocation 的 `aborted`、`outcome_unknown` 和 `process_restart` 审计语义不改。
- 清理完成后使用当前 Bun 的 `process.execve` 原地替换进程镜像，保留原始 argv、环境和 `serve --config <path>` 参数。
- 不 spawn 第二个 serve 进程，不提前退出让 systemd 猜测，不让新旧进程同时持有 Telegram long polling 或 ServeLock。
- Windows 与 Linux 都必须验证 `execve` 后 ServeLock、SQLite 和 Telegram polling 的行为。

## 3. 上一份成功配置备份

只保留一份上一份成功配置，不建立多版本快照系统。建议位置：

```text
data_dir/
└── config-backup/
    ├── manifest.json
    ├── config.toml
    └── prompts/
        └── ...
```

生产部署中对应 `/var/lib/plasticwan/config-backup/`；不能写入受 `ProtectSystem=strict` 保护的 `/etc/plasticwan`。

备份规则：

1. 保存 API 提交前，先把当前已成功运行的配置输入集合备份到临时目录。
2. 临时目录完成后原子替换 `config-backup`；备份失败则不改正式配置。
3. 候选 `config.toml` 与涉及的 Prompt 文件使用临时文件 + 原子 rename 写入。
4. 新进程在 grammY `bot.start({ onStart })` 回调边界确认已进入 polling 后，把当前配置输入集合更新为新的 `last-known-good`。
5. 若新配置启动失败，正式配置文件保留失败候选；上一份成功备份不覆盖、不删除。
6. 不自动恢复、不自动 exec 重试。管理员修复文件或执行显式恢复命令后再启动。

`last-known-good` 可能包含 literal SecretRef 或 Prompt 敏感内容，目录和文件必须按受限权限创建；Admin API 不返回备份正文，只返回存在、hash、时间和恢复状态。备份清理遵循现有在线数据 30 天策略，但第一版实际只保留一份备份。

配置文件和多个 Prompt 文件不能与 SQLite 组成单一事务。实现必须接受“硬崩溃时人工恢复”的边界；不为此引入 pending generation、restart token 或启动恢复状态机。每个文件仍必须单独使用临时文件和原子替换，避免读到半截文件。

提供显式 CLI 恢复命令，例如：

```powershell
bun run src/cli.ts restore-config --config dev-data/config.toml
```

恢复命令要求服务已停止，先校验备份 bundle，再将上一份成功配置恢复到正式配置输入位置；恢复后由管理员正常启动服务。命令不得自动启动第二个 serve 实例。

## 4. `config_changes` 审计

新增连续编号 SQLite migration 和 `config_changes` 表。表只记录配置保存尝试及其结果，不保存完整配置副本。

至少包含：

- `id`（SQLite `INTEGER`，TypeScript `bigint`）；
- `admin_user_id`；
- `created_at`；
- `base_config_hash`；
- `new_config_hash`（候选生成成功后填写）；
- `patch_json` 或脱敏后的 patch 摘要；
- `result`/`error_code`；
- `restart_scheduled` 标记或等价结果字段。

审计约束：

- SecretRef、API key、Token、完整 Prompt 正文不得写入审计记录或日志；对敏感值只记录路径、操作和摘要/hash。
- `config_changed`、`restart_in_progress`、Schema/语义校验失败等拒绝结果也应有稳定错误码；不要依赖自由文本判断。
- 不新增独立 startup 表，不为每次普通启动创建配置变更行。
- 新进程启动结果以现有 `serve_started.config_hash` 和 `startup_failed` 结构化日志为准；`config_changes` 不承担跨进程健康握手。
- 文件提交与 SQLite INSERT 不假装是一个事务。成功提交后写成功审计；硬崩溃造成的极小审计缺口由启动日志和配置 hash 排查，不增加恢复状态机。

Admin API 可提供配置变更列表，但只返回管理员、时间、hash、修改路径、结果和错误码，不返回配置文件、SecretRef 或 Prompt 正文。

## 5. 推荐实现顺序

### 阶段 A：配置输入与备份

1. 抽出“读取当前 TOML + Prompt 输入集合”的可复用函数。
2. 实现显式 patch DTO、字段白名单、集合操作和敏感值拒绝。
3. 实现候选配置生成和完整 `loadConfig` 校验。
4. 实现配置 bundle 的临时写入、原子替换和上一份成功配置备份。
5. 实现 `restore-config` CLI，并覆盖备份缺失、损坏、路径不安全和服务运行中的拒绝。

### 阶段 B：审计与 Admin API

1. 添加 `config_changes` migration、查询类型和清理策略。
2. 在 AdminServer 中增加已认证 `PATCH /api/config`（最终路径可沿用仓库路由命名约定，但不能开放未认证或任意 TOML 上传）。
3. 在进程内加入单次保存锁、`base_config_hash` CAS 和 draining 状态。
4. 增加稳定的 400/409/500 错误码及 `202 restart_scheduled` 响应。
5. 前端增加配置表单、当前 hash、冲突刷新、校验错误、重启中和服务恢复提示。

### 阶段 C：优雅重启与新进程

1. 让 AdminServer 通过显式回调请求 application 层 shutdown/restart，不让 AdminServer 自己调用 `process.exit`。
2. 保存响应 flush 后触发现有 shutdown；第二次请求不得重复触发。
3. 在 `application.ts` 的 cleanup 完成后执行 `process.execve`，保留 CLI 参数和环境。
4. 在 grammY `onStart` 中输出当前 `config_hash` 的成功启动事件；启动异常沿用脱敏错误路径并输出 `startup_failed`。
5. 验证运行中的 Invocation、MCP、Sticker worker、SQLite 和 ServeLock 都按既有关闭顺序结束。

### 阶段 D：文档与验收

同步更新：

- `agent-doc/admin-panel.md`：配置 API、认证、202、draining 和重启状态；
- `agent-doc/configuration.md`：不热加载、Admin 保存入口、锁定字段和 hash CAS；
- `agent-doc/operations.md`：保存后重启、启动失败、备份恢复命令；
- `agent-doc/data-layer.md`：`config_changes` migration、字段和保留；
- `agent-doc/verification.md`：配置保存与重启验收矩阵；
- `agent-doc/README.md`：加入本计划入口，完成实现后将链接保留为当前行为文档入口或删除计划链接。

## 6. 验收标准

### API 与安全

- 未认证保存返回 401。
- 跨 Origin POST 按现有规则拒绝。
- 缺少或错误 `base_config_hash` 返回 409，旧 patch 不会被合并。
- 任意未白名单字段、SecretRef、Token、路径、Admin 监听字段和任意文件路径均被拒绝。
- 两个并发保存只有一个成功；另一个返回 `409 restart_in_progress` 或 `409 config_changed`，不发生双重 exec。
- TOML、Prompt 引用、时区、Chat/Topic、Provider/Model、MCP 和预算语义校验失败时正式配置不改变。

### 文件、审计与恢复

- 正式配置永远不是半截文件。
- 候选提交前上一份成功配置可恢复。
- `config_changes` 保存管理员、旧/新 hash、修改路径/脱敏摘要和结果。
- literal SecretRef、Token 和完整 Prompt 正文不出现在 Admin 响应、审计 JSON 或日志中。
- 新配置启动失败后服务保持停止，失败配置保留，上一份成功配置仍可用；不会自动回滚或重启风暴。
- `restore-config` 在服务停止时恢复上一份成功配置，并拒绝损坏或不存在的备份。

### 进程生命周期

- `202` 在旧进程开始 shutdown 前可正常返回。
- 保存后只出现一次 graceful shutdown 和一次 exec。
- Scheduler 最多等待 30 秒；Invocation 审计符合现有 `aborted`/`outcome_unknown` 规则。
- 新进程输出与 `check-config` 一致的 `serve_started.config_hash`，并进入 grammY `onStart`。
- exec 后没有第二个 ServeLock、SQLite 连接或 Telegram long polling 实例。
- Linux systemd 与 Windows 本地前台运行都覆盖保存、重启、失败和显式恢复场景。

## 7. 明确不要做的事

- 不添加 config watcher。
- 不把热加载包装成“新旧 Invocation 配置代际”。
- 不保存多份配置快照。
- 不做自动回滚、自动重试或启动失败循环。
- 不为低频单实例配置编辑引入分布式锁、配置 generation、restart token、独立 startup 表或多租户模型。
