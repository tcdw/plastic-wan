# 验证

本页记录 Plastic Wan 的验证层级。不要用单一 `bun test` 代替真实 Provider、Telegram 或媒体工具链验证，也不要把自然语言回复当作内部 Tool 成功证据。

## 静态与单元验证

```bash
bun run check
bun test
```

按改动范围可先运行目标测试：

```bash
bun test test/telegram-ingestion.test.ts test/startup-catch-up.test.ts
bun test test/scheduler.test.ts test/sleep.test.ts
bun test test/context-send.test.ts test/cut-topic.test.ts
bun test test/agent-runtime.test.ts test/model-request-audit.test.ts
bun test test/media.test.ts test/stickers.test.ts
bun test test/mcp.test.ts test/web-fetch.test.ts
bun test test/operations.test.ts test/foundation.test.ts test/schema.test.ts
bun test test/admin.test.ts test/model-switch.test.ts
bun test test/bot-commands.test.ts
bun test test/memory.test.ts
bun test test/alarm.test.ts test/alarm-internal-context.test.ts
bun test test/prompt-template.test.ts test/tui-configure.test.ts
```

这 23 个文件是当前测试集的全部；新增测试文件时同步补进下表，否则本页会失去“该跑哪些验证”的作用。

| 测试 | 主要契约 |
| --- | --- |
| `foundation.test.ts` | 严格配置、Secret 脱敏、迁移与备份 |
| `schema.test.ts` | Drizzle 层 bigint/boolean 往返、STRICT 与 CHECK 约束、bun IMMEDIATE 事务回滚、`sql` 模板绑定与 FTS5 查询 |
| `telegram-ingestion.test.ts` | allowlist、Revision、Bot/Service、Topic 隔离 |
| `startup-catch-up.test.ts` | 每 Chat 一个追赶 Invocation、`history_messages` 上限、`ignored_user_ids` 与 `sticker_trigger_enabled` 生效、排空后切换实时 Bucket、Reply 的 Topic 路由 |
| `scheduler.test.ts` | 配置 deadline、冻结快照、恢复和并发串行 |
| `sleep.test.ts` | 5% 阈值边界与 `zzz` 可见性、跨轮次工具注册表更新、睡眠跳过 due/queued 会话、跨进程持久化、UTC 预算重置唤醒、并发 `zzz` 幂等 |
| `context-send.test.ts` | Context 可见性、Reply capability、发送次数与未知结果 |
| `cut-topic.test.ts` | `/cut_topic` 切点排除命令消息及更早历史、切点前移、按 Chat 隔离、非管理员拒绝、重建服务后仍生效 |
| `agent-runtime.test.ts` | Fresh Agent、Tool 循环、预算、transcript 隔离与工具可见性审计 |
| `model-request-audit.test.ts` | `request_json` 中 inline base64 图片被结构化摘要替换、其余请求数据保留、重复清洗幂等 |
| `media.test.ts` | 图片标准化、缓存和 Vision reasoning |
| `stickers.test.ts` | Set 同步、结构化视觉 Tool Call、索引、搜索、发送 |
| `mcp.test.ts` | stdio/HTTP transport、策略、预算、Header、重定向和审计 |
| `web-fetch.test.ts` | 有界不可信文本结果与审计、私网/合成地址拒绝（含跳转目标） |
| `operations.test.ts` | Retention、备份轮换、Scheduler 关闭 |
| `admin.test.ts` | Admin 首次设置、登录、Session、只读审计 API 与静态托管 |
| `model-switch.test.ts` | 可切换模型仅列 text 能力、默认取配置值、切换只对下次会话生效、未知 provider/model 与 image-only 拒绝 |
| `bot-commands.test.ts` | 命令解析与 mention 匹配、`setMyCommands` 注册一致性、`/pause` 中止与阻断、`/resume` 恢复、`/status` 用量口径、`/model` 分页与切换、管理员鉴权与匿名拒绝、命令只审计不入库 |
| `memory.test.ts` | 记忆持久化与 TTL、Conversation 隔离、Tool 审计、system prompt 注入、Admin 记忆 CRUD |
| `alarm.test.ts` / `alarm-internal-context.test.ts` | Alarm 创建/触发/取消、creator-vs-target ownership、latest-new caller 解析、跨 invocation hidden mapping、状态变化安全失败、send 不泄漏、重启后 durable internal context |
| `prompt-template.test.ts` | Prompt 模板白名单变量渲染、未知与格式错误表达式拒绝 |
| `tui-configure.test.ts` | `configure` 向导输出可被 `loadConfig` 接受、models.dev 能力/费用映射、Provider `/models` 拉取与去重、CLI 参数与 `--output-agent-prompt` 解析 |

