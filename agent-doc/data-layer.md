# 数据层

Plastic Wan 使用单个 SQLite 数据库保存消息、调度状态、能力索引、预算与审计。数据库不是长期记忆；在线保留窗口由必填的 `retention.online_days` 指定（dev 示例为 30 天）。

## 打开与迁移

`SqliteStore.open` 使用 Bun SQLite，并启用：

- `strict: true`
- `safeIntegers: true`
- WAL journal
- `synchronous = FULL`
- foreign keys
- 5 秒 busy timeout

迁移文件位于 `src/migrations/`，文件名为 `NNN_name.sql`，按编号排序。每个迁移在 IMMEDIATE transaction 中执行并记录到 `schema_migrations`。已有数据库存在待执行迁移时，先在备份目录创建 `pre-migration-*.sqlite`。

新增迁移时：

1. 创建下一个连续编号文件。
2. 使用 SQLite STRICT 表和显式 CHECK/FOREIGN KEY。
3. 不修改已发布迁移。
4. 更新依赖新字段的查询与测试。
5. 验证从空数据库和旧版本数据库升级。

## 表组

### 配置与 Telegram 接入

| 表 | 用途 |
| --- | --- |
| `schema_migrations` | 已应用迁移版本 |
| `app_state` | 初始化标记等小型进程状态 |
| `telegram_updates` | 每个 Update 的 allow/reject 审计 |
| `chats` | Telegram Chat、canonical Chat 和类型 |
| `chat_migrations` | Supergroup 等 Chat ID 迁移映射 |
| `conversations` | `(chat, message_thread_id)` 对话隔离 |
| `senders` | user/sender_chat 去重身份 |
| `messages` | Telegram Message 稳定身份和当前 Revision |
| `message_revisions` | 文本、Caption、Reply、Forward、Service 与原始片段修订 |
| `media` | Revision 关联的 photo/document/sticker capability 来源 |

### 调度与上下文

| 表 | 用途 |
| --- | --- |
| `buckets` | `realtime` 配置长度窗口或 `startup_catch_up` 启动追赶任务及其状态机 |
| `bucket_messages` | Bucket 中消息的稳定顺序 |
| `invocations` | 一次 Agent 运行、配置哈希、计数和终态 |
| `invocation_messages` | 冻结的 `history`/`new` Message Revision 快照 |
| `agent_messages` | Agent 内部 transcript；Assistant 文本不等于 Telegram 发送 |
| `alarms` | Deferred Invocation：conversation、目标用户与显示名快照、summary、UTC deadline、生命周期状态、关联 Invocation 与取消审计 |

`invocation_messages` 是可重放边界。消息在 Invocation 创建后被编辑，只影响未来 Context，不改写已经冻结的快照。

### 短期记忆

| 表 | 用途 |
| --- | --- |
| `memories` | Conversation 级短期记忆：模型写入的内容、创建/过期时间 |

`memories` 由 Agent 通过 `add_memory`/`delete_memory` 维护，也可在 Admin Panel 手工增删改查：

- 每条记忆归属一个 `conversations` 行（Chat + Forum Topic 隔离，互不可见）。
- `content` 硬限制 150 字符（SQLite `CHECK` 兜底；Tool Schema 与 Admin API 先校验）。
- `expires_at` 由 `created_at + ttl_seconds` 决定，默认 TTL 1 天；过期行在每次写操作机会性清除，`purgeExpiredData` 也会清除。
- 系统不禁止长 TTL；剩余寿命超过 `agent.memory_ttl_warning_days`（默认 30 天）的记忆在 Admin Panel 显示 warning，由管理员决定保留、删除或提升进 `agents.md`。

### 模型、Tool 与发送审计

| 表 | 用途 |
| --- | --- |
| `model_calls` | Provider/Model、角色、Token、成本、耗时、错误码、经 `SecretStore` 脱敏的完整错误详情、请求/响应审计快照和每次请求附带的工具名（`tools_json`） |
| `tool_calls` | Tool 参数、结果、状态、副作用标记和错误码 |
| `telegram_sends` | 文本/Sticker 发送请求、Telegram 结果和未知结果 |
| `daily_usage` | Chat/全局资源预算计数 |

