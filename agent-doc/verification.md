# 验证

本页记录 Plastic Wan 的验证层级。不要用单一 `bun test` 代替真实 Provider、Telegram 或媒体工具链验证，也不要把自然语言回复当作内部 Tool 成功证据。

## 静态与单元验证

```bash
bun run check
bun test
```

按改动范围可先运行目标测试：

```bash
bun test test/telegram-ingestion.test.ts test/startup-catch-up.test.ts test/participation.test.ts
bun test test/scheduler.test.ts test/sleep.test.ts
bun test test/context-store.test.ts test/context-gc.test.ts test/context-hot-inject.test.ts
bun test test/context-send.test.ts test/cut-topic.test.ts
bun test test/agent-runtime.test.ts test/model-request-audit.test.ts
bun test test/skills.test.ts test/system-resources.test.ts
bun test test/media.test.ts test/stickers.test.ts
bun test test/mcp.test.ts test/web-fetch.test.ts
bun test test/operations.test.ts test/foundation.test.ts test/schema.test.ts
bun test test/admin.test.ts test/model-switch.test.ts
bun test test/bot-commands.test.ts
bun test test/memory.test.ts
bun test test/alarm.test.ts test/alarm-internal-context.test.ts
bun test test/prompt-template.test.ts test/prompt-markdown.test.ts test/tui-configure.test.ts
```

上面的命令按改动范围组织；新增测试文件时同步补充对应命令与下表契约。完整测试集以 `test/*.test.ts` 为准，`bun test` 运行全部测试。

