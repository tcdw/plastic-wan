# 运行与运维

## 运行时依赖

必需：

- Bun
- FFmpeg 与 FFprobe
- Python
- `lottie` Python package，提供 `lottie_convert.py`
- Provider API key
- Telegram Bot Token

Windows + Scoop：

```powershell
scoop install ffmpeg-essentials python
python -m pip install lottie
```

安装后新开 PowerShell，确认 `ffmpeg`、`ffprobe`、`python` 可解析。Windows 运行时通过 Python 执行 `lottie_convert.py`；Linux/macOS 要求 `lottie_convert.py` 本身在服务 PATH 中。

TGS 流程先导出 SVG 再交给 Sharp，因此不需要 CairoSVG、Pillow 或 Glaxnimate。

## 初始化开发环境

```powershell
cd C:\Users\tcdw\Projects\plastic-wan
bun install

$env:GOOGLE_API_KEY = "<rotated-key>"
bun run src/cli.ts check-config --config dev-data/config.toml
bun run src/cli.ts doctor --config dev-data/config.toml
```

`dev-data/config.toml`、数据库、媒体和备份已由 `.gitignore` 排除。不要把 Secret 复制到受版本控制的示例或文档。

## 启动与停止

```powershell
bun run src/cli.ts serve --config dev-data/config.toml
```

成功标志：

```json
{"event":"serve_started","bot_id":"...","config_hash":"...","at":"..."}
```

人工前台运行使用 `Ctrl+C`。服务会：

1. 停止 Telegram long polling。
2. 最多等待 Scheduler 30 秒。
3. 停止 Sticker worker 与 MCP。
4. 关闭 SQLite。
5. 释放 `serve.lock`。

不要启动第二份实例。同一 `data_dir` 的 `serve.lock` 会拒绝双实例；绕过锁会造成 Telegram long polling 竞争和未知副作用。

## 配置变更

配置不热重载。变更后：

```powershell
bun run src/cli.ts check-config --config dev-data/config.toml
# 停止旧进程
bun run src/cli.ts serve --config dev-data/config.toml
```

必须确认新 `serve_started.config_hash` 与 `check-config.config_hash` 一致。Chat 已写入文件但仍出现 `chat_not_allowed` 时，首先检查旧进程是否仍使用旧哈希。

## Doctor

```powershell
bun run src/cli.ts doctor --config dev-data/config.toml
```

Doctor 执行真实检查，不是静态 lint：

- 配置与 Secret 解析。
- 数据目录、剩余空间和权限。
- SQLite FTS5 trigram。
- Sharp PNG。
- FFmpeg、FFprobe。
- TGS → SVG → Sharp PNG。
- 自定义 Provider 连通性。
- Agent 模型严格 Tool Call。
- Vision 图片输入。
- Telegram `getMe`。
- required MCP 启动与 Tool registry。

成功输出示例字段：

```json
{
  "status": "ok",
  "fts5_trigram": true,
  "sharp": true,
  "ffmpeg": true,
  "ffprobe": true,
  "lottie": true
}
```

Doctor 会产生 `role = 'doctor'` 的模型调用审计并消耗少量 Provider Token。

## 日志

用户可见日志写 stdout，格式为单行 JSON；框架 trace 可能写 stderr。至少监控：

- `serve_started`
- 进程退出与重启次数
- required MCP 初始化失败
- 未脱敏前的错误不得直接输出

消息、Tool 和模型的细节以 SQLite 审计为准，stdout 不为每条 Update 打日志。不要因日志安静就判断 Bot 没有处理消息。

## 本地排障

### Chat not allowed

1. 确认 Chat ID 符号和完整值，Supergroup 通常为负数。
2. 运行 `check-config`。
3. 重启进程。
4. 对比启动配置哈希。
5. 查询 `telegram_updates.allowed` 与 `rejection_reason`。

### Bot 没有回复

沉默可能是成功行为。检查：

1. Update 是否 allowed。
2. Bucket 是否到达 15 秒 deadline。
3. Invocation 是否 completed。
4. `sends_used = 0`：Agent 主动不发言。
5. 有 `tool_calls` 时继续检查 `send`/`read_image`/MCP 状态。

### Sticker 理解失败

- `media_analyses.state/error/failure_count`。
- 对应 Vision `model_calls`。
- FFmpeg/FFprobe 或 python-lottie 是否在 PATH。
- 模型是否返回 `report_sticker_analysis` Tool Call。
- 重试成功后确认分析状态和 `read_image` Tool Call 都为 success。

### Serve lock

- 正常停止后锁自动删除。
- 服务启动会识别并修复已退出 PID 的 stale lock。
- 锁存在时先确认 PID 与进程归属；不要在活动进程期间手动删除。

## 备份

手动：

```bash
bun run src/cli.ts backup --config dev-data/config.toml
```

输出备份文件路径。备份前执行保留清理，完成后按 `backup_copies` 轮换。定期从复制出的数据库运行：

```sql
PRAGMA integrity_check;
```

并做实际恢复演练；“命令成功”不等于恢复路径已验证。

## systemd 部署

仓库提供：

- `deploy/plasticwan.service`
- `deploy/plasticwan-backup.service`
- `deploy/plasticwan-backup.timer`

约定：

| 路径 | 用途 |
| --- | --- |
| `/opt/plasticwan` | 只读应用工作目录 |
| `/etc/plasticwan/config.toml` | `0600` 配置 |
| `/var/lib/plasticwan` | SQLite、媒体和备份唯一写目录 |
| `/usr/local/bin/bun` | Bun 可执行文件 |

服务用户/组为 `plasticwan`。主服务 `Restart=on-failure`、`UMask=0077`，systemd sandbox 只开放 `/var/lib/plasticwan` 写权限。备份 timer 每天 UTC 00:00 运行并带 `Persistent=true`。

部署前要保证 systemd 的服务 PATH 能找到 `ffmpeg`、`ffprobe`、`lottie_convert.py` 及其 Python。安装单元后验证：

```bash
systemctl daemon-reload
systemctl enable --now plasticwan.service
systemctl enable --now plasticwan-backup.timer
systemctl status plasticwan.service
systemctl list-timers plasticwan-backup.timer
```

修改配置后使用受控 restart，并确认新日志中的配置哈希。
