import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, Card, Descriptions, Empty, Input, Space, Table, Tag, Typography } from "antd";
import type {
  ConversationContextListItem,
  ConversationContextMessageEntry,
  ConversationContextRefEntry,
} from "../api.ts";
import { flatPages, JsonBlock, queryState, TextValue, useSearchFilter } from "../components.tsx";
import { formatNumber, formatTime } from "../format.ts";
import { conversationContextQuery, conversationContextsQuery } from "../queries.ts";

export function ContextsPage(): React.ReactElement {
  const search = useSearchFilter();
  const chat = useSearchFilter();
  const conversation = useSearchFilter();
  const query = useInfiniteQuery(
    conversationContextsQuery({ search: search.filter, chat: chat.filter, conversation: conversation.filter }),
  );
  const items = flatPages(query.data);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        Conversation contexts
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Read-only view of the persistent agent transcript kept for each chat and forum topic.
      </Typography.Paragraph>
      <Space wrap>
        <Input.Search
          allowClear
          placeholder="Chat title or username"
          style={{ width: 260 }}
          onSearch={(value) => search.set(value)}
        />
        <Input.Search
          allowClear
          placeholder="Telegram chat ID"
          style={{ width: 220 }}
          onSearch={(value) => chat.set(value)}
        />
        <Input.Search
          allowClear
          placeholder="Conversation ID"
          style={{ width: 200 }}
          onSearch={(value) => conversation.set(value)}
        />
      </Space>
      {queryState({ isPending: query.isPending, error: query.error })}
      {query.isPending || query.error !== null ? null : items.length === 0 ? (
        <Empty description="No conversation contexts match these filters." />
      ) : (
        <>
          <Table<ConversationContextListItem>
            rowKey="conversation_id"
            size="small"
            pagination={false}
            dataSource={items}
            scroll={{ x: 1080 }}
            columns={[
              {
                title: "Chat/Topic",
                key: "chat",
                render: (_: unknown, row) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{row.chat_title ?? row.telegram_chat_id}</Typography.Text>
                    <Typography.Text type="secondary">
                      {row.chat_type}
                      {row.message_thread_id === 0 ? "" : ` · topic ${row.message_thread_id}`}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: "Conversation",
                key: "conversation",
                render: (_: unknown, row) => (
                  <Link to="/contexts/$conversationId" params={{ conversationId: row.conversation_id }}>
                    {row.conversation_id}
                  </Link>
                ),
              },
              {
                title: "Seq window",
                key: "window",
                render: (_: unknown, row) => (
                  <Typography.Text code>
                    {row.head_seq}–{row.next_seq}
                  </Typography.Text>
                ),
              },
              {
                title: "Messages",
                dataIndex: "message_count",
                key: "message_count",
                align: "right",
                render: (value: number) => formatNumber(value),
              },
              {
                title: "Sends",
                dataIndex: "send_count_total",
                key: "send_count_total",
                align: "right",
                render: (value: number) => formatNumber(value),
              },
              {
                title: "Last active",
                dataIndex: "last_active_at",
                key: "last_active_at",
                render: (value: string) => formatTime(value),
              },
              {
                title: "Last GC",
                dataIndex: "last_gc_at",
                key: "last_gc_at",
                render: (value: string | null) => formatTime(value),
              },
              {
                title: "Active session",
                key: "active_invocation",
                render: (_: unknown, row) =>
                  row.active_invocation_id === null ? (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ) : (
                    <Link to="/invocations/$invocationId" params={{ invocationId: row.active_invocation_id }}>
                      Tool session {row.active_invocation_id}
                    </Link>
                  ),
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

export function ContextDetailPage({ id }: { readonly id: string }): React.ReactElement {
  const { data, isPending, error } = useQuery(conversationContextQuery(id));
  const placeholder = queryState({ isPending: isPending || data === undefined, error });
  if (placeholder !== null) return placeholder;
  if (data === undefined) throw new Error("Conversation context data is missing");
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title={`Conversation context ${data.conversation_id}`}
        extra={<Link to="/contexts">Back to list</Link>}
        size="small"
      >
        <Descriptions
          size="small"
          column={3}
          items={[
            { key: "conversation", label: "Conversation ID", children: data.conversation_id },
            { key: "chat", label: "Chat", children: <TextValue value={data.chat_title ?? data.telegram_chat_id} /> },
            { key: "chat_id", label: "Chat ID", children: data.telegram_chat_id },
            { key: "type", label: "Chat type", children: data.chat_type },
            { key: "topic", label: "Topic", children: String(data.message_thread_id) },
            { key: "sends", label: "Sends (total)", children: formatNumber(data.send_count_total) },
            { key: "head", label: "Head seq", children: formatNumber(data.head_seq) },
            { key: "next", label: "Next seq", children: formatNumber(data.next_seq) },
            { key: "count", label: "Retained messages", children: formatNumber(data.message_count) },
            { key: "active", label: "Last active", children: formatTime(data.last_active_at) },
            { key: "gc", label: "Last GC", children: formatTime(data.last_gc_at) },
            {
              key: "invocation",
              label: "Active session",
              children:
                data.active_invocation_id === null ? (
                  <Typography.Text type="secondary">—</Typography.Text>
                ) : (
                  <Link to="/invocations/$invocationId" params={{ invocationId: data.active_invocation_id }}>
                    Tool session {data.active_invocation_id}
                  </Link>
                ),
            },
            { key: "hash", label: "System prompt hash", children: <Typography.Text code>{data.system_prompt_hash}</Typography.Text> },
            { key: "created", label: "Created", children: formatTime(data.created_at) },
            { key: "updated", label: "Updated", children: formatTime(data.updated_at) },
          ]}
        />
      </Card>
      <Card title={`Retained messages (${data.messages.length})`} size="small">
        {data.messages.length === 0 ? (
          <Empty description="No retained messages." />
        ) : (
          <Table<ConversationContextMessageEntry>
            rowKey="seq"
            size="small"
            pagination={false}
            dataSource={[...data.messages]}
            scroll={{ x: 880 }}
            expandable={{
              expandedRowRender: (row) => (
                <Space direction="vertical" size="small" style={{ width: "100%" }}>
                  <Typography.Text strong>Payload preview</Typography.Text>
                  <JsonBlock value={row.payload_preview} />
                  {row.payload_truncated ? (
                    <Typography.Text type="secondary">
                      Preview truncated; the stored payload is longer.
                    </Typography.Text>
                  ) : null}
                </Space>
              ),
            }}
            columns={[
              { title: "Seq", dataIndex: "seq", key: "seq", width: 70, align: "right" },
              { title: "Role", dataIndex: "role", key: "role", render: (value: string) => <Tag>{value}</Tag> },
              {
                title: "Checkpoint",
                key: "checkpoint",
                render: (_: unknown, row) => (row.is_checkpoint ? <Tag color="purple">checkpoint</Tag> : "—"),
              },
              {
                title: "Send seq",
                key: "send_seq",
                align: "right",
                render: (_: unknown, row) => (row.send_seq === null ? "—" : formatNumber(row.send_seq)),
              },
              {
                title: "Est. tokens",
                dataIndex: "est_tokens",
                key: "est_tokens",
                align: "right",
                render: (value: number) => formatNumber(value),
              },
              {
                title: "Session",
                key: "invocation",
                render: (_: unknown, row) =>
                  row.invocation_id === null ? (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ) : (
                    <Link to="/invocations/$invocationId" params={{ invocationId: row.invocation_id }}>
                      {row.invocation_id}
                    </Link>
                  ),
              },
              {
                title: "Evicted",
                dataIndex: "evicted_at",
                key: "evicted_at",
                render: (value: string | null) => formatTime(value),
              },
              {
                title: "Created",
                dataIndex: "created_at",
                key: "created_at",
                render: (value: string) => formatTime(value),
              },
            ]}
          />
        )}
      </Card>
      <Card title={`Capability refs (${data.refs.length})`} size="small">
        {data.refs.length === 0 ? (
          <Empty description="No live capability refs." />
        ) : (
          <Table<ConversationContextRefEntry>
            rowKey="ref"
            size="small"
            pagination={false}
            dataSource={[...data.refs]}
            columns={[
              { title: "Ref", dataIndex: "ref", key: "ref", render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
              { title: "Kind", dataIndex: "kind", key: "kind", render: (value: string) => <Tag>{value}</Tag> },
              { title: "Source seq", dataIndex: "source_seq", key: "source_seq", align: "right" },
              {
                title: "Expires",
                dataIndex: "expires_at",
                key: "expires_at",
                render: (value: string) => formatTime(value),
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
}
