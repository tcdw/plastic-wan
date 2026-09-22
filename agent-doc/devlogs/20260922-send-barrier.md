# Plastic Wan - 20260922 send 屏障：回复发出前先读完新消息

## 背景

群里经常出现这样的情况：一个人把一句话分成几条发，塑料碗却对每一条分别回复一次。

Bucket 节拍的规则见 `agent-doc/telegram-agent-flow.md`「会话节拍与 Bucket」。deadline 是 `max(第一条消息时刻, 上一轮结束时刻) + telegram.bucket_window_seconds`，本地配置取 15 秒。到期后 Bucket 冻结并注入。同一 Conversation 一轮进行中到达的消息进入下一个 `collecting` Bucket，要等「该轮结束 + 一个窗口」才注入，模型会再回复一次。

从本地审计库查到 2026-09-22 下午的三次连回（表内时间为 UTC），全部是后一条消息只比 deadline 晚了一点，被切进了下一个 Bucket，然后在同一个 Invocation 里被单独回复：

| 前一批 | deadline | 下一条到达 | 晚了多少 | Invocation |
| --- | --- | --- | --- | --- |
| B3733（Henri 两条） | 06:07:47 | 06:07:50.5 | 约 3 秒 | inv1153 |
| B3736（ホロ 一张图） | 06:20:17.08 | 06:20:17.31 | 约 0.2 秒 | inv1155 |
| B3738（Henri 一条） | 06:25:52.04 | 06:25:52.42 | 约 0.4 秒 | inv1156 |

### 放弃的方案：jev hold 闸门

最初的方案是在 Bucket 到期时加一道快速判断，由 TypeSafe 的 jev 决定是立即 fire 还是再 hold x 秒，总共最多多等 X 秒。jev 是 System One 决策模型，走 OpenRouter 的 `POST /api/alpha/decisions`，不是 chat completions，`noul` 类问题返回 P(yes)。

经用户同意，我们用本地库里最近 7 天交出去的 300 个 realtime Bucket 做了离线回放：

- 在「这批离开 `collecting` 的时刻」重建 jev 会收到的 state。
- 标签定义为：这批关门后 10 秒内，同一个人又发了消息。
- 基线续话率是 43/300 = 14%。

| 判断方式 | AUC |
| --- | --- |
| jev，问「他说完了吗」 | 0.516 |
| jev，直接问「10 秒内还会发吗」 | 0.559 |
| jev，只给待处理消息、不给 history | 0.550 |
| 不用模型：最后一条离到期 ≤3 秒就 hold | 0.659 |

jev 基本是掷硬币的水平（TypeSafe 文档也写明 CJK 的准确率更低），而且单次调用 p50 约 1.9 秒，每次 fire 都要付这段时间。300 次调用的总花费是 $0.013。计时规则比 jev 强，但上面三个原始案例一个都抓不到：它们的续话都是在沉默 8~15 秒之后才来的。

决定方案走向的是另一个数字：**43 次续话中有 37 次（86%）是在 bot 那一轮还没 `send` 时就到了**，上面三个案例都在其中。所以与其在 Bucket 到期时猜会不会有下一条，不如在真要发之前看一眼：是不是已经来了。jev 的客户端、配置和回放脚本都只存在于工作区，改方向时已全部删除，没有进入提交。

约束：

- 发不发、发什么仍由模型决定。runtime 只负责让模型在发之前看到新消息，不规定参与倾向。
- 不能丢回复，也不能让一个一直有人说话的群永远发不出去。
- 注入复用现有的 attach → `queueInjection` → turn 边界 `injectPending` 这条路径，不另建一套。
- 「轮中途不交出批次」的节拍规则只在「本轮第一次真正发送之前」这一个点上破例。

## 主要变更

### 1. `send` 在真正发送前询问屏障

`SendToolEnvironment` 新增可选的 `holdForNewMessages`（`src/capabilities/send-tool.ts:109`）。屏障关闭时不传。检查放在全部输入校验之后、写 pending 审计之前（`src/capabilities/send-tool.ts:205`）：

