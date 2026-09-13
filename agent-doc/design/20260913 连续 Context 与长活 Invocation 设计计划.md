# 塑料碗 连续 Context 与长活 Invocation 设计计划

> 调研基线：`@earendil-works/pi-agent-core` / `pi-ai` **0.84.2**（`package.json` 固定版本）。第 2 节的框架行为全部经实测确认；升级 Pi 后必须重新验证。

---

## 1. 背景与目标

需求原文：

> 我希望实现一种新的调度范式：
>
> - 每个群聊维护自己的连续 Agent Context。
> - 一次 invocation 不等于一次普通的 request / response。一个 invocation 内可能：多次注入新的群聊消息；多次调用模型；多次调用 tool；多次调用 `send` 工具向群聊发消息；在新的群消息到达后继续运行。
> - invocation 最终会结束，但 Context 可以跨 invocation 保留。
> - Context 不做 summarization / compaction。对旧历史的处理原则仍然是：直接丢弃。
>
> 具体的 Context GC 方案：
>
> 1. system prompt 永远保留。
> 2. 在完整的 Agent 执行轨迹中建立 checkpoint。
> 3. checkpoint 必须位于语义安全的边界，不能把一组 tool call / tool result 或一次未完成的 agent turn 从中间截断。
> 4. 当 Context 达到淘汰条件时：保留 system prompt；选择某个历史 checkpoint；删除 system prompt 之后、该 checkpoint 之前的所有历史内容；checkpoint 之后的原始消息、assistant message、tool calls、tool results 等全部原样保留。
> 5. 不生成历史摘要，不把被删除的内容压缩成新的 message。
> 6. Context 中希望长期稳定保留最近大约 10–30 次 `send` 工具调用相关的完整历史，这个数字应该可配置。
> 7. `send` 次数可以作为 GC 的主要窗口指标之一，但不要求 GC 精确发生在每一次 `send` 后。更倾向于在达到上限后一次推进到较新的 checkpoint，形成类似 sliding window 的效果。

今日行为是「一个 Bucket → 一个 Invocation → 一个全新 Agent → 一次 `prompt()` → `reset()` 丢弃全部 Context」。连续性来自 SQLite 中冻结的消息快照被重新渲染成一大段 `userPrompt`，而不是来自 Agent 自身的 transcript。

本设计把 Context 生命周期的所有权收到我们这一侧：

1. 每个 **Conversation** 持有一份持久化的 **Conversation Context**（canonical history），跨 Invocation 存活。
2. 一个 Invocation 变成一个「运行窗口」：期间可以多次注入新群消息、多次调用模型与 Tool、多次 `send`。
3. Context 增长由 **checkpoint + 丢弃式 GC** 控制：只删不摘要，`send` 次数为主指标，token 为最终安全阀。

产物是「连续对话感」：模型能看见自己上一次实际说了什么、用过哪些 Tool、Tool 返回了什么，而不是每次从一段被重新渲染的历史文本里推断。

## 2. Pi Agent Framework 调研结论（实测）

### 2.1 现状：只用了最底层的 `Agent`

`grep earendil-works src/` 的结果：整个项目只 import 了 `Agent`（`orchestration/agent-runtime.ts:2`）与 `AgentTool` 类型。包里的 `harness/agent-harness.ts`、`harness/session/`、`harness/compaction/` **一行都没用**。因此：

- **不存在需要禁用的默认 compaction。**
- **不存在框架维护的隐藏 session state。** `Agent.sessionId` 只是缓存亲和 header（Anthropic `x-session-affinity`，`pi-ai/dist/api/anthropic-messages.js:700`；OpenAI `prompt_cache_key`，`openai-responses.js:215`），`openai-responses.js:218` 硬编码 `store: false`，`previous_response_id` 只出现在我们不使用的 `openai-codex-responses.js`。**每次请求都发送完整 messages 数组，纯 stateless。**

### 2.2 三个可用挂点（实测确认）

| 目标 | 机制 | 位置 |
| --- | --- | --- |
| Invocation 运行中注入新群消息 | `agent.steer(message)` | `pi-agent-core/dist/agent.js:173`；loop 侧 `agent-loop.js:83,160` |
| Invocation 运行中裁剪历史 | `prepareNextTurnWithContext` 返回 `{ context: { ...turn.context, messages } }` | `agent-loop.js:132-150` |
| 跨 Invocation 复用 / 外部替换历史 | `agent.state.messages`（setter 会 `.slice()` 拷贝）、`initialState.messages` | `agent.js:39-44,280-286` |

实测记录（用 `fauxProvider` 写的一次性脚本，跑完已删除；下个会话可按需重建）：

1. **在 Tool 执行过程中调用 `steer()`**：第 1 轮请求 `[user]`，第 2 轮请求 `[user, assistant, toolResult, user]` —— 新消息在**同一个 run 内**进入下一次模型调用。
2. **assistant 未产生 Tool Call（本应结束）时，在 awaited 的 `shouldStopAfterTurn` 内 `await` 后 `steer()`**：第 2 轮请求 `[user, assistant, user]`，loop 继续。→ 长活 Invocation 的「空闲等待新消息」可以用这个挂点实现，不需要改框架。
3. **`prepareNextTurnWithContext` 返回裁剪后的 `messages`**：第 3 轮请求确实变成 `["assistant","toolResult"]`，裁剪生效；但此时 `agent.state.messages` 仍有 9 条 —— **loop context 与 Agent state 会分叉**。
4. **同一 Agent 连续两次 `prompt()`**：第 2 次请求 `[user, assistant, user]`，transcript 天然复用。外部执行 `agent.state.messages = slice(-1)` 后第 3 次请求 `[assistant, user]`，外部替换生效。
5. **`agent.continue()` 拒绝以 assistant 结尾的 transcript**（`agent.js:242-253`）。

### 2.3 每轮的执行顺序（决定 GC 与注入的安全点）

`agent-loop.js:88-160` 的单轮顺序：

