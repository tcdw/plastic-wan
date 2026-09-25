# Plastic Wan - 20260925 每日 Token 预算重新计入缓存读写

## 背景

`20260922-token-usage-excludes-cache.md`（`93469dc`）把缓存读写从每日 token 用量里排除了，理由是「闸门跟着缓存命中率走，而不是跟着实际工作量走」。本次撤销这个语义。

`agent.daily_budget` 不是成本预算，而是 Agent 的安全熔断：它防的是循环、异常 Invocation、tool loop 这类失控调用持续消耗模型资源。因此：

- 模型收不收费、缓存读写单价低不低，都不应影响计量；免费模型同样必须受限。
- Prompt caching 只是 provider 层的执行和计费优化，不改变 Agent 层的 runaway protection 语义。

旧口径恰好漏掉了最危险的形态：上下文很长、每轮只生成几个 token、却把整段 prompt 从缓存里再读一遍的循环。按 `input + output` 计，这种循环几乎不花预算，只能靠每次注入的轮次上限（`turns_per_injection`）兜底。生产库对账的结果里就有这样的一天：09-24 的 `-1004402809405` 按旧口径只有 941,483，含缓存是 40,638,821，其中 97% 是缓存读取。

改动前的统计路径：

- 两个写入点 `#finishModelCall`（`src/orchestration/agent-runtime.ts`）与 `#finishVisionCall`（`src/capabilities/media/media.ts`，chat / sticker 两支）调用 `meteredTokens(usage)`，按 UTC 日期累加进 `daily_usage` 的 `model_tokens` / `vision_tokens`。
- `meteredTokens` 返回 `input + output`。
- `readDailyTokenBudget` 对当天全部 Chat 的 `model_tokens` 求和，与 `max_tokens` 比较，同时决定熔断、`zzz` 可见性与 `/status`。
- 迁移 `018_token_usage_excludes_cache.sql` 按旧口径从 `model_calls` 重建了历史行；Admin API 的 `total_tokens` 也是 `input + output`。

要求：不简单 revert，以当前代码结构实现新语义；保留缓存明细；在规范化层避免 provider 间的重复计数；为受影响的 dev 数据写一次性对账脚本，而不是生产自动迁移。

## 主要变更

### 1. 预算口径：四项之和

`meteredTokens`（`src/store/sleep.ts:36`）仍是唯一定义，改为四个 pi-ai `Usage` 计数之和：

```ts
export function meteredTokens(usage: {
  readonly input: number | bigint;
  readonly output: number | bigint;
  readonly cacheRead: number | bigint;
  readonly cacheWrite: number | bigint;
}): bigint {
  return BigInt(usage.input) + BigInt(usage.output) + BigInt(usage.cacheRead) + BigInt(usage.cacheWrite);
}
```

两个写入点传入的本来就是完整的 `Usage`，签名放宽后无需改动。

### 2. 为什么直接相加不会重复计数

逐个核对了 `@earendil-works/pi-ai` 0.84.2 各 adapter 的 usage 规范化：

| API | Provider 原始语义 | pi-ai 存入 `input` 的值 |
| --- | --- | --- |
| openai-completions | `prompt_tokens` 含 `cached_tokens` / `cache_write_tokens` | `prompt_tokens - cacheRead - cacheWrite` |
| openai-responses | `input_tokens` 含两类缓存 | `input_tokens - cached - cacheWrite` |
| google-generative-ai / vertex | `promptTokenCount` 含 `cachedContentTokenCount` | `promptTokenCount - cached` |
| mistral | `prompt_tokens` 含 cached | `prompt_tokens - cached` |
| anthropic-messages | `input_tokens` 不含缓存 | 原样 |
| bedrock-converse | `inputTokens` 不含缓存 | 原样 |

所以 `input`、`output`、`cacheRead`、`cacheWrite` 互不重叠。另有两个字段不能加：`cacheWrite1h` 是 `cacheWrite` 的子集，`reasoning` 是 `output` 的子集。`totalTokens` 也不用：openai-responses、google、bedrock、mistral 会直接抄 provider 的原始总数，不保证等于四项之和。修正落在已有的规范化抽象上，预算代码里没有 provider 分支。

