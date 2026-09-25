# Plastic Wan - 20260926 Forum Topic 作用域修正：`/cut_topic`、启动补偿与 Supergroup 迁移

## 背景

open-code-review 全量扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）报告了三处与 Forum Topic / Chat 作用域相关的问题。逐条对照源码确认都成立：

- `/cut_topic` 的切点按 Chat 存（`chat_context_cutoffs`，每 Chat 一行），但清空的 Conversation Context 只属于命令所在的 Topic。在 Forum 里切 Topic A，Topic B 之后的 history 快照也会把切点前的消息排除掉，而 B 保留的 Context 里仍然有这些消息，两处看到的历史互相矛盾。同一处 upsert 还会无条件覆盖切点，一条更旧的命令可以把切点往回挪。
- 启动补偿（`finishStartupCatchUp`）排名、筛选和分组都按 `chat_id`，但建出来的 Bucket、Invocation 和参与闸门判断只用最新一条消息的 `conversation_id`。停机期间两个 Topic 都有消息时，它们会进同一个 Invocation（快照不按 conversation 过滤），参与判断也只看最新那个 Topic。在连续 Context 之下，这等于把 Topic A 的消息永久写进 Topic B 的 canonical history。
- Supergroup 迁移的记录（`#recordMigration`）在 allowlist 与 Topic 校验之后才执行。如果 Bot 先看到的是新 Supergroup 里的 `migrate_from_chat_id` 通知，此时新 ID 还没有映射，这条通知直接被拒，而它本来就是用来授权新 ID 的那条消息。之后新群的所有消息都会被拒。

`agent-doc/telegram-agent-flow.md` 原来写的是「`/cut_topic` 同样是 Chat 级命令」，但命令名和 Context 清空逻辑都是按 Topic 来的，这次统一改成 Conversation 级。

## 主要变更

### 1. `/cut_topic` 切点改为每 Conversation 一行

新增迁移 `src/store/migrations/019_conversation_context_cutoffs.sql`：建 `conversation_context_cutoffs`（`conversation_id` 为主键，`ON DELETE CASCADE`），然后删除 `chat_context_cutoffs`。命令消息本身不入 `messages`，已有的 Chat 级切点没法追溯到具体 Topic，所以迁移把它复制到该 Chat 的每一个 Conversation，保持迁移前的实际效果：

```sql
INSERT INTO conversation_context_cutoffs (conversation_id, telegram_message_id, created_at, updated_at)
SELECT v.id, c.telegram_message_id, c.created_at, c.updated_at
FROM chat_context_cutoffs c
JOIN conversations v ON v.chat_id = c.chat_id;
```

`src/store/schema.ts` 中的 `chatContextCutoffs` 同步改为 `conversationContextCutoffs`。

两处读取切点的查询（`src/store/invocation-snapshot.ts` 的 history 快照、`src/ingress/telegram-ingestion.ts` 的 `#adoptPendingBotMessages`）改成按消息自己的 conversation 取切点：

```sql
AND m.telegram_message_id > COALESCE(
  (SELECT telegram_message_id FROM conversation_context_cutoffs WHERE conversation_id = m.conversation_id), -1)
```

`#adoptPendingBotMessages` 不再需要 join `conversations`，已一并删除。

`BotCommandService.#cutTopic`（`src/orchestration/bot-commands.ts`）先定位 Conversation，再在同一个分支里写切点、中断运行、清空 Context。冲突更新改为取较大值，保证切点只前移：

```ts
          set: {
            telegramMessageId: sql`MAX(${conversationContextCutoffs.telegramMessageId}, excluded.telegram_message_id)`,
            updatedAt: timestamp,
          },
```

该 Topic 还没有 Conversation 行时，说明它没有任何入库消息，不写切点。

### 2. 启动补偿按 Conversation 分组

