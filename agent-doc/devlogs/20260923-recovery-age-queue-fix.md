# Plastic Wan - 20260923 到期的批次不再按恢复年龄被丢弃

## 背景

2026-09-23 上午，一个群从 07:26 之后连续三个小时没有收到任何回复，其中 08:05 到 10:26 之间的 24 条群消息一条都没触发 Invocation。翻审计库能看到完整的因果链：

| 时间（UTC） | 事件 |
| --- | --- |
| 07:35:03.729 | Invocation 1320 开跑（开批的 Bucket 4303，1 条消息） |
| 07:37:08.083 | 轮中途来了一条新消息 → Bucket 4304 开始 `collecting` |
| 08:05:03.748 | Invocation 1320 撞上 `max_wall_clock_seconds`（30 分钟）以 `timeout` 中止；同一时刻 Bucket 4304 的 deadline 被推到轮结束 |
| 08:05 之后 | Bucket 4304 一直是 `collecting`，再也没有 Invocation；后续 23 条消息全部并进这个死批次 |
| 09:19:10.396 | 进程重启，`recover()` 把它标成 `expired` / `recovery_age`（24 条消息全部作废） |
| 10:25:46 | 重启后的第一条消息开出 Bucket 4327 → Invocation 1326，回复才恢复 |

根因是 `processDue` 把「恢复年龄」当成了实时过滤条件：

```sql
-- 修改前
WHERE b.state = 'collecting' AND b.deadline_at <= ${now.toISOString()} AND b.first_received_at >= ${new Date(now.getTime() - RECOVERY_MAX_AGE_MS).toISOString()}
```

`RECOVERY_MAX_AGE_MS` 是五分钟（`src/orchestration/invocation-queue.ts:10`），它本来是**启动期**规则：进程重启时，五分钟内的工作重新排队，更久的标记为过期，避免无限重放（`agent-doc/architecture.md:104`）。

但同一 Conversation 正在跑长轮次时，收集中的批次会按窗口一格格被推迟 deadline（`agent-doc/telegram-agent-flow.md:78`：「每一轮结束时，该 Conversation 仍 `collecting` 的 Bucket 会把 deadline 推到至少 `本轮结束 + bucket_window_seconds`」）。同一行还承诺「Invocation 结束时，已到期的 collecting Bucket 立刻被处理」——正是这条被年龄过滤破坏了：它到期的那一刻，第一条消息往往已经超过五分钟，于是这条完全合法的批次被排除，运行结束时没人接手，之后也没有任何东西会重新排队它。Scheduler 还会持续被这个已经过去的 deadline 唤醒，每次都查不出结果。

## 主要变更

### 1. `processDue` 去掉年龄过滤

只删掉一个条件，并把「五分钟是启动期规则」写进注释（`src/orchestration/invocation-queue.ts:304`）：

```sql
-- 修改后（`src/orchestration/invocation-queue.ts:315`）
SELECT b.id, b.conversation_id, b.first_received_at, b.deadline_at
 FROM buckets b
 JOIN conversations v ON v.id = b.conversation_id
 WHERE b.state = 'collecting' AND b.deadline_at <= ${now.toISOString()}
   AND NOT EXISTS (SELECT 1 FROM chat_pause p WHERE p.chat_id = v.chat_id)
   AND NOT EXISTS (
     SELECT 1 FROM invocations i
     JOIN conversations v2 ON v2.id = i.conversation_id
     WHERE v2.chat_id = v.chat_id
       AND (i.state = 'queued' OR (i.state = 'running' AND i.conversation_id <> b.conversation_id))
   )
 ORDER BY b.deadline_at, b.id
```

这样安全的理由写在注释里：启动期的 `recover()` 已经先一步把过期的 `collecting` / `queued` 工作标成 `expired`（`src/orchestration/invocation-queue.ts:122`），`processDue` 永远看不到陈旧批次，所以这里不需要第二道年龄闸。真正的过期判定仍然只发生在重启时。

### 2. 回归测试

`test/scheduler.test.ts:169` 复现原故障：

1. `bucket_window_seconds = 6`，第一条消息开出 Invocation 并把它置为 `running`（手动 UPDATE，模拟正在跑的轮次）。
2. 轮中途再来一条消息 → 新 Bucket 开始收集。
3. 六分钟后调用 `processDue`：此时这条批次的第一条消息已远超五分钟，断言**不产生 Invocation**（轮次还在跑）。
4. 十分钟时轮次结束，并把 `collecting` 批次的 deadline 推到轮结束（这一步模拟 runtime 自己对未接手批次做的事）。
5. 再次 `processDue`：断言新 Invocation 被创建、Bucket 变成 `queued`、新 Invocation 的 `invocation_messages` 里有 1 条 `new`。

修复前第 5 步会因为年龄条件被跳过，Bucket 永远停在 `collecting`。

## 验证

本次补写日志时重跑（提交内容未改动）：

```bash
pnpm test
# Test Files 42 passed (42) / Tests 479 passed (479)

pnpm run check
# 通过（后端 tsc + admin-next tsc）
pnpm run lint
# Checked 229 files / Checked 227 files — No fixes applied
git diff --check
# 无输出
```

审计库对照（只读查询，会话 2）：

```txt
invocation 1320: state=aborted completion_reason=timeout 07:35:03.729Z → 08:05:03.748Z turns=1 sends=0
bucket     4304: state=expired error_code=recovery_age first_received_at=07:37:08.083Z deadline_at=08:05:03.748Z
                 started_at=NULL bucket_messages=24
bot 消息:      07:26:09Z 之后下一条是 10:26:19Z（中间 3 小时无回复）
```

还没做：

- 真实环境的对照复现：需要一次跑满 30 分钟的轮次才会重现原故障，没有专门构造。
- 修复后的行为只由单元测试与重启后的正常轮次（Invocation 1333 起）覆盖。

## 提交

```txt
0991e83 Queue due batches that outlived the recovery age
```
