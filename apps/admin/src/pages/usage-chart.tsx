import { Line } from "@ant-design/plots";
import { Col, Row, Typography } from "antd";
import type { UsagePoint } from "../api.ts";

const TOKEN_COLOR = "#1677ff";
const VISION_COLOR = "#52c41a";
const TOOL_COLOR = "#faad14";
const INVOCATION_COLOR = "#722ed1";

interface ChartPoint {
  readonly date: string;
  readonly value: number;
  readonly category: string;
}

function SeriesChart({
  title,
  points,
  colors,
  height,
}: {
  readonly title: string;
  readonly points: readonly ChartPoint[];
  readonly colors: readonly string[];
  readonly height: number;
}): React.ReactElement {
  const config = {
    data: points,
    xField: "date",
    yField: "value",
    colorField: "category",
    scale: { color: { range: colors } },
    axis: { y: { labelFormatter: "~s" } },
    tooltip: { title: "date" },
    legend: { color: { position: "bottom" } },
    height,
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Typography.Text strong>{title}</Typography.Text>
      <Line {...config} />
    </div>
  );
}

export function UsageChart({ data }: { readonly data: readonly UsagePoint[] }): React.ReactElement {
  return (
    <Row gutter={16}>
      <Col xs={24} md={12} xl={8}>
        <SeriesChart
          title="Tokens"
          height={240}
          colors={[TOKEN_COLOR, VISION_COLOR]}
          points={data.flatMap((point) => [
            { date: point.date, value: point.model_tokens, category: "Model tokens" },
            { date: point.date, value: point.vision_tokens, category: "Vision tokens" },
          ])}
        />
      </Col>
      <Col xs={24} md={12} xl={8}>
        <SeriesChart
          title="Invocations"
          height={240}
          colors={[INVOCATION_COLOR]}
          points={data.map((point) => ({
            date: point.date,
            value: point.agent_invocations,
            category: "Invocations",
          }))}
        />
      </Col>
      <Col xs={24} md={12} xl={8}>
        <SeriesChart
          title="Tool calls"
          height={240}
          colors={[TOOL_COLOR]}
          points={data.map((point) => ({
            date: point.date,
            value: point.tool_calls,
            category: "Tool calls",
          }))}
        />
      </Col>
    </Row>
  );
}
