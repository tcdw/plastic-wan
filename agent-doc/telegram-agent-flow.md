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
4. 消息的 `message.from.id` 是否命中当前 Chat 的 `ignored_user_ids`。
5. 消息是否来自 Bot/Service，以及 `process_bot_messages` 是否允许。
6. 单独的人类 Sticker 是否允许按 `sticker_trigger_enabled` 创建 Bucket；该开关默认关闭。
7. Message/Edited Message 结构是否可归一化。
8. 配置了 `participation` 的 Chat 在活跃时段外是否被这类消息命中触发，见「定时活跃与注意力窗口」。

拒绝的 Update 不进入 Bucket，但保留稳定 `rejection_reason`，例如 `chat_not_allowed`、`topic_not_allowed`。允许 Chat 内被 `ignored_user_ids` 命中的用户消息仍保留 Update 审计，但在 Message、命令和 Bucket 边界之前直接丢弃；其文本、媒体及后续编辑不会进入实时或启动追赶 Context，其他成员回复该用户时也不保存对应 Reply 快照。该过滤只匹配 Telegram user，不匹配 `sender_chat`，且不追溯删除配置生效前已入库的历史。排查 allowlist 时同时比较配置哈希；配置不会热重载。

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

## 会话节拍与 Bucket

Chat（群）空闲时，第一条可触发消息创建该 Conversation 的 `collecting` Bucket，并先等待一个完整节拍：

```text
first_received_at = T
first session      = T + telegram.bucket_window_seconds
```

`telegram.bucket_window_seconds` 是全局配置，接受 0–300 的整数秒；`0` 表示新消息可以立即触发，不表示持续轮询。**Agent 会话按 Chat 串行**，消息收集仍按 Conversation 隔离：

1. 不同 Forum Topic 的消息各自进入自己的 `collecting` Bucket；Context 与 Reply 只包含本 Topic 内容，互不混入。
2. 同一 Chat 同时最多一个 queued/running Invocation；运行期间任何 Topic 的新消息只进入自己的 Bucket，不修改当前 Invocation。
3. 每个 Bucket 的 deadline 只由它**自己的第一条消息**决定：`first_received_at + bucket_window_seconds`，按 Conversation 计算。它与前一次 Invocation 的 `started_at`/`finished_at` 和状态都无关。
4. 没有新的可触发消息时不创建 Bucket，也不启动空会话。`sticker_trigger_enabled` 默认为 `false`：单独的人类 Sticker 不开 Bucket，但可以加入已有 collecting Bucket；设为 `true` 后可以单独触发。
5. 到达 deadline 后，Scheduler 冻结 `history` 与 `new` 快照并创建 Invocation；若该 **Conversation** 已有 running Invocation，则改为 attach，见「长活 Invocation 与热注入」。
6. Invocation 结束时，该 Chat 仍 `collecting` 的 Bucket 若**已经到期**（或已在这次运行期间到期）会被立刻处理；尚未到期的保持自己的窗口不变。Scheduler 只会把 deadline 往后推（到 `max(finished_at, started_at + bucket_window_seconds)`），不会提前裁剪一个已建立的批次。

因此，如果 Agent 会话耗时为 0 且群友持续发送消息，会话开始时间相隔 `bucket_window_seconds`；一旦某一轮运行超过一个窗口，后续批次改由各自的第一条消息起算（可能比固定网格略晚），与该群有多少活跃 Topic 无关。Bot 自己通过 `send` 产生的消息写入可见历史，但不会触发下一 Bucket。

deadline 不看「前一次运行是否仍在 queued/running」。长活 Invocation 会立刻消费到期的 Bucket，若把「运行中」当成「立刻到期」，运行超过一个窗口后每条消息都会各自变成零长度 Bucket 并各自注入一批（实测：1.4 秒内 6 条消息 → 6 次注入），节拍就没有了。同理不把 deadline 吸附到 `前一次运行 started_at + bucket_window_seconds` 的网格点：那会让运行开始后一个窗口内到达的消息只收集几毫秒（实测 805 ms）就到期，表现为偶尔秒回。运行期间到达的消息始终按窗口成批，注入粒度仍是 Bucket。

代价是明确接受的：前一次运行**长于一个窗口**且消息在运行结束前一个窗口内到达时，该消息等满自己的窗口才启动，而不是在前一次运行结束的瞬间启动；这一段内批次不再严格对齐同一个网格。

配置了 `participation` 时，「可触发消息」还要先通过下一节的闸门。

## 长活 Invocation 与热注入

`agent.context.idle_grace_seconds` 大于 0 时，Invocation 变成一个运行窗口：它可以跨多个 Bucket，在运行期间接收新注入的消息。

```text
Bucket 到期
  ├─ 该 Conversation 有 running Invocation：attach（写 invocation_buckets + 冻结快照）→ steer 注入
  └─ 否则：创建新 Invocation（既有行为）
```

