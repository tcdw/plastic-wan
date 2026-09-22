import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  ChartPanel,
  ConfirmDialog,
  FLUSH_TABLE_CLASS,
  StateBadge,
  TableShell,
  TimeSeriesChart,
  type ChartSeries,
  type ColumnSpec,
  ToneBadge,
} from '@/components/business';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Panel } from '@/components/layout/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cancelPendingSessions, type LabelCount, type UsageEntry, wakeBot } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatNumber, formatTime } from '@/lib/format';
import { overviewQuery, usageQuery } from '@/lib/queries';

const TOKEN_SERIES: readonly ChartSeries[] = [
  { dataKey: 'model_tokens', label: 'Model tokens', color: 'var(--chart-1)' },
  { dataKey: 'vision_tokens', label: 'Vision tokens', color: 'var(--chart-2)' },
];
const INVOCATION_SERIES: readonly ChartSeries[] = [
  { dataKey: 'agent_invocations', label: 'Invocations', color: 'var(--chart-3)' },
];
const TOOL_SERIES: readonly ChartSeries[] = [{ dataKey: 'tool_calls', label: 'Tool calls', color: 'var(--chart-4)' }];

const COUNT_COLUMNS: readonly ColumnSpec<LabelCount>[] = [
  { key: 'label', title: 'State', render: (row) => <StateBadge state={row.label} /> },
  { key: 'count', title: 'Count', align: 'right', render: (row) => formatNumber(row.count) },
];

const TOOL_COLUMNS: readonly ColumnSpec<LabelCount>[] = [
  { key: 'label', title: 'Tool', render: (row) => row.label },
  { key: 'count', title: 'Calls', align: 'right', render: (row) => formatNumber(row.count) },
];

const USAGE_COLUMNS: readonly ColumnSpec<UsageEntry>[] = [
  { key: 'resource', title: 'Resource', render: (row) => row.resource },
  { key: 'metric', title: 'Metric', render: (row) => row.metric },
  { key: 'scope', title: 'Scope', render: (row) => row.scope },
  { key: 'amount', title: 'Amount', align: 'right', render: (row) => formatNumber(row.amount) },
];

function Stat({ title, value }: { readonly title: string; readonly value: React.ReactNode }): React.ReactElement {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground text-sm">{title}</dt>
      <dd className="text-3xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="flex min-h-6 flex-col justify-center">{children}</dd>
    </div>
  );
}

function StatsSkeleton(): React.ReactElement {
  return (
    <Card className="grid gap-6 px-6 sm:grid-cols-3">
      {[0, 1, 2].map((index) => (
        <div key={index} className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-16" />
        </div>
      ))}
    </Card>
  );
}

function SleepBadge({ sleeping }: { readonly sleeping: boolean }): React.ReactElement {
  return sleeping ? <ToneBadge tone="warning">sleeping</ToneBadge> : <ToneBadge tone="success">awake</ToneBadge>;
}

