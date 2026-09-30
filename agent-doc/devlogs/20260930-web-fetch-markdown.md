# Plastic Wan - 20260930 web_fetch：HTML 默认转 Markdown，修复公网 IPv4 全部被拦截，新增放行全部地址开关

## 背景

改动前，`web_fetch` 把响应原文截到 32 KiB 直接交给模型。HTML 页面的前 32 KiB 通常只有 `<head>`、脚本和导航，正文被截掉，模型拿到的大多是噪音。目标是让 HTML 默认返回正文 Markdown，只有模型显式传 `raw: true` 才返回原始 HTML。维护者对这个 Tool 的定位是「简单能用」：JS 渲染、登录页之类的复杂解析交给用户自己接的 MCP。

选型比较了 webforai 3.0.0 与 Defuddle 0.19.4，用同一批页面实测：

| | Defuddle | webforai |
| --- | --- | --- |
| 许可 | MIT | Apache-2.0 |
| 安装 | 21 包 / 22 MB | 116 包 / 26 MB（`playwright-core` 是非 optional peer，被强制装上，约 13 MB） |
| Wikipedia/Bowl（195 KB HTML） | 12 KB Markdown，256 ms | 25 KB，134 ms |
| nodejs.org/blog（828 KB HTML） | 1.3 KB，392 ms | 1.4 KB，365 ms |

两个库都是纯 JS，没有原生模块，Docker 和将来的 Electron 打包都不需要额外处理。最后选了 Defuddle：输出更干净，依赖树更小，Obsidian Web Clipper 在用它。

Defuddle 有一个必须处理的默认值：`useAsync` 默认 `true`。本地 HTML 抽不出正文时，它会自己请求第三方 API。实测对一个空的 YouTube 页面和一个空的 X 页面各调用一次，共发出 6 个请求，目标包括 `youtube.com/youtubei/v1/*`、`api.fxtwitter.com`、`publish.twitter.com/oembed`。这些请求完全绕过 `web_fetch` 的地址校验与审计。

写测试时又发现一个从 `15350ec`（2026-08-26，web_fetch 首次加入）就存在的 bug：IPv6 黑名单里的 `::ffff:0:0/96` 会让 Node 的 `BlockList` 把 IPv4 查询也拿去匹配，于是所有公网 IPv4 都被判为非公网。维护者的环境开着 fake-ip 代理，DNS 结果全在 `198.18.0.0/15`，走的是 `allow_proxy_synthetic_addresses` 的放行分支，所以一直没发现。没有 fake-ip 的部署上，`web_fetch` 对只有 IPv4 结果（或 IPv4 与 IPv6 混合）的域名全部返回 `blocked_address`。

最后，维护者要求新增一个默认关闭的配置 `dangerously_allow_all_ip_addresses`，用来取消地址检查。维护者问过要不要把 `allow_proxy_synthetic_addresses` 改名为 `allow_proxy_fake_ip_address`，最终决定保留旧键不动。

## 主要变更

### 1. 修复公网 IPv4 被全部拦截

从 `src/plugins/web-fetch/web-fetch.ts` 的 IPv6 黑名单里删掉 `['::ffff:0:0', 96]`。IPv4 映射地址本来就被 `isPublicAddress` 的「IPv6 只放行 `2000::/3`」拦住，这条规则是多余的：

```ts
// IPv4-mapped ::ffff:0:0/96 is deliberately absent: BlockList matches IPv4 lookups
// against it, which would block every IPv4 address. The 2000::/3 check in
// isPublicAddress already rejects mapped addresses.
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  // ...
```

原有测试的「公网」地址用的都是 IPv6（`2606:4700::1`），IPv4 路径从来没有被覆盖过。新增的用例让一个域名同时解析出 `93.184.216.34` 和一个 IPv6 地址，断言请求会发出，同时断言 `http://[::ffff:7f00:1]/` 仍被拒绝。

### 2. HTML 默认转 Markdown，`raw` 返回原文

输入 Schema 新增可选的 `raw: boolean`。只有 `text/html` 与 `application/xhtml+xml` 会转换，JSON、纯文本、XML 与 `raw: true` 走原来的路径。结果的 `details` 新增 `format: 'markdown' | 'raw'`。

读取上限拆成两个。转换路径先最多读 2 MiB HTML（`HTML_MAX_BYTES`，`src/plugins/web-fetch/web-fetch.ts:27`），转换完成后再用 `truncateUtf8` 按 UTF-8 字符边界截到 32 KiB 结果预算内。2 MiB 同时限制了转换这段同步 CPU 工作阻塞事件循环的时长。Header 增加 `Format:` 行，并在有标题时增加 `Title:` 行（标题会压缩空白，最多 300 字符）。

Defuddle 的调用参数写死，并注入一个拒绝所有请求的 `fetch`，作为 `useAsync: false` 之外的第二道防线：

```ts
result = await Defuddle(html, url, {
  markdown: true,
  removeImages: true,
  // Async extractors call third-party APIs (oEmbed, YouTube, Bilibili...) that
  // would bypass the address checks above; the fetch stub backs up the flag.
  useAsync: false,
  fetch: refuseFetch,
});
```

