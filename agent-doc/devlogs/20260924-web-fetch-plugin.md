# Plastic Wan - 20260924 web_fetch 迁为首个内置 Agent 插件

## 背景

`agent-doc/design/20260918 内置能力插件化计划与结论.md` 把内置 Agent 能力的插件化拆成三个 Epic，按 `web_fetch → memory → alarm` 推进。本次实现 Epic 1：最小的插件定义与装配，并把 web fetch 迁为第一个插件模块。

改动前的状态：

- `src/capabilities/web-fetch.ts` 的 `createWebFetchTool` 直接接收整个 `SqliteStore` 与 `InvocationContext`，自己调用 `startToolCall` / `finishToolCall` 写内层审计行。
- 组合根 `src/application.ts` 的 `capabilityTools` 里手写一行 `capability(createWebFetchTool({ store: webFetchStore, ... }), false)`；`webFetchStore` 这个变量名同时被 alarm 工具复用。
- 它的 Skill 文档放在 `src/system-resources/skills/web-fetch/SKILL.md`。`SystemResources.load` 只扫描单一根目录，Skill 索引与能力注册来自两处互不相关的来源，`doctor` 甚至加载了 web-fetch 的 Skill 却不注册任何能力。

计划给出的约束：沿用 `execute` 的注册、校验、分发与审计路径，不新增工具分发体系；插件不持有整个 Runtime 或全局数据库；Skill 由插件声明、宿主统一索引与校验；名称、参数、网络限制、超时、取消与审计语义不退化；不做第三方插件加载、安装或兼容体系。计划把 `definePlugin` 的具体字段、目录布局、Skill 物理组织留到实施时决定，本次的取舍见下文。

## 主要变更

### 1. `src/plugins/`：插件定义、校验与装配

新增一层 `src/plugins/`，只被组合根引用，可依赖 `capabilities/` 及以下各层。`src/plugins/plugin.ts:36` 的插件形态只声明贡献：

```ts
export interface AgentPlugin {
  readonly id: string;
  /** Absolute skill directories; each basename is the skill name and holds SKILL.md. */
  readonly skills?: readonly string[];
  /** Runtime-internal capabilities, dispatched and audited through `execute`. */
  readonly capabilities?: (scope: InvocationScope) => readonly ExecutableCapability[];
}
```

没有 `setup` / 启动 / 关闭钩子：web fetch 无状态，计划也明确「不要求每个插件实现空钩子」。等 Epic 2 的 memory 真正需要存储时再按需求加。`definePlugin` 只做类型推导；`loadPlugins`（`src/plugins/plugin.ts:60`）负责 id 格式与重名校验，并按 Invocation 组装能力：

```ts
  return {
    skillDirectories: plugins.flatMap((plugin) => plugin.skills ?? []),
    capabilities: (store, context, deadline) => {
      const scope: InvocationScope = { context, deadline, audit: createToolAudit(store, context.invocationId) };
      return plugins.flatMap((plugin) => plugin.capabilities?.(scope) ?? []);
    },
  };
```

`InvocationScope.context` 是活的 `InvocationContextState`，热注入刷新后工具在调用时读到的仍是最新状态，没有捕获启动期快照。

### 2. 窄宿主审计接口 `ToolAudit`

插件拿不到 Store，只拿到一个绑定当前 Invocation 的审计接口（`src/plugins/plugin.ts:12`）：

```ts
export interface ToolAudit {
  start(toolCallId: string, toolName: string, argumentsJson: string, sideEffect: boolean): ToolAuditRecord;
}

export interface ToolAuditRecord {
  succeed(resultText: string): void;
  fail(errorCode: string): void;
}
```

`createToolAudit` 只是 `startToolCall` / `finishToolCall` 的薄封装，写的仍是同一张 `tool_calls` 表，`startedAt` 耗时与 `pendingOnly: true` 保持原样，没有另起一套审计约定。`src/plugins/web-fetch/web-fetch.ts:86` 从直接操作 `options.store.orm` 改为：

```ts
      const audit = options.audit.start(toolCallId, 'web_fetch', JSON.stringify(input), false);
      // ...
        audit.succeed(text);
      // ...
        audit.fail(failure.code);
```

网络边界代码（地址黑名单、DNS 固定、跳转重校验、内容类型与 UTF-8 截断）一行未动，只是随文件 `git mv` 到了 `src/plugins/web-fetch/web-fetch.ts`。

### 3. web-fetch 插件模块与内置清单