```text
（可选）注入 pendingMessages → 流式 assistant → 执行 Tool 批次
  → emit turn_end
  → prepareNextTurn(context)        ← 唯一安全的 GC 点
  → shouldStopAfterTurn(context)    ← 可 await；可在此等待新消息
  → getSteeringMessages()           ← 取出 steer() 队列
  → 内层循环条件：hasMoreToolCalls || pendingMessages.length > 0
```

流式期间 `context.messages[len-1]` 会被原地替换（`agent-loop.js:220`），因此**任何时候都不要在流式过程中改动 messages 数组**。`prepareNextTurn` 天然位于流之后、Tool 批次闭合之后，是唯一安全点。

### 2.4 必须遵守的结构性约束（实测）

1. **保留段的头部不能是 `toolResult`。** `pi-ai/dist/api/transform-messages.js` 的第二遍只会为「有 toolCall 但缺 result」补一条合成 `"No result provided"`；**孤儿 `toolResult` 会被原样发出**（实测输入 `[toolResult, user]` → 输出 `[toolResult, user]`），`tool_use_id` 指向不存在的 block，provider 报错。
   这与 Pi 自己的切点规则一致：`harness/compaction/compaction.js:215-247` 的 `findValidCutPoints` 从不把 `toolResult` 作为候选，`findTurnStartIndex`（`:250-264`）以 `role === 'user'` 判定 turn 起点。
2. **`stopReason` 为 `error` / `aborted` 的 assistant 消息在渲染时被静默丢弃**（实测 `[user, aborted, user]` → `[user, user]`）。`Agent.handleRunFailure`（`agent.js:349-365`）还会往 transcript 里 push 一条空 assistant。持久 Context 必须在**写入时**过滤，否则慢慢攒垃圾。
3. **内容全空的 assistant 消息会被 provider 层跳过**（`anthropic-messages.js` `convertMessages` 的 `if (blocks.length === 0) continue`）。
4. **Prompt 缓存的代价**：Anthropic 只把 `cache_control` 打在 system prompt、最后一个 tool 定义、和**最后一条 user 消息**上（`anthropic-messages.js:980-998`）。每次 GC 改动前缀 → 整段会话缓存失效一次。**大步跳跃远比逐条修剪便宜**，正好支持需求第 7 条的 sliding window 取向。

### 2.5 Pi 侧的三个摩擦点（都能绕，不改框架）

- `agent.prompt()` 在 `activeRun` 存在时**抛异常**（`agent.js:227`）→ 热注入只能走 `steer()`，入库路径绝不能直接 `prompt()`。
- `Agent` 把 `getFollowUpMessages` 硬接成非阻塞 drain（`agent.js:323`）→「等待新消息」必须在 awaited 的 `shouldStopAfterTurn` 内做（第 2.2 节实测 2）。
- `steer()` 的可见点是 **turn 边界**，不是 Tool 边界 → 长 Tool 批次期间到达的消息会延迟到该批次结束。

## 3. 已定设计决策

标注「**用户已决**」的条目来自需求确认；其余是本设计的推导结论。

| 决策 | 取值 | 理由 |
| --- | --- | --- |
| canonical history 归属 | **我们持有**，落 SQLite；Pi 的 `_state.messages` 视为可丢弃缓存 | 第 2.2 节实测 3 证明 loop context 与 Agent state 必然分叉，只有单写者能保证一致 |
| Context 粒度 | **Conversation**（chat + Forum Topic） | 与 Bucket / 记忆 / 注意力窗口 / 预算的既有隔离单位一致（`conversations` 表） |
| checkpoint 形态 | **metadata**（`context_messages.is_checkpoint` 标志位），不是消息 | 需求第 5 条禁止摘要消息；插入标记消息会污染 prompt 并需要额外过滤 |
| checkpoint 位置 | **每批注入群消息的 user 消息之前** | 唯一天然满足「头部不是 toolResult」的位置；与 Pi 的 `findTurnStartIndex` 语义一致 |
| GC 挂点 | `prepareNextTurnWithContext` | 第 2.3 节：唯一在流之后、Tool 批次闭合之后的安全点 |
| GC 指标 | 主：保留的 `send` 次数；兜底：估算 token | 需求第 6、7 条 |
| 热注入机制 | `agent.steer()`；**注入粒度是到期的 Bucket，不是单条消息** | 第 2.2 节实测 1、2；既有 15 秒节拍与「运行期间的消息进下一个 Bucket」的设计不变 |
| Invocation 生命周期 | 空闲超时结束（一个 Invocation 可吃多个 Bucket） | 需求「invocation 最终会结束」 |
| 媒体 / Sticker / Reply 引用 | **在 Context 生命周期内持久化，带 TTL**（**用户已决**） | 今日 `img_` 引用每次 Invocation 用 `crypto.randomUUID()` 现造（`context-builder.ts:422`），保留历史里必然全是失效引用 |
| per-Invocation 限额 | **删除 `max_turns` / `max_sends` / 单一 `timeout_seconds` 的 per-Invocation 语义**（**用户已决**），改为窗口/速率保护 | 「一次 Invocation 只跑几轮」的假设已不存在；但防失控的用途仍然存在，见第 5.3 节 |
| system prompt 稳定化 | **移出所有随时间变化的段落**（**用户已决**） | 需求第 1 条要求 system prompt「永远保留」；今日它每次 Invocation 都不同，见第 4.4 节 |
| 迁移策略 | **只新增表**；破坏性变更集中在配置文件（**用户已授权破坏**） | 重新核对后发现几乎不需要破坏数据库，见第 6 节 |
| 范式共存 | **代码里不保留两种模式、不做 mode 开关**；「退回旧范式」只通过 `idle_grace_seconds = 0` 这一个参数表达（**用户已决**） | 保留非持久 Context 会产生两套 Context 组装 / 引用授权 / 写入 / GC / 配额，贯穿五个模块，且违反 `AGENTS.md` 的「清理式切换」规则。mode 开关虽然代码量小，但测试矩阵翻倍且收益有限。参数级降级零分支、零额外路径 |
| 试运行失败的处置 | **直接回滚数据**，不回滚代码（**用户已决**） | 迁移只新增表，双向回滚都安全；三级降级路径见第 9 节末 |
| 命名 | 新实体叫 **Conversation Context**，**不要**叫 Session | `scheduler.ts:371` 的日志字段 `session_id` 实际是 Invocation ID，`active_agent_sessions`、`agent_session_skipped_sleeping`（`invocation-queue.ts:347`）同理。复用 Session 一词会与既有日志语义冲突 |

