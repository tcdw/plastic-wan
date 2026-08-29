# Telegram 与 Agent 流程

## 接收边界

服务使用 grammY long polling，只订阅：

- `message`
- `edited_message`
- `my_chat_member`

群聊不要求 mention Bot。是否处理消息只由配置和代码决定，不由 Prompt 决定。

`TelegramIngestion` 对每个 Update 先写 `telegram_updates` 审计，再判定：

1. Chat 类型是否支持。
2. Chat ID 是否在 `telegram.chats`。
3. Forum Topic 是否在可选 `topic_ids`。
4. 消息是否来自 Bot/Service，以及 `process_bot_messages` 是否允许。
5. 单独的人类 Sticker 是否允许按 `sticker_trigger_enabled` 创建 Bucket；该开关默认关闭。
6. Message/Edited Message 结构是否可归一化。

拒绝的 Update 不进入 Bucket，但保留稳定 `rejection_reason`，例如 `chat_not_allowed`、`topic_not_allowed`。排查 allowlist 时同时比较配置哈希；配置不会热重载。

## Chat、Conversation 与 Topic

- Telegram Chat 归一化到 `chats`。
- Supergroup 迁移通过 `chat_migrations` 把旧 ID 指向 canonical Chat。
- Conversation 由 Chat 与真正的 Forum Topic 组成。仅当 Supergroup 的 `chat.is_forum = true` 且消息的 `is_topic_message = true` 时，才使用 `message_thread_id` 隔离 Conversation。
- 私聊、普通群消息及非 Forum Supergroup 的普通回复线程统一使用 thread ID `0`；Telegram 在普通回复中提供的 `message_thread_id` 不作为 Topic。
- 不同 Forum Topic 的 Bucket、Context、Reply 和预算相互隔离；启动追赶是显式的 Chat 级例外。

## Message Revision

`messages` 保存 Telegram Message 的稳定身份；每次首次接收或编辑产生一条 `message_revisions`：

- Text/Caption
- Sender user 或 sender_chat
- Reply 快照
- Forward origin
- Media group ID
- Service 片段
- 受限原始 JSON 片段
- 关联 Media

相同内容的重复 Update 不创建无意义 Revision。截止时间到达时，Scheduler 冻结当时最新 Revision；截止后的编辑只进入未来 Invocation 的 history。

## 启动追赶

普通重启在启动 Scheduler 和常规 long polling 前，以非阻塞 `getUpdates` 排空 Telegram pending updates：

1. Update 仍经过 allowlist、去重、Revision 与媒体持久化，但不创建常规实时 Bucket。
2. `app_state.telegram_startup_catch_up` 保存本轮起点；进程在排空或建任务时崩溃，下一次启动从同一起点完成，不丢失已确认 Update。
3. 每个有可触发消息的 Chat 只创建一个 `startup_catch_up` Bucket；单独的人类 Sticker 仍受 `sticker_trigger_enabled` 限制。
4. Bucket 仅包含该 Chat 按 Telegram 时间排序的最新 `agent.history_messages` 条本轮消息；Forum Topic 可以混合。
5. Snapshot 携带 `message_thread_id`。回复可见消息时，`send` 路由到该消息所属 Topic；不带 Reply 时路由到最新消息所属 Topic。
6. 排空完成并原子清除启动状态后，才切换到常规按 Conversation 收集。

当前 `dev-data/config.jsonc` 的 `agent.history_messages = 20`，因此每个群的启动追赶任务最多包含 20 条消息。

## 会话节拍与 Bucket

Chat（群）空闲时，第一条可触发消息创建该 Conversation 的 `collecting` Bucket，并先等待一个完整节拍：

```text
first_received_at = T
first session      = T + telegram.bucket_window_seconds
```

`telegram.bucket_window_seconds` 是全局配置，接受 0–300 的整数秒；`0` 表示新消息可以立即触发，不表示持续轮询。**Agent 会话按 Chat 串行**，消息收集仍按 Conversation 隔离：

