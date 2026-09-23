# Plastic Wan - 20260923 serve --takeover：请求运行中的实例优雅退出后接管

## 背景

本地调试时 `serve` 会被反复拉起，而上一次启动的实例还持有 `data_dir` 的锁，新实例直接抛 `Another serve process holds ... with PID <pid>`（`src/store/database.ts:68`）。原有的三条出路都不适合 agent：

- 人工前台 `Ctrl+C` 需要终端，agent 拿不到。
- `agent-doc/operations.md` 明确要求不要手动删 `serve.lock`、不要用未验证 PID 的强制终止命令（`AGENTS.md:121`）。
- Admin 的 `POST /api/restart` 是「让自己退出、由 supervisor 拉起」，需要 `PLASTICWAN_SUPERVISED=1` 与面板会话，裸机前台调试两个都没有。

关键约束是 Windows：Node 在 Windows 上 `process.kill(pid, 'SIGTERM')` 是无条件终止（不存在可捕获的 `SIGTERM`），所以「优雅停止另一个进程」不可能靠信号完成，只能由目标进程自己执行关闭流程。仓库现有的优雅关闭路径（`SIGINT`/`SIGTERM` 处理器、Admin 的重启）都跑在目标进程内部，缺的是「从外部请求它执行」的通道。

## 主要变更

### 1. `serve.stop` 请求文件协议

`src/store/database.ts:87` 起新增两个导出，与 `ServeLock` 同模块、同 `data_dir`。请求方（`src/store/database.ts:104`）：

```ts
export async function stopRunningInstance(dataDir: string, timeoutMs = 60_000): Promise<number | null> {
  const lockPath = join(dataDir, 'serve.lock');
  const pid = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
  if (!Number.isInteger(pid) || !isProcessAlive(pid)) {
    return null;
  }
  const stopPath = join(dataDir, STOP_REQUEST_FILE);
  await writeFile(stopPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  while (await fileExists(lockPath)) {
    if (Date.now() >= deadline) {
      await unlink(stopPath).catch(() => undefined);
      throw new Error(`PID ${pid} still holds ${lockPath} after ${timeoutMs}ms`);
    }
    await delay(STOP_REQUEST_POLL_MS);
  }
  await unlink(stopPath).catch(() => undefined);
  return pid;
}
```

四个决定：

- **请求是文件不是信号**。Windows 上没有可捕获的 `SIGTERM`，文件是唯一跨平台、且只可能被目标进程读到的通道。
- **等锁消失，而不是等 PID 消失**。`release()` 是关闭流程的最后一步（`src/application.ts:286`），锁没了就意味着对方的 SQLite 已经关闭，可以直接接手。
- **不强制**。PID 被复用（锁里的进程其实不是 serve）时没人会读这个文件，函数在 60 秒后抛错并清掉自己的请求，不会误杀。
- **锁不存在或 PID 已死时返回 `null`**，把陈旧锁留给 `ServeLock.acquire` 自己清理（`src/store/database.ts:67`），不为不存在的实例白等 60 秒。

目标进程侧是 `watchStopRequests()`（`src/store/database.ts:132`）：200ms 轮询（不用 `fs.watch`——文件此刻还不存在，且轮询的跨平台行为更确定），定时器 `unref()` 以免自己撑住事件循环；**启动时就存在的 `serve.stop` 会被丢弃而不是照做**——接管方在返回前总会清掉自己的请求，残留只可能是崩溃留下的，照做会让新进程刚起来就自杀。

### 2. `serve --takeover` 接线

`src/application.ts:98` 的顺序是刻意的：

```ts
const token = await secrets.resolve(loaded.config.telegram.token);
if (takeover) {
  // Stop the incumbent only once this process knows it can start at all:
  // the config, its permissions and the bot token are checked by now.
  const stoppedPid = await stopRunningInstance(loaded.config.data_dir);
  logEvent('takeover_completed', { stopped_pid: stoppedPid });
}
lock = await ServeLock.acquire(loaded.config.data_dir);
stopWatcher = watchStopRequests(loaded.config.data_dir, () => {
  logEvent('takeover_requested');
  shutdown();
});
```

配置权限与 `loadConfig` 在更早处已经过（`src/application.ts:53`），token 解析放在停对方之前：**先确认自己能起来，再让旧的退出**，否则会出现「旧的停了、新的起不来」的空窗。日志链是接管方 `takeover_completed`（带被停 PID），被接管方 `takeover_requested` → `shutdown_requested`（`src/application.ts:71`），之后走 `agent-doc/operations.md` 里那套六步关闭流程。`finally` 里 `stopWatcher?.()` 注销轮询（`src/application.ts:280`）。

CLI 侧是 `serve` 专属选项（`src/cli-options.ts:26`），`doctor` 等命令带 `--takeover` 直接落 usage 错误。

### 3. 测试与文档

`test/operations.test.ts:196` 起三个协议用例：接管成功（持锁进程收到请求后释放，返回它的 PID，`serve.lock` 与 `serve.stop` 都无残留）、超时放弃（有锁但没人响应 → 抛 `still holds` 且请求文件被清掉）、陈旧请求不生效（启动前写好的 `serve.stop` 被丢弃，`onRequest` 不触发）。`test/tui-configure.test.ts:198` 覆盖 CLI 解析。

文档：`agent-doc/operations.md` 新增「接管已运行的实例」小节（含「有 supervisor 的部署不要用」与「只处理同一 `data_dir`」两条边界），`AGENTS.md` 的长进程规则与 `agent-doc/verification.md` 的冒烟项各加一条。

## 验证

```bash
pnpm test
# Test Files 42 passed (42) / Tests 483 passed (483)（本次新增 4 个）

pnpm run check
# 通过（后端 tsc + admin-next tsc）
pnpm run lint
# Checked 229 files / Checked 227 files — No fixes applied
git diff --check
# 无输出
```

跨进程真实验证（临时脚本，跑完已删除）：子进程用 `ServeLock.acquire` 持锁并注册 `watchStopRequests`，父进程调用 `stopRunningInstance`：

```txt
holder says: holder_ready 3388
holder says: holder_stopping
takeover stopped pid 3388 (holder pid 3388)
holder exit code 0
files left: holder.mts
```

还没做：

- 没有跑真实 `serve --takeover` 的端到端：需要真实 Telegram token 与 Provider，会让 bot 真上线轮询。协议本身由上面的跨进程检查覆盖，`serve` 侧只有接线与类型检查。
- 没有系统级进程扫描：只处理持有**同一 `data_dir` 锁**的实例。用别的 `data_dir` 起的实例不会被发现，冲突仍表现为 Telegram long polling 的 409。

## 提交

```txt
f0f8692 Let serve take over the instance holding its lock
```
