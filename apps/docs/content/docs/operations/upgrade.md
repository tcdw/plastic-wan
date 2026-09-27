---
title: 升级与数据库迁移
description: 安全升级 Plastic Wan，并区分代码、配置和数据库变更。
---

# 升级与数据库迁移

升级前先记录当前源码提交、镜像标签、配置哈希和数据目录。数据库迁移、配置格式变化与镜像变更是不同步骤；迁移成功不表示可安全降级。

## 推荐流程

1. 停止或维护窗口前，运行 [备份](backup-restore.md) 并将配置、Prompt 与密钥备份策略一并确认。
2. 获取目标源码提交；使用本地构建时重新执行：

   ```bash
   docker build -t plasticwan:local .
   ```

3. 对现有配置运行目标版本的校验：

   ```bash
   docker compose run --rm plasticwan check-config --config /config/config.jsonc
   ```

4. 替换正在运行的服务。Compose 可执行 `docker compose up -d`；确保不会并发启动第二个相同 `/data` 的 `serve`。
5. 跟踪日志，确认数据库迁移、`startup_catch_up_completed` 与 `serve_started`。检查新的配置哈希。
6. 向允许的 Chat 发一条受控测试消息，并在 Admin 审计中确认 Invocation 状态。

## 配置变化

先读取目标版本的配置参考和报错信息；不要为通过校验而盲目删字段。字段可能需要重启，热应用只处理白名单，详见 [配置文件与密钥](../configure/config-file.md)。

## 风险与恢复

升级前备份不是降级保证。若启动或迁移失败，保留失败日志和原数据副本，在隔离目录演练 [恢复](backup-restore.md)，而不是删除 SQLite、缓存或锁文件。具体旧版本迁移路径尚未在本指南环境中演练。
