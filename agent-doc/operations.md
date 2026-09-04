# 运行与运维

## 运行时依赖

必需：

- Bun
- FFmpeg 与 FFprobe
- Python
- `lottie` Python package，提供 `lottie_convert.py`
- Provider API key
- Telegram Bot Token

macOS（Homebrew）：

```bash
brew install ffmpeg python
python3 -m pip install --user lottie
```

Debian/Ubuntu：

```bash
sudo apt-get install -y ffmpeg python3 python3-pip
python3 -m pip install --user lottie
```

Linux/macOS 要求 `lottie_convert.py` 本身在服务 PATH 中（`pip --user` 装到 `~/.local/bin`，确认它在 PATH 里）。Windows 是次要开发环境：`scoop install ffmpeg-essentials python` 后 `python -m pip install lottie`，运行时通过 Python 执行 `lottie_convert.py`。

安装后确认 `ffmpeg`、`ffprobe`、`lottie_convert.py` 都能解析。TGS 流程先导出 SVG 再交给 Sharp，因此不需要 CairoSVG、Pillow 或 Glaxnimate。

## 初始化开发环境

```bash
cd ~/Projects/plasticwan
bun install

export GOOGLE_API_KEY="<rotated-key>"
bun run src/cli.ts check-config --config dev-data/config.jsonc
bun run src/cli.ts doctor --config dev-data/config.jsonc
```

`dev-data/config.jsonc`、数据库、媒体和备份已由 `.gitignore` 排除。不要把 Secret 复制到受版本控制的示例或文档。

## 启动与停止

```bash
bun run src/cli.ts serve --config dev-data/config.jsonc
```

成功标志依次包含启动追赶完成与常规轮询启动：

```json
{"event":"startup_catch_up_completed","updates":0,"stored_messages":0,"invocations":0,"at":"..."}
{"event":"serve_started","bot_id":"...","config_hash":"...","at":"..."}
```

人工前台运行使用 `Ctrl+C`。服务会：

1. 停止 Telegram long polling。
2. 停止 Admin Panel HTTP server。
3. 最多等待 Scheduler 30 秒。
4. 停止 Sticker worker 与 MCP。
5. 关闭 SQLite。
6. 释放 `serve.lock`。

不要启动第二份实例。同一 `data_dir` 的 `serve.lock` 会拒绝双实例；绕过锁会造成 Telegram long polling 竞争和未知副作用。

## 配置变更

配置不热重载。变更后：

```bash
bun run src/cli.ts check-config --config dev-data/config.jsonc
# 停止旧进程
bun run src/cli.ts serve --config dev-data/config.jsonc
```

必须确认新 `serve_started.config_hash` 与 `check-config.config_hash` 一致。Chat 已写入文件但仍出现 `chat_not_allowed` 时，首先检查旧进程是否仍使用旧哈希。

## Doctor

```bash
bun run src/cli.ts doctor --config dev-data/config.jsonc
```

如需查看配置中 Agent 系统 Prompt 的模板渲染结果：

```bash
bun run src/cli.ts doctor --config dev-data/config.jsonc --output-agent-prompt
```

该选项仍会执行完整 Doctor 检查；成功 JSON 中增加 `agent_prompt` 字段。输出包含 Prompt 正文，但不会包含 Secret、Chat 记忆或 Chat-specific instructions。不要在共享日志中使用该选项。

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
- `admin_started`（仅在 `admin.enabled = true` 时出现）
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
2. Bucket 是否到达 `telegram.bucket_window_seconds` 节拍；同一群内前一个 Invocation 仍在运行时，需等待它结束。
3. Invocation 是否 completed。
4. `sends_used = 0`：Agent 主动不发言。
5. 有 `tool_calls` 时继续检查 `send`/`read_image`/MCP 状态；image-capable Agent 的图片直传失败时检查 Invocation 的 `completion_reason`。

### 图片或 Sticker 理解失败

- text-only Agent 的普通图片与全部 Sticker：检查 `media_analyses.state/error/failure_count` 和对应 Vision `model_calls`。
- image-capable Agent 的普通图片：检查 Invocation/Agent `model_calls`，不会产生 `read_image`。
- 视频/动画 Sticker 检查 FFmpeg/FFprobe 或 python-lottie 是否在 PATH。
- Sticker 模型是否返回 `report_sticker_analysis` Tool Call。
- 重试成功后确认分析状态和 `read_image` Tool Call 都为 success。

### Serve lock

- 正常停止后锁自动删除。
- 服务启动会识别并修复已退出 PID 的 stale lock。
- 锁存在时先确认 PID 与进程归属；不要在活动进程期间手动删除。

### Admin Panel 打不开

1. 确认 `admin.enabled = true` 且已重启 `serve`。
2. 启动日志中应有一条 `admin_started`，`host`/`port` 与配置一致。
3. 页面返回 503 `admin_bundle_missing`：先 `bun run admin:build`，或修正 `static_dir`。
4. 忘记密码时没有恢复入口：删除 `admin_users` 行会重新进入首次初始化流程；这是写操作，只能在停止 `serve` 后手动执行。
5. 登录返回 429 `too_many_attempts`：同一用户名连续 10 次失败后锁定 15 分钟，重启 `serve` 会清空内存计数。

