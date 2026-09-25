# Plastic Wan - 20260926 注入确认改到落库之后，异常运行驱逐 Agent 缓存

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）对 `src/orchestration/agent-runtime.ts` 报了两条 high。

1. **steer 之后立刻标记已注入。** `injectPending` 调用 `agent.steer(message)` 之后马上 `#markBucketInjected`。`steer` 只是把消息放进 Agent 的队列，还没写进 transcript。扫描原文认为 abort 会让这条消息丢失。核对 `pi-agent-core` 0.84.2 的 `agent-loop.js` 后发现：`shouldStopAfterTurn` 返回 false 之后，Pi 会立即 `getSteeringMessages()`，并在下一轮开头直接发 `message_end`，中间不检查 abort。所以单纯 abort 不会丢这条消息（实测 abort 后这批仍然落库了）。真正会丢的是异常路径：steer 进来的消息在 `message_end` 里落库失败时，Pi 的 `runWithLifecycle` 会把监听器抛出的错误转成一条失败的 assistant 消息，运行以 `failed` 结束。这批的 bucket 已经带着 `injected_at`，`releaseUninjectedBuckets` 跳过它，它既不在 canonical history 里，也不会被重新排队。
2. **只有模型错误才驱逐缓存。** `finally` 里只有 `agent.state.errorMessage !== undefined` 时才 `runtime.forget`。Pi 的 `processEvents` 会先把消息 push 进 `state.messages`，再调用监听器。如果监听器（`#persistMessage` / `recordAgentMessage`）连续失败，比如消息本身和 Pi 为它生成的失败消息都写不进去，`prompt()` 会直接抛出，而 `errorMessage` 没有被设置（它只在 `turn_end` 时写入）。这时缓存条目保留着和 `transcriptSeqs` 分叉的 `state.messages`，下一次运行会复用这份不一致的 transcript。

## 主要变更

### 1. bucket 在消息落库后才确认注入

`pendingUserTags` 原来只记录每条交给 Agent 的 user 消息是 `checkpoint` 还是 `harness`，现在每一项同时带上 bucket：

```ts
    const pendingUserTags: { readonly tag: 'checkpoint' | 'harness'; readonly bucketId: bigint | null }[] = [];
```

`injectBatch(bucketId)` 放入 `{ tag: 'checkpoint', bucketId }`，nudge 放入 `{ tag: 'harness', bucketId: null }`。`message_end` 监听器在 `#persistMessage` 成功之后才确认：

```ts
      const pendingUser = event.message.role === 'user' ? pendingUserTags.shift() : undefined;
      this.#persistMessage(cached, invocationId, event.message, pendingUser?.tag === 'checkpoint');
      if (pendingUser !== undefined && pendingUser.bucketId !== null) {
        this.#markBucketInjected(invocationId, pendingUser.bucketId);
      }
```

`injectPending` 和开场注入里原来的两处 `#markBucketInjected` 都删掉了，开场 bucket 也走同一条路径。开场 bucket 本来就被 `releaseUninjectedBuckets` 和 Admin 取消排除在外，所以它的 `injected_at` 晚一点写入不影响任何判断。

效果：落库失败 → 不写 `injected_at` → 运行结束时由 scheduler 的 `releaseUninjectedBuckets` 重新排队成新 Invocation。同时第 2 条修复会驱逐缓存，新 Invocation 从 canonical history 播种，这批只会进入历史一次。

### 2. 异常退出也驱逐缓存

```ts
      if (outcome === undefined || agent.state.errorMessage !== undefined) {
        runtime.forget(conversationId);
      }
```

`outcome` 只在 `try` 正常走完时赋值，所以 `undefined` 就表示抛出了异常。

### 3. 文档

- `agent-doc/telegram-agent-flow.md`：`injected_at` 的写入时机；缓存驱逐条件补上「抛出异常的运行」，并说明原因（Pi 先 push 再调用监听器）。
- `agent-doc/verification.md` 更新 `context-hot-inject.test.ts` 的覆盖说明。

### 4. 测试

`test/context-hot-inject.test.ts` 新增两条，都用 SQLite 触发器制造落库失败：

- `a steered batch whose transcript write fails is re-queued, not lost`：真实 scheduler 加 runtime，`idle_grace_seconds = 2`。第一批回答后，第二条消息在空闲等待期间被 attach、steer。触发器只在「只有 1 个 Invocation」时拒绝写入内容含 `second` 的 `context_messages`。断言如下：
  - Invocation 1 为 `failed`；
  - `bucket_id = 2` 的新 Invocation 跑完为 `completed`；
  - canonical history 的 user 行恰好两条，第二条含 `second`。
- `a run that throws drops its cached agent so the next run replays durable history`：第二次运行期间，触发器让 `context_messages` 和 `agent_messages` 的插入都失败，`runtime.run` 抛出 `disk I/O error`。第三次运行应以 `completed` / `completed` 结束，保留历史为 `user, assistant, user, assistant`（只有第一次与第三次运行）。

扫描里的原始场景（abort 丢掉 steer）按上文分析在当前 Pi 版本不会发生，所以测试针对的是实际会丢批次的路径。

## 验证

```bash
pnpm vitest run test/context-hot-inject.test.ts
# Tests 29 passed (29)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 45 passed (45) / Tests 511 passed (511)

git diff --check
# 无输出
```

反向验证：

```bash
# git stash 掉 agent-runtime.ts：
# × a steered batch whose transcript write fails is re-queued, not lost
#   Error: Timed out waiting for the re-queued batch to run as its own invocation

# 只把驱逐条件改回 `agent.state.errorMessage !== undefined`：
# × a run that throws drops its cached agent so the next run replays durable history
#   AssertionError: expected { state: 'failed', … } to deeply equal { state: 'completed', … }
# 两次均随后恢复实现
```

还没做的：

- 扫描里 agent-runtime 的其他 high（`#startModelCall` 写库失败时模型 gate 不释放、`#finishModelCall` 记账失败被吞掉）不在本次范围内。
- 升级 `pi-agent-core` 时需要重新确认「steer 之后到下一轮 `message_end` 之间不检查 abort」这一点。即使行为变了，现在的写法也是正确的，只是会多一条会重新排队的路径。

## 提交

```txt
fa56c09 Acknowledge injected batches only once they are persisted
```
