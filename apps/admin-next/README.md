# Plastic Wan Admin (Next)

Plastic Wan 的 Admin Panel 前端。构建产物是**静态 SPA**（Vite + React + TanStack
Router/Query + Tailwind 4 + shadcn/Base UI），由后端 `AdminServer`（`serve` 进程内的
`src/ingress/admin/server.ts`）**同源托管**，不依赖任何 Node/Nitro 运行时。`dist/`
里的 `index.html` 由后端做深链接回退（未知路径回落到 SPA）。

## 命令

```bash
pnpm --filter plasticwan-admin-next run check   # TypeScript 严格检查（tsc --noEmit）
pnpm --filter plasticwan-admin-next run build   # 产出 dist/（静态 SPA）
pnpm --filter plasticwan-admin-next run dev     # Vite dev server，监听 127.0.0.1:5273
pnpm --filter plasticwan-admin-next run test:e2e # Playwright 浏览器 E2E（见下文）
```

- `pnpm --filter plasticwan-admin-next run dev` 会把 `/api` 代理到 `ADMIN_API_TARGET`（默认
  `http://127.0.0.1:8787`），仅当浏览器 Origin 精确等于
  `http://localhost:5273` / `http://127.0.0.1:5273` 时才重写 Origin 为目标的
  origin；其它 Origin 原样转发，由后端拒绝。
- 生产环境不需要 `ADMIN_API_TARGET`：`serve` 在同源托管静态文件与 `/api`。
- Lint/格式检查走仓库根目录的 Biome（`pnpm exec biome check apps/admin-next`）。

## 安全约定

- 主题初始化用同源 `public/theme-boot.js`（`localStorage` 键 `admin-theme`），
  不引入内联脚本、不写 cookie、不注入 HTML。
- 业务代码不引入 `dangerouslySetInnerHTML` / `document.cookie`；
  `src/components/ui/**`（shadcn vendor）是仅有的窄豁免目录。

## 许可与字体

本前端源自 Kiranism 的开源 dashboard 模板，MIT License 全文保留在
`LICENSE`（Copyright (c) 2025 Kiranism）。自托管字体来自 @fontsource 包
（Inter），按 SIL Open Font License 1.1 分发；随镜像发布的三方许可说明见
`NOTICE`。

## E2E 测试

```bash
pnpm run admin:build                       # 前置：E2E 驱动已构建的 dist
pnpm --filter plasticwan-admin-next exec playwright install chromium  # 首次运行前安装 Chromium
pnpm run admin:test:e2e                    # 或在本目录 pnpm --filter plasticwan-admin-next run test:e2e
```

