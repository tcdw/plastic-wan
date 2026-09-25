# Plastic Wan - 20260926 execute 取消后不再派发，MCP 未发布的 client 一律关闭

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）的三条 high，确认成立：

1. **`execute.call` 在已 abort 时仍派发**（`src/capabilities/execute-tool.ts`）。signal 只是透传给内部能力，而能力不一定理会它：`alarm` 的 `execute` 直接忽略 `_signal`。运行被 `/pause`、`/cut_topic` 或 Admin 取消后，模型已经排好的 `execute.call alarm` 仍会真的建出一个闹钟。
2. **MCP 初始化失败泄漏 client**（`src/capabilities/mcp.ts` 的 `#connect`）。`client.connect` 已经启动了 stdio 子进程或建立了 HTTP 会话之后，`listTools` 超时、`#selectTools` 因配置里的工具不存在或 schema 不合法而抛错，都不会关闭这个 client。原来只有注册表校验失败这一条路径会调用 `close()`。此时 `server.client` 还没有赋值，`stop()` 和后续重连都找不到它；可选 server 每次重连失败都会再漏一个子进程。
3. **`stop()` 与连接过程并发时发布过期 client。** generation 只保护了事件回调。`stop()` 在 `connect()` / `listTools()` 等待期间运行，会把 generation 加一、清空 server、状态置为 `stopped`；连接随后恢复，照样把本地 client 赋给 `server.client` 并标记为 `ready`，这个 client 之后没有人会关闭。`#refreshTools` 的发现结果和 `tools/list_changed` 通知回调也没有绑定 generation。

## 主要变更

### 1. `execute.call` 派发前检查 signal

```ts
  try {
    signal?.throwIfAborted();
    const result = await target.entry.tool.execute(`${toolCallId}:${toolName}`, callInput, signal);
```

放在已有的 `try` 里面，复用原来的错误路径：外层 `tool_calls` 行记为 `error`，错误码 `aborted`（`catch` 里已经按 `signal.aborted` 区分），内部能力不会产生自己的审计行。

### 2. `#connect`：没有发布的 client 一律关闭

连接、发现和校验包在一个 `try/finally` 里，只有 `server.client = client` 执行之后才把 `published` 置为 true：

```ts
    } finally {
      if (!published) {
        client.onclose = () => undefined;
        client.onerror = () => undefined;
        await client.close().catch(() => undefined);
      }
    }
```

关闭之前先把 `onclose` / `onerror` 换成空函数。这次失败由调用方（`start()` 或重连定时器）按 `initialization_failed` / `reconnect_failed` 报告，不应该再被当作一次 `transport_closed` 记录一遍。原来校验失败分支里单独调用的 `client.close()` 已并入这里。

### 3. 过期的连接与刷新丢弃结果

- `#connect` 在 `listTools` 返回后检查 `this.#stopping || generation !== server.generation`，满足时直接 `return`，由 `finally` 关闭 client，不发布、不改状态。
- `#refreshTools` 在 `listTools` 返回后检查 `this.#stopping || server.client !== client`，client 已被替换或已停止时不写 `definitions`。
- `listChanged.tools.onChanged` 回调同样先检查 generation，旧 client 的通知不会再触发刷新。

### 4. 文档

- `agent-doc/telegram-agent-flow.md`：`execute` 在 abort 后不派发。
- `agent-doc/architecture.md`：MCP client 的关闭与过期结果丢弃规则。
- `agent-doc/verification.md` 更新 `skills.test.ts`、`mcp.test.ts` 的覆盖说明。

### 5. 测试

- `test/fixtures/mcp-server.ts` 新增可选的第一个参数：一个文件路径，fixture 启动时把自己的 PID 写进去，供测试判断子进程是否已被关闭。原有用例不传这个参数，行为不变。
- `test/mcp.test.ts`：
  - `a server whose tool discovery fails is closed instead of left running`：`tools` 配置为 `['echo', 'absent']`，fixture 只提供 `echo`，`start()` 以 required server 初始化失败拒绝。之后 5 秒内子进程必须退出。
  - `stop() during a pending connect leaves the server stopped and closed`：`start()` 之后立即 `stop()`，断言 `mcp_server_state` 为 `stopped`、`createTools` 为空、子进程退出。
- `test/skills.test.ts`：`execute does not dispatch a capability once the run is aborted`：注册一个忽略 signal 的副作用能力，用已 abort 的 signal 调用 `execute.call`。断言调用被拒绝、能力没有执行，`tool_calls` 只有一行 `execute` / `error` / `aborted`。

## 验证

```bash
pnpm vitest run test/mcp.test.ts test/skills.test.ts
# Tests 5 passed (5) / Tests 5 passed (5)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 45 passed (45) / Tests 514 passed (514)

git diff --check
# 无输出
```

反向验证（分别 `git stash` 掉对应源码文件）：

```bash
# mcp.ts 恢复旧版：
# × a server whose tool discovery fails is closed instead of left running   （5 秒后子进程仍存活）
# × stop() during a pending connect leaves the server stopped and closed
#   AssertionError: expected 'ready' to be 'stopped'

# execute-tool.ts 恢复旧版：
# × execute does not dispatch a capability once the run is aborted
#   AssertionError: promise resolved "{ content: [ { …(2) } ], …(1) }" instead of rejecting
# 均随后恢复实现
```

还没做的：

- 扫描里 MCP 的其他问题不在本次范围内：等待 semaphore 不受 invocation deadline 约束（high）、`tools/list` 分页只取第一页、`onerror` 之后没有安排恢复、AgentTool 闭包持有刷新前的 definition、HTTP 字节计数把长连接 SSE 也算进去。
- 真实环境验收：给一个 stdio MCP server 配置一个不存在的工具名，重启后用 `ps` 确认没有残留的子进程随重连次数累积。

## 提交

```txt
35caeab Stop aborted execute calls and close unpublished MCP clients
```