### 3. Admin 与 `/status`

- invocation 列表与详情的 `total_tokens` 改成四项之和（`src/ingress/admin/audit.ts:369`、`src/ingress/admin/audit.ts:409`），`cache_read_tokens` / `cache_write_tokens` 保留为明细；单次调用的 `total_tokens` 用 `meteredTokens`，provider 原始值继续以 `provider_total_tokens` 单列（`src/ingress/admin/audit.ts:561`）。
- Admin UI 的四处说明文字与 `apps/admin-next/src/lib/api.ts` 注释改为新口径；缓存列与 KvList 行保留。
- `/status` 去掉「（不含缓存）」（`src/orchestration/bot-commands.ts:418`），下面的 `读取`、`写入`、`缓存读取`、`缓存写入` 四项之和即本群用量。

### 4. 退役迁移 018

原 018 会在尚未应用它的库上按旧口径重写历史，和新语义冲突。迁移 runner 只按版本号记账、不校验内容（`loadMigrations` 取文件名前三位），因此把它改为只有注释的空迁移，并更名为 `src/store/migrations/018_retired_cache_excluded_rollup.sql`。已应用过的库不受影响，迁移总数仍是 18。没有新增生产自动迁移。

### 5. 一次性对账脚本

`scripts/reconcile-daily-token-usage.ts`，直连 better-sqlite3，默认 dry-run，`--apply` 才写库；apply 时先取 `serve.lock`，再 `VACUUM INTO` 到 `backups/before-token-usage-reconcile-*.sqlite`（`--no-backup` 可跳过）。

- 按 runtime 写入侧的键与日期边界从 `model_calls` 重新聚合：`substr(COALESCE(finished_at, created_at), 1, 10)`，`CAST(telegram_chat_id AS TEXT)`；`agent` / `vision_chat` 归 `model_tokens`，`vision_sticker` 归 `vision_tokens`，`doctor` 探针不计（它从不写 `daily_usage`）。
- 每行按现值分类（`scripts/reconcile-daily-token-usage.ts:127`）：
  - 等于四项之和 → `already_reconciled`；
  - 等于 `input + output` 之和 → `reconcile`，覆盖为四项之和。这个相等本身证明审计仍完整覆盖那一天；
  - 其他 → `unreconcilable`，附原因（审计行被保留期整天清掉，或只清掉了一部分），不猜。
- 覆盖而不是 `+= cache`，UPDATE 带 `AND amount = <旧值>` 守卫；计划与写入在同一个 immediate 事务里完成。重复运行时已对账的行落入 `already_reconciled`，不会累加。
- 输出受影响行的表格（day、old_total、recalculated、delta、cache_read、cache_write）、每条 `unreconcilable` 的原因，以及一行 JSON 汇总。

### 6. 测试

- `test/token-usage.test.ts`（新增）：
  - `meteredTokens` 覆盖无缓存、cache write、cache read、缓存和非缓存 input 混合四种请求。
  - 用 `startFixtureServer` 驱动真实的 openai-completions、openai-responses、anthropic-messages、google-generative-ai adapter（经 `buildModelRegistry`）：同一次调用是 1,000 prompt tokens（其中 800 cache read、150 cache write，Gemini 没有 write）加 20 output，四种线格式都计为 1,020。前三种 provider 的 prompt 总数本身含缓存，这里证明它们不会被重复计数。
- `test/sleep.test.ts`：新增 `reportingUsage`（`test/sleep.test.ts:67`），包一层 faux provider 让回复报告指定 usage（faux 自己估算 usage，不产生缓存流量）。
  - `charges a free model the cache tokens of its calls`（`test/sleep.test.ts:162`）：cost 为 0 的调用，审计行保留四项明细，`daily_usage` 记 5,000。
  - `stops a cache-heavy runaway invocation on the daily budget`（`test/sleep.test.ts:198`）：每轮 input 10 / output 5 / cache read 59,985 的 tool loop，在第 5 轮以 `reason: 'budget'` 停下，此时 input + output 只有 75；旧口径下它会跑到第 8 轮被轮次上限拦下。
  - 删掉了钉住旧口径的 `charges the daily budget with processed and generated tokens only`。