规则：

- **注入粒度是 Bucket，不是单条消息。** 入库侧的收集与节拍推算完全不变：运行期间到达的消息进入下一个 `collecting` Bucket，等满自己的窗口才成为一批。
- attach 只发生在**同一个 Conversation**。同一 Chat 另一个 Forum Topic 到期的 Bucket 不会 attach，它属于另一个 Conversation Context，等该 Chat 空闲后开新的 Invocation。
- attach 时对该 Bucket 调用 `snapshotInvocation(..., includeHistory: false)`，按 `sequence_no` 续写到 `invocation_messages`，因此「冻结模型输入」的不变量不变：之后编辑已注入的消息不会改动已注入的批次。
- 一批注入即是一个 checkpoint（见「Context 生命周期」），注入方式是 `agent.steer()`；`steer` 的可见点是 turn 边界，长 Tool 批次期间到达的消息会延迟到该批次结束。
- 结束判定顺序：睡眠/暂停/每日预算触顶 → 结束；有已 attach 未注入的 Bucket → 注入后继续；空闲等待至多 `idle_grace_seconds`，期间有 Bucket 到期 → 注入后继续；超过 `max_wall_clock_seconds` → 结束；其余结束。
- **`idle_grace_seconds = 0` 是关闭开关**：不空闲等待、到期 Bucket 不 attach，节拍行为与「一次 Bucket 一次 Invocation」完全一致，但 Conversation Context 依然持久。这是唯一受支持的降级方式，代码里没有第二套模式或 mode 分支。
- 防失控靠 `agent.rate_limits`：`turns_per_injection` 限制每批注入后最多跑多少轮（注入即重置），`sends_per_window`/`window_seconds` 限制同一 Chat 滑动窗口内的 `send` 次数，`max_wall_clock_seconds` 限制单次运行总时长。per-Invocation 的 `max_turns`/`max_sends`/`timeout_seconds` 已删除。
- attach 但从未注入的 Bucket 在运行结束时重新排队成新 Invocation（`invocation_buckets.injected_at` 为 NULL），不会被丢弃。
- `/pause` 会中断处于空闲等待中的 Invocation。

## Context 生命周期

每个 Conversation 持有一份 **Conversation Context**：canonical history 是 `context_messages` 的 `[head_seq, next_seq)` 区间，按 `seq` 严格有序，跨 Invocation 与进程重启存活。运行中的 Pi Agent 从这份历史播种，写回也以它为准；`ConversationRuntime` 里的 Agent 实例只是 LRU 缓存（`agent.context.agent_cache_size`），驱逐后能从数据库重建等价 transcript。

写入规则：

- 只有 `user`、`assistant`、`toolResult` 三种 role 进入 canonical history，写入时机是 `message_end`；每条记录产出它的 `invocation_id`。
- 过滤：`stopReason` 为 `error`/`aborted` 的 assistant 消息不写入，内容全空的 assistant 消息不写入（Pi 的 provider 层会静默丢弃它们或在失败时 push 一条空 assistant）。
- 完整 `AgentMessage` JSON 入库（含 `toolCallId`、`toolName`、`arguments`、thinking signature），因此可原样回放；内联图片块不入库，历史图片靠 `img_` 引用按需 `read_image`。
- 编解码必须对 Provider 能产出的任何消息成对成立：`usage` 是原样抄写 Provider 的报告，因此宽松接受未知计数（OpenRouter 的 `reasoning`、Anthropic 的 `cacheWrite1h` 拆分）；`content` 块与消息信封是逐字段投影，仍严格校验。**一行解不开不只是坏行**：它的整段保留窗口都无法播种，该 Conversation 之后每次 Invocation 都会在第一次模型调用之前失败，直到有人手动清历史——因此解码器只在真正缺字段时报错，运行时的异常也必须落日志（见下）。
- `agent_messages` 表继续保存摊平的文本审计，供面板阅读；`context_messages` 才是可回放的 canonical history。

system prompt 拆分：

- **稳定段**只包含不随 Invocation 变化的内容：Core Agent Protocol、System Skill 索引、图片/Sticker 说明、人格 Prompt、私聊/群聊模式、Chat instructions、记忆与 internal context 的使用说明。它对一个 Conversation Context 保持逐字节稳定，这样每次请求的前缀能被 provider prefix cache 命中。Sticker 目录（`sticker_id:emoji`）是**不可信数据**，因此随批次注入，不进入稳定段。
- **注入段**是一条 `user` 消息，先给可信的 `<runtime_state>`（当前时间、睡眠状态、Alarm 任务、Startup catch-up 说明、`<memory_list>`、`<internal_context_history>`），再给不可信的 `<untrusted_new_messages>`（本批 Telegram 快照，格式与既有 `invocation_messages` 快照一致）与可选的 `<untrusted_sticker_catalog>`。信任边界不变：`<untrusted_*>` 内的一切仍是数据。
- 历史不再被重新渲染成 `<untrusted_telegram_history>`；它由 transcript 本身承载。只有两种情况例外：该 Conversation Context 尚无历史（冷启动），以及历史区段里那些**从未进入 transcript 的消息**（例如被 participation 闸门拦下的消息）——它们仍然必须渲染，否则模型永远看不到。
- system prompt 变化（`system_prompt_hash` 不同）意味着 Context 重建：丢弃全部 canonical history 重新开始。config 只在 `serve` 启动时加载，所以等价于「改了 Prompt 或 Chat instructions 就重开 Context」。

