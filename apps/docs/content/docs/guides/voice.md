---
title: 让碗用语音说话
description: 配置 Fish Audio，让 Agent 在一次 send 调用中同步合成并发送简短语音。
---

# 让碗用语音说话

语音是 `send` 的一种发送形式，不需要安装 Plugin 或 MCP。配置 Fish Audio 后，Agent 可以在同一次 `send kind:voice` 调用里合成 MP3，再发送到当前 Telegram 会话。没有 `voice` 配置时语音禁用，文本功能不受影响。

## 配置 Fish Audio

准备 Fish Audio API key 和一个 32 位十六进制的声音模型 ID。在完整配置中加入以下局部片段（不是可独立运行的配置）：

```jsonc
{
  "voice": {
    "api_key": { "jar": "fish_audio" },
    "reference_id": "0123456789abcdef0123456789abcdef",
    "model": "s2.1-pro-free"
  }
}
```

- 将真实 API key 放入配置同目录 `key.json` 的 `fish_audio` 条目；配置只保留 SecretRef，不能写明文密钥。也可使用环境变量或固定命令引用，见[配置文件与密钥](../configure/config-file.md)。不要提交或交给 Agent 阅读 `key.json`。
- `reference_id` 示例只是占位值，替换成实际的 Fish Audio 声音模型 ID。
- `model` 可省略，默认 `s2.1-pro-free`；也可选 `s2.1-pro`，其他值不接受。
- 服务必须能访问 `https://api.fish.audio/v1/tts`。

检查配置后，通过 Admin 的 **Apply config file** 或 Telegram `/model` 应用。`voice` 整段的增删、密钥引用和模型字段都可热应用，不需要重启；没有文件监视器或独立语音设置页。每次 Invocation 使用 active 配置构建 send Tool，合成每段音频时重新解析 API key，所以配置应用或 key jar 轮换从下一次 Invocation 生效。

## 什么时候会说话

用户可以明确要求“用语音回复”或“读出来”。只有配置了语音时，send Tool 描述才会增加语音指导：明确请求语音、朗读，或一句简短口语确实增加价值时使用，其他情况默认文本。模型决定是否调用语音，运行时不会靠关键词强制语音回复。不要要求模仿真人或受版权保护的角色。

模型调用形式示意：

```json
{ "kind": "voice", "text": "好的，我听到了。" }
```

这里的 `text` 就是实际要说的话，长度为 1–1000 字符，使用中文、日文或英文的普通口语，而不是声音生成指令。不能同时传 `parse_mode`、`sticker_ref` 或 `image_generation_id`；可选的回复目标仍须经过当前会话的引用授权。

## 合成与发送顺序

一次调用按以下顺序执行：

1. 校验输入并向 Fish Audio 同步合成 MP3（45 秒超时，音频最大 8 MiB）。
2. 合成结束后检查运行是否取消、是否超过 Invocation deadline。
3. 经过正常 send 屏障：合成期间有新消息到达且触发屏障时，先让模型读新消息，不发送旧回复。
4. 检查 Chat 发送限流、写入正常发送审计，再调用 Telegram `sendAudio`。

Telegram 收到的是文件名为 `voice-reply.mp3` 的音频附件，caption 为 `🎙️ <text>`，不是 `sendVoice` 的语音气泡。音频只在内存中传递，不存数据库或本地文件。成功消息进入正常历史，revision kind 为 `voice`，caption 保存所说文本，没有额外媒体行；正常调用和发送审计照常保留。

## 失败时怎么办

合成失败不算发送：没有 Telegram 发送，也没有 `telegram_sends` 行。工具错误会明确告诉模型没有发送任何消息，应改用文本。不要把工具调用本身当成交付成功。

在管理面板的 Tool call 审计中查看稳定错误码：

| 错误码 | 原因 |
| --- | --- |
| `send_input_invalid` | 语音参数缺失或与其他发送类型字段混用 |
| `voice_disabled` | 没有启用 `voice` 配置 |
| `voice_text_too_long` | 正文超过 1000 字符 |
| `voice_missing_api_key` | 密钥缺失、空值或解析失败 |
| `voice_invalid_input`、`voice_invalid_options` | 合成输入或选项不合法 |
| `voice_http_error`、`voice_invalid_response` | 上游请求失败或未返回有效音频 |
| `voice_audio_too_large` | 音频超过 8 MiB |
| `voice_timeout`、`voice_network_error`、`voice_synthesis_error` | 超时、网络故障或其他合成异常 |
| `aborted` | 合成期间运行被取消 |

合成成功后仍可能遇到既有的 `deadline_exceeded`、`send_barrier` 或 `send_rate_limited`；被拦下的音频不持久保存，也不会稍后自动投递。Provider 响应体和密钥不保存、不写日志；没有新增语音日志事件或 doctor 探针。

相关页面：[配置参考](../reference/config.md)、[用量控制](budgets.md)、[Skills、Plugin 与 MCP](extensions.md)。
