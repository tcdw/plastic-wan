# 配置

Plastic Wan 使用严格 JSONC 配置。Schema 位于 `src/platform/config.ts`，未知字段会被拒绝；除类型校验外，还会验证时区、ID 唯一性、模型引用、URL 和预算关系。

本页只记录 Schema 表达不出来的语义。每个字段的类型、取值范围和必填性以 `src/platform/config.ts` 的 TypeBox Schema 为准——越界值由 `check-config` 直接报出，不要靠文档抄写的数字判断。

## 加载语义

- CLI 必须显式传入 `--config <path>`。
- 配置在 `serve` 启动时读取一次；只有[运行时配置热更新](#运行时配置热更新)列出的白名单字段可以在运行中应用，其余字段修改后必须重启。
- 配置哈希是原始 JSONC 文本与所有 Prompt 文件内容的 SHA-256，写入 Invocation 并打印在 `serve_started` 日志中。
- 修改 allowlist、Bucket 窗口、Provider 连接字段、Sticker Set 或 MCP 后必须重启；Prompt 与 agent 模型等白名单字段可用 Admin「Apply config file」或 `/model` 热应用。
- 相对 `data_dir`/`paths` 按服务当前工作目录解释；Docker 镜像的工作目录是 `/app`。
- Prompt 文件路径（`system_prompt_file`、`instructions_file`）相对于配置文件所在目录解释；修改文件内容同样会改变 `config_hash`。
- Prompt 文件按原始字节参与哈希：剔除 HTML 注释只影响进入模型上下文的文本，纯注释改动仍然改变 `config_hash`。
- 非 Windows 系统要求配置文件 `0600`、父目录 `0700`。

验证命令：

```bash
node src/cli.ts check-config --config dev-data/config.jsonc
```

## 运行时配置热更新

`serve` 启动时读取一次配置，但白名单字段可以在运行中应用：Admin Panel 的「Apply config file」按钮（`POST /api/config/apply`）与 `/model`（`PUT /api/model`）都会重新读取 `config.jsonc` 并把白名单字段的变化发布到当前进程。没有文件系统 watcher——手改文件后必须在面板上点一次应用（或执行 `/model`）才生效。

热更新白名单（`src/platform/config-diff.ts` 是唯一定义处，未列出的字段一律按 restart 处理；新增字段默认 restart）：

| 路径 | 说明 |
| --- | --- |
| `agent.provider`、`agent.model` | 指向运行中已注册的 Provider 时热更新；指向本进程从未注册的 Provider 时两项都等重启 |
| `agent.system_prompt_file` | 路径或文件内容变化都算；内容变化会重建每个 Conversation 的 Context |
| 其余 agent 字段：`thinking_level`、`context_stop_ratio`、`send_max_text_length`、`send_disallow_blank_lines`、`send_nudge_enabled`、`daily_budget.max_tokens`、`max_concurrency`、`history_messages`、`context.max_wall_clock_seconds`、`context.idle_grace_seconds`、`rate_limits.*` | 下一次 Invocation 使用新值；运行中的 Invocation 继续用它启动时的快照。唯一例外是 `daily_budget.max_tokens`：日预算在运行期实时读取，调低后下一次模型调用立即被拦截 |
| `telegram.chats[<id>].instructions_file` | 仅限两边都存在的 Chat；路径或内容变化都算 |
| `providers.<alias>.models[<model id>]` | 仅限两边都是 custom 的同一 alias：模型新增、删除或定义变化 |

`outside_serve` 字段（`serve` 从不读取，下一次 `backup` 生效，既不算已应用也不算待重启）：`paths.backups`、`retention.online_days`、`retention.backup_copies`。

其它所有路径都是 restart：改动会写进文件，但要重启才生效，包括 `telegram.token`、`data_dir`、`paths.database`、`admin.*`、`mcp.servers`、Provider 连接字段（`base_url`、`api`、`api_key`、`headers`）、Provider 的新增/删除、`telegram.sticker_sets`、`vision.*`、Chat allowlist，以及 `instructions_file` 以外的 Chat 字段。

应用流程与语义：

- 每次应用做两遍校验：先 `loadConfig` 校验文件本身（保证下次启动可用），再把文件的热字段与当前进程仍然生效的 restart 字段组合成 candidate，用 `validateSemantics` 校验 candidate（保证当前进程可用）。两遍都通过才发布。
- candidate 的 restart 字段保留当前进程的值，热字段与 outside_serve 字段取文件的值。因此组合可能不合法：文件本身合法但与待重启字段冲突时返回 `candidate_invalid`，错误信息会列出待重启路径；文件仍然留在磁盘上，重启后与那些字段一起生效。
- 待重启字段记录在 `ConfigReloader.status().restartRequired`；之后只改热字段再应用也不会清空它。
- 在用模型保护：修改或删除运行中进程仍在使用的模型（agent 模型，或 `vision` 模型——`vision.*` 本身是 restart 字段）时，这一项按 restart 处理，candidate 沿用旧定义；只有 candidate 不再引用它（例如 agent 已切到别的模型且它不是 vision 模型）才按 hot 处理。
- 自定义 Provider 的 `models[]` 热更新会按新定义重建 Provider 对象；`base_url`、`headers`、`api_key` 沿用启动时解析好的凭据，不重新解析 SecretRef。因此这类改动只影响模型列表，连接字段仍要重启。
- 发布是原子的：Provider 替换与配置发布之间没有 `await`。已经开始的 Invocation 与运行中 attach 的 Bucket 继续用运行开始时冻结的快照，下一次 Invocation 才用新配置；`invocations.config_hash` 在 `queued → running` 时写入该快照的 active hash。
- Prompt 变化（`agent.system_prompt_file` 或 `instructions_file`）改变稳定系统提示的哈希，该 Conversation 的 Context 在下一次运行时重建，见「Conversation Context」。
- 每次成功应用输出 `config_reloaded` 日志事件，带 `generation`、`active_hash`、`file_hash`、`applied`、`restart_required`、`outside_serve`；失败输出 `config_reload_failed`（`code` 与脱敏后的 `error`），active 配置与文件哈希都不变，错误记录在 `ConfigReloader.status().lastError`。
- 没有任何待重启字段时 `active_hash` 等于文件哈希，可以直接与 `check-config` 的输出比对；有待重启字段时它是 candidate 规范化序列化的 SHA-256。
- 写入配置文件（`/model`）由 `src/platform/config-file.ts` 完成：只替换 JSONC 的值，保留注释与格式；先写同目录临时文件并完整校验，再 rename 覆盖，因此读者只会看到旧文件或完整合法的新文件。配置文件是符号链接时拒绝写入（`config_symlink`）。
- 端点、状态码与响应体见 [admin-panel.md](admin-panel.md#api)。

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

`.env` / `.env.local` 加载：

- 所有 CLI 子命令（`serve`/`check-config`/`doctor`/`backup`/`configure`）启动时用 dotenv 加载当前工作目录下的 `.env.local` 与 `.env`；文件缺失时静默跳过。
- 只按 CWD 解析，不向上递归查找目录。
- 优先级：真实环境变量 > `.env.local` > `.env`；compose `environment:`/`env_file:` 等方式注入的值不会被覆盖。
- 两份文件均已被 `.gitignore` 排除，用于本地开发便利；生产部署仍应使用环境注入。

不要把真实 Token/API key 写进文档、测试、日志或提交。

## 顶层结构

| Section | 用途 |
| --- | --- |
| `version` | 当前只接受 `1` |
| `data_dir` | Serve lock 与运行数据根目录 |
| `timezone` | 默认 IANA 时区 |
| `telegram` | Token、Bucket 窗口、Chat/Topic allowlist、Sticker Set |
| `providers` | 内置或自定义 Provider 别名 |
| `agent` | 对话模型、Prompt、并发与限流、上下文保留策略、全局 Token 预算 |
| `vision` | Sticker 视觉模型、并发、Prompt 版本和预算 |
| `mcp` | 可选的 stdio/Streamable HTTP Server |
| `admin` | 可选的 Admin Panel（审计只读 + 受控管理写端点） |
| `retention` | 在线保留天数与备份份数 |
| `paths` | SQLite、媒体缓存和备份目录 |

## Telegram Chat 与 Topic

```jsonc
{
  "telegram": {
    "token": { "env": "TELEGRAM_BOT_TOKEN" },
    "process_bot_messages": false,
    "sticker_trigger_enabled": false,
    "bucket_window_seconds": 15,
    "chats": [
      {
        "id": -1001234567890,
        "instructions_file": "prompts/chat-1001234567890.md",
        "timezone": "Asia/Shanghai",
        "topic_ids": [100, 200],
        "ignored_user_ids": [123456789, 987654321],
      },
    ],
  },
}
```

规则：

- `bucket_window_seconds` 是全局 Agent 会话节拍，单位秒，示例值为 15。`0` 表示有新消息时不额外延迟，但不会创建空会话。deadline 锚点、按 Chat 串行、轮中途不交出批次与 attach 到运行中 Invocation 的规则统一见 [Telegram 与 Agent 流程：会话节拍与 Bucket](telegram-agent-flow.md#会话节拍与-bucket)；运行结束后是否继续等待下一个 Bucket 由 `agent.context.idle_grace_seconds` 决定，见「Conversation Context」。
- `process_bot_messages` 控制是否处理其他 Bot 的消息。`false` 时其他 Bot 的新消息与编辑只保留 Update 审计，完全不入库。`true` 时它们会入库，但永远不能创建 Bucket、命中 participation 触发或刷新注意力窗口：已有 collecting Bucket 时直接加入；否则暂存，等下一条真人消息创建 Bucket 时，按 Telegram 时间顺序排在该真人消息之前一并收入（仅收未进过任何 Bucket、晚于该 Conversation 上一个 Bucket 起点、且在 `/cut_topic` 截断之后的最新 `agent.history_messages` 条）。这样两个 Bot 无法互相唤醒形成死循环。自己发送的 Update 始终忽略。
- `sticker_trigger_enabled` 可选，默认 `false`。关闭时，单独收到的人类 Sticker 仍会持久化，但不会创建 Bucket 或触发 Invocation；已有 collecting Bucket 时仍会加入。设为 `true` 后，单独的 Sticker 可以创建 Bucket。
- Chat ID 必须是非零安全整数且不可重复。
- 未配置 `topic_ids`：允许该 Chat 的普通消息与所有 Topic。
- 配置 `topic_ids`：只允许列出的正整数 Topic ID；未列出的 Topic 被审计为拒绝。
- Forum Topic 按 `(chat_id, message_thread_id)` 隔离 Conversation。
- `participation`（可选）配置此 Chat 的定时活跃时段、触发关键词与注意力窗口，见「定时活跃（participation）」。
- `ignored_user_ids`（可选）是此 Chat 内要忽略的 Telegram User ID 数组；必须是唯一的正安全整数。匹配 `message.from.id` 的新消息和编辑只保留 Update 审计，不写入 Message、Revision、Media 或 Bucket，不能作为命令触发，也不会进入实时或启动追赶 Invocation 的 Context。其他成员消息中若 Reply 快照指向被忽略用户，该引用同样不保存。该字段不匹配 `sender_chat` 身份，修改后必须重启；已入库的旧消息不会追溯删除。
- `instructions_file`（可选）指向该 Chat 的附加系统提示 Markdown 文件，缺省时为空；提示内容不提供额外授权。
- 修改 Chat 的 allowlist、Topic 或其它字段后必须重启，并比较 `check-config` 与 `serve_started` 的 `config_hash`；已有 Chat 的 `instructions_file` 属于热更新白名单，见「运行时配置热更新」。
- Chat 没有每日 Invocation 次数上限，也不设 Token 硬上限；Token 只按 Chat 归属统计，唯一硬上限是全局 `agent.daily_budget.max_tokens`。
- `admins`（可选）是 Telegram User ID 数组，作为 Bot 管理员 seed 到 `bot_admins`；只有管理员能执行 `/pause`、`/resume`、`/model`、`/cut_topic`。

## 定时活跃（participation）

默认情况下，任何可触发消息都会开 Bucket 并启动 Agent 会话。`participation` 让管理员把群聊改成「按时间表活跃」：时段内行为与默认完全一致，时段外只有命中触发的消息才能唤醒会话。

```jsonc
{
  "telegram": {
    "participation": {
      "active_windows": [
        { "start": "09:00", "end": "12:00" },
        { "start": "20:00", "end": "01:00", "days": [5, 6, 7] },
      ],
      "trigger_keywords": ["塑料碗", "wan"],
      "attention_window_seconds": 300,
    },
    "chats": [
      {
        "id": -1001234567890,
        "participation": {
          "active_windows": [{ "start": "00:00", "end": "24:00" }],
          "trigger_keywords": ["运维"],
        },
      },
    ],
  },
}
```

判定分两步：仅在活跃时段外，为有触发资格且命中 @、Reply 或关键词的新消息创建或刷新注意力窗口；再用更新后的窗口判断 participation 闸门是否放行。该闸门不替代 allowlist、暂停状态和消息触发资格检查。

```text
participation 放行 = 未配置 participation || 处于活跃时段 || 更新后的注意力窗口未过期
```

- `participation` 可挂在 `telegram`（全局默认）与 `chats[]`（每 Chat）两处；两处都不配置时该 Chat 保持默认行为。
- `active_windows`（可选）：每天重复的活跃时段。`start` 与 `end` 是 `HH:MM` 本地时间，`end` 额外允许 `24:00`；`end` 小于 `start` 表示跨午夜并归属开始日（`23:00-01:00` 配 `days: [5]` 覆盖周五 23:00 到周六 01:00）；`days`（可选）为 ISO 星期 `1`–`7`，1 是周一，省略表示每天。判定是半开区间 `[start, end)`。
- 时段按 Chat 时区解释：`chats[].timezone`，缺省用顶层 `timezone`。
- **每群覆盖全局**：`chats[].participation.active_windows` 存在即整体替换全局值；`[]` 表示该 Chat 没有时段，只能靠触发唤醒。
- `trigger_keywords`（可选）：**每群追加**到全局列表；匹配消息的 `text` 与 `caption`，大小写不敏感。`[]` 表示没有关键词触发。
- `attention_window_seconds`（可选，默认 300）：命中后窗口的长度；同样每群覆盖全局。
- 时段外只有三类消息能开 Bucket：直接 @ Bot、Reply Bot 自己发过的消息、命中 `trigger_keywords`。任意一类命中都会把该 Conversation 推进注意力窗口，窗口内再次命中则重置计时，窗口内该 Conversation 与时段内一样始终触发。
- 窗口只在时段外维护：时段结束时立即回到静默，时段末尾的一次 @ 不会延续到时段之后。
- 粒度是 Conversation（Chat + Forum Topic）：时段是 Chat 级，窗口只覆盖命中发生的那个 Topic。
- 被闸门拦下的消息照常入库并保留 Revision，只是不开 Bucket；它们会在下一次触发时作为 history 进入 Context，因此静默期不会丢上下文。
- 私聊不受 `participation` 影响（即使配置了全局时段）；在正数 Chat ID（私聊）上显式写 `participation` 会被 `check-config` 拒绝。
- `/pause` 优先于 `participation`：暂停期间既不建 Bucket 也不记录窗口。
- `active_windows` 与 `trigger_keywords` **不设条数上限**。启动期会预编译时段、将关键词小写化，并复用时区 Formatter，减少重复解析；逐消息匹配仍遍历时段与关键词，成本随列表长度和消息文本长度增长。`attention_window_seconds` 有上界，表达「永久活跃」应写 `00:00-24:00`。
- 修改后必须重启；窗口状态存在数据库里，跨重启保持。

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
- `system_prompt_file`: 指向运维侧人格提示的 Markdown 文件，路径相对配置文件目录，内容必须非空（剔除 HTML 注释后仍需有正文）。消息分区、安全边界、Tool 选择原则和副作用成功判定由代码内 Core Agent Protocol 固化；具体 Tool 的触发条件、禁用情形、调用顺序与收尾规则由 Tool description 固化，不应重复塞入人格文件。人格提示和 Chat 的 `instructions_file` 支持 `{{ agent.provider }}`、`{{ agent.model }}`、`{{ vision.provider }}`、`{{ vision.model }}`、`{{ timezone }}` 模板变量；模板只执行严格白名单替换，未知或格式错误的表达式会拒绝配置。
- Prompt 注释：`system_prompt_file` 与 `instructions_file` 中的 `<!-- ... -->` HTML 注释在加载时被剔除，可以写给人看的说明而不占模型上下文；注释可跨行，整行只有注释时该行一并消失。未闭合的 `<!--` 不构成注释，按原文保留；模板校验在剔除之后进行，因此注释里可以出现任意 `{{ ... }}` 文本。提示文件含 NUL 字符时拒绝加载。
- 模板中的 `agent.provider` 与 `agent.model` 是当前 Invocation 实际使用的模型，因此 Admin Panel 或 `/model` 的运行时切换会反映到下一次会话；`vision.*` 始终来自配置。模板值只注入 Prompt，不会注入记忆；记忆内容按原文保留。
- `max_concurrency`: 全局并行 running Invocation 上限；`history_messages` 是每个新开 Invocation 冻结 history 快照的条数上限（attach 进运行中 Invocation 的批次不带 history）。渲染时会跳过保留 transcript 里已经有的消息，所以真正注入的只是 transcript 从没见过的那部分，例如被参与闸门挡住、从未注入过的消息；并不是只在冷启动时才生效。单次运行不再有 `max_turns`/`max_sends`/`timeout_seconds`（字段已删除，写进配置会被拒绝），运行边界见「Conversation Context」。
- `context_stop_ratio`: 估算输入 Token 达到 `context_window × context_stop_ratio` 后进入收尾模式：下一次模型调用只带 `send` 和当时可用的 `zzz`，模型用这一轮把话说完；这一轮结束后运行以 `completion_reason = context_limit` 结束。收尾轮只给一次，模型调用使用的是本次运行实际生效的模型（含 `/model` 热切换后的模型），GC 的 token 判据同理。
- `send_max_text_length`（可选，默认不限制）：`send` 工具文本消息的最大字符数。超出时 Tool Call 记为 `send_text_too_long` 错误，不消耗发送配额、不调用 Telegram；Sticker 不受影响。
- `send_disallow_blank_lines`（可选，默认 `false`）：开启后，文本包含任何空行（两个换行符之间只有空格/Tab 也算空行）时 Tool Call 记为 `send_blank_lines` 错误，不消耗发送配额、不调用 Telegram；段落只能用单个换行分隔。Sticker 不受影响。
- `memory_ttl_warning_days`（可选，默认 30）：Agent 记忆剩余寿命超过该天数时，Admin Panel 显示 warning，提示管理员判断保留、删除或提升进 `agents.md`。系统不禁止长 TTL。
- `send_nudge_enabled`（可选，默认 `false`）：开启后，当 agent 即将自然停止、本轮未调用任何工具且产生了去除首尾空白后非空的普通 Assistant 文本，又从未调用过 `send` 时，注入一条 harness 级 user 消息提醒其用 `send` 发送面向群聊的文本。判定排在「注入下一批」与空闲等待之前，因此该提醒按**注入批次**计数（每个批次至多触发一次），而不是按 Invocation 计数；触发与提醒文本记录在 `agent_messages` 中，role 为 `harness_nudge`。用于稳定性不足、偶尔把回复写成私文本却忘记调用 `send` 的模型。
- `thinking_level`: Provider 仍可能限制具体模型支持的级别，Schema 通过不代表模型接受。

Agent 不再配置 `max_output_tokens`：每次请求的输出上限直接使用目标模型在 provider 中声明的 `max_tokens`。Provider 注册的模型必须满足 `max_tokens ≤ context_window`，且 agent 模型必须支持 text。

运行时热切换：Admin Panel「Model」页面（`GET/PUT /api/model`）与 Telegram 的 `/model 序号` 可在已配置的 provider/模型之间切换 agent 模型。切换把 `agent.provider` / `agent.model` 写入 `config.jsonc` 并重新加载配置，因此重启 `serve` 后仍然生效，也没有「恢复默认」操作（`/model reset` 不再是有效命令）。切换对后续启动的 agent session（Invocation）生效，不影响进行中的会话。若稳定系统提示的渲染结果因此变化（模板里出现 `{{ agent.provider }}`/`{{ agent.model }}`，或模型的图片能力改变了图片处理说明），该 Conversation 的 Context 会在下一次运行时重建，见「Conversation Context」。`/status` 命令展示当前生效模型。

`vision` 约束：

- 独立 Provider/Model 与输出上限，用于 text-only Agent 的普通图片回退和 Sticker 分析。
- 前台 `read_image` 并发由 `max_concurrency` 控制。
- `background_sticker_concurrency` 当前必须为 `1`。
- `prompt_version` 参与视觉缓存版本；改变描述规则时递增。
- `daily_budget` 同时限制 Token 和图片数，但只作用于后台 Sticker 索引（`daily_usage` 的 `system`/`sticker_index`）；聊天触发的 `read_image` 计入全局 `agent.daily_budget.max_tokens`。

## Conversation Context

每个 Conversation（Chat + Forum Topic）只有一份持久 transcript，跨 Invocation 与进程重启存在；`agent.context` 控制这份历史如何保留与裁剪，`agent.rate_limits` 控制长生命周期运行的节流。表的语义见 [data-layer.md](data-layer.md#conversation-context长期会话-transcript)。

```jsonc
{
  "agent": {
    "context_stop_ratio": 0.75,
    "history_messages": 30,
    "context": {
      "retained_sends_target": 20,
      "retained_sends_max": 40,
      "hard_token_ratio": 0.7,
      "ref_ttl_hours": 72,
      "idle_grace_seconds": 60,
      "max_wall_clock_seconds": 900,
      "agent_cache_size": 32,
    },
    "rate_limits": {
      "sends_per_window": 3,
      "window_seconds": 120,
      "turns_per_injection": 24,
    },
  },
}
```

`agent.context` 与 `agent.rate_limits` 都是必填对象，新增字段会因 `Strict` 被拒绝；升级旧配置时漏写或残留旧键都会让 `check-config`/`serve` 直接失败，错误信息会点名缺失与多余的键。`agent.context`：

- `retained_sends_target` / `retained_sends_max`: 保留窗口的目标与上限，单位是成功 `send` 的次数。只有在保留窗内发送数超过 `retained_sends_max`（或触发 Token 压力）时才裁剪，裁剪把窗口起点跳到「仍保留至少 `retained_sends_target` 次发送」的最新 checkpoint，因此一次 GC 会跨过若干次发送，而不是逐条消息裁。
- `hard_token_ratio`: Token 安全阀，相对模型的 `context_window`。估算输入加预留输出达到 `context_window × hard_token_ratio` 就会触发 GC，用于发送稀疏但 Tool 链很长的历史；这类历史找不到满足发送目标的 checkpoint 时，退回「保留段估算 Token 不超过 `context_window × hard_token_ratio × 0.8`」的最新 checkpoint。
- `ref_ttl_hours`: 能力引用（`img_`/`stk_`/`reply:`）在 Conversation Context 内的有效期；引用一旦到期，或携带它的历史行被 GC 丢弃，就解析不出来了。
- `idle_grace_seconds`: 运行本该自然结束时，仍保持打开等待下一个 Bucket 的秒数；等待期间有新批次就继续这一轮，否则结束；`0` 表示关闭长生命周期运行（每批消息都会结束这次运行，下一次由新的调度启动）。
- `max_wall_clock_seconds`: 单次运行的墙上时钟上限，达到即结束这次运行。
- `agent_cache_size`: 内存中缓存 Pi agent 实例的 Conversation 数（LRU）。缓存只是加速——被逐出或进程重启后都从 SQLite 的 Conversation Context 重新播种，不丢历史。

`agent.rate_limits`：

- `sends_per_window` / `window_seconds`: 按 Telegram Chat 计算的滑动窗口发送上限，统计窗口内所有已发往 Telegram 的 `telegram_sends`（`success`/`pending`/`outcome_unknown`/`error` 都算，失败的尝试同样消耗额度）。命中时 Tool Call 记为 `send_rate_limited` 错误，不调用 Telegram；长生命周期运行可以发很多次，但循环不能刷屏。
- `turns_per_injection`: 自最近一次消息注入以来允许的最大 turn 数，达到即结束这次运行；注入新批次后计数清零。

`check-config` 另外校验这些关系（Schema 通过不代表组合合法）：

- `retained_sends_target < retained_sends_max`。
- `hard_token_ratio <= agent.context_stop_ratio`。
- `idle_grace_seconds` 为 `0`（关闭长生命周期运行）或不小于 `telegram.bucket_window_seconds`；比一个 Bucket 窗口还短的等待会在下一个 Bucket 到期前就结束运行，看似启用实则无效，因此在配置期直接拒绝。
- `max_wall_clock_seconds > idle_grace_seconds`。

稳定系统提示与重建：稳定段与每批注入段各含什么，见 [Telegram 与 Agent 流程：Context 生命周期](telegram-agent-flow.md#context-生命周期)。配置侧只需记住：人格提示、Chat `instructions` 及其模板变量渲染结果都属于稳定段，其 SHA-256 记在 `conversation_contexts.system_prompt_hash`。稳定段内容一变（改 Prompt 文件或 `instructions_file`、运行时切换模型导致模板或图片说明变化等），该 Conversation 的整份 Context 会重建：已保留的 transcript 与能力引用全部丢弃，`head_seq`/`next_seq` 复位为 1。时间、记忆、睡眠状态等运行期状态随批次注入，改变它们不会触发重建。

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
        "tools": "*",
        "payload_max_bytes": 32768,
        "result_max_bytes": 32768,
        "default_tool_policy": {
          "read_only": true,
          "timeout_seconds": 20,
        },
      },
    ],
  },
}
```

Streamable HTTP 使用 `url` 与可选 SecretRef `headers`，且 `follow_redirects` 必须为 `false`。`url` 可以包含服务协议要求的查询参数，但禁止 URL userinfo 与 fragment；机密值应使用 SecretRef `headers`，不应写入查询参数。`tools` 为 `"*"` 时全部 Tool 共享 `default_tool_policy`；`tools` 为显式数组时，每个列出的 Tool 必须在 `tool_policies` 中提供对应策略，`default_tool_policy` 只服务于 `"*"`。策略只包含 `read_only` 与 `timeout_seconds`，没有每日调用次数上限。没有策略的 Tool 不会暴露给模型。`required = true` 的 Server 启动失败会阻止 `serve`/`doctor` 成功。

## Admin Panel

```jsonc
{
  "admin": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8787,
    "session_ttl_hours": 168,
    "static_dir": "/opt/plasticwan/apps/admin-next/dist",
  },
}
```

- `enabled = false` 或省略整个 section 时 `serve` 不监听任何 HTTP 端口。
- `host` 是任意非空字符串，不做回环限制；绑定非回环地址（如 `0.0.0.0`）会把面板暴露给所在网络，TLS 与访问控制由运维负责。推荐保持回环并经反向代理对外。
- `session_ttl_hours` 同时决定 Session 过期与 Cookie `Max-Age`。
- `static_dir` 可选，默认 `apps/admin-next/dist`（相对仓库根解释）；目录缺失时审计 API 仍可用，静态路由返回 503 `admin_bundle_missing`。

详细认证、API 与前端约定见 [admin-panel.md](admin-panel.md)。
