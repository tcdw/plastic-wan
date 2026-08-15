# 配置

Plastic Wan 使用严格 TOML 配置。Schema 位于 `src/config.ts`，未知字段会被拒绝；除类型校验外，还会验证时区、ID 唯一性、模型引用、URL 和预算关系。

## 加载语义

- CLI 必须显式传入 `--config <path>`。
- 配置在 `serve` 启动时读取一次，不支持热重载。
- 配置哈希是原始 TOML 文本的 SHA-256，写入 Invocation 并打印在 `serve_started` 日志中。
- 修改 allowlist、Provider、Prompt、Sticker Set 或 MCP 后必须重启。
- 相对 `data_dir`/`paths` 按服务当前工作目录解释；systemd 固定在 `/opt/plasticwan`。
- 非 Windows 系统要求配置文件 `0600`、父目录 `0700`。

验证命令：

```bash
bun run src/cli.ts check-config --config dev-data/config.toml
```

## SecretRef

Telegram Token、Provider API key、MCP Header/环境变量都使用同一 SecretRef：

```toml
# 字面量：仅适合已 gitignore 且权限受限的本地文件
token = "literal-secret"

# 环境变量：推荐
api_key = { env = "GOOGLE_API_KEY" }

# 固定 argv 的外部命令
api_key = { command = ["secret-tool", "lookup", "service", "plasticwan"] }
```

command SecretRef：

- 不经过 shell，只执行配置中的 argv。
- 最长 5 秒。
- stdout 最大 4096 bytes，只移除一个末尾换行。
- 子进程只继承最小环境变量集合。
- 已解析 Secret 会在向用户报告错误前脱敏。

不要把真实 Token/API key 写进文档、测试、日志或提交。

## 顶层结构

| Section | 用途 |
| --- | --- |
| `version` | 当前只接受 `1` |
| `data_dir` | Serve lock 与运行数据根目录 |
| `timezone` | 默认 IANA 时区 |
| `telegram` | Token、Chat/Topic allowlist、Sticker Set |
| `providers` | 内置或自定义 Provider 别名 |
| `agent` | 对话模型、Prompt、轮次、超时和并发 |
| `vision` | 图片模型、并发、Prompt 版本和预算 |
| `mcp` | 可选的 stdio/Streamable HTTP Server |
| `retention` | 在线保留天数与备份份数 |
| `paths` | SQLite、媒体缓存和备份目录 |

## Telegram Chat 与 Topic

```toml
[telegram]
token = { env = "TELEGRAM_BOT_TOKEN" }
process_bot_messages = false

[[telegram.chats]]
id = -1001234567890
instructions = "群聊中只在有明确价值时参与。"
timezone = "Asia/Shanghai"
topic_ids = [100, 200]
budget = { max_invocations_per_day = 100, max_tokens_per_day = 300000 }
```

规则：

- Chat ID 必须是非零安全整数且不可重复。
- 未配置 `topic_ids`：允许该 Chat 的普通消息与所有 Topic。
- 配置 `topic_ids`：只允许列出的正整数 Topic ID；未列出的 Topic 被审计为拒绝。
- Forum Topic 按 `(chat_id, message_thread_id)` 隔离 Conversation。
- `instructions` 进入该 Chat 的系统提示，不提供额外授权。
- 修改 Chat 后重启，并比较 `check-config` 与 `serve_started` 的 `config_hash`。

## Sticker Set

```toml
[[telegram.sticker_sets]]
alias = "cats"
name = "TelegramStickerSetName"
```

- `alias` 是模型搜索/发送使用的稳定名称。
- `name` 是 Telegram Sticker Set 名称。
- 只允许发送配置中的 Set。
- Set 在启动时同步，后台以单并发建立视觉索引。

## Provider

内置 Provider 复用 Pi AI 的模型目录：

```toml
[providers.google]
kind = "builtin"
provider = "google"
api_key = { env = "GOOGLE_API_KEY" }

[agent]
provider = "google"
model = "gemini-3.7-flash"
```

自定义 Provider 必须显式声明 API 兼容层和模型元数据：

```toml
[providers.gateway]
kind = "custom"
base_url = "https://example.invalid/v1"
api = "openai-responses"
api_key = { env = "GATEWAY_API_KEY" }

[[providers.gateway.models]]
id = "model-id"
reasoning = true
input = ["text", "image"]
context_window = 128000
max_tokens = 8192
cost = { input = 0, output = 0, cache_read = 0, cache_write = 0 }
```

可用 `api`：`openai-responses`、`openai-completions`、`anthropic-messages`。`agent` 模型必须支持 text；`vision` 模型必须支持 image；配置输出上限不能超过注册模型上限。

## Agent 与 Vision

`agent` 约束：

- `max_turns`: 1–8。
- `max_tool_calls`: 1–12。
- `max_sends`: 1–6。
- `timeout_seconds`: 大于 0 且不超过 90 秒。
- `context_stop_ratio`: 大于 0 且不超过 0.8。
- `history_messages`: 1–20。
- `thinking_level`: `off|minimal|low|medium|high|xhigh`；Provider 仍可能限制具体模型支持级别。

`vision` 约束：

- 独立 Provider/Model 与输出上限。
- 用户图片并发由 `max_concurrency` 控制。
- `background_sticker_concurrency` 当前必须为 `1`。
- `prompt_version` 参与视觉缓存版本；改变描述规则时递增。
- `daily_budget` 同时限制 Token 和图片数。

## MCP

支持两种 transport：

```toml
[[mcp.servers]]
alias = "search"
transport = "stdio"
command = ["node", "server.js"]
required = false
tools = ["search"]
payload_max_bytes = 32768
result_max_bytes = 32768

[mcp.servers.default_tool_policy]
read_only = true
timeout_seconds = 20
per_chat_daily_calls = 20
global_daily_calls = 200
```

Streamable HTTP 使用 `url` 与可选 SecretRef `headers`，且 `follow_redirects` 必须为 `false`。每个 Tool 使用显式策略或 `default_tool_policy`；没有策略的 Tool 不会暴露给模型。`required = true` 的 Server 启动失败会阻止 `serve`/`doctor` 成功。
