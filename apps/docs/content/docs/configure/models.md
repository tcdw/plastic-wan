---
title: 配置 Provider 与模型
description: 显式启用可用模型，并为 Agent 与视觉分析选择合适的能力。
---

# 配置 Provider 与模型

Plastic Wan 只使用配置 `providers.<alias>.models` 中显式列出的模型；Provider 目录里存在不代表运行时可选。主 Agent 模型必须支持 `text`，视觉模型必须支持 `image`，每个模型的上下文、输出上限与成本元数据都要写入配置。

## 从样例开始

[完整样例](__DOCS_BASE__/examples/config.example.jsonc) 使用一个 `custom` Provider。将以下信息替换成你的服务实际值：

1. `base_url` 和 API 协议（`openai-responses`、`openai-completions`、`anthropic-messages` 或 `google-generative-ai`）。
2. 环境变量名；不要把 key 填入 `api_key`。
3. 模型 ID、输入能力、上下文窗口、输出上限和成本。示例 ID 是占位值，不能保留。
4. `agent.provider` / `agent.model` 与 `vision.provider` / `vision.model` 的引用。

推理模型可声明 `reasoning: true` 和可接受的 `thinking_levels`；否则选择 `off`。模型的 `max_tokens` 不能大于 `context_window`，视觉的 `max_output_tokens` 不能超过所选模型上限。

## 选择原则

- 主 Agent：需要可靠的文本、工具调用与足够上下文；若要直接理解普通图片，也需 image 输入。
- Vision：用于图片与 Sticker 分析，单独有并发和日预算；不等于主 Agent 的成本预算。
- 先以保守预算和并发上线，再通过管理面板 Usage 与审计观察实际用量。

## 生效与验证

Provider 定义、模型列表、Agent 模型和视觉模型可以热应用，下一次 Invocation/视觉分析使用新快照；运行中的 Invocation 不会中途换模型。用 Admin **Models** 页保存，或修改文件后点击 **Apply config file**；随后查看 `config_reloaded`。

在有真实凭据且允许消耗 Token 的环境运行：

```bash
node src/cli.ts doctor --config /path/to/config.jsonc
```

Doctor 是实际连通性探针，不是离线 lint。模型失败时不要猜模型名，检查 Provider 返回与 [排查问题](../operations/troubleshooting.md)。