1. 不同 Forum Topic 的消息各自进入自己的 `collecting` Bucket；Context 与 Reply 只包含本 Topic 内容，互不混入。
2. 同一 Chat 同时最多一个 queued/running Invocation；会话运行期间任何 Topic 的新消息只进入自己的 Bucket，不修改当前 Invocation。
3. 下一次允许启动的时间为 `max(前一会话 started_at + bucket_window_seconds, 前一会话 finished_at)`，按 Chat 计算。
4. 前一会话短于一个节拍时，等待满节拍；长于一个节拍时，结束后立即处理下一 Bucket。
5. 没有新的可触发消息时不创建 Bucket，也不启动空会话。`sticker_trigger_enabled` 默认为 `false`：单独的人类 Sticker 不开 Bucket，但可以加入已有 collecting Bucket；设为 `true` 后可以单独触发。
6. 到达启动时间后，Scheduler 冻结 `history` 与 `new` 快照、预留预算并创建 Invocation。

因此，如果 Agent 会话耗时为 0 且群友持续发送消息，会话开始时间固定相隔 `bucket_window_seconds`，与该群有多少活跃 Topic 无关。Bot 自己通过 `send` 产生的消息写入可见历史，但不会触发下一 Bucket。

## Context

`ContextBuilder` 生成：

- `systemPrompt`：安全边界、图片处理说明、全局 Prompt、私聊/群聊参与策略、Chat instructions、记忆列表、当前时间。
- `userPrompt`：仅列出已允许且索引成功 Sticker 的 `<untrusted_sticker_catalog>`（`sticker_id:emoji`），随后是最近 history 与本 Bucket new messages。
- `directImages`：当 `agent` 模型支持 image 时，选中消息里的 Photo/图片 Document 经标准化后成为同一 User Message 的多模态内容。
- `visibleReplyMessageIds`：本次允许 Reply 的 Telegram Message ID。
- `imageCapabilities`：Sticker 始终可用；当 `agent` 模型不支持 image 时也包含 Photo/图片 Document，供 `read_image` 使用。
- `omittedNewMessages`：因 Context 上限省略的新消息数量。

当前 Conversation 全部有效记忆按创建时间升序注入（`<memory_list>` 块）：固定 Prompt → 记忆列表 → 当前时间。新增记忆等价于列表末尾 append，不重排已有项，尽量保留 Provider prefix cache；TTL 到期与 `delete_memory` 只破坏删除位置之后的缓存前缀。

当前时间必须留在 system prompt 最末：它每次 Invocation 都变，放在记忆列表之前会让缓存前缀在时间戳处就断掉，记忆的 append-only 顺序也就白费了。

私聊策略提示模型积极参与；群聊提示只在有明确价值时发言。它是行为偏好，不绕过 Tool 或预算授权。

Context 受模型窗口限制：为系统提示、Tool Schema、历史、新消息和输出保留空间。超过 `context_stop_ratio` 后停止继续 Tool 循环，避免下一轮超窗。

## Agent 循环

每次 Invocation 使用 Fresh Agent：

```text
Context
  → model turn
  → zero or more Tool Calls
  → Tool Results
  → next model turn
  → completed / failed / aborted / outcome_unknown
```

限制来自配置：全局每日 Token 预算、最大轮次、Tool Call 数、发送数、输出 Token、Invocation 超时和全局并发。模型调用与 Tool Call 分别写入审计。`add_memory`/`delete_memory` 是持久化副作用，按 Conversation 隔离并计入 `tool_calls` 审计；`send` 仍是唯一 Telegram 输出边界。

每次模型请求都会附带完整的工具注册表（名称、label、描述与参数 Schema）。请求发出前把该请求实际附带的工具名写入 `model_calls.tools_json`，Invocation 的可用注册表快照（`name`/`label`/`description`）写入 `invocations.tool_registry_json`——因此可以审计“模型在某一轮到底看到了哪些工具”。context 接近上限时，Agent 循环只保留 `send` 和已经可用的 `zzz` 继续收尾。

普通 Assistant Message 永不自动发布。模型不调用 `send` 即表示保持沉默，这在群聊中是正常成功结果。`agent.send_nudge_enabled` 开启时，若模型已草拟足够长的私有文本却未调用 `send`，harness 会在会话自然结束前注入一次 `steer` 提醒；提醒后仍不调用则静默放行，文本不出 Telegram。

## 睡眠

全局当日 `model_tokens` 剩余比例严格低于 5% 时，当前 Agent 才会看到 `zzz`；恰好 5% 不可见。全局用量是所有 Chat 的主 Agent 与聊天触发 `read_image` 用量之和，同时保留各 Chat 的归属统计。运行中的会话越过阈值后，在下一次 model turn 边界更新工具注册表，不为此额外创建会话。

