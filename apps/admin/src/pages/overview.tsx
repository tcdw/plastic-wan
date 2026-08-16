import { useQuery } from "@tanstack/react-query";
import { Card, Col, Row, Statistic, Table, Typography } from "antd";
import type { LabelCount, UsageEntry } from "../api.ts";
import { queryState, StateTag } from "../components.tsx";
import { formatNumber, formatTime } from "../format.ts";
import { overviewQuery } from "../queries.ts";

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

export function OverviewPage(): React.ReactElement {
  const { data, isPending, error } = useQuery(overviewQuery);
  const placeholder = queryState({ isPending: isPending || data === undefined, error });
  if (placeholder !== null) return placeholder;
  if (data === undefined) throw new Error("Overview data is missing");
  const totalInvocations = data.invocation_states.reduce((sum, entry) => sum + entry.count, 0);
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
            <Statistic title="Cached vision analyses" value={data.cached_analysis_count} />
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
          <Card title="Sticker index states" size="small">
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
