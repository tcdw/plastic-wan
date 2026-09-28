# Plaswan Core 与 Telegram Adapter 分离 Epic

状态：规划完成，实施未开始。产品仍为 Telegram Bot，Telegram 仍是唯一正式支持的 Host。

调研基线：`41a3034ae6bc983410abef48d9ccd874b2c1d057`（2026-09-28）。本文记录目标、决策和待办；当前行为以源码及 `agent-doc/` 顶层主题文档为准。后续实施时重新核对基线，不把本计划中的目标接口当成现有实现。

## 目标与交付边界

让 Agent Harness 不再解释 Telegram 类型、身份、路由和 API 行为。Telegram Adapter 负责将平台输入、能力和策略接入 Harness，组合根维持当前 Telegram Bot 产品的装配与运维。

本 Epic 交付同一仓库、同一进程内可验证的模块边界。保留单一 SQLite、现有 Provider、唯一 Scheduler、工具审计及 canonical Conversation Context。独立 npm package、公共 SDK 和独立部署不是完成条件。

目标依赖方向：

```text
Plaswan Telegram Bot / application composition
  ├─ Telegram Adapter ──→ Core contracts
  ├─ Core runtime
  └─ Product configuration, Admin, migrations, backup and lifecycle

Core runtime ──→ neutral contracts / shared infrastructure
Core runtime ──X─→ Telegram Adapter / grammY / Telegram-specific schema
```

Core 可以组装 Adapter 注入的工具与环境说明，因此 Agent 仍然可以知道自己在 Telegram 中；Core 自身不解释 `message_thread_id`、`MarkdownV2`、Sticker file ID 或 Telegram user ID。

Admin 后端也属于本次边界工作：通用 Harness 审计与 Telegram 管理投影分开，产品级 API 继续组合两者。前端继续是一体化的 Telegram Bot 管理面板，保留现有群聊、消息、Sticker、发送记录等页面，不增加 Host 选择器或通用面板插件系统。

不在本 Epic 中实施：

- Discord、QQ、Matrix、Slack 或第二种正式 Adapter。
- Universal IM API、统一富文本协议、跨平台身份合并或会话桥接。
- reaction、消息删除、发送后编辑、inline query 等新产品能力。
- 完整 ConversationEvent 总线、分布式消息队列、RPC、插件市场。
- subagent、通用后台 executor、任务 progress/retry；当前没有这些能力需要随拆分迁移。
- 与边界无关的代码整理、全仓库命名替换或一次性目录搬迁。

## 已核对的起点

| 当前事实 | 源码入口 | 对计划的约束 |
| --- | --- | --- |
| Telegram Update 先经准入、消息/Revision 入库，再进入 Bucket | [telegram-ingestion.ts](../../src/ingress/telegram-ingestion.ts) | 保留去重、参与策略及编辑不触发 Bucket 的行为 |
| 排队或 attach 时冻结消息快照 | [invocation-snapshot.ts](../../src/store/invocation-snapshot.ts)、[invocation-queue.ts](../../src/orchestration/invocation-queue.ts) | 不能在首次接收时永久冻结正文 |
| Runtime 自己构造 Telegram send，并识别其工具名 | [agent-runtime.ts](../../src/orchestration/agent-runtime.ts)、[send-tool.ts](../../src/capabilities/send-tool.ts) | 输出注入必须同时迁移 nudge、closing、屏障和 GC 计数 |
| ContextBuilder 查询 Telegram 表、渲染平台元数据，并反解析消息头恢复状态 | [context-builder.ts](../../src/context/context-builder.ts) | DTO、内容展示与可信运行 metadata 必须分开处理 |
| 引用生命周期属于 Context，引用目标却包含 Telegram file/thread/message 信息 | [context-refs.ts](../../src/context/context-refs.ts)、[invocation-context.ts](../../src/platform/invocation-context.ts) | 授权有效期和平台目标解析需要分离 |
| Context 按 Conversation 隔离，运行和模型锁按 Chat 串行 | [scheduler.ts](../../src/orchestration/scheduler.ts)、[agent-runtime.ts](../../src/orchestration/agent-runtime.ts) | Conversation identity 不能代替 execution key |
| usage 按 Chat resource 记录，每日 token 预算汇总这些记录 | [sleep.ts](../../src/store/sleep.ts)、[agent-runtime.ts](../../src/orchestration/agent-runtime.ts) | 不顺手改成每 Topic 独立预算 |
| 插件贡献 execute capabilities/Skills，但 scope 暴露完整配置和平台相关 Context | [plugin.ts](../../src/plugins/plugin.ts)、[execute-tool.ts](../../src/capabilities/execute-tool.ts) | 复用现有插件体系，收窄 scope，不新增 Host 插件框架 |
| 长期任务状态机基本通用，owner/delivery/Alarm target 仍含 Telegram 用户语义 | [long-tasks.ts](../../src/store/long-tasks.ts)、[alarm.ts](../../src/plugins/alarm/alarm.ts) | 迁移任务身份、mention 与存量 receipt，保留恢复语义 |
| Memory 主体只依赖内部 Conversation ID | [memory.ts](../../src/context/memory.ts) | 保持 ID 连续，避免不必要的数据搬家 |
| Schema、retention 和 Admin 混合 Core 与 Telegram 数据 | [schema.ts](../../src/store/schema.ts)、[database.ts](../../src/store/database.ts)、[audit.ts](../../src/ingress/admin/audit.ts) | 分模块后仍需处理真实的 FK、查询和清理所有权 |
| Invocation/Context 审计通过 mandatory join 读取 Telegram Chat；前端 DTO 也要求 Chat/Topic | [audit.ts](../../src/ingress/admin/audit.ts)、[api.ts](../../apps/admin-next/src/lib/api.ts) | 后端通用查询必须脱离平台表，Telegram DTO 留在产品 API 层组合 |
| Memory 管理输入与列表、Alarm 管理投影带有 Telegram 身份 | [memory-admin.ts](../../src/ingress/admin/memory-admin.ts)、[admin.ts](../../src/plugins/alarm/admin.ts) | 平台身份解析留在管理边界，内部服务使用 Conversation/actor/task ID |

