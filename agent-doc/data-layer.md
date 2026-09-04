# 数据层

Plastic Wan 使用单个 SQLite 数据库保存消息、调度状态、能力索引、预算与审计。数据库不是长期记忆；在线保留窗口由必填的 `retention.online_days` 指定（dev 示例为 30 天）。

## 打开与迁移

`SqliteStore.open` 使用 Bun SQLite，并启用：

- `strict: true`
- `safeIntegers: true`
- WAL journal
- `synchronous = FULL`
- foreign keys
- 5 秒 busy timeout

迁移文件位于 `src/store/migrations/`，文件名为 `NNN_name.sql`，按编号排序。每个迁移在 IMMEDIATE transaction 中执行并记录到 `schema_migrations`。已有数据库存在待执行迁移时，先在备份目录创建 `pre-migration-*.sqlite`。

新增迁移时：

1. 创建下一个连续编号文件。
2. 使用 SQLite STRICT 表和显式 CHECK/FOREIGN KEY。
3. 不修改已发布迁移。
4. 更新依赖新字段的查询与测试。
5. 验证从空数据库和旧版本数据库升级。

## 查询层（Drizzle）

业务查询统一走 `SqliteStore.orm`（drizzle-orm 0.45.2 `bun-sqlite` 驱动的同步 API）；`store.db` 仅供连接层自身（迁移、备份、`VACUUM INTO`）、`doctor.ts` 探针与测试验证断言使用。表定义在 [src/store/schema.ts](../src/store/schema.ts)，是迁移终态的类型化映射——新增迁移必须同步更新它。

约定：

- 只用同步方法 `.all()/.get()/.run()/.values()`；禁止 `await orm...`（bun 原生事务回调是同步的）。
- 事务：模块持有 `SqliteStore` 时用 `store.transaction(fn)`（IMMEDIATE）；仅持有 `Orm` 时用 `orm.transaction(fn, { behavior: 'immediate' })`。
- SQLite dialect 没有 bigint 列模式：ID/计数值列用 `sqliteBigInt`（customType，读写 `bigint`），自增主键用 `sqliteBigIntId`（insert 可省略 id，新 id 用 `.returning({ id }).get()`）；0/1 标志列用 `integer(..., { mode: 'boolean' })`。
- 该驱动把 `.run()` 的类型标为 `void`（运行时返回 `{ changes, lastInsertRowid }`）；需要 `changes` 时用 `asRunResult`（`database.ts`）。
- 复杂 SQL（多表 JOIN、子查询、`NOT EXISTS`、`COALESCE`、FTS5 `MATCH`/`bm25()`、动态拼列）保留 `sql` 模板：`orm.all<Row>(sql\`...\`)`；`${}` 一律是绑定参数（禁止拼 SQL 字符串；受控常量片段用 `sql.raw`）。FTS5 虚拟表 `sticker_search` 不进 schema，只能走 `sql` 模板。
- 驱动陷阱：`orm.get(sql\`...\`)` 对裸 SQL 返回列值数组而非对象——单行裸 SQL 用 `.all<Row>(sql\`...\`).at(0)` 判 `undefined`。
- 测试中的裸 SQL 审计断言保留原样：验证层独立于被验证的实现是本仓库的测试惯例。

## 表组

31 张表的列定义见 [src/store/schema.ts](../src/store/schema.ts) 与 `src/store/migrations/`，表名本身基本自解释。下面只记录 schema 读不出来的语义。

### 冻结与重放边界

`invocation_messages` 是可重放边界，保存 `history`/`new` 两个区段的 Message Revision 快照。消息在 Invocation 创建后被编辑只影响未来 Context，不改写已经冻结的快照。`buckets` 区分 `realtime`（配置长度窗口）与 `startup_catch_up`（启动追赶）两种来源，状态机相同。`agent_messages` 是 Agent 内部 transcript——**Assistant 文本不等于 Telegram 发送**，真正发出去的只有 `telegram_sends` 里的行。

### 隐藏工作上下文

`internal_contexts` 保存同一 Conversation 中先前 Tool 结果产生的隐藏观察。当前实现由 `list_alarm` 持久化 `alarm_list`/`v1`，payload 内含稳定 `kind` discriminator、`version`、`observed_at` 与有序 `items`（`id`/`scheduled_at`/`summary`），并通过 `source_agent_message_id` 关联产生该观察的内部 transcript 行。

### Alarm owner

`alarms.created_by_user_id` 是可信 owner：新建 alarm 时由应用从冻结 invocation 的最新 `new` user sender 写入。迁移历史行允许为 `NULL`，这些旧行不会被用户 list/delete，也不会把 target 冒充 creator 回填。

### 短期记忆

`memories` 由 Agent 通过 `add_memory`/`delete_memory` 维护，也可在 Admin Panel 手工增删改查：

- 每条记忆归属一个 `conversations` 行（Chat + Forum Topic 隔离，互不可见）。
- `content` 硬限制 150 字符（SQLite `CHECK` 兜底；Tool Schema 与 Admin API 先校验）。
- `expires_at` 由 `created_at + ttl_seconds` 决定，默认 TTL 1 天；过期行在每次写操作机会性清除，`purgeExpiredData` 也会清除。
- 系统不禁止长 TTL；剩余寿命超过 `agent.memory_ttl_warning_days`（默认 30 天）的记忆在 Admin Panel 显示 warning，由管理员决定保留、删除或提升进 `agents.md`。

