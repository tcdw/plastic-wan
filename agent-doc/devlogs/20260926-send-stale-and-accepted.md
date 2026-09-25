# Plastic Wan - 20260926 send：不再发出过期回复，已被接受的发送不再报失败

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）对 `src/capabilities/send-tool.ts` 报了两条 high，对照源码确认成立：

1. **发送前不检查取消与过期。** `execute` 从输入校验一路走到 Telegram API，中间没有判断 `signal` 是否已 abort、Invocation 是否已过 deadline。模型在 abort（`/pause`、`/cut_topic`、Admin 取消）之前排好的 `send` 仍会真的发出去。429 重试路径里，等待被 abort 时 `delay` 会抛错，这部分原来就对；但等待结束后不会再判断 send 屏障，等待期间到达的新消息拦不住这条已经过时的回复。
2. **Telegram 已接受、本地落库失败时被当成发送失败。** 成功后的事务（更新 `tool_calls` / `telegram_sends`、`recordOutgoingMessage` 写 `messages`）和 API 调用在同一个 `try` 里。事务抛出普通 SQLite 异常时会落到外层 `catch`：记录为 `error`/`send_error`，并告诉模型 `Telegram send failed`。消息其实已经发出，模型却会以为没发，从而重发一遍。

## 主要变更

### 1. abort / 过期在写审计之前拒绝

输入校验全部通过后、send 屏障判断之前：

```ts
      if (signal?.aborted === true || Date.now() >= environment.deadline) {
        const errorCode = signal?.aborted === true ? 'aborted' : 'deadline_exceeded';
        recordRejectedSend(environment, toolCallId, input, errorCode);
        throw new Error(`Not sent: ${errorCode}`);
      }
```

走和其他发送前拒绝（`send_text_too_long` 等）相同的 `recordRejectedSend`：Tool Call 记为 `error`，不写 `telegram_sends`，不消耗窗口额度，也不设置 `side_effect_started`。检查和 API 调用之间只有同步的数据库事务，没有 await，所以第一次尝试只需要检查这一次。

### 2. 429 等待后重新判断 send 屏障

```ts
            await delay(retryAfter * 1000, undefined, { signal });
            if (environment.holdForNewMessages?.() === true) {
              throw new SendHeldBack();
            }
```

`SendHeldBack` 是文件内私有的错误类。外层 `catch` 把它映射为 `error`/`send_barrier`，返回给模型的仍是 `SEND_BARRIER_TEXT`。`holdForNewMessages` 只在真正拦下时才把 `barrierSpent` 置为 true，所以第一次尝试前没有拦截的话，这里还能再拦一次，符合「每轮至多拦一次」。deadline 原来就由「`retry_after` 等待会越过 deadline 时不重试」的条件覆盖，这次没有改。

### 3. 把「发送」和「记录」拆成两段

原来的单个 `try` 拆成两段：

- API 循环放在自己的 `try/catch` 里，失败处理（`outcome_unknown` / `error`、错误码映射）不变，只加了 `send_barrier` 分支。
- API 成功后先设置 `firstTextSent`，再执行落库。落库在单独的 `try` 里；失败时输出 `send_record_failed` 日志（`invocation_id`、`telegram_message_id`、错误消息），然后尽量单独执行 `markAccepted()`，把 `tool_calls` / `telegram_sends` 标为 `success` 并写入 message id。如果连这一步也失败，说明存储本身出了问题，日志就是唯一的记录。无论哪种情况，Tool 都向模型返回 `Sent Telegram message N`。

```ts
      try {
        environment.store.transaction(() => {
          markAccepted();
          recordOutgoingMessage(/* … */);
        });
      } catch (error) {
        console.error(JSON.stringify({ event: 'send_record_failed', /* … */ }));
        try {
          markAccepted();
        } catch {}
      }
```

代价：落库失败时，这条外发消息可能不在 `messages` 里，之后的 history 渲染看不到它。本次 Tool 结果已经告诉模型发出了，它不会重发。

### 4. 文档

- `agent-doc/telegram-agent-flow.md` 的 send 一节补充三条规则：abort/过期不发送，429 等待后判断屏障，已被接受的发送在落库失败时仍为成功。
- `agent-doc/verification.md` 更新 `context-send.test.ts` 的覆盖说明。

### 5. 测试

`test/context-send.test.ts` 新增公共 fixture `sendFixture` / `countingApi`，以及三条用例：

- `an aborted or expired run records a known non-send without calling Telegram`：已 abort 的 signal 与已过期的 deadline 各跑一次，API 调用次数为 0；`tool_calls` 为 `error`/`aborted`、`error`/`deadline_exceeded`，没有 `telegram_sends` 行。
- `a 429 retry is held back when new messages arrived during the wait`：API 返回 429（`retry_after: 0`），屏障第一次放行、第二次拦截。API 只被调用 1 次，报错为 `SEND_BARRIER_TEXT`，两张表都是 `error`/`send_barrier`。
- `a message Telegram accepted stays a success when recording the outgoing copy fails`：用 `BEFORE INSERT ON messages` 触发器让 `recordOutgoingMessage` 失败。Tool 返回成功，`tool_calls` 与 `telegram_sends` 都是 `success`，`telegram_message_id = 501`。

## 验证

```bash
pnpm vitest run test/context-send.test.ts
# Tests 12 passed (12)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 45 passed (45) / Tests 506 passed (506)

git diff --check
# 无输出
```

反向验证：`git stash` 掉 `src/capabilities/send-tool.ts`，保留新测试：

```bash
pnpm vitest run test/context-send.test.ts
# × an aborted or expired run records a known non-send without calling Telegram
# × a 429 retry is held back when new messages arrived during the wait   （旧代码无限重试直到超时）
# × a message Telegram accepted stays a success when recording the outgoing copy fails
# Tests 3 failed | 9 passed (12)  —— 随后 stash pop 恢复实现
```

还没做的：

- 同一次扫描里 send 的其他 medium（429 重试不刷新每 Chat 速率预留、MarkdownV2 时记录的是带标记的原文、外发 Sticker 记录缺少 `is_video` / `is_animated` 元数据）不在本次范围内。
- 真实环境很难稳定复现 429 与落库失败，只做了单元测试覆盖。

## 提交

```txt
ec4433d Stop stale sends and keep accepted sends successful
```
