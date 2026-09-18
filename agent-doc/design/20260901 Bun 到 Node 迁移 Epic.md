# Bun → Node.js 迁移 Epic

本文档是「从 Bun 迁移回 Node.js」的分阶段计划与决策记录。执行时以源码为准；完成一个阶段后更新本文件的状态标记。

## 背景与目标

- 动机（2026-09-17 补记）：塑料碗后续要同时支持服务端部署与桌面安装版，桌面壳倾向 Electron（评估过 Electrobun，更信赖 Electron 的成熟度）。Electron main / utilityProcess 均为 Node，本迁移是桌面版的前置条件；因此迁移中的选型除服务端外，还须能在 Electron 自带的 Node 中运行（原生模块 ABI、`node:sqlite` 可用性见风险登记）。
- 目标运行时：Node.js（≥22.18 或 24 LTS，type stripping 默认开启，直接执行 `.ts`，不引入 tsx）。
- 策略：先在 Bun 上把所有 Bun 专有面替换为运行时无关实现，让「切换运行时」收敛为一次微小变更；SQLite 采用两段式——先 `bun:sqlite + Drizzle`，切换时刻再换 `node:sqlite + Drizzle`。
- 不变式：全程保持 `bun run check` / 测试绿色；不出现双轨兼容层或隐藏 fallback；Telegram ID 全程 `bigint`。
- 迁移期间新代码不再引入 `Bun.*` / `bun:*` API，避免扩大 Phase 3 范围。

### 后续依赖本迁移的工作（暂缓）

- **Admin Panel 图形化配置编辑**：以图形界面修改 `config.jsonc`，写入后重启生效（不做热重载）。依赖 Phase 3.2（`jsonc-parser` 的 `modify`/`applyEdits` 保留注释写回）与 3.5（新配置 API 直接写在 Hono 上），迁移完成后再立项。
- **Host / Runtime 拆分**：常驻 Host（配置服务 + 生命周期 + Admin Panel）与可重启 Runtime（scheduler/Telegram/MCP），服务端进程内实现、桌面端映射到 Electron main + utilityProcess。需先切断 `AdminServer` 对 `scheduler`/`modelSwitcher` 的直接持有（`src/application.ts`）。
- **Electron 桌面壳**：打包、签名/公证、FFmpeg/Lottie 按平台分发。

## 当前 Bun 依赖面（2026-08 盘点；2026-09-04 重新核对全表）