| 测试 | 主要契约 |
| --- | --- |
| `foundation.test.ts` | 严格配置（含 `agent.context` 与 `agent.rate_limits`）、Secret 脱敏、迁移与备份 |
| `schema.test.ts` | Drizzle 层 bigint/boolean 往返、STRICT 与 CHECK 约束、bun IMMEDIATE 事务回滚、`sql` 模板绑定与 FTS5 查询 |
| `telegram-ingestion.test.ts` | allowlist、Revision、Bot/Service、Topic 隔离 |
| `participation.test.ts` | 全局/每 Chat 规则合并、私聊配置拒绝、跨午夜时段、触发与注意力窗口、暂停/编辑边界、启动追赶与清理 |
| `startup-catch-up.test.ts` | 每 Chat 一个追赶 Invocation、`history_messages` 上限、`ignored_user_ids` 与 `sticker_trigger_enabled` 生效、排空后切换实时 Bucket、Reply 的 Topic 路由 |
| `scheduler.test.ts` | 配置 deadline、冻结快照、恢复和并发串行 |
| `sleep.test.ts` | 5% 阈值边界与 `zzz` 可见性、跨轮次工具注册表、睡眠状态只随注入批次下发而不进入 system prompt、睡眠跳过 due/queued 会话、跨进程持久化、UTC 预算重置唤醒、并发 `zzz` 幂等 |
| `context-store.test.ts` | `AgentMessage` 编解码往返与过滤、保留段结构守卫、canonical history 追加与 checkpoint/send 计数、system prompt 变化触发重建、`advanceHead` 淘汰行并回收其引用、整段清空、capability 引用按 Context 隔离与 TTL |
| `context-gc.test.ts` | 丢弃式 GC 计划：send 数未超上限且无 token 压力时不动、滑到仍保留 `retained_sends_target` 次 send 的最新 checkpoint、没有可用 checkpoint 时不裁剪、Tool 多 send 少时退回 token 判据、保留段会以 `toolResult` 开头时放弃 |
| `context-hot-inject.test.ts` | 空闲等待期间到期的 Bucket 注入同一 Invocation（`invocation_buckets` 两行、一次运行两次模型调用）、`/pause` 立即打断空闲等待、`idle_grace_seconds = 0` 退回一 Bucket 一 Invocation 但 transcript 仍连续、同 Chat 另一个 Topic 不 attach、attach 未注入的 Bucket 重新排队、已 closing 的运行不再接收 attach |
| `context-send.test.ts` | Context 可见性、Reply capability、滑动窗口内的 `send` 速率限制与 `send_rate_limited` 审计、未知网络结果不重试 |
| `cut-topic.test.ts` | `/cut_topic` 切点排除命令消息及更早历史、切点前移、按 Chat 隔离、非管理员拒绝、重建服务后仍生效、同时清空该 Conversation 的 Conversation Context |
| `agent-runtime.test.ts` | 按 Conversation 播种的 Agent、Tool 循环、每批注入的 turn 预算、transcript 隔离与工具可见性审计 |
| `skills.test.ts` | Skill 索引注入 system prompt、原语不经 execute、`execute` search/help/call、`{text, refs}` 封套驱动 `search_stickers → send` 贴纸链路、记忆经 execute 写入、原语/未知能力拒绝的审计 |
| `system-resources.test.ts` | Skill manifest 校验与启动失败、`system:///` 绝对/相对 URI 解析、越界与非 Markdown 拒绝、32 KiB 截断、progressive disclosure fixture |
| `model-request-audit.test.ts` | `request_json` 中 inline base64 图片被结构化摘要替换、其余请求数据保留、重复清洗幂等 |
| `media.test.ts` | 图片标准化、缓存和 Vision reasoning |
| `stickers.test.ts` | Set 同步、结构化视觉 Tool Call、索引、搜索、发送 |
| `mcp.test.ts` | stdio/HTTP transport、策略、Header、重定向和审计 |
| `web-fetch.test.ts` | 有界不可信文本结果与审计、私网/合成地址拒绝（含跳转目标） |
| `operations.test.ts` | Retention、备份轮换、Scheduler 关闭 |
| `admin.test.ts` | Admin 首次设置、登录、Session、只读审计 API（含 Conversation Context 列表/详情与写入尝试被拒）、静态托管 |
| `model-switch.test.ts` | 可切换模型仅列 text 能力、默认取配置值、切换只对下次会话生效、未知 provider/model 与 image-only 拒绝 |
| `bot-commands.test.ts` | 命令解析与 mention 匹配、`setMyCommands` 注册一致性、`/pause` 中止与阻断、`/resume` 恢复、`/status` 用量与 Context 行口径、`/model` 分页与切换、管理员鉴权与匿名拒绝、命令只审计不入库 |
| `memory.test.ts` | 记忆持久化与 TTL、Conversation 隔离、Tool 审计、注入批次内 `<memory_list>` 的顺序与作用域、Admin 记忆 CRUD |
| `alarm.test.ts` / `alarm-internal-context.test.ts` | Alarm 创建/触发/取消、creator-vs-target ownership、latest-new caller 解析、跨 invocation hidden mapping、状态变化安全失败、send 不泄漏、重启后 durable internal context |
| `prompt-template.test.ts` | Prompt 模板白名单变量渲染、未知与格式错误表达式拒绝 |
| `prompt-markdown.test.ts` | HTML 注释剔除、纯注释行移除、跨行注释与未闭合注释保留 |
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
- `agent.context` 与 `agent.rate_limits` 的越界值被拒绝；已删除的 `agent.max_turns`/`agent.max_sends`/`agent.timeout_seconds` 会被严格对象模式拒绝，旧配置必须一起改。
- 配置改变后，不要继续使用旧进程的哈希。

## Doctor