垃圾回收（GC）是**只删不摘要**的 checkpoint 滑动窗口，挂点只有一个：`prepareNextTurnWithContext`（位于流式输出之后、Tool 批次闭合之后，是唯一安全的裁剪点）。

- checkpoint 是纯 metadata（`context_messages.is_checkpoint`），不是消息；每批注入的 `user` 消息打上该标志。`assistant`/`toolResult` 永远不是 checkpoint。
- 触发条件：保留区间的 `send` 数超过 `agent.context.retained_sends_max`，或估算输入 + `maxTokens` 达到 `contextWindow * hard_token_ratio`。
- 目标 checkpoint：从最新往回找第一个仍保留至少 `retained_sends_target` 次 `send` 的 checkpoint（`send` 少而 Tool 多的历史退回 token 判据），一次跨过多个 `send`，形成 sliding window。
- 安全校验：目标必须是 checkpoint 的 `user` 消息、必须前进、保留段头部不能是 `toolResult`、保留段内每个 `toolResult` 都要有对应的 assistant toolCall。任一不过就放弃本次 GC，等下一个 turn 边界（最高优先级守卫：provider 不会修孤儿 `toolResult`）。
- GC 后必须同步四处：`head_seq` 前移（旧行软标记 `evicted_at`）、loop context 的 `messages`、`Agent.state.messages`、被淘汰消息携带的 `context_refs`。缺任何一处都会让三份历史分叉。
- 一个 checkpoint 都没有（冷启动首轮）时不 GC，只能靠收尾模式处理。

## 引用（capability）生命周期

`img_`（媒体）、`stk_`（Sticker）、`reply:<telegram_message_id>`（Reply 目标）三类引用存在 `context_refs`，按 Conversation Context 隔离并带 `expires_at`（`agent.context.ref_ttl_hours`）：

- 同一媒体在 TTL 内复用同一个引用，历史文本因此不会每轮变化。
- `send` 的校验从「当前 Invocation 授权」放宽到「**当前 Conversation Context 授权且未过期**」；`read_image` 同理。
- 跨 Conversation 的引用永远不解析。引用被 GC 淘汰（其来源消息已不在保留段）后立即失效。
- `/cut_topic` 会同时清空该 Conversation Context，否则命令名义上切了历史、模型仍能从 transcript 看得见。

## 定时活跃与注意力窗口

配置了 `telegram.participation` 或 `chats[].participation` 的群聊不再无条件开 Bucket。先在活跃时段外处理有触发资格的新消息、更新注意力窗口，再判断 participation 闸门；allowlist、暂停状态和消息触发资格仍独立生效：

```text
participation 放行 = 未配置 participation || 处于活跃时段 || 更新后的注意力窗口未过期
```

- **活跃时段**（`active_windows`）按 Chat 时区解释，是半开区间 `[start, end)`；`end < start` 表示跨午夜并归属开始日，`end = "24:00"` 表示到当日结束。时段内行为与未配置时完全一致。
- **触发**只有三类：直接 @ Bot、Reply Bot 自己发过的消息（判定原始 Update 的 `reply_to_message.from.id`）、命中 `trigger_keywords`（`text` 与 `caption`，大小写不敏感）。优先级是 mention → reply → keyword，只影响记录下来的 `trigger_kind`，不影响是否放行。
- 仅在活跃时段外，有触发资格且命中的新消息才先写入或刷新 `conversation_attention`（`expires_at = receivedAt + attention_window_seconds`）再判定，因此命中消息自身会通过 participation 闸门。活跃时段内直接放行，不创建或刷新注意力窗口；实时入库与启动追赶复用这一判断。
- 窗口按 Conversation（Chat + Forum Topic）隔离；时段按 Chat 生效，时段内该群所有 Topic 都活跃。
- 只有能开 Bucket 的消息才能开窗口：`sticker_trigger_enabled = false` 时的单独 Sticker 既不开 Bucket 也不刷新窗口。
- 编辑消息不触发、不刷新窗口、不开 Bucket，但仍写入 Revision，并在后续 Invocation 中作为 history 出现。
- 闸门只阻止**创建** Bucket：已有 `collecting` Bucket 时，被抑制的消息仍按原逻辑追加进去。被拦下的消息照常写入 `messages`、`message_revisions` 与 `media`。
- 命中时打印 `agent_attention_triggered`（`chat_id`、`conversation_id`、`trigger_kind`、`telegram_message_id`、`expires_at`）；被抑制的消息不打印，避免静默期每条消息一行。
- 私聊永不受闸门影响；`/pause` 优先（暂停期间既不建 Bucket 也不记窗口）；Alarm 的排期 Invocation 不受影响。
- 启动追赶同样过闸门：追赶 Bucket 只在处于时段内或窗口未过期时创建，否则记为 `skipped_budget`/`participation_gated`。追赶期间收到的命中消息同样会刷新窗口，因此停机期间被 @ 不会丢。

