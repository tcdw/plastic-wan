import { Line } from "@ant-design/plots";
import type { UsagePoint } from "../api.ts";

const TOKEN_COLOR = "#1677ff";
const VISION_COLOR = "#52c41a";
const TOOL_COLOR = "#faad14";
const INVOCATION_COLOR = "#722ed1";

export function UsageChart({ data }: { readonly data: readonly UsagePoint[] }): React.ReactElement {
  const series = data.flatMap((point) => [
    { date: point.date, value: point.model_tokens, category: "Model tokens" },
    { date: point.date, value: point.vision_tokens, category: "Vision tokens" },
    { date: point.date, value: point.tool_calls, category: "Tool calls" },
    { date: point.date, value: point.agent_invocations, category: "Invocations" },
  ]);
  const config = {
    data: series,
    xField: "date",
    yField: "value",
    colorField: "category",
    color: [TOKEN_COLOR, VISION_COLOR, TOOL_COLOR, INVOCATION_COLOR],
    axis: { y: { labelFormatter: "~s" } },
    tooltip: { title: "date" },
    legend: { color: { position: "bottom" } },
    height: 240,
  };
  return <Line {...config} />;
}
