# Plastic Wan - 20260927 Rspress 中文文档站

## 背景

此前仓库没有独立的用户文档站，维护知识主要放在 README 与 `agent-doc/`。这次新增中文、单版本的静态站，按部署和使用任务组织内容，让用户与协助部署的 Agent 都能找到说明，而不是直接公开面向维护者的主题文档或历史设计。

边界是文档工程，不扩展 Bot 能力、不改变 Admin 业务，也不把完成构建等同于公开部署。站点需要同时提供可浏览的 HTML、逐页 Markdown 和 llms 索引，并标明对应源码版本；示例必须能通过当前配置加载器，但验证不能读取真实配置、解析真实凭据或连接外部服务。

## 主要变更

### 1. 独立站点与按任务组织的指南

新增 `plasticwan-docs` workspace，锁定 Rspress 2.0.22。轻量首页介绍产品、人格和常用任务，复用框架默认布局、导航、搜索、代码复制与 Markdown 入口，不另建组件库。首页对话明确标为虚构示意，不冒充真实 Bot 回复或已保存记忆。

正文共 20 个文档页面，包含文档入口和生成字段页；加首页后是 21 对 HTML/Markdown 页面。内容覆盖快速开始、安装、配置与密钥、Telegram、模型、Admin、人格、参与、按群配置、记忆、预算、扩展、升级、备份恢复、排障与参考。

内容复核修正了两个会误导实际操作的问题：MCP `tool_policies` 使用带 `name` 的策略数组；恢复说明要求同时隔离 `data_dir` 与各个数据路径，Docker 还须使用独立宿主机卷，并明确同一 Telegram Token 不能同时轮询。这里只修正并审阅说明，没有执行真实恢复演练。

