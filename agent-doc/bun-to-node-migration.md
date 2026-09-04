# Bun → Node.js 迁移 Epic

本文档是「从 Bun 迁移回 Node.js」的分阶段计划与决策记录。执行时以源码为准；完成一个阶段后更新本文件的状态标记。

## 背景与目标

- 目标运行时：Node.js（≥22.18 或 24 LTS，type stripping 默认开启，直接执行 `.ts`，不引入 tsx）。
- 策略：先在 Bun 上把所有 Bun 专有面替换为运行时无关实现，让「切换运行时」收敛为一次微小变更；SQLite 采用两段式——先 `bun:sqlite + Drizzle`，切换时刻再换 `node:sqlite + Drizzle`。
- 不变式：全程保持 `bun run check` / 测试绿色；不出现双轨兼容层或隐藏 fallback；Telegram ID 全程 `bigint`。

## 当前 Bun 依赖面（2026-08 盘点；2026-09-04 重新核对全表）

> 2026-09-04 状态速览：Phase 0 部分完成（drizzle-orm 已锁定）、**Phase 2 已完成**、Phase 1/3–6 未开始。下一步是 Phase 1（pnpm monorepo）或直接进入 Phase 3（运行时无关化，每项独立提交）。

| 类别 | 位置 |
| --- | --- |
| `bun:sqlite` | `database.ts`（连接/迁移/备份层）、`doctor.ts`（探针）、`operations.test.ts`（备份只读验证）；业务查询层已迁移至 Drizzle（见 Phase 2） |
| `Bun.file` / `Bun.write` / `Bun.BunFile` | `platform/config.ts`、`store/database.ts`、`capabilities/media/media.ts`、`capabilities/media/media-image.ts`、`ingress/admin/server.ts`（含 `BunFile`）、`tui/configure.ts`、`doctor.ts`、`scripts/scrub-model-request-images.ts`；另有 10 个测试文件 |
| `Bun.JSONC.parse` | `platform/config.ts` |
| `Bun.spawn` | `doctor.ts`、`capabilities/media/media-image.ts`（FFmpeg/Lottie 外部链路）、`platform/secrets.ts`（command SecretRef）。`Bun.Subprocess` 类型已无引用 |
| `Bun.password.hash/verify` | `ingress/admin/auth.ts`（Argon2id） |
| `Bun.serve` | `ingress/admin/server.ts`（fetch 风格 Request/Response 处理器 + 静态资源）；`mcp.test.ts`、`tui-configure.test.ts` 用它起 fixture server |
| `Bun.gc(true)` / `Bun.version` | `orchestration/scheduler.ts`（强制 GC 与指标字段 `bun_version`）、`doctor.ts`（`Bun.version`）；`Bun.gc` 另在 19 个测试文件中用于回收断言 |
| `Bun.argv` | `cli.ts` |
| `bun:test` | `test/` 全部 23 个 `.test.ts` 文件（`afterAll`/`describe`/`expect`）；`Bun.sleep` 另见 `bot-commands.test.ts` |
| 其它 | 根 `package.json` 的 `workspaces` + `bun run --filter` 脚本、`@types/bun`、`src/cli.ts` shebang `#!/usr/bin/env bun` |

## 决策记录

| 决策点 | 选择 | 理由与备选 |
| --- | --- | --- |
| ORM | Drizzle ORM | 官方驱动同时覆盖 `drizzle-orm/bun-sqlite` 与 `drizzle-orm/node-sqlite`，支撑两段式切换 |
| 迁移历史 | 保留现有版本号 `.sql` 迁移与自研 runner，不引入 drizzle-kit 迁移 | 现网已有迁移历史；避免第二套迁移事实源。Drizzle schema 手写对齐现有表结构 |
| 测试框架 | Vitest | API（`describe`/`afterAll`/`expect`）与 bun:test 接近，迁移机械；`node:test` 的断言模型差异大被否决 |
| 密码哈希 | `@node-rs/argon2`（预编译 NAPI） | Argon2id PHC 字符串跨库可互验，存量 hash 无需重置；避免 node-gyp 本地编译 |
| HTTP 服务 | Hono + `@hono/node-server` | 现有 handler 已是 Web 标准 Request/Response，移植面最小；纯 `node:http` 手写被否决 |
| JSONC | `jsonc-parser` | Node.js 没有支持注释与尾逗号的原生 JSON parser；保持现有 JSONC 契约 |
| 子进程 | `node:child_process.spawn` | 手工聚合 stdout（现有 `readCommandOutput` 模式平移） |
| 包管理 | pnpm workspaces | 替换 `workspaces` 字段与 `bun run --filter` |

## 阶段拆解

### Phase 0 — 基线与依赖锁定（部分完成）

