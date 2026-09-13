# 配置

Plastic Wan 使用严格 JSONC 配置。Schema 位于 `src/platform/config.ts`，未知字段会被拒绝；除类型校验外，还会验证时区、ID 唯一性、模型引用、URL 和预算关系。

本页只记录 Schema 表达不出来的语义。每个字段的类型、取值范围和必填性以 `src/platform/config.ts` 的 TypeBox Schema 为准——越界值由 `check-config` 直接报出，不要靠文档抄写的数字判断。

## 加载语义

- CLI 必须显式传入 `--config <path>`。
- 配置在 `serve` 启动时读取一次，不支持热重载。
- 配置哈希是原始 JSONC 文本与所有 Prompt 文件内容的 SHA-256，写入 Invocation 并打印在 `serve_started` 日志中。
- 修改 allowlist、Bucket 窗口、Provider、Prompt、Sticker Set 或 MCP 后必须重启。
- 相对 `data_dir`/`paths` 按服务当前工作目录解释；systemd 固定在 `/opt/plasticwan`。
- Prompt 文件路径（`system_prompt_file`、`instructions_file`）相对于配置文件所在目录解释；修改文件内容同样会改变 `config_hash`。
- Prompt 文件按原始字节参与哈希：剔除 HTML 注释只影响进入模型上下文的文本，纯注释改动仍然改变 `config_hash`。
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
| `agent` | 对话模型、Prompt、并发与限流、上下文保留策略、全局 Token 预算 |
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

- `bucket_window_seconds` 是全局 Agent 会话节拍，单位秒，示例值为 15。`0` 表示有新消息时不额外延迟，但不会创建空会话。每个 `collecting` Bucket 的 deadline 是 `max(第一条消息时刻, 该 Conversation 上一轮结束时刻) + 一个节拍`：Agent 空闲时就是消息自身加一个节拍，消息在上一轮运行期间到达时则从该轮结束起算，与 Invocation 的创建/结束时刻无关；同一时刻每个群最多一个 Agent 会话（按 Chat 串行），未到期的批次不会被提前消费，运行中的批次也不会在轮中途被交出。若该 Conversation 已有 running Invocation，到期且已空闲的 Bucket 会挂到这个运行中的 Invocation 上（不再新开会话）并注入其 transcript；运行结束后是否继续等待下一个 Bucket 由 `agent.context.idle_grace_seconds` 决定，见「Conversation Context」。
- `sticker_trigger_enabled` 可选，默认 `false`。关闭时，单独收到的人类 Sticker 仍会持久化，但不会创建 Bucket 或触发 Invocation；已有 collecting Bucket 时仍会加入。设为 `true` 后，单独的 Sticker 可以创建 Bucket。
- 消息收集仍按 Conversation 隔离：Forum Topic 各自收集、Context 互不混入，只是 Agent 会话在群内串行。
- Chat ID 必须是非零安全整数且不可重复。
- 未配置 `topic_ids`：允许该 Chat 的普通消息与所有 Topic。
- 配置 `topic_ids`：只允许列出的正整数 Topic ID；未列出的 Topic 被审计为拒绝。
- Forum Topic 按 `(chat_id, message_thread_id)` 隔离 Conversation。
- `participation`（可选）配置此 Chat 的定时活跃时段、触发关键词与注意力窗口，见「定时活跃（participation）」。
- `ignored_user_ids`（可选）是此 Chat 内要忽略的 Telegram User ID 数组；必须是唯一的正安全整数。匹配 `message.from.id` 的新消息和编辑只保留 Update 审计，不写入 Message、Revision、Media 或 Bucket，不能作为命令触发，也不会进入实时或启动追赶 Invocation 的 Context。其他成员消息中若 Reply 快照指向被忽略用户，该引用同样不保存。该字段不匹配 `sender_chat` 身份，修改后必须重启；已入库的旧消息不会追溯删除。
- `instructions_file`（可选）指向该 Chat 的附加系统提示 Markdown 文件，缺省时为空；提示内容不提供额外授权。
- 修改 Chat 后重启，并比较 `check-config` 与 `serve_started` 的 `config_hash`。
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
- `max_concurrency`: 全局并行 running Invocation 上限；`history_messages` 是冷启动批次（该 Conversation Context 尚无历史，例如新建或刚重建）随注入附加的 history 区段条数上限。单次运行不再有 `max_turns`/`max_sends`/`timeout_seconds`（字段已删除，写进配置会被拒绝），运行边界见「Conversation Context」。
- `context_stop_ratio`: 估算输入 Token 占模型窗口的比例达到该阈值后，进入收尾模式，只保留 `send` 和当时可用的 `zzz`，而不是立即停止 Tool 循环；估算输入加预留输出达到模型窗口时才按上下文限制终止。
- `send_max_text_length`（可选，默认不限制）：`send` 工具文本消息的最大字符数。超出时 Tool Call 记为 `send_text_too_long` 错误，不消耗发送配额、不调用 Telegram；Sticker 不受影响。
- `send_disallow_blank_lines`（可选，默认 `false`）：开启后，文本包含任何空行（两个换行符之间只有空格/Tab 也算空行）时 Tool Call 记为 `send_blank_lines` 错误，不消耗发送配额、不调用 Telegram；段落只能用单个换行分隔。Sticker 不受影响。
- `memory_ttl_warning_days`（可选，默认 30）：Agent 记忆剩余寿命超过该天数时，Admin Panel 显示 warning，提示管理员判断保留、删除或提升进 `agents.md`。系统不禁止长 TTL。
- `send_nudge_enabled`（可选，默认 `false`）：开启后，当 agent 即将自然停止、本轮未调用任何工具且产生了去除首尾空白后非空的普通 Assistant 文本，又从未调用过 `send` 时，注入一条 harness 级 user 消息提醒其用 `send` 发送面向群聊的文本。判定排在「注入下一批」与空闲等待之前，因此该提醒按**注入批次**计数（每个批次至多触发一次），而不是按 Invocation 计数；触发与提醒文本记录在 `agent_messages` 中，role 为 `harness_nudge`。用于稳定性不足、偶尔把回复写成私文本却忘记调用 `send` 的模型。
- `thinking_level`: Provider 仍可能限制具体模型支持的级别，Schema 通过不代表模型接受。

