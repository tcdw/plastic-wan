# Plastic Wan - 20260922 Token 用量不再计入缓存读写

## 背景

起因是一次审计：Admin Panel 里 invocation 1216 的 Tokens 显示 598,752，看着像一次请求烧了 60 万 token。翻审计库发现那其实是 4 次模型调用的合计（`listInvocations` 里的 `SUM(model_calls.total_tokens)`）：该 Invocation 吃了两个 Bucket，每轮模型只写私有文本、不调 `send`，harness 提醒一次，于是每轮两次调用，每次带着同一份约 15 万 token 的 prompt：

| model_call | input | cache_read | output | total |
| --- | --- | --- | --- | --- |
| #7859 | 149,252 | 0 | 19 | 149,271 |
| #7860 | 1,234 | 148,096 | 18 | 149,348 |
| #7861 | 1,917 | 148,096 | 15 | 150,028 |
| #7862 | 1,223 | 148,864 | 18 | 150,105 |
| 合计 | 153,626 | **445,056** | 70 | **598,752** |

**74% 是缓存读取**。而这份 prompt 的构成是 969 条消息（453,216 字符，约 13 万 token 的会话历史）加 26 个工具 schema（53,559 字符，约 1.5 万 token），system prompt 本身只有 7,108 字符。

### 为什么用 token 而不是钱

`agent.daily_budget` 的用途是给免费模型与本地迷你 LLM 兜底，token 是模型无关、价格表无关的单位，这个选择不能动：实测 `qwen3.8-27b:free`、`XingChenAGI/Xing4.0-29B` 的 `cost` 恒为 0，改成按钱计费等于给这些模型拆掉闸门。

### 真正的问题：闸门跟着缓存命中率走

`daily_usage` 原来记的是 provider 的 `total_tokens`，而它含缓存。缓存命中率天天翻脸，同样的行为日总量能差一个量级（09-16 命中 0.9%、09-18 命中 90.7%），于是这个数字既不反映实际工作量，也没法做日环比；上下文大小本来就有 GC 的 `hard_token_ratio` 与 `context_stop_ratio` 两道闸，日预算再计一遍「上下文被读了几遍」是重复计量。

先验证了一条前提：审计库里 10 个模型全部满足 `total = input + output + cacheRead + cacheWrite`，也就是 `input` 本身不含缓存，`input + output` 恰好等于「总 token − 缓存读写」。顺带发现 `gpt-5.6-luna` 有 926,501 的 cache write（占其总量 3.4%），所以「不计 cache」要读写两类一起排除。

### 定下的口径与边界

- **`Token 用量 = input_tokens + output_tokens`**，缓存读写单列，不进任何总量、不吃预算。全站一致：每日预算、日图、invocation 列表/详情的总计、`/status` 都按这个口径。
- Sticker 索引的 `vision_tokens` 同口径，文档里「Token 用量」只留一个定义。
- 历史数据按新口径回填，图表不留台阶。
- 阈值不动（仍是 4B），也不新增每日调用次数上限——那是 `015_drop_call_budgets.sql` 刚删掉的方向，而每次调用都带整段上下文，token 闸本身已经隐含约束了调用次数。
- provider 的原始 `total_tokens` 仍留在 `model_calls` 里，Admin API 以 `provider_total_tokens` 单列暴露，审计不丢数据。

## 主要变更

### 1. 口径只留一份实现

新增 `meteredTokens`（`src/store/sleep.ts:31`），预算口径的唯一定义：

```ts
/**
 * Tokens charged against the daily budget: the prompt tokens the provider had
 * to process plus the tokens it generated. Cache reads are served from the
 * provider's cached prefix and cache writes are tracked separately, so neither
 * counts here — the meter must follow the work the run asked for, not how warm
 * the provider's cache happened to be. `usage.input` already excludes both
 * cache counters (`total = input + output + cacheRead + cacheWrite`).
 */
export function meteredTokens(usage: { readonly input: number | bigint; readonly output: number | bigint }): bigint {
  return BigInt(usage.input) + BigInt(usage.output);
}
```