## 备份

手动：

```bash
bun run src/cli.ts backup --config dev-data/config.jsonc
```

输出备份文件路径。备份前执行保留清理，完成后按 `backup_copies` 轮换。定期从复制出的数据库运行：

```sql
PRAGMA integrity_check;
```

并做实际恢复演练；“命令成功”不等于恢复路径已验证。

## 部署方式

仓库提供两条部署路径，二选一：

- **Docker**：`Dockerfile` + `docker-compose.yml`，镜像由 CI 推到 GHCR。媒体依赖已打进镜像。
- **systemd**：`deploy/` 下的三个单元，直接在宿主机跑 Bun。需要自己保证 FFmpeg/python-lottie 在服务 PATH 中。

## Docker 部署

`.github/workflows/docker.yml` 在推送 `develop` 分支和 `v*` tag 时构建 `linux/amd64` 与 `linux/arm64` 镜像并推送到 `ghcr.io/tcdw/plasticwan`：`develop` 产出 `nightly` 与 `develop` tag，`v*` 产出 `latest` 与 semver tag。

镜像结构（`Dockerfile`，基于 `oven/bun:1.4-debian` 两阶段）：

- builder 阶段 `bun install --frozen-lockfile` → `bun run admin:build` → 再以 `--production` 剪掉 devDependencies。
- runtime 阶段用 apt 装 `ffmpeg`（含 `ffprobe`）、`python3` 与 `gosu`，再 pip 装 `lottie`；因此**不需要**在宿主机准备任何媒体依赖。
- 只复制 `src/`、`node_modules/`、`apps/admin/dist/` 和 `package.json`。`deploy/`、`test/`、`agent-doc/`、`dev-data/` 被 `.dockerignore` 排除，镜像里没有这些目录。
- Admin 前端已经构建进 `/app/apps/admin/dist`，与 `static_dir` 默认值一致，无需额外配置。

运行约定：

| 容器路径 | 用途 |
| --- | --- |
| `/config/config.jsonc` | 配置文件（bind mount） |
| `/config/*.md` | Prompt 文件；`system_prompt_file`、`instructions_file` 相对配置文件解析，必须和 `config.jsonc` 放在一起 |
| `/data` | `data_dir`、SQLite、媒体缓存与备份 |

配置里必须使用容器内路径，而不是宿主机路径：

```jsonc
{
  "data_dir": "/data",
  "paths": {
    "database": "/data/plasticwan.sqlite",
    "media_cache": "/data/media-cache",
    "backups": "/data/backups",
  },
}
```

启动：

```bash
mkdir -p config data
# 把 config.jsonc 和 prompt 文件放进 ./config/
docker compose up -d
docker compose logs -f          # 确认 serve_started 与 config_hash
```

`docker-entrypoint.sh` 以 root 启动，做三件事后才降权：

1. 按 `PUID`/`PGID`（默认 `1000`）重映射容器内 `plasticwan` 用户，避免 bind mount 的属主冲突。
2. `chown -R` 挂载卷，并把 `/config`、`/data` 设为 `0700`、`/config/config.jsonc` 设为 `0600` —— 这是为了满足 `assertConfigPermissions` 的权限检查，宿主机上不必手动 chmod。
3. `exec gosu plasticwan bun run /app/src/cli.ts "$@"`。

因为最后一步把参数原样传给 CLI，其它子命令都能用同一镜像跑：

```bash
docker compose run --rm plasticwan check-config --config /config/config.jsonc
docker compose run --rm plasticwan doctor --config /config/config.jsonc
docker compose run --rm plasticwan backup --config /config/config.jsonc
```

注意：`serve` 是长期进程且受 `ServeLock` 约束，同一 `data_dir` 只能有一个实例。上面的一次性命令都不启动 `serve`，可以与运行中的容器共存；但**不要**用 `docker compose run` 再起一个 `serve`。

Admin Panel 的 `admin.host` 只接受回环地址，因此它绑定的是**容器内**的 `127.0.0.1`。Docker 的端口发布转发到容器在 bridge 网络上的地址，够不到 loopback，所以 `docker-compose.yml` 里的 `ports:` 默认是注释掉的，取消注释也不会让面板可达。可行的访问方式：

- `docker compose exec plasticwan <客户端> http://127.0.0.1:8787/...`（镜像未显式安装 curl，先确认基础镜像里有没有）；
- 让反向代理与容器共享网络命名空间（`network_mode: "service:plasticwan"`），由它承担 TLS 与对外暴露。

配置变更同样不热重载，改完 `./config/config.jsonc` 后 `docker compose restart`，并比对新日志里的 `config_hash`。

## systemd 部署

仓库提供：

- `deploy/plasticwan.service`
- `deploy/plasticwan-backup.service`
- `deploy/plasticwan-backup.timer`

约定：

| 路径 | 用途 |
| --- | --- |
| `/opt/plasticwan` | 只读应用工作目录 |
| `/etc/plasticwan/config.jsonc` | `0600` 配置 |
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
