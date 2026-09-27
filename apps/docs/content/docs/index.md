---
title: 使用文档
description: 从首次部署到人格、群聊、记忆与维护，按你要完成的任务选择入口。
---

# 使用文档

塑料碗（Plastic Wan）是可自行部署、运行在 Telegram 私聊、群组、Supergroup 与 Forum Topic 中的 Agent Bot。你选择模型和人格，并明确允许它在哪些会话里活动。它收到消息后可以决定参与，也可以保持安静。

:::info 先核对版本
页面上方标明本次构建的源码提交。它不自动对应远端镜像的 `latest` 或某个稳定版；含未提交修改的站点只是本地预览。本文档的 Docker 主路径从选定提交自行构建镜像。
:::

## 还没有部署

1. [第一次运行塑料碗](start/quick-start.md)：准备 Telegram Bot、模型和完整配置。
2. [部署方式与环境要求](start/installation.md)：卷、权限、媒体依赖与进程管理。
3. [配置文件、密钥与生效方式](configure/config-file.md)：分清公开配置和秘密。
4. [让 Codex / Claude Code 协助部署](start/agent-assisted.md)：给外部 Agent 的文档入口与安全边界。

## 已经跑起来了

- [修改人格](guides/personality.md)：全局性格与每群附加指令。
- [让碗在合适的时候参与](guides/participation.md)：时段、触发方式和注意力窗口。
- [给不同群配置不同的碗](guides/per-chat.md)：群级覆盖与 Topic 的区别。
- [管理记忆](guides/memory.md)：记住、遗忘，以及人工整理长期知识。
- [选择和切换模型](configure/models.md)：Provider、thinking 与 Vision。
- [控制用量](guides/budgets.md)：Token 预算、并发、限流和上下文。
- [了解 Skills、Plugin 与 MCP](guides/extensions.md)：可以扩展什么，不能绕过什么。
- [使用管理面板](configure/admin.md)：查看运行状态和审计，不与此静态网站混淆。

## 要维护，或者出了问题

- [升级与迁移](operations/upgrade.md)
- [备份、保留与恢复](operations/backup-restore.md)
- [排查为什么不回复或无法启动](operations/troubleshooting.md)

## 查具体字段与命令

- [配置语义](reference/config.md)与[自动生成的字段参考](reference/fields.md)
- [命令行与 Bot 管理命令](reference/cli.md)
- [JSON Schema](__DOCS_BASE__/config.schema.json)、[完整配置示例](__DOCS_BASE__/examples/config.example.jsonc)
- [Agent 文档索引](__DOCS_BASE__/llms.txt)、[完整 Markdown](__DOCS_BASE__/llms-full.txt)

本站只包含公开指南与安全示例，不包含运行中的 Bot、管理接口、聊天记录或密钥。连接 Telegram / Provider、升级和恢复仍需在你自己的受控环境中验证。
