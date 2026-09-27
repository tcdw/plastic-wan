---
title: 管理 Conversation 记忆
description: 了解按 Conversation 隔离的短期记忆、TTL 和 Admin Panel 管理方式。
---

# 管理 Conversation 记忆

Plastic Wan 的 Agent 记忆属于单个 Conversation：同一 Chat 的不同 Forum Topic 不共享记忆，私聊也有自己的 Conversation。记忆用于保存模型主动记录的短期事实，不是全局知识库。

## 先配置保留策略

在 `agent` 中配置片段（这是片段，不是完整配置）：

```jsonc
{
  "agent": {
    "memory_ttl_warning_days": 30
  }
}
```

记忆的具体 TTL 由 Agent 在调用记忆能力时决定；系统会在到期后自动清理。`memory_ttl_warning_days` 只控制 Admin Panel 何时把剩余寿命较长的记忆标为 `long_ttl`，不会阻止长 TTL。

## 在面板查看和处理

1. 打开 Admin Panel 并登录。
2. 进入 **Memories**，按 Chat 或状态筛选。
3. 查看记忆内容、所属 Chat/Conversation、创建时间和 TTL 状态。
4. 对长 TTL 记忆选择保留、删除，或提升到人工维护的 `agents.md` 长期知识中。

面板中的记忆管理是受控写操作；普通审计页面只读。删除只影响该条记忆，不会删除消息、Context 或其他 Conversation 的记忆。

## 何时生效与如何确认

记忆在下一次该 Conversation 的模型注入中出现在记忆列表。新增记忆按创建顺序追加；删除或 TTL 到期后不再注入。可在 **Tool sessions** 查看对应 Invocation 的上下文时间线，并在 **Memories** 列表刷新确认状态变为 `expired` 或消失。

重启不会把未到期记忆变成全局记忆；Conversation Context 和记忆按各自的 Conversation 继续隔离。修改 Prompt 导致 Context 重建，也不会把记忆复制到其他 Conversation。

## 常见误区

- Topic 隔离不是“每 Topic 各有独立预算或全套配置”；它只说明 Context、记忆和消息边界按 Conversation 隔离。
- 记忆不是可靠数据库。需要长期保留的内容必须人工审核后写入 `agents.md`。
- 删除消息或切换模型不会自动把所有记忆清除；请在 Memories 页面单独处理。
- 不要把 Token、API key 或其他凭据写入记忆。

相关页面：[管理面板](../configure/admin.md)、[Telegram 与 Topic](../configure/telegram.md)、[配置参考](../reference/config.md)。
