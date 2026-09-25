# Plastic Wan - 20260926 视频 Sticker 只按 WebM 解码

## 背景

open-code-review 扫描（session `d79a83a3-a8f1-4dea-83e0-86c7dab26187`）指出 `src/capabilities/media/media-image.ts` 处理视频 Sticker 时，ffprobe（取时长）和 ffmpeg（取中间帧）都开着默认的格式探测与协议（high，security）。`is_video` 只是 Telegram 给的元数据，不能说明下载到的字节是什么格式。一个伪装成视频 Sticker 的播放列表（HLS）或 concat 文件，可能让 ffmpeg 以服务进程的权限打开其他本地文件，或访问网络 URL。

本机的 ffmpeg 9.0.1 已经自带一部分防护，下面三种方式都试过，都会被拒绝：

- 扩展名不标准的 HLS：`Not detecting m3u8/hls with non standard extension`；
- 引用 `file://` 绝对路径的 HLS；
- 引用绝对路径的 ffconcat：`Unsafe file name`。

线上 Docker 镜像基于 `node:24-bookworm-slim`，装的是 Debian 的 ffmpeg 5.1。这些防护在那个版本里是否存在，本地无法确认；而且格式探测本身就是不必要的攻击面：视频 Sticker 只可能是 WebM。

## 主要变更

新增常量，放在 ffprobe 与 ffmpeg 的输入之前：

```ts
const VIDEO_STICKER_INPUT = ['-f', 'matroska', '-protocol_whitelist', 'file'] as const;
```

- `-f matroska` 固定使用 Matroska/WebM demuxer，不再探测，其他容器一律报错。
- `-protocol_whitelist file` 只允许 `file` 协议，即使某个 demuxer 想打开嵌套资源，也碰不到网络。

扫描同一条目建议的「文件系统/网络隔离运行」（沙箱）没有做，这需要部署层面的支持。

### 文档

- `agent-doc/telegram-agent-flow.md` 的 Sticker 媒体一节说明这两个固定参数的原因。
- `agent-doc/verification.md` 新增 `media-image.test.ts` 一行。

### 测试

新增 `test/media-image.test.ts`，直接调用 `prepareMediaImage`，用假 downloader 把测试准备好的文件当成下载结果。本机没有 ffmpeg/ffprobe 时整组跳过（`describe.skipIf`），原有测试不依赖 ffmpeg。

- `only WebM is decoded: another container posing as a video sticker is refused`：用 lavfi 生成一段 MPEG-TS，冒充视频 Sticker，断言在 ffprobe 这一步就失败。在本机 ffmpeg 上，这是新旧代码之间唯一能观察到的差别：播放列表类输入在新旧代码下都会被拒绝，如上所述。
- `a real WebM video sticker still yields a frame`：用 `libvpx-vp9` 生成真实的 WebM，确认固定 demuxer 之后仍能取帧。ffmpeg 构建里没有 VP9 编码器时这条用例直接返回。

## 验证

```bash
pnpm vitest run test/media-image.test.ts
# Tests 2 passed (2)

pnpm run check
# 通过

pnpm run lint
# No fixes applied

pnpm test
# Test Files 47 passed (47) / Tests 528 passed (528)

git diff --check
# 无输出
```

反向验证：`git stash` 掉 `media-image.ts`：

```bash
pnpm vitest run test/media-image.test.ts
# × only WebM is decoded: another container posing as a video sticker is refused
#   expected … to throw error including 'ffprobe failed' but got 'ENOENT: …'
#   （旧代码把 MPEG-TS 当视频探测并取帧，一直走到后面的输出文件步骤）
# Tests 1 failed | 1 passed (2)  —— 随后 stash pop 恢复实现
```

还没做的：

- 在线上镜像（ffmpeg 5.1）里验收：收到一个真实的视频 Sticker 后，确认 Sticker 索引仍为 `success`。
- 同文件里另外两条问题不在本次范围内：TGS 解压没有上限（P2 的下一项）；超时只发 SIGTERM，不会升级为强制结束。

## 提交

```txt
e4f310d Decode video stickers only as WebM from the local file
```
