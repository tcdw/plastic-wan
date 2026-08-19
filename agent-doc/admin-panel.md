# Admin Panel

Admin Panel 是随 `serve` 启动的本地审计与管理界面，覆盖 Tool Session（Invocation）、收到的 Telegram 消息、媒体视觉分析、已配置 Sticker Set 的可搜索索引，以及 Agent 短期记忆（`memories`）。后端在 `src/admin/`，前端在 `apps/admin/`（Rsbuild + React + Ant Design + TanStack Query + TanStack Router）。

审计数据只读；记忆管理是该规则唯一的写入例外：管理员可以增删改查记忆、按群聊过滤，并对长 TTL 记忆做人工判断（保留 / 删除 / 提升进 `agents.md`）。面板不能发送消息、修改运行配置、重跑 Invocation 或删除审计记录。

## 配置

```toml
[admin]
enabled = true
host = "127.0.0.1"
port = 8787
session_ttl_hours = 168
# 可选：默认 apps/admin/dist
static_dir = "/opt/plasticwan/apps/admin/dist"
```

| 字段 | 语义 |
| --- | --- |
| `enabled` | `false` 时 `serve` 完全不监听端口 |
| `host` | 只接受 `127.0.0.1`、`::1`、`localhost`；远程访问放反向代理 |
| `port` | 1–65535 |
| `session_ttl_hours` | 1–720，Session 与 Cookie `Max-Age` 共用 |
| `static_dir` | 前端 bundle 目录；缺失时 API 仍可用，静态路由返回 503 `admin_bundle_missing` |

`admin.host` 的回环限制在 `validateSemantics` 中强制。配置整体参与 `config_hash`，改动后必须重启 `serve`。

## 生命周期

`src/application.ts` 在 Scheduler 启动后、Telegram long polling 之前创建 `AdminServer`，日志输出：

```json
{"event":"admin_started","host":"127.0.0.1","port":8787,"at":"..."}
```

关闭顺序中 `admin?.stop()` 先于 Scheduler，避免请求持有已关闭的数据库。Admin Panel 与 Bot 共享同一个 `SqliteStore`，因此受 `ServeLock` 单实例约束保护。

## 认证

`src/admin/auth.ts`：

- 首次访问时 `GET /api/auth/session` 返回 `setup_required = true`，前端渲染创建管理员表单。
- `POST /api/auth/setup` 在事务内再次确认无用户后写入 `admin_users`；重复调用返回 409 `setup_complete`。
- 密码 12–200 字符，用户名 `^[A-Za-z0-9._-]{3,32}$`。
- 密码只以 Bun `argon2id` hash 存储，明文不落库、不进日志。
- Session Token 为 32 字节随机值，返回给 Cookie，数据库只存 SHA-256 摘要。
- Cookie 为 `HttpOnly; SameSite=Strict; Path=/`，`Max-Age` 等于 `session_ttl_hours`。
- 用户名不存在时仍执行一次 hash 运算，避免枚举时间差。
- 同一 `(client, username)` 连续 10 次失败后锁定 15 分钟，返回 429 `too_many_attempts`。
- 过期 Session 在认证时删除，并在新建 Session 与服务启动时批量清理。
- `POST /api/auth/logout` 按 Token 摘要删除 Session。
- `POST /api/auth/credentials` 修改当前管理员用户名和密码，保留当前 Session、撤销该用户其它 Session，并签发新的 Cookie。

跨站防护：所有 `POST` 校验 `Origin`，主机不匹配返回 403 `bad_origin`；审计路由只接受 `GET`，其它方法返回 405。

## API

前缀 `/api`，全部返回 JSON，`cache-control: no-store`。

| 路由 | 说明 |
| --- | --- |
| `POST /auth/logout` | 撤销当前 Session |
| `POST /auth/credentials` | 修改当前管理员用户名和密码，并撤销该用户其它 Session |
| `GET /overview` | Invocation/已配置 Sticker 索引状态、Top Tool、当日预算用量、消息与媒体分析缓存计数 |
| `GET /invocations` | Tool Session 列表 |
| `GET /invocations/:id` | Overview 时间线所需的冻结消息、Tool Call、Model Call、Agent transcript、Telegram 发送与冻结上下文 |
| `GET /messages` | 消息列表 |
| `GET /messages/:id` | 全部 Revision 与媒体（含视觉描述） |
| `GET /sticker-sets` | Set 同步状态与索引进度 |
| `GET /stickers` | 已配置 Sticker Set 的可搜索索引条目与分析元数据 |
| `GET /memories` | 记忆列表，可按 `chat`（Telegram Chat ID）与 `state`（`active`/`expired`/`long_ttl`）过滤 |
| `GET /memories/chats` | 已知 Chat 列表（记忆创建表单的选项来源） |
| `POST /memories` | 创建记忆：`chat_id`、可选 `message_thread_id`（默认 0）、`content`（1–150 字符）、可选 `ttl_seconds`（默认 1 天） |
| `PUT /memories/:id` | 修改 `content` 和/或按 `ttl_seconds` 续期（至少提供一项）；不存在返回 404 |
| `DELETE /memories/:id` | 删除记忆；不存在返回 404 |
| `POST /cancel-pending-sessions` | 取消所有 `collecting`/`queued` Bucket 及其 queued Invocation，并退回当日调用预算 |