当前 `send` 只发送文字或贴纸；reply 是可选参数。图片理解涵盖 Photo、受支持的图片 Document 和 Sticker，不代表支持任意文件。启动追赶已按 Conversation 分开；相关文档和 Prompt 中仍有跨 Topic 的旧措辞，不以该措辞作为迁移目标，也不在机械拆分时无意修改模型行为。

前一轮调研实际执行了 `pnpm run check`，以及 13 个相关文件、131 项测试，均通过；不是全量测试结论，也不是本 Epic 的交付验收结果。未执行真实 Telegram/Provider 验收。

## 已确定的设计方向

### 最小输入与环境契约

契约只承载当前流程已经需要的信息。具体类型名在相关任务实现时确定，不提前创建公共协议包。

| 数据 | Core 需要知道 | Adapter 保留 |
| --- | --- | --- |
| Conversation | 稳定内部 ID、时区、解析后的指令与运行策略 | Chat/Topic 映射、迁移和目的地路由 |
| Actor | 不透明稳定 key、显示信息；独立的可信 caller 身份 | Telegram user/sender_chat 区别及外部 ID |
| Message | 不透明 key、revision、时间、sender、sentByAgent、内容片段 | 原始 Update、实体、forward origin、媒体组、平台排序与去重 |
| Content | text、image/file 描述与不透明 asset key、是否可内联 | 下载、file ID、Sticker 转换、平台媒体限制 |
| Reference | Context、承载 seq、TTL、允许的使用方式 | 回复目的地、thread、file、Sticker 等实际目标 |
| Scheduling | execution key、解析后的窗口、是否可运行 | allowlist、participation、Chat 暂停、Topic 移除及 catch-up 筛选 |
| Usage | usage key、现有 token/cost 计量规则 | Telegram Chat 到记账资源的映射 |

收集阶段通知稳定 message key 和准入结果；queue/attach 的冻结边界读取最新 Revision，得到平台无关快照。编辑更新来源记录，不额外唤醒 Agent。历史文本仍只提供背景，不能被当作新的任务来源。

file 描述不授予读取任意文件的能力。asset key 不直接暴露原始 file ID，也不替代当前 Context 的授权检查。转发说明、引用摘录及媒体标签按不可信内容渲染。

本次无需新增完整 `ConversationEvent` union；保留消息批次和现有 task completion 两类运行输入。新平台事件需要真实产品需求后再定义其唤醒、排序和恢复语义。

### Conversation 与 Invocation 的关系

Conversation 标识持续的上下文与隔离范围；Invocation 是有起止状态的运行窗口。当前实现已经允许同一 Conversation 有多次 Invocation，也允许运行中的 Invocation attach 新 Bucket。这两个身份不能因未来可能出现 Thread 型 Host 而合并。

外部 Thread 映射到哪个 Conversation、何时启动或继续一次 Invocation，由 Host 输入策略和产品需求决定。未来可以选择“一个 Thread 只运行一次”的策略，也可以让同一 Thread 多次运行；本 Epic 不预设 Slack 的映射方式，更不在数据库、查询或 Admin DTO 中建立 Thread 与 Invocation 一对一约束。任务 receipt 等运行输入也不能要求一定存在一条 Telegram 消息。

当前只保留稳定的 Conversation → Invocation 关联和可审计的输入来源，不提前增加 Workspace/Channel/Thread 的统一层级协议。

### 输出与能力契约

Adapter 提供当前可用工具的 Schema、描述与实现；Core 只识别少量运行角色。复用已有 `AgentTool`、工具工厂和 `ExecutableCapability`，不在 Core 规定所有 Host 共享的 send 参数。

