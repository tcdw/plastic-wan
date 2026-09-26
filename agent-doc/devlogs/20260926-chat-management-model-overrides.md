# Plastic Wan - 20260926 Chat 管理与按群模型覆盖

## 背景

此前所有 Chat 共用全局 Agent 模型与 thinking 设置，Telegram `/model` 修改的也是全局默认；Admin Panel 的 Models 页管理 Provider 和模型，但 Chat / Topic 白名单仍要手工编辑配置文件。

这次把模型选择下沉到 Chat，并在 Manage → Chats 中提供白名单和模型覆盖的管理入口。关键约束是不引入 Topic 级模型：同一 Chat 的所有 Topic 共用模型设置，Conversation Context 仍按 Topic 隔离。同时必须区分“文件已保存”和“当前进程已生效”，不能把待重启的白名单变化显示成已经应用。

## 主要变更

### 1. Chat 覆盖、继承与 Invocation 快照

- `telegram.chats[]` 新增可选的 `provider`、`model`、`thinking_level`。Provider 与 model 必须成对出现，thinking 可以独立覆盖；未覆盖的项继承全局 `agent.*`。
- `resolveAgentSettings` 统一解析生效设置。配置校验检查模型引用、text 输入能力，以及继承之后的 thinking 兼容性，不合法组合直接拒绝。
- Agent Runtime 在 Invocation 开始时按 Chat 解析模型、thinking、图片能力和 Tool Schema 关键字策略；复用缓存 Agent 时也重新绑定 thinking，避免沿用上一次运行的档位。
- 正在运行的 Invocation 继续使用启动快照；排队中的 Invocation 在转为 running 时取得当前快照。切换模型本身不强制清空 Context，只有稳定系统提示实际变化才按原有规则重建。
- 群迁移复用现有配置解析规则；直接配置迁移后的新 Chat ID 时，新 ID 的配置优先于旧群配置。