Playwright 套件位于 `e2e/**/*.e2e.ts`（文件名不以 `.test.ts` 结尾，vitest
不会发现它们）。`globalSetup` 派生 Node 子进程 `e2e/server.ts`：临时目录 + 临时
SQLite + `test/fixtures/admin-seed.ts` 合成数据 + 真实 `AdminServer`
（`static_dir` 指向本包 `dist`），回环随机端口；`globalTeardown` 关闭并清理。
用例覆盖认证状态机、13 路由深链接、列表过滤与 Load more 游标分页、Invocation
六 Tab、记忆/管理员/模型/告警/Overview 写操作与冲突路径、只读保证与 CSP 同源
安全断言。真实命令与契约清单见
[agent-doc/verification.md](../../agent-doc/verification.md#admin-panel-浏览器-e2e)。

## 数据请求约定

- 业务页面一律使用 `useQuery` / `useInfiniteQuery` 并显式渲染
  loading / error / data 三态，**禁止 `useSuspenseQuery`**。查询被拒时
  promise rejection 会在渲染期抛出并落进路由错误边界，产生无法恢复的
  “Something went wrong” 死屏；显式状态分支把错误留在页面内展示
  （`ApiError.code: message`）。
- 受保护请求返回 401（code `unauthenticated`）由
  `src/lib/query-client.ts` 的全局 Query/MutationCache `onError` 集中处理：
  失效 session query，让 AuthGate 回到登录 gate。登录 / setup / 改凭据的
  `invalid_credentials` 等 401 属于表单错误，必须留在表单内展示，不得被
  全局处理吞掉（判定按错误 code，不是按 status）。

## 共享业务组件契约

页面必须复用 `src/components/business/` 下的公共层，不要复制各自的
加载/错误/空态实现，也不要发明跳页或全量排序。统一从 barrel 导入：

```ts
import {
  ChartPanel, ConfirmDialog, CursorList, FilterToolbar, JsonViewer, KvList,
  LazyDetails, MonoValue, PrivateReasoningNote, PrivateReasoningTag,
  SelectFilter, StateBadge, TableShell, TextValue, TimeSeriesChart, flatPages,
  type ColumnSpec, type CursorQueryFactory, type CursorQueryOptions,
} from '@/components/business';
```

### 游标列表容器 `cursor-list.tsx`

- `CursorList<T, TQueryKey>`：props 为 `factory`（`(filters: ListFilters) =>
  CursorQueryOptions<T>`，直接传 `lib/queries.ts` 的工厂如 `invocationsQuery`）、
  `filters`、`renderItems(items)`，可选 `empty` / `errorTitle` /
  `skeletonRows` / `loadMoreLabel` / `className`。
- 组件内部调用 `useInfiniteQuery`（每页 25 条，`next_cursor` 透传），自行渲染
  loading 骨架、错误态（`ApiError.code: message`）、空态和 “Load more” 按钮
  （仅当 `next_cursor` 非空）。
- **禁止**：跳页、总页数、对已加载数据的客户端排序、把 error 当空态。
- 过滤变化 = query key 变化 = 已加载分页自动重置，页面只需把过滤值放进
  `filters`。
- `flatPages(query.data)` 把分页拍平成数组，详情展开等场景可单独使用。

### 过滤工具栏 `filter-toolbar.tsx`

- `FilterToolbar`：flex-wrap 容器，子项自动换行。
- `TextFilter`：受控文本过滤，提交/清除语义。props：`value`（已应用的过滤值，
  `undefined` 表示未过滤）、`placeholder`、`onCommit(value)`（回车或搜索按钮，
  trim 后提交）、`onClear()`（清空输入并清除已应用过滤）。**清除按钮会立即
  重置过滤与分页**（这是相对旧面板非受控 `Input.Search` 的有意改进）。
- `SelectFilter<T extends string>`：下拉即时生效，`onChange(value | undefined)`
  立即回调；选项用 `FilterOption[]`（`{ value, label }`），列表里自带
  “All” 项表示无过滤。不要拿它做延迟提交。

### 状态徽章 `state-badge.tsx`

- `StateBadge({ state })`：state → `stateColor`（`lib/format.ts` 的状态色表）
  → 语义变体（success/info/warning/danger/neutral）。未知状态与未知颜色一律
  兜底 neutral；`null`/空串渲染为 `—`。
- `stateBadgeSemantic(state)`：纯函数，测试/样式复用。

### JSON 查看器 `json-viewer.tsx`

- `JsonViewer({ value, title?, defaultMode?, initiallyCollapsed?, collapseThresholdChars? })`：
  树/文本切换；畸形 JSON 自动降级为原文（文本模式）；payload 超过
  `collapseThresholdChars`（默认 2000）默认折叠并显示字符数；**只渲染文本，
  永不执行 HTML**；`value` 为 `null`/空串时显示 `—`。
- 文本内容不一定合法 JSON（如 `result_text`），直接传字符串即可。
- 折叠的大 payload 走 `LazyDetails`，展开前不构建 JSON 树。

### 懒挂载折叠区 `lazy-details.tsx`

- `LazyDetails({ summary, children, className?, summaryClassName?,
  contentClassName? })`：原生 `<details>` 语义 + **展开前不挂载 children**。
  原生 `<details>` 只是把子树隐藏起来，仍然会渲染 DOM——重内容（`JsonViewer`
  树、tool registry 表格、长文本）必须用它包一层。
- 首次展开后 children 常驻，折叠不清空查看器内部状态（树/文本模式、节点展开）。
- 需要多段内容的折叠区用 `contentClassName` 承担原先内层 `<div>` 的间距类。

### 键值明细与文本 `kv-list.tsx`

- `KvList({ items: { label, value }[] })`：详情页诊断字段网格，多列自适应。
- `TextValue({ value })`：可空文本，空值显示 `—`。
- `MonoValue({ value })`：可空等宽 ID（bigint 字符串字段保持字符串，不要
  转 `Number`）。

### 二次确认弹窗 `confirm-dialog.tsx`

- `ConfirmDialog({ open, onOpenChange, title, description?, confirmText,
  cancelText?, destructive?, pending, error, onConfirm })`，供破坏性/控制
  操作使用。
- **确认按钮必须用 `onClick`（内部会 `preventDefault()`）**：Radix 的
  `AlertDialogAction` 按 `Dialog.Close` 语义渲染，点击默认关闭弹窗；
  `onSelect` 是 Select/DropdownMenu 的 API，AlertDialog Action 不消费它——
  挂 `onSelect` 会导致点击只关弹窗、`onConfirm` 永不执行。
  `preventDefault()` 抑制 Radix 隐式关闭，让 mutation 真正跑起来。
- **弹窗不自动关闭契约**：确认后由调用方在 mutation 成功/取消时设置
  `open=false`；`pending` 期间两个按钮禁用防重复提交，失败时弹窗保持打开
  并内联展示 `error`（`ApiError.code: message`）。调用方的 `onOpenChange`
  应在 mutation pending 时拒绝关闭（`!open && !pending` 才置 false）。
- **文案契约**：`confirmText` 必须描述具体动作（如 `Cancel alarm` /
  `Delete memory`），且必须与 dismiss 文案可区分——组件在渲染时校验
  `confirmText !== cancelText`，两者相同会直接抛错；默认 dismiss 文案为
  `Dismiss`，不要再把 dismiss 写成 `Cancel` 与确认动作混淆。

### 表格外壳 `table-shell.tsx`

- `TableShell<T>({ columns: ColumnSpec<T>[], data, rowKey, expandedRender?,
  isExpandable?, emptyText?, className? })`，基于 `ui/table`；横向滚动由
  Table 自带。行展开是本地 state（chevron 列）。
- `ColumnSpec<T>`：`{ key, title, align?, width?, className?, render(row) }`；
  长文本列记得加 `className: 'whitespace-normal min-w-… max-w-…'` 覆盖
  `TableCell` 的 `whitespace-nowrap`。
- 无跳页、无排序、无批量选择。

### 图表卡片 `chart-card.tsx`

- `ChartPanel({ title, children, className? })` + `TimeSeriesChart({ data,
  series, height? })`：基于 recharts 的时间序列折线封装，Overview/Usage
  使用。`ChartSeries = { dataKey, label, color }`，
  `ChartDatum` 的 `date` 字段作 x 轴。只画 API 真实返回的序列，不合成指标。

### 私有推理标记 `private-reasoning.tsx`

- `PrivateReasoningTag()`：金色徽章“Private reasoning”，用于 assistant 行。
- `PrivateReasoningNote()`：说明文案——assistant 文本是私有推理，只有成功的
  `send` tool call 才发往 Telegram。
- 任何展示 agent 消息的页面都必须把 assistant 普通文本标为私有推理。

### 详情页状态 `detail-state.tsx`

- `DetailSkeleton()`：详情页统一的 loading 骨架（两个大块占位）。
- `DetailError({ error, notFoundTitle, failedTitle, backTo, backLabel })`：
  详情页错误态——404 显示 `notFoundTitle`，其余失败显示 `failedTitle`，
  消息行用 `lib/errors.ts` 的 `errorMessage`（`ApiError.code: message`），
  底部是回到列表的链接。
- 三个详情页（invocation / context / message）共用这两个组件，页面自身只
  保留 `isPending / isError / data === undefined` 的控制流和第三态（数据）
  渲染；`useSuspenseQuery` 依旧禁用。

### 契约禁止事项

- 共享组件不内嵌任何具体页面的业务字段；页面通过 render 函数/ColumnSpec 提供。
- 不在共享组件里使用 `useSuspenseQuery`、不调用受保护接口、不做 mutation。
- 不引入遗留 UI 组件库依赖；样式用 Tailwind 语义类，暗色模式同时覆盖。