- [ ] 记录基线：全量 `bun test`、`bun run check`、`check-config`、`doctor` 输出。
  - 2026-09-04：`bun test`（176/176，23 个文件）与 `bun run check` 全绿，可作为基线；`check-config` 与 `doctor` 输出待正式记录（生产试运行的 doctor 输出可直接归档为基线）。
- [ ] 安装并锁定版本：`drizzle-orm`、`vitest`、`@node-rs/argon2`、`hono`、`@hono/node-server`。
  - 2026-09-01：`drizzle-orm@^0.45.2` 已安装锁定（随 Phase 2 提前完成）；其余四项待 Phase 3 启动时安装。
- [ ] 确认目标 Node 版本下限（type stripping 默认开启的版本）写入 `engines`。

### Phase 1 — pnpm monorepo（运行时仍为 Bun）

- [ ] 新增 `pnpm-workspace.yaml`（`apps/*`），删除根 `package.json` 的 `workspaces`。
- [ ] 脚本改造：`bun run --filter plasticwan-admin <cmd>` → `pnpm --filter plasticwan-admin run <cmd>`；根脚本改用 pnpm 直接调 `tsc`/`biome`/`vitest`/`node src/cli.ts`（切换前临时仍可用 bun 执行入口）。
- [ ] 锁文件切换为 `pnpm-lock.yaml`；CI/deploy 文档同步安装命令。
- 验收：`pnpm install && pnpm build` 通过；`serve` 在 Bun 下照常启动。

### Phase 2 — 数据访问层：bun:sqlite + Drizzle ✅（2026-09-01 完成）

- [x] 新增 Drizzle schema（[src/store/schema.ts](../src/store/schema.ts)：31 张表逐列对齐迁移终态；FTS5 `sticker_search` 虚拟表不进 schema，查询走 `sql` 模板）。
- [x] 保留现有 `.sql` 迁移 runner；Drizzle 仅作查询层，不接管迁移（未引入 drizzle-kit）。
- [x] 改造调用方：全部业务模块（ingestion、media、scheduler、bot-commands、startup-catch-up、send-tool、agent-runtime、mcp、memory、sleep、alarm、internal-context、stickers、admin 全部）。事务映射：`store.transaction(fn)` 保持 bun 原生 IMMEDIATE，drizzle 语句在其内执行；仅持有 `Orm` 的函数用 `orm.transaction(fn, { behavior: 'immediate' })`。
- [x] **bigint 核验**：drizzle SQLite dialect 无 `integer({ mode: 'bigint' })`（备选被否决），改用 `customType` 自制 `sqliteBigInt`/`sqliteBigIntId`（读写均 `bigint`，主键变体允许省略自增 id）；精度/行为测试固化在 [test/schema.test.ts](../test/schema.test.ts)。
- 实施要点：只用 drizzle 同步 API（`.all()/.get()/.run()/.values()`，与同步事务回调兼容）；该 driver 把 `.run()` 类型标为 `void`，取 `changes` 用 `asRunResult`；裸 `sql` 单行查询须 `.all<Row>(sql\`…\`).at(0)`（`orm.get(sql)` 返回列值数组）；sql 模板内的 `${}` 一律是绑定参数，常量 SQL 片段须 `sql.raw`。测试的裸 SQL 审计断言保留（验证层惯例）。
- 验收：✅ 全量 `bun test` 绿（Phase 2 验收时 168/168；2026-09-04 复测 176/176）；`bun run check`、`bun run lint` 零错误；备份/保留清理、Admin 审计分页、FTS5 搜索测试全部通过。`bun:sqlite` import 面收敛为 `database.ts`（连接/迁移/备份）、`doctor.ts`（探针）、`scripts/scrub-model-request-images.ts`（维护脚本）、`operations.test.ts`（备份验证）。

### Phase 3 — 运行时无关化（每项独立提交，均在 Bun 上回归）

1. `Bun.file`/`Bun.write`/`exists`/`lastModified` → `node:fs/promises`（`readFile`/`writeFile`/`stat`/`access`）；`capabilities/media/` 中 `arrayBuffer()` 读法改为 `readFile` 直取 Buffer。
2. `Bun.JSONC.parse` → `jsonc-parser`（`config.ts`）。
3. `Bun.spawn` → `node:child_process.spawn`；`readCommandOutput` 平移到 `Readable` 流聚合；覆盖 `doctor`、`media`、`secrets` 三处。
4. `Bun.password` → `@node-rs/argon2`；**必须用存量管理员账号做登录回归**，证明旧 PHC hash 可验证；`HASH_OPTIONS` 参数逐项映射。
5. `Bun.serve` → Hono + `@hono/node-server`：回环绑定、`idleTimeout: 30` 对应参数、静态资源 fallback（`index.html`）、错误 JSON 形状不变。
6. `Bun.gc(true)` 移除（或 gate 在 `--expose-gc`）；指标字段 `bun_version` 更名 `runtime_version`（确认无持久化消费者）。
7. `bun:test` → Vitest：23 个测试文件机械改 import；`bun:test` 特有行为（如隐式超时差异）逐一确认。
- 出口条件：除 `drizzle-orm/bun-sqlite` 单一 import、shebang、`@types/bun` 外，仓库零 Bun 引用（`grep -r "Bun\.\|bun:"` 为空）。

