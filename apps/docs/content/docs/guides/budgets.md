---
title: 配置 Agent、Vision 预算与睡眠
description: 设置全局 Agent Token 熔断、Vision 预算，了解睡眠状态和验证用量的方法。
---

# 配置 Agent、Vision 预算与睡眠

Plastic Wan 有两套相关但不相同的预算：主 Agent 的全局 Token 上限，以及后台 Sticker 索引使用的 Vision 预算。聊天触发的 `read_image` 使用主 Agent 的全局预算，不会变成每群独立 Token 配额。

## 设置全局 Agent Token 上限

局部 JSONC 片段如下（不是完整配置）：

```jsonc
{
  "agent": {
    "daily_budget": {
      "max_tokens": 1000000
    }
  }
}
```

该上限按 UTC 日统计主 Agent 和聊天触发的 `read_image`。计量包含非缓存输入、缓存读取、缓存写入和生成 Token；各 Chat 仍有归属统计，但只有这一个全局硬上限。

## 设置 Vision 预算

`vision` 中可按运行时 Schema 配置独立模型与后台 Sticker 索引预算。示例仍是局部片段：

```jsonc
{
  "vision": {
    "provider": "gateway",
    "model": "replace-with-your-text-and-image-model",
    "max_output_tokens": 2048,
    "daily_budget": {
      "max_tokens": 200000,
      "max_images": 500
    }
  }
}
```

Vision 模型必须支持 image，`max_output_tokens` 不能超过该模型的 `max_tokens`。Vision 的 `daily_budget` 只限制后台 Sticker 索引；普通聊天图片的 `read_image` 计入 `agent.daily_budget.max_tokens`。

模型引用沿用[完整示例](../configure/models.md)，需替换为你实际注册的模型。

## 限制同时运行与消息量

在完整配置中调整 `agent.max_concurrency` 控制同时运行的 Agent 数量；`agent.rate_limits.sends_per_window` 和 `window_seconds` 限制发送频率，`turns_per_injection` 限制一次注入后的模型轮次。这些限制不等于 Token 预算，不保证所有任务一定发出回复。

`agent.context` 控制连续上下文的保留、引用有效期与单次运行时长；上下文清理丢弃旧 checkpoint，不会自动摘要。优先沿用完整示例中的比例关系，再用 `check-config` 校验，避免把所有上限同时调高。

Token 上限不是美元账单硬限额。价格元数据、供应商计量及已开始的请求都会影响最终花费；还应在供应商侧设置账户额度并观察实际账单。

## 预算触顶后会发生什么

当全局当日 `model_tokens` 剩余比例严格低于 5% 时，Agent 可能看到 `zzz` 并选择睡眠。调用 `zzz` 会写入全局睡眠状态，通常至少持续 8 小时或直到下一次 UTC 日预算重置（取较晚者）。睡眠期间消息、编辑和 Bucket 仍保存，但新的 Agent Invocation 会被跳过，不会补发被跳过的 Bucket。

管理员可在 Admin Overview 点击 **Wake now** 解除睡眠；这不会重放睡眠期间已经跳过的批次。后续新消息和到期 Bucket 才恢复调度。Alarm Invocation 不受每日预算 gate 和 `zzz` 影响，但仍受其他运行约束。

## 让修改生效和验证

1. 运行 `node src/cli.ts check-config --config <config.jsonc>` 校验预算关系和模型引用。
2. `agent.daily_budget.max_tokens`、Vision 的 provider/model/max_output_tokens 可热应用；Vision 的并发等其他字段需要重启。手改文件后在 Settings 点击 **Apply config file**。
3. 在 Admin **Usage** 查看每日 Token 曲线，在 Tool session 的 Model call 查看 input、cache read/write 和 output 明细。
4. 在 Overview 查看 `awake`/`sleeping` 与 `sleep_until`；若恢复运行，确认后续消息产生新的 Invocation。

## 常见误区

- 预算是全局 Agent 上限，不是每群上限，也不是每 Topic 上限。
- Vision 后台预算和聊天 `read_image` 的计量入口不同。
- “Wake now” 不会重放已经因睡眠跳过的 Bucket。
- 修改 `key.json` 等凭据文件不是预算配置；不要把 Token 或 API key 写入配置、日志或文档。

相关页面：[模型](../configure/models.md)、[管理面板](../configure/admin.md)、[配置参考](../reference/config.md)、[排障](../operations/troubleshooting.md)。
