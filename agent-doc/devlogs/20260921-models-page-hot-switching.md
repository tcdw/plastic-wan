# Plastic Wan - 20260921 Models 页全量热切换

## 背景

Admin 模型管理器（见 `agent-doc/design/20260920 Admin 模型管理器设计计划.md`）落地时采取「先重启」策略。Models 页上有相当一部分操作只写进 `config.jsonc`，要等服务端重启才生效：

- Provider 的连接字段（`base_url`、`api`、`api_key`、`headers`）以及 Provider 的新增、删除、改 kind。
- `vision.provider` / `vision.model` / `vision.max_output_tokens`。
- 在用模型保护：修改或删除 agent 或 vision 正在使用的模型，都会被归为 restart。
- 把 agent 指向一个进程还没注册的 Provider。

之所以这样，是因为模型注册表是启动时 `createModelRegistry` 建出来的一个共享 `MutableModels`，reload 只会对 `models[]` 的变化做原地 `setProvider`，连接字段沿用启动时解析好的凭据。另外，Pi 的 `Models.streamSimple` 每次调用都会按 `model.provider` 去注册表里找 Provider。结果是运行中的 Invocation 能钉住模型对象，却钉不住 Provider 连接：原地替换 Provider 会让正在跑的一轮换到新连接上。

用户的要求是「不惜一切代价」把 Models 页上所有需要重启的地方铲掉，并且每个 Invocation 都要把模型和 Provider 参数钉死。据此写成了设计计划 `agent-doc/design/20260921 Models 页全量热切换设计计划.md`（`1ad470f`），由 deepseek 按计划实现，之后评审时补了一处修复。

约束：

- Admin 只写 literal SecretRef。输入 key 是单向的。凭据绑定在 `base_url` 上。
- reload 不能半个生效：新注册表要么和配置一起发布，要么整次拒绝。
- 连接没变的 Provider 不能重新解析 SecretRef，因为 `command` 引用会起进程。

## 主要变更

### 1. 模型注册表进入配置快照

`RuntimeConfiguration` 新增了 `models` 和 `visionModel` 两个字段，快照发布时把配置和它的注册表放在一起（`src/platform/runtime-config.ts:12`）：

```ts
export interface ConfigurationModels {
  readonly models: Models;
  /** The model `config.vision` names, checked to exist and accept image input. */
  readonly visionModel: Model<Api>;
}
```

类型用只读的 `Models`，而不是 `MutableModels`：已发布的注册表不会再被修改。`ModelRegistry`、`createModelRegistry`、`rebuildCustomProvider` 和 `rebuildBuiltinProvider` 全部删掉。`AgentRuntime`、`AgentModelSwitcher`、`MediaService`、`AdminServer`、`ConfigReloader` 不再各自持有 `models`，统一从快照读取。

运行时的模型解析和请求发送都走 Invocation 在 `queued → running` 时拿到的那份快照（`src/orchestration/agent-runtime.ts:218`、`:464`）：

```ts
const model = snapshot.models.getModel(config.agent.provider, config.agent.model);
// ...
const stream = snapshot.models.streamSimple(streamModel, modelContext, {
```

因为 `streamSimple` 查的是快照自己的注册表，运行期间发布的新配置既碰不到这一轮的模型，也碰不到这一轮的 Provider 连接。

### 2. 每次 reload 重建注册表，连接没变的 Provider 原样复用

`buildModelRegistry(config, previous, secrets)`（`src/platform/providers.ts:55`）取代了原来的启动路径和原地重建两套逻辑。`previous` 传 `null` 就是启动路径。reload 时，对连接字段没变的 Provider，直接复用上一代的对象，只替换模型列表：

```ts
const existing = reusableProvider(previous, alias, configured);
if (existing !== null) {
  // The model list is built once and closed over, exactly as the provider it
  // replaces did: a lookup must not rebuild the objects on every call.
  const reused = providerModelsFor(alias, configured, existing);
  models.setProvider({ ...existing, getModels: () => reused });
  continue;
}
const apiKey = await secrets.resolve(configured.api_key);
```

