import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { App as AntApp, Button, Empty, Input, Popconfirm, Select, Space, Table, Typography } from "antd";
import { cancelAlarm, type AlarmListItem } from "../api.ts";
import { flatPages, queryState, StateTag } from "../components.tsx";
import { formatTime } from "../format.ts";
import { alarmsQuery } from "../queries.ts";

const ALARM_STATES = ["pending", "firing", "fired", "cancelled"];

export function AlarmsPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [state, setState] = useState<string | undefined>(undefined);
  const [chatDraft, setChatDraft] = useState("");
  const [targetDraft, setTargetDraft] = useState("");
  const [chat, setChat] = useState<string | undefined>(undefined);
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const query = useInfiniteQuery(alarmsQuery({ state, chat, target }));
  const items = flatPages(query.data);

  const applyFilters = (): void => {
    setChat(chatDraft.trim().length === 0 ? undefined : chatDraft.trim());
    setTarget(targetDraft.trim().length === 0 ? undefined : targetDraft.trim());
  };

  const resetFilters = (): void => {
    setState(undefined);
    setChatDraft("");
    setTargetDraft("");
    setChat(undefined);
    setTarget(undefined);
  };

  const remove = useMutation({
    mutationFn: cancelAlarm,
    onSuccess: async () => {
      message.success("Alarm cancelled");
      setCancellingId(null);
      await queryClient.invalidateQueries({ queryKey: ["alarms"] });
    },
    onError: async (error: unknown) => {
      setCancellingId(null);
      message.error(error instanceof Error ? error.message : "Request failed");
      await queryClient.invalidateQueries({ queryKey: ["alarms"] });
    },
  });

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        Alarms
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Audit scheduled follow-ups and cancel pending alarms.
      </Typography.Paragraph>
      <Space wrap>
        <Select
          allowClear
          placeholder="State"
          style={{ width: 180 }}
          value={state}
          onChange={(value) => setState(value)}
          options={ALARM_STATES.map((value) => ({ value, label: value }))}
        />
        <Input
          allowClear
          placeholder="Telegram chat ID"
          style={{ width: 220 }}
          value={chatDraft}
          onChange={(event) => setChatDraft(event.target.value)}
        />
        <Input
          allowClear
          placeholder="Target user ID"
          style={{ width: 200 }}
          value={targetDraft}
          onChange={(event) => setTargetDraft(event.target.value)}
        />
        <Button type="primary" onClick={applyFilters}>
          Apply
        </Button>
        <Button onClick={resetFilters}>Reset</Button>
      </Space>
      {queryState({ isPending: query.isPending, error: query.error })}
      {query.isPending || query.error !== null ? null : items.length === 0 ? (
        <Empty description="No alarms match these filters." />
      ) : (
        <>
          <Table<AlarmListItem>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={items}
            scroll={{ x: 960 }}
            expandable={{
              expandedRowRender: (row) => (
                <Space direction="vertical" size="small" style={{ width: "100%" }}>
                  <Typography.Text>
                    <Typography.Text strong>Alarm ID:</Typography.Text>{" "}
                    <Typography.Text code>{row.id}</Typography.Text>
                  </Typography.Text>
                  <Typography.Text>
                    <Typography.Text strong>Conversation ID:</Typography.Text>{" "}
                    <Typography.Text code>{row.conversation_id}</Typography.Text>
                  </Typography.Text>
                  <Typography.Text>
                    <Typography.Text strong>Scheduled (UTC):</Typography.Text>{" "}
                    <Typography.Text code>{row.scheduled_at}</Typography.Text>
                  </Typography.Text>
                  <Typography.Text>
                    <Typography.Text strong>Telegram chat:</Typography.Text>{" "}
                    <Typography.Text code>{row.chat.telegram_chat_id}</Typography.Text>
                    {` · thread ${row.chat.message_thread_id}`}
                  </Typography.Text>
                  <Typography.Text>
                    <Typography.Text strong>Target user ID:</Typography.Text>{" "}
                    <Typography.Text code>{row.target_user_id}</Typography.Text>
                  </Typography.Text>
                  <Typography.Text>
                    <Typography.Text strong>Summary:</Typography.Text>{" "}
                    <Typography.Text style={{ whiteSpace: "pre-wrap" }}>{row.summary}</Typography.Text>
                  </Typography.Text>
                  <Typography.Text>
                    <Typography.Text strong>Created:</Typography.Text> {formatTime(row.created_at)}
                    {row.created_by_invocation_id === null ? "" : ` · created by Tool session ${row.created_by_invocation_id}`}
                  </Typography.Text>
                  <Typography.Text>
                    <Typography.Text strong>Fired:</Typography.Text> {formatTime(row.fired_at)}
                    {row.invocation_outcome === null ? "" : ` · outcome ${row.invocation_outcome}`}
                    {row.completion_reason === null ? "" : ` (${row.completion_reason})`}
                  </Typography.Text>
                  <Typography.Text>
                    <Typography.Text strong>Cancelled:</Typography.Text> {formatTime(row.cancelled_at)}
                    {row.cancelled_by === null ? "" : ` · by ${row.cancelled_by}`}
                    {row.cancel_reason === null ? "" : ` · reason ${row.cancel_reason}`}
                    {row.admin_cancelled ? " · admin-cancelled" : ""}
                  </Typography.Text>
                  <Typography.Text>
                    <Typography.Text strong>Updated:</Typography.Text> {formatTime(row.updated_at)}
                  </Typography.Text>
                  {row.invocation_id === null ? null : (
                    <Typography.Text>
                      <Typography.Text strong>Invocation:</Typography.Text>{" "}
                      <Link to="/invocations/$invocationId" params={{ invocationId: row.invocation_id }}>
                        Tool session {row.invocation_id}
                      </Link>
                    </Typography.Text>
                  )}
                </Space>
              ),
            }}
            columns={[
              {
                title: "Status",
                dataIndex: "state",
                key: "state",
                render: (value: string) => <StateTag state={value} />,
              },
              {
                title: "Scheduled",
                dataIndex: "scheduled_at",
                key: "scheduled_at",
                render: (value: string) => formatTime(value),
              },
              {
                title: "Chat/Topic",
                key: "chat",
                render: (_: unknown, row) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{row.chat.title ?? row.chat.telegram_chat_id}</Typography.Text>
                    <Typography.Text type="secondary">
                      {row.chat.telegram_chat_id}
                      {row.chat.message_thread_id === "0" ? "" : ` · topic ${row.chat.message_thread_id}`}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: "Target user",
                key: "target",
                render: (_: unknown, row) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{row.target_display_name}</Typography.Text>
                    <Typography.Text type="secondary">{row.target_user_id}</Typography.Text>
                  </Space>
                ),
              },
              {
                title: "Summary",
                dataIndex: "summary",
                key: "summary",
                render: (value: string) => (
                  <Typography.Paragraph ellipsis={{ rows: 1 }} style={{ margin: 0, maxWidth: 320 }}>
                    {value}
                  </Typography.Paragraph>
                ),
              },
              {
                title: "Invocation",
                key: "invocation",
                render: (_: unknown, row) =>
                  row.invocation_id === null && row.created_by_invocation_id === null ? (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ) : (
                    <Link
                      to="/invocations/$invocationId"
                      params={{ invocationId: row.invocation_id ?? row.created_by_invocation_id ?? "" }}
                    >
                      Tool session {row.invocation_id ?? row.created_by_invocation_id}
                    </Link>
                  ),
              },
              {
                title: "Action",
                key: "action",
                fixed: "right",
                render: (_: unknown, row) =>
                  row.state !== "pending" ? (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ) : (
                    <Popconfirm
                      title="Cancel this pending alarm?"
                      description="It will remain visible in audit history."
                      okText="Cancel"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => {
                        setCancellingId(row.id);
                        remove.mutate(row.id);
                      }}
                    >
                      <Button size="small" danger loading={cancellingId === row.id}>
                        Cancel
                      </Button>
                    </Popconfirm>
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
