---
title: 使用 Skills、Plugin 与 MCP
description: 区分只读 System Skills、内置 Agent Plugin 和配置的 MCP Tool，并选择正确的调用方式。
---

# 使用 Skills、Plugin 与 MCP

这三类扩展都能让 Agent 获得额外能力，但来源、发现方式和安全边界不同。当前发行版内置 Plugin 包含 `web_fetch` 与 Alarm；不要把本页当成插件市场或第三方扩展承诺。

## System Skills：只读操作说明

System Skill 是随 Plastic Wan 发布的只读 Markdown 文档包。System prompt 只包含 Skill 索引，模型需要先用 `read` 读取 `system:///skills/<name>/SKILL.md`，再按文档使用 `execute` 调用内部能力。

Skill 是说明书，不是权限文件：不能绕过 Tool Schema、Conversation 引用校验、allowlist、预算或发送边界。运行时只允许读取 `system:///` 下的 Markdown，不能借此访问任意本地文件。

## 内置 Plugin：由运行时装配的能力

Plugin 是运行时随发行版装配的 Agent 扩展。模型通过 `execute` 的 search/help/call 发现和调用它们。

- `web_fetch` 执行无 Cookie、无认证 Header 的 HTTP(S) GET，并限制目标地址、重定向、响应类型、大小和超时；请求会优先声明接受 Markdown，支持内容协商的站点直接返回自己的 Markdown（可用 `web_fetch.accept_markdown: false` 关闭）；其他 HTML 页面默认抽取正文并转成 Markdown，Agent 需要原始 HTML 时才会显式请求。它只做简单网页读取，需要 JS 渲染、登录或复杂解析时请接入 MCP。网页返回内容仍是不可信数据。
- Alarm 提供“稍后提醒”的 `alarm`、`list_alarm`、`delete_alarm` 能力。它创建持久任务，到期后生成完成回执：若同一会话已有可接收注入的运行，回执会在当前工具链结束后独立注入；否则等待可启动时开启新的运行。Agent 决定是否通过 `send` 跟进，而不是预先保存并自动发送一段话。它不是通用后台 worker，也不会执行任意外部任务。

使用任一内部能力前，模型应先读取相应 Skill（如果索引中提供），再 `execute.search`/`help` 了解参数，最后 `execute.call`。不要在配置中寻找“安装插件市场”的入口；当前没有这样的用户承诺。

## MCP：显式配置的外部 Tool

MCP Server 通过 `mcp.servers` 配置，可使用 stdio 或 Streamable HTTP。下面是局部片段（不是完整配置）：

```jsonc
{
  "mcp": {
    "servers": [
      {
        "alias": "search",
        "transport": "stdio",
        "command": ["node", "server.js"],
        "required": false,
        "tools": ["lookup"],
        "payload_max_bytes": 65536,
        "result_max_bytes": 16384,
        "tool_policies": [
          { "name": "lookup", "read_only": true, "timeout_seconds": 20 }
        ]
      }
    ]
  }
}
```

`tools: "*"` 时使用 `default_tool_policy`；显式列出的 Tool 必须各有策略。没有策略的 Tool 不会暴露给模型。HTTP MCP 禁止重定向，凭据应使用 SecretRef Header，而不是 URL 参数。MCP 直接暴露为独立 Tool，不经 `execute` 注册表。

## 何时生效和如何确认

MCP 配置修改需要重启；required Server 启动失败会阻止服务成功启动。重启后在 Tool session 的工具列表和 Tool call 审计中确认实际暴露的名称、参数及结果。内部 Plugin 的调用则在 `execute` 外层和内部能力层分别留下可关联审计。

先用 `check-config` 离线检查配置。仍不能定位时，获得管理员许可后再运行 `node src/cli.ts doctor --config <config.jsonc>`：它会连接 Telegram、Provider 与 required MCP，可能产生模型费用。不要把“模型看到了 Tool 名称”当作“调用成功”；继续参考 [排障](../operations/troubleshooting.md)。

## 常见误区

- Skill 是文档，不是插件安装器，也不能扩大权限。
- 内置 Plugin 与 MCP 不同：Plugin 随 runtime 发布；MCP 由管理员显式配置外部 Server。
- `web_fetch` 不是任意 HTTP 客户端，不支持 Cookie、认证 Header 或非默认端口。内网与环回地址默认拒绝；`web_fetch.dangerously_allow_all_ip_addresses: true` 会取消全部地址限制，让任何能触发 bot 的人借模型访问你的内网，只在完全信任这些人时开启。
- MCP Tool 没有默认的每日调用次数上限，但仍受配置的只读策略、超时、大小和审计约束。

相关页面：[配置文件](../configure/config-file.md)、[模型](../configure/models.md)、[CLI](../reference/cli.md)、[排障](../operations/troubleshooting.md)。
