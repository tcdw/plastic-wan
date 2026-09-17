# 数据层

Plastic Wan 使用单个 SQLite 数据库保存消息、调度状态、能力索引、预算与审计。数据库不是长期记忆；在线保留窗口由必填的 `retention.online_days` 指定。

## 打开与迁移

`SqliteStore.open` 使用 better-sqlite3，并启用：

- `strict: true`
- `safeIntegers: true`
- WAL journal
- `synchronous = FULL`
- foreign keys
- 5 秒 busy timeout

迁移文件位于 `src/store/migrations/`，文件名为 `NNN_name.sql`，按编号排序。每个迁移在 IMMEDIATE transaction 中执行并记录到 `schema_migrations`。已有数据库存在待执行迁移时，先在备份目录创建 `pre-migration-*.sqlite`。

新增迁移时：

1. 创建下一个连续编号文件。
2. 使用 SQLite STRICT 表和显式 CHECK/FOREIGN KEY。
3. 不修改已发布迁移。
4. 更新依赖新字段的查询与测试。
5. 验证从空数据库和旧版本数据库升级。

## 查询层（Drizzle）

业务查询统一走 `SqliteStore.orm`（Drizzle `better-sqlite3` 驱动的同步 API；依赖版本见 [package.json](../package.json) 与 [pnpm-lock.yaml](../pnpm-lock.yaml)）；`store.db` 仅供连接层自身（迁移、备份、`VACUUM INTO`）、`doctor.ts` 探针与测试验证断言使用。表定义在 [src/store/schema.ts](../src/store/schema.ts)，是迁移终态的类型化映射——新增迁移必须同步更新它。

约定：

- 只用同步方法 `.all()/.get()/.run()/.values()`；禁止 `await orm...`（better-sqlite3 事务回调是同步的）。
- 事务：模块持有 `SqliteStore` 时用 `store.transaction(fn)`（IMMEDIATE）；仅持有 `Orm` 时用 `orm.transaction(fn, { behavior: 'immediate' })`。
- SQLite dialect 没有 bigint 列模式：ID/计数值列用 `sqliteBigInt`（customType，读写 `bigint`），自增主键用 `sqliteBigIntId`（insert 可省略 id，新 id 用 `.returning({ id }).get()`）；0/1 标志列用 `integer(..., { mode: 'boolean' })`。
- 该驱动把 `.run()` 的类型标为 `void`（运行时返回 `{ changes, lastInsertRowid }`）；需要 `changes` 时用 `asRunResult`（`database.ts`）。
- 复杂 SQL（多表 JOIN、子查询、`NOT EXISTS`、`COALESCE`、FTS5 `MATCH`/`bm25()`、动态拼列）保留 `sql` 模板：`orm.all<Row>(sql\`...\`)`；`${}` 一律是绑定参数（禁止拼 SQL 字符串；受控常量片段用 `sql.raw`）。FTS5 虚拟表 `sticker_search` 不进 schema，只能走 `sql` 模板。
- 驱动陷阱：`orm.get(sql\`...\`)` 对裸 SQL 返回列值数组而非对象——单行裸 SQL 用 `.all<Row>(sql\`...\`).at(0)` 判 `undefined`。
- 关闭连接时使用 `Database.close(true)`，立即释放 Drizzle 通过 `.prepare()` 创建的未缓存语句及文件句柄；默认 `close()` 可能延迟到语句被 GC 回收后才释放文件，导致 Windows 上备份后的临时数据库无法删除。`SqliteStore.close()`、初始化失败清理及备份连接清理都采用严格关闭，关闭后不得继续使用已创建的 ORM 查询。
- 测试中的裸 SQL 审计断言保留原样：验证层独立于被验证的实现是本仓库的测试惯例。

## 表组

表与列定义见 [src/store/schema.ts](../src/store/schema.ts) 和 [迁移目录](../src/store/migrations/)，不在文档维护表数量或字段类型副本；类型、可空性与 CHECK 约束以 schema、迁移与源码为准。下面只记录 schema 读不出来的语义。

### 冻结与重放边界

`invocation_messages` 是可重放边界，保存 `history`/`new` 两个区段的 Message Revision 快照；长生命周期 Invocation 的多个批次按 `source_bucket_id` 追加进同一个 Invocation（`sequence_no` 在 Invocation 内保持单调）。消息在 Invocation 创建后被编辑只影响未来 Context，不改写已经冻结的快照。`buckets` 区分 `realtime`（配置长度窗口）与 `startup_catch_up`（启动追赶）两种来源，状态机相同。`agent_messages` 是**按 Invocation 展开的扁平审计轨迹**（人类可读的 `assistant`/`tool_result`/`harness_nudge` 文本行），完整可重放的 transcript 属于 Conversation，见下一节——**Assistant 文本不等于 Telegram 发送**，真正发出去的只有 `telegram_sends` 里的行。