Telegram 的首个实现保持工具名 `send`、现有参数及返回契约。核心输出角色需要覆盖以下已有行为：

- 对话输出工具可以参加 nudge 与 closing；Telegram 的原提示文字在机械拆分时保持不变。
- 输出尝试、确认成功、结果未知分别处理。当前 `sendUsed` 在执行结束时置位，而 GC 只统计成功 send，不合并这两个指标。
- Core 管理待注入新消息与屏障状态，Adapter 在副作用开始前及现有 429 重试检查点调用屏障。
- 直接工具不能通过 execute 间接调用；名称冲突与禁止集合根据实际装配结果校验。
- 注册表预览、真实运行、热配置候选校验与每次模型请求审计使用一致的装配规则。
- Plugin/Host 提供的 Skill 与说明只描述实际能力；不会因某工具缺席而留下要求调用它的文档入口。

Core 管理通用 deadline、取消、工具审计及恢复约束；Telegram Adapter 管理限流、429、网络未知结果、API 接受语义与发送记录。保留 Telegram 已接受但本地写入失败时不误报“未发送”的行为。

reply 暂时仍是 Telegram send 参数。未来若实现 reaction，可以贡献单独的副作用能力，但不默认把它算成成功回复或 GC 保留单位。本 Epic 不实现 reaction。

### Admin 后端边界与产品组合

当前 `listInvocations`、`getInvocation`、`listConversationContexts` 和 `getConversationContext` 都依赖 Telegram Chat join；`getInvocation` 同时读取通用模型/工具记录与 `telegram_sends`。这意味着仅把运行时拆开，仍无法独立查询没有 Telegram Chat 的 Core 运行记录。后端按已有查询的职责拆分，不把所有管理页面变成统一 IM 协议。

| 层次 | 负责的数据与行为 | 依赖约束 |
| --- | --- | --- |
| Core 审计查询与管理服务 | Invocation、模型/工具调用、Context/canonical history、refs 生命周期、usage、memory、长期任务状态 | 使用内部 Conversation/Invocation/task ID；不要求 Telegram Chat/Message 存在；平台专有引用目标不进入中性 DTO |
| Telegram 管理投影 | Chat/Topic、收到的消息与 revisions、sender、reply、媒体/Sticker、Telegram 发送和平台配置/控制 | 保留完整 Telegram 细节，通过内部 ID 关联 Core 记录 |
| 产品 Admin API | 组合通用运行记录和 Telegram 投影，维持当前页面接口、筛选和错误契约 | 可以知道 Telegram；复用现有 AdminServer、认证、Origin 校验与写入白名单 |

“审计群聊消息”本身仍是 Telegram 投影。可复用的是底层 Harness 运行审计和内部关联，不要求它承诺展示未来所有 Host 的原始消息。`telegram_sends`、ChatSummary、Topic 字段可以继续出现在产品 HTTP 响应及前端类型中；这些是正式产品边界，不是需要长期保留的旧实现别名。通用查询可以只是内部 TypeScript 接口，无需同步发布第二套 HTTP API。

组合查询必须保留以下约束：

- Telegram 筛选在产品层解析为内部查询范围，过滤在分页前完成；不能先取一页再删去不匹配记录。详情、游标、排序、统计和空结果语义保持原状。
- Core 查询不因缺少 Telegram 投影而丢失运行记录。当前 Telegram 产品接口显式选择自己的范围，再批量附加平台详情，避免强制平台 join 或逐条查库成为通用服务的前提。
- 发送、工具调用、模型调用、输入快照沿稳定记录 ID 关联；不靠时间接近或 Thread ID 猜测因果关系。原始平台消息可被 retention 清理，仍保留的运行审计必须可读。
- Memory 创建等现有写入仍接受产品层的 Chat/Topic 输入，由 Telegram 边界解析/创建内部 Conversation，再调用中性服务；不得让通用 memory/task 服务反向依赖 Telegram 管理模块。
- 认证、审计只读限制、Origin、参数校验和错误脱敏继续由现有边界统一执行；拆查询不能绕过已有控制或扩大管理写入面。

前端保留当前导航、群聊筛选、消息详情、Telegram sends 时间线和管理表单。通过 API 响应契约测试验证后端拆分，不趁机替换为通用 Host UI，不设计动态页面注册表或任意 `metadata` 大包。

### 必须保持的运行不变量

