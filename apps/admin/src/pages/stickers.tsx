import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button, Card, Input, Select, Space, Table, Tag, Typography } from "antd";
import type { StickerEntry, StickerSetEntry } from "../api.ts";
import { JsonBlock, queryState, StateTag, TextValue } from "../components.tsx";
import { formatTime } from "../format.ts";
import { stickerSetsQuery, stickersQuery } from "../queries.ts";

const INDEX_STATES = ["pending", "running", "success", "error"];

export function StickersPage(): React.ReactElement {
  const [set, setSet] = useState<string | undefined>(undefined);
  const [state, setState] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const sets = useQuery(stickerSetsQuery);
  const stickers = useInfiniteQuery(
    stickersQuery({ set, state, search: search.length === 0 ? undefined : search }),
  );
  const items = stickers.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card title="Sticker sets" size="small">
        {queryState({ isPending: sets.isPending, error: sets.error })}
        {sets.isPending || sets.error !== null ? null : (
          <Table<StickerSetEntry>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={[...(sets.data?.items ?? [])]}
            columns={[
              { title: "Alias", dataIndex: "alias", key: "alias" },
              { title: "Telegram name", dataIndex: "telegram_name", key: "telegram_name" },
              { title: "Title", dataIndex: "title", key: "title", render: (value: string | null) => <TextValue value={value} /> },
              {
                title: "Configured",
                dataIndex: "configured",
                key: "configured",
                render: (value: boolean) => (value ? <Tag color="green">yes</Tag> : <Tag>disabled</Tag>),
              },
              {
                title: "Sync",
                dataIndex: "sync_state",
                key: "sync_state",
                render: (value: string) => <StateTag state={value} />,
              },
              { title: "Stickers", dataIndex: "sticker_count", key: "sticker_count", align: "right" },
              { title: "Indexed", dataIndex: "indexed_count", key: "indexed_count", align: "right" },
              { title: "Pending", dataIndex: "pending_count", key: "pending_count", align: "right" },
              { title: "Errors", dataIndex: "error_count", key: "error_count", align: "right" },
              {
                title: "Last synced",
                dataIndex: "last_synced_at",
                key: "last_synced_at",
                render: (value: string | null) => formatTime(value),
              },
              { title: "Error", dataIndex: "error_code", key: "error_code", render: (value: string | null) => <TextValue value={value} /> },
            ]}
          />
        )}
      </Card>
      <Card title="Vision index cache" size="small">
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
            <Select
              allowClear
              placeholder="Sticker set"
              style={{ width: 220 }}
              value={set}
              onChange={(value) => setSet(value)}
              options={(sets.data?.items ?? []).map((entry) => ({ value: entry.alias, label: entry.alias }))}
            />
            <Select
              allowClear
              placeholder="Index state"
              style={{ width: 180 }}
              value={state}
              onChange={(value) => setState(value)}
              options={INDEX_STATES.map((value) => ({ value, label: value }))}
            />
            <Input.Search
              allowClear
              placeholder="Search description or emoji"
              style={{ width: 320 }}
              onSearch={(value) => setSearch(value.trim())}
            />
          </Space>
          {queryState({ isPending: stickers.isPending, error: stickers.error })}
          {stickers.isPending || stickers.error !== null ? null : (
            <>
              <Table<StickerEntry>
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={items}
                expandable={{
                  expandedRowRender: (row) => (
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Typography.Text strong>Description</Typography.Text>
                      <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                        {row.analysis?.description ?? "—"}
                      </Typography.Paragraph>
                      <Typography.Text strong>Metadata</Typography.Text>
                      <JsonBlock value={row.analysis?.metadata_json ?? null} />
                    </Space>
                  ),
                }}
                columns={[
                  { title: "Set", dataIndex: "set_alias", key: "set_alias" },
                  { title: "Emoji", dataIndex: "emoji", key: "emoji", render: (value: string | null) => <TextValue value={value} /> },
                  { title: "Format", dataIndex: "format", key: "format" },
                  {
                    title: "Index state",
                    dataIndex: "index_state",
                    key: "index_state",
                    render: (value: string) => <StateTag state={value} />,
                  },
                  { title: "Failures", dataIndex: "failure_count", key: "failure_count", align: "right" },
                  {
                    title: "Next retry",
                    dataIndex: "next_retry_at",
                    key: "next_retry_at",
                    render: (value: string | null) => formatTime(value),
                  },
                  {
                    title: "Analysis version",
                    key: "analysis_version",
                    render: (_: unknown, row) => <TextValue value={row.analysis?.analysis_version ?? null} />,
                  },
                  {
                    title: "Model",
                    key: "model",
                    render: (_: unknown, row) =>
                      row.analysis === null ? (
                        <Typography.Text type="secondary">—</Typography.Text>
                      ) : (
                        <Typography.Text>{`${row.analysis.provider ?? "?"}/${row.analysis.model ?? "?"}`}</Typography.Text>
                      ),
                  },
                  {
                    title: "Description",
                    key: "description",
                    render: (_: unknown, row) => (
                      <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: 0, maxWidth: 360 }}>
                        {row.analysis?.description ?? "—"}
                      </Typography.Paragraph>
                    ),
                  },
                  {
                    title: "Updated",
                    dataIndex: "updated_at",
                    key: "updated_at",
                    render: (value: string) => formatTime(value),
                  },
                ]}
              />
              {stickers.hasNextPage ? (
                <Button loading={stickers.isFetchingNextPage} onClick={() => void stickers.fetchNextPage()}>
                  Load more
                </Button>
              ) : null}
            </>
          )}
        </Space>
      </Card>
    </Space>
  );
}
