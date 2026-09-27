---
title: 配置人格与每群指令
description: 为 Plastic Wan 设置全局人格、每群附加指令和模板变量，并确认它们何时生效。
---

# 配置人格与每群指令

本页适合需要让 Bot 保持固定身份、语气或工作规则的管理员。全局人格决定 Bot 的共同身份；Chat 指令只补充某个群或私聊的上下文。

## 配置全局人格

准备一个非空 Markdown 文件，例如 `prompts/system.md`。在 `config.jsonc` 中加入片段（这是片段，不是完整配置）：

```jsonc
{
  "agent": {
    "system_prompt_file": "prompts/system.md"
  }
}
```

路径相对于 `config.jsonc` 所在目录，不是当前终端目录。文件中的 HTML 注释会在送入模型前移除；可以用注释写给管理员的备注。人格文件负责身份、表达和参与倾向；是否最终发言由模型判断。它不能授予 Tool 权限，也不能覆盖运行时的授权、校验和发送边界。

支持的模板变量只有：`{{ agent.provider }}`、`{{ agent.model }}`、`{{ vision.provider }}`、`{{ vision.model }}`、`{{ timezone }}`。它们会在每次 Invocation 按实际生效配置替换；未知变量会使配置校验失败。

## 为单个 Chat 添加指令

在对应 Chat 项中加入 `instructions_file`：

```jsonc
{
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "instructions_file": "prompts/group.md"
      }
    ]
  }
}
```

Chat 指令是全局人格之外的附加系统提示。Forum Topic 使用所属 Chat 的指令；它不会自动变成每 Topic 一份配置。指令同样支持上述模板变量。

## 写一份简短的人格

例如，全局人格文件可以写成：

```markdown
你是塑料碗，和大家一起待在 Telegram 群里的伙伴。
用简短、自然的中文交流；不确定时先说明，不编造经历。
不必接每一句话；有能补充的内容或被问到时再参与。
```

某个技术群的 `prompts/group.md` 可以只补充：

```markdown
这个群主要讨论软件开发。回答时优先给出可验证的步骤。
不要把本群成员的习惯推广到其他群。
```

对话中的一次请求不等于长期配置；希望稳定保留的规则写入文件并显式应用。

## 让修改生效

1. 运行 `node src/cli.ts check-config --config <config.jsonc>` 检查 JSONC、文件路径和模板。
2. 修改 Prompt 文件后，在 Admin Panel 的 **Apply config file** 应用；也可以使用 `/model` 触发重新加载。没有文件 watcher，单独保存文件不会立即改变运行中的配置。
3. 全局 `system_prompt_file` 和已有 Chat 的 `instructions_file` 属于热更新字段。下一次该 Conversation 运行时，稳定提示哈希变化会重建其 Conversation Context；当前正在运行的 Invocation 继续使用启动时快照。

## 如何确认

查看 Admin Panel 的 Settings 中 `active hash`、`file hash` 和 `last error`。成功应用会显示新的哈希并记录 `config_reloaded`；若仍有待重启字段，面板会同时列出 `restart required`。在下一次 Invocation 的 Tool session 中确认使用了预期模型和行为。

## 常见误区

- Prompt 文件路径不是相对 `data_dir`，而是相对配置文件目录。
- 改文件不会自动热加载，必须 Apply 或重启。
- 全局人格和 Chat 指令会影响模型上下文，但不授予额外权限。
- Prompt 改动可能清掉该 Conversation 的连续 Context；这不是普通消息历史被“摘要”了，而是按新稳定提示重新开始。

相关页面：[配置文件与 Secret](../configure/config-file.md)、[模型](../configure/models.md)、[管理面板](../configure/admin.md)、[排障](../operations/troubleshooting.md)。