> 2026-09-17 复核：Phase 1 与 Phase 3 仍未开始（无 `pnpm-workspace.yaml`；`src/` 仍有 `Bun.file`×12、`Bun.password`×4、`Bun.write`×4、`Bun.spawn`×3、`Bun.serve`×2 等，`bun:test` 30 个测试文件）。下表文件清单未随之重核，执行前以 `grep -rn "Bun\.\|bun:"` 为准。
>
> 2026-09-17 更新：**Phase 1 已完成**（pnpm monorepo，见下方状态标记；`src/` 的 Bun 依赖面复核数不变）。下一步进入 Phase 3（运行时无关化，每项独立提交）。
>
> 2026-09-17 晚间更新：**Phase 3 已完成**（含 `apps/admin-next/e2e/server.ts` 与 `apps/admin-next/src/lib/*.test.ts` 两处盘点遗漏的补全；剩余 Bun 引用收敛为 `bun:sqlite` import ×3（doctor/database/scrub 脚本）、`drizzle-orm/bun-sqlite` driver、shebang、`@types/bun` 与历史性注释，全部属 Phase 4/5 范围）。下一步 Phase 4（tsconfig 与 type stripping 审计；root tsconfig 已顺带纳入 `vitest.config.ts`）。
>
> 2026-09-17 深夜更新：**Phase 4 已完成**。原计划只是改 tsconfig 加"已核验"记录，实际核验推翻了原文结论——仓库有 4 处构造器参数属性（不可擦除语法）与 5 处 Bun 专有的 `import.meta.dir`，均已修复；`erasableSyntaxOnly` 已固化为持续闸门。下一步 Phase 5（切换运行时到 Node + `node:sqlite`）。
>
> 2026-09-18 凌晨更新：**Phase 5 已完成**，但驱动改为 **better-sqlite3**——`drizzle-orm/node-sqlite` 只存在于 drizzle 1.0-rc 线，stable 0.45.2 没有；三条路线实测后选择代价最小的 better-sqlite3（详见 Phase 5 章节的路线变更说明）。运行时切换顺带暴露了 3 处"只在 Node 下失败"的启动缺陷（`@hono/node-server` 异步绑定）与 `.get()` 的 null→undefined 语义漂移，均已修复。下一步 Phase 6（清理与文档收尾）。
>
> 2026-09-18 补记（Phase 5 后续补漏）：Bun 由运行时隐式加载的 CWD `.env` 在 Node 下没有对应行为，`required` MCP 的 env SecretRef 直接以 `Secret environment variable is not set: BRAVE_API_KEY` 失败（本机 doctor 实测复现，exit 1）。修复用 Node 原生 `process.loadEnvFile`（新模块 `src/platform/load-env.ts`，CLI 入口 existsSync 守卫加载：缺失跳过、只按 CWD 解析、真实环境变量优先不被覆盖），**未引入 dotenv**——Node ≥24 原生覆盖该能力，与决策表「Node 没有原生实现才引包」（jsonc-parser）的惯例一致。`.gitignore` 同步补 `.env`（原先只有 `.env.local`，存在误提交真实 key 的风险）。验证：`test/load-env.test.ts` 3 例 + doctor 前后对照（同一错误路径下临时 `.env` 后全探针 `status: ok`，验后即删）；`agent-doc/` 的 configuration/operations/verification 已同步。
>
> 2026-09-18 再补记：上面的原生方案随即推翻，改用 **dotenv**——本地密钥实际放在 `.env.local`（Bun 会自动加载整个 `.env*` 家族，原生方案只覆盖了 `.env`），且该路径暴露了 `mcp.ts` 的 `safeErrorName` 只输出错误构造器名、把 `Secret environment variable is not set` 吞成 `failed to initialize: Error` 的诊断缺陷。dotenv 一次对齐 Bun 的多文件语义与解析边界（BOM/CRLF）：加载顺序 `.env.local` → `.env`，真实环境变量优先；`safeErrorName` 移除，required MCP 初始化失败改为输出经 `SecretStore.redactError` 的完整错误（message/stack/cause 链）。回归测试在 `test/mcp.test.ts`（未设 Secret 变量的完整错误文本）与 `test/load-env.test.ts`（多文件优先级 + BOM）。
>
> 2026-09-18 收尾更新：**Phase 6 已完成，本 Epic 全部收尾**。残留清理结论见 Phase 6 章节（唯一修复项 `apps/admin-next/env.example.txt` 的命令引用；`pnpm-lock.yaml` 的 `bun-types` 为 drizzle optional peer，inert 保留）。迁移后的运行时与命令事实以 [operations.md](../operations.md) 与根 [AGENTS.md](../../../AGENTS.md) 为准。
>
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
| 测试运行器过渡 | 测试 import 写 `vitest`，`pnpm test` 仍为 `bun test`（Bun 官方重定向 vitest import）；Phase 5 切 `vitest run`（Node） | vitest 无法在 Node 下解析 `bun:sqlite`（Phase 5 前存在）；`bun --bun vitest` 不可用（Bun worker 缺陷） |
| `.env` 加载 | dotenv | Bun 自动加载 `.env*` 家族；dotenv 是事实标准并处理 BOM/CRLF 解析边界，显式加载 `.env.local` + `.env`，真实环境变量优先 |

## 阶段拆解

### Phase 0 — 基线与依赖锁定（部分完成）

- [x] 记录基线：全量 `bun test`、`bun run check`、`check-config`、`doctor` 输出。
  - 2026-09-04：`bun test`（176/176，23 个文件）与 `bun run check` 全绿，可作为基线；`check-config` 与 `doctor` 输出待正式记录（生产试运行的 doctor 输出可直接归档为基线）。
  - 2026-09-17 Phase 3 开工时基线：`pnpm test` 304/304（33 文件）、`pnpm run check` 全绿、`check-config` config_hash `8339d3f5…`；`doctor` 依赖探针通过、model probe 因外部 Provider 环境失败（与本迁移无关）。
  - 2026-09-18 Phase 6 收口：各时点基线以上述注记为准，Phase 5 验收记录为迁移后最终基线（305/305 → 后续 308/308，含 `.env` 与 MCP 错误报告回归测试）。
