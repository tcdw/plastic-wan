# 配置

Plastic Wan 使用严格 JSONC 配置。Schema 位于 `src/config.ts`，未知字段会被拒绝；除类型校验外，还会验证时区、ID 唯一性、模型引用、URL 和预算关系。

## 加载语义

- CLI 必须显式传入 `--config <path>`。
- 配置在 `serve` 启动时读取一次，不支持热重载。
- 配置哈希是原始 JSONC 文本与所有 Prompt 文件内容的 SHA-256，写入 Invocation 并打印在 `serve_started` 日志中。
- 修改 allowlist、Bucket 窗口、Provider、Prompt、Sticker Set 或 MCP 后必须重启。
- 相对 `data_dir`/`paths` 按服务当前工作目录解释；systemd 固定在 `/opt/plasticwan`。
- Prompt 文件路径（`system_prompt_file`、`instructions_file`）相对于配置文件所在目录解释；修改文件内容同样会改变 `config_hash`。
- 非 Windows 系统要求配置文件 `0600`、父目录 `0700`。

验证命令：

```bash
bun run src/cli.ts check-config --config dev-data/config.jsonc
```

## SecretRef

Telegram Token、Provider API key、MCP Header/环境变量都使用同一 SecretRef：

```jsonc
[
  // 字面量：仅适合已 gitignore 且权限受限的本地文件
  "literal-secret",
  // 环境变量：推荐
  { "env": "GOOGLE_API_KEY" },
  // 固定 argv 的外部命令
  { "command": ["secret-tool", "lookup", "service", "plasticwan"] },
]
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
| `telegram` | Token、Bucket 窗口、Chat/Topic allowlist、Sticker Set |
| `providers` | 内置或自定义 Provider 别名 |
| `agent` | 对话模型、Prompt、轮次、超时、并发和全局 Token 预算 |
| `vision` | Sticker 视觉模型、并发、Prompt 版本和预算 |
| `mcp` | 可选的 stdio/Streamable HTTP Server |
| `admin` | 可选的本地只读 Admin Panel |
| `retention` | 在线保留天数与备份份数 |
| `paths` | SQLite、媒体缓存和备份目录 |

## Telegram Chat 与 Topic

```jsonc
{
  "telegram": {
    "token": { "env": "TELEGRAM_BOT_TOKEN" },
    "process_bot_messages": false,
    "bucket_window_seconds": 15,
    "chats": [
      {
        "id": -1001234567890,
        "instructions_file": "prompts/chat-1001234567890.md",
        "timezone": "Asia/Shanghai",
        "topic_ids": [100, 200],
        "budget": { "max_invocations_per_day": 100 },
      },
    ],
  },
}
```

规则：

- `bucket_window_seconds` 是全局 Agent 会话节拍，单位秒；接受 0–300 的整数，示例值为 15。`0` 表示有新消息时不额外延迟，但不会创建空会话。节拍按 Chat（群）计算：同一时刻每个群最多一个 Agent 会话，下一会话在前一会话开始满一个节拍、且前一会话结束后启动。
- 消息收集仍按 Conversation 隔离：Forum Topic 各自收集、Context 互不混入，只是 Agent 会话在群内串行。
- Chat ID 必须是非零安全整数且不可重复。
- 未配置 `topic_ids`：允许该 Chat 的普通消息与所有 Topic。
- 配置 `topic_ids`：只允许列出的正整数 Topic ID；未列出的 Topic 被审计为拒绝。
- Forum Topic 按 `(chat_id, message_thread_id)` 隔离 Conversation。
- `instructions_file`（可选）指向该 Chat 的附加系统提示 Markdown 文件，缺省时为空；提示内容不提供额外授权。
- 修改 Chat 后重启，并比较 `check-config` 与 `serve_started` 的 `config_hash`。
- `budget.max_invocations_per_day` 限制该 Chat 每日创建的 Invocation 数量；Chat 不设 Token 硬上限，Token 仅按 Chat 归属统计。

## Sticker Set

```jsonc
{
  "telegram": {
    "sticker_sets": [{ "alias": "cats", "name": "TelegramStickerSetName" }],
  },
}
```

- `alias` 是模型搜索/发送使用的稳定名称。
- `name` 是 Telegram Sticker Set 名称。
- 只允许发送配置中的 Set。
- Set 在启动时同步，后台以单并发建立视觉索引。

## Provider

内置 Provider 复用 Pi AI 的模型目录：

```jsonc
{
  "providers": {
    "google": {
      "kind": "builtin",
      "provider": "google",
      "api_key": { "env": "GOOGLE_API_KEY" },
    },
  },
  "agent": {
    "provider": "google",
    "model": "gemini-3.7-flash",
  },
}
```

自定义 Provider 必须显式声明 API 兼容层和模型元数据：

```jsonc
{
  "providers": {
    "gateway": {
      "kind": "custom",
      "base_url": "https://example.invalid/v1",
      "api": "openai-responses",
      "api_key": { "env": "GATEWAY_API_KEY" },
      "models": [
        {
          "id": "model-id",
          "reasoning": true,
          "compat": { "supports_developer_role": false },
          "input": ["text", "image"],
          "context_window": 128000,
          "max_tokens": 8192,
          "cost": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 },
        },
      ],
    },
  },
}
```

可用 `api`：`openai-responses`、`openai-completions`、`anthropic-messages`。`agent` 模型必须支持 text；若同时支持 image，用户 Photo/图片 Document 直接作为多模态输入，否则保留为 `read_image` capability 并由独立 `vision` 模型按需解析。`vision` 模型必须支持 image，也负责 Sticker 的按需理解与后台索引；配置输出上限不能超过注册模型上限。

`compat.supports_developer_role` 覆盖 Pi AI 对 OpenAI 兼容接口的自动检测。仅接受 `system`、`assistant`、`user`、`tool` 角色的接口必须设为 `false`；省略时继续自动检测。该字段仅适用于 `openai-responses` 和 `openai-completions`。

`configure` 向导可使用已配置的 `api_key` 与附加 Header 请求 `${base_url}/models`，再按关键词筛选并选择返回的模型 ID。该响应只用于发现可路由的 ID；`reasoning`、输入能力、上下文、输出上限与费用仍由 models.dev 或管理员确认后写入。

## Agent 与 Vision

- `daily_budget.max_tokens`: 主 Agent 与聊天触发的 `read_image` 共享的全局每日 Token 上限；各 Chat 用量仍分别写入 `daily_usage`。
- `system_prompt_file`: 指向全局系统提示的 Markdown 文件，路径相对配置文件目录，内容必须非空。系统提示和 Chat 的 `instructions_file` 支持 `{{ agent.provider }}`、`{{ agent.model }}`、`{{ vision.provider }}`、`{{ vision.model }}`、`{{ timezone }}` 模板变量；模板只执行严格白名单替换，未知或格式错误的表达式会拒绝配置。
- 模板中的 `agent.provider` 与 `agent.model` 是当前 Invocation 实际使用的模型，因此 Admin Panel 或 `/model` 的运行时切换会反映到下一次会话；`vision.*` 始终来自配置。模板值只注入 Prompt，不会注入记忆；记忆内容按原文保留。
- `max_turns`: 1–8。
- `max_tool_calls`: 1–12。
- `max_sends`: 1–6。
- `timeout_seconds`: 大于 0 且不超过 90 秒。
- `context_stop_ratio`: 大于 0 且不超过 0.8。
- `history_messages`: 1–20。
- `memory_ttl_warning_days`（可选，默认 30）：Agent 记忆剩余寿命超过该天数时，Admin Panel 显示 warning，提示管理员判断保留、删除或提升进 `agents.md`。系统不禁止长 TTL。
- `send_nudge_enabled`（可选，默认 `false`）：开启后，当 agent 即将自然停止、本轮未调用任何工具且产生了足够长的普通 Assistant 文本，又从未调用过 `send` 时，注入一条 harness 级 user 消息提醒其用 `send` 发送面向群聊的文本。每次 Invocation 至多触发一次；触发与提醒文本记录在 `agent_messages` 中，role 为 `harness_nudge`。用于稳定性不足、偶尔把回复写成私文本却忘记调用 `send` 的模型。
- `thinking_level`: `off|minimal|low|medium|high|xhigh`；Provider 仍可能限制具体模型支持级别。

Agent 不再配置 `max_output_tokens`：每次请求的输出上限直接使用目标模型在 provider 中声明的 `max_tokens`。Provider 注册的模型必须满足 `max_tokens ≤ context_window`，且 agent 模型必须支持 text。

运行时热切换：Admin Panel「Model」页面（`GET/PUT/DELETE /api/model`）可在已配置的 provider/模型之间切换 agent 模型。切换是内存态，立即对后续启动的 agent session（Invocation）生效，不影响进行中的会话；重启 `serve` 后恢复 `config.jsonc` 的默认值。`/status` 命令展示当前生效模型。

`vision` 约束：

- 独立 Provider/Model 与输出上限，用于 text-only Agent 的普通图片回退和 Sticker 分析。
- 前台 `read_image` 并发由 `max_concurrency` 控制。
- `background_sticker_concurrency` 当前必须为 `1`。
- `prompt_version` 参与视觉缓存版本；改变描述规则时递增。
- `daily_budget` 同时限制 Token 和图片数。

## MCP

支持两种 transport：

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "search",
        "transport": "stdio",
        "command": ["node", "server.js"],
        "required": false,
        "tools": ["search"],
        "payload_max_bytes": 32768,
        "result_max_bytes": 32768,
        "default_tool_policy": {
          "read_only": true,
          "timeout_seconds": 20,
          "per_chat_daily_calls": 20,
          "global_daily_calls": 200,
        },
      },
    ],
  },
}
```

Streamable HTTP 使用 `url` 与可选 SecretRef `headers`，且 `follow_redirects` 必须为 `false`。`url` 可以包含服务协议要求的查询参数，但禁止 URL userinfo 与 fragment；机密值应使用 SecretRef `headers`，不应写入查询参数。每个 Tool 使用显式策略或 `default_tool_policy`；没有策略的 Tool 不会暴露给模型。`required = true` 的 Server 启动失败会阻止 `serve`/`doctor` 成功。

## Admin Panel

```jsonc
{
  "admin": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8787,
    "session_ttl_hours": 168,
    "static_dir": "/opt/plasticwan/apps/admin/dist",
  },
}
```

- `enabled = false` 或省略整个 section 时 `serve` 不监听任何 HTTP 端口。
- `host` 只接受 `127.0.0.1`、`::1`、`localhost`；远程访问必须由反向代理承担 TLS 与网络暴露。
- `session_ttl_hours` 为 1–720，同时决定 Session 过期与 Cookie `Max-Age`。
- `static_dir` 可选，默认 `apps/admin/dist`；目录缺失时审计 API 仍可用，静态路由返回 503 `admin_bundle_missing`。

详细认证、API 与前端约定见 [admin-panel.md](admin-panel.md)。