### Conversation Context（长期会话 transcript）

`conversation_contexts` + `context_messages` 是 Agent 的**规范 transcript**：粒度是 Conversation（Chat + Forum Topic），跨 Invocation、跨进程重启长期存在。内存里的 Pi agent 只是可丢弃的缓存，缓存被 LRU 逐出或进程重启后都从这里重新播种。

- `conversation_contexts.conversation_id` 带 UNIQUE 约束：**每个 Conversation 至多一行 context**。
- 保留窗口是半开区间 `[head_seq, next_seq)`：`next_seq` 是下一个空位，`head_seq` 是第一条保留行；`context_messages` 以 `(context_id, seq)` 为主键，`seq` 只增不减，被丢弃的行不从编号里移除。
- `send_count_total` 是该 context 累计的成功 `send` 次数，跨 Invocation 累计，`head_seq` 前移时不清零。
- `system_prompt_hash` 是稳定系统提示的 SHA-256。打开 context 时 hash 不一致按「重建」处理：删除该 context 的全部 `context_messages` 与 `context_refs`，`head_seq`/`next_seq` 复位为 1、`send_count_total` 归零、`active_invocation_id` 清空。
- `active_invocation_id` 指向当前拥有该 context 的 running Invocation，运行结束时清空；Invocation 行本身被清理时置 `NULL`。
- `last_active_at` 在每次追加行与 `touch`（Invocation 开始/结束）时刷新，是保留清理判定「空闲 Conversation」的依据；`last_gc_at` 记录最近一次 GC 时间。
- `context_messages.payload_json` 保存**完整 AgentMessage JSON**（含 thinking 与 tool call 结构），可以直接解码重放，而不是从文本反推；`role` 只有 `user`/`assistant`/`toolResult`。
- `agent_messages` 与 `context_messages` 的分工：前者是审计轨迹（每 Invocation 扁平展开、人可读、把 harness 提醒单独标成 `harness_nudge`），后者是重放来源（完整结构与 thinking、按 Conversation 长期保留）；两者都由 `agent-runtime` 写入，互不替代。
- `is_checkpoint` 标记一条注入批次的首条 user 消息；GC 只会把 `head_seq` 推到 checkpoint 行上。
- `send_seq` 只在「成功 `send` 的 toolResult」行上非空，值等于写入时的 `send_count_total + 1`；GC 用它统计保留窗内还剩几次发送。
- `est_tokens` 是逐行 Token 估算，供 GC 与收尾判定使用，不是精确计数。
- `evicted_at` 是软删除标记：GC 不立即物理删除行，只打标记；行保留到在线窗口之后才由 `purgeExpiredData` 真正删除（见「保留清理」）。
- `invocation_id` 记录写入该行的 Invocation，Invocation 被清理时置 `NULL`，历史行本身不随之删除。

写路径只有一处：`advanceHead` 把 `head_seq` 前移时，在同一事务里软标记被丢弃的行、删除这些行携带的 `context_refs`、更新 `head_seq` 与 `last_gc_at`。GC 是**纯丢弃，从不做摘要**：`planContextGc` 决定新起点（默认跳到「仍保留至少 `retained_sends_target` 次发送」的最新 checkpoint，发送稀疏但 Token 压力大的历史退回 Token 预算判定），保留段还必须通过 `isRenderable` 结构检查（不得以 `toolResult` 开头，每个 tool result 都要有对应的 assistant tool call），否则这一轮不裁剪。

`context_refs` 是**按 Conversation Context 记账的能力引用**，取代了原来按 Invocation 记账的引用：

- `kind` 为 `media`/`sticker`/`reply`，`ref` 分别是 `img_<uuid>`、`stk_<uuid>`、`reply:<telegram_message_id>`；对应 payload 落在 `media_id` / `sticker_file_id` / `target_conversation_id` + `target_thread_id`。
- 授权规则只有一条：`source_seq >= head_seq` 且 `expires_at > now`。`source_seq` 是携带该引用的 context 行，该行被 GC 逐出后引用立即失效，不需要额外的撤销步骤。
- 查询始终带 `context_id`，因此**引用永不跨 Conversation 解析**：另一个 Chat/Topic 的引用即使格式相同也解析不出来。
- `expires_at = 写入时刻 + agent.context.ref_ttl_hours`（reply 引用每次重新注册都会续期）；同一 (context, media) 在未过期时复用同一条 `ref`，避免前缀抖动。

