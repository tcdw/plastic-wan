---
title: 第一次运行塑料碗
description: 从源码构建 Docker 镜像，配置 Telegram 和模型后启动 Bot。
---

# 第一次运行塑料碗

本路径从你选定的源码提交构建 `plasticwan:local`，不假定远端 `latest` 镜像与文档对应。需要 Docker Compose、一个 Telegram Bot、可调用的文本和图片模型，以及你要允许的一个私聊或群聊。

## 1. 准备目录与文件

在**源码仓库根目录**执行：

```bash
mkdir -p config data
cp apps/docs/examples/config.example.jsonc config/config.jsonc
cp apps/docs/examples/system-prompt.example.md config/system-prompt.md
cp apps/docs/examples/compose.yml compose.yml
```

编辑 `config/config.jsonc`：

- 将 `telegram.chats[0].id` 改为允许使用 Bot 的 Chat ID；私聊 ID 为正数，群/Supergroup 通常为负数。
- 替换 `base_url`、模型 `id` 与显示名。模型必须真实存在，且同时支持 `text` 与 `image`；示例中的占位模型不可直接运行。
- 保留容器路径 `/data`，Prompt 文件与配置放在同一 `config/` 目录。

## 2. 安全提供密钥

不要把 Token 或 API key 写入配置、Compose 文件或聊天。为当前 shell 设置环境变量，或由部署系统注入：

```bash
export TELEGRAM_BOT_TOKEN='…'
export PLASTICWAN_API_KEY='…'
```

Telegram 官方说明 Bot 由 [@BotFather](https://t.me/BotFather) 创建；不要将它返回的 Token 发给协助部署的 Agent。群聊需要 Bot 能收到你希望它处理的消息，见 [接入 Telegram](../configure/telegram.md)。

## 3. 构建并检查配置

```bash
docker build -t plasticwan:local .
docker compose run --rm plasticwan check-config --config /config/config.jsonc
```

`check-config` 成功后才继续。它不连接 Telegram 或模型；需要真实连通性检查时，在获准消耗少量 Token 的环境运行 `doctor`。

## 4. 启动并验证

```bash
docker compose up -d
docker compose logs -f plasticwan
```

日志出现 `serve_started` 表示服务已开始轮询。向允许的 Chat 发送一条消息，等待配置的 `bucket_window_seconds`。模型可以选择沉默；要区分未触发与主动不发言，请看 [排查问题](../operations/troubleshooting.md)。

管理面板发布在 `127.0.0.1:8787`，首次访问创建本地管理员账号。不要把该端口直接公开到互联网，见 [管理面板](../configure/admin.md)。

## 下一步

- 调整 Prompt：[配置文件与密钥](../configure/config-file.md)
- 为群或 Topic 设置边界：[Telegram 接入](../configure/telegram.md)
- 了解模型和预算：[模型](../configure/models.md) 与 [配置参考](../reference/config.md)
