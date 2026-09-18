# 审计表参考

Plastic Wan 的审计数据全部在 `paths.database` 指向的 SQLite 里。本页只列审计会用到的事实与字段语义；权威定义在 `src/store/schema.ts`，行为语义在 `agent-doc/`。

## 目录

- [Invocation 主链路](#invocation-主链路)
- [模型与工具](#模型与工具)
- [发送](#发送)
- [Agent 消息](#agent-消息)
- [消息入库](#消息入库)
- [Context 与参与](#context-与参与)
- [症状 → 结论速查](#症状--结论速查)

## Invocation 主链路

- `telegram_updates`：每条收到的 Update 一行；`allowed = 0` 表示被 allowlist 或闸门拦下，`rejection_reason` 给出原因。命令消息只在这里出现。
- `buckets`：`kind` 为 `realtime` / `startup_catch_up`；`state` 为 `collecting` / `queued` / `running` / `completed` / `failed` / `aborted` / `outcome_unknown` / `merged` / `expired` / `skipped_budget`。`skipped_budget` 与 `expired` 表示这批消息没开成会话。
- `invocations`：一次运行一行。`state` 为 `queued` / `running` / `completed` / `failed` / `aborted` / `outcome_unknown` / `skipped_budget`。
  - `prompt_version`：创建该行时 `src/platform/agent-protocol.ts` 的 `AGENT_PROMPT_VERSION`。与当前代码不一致 = 当时用的是旧系统提示词。
  - `config_hash`：创建时的配置哈希；与 `node src/cli.ts check-config --config <file>` 的输出比对可判断运行期配置是否已变。
  - `sends_used` / `tool_calls_used` / `turns_used`：审计计数，不是配额。
  - `completion_reason`：结束原因，自由文本。当前代码产出 `completed` / `context_limit` / `turn_budget` / `wall_clock` / `sleep` / `budget`；恢复路径产出 `process_restart` / `recovery_age` / `outcome_unknown`；历史行里还能看到 `Error` / `model_error` / `timeout` / `aborted`。**只有 `completed` 是正常结束**。
  - `side_effect_started`：是否已开始产生副作用（决定崩溃后是 `aborted` 还是 `outcome_unknown`）。
- `invocation_messages`：冻结的注入批次。`section = 'new'` 是本批消息（唯一能创建当前任务的部分），`'history'` 是历史补渲染；`snapshot_json` 是模型当时看到的快照原文（媒体已换成 `img_` 引用，本批图片另以 `figure_N` 附带）。

## 模型与工具

- `model_calls`：每次 Provider 请求一行。`role` 为 `agent`（主 Agent）/ `doctor` / `vision_chat` / `vision_sticker`。`state` 为 `pending` / `success` / `error`。
  - `request_json` 含完整的 `messages` 与 `tools` —— **这是还原「模型当时到底看到了什么」的唯一权威来源**，`prompt` 子命令就是从这里取 system prompt。
  - `tools_json` 记录该请求实际附带的工具名；`error_code` / `error_detail` 给出失败原因。
- `tool_calls`：一次 Tool Call 一行。`state` 为 `pending` / `success` / `error` / `outcome_unknown` / `blocked_budget`；`side_effect` 标记是否有外部副作用；`arguments_json` 与 `result_text` 是入参与返回。
- `invocations.tool_registry_json`：该次运行可用的工具注册表快照。

## 发送

- `telegram_sends`：`send` 工具产生的每一次 Telegram 调用。`kind` 为 `text` / `sticker`；`state` 为 `pending` / `success` / `error` / `outcome_unknown`；成功时 `telegram_message_id` 是 Telegram 返回的消息 ID。
- 判定：`sends_used = 0` 表示**没有任何发送**；`telegram_sends.state != success` 才是发送故障。`outcome_unknown` 必须按「可能已发出」处理，不得重试或声称成功。

## Agent 消息

- `agent_messages`：`role` 为 `assistant`（普通 Assistant 文本，**私有推理记录，永不发布**）/ `tool_result`（发给模型的工具结果）/ `harness_nudge`（harness 提醒模型用 `send` 发布的 steer 消息）。
- 关键判读：出现 `assistant` 私有文本 + `harness_nudge` 但 `sends_used = 0`，说明模型被提醒后仍选择不发言——沉默来自模型，不是 harness。

## 消息入库

- `messages`：`sent_by_bot` 标记 Bot 自己发出的消息；`visible = 0` 表示已不可见（删除等）。`telegram_date` 是 Telegram 时间戳。
- `message_revisions`：编辑保留多版本；`current_revision_id` 指向最新版；`reply_snapshot_json` 保存被回复消息的发送者与内容。
- `senders`：`display_name` / `username` / `telegram_type`。群友昵称可能随时间变化，审计以行内快照为准。

## Context 与参与

- `conversation_contexts`：`head_seq` / `next_seq` 定义保留区间；`system_prompt_hash` 变化即 Context 重建；`send_count_total` 是累计发送数。
- `context_messages`：canonical history 行，`role` 为 `user` / `assistant` / `toolResult`。`is_checkpoint = 1` 标记可裁剪边界；`evicted_at` 非空表示已被 GC 丢弃（模型看不到）。GC 后 `head_seq` 前移。
- `conversation_attention`：时段外被触发消息开出的注意力窗口（`trigger_kind` 为 `mention` / `reply_to_bot` / `keyword`）。过期即窗口失效。
- `memories`：短期记忆，`expires_at` 到期即不再注入；`<memory_list>` 为空时注入块里没有该块。

## 症状 → 结论速查

| 症状 | 结论 |
| --- | --- |
| `sends_used = 0`，有 `harness_nudge` 与私有文本 | 模型被提醒后仍选择沉默，harness 无责 |
| `sends_used = 0`，无私有文本也无 Tool Call | 模型没有产出；先查 `model_calls.state = error` 与 `completion_reason` |
| `telegram_sends.state` 为 `error` / `outcome_unknown` | 发送失败或结果未知，不得声称已发送 |
| `tool_calls.state = blocked_budget` | 预算闸门拦下了副作用 |
| `completion_reason` 为 `budget` / `sleep` | 每日预算耗尽或处于睡眠状态 |
| `completion_reason` 为 `turn_budget` / `wall_clock` / `context_limit` | 每批轮数上限 / 单次运行超时 / 进入收尾模式 |
| `completion_reason` 为 `process_restart` / `recovery_age` | 运行被进程重启或恢复流程中断 |
| `prompt_version` 小于当前 `AGENT_PROMPT_VERSION` | 该次运行用的是旧系统提示词 |
| `buckets.state` 为 `skipped_budget` / `expired` | 消息没开成会话 |
| `telegram_updates.allowed = 0` | 被 allowlist 或参与闸门拦下，看 `rejection_reason` |
| `conversation_attention` 已过期 | 时段外没有注意力窗口，需要触发消息才能唤醒 |
| `context_messages.evicted_at` 非空 | 该历史已被 GC 丢弃，模型看不到 |