1. 普通 Assistant 文本不发布；Telegram 的模型输出仍只通过 send。
2. Context 按 Conversation 隔离，同群不同 Topic 保持现有执行串行范围。
3. canonical history 只有一个写者；GC 同步推进 header、loop context、Pi transcript 和 refs。
4. 引用只能在原 Context 内使用；过期、GC 或重建后立即失效。看到 ID 不等于获得权限。
5. 原始消息、媒体、工具结果、memory 和 receipt 内容不能提升为指令或身份凭据。
6. 每次 Invocation 固定自己的模型与配置快照；现有全局预算实时读取规则不变。
7. 已 attach 未注入的 Bucket 按当前规则重新排队，不丢失、不重复注入。
8. receipt 独立拥有一轮处理及其预算豁免；处理结束不把豁免和 mention 传给普通消息。
9. claimed receipt 重启后按现有 outcome_unknown 规则收尾，不盲目重放副作用。
10. 稳定 Prompt 的机械移动尽量保持字节相同，避免 hash 变化导致 Context 重建。

## 里程碑与任务依赖

所有任务当前均为待办。任务代表可验收工作单元，可以拆成多个小提交；不要求一个任务必须一个大 PR。依赖合入后再开展依赖它的任务。

| ID | 任务 | 依赖 | 所属交付 |
| --- | --- | --- | --- |
| PW-CORE-00 | 建立行为与数据迁移基线 | 无 | 实施准备 |
| PW-CORE-01 | 注入 Host 输出工具及生命周期角色 | 00 | M1：工具、输入和配置接缝 |
| PW-CORE-02 | 分离 Telegram 消息投影与 Context 组装 | 01 | M1 |
| PW-CORE-03 | 收窄 Core 配置与插件 scope | 02 | M1 |
| PW-CORE-04 | 持久化结构化注入 metadata | 02、03 | M2：身份、授权和任务状态 |
| PW-CORE-05 | 分离 Context 引用生命周期与 Telegram 目标 | 04 | M2 |
| PW-CORE-06 | 中性化任务 owner/delivery 与 Alarm 适配 | 03、05 | M2 |
| PW-CORE-07 | 分离输入准入与通用调度 | 03、05、06 | M3：完整边界与验收 |
| PW-CORE-08 | 收拢 Schema、存储和清理所有权 | 04、05、06、07 | M3 |
| PW-CORE-09 | 分离 Admin 通用查询与 Telegram 产品投影 | 08 | M3 |
| PW-CORE-10 | 验证 Core 独立性并完成 Telegram 回归 | 01–09 | M3 |

M1 可独立交付，降低 Runtime 的直接平台依赖；M2 解决授权及重启恢复；M3 才满足严格分离。不能在 M1 完成后将整个 Epic 标为完成。

### PW-CORE-00 — 建立行为与数据迁移基线

- [ ] 完成任务。

范围：重新核对当前 HEAD、现有测试与迁移，列出计划中保留的行为和必须转换的持久化格式；明确 Core 拥有的模块集合、Adapter 查询边界及共享基础设施清单。此时仅确定表的所有权和迁移顺序，不实施全量拆表。

验收：建立可复跑的旧库 fixture，覆盖至少一份非空 canonical history、有效/过期 refs、memory、waiting task、pending/claimed receipt，以及同一 Conversation 的多次 Invocation。固定 Admin 列表/详情、Chat/Topic 筛选、游标、统计和写入校验的当前契约。复用现有 fixture，只有缺失的契约才新增测试。记录初始 `check`、相关测试、全量测试和 lint 结果，区分已有失败与后续回归。fixture 只使用合成数据。

风险：用自然语言回复或测试标题代替状态断言；误把旧文档描述当作现状。测试必须覆盖真实 SQL 状态与审计结果。

提交/回滚：测试与基线文档可独立提交和回滚，不改生产行为。交付物是后续每个迁移任务的输入，不是第二套测试框架。

### PW-CORE-01 — 注入 Host 输出工具及生命周期角色

- [ ] 完成任务。

范围：`application.ts`、`agent-runtime.ts`、`send-tool.ts`、`execute-tool.ts` 及其调用方。组合根装配 Telegram send；Runtime 不再要求 `TelegramSendApi` 或 Bot 身份。保留现有 Telegram Schema、返回文本、工具顺序和描述。以最小角色信息替代 Core 对 send 名称的运行判断，并保持旧 nudge、closing、发送计数和屏障效果。

验收：`agent-runtime`、`context-send`、`context-hot-inject`、`task-context`、`skills`、`tool-schema` 和工具注册表相关测试通过。补充必要的工厂测试：只有 text 参数、不同工具名的合成输出工具仍可被识别；直接工具经 execute 调用被拒绝；预览与运行使用相同 Schema。此阶段 fixture 可以继续沿用旧身份结构，不将其宣称为完全独立 Core。

风险：漏迁成功 send 计数、把失败尝试当作成功、取消后仍产生副作用、429 等待后漏查屏障、配置校验误用另一套工具列表。Telegram 详细审计保留，不能只剩通用 tool_calls。

提交/回滚：工厂及所有调用方清理式切换；不改数据库和模型可见契约，可直接回滚该代码变更。不要保留默认 Telegram fallback。

### PW-CORE-02 — 分离 Telegram 消息投影与 Context 组装

- [ ] 完成任务。