## 4. 行为语义

### 4.1 Conversation Context 生命周期

1. 每个 Conversation 至多一份 Conversation Context。首次需要时创建。
2. Context 的 canonical history 是 `context_messages` 的 `[head_seq, next_seq)` 区间，按 `seq` 严格有序。
3. Invocation 启动时：从 canonical history 播种 Pi Agent（`initialState.messages`），或复用进程内已有的 Agent 实例（若同一 Conversation 的 Agent 仍在缓存中）。
4. Invocation 结束时：Agent 实例可以保留在内存中，也可以驱逐；**canonical history 是唯一真相**，驱逐后从 DB 重建等价。
5. 进程重启后 Context 保持（与 `chat_pause` / `bot_sleep_until` / `conversation_attention` 同一取向）。
6. **Invocation 失败不等于 Context 失效。** `recover()`（`invocation-queue.ts:72`）把中断的 Invocation 标记为 `aborted` / `outcome_unknown`，但已写入的 `context_messages` 原样保留。
7. `/cut_topic` 与 `/pause` 的语义扩展见第 4.6 节。

### 4.2 写入规则（canonical history）

1. 只有三种 role 进入 canonical history：`user`、`assistant`、`toolResult`。
2. 写入时机：`agent.subscribe` 的 `message_end` 事件（今日已在 `agent-runtime.ts:399-416` 监听，但只摊平成文本写审计表）。
3. **写入完整 `AgentMessage` JSON**，含 `toolCallId`、`toolName`、`arguments`、`thinkingSignature`。今日的 `agent_messages` 表只存文本且有 `thinking_text = ''` 的 CHECK 约束（`schema.ts:368`），**不可回放**，因此必须新表。
4. **过滤**：`stopReason` 为 `error` / `aborted` 的 assistant 消息不写入；内容全空的 assistant 消息不写入（第 2.4 节 2、3）。
5. `harness_nudge` 与 steering 注入的 harness 级消息按普通 `user` 消息写入（它们确实进了模型上下文）。
6. 每条记录产出它的 `invocation_id`，供审计与回溯。

### 4.3 checkpoint 规则

1. 每次向 Context 注入一批新群消息时，该批次的 `user` 消息标记 `is_checkpoint = 1`。
2. Alarm 触发的注入同样打 checkpoint。
3. `assistant` / `toolResult` 永不是 checkpoint。
4. `head_seq` 指向的那条消息本身必须是 checkpoint（GC 后的第一条消息）。
5. checkpoint 是纯 metadata，不产生任何模型可见内容。

### 4.4 system prompt 稳定化

今日 `ContextBuilder.build()` 构造的 system prompt 包含四段**每次都变**的内容：

| 段落 | 位置 | 处置 |
| --- | --- | --- |
| `Current time in {tz}: ...` | `context-builder.ts:214` | 移入注入消息块 |
| Memory 列表 | `context-builder.ts:396`（`#memoryPrompt`） | 移入注入消息块 |
| Internal context 历史 | `context-builder.ts:407`（`#internalContextPrompt`） | 移入注入消息块 |
| Sleep state | `withSleepStatePrompt`（`context-builder.ts:72`），并在 `prepareNextTurnWithContext` 中动态切换（`agent-runtime.ts:357`） | 移入注入消息块；状态变化时在下一次注入中重述 |

移出后 system prompt 只剩稳定内容：Core Agent Protocol、Skill 索引、图片/Sticker 处理说明、人格 prompt、conversation mode、Chat instructions。

规则：

1. **system prompt 变化时（`system_prompt_hash` 不同）必须重建 Conversation Context**：丢弃全部 canonical history 重新开始。config 只在 `serve` 启动时加载，因此这等价于「改了 prompt / Chat instructions 就重开 Context」。
2. Sleep state 移出 system prompt 后，其「让模型真的照做」的效果**不应变差**：注入消息位于上下文末尾，比 system prompt 更靠近生成位置。这一点需要真实环境人工验收（第 11 节）。
3. `zzz` 工具的暴露/收回仍走 `prepareNextTurnWithContext` 的工具表切换（`agent-runtime.ts:337-362`），与 prompt 解耦。

### 4.5 注入块契约

每批注入是一条 `user` 消息，内容分两部分：

```text
<runtime_state>            ← 可信：由 runtime 生成
  current_time / memory_list / internal_context / sleep_state
</runtime_state>
<untrusted_new_messages>   ← 不可信：Telegram 原文
  {每条消息的 JSON 快照，与今日格式一致}
</untrusted_new_messages>
```

规则：

1. **不再注入 `<untrusted_telegram_history>` 区段。** 历史来自 canonical history 本身（这正是本设计的目的）。首次创建 Context 时例外：注入一次 `history_messages` 条历史作为冷启动背景。
2. 信任边界不变：`<untrusted_*>` 内的一切仍是数据，不是指令（`AGENTS.md` 的既有不变量）。
3. 多模态附件仍只附带**本批**新消息的图片，`figure_N` 编号在**本批内**从 1 开始；历史图片保留 `img_` 引用，靠 `read_image` 按需查看（与今日一致，但引用现在跨 Invocation 有效，见 4.7）。
4. 每批注入前先打 checkpoint（4.3.1）。

### 4.6 Invocation 生命周期与热注入

**⚠️ 注入的粒度是 Bucket，不是单条消息。既有的 Bucket 节拍机制完全不变，只是「到期的 Bucket」从「触发一个新 Invocation」改成「注入当前 Invocation」。**