### Phase 4 — tsconfig 与 Node type stripping 审计

- [ ] `moduleResolution: "Bundler"` → `"nodenext"`，`module: "nodenext"`；删除 `"types": ["bun"]`。
- [ ] 保留 `allowImportingTsExtensions`（仓库已强制相对导入带 `.ts` 后缀，天然满足 Node strip-types 要求）；no-emit 行为由 `package.json` 的 `tsc --noEmit` 脚本维持，tsconfig 无 `noEmit` 键。
- [ ] 已核验：src/test 无 `enum`/`namespace`/构造器参数属性（不可擦除语法）；将此作为评审守则记录。
- [ ] 注意：Node type stripping 不读 tsconfig，只要求可擦除语法；`tsc --noEmit` 仍是类型闸门。
- 验收：`pnpm check` 在新 tsconfig 下通过（重点观察依赖 export map 在 nodenext 解析下的差异）。

### Phase 5 — 切换运行时：Node.js + node:sqlite（单次小步）

- [ ] shebang → `#!/usr/bin/env node`；`engines` 生效。
- [ ] Drizzle 驱动 `drizzle-orm/bun-sqlite` → `drizzle-orm/node-sqlite`（唯一 import 位；2026-09-01 已确认收敛为 `src/store/database.ts` 单处）。
- [ ] **最高风险项**：`node:sqlite` 默认把 INTEGER 读成 Number；确认 Drizzle node-sqlite 会话对 bigint 列的处理，否则 Telegram ID 精度丢失。若无法保证，降级决策点：改用 `better-sqlite3` 驱动（成熟但引入原生依赖）。
- [ ] 接受 `node:sqlite` 稳定性现状：Node 24.15+ 为 Stability 1.2 Release Candidate，无需 flag；记录到 operations.md。
- [ ] 移除 `@types/bun`，新增 `@types/node`。
- [ ] `deploy/systemd` 单元 `ExecStart` 由 bun 改 node；权限检查、`UMask=0077`、ServeLock 语义不变。
- 验收：完整矩阵跑一遍（见下）。

### Phase 6 — 清理与文档收尾

- [ ] `AGENTS.md` 命令区更新（`bun install/test/run` → pnpm/node）；`operations.md`、`verification.md`、`data-layer.md` 同步运行时事实。
- [ ] 删除残留 Bun 工件；确认 `grep -rn "bun"` 仅剩历史性描述。
- [ ] 本文档更新各阶段状态；全部完成后按文档边界惯例归档或精简。

## 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `node:sqlite` bigint 回落 Number | Telegram ID 精度损坏（数据损坏级） | ✅ Phase 2 已在 Drizzle 层固定 bigint 映射（customType）并在 Bun 上写了精度/行为测试（`test/schema.test.ts`）；切换时刻仅换驱动再复测；兜底 better-sqlite3 |
| Argon2 库参数不一致 | 存量密码无法登录 | PHC 字符串自描述参数；切换前用真实账号回归 |
| Hono 与 Bun.serve 行为差（idleTimeout、请求体上限、错误响应形状） | Admin Panel 可用性 | Phase 3 用现有 admin 测试 + 手动面板冒烟覆盖 |
| drizzle bun-sqlite 驱动维护节奏 | Phase 2–5 过渡期维护负担 | 过渡期短；驱动仅一处引用，随时可切 |
| nodenext 解析下依赖子路径类型差异 | `check` 失败 | Phase 4 独立成阶段，失败即回退 Bundler 并排查具体包 |

## 验证矩阵（Phase 5 验收最低集）

1. `pnpm install && pnpm check && pnpm test` 全绿。
2. `check-config` 输出与切换前 `config_hash` 一致。
3. `doctor` 全探针通过（输出中的运行时字段已更名）。
4. 监督器启动 `serve`，日志含预期 `config_hash`；发一条私聊消息验证入库 → Invocation → `send` 全链路与审计行。
5. 图片消息与 Sticker 视觉链路各一例（外部 FFmpeg/Lottie 子进程在新 spawn 实现下工作）。
6. Admin Panel：存量账号登录成功（Argon2 回归）、审计查询、记忆管理写入、静态资源加载。
7. `backup` 执行保留清理 + `VACUUM INTO`；恢复验证按 data-layer.md 流程走一次。
