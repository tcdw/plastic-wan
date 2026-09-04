# Admin Panel

Admin Panel 是随 `serve` 启动的本地审计与管理界面，覆盖 Tool Session（Invocation）、收到的 Telegram 消息、媒体视觉分析、已配置 Sticker Set 的可搜索索引、Agent 短期记忆（`memories`）以及 Alarm（闹钟 / 延迟调用）。后端在 `src/ingress/admin/`，前端在 `apps/admin/`（Rsbuild + React + Ant Design + TanStack Query + TanStack Router）。

审计数据只读；记忆管理、Bot 管理员列表管理、模型热切换、解除睡眠、取消挂起会话与取消 pending Alarm 是受控的控制端点。管理员可以增删改查记忆、按群聊过滤，并对长 TTL 记忆做人工判断（保留 / 删除 / 提升进 `agents.md`），也可以指派/移除能执行 `/pause`、`/resume`、`/cut_topic` 等 Bot 管理员命令的 Telegram 用户，热切换 agent 模型，唤醒/取消挂起会话，或取消尚未触发的 Alarm。面板不能改写配置文件、不能重跑 Invocation 或删除审计记录。

`admin` section 的字段语义见 [configuration.md](configuration.md#admin-panel)；`admin.host` 的回环限制在 `validateSemantics` 中强制，配置整体参与 `config_hash`，改动后必须重启 `serve`。

## 生命周期

`src/application.ts` 在 Scheduler 启动后、Telegram long polling 之前创建 `AdminServer`，日志输出：

```json
{"event":"admin_started","host":"127.0.0.1","port":8787,"at":"..."}
```

关闭顺序中 `admin?.stop()` 先于 Scheduler，避免请求持有已关闭的数据库。Admin Panel 与 Bot 共享同一个 `SqliteStore`，因此受 `ServeLock` 单实例约束保护。

## 认证

`src/ingress/admin/auth.ts`：

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
- `POST /api/auth/credentials` 修改当前管理员用户名和密码，撤销该用户全部 Session（含当前）并签发新的 Cookie。

跨站防护：所有写方法（`POST`/`PUT`/`DELETE`）校验 `Origin`，主机不匹配返回 403 `bad_origin`；审计路由只接受 `GET`，其它方法返回 405。

## API

前缀 `/api`，全部返回 JSON，`cache-control: no-store`。

完整路由表以 `src/ingress/admin/server.ts` 的分发为准。这里只记录路由签名看不出来的约束。

**审计读端点**（`GET /auth/session`、`/overview`、`/usage`、`/invocations[/:id]`、`/messages[/:id]`、`/sticker-sets`、`/stickers`、`/alarms`、`/memories`、`/memories/chats`、`/admins`、`/model`）一律只读；落到审计分支的非 `GET` 请求返回 405 `method_not_allowed`。`/usage` 额外接受 `days`（1–90，默认 7），越界返回 400 `invalid_days`。

**写端点是白名单例外**，只有这些：

| 路由 | 非显然的语义 |
| --- | --- |
| `POST /auth/logout` / `POST /auth/credentials` | 改凭据会撤销该用户**全部** Session（含当前）并签发新 Cookie |
| `POST /wake` | 删除持久化睡眠状态并唤醒 Scheduler；幂等，重复调用保持 `awake` |
| `POST /cancel-pending-sessions` | 取消所有 `collecting`/`queued` Bucket 及其 queued Invocation，并**退回**当日调用预算 |
| `POST` / `PUT` / `DELETE /memories[/:id]` | 创建时若 `(chat_id, message_thread_id)` 的 Conversation 不存在会自动建；`PUT` 至少要提供 `content` 或 `ttl_seconds` 之一 |
| `POST` / `DELETE /admins[/:id]` | `:id` 是 Telegram 用户 ID 不是行 ID；添加幂等；删掉配置种子项后重启会重新出现 |
| `PUT` / `DELETE /model` | 内存态热切换，只影响后续 Invocation；未知 provider/model 或模型无 text 能力返回 400（`unknown_provider`/`unknown_model`/`not_text_capable`） |
| `DELETE /alarms/:id` | **只能**取消 `pending`：`firing` 与其它终态返回 409 `alarm_not_pending`，不存在返回 404 `not_found`。取消记录当前面板管理员与 `admin_cancelled` 原因并唤醒 Scheduler |

列表过滤同样只在少数端点上有效：`/alarms` 按 `state`(`pending`/`firing`/`fired`/`cancelled`)/`chat`/`target`，`/memories` 按 `chat`/`state`(`active`/`expired`/`long_ttl`)，`/stickers` 按 `set`/`state`。记忆列表项带 `expired` 与 `long_ttl` 布尔标记，`long_ttl` 表示剩余寿命超过 `agent.memory_ttl_warning_days`。Alarm 列表把 `pending` 按 `scheduled_at, id` 升序置顶，非 pending 历史按最近状态时间/id 倒序。

`GET /stickers` 不列出群聊中收到的任意 Sticker。只有 `telegram.sticker_sets` 中配置的 Set 才会同步到该索引并获准供 Bot 搜索和发送；聊天媒体的按需视觉分析属于 `media_analyses`，在消息详情中展示。

列表参数：`limit`（1–100，默认 25）、`cursor`（上一页 `next_cursor`）、`state`、`chat`、`set`、`search`。分页为 ID 倒序 keyset：请求 `limit + 1` 行，多出一行则返回 `next_cursor`。

输入校验在 `src/ingress/admin/audit.ts`：`state`/`set` 必须匹配 `^[A-Za-z0-9._-]{1,64}$`，`chat`/`cursor` 必须是整数，`search` 最长 100 字符且 `LIKE` 通配符经过转义。非法输入返回 400 与稳定错误码（`invalid_limit`、`invalid_state`、`invalid_cursor`…）。所有查询使用绑定参数。

SQLite `bigint` ID 在 JSON 中字符串化，Token/计数等小整数转 `number`。Alarm 列表项额外把 `message_thread_id`、目标 User ID、conversation ID 与关联 Invocation ID 全部字符串化，展开详情展示完整 summary、原始 UTC 计划时间、conversation ID、Telegram Chat ID、thread ID、目标 User ID、创建/触发/取消时间、取消者、取消原因、Invocation 结果、`admin_cancelled` 标记与 `updated_at`。`DELETE /api/alarms/:id` 只能取消 `pending`；`firing` 与其它终态返回 409 `alarm_not_pending`，不存在返回 404 `not_found`，跨站与认证规则沿用现有 Admin 写端点。

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
| `src/pages/*.tsx` | Overview、Tool sessions、Alarms、Messages、Memories、Bot admins、Sticker Set 索引、Model 切换、Usage chart |

`queryState()` 是普通函数而非组件：调用方依赖 `null` 判断是否渲染真实数据，JSX 元素永远不为 `null`。

Overview 的 Bot status 卡片显示当前 `sleeping`/`awake`、`sleep_until`，睡眠时提供带确认的 `Wake now` 操作，并显示所有 `chat_pause` Chat 的名称或 Telegram ID 与暂停时间。

Tool session 详情默认打开 Overview 时间线：按时间合并冻结消息、Invocation 生命周期、Model Call、Tool Call 与 Agent transcript；消息正文和 `send` 参数中的发送内容直接展示，Tool 结果与完整参数按需展开。失败的 Model Call 同时展示稳定错误码，并可展开查看经密钥脱敏的完整 Provider 错误详情。Assistant 文本显式标注为私有推理，只有 `send` Tool 会发往 Telegram。

## 数据表

迁移 `src/store/migrations/003_admin.sql`：

| 表 | 用途 |
| --- | --- |
| `admin_users` | 用户名、Argon2id hash、创建/更新/最近登录时间 |
| `admin_sessions` | Token SHA-256 摘要、所属用户、创建/过期/最近活动时间 |

`admin_sessions.user_id` 级联删除；`admin_sessions_expiry_idx` 支撑过期清理。两张表不参与 `purgeExpiredData` 的 30 天在线保留窗口——管理员账号不是会话数据。

Bot 管理员列表（迁移 `src/store/migrations/008_bot_admins.sql`）：

| 表 | 用途 |
| --- | --- |
| `bot_admins` | Telegram 用户 ID（主键）、显示名、来源（`config`/`admin-panel`/`telegram`）、添加时间 |

`telegram.admins` 配置项在启动时以 `INSERT ... ON CONFLICT DO NOTHING` 播种，只增不减，来源记为 `config`；面板添加管理员时来源记为 `admin-panel`。管理员本人执行命令时只刷新 `display_name`（`ON CONFLICT DO UPDATE`），不改写 `added_by` 来源。Bot 管理员决定谁能执行 `/pause` 与 `/resume`，与面板登录账号无关。

## 验证

测试命令、覆盖契约与浏览器冒烟清单见 [verification.md](verification.md) 的「静态与单元验证」与「Admin Panel 冒烟」两节。