`zzz` 把全局 `bot_sleep_until` 写入 `app_state`，取 `max(调用时间 + 8 小时, 下一次 UTC 日预算重置)`。写入使用 SQLite IMMEDIATE transaction，重复或并发调用保持同一状态。调用后当前会话停止下一轮模型请求，后续实际 Tool Call 被阻止。

睡眠期间 Telegram Update、Message、Revision 与 Bucket 仍照常保存；Scheduler 将到期 Bucket 和尚未启动的 queued Invocation 标记为 `skipped_budget`/`sleeping`，不创建新 Agent。首次在 `sleep_until` 之后检查状态时原子删除该键并恢复调度，因此状态可跨进程重启且不会因预算提前重置而提前唤醒。

管理员调大预算后可在 Admin Overview 手动解除睡眠；`POST /api/wake` 原子删除该键并唤醒 Scheduler，重复调用幂等。已因睡眠跳过的 Bucket 不会重放，后续到期 Bucket 与新消息恢复正常调度。

## Alarm / Deferred Invocation

Agent 通过 `alarm` Tool 创建一个绑定当前 conversation 的未来 Invocation，而不是延迟发送预生成文本：

1. Tool 校验 `target_user_id` 必须是当前 Invocation 实际可见消息中的 Telegram **user** sender（sender_chat 与任意 ID 拒绝）、`summary` 为 1–500 字符任务说明、`datetime` 为带显式 offset/`Z` 的绝对时间且严格未来、不超 365 天；同一 Invocation 最多成功创建 3 个。
2. 成功创建是副作用，写入 `alarms`（含原 conversation/Forum Topic、目标 ID 与显示名快照、UTC deadline、`created_by_invocation_id`），并返回 Alarm ID/scheduled UTC。
3. Scheduler 的动态等待同时考虑最近 Bucket deadline 与最近 pending Alarm `scheduled_at`；到期 Alarm 在 Chat 空闲时原子 `pending → firing`，再创建不携带任何 Telegram Update/Message/Revision 的真实 `alarm` Invocation。
4. Alarm Invocation 仍走普通 Context/Agent/send pipeline；系统提示临时加入任务说明（summary 是任务描述，不是待发送文本），首次成功文本 `send` 自动在开头加入目标用户的 Telegram text mention。
5. Alarm Invocation 绕过 Chat 每日调用预留、全局每日 Token gate 与预算触发的 `zzz`/sleep，且不暴露 `zzz`；仍受 pause、Chat/Topic 配置、同 Chat 串行、并发、timeout、最大轮次/Tool/send、capability 与 Telegram 错误约束。
6. Invocation 无论何种终态都关闭 Alarm 且不重试；进程恢复遗留 `firing` 关闭为 `fired`/`outcome_unknown`。到期时 Chat/Topic 停用、移出配置或 pause 则置 `cancelled` 并记录稳定原因。

## send Tool

`send` 是唯一 Telegram 输出边界，支持：

- 文本默认按纯文本发送；显式设置 `parse_mode: "MarkdownV2"` 时由 Telegram 按 MarkdownV2 解析。只提供 `text`（以及可选的 `reply_to_message_id`）时，`kind` 默认为 `text`。
- 配置允许且当前 capability 授权的 Sticker。
- 可选 Reply，但目标 Message ID 必须在当前 `visibleReplyMessageIds`。

发送前写 pending 审计并标记副作用边界。明确失败可按策略处理；网络中断后无法确认 Telegram 是否接收时记录 `outcome_unknown`，不能盲目重发。

`agent.send_max_text_length` 配置了文本最大字符数（默认不限制）时，超长文本在进入配额扣减前被拒绝：Tool Call 记为 `error`、错误码 `send_text_too_long`，不写 `telegram_sends`、不消耗 `sends_used`。

`agent.send_disallow_blank_lines` 开启（默认关闭）时，包含任何空行的文本同样在配额扣减前被拒绝，错误码 `send_blank_lines`。

成功发送后：

- `tool_calls` 记为 success。
- `telegram_sends` 保存 Telegram 返回 ID/时间。
- 发送内容写入可见消息历史。
- Agent 的私有 Assistant 文本仍不进入 Telegram。

## `web_fetch`

`web_fetch` 接受模型生成的单个 URL，只执行无 Cookie、无认证 Header 的 HTTP(S) GET。它只允许协议默认端口，最多跟随 3 次跳转；每一跳都重新解析并校验目标，连接固定到已经校验的 IP，防止 DNS rebinding。