`finishStartupCatchUp`（`src/orchestration/invocation-queue.ts`）里的窗口函数改为 `PARTITION BY conversation_id`，可触发消息的筛选改为 `conversation_id IN (...)`，排序与分组 key 也换成 `conversation_id`。每个 Conversation 取自己最新的 `agent.history_messages` 条消息，建自己的 Bucket 与 Invocation，参与闸门也按自己判断。同一 Chat 的多个 queued Invocation 由 Scheduler 现有的「同 Chat 不并发运行」规则串行启动，不需要额外处理。

### 3. 迁移通知先于授权记录

`#ingestTransaction` 在计算 `topics` 之前调用 `#recordMigration`。为了不让任意群借助伪造的 `migrate_from_chat_id` 获得授权，`#recordMigration` 只在旧 ID 本身被允许（`#topicsFor(oldChatId) !== null`，含链式迁移）时才写 `chat_migrations`。原来授权之后的那次调用已删除。

### 4. 文档

- `agent-doc/telegram-agent-flow.md`：`/cut_topic` 改为 Conversation 级命令，写明切点只前移、Topic 间互不影响；启动补偿改为每 Conversation 一个 Bucket；补充迁移通知先于授权记录的规则。
- `agent-doc/architecture.md`、`agent-doc/data-layer.md`、`agent-doc/verification.md` 同步。

### 5. 测试

- `test/cut-topic.test.ts`：已有用例改查新表；新增「Forum 中切 Topic 100 后，Topic 100 的 history 为空、Topic 200 仍能看到 `topic B old`」，以及「更旧的切点不会覆盖更新的切点」。
- `test/startup-catch-up.test.ts`：原用例「每 Chat 一个 Invocation」断言的正是跨 Topic 合并的旧行为（每条消息一个 Topic 却只建 2 个 Invocation），改为每个 Chat 只用一个 Topic，断言不变；原「Reply 路由到可见消息的 Topic」用例依赖同一个 Invocation 里有两个 Topic，改为「同群两个 Topic 分成两个 Invocation，各自的 prompt 只含自己 Topic 的消息，发送各自落回自己的 Topic」。
- `test/telegram-ingestion.test.ts`：新增「先看到 `migrate_from_chat_id` 也能授权新 Supergroup」与「未被允许的旧 ID 不能借迁移通知获得授权」。
- `test/foundation.test.ts`：迁移数量 18 → 19。

## 验证

```bash
pnpm vitest run test/telegram-ingestion.test.ts test/startup-catch-up.test.ts test/cut-topic.test.ts
# Tests 32 passed (32)

pnpm run check
# 通过（后端 tsc + admin-next tsc）

pnpm run lint
# Checked 250 files / Checked 248 files，No fixes applied

pnpm test
# Test Files 45 passed (45) / Tests 502 passed (502)

git diff --check
# 无输出
```

反向验证：临时把三处修复撤回（迁移记录挪回授权之后、分组 key 改回 `chat_id`、history 快照改回取整个 Chat 的切点），重跑上面三个文件：

```bash
# × cut_topic in one forum topic leaves the other topics' history alone
# × authorizes the new supergroup from a migrate_from notice seen first
# × keeps forum topics of one chat in separate invocations
# Tests 3 failed | 29 passed (32)  —— 随后恢复实现
```

迁移验证：用 `sqlite3 .backup` 复制 dev 库，在副本上执行 019。迁移前 `chat_context_cutoffs` 有 1 行（chat 3，切点 979，该 Chat 有 1 个 Conversation），迁移后 `conversation_context_cutoffs` 为 `(3, 979)`，`PRAGMA foreign_key_check` 无输出。

还没做的：

- 真实 Forum 群验收：在一个 Topic 执行 `/cut_topic`，确认另一个 Topic 的下一次回复仍能看到切点前的 history。
- 迁移前已存在的 Chat 级切点会复制到该群所有 Topic，仍会作用于没执行过命令的 Topic；如需精确到 Topic，需要人工删掉多余的行。
- 同一次扫描里 `/cut_topic` 的另一条问题（`abortConversation` 只发信号、不等运行结束就清空 Context）不在本次范围内。

## 提交

```txt
19935ee Scope cut_topic, startup catch-up, and migrations per conversation
```
