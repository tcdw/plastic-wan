## 1. 背景

实现一个运行于 Telegram 中、能够以自然方式参与私聊或群聊的 Agent Bot。

Phase 1 的核心目标不是构建完整的长期运行 Agent，而是验证最基本的 Telegram 对话体验：

> Bot 能够观察一段正在发生的 Telegram 对话，在固定时间窗口内收集新消息，将近期上下文交给 Agent，并由 Agent 自主决定是否参与以及如何参与。

本 PRD 只定义**要实现什么**，不规定具体技术选型。

---

## 2. Phase 1 核心目标

Phase 1 需要实现以下能力：

1. 接入 Telegram 私聊、群组、Supergroup 与 Forum Topic。
2. 仅处理管理员明确允许的 Chat；群聊不要求 mention Bot。
3. 保存并向 Agent 提供近期 Chat Message。
4. 使用全局可配置的固定长度窗口收集连续发生的新消息，并统一交给 Agent 处理。
5. Agent 自主判断是否需要回复；私聊默认更积极，群聊默认更克制。
6. Agent 必须通过 `send` Tool 向 Telegram 发送内容，Assistant Message 本身不得直接发布。
7. `send` 可以发送纯文本，或管理员许可的 Telegram Sticker Set 中的 Sticker。
8. 多模态 Agent 模型直接读取 Telegram Photo 与受支持的图片 Document。
9. Telegram Sticker 通过 `read_image` 单帧理解，并缓存视觉解析结果。
10. Agent 可以通过 `search_stickers` 搜索管理员许可且已建立视觉索引的 Sticker。
11. 支持接入 MCP Server，为 Agent 提供互联网搜索等受限外部能力。
12. 不向 Agent 提供 Bash、任意代码执行等通用计算机操作能力。
13. 对 Agent Invocation、Tool Call、Telegram 发送结果与 Token 用量进行审计。
14. 聊天与审计数据默认保留 30 天。
15. Phase 1 不实现长期记忆系统。

---

## 3. Telegram 消息接入

Bot 应能够接收允许名单内的 Telegram 私聊、群组、Supergroup 与 Forum Topic 消息。Telegram Channel 不属于 Phase 1 范围。为了在群聊中观察普通消息，部署时允许关闭 Bot Privacy Mode。

Phase 1 完整处理：

- Text；
- Photo；
- MIME 为 JPEG、PNG 或 WebP 的图片 Document；
- 静态、动画与视频 Sticker；
- Caption、Reply、Forward 与 `edited_message`。

进入 Agent Context 的消息至少应表达：

- 消息正文与消息类型；
- 稳定的发送者 ID 及当时可见的名称；
- 消息时间与消息 ID；
- Reply 关系及必要的单层引用快照；
- Forward 标记及 Telegram 公开提供的来源；
- 图片或 Sticker 的存在及调用期内有效的可读取引用；
- 暂不支持的消息类型占位。

每次 `edited_message` 都应保存为新的 Revision。Bucket 截止时使用当时已收到的最新 Revision；截止后到达的编辑只更新后续历史，不重跑已经开始的 Invocation。

Telegram Bot API 不提供普通聊天消息的通用读取接口或删除事件，因此 Phase 1 不承诺检测消息删除。

真人发送的暂不支持消息仍可创建 Bucket，并以占位形式进入 Context。Service Message 只能作为真人消息 Bucket 的伴随上下文。其他 Bot 消息默认忽略；显式启用后也只能加入已由真人触发的 Bucket，不能独立触发 Agent。

---

## 4. 短期 Chat Context

每个私聊、群聊或 Forum Topic 都构成独立 Conversation。Forum Group 的不同 Topic 不得共享短期 Context。

每次 Agent Invocation 都重新构建 Context，不延续上一轮 Pi Agent 的内部 Session。Agent 至少看到：

1. 当前 Conversation 最近 20 条 Telegram 可见历史消息；
2. 当前尚未处理的新消息 Bucket。

每个 Telegram `message_id` 计为一条历史消息。媒体 Caption 属于对应消息，Reply 引用快照不额外计数，当前 Bucket 不占 20 条历史额度。

只有 Telegram 中实际可见的内容进入下一轮历史，包括用户消息和 Bot 通过 `send` 成功发送的内容。未发布的 Assistant Message、Tool Call、Tool Result 与内部推理只进入审计，不进入后续 Conversation Context。

历史消息与本轮新消息在语义上必须明确区分：

```text
<context>
  ...最近 20 条 Telegram 可见历史...
</context>

<new_messages>
  ...本轮 Message Bucket...
</new_messages>
```

如果当前 Bucket 自身超过模型输入预算，应保留最新消息并明确标记省略数量，仍然只产生一次 Agent Invocation。