两个写入点改用它：`#finishModelCall`（`src/orchestration/agent-runtime.ts:1258`）与 `#finishVisionCall` 的 chat / sticker 两个分支（`src/capabilities/media/media.ts:570`、`src/capabilities/media/media.ts:586`）。`readDailyTokenBudget` 的 SQL 不用改——metric 名没变，变的是记进去的数。

### 2. 迁移 018：从审计行回填历史

`daily_usage` 是 `model_calls` 的派生汇总，所以历史可以直接重算，不需要新 metric 名、也不会出现「同一天混两种口径」。只重算审计仍覆盖的日期，其他日期原样保留：

```sql
DELETE FROM daily_usage
 WHERE metric IN ('model_tokens', 'vision_tokens')
   AND utc_date IN (SELECT DISTINCT substr(COALESCE(finished_at, created_at), 1, 10) FROM model_calls);

INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at)
SELECT substr(COALESCE(mc.finished_at, mc.created_at), 1, 10),
       'chat',
       CAST(ch.telegram_chat_id AS TEXT),
       'model_tokens',
       SUM(COALESCE(mc.input_tokens, 0) + COALESCE(mc.output_tokens, 0)),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM model_calls mc
  JOIN invocations i ON i.id = mc.invocation_id
  JOIN conversations c ON c.id = i.conversation_id
  JOIN chats ch ON ch.id = c.chat_id
 WHERE mc.role IN ('agent', 'vision_chat')
 GROUP BY 1, 3;
```

`vision_tokens` 同理，按 `role = 'vision_sticker'` 汇总。`chats.telegram_chat_id` 是 INTEGER 而 `daily_usage.resource` 是 TEXT，这里显式 `CAST(... AS TEXT)` 与写入侧的 `chatId.toString()` 对齐；`vision_images` 是计数不是 token，不在重算范围内。

回填后逐日对比（只读方式跑迁移的 SELECT，未写库）：

| 日期（UTC） | 旧口径 | 新口径 | 缓存占比 |
| --- | --- | --- | --- |
| 09-22 | 55,587,323 | 15,427,580 | 74.1% |
| 09-21 | 38,485,389 | 31,658,325 | 17.2% |
| 09-20 | 27,932,623 | 27,630,447 | 1.1% |
| 09-19 | 28,515,377 | 4,219,283 | 84.2% |
| 09-18 | 31,545,730 | 2,924,418 | 90.7% |
| 09-17 | 7,690,386 | 2,443,098 | 68.2% |
| 09-16 | 12,559,340 | 12,442,956 | 0.9% |
| 09-15 | 26,536,940 | 26,015,868 | 2.0% |

### 3. Admin API：总计改口径，缓存单列

invocation 列表与详情的总计改成同一算式（`src/ingress/admin/audit.ts:369`、`src/ingress/admin/audit.ts:409`），并新增两个缓存汇总字段：

```sql
(SELECT COALESCE(SUM(COALESCE(mc.input_tokens, 0) + COALESCE(mc.output_tokens, 0)), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_tokens,
(SELECT COALESCE(SUM(mc.cache_read_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS cache_read_tokens,
(SELECT COALESCE(SUM(mc.cache_write_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS cache_write_tokens,
```

单次调用的 `total_tokens` 也改成 `input + output`，原始值另起字段（`src/ingress/admin/audit.ts:554`）：

```ts
total_tokens: Number(meteredTokens({ input: row.inputTokens ?? 0n, output: row.outputTokens ?? 0n })),
provider_total_tokens: num(row.totalTokens),
```

这样「API 里叫 total 的字段」全站只有一个含义，需要 provider 原始值时名字也说得清。

### 4. Admin UI 说明清楚

按用户要求，把口径写在看得到的地方，并把缓存做成明细列：

- invocation 列表加说明行（`apps/admin-next/src/pages/invocations.tsx:125`）。
- 详情页 KvList 增加 Cache read / Cache write 两行（`apps/admin-next/src/pages/invocation-detail.tsx:145`）。
- Model calls 表新增 Cache read / Cache write 两列，Total = Input + Output，并在表前说明「provider 原始总量在 API 里叫 `provider_total_tokens`」（`apps/admin-next/src/pages/invocation-detail.tsx:537`、`apps/admin-next/src/pages/invocation-detail.tsx:549`）。
- 日图与 Today's usage 各加一段说明（`apps/admin-next/src/pages/overview.tsx:250`、`apps/admin-next/src/pages/overview.tsx:299`）。

