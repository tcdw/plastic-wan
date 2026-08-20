import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Alert, Button, Form, Input, Modal, Popconfirm, Space, Table, Typography } from "antd";
import type { BotAdminEntry } from "../api.ts";
import { addBotAdmin, removeBotAdmin } from "../api.ts";
import { queryState } from "../components.tsx";
import { formatTime } from "../format.ts";
import { adminsQuery } from "../queries.ts";

interface AdminFormValues {
  readonly telegram_user_id: string;
}

export function AdminsPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<AdminFormValues>();
  const admins = useQuery(adminsQuery);
  const items = admins.data?.items ?? [];
  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["admins"] });
  };
  const create = useMutation({
    mutationFn: (values: AdminFormValues) => addBotAdmin({ telegram_user_id: values.telegram_user_id.trim() }),
    onSuccess: async () => {
      message.success("Bot admin added");
      setCreateOpen(false);
      createForm.resetFields();
      await invalidate();
    },
    onError: (error: unknown) => {
      message.error(error instanceof Error ? error.message : "Request failed");
    },
  });
  const remove = useMutation({
    mutationFn: removeBotAdmin,
    onSuccess: async () => {
      message.success("Bot admin removed");
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
        message="Telegram bot admins"
        description={
          <Typography.Text>
            These Telegram users may run <Typography.Text code>/pause</Typography.Text> and{" "}
            <Typography.Text code>/resume</Typography.Text> in allowed chats. The user ID is the numeric Telegram
            account ID (see <Typography.Text code>@userinfobot</Typography.Text>); entries seeded from{" "}
            <Typography.Text code>telegram.admins</Typography.Text> in the config are re-added on startup and cannot
            be permanently removed.
          </Typography.Text>
        }
      />
      <Space wrap>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          Add bot admin
        </Button>
      </Space>
      {queryState({ isPending: admins.isPending, error: admins.error })}
      {admins.isPending || admins.error !== null ? null : (
        <Table<BotAdminEntry>
          rowKey="telegram_user_id"
          size="small"
          pagination={false}
          dataSource={items}
          columns={[
            {
              title: "Telegram user ID",
              dataIndex: "telegram_user_id",
              key: "telegram_user_id",
              render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
            },
            {
              title: "Display name",
              dataIndex: "display_name",
              key: "display_name",
              render: (value: string) => (value.length === 0 ? <Typography.Text type="secondary">—</Typography.Text> : value),
            },
            {
              title: "Added by",
              dataIndex: "added_by",
              key: "added_by",
              render: (value: string) => <Typography.Text type="secondary">{value}</Typography.Text>,
            },
            {
              title: "Added",
              dataIndex: "created_at",
              key: "created_at",
              render: (value: string) => formatTime(value),
            },
            {
              title: "Actions",
              key: "actions",
              render: (_: unknown, row) => (
                <Popconfirm
                  title={`Remove admin ${row.telegram_user_id}?`}
                  okText="Remove"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => remove.mutate(row.telegram_user_id)}
                >
                  <Button size="small" danger loading={remove.isPending}>
                    Remove
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      )}
      <Modal
        title="Add bot admin"
        open={createOpen}
        okText="Add"
        confirmLoading={create.isPending}
        onOk={() => createForm.submit()}
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
      >
        <Form<AdminFormValues>
          form={createForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => create.mutate(values)}
        >
          <Form.Item
            name="telegram_user_id"
            label="Telegram user ID"
            rules={[
              { required: true, message: "User ID is required" },
              { pattern: /^\d{1,19}$/, message: "Numeric Telegram user ID" },
            ]}
          >
            <Input placeholder="e.g. 123456789" autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