### 工具可见性审计

`invocations.tool_registry_hash` 之外还有 `tool_registry_json`：本次 Invocation 实际展示给模型的完整工具快照（`name`/`label`/`description`）；hash 覆盖名称、描述和参数 Schema，Tool 使用策略变化也会产生新 hash。`model_calls.tools_json` 记录该次请求真正附带的工具名数组——Agent 循环在 context 接近上限时会把工具裁剪到只剩 `send`，因此同一 Invocation 内不同请求的工具列表可能不同；这两列共同回答“模型当时能看到哪些工具”。

`model_calls.request_json` 保存 Provider 请求审计快照，但不会复制 `data:image/*;base64,...` 图片正文；对应字符串会替换为包含 MIME、Base64 字符数、解码字节数与 SHA-256 的结构化摘要，真实 Provider 请求不受影响。`side_effect_started` 和 `outcome_unknown` 用于阻止不可逆 Tool 的盲目重试。审计记录应保留稳定错误码；不要依赖解析自由文本错误。

### 媒体与 Sticker 缓存

`media_analyses` 按 `file_unique_id + analysis_version` 缓存视觉结果。Sticker 分析在 Set 仍受配置允许时可长期保留；普通图片分析按在线保留窗口清理。`vision.prompt_version`、Provider 和 Model 都参与分析版本，避免不同规则错误复用缓存。FTS5 虚拟表 `sticker_search` 不进 Drizzle schema，只能走 `sql` 模板。

### MCP 与 Admin

MCP 只有 `mcp_server_state` 一张自己的表（Server 状态、Tool registry hash、重连次数、错误码）；Tool 调用复用 `tool_calls`，预算复用 `daily_usage`。

Admin 侧的 `admin_users`/`admin_sessions`/`bot_admins` 语义见 [admin-panel.md](admin-panel.md#数据表)。密码明文和 Session Token 原文都不入库；`admin_users` 与 `admin_sessions` 不参与在线保留清理（管理员账号不是会话数据），过期 Session 由 `AdminAuth` 在认证、新建 Session 和服务启动时删除。`chat_pause` 记录 `/pause` 暂停的 Chat，`chat_context_cutoffs` 记录 `/cut_topic` 的每 Chat 上下文切点（Telegram message ID），仅影响新 Invocation 的 history。

## ID 与 JSON 规则

- SQLite 整数 ID 在 TypeScript 中使用 `bigint`。
- Telegram Chat/Message ID 进入 JSON 快照时字符串化，避免超出 JavaScript 安全整数。
- 原始 Update 不整体永久保存；只保存需要审计和重放的受限片段。
- 读取 `snapshot_json`、`telegram_json`、`metadata_json` 时必须在使用前校验结构。

## 保留清理

`backup` 在备份前调用 `purgeExpiredData`。清理仅删除已完成终态和不再被活跃引用的数据：

- 已过期的 `memories`（按自身 TTL，不参与 30 天在线窗口）。
- 过期 Telegram Update 与终态 Invocation/Send/Bucket。
- 不再被 Invocation/Bucket 引用的旧 Message。
- 仍被快照引用的旧 Message 保留身份，但匿名化 Revision 文本、Sender、Reply/Forward 和 Service 内容。
- 删除无引用 Sender、过期普通图片分析、独立 Doctor 模型调用与旧预算日期。
- Sticker 长期视觉索引不按普通图片策略删除。
- `alarms` 的 `pending`/`firing` 行保留（未来仍需执行）；`fired`/`cancelled` 终态行随在线审计窗口清理。
- `internal_contexts` 不是长期 memory，也不单独配置 TTL；它随在线会话窗口清理，默认保留到 `created_at < now - retention.online_days` 时删除。

不要把 `DELETE FROM messages WHERE received_at < ...` 当作等价实现；外键和冻结快照要求分阶段清理。

## 备份

```bash
bun run src/cli.ts backup --config dev-data/config.jsonc
```

流程：

1. 打开现有 SQLite 并启用与服务一致的 PRAGMA。
2. 执行保留清理。
3. 使用 `VACUUM INTO` 写入同目录临时文件。
4. 非 Windows 系统将临时文件设为 `0600`。
5. 原子 rename 为 `plasticwan-<timestamp>-<uuid>.sqlite`。
6. 按修改时间保留 `retention.backup_copies` 份。

systemd timer 每天 UTC 00:00 调用该命令。恢复或复制前应额外运行 `PRAGMA integrity_check`；当前备份命令不替代恢复演练。

## 本地路径

开发配置通常使用：

```text
dev-data/
├── config.jsonc
└── data/
    ├── plasticwan.sqlite
    ├── plasticwan.sqlite-wal
    ├── plasticwan.sqlite-shm
    ├── media/
    └── backups/
```

`dev-data/` 已 gitignore。不得提交数据库、WAL/SHM、媒体缓存、备份或真实配置。