Agent 不再配置 `max_output_tokens`：每次请求的输出上限直接使用目标模型在 provider 中声明的 `max_tokens`。Provider 注册的模型必须满足 `max_tokens ≤ context_window`，且 agent 模型必须支持 text。

运行时热切换：Admin Panel「Model」页面（`GET/PUT/DELETE /api/model`）可在已配置的 provider/模型之间切换 agent 模型。切换是内存态，立即对后续启动的 agent session（Invocation）生效，不影响进行中的会话；重启 `serve` 后恢复 `config.jsonc` 的默认值。若稳定系统提示的渲染结果因此变化（模板里出现 `{{ agent.provider }}`/`{{ agent.model }}`，或模型的图片能力改变了图片处理说明），该 Conversation 的 Context 会在下一次运行时重建，见「Conversation Context」。`/status` 命令展示当前生效模型。

`vision` 约束：

- 独立 Provider/Model 与输出上限，用于 text-only Agent 的普通图片回退和 Sticker 分析。
- 前台 `read_image` 并发由 `max_concurrency` 控制。
- `background_sticker_concurrency` 当前必须为 `1`。
- `prompt_version` 参与视觉缓存版本；改变描述规则时递增。
- `daily_budget` 同时限制 Token 和图片数。

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

- `sends_per_window` / `window_seconds`: 按 Telegram Chat 计算的滑动窗口发送上限，统计窗口内 `success`/`pending`/`outcome_unknown` 的 `telegram_sends`。命中时 Tool Call 记为 `send_rate_limited` 错误，不调用 Telegram；长生命周期运行可以发很多次，但循环不能刷屏。
- `turns_per_injection`: 自最近一次消息注入以来允许的最大 turn 数，达到即结束这次运行；注入新批次后计数清零。

`check-config` 另外校验这些关系（Schema 通过不代表组合合法）：

- `retained_sends_target < retained_sends_max`。
- `hard_token_ratio <= agent.context_stop_ratio`。
- `idle_grace_seconds` 为 `0`（关闭长生命周期运行）或不小于 `telegram.bucket_window_seconds`；比一个 Bucket 窗口还短的等待会在下一个 Bucket 到期前就结束运行，看似启用实则无效，因此在配置期直接拒绝。
- `max_wall_clock_seconds > idle_grace_seconds`。

稳定系统提示与重建：系统提示被拆成两部分。**稳定部分**（Core Agent Protocol、Skill 索引、图片与 Sticker 处理说明、人格提示、对话模式、记忆与内部上下文指引、Chat `instructions`，含模板变量渲染结果）不随运行期状态变化，它的 SHA-256 记在 `conversation_contexts.system_prompt_hash`；**每批注入部分**（当前时间、记忆列表、内部上下文、睡眠状态、闹钟任务、启动追赶说明、不可信的 Sticker 目录与本次 Telegram 快照）改由每批注入的消息携带（`ContextBuilder.renderInjection`），不再进入系统提示。稳定部分的内容一变（改 Prompt 文件或 `instructions_file`、模板渲染结果变化等），该 Conversation 的整份 Context 会重建：已保留的 transcript 与能力引用全部丢弃，`head_seq`/`next_seq` 复位为 1。只改运行期状态不会触发重建。

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
    "static_dir": "/opt/plasticwan/apps/admin/dist",
  },
}
```

- `enabled = false` 或省略整个 section 时 `serve` 不监听任何 HTTP 端口。
- `host` 只接受 `127.0.0.1`、`::1`、`localhost`；远程访问必须由反向代理承担 TLS 与网络暴露。
- `session_ttl_hours` 同时决定 Session 过期与 Cookie `Max-Age`。
- `static_dir` 可选，默认 `apps/admin/dist`；目录缺失时审计 API 仍可用，静态路由返回 503 `admin_bundle_missing`。

详细认证、API 与前端约定见 [admin-panel.md](admin-panel.md)。