---

## 5. Message Bucket

Bot 不应在收到每一条 Telegram Message 后立即调用 Agent。

### 5.1 收集窗口

当一个 Chat 处于就绪状态，并收到第一条待处理消息时：

1. 创建该 Topic/Conversation 的 Message Bucket；
2. 等待一个 `telegram.bucket_window_seconds` 节拍，Phase 1 接受 1–300 的整数秒，示例值为 **15 秒**；
3. 等待期间的后续消息加入当前 Bucket，且不重置计时器；
4. 节拍到达后，将整个 Bucket 一次性交给 Agent。

例如：

```text
00:00 Alice: 我今天去面试了
00:03 Alice: 感觉还行
00:08 Bob: 哪家公司
00:11 Alice: 就之前说的那个

00:15 → 整个 Bucket 交给 Agent
```

该机制主要用于：

- 避免用户拆分发送一句话时 Bot 过早回复；
- 允许多人在短时间内形成一小段连续对话；
- 减少逐消息调用 Agent 的频率；
- 让 Agent 更接近“听一会儿再决定要不要说话”。

### 5.2 截止、排队与恢复

Bucket 交给 Agent 时应读取其中每条消息当时最新的已知 Revision，并形成不可变的 Invocation 输入快照。

Agent Invocation 按 Chat 串行执行，消息收集仍按 Conversation 隔离：同一时刻每个群最多一个 Invocation，但 Forum Topic 的 Context 与 Reply 互不混入。Chat 内任意 Invocation 运行期间到达的新消息进入各自 Topic 的下一 Bucket，不中断或修改当前 Invocation。

下一 Invocation 的启动时间不得早于前一 Invocation 的开始时间加 `bucket_window_seconds`，也不得早于前一 Invocation 的结束时间，均按 Chat 计算。前一 Invocation 运行超过一个节拍时，结束后立即处理非空的下一 Bucket；运行不足一个节拍时等待到节拍边界。没有新消息时不得启动空 Invocation。

普通重启应恢复 5 分钟内尚未执行的 Bucket；更早的 Bucket 标记为过期，不调用 Agent，但其中消息仍进入近期历史。首次部署可以丢弃 Telegram 已有积压 Update。

### 5.3 Agent-controlled Wait

Phase 1 **不要求** Agent 自主延长等待时间。

例如暂不提供：

```text
wait(5)
```

未来可根据真实聊天体验评估 Agent 是否需要主动等待更多消息。

---

## 6. Agent 发言行为

Agent 的 Assistant Message 本身不得直接发送到 Telegram。系统只允许通过专门的 `send` Tool 产生 Telegram 可见内容。

`send` 支持两种互斥内容：

```text
send({ text: "你好", reply_to_message_id?: 123 })
send({ sticker: "cat_pack/crying", reply_to_message_id?: 123 })
```

文本使用纯文本格式，不启用 Markdown 或 HTML。Reply 目标必须来自当前 Conversation 的可见 Context。超出 Telegram 单条长度限制时，Tool 应返回错误，不自动拆分或截断内容。

Sticker 必须来自管理员静态许可的 Sticker Set，并使用系统生成的稳定引用。Agent 不得提交任意 Telegram `file_id` 或未许可的 Sticker Set。

一次 Agent Invocation 最多调用 `send` 6 次，因此可以：

- 不发送任何内容；
- 发送一条文本或 Sticker；
- 连续发送多条文本或 Sticker；
- 在使用其他 Tool 后再决定是否发送。

多次 `send` 必须按 Tool Call 顺序执行，不添加人为延迟。成功发送的内容立即进入 Telegram 可见历史。

```text
Agent invocation

→ 不调用 send
```

表示 Agent 决定不参与当前对话。

**Message Bucket 被处理，不代表 Agent 必须回复。** 是否参与当前对话始终由 Agent 自主判断。

---

## 7. 图片理解

当主 Agent 模型支持 image 输入时，Telegram Photo 与受支持的图片 Document 应随冻结消息上下文直接交给多模态 Agent，不经过 `read_image` 或独立视觉模型。

当主 Agent 模型只有 text 输入时，同样的图片在 Context 中表示为调用期有效的 `image_ref`。Agent 可按需调用 `read_image`，由独立视觉模型返回文字描述；普通图片描述按 `file_unique_id + analysis_version` 缓存 30 天。

图片输入包括 Telegram Photo，以及不超过 Telegram Bot API 下载限制、MIME 为 JPEG、PNG 或 WebP 的图片 Document。Telegram Photo 只选择最高分辨率变体。图片送入任一模型前应校验真实格式与像素上限、移除 EXIF，并缩放到受控尺寸。

