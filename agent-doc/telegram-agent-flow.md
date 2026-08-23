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
5. Message/Edited Message 结构是否可归一化。

拒绝的 Update 不进入 Bucket，但保留稳定 `rejection_reason`，例如 `chat_not_allowed`、`topic_not_allowed`。排查 allowlist 时同时比较配置哈希；配置不会热重载。

## Chat、Conversation 与 Topic

- Telegram Chat 归一化到 `chats`。
- Supergroup 迁移通过 `chat_migrations` 把旧 ID 指向 canonical Chat。
- Conversation 由 Chat 与 `message_thread_id` 组成。
- 非 Forum/普通消息使用 thread ID `0`。
- 常规消息处理中，不同 Forum Topic 的 Bucket、Context、Reply 和预算相互隔离；启动追赶是显式的 Chat 级例外。

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
3. 每个有可处理人类消息的 Chat 只创建一个 `startup_catch_up` Bucket。
4. Bucket 仅包含该 Chat 按 Telegram 时间排序的最新 `agent.history_messages` 条本轮消息；Forum Topic 可以混合。
5. Snapshot 携带 `message_thread_id`。回复可见消息时，`send` 路由到该消息所属 Topic；不带 Reply 时路由到最新消息所属 Topic。
6. 排空完成并原子清除启动状态后，才切换到常规按 Conversation 收集。

当前 `dev-data/config.toml` 的 `agent.history_messages = 20`，因此每个群的启动追赶任务最多包含 20 条消息。

## 会话节拍与 Bucket

Chat（群）空闲时，第一条可处理消息创建该 Conversation 的 `collecting` Bucket，并先等待一个完整节拍：

```text
first_received_at = T
first session      = T + telegram.bucket_window_seconds
```

`telegram.bucket_window_seconds` 是全局配置，接受 0–300 的整数秒；`0` 表示新消息可以立即触发，不表示持续轮询。**Agent 会话按 Chat 串行**，消息收集仍按 Conversation 隔离：

1. 不同 Forum Topic 的消息各自进入自己的 `collecting` Bucket；Context 与 Reply 只包含本 Topic 内容，互不混入。
2. 同一 Chat 同时最多一个 queued/running Invocation；会话运行期间任何 Topic 的新消息只进入自己的 Bucket，不修改当前 Invocation。
3. 下一次允许启动的时间为 `max(前一会话 started_at + bucket_window_seconds, 前一会话 finished_at)`，按 Chat 计算。
4. 前一会话短于一个节拍时，等待满节拍；长于一个节拍时，结束后立即处理下一 Bucket。
5. 没有新的人类消息时不创建 Bucket，也不启动空会话。
6. 到达启动时间后，Scheduler 冻结 `history` 与 `new` 快照、预留预算并创建 Invocation。

因此，如果 Agent 会话耗时为 0 且群友持续发送消息，会话开始时间固定相隔 `bucket_window_seconds`，与该群有多少活跃 Topic 无关。Bot 自己通过 `send` 产生的消息写入可见历史，但不会触发下一 Bucket。

## Context

`ContextBuilder` 生成：

- `systemPrompt`：安全边界、图片处理说明、全局 Prompt、私聊/群聊参与策略、Chat instructions、记忆列表、当前时间。
- `userPrompt`：最近 history 与本 Bucket new messages。
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

限制来自配置：最大轮次、Tool Call 数、发送数、输出 Token、Invocation 超时和全局并发。模型调用与 Tool Call 分别写入审计。`add_memory`/`delete_memory` 是持久化副作用，按 Conversation 隔离并计入 `tool_calls` 审计；`send` 仍是唯一 Telegram 输出边界。

每次模型请求都会附带完整的工具注册表（名称、label、描述与参数 Schema）。请求发出前把该请求实际附带的工具名写入 `model_calls.tools_json`，Invocation 启动时把完整注册表快照（`name`/`label`/`description`）写入 `invocations.tool_registry_json`——因此可以审计“模型在某一轮到底看到了哪些工具”。context 接近上限时，Agent 循环只保留 `send` 继续收尾，该轮请求的 `tools_json` 会如实记录为 `["send"]`。

普通 Assistant Message 永不自动发布。模型不调用 `send` 即表示保持沉默，这在群聊中是正常成功结果。

## send Tool

`send` 是唯一 Telegram 输出边界，支持：

- 纯文本。
- 配置允许且当前 capability 授权的 Sticker。
- 可选 Reply，但目标 Message ID 必须在当前 `visibleReplyMessageIds`。

发送前写 pending 审计并标记副作用边界。明确失败可按策略处理；网络中断后无法确认 Telegram 是否接收时记录 `outcome_unknown`，不能盲目重发。

成功发送后：

- `tool_calls` 记为 success。
- `telegram_sends` 保存 Telegram 返回 ID/时间。
- 发送内容写入可见消息历史。
- Agent 的私有 Assistant 文本仍不进入 Telegram。