`invocations.tool_registry_hash` 之外还有 `tool_registry_json`：本次 Invocation 实际展示给模型的完整工具快照（`name`/`label`/`description`）。`model_calls.tools_json` 记录该次请求真正附带的工具名数组——Agent 循环在 context 接近上限时会把工具裁剪到只剩 `send`，因此同一 Invocation 内不同请求的工具列表可能不同；这两列共同回答“模型当时能看到哪些工具”。`model_calls.request_json` 保存 Provider 请求审计快照，但不会复制 `data:image/*;base64,...` 图片正文；对应字符串会替换为包含 MIME、Base64 字符数、解码字节数与 SHA-256 的结构化摘要，真实 Provider 请求不受影响。`side_effect_started` 和 `outcome_unknown` 用于阻止不可逆 Tool 的盲目重试。审计记录应保留稳定错误码；不要依赖解析自由文本错误。

### 媒体与 Sticker

| 表 | 用途 |
| --- | --- |
| `media_analyses` | `file_unique_id + analysis_version` 视觉缓存、状态和元数据 |
| `sticker_sets` | 配置允许的 Set 别名与同步状态 |
| `stickers` | Sticker 文件信息、索引状态、失败次数和重试时间 |
| `sticker_search` | FTS5 trigram 描述/标签索引 |

Sticker 分析在 Set 仍受配置允许时可长期保留；普通图片分析按在线保留窗口清理。`vision.prompt_version`、Provider 和 Model 参与分析版本，避免不同规则错误复用缓存。

### MCP

| 表 | 用途 |
| --- | --- |
| `mcp_server_state` | Server 状态、Tool registry hash、重连次数和错误码 |

MCP Tool 调用本身复用 `tool_calls`，预算复用 `daily_usage`。

### Admin Panel

| 表 | 用途 |
| --- | --- |
| `admin_users` | 用户名、Argon2id 密码 hash、创建/更新/最近登录时间 |
| `admin_sessions` | Session Token 的 SHA-256 摘要、所属用户、过期与最近活动时间 |
| `bot_admins` | Telegram User ID 形式的 Bot 管理员，可执行 `/pause`/`/resume`/`/model` |
| `chat_pause` | `/pause` 标记的暂停 Chat 与暂停时间 |
| `chat_context_cutoffs` | `/cut_topic` 记录的每 Chat 上下文切点（Telegram message ID），仅影响新 Invocation 的 history |

密码明文和 Session Token 原文都不入库。两张表不参与在线保留清理：管理员账号不是会话数据；过期 Session 由 `AdminAuth` 在认证、新建 Session 和服务启动时删除。

## ID 与 JSON 规则

- SQLite 整数 ID 在 TypeScript 中使用 `bigint`。
- Telegram Chat/Message ID 进入 JSON 快照时字符串化，避免超出 JavaScript 安全整数。
- 原始 Update 不整体永久保存；只保存需要审计和重放的受限片段。
- 读取 `snapshot_json`、`telegram_json`、`metadata_json` 时必须在使用前校验结构。

## 保留清理

`backup` 在备份前调用 `purgeExpiredData`。清理仅删除已完成终态和不再被活跃引用的数据：

- 已过期的 `memories`（按自身 TTL，不参与 30 天在线窗口）。
- 过期 Telegram Update 与终态 Invocation/Send/Bucket。
- 不再被 Invocation/Bucket 引用的旧 Message。
- 仍被快照引用的旧 Message 保留身份，但匿名化 Revision 文本、Sender、Reply/Forward 和 Service 内容。
- 删除无引用 Sender、过期普通图片分析、独立 Doctor 模型调用与旧预算日期。
- Sticker 长期视觉索引不按普通图片策略删除。
- `alarms` 的 `pending`/`firing` 行保留（未来仍需执行）；`fired`/`cancelled` 终态行随在线审计窗口清理。

不要把 `DELETE FROM messages WHERE received_at < ...` 当作等价实现；外键和冻结快照要求分阶段清理。

## 备份

```bash
bun run src/cli.ts backup --config dev-data/config.jsonc
```

流程：

1. 打开现有 SQLite 并启用与服务一致的 PRAGMA。
2. 执行保留清理。
3. 使用 `VACUUM INTO` 写入同目录临时文件。
4. 非 Windows 系统将临时文件设为 `0600`。
5. 原子 rename 为 `plasticwan-<timestamp>-<uuid>.sqlite`。
6. 按修改时间保留 `retention.backup_copies` 份。

systemd timer 每天 UTC 00:00 调用该命令。恢复或复制前应额外运行 `PRAGMA integrity_check`；当前备份命令不替代恢复演练。

## 本地路径

开发配置通常使用：

```text
dev-data/
├── config.jsonc
└── data/
    ├── plasticwan.sqlite
    ├── plasticwan.sqlite-wal
    ├── plasticwan.sqlite-shm
    ├── media/
    └── backups/
```

`dev-data/` 已 gitignore。不得提交数据库、WAL/SHM、媒体缓存、备份或真实配置。
