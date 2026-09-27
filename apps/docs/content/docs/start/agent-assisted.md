---
title: 让 Agent 协助部署
description: 安全地让 Codex、Claude Code 等 Agent 协助检查和部署塑料碗。
---

# 让 Agent 协助部署

Agent 可以帮助阅读配置、生成非敏感 Prompt、执行校验和解释日志，但它不应接触你的 Token、API key、`key.json` 或 `.env` 文件。

## 给 Agent 的安全任务提示

将下面文字与项目版本、目标环境一起提供；将密钥留在你自己的终端或密钥管理系统中：

```text
我正在部署 Plastic Wan。请先确认当前源码提交和部署方式，阅读
我提供的文档索引，以及其中的快速开始、配置文件与密钥页面，
再检查我的 config.jsonc 是否符合 Schema。不要读取、要求我粘贴、打印
或修改 key.json、.env、Token、API key。涉及重启、迁移、覆盖配置或
删除数据前，请先解释影响并等待确认。
```

部署后的文档站提供 [llms.txt](__DOCS_BASE__/llms.txt) 与逐页 Markdown；它们是定向阅读入口，不表示任何 Agent 会自动发现或执行其中内容。

## 推荐协作顺序

1. 让 Agent 确认 checkout 的提交、Docker/宿主机方式和目标数据目录。
2. 由你复制公开的 [完整配置样例](__DOCS_BASE__/examples/config.example.jsonc)，并在本地填入 Chat ID、Provider URL 与模型元数据。
3. 让 Agent 执行或审阅 `check-config` 输出；它只校验文件，不能证明密钥或网络可用。
4. 你自己注入环境变量后，再决定是否运行 `doctor`。Doctor 会访问 Telegram、Provider 和媒体依赖，并可能消耗少量 Token。
5. 变更前让 Agent 列出哪些字段需要重启；变更后查看 `serve_started` 或 `config_reloaded`。

## 不要自动化的动作

- 不要让 Agent 调用交互式 `configure` 来创建首份配置；它只编辑已有可加载配置且需要 TTY。
- 不要让 Agent 为“修复”而删除数据库、缓存或 `serve.lock`。
- 不要把管理面板密码或浏览器 Session 分享到对话中。

如果 Bot 没有回复，先按 [排查问题](../operations/troubleshooting.md) 收集允许状态、Invocation 和错误事件；沉默也可能是模型的正常决定。