直接提交的环回、私网、链路本地、文档与保留地址会被拒绝。代理环境把公网域名解析到 `198.18.0.0/15` synthetic IP 时，仅允许“域名解析结果”使用该网段；模型直接提交该网段 IP 仍会被拒绝。

Tool 只返回文本、JSON、XML 或 JavaScript 响应，拒绝压缩和二进制内容。单次调用最多 15 秒、结果最多 32 KiB；结果前缀明确标记网页为不可信数据。调用参数、结果、耗时和失败码写入 `tool_calls`，`side_effect = false`。

## 用户图片模型分流

当 `agent` 模型支持 image 时，Photo 与受支持的图片 Document 随冻结 Context 直接送入主模型，不经过 `read_image` 或独立 `vision` 模型。Telegram Photo 只保留最高分辨率变体，避免同一照片重复占用模型输入。

当 `agent` 模型只有 text 输入时，普通图片不附到主模型请求，而是在 Context 中保留 Invocation-scoped `image_ref`。Agent 可按需调用 `read_image`，由独立 `vision` 模型返回文字描述。普通图片继续按 `file_unique_id + analysis_version` 缓存 30 天。

直传图片在首次 Agent 请求前下载到 `paths.media_cache` 临时目录，并执行下载大小、真实格式、像素数、EXIF 移除、最大边长与标准化输出大小限制；请求载荷完成构造后立即删除临时文件。下载或校验失败会使 Invocation 失败，不会把缺失图片伪装成成功。

## `read_image`

模型只能使用 Context 中展示的不透明 `image_ref`。多模态 Agent 只获得 Sticker 引用；text-only Agent 还会获得 Photo 与图片 Document 引用。Tool 不接受原始 Telegram file ID、任意 URL 或任意 Media ID。

处理流程：

1. 校验 capability、Invocation deadline 与全局 agent 每日 Token 预算。
2. 从 Telegram 下载到 `paths.media_cache` 下的临时目录。
3. 检查下载大小、图片格式、像素数和标准化输出大小。
4. 提取 Sticker 代表帧。
5. 调用 Vision 模型并审计 Token/图片预算。
6. 按 `file_unique_id + analysis_version` 缓存。
7. 删除临时文件。

Sticker 代表帧：

- Telegram thumbnail 优先。
- 静态 WEBP 直接标准化。
- 视频 WEBM 使用 FFprobe 获取时长、FFmpeg 提取中间帧。
- 动画 TGS 使用 python-lottie 导出指定中间帧 SVG，再由 Sharp 标准化。

Sticker 视觉元数据通过严格 Tool Call 返回：中文描述、情绪、动作、中英文标签。不要改回“提示模型输出 JSON 后直接 `JSON.parse`”；Provider 可能返回 Markdown code fence，曾导致真实 `read_image` 失败。

## Sticker 搜索与后台索引

启动时 `StickerService.sync` 拉取配置中的完整 Set：

- Set/Sticker 元数据写入 SQLite。
- 新增或版本变化的 Sticker 进入索引队列。
- 后台固定单并发，前台 Sticker `read_image` 优先。
- 分析成功后更新 `sticker_search` FTS5 trigram 索引。
- 失败记录次数与 `next_retry_at`，避免热循环。

`search_stickers` 支持语义查询，也支持一次解析最多 5 个目录 `sticker_id`；两种方式都只返回已允许、已成功索引的 Sticker，并生成仅限当前 Invocation 的 `sticker_ref`。目录 ID 与 Telegram file ID 都不能直接发送，`send` 只接受本次 `search_stickers` 返回的 capability。

## Bot Commands

`/pause`、`/resume` 与 `/status` 是 Chat 级控制命令，作用于发送命令的 Chat（含 Forum 全部 Topic），不按 Topic 隔离。`/cut_topic` 同样是 Chat 级命令。

- 判定：`message.entities` 中 offset 为 0 的 `bot_command`；命令名大小写不敏感；带 `@用户名` 后缀时必须匹配当前 Bot；Bot 发送者的消息不触发命令。未知命令与非命令消息照常入库。
- 启动时（`getMe` 后）调用 `setMyCommands` 自动注册 `/pause`、`/resume`、`/status`、`/model`、`/cut_topic` 及中文描述（`BOT_COMMANDS` 是唯一事实来源，注册前校验每个命令都能被 `parseBotCommand` 解析）；注册失败只记 `command_registration_failed`，不阻塞启动——命令菜单是便利设施，文本解析不依赖它。
- 命令消息只写 `telegram_updates` 审计，不写入 `messages`，因此不会创建 Bucket 或进入 Agent 历史。`parseBotCommand` 返回的命令附带 `messageId`（命令消息自身的 Telegram message ID），供 `/cut_topic` 记录切点使用。
- 回复是确定性 Bot 输出（不经模型），直接通过 Bot API 发送并 Reply 原命令消息，不经过 `send` Tool；发送失败只记 `command_reply_failed` 事件，不重试。