按 [运行与运维：Doctor](operations.md#doctor) 执行检查；需要核对 Prompt 模板时使用该节的 `--output-agent-prompt` 命令，避免把 Prompt 正文转发到共享日志。

通过标准：命令成功退出、JSON 中 `status = ok`，以下依赖探针均成功；启用 Prompt 输出时还应核对 `agent_prompt` 的渲染结果。

检查覆盖：

- SQLite/FTS/磁盘。
- Sharp、FFmpeg、FFprobe、python-lottie。
- Agent Provider 文本与严格 Tool Call。
- Vision 图片请求。
- Telegram Bot Token。
- required MCP。

Doctor 成功只证明连接与最小能力，不证明真实群聊调度、Reply、Sticker capability 或“不回复”行为。

## 本地服务冒烟

按[运行与运维：启动与停止](operations.md#启动与停止)启动服务。以下是通过标准；运行方式、停止步骤与 lock 排障以该页为准：

1. 出现一次 `startup_catch_up_completed`，随后出现一次 `serve_started`。
2. `bot_id` 与预期 Bot 一致，`config_hash` 与 `check-config` 一致。
3. 运行 30 秒以上没有退出/重启。
4. `serve.lock` 阻止第二实例。
5. `Ctrl+C` 后 Scheduler、数据库和 lock 正常收尾。

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
8. Overview 的 Bot status 卡片显示 `sleeping`/`awake` 与 `sleep_until`，睡眠时 `Wake now` 带二次确认；同时列出所有 `chat_pause` Chat 与暂停时间。
9. Alarms 页面按 state/Chat/Target 过滤，pending 优先置顶，展开显示完整诊断并链接到对应 Tool session；取消只对 pending 开放且需二次确认，对非 pending 给出 409 冲突提示。
10. Bot admins 页面能添加/移除管理员，`telegram.admins` 的种子项来源显示为 `config`。
11. Model 页面显示当前/默认模型；切换后 Telegram `/status` 立即反映新模型，恢复默认后回到 `config.jsonc` 的值。
12. Conversation Contexts 页面按 chat/conversation/search 过滤，列表按最近活跃倒序并可用 Load more 翻页；详情显示 head/next seq、保留消息数与 capability refs，展开消息看到 `payload_preview` 与截断标记，且不出现已 GC 的行。
13. 登出后访问深链接回落登录页；重新登录恢复访问。
14. `admin_users.password_hash` 以 `$argon2id$` 开头，`admin_sessions` 只有 64 位十六进制摘要。

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
- `agent.context.idle_grace_seconds` 大于 0 时，Invocation 是运行窗口：运行期间到期的 Bucket 通过 `agent.steer()` 注入**同一个** Invocation，不新开会话；日志出现 `bucket_attached`，随后是同 Invocation 的第二次 `context_injected`。
- 注入粒度是 Bucket：运行期间连续发送多条消息，仍先进入各自 Topic 的 `collecting` Bucket，等满自己的窗口才成为一批；`steer` 在 turn 边界可见，长 Tool 批次期间到达的消息要等该批次结束才进入上下文。
- 同一 Chat 的 Invocation 仍串行：运行期间另一个 Forum Topic 到期的 Bucket 不 attach，等该 Chat 空闲后才开新 Invocation。
- attach 但从未注入的 Bucket 在运行结束时重新排队（`invocation_buckets.injected_at` 为 NULL，日志 `bucket_requeued`），不会被静默丢弃。
- Forum Topic 消息各自收集；一个 Topic 的会话不会让另一个 Topic 的消息混入 Context。
- 前一个 Invocation 短于窗口：下一 Bucket 仍等满自己的窗口（`first_received_at + bucket_window_seconds`）才启动，不因上一轮提前结束而缩短。
- 前一个 Invocation 长于窗口：运行期间已到期的 Bucket 在结束后立即处理；运行结束前一个窗口内才创建、尚未到期的 Bucket 仍等满自己的窗口。
- 前一个 Invocation 结束且没有新消息：不创建新的 Invocation。
- 运行期间（无论运行了多久）群里再发消息：该消息进入新的 `collecting` Bucket 并**等满自己的窗口**才注入（`deadline_at - first_received_at >= bucket_window_seconds`），不是立刻注入；连续快速发多条也只成为同一批。
- 运行开始后一个窗口内发消息：同样等满自己的窗口，不出现几毫秒就注入的「秒回」（回归：吸附到运行起点网格时实测 805 ms）。
- `idle_grace_seconds = 0` 是唯一受支持的降级：到期 Bucket 不再 attach，退回“一次 Bucket 一次 Invocation”，节拍不变。
- 不同 Chat 的 Invocation 可以并发。
- Bucket 冻结前编辑：使用新 Revision；冻结后编辑：已注入的批次不变，之后的 history 使用新 Revision。

### 长活 Invocation 与 Conversation Context

这一节的检查在真实群里只能靠日志与数据库对照，不能只看 Telegram 上的回复：

- 同一次运行里连续回答两条消息：`invocations` 只有一行、`invocation_buckets` 有两行，两次 `context_injected` 的 `invocation_id` 相同而 `seq` 递增，`buckets` 两行都以 `completed` 收尾。
- 重启进程后继续同一 Conversation：新 Invocation 的 `model_calls.request_json` 仍带着重启前的 transcript（含上次的 assistant 文本与 `send` 结果），`conversation_contexts.head_seq` 保持不变；`context_rebuilt` 只在 system prompt 或 Chat instructions 变化时出现，出现即表示整段上下文已重建。
- 连续对话直到保留段超过 `retained_sends_max`：日志出现 `context_gc`，`target_seq` 落在 checkpoint 上、保留段仍含至少 `retained_sends_target` 次 `send`；之后请求里不再出现被淘汰的那几轮，`head_seq` 与日志一致。
- 被 GC 淘汰的消息携带的引用立即失效：引用旧 `img_`/`stk_`/reply 的 `send` 必须被拒绝，而不是照旧发出。
- 睡眠状态只随注入批次下发：`zzz` 暴露前后两次请求的 system prompt 逐字节相同，睡眠状态出现在注入批次的 `<runtime_state>` 里；`zzz` 结束时 Invocation 的 `completion_reason` 是 `sleep`。
- `send_nudge_enabled = true` 且模型持续只写私文本：每个批次的提醒紧跟该批次（`agent_messages` 里 `harness_nudge` 排在下一次注入的 batch 之前，`telegram_sends` 逐批出现），而不是整段运行只提醒一次、其余批次的回复全部丢掉。
- `/cut_topic`：日志出现 `context_cleared`，`conversation_contexts.head_seq = next_seq` 且 `context_refs` 清空，下一条消息不再看到切点前的 transcript（Telegram 上切了历史、模型仍记得的旧故障形态不应再出现）。
- `/status` 的 Context 行显示该 Conversation 的保留消息数、保留 send 数与 `head_seq`，以及 `未 GC` 或上次 GC 时间；尚未建立 Context 时显示 `Context: 尚未建立`。

### 输出与 Reply

- Bot 回复必须对应 `send` Tool Call 和 `telegram_sends` success。
- 普通 Assistant Message 不应直接出现在 Telegram。
- Reply 只能指向当前 Conversation Context 授权且未过期的 Message；被 GC 淘汰的消息携带的 reply 引用立即失效。
- Agent 可以 completed 且 `sends_used = 0`，这是正常静默。

### 图片与 Sticker

- 使用 image-capable Agent 发送 Photo/图片 Document：首轮 User Message 直接包含标准化图片，不产生 `read_image` 或 `vision_chat`。
- 使用 text-only Agent 发送 Photo/图片 Document：Context 提供 `image_ref`（`img_` token），`read_image` 成功且产生 `vision_chat` 审计。
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

### Skills 与 execute

- system prompt 包含完整 Skill 索引；模型未读取任何 Skill 也能直接调用 `send`。
- 让模型处理匹配某个 Skill 的任务：审计出现 `read` 的 `system:///skills/...` 成功行，随后是 `execute` 调用行。
- 贴纸请求走「`execute.call search_stickers` → 封套 `refs.sticker_ref` → `send kind=sticker`」链路；`tool_calls` 中 `execute` 与 `search_stickers` 各自成功。
- 模型尝试 `execute.call send/zzz/read/execute`：审计记录 `execute_primitive_rejected`，消息未发出。
- 上下文收尾轮次仍可直接 `send`；`zzz` 暴露与休眠终止不受 Skill 加载影响。

### MCP

仅在配置 MCP 时执行：

- required Server 失败会阻止启动。
- optional Server 失败进入 degraded，不伪装 ready。
- allowlisted Tool 可调用并审计。
- 未配置策略/超时/超大小结果被拒绝。
- Streamable HTTP 重定向被拒绝；静态 Header 生效且不进入日志。

## 审计验收

对一次真实交互至少核对：

```text
telegram_updates
  → messages/message_revisions/media
  → buckets/bucket_messages + invocation_buckets
  → invocations/invocation_messages
  → model_calls
  → tool_calls
  → telegram_sends 或 media_analyses
```

`invocations` 不再与 Bucket 一一对应：`invocation_buckets` 记录哪些 Bucket 进入过哪次运行，只有 `injected_at` 非 NULL 的批次才真正送达模型。模型实际保留的输入不在这条链上，而在 `conversation_contexts`/`context_messages`/`context_refs`：判断“模型现在还看得见什么、还能用哪些引用”要看这里，不要从 `invocation_messages` 推断。

结论必须区分：

- Telegram 表面回复成功。
- Invocation 成功。
- 具体 Tool 成功。
- Vision/MCP 子调用成功。

曾出现“Bot 对 Sticker 给出自然回复，但 `read_image` 实际失败”的情况；只有审计链能识别这种降级。

## 备份与恢复验证

按[运行与运维：备份](operations.md#备份)执行备份命令。检查：

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
