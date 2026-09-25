# Plastic Wan - 20260926 attach 路径补上睡眠与 Chat 配置闸门

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）指出 `InvocationQueueService.#attachBucket`（`src/orchestration/invocation-queue.ts`）绕过了开新运行时的闸门，确认成立：

- 睡眠中（`bot_sleep_until` 生效）：它只调用 `#logSleepingSkip` 打一条「跳过」日志，然后照样 `attachBucketToInvocation`，再 `queueInjection`。`queueInjection` 会唤醒处于 `idle_grace_seconds` 空闲等待里的运行，运行随即注入这批消息、再跑一轮模型调用。`AgentRuntime` 在睡眠时会拦下 `zzz` 以外的 Tool Call，所以这一轮只是白白消耗 token，日志里还写着「skipped」。
- Chat 已移出配置：`#queueBucket` 会记为 `chat_removed`，attach 路径完全没检查，已移除的 Chat 仍可以通过正在运行的 Invocation 收到新批次。

`agent-doc/telegram-agent-flow.md` 写的是「睡眠期间 Scheduler 将到期 Bucket 标记为 `skipped_budget`/`sleeping`，不创建新 Agent」，attach 路径的实际行为和文档不一致。

## 主要变更

### 1. `#attachBucket` 先过闸门再 attach

查到 Chat 之后、attach 之前：

```ts
    if (resolveChatConfig(this.#configStore.current().config, this.#store.orm, chat.telegram_chat_id) === undefined) {
      this.#markBucketSkipped(bucket.id, now, 'chat_removed');
      return true;
    }
    if (sleepUntil !== null) {
      this.#markBucketSkipped(bucket.id, now, 'sleeping');
      this.#logSleepingSkip(chat.telegram_chat_id, bucket.id, invocationId, sleepUntil);
      return true;
    }
```

返回 `true` 表示这个 Bucket 已经处理完（`processDue` 直接 `continue`），不会再走开新运行的分支，也不会通知 runtime。跳过的 Bucket 与 `#queueBucket` 一样记为 `skipped_budget` 加原因码，不写 `invocation_buckets`。原来 attach 之后那次 `#logSleepingSkip` 已删除，`agent_session_skipped_sleeping` 日志现在只在真正跳过时输出。

暂停不需要在这里再判断：due 查询本身就排除了 `chat_pause` 里的 Chat。Chat 查询里原来那个没用上的 `paused` 列也一起删掉了，留了一行注释说明原因。

### 2. 文档

- `agent-doc/telegram-agent-flow.md` 睡眠一节补充：本该 attach 到运行中 Invocation 的到期 Bucket 同样跳过、不注入；Chat 已移出配置时记为 `chat_removed`。
- `agent-doc/verification.md` 更新 `context-hot-inject.test.ts` 的覆盖说明。

### 3. 测试

`test/context-hot-inject.test.ts` 新增 `a batch that comes due while the bot sleeps is skipped instead of attached`：用 stub attachment 记录 `queueInjection` 调用；开场 Invocation 置为 `running` 后写入 `bot_sleep_until`，再收一条消息并让它到期。断言如下：

- `processDue` 返回 `[]`，`queueInjection` 没有被调用；
- 第二个 Bucket 为 `skipped_budget` / `sleeping`；
- `invocation_buckets` 里没有这个 Bucket。

`chat_removed` 分支和 `#queueBucket` 共用同一个 `resolveChatConfig` 判断，这次没有单独加用例。

## 验证

```bash
pnpm vitest run test/context-hot-inject.test.ts -t "sleeps"
# Tests 1 passed | 25 skipped (26)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 45 passed (45) / Tests 507 passed (507)

git diff --check
# 无输出
```

反向验证：`git stash` 掉 `src/orchestration/invocation-queue.ts`：

```bash
pnpm vitest run test/context-hot-inject.test.ts -t "sleeps"
# × a batch that comes due while the bot sleeps is skipped instead of attached
# AssertionError: expected [ 2n ] to deeply equal []
# —— 随后 stash pop 恢复实现
```

行为变化：睡眠期间，运行中的 Invocation 不会再被新消息续命，会在空闲等待结束后自然退出。睡眠期间跳过的批次与原来一样不会重放。

还没做的：

- 真实环境验收：让 Bot `zzz` 后在空闲等待窗口内发消息，确认日志出现 `agent_session_skipped_sleeping` 而不是 `bucket_attached`，且没有新的 `model_calls` 行。

## 提交

```txt
d00fa66 Skip batches due during sleep instead of attaching them
```