- [x] 安装并锁定版本：`drizzle-orm`、`vitest`、`@node-rs/argon2`、`hono`、`@hono/node-server`。
  - 2026-09-01：`drizzle-orm@^0.45.2` 已安装锁定（随 Phase 2 提前完成）。
  - 2026-09-17：其余四项 + `jsonc-parser`（Phase 0 清单遗漏，Phase 3.2 需要）已安装锁定（提交 7b19b4f）：hono 4.13.8、@hono/node-server 2.1.1、@node-rs/argon2 2.2.1、jsonc-parser 3.3.1、vitest 5.0.1。
- [x] 确认目标 Node 版本下限（type stripping 默认开启的版本）写入 `engines`。
  - Phase 5 已写入 `engines.node >= 24.0.0`。

### Phase 1 — pnpm monorepo（运行时仍为 Bun）✅（2026-09-17 完成）

- [x] 新增 `pnpm-workspace.yaml`（`apps/*`），删除根 `package.json` 的 `workspaces`，并新增 `packageManager: "pnpm@12.4.2"`。
- [x] 脚本改造：`bun run --filter plasticwan-admin-next <cmd>` → `pnpm --filter plasticwan-admin-next run <cmd>`（`admin:dev`/`admin:build`/`admin:test:e2e`）；根 `check` 改为 `tsc --noEmit && pnpm --filter …`；`lint` 直接调 `biome`。`test`/`start` 与 CLI 入口暂保持 bun，随 Phase 3.7/Phase 5 切换。
- [x] 锁文件切换为 `pnpm-lock.yaml`（删除 `bun.lock`）。pnpm 12 默认拦截依赖 build scripts，`pnpm-workspace.yaml` 用 `allowBuilds` 显式放行 `@google/genai`、`esbuild`、`protobufjs`（与迁移前 bun 时代行为对齐，非新增执行面）。
- [x] CI/deploy 同步：`Dockerfile` builder 阶段改为 `node:24-bookworm-slim` + `npm i -g pnpm@12.4.2` → `pnpm install --frozen-lockfile` → `pnpm run admin:build` → `pnpm install --prod --frozen-lockfile`；runtime 阶段保持 `oven/bun:1.4-debian`（Phase 5 切 Node）；`.github/workflows/docker.yml` 改用 `pnpm/action-setup@v4` + `actions/setup-node@v4`（cache: pnpm），命令全部 pnpm 化；`AGENTS.md` 与 `agent-doc/`（operations/verification/data-layer/admin-panel）的安装与脚本命令同步。systemd 单元与 `docker-entrypoint.sh` 的 `bun run` 保持不变（运行时切换属于 Phase 5）。
- 验收：✅ 2026-09-17 本地实测 `pnpm install`、`pnpm run check`（根 + admin 两段 tsc）、`pnpm run lint`（biome 190 文件）、`pnpm test`（304/304，33 文件，Bun 在 pnpm 布局下照常）、`pnpm run admin:build` 全绿；`serve` 在 Bun 下照常启动（`serve_started` 的 `config_hash` 与 `check-config` 一致，冒烟后已停）。Docker 镜像构建未在本地验证（无 Docker 环境），由 CI `verify`/`build` job 覆盖。

### Phase 2 — 数据访问层：bun:sqlite + Drizzle ✅（2026-09-01 完成）

- [x] 新增 Drizzle schema（[src/store/schema.ts](../../src/store/schema.ts)：31 张表逐列对齐迁移终态；FTS5 `sticker_search` 虚拟表不进 schema，查询走 `sql` 模板）。
- [x] 保留现有 `.sql` 迁移 runner；Drizzle 仅作查询层，不接管迁移（未引入 drizzle-kit）。
- [x] 改造调用方：全部业务模块（ingestion、media、scheduler、bot-commands、startup-catch-up、send-tool、agent-runtime、mcp、memory、sleep、alarm、internal-context、stickers、admin 全部）。事务映射：`store.transaction(fn)` 保持 bun 原生 IMMEDIATE，drizzle 语句在其内执行；仅持有 `Orm` 的函数用 `orm.transaction(fn, { behavior: 'immediate' })`。
- [x] **bigint 核验**：drizzle SQLite dialect 无 `integer({ mode: 'bigint' })`（备选被否决），改用 `customType` 自制 `sqliteBigInt`/`sqliteBigIntId`（读写均 `bigint`，主键变体允许省略自增 id）；精度/行为测试固化在 [test/schema.test.ts](../../test/schema.test.ts)。
- 实施要点：只用 drizzle 同步 API（`.all()/.get()/.run()/.values()`，与同步事务回调兼容）；该 driver 把 `.run()` 类型标为 `void`，取 `changes` 用 `asRunResult`；裸 `sql` 单行查询须 `.all<Row>(sql\`…\`).at(0)`（`orm.get(sql)` 返回列值数组）；sql 模板内的 `${}` 一律是绑定参数，常量 SQL 片段须 `sql.raw`。测试的裸 SQL 审计断言保留（验证层惯例）。
- 验收：✅ 全量 `bun test` 绿（Phase 2 验收时 168/168；2026-09-04 复测 176/176）；`bun run check`、`bun run lint` 零错误；备份/保留清理、Admin 审计分页、FTS5 搜索测试全部通过。`bun:sqlite` import 面收敛为 `database.ts`（连接/迁移/备份）、`doctor.ts`（探针）、`scripts/scrub-model-request-images.ts`（维护脚本）、`operations.test.ts`（备份验证）。