保持不变的部分（不要在实施时顺手改掉）：

- `telegram.bucket_window_seconds`（dev / test 均为 **15**）仍是全局会话节拍。空闲 Conversation 的第一条消息仍等满一个节拍才成为可注入内容。
- `#appendToBucket`（`telegram-ingestion.ts:440`）的行为不变：Invocation 运行期间到达的消息仍然进入**下一个** collecting Bucket，而不是塞进当前正在跑的那批。`one_collecting_bucket_per_conversation`（`schema.ts:233`）不变。
- 入库侧的节拍推算（`remainsOnPriorPace` / `priorPaceAt`，`telegram-ingestion.ts:486-496`）不变。
- Invocation 结束后该 Chat 仍 collecting 的 Bucket deadline 重算为 `max(finished_at, started_at + bucket_window_seconds)`（`scheduler.ts:266-290`）不变。
- 参与闸门（`participation` / 注意力窗口 / `sticker_trigger_enabled` / `eligibleHuman`）在 Bucket 创建时判定，位置与语义不变：**不能创建 Bucket 的消息同样不会被注入**。

改变的部分：

1. Bucket 与 Invocation 的关系从一对一变成 **多对一**：`invocation_buckets` join 表；`invocations.bucket_id` 保留为「开场 Bucket」以兼容既有查询。
2. Bucket 到期时，若该 Conversation 已有 running Invocation：**attach 到它并注入**，而不是像今日那样被 `processDue` 的 `NOT EXISTS (... state IN ('queued','running'))` 挡住等下一轮（`invocation-queue.ts:259-263`）。`#nextDelayMilliseconds` 的同类排除（`scheduler.ts:154-164`）也要一起放开，否则调度器不会在 Bucket 到期时醒来。
3. attach 时对该 Bucket 调用 `snapshotInvocation(..., includeHistory: false)`，`invocation_messages` 按 `sequence_no` 续写、`section = 'new'`、`source_bucket_id` 区分批次。**「冻结模型输入」的既有不变量因此保持成立**：注入内容仍是快照，后续编辑不会改动已注入的批次。
4. 注入即打 checkpoint（4.3.1），然后 `agent.steer(injectionMessage)`。
5. `shouldStopAfterTurn` 的结束判定顺序：
   ```text
   1. sleep / pause / daily_budget 触顶 → 结束
   2. 有已 attach 但未注入的 Bucket → steer 后继续
   3. 空闲等待至多 idle_grace_seconds，期间有 Bucket 到期 → attach + steer 后继续
   4. 超过 max_wall_clock_seconds → 结束
   5. 其余 → 结束
   ```
6. **`idle_grace_seconds = 0` 是长活 Invocation 的关闭开关。** 取 0 时不空闲等待、到期 Bucket 不 attach，节拍行为与今日完全一致，但 Conversation Context 仍然持久。这是**唯一**受支持的「退回旧范式」方式：代码里不保留第二套模式，也不做 mode 分支（见第 3 节决策表）。
   校验规则因此是：`0` 合法；**拒绝 `0 < idle_grace_seconds < telegram.bucket_window_seconds`** —— 该取值看起来开着长活，实际每次都在下一个 Bucket 到期前结束，属于静默退化，必须在 `check-config` 阶段拦下。
7. **注入可见性延迟 = Bucket 节拍剩余时长 + 当前 Tool 批次剩余时长**（后者见第 2.5 节）。前者是既有设计的固有延迟，本特性不改善也不恶化。
8. `/pause` 的 `pauseChat`（`scheduler.ts:76`）必须能中断处于空闲等待中的 Invocation（`agent.abort()` 已经能做到，但要加测试钉死）。
9. `one_running_invocation_per_conversation` 唯一索引（`schema.ts:286`）与 `#launchQueued` 的 `NOT EXISTS` 检查（`scheduler.ts:205-209`）从「顺手的不变量」变成**承重结构**：attach 路径依赖「同一 Conversation 至多一个 running Invocation」。注意 Agent 会话按 **Chat** 串行、Bucket 按 **Conversation** 收集（`telegram-agent-flow.md:69`）这一既有非对称性仍然成立：同一 Chat 的另一个 Topic 到期的 Bucket **不能** attach 到当前 Invocation，它属于另一个 Conversation Context。

### 4.7 引用（capability）持久化

1. 媒体引用 `img_*`、Sticker 引用 `stk_*`、Reply 目标共用一张 `context_refs` 表，按 Conversation Context 隔离，带 `expires_at`。
2. **同一媒体在 TTL 内复用同一个引用**（今日每次 Invocation 重新随机生成）。副作用是正面的：历史段文本不再每轮变化，prefix cache 可以命中。
3. `send` 的校验从「当前 Invocation 授权」放宽到「**当前 Conversation Context 授权且未过期**」。`send-tool.ts:142-149`（Reply）与 `:179-183`（Sticker）的校验点不变，只换数据源。
4. **跨 Conversation 的引用永远不解析。** 这是放宽后仍必须成立的硬边界。
5. 引用被 GC 掉（对应消息已不在保留段）后应撤销授权；实现上可以懒清理，但 `send` 必须以「引用仍在保留段内 且 未过期」为准。
6. `AGENTS.md` 与 `architecture.md` 的信任边界描述需要同步：「当前 Context capability」→「当前 Conversation Context capability（带 TTL）」。

### 4.8 GC 算法

只在 `prepareNextTurnWithContext` 内执行。

