import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  type ColumnSpec,
  CursorList,
  FilterToolbar,
  JsonViewer,
  SelectFilter,
  StateBadge,
  TableShell,
  TextFilter,
  TextValue,
  ToneBadge,
} from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, type StickerEntry, type StickerSetEntry } from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { stickerSetsQuery, stickersQuery } from '@/lib/queries';

const INDEX_STATES = ['pending', 'running', 'success', 'error'] as const;

function nonEmpty(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

function ConfiguredBadge({ configured }: { readonly configured: boolean }): React.ReactElement {
  return configured ? <ToneBadge tone="success">yes</ToneBadge> : <ToneBadge tone="neutral">disabled</ToneBadge>;
}

const SET_COLUMNS: readonly ColumnSpec<StickerSetEntry>[] = [
  { key: 'alias', title: 'Alias', render: (row) => row.alias },
  { key: 'telegram_name', title: 'Telegram name', render: (row) => row.telegram_name },
  { key: 'title', title: 'Title', render: (row) => <TextValue value={row.title} /> },
  { key: 'configured', title: 'Configured', render: (row) => <ConfiguredBadge configured={row.configured} /> },
  { key: 'sync_state', title: 'Sync', render: (row) => <StateBadge state={row.sync_state} /> },
  { key: 'sticker_count', title: 'Stickers', align: 'right', render: (row) => formatNumber(row.sticker_count) },
  { key: 'indexed_count', title: 'Indexed', align: 'right', render: (row) => formatNumber(row.indexed_count) },
  { key: 'pending_count', title: 'Pending', align: 'right', render: (row) => formatNumber(row.pending_count) },
  { key: 'error_count', title: 'Errors', align: 'right', render: (row) => formatNumber(row.error_count) },
  { key: 'last_synced_at', title: 'Last synced', render: (row) => formatTime(row.last_synced_at) },
  { key: 'error_code', title: 'Error', render: (row) => <TextValue value={row.error_code} /> },
];

const STICKER_COLUMNS: readonly ColumnSpec<StickerEntry>[] = [
  { key: 'set_alias', title: 'Set', render: (row) => row.set_alias },
  { key: 'emoji', title: 'Emoji', render: (row) => <TextValue value={row.emoji} /> },
  { key: 'format', title: 'Format', render: (row) => row.format },
  { key: 'index_state', title: 'Index state', render: (row) => <StateBadge state={row.index_state} /> },
  { key: 'failure_count', title: 'Failures', align: 'right', render: (row) => formatNumber(row.failure_count) },
  { key: 'next_retry_at', title: 'Next retry', render: (row) => formatTime(row.next_retry_at) },
  {
    key: 'analysis_version',
    title: 'Analysis version',
    render: (row) => <TextValue value={row.analysis?.analysis_version ?? null} />,
  },
  {
    key: 'model',
    title: 'Model',
    render: (row) =>
      row.analysis === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="break-words">{`${row.analysis.provider ?? '?'}/${row.analysis.model ?? '?'}`}</span>
      ),
  },
  {
    key: 'description',
    title: 'Description',
    className: 'min-w-56 max-w-md whitespace-normal',
    render: (row) => (
      <p className="max-w-md text-sm break-words line-clamp-2">
        {row.analysis?.description ?? <span className="text-muted-foreground">—</span>}
      </p>
    ),
  },
  { key: 'updated_at', title: 'Updated', render: (row) => formatTime(row.updated_at) },
];

export default function StickersPage(): React.ReactElement {
  const [set, setSet] = useState<string | undefined>(undefined);
  const [state, setState] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState<string | undefined>(undefined);
  const sets = useQuery(stickerSetsQuery);
  const filters = useMemo(() => ({ set, state, search }), [set, state, search]);

  const setOptions = (sets.data?.items ?? []).map((entry) => ({ value: entry.alias, label: entry.alias }));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Configured sticker sets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Only sets listed in{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">telegram.sticker_sets</code> are
            synchronized here. Stickers received in chats are not automatically added or approved for sending.
          </p>
          {sets.isPending ? <Skeleton className="h-32 w-full rounded-md" /> : null}
          {sets.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Failed to load sticker sets</AlertTitle>
              <AlertDescription>
                {sets.error instanceof ApiError
                  ? `${sets.error.code}: ${sets.error.message}`
                  : sets.error instanceof Error
                    ? sets.error.message
                    : 'Admin request failed'}
              </AlertDescription>
            </Alert>
          ) : null}
          {!sets.isPending && !sets.isError ? (
            <TableShell
              columns={SET_COLUMNS}
              data={sets.data?.items ?? []}
              rowKey={(row) => row.id}
              emptyText="No sticker sets configured."
              className="max-w-full overflow-x-auto"
            />
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Bot search index</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Only successfully analyzed stickers from configured sets appear here and are available to the{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">search_stickers</code> capability (called
            through <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">execute</code>). On-demand analyses
            of chat media are stored separately and appear in message details.
          </p>
          <FilterToolbar>
            <SelectFilter placeholder="Sticker set" value={set} onChange={setSet} options={setOptions} />
            <SelectFilter
              placeholder="Index state"
              value={state}
              onChange={setState}
              options={INDEX_STATES.map((value) => ({ value, label: value }))}
            />
            <TextFilter
              placeholder="Search description or emoji"
              value={search}
              onCommit={(value) => setSearch(nonEmpty(value))}
              onClear={() => setSearch(undefined)}
              widthClassName="w-72"
            />
          </FilterToolbar>
          <CursorList
            factory={stickersQuery}
            filters={filters}
            renderItems={(items) => (
              <TableShell
                columns={STICKER_COLUMNS}
                data={items}
                rowKey={(row) => row.id}
                className="max-w-full overflow-x-auto"
                expandedRender={(row) => (
                  <div className="space-y-2">
                    <div>
                      <p className="text-muted-foreground mb-1 text-xs">Description</p>
                      <p className="text-sm break-words whitespace-pre-wrap">{row.analysis?.description ?? '—'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1 text-xs">Metadata</p>
                      <JsonViewer value={row.analysis?.metadata_json ?? null} />
                    </div>
                  </div>
                )}
              />
            )}
          />
        </CardContent>
      </Card>
    </div>
  );
}