`removeImages` 是因为模型不能通过 `web_fetch` 看图，图片链接（例如 GitHub 的 camo URL）只会浪费预算。转换失败时返回 `conversion_failed` 并提示用 `raw: true` 重试，不会悄悄回退到原文。依赖钉死为 `defuddle@0.19.4`；它的 `linkedom`、`turndown` 是 optionalDependencies，pnpm 默认会安装，Dockerfile 的 `pnpm install --prod` 也不受影响。

### 3. 新配置 `web_fetch.dangerously_allow_all_ip_addresses`

`src/platform/config.ts` 新增可选布尔值，默认 `false`，属于 restart-only。插件在 `src/plugins/web-fetch/index.ts` 里把它传为 `allowAllAddresses`。工具内部把两个开关合并成 `AddressPolicy`，替换原来单独传递的布尔参数，`resolvePublicAddress` 改名为 `resolveAllowedAddress`：

```ts
if (
  !policy.allowAll &&
  addresses.some(
    // ...
```

URL 规则不变：只允许默认端口，禁止凭据与 fragment，最多 3 次跳转。开关打开时，Tool 描述也会改为说明「此部署允许私网与本地地址」，否则模型看到「private, local ... are rejected」就不会去尝试。开关关闭时，描述与改动前逐字相同（`src/plugins/web-fetch/web-fetch.ts:116`）。

### 4. 文档

- `agent-doc/telegram-agent-flow.md` 的 `web_fetch` 一节：IPv4 映射地址不能写进 `BlockList` 的原因、Markdown 转换规则与 `useAsync` 风险、新开关的语义。
- `agent-doc/configuration.md` 的 `web_fetch` 一节：新开关的风险说明（群聊中任何能触发 bot 的人都能借模型访问内网，包括云厂商的 `169.254.169.254` 元数据端点）。
- `agent-doc/verification.md` 更新 `web-fetch.test.ts` 的覆盖说明。
- `src/plugins/web-fetch/skills/web-fetch/SKILL.md` 说明 Markdown 默认行为、`raw` 的使用时机，以及地址限制可能被部署关闭。
- `apps/docs/content/docs/guides/extensions.md` 更新用户指南：说明 Markdown 行为，以及「复杂解析请接 MCP」和新开关的风险。

## 验证

```bash
pnpm test
# 第 2、3 个提交后各运行一次：
# Test Files 58 passed (58) / Tests 685 passed (685)
# Test Files 58 passed (58) / Tests 687 passed (687)

pnpm test test/web-fetch.test.ts
# ea37b97 单独检出后运行：Tests 5 passed (5)
# 最终：Tests 11 passed (11)

pnpm run check
# 通过（runtime / Admin / docs）

pnpm run lint
# No fixes applied

git diff --check
# 无输出
```

反向验证：

- 在 IPv4 修复后的代码里临时加回 `['::ffff:0:0', 96]`，`web_fetch allows public IPv4 answers ...` 失败：`Hostname resolves to a non-public address`。
- 把 Defuddle 参数临时改为 `useAsync: true` 并去掉 `fetch: refuseFetch`，`web_fetch HTML conversion makes no network requests of its own` 失败（`globalThis.fetch` 被调用）。

真实网络：通过本机的 fake-ip 代理（`allowProxySyntheticAddresses: true`），在 IPv4 修复之后运行：

```txt
en.wikipedia.org/wiki/Bowl            format=markdown  12518 B  1567 ms
github.com/kepano/defuddle            format=markdown  13710 B  1671 ms
nodejs.org/en/blog                    format=markdown   1630 B  1525 ms
example.com (raw: true)               format=raw          873 B   613 ms
api.github.com/repos/kepano/defuddle  format=raw         5317 B   724 ms  (application/json 原样返回)
```

`dangerously_allow_all_ip_addresses` 已覆盖：配置加载后能传到内置插件生成的 Tool 描述；私网 DNS 结果、`[::1]`、跳转到 `127.0.0.1` 均能成功；`:8080` 仍被拒；每次调用的 `tool_calls` 审计状态也做了断言。

行为变化：

- 升级后，没有 fake-ip 的部署首次能访问公网 IPv4 站点。
- HTML 结果从原文变成 Markdown，模型需要原文时要显式传 `raw: true`。

还没做的：

- 线上验收：通过 Bot 触发一次 `web_fetch`，在 `tool_calls` 里确认 Markdown 结果，并在非 fake-ip 网络上确认 IPv4 站点可以访问。
- 本机测试环境是 fake-ip，没在非 fake-ip 网络上用真实 DNS 跑过。
- 转换仍在主线程同步执行，2 MiB 页面预计阻塞约 1 秒，还没有放进 worker。
- `dangerously_allow_all_ip_addresses` 打开时，`serve` 与 `doctor` 都不会输出警告日志。
- 这三个提交都在 `web-fetch-markdown` 分支上，还没有合并到 `main`。

## 提交

```txt
ea37b97 Fix web_fetch blocking all public IPv4 addresses
9382d86 Convert web_fetch HTML to Markdown by default
2acfe95 Add web_fetch option to allow all IP addresses
```
