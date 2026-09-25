# Plastic Wan - 20260926 HTTPS 下 Admin Session Cookie 带 Secure

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）指出 `src/ingress/admin/server.ts` 签发的 Session Cookie 从不带 `Secure`（medium，security）。面板通过 HTTPS 反向代理对外提供时，浏览器仍然允许把这个 Cookie 通过明文 HTTP 发出去，例如用户手动输入 `http://` 地址，或遇到降级跳转。

难点在于判断「浏览器是不是在 HTTPS 上」：TLS 在反向代理终止时，到达 `serve` 的请求本身是明文 HTTP，`url.protocol` 是 `http:`。不能无条件加 `Secure`：纯 HTTP 的回环面板是默认部署方式，浏览器会拒绝在非安全上下文里保存 `Secure` Cookie（`localhost` 除外），直接加会导致无法登录。

## 主要变更

新增 `cookieAttributes(request, url)`：满足以下任一条件时追加 `; Secure`：

- `url.protocol === 'https:'`；
- 请求的 `Origin` 以 `https://` 开头。浏览器对 setup、login、logout 这些同源 POST 都会带上 Origin；`#api` 已经拒绝跨源的写请求，所以这里的 Origin 与页面同源。

伪造 Origin 只会影响伪造者自己拿到的 Cookie，不会影响别人。签发 Session 的三处（setup、login、credentials）和登出清除 Cookie 都使用这个函数；`#sessionCookie` 增加 `request`、`url` 参数。

没有读取 `X-Forwarded-Proto`：它和 `X-Forwarded-For` 一样由客户端控制，而 Origin 已经足够说明页面所在的协议。

### 文档

- `agent-doc/admin-panel.md`：Cookie 属性一条补充 `Secure` 的判断规则。
- `agent-doc/verification.md`：`admin.test.ts` 的覆盖说明。

### 测试

`test/admin.test.ts` 新增 `session cookies are Secure when the browser is on HTTPS`：

- 普通 HTTP 请求的 setup Cookie 不带 `Secure`；
- `Origin: https://127.0.0.1:8899` 的登录 Cookie 带 `; Secure`；
- 同样 Origin 的登出 Cookie（`Max-Age=0`）也带 `Secure`。

## 验证

```bash
pnpm vitest run test/admin.test.ts -t "Secure"
# Tests 1 passed | 15 skipped (16)

cd apps/admin-next && pnpm exec playwright test e2e/00-auth.e2e.ts e2e/06-trust-boundary.e2e.ts
# 8 passed   （纯 HTTP 回环面板登录不受影响）

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 46 passed (46) / Tests 524 passed (524)

git diff --check
# 无输出
```

反向验证：`git stash` 掉 `server.ts`：

```bash
pnpm vitest run test/admin.test.ts -t "Secure"
# × session cookies are Secure when the browser is on HTTPS
# AssertionError: expected 'plasticwan_admin=…' to match /; Secure(;|$)/
# —— 随后 stash pop 恢复实现
```

还没做的：

- 真实 HTTPS 反向代理下的验收：登录后在浏览器开发者工具里确认 `plasticwan_admin` Cookie 的 Secure 列已勾选。

## 提交

```txt
2c8d632 Mark admin session cookies Secure on HTTPS
```