### 5. `/status` 标注口径

两行用量加上「（不含缓存）」，下面的 `读取` + `写入` 正好等于该用量（`src/orchestration/bot-commands.ts:418`）：

```ts
`本群今日 token 用量（不含缓存）: ${tokens.toLocaleString('en-US')}`,
`全局今日 token 用量（不含缓存）: ${dailyBudget.usedTokens.toLocaleString('en-US')} / ${dailyBudget.maxTokens.toLocaleString('en-US')} (${dailyBudgetPercentage})`,
```

### 6. 测试

- `test/schema.test.ts:172`：造一份迁移前状态（agent 调用带 40,000 缓存读取 + 500 缓存写入、sticker 调用、以及三行 `daily_usage`），执行迁移 SQL，断言 `model_tokens` 由 41,750 重算为 1,250、`vision_tokens` 由 1,020 重算为 120，且 `vision_images` 的计数不被碰。
- `test/sleep.test.ts:108`：跑一次真实 Invocation，断言记进 `daily_usage` 的等于该次调用审计行里的 `input + output`。faux provider 不产生缓存流量（它的 usage 是按 prompt 估算的，只有带 sessionId 才给缓存），所以这条钉的是口径而不是算术；带缓存的排除由迁移与 Admin API 两条测试覆盖。
- `test/admin.test.ts:333`：把 fixture 的模型调用补成 `input 100 / output 20 / cache_read 500 / total 620`，断言列表 `total_tokens` 仍是 120、`cache_read_tokens` 为 500，单次调用的 `provider_total_tokens` 为 620（`test/admin.test.ts:353`）。
- `test/foundation.test.ts`：迁移总数与 `MAX(version)` 由 17 提到 18。

### 7. 文档

- `agent-doc/configuration.md`：`daily_budget.max_tokens` 补上口径与理由。
- `agent-doc/data-layer.md`：`daily_usage` 一节写明口径与迁移 018。
- `agent-doc/telegram-agent-flow.md`：`/status` 输出说明与 `zzz` 阈值口径。

## 验证

只读方式在真实审计库上跑迁移的两条 SELECT，确认 SQL 与结果（脚本放在 gitignore 的 `dev-data/` 下，跑完即删，全程 `readonly: true`）：

```bash
node dev-data/tmp-verify.mjs
# INSERT statements found: 2
# rows: 30 / rows: 1
# 2026-09-22 chat 群聊（supergroup）: 13,924,803
# 当日合计：旧口径 55,587,323 → 新口径 15,427,580
```

实现与测试：

```bash
npx vitest run test/sleep.test.ts test/schema.test.ts test/admin.test.ts test/bot-commands.test.ts
# Test Files 4 passed (4) / Tests 59 passed (59)

pnpm test
# 首次：Test Files 1 failed | 41 passed (42) / Tests 2 failed | 476 passed (478)
#   foundation.test.ts 写死了迁移数 17 与 MAX(version) 17，新迁移后应为 18
# 改为 18 后重跑：
# Test Files 42 passed (42) / Tests 478 passed (478)

pnpm run lint
# 首次 format 报出 5 个文件；pnpm run lint:fix 后
# Checked 229 files / Checked 227 files — No fixes applied
pnpm run check
# 通过（后端 tsc + admin-next tsc）
git diff --check
# 无输出
```

提交前状态：`pnpm test` 478 全过、`pnpm run check` 与 `pnpm run lint` 全绿、`git diff --check` 无空白问题。

还没做的：

- **迁移尚未在真实库上生效**——需要重启 `serve`（会自动建 pre-migration 备份）。
- Admin Panel 需要 `pnpm run admin:build` 重新构建，否则静态资源还是旧的。
- 真实 Telegram 验收：`/status` 的两行用量应等于下面 `读取` + `写入` 之和；Admin Panel 的日图在重启后应看到回填后的台阶下降。

## 提交

```txt
93469dc Exclude cache tokens from metered token usage
```
