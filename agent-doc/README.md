# Agent Documentation

本目录存放面向 AI agent 的 Plastic Wan 项目知识。根目录 [`../AGENTS.md`](../AGENTS.md) 是统一入口；这里的文档按任务主题拆分，避免每次加载完整技术设计。

## 使用方式

1. 先读 [`../AGENTS.md`](../AGENTS.md) 的项目约束与「Where to Look」。
2. 根据任务只读取相关主题文档。
3. 以当前源码、迁移和配置 Schema 为最终事实；设计文档用于理解范围与意图。
4. 行为或运维契约改变时，同步更新对应主题文档和本索引。

## 快速入口

| 任务 | 文档 |
| --- | --- |
| 理解整体进程、模块和信任边界 | [architecture.md](architecture.md) |
| 修改 TOML、Provider、Chat/Topic、Sticker Set 或 MCP | [configuration.md](configuration.md) |
| 修改 SQLite、迁移、保留、备份或审计 | [data-layer.md](data-layer.md) |
| 修改 Telegram 入库、调度、Context、Tool 或媒体 | [telegram-agent-flow.md](telegram-agent-flow.md) |
| 本地启动、安装媒体依赖、部署或排障 | [operations.md](operations.md) |
| 修改 Admin Panel 认证、审计 API 或前端 | [admin-panel.md](admin-panel.md) |
| 决定该运行哪些验证 | [verification.md](verification.md) |
| 查 Phase 1 产品目标与验收范围 | [design/20260815 塑料碗 Telegram Bot 设计方案.md](design/20260815%20塑料碗%20Telegram%20Bot%20设计方案.md) |
| 查原始技术设计、安全边界与状态机 | [design/20260815 塑料碗 Telegram Bot 技术设计.md](design/20260815%20塑料碗%20Telegram%20Bot%20技术设计.md) |

## 文档边界

- `AGENTS.md`：稳定入口、仓库规则、命令和主题目录。
- 本目录正文：当前实现的可检索知识与故障处理。
- `design/`：需求与技术设计原文，不作为运行状态或版本号的动态记录。
- 测试：可执行行为契约；文档与测试冲突时，先核对源码和最近迁移，再修正文档或实现。