export default function OverviewPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [days, setDays] = useState(7);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [wakeOpen, setWakeOpen] = useState(false);

  const { data, isPending, isError, error } = useQuery(overviewQuery);
  const {
    data: usage,
    isPending: usagePending,
    isError: usageError,
    error: usageErrorValue,
  } = useQuery({
    ...usageQuery(days),
    enabled: data !== undefined,
  });

  const cancel = useMutation({
    mutationFn: cancelPendingSessions,
    onSuccess: (result) => {
      setCancelOpen(false);
      toast.success(
        `Canceled ${formatNumber(result.canceled_buckets)} buckets / ${formatNumber(result.canceled_invocations)} invocations`,
      );
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['invocations'] });
    },
    onError: () => {
      // Keep the dialog open so the failure is visible; the user closes it.
    },
  });
  const wake = useMutation({
    mutationFn: wakeBot,
    onSuccess: (result) => {
      setWakeOpen(false);
      toast.success(result.was_sleeping ? 'Bot is awake' : 'Bot was already awake');
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: () => {
      // Keep the dialog open so the failure is visible; the user closes it.
    },
  });

  if (isPending || data === undefined) {
    return <StatsSkeleton />;
  }

  if (isError) {
    return (
      <div className="p-6 text-center">
        <p className="text-destructive font-medium">Failed to load overview</p>
        <p className="text-muted-foreground text-sm break-words">{errorMessage(error)}</p>
      </div>
    );
  }

  const totalInvocations = data.invocation_states.reduce((sum, entry) => sum + entry.count, 0);
  const queuedInvocations = data.invocation_states.find((entry) => entry.label === 'queued')?.count ?? 0;
  const chartData = usage?.series.map((point) => ({ ...point })) ?? [];

  return (
    <div className="space-y-6">
      <Card className="px-6">
        <dl className="grid gap-6 sm:grid-cols-3">
          <Stat title="Invocations" value={formatNumber(totalInvocations)} />
          <Stat title="Stored messages" value={formatNumber(data.message_count)} />
          <Stat title="Cached media analyses" value={formatNumber(data.cached_analysis_count)} />
        </dl>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Bot status"
          action={
            data.runtime_status.sleeping ? (
              <Button type="button" size="sm" disabled={wake.isPending} onClick={() => setWakeOpen(true)}>
                Wake now
              </Button>
            ) : null
          }
        >
          <dl className="space-y-4">
            <Field label="State">
              <div className="flex flex-wrap items-center gap-2">
                <SleepBadge sleeping={data.runtime_status.sleeping} />
                {data.runtime_status.sleep_until !== null ? (
                  <span className="text-muted-foreground text-sm">
                    until {formatTime(data.runtime_status.sleep_until)}
                  </span>
                ) : null}
              </div>
            </Field>
            <Field label="Administrator pauses">
              {data.runtime_status.paused_chats.length === 0 ? (
                <p className="text-sm opacity-60">None</p>
              ) : (
                <ul className="space-y-2">
                  {data.runtime_status.paused_chats.map((chat) => (
                    <li key={chat.telegram_chat_id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="font-medium">
                        {chat.title ?? (chat.username === null ? chat.telegram_chat_id : `@${chat.username}`)}
                      </span>
                      <span className="text-muted-foreground text-xs">since {formatTime(chat.paused_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </dl>
        </Panel>

        <Panel
          title="Operations"
          action={
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => setCancelOpen(true)}
            >
              Cancel pending
            </Button>
          }
        >
          <dl className="space-y-4">
            <Field label="Queued invocations">
              <p className="text-sm font-medium tabular-nums">{formatNumber(queuedInvocations)}</p>
            </Field>
            <Field label="Cancel pending">
              <p className="text-sm">Expires collecting/queued buckets and aborts queued invocations.</p>
            </Field>
          </dl>
        </Panel>
      </div>

      <Panel
        title="Daily usage"
        action={
          <Tabs value={String(days)} onValueChange={(value) => setDays(Number(value))}>
            <TabsList>
              <TabsTrigger value="7">7d</TabsTrigger>
              <TabsTrigger value="30">30d</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      >
        {usagePending ? (
          <Skeleton className="h-56 w-full" />
        ) : usageError ? (
          <p className="text-destructive text-sm break-words">{errorMessage(usageErrorValue)}</p>
        ) : usage === undefined || chartData.length === 0 ? (
          <p className="text-muted-foreground py-20 text-center text-sm">No usage data</p>
        ) : (
          <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-3">
            <ChartPanel title="Tokens">
              <TimeSeriesChart data={chartData} series={TOKEN_SERIES} height={200} />
              <p className="text-muted-foreground text-xs">
                Token usage: prompt tokens processed plus generated tokens. Cache reads and writes are excluded from
                this total and from the daily budget.
              </p>
            </ChartPanel>
            <ChartPanel title="Invocations">
              <TimeSeriesChart data={chartData} series={INVOCATION_SERIES} height={200} />
            </ChartPanel>
            <ChartPanel title="Tool calls">
              <TimeSeriesChart data={chartData} series={TOOL_SERIES} height={200} />
            </ChartPanel>
          </div>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Invocation states" flush>
          <TableShell
            columns={COUNT_COLUMNS}
            data={data.invocation_states}
            rowKey={(row) => row.label}
            className={FLUSH_TABLE_CLASS}
          />
        </Panel>
        <Panel title="Configured sticker index states" flush>
          <TableShell
            columns={COUNT_COLUMNS}
            data={data.sticker_index_states}
            rowKey={(row) => row.label}
            className={FLUSH_TABLE_CLASS}
          />
        </Panel>
        <Panel title="Top tools" flush>
          <TableShell
            columns={TOOL_COLUMNS}
            data={data.top_tools}
            rowKey={(row) => row.label}
            className={FLUSH_TABLE_CLASS}
          />
        </Panel>
      </div>

      <Panel title="Today's usage (UTC)" flush>
        <TableShell
          columns={USAGE_COLUMNS}
          data={data.daily_usage}
          rowKey={(row) => `${row.resource}|${row.metric}|${row.scope}`}
          className={FLUSH_TABLE_CLASS}
        />
        <p className="text-muted-foreground px-5 py-3 text-xs">
          <code className="font-mono">model_tokens</code> is what the global daily budget meters, per chat:{' '}
          <code className="font-mono">vision_tokens</code> is the same definition for the sticker index. Neither
          includes cache reads or writes.
        </p>
      </Panel>

      <p className="text-muted-foreground text-sm">Generated at {formatTime(data.generated_at)}</p>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) {
            setCancelOpen(false);
          }
        }}
        title="Cancel all pending sessions?"
        description="This will expire collecting/queued buckets and abort queued invocations."
        confirmText="Cancel pending sessions"
        destructive
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() => cancel.mutate()}
      />
      <ConfirmDialog
        open={wakeOpen}
        onOpenChange={(open) => {
          if (!open && !wake.isPending) {
            setWakeOpen(false);
          }
        }}
        title="Wake the bot now?"
        description="New sessions may consume the increased token budget immediately."
        confirmText="Wake now"
        pending={wake.isPending}
        error={wake.isError ? errorMessage(wake.error) : null}
        onConfirm={() => wake.mutate()}
      />
    </div>
  );
}
