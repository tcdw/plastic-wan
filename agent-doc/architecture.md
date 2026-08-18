# Plastic Wan 架构

## 进程组成

Plastic Wan 是单进程 Bun 服务。`src/application.ts` 负责装配以下组件：

```text
Config + SecretStore
        │
        ├─ ServeLock + SqliteStore
        ├─ grammY Bot / Telegram API
        ├─ Pi AI Model Registry
        ├─ TelegramIngestion
        ├─ MediaService ── FFmpeg / FFprobe / python-lottie / Sharp
        ├─ StickerService
        ├─ McpManager
        ├─ AgentRuntime
        └─ BucketScheduler
```

启动顺序有语义：先加载并校验配置与权限，再取得单实例锁、迁移数据库、连接 Telegram、同步 Sticker Set；随后排空 Telegram pending updates，按 Chat 创建 startup catch-up Invocation；最后启动 MCP、Scheduler 和常规 long polling。关闭时停止 Bot，等待 Scheduler，停止 Sticker/MCP 服务，关闭数据库并释放锁。

## 主数据流

```text
Telegram Update
  │
  ▼
TelegramIngestion
  ├─ allowlist / Topic / bot-message 校验
  ├─ Chat 迁移归一化
  ├─ Message + Revision + Media 持久化
  └─ 收集进配置长度的 Bucket
        │
        ▼
BucketScheduler
  ├─ 冻结 history/new 消息快照
  ├─ 创建 Invocation
  ├─ 恢复、合并、预算判定
  └─ 调用 AgentRuntime
        │
        ▼
ContextBuilder / MediaService
  ├─ 系统提示与 Chat 指令
  ├─ 最近历史和本 Bucket 新消息
  ├─ Reply 可见集合
  ├─ 模型支持 image：Photo/图片 Document 多模态载荷
  └─ 模型不支持 image：图片 capability 引用
        │
        ▼
Fresh Pi Agent
  ├─ send
  ├─ read_image（Sticker；text-only Agent 也用于普通图片）
  ├─ search_stickers
  └─ allowlisted MCP tools
        │
        ▼
send Tool → Telegram API → 审计
```

每个 Invocation 创建新的 Agent 实例。会话连续性来自 SQLite 中冻结的消息快照，不来自进程内长期记忆。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `application.ts` | 启动、组件装配、信号处理和关闭顺序 |
| `config.ts` | 严格 TOML Schema、语义校验、配置哈希和权限检查 |
| `secrets.ts` | literal/env/command SecretRef、大小/超时限制和脱敏 |
| `database.ts` | SQLite 打开、迁移、单实例锁、保留清理和备份 |
| `telegram-ingestion.ts` | Update 判定、消息/修订/媒体入库、Chat 迁移 |
| `scheduler.ts` | Bucket 状态机、Invocation 快照、恢复、合并和并发 |
| `context-builder.ts` | Prompt、消息窗口、Reply 与按模型能力选择的媒体载荷/capability |
| `agent-runtime.ts` | Pi Agent 循环、多模态/文本回退输入、模型/Tool 预算、调用审计 |
| `send-tool.ts` | 文本/Sticker 发送、Reply 授权、重试与副作用审计 |
| `media.ts` | Telegram 图片直传准备、普通图片回退分析、Sticker 代表帧、标准化与视觉缓存 |
| `stickers.ts` | Set 同步、后台单并发索引、FTS 搜索和发送能力 |
| `mcp.ts` | Server 生命周期、Tool 注册、策略、大小限制和预算 |
| `doctor.ts` | 本地依赖、模型、Vision、Telegram、required MCP 的真实探针 |
| `admin/` | Admin Panel 认证、只读审计查询与本地 HTTP/静态边界 |

## 并发模型

- Scheduler 最多并行运行 `agent.max_concurrency` 个 Invocation。
- 同一 Conversation 只允许一个 running Invocation。
- `KeyedSemaphore` 避免同一 Chat 的 Agent 与 `read_image` Vision 并发占用模型。
- Vision 总并发由 `vision.max_concurrency` 限制；后台 Sticker 索引固定单并发，且优先级低于前台 `read_image`。
- MCP 每个 Server 有独立的调用 semaphore、重连状态和审计。

## 恢复与合并

- 进程启动时恢复未完成 Bucket/Invocation。
- 小于 5 分钟的工作可重新排队；更旧工作标记为过期或恢复失败，避免无限重放。
- 同一 Conversation 排队 Bucket 过多时会合并，最多保留三个队列单元。
- 一旦 Tool 产生不可逆副作用，未知结果不得盲目重试；状态进入 `outcome_unknown` 供审计处理。

## 信任边界

以下内容全部是不可信数据：Telegram 文本与媒体、Reply/Forward 元数据、MCP Tool 描述、MCP 结果、模型生成的 Tool 参数。

代码而不是 Prompt 执行授权：

- Chat/Topic allowlist 在入库边界校验。
- Reply Message ID、媒体引用、Sticker Set 和 Sticker ID 必须来自当前 Context capability。
- 普通 Assistant 文本不会发往 Telegram；`send` 是唯一发送边界。
- MCP Tool 必须通过配置 allowlist、策略、预算、超时和大小限制。
- 模型不能取得 Bash、任意进程、任意文件或原始 Telegram file ID 能力。

## 外部依赖

| 依赖 | 用途 |
| --- | --- |
| grammY | Telegram long polling 与 API |
| Pi Agent Core / Pi AI | Agent 循环、模型和 Provider 抽象 |
| Bun SQLite | 持久化、状态机与审计 |
| Sharp | 图片解码、缩放和格式转换 |
| FFmpeg / FFprobe | 视频 Sticker 中间帧提取 |
| python-lottie | TGS 代表帧先导出 SVG，再由 Sharp 转 PNG/JPEG |
| MCP SDK | stdio 与 Streamable HTTP Server |