范围：`context-builder.ts`、`invocation-snapshot.ts`、`agent-protocol.ts`、Telegram 消息归一化和媒体上下文贡献。引入满足当前字段的中性消息投影；Telegram SQL、forward/reply 描述、Sticker catalog 由 Adapter 提供。Core 保留受限上下文选择、可信 runtime_state 与不可信内容封装。

验收：同一输入生成的 Telegram 模型请求、冻结 Revision、Prompt hash、引用关系、图片顺序与原行为一致；编辑在冻结前可影响快照，冻结后不能改写快照。Photo/图片 Document 的内联与 Sticker 按需观察不改变。特殊字符不能伪造消息头、runtime block 或授权信息。

风险：归一化丢失回复引用、sender_chat 或转发信息；过早冻结；图片与 figure 标记错位；稳定 Prompt 重排导致历史重建。现有文本回读可在本任务中保留，明确由 04 清除，不能据此宣称身份已中性化。

提交/回滚：优先保持存储格式不变，Adapter 从旧表投影中性 DTO；可直接回滚。若实现需要改存储格式，拆成显式迁移提交，执行后文数据回滚规则。

### PW-CORE-03 — 收窄 Core 配置与插件 scope

- [ ] 完成任务。

范围：`runtime-config.ts`、`providers.ts`、Runtime、ContextBuilder、`plugin.ts` 和组合根。产品层解析 Chat override、模型、指令、时区、bucket window、execution/usage key；Core 接收所需字段，不持有完整 Telegram `RawConfig`。插件获得其实际需要的配置和受限服务；保留现有 web-fetch、memory、MCP 能力装配。

验收：配置文件格式和 Admin 操作保持不变；全局/Chat 模型覆盖、候选工具校验和模型注册表原子发布保持通过。运行中的 Invocation 仍固定自己的配置/Provider；新批次只刷新允许变化的运行状态。动态睡眠预算规则不因配置投影变成启动时快照。

风险：Core 配置只是完整 RawConfig 的别名；通过闭包继续读取热更新后的模型连接；每个插件引入一套新配置机制。只投影现有需要的设置。

提交/回滚：不要求用户迁移 JSONC；所有调用方改用新 scope 后删除旧入口，可直接回滚。现有历史审计中的配置 hash 语义保持可追溯。

### PW-CORE-04 — 持久化结构化注入 metadata

- [ ] 完成任务。

范围：ContextBuilder 的 sender/message/catalog 回读、`context-codec.ts`、`context-store.ts`、Runtime 的可见状态恢复，以及必要的 Schema/迁移。结构化保存恢复所需的 message keys、actor、caller 来源和 Host 批次信息；metadata 绑定承载它的 Context seq。Core 不通过数字 Prompt 头恢复身份。

验收：清空 Pi 缓存、重启及 GC 后，去重、可见身份和 caller 与运行前一致；使用非数字 actor/message key 的 fixture。输入正文伪造 uid/header 不获得权限；仅保留实际注入且仍有效的身份。验证 header、loop context、Pi transcript 与 refs 同步推进。

风险：把任意文本或任意历史 JSON 当成可信 metadata；回填出原来没有的权限；从 Telegram 在线消息表重建时丢失尚保留的 canonical history。旧格式转换只读取可验证的 runtime 记录，不让无法验证的身份获得新权限。

提交/回滚：先确定旧 Context 转换策略并用 00 的 fixture 验证。迁移和读取切换配套提交，不保留长期“双格式猜测”路径。无法可靠转换的记录必须有明确、可审计的处理结果；不能静默扩大权限或丢弃全部历史。此任务涉及存量格式，不能仅 revert 代码回滚。

### PW-CORE-05 — 分离 Context 引用生命周期与 Telegram 目标

- [ ] 完成任务。

范围：`invocation-context.ts`、`context-refs.ts`、send、Sticker、read_image 及必要存储映射。Core 管理 Context/seq/TTL 授权，Adapter 持有 Telegram message/thread/file/sticker 目标。Core 公共契约不再暴露 `resolveStickerRef -> file_id` 或 `ReplyTarget.threadId`。

验收：跨 Context、跨 Topic、TTL 到期、GC、Context 重建和缓存恢复的拒绝行为均保持；有效历史引用继续可用。当前 Telegram send Schema 和 img_/stk_ 的用户侧工具用法保持兼容，转换在 Adapter 内完成。模型不获得任意 Chat ID、Topic ID 或 file ID 入口。

风险：将 opaque key 当授权；撤销只影响一个缓存副本；媒体表删除后仍残留可解析能力；映射过程中给 history-only 内容新增 reply 权限。

提交/回滚：按引用种类做完整垂直切换；每次迁移同时更新生产调用方及 schema，不建立两套长期授权源。涉及持久化引用格式，回滚依赖迁移前备份或经过验证的逆向转换。

### PW-CORE-06 — 中性化任务 owner/delivery 与 Alarm 适配

