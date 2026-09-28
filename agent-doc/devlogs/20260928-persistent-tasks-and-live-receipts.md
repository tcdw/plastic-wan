# Plastic Wan - 20260928 持久化任务与完成回执热注入

## 背景

此前 Alarm 有专用存储与调度路径，闹钟列表还通过隐藏的 internal context 反复注入。它能处理定时提醒，却不能直接承载「由插件发起、创建它的 Invocation 已结束、稍后才得到结果」的通用任务；隐藏列表也形成了 canonical history 之外的第二份记忆。

本次把长期任务及其投递状态分开持久化，让 Alarm 成为第一个使用者，并补齐「闲时唤醒、聊着时注入」：Conversation 空闲时启动一次回执 Invocation，已有可接收的运行时则把结果放进同一条连续 Context。关键不是把结果越早塞给模型越好，而是不能打断正在执行的工具链，也不能把回执的预算豁免、目标 mention 或前一位用户的权限混进下一轮。

范围是可信内置插件的任务记录、完成入口和回执投递，不是通用后台 executor。Agent 的 Telegram 输出仍只允许模型显式调用 `send`；任务完成、回执处理结束和消息成功送达是三个不同事实。

## 主要变更

### 1. 任务结果与投递状态分开保存

新增 `LongTaskService`、`long_tasks` 和 `task_receipts`。任务在 `waiting` 后进入 `completed`、`failed` 或 `cancelled`；回执独立记录 `pending`、`claimed`、`handled` 或 `suppressed`。完成操作通过状态条件更新和同一事务中的 receipt 插入保证单次结算，重复完成不会重新排队。

插件取得绑定 plugin 与 Conversation 的任务 scope，不能通过工具参数切换这些归属。创建时冻结结构化 payload 和 delivery policy；带 timer 的任务由现有唯一 Scheduler 到期完成，无 timer 的任务等待可信插件调用完成入口。完成入口不依赖创建 Invocation 继续存在，也不沿用其 `AbortSignal`。

通用任务允许没有创建 Invocation 或用户 owner，但不能因此给 Alarm 放宽权限；带 `maxPerInvocation` 的创建仍要求可靠的 Invocation。这里只补最小任务服务，没有新增 worker、running/progress 状态、插件生命周期框架或自动 retry。