### Phase 3 — 运行时无关化（每项独立提交，均在 Bun 上回归）✅（2026-09-17 完成）

1. ✅ `Bun.file`/`Bun.write`/`exists`/`lastModified` → `node:fs/promises`（提交 d5de5c1）。语义补偿：`Bun.write` 自动建父目录 → fixture 补 mkdir；`Bun.file().text()` 剥 UTF-8 BOM → `readPromptFile` 显式剥（hash 语义保持）；`lastModified`（Bun 1.4 运行时同步 number，Unix ms）→ `stat().mtimeMs`；`Bun.argv` → `process.argv` 一并处理。
2. ✅ `Bun.JSONC.parse` → `jsonc-parser`（提交 ab60257）。必须 `allowTrailingComma: true` + 显式 errors 数组检查 + BOM 剥离；错误消息保持 `Invalid JSONC: ` 前缀并给出行列定位。
3. ✅ `Bun.spawn` → `node:child_process.spawn`（提交 57a1cc2）：`subprocess.ts` 新增 `spawnProcess`（error/close 双监听防 ENOENT 挂死、`windowsHide: true` 对齐 Bun 默认）；`readBoundedOutput` 平移为 Node Readable 聚合。`scripts/admin-dev-proxy-probe.ts` 同步迁移。
4. ✅ `Bun.password` → `@node-rs/argon2`（提交 aacf9cf）：HASH_OPTIONS 显式 `memoryCost: 65536, timeCost: 2, parallelism: 1`（@node-rs 默认 19456 会静默降强度）；verify 参数顺序相反（hash 在前）；`Algorithm` const enum 因 verbatimModuleSyntax 不可 import，依赖默认 Argon2id。跨库互验 fixture 测试固化（Bun 1.4.0 生成的 PHC 直接插入 DB 验证登录）；存量管理员 hash（m=65536,t=2,p=1）格式确认兼容。
5. ✅ `Bun.serve` → Hono + `@hono/node-server`（提交 dc3950e + e2e fixture 补遗 5066442）：只用了 `serve()` fetch 适配（不实例化 Hono app，路由已在 handle 内）；`idleTimeout: 30`（秒）映射为 `headersTimeout`/`keepAliveTimeout` 各 30s（不误伤慢响应）；`stop(true)` → `closeAllConnections()` + `close()`。测试 fixture 收敛到 `test/helpers.ts` 的 `startFixtureServer`/`stopFixtureServer`。
6. ✅ `Bun.gc(true)` 移除、指标字段 `bun_version` → `runtime_version`（提交 d5a68a3）：强制 GC gate 在 `globalThis.gc`（Node 需 `--expose-gc`；Bun 1.4 下 `globalThis.gc` 为 undefined，指标自然退化为 null/forced_gc:false）；doctor 成功输出字段 `bun` → `runtime`；24 个测试文件（盘点表写 19，实际 24）的钩子内 `Bun.gc(true)` 直接删除（rm 清理有 maxRetries 兜底）。
7. ✅ `bun:test` → Vitest（提交 795b014）：**运行时矛盾与解法**——vitest 跑在 Node，而 src 仍 import `bun:sqlite`（Phase 5 才切），直跑 `vitest run` 会 26/30 文件失败、`bun --bun vitest` 也不可用；采用 Bun 官方的 **vitest import 重定向**（`bun test` 把 `from 'vitest'` 重定向到自身 runner，实测通过），故测试文件全部改为 `from 'vitest'` 而 `pnpm test` 保持 `bun test`，`vitest.config.ts`（`fileParallelism: false`、include 覆盖 test/ + admin-next/src）作为 Phase 5 切换 `vitest run` 的现成配置。bun:test 独有断言适配（toStartWith/toEndWith/toBeFalse → toMatch/startsWith/endsWith/toBe）；`Bun.sleep` → helpers `sleep` ×11；`operations.test.ts` 备份验证 `bun:sqlite` → `node:sqlite DatabaseSync`，Bun 1.4 的 node:sqlite close 后 Windows 句柄需 GC 释放（100% EBUSY 复现；Node 即时释放），afterAll 清理容错 + 注释说明。
- 出口条件：✅ 达成。除 `drizzle-orm/bun-sqlite` driver、`bun:sqlite` import ×3（`database.ts`/`doctor.ts`/`scripts/scrub-model-request-images.ts`，Phase 5）、shebang、`@types/bun` 外，仓库（src/test/scripts/apps/vitest.config）零 Bun 代码引用；剩余匹配均为历史性注释。**盘点遗漏补全**：`apps/admin-next/e2e/server.ts`（Bun.serve）与 `apps/admin-next/src/lib/*.test.ts` ×3（bun:test，贡献 27 个测试）不在原盘点内，已随子项 5/7 一并迁移。
- 验收：✅ 每项经独立验收 agent 审查通过；全量 `pnpm test` 305/305（33 文件）、`pnpm run check`、`pnpm run lint` 全绿；`check-config` config_hash 与迁移前逐字一致；doctor 的 ffmpeg/ffprobe/lottie 子进程探针在新 spawn 实现下通过；admin e2e 80/80（Playwright 真实浏览器全链路，含存量 hash 登录路径外的面板冒烟）。Argon2 存量账号的**真实浏览器登录**留人工验收。