- [ ] 完成任务。

范围：`long-tasks.ts`、`InvocationContext`、Alarm plugin/Admin、send completion mention。任务 owner 使用可信 actor identity，Core delivery 保留预算等运行策略，Telegram mention 格式及路由由 Adapter 解释。当前 Alarm 可保留 Telegram 专用输入外观，由产品装配适配到中性任务服务；不为尚不存在的 Host 强行统一提醒 UX。

验收：已存在的 waiting task、pending/claimed receipt 升级后保留 owner、目的地及处理状态。list/delete 不能访问别人的任务；sender_chat 不自动成为普通 user；receipt 不继承上一批 caller。首次成功文字发送消费 mention，贴纸/拒绝/失败/未知结果不消费；预算豁免只覆盖自己的 receipt round。

风险：数字用户 ID 改 key 后失去任务归属；旧 delivery JSON 无法读取；全局睡眠/预算策略误变；claimed receipt 重放。所有解析在边界校验，不能通过任意 metadata 绕过任务授权。

提交/回滚：owner、delivery 转换及全部消费者作为成套变更提交；使用 00 fixture 验证迁移。数据回滚按停机备份方案处理，不能重新触发已处理回执。

### PW-CORE-07 — 分离输入准入与通用调度

- [ ] 完成任务。

范围：`telegram-ingestion.ts`、`startup-catch-up.ts`、`participation.ts`、`invocation-queue.ts`、`scheduler.ts`、Runtime 节拍及 Bot commands 的控制调用。Adapter 处理原始输入、Revision、平台准入和 catch-up 筛选；Core 负责 Bucket/Invocation 转换、attach、节拍、串行和 receipt 调度。调度使用解析后的 policy/execution key，模型锁和 usage 使用对应中性 key。

验收：保持当前固定窗口、窗口只延后、0 秒窗口、idle grace、同 Chat 跨 Topic 串行及跨 Chat 并发。编辑不新建 Bucket；Bot companion 不自行触发；startup catch-up 每 Conversation 分开。暂停、移除 Chat/Topic 后待发 receipt 的抑制和启动前复查不改变；全局 sleep 与逐 receipt 豁免一致。

风险：Adapter 和 Core 各建一个 Scheduler；入库与 Bucket 通知之间出现崩溃丢消息窗口；将 TaskCompleted 伪装成人类消息；替换 key 导致预算被重置或重复计数。继续使用同一 SQLite 同步事务，明确正常接收和 catch-up 的确认边界。

提交/回滚：输入、catch-up、串行策略可按完整调用链分提交；每次只保留一个状态机实现。涉及 key 持久化变化时配套迁移；纯装配变化可直接回滚。产品配置字段可以继续叫 telegram.bucket_window_seconds，由组合根投影，Core 不读取该路径。

### PW-CORE-08 — 收拢 Schema、存储和清理所有权

- [ ] 完成任务。

范围：`schema.ts`、`database.ts`、相关 migration、媒体与发送存储，以及受存储变化影响的 Admin 调用方。Core 表及查询不依赖 Telegram 专有表；Adapter 表可以引用稳定 Core ID。保留一个数据库、一个 ORM 和产品级 migration/backup 入口，按实际耦合拆分模块，不引入通用 repository 框架。此任务保证现有 Admin 行为继续可用，查询服务职责分离由 09 完成。

验收：Core 创建 Conversation 和运行测试不需要伪造 Telegram Chat 行；Invocation 输入审计不依赖 Telegram 表才能读取。已有 Conversation、memory、task ID 连续；FK、retention、备份恢复及 Admin 查询契约通过旧库升级测试。Core Context 模块不再包含 Telegram 管理投影。

风险：只分 TypeScript 文件但 Core schema 仍 import Telegram schema；公共 barrel 或 SqliteStore 初始化间接拉回平台表；清理顺序删除仍在使用的引用；拆库破坏原子性。本 Epic 不拆库。

提交/回滚：先利用 04–07 已建立的查询接缝，再做必要 DDL。每次迁移核对 schema 与 SQL 一致；表改名/拆分不伴随无关业务改动。DDL 上线需备份及恢复演练，旧二进制不得直接打开不可兼容的新库。

### PW-CORE-09 — 分离 Admin 通用查询与 Telegram 产品投影

- [ ] 完成任务。

范围：`ingress/admin/audit.ts`、`memory-admin.ts`、Alarm Admin、`server.ts` 及查询契约测试。提取不读取 Telegram 表的 Harness 审计查询与受限管理服务；Telegram 消息/Revision、Chat/Topic、Sticker、发送记录及平台控制留在 Adapter/产品模块。产品 API 组合两者，继续供现有 Telegram 前端使用，不新增通用管理站或独立审计框架。

主要依赖：08 提供独立的 Conversation/Invocation 存储与稳定关联；04 的输入 metadata 和 06 的任务身份提供中性审计来源。查询拆分可按 Invocation、Context、memory/task 等垂直路径逐项提交，不用等待所有页面一起切换。