`/pause` 与 `/resume` 仅对 Bot 管理员开放（`bot_admins` 表，见下文）；`/status` 对任何成员开放。非管理员或匿名身份执行会收到拒绝回复，不产生任何状态变更。管理员执行命令时其显示名会刷新到 `bot_admins`。

`/model` 同样仅限管理员，用于运行时切换 agent 模型（与 Admin Panel「Model」页共享同一 `AgentModelSwitcher`）：`/model` 按每页 20 条列出当前模型与第一页可切换序号；`/model page 页码` 翻页，所有页面保留全局序号；`/model 纯数字序号` 直接切换对应模型（立即对后续 Invocation 生效）；`/model reset` 恢复 config.jsonc 默认。越界页码或无效参数返回提示且不改状态。

`/pause` 立即生效（与 scheduler 同一事件循环，无竞态）：

1. 写入 `chat_pause`（chat_id 为内部 `chats.id`）。
2. 该 Chat 所有 `collecting`/`queued` Bucket 置为 `expired`、`error_code = chat_paused`；对应 `queued` Invocation 置为 `aborted`、`completion_reason = chat_paused`。
3. Scheduler 中止该 Chat 正在运行的 Invocation（`pauseChat`）；正在飞行中的 `send` 可能已经落盘，属正常结果。

暂停期间消息仍入库并保留 Revision，但不创建 Bucket、不启动会话；`processDue` 与启动追赶也会跳过暂停 Chat（追赶 Bucket 记 `skipped_budget`/`chat_paused`）。`/resume` 删除 `chat_pause` 行，恢复正常节拍。

`/status` 返回当前生效的 `agent.provider` / `agent.model`（含 Admin Panel 热切换后的运行时模型）、`agent.thinking_level`、本 Chat 的当日 `model_tokens` 用量，以及全局当日用量、`agent.daily_budget.max_tokens` 上限与四舍五入到两位小数的用量百分比；所有 token 数量使用千位分隔符。并按该 Chat 的 Model Call 审计拆分显示 `read`、`write`、`cache read`、`cache write` token。日期口径均为 UTC；暂停中额外显示一行。

`/cut_topic` 仅对 Bot 管理员开放，用于在群聊上下文被旧话题污染时手动切断历史：

1. 把命令消息自身的 Telegram message ID 写入 `chat_context_cutoffs`（每 Chat 一行，重复执行即前移切点）。
2. 之后新建的 Invocation 在冻结 history 快照时排除 `telegram_message_id <= 切点` 的消息，命令消息本身也在切点上，因此不会进入下一个会话的上下文。
3. 不删除任何消息或 Revision；已排队/运行中的 Invocation 不受影响，启动追赶的 `new` 消息也不受影响。

## Bot 管理员列表

`bot_admins`（迁移 `008_bot_admins.sql`）保存可执行 `/pause`、`/resume` 的 Telegram 用户 ID，Bot 全局共享：

- 启动时 `telegram.admins`（JSONC 数组）以 `ON CONFLICT DO NOTHING` 播种，保证运营者始终保有控制权；面板新增的条目不会被种子移除。
- Admin Panel「Bot admins」页面（`GET/POST /api/admins`、`DELETE /api/admins/:id`）是运行时管理入口。
- 权限判定在 `BotCommandService`：命令发送者的 `message.from.id` 命中 `bot_admins` 才放行；`sender_chat` 匿名身份一律拒绝。

## 常见排查顺序

1. `check-config` 输出是否为预期哈希。
2. `serve_started.config_hash` 是否一致。
3. `telegram_updates.allowed/rejection_reason`。
4. Bucket 与 Invocation 是否进入终态。
5. `model_calls` 是否 success，Token 是否计入。
6. `tool_calls` 与 `telegram_sends` 是否 success/outcome_unknown。
7. 媒体问题检查 `media_analyses` 和对应 Vision `model_calls`。

一次自然语言回复看似成功，不代表内部 Tool 都成功；必须以审计表为准。