跨模块改动完成后运行全部测试与 TypeScript 检查。

## 配置验证

```bash
bun run src/cli.ts check-config --config dev-data/config.jsonc
```

检查：

- 输出 `status = ok`。
- `config_hash` 与预期文件一致。
- Chat ID、Topic、Provider alias、Model ID 和 MCP Tool policy 未被错误引用。
- 配置改变后，不要继续使用旧进程的哈希。

## Doctor

```bash
bun run src/cli.ts doctor --config dev-data/config.jsonc
```

如需同时验证 Prompt 模板的渲染结果：

```bash
bun run src/cli.ts doctor --config dev-data/config.jsonc --output-agent-prompt
```

该模式仍执行完整外部依赖冒烟，并在成功 JSON 中输出 `agent_prompt`。Prompt 正文可能包含内部配置，不要转发到共享日志。

这是外部依赖冒烟，覆盖：

- SQLite/FTS/磁盘。
- Sharp、FFmpeg、FFprobe、python-lottie。
- Agent Provider 文本与严格 Tool Call。
- Vision 图片请求。
- Telegram Bot Token。
- required MCP。

Doctor 成功只证明连接与最小能力，不证明真实群聊调度、Reply、Sticker capability 或“不回复”行为。

## 本地服务冒烟

启动：

```bash
bun run src/cli.ts serve --config dev-data/config.jsonc
```

验证：

1. 出现一次 `serve_started`。
2. `bot_id` 与预期 Bot 一致。
3. `config_hash` 与 `check-config` 一致。
4. 运行 30 秒以上没有退出/重启。
5. `serve.lock` 阻止第二实例。
6. `Ctrl+C` 后 Scheduler、数据库和 lock 正常收尾。

长期进程必须用进程监督器或人工前台运行；不要让测试命令无限阻塞。

## Admin Panel 冒烟

```bash
bun run admin:build
bun run src/cli.ts serve --config dev-data/config.jsonc
```

验证：

1. 出现一次 `admin_started`，host 为回环地址。
2. 首次打开 `http://127.0.0.1:<port>/` 渲染「创建管理员」表单，`GET /api/auth/session` 返回 `setup_required = true`。
3. 创建账号后 Overview 分别显示 Invocation、消息、媒体分析缓存与已配置 Sticker 索引状态。
4. Tool session 详情六个 Tab（Overview / Tool calls / Model calls / Telegram sends / Agent transcript / Frozen context）各自渲染；默认落在 Overview 时间线。
5. 消息搜索命中当前 Chat 的文本，详情展示全部 Revision。
6. Bot sticker sets 页面明确说明只包含 `telegram.sticker_sets` 中配置的 Set，并按 Set 与 `index_state` 过滤后行数变化。
7. Memories 页面按群聊与状态过滤，新建/编辑/删除记忆后列表刷新；剩余寿命超过 `memory_ttl_warning_days` 的记忆带 warning 标记。
8. 登出后访问深链接回落登录页；重新登录恢复访问。
9. `admin_users.password_hash` 以 `$argon2id$` 开头，`admin_sessions` 只有 64 位十六进制摘要。

未构建 bundle 时静态路由返回 503 `admin_bundle_missing`，API 仍可用；这不是启动失败。

## 真实 Telegram 验收

### Chat 与参与策略

- 私聊发送普通消息：无需 mention，Bot 可积极回复。
- 群聊发送普通消息：无需 mention，Bot 能观察但允许保持沉默。
- 群聊 mention Bot：仍通过相同配置窗口的 Bucket，不走特殊旁路。
- 未允许 Chat：`telegram_updates.allowed = 0`，原因是 `chat_not_allowed`。
- 新增 Chat 后未重启：旧进程仍拒绝；重启且哈希变化后允许。

