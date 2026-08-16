import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, Card, Descriptions, Input, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import type {
  AgentMessageEntry,
  ContextMessageEntry,
  InvocationListItem,
  ModelCallEntry,
  TelegramSendEntry,
  ToolCallEntry,
} from "../api.ts";
import { JsonBlock, queryState, StateTag, TextValue } from "../components.tsx";
import { formatCost, formatDuration, formatNumber, formatTime } from "../format.ts";
import { invocationQuery, invocationsQuery } from "../queries.ts";

const INVOCATION_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "aborted",
  "outcome_unknown",
  "skipped_budget",
];

export function InvocationsPage(): React.ReactElement {
  const [state, setState] = useState<string | undefined>(undefined);
  const [chat, setChat] = useState("");
  const query = useInfiniteQuery(invocationsQuery({ state, chat: chat.length === 0 ? undefined : chat }));
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Select
          allowClear
          placeholder="State"
          style={{ width: 200 }}
          value={state}
          onChange={(value) => setState(value)}
          options={INVOCATION_STATES.map((value) => ({ value, label: value }))}
        />
        <Input.Search
          allowClear
          placeholder="Telegram chat ID"
          style={{ width: 240 }}
          defaultValue={chat}
          onSearch={(value) => setChat(value.trim())}
        />
      </Space>
      {queryState({ isPending: query.isPending, error: query.error })}
      {query.isPending || query.error !== null ? null : (
        <>
          <Table<InvocationListItem>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={items}
            columns={[
              {
                title: "ID",
                dataIndex: "id",
                key: "id",
                render: (id: string) => <Link to="/invocations/$invocationId" params={{ invocationId: id }}>{id}</Link>,
              },
              {
                title: "State",
                dataIndex: "state",
                key: "state",
                render: (value: string) => <StateTag state={value} />,
              },
              {
                title: "Chat",
                key: "chat",
                render: (_: unknown, row) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{row.chat.title ?? row.chat.telegram_chat_id}</Typography.Text>
                    <Typography.Text type="secondary">
                      {row.chat.type}
                      {row.chat.message_thread_id === 0 ? "" : ` · topic ${row.chat.message_thread_id}`}
                    </Typography.Text>
                  </Space>
                ),
              },
              { title: "Turns", dataIndex: "turns_used", key: "turns_used", align: "right" },
              { title: "Tools", dataIndex: "tool_call_count", key: "tool_call_count", align: "right" },
              { title: "Sends", dataIndex: "sends_used", key: "sends_used", align: "right" },
              {
                title: "Tokens",
                dataIndex: "total_tokens",
                key: "total_tokens",
                align: "right",
                render: (value: number) => formatNumber(value),
              },
              {
                title: "Cost",
                dataIndex: "total_cost",
                key: "total_cost",
                align: "right",
                render: (value: number | null) => formatCost(value),
              },
              {
                title: "Side effect",
                dataIndex: "side_effect_started",
                key: "side_effect_started",
                render: (value: boolean) => (value ? <Tag color="volcano">started</Tag> : <Tag>none</Tag>),
              },
              {
                title: "Created",
                dataIndex: "created_at",
                key: "created_at",
                render: (value: string) => formatTime(value),
              },
            ]}
          />
          {query.hasNextPage ? (
            <Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Load more
            </Button>
          ) : null}
        </>
      )}
    </Space>
  );
}