```text
maybeCollect(ctx, loopMessages, estimatedInputTokens):
  1. sends       = count(send_seq != NULL) in [head_seq, next_seq)
     tokenPressure = estimatedInputTokens + model.maxTokens
                     >= contextWindow * hard_token_ratio
  2. if sends <= retained_sends_max and not tokenPressure: return undefined

  3. candidates = checkpoints with seq > head_seq, 按 seq 降序
     target = 最老的 checkpoint C 使 sendsAfter(C) >= retained_sends_target
     if target is undefined:                      // tool 很长但 send 很少
        target = 最新的 checkpoint C 使 estTokensAfter(C) <= contextWindow * hard_token_ratio * 0.8

  4. 安全校验（任一不过 → 放弃本次 GC，等下一个 turn 边界）：
     - target.role === 'user' 且 target.is_checkpoint
     - target.seq > head_seq                      // 必须前进
     - 保留段内每个 toolResult 都有对应的 assistant toolCall
     - 保留段头部不是 toolResult

  5. retained = loopMessages[indexOf(target) ..]
     同步四处状态（见 4.9）
     审计一条 context_gc 事件
     return { context: { ...turn.context, messages: retained } }
```

边界情况：

| 情况 | 处理 |
| --- | --- |
| 一次 Invocation 内多个 `send` | checkpoint 按注入批次打，不按 `send` 打；GC 可一次跨过多个 `send`（这正是需求第 7 条要的 sliding window） |
| 某些 Invocation 没有 `send` | 照样贡献 checkpoint 但不加 `send` 计数 → 由 token 安全阀兜底 |
| Tool 链很长但 `send` 很少 | 步骤 3 的退化分支改用 token 指标 |
| Invocation 未结束就触发阈值 | 照常 GC；`prepareNextTurn` 位于 `turn_end` 之后，Tool 批次已闭合 |
| checkpoint 前后有 tool call / result | 步骤 4 的结构校验拦截；拦下就等下一个 turn 边界 |
| 正在 streaming | 不可能撞上（第 2.3 节） |
| token 先于 `send` 触顶 | `hard_token_ratio` 无视 `send` 计数直接切；再切不动则退回既有 `closing` 模式（只留 `send` / `zzz` 工具收尾，`agent-runtime.ts:376-384`） |
| 一个 checkpoint 都没有（冷启动首轮） | 不 GC；只能靠 `closing` 模式收尾 |

### 4.9 GC 后必须同步的四处状态

缺任何一处都会出 bug：

1. `conversation_contexts.head_seq` 前移；`context_messages` 中 `seq < head_seq` 的行标记为已淘汰（软标记，保留一段时间供审计）。
2. 运行中的 loop：`prepareNextTurnWithContext` 返回裁剪后的 `context.messages`。
3. `Agent._state.messages`：**必须同步替换**，否则下一次 `prompt()` 会把全量历史又端上来（第 2.2 节实测 3）。
4. `context_refs`：被淘汰消息携带的引用不再授权（4.7.5）。

## 5. 配置契约

### 5.1 新增

```jsonc
{
  "agent": {
    "context": {
      "retained_sends_target": 20,      // GC 后大约保留多少次 send
      "retained_sends_max": 30,         // 触发阈值
      "hard_token_ratio": 0.6,          // 最终安全阀
      "ref_ttl_hours": 72,              // 媒体 / Sticker / Reply 引用存活时长
      "idle_grace_seconds": 60,         // 空闲等待下一个 Bucket 到期的上限；0 = 关闭长活 Invocation
      "max_wall_clock_seconds": 1800,   // 单个 Invocation 的总墙钟上限
      "agent_cache_size": 32,           // 进程内常驻 Agent 实例上限（LRU）
    },
  },
}
```

校验（`validateSemantics`）：

- `retained_sends_target < retained_sends_max`
- `hard_token_ratio <= context_stop_ratio`（先 GC，再退 `closing`）
- **`idle_grace_seconds = 0` 合法（关闭长活）；拒绝 `0 < idle_grace_seconds < telegram.bucket_window_seconds`**（4.6.6：静默退化）
- `max_wall_clock_seconds > idle_grace_seconds`

### 5.2 删除

`agent.max_turns`、`agent.max_sends`、`agent.timeout_seconds`。

**⚠️ 这是本次唯一的破坏性变更。** config schema 使用 `Strict`（`additionalProperties: false`），删键后**旧配置文件会直接 `check-config` 报错**。必须同步更新：

- `dev-data/config.jsonc`
- `test/helpers.ts` 的 `testConfigJsonc`
- `agent-doc/configuration.md`
- `README` / 部署模板中出现这些键的地方（`grep -rn "max_turns\|max_sends\|timeout_seconds"`）

### 5.3 替代的防失控保护（本设计的建议，非用户硬需求）

删掉 per-Invocation 限额后，唯一剩下的刹车是 `agent.daily_budget.max_tokens`。建议补一层速率保护：

```jsonc
"agent": {
  "rate_limits": {
    "sends_per_window": 6,
    "window_seconds": 300,
    "turns_per_injection": 8,
  },
}
```

- `sends_per_window`：滑动窗口内最多发多少条，防止循环 bug 往群里连发几十条。
- `turns_per_injection`：每批注入后最多跑多少轮，注入即重置。

**若确认不需要，实施时删掉本小节对应实现即可**，其余设计不依赖它。但请明确记录这个取舍：没有它时，一次失控循环只会被 daily token 预算拦下。

## 6. 数据层

迁移 `017_conversation_context.sql`，**只新增表，不改既有表**。

```sql
CREATE TABLE conversation_contexts (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  head_seq INTEGER NOT NULL DEFAULT 1,
  next_seq INTEGER NOT NULL DEFAULT 1,
  send_count_total INTEGER NOT NULL DEFAULT 0,
  system_prompt_hash TEXT NOT NULL,
  active_invocation_id INTEGER REFERENCES invocations(id),
  last_active_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE context_messages (
  context_id INTEGER NOT NULL REFERENCES conversation_contexts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  payload_json TEXT NOT NULL,          -- 完整 AgentMessage
  invocation_id INTEGER REFERENCES invocations(id),
  is_checkpoint INTEGER NOT NULL DEFAULT 0,
  send_seq INTEGER,                    -- 该行是 send 的 toolResult 时记序号
  est_tokens INTEGER NOT NULL,
  evicted_at TEXT,                     -- GC 软标记
  created_at TEXT NOT NULL,
  PRIMARY KEY (context_id, seq)
) STRICT;

CREATE INDEX context_messages_checkpoint_idx
  ON context_messages(context_id, is_checkpoint, seq);

CREATE TABLE context_refs (
  context_id INTEGER NOT NULL REFERENCES conversation_contexts(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,                   -- img_* / stk_* / reply:<telegram_message_id>
  kind TEXT NOT NULL,                  -- media | sticker | reply
  media_id INTEGER REFERENCES media(id),
  sticker_file_id TEXT,
  target_conversation_id INTEGER REFERENCES conversations(id),
  target_thread_id INTEGER,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (context_id, ref)
) STRICT;

CREATE TABLE invocation_buckets (
  invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  attached_at TEXT NOT NULL,
  PRIMARY KEY (invocation_id, bucket_id)
) STRICT;
```