- `test/reconcile-daily-token-usage.test.ts`（新增）：造一份 018 之后的库（含 doctor 调用、审计整天被清、审计部分被清的日期），断言 dry-run 不写库、分类与 delta 正确；apply 后再 apply 一次，数值不变。
- `test/schema.test.ts`：删掉原 018 回填测试及其多余 import。
- `test/admin.test.ts`：fixture 改为 `input 100 / output 20 / cache_read 500 / cache_write 30 / provider total 620`，断言 `total_tokens` 为 650、`provider_total_tokens` 仍为 620。
- `test/bot-commands.test.ts`：`/status` 断言去掉「（不含缓存）」，用量改回与四项明细一致的 1,234。

## 验证

```bash
pnpm run check
# 通过（后端 tsc + admin-next tsc）

pnpm run lint
# 首次 format 报 4 个文件；pnpm run lint:fix 后无问题

pnpm test
# Test Files 45 passed (45) / Tests 497 passed (497)

git diff --check
# 无输出
```

反向验证：把 `meteredTokens` 临时改回 `input + output`，跑 `test/sleep.test.ts` 与 `test/token-usage.test.ts`：

```bash
npx vitest run test/sleep.test.ts test/token-usage.test.ts
# Tests 9 failed | 12 passed (21)  —— 新增的 9 个用例全部失败，随后恢复实现
```

本地 dev 库对账（`serve` 未运行）：

```bash
node scripts/reconcile-daily-token-usage.ts --database dev-data/data/plasticwan.sqlite
# {"mode":"dry-run","rows":33,"reconcile":28,"already_reconciled":5,"unreconcilable":0,
#  "affected_days":["2026-09-13", ... ,"2026-09-23"],"total_delta":"120506869"}

node scripts/reconcile-daily-token-usage.ts --database dev-data/data/plasticwan.sqlite --apply
# 同上，mode 为 apply，备份写入 dev-data/data/backups/

node scripts/reconcile-daily-token-usage.ts --database dev-data/data/plasticwan.sqlite --apply --no-backup
# {"mode":"apply","backup":null,"rows":33,"reconcile":0,"already_reconciled":33,"unreconcilable":0,"affected_days":[],"total_delta":"0"}
```

另用 sqlite3 逐日比较 `daily_usage.model_tokens` 与 `model_calls`（`agent` + `vision_chat`）的四项之和，09-13 至 09-23 共 11 天差值全部为 0；修正后单日最高 60,951,698（09-22），远低于 4B 上限。

生产库（Windows）由用户执行 `--apply`，这是它唯一一次运行，之前没有跑 dry-run：

```txt
{"mode":"apply","rows":39,"reconcile":33,"already_reconciled":6,"unreconcilable":0,
 "affected_days":["2026-09-13", ... ,"2026-09-25"],"total_delta":"183518524"}
```

09-13 至 09-22 的每一行与本地一致；09-23 的 `-1002577182144` 旧值为 4,689,308（本地快照为 4,300,532），说明生产在快照之后还有调用，按守卫规则同样安全覆盖。

还没做的：

- 生产 `serve` 须先部署本提交再重启。今天（09-25）的行已对账，若旧代码继续写入，今天会混入两种口径，之后再跑脚本会被标成 `unreconcilable`。
- 用新代码重启后，再跑一次 dry-run，应为 `reconcile: 0`、`unreconcilable: 0`。
- Admin Panel 需要 `pnpm run admin:build` 才会显示新的说明文字。
- 真实 Telegram 验收：`/status` 的本群用量应等于下面四项之和。

## 提交

```txt
fa231a2 Count cache tokens toward the daily token budget
```
