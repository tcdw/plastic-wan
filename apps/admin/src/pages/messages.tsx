import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, Card, Descriptions, Input, Space, Table, Tag, Typography } from "antd";
import type { MediaEntry, MessageListItem, RevisionEntry } from "../api.ts";
import { flatPages, JsonBlock, queryState, TextValue, useSearchFilter } from "../components.tsx";
import { formatNumber, formatTime } from "../format.ts";
import { messageQuery, messagesQuery } from "../queries.ts";

export function MessagesPage(): React.ReactElement {
  const search = useSearchFilter();
  const chat = useSearchFilter();
  const query = useInfiniteQuery(messagesQuery({ search: search.filter, chat: chat.filter }));
  const items = flatPages(query.data);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Input.Search
          allowClear
          placeholder="Search text or caption"
          style={{ width: 320 }}
          onSearch={(value) => search.set(value)}
        />
        <Input.Search
          allowClear
          placeholder="Telegram chat ID"
          style={{ width: 240 }}
          onSearch={(value) => chat.set(value)}
        />
      </Space>
      {queryState({ isPending: query.isPending, error: query.error })}
      {query.isPending || query.error !== null ? null : (
        <>
          <Table<MessageListItem>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={items}
            columns={[
              {
                title: "ID",
                dataIndex: "id",
                key: "id",
                render: (id: string) => <Link to="/messages/$messageId" params={{ messageId: id }}>{id}</Link>,
              },
              { title: "Telegram ID", dataIndex: "telegram_message_id", key: "telegram_message_id" },
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
              {
                title: "Sender",
                key: "sender",
                render: (_: unknown, row) =>
                  row.sender === null ? (
                    <Typography.Text type="secondary">{row.sent_by_bot ? "bot" : "—"}</Typography.Text>
                  ) : (
                    <Space size={4}>
                      <Typography.Text>{row.sender.display_name}</Typography.Text>
                      {row.sender.is_bot === true ? <Tag>bot</Tag> : null}
                    </Space>
                  ),
              },
              { title: "Kind", dataIndex: "kind", key: "kind", render: (value: string | null) => <TextValue value={value} /> },
              {
                title: "Text",
                key: "text",
                render: (_: unknown, row) => (
                  <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: 0, maxWidth: 420 }}>
                    {row.text ?? row.caption ?? "—"}
                  </Typography.Paragraph>
                ),
              },
              { title: "Revisions", dataIndex: "revision_count", key: "revision_count", align: "right" },
              { title: "Media", dataIndex: "media_count", key: "media_count", align: "right" },
              {
                title: "Received",
                dataIndex: "received_at",
                key: "received_at",
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

export function MessageDetailPage({ id }: { readonly id: string }): React.ReactElement {
  const { data, isPending, error } = useQuery(messageQuery(id));
  const placeholder = queryState({ isPending: isPending || data === undefined, error });
  if (placeholder !== null) return placeholder;
  if (data === undefined) throw new Error("Message data is missing");
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card title={`Message ${data.id}`} extra={<Link to="/messages">Back to list</Link>} size="small">
        <Descriptions
          size="small"
          column={3}
          items={[
            { key: "telegram", label: "Telegram message ID", children: data.telegram_message_id },
            { key: "chat", label: "Chat", children: <TextValue value={data.chat.title ?? data.chat.telegram_chat_id} /> },
            { key: "chat_id", label: "Chat ID", children: data.chat.telegram_chat_id },
            { key: "type", label: "Chat type", children: data.chat.type },
            { key: "topic", label: "Topic", children: String(data.chat.message_thread_id) },
            { key: "visible", label: "Visible", children: data.visible ? "yes" : "no" },
            { key: "bot", label: "Sent by bot", children: data.sent_by_bot ? "yes" : "no" },
            { key: "date", label: "Telegram date", children: formatTime(data.telegram_date) },
            { key: "received", label: "Received", children: formatTime(data.received_at) },
          ]}
        />
      </Card>
      <Card title={`Revisions (${data.revisions.length})`} size="small">
        <Table<RevisionEntry>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={[...data.revisions]}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Typography.Text strong>Reply snapshot</Typography.Text>
                <JsonBlock value={row.reply_snapshot_json} />
                <Typography.Text strong>Forward origin</Typography.Text>
                <JsonBlock value={row.forward_origin_json} />
                <Typography.Text strong>Service payload</Typography.Text>
                <JsonBlock value={row.service_json} />
              </Space>
            ),
          }}
          columns={[
            { title: "#", dataIndex: "revision_no", key: "revision_no", width: 60 },
            { title: "Kind", dataIndex: "kind", key: "kind" },
            {
              title: "Sender",
              key: "sender",
              render: (_: unknown, row) => <TextValue value={row.sender?.display_name ?? null} />,
            },
            {
              title: "Text",
              key: "text",
              render: (_: unknown, row) => (
                <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                  {row.text ?? row.caption ?? "—"}
                </Typography.Paragraph>
              ),
            },
            {
              title: "Reply to",
              dataIndex: "reply_to_message_id",
              key: "reply_to_message_id",
              render: (value: string | null) => <TextValue value={value} />,
            },
            { title: "Created", dataIndex: "created_at", key: "created_at", render: (value: string) => formatTime(value) },
          ]}
        />
      </Card>
      <Card title={`Media (${data.media.length})`} size="small">
        <Table<MediaEntry>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={[...data.media]}
          columns={[
            { title: "Kind", dataIndex: "kind", key: "kind" },
            { title: "File unique ID", dataIndex: "file_unique_id", key: "file_unique_id" },
            { title: "MIME", dataIndex: "mime_type", key: "mime_type", render: (value: string | null) => <TextValue value={value} /> },
            {
              title: "Size",
              dataIndex: "file_size",
              key: "file_size",
              align: "right",
              render: (value: number | null) => formatNumber(value),
            },
            {
              title: "Dimensions",
              key: "dimensions",
              render: (_: unknown, row) => (row.width === null || row.height === null ? "—" : `${row.width}×${row.height}`),
            },
            {
              title: "Media analysis",
              key: "analysis",
              render: (_: unknown, row) => <TextValue value={row.analysis_description ?? row.analysis_state} />,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