验收：没有 Telegram Chat/Message 行的合成 Core 记录仍可查询 Invocation、Context、usage、memory 和 task；同一 Conversation 的多次 Invocation 各自关联正确的模型/工具/输入记录。Telegram 产品 API 的响应结构、Chat/Topic 筛选、游标、统计、消息 revisions、发送详情和错误契约与 00 基线一致；分页前完成过滤。保留的运行审计在原始消息清理后仍可读。Memory/Alarm 管理权限和目标解析不变。

前端验收：现有导航、群聊消息审计、Telegram sends 时间线、Context、memory/Alarm 管理继续工作；复用 `test/admin.test.ts`、`test/admin-chats.test.ts`、相关管理测试及 `apps/admin-next/src/lib/timeline.test.ts`。不新增 Host selector、动态板块注册、通用消息渲染器或 Slack DTO。

风险：只改字段名但仍 mandatory join Telegram 表；通过公共类型间接带回平台依赖；统计与列表使用不同范围；分页后附加投影丢行或出现 N+1；消息 retention 导致整条运行审计消失；后台写入跳过原有认证/Origin/白名单。产品专用查询允许组合两层，但不能反向成为 Core 服务依赖。

提交/回滚：主要是查询与组装层变更，保持既有 HTTP 和持久化格式，每条垂直路径可独立提交/回滚；新查询替换全部对应调用方后删除旧路径，不保留隐藏 fallback。若发现必须新增持久化关联，拆出显式迁移并遵守数据回滚规则。仅在后端需要的测试或类型校验处调整前端代码，不进行前端架构改造。

### PW-CORE-10 — 验证 Core 独立性并完成 Telegram 回归

- [ ] 完成任务。

范围：Core 测试 fixture、导入边界检查、残余平台引用、必要目录归位及当前行为文档。合成 Host 仅在测试中提供输入和内存输出，不提供 CLI、网络服务、配置选项或第二个正式 Adapter。媒体平台逻辑留在 Adapter；只有已有通用处理确有调用需求时才抽共享函数。

验收：Core 在不导入 grammY、Telegram Adapter 或平台 Schema 的条件下完成两次连续 Invocation、缓存驱逐恢复、checkpoint/GC、memory 和任务 receipt，并能通过中性审计查询读取结果。输入使用非数字 actor/message keys；输出工具不叫 send 且仅接受 text。单独验证无输出工具时不会无限 nudge，普通 Assistant 文本仍私有；不因此扩展产品功能。

边界检查必须覆盖直接与间接依赖，以及平台 SQL、完整产品配置和硬编码工具名称；不能只运行一次关键词 grep。Telegram 集成测试继续走实际 Adapter 及 Faux Provider，检查发送副作用和落盘状态。收尾运行完整测试、check、lint、diff 检查，并完成下面的真实验收。

风险：为通过测试给 Core 塞 Telegram 默认值；新增空实现和 fallback；只验证内存 transcript 不验证 canonical history。删除被替代的旧路径及测试中的伪装平台依赖。

提交/回滚：边界约束、fixture、目录和文档可独立提交；不在此阶段追加新平台功能或新的数据模型。更新 `AGENTS.md`、架构、数据层、流程、配置、验证和 Admin 主题文档中实际受影响的部分。

## 数据迁移与回滚规则

每个触及持久化格式的任务必须交付自己的迁移说明，而非统一承诺“可回滚”：

| 情况 | 必须提供的处理 |
| --- | --- |
| 纯装配、投影或目录变更 | 保持持久化格式；可回滚代码 |
| 新 metadata、引用、owner 或 delivery 格式 | 明确旧记录转换、校验失败处理、事务边界及新旧二进制兼容性 |
| 表拆分、FK 或 key 变化 | 旧库 fixture 升级、FK/完整性检查、retention 与恢复验证 |
| 升级后尚未接收新数据 | 若无逆迁移，停机恢复升级前备份和旧二进制 |
| 升级后已接收新消息或产生副作用 | 明确恢复备份会丢失哪些新增记录；优先前向修复，禁止用重放发送/receipt “恢复一致性” |

不更换现有 Conversation ID，不随意重建 memory/task，不用第二套调度或双写系统过渡。保留的过渡格式要有对应任务负责清除；不形成永久兼容别名。

如果某次 Prompt 或历史格式改动确实必须重建 Context，在实施提交中单列行为影响、作用范围和验证证据，不能藏在文件移动里。

## 最终验收

### 自动验证矩阵

