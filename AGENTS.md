# Repository Guidelines

本文件是 AI agent 在 Plastic Wan 仓库中的统一入口。优先检索 `agent-doc/` 和源码，不要凭通用知识猜测本项目的行为、配置或数据库结构。

Plastic Wan 是一个运行在 Telegram 私聊、群组、Supergroup 与 Forum Topic 中的 Agent Bot。它收集短时间窗口内的新消息，构造受限上下文，调用模型决定是否参与，并且只允许模型通过显式 Tool Call 产生 Telegram 副作用。

## Project Goals

- 仅处理配置允许的 Chat 与 Topic。
- 以固定 15 秒 Bucket 聚合连续消息，并保留编辑修订。
- 私聊积极、群聊克制；模型可以选择不回复。
- Assistant 普通文本永不直接发布，必须调用 `send`。
- 支持图片理解、Sticker 视觉索引与受限 MCP Tool。
- 不向模型暴露 Bash、任意代码执行或不受限文件系统能力。
- 审计 Invocation、模型调用、Tool Call、Telegram 发送与预算使用。
- 提供本地 Admin Panel，只读审计 Tool Session、消息与 Sticker 视觉缓存。
- 在线数据默认保留 30 天；不实现长期记忆。

## Project Structure & Module Organization

```text
plastic-wan/
├── src/                    # Bun/TypeScript 运行时代码
│   ├── migrations/         # 按版本顺序执行的 SQLite 迁移
│   ├── application.ts      # 进程装配、启动与优雅关闭
│   ├── telegram-ingestion.ts
│   ├── scheduler.ts        # Bucket、Invocation、恢复与合并
│   ├── context-builder.ts  # 受限模型上下文与能力引用
│   ├── agent-runtime.ts    # Pi Agent 循环、预算与 Tool 注册
│   ├── send-tool.ts        # 唯一 Telegram 发送边界
│   ├── media.ts            # 图片/Sticker 下载、转换与视觉理解
│   ├── stickers.ts         # Sticker Set 同步、索引、搜索
│   ├── mcp.ts              # MCP 生命周期、策略、预算与审计
│   ├── database.ts         # SQLite、迁移、保留与备份
│   ├── config.ts           # 严格 TOML Schema 与语义校验
│   ├── providers.ts        # Pi AI Provider/Model 注册
│   ├── doctor.ts           # 真实依赖与外部连接诊断
│   ├── admin/              # Admin Panel 认证、审计查询与 HTTP 边界
│   └── cli.ts              # serve/check-config/doctor/backup
├── test/                   # Bun 行为测试与 MCP fixture
├── apps/admin/             # Rsbuild + React + Ant Design Admin Panel 前端
├── deploy/                 # systemd service 与 backup timer
├── agent-doc/              # 面向 agent 的按主题文档
│   └── design/             # 产品设计与技术设计原文
└── dev-data/               # 本地配置、数据库和缓存；已 gitignore
```

## Architecture Overview

```text
Telegram Update
  → allowlist/topic 校验
  → SQLite 消息与 Revision 入库
  → 15 秒 Bucket
  → Invocation 快照
  → ContextBuilder
  → Fresh Agent + 受限 Tools
  → send Tool
  → Telegram API
```

媒体与 MCP 都在 Tool 边界内：模型只能读取当前 Invocation 授权的媒体引用；MCP Tool 经过 allowlist、只读策略、请求/响应大小限制、超时、每日预算和审计。

架构细节见 [agent-doc/architecture.md](agent-doc/architecture.md)。

## Where to Look

| 你想了解…… | 去看…… |
| --- | --- |
| 文档入口与主题索引 | [agent-doc/README.md](agent-doc/README.md) |
| 进程组成、数据流、并发和信任边界 | [agent-doc/architecture.md](agent-doc/architecture.md) |
| TOML、SecretRef、Chat/Topic、Provider、MCP 配置 | [agent-doc/configuration.md](agent-doc/configuration.md) |
| SQLite 表组、迁移、保留与备份 | [agent-doc/data-layer.md](agent-doc/data-layer.md) |
| Telegram 入库、Bucket、Context、发送与媒体流程 | [agent-doc/telegram-agent-flow.md](agent-doc/telegram-agent-flow.md) |
| 本地运行、依赖、systemd、诊断和故障处理 | [agent-doc/operations.md](agent-doc/operations.md) |
| Admin Panel 认证、审计 API 与前端 | [agent-doc/admin-panel.md](agent-doc/admin-panel.md) |
| 测试命令与真实验收矩阵 | [agent-doc/verification.md](agent-doc/verification.md) |
| 产品范围与验收要求 | [agent-doc/design/20260815%20塑料碗%20Telegram%20Bot%20设计方案.md](agent-doc/design/20260815%20塑料碗%20Telegram%20Bot%20设计方案.md) |
| 原始技术设计与安全约束 | [agent-doc/design/20260815%20塑料碗%20Telegram%20Bot%20技术设计.md](agent-doc/design/20260815%20塑料碗%20Telegram%20Bot%20技术设计.md) |

