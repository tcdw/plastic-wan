import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, Card, Collapse, Descriptions, Input, Select, Space, Table, Tabs, Tag, Timeline, Typography } from "antd";
import type {
  AgentMessageEntry,
  ContextMessageEntry,
  InvocationDetail,
  InvocationListItem,
  ModelCallEntry,
  TelegramSendEntry,
  ToolCallEntry,
  ToolRegistryEntry,
} from "../api.ts";
import { flatPages, JsonBlock, queryState, StateTag, TextValue, useSearchFilter } from "../components.tsx";
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

interface SessionTimelineEvent {
  readonly at: string;
  readonly order: number;
  readonly color: string;
  readonly content: React.ReactNode;
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : null;
  } catch {
    return null;
  }
}

function stringField(value: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function objectField(
  value: Readonly<Record<string, unknown>> | null,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const field = value?.[key];
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? field as Readonly<Record<string, unknown>>
    : null;
}

function ToolTimelineCard({
  tool,
  send,
}: {
  readonly tool: ToolCallEntry;
  readonly send: TelegramSendEntry | undefined;
}): React.ReactElement {
  const argumentsValue = parseJsonObject(tool.arguments_json);
  const sendKind = stringField(argumentsValue, "kind") ?? send?.kind ?? null;
  const sendText = stringField(argumentsValue, "text");
  const stickerRef = stringField(argumentsValue, "sticker_ref");
  const replyTo = stringField(argumentsValue, "reply_to_message_id");
  const sendContent = sendKind === "text"
    ? sendText
    : sendKind === "sticker" && stickerRef !== null
      ? `Sticker ${stickerRef}`
      : null;
  return (
    <Card
      size="small"
      title={(
        <Space size="small" wrap>
          <Tag color={tool.tool_name === "send" ? "green" : "cyan"}>{tool.tool_name}</Tag>
          <Typography.Text code>{tool.tool_call_id}</Typography.Text>
        </Space>
      )}
      extra={(
        <Space size="small" wrap>
          <StateTag state={tool.state} />
          <Typography.Text type="secondary">{formatTime(tool.created_at)}</Typography.Text>
        </Space>
      )}
    >
      <Space direction="vertical" size="small" style={{ width: "100%" }}>
        {tool.tool_name !== "send" ? null : (
          <>
            {sendContent === null ? (
              <Typography.Text type="secondary">No send content recorded</Typography.Text>
            ) : (
              <Typography.Paragraph
                copyable={sendKind === "text"}
                style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
              >
                {sendContent}
              </Typography.Paragraph>
            )}
            <Space size="small" wrap>
              {replyTo === null ? null : (
                <Typography.Text type="secondary">Reply to Telegram message {replyTo}</Typography.Text>
              )}
              {send === undefined ? null : (
                <>
                  <Typography.Text type="secondary">Telegram delivery</Typography.Text>
                  <StateTag state={send.state} />
                  {send.telegram_message_id === null ? null : (
                    <Typography.Text type="secondary">
                      Message {send.telegram_message_id}
                    </Typography.Text>
                  )}
                </>
              )}
            </Space>
          </>
        )}
        <Space size="middle" wrap>
          <Typography.Text type="secondary">Duration {formatDuration(tool.duration_ms)}</Typography.Text>
          {tool.error_code === null ? null : (
            <Typography.Text type="danger">Error {tool.error_code}</Typography.Text>
          )}
        </Space>
        <Collapse
          size="small"
          items={[
            {
              key: "details",
              label: "Arguments and result",
              children: (
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Typography.Text strong>Arguments</Typography.Text>
                  <JsonBlock value={tool.arguments_json} />
                  <Typography.Text strong>Result</Typography.Text>
                  <JsonBlock value={tool.result_text} />
                </Space>
              ),
            },
          ]}
        />
      </Space>
    </Card>
  );
}

function ContextTimelineCard({
  message,
}: {
  readonly message: ContextMessageEntry;
}): React.ReactElement {
  const snapshot = parseJsonObject(message.snapshot_json);
  const sender = objectField(snapshot, "sender");
  const username = stringField(sender, "username");
  const senderName = stringField(sender, "name") ?? (username === null ? "Unknown sender" : `@${username}`);
  const telegramMessageId = stringField(snapshot, "message_id");
  const kind = stringField(snapshot, "kind") ?? "message";
  const text = stringField(snapshot, "text") ?? stringField(snapshot, "caption");
  const media = snapshot?.["media"];
  const mediaCount = Array.isArray(media) ? media.length : 0;
  const sentByBot = snapshot?.["sent_by_bot"] === true;
  return (
    <Card
      size="small"
      title={(
        <Space size="small" wrap>
          <Tag color={message.section === "new" ? "blue" : "default"}>
            {message.section === "new" ? "Incoming message" : "Context history"}
          </Tag>
          <Typography.Text strong>{senderName}</Typography.Text>
          {username === null || senderName === `@${username}` ? null : (
            <Typography.Text type="secondary">@{username}</Typography.Text>
          )}
          {sentByBot ? <Tag>bot</Tag> : null}
        </Space>
      )}
      extra={<Typography.Text type="secondary">{formatTime(stringField(snapshot, "telegram_date"))}</Typography.Text>}
    >
      <Space direction="vertical" size="small" style={{ width: "100%" }}>
        {text === null ? (
          <Typography.Text type="secondary">
            {kind}{mediaCount === 0 ? "" : ` · ${mediaCount} media`}
          </Typography.Text>
        ) : (
          <Typography.Paragraph
            copyable
            style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            {text}
          </Typography.Paragraph>
        )}
        <Space size="small" wrap>
          <Typography.Text type="secondary">
            {telegramMessageId === null ? kind : `Telegram message ${telegramMessageId} · ${kind}`}
          </Typography.Text>
          <Link to="/messages/$messageId" params={{ messageId: message.message_id }}>
            Open message record
          </Link>
        </Space>
      </Space>
    </Card>
  );
}

function AgentTimelineCard({ message }: { readonly message: AgentMessageEntry }): React.ReactElement {
  const isToolResult = message.role === "tool_result";
  const meta = ({
    assistant: { label: "Assistant private text", color: "gold", note: "Not published to Telegram" },
    tool_result: { label: "Tool result", color: "purple", note: null },
    harness_nudge: { label: "Harness nudge", color: "cyan", note: "Reminder to use send" },
  } as const)[message.role] ?? { label: message.role, color: "default" as const, note: null };
  return (
    <Card
      size="small"
      title={(
        <Space size="small" wrap>
          <Tag color={meta.color}>
            {meta.label}
          </Tag>
          {meta.note !== null ? (
            <Typography.Text type="secondary">{meta.note}</Typography.Text>
          ) : null}
        </Space>
      )}
      extra={<Typography.Text type="secondary">{formatTime(message.created_at)}</Typography.Text>}
    >
      {message.text.length === 0 ? (
        <Typography.Text type="secondary">No text content</Typography.Text>
      ) : isToolResult ? (
        <Collapse
          size="small"
          items={[
            {
              key: "result",
              label: "View tool result passed to the agent",
              children: (
                <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {message.text}
                </Typography.Paragraph>
              ),
            },
          ]}
        />
      ) : (
        <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {message.text}
        </Typography.Paragraph>
      )}
    </Card>
  );
}

function ModelTimelineCard({ model }: { readonly model: ModelCallEntry }): React.ReactElement {
  return (
    <Card
      size="small"
      title={(
        <Space size="small" wrap>
          <Tag color="geekblue">Model call</Tag>
          <Typography.Text strong>{model.provider}/{model.model}</Typography.Text>
        </Space>
      )}
      extra={(
        <Space size="small" wrap>
          <StateTag state={model.state} />
          <Typography.Text type="secondary">{formatTime(model.created_at)}</Typography.Text>
        </Space>
      )}
    >
      <Space size="middle" wrap>
        <Typography.Text type="secondary">Attempt {model.attempt}</Typography.Text>
        <Typography.Text type="secondary">Tokens {formatNumber(model.total_tokens)}</Typography.Text>
        <Typography.Text type="secondary">Cost {formatCost(model.cost)}</Typography.Text>
        <Typography.Text type="secondary">Duration {formatDuration(model.duration_ms)}</Typography.Text>
        {model.error_code === null ? null : (
          <Typography.Text type="danger">Error {model.error_code}</Typography.Text>
        )}
      </Space>
    </Card>
  );
}

function SessionOverview({ invocation }: { readonly invocation: InvocationDetail }): React.ReactElement {
  const events: SessionTimelineEvent[] = [
    {
      at: invocation.created_at,
      order: -3_000,
      color: "blue",
      content: (
        <Card size="small">
          <Space size="small" wrap>
            <Typography.Text strong>Invocation queued</Typography.Text>
            <Typography.Text type="secondary">{formatTime(invocation.created_at)}</Typography.Text>
          </Space>
        </Card>
      ),
    },
  ];
  if (invocation.started_at !== null) {
    events.push({
      at: invocation.started_at,
      order: -2_000,
      color: "green",
      content: (
        <Card size="small">
          <Space size="small" wrap>
            <Typography.Text strong>Agent session started</Typography.Text>
            <Typography.Text type="secondary">{formatTime(invocation.started_at)}</Typography.Text>
          </Space>
        </Card>
      ),
    });
  }
  invocation.context_messages.forEach((message) => {
    const snapshot = parseJsonObject(message.snapshot_json);
    events.push({
      at: stringField(snapshot, "telegram_date") ?? invocation.created_at,
      order: -10_000 + message.sequence_no,
      color: message.section === "new" ? "blue" : "gray",
      content: <ContextTimelineCard message={message} />,
    });
  });
  invocation.model_calls.forEach((model, index) => {
    events.push({
      at: model.created_at,
      order: index * 10,
      color: "geekblue",
      content: <ModelTimelineCard model={model} />,
    });
  });
  const sendsByToolCall = new Map(invocation.telegram_sends.map((send) => [send.tool_call_id, send]));
  invocation.tool_calls.forEach((tool, index) => {
    events.push({
      at: tool.created_at,
      order: index * 10 + 2,
      color: tool.tool_name === "send" ? "green" : "cyan",
      content: <ToolTimelineCard tool={tool} send={sendsByToolCall.get(tool.tool_call_id)} />,
    });
  });
  invocation.agent_messages.forEach((message) => {
    events.push({
      at: message.created_at,
      order: message.sequence_no * 10 + 4,
      color: message.role === "assistant" ? "gold" : message.role === "harness_nudge" ? "cyan" : "purple",
      content: <AgentTimelineCard message={message} />,
    });
  });
  if (invocation.finished_at !== null) {
    const failed = invocation.state === "failed" || invocation.state === "aborted" || invocation.state === "outcome_unknown";
    events.push({
      at: invocation.finished_at,
      order: 10_000,
      color: failed ? "red" : "green",
      content: (
        <Card size="small">
          <Space size="small" wrap>
            <Typography.Text strong>Agent session finished</Typography.Text>
            <StateTag state={invocation.state} />
            <TextValue value={invocation.completion_reason} />
            <Typography.Text type="secondary">{formatTime(invocation.finished_at)}</Typography.Text>
          </Space>
        </Card>
      ),
    });
  }
  events.sort((left, right) => {
    const time = Date.parse(left.at) - Date.parse(right.at);
    return time === 0 ? left.order - right.order : time;
  });
  return (
    <Timeline
      items={events.map((event) => ({
        color: event.color,
        children: event.content,
      }))}
    />
  );
}

export function InvocationsPage(): React.ReactElement {
  const [state, setState] = useState<string | undefined>(undefined);
  const chat = useSearchFilter();
  const query = useInfiniteQuery(invocationsQuery({ state, chat: chat.filter }));
  const items = flatPages(query.data);
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
          defaultValue={chat.filter}
          onSearch={(value) => chat.set(value)}
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
      <Collapse
        size="small"
        items={[
          {
            key: "tool-registry",
            label: (
              <Space>
                Tool registry
                <Typography.Text type="secondary">Snapshot of the tools presented to the model</Typography.Text>
              </Space>
            ),
            children: data.tool_registry === null || data.tool_registry.length === 0 ? (
              <Typography.Text type="secondary">No registry snapshot recorded.</Typography.Text>
            ) : (
              <Table<ToolRegistryEntry>
                rowKey="name"
                size="small"
                pagination={false}
                dataSource={[...data.tool_registry]}
                columns={[
                  { title: "Name", dataIndex: "name", key: "name", render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
                  { title: "Label", dataIndex: "label", key: "label" },
                  {
                    title: "Description (as sent to the model)",
                    dataIndex: "description",
                    key: "description",
                    render: (value: string) => (
                      <Typography.Paragraph ellipsis={{ rows: 3 }} style={{ margin: 0, maxWidth: 640 }}>
                        {value}
                      </Typography.Paragraph>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
      <Card size="small">
        <Tabs
          items={[
            {
              key: "overview",
              label: "Overview",
              children: <SessionOverview invocation={data} />,
            },
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
                      title: "Tools in request",
                      key: "tools",
                      render: (_: unknown, row) =>
                        row.tools === null ? (
                          <Typography.Text type="secondary">—</Typography.Text>
                        ) : (
                          <Space size={4} wrap>
                            {row.tools.map((name) => (
                              <Tag key={name}>{name}</Tag>
                            ))}
                          </Space>
                        ),
                    },
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
