# 验证

本页记录 Plastic Wan 的验证层级。不要用单一 `bun test` 代替真实 Provider、Telegram 或媒体工具链验证，也不要把自然语言回复当作内部 Tool 成功证据。

## 静态与单元验证

```bash
bun run check
bun test
```

按改动范围可先运行目标测试：

```bash
bun test test/telegram-ingestion.test.ts
bun test test/scheduler.test.ts
bun test test/context-send.test.ts
bun test test/agent-runtime.test.ts
bun test test/media.test.ts test/stickers.test.ts
bun test test/mcp.test.ts
bun test test/operations.test.ts test/foundation.test.ts
```

| 测试 | 主要契约 |
| --- | --- |
| `foundation.test.ts` | 严格配置、Secret 脱敏、迁移与备份 |
| `telegram-ingestion.test.ts` | allowlist、Revision、Bot/Service、Topic 隔离 |
| `scheduler.test.ts` | 15 秒 deadline、冻结快照、恢复和合并 |
| `context-send.test.ts` | Context 可见性、Reply capability、发送次数与未知结果 |
| `agent-runtime.test.ts` | Fresh Agent、Tool 循环、预算和 transcript 隔离 |
| `media.test.ts` | 图片标准化、缓存和 Vision reasoning |
| `stickers.test.ts` | Set 同步、结构化视觉 Tool Call、索引、搜索、发送 |
| `mcp.test.ts` | stdio/HTTP transport、策略、预算、Header、重定向和审计 |
| `operations.test.ts` | Retention、备份轮换、Scheduler 关闭 |

跨模块改动完成后运行全部测试与 TypeScript 检查。

## 配置验证

```bash
bun run src/cli.ts check-config --config dev-data/config.toml
```

检查：

- 输出 `status = ok`。
- `config_hash` 与预期文件一致。
- Chat ID、Topic、Provider alias、Model ID 和 MCP Tool policy 未被错误引用。
- 配置改变后，不要继续使用旧进程的哈希。

## Doctor

```bash
bun run src/cli.ts doctor --config dev-data/config.toml
```

这是外部依赖冒烟，覆盖：

- SQLite/FTS/磁盘。
- Sharp、FFmpeg、FFprobe、python-lottie。
- Agent Provider 文本与严格 Tool Call。
- Vision 图片请求。
- Telegram Bot Token。
- required MCP。

Doctor 成功只证明连接与最小能力，不证明真实群聊调度、Reply、Sticker capability 或“不回复”行为。

## 本地服务冒烟

启动：

```bash
bun run src/cli.ts serve --config dev-data/config.toml
```

验证：

1. 出现一次 `serve_started`。
2. `bot_id` 与预期 Bot 一致。
3. `config_hash` 与 `check-config` 一致。
4. 运行 30 秒以上没有退出/重启。
5. `serve.lock` 阻止第二实例。
6. `Ctrl+C` 后 Scheduler、数据库和 lock 正常收尾。

长期进程必须用进程监督器或人工前台运行；不要让测试命令无限阻塞。

## 真实 Telegram 验收

### Chat 与参与策略

- 私聊发送普通消息：无需 mention，Bot 可积极回复。
- 群聊发送普通消息：无需 mention，Bot 能观察但允许保持沉默。
- 群聊 mention Bot：仍通过相同 15 秒 Bucket，不走特殊旁路。
- 未允许 Chat：`telegram_updates.allowed = 0`，原因是 `chat_not_allowed`。
- 新增 Chat 后未重启：旧进程仍拒绝；重启且哈希变化后允许。

### 时间窗口与 Revision

- 15 秒内连续发送多条：合并进一个 Bucket/Invocation。
- 第一条消息后继续发送：deadline 不滑动。
- deadline 前编辑：冻结新 Revision。
- deadline 后编辑：旧 Invocation 不变，未来 history 使用新 Revision。

### 输出与 Reply

- Bot 回复必须对应 `send` Tool Call 和 `telegram_sends` success。
- 普通 Assistant Message 不应直接出现在 Telegram。
- Reply 只能指向当前 Context 可见 Message。
- Agent 可以 completed 且 `sends_used = 0`，这是正常静默。

### 图片与 Sticker

- 发送图片并诱导读取：`read_image` success，普通图片缓存有过期时间。
- 发送从未分析的静态/视频/TGS Sticker：视觉分析成功并写结构化元数据。
- 再次发送同一 Sticker：命中 `file_unique_id + analysis_version` 缓存。
- Sticker 分析必须产生 `report_sticker_analysis` Tool Call；文本 JSON/code fence 不算成功。
- `search_stickers` 只返回允许 Set 中已索引 Sticker。
- `send` 不能使用模型虚构的 file ID。

### Forum Topic

- 允许 Topic：正常入库。
- 未允许 Topic：`topic_not_allowed`。
- 两个 Topic 的 Conversation、history、Bucket、Reply 和媒体 capability 不混合。

### MCP

仅在配置 MCP 时执行：

- required Server 失败会阻止启动。
- optional Server 失败进入 degraded，不伪装 ready。
- allowlisted Tool 可调用并审计。
- 未配置策略/超预算/超时/超大小结果被拒绝。
- Streamable HTTP 重定向被拒绝；静态 Header 生效且不进入日志。

## 审计验收

对一次真实交互至少核对：

```text
telegram_updates
  → messages/message_revisions/media
  → buckets/bucket_messages
  → invocations/invocation_messages
  → model_calls
  → tool_calls
  → telegram_sends 或 media_analyses
```

结论必须区分：

- Telegram 表面回复成功。
- Invocation 成功。
- 具体 Tool 成功。
- Vision/MCP 子调用成功。

曾出现“Bot 对 Sticker 给出自然回复，但 `read_image` 实际失败”的情况；只有审计链能识别这种降级。

## 备份与恢复验证

```bash
bun run src/cli.ts backup --config dev-data/config.toml
```

检查：

1. 生成新 `.sqlite`。
2. 数量不超过 `backup_copies`。
3. 对复制文件执行 `PRAGMA integrity_check` 返回 `ok`。
4. 在隔离目录使用备份启动或打开数据库。
5. 当前生产数据库、WAL、SHM 不被测试覆盖。

## 提交前检查

```bash
git diff --check
bun run check
bun test
```

最终报告应精确写明：

- 哪些命令通过。
- 哪些真实场景执行过。
- 哪些外部场景因 Token、Chat、Provider 或 MCP 不可用而未执行。
- 观察到的审计状态，而不是推测状态。