实现入口：[src/platform/config.ts:343](../../src/platform/config.ts#L343)、[src/orchestration/agent-runtime.ts:236](../../src/orchestration/agent-runtime.ts#L236)。

### 2. 按群命令与热更新边界

- Telegram `/model` 的列表和切换改为当前 Chat 语义，切换时将该 Chat 的 thinking 重置为目标模型支持的最弱档；`/model default` 清除三项覆盖，恢复继承全局。
- `/status` 展示当前 Chat 的生效模型和 thinking，并标明继承全局的项目。Admin Models 页的模型/thinking 写端点仍只修改全局默认，不改动 Chat 覆盖。
- 已有 active Chat 的模型覆盖可以热应用；Chat 增删、Topic 范围与其它非白名单字段仍需重启。写配置时按文件中的 Chat ID 定位，并用 revision 防止数组重排导致改错对象。
- 发布前验证全局默认和所有 Chat 的生效模型；Provider / 模型删除保护纳入 Chat 引用。已经从文件移除但仍在运行态等待重启移除的 Chat，其模型引用仍受 candidate 校验保护。
- MCP Tool 注册校验覆盖各 Chat 选用的模型；Doctor 按全局默认与 Chat 选用的 provider/model/thinking 组合去重后执行探针，而不是只检查全局模型。

实现入口：[src/platform/config-reload.ts:155](../../src/platform/config-reload.ts#L155)、[src/platform/config-diff.ts:255](../../src/platform/config-diff.ts#L255)、[src/orchestration/bot-commands.ts:307](../../src/orchestration/bot-commands.ts#L307)、[src/platform/providers.ts:123](../../src/platform/providers.ts#L123)。

### 3. Chats 管理 API

新增 `GET /api/chats`、`POST /api/chats`、`PUT /api/chats/:id` 与 `DELETE /api/chats/:id`，复用现有认证、Origin 检查、配置写锁与 `ConfigReloader`。

- 读取视图取文件与运行态 Chat ID 的并集，分别返回 `saved` 和 `active`；待新增、待删除与设置不一致都能表达。名称、类型和迁移后的 ID 来自本地 SQLite，不额外查询 Telegram。
- HTTP 中 Chat / Topic ID 保持十进制字符串，校验安全整数后才转换成配置值；拒绝零、前导零、越界整数、重复 Topic 和未知字段。
- 写入必须带 `If-Match`。revision 在 body 解析前核对，在写锁内再次核对；请求体保持 8 KiB 上限。
- 编辑只改 Topic 范围和三项模型设置，保留 JSONC 注释、instructions、参与策略与忽略用户等其它字段。删除移除整个配置项，但不删除消息、Context、记忆或审计历史；最后一个配置 Chat 不能删除。
- 文件写入成功后应用失败，不回滚文件、不改变 active 快照；错误明确以 `config.jsonc was updated but not applied:` 开头，并记录配置应用失败状态。

实现入口：[src/ingress/admin/chats-admin.ts:19](../../src/ingress/admin/chats-admin.ts#L19)、[src/ingress/admin/server.ts:606](../../src/ingress/admin/server.ts#L606)。

### 4. 保存态与运行态并排展示

Manage → Chats 同时显示 Saved settings / Running settings，并区分 Addition pending、Removal pending、Changes pending 与 Active。表单可编辑 Topic 白名单、模型和 thinking；选择 Global default 恢复模型与 thinking 继承，也能单独覆盖 thinking。

编辑表单和删除确认在打开时冻结数据与 revision。后台 refetch 不会把旧草稿的 revision 升级成新值；冲突后关闭旧对话框，要求重新打开。Models / Chats 写入及 Settings 应用配置，无论成功或失败都会刷新相关视图，确保“文件已保存但应用失败”不会被隐藏。

待重启横幅复用现有控件。只有部署声明 supervisor 时才显示 Restart now；未声明时提示人工重启，不把请求进程退出伪装成自带监督能力。

实现入口：[apps/admin-next/src/pages/chats.tsx:80](../../apps/admin-next/src/pages/chats.tsx#L80)、[apps/admin-next/src/pages/chats.tsx:268](../../apps/admin-next/src/pages/chats.tsx#L268)、[apps/admin-next/src/lib/use-provider-write.ts:20](../../apps/admin-next/src/lib/use-provider-write.ts#L20)。

### 文档与数据影响

同步更新配置、架构、Telegram 流程、Admin 写端点白名单、运维与验证文档，以及 Admin 前端说明。没有新增数据库表或迁移，也没有新增依赖；既有配置省略 Chat 模型字段时继续继承全局。Telegram `/model` 从全局切换变为当前 Chat 切换，是本次明确的行为变化。

### 测试

新增 [test/admin-chats.test.ts](../../test/admin-chats.test.ts)、[test/chat-model-runtime.test.ts](../../test/chat-model-runtime.test.ts) 和 [apps/admin-next/e2e/09-chats.e2e.ts](../../apps/admin-next/e2e/09-chats.e2e.ts)，并扩展配置、Provider、Bot 命令与路由回归。

覆盖 ID 与 Topic 边界、鉴权和 Origin、并发 revision 冲突、JSONC 保留、保存/运行状态分离、按群模型继承、缓存 thinking 重绑、Topic 共用模型、迁移优先级、Context 与模型调用审计，以及保存后应用失败和 Settings 恢复。浏览器测试还验证后台刷新不升级草稿 revision、删除确认和移动端暗色布局。

## 验证

以下命令均在本次实现与提交前实际运行；提交前再次执行了定向测试、lint、类型检查和差异检查。

```bash
pnpm test test/admin-chats.test.ts test/admin-providers.test.ts test/chat-model-runtime.test.ts
# Test Files 3 passed (3) / Tests 33 passed (33)

pnpm test
# Test Files 49 passed (49) / Tests 582 passed (582)

pnpm run admin:build
# Rsbuild 构建成功

pnpm run admin:test:e2e
# 102 passed (1.4m)

pnpm run lint
# lint 与 format 检查通过；No fixes applied

pnpm run check
# 根项目与 Admin 前端 TypeScript 检查通过

git diff --check
# 无输出

git diff --cached --check
# 无输出
```

浏览器 E2E 使用构建后的 SPA、真实 AdminServer 和临时 SQLite，监听随机回环端口；数据、凭据与失败注入都是隔离夹具，不启动实际 Bot。单元与运行时回归还检查了 `config_reloaded`、`config_reload_failed`、文件与 active 快照，以及 Context / 模型调用的落盘状态，不只检查返回文案。

未执行真实 Telegram、真实 Provider 或线上 Doctor 验收，也未验证生产 supervisor 的重启链路。自动化测试通过不代表这些外部场景已经验收。

## 提交

```txt
e5f6db67a07bc03be8e285c0583cff94abfaf7bc Add Chat management and per-chat model overrides
```