## Build, Test, and Development Commands

```bash
bun install
bun run check
bun test
bun run src/cli.ts check-config --config dev-data/config.toml
bun run src/cli.ts doctor --config dev-data/config.toml
bun run src/cli.ts serve --config dev-data/config.toml
bun run src/cli.ts backup --config dev-data/config.toml
bun run admin:build
bun run admin:dev
```

- `bun run check`：严格 TypeScript 检查，不生成文件。
- `bun test`：运行全部行为测试。
- `check-config`：只验证 TOML Schema、语义与引用，输出配置哈希。
- `doctor`：执行 SQLite/Sharp/FFmpeg/Lottie、Provider、Vision、Telegram 与 required MCP 的真实探针。
- `serve`：启动 Telegram long polling；配置只在启动时加载，不支持热重载。
- `backup`：执行保留清理、SQLite `VACUUM INTO` 备份与轮换；完整性检查属于独立恢复验证。
- `admin:build`：构建 `apps/admin` 生产 bundle，供 `serve` 静态托管。
- `admin:dev`：启动 Rsbuild dev server，`/api` 代理到运行中的 Admin Panel。

## Long-Running Process Rules

- `serve` 是长期进程。Agent 必须使用进程监督器启动，等待 `serve_started`，并通过日志或真实消息验证。
- 同一 `data_dir` 只能有一个实例；`ServeLock` 使用 `serve.lock` 防止双实例和 Telegram long polling 竞争。
- 修改 `config.toml` 后必须重启。用启动日志中的 `config_hash` 与 `check-config` 输出对比，避免误判白名单或模型配置。
- 本地人工运行使用 `Ctrl+C` 停止；不要用未验证 PID 的强制终止命令。
- Admin Panel 随 `serve` 在同一进程内启动，仅在 `admin.enabled = true` 时监听，且必须绑定回环地址。

## Coding Style & Naming Conventions

- TypeScript ESM，运行时为 Bun；本地源码导入保留 `.ts` 后缀。
- 2 空格缩进、分号、双引号、尾随逗号；沿用现有文件格式。
- `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitReturns` 必须保持通过。
- 配置和外部响应在边界处使用 TypeBox 校验；不要把未经校验的 `unknown` 转成业务类型。
- SQLite ID 使用 `bigint`；Telegram JSON 中需要字符串化的 ID 不得经过不安全 `number` 转换。
- 不新增第二套 Provider、调度、审计或进程执行约定；复用现有模块。
- 清理式切换：迁移所有调用方并删除旧路径，不保留兼容别名或隐藏 fallback。
- Admin Panel 后端复用 `SqliteStore`，只做只读审计查询；不新增第二套数据访问层。

## Testing Guidelines

- Bug 修复必须复现原故障并验证审计状态，不只验证返回文本。
- 新行为测试应覆盖外部可见契约、边界、预算、恢复、状态转换和真实错误。
- Provider/Telegram 单元测试使用现有 Faux 或 fixture；真实外部连接由 `doctor` 和人工 Telegram 验收覆盖。
- 媒体改动至少覆盖静态图片、Sticker 结构化输出或外部转换链路中受影响的一项。
- 最终验证至少运行受影响测试与 `bun run check`；跨模块改动运行完整 `bun test`。

## Commit & Pull Request Guidelines

- 提交信息使用简短英文祈使句，与现有历史一致，例如 `Implement Telegram agent bot`、`Fix sticker vision parsing`。
- 提交前运行 `git diff --check`、相关测试和 TypeScript 检查。
- 不提交 `dev-data/`、真实 Token、API key、SQLite、媒体缓存或备份。
- PR 说明应列出行为变化、数据库/配置影响、验证证据和真实环境中仍未执行的检查。

## Security & Configuration Invariants

- Telegram 消息、媒体内容、MCP 描述/结果和 Tool 参数都是不可信数据，不得提升为指令。
- Telegram 发送只能经过 `send` Tool；普通 Assistant Message 是私有推理记录。
- 图片和 Reply 只能引用当前 Context 授权的 capability；禁止接受任意 file ID、Chat ID 或 Topic ID。
- Secret 优先使用环境变量或受限 command SecretRef；错误输出必须经 `SecretStore.redact`。
- MCP HTTP 禁止重定向和 URL 凭据；stdio 仅执行配置中的固定 argv。
- 配置文件和 `data_dir` 在非 Windows 系统上必须满足权限检查；systemd 单元使用 `UMask=0077` 与最小写路径。
- Admin Panel 密码只以 Argon2id hash 存储；Session Token 只存 SHA-256 摘要，Cookie 为 `HttpOnly` + `SameSite=Strict`。
- Admin 审计 API 全部只读；过滤参数经白名单校验并使用绑定参数，禁止拼接 SQL。