```text
image-capable Agent → 首轮输入同时包含消息上下文和图片
text-only Agent      → Context 提供 image_ref，按需调用 read_image
```

图片仍属于不可信 Telegram 内容，图中指令不得提升为系统指令。下载、解码或校验失败时应明确失败，不得假装模型看到了图片。

## 8. Telegram Sticker

Telegram Sticker 同时具有输入理解与受限输出能力。

### 8.1 Sticker 理解

Agent 通过同一个：

```text
read_image(sticker_ref)
```

读取静态 WEBP、动画 TGS 或视频 WEBM Sticker。视觉理解只使用单个代表帧，不实现完整时序理解。动画和视频 Sticker 优先使用 Telegram 提供的 Thumbnail；缺失时由系统在本地渲染代表帧。

例如：

```text
Alice:
[sticker: available]

Agent:
→ read_image(sticker_ref)
```

返回：

```text
一只猫缩成一团哭泣，看起来非常委屈。
```

### 8.2 Sticker 解析缓存

同一个 Telegram Sticker 的视觉结果应按 `file_unique_id` 和分析配置版本缓存。管理员仍然许可对应 Sticker Set 时，代表帧、中文描述、情绪与动作信息、中英文标签及 Telegram Emoji 可以长期保留。

视觉模型或描述规则变化后，旧索引可以继续服务，同时在后台生成新版并原子替换。

### 8.3 管理员许可的 Sticker Set

管理员可以通过静态配置声明允许 Agent 发送的 Sticker Set，并为每个 Set 设置稳定别名。Bot 不提供聊天命令修改该配置。

系统应在后台以单并发逐张建立完整视觉索引，并持久化索引进度。用户触发的 `read_image` 优先于后台索引。

Agent 通过：

```text
search_stickers({ query: "委屈地哭", set?: "cat_pack", limit?: 5 })
```

搜索已经完成索引的 Sticker。搜索返回少量描述与调用期内有效的稳定引用，再由 Agent 交给 `send`。搜索不使用 Embedding 或 Vector Search。

---

## 9. MCP Server

Bot 应支持接入一个或多个由管理员静态配置的 MCP Server。

MCP Server 只用于向 Agent 提供具有明确、有限语义的 Tool：

```text
Agent
 ├── Telegram Tools
 │    ├── send
 │    └── search_stickers
 │
 ├── Media Tools
 │    └── read_image
 │
 └── Namespaced MCP Tools
      ├── search__web_search
      └── ...
```

Phase 1 只接入 MCP Tools，不接入 Resources、Prompts、Sampling 或 Elicitation。MCP Server 及 Tool 暴露策略只能由管理员静态配置，不允许通过 Bot Command、聊天内容或 Agent 动态添加。

管理员可以为单个 MCP Server 选择显式 Tool allowlist，或明确选择信任该 Server 的全部 Tool。来自不同 Server 的 Tool 必须使用稳定命名空间，避免名称碰撞。

一个预期场景是为 Agent 提供互联网搜索。Agent 可以根据当前对话自主决定是否调用这些受限 Tool。

---

## 10. Capability Boundary

Bot 面向的 Telegram 对话内容应视为**不可信输入**。

尤其在群聊中，任何群成员都可能向 Agent 发送内容。

因此 Phase 1 不向 Agent 提供：

- Bash
- Shell
- 任意命令执行
- 任意代码执行
- 通用文件系统操作
- 其他等价的 unrestricted computer access

外部能力应通过具有明确用途和有限权限的 Tool 暴露。

例如，需要互联网搜索时，应提供类似：

```text
web_search(query)
```

的受限能力，而不是要求 Agent 通过 Shell、HTTP Client 或任意代码执行自行实现搜索。

该原则不限制未来增加 Agent 能力，但新增能力应当具有明确的权限边界。

---

## 11. Agent Invocation

一次典型处理过程在产品语义上表现为：

```text
Telegram Messages
        ↓
创建 / 加入 Message Bucket
        ↓
配置长度的固定收集窗口
        ↓
准备近期 Chat Context
        ↓
附加当前 Message Bucket
        ↓
调用 Agent
        ↓
Agent 阅读上下文
        ↓
 ├── 什么都不做
 ├── read_image
 ├── search_stickers
 ├── namespaced MCP Tool
 ├── send text / sticker
 └── 多次、顺序组合 Tool Call
        ↓
本轮结束
```

工具调用本身不意味着 Agent 最终必须发言。

例如：

```text
read_image(...)
→ 发现图片与当前聊天无关
→ 不调用 send
```

是完全有效的处理结果。

---

## 12. 审计与数据保留

系统应记录：

