# Plastic Wan - 20260926 重叠的 Secret 也能完整脱敏

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）指出 `SecretStore.redact`（`src/platform/secrets.ts`）的结果取决于插入顺序（high，security）。它按「配置里解析过的值 + 面板提交过的明文」的顺序逐个 `replaceAll`，前一次替换会破坏后一次的匹配。例如先记住 `abcdef`、再记住 `abcdef123456`，脱敏 `abcdef123456` 会得到 `[REDACTED]123456`：短的那个先替换掉了开头，长的那个就再也匹配不上。

现实中会出现这种情况：面板里输错一次 key 再补全，两次提交会先后被 `remember`；或者两个 Provider 的 key 有共同前缀。泄露的是 key 的后半段，会出现在错误信息、审计里的错误详情和日志中。

## 主要变更

`redact` 改成两步：

1. 对每个已知值（仍然跳过短于 6 个字符的值），在**原文**上用 `indexOf` 找出全部出现位置，得到一组 `[start, end)` 区间。同一个值自身重叠出现也会收集到。
2. 按起点排序，把重叠或相邻（`start <= spanEnd`）的区间合并，然后一次性拼出结果，每个合并后的区间替换成一个 `[REDACTED]`。

没有命中时原样返回。这样既不依赖插入顺序，也覆盖了扫描指出的「最长优先也处理不了的部分重叠」情况，比如 `xyz-overlap-1` 与 `overlap-1-tail` 同时出现在 `xyz-overlap-1-tail` 里。

同文件的另外两条 medium（`Error.cause` 成环时 `formatErrorDetail` 会无限递归、command SecretRef 的错误类型不统一）不在本次范围内。

### 文档

- `agent-doc/configuration.md` 的 Secret 一节补充匹配规则。
- `agent-doc/verification.md` 更新 `foundation.test.ts` 的覆盖说明。

### 测试

`test/foundation.test.ts` 新增 `redacts a secret in full when another known secret is its prefix or overlaps it`：

- 前缀关系：`abcdef-short` 与 `abcdef-short-and-long` 都已知时，`key=abcdef-short-and-long;` 得到 `key=[REDACTED];`；
- 短值单独出现仍被替换；
- 部分重叠：`[xyz-overlap-1-tail]` 得到 `[[REDACTED]]`；
- 两处独立出现各自替换；没有命中的文本不变。

## 验证

```bash
pnpm vitest run test/foundation.test.ts -t "secrets"
# Tests 6 passed | 39 skipped (45)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 47 passed (47) / Tests 529 passed (529)

git diff --check
# 无输出
```

反向验证：`git stash` 掉 `secrets.ts`：

```bash
pnpm vitest run test/foundation.test.ts -t "prefix or overlaps"
# × redacts a secret in full when another known secret is its prefix or overlaps it
# AssertionError: expected 'key=[REDACTED]-and-long;' to be 'key=[REDACTED];'
# —— 随后 stash pop 恢复实现
```

## 提交

```txt
ec02e7a Redact overlapping secrets in full
```
