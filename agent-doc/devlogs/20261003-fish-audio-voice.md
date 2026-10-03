# 2026-10-03：Fish Audio 同步语音发送

## 来源与边界

Fish Audio TTS 客户端移植自 [beiwater/jingmei](https://github.com/beiwater/jingmei) 的 [`src/tools/fish-tts.ts`](https://github.com/beiwater/jingmei/blob/main/src/tools/fish-tts.ts)，上游采用 BSD-2-Clause 许可证。当前客户端位于 `src/voice/fish-tts.ts`，仅负责返回有界 MP3 字节与稳定错误码；Telegram 交付仍由现有 `send` Tool 负责。

没有移植 jingmei 的 runtime 关键词启发式：用户说到某些词并不强迫 runtime 输出语音。是否说话、是否用语音由模型决定；只有配置了 `voice` 时，send Tool 描述才增加适用场景和禁止模仿真人、受版权保护角色的指导。

## 为什么选择同步

短句 TTS 的用户意图是“把这句话说出来”，不需要先创建生成任务、跨运行等待，再取得引用交付。当前版本直接采用 `send kind:voice`：一次 Tool Call 内完成合成和发送，不引入第二条生命周期、调度或持久化路径。

同步不等于绕过时效判断。合成结束后才执行既有的 abort/deadline 检查和 send 屏障，因此合成期间的新消息可以拦下已经过时的回复。合成失败或发送前被拦下都不是 Telegram 发送，不写 `telegram_sends`，也不消耗发送窗口额度。模型从工具结果知道没有发送，应改用文本，而不是等待后台补发。

### 留在归档分支的替代方案

早期异步生成与完成回执方案保留在 `archive/voice-async-receipts` 分支，供未来音乐生成这种更长耗时任务参考。该方案的 `voice_generate`、`voice_id`、`voice_clips`、receipts、音频 BLOB 与保留清理都不是本分支的实现，不能作为当前配置、运维或调用文档。

## 当前调用契约

- 可选顶层 `voice`：`api_key` 为 SecretRef，`reference_id` 为 32 位十六进制声音模型 ID，`model` 可省略，默认 `s2.1-pro-free`，也可选 `s2.1-pro`。缺省禁用。
- `voice` 与 `voice.` 分别列入热更新路径和前缀。每次 Invocation 从 active 配置构建 send Tool，每段音频重新解析 API key；配置应用或 key jar 轮换从下一次 Invocation 生效。
- `send kind:voice` 的 `text` 是 1–1000 字符的实际口语正文；不能与 `parse_mode`、`sticker_ref`、`image_generation_id` 混用。
- 客户端 POST `https://api.fish.audio/v1/tts`，请求 MP3，45 秒超时、8 MiB 响应上限。固定顺序为：合成 → abort/deadline → send 屏障 → 发送限流 → pending 审计 → Telegram `sendAudio`。
- 交付文件名 `voice-reply.mp3`，caption 为 `🎙️ <text>`；不使用 `sendVoice`。音频不落库、不写文件。

## 审计与数据变更

合成拒绝仅记录在 `tool_calls`：`voice_disabled`、`voice_text_too_long`、`voice_<fish code>` 或 `voice_synthesis_error`；合成期间取消记为 `aborted`。Fish code 包含 `missing_api_key`、`invalid_input`、`invalid_options`、`http_error`、`invalid_response`、`audio_too_large`、`timeout`、`network_error`。Provider 响应体与密钥不保存、不记录到日志。失败结果明确告诉模型没有发送任何消息，应改用文本。

迁移 `026_voice_send_kind.sql` 沿用 `025` 的表重建方式，仅让 `telegram_sends.kind` 的 CHECK 接受 `voice`，没有新增表。成功后 Bot 的消息 revision kind 为 `voice`、caption 为 `🎙️ <text>`，没有媒体行；仅保留正常消息历史、工具及发送审计，没有额外音频备份对象。

没有独立语音服务、启动日志事件、doctor 探针、Admin UI 或语音生成 Skill。用户操作、配置和导航已经同步补充到文档站，配置示例使用 `{ "jar": "fish_audio" }` 与合法长度的占位声音模型 ID，不包含明文密钥。

## 文档与验证边界

实现细节以 `src/voice/`、`src/capabilities/send-tool.ts`、`src/platform/config.ts`、`src/platform/config-diff.ts` 与迁移 `026` 为准；维护文档见 [Telegram 与 Agent 流程](../telegram-agent-flow.md#同步语音发送)、[配置](../configuration.md#voice-语音发送)、[数据层](../data-layer.md)。

本次文档更新阅读了 `test/docs-examples.test.ts` 的示例加载与片段合并规则，示例只使用 Schema 接受的 SecretRef、模型枚举和 32 位十六进制 ID。此次文档工作未运行测试、lint 或构建，不声明外部 Fish Audio / Telegram 验收结果。