- Telegram Update 的规范化结果；
- 允许 Chat 的原始 Update JSON；
- Message Revision 与实际进入 Invocation 的 Revision；
- 每次模型请求与完成后的 Assistant Message；
- Tool Call、Tool Result、错误与耗时；
- Telegram 发送结果及不确定状态；
- Token 输入、输出、缓存读取、缓存写入与模型报告的费用。

审计只保存完成事件，不逐条保存流式 Text Delta。默认不保存 reasoning/thinking 正文，但应记录对应 Token 数量。

聊天、原始 Update、Message Revision、Prompt、Tool Result 与 Invocation 审计默认在在线数据库保留 30 天。本地备份可以额外保留 7 天。未在 allowlist 的 Chat 只保存 Update ID、Chat ID、Chat 类型、接收时间和拒绝原因，不保存消息正文或媒体引用。

---

## 13. Phase 1 Non-goals

### 13.1 长期记忆

Phase 1 不实现：

- RAG
- Vector Search
- Embedding-based Memory
- Episodic Memory
- Semantic Memory
- 自动提取长期用户信息
- 长期 User Profile
- 跨越短期 Context Window 的记忆检索

是否需要长期记忆，应根据 Bot 实际运行后的体验重新评估。

### 13.2 Agent-controlled Wait

Phase 1 不要求 Agent 自主决定：

- 再等待若干秒；
- 延长当前 Message Bucket；
- 等待某位参与者继续发言；
- 安排自己稍后重新唤醒。

### 13.3 完整媒体理解

Phase 1 的视觉输入重点为：

- Telegram 图片
- Telegram Sticker

暂不要求：

- 视频理解
- Voice Message 转录
- 音频理解
- 任意文件内容解析
- GIF / Animation 的完整时序理解

### 13.4 完整 Telegram 功能覆盖

暂不要求：

- 发送未由管理员许可的 Sticker；
- Reaction；
- Poll；
- 主动发送图片、视频、音频或任意文件；
- Telegram 所有 Message Entity；
- Telegram 所有 Service Message。

### 13.5 通用计算机控制

Phase 1 明确不提供通用 Shell 或等价能力。

### 13.6 技术选型

本 PRD 不指定：

- Agent Framework / Harness；
- LLM / Model Provider；
- 多模态模型；
- 数据库；
- 编程语言与运行时；
- Telegram Bot Framework；
- MCP Client 实现；
- 搜索服务提供商；
- 部署方式。

上述内容属于独立的技术设计决策。

---

## 14. Phase 1 验收标准

Phase 1 完成后，应能够将 Bot 放入真实 Telegram 对话并满足：

1. 能够读取允许名单内 Telegram 私聊、群组、Supergroup 与 Forum Topic 的近期消息；
2. 不同 Forum Topic 使用独立 Conversation Context，但共享所在 Group 的每日预算；
3. 能够以全局配置的固定长度窗口收集一批新消息，后续消息不延长当前窗口；
4. 同一 Conversation 的 Invocation 串行执行，运行期间的新消息进入下一 Bucket；
5. Bucket 截止时使用当时最新的已知 Message Revision；
6. Agent 能区分最近 20 条 Telegram 可见历史与当前 Message Bucket；
7. Agent 可以选择完全不参与某一轮对话；
8. Agent 只能通过 `send` Tool 主动向 Telegram 发言；
9. 一次 Invocation 可以产生零条至六条 Telegram 文本或许可 Sticker；
10. 文本以纯文本发送，并可以 Reply 当前 Context 中的消息；
11. image-capable Agent 首轮即可直接读取 Photo 与许可的图片 Document；
12. text-only Agent 可通过 `read_image` 按需读取普通图片；
13. 静态、动画与视频 Sticker 均可通过 `read_image` 获取单帧描述；
14. Sticker 视觉索引可缓存、版本化并在管理员仍许可对应 Set 时长期复用；
15. Agent 可以通过 `search_stickers` 找到并发送管理员许可的 Sticker；
16. Agent 可以使用管理员静态配置的 namespaced MCP Tools；
17. MCP 仅提供受限 Tool，不允许通过聊天或 Agent 扩大能力；
18. Agent 不具有 Bash、Shell、任意代码执行或通用文件系统操作能力；
19. Agent 每轮受到时间、Turn、Tool Call 与发送次数限制，并受 Chat 每日预算约束；
20. Agent 的完整完成事件、Tool 使用、Telegram 发送状态和 Token 用量可以审计；
21. 在线聊天与审计数据按默认 30 天策略清理；
22. 在没有长期记忆系统的情况下，Bot 已能够基本自然地参与 Telegram 对话。

Phase 1 最核心的产品验证目标是：

> **Bot 能否先观察一小段正在发生的 Telegram 对话，按需理解其中的视觉内容和外部信息，再自主决定自己是否应该参与，以及如何参与。**