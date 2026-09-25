# Plastic Wan - 20260926 web_fetch：fake-ip 网段改为显式开启，拦截 IPv6 过渡地址

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）对 `src/plugins/web-fetch/web-fetch.ts` 报了两条安全问题：

1. **`198.18.0.0/15` 对所有域名放行**（high）。为了兼容 fake-ip 代理（Clash、Surge 会把所有域名解析到这个网段），只要解析结果落在这个网段就放行，没有任何开关。攻击者可以把自己控制的域名解析到 `198.18.0.1`；如果部署所在网络恰好路由了这个网段，就构成 SSRF。
2. **IPv6 过渡地址绕过 IPv4 黑名单**（high）。`isPublicAddress` 允许 `2000::/3` 中不在黑名单里的地址，而 6to4（`2002::/16`，例如 `2002:7f00:1::` 内嵌 `127.0.0.1`）和 Teredo（`2001::/32`）不在黑名单里。主机上如果有对应的隧道路由，就能到达内嵌的 IPv4 目标。

第 1 条会影响依赖 fake-ip 的部署。和维护者确认后，选择「默认关闭、配置开启」。

## 主要变更

### 1. 新配置 `web_fetch.allow_proxy_synthetic_addresses`

`src/platform/config.ts` 新增顶层可选 section：

```jsonc
{ "web_fetch": { "allow_proxy_synthetic_addresses": false } }
```

默认 `false`。字段不在热更新白名单里，按 `config-diff` 的规则属于 restart-only。

### 2. 插件拿到当前配置

`InvocationScope` 增加 `config: RawConfig`，`LoadedPlugins.capabilities` 的签名改为 `(store, config, context, deadline)`。组合根传入 `configStore.current().config`；restart-only 字段在运行期不会变化，所以这里读到的就是启动时的值。web-fetch 插件从 `config.web_fetch?.allow_proxy_synthetic_addresses === true` 得到 `allowProxySyntheticAddresses`，传给 `createWebFetchTool`。调用方（`application.ts`、`test/skills.test.ts`）都已迁移。

### 3. 放行条件

`resolvePublicAddress` 增加 `allowProxySynthetic` 参数，只有开关打开、输入是域名（不是 IP 字面量）、解析结果是 IPv4 且在 `198.18.0.0/15` 内时才放行。开关打开后，模型直接提交该网段 IP 仍会被拒绝，行为与以前一致。

### 4. IPv6 过渡前缀

黑名单加入 `2001::/32`（Teredo）与 `2002::/16`（6to4）。

### 5. 文档

- `agent-doc/configuration.md` 新增 `web_fetch` 一节。
- `agent-doc/telegram-agent-flow.md` 的 `web_fetch` 一节改写地址规则。
- `agent-doc/verification.md` 更新 `web-fetch.test.ts` 的覆盖说明。

### 6. 测试

`test/web-fetch.test.ts`：

- 新增 `proxy synthetic DNS answers are refused unless the deployment opts in`：默认配置下，域名解析到 `198.18.0.42` 被拒绝，没有发出请求。
- 原有的「通过 synthetic DNS 获取正文」与「私网与字面量 synthetic 地址拒绝」两条用例显式设置 `allowProxySyntheticAddresses: true`，保留原来的测试意图。
- 新增 `web_fetch blocks IPv6 transition addresses that embed an IPv4 destination`：解析到 6to4、Teredo 地址的域名，以及 6to4 字面量 URL 都被拒绝；普通全局单播地址（`2606:4700::1`）照常请求。

## 验证

```bash
pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 46 passed (46) / Tests 526 passed (526)

git diff --check
# 无输出
```

反向验证：只对 IPv6 部分做了，`git stash` 掉 `web-fetch.ts` 后，过渡地址用例失败（`promise resolved … instead of rejecting`）。fake-ip 默认拒绝的用例是在同一处代码里新增的开关，没有单独做反向验证。

行为变化：**使用 fake-ip 代理的部署升级后需要在 `config.jsonc` 里设置 `"web_fetch": { "allow_proxy_synthetic_addresses": true }` 并重启**，否则 `web_fetch` 对所有域名都会返回 `blocked_address`。

还没做的：

- 线上验收：分别在开关关闭与打开时，通过 Bot 触发一次 `web_fetch`，在 `tool_calls` 里确认 `blocked_address` / `success`。

## 提交

```txt
5ff5cf9 Refuse fake-ip addresses and IPv6 transition prefixes in web_fetch
```
