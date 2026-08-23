import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Alert, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from "antd";
import type { MemoryDraft, MemoryEntry, MemoryUpdate } from "../api.ts";
import { createMemory, deleteMemory, updateMemory } from "../api.ts";
import { flatPages, queryState, useSearchFilter } from "../components.tsx";
import { formatTime } from "../format.ts";
import { memoriesQuery, memoryChatsQuery } from "../queries.ts";

const DAY_SECONDS = 86_400;
const MEMORY_STATES = ["active", "expired", "long_ttl"];

function formatTtl(seconds: number): string {
  if (seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS} d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)} h`;
  return `${seconds} s`;
}

interface MemoryFormValues {
  readonly chat_id?: string;
  readonly message_thread_id?: number;
  readonly content: string;
  readonly ttl_days?: number;
}

export function MemoriesPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const chat = useSearchFilter();
  const [state, setState] = useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [createForm] = Form.useForm<MemoryFormValues>();
  const [editForm] = Form.useForm<MemoryFormValues>();
  const memories = useInfiniteQuery(memoriesQuery({ chat: chat.filter, state }));
  const chats = useQuery(memoryChatsQuery);
  const items = flatPages(memories.data);
  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["memories"] });
  };
  const create = useMutation({
    mutationFn: (values: MemoryFormValues) => {
      const draft: MemoryDraft = {
        chat_id: values.chat_id ?? "",
        message_thread_id: values.message_thread_id ?? 0,
        content: values.content,
        ttl_seconds: (values.ttl_days ?? 1) * DAY_SECONDS,
      };
      return createMemory(draft);
    },
    onSuccess: async () => {
      message.success("Memory created");
      setCreateOpen(false);
      createForm.resetFields();
      await invalidate();
    },
    onError: (error: unknown) => {
      message.error(error instanceof Error ? error.message : "Request failed");
    },
  });
  const update = useMutation({
    mutationFn: ({ id, values }: { id: string; values: MemoryFormValues }) => {
      const updateBody: MemoryUpdate = {
        content: values.content,
        ...(values.ttl_days !== undefined && values.ttl_days !== null
          ? { ttl_seconds: values.ttl_days * DAY_SECONDS }
          : {}),
      };
      return updateMemory(id, updateBody);
    },
    onSuccess: async () => {
      message.success("Memory updated");
      setEditing(null);
      await invalidate();
    },
    onError: (error: unknown) => {
      message.error(error instanceof Error ? error.message : "Request failed");
    },
  });
  const remove = useMutation({
    mutationFn: deleteMemory,
    onSuccess: async () => {
      message.success("Memory deleted");
      await invalidate();
    },
    onError: (error: unknown) => {
      message.error(error instanceof Error ? error.message : "Request failed");
    },
  });
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="Agent-managed short-term memory"
        description={
          <Typography.Text>
            The agent saves and deletes notes itself via <Typography.Text code>add_memory</Typography.Text> /{" "}
            <Typography.Text code>delete_memory</Typography.Text>; notes expire by TTL. Entries whose remaining
            lifetime exceeds the configured warning threshold are flagged — review them: keep, delete, or promote
            durable knowledge into <Typography.Text code>agents.md</Typography.Text>.
          </Typography.Text>
        }
      />
      <Space wrap>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          New memory
        </Button>
        <Input.Search
          allowClear
          placeholder="Telegram chat ID"
          style={{ width: 240 }}
          onSearch={(value) => chat.set(value)}
        />
        <Select
          allowClear
          placeholder="State"
          style={{ width: 180 }}
          value={state}
          onChange={(value) => setState(value)}
          options={MEMORY_STATES.map((value) => ({ value, label: value }))}
        />
      </Space>
      {queryState({ isPending: memories.isPending, error: memories.error })}
      {memories.isPending || memories.error !== null ? null : (
        <>
          <Table<MemoryEntry>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={items}
            columns={[
              {
                title: "ID",
                dataIndex: "id",
                key: "id",
                render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
              },
              {
                title: "Chat",
                key: "chat",
                render: (_: unknown, row) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{row.chat.title ?? row.chat.telegram_chat_id}</Typography.Text>
                    <Typography.Text type="secondary">
                      {row.chat.telegram_chat_id}
                      {row.chat.message_thread_id === 0 ? "" : ` · topic ${row.chat.message_thread_id}`}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: "Content",
                dataIndex: "content",
                key: "content",
                render: (value: string) => (
                  <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: 0, maxWidth: 420, whiteSpace: "pre-wrap" }}>
                    {value}
                  </Typography.Paragraph>
                ),
              },
              {
                title: "Created",
                dataIndex: "created_at",
                key: "created_at",
                render: (value: string) => formatTime(value),
              },
              {
                title: "Expires",
                dataIndex: "expires_at",
                key: "expires_at",
                render: (value: string) => formatTime(value),
              },
              {
                title: "TTL",
                key: "ttl",
                render: (_: unknown, row) => formatTtl(row.ttl_seconds),
              },
              {
                title: "Status",
                key: "status",
                render: (_: unknown, row) => (
                  <Space size={4}>
                    {row.long_ttl ? <Tag color="orange">long TTL</Tag> : null}
                    {row.expired ? <Tag>expired</Tag> : <Tag color="green">active</Tag>}
                  </Space>
                ),
              },
              {
                title: "Actions",
                key: "actions",
                render: (_: unknown, row) => (
                  <Space size={8}>
                    <Button
                      size="small"
                      onClick={() => {
                        editForm.setFieldsValue({ content: row.content });
                        setEditing(row);
                      }}
                    >
                      Edit
                    </Button>
                    <Popconfirm
                      title="Delete this memory?"
                      description="The agent will no longer see it in future sessions."
                      okText="Delete"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => remove.mutate(row.id)}
                    >
                      <Button size="small" danger loading={remove.isPending}>
                        Delete
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
          {memories.hasNextPage ? (
            <Button loading={memories.isFetchingNextPage} onClick={() => void memories.fetchNextPage()}>
              Load more
            </Button>
          ) : null}
        </>
      )}
      <Modal
        title="New memory"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={create.isPending}
        destroyOnHidden
      >
        <Form<MemoryFormValues>
          form={createForm}
          layout="vertical"
          requiredMark={false}
          initialValues={{ message_thread_id: 0, ttl_days: 1 }}
          onFinish={(values) => create.mutate(values)}
        >
          <Form.Item name="chat_id" label="Chat" rules={[{ required: true, message: "Chat is required" }]}>
            <Select
              showSearch
              placeholder="Select a chat"
              optionFilterProp="label"
              options={(chats.data?.items ?? []).map((chatOption) => ({
                value: chatOption.telegram_chat_id,
                label: `${chatOption.title ?? chatOption.telegram_chat_id} (${chatOption.type}${chatOption.username === null ? "" : ` @${chatOption.username}`})`,
              }))}
            />
          </Form.Item>
          <Form.Item name="message_thread_id" label="Forum topic (0 = main thread)" rules={[{ required: true }]}>
            <InputNumber min={0} max={1_000_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="content"
            label="Content"
            rules={[
              { required: true, message: "Content is required" },
              { max: 150, message: "At most 150 characters" },
            ]}
          >
            <Input.TextArea rows={3} maxLength={150} showCount />
          </Form.Item>
          <Form.Item name="ttl_days" label="TTL in days" rules={[{ required: true }]}>
            <InputNumber min={1} max={1_825} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={`Edit memory ${editing?.id ?? ""}`}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => editForm.submit()}
        confirmLoading={update.isPending}
        destroyOnHidden
      >
        <Form<MemoryFormValues>
          form={editForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            if (editing !== null) update.mutate({ id: editing.id, values });
          }}
        >
          <Form.Item
            name="content"
            label="Content"
            rules={[
              { required: true, message: "Content is required" },
              { max: 150, message: "At most 150 characters" },
            ]}
          >
            <Input.TextArea rows={3} maxLength={150} showCount />
          </Form.Item>
          <Form.Item name="ttl_days" label="Renew TTL in days (leave empty to keep current expiry)">
            <InputNumber min={1} max={1_825} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