### 时间窗口与 Revision

- 空闲 Chat 的第一条消息等待 `telegram.bucket_window_seconds` 后启动 Invocation。
- Invocation 运行期间连续发送多条：消息合并进各自 Topic 的下一 Bucket，同一群不会并发启动 Agent。
- Forum Topic 消息各自收集；一个 Topic 的会话不会让另一个 Topic 的消息混入 Context。
- 前一个 Invocation 短于窗口：下一 Invocation 从前一次开始算满窗口后启动。
- 前一个 Invocation 长于窗口：结束后若下一 Bucket 非空则立即启动。
- 前一个 Invocation 结束且没有新消息：不创建新的 Invocation。
- 不同 Chat 的 Invocation 可以并发。
- Bucket 冻结前编辑：使用新 Revision；冻结后编辑：旧 Invocation 不变，未来 history 使用新 Revision。

### 输出与 Reply

- Bot 回复必须对应 `send` Tool Call 和 `telegram_sends` success。
- 普通 Assistant Message 不应直接出现在 Telegram。
- Reply 只能指向当前 Context 可见 Message。
- Agent 可以 completed 且 `sends_used = 0`，这是正常静默。

### 图片与 Sticker

- 使用 image-capable Agent 发送 Photo/图片 Document：首轮 User Message 直接包含标准化图片，不产生 `read_image` 或 `vision_chat`。
- 使用 text-only Agent 发送 Photo/图片 Document：Context 提供 `image_ref`，`read_image` 成功且产生 `vision_chat` 审计。
- 同一 Telegram Photo 的多尺寸数组只保留最高分辨率变体。
- 发送从未分析的静态/视频/TGS Sticker：`read_image` 或后台索引触发视觉分析并写结构化元数据。
- 普通图片与 Sticker 再次读取：命中各自的 `file_unique_id + analysis_version` 缓存。
- Sticker 分析必须产生 `report_sticker_analysis` Tool Call；文本 JSON/code fence 不算成功。
- `search_stickers` 只返回允许 Set 中已索引 Sticker。
- `send` 不能使用模型虚构的 file ID。

### Forum Topic

- 允许 Topic：正常入库。
- 未允许 Topic：`topic_not_allowed`。
- 两个 Topic 的 Conversation、history、Bucket、Reply 和媒体 capability 不混合。

### MCP

仅在配置 MCP 时执行：

- required Server 失败会阻止启动。
- optional Server 失败进入 degraded，不伪装 ready。
- allowlisted Tool 可调用并审计。
- 未配置策略/超预算/超时/超大小结果被拒绝。
- Streamable HTTP 重定向被拒绝；静态 Header 生效且不进入日志。

## 审计验收

对一次真实交互至少核对：

```text
telegram_updates
  → messages/message_revisions/media
  → buckets/bucket_messages
  → invocations/invocation_messages
  → model_calls
  → tool_calls
  → telegram_sends 或 media_analyses
```

结论必须区分：

- Telegram 表面回复成功。
- Invocation 成功。
- 具体 Tool 成功。
- Vision/MCP 子调用成功。

曾出现“Bot 对 Sticker 给出自然回复，但 `read_image` 实际失败”的情况；只有审计链能识别这种降级。

## 备份与恢复验证

```bash
bun run src/cli.ts backup --config dev-data/config.jsonc
```

检查：

1. 生成新 `.sqlite`。
2. 数量不超过 `backup_copies`。
3. 对复制文件执行 `PRAGMA integrity_check` 返回 `ok`。
4. 在隔离目录使用备份启动或打开数据库。
5. 当前生产数据库、WAL、SHM 不被测试覆盖。

## 提交前检查

```bash
git diff --check
bun run check
bun test
```

最终报告应精确写明：

- 哪些命令通过。
- 哪些真实场景执行过。
- 哪些外部场景因 Token、Chat、Provider 或 MCP 不可用而未执行。
- 观察到的审计状态，而不是推测状态。