说明：

- `role` 的 CHECK 取值 `user` / `assistant` / `toolResult`（对应 Pi 的 `AgentMessage`，注意大小写与 Pi 一致）。
- `kind` 的 CHECK 取值 `media` / `sticker` / `reply`。
- **`agent_messages` 原样保留**做审计（Admin Panel 在读），不迁移、不删除。它与 `context_messages` 的分工写进 `data-layer.md`：前者审计可读、后者可回放。
- `invocations.bucket_id` 保留为开场 Bucket，既有查询（`scheduler.ts`、`context-builder.ts:140-148`）不受影响。
- 保留清理（`purgeExpiredData`，`store/database.ts`）新增：删除 `evicted_at` 早于保留期的 `context_messages`；删除过期 `context_refs`；`retention.online_days` 之外的 `conversation_contexts` 整体清理。

## 7. 模块边界

新增：

- **`src/context/context-codec.ts`** —— `AgentMessage ⇄ payload_json` 编解码；写入过滤（4.2.4）；`est_tokens` 估算。纯函数，可单测。
- **`src/context/context-store.ts`** —— canonical history 读写、checkpoint 标记、`head_seq` 推进、`send_seq` 计数。唯一写者。
- **`src/context/context-gc.ts`** —— 4.8 的算法 + 结构校验器 `assertRenderable(messages)`（第 2.4 节 1 的守卫）。纯函数 + Store 调用分离。
- **`src/context/context-refs.ts`** —— 引用注册与解析（4.7）。
- **`src/orchestration/conversation-runtime.ts`** —— Agent 实例的 LRU 缓存、播种/驱逐、已 attach Bucket 的注入队列、`steer` 桥、空闲等待。

改动：

- **`src/orchestration/agent-runtime.ts`**（🔴 重）—— `run()` 当前是「建 Agent → 一次 `prompt()` → `reset()`」，要整体重写成「取/建 Agent → 注入 → 循环 → 不 reset」。`prepareNextTurnWithContext` 内接 GC；`shouldStopAfterTurn` 内接结束判定与空闲等待；deadline 从单一 `AbortSignal.timeout`（`:220`）改成三层（空闲 / 每轮 / 总墙钟）。
- **`src/context/context-builder.ts`**（🟡 中）—— 拆成 `buildStableSystemPrompt()` 与 `renderInjection()` 两件事（4.4、4.5）。`img_` 引用生成改为查 `context_refs`。
- **`src/store/schema.ts`** + `migrations/017_*.sql`（🟡 中，纯增量）。
- **`src/orchestration/scheduler.ts`** / **`invocation-queue.ts`**（🟡 中）—— attach-to-running 路径；多 Bucket 终态（`scheduler.ts:254-301` 改为遍历 `invocation_buckets`）；`#nextDelayMilliseconds` 与节拍适配长活 Invocation。
- **`src/ingress/telegram-ingestion.ts`**（🟢 **无改动**）—— Bucket 收集与节拍推算原样保留；`scheduler.wake()` 已在 `application.ts:193`。列在这里只是为了说明「不要改它」。
- **`src/capabilities/send-tool.ts`**（🟡 中）—— 配额改窗口制；引用校验换数据源。
- **`src/platform/config.ts`**（🟢 轻）—— 第 5 节。
- **`src/store/database.ts`**（🟢 轻）—— 保留清理。
- **`src/ingress/admin/audit.ts`** + **`apps/admin`**（🟡 中）—— Conversation Context 与 GC 事件可视。

## 8. 接入点

1. **入库**：**不改。** Bucket 收集、参与闸门、节拍推算全部保持今日行为。
2. **调度**：`processDue`（`invocation-queue.ts:250`）分岔——到期 Bucket 若所属 Conversation 有 running Invocation，则走 `attachBucket()`（写 `invocation_buckets` + `snapshotInvocation(includeHistory: false)` + 唤醒该 Invocation 的注入队列）而不是 `#queueBucket()`；否则照旧创建新 Invocation。`#nextDelayMilliseconds`（`scheduler.ts:150`）同步放开对 running Invocation 的排除，否则调度器不会在 Bucket 到期时醒来。
3. **Agent 运行**：`prepareNextTurnWithContext` → GC；`shouldStopAfterTurn` → 结束判定 + 空闲等待 + `steer`；`subscribe(message_end)` → 写 canonical history。
4. **`/status`**：增加一行 Context 状态（消息条数、保留 `send` 数、`head_seq`、上次 GC 时间）。
5. **`/cut_topic`**：语义扩展为「同时把该 Conversation Context 的 `head_seq` 推到末尾」（即清空连续 Context）。否则命令名义上切了历史，模型仍从 canonical history 看得见。**这一条必须实现**，属于既有命令的正确性。
6. **结构化日志**：新增 `context_gc`（before/after 的 tokens、sends、`head_seq`）、`context_injected`（消息数、是否 checkpoint）、`context_rebuilt`（system prompt hash 变化）、`invocation_idle_wait`。
7. **文档**：`AGENTS.md`（数据流示意图、Project Goals 的 Context 描述）、`architecture.md`（第 63 行「每个 Invocation 创建新的 Agent 实例」已过期，必须改）、`telegram-agent-flow.md`（注入、checkpoint、GC、热注入、引用 TTL）、`configuration.md`（第 5 节）、`data-layer.md`（第 6 节）、`verification.md`（第 10、11 节）。

