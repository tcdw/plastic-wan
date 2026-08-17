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

1. Update 仍经过 allowlist、去重、Revision 与媒体持久化，但不创建常规 15 秒 Bucket。
2. `app_state.telegram_startup_catch_up` 保存本轮起点；进程在排空或建任务时崩溃，下一次启动从同一起点完成，不丢失已确认 Update。
3. 每个有可处理人类消息的 Chat 只创建一个 `startup_catch_up` Bucket。
4. Bucket 仅包含该 Chat 按 Telegram 时间排序的最新 `agent.history_messages` 条本轮消息；Forum Topic 可以混合。
5. Snapshot 携带 `message_thread_id`。回复可见消息时，`send` 路由到该消息所属 Topic；不带 Reply 时路由到最新消息所属 Topic。
6. 排空完成并原子清除启动状态后，才切换到常规按 Conversation 收集。

当前 `dev-data/config.toml` 的 `agent.history_messages = 10`，因此每个群的启动追赶任务最多包含 10 条消息。

## 15 秒 Bucket

第一条可处理消息创建 `collecting` Bucket：

```text
first_received_at = T
fixed deadline     = T + 15s
```

后续消息加入该 Bucket，但不会滑动截止时间。到期后：

1. Bucket 从 `collecting` 进入队列。
2. Scheduler 冻结 `history` 与 `new` 快照。
3. 创建一个 Invocation。
4. 同一 Conversation 已有运行任务时，新任务继续排队；过多队列可合并。
5. Chat 每日 Invocation/Token 预算不足时进入 `skipped_budget`。

Bot 自己通过 `send` 产生的消息写入可见历史，但不会再次触发收集循环。

## Context

`ContextBuilder` 生成：

- `systemPrompt`：安全边界、全局 Prompt、私聊/群聊参与策略、Chat instructions、当前时间。
- `userPrompt`：最近 history 与本 Bucket new messages。
- `directImages`：当 `agent` 模型支持 image 时，选中消息里的 Photo/图片 Document 经标准化后成为同一 User Message 的多模态内容。
- `visibleReplyMessageIds`：本次允许 Reply 的 Telegram Message ID。
- `imageCapabilities`：Sticker 始终可用；当 `agent` 模型不支持 image 时也包含 Photo/图片 Document，供 `read_image` 使用。
- `omittedNewMessages`：因 Context 上限省略的新消息数量。

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

限制来自配置：最大轮次、Tool Call 数、发送数、输出 Token、Invocation 超时和全局并发。模型调用与 Tool Call 分别写入审计。

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

## 常见排查顺序

1. `check-config` 输出是否为预期哈希。
2. `serve_started.config_hash` 是否一致。
3. `telegram_updates.allowed/rejection_reason`。
4. Bucket 与 Invocation 是否进入终态。
5. `model_calls` 是否 success，Token 是否计入。
6. `tool_calls` 与 `telegram_sends` 是否 success/outcome_unknown。
7. 媒体问题检查 `media_analyses` 和对应 Vision `model_calls`。

一次自然语言回复看似成功，不代表内部 Tool 都成功；必须以审计表为准。
