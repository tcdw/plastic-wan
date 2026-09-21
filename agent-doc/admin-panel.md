# Admin Panel

Admin Panel 是随 `serve` 启动的本地审计与管理界面，覆盖 Tool Session（Invocation）、收到的 Telegram 消息、媒体视觉分析、已配置 Sticker Set 的可搜索索引、Agent 短期记忆（`memories`）以及 Alarm（闹钟 / 延迟调用）。后端在 `src/ingress/admin/`，前端在 `apps/admin-next/`（Vite + React + Tailwind 4 + shadcn/Base UI + TanStack Query + TanStack Router），构建产物是**纯静态 SPA**，由 `AdminServer` 同源托管，不依赖任何 Node/Nitro 运行时。

审计数据只读；记忆管理、Bot 管理员列表管理、模型与 Provider 管理（Models 页）、配置文件应用、立即重启、解除睡眠、取消挂起会话与取消 pending Alarm 是受控的控制端点。管理员可以增删改查记忆、按群聊过滤，并对长 TTL 记忆做人工判断（保留 / 删除 / 提升进 `agents.md`），也可以指派/移除能执行 `/pause`、`/resume`、`/cut_topic` 等 Bot 管理员命令的 Telegram 用户，在 Models 页维护 Provider 与模型列表（写回 `config.jsonc` 并重新加载）、切换 agent 与 vision 模型并设置 agent 的 thinking 级别，唤醒/取消挂起会话，取消尚未触发的 Alarm，把配置文件中的热更新白名单字段应用到运行中的进程，或在有待重启字段时直接重启 `serve`。写入只发生在 [API](#api) 白名单里的端点，且全部经过 `writeConfigEdits` 与 `ConfigReloader`（先写文件、再应用，可回滚到未写入状态）。

`admin` section 的字段语义见 [configuration.md](configuration.md#admin-panel)；`admin.host` 不限制取值，绑定地址与暴露风险由运维负责（推荐回环 + 反向代理）。`admin.*` 不在热更新白名单里：改动后进入待重启列表，重启 `serve` 才生效。热更新白名单与语义见 [configuration.md](configuration.md#运行时配置热更新)。

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
- 密码只以 `argon2id` hash（`@node-rs/argon2`）存储，明文不落库、不进日志。
- Session Token 为 32 字节随机值，返回给 Cookie，数据库只存 SHA-256 摘要。
- Cookie 为 `HttpOnly; SameSite=Strict; Path=/`，`Max-Age` 等于 `session_ttl_hours`。
- 用户名不存在时仍执行一次 hash 运算，避免枚举时间差。
- 同一失败键连续 10 次失败后锁定 15 分钟，返回 429 `too_many_attempts`；计数只在内存中，重启 `serve` 清空。失败键是请求头 `X-Forwarded-For` 的原值（缺省为 `local`）加小写用户名，见 `server.ts` 登录分支与 `AdminAuth.login`。该请求头由客户端提供，直连时并不可信。
- 过期 Session 在认证时删除，并在新建 Session 与服务启动时批量清理。
- `POST /api/auth/logout` 按 Token 摘要删除 Session。
- `POST /api/auth/credentials` 修改当前管理员用户名和密码，撤销该用户全部 Session（含当前）并签发新的 Cookie。

跨站防护：所有写方法（`POST`/`PUT`/`DELETE`）校验 `Origin`，主机不匹配返回 403 `bad_origin`；审计路由只接受 `GET`，其它方法返回 405。

## API

前缀 `/api`，全部返回 JSON，`cache-control: no-store`。

完整路由表以 `src/ingress/admin/server.ts` 的分发为准。这里只记录路由签名看不出来的约束。

**审计读端点**（`GET /auth/session`、`/overview`、`/usage`、`/invocations[/:id]`、`/contexts[/:conversation_id]`、`/messages[/:id]`、`/sticker-sets`、`/stickers`、`/alarms`、`/memories`、`/memories/chats`、`/admins`、`/provider-presets`、`/config/status`）一律只读；落到审计分支的非 `GET` 请求返回 405 `method_not_allowed`。`GET /providers` 只读，但 `/providers` 同时是写端点前缀，不落到审计分支。`/usage` 额外接受 `days`（1–90，默认 7），越界返回 400 `invalid_days`；Token 序列来自 `daily_usage`，Invocation 与 Tool call 序列直接按 UTC 日期 `COUNT` `invocations` 与 `tool_calls`。`/contexts` 是按 Conversation（chat + Forum Topic）维度只读投影 Conversation Context；`:conversation_id` 是 `conversations.id` 而不是 `conversation_contexts.id`，不存在返回 404。`GET /config/status` 返回 `generation`、`active_hash`、`file_hash`、`restart_required` 与 `last_error`（`{ code, message, at }` 或 `null`）。`ConfigReloader` 未接线时，`GET /config/status` 返回 503 `config_reload_unavailable`，`PUT /model` 返回 503 `model_switch_unavailable`，`/providers` 与 `PUT /vision` 返回 503 `providers_unavailable`。

`GET /providers` 是 Models 页的主读端点，读的是**磁盘上的 `config.jsonc`**（不是运行中的 active 配置），因此待重启字段以文件为准：

```jsonc
{
  "revision": "<config.jsonc 原始字节的 SHA-256>",
  "supervised": false,                       // PLASTICWAN_SUPERVISED=1 时为 true
  "agent": { "provider": "openrouter", "model": "deepseek/deepseek-v4-flash-0731", "thinking_level": "off" },
  "vision": { "provider": "google", "model": "gemini-3.7-flash" },
  "restart_required": ["providers.oproxy.base_url"],
  "providers": [
    {
      "alias": "openrouter",
      "kind": "builtin",
      "provider": "openrouter",              // builtin 才有；Pi 供应商 id
      "api": "openai-completions",           // builtin 由 Pi 目录推导
      "base_url": "https://openrouter.ai/api/v1",
      "header_names": [],                    // 只有名称，永远没有值
      "models": [ /* 完整模型配置，含 compat */ ]
    }
  ]
}
```

响应里不出现 `api_key`，也不出现任何 header 值，也不说明已保存的 SecretRef 是明文、`env` 还是 `command`。文件无效时返回 422 `config_invalid`（错误经过密钥脱敏）。`GET /provider-presets` 列出可配置的 builtin Provider（`id`、`name`、`api`、`base_url`），过滤规则见 [configuration.md](configuration.md#provider)。

**写端点是白名单例外**，只有这些：

| 路由 | 非显然的语义 |
| --- | --- |
| `POST /auth/setup` / `POST /auth/login` | 首次建号与登录，约束见「认证」 |
| `POST /auth/logout` / `POST /auth/credentials` | 改凭据会撤销该用户**全部** Session（含当前）并签发新 Cookie |
| `POST /wake` | 删除持久化睡眠状态并唤醒 Scheduler；幂等，重复调用保持 `awake` |
| `POST /cancel-pending-sessions` | 取消所有 `collecting`/`queued` Bucket 及其 queued Invocation |
| `POST` / `PUT` / `DELETE /memories[/:id]` | 创建时若 `(chat_id, message_thread_id)` 的 Conversation 不存在会自动建；`PUT` 至少要提供 `content` 或 `ttl_seconds` 之一 |
| `POST` / `DELETE /admins[/:id]` | `:id` 是 Telegram 用户 ID 不是行 ID；添加幂等；删掉配置种子项后重启会重新出现 |
| `PUT /model` | 切换 agent 模型：把 `agent.provider` / `agent.model` 写入 `config.jsonc`，同时把 `agent.thinking_level` 重置为新模型接受的最弱级别，然后重新加载，重启后仍然生效，只影响后续 Invocation。响应的 `current.thinking_level` 是重置后的级别。必须带 `If-Match`（revision 来自 `GET /providers`），缺失返回 400 `revision_required`，过期返回 409 `config_conflict`。未知 provider/model、模型无 text 能力或模型不可用返回 400（`unknown_provider`/`unknown_model`/`not_text_capable`/`model_unusable`），其它失败（配置权限、文件校验、candidate 校验等）返回 409；body 为 `{ error, message }`，文件已写入但应用失败时 message 以 `config.jsonc was updated but not applied: ` 开头。`GET /model` 与 `DELETE /model` 已删除，落到 405 `method_not_allowed` |
| `POST` / `PUT` / `DELETE /providers[...]` | Provider 与模型管理，见「Models 页写端点」 |
| `PUT /thinking-level` | body `{ thinking_level }`，设置 `agent.thinking_level`，热应用，响应同「Models 页写端点」。取值不是 Pi 级别返回 400 `invalid_body`；文件里的 agent 模型不接受该级别返回 422 `unsupported_thinking_level`，message 列出可选级别（规则见 [configuration.md](configuration.md#模型-thinking-级别)）；`If-Match` 规则同其它写端点 |
| `PUT /vision` | 切换 vision 模型。写入前预检：模型在文件的该 Provider 下存在、支持 image 输入、且 `vision.max_output_tokens ≤ 该模型的 max_tokens`，不满足返回 400（`unknown_provider`/`unknown_model`/`not_image_capable`/`max_output_tokens_exceeded`）。`vision.*` 是 restart 字段，结果是待重启 |
| `POST /restart` | 界面上的 “Restart now”。部署方未声明 `PLASTICWAN_SUPERVISED=1` 时返回 409 `restart_unsupported`；磁盘配置权限或内容校验失败时返回 422 `config_invalid` 且不退出；成功返回 202 `{ status: 'restarting' }`，随后走优雅关闭并以退出码 75（`EX_TEMPFAIL`）退出，由外部监督重新拉起 |
| `POST /config/apply` | 重新读取 `config.jsonc` 并把热更新白名单字段应用到运行中的进程。成功返回 200 `{ status: 'applied', applied, restart_required, outside_serve, generation, active_hash, file_hash }`；失败返回 422 `{ error, message }`，此时 active 配置不变，错误记录在 `GET /config/status` 的 `last_error` |
| `DELETE /alarms/:id` | **只能**取消 `pending`：`firing` 与其它终态返回 409 `alarm_not_pending`，不存在返回 404 `not_found`。取消记录当前面板管理员与 `admin_cancelled` 原因并唤醒 Scheduler |

列表过滤同样只在少数端点上有效：`/alarms` 按 `state`(`pending`/`firing`/`fired`/`cancelled`)/`chat`/`target`，`/memories` 按 `chat`/`state`(`active`/`expired`/`long_ttl`)，`/stickers` 按 `set`/`state`，`/contexts` 只按 `chat`。记忆列表项带 `expired` 与 `long_ttl` 布尔标记，`long_ttl` 表示剩余寿命超过 `agent.memory_ttl_warning_days`。Alarm 列表把 `pending` 按 `scheduled_at, id` 升序置顶，非 pending 历史按最近状态时间/id 倒序。

## Models 页写端点

所有写端点：路径在 `/api` 下；必须带 `If-Match: <revision>`（缺失返回 400 `revision_required`，过期返回 409 `config_conflict` 且文件不变）；在 `ConfigReloader` 的锁里「写文件 → 应用」；响应是 `GET /providers` 的完整视图加上 `apply: { applied, restart_required, outside_serve }`。模型 id 可能含 `/`，路径里必须 `encodeURIComponent` 编码：服务端先按 `/` 切分再逐段解码，未编码的 id 不会匹配到路由。

| 端点 | 语义 |
| --- | --- |
| `POST /providers` | 新建 Provider。body：`alias`、`kind`、builtin 的 `provider` 或 custom 的 `base_url` + `api`、`api_key`（必填明文）、`headers?`、`models`（至少 1 个）。alias 已存在返回 409 `provider_exists`；builtin 不满足收录规则返回 400 `unknown_builtin_provider` / `unsupported_builtin_provider`；模型违反 `max_tokens ≤ context_window` 或 compat 适用性返回 400 `invalid_model`。新增 Provider 是 restart 字段，结果是待重启 |
| `PUT /providers/:alias` | 修改连接字段。`api_key` 省略表示保持；`headers` 按名称逐项处理（省略保持、字符串替换、`null` 删除）。**修改 `base_url` 时必须在同一次请求里重新提交 `api_key` 与全部已有 header 值**，否则返回 400 `credentials_required`——面板被盗用时改地址即可把已保存的凭据引向攻击者的服务器。builtin 只接受 `api_key`，其它字段返回 400 `immutable_field`；`kind`、`alias`、builtin 的 `provider` 都不可改。没有任何字段变化返回 400 `no_changes` |
| `DELETE /providers/:alias` | 删除。文件里的 `agent.provider` 或 `vision.provider` 指向它时返回 409 `provider_in_use` |
| `POST /providers/:alias/models` | 批量追加模型（`models`，1–200 个）。id 重复返回 409 `model_exists`。热更新 |
| `PUT /providers/:alias/models/:id` | 替换单个模型定义，body 的 `id` 必须等于 `:id`（否则 400 `invalid_model_id`）。热更新；在用模型变成待重启 |
| `DELETE /providers/:alias/models/:id` | 删除模型。在用（agent 或 vision 模型）返回 409 `model_in_use` |
| `POST /providers/discover` | 拉取模型列表并解析元数据，同时充当连接自检（界面上的 “Test”）。两种模式二选一：`{ alias }` 用运行中 registry 的 baseUrl 与凭据（不重新解析文件里的 SecretRef，`env`/`command` 不会执行；连接字段待重启时返回 409 `restart_pending`），或临时模式 `{ kind, provider \| base_url+api, api_key, headers? }` 用请求体里的完整连接。响应 `{ endpoint, models: [draft], metadata_source_error }`，每个 draft 带元数据、来源标记与 `configured`。上游错误经脱敏后以 502 `provider_discovery_failed` 返回 |
| `POST /providers/lookup-metadata` | 给定手动输入的模型 id 列表（1–100）只做元数据解析，不访问供应商端点。响应 `{ models: [draft], metadata_source_error }` |

`metadata_source_error` 只在 models.dev 目录拉取失败时非空：目录只是元数据来源之一，列表本身仍然可用，拿不到的字段一律标成「缺失」并要求管理员确认，而不是让整个请求失败。

草稿字段：`id`、`name`、`reasoning`、`thinking_levels`、`input`、`context_window`、`max_tokens`、`cost`、`requires_reasoning_content`、`sources`（逐字段来源：`openrouter`/`vercel`/`gemini`/`models.dev`/`models.dev-cross-provider`/`models.dev-fuzzy`/`missing`）、`requires_reasoning_content_source`、`match`、`candidates`、`needs_confirmation`。字段为空、只由「猜出来的」来源支撑、或列为 `needs_confirmation` 时，面板必须让管理员确认或手填后才能保存；服务端不填任何默认值。

`match.confidence` 说明这份元数据是怎么找到的，也决定了要不要确认：

| confidence | 含义 | 来源标记 | 是否需确认 |
| --- | --- | --- | --- |
| `exact` | 就在该 Provider 对应的 models.dev 条目下（builtin 按映射表，custom 按 base_url 主机） | `models.dev` | 否 |
| `cross-provider` | 模型 id 精确命中，但命中的是**别的** provider——不知名中转站的常态 | `models.dev-cross-provider` | 是 |
| `fuzzy` | 去掉 `~` 前缀、`:free` 之类后缀和 vendor 前缀之后才匹配上 | `models.dev-fuzzy` | 是 |

`cross-provider` 也要确认，是因为同一个模型 id 在不同 provider 下是不同的部署，价格、上下文、输出上限与可选的 thinking 级别都可能不一样（同一个 DeepSeek 模型，DeepSeek 官方给 `high`/`max`，OpenRouter 给 `high`/`xhigh`）。`thinking_levels` 只在最终 `reasoning` 为 `true` 时才有值；拿不到时为 `null`、来源 `missing`，但**不**列入 `needs_confirmation`——配置里省略它就是沿用 Pi 默认。`requires_reasoning_content_source` 只在真的映射出 `true`（models.dev 的 `interleaved.field === "reasoning_content"`）时才指向 models.dev；`interleaved` 缺失、是裸 `true` 或写的是别的字段名时一律是 `missing`——值留在「自动」，没有来源填过它。

**SecretRef 只写不读**：面板只能把 `api_key` / header 值写成明文字符串，不能写 `{ env }` 或 `{ command }`（`command` 等于让面板在宿主机上执行命令；`env` 配合可编辑的 `base_url` 等于能外泄进程里任意环境变量）。输入框固定提示 “Set - leave empty to keep it”：留空表示保持，非空表示替换成明文。代价是：原来用 `env` 的 Provider 在面板里被替换成明文后，环境变量不再生效，页面上也看不出这一点——要继续用 `env` 管理 key 的人只能手改配置文件；又因为 `base_url` 改动强制重填凭据，改地址会把 `env` / `command` 引用一并降级成明文。服务端收到明文后先 `secrets.remember(value)` 注册进 `SecretStore`，再写文件或发请求，这样日志、reload 错误与上游报错都能脱敏。请求提交的明文走单独一条有上限的队列（最旧的会被挤掉），不会像配置里解析出来的 Secret 那样永久累积；面板路径也从不调用 `secrets.resolve`，因此请求体里的字符串不会进入进程级的永久集合。

`/contexts` 按 `last_active_at` 倒序，游标是 `last_active_at|id` 复合值（`invalid_cursor` 由解析失败给出）。`GET /contexts/:conversation_id` 返回 Context Header 加上保留窗口（`seq >= head_seq`）内的 `context_messages` 与存活 `context_refs`；`payload_preview` 截断到 2000 字符并附 `payload_truncated`，被 GC 软删的行不出现在响应里。两个端点都是 `GET`，前端页面不发任何写请求。

`GET /stickers` 不列出群聊中收到的任意 Sticker。只有 `telegram.sticker_sets` 中配置的 Set 才会同步到该索引并获准供 Bot 搜索和发送；聊天媒体的按需视觉分析属于 `media_analyses`，在消息详情中展示。

列表参数：`limit`（1–100，默认 25）、`cursor`（上一页 `next_cursor`）、`state`、`chat`、`set`、`search`。分页为 ID 倒序 keyset：请求 `limit + 1` 行，多出一行则返回 `next_cursor`。

输入校验在 `src/ingress/admin/audit.ts`：`state`/`set` 必须匹配 `^[A-Za-z0-9._-]{1,64}$`，`chat`/`cursor` 必须是整数，`search` 最长 100 字符且 `LIKE` 通配符经过转义。非法输入返回 400 与稳定错误码（`invalid_limit`、`invalid_state`、`invalid_cursor`…）。所有查询使用绑定参数。

SQLite `bigint` ID 在 JSON 中字符串化，Token/计数等小整数转 `number`。Alarm 列表项额外把 `message_thread_id`、目标 User ID、conversation ID 与关联 Invocation ID 全部字符串化，展开详情展示完整 summary、原始 UTC 计划时间、conversation ID、Telegram Chat ID、thread ID、目标 User ID、创建/触发/取消时间、取消者、取消原因、Invocation 结果、`admin_cancelled` 标记与 `updated_at`。

## 静态资源

非 `/api` 路径由 `AdminServer` 从 `static_dir` 提供：

- 路径解析后必须仍在 `static_dir` 内，否则 404，避免穿越。
- 命中文件按扩展名设置 Content-Type，非 HTML 资源 `max-age=3600`。
- 未命中时回退 `index.html`，支持前端路由深链接。
- 所有响应带 `X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options: DENY`；HTML 额外带 CSP（`default-src 'none'`，脚本仅 `'self'`）。

## 前端

```bash
pnpm run admin:build   # 生成 apps/admin-next/dist，供 serve 托管
pnpm run admin:dev     # Vite dev server，监听 127.0.0.1:5273，/api 代理到 ADMIN_API_TARGET
pnpm run admin:test:e2e  # Playwright 浏览器 E2E（真实 AdminServer + 临时 SQLite + 合成数据）
```

`ADMIN_API_TARGET` 默认 `http://127.0.0.1:8787`。开发代理只把 Origin 精确等于
`http://localhost:5273` / `http://127.0.0.1:5273` 的请求改写为目标的 origin，
其它 Origin 原样转发、由后端跨站校验拒绝（人工验证脚本见
`scripts/admin-dev-proxy-probe.ts`）。生产环境不需要该变量：`serve` 同源托管静态文件与 `/api`。

结构：

| 文件 | 职责 |
| --- | --- |
| `src/routes.tsx` | 认证门（setup/login gate）、Layout 与显式路由表（一级页面与详情页）；新增页面在此注册 |
| `src/lib/api.ts` | 类型化 fetch 封装与 `ApiError` |
| `src/lib/queries.ts` | TanStack Query option 工厂（列表用 infinite query，keyset cursor 透传） |
| `src/lib/format.ts` | 格式化与状态色映射 |
| `src/lib/errors.ts` | `errorMessage()`：统一错误文本（`ApiError.code: message`） |
| `src/lib/memory-ttl.ts` | 记忆 TTL 边界纯函数 |
| `src/lib/timeline.ts` | Invocation 时间线纯模型（同时间排序、send 参数解析） |
| `src/components/business/**` | 共享业务组件（CursorList / FilterToolbar / StateBadge / TableShell / JsonViewer / KvList / ConfirmDialog / ChartCard / PrivateReasoning / DetailState 等），契约见 `apps/admin-next/README.md` |
| `src/pages/*.tsx` | Overview、Tool sessions、Contexts、Alarms、Messages、Memories、Bot admins、Sticker Set 索引、Models、Settings |

前端约定：

- 业务页面一律 `useQuery` / `useInfiniteQuery` 并显式渲染 loading / error / data
  三态，**禁止 `useSuspenseQuery`**（401 会在渲染期抛出并落进路由错误边界，
  产生无法恢复的死屏；显式状态分支把错误留在页面内展示）。
- 受保护请求的 401（`unauthenticated`）由 `src/lib/query-client.ts` 的全局
  cache `onError` 统一处理：失效 session query，让认证 gate 回登录页；登录 /
  setup / 改凭据的 `invalid_credentials` 等 401 属于表单错误，必须留在表单内，
  判定按错误 code 而不是 status。
- 详情页 loading/error 复用 `components/business/detail-state.tsx` 的
  `DetailSkeleton` / `DetailError`，错误行显示 `ApiError.code: message`。

Overview 的 Bot status 卡片显示当前 `sleeping`/`awake`、`sleep_until`，睡眠时提供带确认的 `Wake now` 操作，并显示所有 `chat_pause` Chat 的名称或 Telegram ID 与暂停时间。

Settings 页有一张 `Configuration file` 卡片：显示 generation、active hash 与 file hash、待重启字段列表与 last error，并提供 `Apply config file` 按钮（调用 `POST /config/apply`），成功或失败后都刷新配置状态。

Models 页是 Provider 与模型的管理器：顶部 “In use” 面板显示文件里的 agent 模型、vision 模型与 “Thinking effort” 下拉框（只列 agent 模型接受的级别，改动走 `PUT /thinking-level` 热应用；切换 agent 模型后提示 “Thinking effort reset to …”）；下方左栏 Provider 列表（搜索、Agent/Vision 在用徽章、待重启徽章），右栏连接字段与模型列表。四个区域都是 `Panel`（In use、左栏、Connection、Models），列表项与表格都不再套自己的边框，保持「一个区域一个边框」。连接区里 builtin 只读展示 Pi 的供应商名与 baseUrl，custom 可编辑 `base_url` 与 `api`；API Key 与 header 值一律 `type="password"` 且没有查看按钮，提示 “Set - leave empty to keep it”；`base_url` 一改动，key 与所有 header 值立刻变成必填。模型区是一个 flush 面板：表格贴边、只保留标题下那条线，行内用图标标出 image / reasoning 能力（带 sr-only 文本），并显示 context / max output 与在用徽章，行末是 “Set as agent” “Set as vision” 与编辑 / 删除图标按钮。面板标题栏放 “Fetch models”（发现 + 元数据预览，待重启时改用临时模式并要求再填一次 key）与 “Add by id”；编辑弹窗里元数据字段带来源标签与匹配来源；勾选 reasoning 后出现 thinking levels 复选框，全部不勾即沿用 Pi 默认；compat 三态放在折叠的 “Advanced” 区，只显示当前 API 适用的字段。草稿行对推理模型多显示一项 “thinking”（级别列表或 “Pi default”）。带 “N to confirm” 的草稿不能直接提交：字段齐全的可以用 “Accept listed values (N)” 一次接受列表里显示的值，有空缺的必须进编辑弹窗填写。有待重启字段时页面顶部出现横幅与 “Restart now” 按钮（部署方未声明进程监督时隐藏），点击后界面会断开并轮询等待服务恢复。保存反馈区分 “Applied” 与 “Saved, restart required”。界面文案全部是英文，与面板其它页面一致。

Tool session 详情默认打开 Overview 时间线：按时间合并冻结消息、Invocation 生命周期、Model Call、Tool Call 与 Agent transcript；消息正文和 `send` 参数中的发送内容直接展示，Tool 结果与完整参数按需展开。失败的 Model Call 同时展示稳定错误码，并可展开查看经密钥脱敏的完整 Provider 错误详情。Assistant 文本显式标注为私有推理，只有 `send` Tool 会发往 Telegram。

## 数据表

迁移 `src/store/migrations/003_admin.sql`：

| 表 | 用途 |
| --- | --- |
| `admin_users` | 用户名、Argon2id hash、创建/更新/最近登录时间 |
| `admin_sessions` | Token SHA-256 摘要、所属用户、创建/过期/最近活动时间 |

`admin_sessions.user_id` 级联删除；`admin_sessions_expiry_idx` 支撑过期清理。两张表不参与 `purgeExpiredData` 的在线保留窗口（`retention.online_days`）——管理员账号不是会话数据。

Bot 管理员列表（迁移 `src/store/migrations/008_bot_admins.sql`）：

| 表 | 用途 |
| --- | --- |
| `bot_admins` | Telegram 用户 ID（主键）、显示名、来源（`config`/`admin-panel`/`telegram`）、添加时间 |

`telegram.admins` 配置项在启动时以 `INSERT ... ON CONFLICT DO NOTHING` 播种，只增不减，来源记为 `config`；面板添加管理员时来源记为 `admin-panel`。管理员本人执行命令时只刷新 `display_name`（`ON CONFLICT DO UPDATE`），不改写 `added_by` 来源。Bot 管理员决定谁能执行 `/pause`、`/resume`、`/model` 与 `/cut_topic`，与面板登录账号无关。

## 验证

测试命令、覆盖契约与浏览器冒烟清单见 [verification.md](verification.md) 的「静态与单元验证」「Admin Panel 冒烟」与「Admin Panel 浏览器 E2E」三节。