### Phase 4 — tsconfig 与 Node type stripping 审计 ✅（2026-09-17 完成）

- [x] `moduleResolution: "Bundler"` → `"nodenext"`，`module: "nodenext"`；删除 `"types": ["bun"]`（`@types/bun` 仍在 devDependencies，靠 `node_modules/@types` 默认自动包含继续为 `bun:sqlite` 提供类型，Phase 5 移除时才真正消失）。依赖 export map 在 nodenext 解析下**零差异**，未触发回退预案。
- [x] 保留 `allowImportingTsExtensions`（仓库已强制相对导入带 `.ts` 后缀，天然满足 Node strip-types 要求）；no-emit 行为由 `package.json` 的 `tsc --noEmit` 脚本维持，tsconfig 无 `noEmit` 键。
- [x] 新增 `erasableSyntaxOnly: true`：把"评审守则"变成 `pnpm check` 的机器闸门（实测能报 TS1294）。原计划只写"核验 + 记录"，但核验结论与原文不符（见下），单靠文档守则不足以防止回退。
- [x] 新增 `isolatedModules: true`（实测零错误、零改动）：Node strip-types 是逐文件转换，它与 `erasableSyntaxOnly` 一起覆盖单文件转换的两类陷阱（不可擦除语法 / 跨文件类型 re-export）。
- [x] **核验推翻原文结论**：原文称"src/test 无 enum/namespace/构造器参数属性"，实际存在 4 处**构造器参数属性**（Node strip 模式报 `TypeScript parameter property is not supported in strip-only mode`）：
  - `capabilities/web-fetch.ts`（`WebFetchError.code`）、`platform/model-switch.ts`（`ModelSwitchError.code`）、`platform/system-resources.ts`（`SystemResourceError.code`）：改为显式 `readonly` 字段 + 构造器赋值。
  - `platform/concurrency.ts`（`AsyncSemaphore` 的 `private readonly onIdle?`）：改为 `#onIdle` 私有字段 + 构造器赋值（`exactOptionalPropertyTypes` 下字段类型写 `T | undefined`）。