`invocation_buckets` 是 Bucket 到 Invocation 的 join 表：长生命周期的 Invocation 会消费多个 Bucket，`invocations.bucket_id` 只保留「开场 Bucket」这一历史字段。

- 主键 `(invocation_id, bucket_id)`，`attached_at` 是挂载时间。
- `injected_at` 为 `NULL` 表示「已挂到该 Invocation，但还没进入模型 transcript」。Invocation 结束时 `releaseUninjectedBuckets` 把这些 Bucket（开场 Bucket 除外）重新排队成新的 Invocation，批次不会被静默丢弃。
- Bucket 终态与重启恢复按 join 表判断：Invocation 结束时把它名下的所有 running Bucket 一起置为同一终态，进程重启时也只把这些 Bucket 标成 `aborted`/`outcome_unknown`。

`/status` 命令与 Admin Panel 的 `contexts` 接口只读展示 `head_seq`/`next_seq`/`send_count_total`、保留消息数与最近 GC 时间，不写入该表组。

### 隐藏工作上下文

`internal_contexts` 保存同一 Conversation 中先前 Tool 结果产生的隐藏观察。当前实现由 `list_alarm` 持久化 `alarm_list`/`v1`，payload 内含稳定 `kind` discriminator、`version`、`observed_at` 与有序 `items`（`id`/`scheduled_at`/`summary`），并通过 `source_agent_message_id` 关联产生该观察的内部 transcript 行。

### Alarm owner

`alarms.created_by_user_id` 是可信 owner：新建 alarm 时由应用从冻结 invocation 的最新 `new` user sender 写入。迁移历史行允许为 `NULL`，这些旧行不会被用户 list/delete，也不会把 target 冒充 creator 回填。

### 短期记忆

`memories` 由 Agent 通过 `add_memory`/`delete_memory` 维护，也可在 Admin Panel 手工增删改查：

- 每条记忆归属一个 `conversations` 行（Chat + Forum Topic 隔离，互不可见）。
- `content` 硬限制 150 字符（SQLite `CHECK` 兜底；Tool Schema 与 Admin API 先校验）。
- `expires_at` 由 `created_at + ttl_seconds` 决定，默认 TTL 1 天；过期行在每次写操作机会性清除，`purgeExpiredData` 也会清除。
- 系统不禁止长 TTL；剩余寿命超过 `agent.memory_ttl_warning_days`（默认 30 天）的记忆在 Admin Panel 显示 warning，由管理员决定保留、删除或提升进 `agents.md`。

### 注意力窗口

`conversation_attention` 每个 Conversation 至多一行，记录 `expires_at`、命中的 `trigger_kind`（`mention`/`reply_to_bot`/`keyword`）与触发消息的 Telegram message ID。它只回答「这个会话现在算不算活跃」：行过期即无意义，读路径只比较 `expires_at > now` 且从不惰性删除，清理交给 `purgeExpiredData`。窗口要跨进程重启保持，因此放在 SQLite 而不是内存。

### 工具可见性审计

`invocations.tool_registry_hash` 之外还有 `tool_registry_json`：本次 Invocation 实际展示给模型的完整工具快照（`name`/`label`/`description`）；hash 覆盖名称、描述和参数 Schema，Tool 使用策略变化也会产生新 hash。`model_calls.tools_json` 记录该次请求真正附带的工具名数组——Agent 循环在 context 接近上限时会把工具裁剪到 `send` 和当时可用的 `zzz`，因此同一 Invocation 内不同请求的工具列表可能不同；这两列共同回答“模型当时能看到哪些工具”。

`model_calls.request_json` 保存 Provider 请求审计快照，但不会复制 `data:image/*;base64,...` 图片正文；对应字符串会替换为包含 MIME、Base64 字符数、解码字节数与 SHA-256 的结构化摘要，真实 Provider 请求不受影响。`side_effect_started` 和 `outcome_unknown` 用于阻止不可逆 Tool 的盲目重试。审计记录应保留稳定错误码；不要依赖解析自由文本错误。

### 媒体与 Sticker 缓存

`media_analyses` 按 `file_unique_id + analysis_version` 缓存视觉结果。Sticker 分析在 Set 仍受配置允许时可长期保留；普通图片分析按在线保留窗口清理。`vision.prompt_version`、Provider 和 Model 都参与分析版本，避免不同规则错误复用缓存。FTS5 虚拟表 `sticker_search` 不进 Drizzle schema，只能走 `sql` 模板。