export function InvocationDetailPage({ id }: { readonly id: string }): React.ReactElement {
  const { data, isPending, error } = useQuery(invocationQuery(id));
  const placeholder = queryState({ isPending: isPending || data === undefined, error });
  if (placeholder !== null) return placeholder;
  if (data === undefined) throw new Error("Invocation data is missing");
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title={`Invocation ${data.id}`}
        extra={<Link to="/invocations">Back to list</Link>}
        size="small"
      >
        <Descriptions
          size="small"
          column={3}
          items={[
            { key: "state", label: "State", children: <StateTag state={data.state} /> },
            { key: "reason", label: "Completion reason", children: <TextValue value={data.completion_reason} /> },
            { key: "error", label: "Error code", children: <TextValue value={data.error_code} /> },
            { key: "chat", label: "Chat", children: <TextValue value={data.chat.title ?? data.chat.telegram_chat_id} /> },
            { key: "chat_id", label: "Chat ID", children: <TextValue value={data.chat.telegram_chat_id} /> },
            { key: "topic", label: "Topic", children: String(data.chat.message_thread_id) },
            { key: "bucket", label: "Bucket", children: data.bucket_id },
            { key: "created", label: "Created", children: formatTime(data.created_at) },
            { key: "started", label: "Started", children: formatTime(data.started_at) },
            { key: "finished", label: "Finished", children: formatTime(data.finished_at) },
            { key: "tokens", label: "Tokens", children: formatNumber(data.total_tokens) },
            { key: "cost", label: "Cost", children: formatCost(data.total_cost) },
            { key: "config", label: "Config hash", children: <Typography.Text code copyable>{data.config_hash.slice(0, 16)}</Typography.Text> },
            { key: "prompt", label: "Prompt version", children: String(data.prompt_version) },
            { key: "registry", label: "Tool registry hash", children: <TextValue value={data.tool_registry_hash} /> },
          ]}
        />
      </Card>
      <Card size="small">
        <Tabs
          items={[
            {
              key: "tools",
              label: `Tool calls (${data.tool_calls.length})`,
              children: (
                <Table<ToolCallEntry>
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={[...data.tool_calls]}
                  expandable={{
                    expandedRowRender: (row) => (
                      <Space direction="vertical" style={{ width: "100%" }}>
                        <Typography.Text strong>Arguments</Typography.Text>
                        <JsonBlock value={row.arguments_json} />
                        <Typography.Text strong>Result</Typography.Text>
                        <JsonBlock value={row.result_text} />
                      </Space>
                    ),
                  }}
                  columns={[
                    { title: "Tool", dataIndex: "tool_name", key: "tool_name" },
                    { title: "Call ID", dataIndex: "tool_call_id", key: "tool_call_id" },
                    {
                      title: "State",
                      dataIndex: "state",
                      key: "state",
                      render: (value: string) => <StateTag state={value} />,
                    },
                    {
                      title: "Side effect",
                      dataIndex: "side_effect",
                      key: "side_effect",
                      render: (value: boolean) => (value ? <Tag color="volcano">yes</Tag> : <Tag>no</Tag>),
                    },
                    { title: "Error", dataIndex: "error_code", key: "error_code", render: (value: string | null) => <TextValue value={value} /> },
                    {
                      title: "Duration",
                      dataIndex: "duration_ms",
                      key: "duration_ms",
                      align: "right",
                      render: (value: number | null) => formatDuration(value),
                    },
                    { title: "Created", dataIndex: "created_at", key: "created_at", render: (value: string) => formatTime(value) },
                  ]}
                />
              ),
            },
            {
              key: "models",
              label: `Model calls (${data.model_calls.length})`,
              children: (
                <Table<ModelCallEntry>
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={[...data.model_calls]}
                  columns={[
                    { title: "Role", dataIndex: "role", key: "role" },
                    { title: "Provider", dataIndex: "provider", key: "provider" },
                    { title: "Model", dataIndex: "model", key: "model" },
                    { title: "Attempt", dataIndex: "attempt", key: "attempt", align: "right" },
                    {
                      title: "State",
                      dataIndex: "state",
                      key: "state",
                      render: (value: string) => <StateTag state={value} />,
                    },
                    { title: "Input", dataIndex: "input_tokens", key: "input_tokens", align: "right", render: (value: number | null) => formatNumber(value) },
                    { title: "Output", dataIndex: "output_tokens", key: "output_tokens", align: "right", render: (value: number | null) => formatNumber(value) },
                    { title: "Total", dataIndex: "total_tokens", key: "total_tokens", align: "right", render: (value: number | null) => formatNumber(value) },
                    { title: "Cost", dataIndex: "cost", key: "cost", align: "right", render: (value: number | null) => formatCost(value) },
                    { title: "Duration", dataIndex: "duration_ms", key: "duration_ms", align: "right", render: (value: number | null) => formatDuration(value) },
                    { title: "Error", dataIndex: "error_code", key: "error_code", render: (value: string | null) => <TextValue value={value} /> },
                  ]}
                />
              ),
            },
            {
              key: "sends",
              label: `Telegram sends (${data.telegram_sends.length})`,
              children: (
                <Table<TelegramSendEntry>
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={[...data.telegram_sends]}
                  expandable={{ expandedRowRender: (row) => <JsonBlock value={row.request_json} /> }}
                  columns={[
                    { title: "Kind", dataIndex: "kind", key: "kind" },
                    {
                      title: "State",
                      dataIndex: "state",
                      key: "state",
                      render: (value: string) => <StateTag state={value} />,
                    },
                    { title: "Telegram message", dataIndex: "telegram_message_id", key: "telegram_message_id", render: (value: string | null) => <TextValue value={value} /> },
                    { title: "Tool call", dataIndex: "tool_call_id", key: "tool_call_id" },
                    { title: "Error", dataIndex: "error_code", key: "error_code", render: (value: string | null) => <TextValue value={value} /> },
                    { title: "Created", dataIndex: "created_at", key: "created_at", render: (value: string) => formatTime(value) },
                  ]}
                />
              ),
            },
            {
              key: "agent",
              label: `Agent transcript (${data.agent_messages.length})`,
              children: (
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Typography.Text type="secondary">
                    Assistant text is private reasoning. Only the send tool publishes to Telegram.
                  </Typography.Text>
                  <Table<AgentMessageEntry>
                    rowKey="sequence_no"
                    size="small"
                    pagination={false}
                    dataSource={[...data.agent_messages]}
                    columns={[
                      { title: "#", dataIndex: "sequence_no", key: "sequence_no", width: 60 },
                      { title: "Role", dataIndex: "role", key: "role", width: 120 },
                      {
                        title: "Text",
                        dataIndex: "text",
                        key: "text",
                        render: (value: string) => <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>{value}</Typography.Paragraph>,
                      },
                      { title: "Created", dataIndex: "created_at", key: "created_at", width: 180, render: (value: string) => formatTime(value) },
                    ]}
                  />
                </Space>
              ),
            },
            {
              key: "context",
              label: `Frozen context (${data.context_messages.length})`,
              children: (
                <Table<ContextMessageEntry>
                  rowKey={(row) => `${row.section}-${row.sequence_no}`}
                  size="small"
                  pagination={false}
                  dataSource={[...data.context_messages]}
                  expandable={{ expandedRowRender: (row) => <JsonBlock value={row.snapshot_json} /> }}
                  columns={[
                    { title: "Section", dataIndex: "section", key: "section", render: (value: string) => <Tag color={value === "new" ? "blue" : "default"}>{value}</Tag> },
                    { title: "#", dataIndex: "sequence_no", key: "sequence_no", align: "right" },
                    {
                      title: "Message",
                      dataIndex: "message_id",
                      key: "message_id",
                      render: (value: string) => <Link to="/messages/$messageId" params={{ messageId: value }}>{value}</Link>,
                    },
                    { title: "Revision", dataIndex: "revision_id", key: "revision_id" },
                    { title: "Omitted before", dataIndex: "omitted_before", key: "omitted_before", align: "right" },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