- [x] **Phase 3 遗漏补全**：`import.meta.dir`（Bun 专有，Node 下为 `undefined`，`join(undefined, …)` 抛 `ERR_INVALID_ARG_TYPE`）5 处 → `import.meta.dirname`：`platform/system-resources.ts`、`store/database.ts`、`ingress/admin/server.ts`、`test/mcp.test.ts`、`apps/admin-next/e2e/server.ts`。
- [x] 守则记录到 `AGENTS.md` Coding Style：禁不可擦除语法（enum/namespace/构造器参数属性/`import x = require()`），只用 Node 与 Bun 共有的运行时 API。
- [x] 注意（已记录）：Node type stripping 不读 tsconfig，只要求可擦除语法；`tsc --noEmit` 仍是类型闸门。
- 审计证据（本机 Node v26.5.0，脚本未入库）：
  - `module.stripTypeScriptTypes(code, { mode: 'strip' })` 遍历 `src/`、`test/`、`scripts/`、`apps/admin-next/{src,e2e}`、`vitest.config.ts` 共 120 个 `.ts`：0 失败。
  - 真实模块图加载：mock `bun:sqlite` 后逐个 `import()` 全部 59 个 `src/**/*.ts`：0 失败——除 Phase 5 要换的 SQLite 驱动外，src 已可被 Node 直接加载。
- 验收：✅ `pnpm run check`（root + admin 两段 tsc）、`pnpm run lint`、`pnpm test` 305/305（33 文件）全绿。
- Phase 5 提示：`apps/admin-next/tsconfig.json` 仍写 `types: ["vite/client", "bun"]`，`e2e/server.ts` 的 Node 类型目前由 bun-types 提供；Phase 5 移除 `@types/bun` 时需同步换 `@types/node`，否则 admin 段 `tsc` 会报 TS2688。

### Phase 5 — 切换运行时：Node.js + better-sqlite3 ✅（2026-09-17 完成）

> **路线变更**：原计划用 `drizzle-orm/node-sqlite`，实测发现该驱动只存在于 drizzle 1.0-rc 线（stable 0.45.2 只有 `bun-sqlite`/`better-sqlite3`/`sqlite-proxy` 等，`sqlite-proxy` 是异步接口、与现有同步调用方不兼容）。三条路线实测后选择 **better-sqlite3**：stable 驱动、零类型错误、零调用点改动，代价是 V8 ABI 原生模块（Node 大版本升级需重编译、Electron 需 electron-rebuild）。drizzle 1.0-rc.4 + node-sqlite 路线实测需要修 85 个类型错误（1.0 移除了 `db.all<T>()`/`db.get<T>()` 的泛型形式），且引入 RC 依赖；自建 node:sqlite 适配层因自维护 drizzle 内部契约被否决。

