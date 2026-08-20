import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Alert, Button, Card, Descriptions, Select, Space, Typography } from "antd";
import type { ModelOption } from "../api.ts";
import { resetAgentModel, switchAgentModel } from "../api.ts";
import { queryState } from "../components.tsx";
import { modelQuery } from "../queries.ts";

export function ModelPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const model = useQuery(modelQuery);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const optionKey = (option: ModelOption): string => `${option.provider}/${option.model}`;
  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["model"] });
  };
  const apply = useMutation({
    mutationFn: async (option: ModelOption) => switchAgentModel({ provider: option.provider, model: option.model }),
    onSuccess: async () => {
      message.success("模型已切换，将在下一次 agent session 生效");
      setSelectedKey(null);
      await invalidate();
    },
    onError: (error: unknown) => {
      message.error(error instanceof Error ? error.message : "Request failed");
    },
  });
  const reset = useMutation({
    mutationFn: resetAgentModel,
    onSuccess: async () => {
      message.success("已恢复 config.toml 默认模型");
      setSelectedKey(null);
      await invalidate();
    },
    onError: (error: unknown) => {
      message.error(error instanceof Error ? error.message : "Request failed");
    },
  });
  const state = model.data;
  const current = state?.current;
  const defaultModel = state?.default;
  const selectedOption = state?.options.find((option) => optionKey(option) === selectedKey) ?? null;
  const switched = current !== undefined && defaultModel !== undefined
    && (current.provider !== defaultModel.provider || current.model !== defaultModel.model);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="热切换模型"
        description="只允许切换到 config.toml 已配置的 provider 和模型。切换立即生效于后续启动的 agent session（进行中的 Invocation 不受影响）；重启 serve 后恢复 config.toml 默认值。输出长度上限使用目标模型在 provider 中声明的 max_tokens。"
      />
      {queryState({ isPending: model.isPending, error: model.error })}
      {current === undefined ? null : (
        <Card title="当前生效模型">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Provider">{current.provider}</Descriptions.Item>
            <Descriptions.Item label="Model">{current.model}</Descriptions.Item>
            <Descriptions.Item label="名称">{current.name}</Descriptions.Item>
            <Descriptions.Item label="上下文窗口">{current.context_window.toLocaleString()} tokens</Descriptions.Item>
            <Descriptions.Item label="最大输出">{current.max_tokens.toLocaleString()} tokens</Descriptions.Item>
            <Descriptions.Item label="来源">
              {switched ? "运行时切换" : "config.toml 默认"}
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}
      {state === undefined ? null : (
        <Card title="切换模型">
          <Space wrap>
            <Select<string>
              style={{ minWidth: 320 }}
              placeholder="选择 provider 和模型"
              value={selectedKey}
              onChange={setSelectedKey}
              options={state.options.map((option) => ({
                value: optionKey(option),
                label: `${option.provider} / ${option.model}（${option.name}）`,
              }))}
              optionFilterProp="label"
              showSearch
            />
            <Button
              type="primary"
              disabled={selectedOption === null || apply.isPending}
              loading={apply.isPending}
              onClick={() => {
                if (selectedOption !== null) void apply.mutateAsync(selectedOption);
              }}
            >
              切换
            </Button>
            <Button disabled={reset.isPending || !switched} loading={reset.isPending} onClick={() => void reset.mutateAsync()}>
              恢复默认
            </Button>          </Space>
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            只有支持文本输入（input 包含 text）的模型可被选为 agent 模型。
          </Typography.Paragraph>
        </Card>
      )}
    </Space>
  );
}
