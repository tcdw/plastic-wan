import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Col,
  Descriptions,
  message,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { CancelPendingResult, LabelCount, UsageEntry } from "../api.ts";
import { cancelPendingSessions } from "../api.ts";
import { queryState, StateTag } from "../components.tsx";
import { formatNumber, formatTime } from "../format.ts";
import { overviewQuery, usageQuery } from "../queries.ts";
import { UsageChart } from "./usage-chart.tsx";

const COUNT_COLUMNS = [
  {
    title: "State",
    dataIndex: "label",
    key: "label",
    render: (label: string) => <StateTag state={label} />,
  },
  {
    title: "Count",
    dataIndex: "count",
    key: "count",
    align: "right" as const,
    render: (count: number) => formatNumber(count),
  },
];

const TOOL_COLUMNS = [
  { title: "Tool", dataIndex: "label", key: "label" },
  {
    title: "Calls",
    dataIndex: "count",
    key: "count",
    align: "right" as const,
    render: (count: number) => formatNumber(count),
  },
];

const USAGE_COLUMNS = [
  { title: "Resource", dataIndex: "resource", key: "resource" },
  { title: "Metric", dataIndex: "metric", key: "metric" },
  { title: "Scope", dataIndex: "scope", key: "scope" },
  {
    title: "Amount",
    dataIndex: "amount",
    key: "amount",
    align: "right" as const,
    render: (amount: number) => formatNumber(amount),
  },
];

export function OverviewPage(): React.ReactNode {
  const [days, setDays] = useState(7);
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery(overviewQuery);
  const { data: usage, isPending: usagePending } = useQuery({ ...usageQuery(days), enabled: data !== undefined });
  const { mutate, isPending: isCanceling } = useMutation<CancelPendingResult, Error, void>({
    mutationFn: cancelPendingSessions,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["invocations"] });
      message.success(
        `Canceled ${formatNumber(result.canceled_buckets)} buckets / ${formatNumber(result.canceled_invocations)} invocations`,
      );
    },
    onError: (err) => {
      message.error(err instanceof Error ? err.message : "Cancel failed");
    },
  });
  const placeholder = queryState({ isPending: isPending || data === undefined, error });
  if (data === undefined || placeholder !== null) return placeholder;
  const totalInvocations = data.invocation_states.reduce((sum, entry) => sum + entry.count, 0);
  const queuedInvocations = data.invocation_states.find((entry) => entry.label === "queued")?.count ?? 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Row gutter={16}>
        <Col span={8}>
          <Card>
            <Statistic title="Invocations" value={totalInvocations} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="Stored messages" value={data.message_count} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="Cached media analyses" value={data.cached_analysis_count} />
          </Card>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col span={8}>
          <Card title="Operations" size="small">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <Statistic title="Queued invocations" value={queuedInvocations} valueStyle={{ fontSize: 24 }} />
              <Popconfirm
                title="Cancel all pending sessions?"
                description="This will expire collecting/queued buckets and abort queued invocations."
                onConfirm={() => mutate()}
                okText="Cancel"
                okButtonProps={{ danger: true, loading: isCanceling }}
              >
                <Button danger type="primary" loading={isCanceling}>
                  Cancel pending
                </Button>
              </Popconfirm>
            </div>
          </Card>
        </Col>
        <Col span={16}>
          <Card title="Bot status" size="small">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="Sleep">
                <Space size="small" wrap>
                  <Tag color={data.runtime_status.sleeping ? "purple" : "green"}>
                    {data.runtime_status.sleeping ? "sleeping" : "awake"}
                  </Tag>
                  {data.runtime_status.sleep_until === null ? null : (
                    <Typography.Text type="secondary">
                      until {formatTime(data.runtime_status.sleep_until)}
                    </Typography.Text>
                  )}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="Administrator pauses">
                {data.runtime_status.paused_chats.length === 0 ? (
                  <Tag color="green">none</Tag>
                ) : (
                  <Space size={[4, 4]} wrap>
                    {data.runtime_status.paused_chats.map((chat) => (
                      <Tag color="orange" key={chat.telegram_chat_id}>
                        {chat.title ?? (chat.username === null ? chat.telegram_chat_id : `@${chat.username}`)}
                        {" · since "}
                        {formatTime(chat.paused_at)}
                      </Tag>
                    ))}
                  </Space>
                )}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col span={8}>
          <Card title="Invocation states" size="small">
            <Table<LabelCount>
              rowKey="label"
              size="small"
              pagination={false}
              columns={COUNT_COLUMNS}
              dataSource={[...data.invocation_states]}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card title="Configured sticker index states" size="small">
            <Table<LabelCount>
              rowKey="label"
              size="small"
              pagination={false}
              columns={COUNT_COLUMNS}
              dataSource={[...data.sticker_index_states]}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card title="Top tools" size="small">
            <Table<LabelCount>
              rowKey="label"
              size="small"
              pagination={false}
              columns={TOOL_COLUMNS}
              dataSource={[...data.top_tools]}
            />
          </Card>
        </Col>
      </Row>
      <Card
        title="Daily usage"
        size="small"
        extra={
          <Tabs
            size="small"
            activeKey={String(days)}
            onChange={(key) => setDays(Number(key))}
            items={[
              { key: "7", label: "7d" },
              { key: "30", label: "30d" },
            ]}
          />
        }
      >
        {usagePending ? (
          <div style={{ height: 280 }} />
        ) : usage !== undefined ? (
          <UsageChart data={usage.series} />
        ) : (
          <Typography.Text type="secondary">No usage data</Typography.Text>
        )}
      </Card>
      <Card title="Today's budget usage (UTC)" size="small">
        <Table<UsageEntry>
          rowKey={(row) => `${row.resource}|${row.metric}|${row.scope}`}
          size="small"
          pagination={false}
          columns={USAGE_COLUMNS}
          dataSource={[...data.daily_usage]}
        />
      </Card>
      <Typography.Text type="secondary">Generated at {formatTime(data.generated_at)}</Typography.Text>
    </div>
  );
}
