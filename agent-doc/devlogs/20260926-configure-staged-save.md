# Plastic Wan - 20260926 configure 保存改为先校验再替换

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）指出 `src/tui/configure.ts` 的 `saveConfig` 顺序有误，确认成立：

1. **先写后验。** `writeFile(path, JSON.stringify(config))` 直接截断并覆盖真实的配置文件，然后才 `loadConfig`。比如在向导里删掉 agent 正在用的 Provider，得到的配置会被 `loadConfig` 拒绝，但此时它已经在磁盘上了。之后的「Restore previous config?」提示如果被 Ctrl+C 打断，或者恢复写入本身失败，应用就没有一份可用的配置了。
2. **不检测并发修改。** 向导从启动时读到的 `originalSource` 开始编辑，保存时不管文件是否已被别人（Admin 面板、手工编辑）改过，直接整份覆盖。
3. **解析出错时仍然清理密钥**（同文件，high）。退出时 `pruneKeyJar` 用 `jsonc-parser` 解析磁盘上的文件，决定哪些 key jar 条目已经不再被引用。`parse` 对损坏的输入只返回尽力而为的结果，错误被丢弃；引用集合不完整时，仍被需要的密钥会被永久删除。

Admin 面板写配置用的 `writeConfigEdits`（`src/platform/config-file.ts`）已经解决了前两个问题：写同目录临时文件，`loadConfig` 通过后再原子 rename，并支持 `expectedRevision`。configure 没有复用它。

## 主要变更

### 1. `saveConfig` 走 `writeConfigEdits`

```ts
export async function saveConfig(path: string, config: FileConfig, originalSource: string): Promise<boolean> {
  try {
    const revision = createHash('sha256').update(Buffer.from(originalSource, 'utf8')).digest('hex');
    await writeConfigEdits(path, [{ path: [], value: config }], revision);
    const loaded = await loadConfig(path);
    console.log(`Config saved and validated. Hash: ${loaded.hash}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Config not saved; the file is unchanged: ${message}`);
    return false;
  }
}
```

- `path: []` 让 `jsonc-parser` 的 `modify` 替换整个文档。原来 `JSON.stringify(config, null, 2)` 也会丢掉注释，这一点行为不变。
- revision 取会话开始时读到的原文，和 `readConfigRevision` 同样是 SHA-256。期间文件被改过时抛出 `config_conflict`，保存失败，文件保持别人改过的内容。
- 校验失败时文件根本没有被动过，所以「Restore previous config?」提示整段删掉了。保存失败后回到主菜单，可以继续修改或放弃。
- `saveConfig` 改为导出，供测试直接调用；`runConfigure` 仍要求 TTY，不能在测试里驱动。

代价：`writeConfigEdits` 会检查配置文件权限（`0600`、目录 `0700`、不是符号链接），configure 以前不检查这些。`serve` 本来就有同样的要求，所以正常部署不受影响。

### 2. key jar 清理遇到解析错误时跳过

`jarNamesIn` 收集 `ParseError`，有错误时返回 `null`。`pruneKeyJar` 读到磁盘上的文件解析失败时，输出一行说明并直接返回，不删除任何条目。`originalSource` 在会话开始时已经被 `loadConfig` 成功加载过，这里的 `?? new Set()` 只是为了满足类型。

扫描里同文件的另一条 high（两个 configure 会话重叠时，按「启动时的 jar 快照」判断「本会话新增」，可能误删另一会话的条目）没有处理：需要跨进程锁，而 configure 是单人交互工具，风险远低于前两条。

### 3. 文档

- `agent-doc/configuration.md` 的 key jar 一节补充：解析出错时跳过清理；configure 与面板走同一个暂存写入流程，带 revision，因此也有权限要求。
- `agent-doc/verification.md` 更新 `tui-configure.test.ts` 的覆盖说明。

### 4. 测试

`test/tui-configure.test.ts` 新增 `configure save` 组：

- `an invalid configuration never reaches the file`：删掉 agent 使用的 Provider 再保存，返回 false，文件字节与原来完全一致。
- `a file changed during the session is not overwritten`：会话开始后把文件里的 `thinking_level` 改成 `medium`，再保存 `off`，返回 false，文件保留 `medium` 版本。
- `a valid configuration is saved and loads back`：保存 `thinking_level: off`，重新加载后生效。

## 验证

```bash
pnpm vitest run test/tui-configure.test.ts
# Tests 15 passed (15)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 46 passed (46) / Tests 520 passed (520)

git diff --check
# 无输出
```

反向验证：把 `src/tui/configure.ts` 恢复为改动前的版本（只给 `saveConfig` 加上 `export`）：

```bash
pnpm vitest run test/tui-configure.test.ts -t "configure save"
# × an invalid configuration never reaches the file    （Test timed out：非法配置已落盘，卡在 Restore 交互提示）
# × a file changed during the session is not overwritten
#   AssertionError: expected true to be false
# Tests 2 failed | 1 passed  —— 随后恢复实现
```

还没做的：

- 真实终端验收：`node src/cli.ts configure --config dev-data/config.jsonc` 里删掉 agent 的 Provider 后保存，应看到 `Config not saved; the file is unchanged: …`，`check-config` 输出的哈希不变。
- 同一次扫描里 provider-wizard 的问题（重复 alias 会静默替换已有 Provider、编辑时绕过 URL 校验、可以删光所有模型）不在本次范围内。

## 提交

```txt
08f5665 Validate configure saves before they replace the config
```
