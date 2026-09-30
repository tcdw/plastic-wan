# Plastic Wan - 20260930 模型调试报文按需记录与历史清除

## 背景

模型调用的请求与响应快照原本无条件写入 SQLite，方便在 Admin Panel 的 Invocation 详情中排查问题。请求可能包含大型 Prompt JSON，持续保存会显著增加数据库占用。此前 Invocation 列表查询延迟的排查也暴露了大型审计行带来的成本，因此需要把调试报文明确改成默认关闭、按需开启的能力，并提供主动清除历史报文的入口。

这次改动只控制调试快照：Invocation、模型调用、工具调用、Token/cache usage、费用、状态和错误仍然正常审计。升级不能自动删除已有报文，也不能通过日志文件、另一套配置或存储机制绕开这个边界。

## 主要变更

### 1. 可选配置默认关闭，沿用现有热更新

在 `src/platform/config.ts:324` 增加可选的 `developer` 节，其中 `record_model_payloads` 也是可选 boolean，默认值为 `false`。旧配置不需要补字段；缺少整个节或使用空对象时，`assembleRawConfig` 都将运行时值归一为 `false`，文件层仍保留原来的缺省状态。

`src/platform/config-diff.ts` 将节的增删和字段变化纳入热更新。Admin 修改开关仍走 `ConfigReloader.writeAndApply` 与既有 JSONC 原子写入流程，保留注释，并通过 `If-Match` revision 拒绝覆盖并发编辑。没有增加独立设置表、配置文件或数据库迁移。

保存与应用沿用现有的两阶段语义：应用失败时，配置文件可能已保存，运行配置保持原值。因此 Developer API 同时返回文件值与运行值，页面在两者不一致时说明当前运行状态，并提示到 Settings 应用配置。

### 2. 在统一模型调用入口控制快照

核对所有写入路径后，现有模型请求与响应快照均由 `src/orchestration/agent-runtime.ts` 的统一流式调用回调保存。开关放在这个入口，避免只覆盖某个 Provider；`telegram_sends` 的同名字段不属于本次调试功能，保持原有行为。

每个 model call 开始时读取当前开关，回调写入前再次检查运行值：

- 关闭时不序列化或写入新的请求/响应快照，但 model call 本身及正常审计继续记录。
- 开启时保留原有捕获能力，同一个 Invocation 内后续 model call 也能使用热应用后的值。
- 关闭期间，在途调用的后续快照回调停止写入；重新开启不会补录关闭时启动的调用。
- 开关变化不修改已保存的历史快照。

这里保持原有快照范围：请求里的内联图片正文仍替换为结构化摘要，响应快照仅保存 HTTP status，并非完整响应流。已有 Vision/doctor 路径没有模型原始快照写入，本次也没有额外扩展它们的捕获范围。

### 3. 独立 Developer 页面与受控清除端点

Admin 的 Manage 导航新增 Developer，复用现有文件路由、Card、配置写入反馈和 `ConfirmDialog`。`apps/admin-next/src/pages/developer.tsx` 提供「记录原始请求报文以便调试」开关，以及需要二次确认的「清除此前记录的原始请求报文」。页面同时说明数据库占用和文件大小语义。

`src/ingress/admin/server.ts` 增加 `GET /api/developer`、`PUT /api/developer` 与 `DELETE /api/developer/model-payloads`，沿用现有登录和 Origin 检查；新增写端点同步登记到 Admin 文档白名单。

清除由 `src/ingress/admin/developer-admin.ts:20` 实现：固定操作开始时最大的 model call ID，沿主键每批最多读取 100 个 ID，再对该范围做集合更新，只将 `model_calls.request_json` 和 `model_calls.response_json` 置为 `NULL`。报文不加载进 JS，也不逐行更新；每批完成后释放写锁并通过 `setImmediate` 让出事件循环，避免同步 SQLite 的整库长事务持续占住 Bot 主进程。

不删除 Invocation、model/tool call、Telegram 发送或关联，不修改 Token/cache、费用、状态、错误与 retention。两列原本就允许 `NULL`，无需迁移。固定 ID 上界让新调用不会无限延长清除；记录开关仍开启时，新报文可以继续保存。并发清除返回 409 `clear_in_progress`，成功返回清除的 model call 数；重复清除可返回 0。中途失败保留已完成批次，可重试。

页面成功后显示清除数量，并使 Invocation 详情缓存失效；失败时也刷新详情，因为此前批次可能已提交。历史调用的空快照正常显示为未记录或已清除，不改变其他详情和统计语义。

清除只作用于在线数据库，不修改既有备份。SQLite 释放的页可供后续写入复用，`.db` 文件不保证立即缩小；端点不执行 `VACUUM`。未对用户实际历史数据库执行清除。

### 4. 行为测试与文档同步

`test/admin-developer.test.ts` 覆盖缺失节、空节、显式 false/true 的加载与往返写入，删除配置后的默认值、热应用、鉴权、Origin、revision 冲突、严格 body 校验及应用失败后的恢复。清除测试使用超过两批的合成记录，逐字段比较清除前后数据，验证正常审计、关联、统计、外键完整性和幂等，并在批次之间插入新调用验证固定清理边界。

`test/agent-runtime.test.ts` 在缺省、false、true 三种初始状态下验证模型调用与快照，并在同一 Invocation 内热切换开关，检查调用用量和日预算审计。依赖请求快照的 Context、Alarm 和持久任务测试改为显式开启记录，其余测试继续覆盖默认关闭状态。

浏览器测试新增 Developer 深链接、开关保存与刷新持久化、取消/确认清除、清除前后详情对比、文件已保存但应用失败的反馈及 Settings 恢复流程，并检查移动端暗色布局。已查看桌面、手机页面和确认弹窗截图。

同步更新公开 Admin 指南、配置参考与示例，以及配置、数据层、Admin、验证主题文档；文档示例测试检查新增配置字段进入生成参考。

## 验证

以下为功能实现阶段实际运行的最终验证结果；日志阶段仅新增本文，没有重新运行代码测试或真实 Telegram/Provider 检查。

```bash
pnpm test test/agent-runtime.test.ts test/context-hot-inject.test.ts
# 2 个文件、41 项测试通过

pnpm test
# 最终全量重跑：58 个文件、680 项测试全部通过

pnpm run check
# runtime、Admin、docs TypeScript 检查通过

pnpm run lint:fix
# 修正新增页面与测试的格式

pnpm run lint
# lint 303 文件、format 300 文件通过
# 各有 1 条既有 test-tmp 临时 JSON 超过 1 MiB 的跳过警告

pnpm run admin:build
# Admin 生产构建通过，生成 Developer 文件路由

pnpm run admin:test:e2e
# 107 项浏览器测试全部通过

pnpm run admin:test:e2e 00-auth.e2e.ts 10-developer.e2e.ts
# 调整截图等待动画结束后复验：6 项通过

pnpm run docs:build
# 文档站生产构建通过

pnpm run docs:verify
# 验证 21 个 HTML/Markdown 页面及 76 个 HTTP 资源通过
# 同时检查搜索、示例、schema 与 provenance

git diff --check
git diff --cached --check
# 代码提交前通过
```

自动化验证使用临时 SQLite、合成审计数据和 Faux Provider；浏览器测试运行真实 AdminServer 与生产前端 bundle。未将这些结果表述为真实外部模型调用或生产数据库清理验收。

## 提交

```txt
6abc03acb5f719eb34fbd55a26501bd3b2551b2f Add opt-in model payload debugging controls
```
