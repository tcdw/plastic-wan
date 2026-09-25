# Plastic Wan - 20260926 Admin 登录与首次设置的加固

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）对 Admin 认证报了七条安全问题，对照 `src/ingress/admin/auth.ts` 与 `server.ts` 确认都成立。这些问题都在未认证的入口上：Admin 只绑定回环地址时影响很小，一旦暴露到公网就可以被直接利用。

1. **限流信任 `X-Forwarded-For`**（`server.ts:265`）。失败键是请求头原值加用户名，每次换一个伪造的请求头就换了一个计数桶，锁定形同虚设。
2. **按用户名分桶，且失败表只增不减**（`auth.ts:136`）。换用户名同样能绕过锁定；未知用户名永远不会登录成功，它们的条目永远不会删除，每个条目还要消耗一次 64 MiB 的 Argon2。
3. **锁定过期后计数不归零**（`auth.ts:138`）。第 10 次失败之后，过期的锁定仍保留着 count，下一次失败立刻重新锁定。
4. **并发失败互相覆盖**（`auth.ts:154`）。计数快照在 `await verify` 之前读取，十个并发的首次失败最后只记为 1。
5. **登录与改密码的竞态**（`auth.ts:167`）。密码 hash 在 `await verify` 之前读取；校验期间 `changeCredentials` 改了密码、撤销了所有 Session，这次登录恢复后仍会用旧密码签发新 Session。
6. **setup 先 hash 再检查**（`auth.ts:74`）。管理员已存在后，未认证的 setup 请求仍会先跑一次 Argon2 再返回 409。
7. **请求体先读完再限长**（`server.ts:849`）。`request.text()` 会读入整个 body；不带 Content-Length 的分块请求可以让未认证的登录请求无上限地分配内存。`text.length` 按 UTF-16 单元计数，多字节内容还能超出字节上限。

## 主要变更

### 1. 客户端取传输层地址

`AdminServer.start` 的 `fetch` 回调从 `@hono/node-server` 的 `env.incoming.socket.remoteAddress` 取对端地址，传给 `handle(request, clientAddress)`，登录分支用它作为 `clientKey`。`handle` 的第二个参数默认 `'local'`，直接调用 `handle` 的测试保持不变。

取舍：反向代理之后，所有请求的对端都是代理本身，共用一个计数。要取得真实地址，需要新增「可信代理」配置，这次没有做；原来直接信任请求头的做法比共用计数更糟。

### 2. `AdminAuth.login` 的计数与资源边界

- 失败按 `clientKey` 计数，不再拼用户名。
- 条目带 `lastAt`；每次登录先 `#sweepFailures`，删掉 `max(lastAt + 15 分钟, lockedUntil)` 已过去的条目，因此锁定过期后计数从零开始。
- `#recordFailure` 删除后重新插入，让 Map 的插入顺序就是最近失败的顺序；超过 `MAX_TRACKED_CLIENTS = 1000` 时淘汰最旧的条目。
- 用户名不匹配 `USERNAME_PATTERN`、或密码超过 200 字符时，不可能对应任何账号，直接按失败处理，不做 hash。
- `#withHashSlot` 限制 login 与 setup 同时最多运行 2 个 Argon2，超出直接返回 429，不排队。计数在进入 slot 之后、`verify` 之前执行，并发的失败因此都会计入。
- 校验通过后，在 immediate 事务里重新读取该用户的 `password_hash`，与校验时用的不一致就当作失败；更新 `last_login_at` 与创建 Session 放在同一个事务里。

### 3. setup 先检查再 hash

`createFirstUser` 在 hash 之前调用 `setupRequired()`，已完成时直接返回 409，hash 也走 `#withHashSlot`。事务里原有的二次检查保留，用来处理两个 setup 同时进行的情况。`changeCredentials` 需要登录后才能调用，不受 slot 限制。

### 4. 请求体流式限长

`readJsonObject` 改为调用新的 `readBoundedText`：先看 Content-Length，然后用 reader 逐块读取、按字节累计，超过上限立即 `reader.cancel()` 并返回 413 `body_too_large`。所有写端点都经过这里，包括 Models 页各自的 `PROVIDER_BODY_MAX_BYTES`。

### 5. 文档

- `agent-doc/admin-panel.md` 的认证一节重写了锁定规则、资源边界、改密码竞态和请求体限长，并写明反向代理下共用计数的取舍。
- `agent-doc/verification.md` 更新 `admin.test.ts` 的覆盖说明。

### 6. 测试

`test/admin.test.ts` 新增：

- `the login lockout cannot be dodged by rotating X-Forwarded-For or usernames`：10 次失败，每次换一个 `X-Forwarded-For` 和用户名，之后正确密码也得到 429；换一个对端地址（`handle` 的第二个参数）可以正常登录。
- `concurrent failures all count, and an expired lockout starts a fresh count`：直接使用 `AdminAuth`。2 次并发失败加 8 次顺序失败后，正确密码被锁；15 分钟后连续两次失败都是 401（旧代码第二次就会重新锁定），然后可以正常登录。
- `request bodies are limited by bytes as they stream in`：一个不带 Content-Length、无限产生 4 KiB 块的流得到 413，并且只拉取了不到 10 块；3000 个三字节字符（约 9 KiB，但只有约 3000 个 UTF-16 单元）也得到 413。

改密码竞态与「setup 完成后不再 hash」没有写自动化用例：前者需要让两个 Argon2 操作按确定的顺序交错，后者只能靠计时判断，都容易不稳定。

## 验证

```bash
pnpm vitest run test/admin.test.ts
# Tests 15 passed (15)

cd apps/admin-next && pnpm exec playwright test e2e/00-auth.e2e.ts e2e/06-trust-boundary.e2e.ts e2e/08-models.e2e.ts
# 20 passed   （真实 HTTP 服务，验证 socket 地址这条路径）

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 46 passed (46) / Tests 523 passed (523)

git diff --check
# 无输出
```

反向验证：`git stash` 掉 `auth.ts` 与 `server.ts`，只跑锁定相关的用例：

```bash
timeout 90 pnpm vitest run test/admin.test.ts -t "lockout"
# × the login lockout cannot be dodged by rotating X-Forwarded-For or usernames
# × concurrent failures all count, and an expired lockout starts a fresh count
# Tests 2 failed | 13 skipped (15)  —— 随后 stash pop 恢复实现
```

流式 body 用例没有在旧代码上跑完：旧实现会一直读取那个无限流，第一次尝试时进程一直卡住，只能手动结束。这本身就复现了第 7 条问题。

还没做的：

- 反向代理部署下按真实客户端区分计数，需要新增可信代理配置。
- Session Cookie 的 `Secure` 属性是 P2 的下一项，单独处理。

## 提交

```txt
b6c8ecf Harden admin login and setup against unauthenticated abuse
```