## 9. 实施顺序

**Step 0｜地基（无行为变化）**
迁移 + `schema.ts` + `context-codec.ts` + `context-store.ts` + 结构校验器 + 配置键（暂不删旧键）。只有单测，不接线。

**Step 1｜持久 Context，仍是一 Bucket 一 Invocation**
`AgentRuntime` 从 canonical history 播种 Agent，运行结束写回。**不做 GC、不做热注入。** system prompt 稳定化（4.4）与引用持久化（4.7）在这一步落地。
这一步单独走，是为了先把最脏的三件事暴露出来：codec 保真度、陈旧引用、aborted 过滤。
**验收**：连续 3 次 Invocation，第 3 次的 provider 请求（`model_calls.request_json`）里能看到第 1 次的 assistant / toolResult 原文。

→ **可发布的稳定点。** 有连续 Context，没有长活 Invocation。

**Step 2｜GC**
接 `prepareNextTurnWithContext` → `maybeCollect`；`send` 窗口 + token 安全阀 + 四处同步（4.9）。
**验收**：造 40 次 `send` 的历史，断言 GC 后 `send` 数落在 target 附近、`head_seq` 单调前进、保留段头部是 checkpoint user 消息、结构校验通过。

**Step 3｜热注入 + 长活 Invocation**
`attachBucket()` + 注入队列 + `steer` 桥 + 空闲等待 + `invocation_buckets` + deadline 三层 + `processDue` / `#nextDelayMilliseconds` 分岔 + `/pause` 中断。**入库侧一行不改。**
**验收**：Invocation 运行中 ingest 新消息，等满一个 `bucket_window_seconds` 节拍后，断言同一 `invocation_id` 内出现第二次 `send`，且 `invocation_buckets` 有两行。

**Step 4｜配额与可视化**
删除旧配置键（第 5.2 节，破坏性），接入速率保护（第 5.3 节），`/status` 与 Admin Panel。

**Step 5｜文档同步与调参**
第 8 节第 7 条的全部文档；按真实群聊调 target / max / TTL。

每个 Step 收尾都跑：`bun run lint:fix` → `bun run check` → `bun test` → `check-config` + `doctor`。

### 试运行与三级降级路径

代码里不保留旧范式（第 3 节决策表），因此试运行出问题时**回滚数据、不回滚代码**。按故障范围选最小的那一级：

| 级别 | 故障现象 | 处置 | 代价 |
| --- | --- | --- | --- |
| 1. 配置 | 长活 Invocation 行为不对（注入时机、空闲等待、发言节奏） | `idle_grace_seconds = 0` + 重启 `serve` | 不动数据；Context 仍持久 |
| 2. 单 Conversation | 某个群的 Context 坏了（codec 丢信息、GC 切错、攒了垃圾） | `/cut_topic` 清空该 Conversation Context（第 8 节第 5 条） | 只影响一个 Conversation |
| 3. 整库 | canonical history 大面积不可用 | 恢复迁移前备份 | 丢失该时间点之后的全部在线数据 |

关于第 3 级：`SqliteStore.open` 在应用 pending 迁移前会自动写一份 `pre-migration-<时间戳>-<uuid>.sqlite`（`store/database.ts:136-142`），它就是天然的回滚点，不需要额外准备。因为迁移**只新增表**，两个方向都安全：

- 恢复迁移前的库 + 新代码 → 017 重新应用，正常启动。
- 保留新库 + 旧代码 → 多出来的表无人读取，`schema_migrations` 只跳过已应用版本，也能启动。

**第 2 级是主要路径。** 第 3 级只在无法定位到具体 Conversation 时使用；实施时应确保 `/cut_topic` 真的清空 Conversation Context，否则第 2 级不存在，一有问题就只能跳到第 3 级。

## 10. 测试计划

新增 `test/context-store.test.ts`、`test/context-gc.test.ts`、`test/context-hot-inject.test.ts`；沿用 `mkdtemp` + `testConfigJsonc` + `loadConfig` + `SqliteStore.open` 的既有骨架，断言用 `store.db` 原始 SQL 与精确值比对。

- **codec**：`AgentMessage` 往返保真（含 toolCall arguments、`toolCallId`、thinking signature）；aborted / error / 空内容 assistant 被过滤；role 白名单。
- **结构校验器**：孤儿 `toolResult` 被拒；悬空 toolCall 被接受（Pi 会补合成结果）；保留段头部必须是 user。
- **canonical history**：跨 Invocation 复用（第 3 次请求含第 1 次的原文）；`system_prompt_hash` 变化 → Context 重建；进程重启后从 DB 重建等价（对比 `model_calls.request_json`）。
- **GC**：`send` 阈值触发；target 落点；`head_seq` 单调；无 checkpoint 时不 GC；token 安全阀先于 `send` 触发；tool 长 / send 少的退化分支；GC 后 `Agent.state.messages` 与 loop context 一致（第 2.2 节实测 3 的回归钉子）。
- **引用**：TTL 内同一媒体复用同一 ref；跨 Conversation ref 不解析；被 GC 掉的 ref 不再授权；过期 ref 被 `send` 拒绝。
- **热注入**：running Invocation 期间 ingest → 消息进**新的** collecting Bucket（不进当前批次）；该 Bucket 到期后 attach 并触发同一 Invocation 内的第二次模型调用；`invocation_buckets` 两行；一个 Bucket 内的多条消息作为**一批**注入。
- **节拍回归**：`bucket_window_seconds` 未满时不注入；空闲 Chat 首条消息仍等满一个节拍；`0 < idle_grace_seconds < bucket_window_seconds` 的配置被 `check-config` 拒绝。
- **`idle_grace_seconds = 0`**：到期 Bucket 不 attach、Invocation 不空闲等待，`invocation_buckets` 恒为一行，节拍与今日一致；但 canonical history 仍跨 Invocation 复用（这是关闭开关的回归底线）。
- **注入隔离**：同一 Chat 另一个 Topic 到期的 Bucket **不会** attach 到当前 Invocation。
- **注入快照**：attach 后编辑已注入消息，不改动已注入批次的内容（`invocation_messages` 的冻结语义）。
- **结束与中断**：空闲超时后 Invocation 结束；`/pause` 中断空闲等待。
- **多 Bucket**：一个 Invocation attach 多个 Bucket 后，全部 Bucket 终态正确。
- **`/cut_topic`**：执行后 Context 被清空，后续 Invocation 的请求里看不到旧历史。
- **回归**：`scheduler`、`telegram-ingestion`、`startup-catch-up`、`alarm`、`sleep`、`participation`、`admin` 全套跑通。

