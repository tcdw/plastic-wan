# Plastic Wan - 20260926 GC 在 token 压力下的候选选择与 GC 后的估算回落

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）报告了两条与 Context 预算相关的 high，确认成立。两条都会让长会话提前结束：

1. **`planContextGc` 在 token 压力下仍按 `send` 数挑候选**（`src/context/context-gc.ts`）。只要存在「仍保留至少 `retained_sends_target` 次 `send`」的 checkpoint，就直接用它，不看保留段的 token 数；token 判据只在没有这种候选时才会用到。当最近几批消息本身就很重时（例如一次大的 Tool 结果），这个候选保留下来的 token 仍然超过硬阈值，GC 等于没有缓解压力，而一个更靠后、保留 `send` 更少但放得下的 checkpoint 永远不会被考虑。
2. **GC 之后 token 估算不回落**（`src/orchestration/agent-runtime.ts` 的 `prepareNextTurnWithContext`）。`state.estimatedInputTokens` 是高水位：注入与模型 usage 都通过 `Math.max` 更新，只会变大。`#maybeCollect` 丢掉旧历史之后，紧接着的收尾判断 `estimatedInputTokens >= contextWindow × context_stop_ratio` 仍然用 GC 之前的值。刚被 GC 缓解的运行会直接进入 send-only 收尾，以 `context_limit` 结束，而此时保留的 transcript 可能已经很小。

## 主要变更

### 1. token 压力下，按 `send` 选出的候选也必须放得下

```ts
  const fitsTokens = (seq: bigint): boolean => !tokenPressure || tokensFrom(rows, seq) <= tokenBudget(options);
  const target =
    checkpoints
      .toReversed()
      .find(
        (candidate) => countSends(rows, candidate.seq) >= options.retainedSendsTarget && fitsTokens(candidate.seq),
      ) ??
    checkpoints.toReversed().find((candidate) => tokensFrom(rows, candidate.seq) <= tokenBudget(options));
```

没有 token 压力（只因 `send` 数超过 `retained_sends_max` 触发）时行为不变。有压力时，从新往旧找到的第一个满足 `send` 数的候选，是满足条件的候选里保留 token 最少的，所以它放不下的话，更旧的也一定放不下，就会落到 token 判据：取 token 软预算（`contextWindow × hard_token_ratio × 0.8`）以内最新的 checkpoint。代价是这次 GC 保留的 `send` 可能少于 `retained_sends_target`。

### 2. GC 之后重新估算

`prepareNextTurnWithContext` 里，`#maybeCollect` 返回计划之后、判断收尾之前：

```ts
      if (collected !== undefined) {
        state.estimatedInputTokens = this.#estimateInputTokens(
          cached,
          estimateToolRegistryCharacters(nextTools ?? tools),
        );
      }
```

复用运行开始时的同一个估算函数：保留窗口内各行的 `est_tokens` 之和，加上当前 Tool 注册表的字符数除以 4。注册表用 `nextTools ?? tools`，已经包含这一轮可能新暴露的 `zzz`。估算不含 system prompt，和运行开始时的口径一致；之后的模型 usage 仍会通过 `Math.max` 把它抬回真实值。

### 3. 文档

- `agent-doc/telegram-agent-flow.md` 的 Context GC 一节补充上述两条规则。
- `agent-doc/verification.md` 更新 `context-gc.test.ts`、`context-hot-inject.test.ts` 的覆盖说明。

### 4. 测试

- `test/context-gc.test.ts` 新增 `under token pressure the send window cannot pick a cut that stays over budget`：十批消息各有一次 `send`，最后两批每行 20k token。按 `send` 数（target 2）选出的候选（seq 17）保留 80k，超过 48k 的软预算；断言最终 `targetSeq = 19`、保留 token ≤ 48k、`afterSends = 1`。
- `test/context-hot-inject.test.ts` 新增 `a collection that relieves token pressure does not push the run into closing mode`：窗口 40k，`context_stop_ratio = 0.8`，`hard_token_ratio = 0.6`。第一次运行之后，把它留下的 assistant 行 `est_tokens` 改成 31000，模拟一段很重的旧历史。faux provider 会用自己估算的 prompt 大小覆盖 usage，没法直接伪造大 usage，所以用这种方式代替。第二次运行第一轮调用 `read`，在 turn 边界：
  - GC 执行：`head_seq = 3`，`last_gc_at` 非空；
  - 运行以 `completed` / `completed` 结束（不是 `context_limit`），共 3 次模型调用，最后一次仍带完整注册表（含 `execute`）。

## 验证

```bash
pnpm vitest run test/context-gc.test.ts test/context-hot-inject.test.ts
# Tests 34 passed (34)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 45 passed (45) / Tests 509 passed (509)

git diff --check
# 无输出
```

反向验证：`git stash` 掉 `src/context/context-gc.ts` 与 `src/orchestration/agent-runtime.ts`：

```bash
pnpm vitest run test/context-hot-inject.test.ts test/context-gc.test.ts
# × a collection that relieves token pressure does not push the run into closing mode
#   AssertionError: expected { state: 'completed', …(1) } to deeply equal { state: 'completed', …(1) }   （旧代码为 context_limit）
# × under token pressure the send window cannot pick a cut that stays over budget
#   AssertionError: expected 80000 to be less than or equal to 48000
# Tests 2 failed | 32 passed (34)  —— 随后 stash pop 恢复实现
```

还没做的：

- 扫描里 `context-builder.ts` 的预算问题（选历史时没有给 system prompt、runtime state、Sticker 目录、图片预留空间）不在本次范围内。
- 真实环境验收：长会话里出现 `context_gc` 日志后，下一轮不应马上出现 send-only 收尾（`model_calls.tools_json` 仍含完整注册表）。

## 提交

```txt
94e73d8 Keep GC token pressure relief from ending runs early
```
