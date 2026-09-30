# Plastic Wan - 20260930 修复管理面板 Invocation 列表查询延迟

## 背景

管理面板的 `GET /api/invocations?limit=25` 出现明显的首字节等待。只读检查开发数据库后，直接调用同一个 `listInvocations` 查询即可复现：返回约 15 KB 的 25 条记录，SQL 查询连续三次耗时约 5.83 秒。

当时数据库约 2 GB，包含 2,418 条 Invocation、16,995 条模型调用和 8,214 条工具调用。列表对每条候选记录分别统计工具调用数、Token、缓存读写 Token 和费用；`model_calls`、`tool_calls` 都缺少 `invocation_id` 索引。查询计划显示 `SCAN mc` / `SCAN tc`，分页的 26 条候选记录会触发最多 104 次模型调用表扫描和 26 次工具调用表扫描。模型调用表还保存大型请求/响应快照，反复扫描的成本远高于最终响应体大小。

查询使用同步 SQLite，Admin 与 Bot 共用进程，因此这段数据库等待也会阻塞同进程的其他工作。

## 主要变更

### 1. 补齐关联索引

新增 `src/store/migrations/023_invocation_audit_indexes.sql`，并在 `src/store/schema.ts` 同步声明：

```sql
CREATE INDEX model_calls_invocation_idx ON model_calls(invocation_id);
CREATE INDEX tool_calls_invocation_idx ON tool_calls(invocation_id);
```

沿用现有迁移流程：已有数据库先生成迁移前备份，再在事务中创建索引并记录版本。改动不增加配置项、不修改审计记录，也不改变列表与详情的统计语义。现有查询可直接使用新索引，无需增加缓存或另一套统计表。

### 2. 用真实查询计划防止回归

`test/schema.test.ts` 增加新建数据库和旧库升级两种场景。升级场景移除新增索引及版本记录后重新打开数据库，再次打开验证重复启动；比较迁移前后的完整模型调用、工具调用审计行，并检查外键完整性。

测试通过 Drizzle logger 捕获实际列表 SQL，再执行 `EXPLAIN QUERY PLAN`，要求模型调用与工具调用按 `invocation_id` 索引查找，拒绝退回全表扫描。分页游标、Chat/状态过滤、失败调用的空用量、Token 与费用汇总也同时断言。性能门槛依赖查询计划，不使用随机器速度波动的毫秒阈值。

同步更新已有迁移数量断言、Admin 主题文档和验证索引。

## 验证

### 查询耗时

使用 Node 24.18.0 与已安装的 better-sqlite3 / Drizzle，先只读测量开发库，再通过 SQLite backup API 创建一致性副本。索引只在副本上应用，前后调用同一个 `listInvocations`，并逐次比较完整 JSON 结果。

| 测量阶段 | 查询耗时 |
| --- | --- |
| 开发库只读基线，连续三次 | 5,830.07 / 5,833.27 / 5,826.94 ms |
| 同一副本，添加索引前 | 5,999.22 ms |
| 同一副本，添加索引后首次 | 1.60 ms |
| 同一副本，后续三次 | 0.95 / 0.93 / 1.08 ms |

副本上的索引创建耗时约 74.56 ms；四次修复后响应与修复前完全一致。查询计划从 `SCAN mc` / `SCAN tc` 变为 `SEARCH ... USING INDEX`，工具调用计数使用 covering index。临时数据库副本验证后已删除。

以上是 SQL 耗时，不是浏览器 HTTP TTFB。Agent 尝试浏览器复测时，8787 端口拒绝连接，未取得修复后的 HTTP 计时；用户随后实测确认管理面板立即加载，但没有提供毫秒级网络数据。

### 自动化检查

```bash
pnpm test test/schema.test.ts -t 'invocation audit uses indexed calls'
# 添加索引前：2 项回归测试均按预期失败，实际计划仍有全表扫描

pnpm test
# 57 个文件：56 通过、1 失败；670 项测试：669 通过、1 失败
# 唯一失败是既有 prepared ORM 测试仍断言 22 条迁移记录，实际已为 23

pnpm test test/foundation.test.ts test/schema.test.ts test/long-tasks-migration.test.ts test/admin.test.ts
# 修正迁移数量断言后：4 个文件、96 项测试全部通过

pnpm run check
# runtime、Admin、docs TypeScript 检查通过

pnpm run lint:fix
# 修正本次测试的一处格式问题

pnpm run lint
# lint 297 文件、format 294 文件通过；各有 1 条既有临时 JSON 超过 1 MiB 的警告

git diff --check
git diff --cached --check
# 通过
```

最终修正后只复跑上述受影响测试，没有将其描述为全量 670 项重新通过。日志阶段仅新增本文，未重新运行代码测试、构建或真实 Telegram/Provider 检查。

## 提交

```txt
cfe577290999557f90750683fe70a635140cf9dc Fix invocation audit query performance
```
