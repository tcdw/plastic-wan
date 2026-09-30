# Plastic Wan - 20260930 web_fetch：请求优先声明 text/markdown

## 背景

上一轮改动（`agent-doc/devlogs/20260930-web-fetch-markdown.md`）让 `web_fetch` 用 Defuddle 在本地把 HTML 抽取成 Markdown。维护者提出：请求的 `Accept` 可以直接写上 `text/markdown`，网站如果支持内容协商，返回的就是它自己生成的 Markdown，可以原样交给模型。这个行为要做成 `config.jsonc` 里的开关，默认开启。

改动前用 curl 带 `Accept: text/markdown, text/html;q=0.9, */*;q=0.1` 探测了几个站点：

```txt
https://developers.cloudflare.com/workers/  200 text/markdown; charset=utf-8 6949B
https://blog.cloudflare.com/                200 text/markdown; charset=utf-8 24009B
https://example.com/                        200 text/html; charset=utf-8 713B
https://en.wikipedia.org/wiki/Bowl          200 text/html; charset=UTF-8 196584B
```

开启了 Cloudflare「Markdown for Agents」的站点确实会返回 Markdown，其他站点照常返回 HTML，所以不会影响现有的抽取路径。

## 主要变更

### 1. Accept 头与内容协商

`src/plugins/web-fetch/web-fetch.ts:30` 定义了两个 Accept 值。声明 Markdown 时，HTML 与 XHTML 降为 `q=0.9`：

```ts
const ACCEPT = 'text/html, application/xhtml+xml, application/json, text/plain;q=0.9, */*;q=0.1';
// Sites with Markdown content negotiation (e.g. Cloudflare "Markdown for Agents")
// then serve their own Markdown, which beats local HTML extraction.
const ACCEPT_MARKDOWN =
  'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, application/json, text/plain;q=0.9, */*;q=0.1';
```

`raw: true` 不声明 Markdown，否则支持协商的站点会返回 Markdown，模型就拿不到原始 HTML（`src/plugins/web-fetch/web-fetch.ts:147`）：

```ts
const accept = input.raw !== true && options.acceptMarkdown !== false ? ACCEPT_MARKDOWN : ACCEPT;
```

为了让测试能断言请求头，`RequestResolved` 的签名增加了 `accept` 参数：`(url, address, accept, signal)`。Accept 值从 `fetchWithRedirects` 一路传给 `defaultRequestResolved`，每一跳跳转都使用同一个值。

### 2. 站点返回的 Markdown

`text/markdown` 响应不经过 Defuddle，和 JSON、纯文本一样走 `readTextBody`：按 32 KiB 结果预算边读边截，截断点对齐 UTF-8 字符边界，末尾加 `[content truncated]`。与纯文本的区别只有两点：header 多一行 `Format: Markdown served by the site; call again with raw: true for the original HTML`，`details.format` 记为 `markdown`。

### 3. 配置 `web_fetch.accept_markdown`

`src/platform/config.ts` 新增可选布尔值。缺省时视为 `true`，插件在 `src/plugins/web-fetch/index.ts` 里用 `config.web_fetch?.accept_markdown !== false` 传给 `acceptMarkdown`。它和同一 section 的其他字段一样，属于 restart-only。设为 `false` 后，Accept 恢复为改动前的值。

### 4. 文档

- `agent-doc/configuration.md` 的 `web_fetch` 示例与说明加入 `accept_markdown`，写明什么时候可以关闭（站点返回的 Markdown 质量不如本地抽取时）。
- `agent-doc/telegram-agent-flow.md`、`agent-doc/verification.md`、`src/plugins/web-fetch/skills/web-fetch/SKILL.md`、`apps/docs/content/docs/guides/extensions.md` 同步更新。

## 验证

```bash
pnpm test test/web-fetch.test.ts
# Tests 13 passed (13)

pnpm test
# Tests 689 passed (689)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

git diff --check
# 无输出
```

新增的两个测试：

- `web_fetch asks for Markdown and passes site-served Markdown through unchanged`：默认 Accept 以 `text/markdown, text/html;q=0.9` 开头；返回的 `text/markdown` 内容（其中故意放了 `<p>`）原样出现在结果末尾，没有被转换；带上 `raw: true` 时 Accept 不含 `text/markdown`，返回 HTML。
- `web_fetch.accept_markdown false loads and stops advertising Markdown`：配置能加载，`acceptMarkdown: false` 时 Accept 等于改动前的值。

真实网络：本机 fake-ip 环境，`allowProxySyntheticAddresses: true`：

```txt
developers.cloudflare.com/workers/  raw=false  format=markdown  7220 B   Content-Type: text/markdown
developers.cloudflare.com/workers/  raw=true   format=raw       32768 B  Content-Type: text/html（truncated）
en.wikipedia.org/wiki/Bowl          raw=false  format=markdown  12518 B  Content-Type: text/html（经 Defuddle 转换）
```

还没做的：

- `index.ts` 中配置到插件的接线（`accept_markdown !== false`）没有测试覆盖。插件生成的 Tool 使用真实网络栈，测试里拿不到它发出的 Accept 头。
- 站点返回的 Markdown 超过 32 KiB 时的截断，没有专门用 `text/markdown` 测试。它和 `text/plain` 走同一条 `readTextBody` 路径，那条路径由原有的截断用例覆盖。
- 线上验收：通过 Bot 触发一次对支持 Markdown 协商的站点的 `web_fetch`，在 `tool_calls` 里确认结果带有 `Format: Markdown served by the site`。

## 提交

```txt
b7fe184 Ask web_fetch sites for Markdown first
```