```ts
// Checked last, so only a send that would otherwise go out is held back:
// an invalid one keeps its own error and the barrier stays unspent.
if (environment.holdForNewMessages?.() === true) {
  recordRejectedSend(environment, toolCallId, input, 'send_barrier');
  throw new Error(SEND_BARRIER_TEXT);
}
```

被拦下的 Tool Call 记为 `error` / `send_barrier`，不写 `telegram_sends`，也不消耗发送配额。模型收到的 Tool 结果是 `SEND_BARRIER_TEXT`（`src/capabilities/send-tool.ts:36`），告诉它新消息紧随其后，读完再决定发什么，一条消息可以同时回应两批。

### 2. runtime 当场 attach 并排队注入，每轮至多一次

`holdForNewMessages` 定义在 `AgentRuntime` 每次运行的闭包里（`src/orchestration/agent-runtime.ts:304`）：

```ts
const holdForNewMessages = (): boolean => {
  // ...
  // A closing run never injects again, so holding its last send back would
  // only lose that reply; an attached batch is re-queued when the run ends.
  if (state.contextClosing || conversationRuntime.isClosing(conversationId)) {
    return false;
  }
  // A batch the barrier already queued holds back every later send of the
  // same turn too, so no reply goes out before the model has read it.
  if (conversationRuntime.hasPendingInjections(conversationId)) {
    return true;
  }
  if (state.barrierSpent) {
    return false;
  }
  const now = new Date();
  const bucketId = this.#store.transaction(() => {
    const collecting = this.#store.orm
      .select({ id: buckets.id })
      .from(buckets)
      .where(and(eq(buckets.conversationId, conversationId), eq(buckets.state, 'collecting')))
      .get();
    // ...
    attachBucketToInvocation(/* ... */);
    return collecting.id;
  });
  // ...
  state.barrierSpent = true;
  conversationRuntime.queueInjection(conversationId, bucketId);
  // ... console.log({ event: 'send_barrier', ... })
  return true;
};
```

这次 send 被拦下后，这个 turn 以 Tool Call 结束。`shouldStopAfterTurn` 里原有的 `injectPending` 会把排队的批次 steer 进去。这一批本身就是一个 checkpoint，所以模型下一次调用会同时看到被拦的原因和新批次。

各条分支的理由：

- **closing 优先放行**：写这段时发现一个边界。如果屏障刚排好一批，下一个边界就进入了 `context_stop_ratio` 的 send-only 收尾轮，这时收尾后不会再注入，pending 检查会把最后一次 send 也拦下，这一轮就什么都发不出去了。所以 closing 检查放在最前面。没注入的那批照旧在运行结束时由 `releaseUninjectedBuckets` 重新排队。
- **pending 检查**：模型在同一个 turn 里连发两条时，第二条也要被拦住，不能出现「第一条被拦、第二条先发出去」。
- **`barrierSpent`**：只在 Agent 空下来时重置（`src/orchestration/agent-runtime.ts:513` 的 `freeAgent`，即该轮结束或运行结束）。屏障自己触发的注入会重置 `turnsSinceInjection` 等按批计数的状态，但不会重置它，所以不会出现「拦 → 注入 → 再拦」的循环。

屏障只看已经开出的 Bucket。被参与闸门拦下的消息、其他 Bot 的消息、不开桶的单独 Sticker，都不会触发屏障。

### 3. attach 抽成共享函数

到期 attach 原本写在 `InvocationQueueService#attachBucket` 内部，包括写 `invocation_buckets`、把 Bucket 置为 `running`、按 `sequence_no` 续写 `invocation_messages` 快照。现在抽成模块级的 `attachBucketToInvocation`（`src/orchestration/invocation-queue.ts:70`），到期 attach 和屏障共用。冻结输入的不变量只保留一份实现，调用方负责在自己的事务里调用它，再排队注入。

### 4. 配置与热更新

