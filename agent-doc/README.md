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
| 修改 JSONC、Provider、Chat/Topic、Sticker Set 或 MCP | [configuration.md](configuration.md) |
| 修改 SQLite、迁移、保留、备份或审计（含 durable internal context） | [data-layer.md](data-layer.md) |
| 修改 Telegram 入库、调度、Context、Tool 或媒体 | [telegram-agent-flow.md](telegram-agent-flow.md) |
| 实现/排查 Alarm 与 Deferred Invocation | [telegram-agent-flow.md](telegram-agent-flow.md)、[design/20260828 闹钟系统.md](design/20260828%20闹钟系统.md) |
| 本地启动、安装媒体依赖、部署或排障 | [operations.md](operations.md) |
| 修改 Admin Panel 认证、审计 API 或前端 | [admin-panel.md](admin-panel.md) |
| 决定该运行哪些验证 | [verification.md](verification.md) |
| 查 Phase 1 产品目标与验收范围 | [design/20260815 塑料碗 Telegram Bot 设计方案.md](design/20260815%20塑料碗%20Telegram%20Bot%20设计方案.md) |
| 查原始技术设计、安全边界与状态机 | [design/20260815 塑料碗 Telegram Bot 技术设计.md](design/20260815%20塑料碗%20Telegram%20Bot%20技术设计.md) |

## 计划文档（尚未落地，不描述当前行为）

以下文档描述的是设想中的工作，读它们**不能**推断系统现在的行为；判断现状一律以源码与上表的主题文档为准。

| 计划 | 文档 | 状态 |
| --- | --- | --- |
| Bun → Node.js 运行时迁移 | [bun-to-node-migration.md](bun-to-node-migration.md) | Phase 2（Drizzle 查询层）已完成，Phase 1/3–6 未开始 |
| Admin 配置保存、备份与进程重启 | [config-admin-save-restart-plan.md](config-admin-save-restart-plan.md) | 未实现：无 `config_changes` 表、无配置写入 API、无 `restore-config` |
| Skills 机制 | [design/20260903 塑料碗 Skills 机制设计计划.md](design/20260903%20塑料碗%20Skills%20机制设计计划.md) | 未实现：源码中没有任何 Skill 相关模块 |

## design/ 全部原文

`design/` 保存需求与设计原文，按日期排列，不作为运行状态的动态记录。已实现的设计以主题文档为准，两者冲突时相信主题文档和源码。

| 文档 | 内容 | 对应主题文档 |
| --- | --- | --- |
| [20260815 设计方案](design/20260815%20塑料碗%20Telegram%20Bot%20设计方案.md) | Phase 1 产品范围与验收 | — |
| [20260815 技术设计](design/20260815%20塑料碗%20Telegram%20Bot%20技术设计.md) | 原始技术设计、安全边界与状态机 | [architecture.md](architecture.md) |
| [20260819 记忆系统](design/20260819%20记忆系统.md) | Conversation 级短期记忆与 TTL | [data-layer.md](data-layer.md) |
| [20260823 睡眠系统](design/20260823%20睡眠系统.md) | 预算耗尽后的 `zzz` 与全局睡眠 | [telegram-agent-flow.md](telegram-agent-flow.md) |
| [20260828 闹钟系统](design/20260828%20闹钟系统.md) | Alarm / Deferred Invocation | [telegram-agent-flow.md](telegram-agent-flow.md) |
| [20260828 闹钟系统 Admin Alarms 布局](design/20260828%20闹钟系统%20Admin%20Alarms%20布局.md) | Admin Alarms 页面布局（已实现） | [admin-panel.md](admin-panel.md) |
| [20260830 闹钟系统改进](design/20260830%20闹钟系统改进.md) | `list_alarm`/`delete_alarm` 与 durable internal context 的需求原文（已实现） | [telegram-agent-flow.md](telegram-agent-flow.md) |
| [20260903 Skills 机制设计计划](design/20260903%20塑料碗%20Skills%20机制设计计划.md) | Skills 机制（**未实现**） | — |

## 文档边界

- `AGENTS.md`：稳定入口、仓库规则、命令和主题目录。
- 本目录正文：当前实现的可检索知识与故障处理。
- 「计划文档」与 `design/`：设想或原始需求，不是当前行为；不作为运行状态或版本号的动态记录。
- 测试：可执行行为契约；文档与测试冲突时，先核对源码和最近迁移，再修正文档或实现。