## 用户图片模型分流

当 `agent` 模型支持 image 时，Photo 与受支持的图片 Document 随冻结 Context 直接送入主模型，不经过 `read_image` 或独立 `vision` 模型。Telegram Photo 只保留最高分辨率变体，避免同一照片重复占用模型输入。

当 `agent` 模型只有 text 输入时，普通图片不附到主模型请求，而是在 Context 中保留 Invocation-scoped `image_ref`。Agent 可按需调用 `read_image`，由独立 `vision` 模型返回文字描述。普通图片继续按 `file_unique_id + analysis_version` 缓存 30 天。

直传图片在首次 Agent 请求前下载到 `paths.media_cache` 临时目录，并执行下载大小、真实格式、像素数、EXIF 移除、最大边长与标准化输出大小限制；请求载荷完成构造后立即删除临时文件。下载或校验失败会使 Invocation 失败，不会把缺失图片伪装成成功。

## `read_image`

模型只能使用 Context 中展示的不透明 `image_ref`。多模态 Agent 只获得 Sticker 引用；text-only Agent 还会获得 Photo 与图片 Document 引用。Tool 不接受原始 Telegram file ID、任意 URL 或任意 Media ID。

处理流程：

1. 校验 capability、Invocation deadline 与 Chat Vision 预算。
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

`search_stickers` 只返回已允许、已成功索引的 Sticker capability。`send` 只接受这些 capability，而不是模型给出的 file ID 或 Set 名称。

## Bot Commands

`/pause`、`/resume` 与 `/status` 是 Chat 级控制命令，作用于发送命令的 Chat（含 Forum 全部 Topic），不按 Topic 隔离。

- 判定：`message.entities` 中 offset 为 0 的 `bot_command`；命令名大小写不敏感；带 `@用户名` 后缀时必须匹配当前 Bot；Bot 发送者的消息不触发命令。未知命令与非命令消息照常入库。
- 启动时（`getMe` 后）调用 `setMyCommands` 自动注册 `/pause`、`/resume`、`/status`、`/model` 及中文描述（`BOT_COMMANDS` 是唯一事实来源，注册前校验每个命令都能被 `parseBotCommand` 解析）；注册失败只记 `command_registration_failed`，不阻塞启动——命令菜单是便利设施，文本解析不依赖它。
- 命令消息只写 `telegram_updates` 审计，不写入 `messages`，因此不会创建 Bucket 或进入 Agent 历史。
- 回复是确定性 Bot 输出（不经模型），直接通过 Bot API 发送并 Reply 原命令消息，不经过 `send` Tool；发送失败只记 `command_reply_failed` 事件，不重试。

`/pause` 与 `/resume` 仅对 Bot 管理员开放（`bot_admins` 表，见下文）；`/status` 对任何成员开放。非管理员或匿名身份执行会收到拒绝回复，不产生任何状态变更。管理员执行命令时其显示名会刷新到 `bot_admins`。

`/model` 同样仅限管理员，用于运行时切换 agent 模型（与 Admin Panel「Model」页共享同一 `AgentModelSwitcher`）：`/model` 按每页 20 条列出当前模型与第一页可切换序号；`/model page 页码` 翻页，所有页面保留全局序号；`/model 纯数字序号` 直接切换对应模型（立即对后续 Invocation 生效）；`/model reset` 恢复 config.toml 默认。越界页码或无效参数返回提示且不改状态。

`/pause` 立即生效（与 scheduler 同一事件循环，无竞态）：

1. 写入 `chat_pause`（chat_id 为内部 `chats.id`）。
2. 该 Chat 所有 `collecting`/`queued` Bucket 置为 `expired`、`error_code = chat_paused`；对应 `queued` Invocation 置为 `aborted`、`completion_reason = chat_paused`。
3. Scheduler 中止该 Chat 正在运行的 Invocation（`pauseChat`）；正在飞行中的 `send` 可能已经落盘，属正常结果。

暂停期间消息仍入库并保留 Revision，但不创建 Bucket、不启动会话；`processDue` 与启动追赶也会跳过暂停 Chat（追赶 Bucket 记 `skipped_budget`/`chat_paused`）。`/resume` 删除 `chat_pause` 行，恢复正常节拍。

`/status` 返回当前生效的 `agent.provider` / `agent.model`（含 Admin Panel 热切换后的运行时模型）、`agent.thinking_level` 与本日（UTC 日期，与 `daily_usage`/预算口径一致）该 Chat 的 `model_tokens` 用量及 `budget.max_tokens_per_day` 上限；暂停中额外显示一行。

## Bot 管理员列表

`bot_admins`（迁移 `008_bot_admins.sql`）保存可执行 `/pause`、`/resume` 的 Telegram 用户 ID，Bot 全局共享：

- 启动时 `telegram.admins`（TOML 数组）以 `ON CONFLICT DO NOTHING` 播种，保证运营者始终保有控制权；面板新增的条目不会被种子移除。
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