判断「连接没变」看的是除 `models` 以外的全部字段（`src/platform/providers.ts:140`），所以 `kind` 或 builtin 的 `provider` 被改掉时，都按新连接处理：

```ts
export function sameConnection(left: ProviderFileConfig, right: ProviderFileConfig): boolean {
  return deepEqual(connectionOf(left), connectionOf(right));
}
```

新增的 Provider 或连接变了的 Provider，按启动路径完整构建并重新解析 SecretRef。`command` 引用因此会在 reload 时执行一次，效果和重启相同，而 reload 只由管理员的显式操作触发。

`ConfigReloader` 在锁内构建新注册表，然后在同一个同步块里把注册表和配置一起发布（`src/platform/config-reload.ts:275`）：

```ts
this.#store.publish({
  config: diff.candidate.raw,
  hash: activeHash,
  models: rebuilt.registry.models,
  visionModel: rebuilt.registry.visionModel,
});
```

构建失败时整次 reload 被拒绝，active 配置和注册表都不变。`secrets.ts` 新增 `SecretResolutionError`，覆盖三种情况：环境变量缺失、命令失败、结果为空。`#buildRegistry` 按错误类型映射到新的错误码 `secret_unresolved`（`src/platform/config-reload.ts:314`），其余构建失败仍然是 `model_unusable`。Admin 的写端点对 `secret_unresolved` 返回 422。

### 3. 热更新分类：Provider 全部字段与 vision 模型改为 hot

`src/platform/config-diff.ts` 把整个 `providers.` 前缀列为 hot（`:65`），并把 `vision.provider`、`vision.model`、`vision.max_output_tokens` 加进白名单（`:54`）：

```ts
const HOT_PREFIXES: readonly string[] = ['agent.rate_limits.', 'providers.'];
```

删除的逻辑：

- `InUseModels` / `isInUse` 在用模型保护。
- `mergeAgent` 里的 `providerIsNew` 分支。
- `candidateAgentProvider` / `candidateAgentModel`。

模型的新增、修改、删除，以及 Provider 的增删和改 kind，candidate 一律取文件里的值。

`vision` 仍是 restart 的字段只剩 `max_concurrency`、`background_sticker_concurrency`、`prompt_version` 和 `daily_budget`。

### 4. vision 分析按次钉住快照

`MediaService` 删除了构造时固定的 `#models`、`#model` 和 `#analysisVersion`。现在每次分析开始时取一次当前快照（`src/capabilities/media/media.ts:94`），聊天里的 `read_image` 和后台 Sticker 索引走同一条规则：

```ts
#visionRun(): VisionRun {
  const snapshot = this.#configStore.current();
  const model = snapshot.visionModel;
  return {
    models: snapshot.models,
    model,
    analysisVersion: `${model.provider}/${model.id}/prompt-${this.#visionPromptVersion}`,
    maxOutputTokens: snapshot.config.vision.max_output_tokens,
  };
}
```

`analysis_version` 里带着 provider 和 model，所以换 vision 模型后，旧模型写的 `media_analyses` 行不会被命中。in-flight 去重键 `<file_unique_id>\0<analysis_version>` 里也有它，换模型前后同一张图的并发请求会各自分析。已经索引过的 Sticker 不会重跑，因为 `stickers.ts` 只处理 `pending` / `error` 状态的行。

`maxOutputTokens` 是评审时补上的（`b7d0dd0`）。实现提交里，模型在分析开始时就钉住了，但输出上限是在真正调用模型时（`maxTokens: this.#configStore.current().config.vision.max_output_tokens`）才从 live 配置读。出错的场景：一次写入同时把 vision 从小上限模型换成大上限模型，并调高 `max_output_tokens`；一个已经钉住旧模型、正在 `#visionSemaphore` 或 `#modelGate` 上排队的分析，会拿新上限去打旧模型，上游返回 400。修复后，输出上限和模型从同一份快照取出，而构建注册表时两者已经一起校验过；调用处改为 `maxTokens: run.maxOutputTokens`（`src/capabilities/media/media.ts:438`）。

### 5. Admin：discover 的 saved 模式与 Models 页去掉待重启