- [x] shebang → `#!/usr/bin/env node`；`package.json` 新增 `engines.node >= 24.0.0`（type stripping 默认开启 + `node:sqlite` 无需 flag）。
- [x] 测试切换：`test` 由 `bun test` 改为 `vitest run`；`apps/admin-next` 的 `test: bun test src` script 删除（根 vitest 的 include 已覆盖 `apps/admin-next/src/**/*.test.ts`，无调用方）。
- [x] 驱动切换：`bun:sqlite` → `better-sqlite3` 13.0.3 + `drizzle-orm/better-sqlite3`（`store/database.ts`、`doctor.ts`、`scripts/scrub-model-request-images.ts`）。`safeIntegers` → `defaultSafeIntegers(true)`；`create:false/strict` → `fileMustExist`；`close(true)` → `close()`；`db.query()` → `db.prepare()`；`db.transaction(fn).immediate()` 语义不变（better-sqlite3 原生支持）。
- [x] **435 处 `.query()` 机械迁移**：bun:sqlite 是 `query<Result, Params>`，better-sqlite3 是 `prepare<Params, Result>`——泛型顺序相反。用 TypeScript AST 脚本一次性调换 297 处泛型（单泛型补 `unknown[]` 绑定位），并处理多行泛型。
- [x] **`.get()` 的 null → undefined 语义**（最高风险项的实际形态）：better-sqlite3 无行时返回 `undefined`（bun 返回 `null`），`=== null` 检查会**静默失效**且 TS 不报错。修复 56 处 TS 报错 + 6 处运行时静默失效（含 `cut-topic.test.ts` 的 running 轮询循环、fixture 的 `!== null`）；测试断言同步改 `toBeUndefined()`。`test/operations.test.ts` 的备份完整性验证仍用 `node:sqlite`（独立验证手段，不随驱动走）。
- [x] **只在 Node 下暴露的启动缺陷**（Phase 3 遗留）：`@hono/node-server` 的 `serve()` 是异步绑定，紧跟的 `server.address()` 返回 null。修复 3 处：`AdminServer.start()`（改 async，等待 `listening`/`error`——顺带把端口占用从"未处理的 error 事件"变成真实 reject，落实风险登记里的可诊断性改进）、`test/helpers.ts` 的 `startFixtureServer`、`apps/admin-next/e2e/server.ts`。
- [x] `test/mcp.test.ts` 的 stdio fixture 命令由 `[process.execPath, 'run', fixturePath]`（bun 子命令）改为 `[process.execPath, fixturePath]`。
- [x] 移除 `@types/bun`，新增 `@types/node@24`（根 + `apps/admin-next`）；`apps/admin-next/tsconfig.json` 的 `types` 由 `bun` 改 `node`。
- [x] 部署同步：`deploy/plasticwan{,-backup}.service` 的 `ExecStart` 由 `bun run` 改 `node`；`docker-entrypoint.sh` 同步；`Dockerfile` runtime 阶段由 `oven/bun:1.4-debian` 改 `node:24-bookworm-slim`（builder 预置 python3/make/g++，兜底 better-sqlite3 的源码编译路径）；`apps/admin-next/e2e/global-setup.ts` 由 `spawn('bun', …)` 改 `spawn(process.execPath, …)`；CI 已是 `node-version: 24`，无需改动。
- [x] 文档同步运行时事实：`operations.md`（Node ≥24、better-sqlite3 原生模块说明、镜像结构、systemd 路径）、`architecture.md`、`data-layer.md`、`configuration.md`、`verification.md`、`admin-panel.md`、`AGENTS.md`、`apps/admin-next/README.md`。
- 验收（本机 Node v26.5.0；目标运行时 Node 24）：
  - `pnpm install`、`pnpm run check`（root + admin 两段 tsc）、`pnpm run lint`、`pnpm test` **305/305**（vitest run，Node 下）全绿。
  - `check-config` 在 Node 与 Bun 下输出同一 `config_hash`（`f056c037…`；与 Phase 3 记录的 `8339d3f5…` 不同是因为 `dev-data/config.jsonc` 之后被本地修改过）。
  - `doctor` 依赖探针全部通过（ffmpeg/ffprobe 真实探针 + lottie 链路经 `spawnProcess`；本机未装真实 `lottie` 包，用 stub 验证了命令构造、spawn、退出码与 sharp 读回链路）；model probe 因本机无真实 `GOOGLE_API_KEY` 失败，与迁移无关。
  - Admin Panel：`pnpm run admin:test:e2e` **79 passed**（Node 下的 e2e server + 真实 Chromium 全链路）；`AdminServer.start()` 额外单独验证——Node 下返回 `127.0.0.1:8787`，`/api/auth/session` 返回 200。
  - `backup` 在 Node 下执行保留清理 + `VACUUM INTO`：备份文件 0600、`integrity_check = ok`、42 张表，轮换正常。
  - **未执行（需生产凭据/真实消息，留人工验收）**：真实 Telegram 私聊全链路、图片与 Sticker 视觉链路、存量管理员密码的真实浏览器登录。

### Phase 6 — 清理与文档收尾 ✅（2026-09-18 完成）

- [x] `AGENTS.md` 命令区更新（`bun install/test/run` → pnpm/node）；`operations.md`、`verification.md`、`data-layer.md` 同步运行时事实。
  - Phase 5 已随运行时切换同步全部主题文档；本次全量复核 `AGENTS.md` 与 agent-doc 正文（`design/` 归档除外），零 bun 命令残留。
- [x] 删除残留 Bun 工件；确认 `grep -rn "bun"` 仅剩历史性描述。
  - 无 `bun.lock`/`@types/bun`/bun shebang 等工件残留；唯一修复项是 `apps/admin-next/env.example.txt` 仍写着 `bun run admin:dev`（已改 `pnpm run admin:dev`）。
  - 剩余匹配逐项归类，均属可保留：src/test 的历史性注释（BOM 行为对齐、`@hono/node-server` 异步绑定差异、Argon2 强度来源、`node:sqlite` 句柄释放差异——各自解释了现有代码为何如此）；`test/admin.test.ts` 的 Bun.password 存量 hash 互验 fixture（跨库登录回归，必须保留）；`apps/admin-next/tsconfig.json` 的 `moduleResolution: "bundler"`（TypeScript 合法取值，与 Bun 无关）；`ubuntu-latest`/`bundle(d)` 字样误命中；`agent-doc/design/` 历史归档原文。
  - `pnpm-lock.yaml` 中的 `bun-types@1.3.14` 是 drizzle-orm 声明的 **optional peer**，由 pnpm auto-install-peers 带入：types-only、无任何 import 路径。`ignoredOptionalDependencies` 实测不覆盖 auto-install 的 peer；全局关 `autoInstallPeers` 波及面更大（会顺带移除同为 optional peer 的 `@opentelemetry/api`），故保留此 inert 条目并在此记录。
  - `docs/plan/` 内的 bun 命令输出是 `.gitignore` 排除的本地草稿（0 个被跟踪文件），不属于仓库工件，不处理。