| 契约 | 复用的主要测试 |
| --- | --- |
| 输入、编辑、参与和 Topic | `telegram-ingestion`、`participation`、`startup-catch-up`、`cut-topic` |
| 调度、热注入、恢复和屏障 | `scheduler`、`context-hot-inject`、`sleep` |
| 私有文本、发送和审计 | `agent-runtime`、`context-send`、`model-request-audit` |
| Context、GC、refs 和 metadata | `context-store`、`context-gc`、`context-hot-inject` |
| 任务和提醒 | `long-tasks`、`long-tasks-migration`、`task-runtime`、`task-context`、`task-delivery`、`task-hot-injection`、`alarm`、`alarm-context` |
| 媒体和能力 | `media`、`media-image`、`stickers`、`skills`、`system-resources`、`plugins`、`mcp` |
| 模型、配置和预算 | `runtime-config-snapshot`、`config-reload`、`chat-model-runtime`、`token-usage`、`sleep` |
| 数据与管理 | `schema`、`foundation`、`operations`、`memory`、`admin` 及对应 Admin 管理测试 |
| Admin 查询边界与 Telegram 页面契约 | 无 Telegram 行的通用查询、同 Conversation 多次运行、筛选后分页、统计/详情及原始消息清理；`admin-chats` 和前端 `timeline` 测试 |

每个实施任务至少运行受影响测试、`pnpm run check`、`pnpm run lint`、`git diff --check`；跨模块变更运行完整 `pnpm test`。按仓库规则处理 lint，避免把无关修复混入迁移提交。用户指南、配置示例或 Admin 契约真正变化时同步更新公开文档并运行相应文档验证。

### 真实 Telegram 验收

沿用 [operations](../operations.md) 与 [verification](../verification.md) 的进程和验收流程，在明确的测试 Chat/Topic 中验证：

- 私聊、普通群和 Forum Topic 的准入、回复目的地及同群串行。
- 窗口内/冻结后编辑、运行中新消息、send barrier、重启 catch-up。
- 文字、MarkdownV2、Sticker、图片内联和按需 read_image。
- Reminder 创建、owner 隔离、首次文字 mention、暂停与任务完成。
- Context 恢复、GC 后引用失效、热配置后的新旧 Invocation 分界。
- Admin 的群聊消息、Invocation/Context 详情、Telegram sends 时间线与 memory/Alarm 管理；操作前后核对 API 和持久化结果。

真实发送在后续实施验收阶段进行，本规划不启动服务或发 Telegram 消息。必须遵守单实例、监督器和 takeover 规则，不操作未确认的数据目录。

### Epic 完成条件

- [ ] PW-CORE-00 至 PW-CORE-10 均有实现、验证和迁移记录。
- [ ] Core 的生产依赖闭包不包含 Telegram API、类型、专有 Schema 和产品配置路径。
- [ ] 输入、输出工具、引用及运行环境的边界均有执行测试，测试用 Host 不依赖 Telegram fixture。
- [ ] Telegram 功能、发送授权、审计、预算、Context 和任务恢复契约保持通过。
- [ ] 存量数据库升级、retention、备份及回滚限制经过验证并记录。
- [ ] 通用 Admin 查询无需 Telegram 数据即可审计 Core；产品 API 和前端继续提供一体化的 Telegram 管理体验。
- [ ] 完整测试、check、lint、diff 检查及真实验收结果可追溯；未执行项明确列出，不能写成已通过。
- [ ] 当前行为文档已更新；不存在两套正式 Provider、Scheduler、审计或 Context 写入路径。
- [ ] 产品仍只正式支持 Telegram，没有借本 Epic 增加跨平台功能面。

## 实施时才需要收敛的问题

| 问题 | 最迟解决任务 | 限制 |
| --- | --- | --- |
| 模块集合与共享存储初始化怎样避免间接平台依赖 | 00 定边界，08/10 验证 | 不要求独立发布包 |
| 旧 Context metadata 怎样可靠转换 | 04 | 不扩大历史授权，不长期猜测旧格式 |
| 引用目标怎样持久化及撤销 | 05 | 保持同 Context、seq、TTL 约束，不新增任意资源访问 |
| actor/owner 与存量 Alarm delivery 怎样映射 | 06 | 不引入跨平台身份合并 |
| execution/usage key 怎样保留历史记录 | 07 | 不改变现有并发和预算范围 |
| 哪些 FK 必须拆分、哪些可留在产品级存储 | 08 | 以 Core 独立运行的实际需要决定 |
| Admin 的中性查询范围、分页及 Telegram 投影怎样组合 | 09 | 保持现有产品 HTTP 契约，不新增公共管理协议 |

第二种 Host 的能力命名、富文本、reaction/event 顺序、统一 mention、SDK 稳定性，以及外部 Thread 与 Conversation/Invocation 的具体映射继续推迟，不作为本 Epic 的阻塞条件。保留不同运行策略的空间，不为假想 Slack 产品提前设计面板或生命周期。

实施起点为 PW-CORE-00，第一项生产变更为 PW-CORE-01。M1 可先交付并评估维护收益；若暂缓后续里程碑，保留未完成状态，不宣称已达到严格 Core/Adapter 分离。