`ProviderWriteContext` 原来带的 `models` 和 `restartRequired` 换成了当前快照。`POST /providers/discover` 的 saved 模式会比较文件里的连接和运行中的 active 连接（`src/ingress/admin/providers-admin.ts:649`）。不一致时返回 409 `connection_not_applied`，不会把已解析的 key 发到只存在于文件里的地址。文件里有、运行中没有的 Provider 返回 409 `provider_not_registered`。

前端（`d4702cb`）删除了 Models 页所有「待重启」专属逻辑：

- `providerPendingRestart` / `modelPendingRestart` 以及两处 “Restart pending” 徽章。
- 连接卡上的 “Connection fields take effect after a restart.”。
- 模型选择弹窗里「连接待重启时默认进入临时模式」的逻辑和说明文字。
- 新建 Provider 向导的 `saved` 步骤和 “Restart now” 按钮。现在创建成功后直接关闭向导，并选中新 Provider：

```tsx
onSuccess: (result) => {
  // A create is applied immediately like every other write, so the same
  // feedback shows and the wizard hands the new provider to the page.
  write.succeeded(result.apply);
  onCreated(alias);
  onClose();
```

全局的 `RestartBanner`、`POST /restart` 和 `supervised` 保留，服务于 `telegram.*`、`mcp.*`、`admin.*`、`paths.*`、`vision.max_concurrency` 等仍需重启的字段。

e2e 的 “Applied” 断言改为 `appliedToast(page)`，限定在 Sonner 的 `[data-sonner-toast]` 容器内。原因是编辑弹窗的新说明文字里出现了 “applied”，而 `getByText('Applied')` 是大小写不敏感的子串匹配，会先命中弹窗说明，在写入还没落地时就让断言通过。

### 6. 文档

- `29fa6ae` 同步了 `agent-doc/configuration.md`（热更新白名单、Provider 重建规则、vision 钉住、`secret_unresolved`）、`admin-panel.md`、`architecture.md`、`telegram-agent-flow.md`、`operations.md`、`verification.md`、`apps/admin-next/README.md`。
- 还在 `agent-doc/design/` 里新增了交付报告，并把历史索引里的计划标为已实现。
- `b7d0dd0` 把 `configuration.md` 里「`max_output_tokens` 每次分析现读」的说法更正为「和模型一起在分析开始时从同一份快照取出」。

## 验证

实现提交（`29fa6ae` 状态）评审时实际运行：

```bash
pnpm run check
# 通过（后端 tsc + admin-next tsc）
pnpm run lint
# biome lint . && biome format .：No fixes applied
pnpm test
# Test Files 41 passed (41) / Tests 455 passed (455)
pnpm run admin:build && pnpm run admin:test:e2e
# 90 passed (53.9s)，含 08-models 的 “creates a custom provider through the wizard and applies it immediately”
```

修复提交（`b7d0dd0`）：

```bash
pnpm vitest run test/media.test.ts
# 修复前：Tests 1 failed | 2 passed (3)，新加的钉住断言失败
# 修复后：Tests 3 passed (3)
pnpm run check
# 通过
pnpm run lint
# No fixes applied
pnpm test
# Tests 455 passed (455)
git diff --check
# 无输出
```

`test/media.test.ts` 里 “a switched vision model analyzes under its own cache version” 新增的一段：

1. 先发布一个 `maxTokens: 1_024`、`max_output_tokens = 1_000` 的模型。
2. 占住该 chat 的 `modelGate` 后开始一次分析，等 `media_analyses` 出现该版本的 pending 行。
3. 发布上限更大的新模型和 `max_output_tokens = 4_000`。
4. 释放 `modelGate`，断言 faux 收到的 `maxTokens` 仍是 `1_000`。

修复提交只改了后端，没有重跑 e2e。真实 Provider 上的「运行中轮换 key / 改 base_url」没有端到端验收，协议层由 `config-reload.test.ts` 的两个本地端点用例覆盖。

## 提交

```txt
1ad470f Plan hot switching for every Models page change
7c1770d Hot-switch providers, agent and vision models without a restart
d4702cb Apply Models page writes without a restart in the admin panel
29fa6ae Document Models page hot switching
b7d0dd0 Pin the vision output limit with the model it was validated against
```