`src/plugins/web-fetch/index.ts` 是插件入口，Skill 文档也 `git mv` 到了插件目录：

```ts
export default definePlugin({
  id: 'web-fetch',
  skills: [join(import.meta.dirname, 'skills', 'web-fetch')],
  capabilities: ({ audit, deadline }) => [
    capability(createWebFetchTool({ audit, invocationDeadline: deadline }), false),
  ],
});
```

`src/plugins/builtin.ts` 导出 `BUILTIN_PLUGINS`，`serve`、`doctor` 与测试 helper `bundledSystemResources()` 都从这一份清单加载。Skill 索引与能力注册因此出自同一装配结果，避免计划风险 4「工具注册与 Skill 索引不一致」。组合根的改动（`src/application.ts:161`、`:181`）：

```ts
    const plugins = loadPlugins(BUILTIN_PLUGINS);
    const systemResources = await SystemResources.load(BUNDLED_SYSTEM_RESOURCES_DIR, plugins.skillDirectories);
    // ...
      capability(createDeleteAlarmTool({ store: openedStore, context }), true),
      ...plugins.capabilities(openedStore, context, deadline),
```

`webFetchStore` 顺手改名为 `openedStore`，因为它现在只给 alarm 工具用。Agent 循环与 `execute` 没有任何为插件新增的分支。

### 4. `SystemResources` 挂载插件 Skill 目录

`SystemResources.load(root, skillDirectories)`（`src/platform/system-resources.ts:81`）把内置树 `skills/` 下的目录与插件声明的目录合成同一个候选列表，走同一套 `SKILL.md` frontmatter 校验，并记录「Skill 名 → 磁盘目录」映射。原来的重名检查在单一目录扫描下不可能触发，现在变成真实的冲突校验：插件与内置树、插件与插件重名都在启动时报 `Duplicate system skill name`。

`readText`（`src/platform/system-resources.ts:210`）对 `system:///skills/<name>/...` 按映射取目录：

```ts
    const [top, skillName, ...rest] = resolved.segments;
    const skillDirectory =
      top === 'skills' && skillName !== undefined && rest.length > 0
        ? this.#skillDirectories.get(skillName)
        : undefined;
```

路径段在 `resolve` 里已经过 `SEGMENT_PATTERN` 校验（拒绝 `..` 等），`join(skillDirectory, ...rest)` 不会越出 Skill 目录。Skill 索引的名称、描述、URI 和排序都没变，所以 system prompt hash 不变，部署后不会触发 Conversation Context 重建。

### 5. 测试与文档

- `test/plugins.test.ts`：插件 id 格式与重名拒绝、内置清单加载出 `web-fetch` Skill 目录。
- `test/system-resources.test.ts`：插件 Skill 挂载、相对引用跨插件目录与内置目录解析、根目录无 `skills/` 时仍能挂载、三类重名或缺失拒绝。
- `test/web-fetch.test.ts` 改用 `createToolAudit`，原有审计行断言（`state`、`side_effect`、`result_text`、`error_code`）不变；`test/skills.test.ts` 改为经真实 `loadPlugins(BUILTIN_PLUGINS)` 装配能力，继续跑 `execute` help/search `web_fetch`。
- `AGENTS.md`、`agent-doc/architecture.md`、`agent-doc/telegram-agent-flow.md`、`agent-doc/verification.md` 同步新目录、依赖方向与 Skill 位置；设计原文作为历史归档未改。

## 验证

```bash
pnpm test test/web-fetch.test.ts test/skills.test.ts test/system-resources.test.ts test/plugins.test.ts
# Test Files 4 passed (4) / Tests 14 passed (14)
pnpm run check
# exit 0
pnpm run lint
# 首次有 3 处格式问题，pnpm run lint:fix 后 No fixes applied
pnpm test
# Test Files 43 passed (43) / Tests 487 passed (487)
git diff --cached --check
# 无输出
```

还没做：

- 没有启动真实 `serve` 或 `doctor`，也没有在 Telegram 里人工触发一次 `web_fetch`；装配链路只由 `skills.test.ts` 的 Faux Provider 集成测试覆盖。
- 能力重名仍然只在每次组装 `execute` 注册表时检查（`createExecuteTool` 抛错），没有提前到启动期。
- 讨论过引入 `is-cidr`：web fetch 没有需要校验的 CIDR 字符串（网段在代码里写死，由 `node:net` 的 `BlockList` 处理，输入只是单个 IP），不需要。

## 提交

```txt
d935eb4 Move web_fetch into the first built-in agent plugin
```