## Context

一次 Invocation 的模型输入由 `ContextBuilder` 的两半拼成：稳定的 `systemPrompt` 与一批注入消息。项目里不再有「每次重新渲染全部历史」的 `userPrompt`——历史由 Conversation Context 的 transcript 承载，见 [Context 生命周期](#context-生命周期)。

- `systemPrompt`：代码固化的 Core Agent Protocol、System Skill 索引、图片/Sticker 能力说明、运维侧人格 Prompt、私聊/群聊模式、Chat instructions、记忆与 internal context 的使用说明。Core Protocol 规定消息分区、沉默判断、Tool 选择原则与副作用成功判定；人格 Prompt 只负责身份和表达风格。这一整段对同一个 Conversation Context 保持稳定；不可信的 Sticker 目录随批次注入，不在这里。
- 注入消息（`user`）：`<runtime_state>` 给出当前时间、睡眠状态、Alarm 任务、Startup catch-up 说明、`<memory_list>` 与 `<internal_context_history>`；随后是可选的 `<untrusted_sticker_catalog>`（`sticker_id:emoji`），最后是 `<untrusted_new_messages>`（本批 Telegram 快照）。只有冷启动那一批、以及历史区段里从未进入 transcript 的消息，会额外带上 `<untrusted_telegram_history>`。
- `directImages`：当 `agent` 模型支持 image 时，**本批**消息里的 Photo/图片 Document 经标准化后成为同一 User Message 的多模态内容，并按 `figure_N` 与消息 JSON 中的引用对应。
- `visibleSenders`：本批及保留历史中可见的 Telegram user sender，供 `alarm` 校验目标。
- `imageCapabilities`：Sticker 始终可用；Photo/图片 Document 在 `agent` 模型不支持 image 时全部可用，支持 image 时历史图片通过 `img_` 引用可用，供 `read_image` 使用。
- `omittedNewMessages`：因 Context 上限省略的新消息数量。

当前 Conversation 全部有效记忆按创建时间升序出现在注入块的 `<memory_list>` 内。新增记忆等价于列表末尾 append，不重排已有项；TTL 到期与 `delete_memory` 只破坏删除位置之后的缓存前缀。

同一 Conversation 最近的 `internal_contexts` 也作为隐藏 `<internal_context_history>` 块出现在注入块中，而不是 system prompt。当列表为空时不注入该块，避免空提示开销。该块显式说明这些内容是历史 Tool 观察、不会发送到 Telegram、不是当前数据库权威；当前实现主要保存 `list_alarm` 结果的有序映射，让后续 invocation 能把“第二个”解析回稳定 alarm ID，并在真正 `delete_alarm` 时重新做数据库 ownership / pending 校验。

随 Invocation 变化的内容（当前时间、记忆、internal context、睡眠状态、Alarm 任务）都必须待在注入块里：放进 system prompt 会让每次请求的前缀都不同，既失去前缀缓存，又违反「Context 可以稳定保留」的前提。

私聊策略提示模型积极参与；群聊提示只在有明确价值时发言。它是行为偏好，不绕过 Tool 或预算授权。

Context 受模型窗口限制：为系统提示、完整 Tool 定义（名称、描述与参数 Schema）、历史、新消息和输出保留空间。Tool description 不只是能力清单，还应说明何时使用、何时不用、必要调用顺序和成功判定。估算输入达到 `context_stop_ratio` 后进入收尾模式，只保留 `send` 和当时可用的 `zzz`；估算输入加预留输出达到模型窗口时才按上下文限制终止，不是在比例阈值处立即停止 Tool 循环。

## Agent 循环

```text
Context（稳定 system prompt + 本批注入）
  → model turn
  → zero or more Tool Calls
  → Tool Results
  → next model turn
  → completed / failed / aborted / outcome_unknown
```

Invocation 结束时 Agent 实例可以留在 `ConversationRuntime` 缓存里供下一次复用；canonical history 才是唯一真相，缓存被驱逐或进程重启都不影响连续性。失败运行（`model_error`）会主动驱逐该 Conversation 的缓存，避免把半截 transcript 带进下一次。

运行时抛出的异常（播种 canonical history 失败等）由 Scheduler 记为 `state = failed`、`completion_reason = invocation_error`，异常消息与堆栈以 `agent_invocation_error` 日志落盘——`completion_reason` 是 outcome 词表而不是错误类名，只有日志里才有“为什么”。同一条异常会把该 Invocation 消费的 Bucket 一起置为 `failed`，不会留下悬空的运行中 Bucket。`invocation_error` 意味着代码或存储层出问题，`model_error` 才是 Provider 侧问题。

限制来自配置：全局每日 Token 预算、`agent.rate_limits`（`turns_per_injection`、`sends_per_window`/`window_seconds`）、`agent.context.max_wall_clock_seconds` 与全局并发（`tool_calls_used` 仅作审计统计，不再按次数终止）。除该全局 Token 预算外没有其它每日配额：Chat 不限每日 Invocation 数，MCP Tool 不限每日调用数。模型调用与 Tool Call 分别写入审计；`execute` 每次调用有自己的 `tool_calls` 行，dispatch 到的内部能力还会各自再写一行，因此一次 `execute.call` 在审计里是两条可关联记录（外层 `tool_call_id` 与内层 `<id>:<tool>`）。`add_memory`/`delete_memory` 是持久化副作用，按 Conversation 隔离；`send` 仍是模型驱动的 Telegram 输出的唯一边界。

## Skills 与受控能力调用

工具面分三层：runtime 原语直接暴露、内部能力经 `execute`、MCP Tool 直接暴露。内部能力按需发现，避免每轮请求携带全部定义；这不是放宽授权，Schema、引用和预算仍由 Tool 边界校验。修改能力时先查 [组合根的 `capabilityTools`](../src/application.ts#L128) 与 [原语装配](../src/orchestration/agent-runtime.ts)，行为验证见 [验证索引](verification.md#静态与单元验证)。

- **原语**：`read`、`send`、`execute`、`zzz`（条件暴露）。它们的定义、Schema 与约束完全由 runtime 提供，不依赖任何 Skill；未读取任何 Skill 也能直接调用。
- **内部能力注册表**：由 [application.ts](../src/application.ts) 的 `capabilityTools` 装配，完整清单以此为准，不在文档维护副本。模型经 `execute` 的 search/help/call 按需发现与调用；调用前按目标能力的参数 Schema 校验，input 超 32 KiB 拒绝。
- **MCP Tool**：按配置 allowlist 直接暴露，不进入 `execute` 注册表。

`execute.call` 的结果是 `{text, refs}` 封套：`text` 截断到 32 KiB 并带 `[content truncated]` 标记；`refs` 是本次调用产生的 Conversation Context 级引用 token（目前只有 `search_stickers` 的 `sticker_ref`，带 TTL），只能交给对应消费 Tool 在边界校验后使用。`execute` 拒绝四个原语（`execute_primitive_rejected`）与未知能力（`unknown_capability`），也不会递归调用自己。

System Skills 是随 runtime 发布的只读文档包，位于 `src/system-resources/skills/<name>/SKILL.md`（Docker 镜像随 `src/` 打包）。`SKILL.md` 头部 frontmatter 声明 `name`（必须等于目录名）与 `description`，加载失败即启动失败。system prompt 只注入索引（名称、描述、`system:///skills/<name>/SKILL.md` URI）；正文由模型用 `read` 按需读取，即 progressive disclosure。`read` 只接受 `system:///` 绝对 URI 或「相对引用 + base」，路径段校验拒绝 `..`、反斜杠、百分号转义，只允许 `.md`，结果 32 KiB 截断。Skill 是文档不是授权：不能覆盖 Tool 约束、协议或预算。

每次模型请求都会附带完整的工具注册表（名称、label、描述与参数 Schema）。请求发出前把该请求实际附带的工具名写入 `model_calls.tools_json`，Invocation 的可用注册表快照（`name`/`label`/`description`）写入 `invocations.tool_registry_json`——因此可以审计“模型在某一轮到底看到了哪些工具”。context 接近上限时，Agent 循环只保留 `send` 和已经可用的 `zzz` 继续收尾。

普通 Assistant Message 永不自动发布。模型不调用 `send` 即表示保持沉默，这在群聊中是正常成功结果。`agent.send_nudge_enabled` 开启时，若本轮没有 Tool Call、私有文本去除首尾空白后非空，且**本批注入**以来尚未调用 `send`，harness 会在会话自然结束前至多注入一次 `steer` 提醒；提醒后仍不调用则静默放行，文本不出 Telegram。提醒的判定必须**早于**注入下一个批次与空闲等待：后两者都会延长这次运行，而草稿只有在自己那批仍是最新批次时才可挽回——排在它们后面会让整段运行期间每个「有草稿又被下一批接上」的批次都静默丢回复（只有真正静默满一个 grace 才会被提醒）。

## 睡眠

全局当日 `model_tokens` 剩余比例严格低于 5% 时，当前 Agent 才会看到 `zzz`；恰好 5% 不可见。全局用量是所有 Chat 的主 Agent 与聊天触发 `read_image` 用量之和，同时保留各 Chat 的归属统计。运行中的会话越过阈值后，在下一次 model turn 边界更新工具注册表，不为此额外创建会话。

`zzz` 可见性与注入块里的睡眠状态说明由同一个判断渲染：只要 `zzz` 可见，本批注入的 `<runtime_state>` 就带一段自然语义的状态说明（现在很困、该睡就睡、静默结束也应该直接睡），而不是只让模型从 tool description 推断自己的状态。状态放在注入块而不是 system prompt，是因为 system prompt 必须对一个 Conversation Context 保持稳定。会话中途越过阈值时，工具注册表立即更新，状态说明在下一次注入时出现；如果该批注入之后 `zzz` 才可见，模型仍可从 tool description 推断。`zzz` 的 description 同样只用自然语义描述睡意，不暴露 token、budget、quota 等实现细节。

`zzz` 把全局 `bot_sleep_until` 写入 `app_state`，取 `max(调用时间 + 8 小时, 下一次 UTC 日预算重置)`。写入使用 SQLite IMMEDIATE transaction，重复或并发调用保持同一状态。调用后当前会话停止下一轮模型请求，后续实际 Tool Call 被阻止。

睡眠期间 Telegram Update、Message、Revision 与 Bucket 仍照常保存；Scheduler 将到期 Bucket 和尚未启动的 queued Invocation 标记为 `skipped_budget`/`sleeping`，不创建新 Agent。首次在 `sleep_until` 之后检查状态时原子删除该键并恢复调度，因此状态可跨进程重启且不会因预算提前重置而提前唤醒。

管理员调大预算后可在 Admin Overview 手动解除睡眠；`POST /api/wake` 原子删除该键并唤醒 Scheduler，重复调用幂等。已因睡眠跳过的 Bucket 不会重放，后续到期 Bucket 与新消息恢复正常调度。

## Alarm / Deferred Invocation

Agent 通过 `alarm` 能力（经 `execute.call` 调用）创建一个绑定当前 conversation 的未来 Invocation，而不是延迟发送预生成文本。另有 `list_alarm`/`delete_alarm`：前者只从可信 invocation 身份列出当前调用者自己仍可操作的 pending alarms，并把结果以 durable hidden internal context 保存；后者只允许把该调用者自己的 pending alarm 原子置为现有终态 `cancelled`，对不存在 / 他人所有 / 状态变化统一返回 `alarm_not_found`：

1. Tool 校验 `target_user_id` 必须是当前 Invocation 实际可见消息中的 Telegram **user** sender（sender_chat 与任意 ID 拒绝）、`summary` 为 1–500 字符任务说明、`datetime` 为带显式 offset/`Z` 的绝对时间且严格未来、不超 365 天；同一 Invocation 最多成功创建 3 个。
2. Alarm 的 owner 是“创建者”而不是 target。创建者来自冻结 invocation 的 `new` 区段中**最新一条** Telegram user sender；不会扫描 `visibleSenders` 做唯一值猜测。若 `new` 区段里没有可靠 user sender（例如 alarm invocation、sender_chat、仅 bot/service），`alarm`/`list_alarm`/`delete_alarm` 全部 fail closed，返回 `alarm_caller_not_available`。
3. 成功创建是副作用，写入 `alarms`（含原 conversation/Forum Topic、目标 ID 与显示名快照、UTC deadline、`created_by_user_id`、`created_by_invocation_id`），并返回 Alarm ID/scheduled UTC。历史旧行若 `created_by_user_id IS NULL`，不会被用户列出或删除；不会把 target 冒充 creator 回填。
4. Scheduler 的动态等待同时考虑最近 Bucket deadline 与最近 pending Alarm `scheduled_at`；到期 Alarm 在 Chat 空闲时原子 `pending → firing`，再创建不携带任何 Telegram Update/Message/Revision 的真实 `alarm` Invocation。
5. Alarm Invocation 仍走普通 Context/Agent/send pipeline；注入块临时加入任务说明（summary 是任务描述，不是待发送文本），首次成功文本 `send` 自动在开头加入目标用户的 Telegram text mention。
6. Alarm Invocation 绕过全局每日 Token gate 与预算触发的 `zzz`/sleep，且不暴露 `zzz`；仍受 pause、Chat/Topic 配置、同 Chat 串行、并发、`agent.context.max_wall_clock_seconds`、`agent.rate_limits`、capability 与 Telegram 错误约束。
7. Invocation 无论何种终态都关闭 Alarm 且不重试；进程恢复遗留 `firing` 关闭为 `fired`/`outcome_unknown`。到期时 Chat/Topic 停用、移出配置或 pause 则置 `cancelled` 并记录稳定原因。

## send Tool

`send` 是模型驱动的 Telegram 输出的唯一边界，支持以下形式；确定性的 Bot 命令回复不经过模型，见 [Bot Commands](#bot-commands)：

- 文本默认按纯文本发送；显式设置 `parse_mode: "MarkdownV2"` 时由 Telegram 按 MarkdownV2 解析。只提供 `text`（以及可选的 `reply_to_message_id`）时，`kind` 默认为 `text`。
- 配置允许且当前 Conversation Context 授权的 Sticker（`stk_` 引用）。
- 可选 Reply，但目标 Message ID 必须仍在当前 Conversation Context 的保留段内且未过期（`reply_` 引用）。

发送前写 pending 审计并标记副作用边界。明确失败可按策略处理；网络中断后无法确认 Telegram 是否接收时记录 `outcome_unknown`，不能盲目重发。

`agent.send_max_text_length` 配置了文本最大字符数（默认不限制）时，超长文本在进入发送前被拒绝：Tool Call 记为 `error`、错误码 `send_text_too_long`，不写 `telegram_sends`、不消耗窗口额度。

`agent.send_disallow_blank_lines` 开启（默认关闭）时，包含任何空行的文本同样在发送前被拒绝，错误码 `send_blank_lines`。

`agent.rate_limits.sends_per_window` / `window_seconds` 限制同一 Chat 在滑动窗口内的成功（或 pending/unknown）发送数；超出时 Tool Call 记为 `error`/`send_rate_limited`，不写 `telegram_sends`。这是长活 Invocation 取代 per-Invocation `max_sends` 的刹车。

成功发送后：

- `tool_calls` 记为 success。
- `telegram_sends` 保存 Telegram 返回 ID/时间。
- 发送内容写入可见消息历史。
- Agent 的私有 Assistant 文本仍不进入 Telegram。

## `web_fetch`

`web_fetch` 是经 `execute.call` 调用的内部能力，接受模型生成的单个 URL，只执行无 Cookie、无认证 Header 的 HTTP(S) GET。它只允许协议默认端口，最多跟随 3 次跳转；每一跳都重新解析并校验目标，连接固定到已经校验的 IP，防止 DNS rebinding。

直接提交的环回、私网、链路本地、文档与保留地址会被拒绝。代理环境把公网域名解析到 `198.18.0.0/15` synthetic IP 时，仅允许“域名解析结果”使用该网段；模型直接提交该网段 IP 仍会被拒绝。

Tool 只返回文本、JSON、XML 或 JavaScript 响应，拒绝压缩和二进制内容。单次调用最多 15 秒、结果最多 32 KiB；结果前缀明确标记网页为不可信数据。调用参数、结果、耗时和失败码写入 `tool_calls`，`side_effect = false`。

## 用户图片模型分流

当 `agent` 模型支持 image 时，`new` 区段的 Photo 与受支持的图片 Document 随冻结 Context 直接送入主模型，不经过 `read_image` 或独立 `vision` 模型；历史区段的图片只保留 `image_ref`，模型可用 `read_image` 按需查看，避免旧图占用输入或分散注意力。Telegram Photo 只保留最高分辨率变体，避免同一照片重复占用模型输入。

当 `agent` 模型只有 text 输入时，所有普通图片不附到主模型请求，而是在 Context 中保留 Invocation-scoped `image_ref`。Agent 可按需调用 `read_image`，由独立 `vision` 模型返回文字描述。普通图片继续按 `file_unique_id + analysis_version` 缓存 30 天。

直传图片在首次 Agent 请求前下载到 `paths.media_cache` 临时目录，并执行下载大小、真实格式、像素数、EXIF 移除、最大边长与标准化输出大小限制；请求载荷完成构造后立即删除临时文件。下载或校验失败会使 Invocation 失败，不会把缺失图片伪装成成功。

## `read_image`

`read_image` 是经 `execute.call` 调用的内部能力。模型只能使用 Context 中展示的不透明 `image_ref`。多模态 Agent 获得 Sticker 与历史区段 Photo/图片 Document 的引用；新消息中的普通图片直传主模型，不再保留对应 `read_image` 引用。text-only Agent 获得所有可见区段中 Sticker、Photo 与图片 Document 的引用。Tool 不接受原始 Telegram file ID、任意 URL 或任意 Media ID。

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

`search_stickers`（经 `execute.call` 调用）支持语义查询，也支持一次解析最多 5 个目录 `sticker_id`；两种方式都只返回已允许、已成功索引的 Sticker，并生成当前 Conversation Context 的 `sticker_ref`（带 TTL，历史里引用过也仍然有效）。目录 ID 与 Telegram file ID 都不能直接发送，`send` 只接受 `search_stickers` 返回的 capability；`execute.call` 的结果封套会在 `refs.sticker_ref` 中同时列出这些授权 token。

## Bot Commands

`/pause`、`/resume` 与 `/status` 是 Chat 级控制命令，作用于发送命令的 Chat（含 Forum 全部 Topic），不按 Topic 隔离。`/cut_topic` 同样是 Chat 级命令。

- 判定：`message.entities` 中 offset 为 0 的 `bot_command`；命令名大小写不敏感；带 `@用户名` 后缀时必须匹配当前 Bot；Bot 发送者的消息不触发命令。未知命令与非命令消息照常入库。
- 启动时（`getMe` 后）调用 `setMyCommands` 自动注册 `/pause`、`/resume`、`/status`、`/model`、`/cut_topic` 及中文描述（`BOT_COMMANDS` 是唯一事实来源，注册前校验每个命令都能被 `parseBotCommand` 解析）；注册失败只记 `command_registration_failed`，不阻塞启动——命令菜单是便利设施，文本解析不依赖它。
- 命令消息只写 `telegram_updates` 审计，不写入 `messages`，因此不会创建 Bucket 或进入 Agent 历史。`parseBotCommand` 返回的命令附带 `messageId`（命令消息自身的 Telegram message ID）与 `threadId`（命令所在 Forum Topic），供 `/cut_topic` 记录切点并定位要清空的 Conversation Context。
- 回复是确定性 Bot 输出（不经模型），直接通过 Bot API 发送并 Reply 原命令消息，不经过 `send` Tool；发送失败只记 `command_reply_failed` 事件，不重试。

`/pause` 与 `/resume` 仅对 Bot 管理员开放（`bot_admins` 表，见下文）；`/status` 对任何成员开放。非管理员或匿名身份执行会收到拒绝回复，不产生任何状态变更。管理员执行命令时其显示名会刷新到 `bot_admins`。

`/model` 同样仅限管理员，用于运行时切换 agent 模型（与 Admin Panel「Model」页共享同一 `AgentModelSwitcher`）：`/model` 按每页 20 条列出当前模型与第一页可切换序号；`/model page 页码` 翻页，所有页面保留全局序号；`/model 纯数字序号` 直接切换对应模型（立即对后续 Invocation 生效）；`/model reset` 恢复 config.jsonc 默认。越界页码或无效参数返回提示且不改状态。

`/pause` 立即生效（与 scheduler 同一事件循环，无竞态）：

1. 写入 `chat_pause`（chat_id 为内部 `chats.id`）。
2. 该 Chat 所有 `collecting`/`queued` Bucket 置为 `expired`、`error_code = chat_paused`；对应 `queued` Invocation 置为 `aborted`、`completion_reason = chat_paused`。
3. Scheduler 中止该 Chat 正在运行的 Invocation（`pauseChat`），包括正处于空闲等待（等待下一个 Bucket）的长活 Invocation；正在飞行中的 `send` 可能已经落盘，属正常结果。

暂停期间消息仍入库并保留 Revision，但不创建 Bucket、不启动会话；`processDue` 与启动追赶也会跳过暂停 Chat（追赶 Bucket 记 `skipped_budget`/`chat_paused`）。`/resume` 删除 `chat_pause` 行，恢复正常节拍。

`/status` 返回当前生效的 `agent.provider` / `agent.model`（含 Admin Panel 热切换后的运行时模型）、`agent.thinking_level`、本 Chat 的当日 `model_tokens` 用量，以及全局当日用量、`agent.daily_budget.max_tokens` 上限与四舍五入到两位小数的用量百分比；所有 token 数量使用千位分隔符。并按该 Chat 的 Model Call 审计拆分显示 `read`、`write`、`cache read`、`cache write` token。日期口径均为 UTC；暂停中额外显示一行。每个 Conversation 再追加一行 Context 状态（保留消息数、保留窗口内的 `send` 数、`head_seq`、上次 GC 时间，尚未建立时显示 `Context: 尚未建立`）。配置了 `participation` 的 Chat 再多一行互动状态：`互动: 活跃时段内`、`互动: 注意力窗口至 <UTC ISO>` 或 `互动: 静默（仅 @、Reply 或关键词触发）`；暂停时只显示 `互动: 已暂停`。

`/cut_topic` 仅对 Bot 管理员开放，用于在群聊上下文被旧话题污染时手动切断历史：

1. 把命令消息自身的 Telegram message ID 写入 `chat_context_cutoffs`（每 Chat 一行，重复执行即前移切点）。
2. 之后新建的 Invocation 在冻结 history 快照时排除 `telegram_message_id <= 切点` 的消息，命令消息本身也在切点上，因此不会进入下一个会话的上下文。
3. 同时清空该 Conversation Context 的 canonical history（`head_seq` 推进到 `next_seq`、`context_refs` 全删），并驱逐进程内的 Agent 缓存。否则命令只是名义上切了历史，模型仍能从自己的 transcript 看得见。
4. 不删除任何消息、Revision 或已淘汰的 Context 行（只软标记）；已排队/运行中的 Invocation 不受影响，启动追赶的 `new` 消息也不受影响。

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