记忆列表项包含 `expired` 与 `long_ttl` 布尔标记：`long_ttl` 表示剩余寿命超过 `agent.memory_ttl_warning_days`（默认 30 天）。创建时若 `(chat_id, message_thread_id)` 对应的 Conversation 尚不存在会自动创建。

`GET /stickers` 不列出群聊中收到的任意 Sticker。只有 `telegram.sticker_sets` 中配置的 Set 才会同步到该索引并获准供 Bot 搜索和发送；聊天媒体的按需视觉分析属于 `media_analyses`，在消息详情中展示。

列表参数：`limit`（1–100，默认 25）、`cursor`（上一页 `next_cursor`）、`state`、`chat`、`set`、`search`。分页为 ID 倒序 keyset：请求 `limit + 1` 行，多出一行则返回 `next_cursor`。

输入校验在 `src/admin/audit.ts`：`state`/`set` 必须匹配 `^[A-Za-z0-9._-]{1,64}$`，`chat`/`cursor` 必须是整数，`search` 最长 100 字符且 `LIKE` 通配符经过转义。非法输入返回 400 与稳定错误码（`invalid_limit`、`invalid_state`、`invalid_cursor`…）。所有查询使用绑定参数。

SQLite `bigint` ID 在 JSON 中字符串化，Token/计数等小整数转 `number`。

## 静态资源

非 `/api` 路径由 `AdminServer` 从 `static_dir` 提供：

- 路径解析后必须仍在 `static_dir` 内，否则 404，避免穿越。
- 命中文件按扩展名设置 Content-Type，非 HTML 资源 `max-age=3600`。
- 未命中时回退 `index.html`，支持前端路由深链接。
- 所有响应带 `X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options: DENY`；HTML 额外带 CSP（`default-src 'none'`，脚本仅 `'self'`）。

## 前端

```bash
bun run admin:build   # 生成 apps/admin/dist，供 serve 托管
bun run admin:dev     # Rsbuild dev server，/api 代理到 ADMIN_API_TARGET
```

`ADMIN_API_TARGET` 默认 `http://127.0.0.1:8787`。

结构：

| 文件 | 职责 |
| --- | --- |
| `src/api.ts` | 类型化 fetch 封装与 `ApiError` |
| `src/queries.ts` | TanStack Query option 工厂（列表用 infinite query） |
| `src/routes.tsx` | 认证门、登录/初始化卡片、Layout 与路由树 |
| `src/components.tsx` | `queryState()` 占位渲染、JSON 块、状态 Tag |
| `src/pages/*.tsx` | Overview、Tool sessions、Messages、Memories、Bot Sticker Set 索引 |

`queryState()` 是普通函数而非组件：调用方依赖 `null` 判断是否渲染真实数据，JSX 元素永远不为 `null`。

Tool session 详情默认打开 Overview 时间线：按时间合并冻结消息、Invocation 生命周期、Model Call、Tool Call 与 Agent transcript；消息正文和 `send` 参数中的发送内容直接展示，Tool 结果与完整参数按需展开。Assistant 文本显式标注为私有推理，只有 `send` Tool 会发往 Telegram。

## 数据表

迁移 `src/migrations/003_admin.sql`：

| 表 | 用途 |
| --- | --- |
| `admin_users` | 用户名、Argon2id hash、创建/更新/最近登录时间 |
| `admin_sessions` | Token SHA-256 摘要、所属用户、创建/过期/最近活动时间 |

`admin_sessions.user_id` 级联删除；`admin_sessions_expiry_idx` 支撑过期清理。两张表不参与 `purgeExpiredData` 的 30 天在线保留窗口——管理员账号不是会话数据。

## 验证

```bash
bun test test/admin.test.ts
bun test test/memory.test.ts
bun run check
bun run admin:build
```

`test/admin.test.ts` 覆盖：首次初始化与登录态转换、弱密码拒绝且不写入用户、`setup` 重复调用冲突、错误凭据与未知用户的统一 401、跨站 `POST` 拒绝、审计三大视图的字段与过滤、非法 `limit`/`state` 的 400、审计路由写操作 405、静态资源回退与目录穿越拒绝、`admin.host` 非回环时配置加载失败。

`test/memory.test.ts` 覆盖：记忆持久化与 TTL 过期、跨 Conversation 隔离与删除幂等、Tool 审计与 150 字符硬限制、system prompt 注入顺序与过滤、管理 API 的 CRUD/聊天过滤/`long_ttl` 与 `expired` 标记/参数校验/404 与 405、`purgeExpiredData` 清理过期记忆。

浏览器冒烟应确认：初始化表单 → Overview 统计 → Tool session 详情六个 Tab，默认 Overview 按时间显示收到的消息与 `send` 内容 → 消息搜索与详情 Revision、媒体分析 → 已配置 Sticker Set 与 `index_state` 过滤 → Memories 页面按群聊与状态过滤、新建/编辑/删除记忆、长 TTL 记忆显示 warning → 登出后深链接回落登录页 → 重新登录恢复。
