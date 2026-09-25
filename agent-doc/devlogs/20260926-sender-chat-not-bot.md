# Plastic Wan - 20260926 匿名管理员与频道身份消息不再被当成 Bot

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）指出 `src/ingress/telegram-ingestion.ts` 判断 Bot 消息时只看 `message.from.is_bot`。

Telegram 对「代表某个 Chat 发出」的消息会在 `from` 里放一个占位 Bot，真正的作者在 `sender_chat`：

- 匿名群管理员：`from` 是 GroupAnonymousBot（`is_bot: true`），`sender_chat` 是群本身。
- 以频道身份在群里发言、关联频道自动转发到讨论组：`from` 是 Channel_Bot，`sender_chat` 是频道。

`process_bot_messages` 默认为 `false`，所以这些消息只留下 Update 审计，完全不入库。开了匿名管理员的群里，管理员说的话 Bot 根本看不到。开启 `process_bot_messages` 也不能解决：它们会被当成 Bot 消息，永远不能开 Bucket。

同一个文件里的 `#upsertSender` 早已把 `sender_chat` 发送者记为 `is_bot = 0`，启动补偿的可触发判断也读这个字段。实时入库和启动补偿对同一条消息的判断因此不一致。

## 主要变更

### 1. `fromBot` 排除 `sender_chat`

`#storeMessage`（`src/ingress/telegram-ingestion.ts`）：

```ts
    const fromBot = message.sender_chat === undefined && message.from?.is_bot === true;
```

`fromBot` 同时决定「是否丢弃」和 `eligibleHuman`，这一行改完，两处都会把这类消息当作真人消息：入库、可以开 Bucket、参与 participation 判断。自己发出的消息仍按 `from.id === botId` 忽略，不受影响。

没有改的地方：`CORE_AGENT_PROTOCOL` 里「username 以 bot 结尾视为 Bot」的提示语启发式（扫描里另一条 medium）。改它要升 `AGENT_PROMPT_VERSION`，所有 Conversation Context 都会重建，不在本次范围内。

### 2. 文档

- `agent-doc/configuration.md` 的 `process_bot_messages` 一节补充：带 `sender_chat` 的消息不算 Bot 消息。
- `agent-doc/verification.md` 更新 `telegram-ingestion.test.ts` 的覆盖说明。

### 3. 测试

`test/telegram-ingestion.test.ts` 新增 `an anonymous admin message is a human message despite its placeholder bot sender`：

- `from` 为 GroupAnonymousBot、`sender_chat` 为群本身的消息会入库并开 Bucket，`senders` 行为 `telegram_type = 'sender_chat', is_bot = 0`。
- 没有 `sender_chat` 的真实 Bot 消息在默认配置下仍返回 `{}`，不入库。

## 验证

```bash
pnpm vitest run test/telegram-ingestion.test.ts
# Tests 16 passed (16)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 45 passed (45) / Tests 503 passed (503)

git diff --check
# 无输出
```

反向验证：把 `fromBot` 临时改回 `message.from?.is_bot === true`：

```bash
pnpm vitest run test/telegram-ingestion.test.ts
# × an anonymous admin message is a human message despite its placeholder bot sender
# AssertionError: expected undefined to be defined
# Tests 1 failed | 15 passed (16)  —— 随后恢复实现
```

行为变化与风险：

- 关联频道的自动转发（讨论组里的频道帖子）现在也会开 Bucket。如果某个群绑定了发帖频繁的频道，Bot 可能会对频道帖子做出反应；是否回复仍由模型决定。需要屏蔽时，目前只能靠人格 Prompt 约束，`ignored_user_ids` 不匹配 `sender_chat`。

还没做的：

- 真实群验收：开启匿名管理员后用管理员身份 @Bot，确认产生 Invocation。

## 提交

```txt
5bf734b Treat messages sent on behalf of a chat as human messages
```
