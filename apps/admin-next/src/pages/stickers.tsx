import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  type ColumnSpec,
  CursorList,
  FilterToolbar,
  JsonViewer,
  LIST_TABLE_CLASS,
  SelectFilter,
  StateBadge,
  TableShell,
  TextFilter,
  TextValue,
  ToneBadge,
} from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, type StickerEntry, type StickerSetEntry } from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { stickerSetsQuery, stickersQuery } from '@/lib/queries';

const INDEX_STATES = ['pending', 'running', 'success', 'error'] as const;

function nonEmpty(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

const CODE = 'bg-muted rounded px-1 py-0.5 font-mono text-xs';

function ConfiguredBadge({ configured }: { readonly configured: boolean }): React.ReactElement {
  return configured ? <ToneBadge tone="success">yes</ToneBadge> : <ToneBadge tone="neutral">disabled</ToneBadge>;
}

function Section({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: React.ReactNode;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-muted-foreground max-w-3xl text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

const SET_COLUMNS: readonly ColumnSpec<StickerSetEntry>[] = [
  {
    key: 'alias',
    title: 'Set',
    render: (row) => (
      <div className="space-y-0.5">
        <div className="font-medium">{row.title ?? row.alias}</div>
        <div className="text-muted-foreground text-xs">
          {row.alias} · {row.telegram_name}
        </div>
      </div>
    ),
  },
  { key: 'configured', title: 'Configured', render: (row) => <ConfiguredBadge configured={row.configured} /> },
  { key: 'sync_state', title: 'Sync', render: (row) => <StateBadge state={row.sync_state} /> },
  {
    key: 'sticker_count',
    title: 'Stickers',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatNumber(row.sticker_count),
  },
  {
    key: 'indexed_count',
    title: 'Indexed',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatNumber(row.indexed_count),
  },
  {
    key: 'pending_count',
    title: 'Pending',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatNumber(row.pending_count),
  },
  {
    key: 'error_count',
    title: 'Errors',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatNumber(row.error_count),
  },
  { key: 'error_code', title: 'Error', className: 'ps-6', render: (row) => <TextValue value={row.error_code} /> },
  {
    key: 'last_synced_at',
    title: 'Last synced',
    className: 'text-muted-foreground',
    render: (row) => formatTime(row.last_synced_at),
  },
];

const STICKER_COLUMNS: readonly ColumnSpec<StickerEntry>[] = [
  {
    key: 'emoji',
    title: 'Sticker',
    render: (row) => (
      <div className="space-y-0.5">
        <div>{row.emoji ?? <span className="text-muted-foreground">—</span>}</div>
        <div className="text-muted-foreground text-xs">
          {row.set_alias} · {row.format}
        </div>
      </div>
    ),
  },
  { key: 'index_state', title: 'Index state', render: (row) => <StateBadge state={row.index_state} /> },
  {
    key: 'description',
    title: 'Description',
    className: 'min-w-64 whitespace-normal',
    render: (row) => (
      <p className="line-clamp-2 max-w-md break-words">
        {row.analysis?.description ?? <span className="text-muted-foreground">—</span>}
      </p>
    ),
  },
  {
    key: 'model',
    title: 'Model',
    render: (row) =>
      row.analysis === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        `${row.analysis.provider ?? '?'}/${row.analysis.model ?? '?'}`
      ),
  },
  {
    key: 'failure_count',
    title: 'Failures',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatNumber(row.failure_count),
  },
  {
    key: 'updated_at',
    title: 'Updated',
    className: 'text-muted-foreground ps-6',
    render: (row) => formatTime(row.updated_at),
  },
];

export default function StickersPage(): React.ReactElement {
  const [set, setSet] = useState<string | undefined>(undefined);
  const [state, setState] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState<string | undefined>(undefined);
  const sets = useQuery(stickerSetsQuery);
  const filters = useMemo(() => ({ set, state, search }), [set, state, search]);

  const setOptions = (sets.data?.items ?? []).map((entry) => ({ value: entry.alias, label: entry.alias }));

  return (
    <div className="space-y-10">
      <Section
        title="Configured sticker sets"
        description={
          <>
            Only sets listed in <code className={CODE}>telegram.sticker_sets</code> are synchronized here. Stickers
            received in chats are not automatically added or approved for sending.
          </>
        }
      >
        {sets.isPending ? <Skeleton className="h-32 w-full rounded-xl" /> : null}
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
            className={LIST_TABLE_CLASS}
          />
        ) : null}
      </Section>
      <Section
        title="Bot search index"
        description={
          <>
            Only successfully analyzed stickers from configured sets appear here and are available to the{' '}
            <code className={CODE}>search_stickers</code> capability (called through{' '}
            <code className={CODE}>execute</code>
            ). On-demand analyses of chat media are stored separately and appear in message details.
          </>
        }
      >
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
              className={LIST_TABLE_CLASS}
              expandedRender={(row) => (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs">Next retry</p>
                    <p>{formatTime(row.next_retry_at)}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs">Analysis version</p>
                    <TextValue value={row.analysis?.analysis_version ?? null} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs">Description</p>
                    <p className="break-words whitespace-pre-wrap">{row.analysis?.description ?? '—'}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs">Metadata</p>
                    <JsonViewer value={row.analysis?.metadata_json ?? null} />
                  </div>
                </div>
              )}
            />
          )}
        />
      </Section>
    </div>
  );
}
