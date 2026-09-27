---
title: 使用管理面板
description: 安全访问本地 Admin Panel，查看审计、管理模型与应用配置。
---

# 使用管理面板

Admin Panel 与 `serve` 同进程启动，用于本地审计和受控管理；它不是文档站，也不应直接暴露在公网。

## 启用与安全访问

配置：

```jsonc
{
  "admin": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8787,
    "session_ttl_hours": 24
  }
}
```

`admin.*` 改动需要重启。Docker 中要从宿主机访问，容器应绑定 `0.0.0.0`，但端口发布必须限制为 `127.0.0.1:8787:8787`，再由你管理的 TLS 反向代理进行认证和访问控制。首次访问时创建管理员账号；密码长度为 12–200 字符，浏览器 Session 采用 HttpOnly 且 SameSite=Strict Cookie。

## 常用任务

- **Overview / Invocations / Messages / Contexts**：查看收到消息、运行窗口、Tool 调用和连续对话上下文；审计读取不修改数据。
- **Models**：维护 Provider、已启用模型和全局 Agent/Vision 选择。保存后查看是否成功应用。
- **Chats**：管理 Chat/Topic allowlist 与每群模型覆盖。新增/删除 Chat 与 Topic 范围需重启；已有 Chat 的模型覆盖可热应用。
- **Memories**：查看、编辑或删除短期记忆；长 TTL 记忆应由人工审核，不要把它当永久知识库。
- **Settings**：对手改配置使用 **Apply config file**，并查看 Saved 与 Running 状态及 `restart_required`。

## 验证与风险

启动日志需要有 `admin_started`。设置页面显示“已保存”不一定等于运行中已使用：若有待重启字段，确认外部监督器已重启服务后再检查配置哈希。不要共享面板密码、Cookie 或从浏览器导出的请求。

面板打不开时，请看 [排查问题](../operations/troubleshooting.md)。