实现入口：[src/store/long-tasks.ts:278](../../src/store/long-tasks.ts#L278)、[src/store/long-tasks.ts:318](../../src/store/long-tasks.ts#L318)、[src/store/long-tasks.ts:458](../../src/store/long-tasks.ts#L458)、[src/plugins/plugin.ts:29](../../src/plugins/plugin.ts#L29)。

### 2. Alarm 迁入插件，列表只走正常工具历史

Alarm 的能力、只读 Skill 和 Admin 查询集中到内置插件目录，继续通过 `execute.call` 提供 `alarm`、`list_alarm`、`delete_alarm`，不新增模型原语或 Telegram 发送通道。创建会冻结目标 mention 与每日预算豁免，到期产物仍是结构化提醒数据，不是预生成的聊天文本。

owner 是发起请求的 caller，不是被提醒的 target。三个 Alarm 工具都要求可靠 caller；缺失时返回 `alarm_caller_not_available`。迁移前 owner 为空的行不会拿 target 补成 owner，也不能被用户工具列出或删除。后端始终重新校验当前 owner 和状态，历史列表中的 ID 不等于授权。

移除隐藏的 internal context 存储与渲染链路。`list_alarm` 结果只作为正常工具结果进入 canonical history，同时保留普通审计；跨 Invocation 或进程重开时从保留历史恢复。checkpoint GC 或清空 Topic 后，它随历史一起消失，不再从旁路重新注入。自然语言里的「第二个」可以引用仍保留的列表，但不会把过期观察当成当前数据库事实。

实现与回归入口：[src/plugins/alarm/alarm.ts:53](../../src/plugins/alarm/alarm.ts#L53)、[src/plugins/alarm/alarm.ts:122](../../src/plugins/alarm/alarm.ts#L122)、[src/plugins/alarm/alarm.ts:162](../../src/plugins/alarm/alarm.ts#L162)、[test/alarm-context.test.ts:218](../../test/alarm-context.test.ts#L218)、[test/alarm-context.test.ts:329](../../test/alarm-context.test.ts#L329)。

### 3. 每条回执拥有独立 Bucket，运行中按轮次注入

Scheduler 先处理到期 timer，再领取可投递的 pending receipt；领取时为每条回执建立独立的空 Bucket，不伪造 Telegram Update、Message 或 Revision。投递仍检查 allowlist、Topic 和 pause，并遵守同 Chat 串行与全局并发限制。

- 同一 Conversation 已有 running Invocation 且仍接受注入：attach 回执 Bucket，不另开 Invocation；一次运行可以接收多条回执。
- 同 Chat 没有 running Invocation：创建 queued 回执 Invocation，启动优先级高于普通排队工作。
- 运行已进入 closing，或同 Chat 的另一 Topic 正在运行：保留 pending，等可接收时再 claim，不把结果送进错误 Topic，也不忙等。

运行内的顺序与排队启动优先级是两回事：回执轮开始前，已经 attach 的普通消息批次优先；当前工具链结束后才一次注入一条回执，各自形成 checkpoint。已经开始的回执轮不会与普通消息或另一条回执合并。空闲宽限期内到达的回执会唤醒同一个 Invocation。

Context 中把可信的「当前有任务完成，可以处理结果」说明与 `<untrusted_task_receipt>` 分开。结果仍是数据，不提升为指令；模型可以不发言，普通 assistant 文本不会直接发送。

实现入口：[src/orchestration/invocation-queue.ts:530](../../src/orchestration/invocation-queue.ts#L530)、[src/orchestration/conversation-runtime.ts:146](../../src/orchestration/conversation-runtime.ts#L146)、[src/orchestration/agent-runtime.ts:471](../../src/orchestration/agent-runtime.ts#L471)、[src/context/context-builder.ts:383](../../src/context/context-builder.ts#L383)。

### 4. 权限、mention 与预算豁免只属于当前回执轮

回执不是新的用户请求。注入时清空 caller，不能继承前一位发言者列出或取消其任务的权限；之后普通批次按自己的可信 sender 恢复 caller。mention 按 task 分开，只在对应回执轮第一次成功的文本发送后消耗，Sticker 或失败发送不提前消耗。

`bypassDailyBudget` 默认关闭，只有可信代码在任务创建时显式冻结才能绕过 sleep 与每日 Token gate。豁免不覆盖目的地、pause、并发、wall-clock、上下文限制或发送限流。回执轮结束即清除 completion 状态，重新应用普通预算与 `zzz` 可见性，不能等整个 Invocation 结束才恢复。

这里同时更新 Pi 的当前 loop context 和 `Agent.state.tools`：Pi 在 `shouldStopAfterTurn` 之前准备工具集，如果热注入只改 Agent 缓存，下一次模型请求仍可能拿到上一轮的 `zzz`。专项测试直接检查 Faux 接收到的模型请求里的工具集合，而不只检查内部标志。

回执不触发普通回复的 pending-message `send` barrier；回执轮已经开始后，新用户消息也不会拦住该轮发送，而是等该轮结束再注入。这是为了保住独立轮次和 delivery policy，不是放宽 `send` 的输入、授权、取消或限流校验。

实现与回归入口：[src/platform/invocation-context.ts:152](../../src/platform/invocation-context.ts#L152)、[src/orchestration/agent-runtime.ts:315](../../src/orchestration/agent-runtime.ts#L315)、[src/orchestration/agent-runtime.ts:511](../../src/orchestration/agent-runtime.ts#L511)、[src/orchestration/agent-runtime.ts:639](../../src/orchestration/agent-runtime.ts#L639)、[src/orchestration/agent-runtime.ts:756](../../src/orchestration/agent-runtime.ts#L756)、[src/capabilities/send-tool.ts:361](../../src/capabilities/send-tool.ts#L361)、[test/task-hot-injection.test.ts:400](../../test/task-hot-injection.test.ts#L400)。

### 5. 未消费回执可转交，但取消和重启不能导致重放

`steer` 只是入队，Bucket 仍要等消息成功写入 canonical history 才确认注入。运行失败或结束时，尚未消费的 attached Bucket 可以重新排队；回执归属先转给新 Invocation，再结算旧 Invocation 的回执，避免旧运行把未处理结果一起标成 handled。

取消边界刻意区分：

- `/pause` 或 Admin 取消会让尚未注入的 attached Bucket 过期，随后 suppressed，不能在旧运行释放时复活。
- Admin「Cancel ongoing」取消已排队或运行中的会话工作，不取消尚未 claim 的 pending receipt；这些结果仍能在后续调度中投递。
- 已完成任务的 pending receipt 可以单独取消投递，但任务结果不回退；claimed receipt 不能再单独取消，运行中的工作走 `AbortSignal` 收尾。
- 进程恢复将已 claimed 回执收为 handled / `outcome_unknown`，即使关联 Invocation 已缺失或已终结也不重放。这不是成功送达证明，也没有 exactly-once Telegram 保证。

未消费 attached 回执的进程内转交不等于通用 retry：已消费回执随 Invocation 终态结算；无预算豁免的回执若在 claim 后、launch 前遇到睡眠，仍可能以 handled / `skipped_budget` 结束，不承诺稍后重试。

retention 只清理超过在线保留窗口、任务已终态且 receipt 已 handled/suppressed 的记录。waiting 任务和 pending/claimed receipt 保留，包括没有 timer、创建 Invocation 已被清理的任务。不能把「创建者已结束」当作外部任务孤儿的判据，否则会破坏稍后完成的契约。

实现与回归入口：[src/orchestration/invocation-queue.ts:130](../../src/orchestration/invocation-queue.ts#L130)、[src/orchestration/invocation-queue.ts:451](../../src/orchestration/invocation-queue.ts#L451)、[src/orchestration/scheduler.ts:329](../../src/orchestration/scheduler.ts#L329)、[src/ingress/admin/operations.ts:12](../../src/ingress/admin/operations.ts#L12)、[src/store/database.ts:341](../../src/store/database.ts#L341)、[test/task-runtime.test.ts:245](../../test/task-runtime.test.ts#L245)。

### 6. 三步迁移与保留的管理界面契约

- [020_long_tasks.sql:1](../../src/store/migrations/020_long_tasks.sql#L1)：建立任务和回执表，将旧 Alarm 的 ID、owner、定时信息、delivery policy 与审计状态迁移后删除旧表。旧 pending 变为 waiting；firing/fired 分别形成 completed + claimed/handled；cancelled 形成 cancelled + suppressed。
- [021_drop_internal_contexts.sql:1](../../src/store/migrations/021_drop_internal_contexts.sql#L1)：删除整张 `internal_contexts` 表，而不是保留某类隐藏上下文作为 fallback；正常 canonical history 与普通审计不由此删除。
- [022_task_receipt_buckets.sql:1](../../src/store/migrations/022_task_receipt_buckets.sql#L1)：增加 receipt 的 `bucket_id` 并从既有 Invocation 回填；Invocation 唯一索引改为普通索引，Bucket 保留非空唯一约束，允许同一 Invocation 拥有多条独立回执。

Admin 的 Alarm 页面继续使用 pending/firing/fired/cancelled 四态，但它是任务与回执的组合投影，不是直接照搬任务状态枚举。waiting 或 completed + pending 仍显示 pending，claimed 显示 firing，handled 显示 fired，取消任务或 suppressed 投递显示 cancelled。completed + pending 仍能列出和取消，不把「timer 已到期」误当成「已经发出提醒」。实现见 [src/plugins/alarm/admin.ts:67](../../src/plugins/alarm/admin.ts#L67)。

本次没有增加产品配置字段。同步更新仓库入口、架构、数据层、调度流程、Admin 和验证说明，以及公开的[预算指南](../../apps/docs/content/docs/guides/budgets.md)与[扩展指南](../../apps/docs/content/docs/guides/extensions.md)；不把历史设计或开发日志自动发布到用户文档站。

## 验证

本次按约束直接使用已安装的 Node 与工具入口，没有运行 pnpm/npm/npx 或安装依赖。实际 Node 为 24.18.0。功能提交前的最终全量 Vitest 结果为 **57 个文件、668 项测试通过，0 失败、0 pending**；日志编写阶段另复跑以下 8 个受影响文件，共 **108 项通过**，没有把专项结果冒充全量重跑。

```bash
node node_modules/vitest/vitest.mjs run test/long-tasks.test.ts test/long-tasks-migration.test.ts test/task-delivery.test.ts test/task-runtime.test.ts test/task-context.test.ts test/task-hot-injection.test.ts test/alarm.test.ts test/alarm-context.test.ts
# Test Files 8 passed (8) / Tests 108 passed (108)

node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p apps/admin-next/tsconfig.json
node scripts/docs-prepare.ts
node node_modules/typescript/bin/tsc --noEmit -p apps/docs/tsconfig.json
# runtime、Admin、docs 类型检查通过；与根 check 的检查范围一致

node node_modules/@biomejs/biome/bin/biome lint .
node node_modules/@biomejs/biome/bin/biome format .
# lint 297 文件、format 294 文件；No fixes applied，均退出成功
# 两个命令各有 1 条 warning：既有临时 JSON 超过项目 1 MiB 检查上限
```

临时大文件警告不涉及本次修改，没有改动无关临时资料，也没有放宽检查上限；不将该次 lint 描述为零警告。功能提交前的检查记录为 lint 287 文件、format 284 文件通过。

回归覆盖不只断言回答文字：

- 迁移状态映射、空 owner、重复完成、跨 plugin/Conversation 隔离、JSON 边界，以及创建 Invocation 删除后仍可完成任务。
- Alarm 列表在 canonical history、缓存与后续模型请求中的一致性；GC、Topic 清空、owner 变化后的权限拒绝与审计状态。
- 空闲唤醒、同 Conversation 热注入、多 receipt 独立 Bucket/checkpoint/mention、普通工具链不被打断，以及普通消息与回执的顺序边界。
- 预算和 `zzz` 在 Faux 接收到的模型请求工具集中的恢复，caller 不继承；模型失败后的归属转交、取消不复活、pending receipt 不被 Cancel ongoing 误删、重启不重放。
- 任务、回执、Bucket、Invocation、模型调用和发送审计的持久化状态，以及长期任务的保留边界。

功能提交前还通过 Rspress 生产构建，并检查两篇变更指南的 HTML、Markdown、llms 输出及 80 个本地目标链接；相关 6 篇主题文档检查了 41 个文件链接和 21 个标题锚点。这些是当时的静态构建证据，不是本篇日志提交后的发布产物。日志阶段的 `docs-prepare` 已重新生成版本来源信息，没有重新生产构建，也未运行包含 HTTP 预览的完整文档验收。

本篇日志另核对了 32 个仓库内文件链接及行号锚点，逐行检查无尾随空白、冲突标记或构建机绝对路径；`git diff --check` 无输出。未修改旧日志或其他业务文件。

### 尚未验证

未启动真实 Bot、Doctor 或在线 Provider/Telegram/MCP，没有读取真实配置、密钥或数据库。迁移与恢复结论来自临时 SQLite 和 Faux/fixture，不等同部署数据库升级、备份恢复或真实提醒验收；Docker、真实 Admin 浏览器交互、文档 HTTP/视觉检查与公开托管均未在本次执行。

## 提交

代码与配套行为文档先提交，本篇开发日志单独提交；不回改旧日志。

```txt
a4e78e6d88ecc28790f91011393d46e639cf0ebc Implement persistent tasks and live receipt injection
```