`agent.send_barrier_enabled` 是可选布尔值，默认关闭（`src/platform/config.ts:269`），和 `send_nudge_enabled` 一样列进热更新白名单（`src/platform/config-diff.ts:49`）。它随 Invocation 快照生效，运行中的 Invocation 继续用启动时的值。

### 5. 测试

`test/context-hot-inject.test.ts:1061` 新增 `send barrier` 组。四个用例都走真实 `BucketScheduler` 和 `AgentRuntime`，外加 faux provider：

- **holds the round's first send back and injects the messages that arrived meanwhile**：模型组织回复时来了第二条消息，同一 turn 连发两条，两条都被记为 `send_barrier`；下一次请求里同时有新消息和 `SEND_BARRIER_TEXT`；最终只有一条 `combined answer` 发出。断言还覆盖了：`invocation_buckets` 两行同属一个 Invocation 且都已注入；两个 Bucket 都以 `completed` 收尾；`context_messages` 有两个 user checkpoint，被拦的 toolResult 排在第二批之前。
- **holds back at most one send per round**：屏障用过一次后，再来的消息不拦，按原规则进入下一轮注入。
- **lets a send through when nothing new arrived**：开启但没有新消息时照常发送，也不产生额外的 attach。
- **stays out of the way when disabled**：关闭时仍是两批两次回复。

另外，fixture 里的假 Telegram 原来每次都返回 `message_id: 900`，改成了递增（`test/context-hot-inject.test.ts:75`），第一次仍是 900，已有断言不受影响。否则一个测试里第二次成功发送写 bot 消息时会撞唯一约束，记为 `send_error`。

### 6. 文档

- `agent-doc/telegram-agent-flow.md` 新增「send 屏障」一节，并在「会话节拍与 Bucket」的代价说明后注明这一处例外。
- `agent-doc/configuration.md` 增加字段说明和热更新白名单项。
- `agent-doc/verification.md` 增加真实环境的对照项。

## 验证

离线回放（jev 方案评估；脚本随方案删除，逐桶结果只保存在仓库外）：

```bash
node scripts/hold-gate-eval.ts --out <scratchpad>/eval-300b.jsonl --limit 300 --concurrency 4
# buckets 300  answered 300  errors 0  continuations 43
# latency p50 1927 ms  p90 2456 ms  max 3244 ms  cost $0.01335
# 阈值 0.5：hold_rate 15.3%  recall 18.6%  precision 17.4%（基线 14.3%）
```

实现与测试：

```bash
pnpm exec vitest run test/context-hot-inject.test.ts -t "send barrier"
# 首次：Tests 2 failed | 2 passed —— 假 Telegram 固定返回 message_id 900，
# 第二次成功发送撞唯一约束（send_error），与屏障逻辑无关；修 fixture 后通过
pnpm exec vitest run test/context-hot-inject.test.ts
# Test Files 1 passed (1) / Tests 25 passed (25)
pnpm test
# Test Files 41 passed (41) / Tests 459 passed (459)
pnpm run lint
# format 报出测试文件 1 处格式问题
pnpm run lint:fix
# Formatted 223 files. Fixed 1 file.
pnpm run lint
# No fixes applied
pnpm run check
# 通过（后端 tsc + admin-next tsc）
pnpm exec vitest run test/context-hot-inject.test.ts test/config-diff.test.ts test/config-reload.test.ts
# Test Files 3 passed (3) / Tests 83 passed (83)
git diff --check
# 无输出
```

完整的 `pnpm test` 是在 `lint:fix` 之前跑的。`lint:fix` 只改了测试文件的格式，之后重跑了类型检查和受影响的三个测试文件。

真实 Telegram 验收还没有做。开启后应对照：
- 日志里出现 `send_barrier`。
- `tool_calls` 先有一条 `error` / `send_barrier`，紧跟着一条 `success`。
- 补话那批与开场批次属于同一个 `invocation_id`，且 `injected_at` 非空。
- Telegram 上只出现一条合并后的回复。

## 提交

```txt
67d763c Hold back a send when newer messages arrived mid-reply
```
