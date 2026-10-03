---
title: 配置文件与密钥
description: 编辑严格 JSONC 配置，安全引用密钥并确认变更何时生效。
---

# 配置文件与密钥

Plastic Wan 读取严格 JSONC：未知字段、无效模型引用和不合法的跨字段组合都会被拒绝。下载 [完整样例](__DOCS_BASE__/examples/config.example.jsonc) 和 [Prompt 样例](__DOCS_BASE__/examples/system-prompt.example.md)，不要把局部片段当作独立配置。

## 文件布局

Docker 部署中将这些文件放入同一个宿主机 `config/` 目录：

```text
config/
├── config.jsonc
└── system-prompt.md
```

`system_prompt_file` 和每群 `instructions_file` 相对**配置文件目录**解析；`data_dir` 与 `paths.*` 则按服务工作目录解析，容器请使用 `/data/...`。

## 引用密钥

配置不接受明文 Token 或 API key。使用环境变量、同目录 key jar，或固定 argv 命令引用：

```jsonc
{
  "telegram": { "token": { "env": "TELEGRAM_BOT_TOKEN" } },
  "providers": {
    "gateway": { "api_key": { "env": "PLASTICWAN_API_KEY" } }
  }
}
```

`{ "jar": "name" }` 只引用同目录 `key.json` 中的条目，不能将该文件提交、上传到文档站或交给 Agent 阅读。生产环境优先让 Compose、supervisor 或密钥管理器注入环境变量。

## 可选语音配置

需要语音时，在完整配置中加入以下局部片段；没有 `voice` 段即禁用语音：

```jsonc
{
  "voice": {
    "api_key": { "jar": "fish_audio" },
    "reference_id": "0123456789abcdef0123456789abcdef",
    "model": "s2.1-pro-free"
  }
}
```

将实际 API key 写入同目录 `key.json` 的 `fish_audio` 条目，配置里只保留 SecretRef。`reference_id` 是 32 位十六进制 Fish Audio 声音模型 ID，须替换示例占位值。`model` 可省略，默认 `s2.1-pro-free`，也可选 `s2.1-pro`。使用与失败处理见[语音指南](../guides/voice.md)。

## 检查、应用与重启

每次编辑后先检查：

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
```

没有文件监视器。Prompt、Provider、全局/既有 Chat 的模型覆盖、部分预算和并发可以通过 Admin 的 **Apply config file** 或 `/model` 热应用；`telegram.chats` 的增删、allowlist、MCP、Admin、数据路径和多数其他字段必须重启。`retention` 与备份路径只在下一次 `backup` 使用。

`voice` 整段及所有子字段可热应用，包括启用、禁用、声音模型和密钥引用；下一次 Invocation 会用 active 配置构建 send Tool，每段音频重新解析 API key，因此配置应用或 key jar 轮换从下一次 Invocation 生效。不提供独立语音设置页面。

成功热应用看 `config_reloaded` 的 `active_hash` 与 `file_hash`；重启后看 `serve_started.config_hash` 与 `check-config` 输出是否相同。详细字段见 [配置参考](../reference/config.md)。

## 风险

Prompt 变化会让相关 Conversation 的 Context 在下一次运行时重建。先备份并评估对话影响，不要用配置热应用代替数据库迁移或恢复验证。
