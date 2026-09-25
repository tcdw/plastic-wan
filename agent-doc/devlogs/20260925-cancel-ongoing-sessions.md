# Plastic Wan - 20260925 Admin 的 Cancel pending 改为 Cancel ongoing

## 背景

Admin Overview 的 Operations 面板原来只有 “Cancel pending”：`POST /cancel-pending-sessions` 把 `collecting` / `queued` 状态的 Bucket 置为 `expired`，并把 `queued` 状态的 Invocation 置为 `aborted`。面板显示的数字是 “Queued invocations”。

这套语义来自「一条消息一次 Invocation」的时代。现在 Invocation 是一个运行窗口：`agent.context.idle_grace_seconds > 0` 时，运行期间到期的 Bucket 会被 attach 到正在跑的 Invocation 并注入。新消息几乎不会停留在 queued 状态，真正需要叫停的是正在运行的那一个。只取消 pending 基本起不到作用。

改动前还有两处遗留问题：

- 被中断的 Invocation 收尾时，`releaseUninjectedBuckets` 会把「已 attach 但未注入」的 Bucket 改回 `queued`，并为它新建一个 queued Invocation。如果只中断运行，这些批次会立刻重新起跑，取消等于没取消。
- 旧的取消逻辑 abort queued Invocation 时不处理它认领的闹钟，闹钟会一直停在 `firing`，直到下一次重启被 recovery 收掉。`/pause` 的同类逻辑已经处理了这一点。

## 主要变更

### 1. Scheduler 中断全部运行中的 Invocation

`BucketScheduler` 新增 `abortAll()`（`src/orchestration/scheduler.ts:115`），写法与已有的 `pauseChat` / `abortConversation` 一致：

```ts
  abortAll(): number {
    for (const entry of this.#active.values()) {
      entry.controller.abort(new Error('admin_cancel'));
    }
    return this.#active.size;
  }
```

它只发 abort 信号，终态仍由各自的 `#execute` 落库：`AgentRuntime` 返回 `aborted`，有 `outcome_unknown` 的 Tool Call 时返回 `outcome_unknown`，`completion_reason` 为 `aborted`。这与 `/pause` 中断运行时的审计表现一致。

### 2. 数据库侧的取消：`cancelOngoingSessions`

`src/ingress/admin/operations.ts` 中的 `cancelPendingSessions` 改名为 `cancelOngoingSessions`，在同一个 immediate 事务里做三件事：

- 把 `collecting` / `queued` Bucket 置为 `expired`；同时把挂在 running Invocation 上、`injected_at IS NULL` 且不是 opening bucket 的 Bucket 也置为 `expired`：

  ```ts
       WHERE state IN ('collecting', 'queued')
          OR (state = 'running' AND id IN (
            SELECT ib.bucket_id FROM invocation_buckets ib
            JOIN invocations i ON i.id = ib.invocation_id
            WHERE i.state = 'running' AND ib.injected_at IS NULL AND ib.bucket_id <> i.bucket_id
          ))
  ```

- 由 queued Invocation 认领的 `firing` 闹钟改为 `cancelled`，`cancel_reason = 'admin_cancel'`，`admin_cancelled = 1`（`src/ingress/admin/operations.ts:34`）。
- `queued` Invocation 置为 `aborted`，`completion_reason = 'admin_cancel'`。

opening bucket 保持 `running`，由被中断的运行在收尾时关成 `aborted`。

### 3. 被中断的运行不再重新排队已过期的批次

`releaseUninjectedBuckets`（`src/orchestration/invocation-queue.ts:446`）原来无条件地为每个未注入批次调用 `#insertInvocation`。现在只有 Bucket 确实从 `running` 改回了 `queued` 才会建新 Invocation：

```ts
      const released = this.#store.orm
        .update(buckets)
        .set({ state: 'queued', queuedAt: timestamp, updatedAt: timestamp })
        .where(and(eq(buckets.id, row.bucketId), eq(buckets.state, 'running')))
        .run();
      // An admin cancel expires attached batches before aborting the run; those
      // must not come back as a new invocation.
      if (asRunResult(released).changes === 0) {
        continue;
      }
```

### 4. 路由与顺序

`POST /cancel-pending-sessions` 改名为 `POST /cancel-ongoing-sessions`，旧路由直接删除，不保留别名。处理顺序是先执行数据库事务，再调用 `abortAll()`（`src/ingress/admin/server.ts:281`）。两步在同一个同步块里完成，被中断的运行进入收尾时，它的未注入批次已经是 `expired`。响应形状不变，`canceled_invocations` 是 queued 与 running 两部分的数量之和。

### 5. Admin 前端与文档

- `apps/admin-next/src/lib/api.ts`：`cancelPendingSessions` / `CancelPendingResult` 改名为 `cancelOngoingSessions` / `CancelOngoingResult`。
- `apps/admin-next/src/pages/overview.tsx`：按钮改为 “Cancel ongoing”；“Queued invocations” 改为 “Ongoing invocations”，数值为 `running` 与 `queued` 之和；确认框注明已发出的消息不会撤回。
- `agent-doc/admin-panel.md` 写端点白名单、`agent-doc/verification.md` 验收矩阵同步改名与语义。

### 6. 测试

- `test/admin.test.ts` 原有用例改名为 `admin can cancel all ongoing sessions`，改走新路由，断言不变。
- 新增 `cancel ongoing aborts a running invocation without re-queuing its attached batch`：用 gate 挡住 handler，让 Invocation 停在 running；用 `attachBucketToInvocation` 挂上第二个未注入批次，然后调用新端点。断言响应为 `canceled_buckets: 1, canceled_invocations: 1`；放行后 invocations 表只剩一行 `aborted`，opening bucket 为 `aborted`，attach 的 bucket 为 `expired`。

## 验证

```bash
pnpm vitest run test/admin.test.ts -t "cancel"
# Tests 2 passed | 10 skipped (12)

pnpm run check
# 通过（后端 tsc + admin-next tsc）

pnpm run lint
# Checked 250 files / Checked 248 files，No fixes applied

pnpm test
# Test Files 45 passed (45) / Tests 498 passed (498)

git diff --check
# 无输出
```

反向验证：把 `src/orchestration/invocation-queue.ts` 临时恢复为改动前的版本（无 `changes === 0` 守卫），重跑新用例：

```bash
pnpm vitest run test/admin.test.ts -t "cancel ongoing aborts"
# × cancel ongoing aborts a running invocation without re-queuing its attached batch
# Tests 1 failed | 11 skipped (12)  —— 随后恢复实现
```

还没做的：

- Admin Panel 需要 `pnpm run admin:build` 才会显示新按钮。
- 真实环境验收：在一次长 Invocation 运行中点 Cancel ongoing，确认它立即停止、审计为 `aborted`，并且没有新的 Invocation 接着起跑。
- 被中断的 running Invocation 的 `completion_reason` 是 `aborted`，不是 `admin_cancel`；审计上区分「管理员取消」需要让 `AgentRuntime` 透传 abort 原因，本次未做。

## 提交

```txt
18b03fc Cancel ongoing sessions from the admin panel
```