实现入口：[apps/docs/package.json:6](../../apps/docs/package.json#L6)、[apps/docs/theme/HomeIntro.tsx:5](../../apps/docs/theme/HomeIntro.tsx#L5)、[apps/docs/content/docs/guides/extensions.md:26](../../apps/docs/content/docs/guides/extensions.md#L26)、[apps/docs/content/docs/operations/backup-restore.md:26](../../apps/docs/content/docs/operations/backup-restore.md#L26)。

### 2. 配置参考、示例和版本来源只保留一个源

- 从当前 `ConfigSchema` 生成字段参考与可下载 JSON Schema；遍历对象、数组和联合分支，描述类型、所在对象内的必填性与显式约束，不把“可选”推断成“存在默认值”。运行时语义和热更新规则仍由手写指南解释。
- 三个安全示例以源码目录为唯一来源，生成时按白名单复制。测试将完整示例及正文 JSONC 片段放入临时目录，经过真实 `loadConfig` 语义校验，同时断言没有明文 Secret，不执行 SecretRef 解析或服务连接。
- 生成 `build-info.json`，记录完整 Git SHA、dirty 状态、origin 和 base。页面与 llms 输出共同标注对应源码提交；未提交的产物显示“仅供本地预览”，不把更新时间或源码 SHA 当成镜像版本承诺。
- 字段页、Schema、版本信息、公开示例副本和构建产物均被 Git 忽略，避免生成内容和源码并行漂移。

实现入口：[scripts/docs-prepare.ts:42](../../scripts/docs-prepare.ts#L42)、[scripts/docs-prepare.ts:103](../../scripts/docs-prepare.ts#L103)、[scripts/docs-prepare.ts:118](../../scripts/docs-prepare.ts#L118)、[test/docs-examples.test.ts:51](../../test/docs-examples.test.ts#L51)、[apps/docs/theme/VersionNotice.tsx:3](../../apps/docs/theme/VersionNotice.tsx#L3)。

### 3. HTML、Markdown 与真实静态响应一起验证

站点开启 HTML SSG 与 Markdown 导出，提供逐页 Markdown、`llms.txt` 和 `llms-full.txt`。公开下载链接在两种渲染之前统一替换 base 前缀；使用 `.html` 深链并关闭 HTML fallback，防止缺失的 Markdown 被首页伪装成成功响应。部署 origin 拒绝凭据、路径、查询和片段，base 只接受限定的斜杠分隔路径。

新增产物验证脚本：检查来源 SHA、Schema 与示例是否过期，核对每页标题、唯一 H1、来源标识、代码块保留、链接、搜索索引和 llms 内容。扫描未解析的 `__DOCS_BASE__`、私有目录产物以及构建机路径泄漏，而不是跳过这些检查来让构建通过。

静态检查之后启动框架原生生产 preview，逐个比较 HTTP 响应与磁盘文件的字节、状态和 MIME，并断言不存在的 Markdown 返回 404；检查结束在 `finally` 关闭服务。根路径与子路径使用同一逻辑，不用自制测试服务器掩盖真实托管行为。公网主机仍须单独验收。

实现入口：[apps/docs/rspress.config.ts:9](../../apps/docs/rspress.config.ts#L9)、[apps/docs/rspress.config.ts:35](../../apps/docs/rspress.config.ts#L35)、[scripts/docs-verify.ts:68](../../scripts/docs-verify.ts#L68)、[scripts/docs-verify.ts:146](../../scripts/docs-verify.ts#L146)、[scripts/docs-verify.ts:163](../../scripts/docs-verify.ts#L163)。

### 4. 将框架兼容处理限制在实际故障处

- Rspress 2.0.22 的搜索叶子路由缺少扩展名，通过 `modifySearchIndexData` 调用框架原生 `normalizeHref` 补齐，目录路由保留结尾斜杠。
- 本地搜索不使用 worker 或持久化，将 FlexSearch 精确 alias 到同包 compact ESM 构建，排除未使用的 worker fallback 携带的本机路径；没有放宽产物泄漏检查。
- 默认主题未落实生成页的 `editLink` / `lastUpdated` frontmatter 开关，用两个小包装隐藏无效编辑链接与 Git 时间，手写页继续保留编辑入口。首页和版本说明也提供 Markdown 渲染分支，避免只有 HTML 能读到自定义内容。
- 生产键盘验收发现搜索 Enter 全局处理及空结果上下键越界，使用版本锁定的 pnpm 补丁约束为打开面板中的搜索输入，并检查候选是否存在。不复制整个搜索组件，也不手改安装目录。

搜索回归从已安装包提取真实处理器，在 Node `vm` 中验证关闭状态、空结果、非输入目标、输入法组合、失效索引和正常上下键/Enter 导航。升级导致处理器结构变化时测试会失败，要求重新审查补丁，而不是悄悄保留失效修复。

实现入口：[apps/docs/rspress.config.ts:20](../../apps/docs/rspress.config.ts#L20)、[apps/docs/rspress.config.ts:57](../../apps/docs/rspress.config.ts#L57)、[apps/docs/theme/index.tsx:14](../../apps/docs/theme/index.tsx#L14)、[apps/docs/theme/index.tsx:50](../../apps/docs/theme/index.tsx#L50)、[patches/@rspress__core@2.0.22.patch:1](../../patches/@rspress__core@2.0.22.patch#L1)、[test/docs-search.test.ts:8](../../test/docs-search.test.ts#L8)。

### 5. 构建接入与发布边界

根 `check` 纳入文档类型检查，新增 docs 开发、构建、预览和验证命令，并更新仓库导航。维护说明集中在 [apps/docs/README.md](../../apps/docs/README.md)，公开内容根不包含 `agent-doc/` 或历史资料。

新增 CI 用 Node 24 分别检查 `/` 与 `/plastic-wan/`，上传静态检查 artifact；另配置 Bot 镜像构建与 docs 依赖隔离冒烟。CI 没有公开发布 job，`https://docs.example.com` 只是验证用 origin。

Docker 构建上下文排除文档站；由于共享锁文件即使在 docs workspace 缺席时也会校验 patch，安装层先复制补丁，再冻结安装。最终 runtime 不复制 docs 或补丁。没有修改 Bot/Admin 业务源码，没有数据库迁移，也没有修改产品配置 Schema。

实现入口：[package.json:14](../../package.json#L14)、[.github/workflows/docs.yml:12](../../.github/workflows/docs.yml#L12)、[.github/workflows/docs.yml:52](../../.github/workflows/docs.yml#L52)、[Dockerfile:14](../../Dockerfile#L14)。

## 验证

以下记录实现及代码提交前实际运行的检查，包含最终搜索补丁与主题包装。全量 pnpm 链路的实际运行时记录为 Node 26.5.0，pnpm 为 12.4.2；不能因为外层直接调用的 `node` 是 24，就把全部测试写成 Node 24 通过。

```bash
pnpm install --frozen-lockfile
# 通过；已有本地依赖环境上的冻结安装，不等同全新联网安装

pnpm exec vitest run test/docs-examples.test.ts test/docs-search.test.ts
# Test Files 2 passed (2) / Tests 5 passed (5)

pnpm run check
# runtime、Admin、docs TypeScript 检查通过

pnpm test
# Test Files 51 passed (51) / Tests 589 passed (589)

pnpm run admin:build
# Rsbuild 生产构建通过

pnpm run lint
# lint 280 文件、format 277 文件通过；No fixes applied

git diff --check
git diff --cached --check
# 无输出；新增文件暂存前另做逐文件 whitespace 检查
```

两种 base 分别运行 `pnpm run docs:build` 和 `pnpm run docs:verify`，origin 均为测试值 `https://docs.example.com`：

| `DOCS_BASE_PATH` | 生产构建与 HTTP 验证 |
| --- | --- |
| `/plastic-wan/` | 21 对 HTML/Markdown 页面、76 个 HTTP 资源通过 |
| `/` | 21 对 HTML/Markdown 页面、76 个 HTTP 资源通过 |

随后绕过 pnpm 的 Node 26 路径，直接使用 Node 24.18.0 复验文档 Vitest（2 文件 / 5 测试）、生成脚本、两个 base 的 Rspress 生产构建与验证，以及 docs 的 `tsc --noEmit`，全部通过；每个 base 仍为 21 对页面、76 个 HTTP 资源。此结果只覆盖文档链路，不扩展为全仓库 Node 24 或 Linux/原生依赖验收。

代码提交前再次运行 `pnpm run check`、`pnpm test test/docs-examples.test.ts test/docs-search.test.ts`、`pnpm run lint` 与差异检查，均通过。上述生产产物是在功能提交前生成，携带当时的基线 SHA 和未提交标识，不是该功能提交在干净 checkout 上的发布产物；提交后要使用新版本产物须重新构建与验证。

本篇日志编写后再次运行类型检查、上述 5 项文档测试、lint 与差异检查，结果通过；另外核对了本文 25 个相对文件链接及行号锚点。此次仅新增日志，没有重新执行全量测试或生产构建。

### 负向与浏览器检查

- 在忽略的产物目录添加包含未解析前缀的临时 fixture，verify 按预期以 `Unresolved public-resource prefix` 失败；清理后正常验证再次通过。构建机路径负向 fixture 也被拒绝。
- 临时目录只复制 root/Admin manifest、workspace、lockfile 与 patches，执行 `pnpm install --frozen-lockfile --ignore-scripts --offline` 成功，验证 docs workspace 缺席时锁文件与补丁解析；它不等同 Docker 安装或原生依赖构建。
- 原生生产 preview 下，1280px 与 375px 首页无页面级横向溢出，移动端文档也无页面级横向溢出；导航、侧栏打开、暗色样式和搜索键盘路径完成局部检查。空搜索结果的上/下/Enter 不报错、不导航；有效结果可选择并用 Enter 进入 `.html` 页面。
- Ctrl+K 打开并聚焦搜索，Escape 关闭，最终无 page errors；但 Escape 后焦点落到 BODY，没有宣称焦点恢复或完整焦点圈闭已通过。自动化便捷 Enter 操作未触发原生 click 的差异，用标准 CDP 按键事件复核，没有为工具差异另加应用补丁。
- 浏览器结论来自本次本地操作记录，不是完整 E2E 套件或视觉/无障碍认证。复制只核对选中文本与调用内容，未读取系统剪贴板；没有真实 Admin 截图。预览和临时 fixture 在收尾时清理。

### 尚未验证

本机 PATH 无 Docker，未执行真实镜像构建或运行；GitHub Actions 也未实际执行。没有公开部署，真实主机的深链、MIME、缓存与 Markdown 404 仍待验收。

未运行真实 Bot、Doctor、Telegram、Provider、MCP、备份恢复或迁移演练；未读取真实配置、密钥或数据库。离线示例、静态产物与本地 HTTP 检查通过，不能替代这些环境门槛。

## 提交

```txt
e840fd80cc4cf8e36cefd80a952d363e2a8af288 Add Rspress documentation site
```
