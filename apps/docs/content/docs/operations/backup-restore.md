---
title: 备份与恢复
description: 创建数据库备份、理解保留策略，并在隔离环境验证恢复。
---

# 备份与恢复

在线数据由 `retention.online_days` 保留；`backup` 会先清理再创建 SQLite 备份，并按 `retention.backup_copies` 轮换。配置、Prompt 和密钥不在数据库中，必须纳入单独且受保护的备份策略。

启用了图片生成时，`backup` 还会把原图目录（`<data_dir>/images`）一并拷贝为备份文件旁的同名 `.images` 目录（如 `plasticwan-….sqlite.images/`）。目录不存在时跳过；拷贝失败只记日志，不影响 SQLite 备份的有效性。恢复时把 `.images` 目录放回 `data_dir` 下的 `images/`，与 SQLite 文件配套使用——两个快照之间没有跨库原子性，恢复后个别最新记录可能引用尚未拷入的图片文件。

## 创建备份

Docker：

```bash
docker compose run --rm plasticwan backup --config /config/config.jsonc
```

宿主机：

```bash
node src/cli.ts backup --config /path/to/config.jsonc
```

命令成功只说明备份已生成，不代表恢复路径已被验证。备份相关字段仅由下次 `backup` 读取，不需要热应用。

## 恢复前的检查清单

1. 停止正在使用目标数据目录的服务，避免两个进程写同一 SQLite 数据库。
2. 保留原始目录的只读副本；不要直接覆盖唯一副本。
3. 准备**新建且为空的隔离目录**和复制的 `config/`、Prompt。编辑复制的配置，将 `data_dir`、`paths.database`、`paths.media_cache`、`paths.backups` 全部改到隔离目录内；Prompt 的相对路径仍以配置目录为准。密钥仍通过安全环境或 key jar 提供，绝不放进工单或公开存储。
4. 项目没有 `restore` 命令。只将候选备份文件复制到新配置的 `paths.database`；不要覆盖原数据库，也不要复制旧目录中的 `-wal`、`-shm` 或 `serve.lock`。先在不运行 Bot 的条件下检查数据库完整性。
5. 用复制的配置运行 `check-config`，人工核对全部路径；校验成功**不证明数据目录隔离或备份完整**。只有得到许可后才启动隔离服务，验证审计与一条受控消息。同一个 Telegram Token 只能有一个轮询实例；数据目录不同也不能与原 Bot 同时轮询。

### Linux/macOS 上的离线复制示例

下列命令用于宿主机演练；占位路径需替换。`mktemp` 创建新目录，随后只写该目录。先复制配置和所需 Prompt（不要将密钥复制到公开位置），再编辑配置，使路径与输出的隔离目录一致。

```bash
restore_root="$(mktemp -d)"
mkdir "$restore_root/config" "$restore_root/data"
chmod 700 "$restore_root" "$restore_root/config" "$restore_root/data"
cp /protected/config/config.jsonc "$restore_root/config/config.jsonc"
chmod 600 "$restore_root/config/config.jsonc"
printf '隔离根目录：%s\n' "$restore_root"
# 编辑新配置：data_dir 指向此 data 目录；paths.database 指向其中的 restored.sqlite
# paths.media_cache、paths.backups 也必须在此 data 目录内；复制配置所引用的 Prompt
cp /protected/backups/chosen.sqlite "$restore_root/data/restored.sqlite"
chmod 600 "$restore_root/data/restored.sqlite"
```

若已安装 SQLite CLI，可在启动前执行只读完整性检查：

```bash
sqlite3 -readonly "$restore_root/data/restored.sqlite" 'PRAGMA integrity_check;'
node src/cli.ts check-config --config "$restore_root/config/config.jsonc"
```

完整性检查应返回 `ok`；任何错误都先保留证据，不启动服务。SQLite CLI 是此检查的额外工具，不假定镜像已安装。Windows 使用新建目录和文件复制完成同样的隔离与检查，不执行上述 POSIX 权限命令。

Docker 演练必须另建 Compose 项目（不同 `-p`），将配置和数据卷绑定到**新的宿主机目录**，并选择不冲突的回环端口；容器内可沿用 `/data`，但它必须挂载隔离数据目录。不要直接复用生产 Compose 的 `./data`，或因改了配置副本就以为卷已经隔离。

## 风险

数据库备份无法替代 Telegram、Provider 或密钥可用性。不要把迁移前备份当作自动降级按钮；版本不匹配时先在隔离环境演练。当前指南未对真实备份恢复做环境实测。