## 11. 验证

```bash
bun run lint:fix
bun run check
bun test
bun run src/cli.ts check-config --config dev-data/config.jsonc
bun run src/cli.ts doctor --config dev-data/config.jsonc
```

真实环境人工验收（测试覆盖不到）：

1. 私聊连续对话三轮，第三轮问「你刚才第一句说了什么」，确认模型能凭 canonical history 答对（不是靠重新渲染的历史文本）。
2. 群里连续发消息触发一次 Invocation，在它运行期间再发一条，确认**同一次** Invocation 里回应了后到的消息（看 `invocation_id` 与 `telegram_sends`）。
3. 制造超过 `retained_sends_max` 次 `send`，观察 `context_gc` 日志：`head_seq` 前进、token 数下降、对话没有断裂感。
4. 观察 `model_calls` 的 `cache_read_tokens`：GC 之后应有一次缓存失效，随后恢复命中。
5. 触发低预算窗口，确认 sleep state 移出 system prompt 后模型仍会按预期 `zzz`（4.4.2 的待验证项）。
6. 执行 `/cut_topic`，确认后续回复不再引用被切掉的内容。
7. 重启 `serve`，确认对话连续性保持，且 `config_hash` 与 `check-config` 一致。

## 12. 风险与已知边界

1. **孤儿 `toolResult` → provider 400。** 已实测 `transformMessages` 不会救（第 2.4 节 1）。缓解：只在 checkpoint 切 + 每次请求前跑 `assertRenderable`。这是最高优先级的守卫。
2. **三处历史分叉**（canonical / `Agent._state.messages` / loop `currentContext`）。已实测会分叉。缓解：单写者 + 4.9 的四处同步 + 一个 debug 断言比较长度。
3. **引用授权窗口放宽**：从 per-Invocation 变成 per-Context + TTL，被伪造/幻觉命中的窗口变长。缓解：严格按 Conversation 隔离、TTL 有界、`send` 仍在边界处校验。这是有意接受的取舍，必须写进 `architecture.md` 的信任边界。
4. **`architecture.md:63` 与 `AGENTS.md` 的现有描述会变成错的**（「每个 Invocation 创建新的 Agent 实例。会话连续性来自 SQLite 中冻结的消息快照，不来自进程内长期记忆」）。文档同步不是可选项。
5. **删掉 per-Invocation 限额后的失控风险**：第 5.3 节的速率保护若不实现，唯一刹车是 daily token 预算。
6. **进程内存**：每 Conversation 一个常驻 Agent + 全量 transcript。靠 `agent_cache_size` LRU 驱逐 + canonical history 重建兜底。注意 `scheduler.ts:362` 已经在每分钟强制 `Bun.gc(true)`，说明内存本来就是关注点。
7. **Prompt 缓存**：GC 与 Context 重建各会失效一次前缀。第 2.4 节 4 已说明大步 GC 更便宜；`system_prompt_hash` 变化则是整体重建，代价更大——这是「改 prompt 要慎重」的新成本。
8. **长活 Invocation 与 `outcome_unknown` 语义**：Invocation 越长，被重启打断且 `side_effect_started = 1` 的概率越高，`outcome_unknown` 会变多（`invocation-queue.ts:72`）。这只是审计噪音，不影响 Context（4.1.6），但排障时要知道。
9. **注入延迟 = Bucket 节拍剩余 + 当前 Tool 批次剩余。** 前者是既有设计的固有延迟（15 秒量级），本特性不改善也不恶化；后者见第 2.5 节。用户体感上是「机器人在忙」，可接受。**不要试图用「消息一到就注入」来消除前者** —— 那会破坏既有的会话节拍与「运行期间的消息进下一个 Bucket」的设计。
10. **Forum Topic**：Context 按 Conversation 隔离，因此同一群不同 Topic 的连续性互相独立。这与既有隔离取向一致，但意味着跨 Topic 的指代（「刚才那个话题里说的」）不会成立。
11. **startup catch-up 与连续 Context 的关系**：启动追赶的 Bucket 也走注入路径，会在 Context 里留下一批 checkpoint。若重启频繁，Context 会被追赶批次占据。可考虑给追赶注入更少的历史条数，本次不做。
12. **Pi 版本锁定**：第 2 节的全部行为绑定 0.84.2。升级前必须重跑第 2.2 节的 5 组实测。

## 13. 可选扩展（本次不做）

- **Admin Panel 的 Context 浏览器**：按 Conversation 展示 canonical history、checkpoint 位置、GC 历史与被淘汰段。只读，符合「审计 API 全部只读」的既有不变量。
- **手动 GC / 手动重建**：Telegram 命令或面板按钮。需要单独评估写入面，不要顺手塞进本特性。
- **按 Chat 覆盖 `agent.context` 参数**（活跃大群保留更多、冷群保留更少）。等真实数据出来再决定，不要提前一般化。
- **重命名既有日志字段** `session_id` / `active_agent_sessions` / `agent_session_skipped_sleeping`（它们实际指 Invocation，与新实体名易混）。属于独立的命名债，会破坏日志消费者，单独提。
