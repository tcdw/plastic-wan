# Plastic Wan - 20260926 TGS 解压设上限

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）指出 `src/capabilities/media/media-image.ts` 解压动画 Sticker（TGS，即 gzip 压缩的 Lottie JSON）时没有输出上限（high，security）：

```ts
metadata = JSON.parse(new TextDecoder().decode(gunzipSync(compressed)));
```

下载上限是 20 MB，限制的是压缩后的大小。一个 gzip 炸弹可以在这个范围内展开到 GB 级别，而且 `gunzipSync` 是同步调用，展开期间整个进程的事件循环都被阻塞，之后的解码与 `JSON.parse` 还会继续分配内存。Telegram 本身限制 TGS 文件不超过 64 KiB，真实的 Lottie JSON 通常也只有几百 KiB。

## 主要变更

```ts
const MAX_TGS_JSON_BYTES = 8 * 1024 * 1024;
…
gunzipSync(compressed, { maxOutputLength: MAX_TGS_JSON_BYTES })
```

超过上限时 zlib 直接抛错，被原来的 `catch` 接住，错误信息改为 `Animated sticker TGS metadata is invalid or larger than 8 MiB`。这个检查发生在调用 `lottie_convert.py` 之前，所以炸弹也到不了转换器那一侧（那边会自己再解压一次）。

8 MiB 比真实 TGS 的解压结果大一个数量级以上，不会误伤正常 Sticker；同时把一次同步解压的最坏情况限制在毫秒级。扫描还建议把解压挪出事件循环，有了上限之后收益很小，这次没有做。

### 文档

- `agent-doc/telegram-agent-flow.md` 的 Sticker 媒体一节补充解压上限。
- `agent-doc/verification.md` 更新 `media-image.test.ts` 的覆盖说明。

### 测试

`test/media-image.test.ts` 新增 `an animated sticker that decompresses past the TGS ceiling is refused before conversion`（不依赖 ffmpeg，也不依赖 python-lottie）：用 `gzipSync` 生成一个解压后 64 MiB 的 JSON，作为动画 Sticker 交给 `prepareMediaImage`，断言错误信息包含 `larger than 8 MiB`。

## 验证

```bash
pnpm vitest run test/media-image.test.ts
# Tests 3 passed (3)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 47 passed (47) / Tests 530 passed (530)

git diff --check
# 无输出
```

反向验证：`git stash` 掉 `media-image.ts`：

```bash
pnpm vitest run test/media-image.test.ts -t "TGS ceiling"
# × an animated sticker that decompresses past the TGS ceiling is refused before conversion
#   expected … to throw error including 'larger than 8 MiB' but got 'spawn lottie_convert.py ENOENT'
#   （旧代码把 64 MiB 全部解压并解析，一直走到调用转换器）
# —— 随后 stash pop 恢复实现
```

还没做的：

- 线上验收：收到一个普通动画 Sticker 后，确认索引仍为 `success`。
- 同文件里 30 秒超时只发 SIGTERM、不会升级为强制结束的问题（high）不在本次范围内。

## 提交

```txt
4d50928 Cap decompressed TGS size before conversion
```