- [x] 本文档更新各阶段状态；全部完成后按文档边界惯例归档或精简。
  - Phase 0 两个未勾项一并收口（基线记录见各时点注记；`engines.node >= 24.0.0` 已在 Phase 5 写入）。
  - 本文档留在 `design/` 作为历史决策记录，符合 [agent-doc/README.md](../README.md) 的归档边界；索引状态同步为已完成。

## 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `node:sqlite` bigint 回落 Number | Telegram ID 精度损坏（数据损坏级） | ✅ 已消解：Phase 5 实测 `drizzle-orm/node-sqlite` 不在 stable 线，改用 better-sqlite3；bigint 由 `defaultSafeIntegers(true)` + Drizzle `customType` 双重保证，`schema.test.ts` 覆盖 int64 边界往返 |
| Argon2 库参数不一致 | 存量密码无法登录 | PHC 字符串自描述参数；切换前用真实账号回归 |
| Hono 与 Bun.serve 行为差（idleTimeout、请求体上限、错误响应形状） | Admin Panel 可用性 | ✅ Phase 5 用 admin e2e（79 passed，真实 Chromium）与 `AdminServer.start()` 冒烟覆盖 |
| drizzle bun-sqlite 驱动维护节奏 | Phase 2–5 过渡期维护负担 | ✅ 已结束：Phase 5 切到 `drizzle-orm/better-sqlite3`（stable 驱动，不随 1.0-rc 波动） |
| Hono 与 Bun.serve 行为差（传输层 body 上限、headers 后 body 停滞无空闲切断、端口占用报错变钝） | Admin Panel 可用性 | Phase 3 验收记录：Bun.serve 的 128MB 传输上限与 idle 断开在 node-server 无直接对应；回环绑定缓解，低风险。✅ 端口占用可诊断性已在 Phase 5 修复：`AdminServer.start()` 等待 `listening`/`error`，bind 失败以真实错误 reject |
| Bun 1.4 的 `node:sqlite` close 后 Windows 句柄需 GC 释放 | 过渡期测试临时目录泄漏（EBUSY） | ✅ 已消失：Phase 5 后测试在 Node 下跑（Node close 即释放句柄） |
| nodenext 解析下依赖子路径类型差异 | `check` 失败 | ✅ Phase 4 实测零差异，未触发回退 |
| better-sqlite3 是 V8 ABI 原生模块（非 N-API） | Node 大版本升级需重编译；Electron 打包需 `electron-rebuild` | 服务端跟随 Node LTS（当前 24）；Docker builder 预置 python3/make/g++ 兜底源码编译；桌面壳 spike 时验证 electron-rebuild 与 asar unpack |
| 原生模块（`sharp`、`@node-rs/argon2`）在 Electron 打包后加载 | 桌面版媒体/登录不可用 | 优先 N-API 预编译包；asar unpack；spike 时三平台冒烟 |

## 验证矩阵（Phase 5 验收最低集）

1. `pnpm install && pnpm check && pnpm test` 全绿。
2. `check-config` 输出与切换前 `config_hash` 一致。
3. `doctor` 全探针通过（输出中的运行时字段已更名）。
4. 监督器启动 `serve`，日志含预期 `config_hash`；发一条私聊消息验证入库 → Invocation → `send` 全链路与审计行。
5. 图片消息与 Sticker 视觉链路各一例（外部 FFmpeg/Lottie 子进程在新 spawn 实现下工作）。
6. Admin Panel：存量账号登录成功（Argon2 回归）、审计查询、记忆管理写入、静态资源加载。
7. `backup` 执行保留清理 + `VACUUM INTO`；恢复验证按 data-layer.md 流程走一次。