### 每日用量

`daily_usage` 只保留 Token 计量：`scope = 'chat'` / `metric = 'model_tokens'` 按 Chat 归属记录 Agent 与聊天触发 `read_image` 的 Token（全局求和后与 `agent.daily_budget.max_tokens` 比较），`scope = 'system'` / `resource = 'sticker_index'` 的 `vision_images`、`vision_tokens` 服务于后台 Sticker 索引的 `vision.daily_budget`。Chat 每日 Invocation 数与 MCP 每日调用数已经取消，不再有对应的 metric；Admin Panel 的 Invocation 与 Tool call 曲线直接 `COUNT` `invocations` 与 `tool_calls`，因此覆盖全部 Tool 而不只是 MCP。

### MCP 与 Admin

MCP 只有 `mcp_server_state` 一张自己的表（Server 状态、Tool registry hash、重连次数、错误码）；Tool 调用复用 `tool_calls`，没有自己的调用配额。

Admin 侧的 `admin_users`/`admin_sessions`/`bot_admins` 语义见 [admin-panel.md](admin-panel.md#数据表)。密码明文和 Session Token 原文都不入库；`admin_users` 与 `admin_sessions` 不参与在线保留清理（管理员账号不是会话数据），过期 Session 由 `AdminAuth` 在认证、新建 Session 和服务启动时删除。`chat_pause` 记录 `/pause` 暂停的 Chat，`chat_context_cutoffs` 记录 `/cut_topic` 的每 Chat 上下文切点（Telegram message ID）：切点同时决定新批次 history 的下界，并在同一步中断该 Conversation 正在运行的 Invocation、清空被切 Topic 的 Conversation Context（保留行打上 `evicted_at`、删除其 `context_refs`、`head_seq` 推到 `next_seq`），否则切点只会裁掉渲染用的 history，模型仍然能从 transcript 里看到全部旧消息。`evicted_at` 是保留窗口的权威条件之一：读取一律附带 `evicted_at IS NULL`，这样运行中的 Invocation 持有的陈旧 `head_seq` 也无法把淘汰行读回来。

## ID 与 JSON 规则

- SQLite 整数 ID 在 TypeScript 中使用 `bigint`。
- Telegram Chat/Message ID 进入 JSON 快照时字符串化，避免超出 JavaScript 安全整数。
- 原始 Update 不整体永久保存；只保存需要审计和重放的受限片段。
- 读取 `snapshot_json`、`telegram_json`、`metadata_json` 时必须在使用前校验结构。

## 保留清理

`backup` 在备份前调用 `purgeExpiredData`。清理仅删除已完成终态和不再被活跃引用的数据：

- 已过期的 `memories`（按自身 TTL，不参与在线保留窗口）。
- 已过期的 `conversation_attention` 注意力窗口行（窗口过期即无意义，不参与在线保留窗口）。
- 过期 Telegram Update 与终态 Invocation/Send/Bucket。
- 不再被 Invocation/Bucket 引用的旧 Message。
- 仍被快照引用的旧 Message 保留身份，但匿名化 Revision 文本、Sender、Reply/Forward 和 Service 内容。
- 删除无引用 Sender、过期普通图片分析、独立 Doctor 模型调用与旧 `daily_usage` 日期。
- Sticker 长期视觉索引不按普通图片策略删除。
- `alarms` 的 `pending`/`firing` 行保留（未来仍需执行）；`fired`/`cancelled` 终态行随在线审计窗口清理。
- `internal_contexts` 不是长期 memory，也不单独配置 TTL；它随在线会话窗口清理，默认保留到 `created_at < now - retention.online_days` 时删除。
- `context_refs` 中 `expires_at <= now` 的行（TTL 到期即删，与在线保留窗口无关）。
- `context_messages` 中已软标记 `evicted_at` 且早于在线窗口的行；软标记本身保留一个在线窗口，便于审计 GC 丢掉了什么。
- `last_active_at` 早于在线窗口的 `conversation_contexts`，连带级联删除其 `context_messages` 与 `context_refs`；空闲 Conversation 的长期 transcript 因此不会无限增长。
- `invocation_buckets` 没有独立清理规则，随 `invocations`/`buckets` 的删除级联消失。

不要把 `DELETE FROM messages WHERE received_at < ...` 当作等价实现；外键和冻结快照要求分阶段清理。

## 备份

```bash
node src/cli.ts backup --config dev-data/config.jsonc
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
