import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  ChartCard,
  ConfirmDialog,
  StateBadge,
  TableShell,
  TimeSeriesChart,
  type ChartSeries,
  type ColumnSpec,
} from '@/components/business';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cancelPendingSessions, type LabelCount, type UsageEntry, wakeBot } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatNumber, formatTime } from '@/lib/format';
import { overviewQuery, usageQuery } from '@/lib/queries';

const TOKEN_SERIES: readonly ChartSeries[] = [
  { dataKey: 'model_tokens', label: 'Model tokens', color: '#3b82f6' },
  { dataKey: 'vision_tokens', label: 'Vision tokens', color: '#22c55e' },
];
const INVOCATION_SERIES: readonly ChartSeries[] = [
  { dataKey: 'agent_invocations', label: 'Invocations', color: '#a855f7' },
];
const TOOL_SERIES: readonly ChartSeries[] = [{ dataKey: 'tool_calls', label: 'Tool calls', color: '#f59e0b' }];

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

function StatCard({ title, value }: { readonly title: string; readonly value: string }): React.ReactElement {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}

function StatCardSkeleton(): React.ReactElement {
  return (
    <Card>
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-16" />
      </CardContent>
    </Card>
  );
}

function SleepBadge({ sleeping }: { readonly sleeping: boolean }): React.ReactElement {
  return sleeping ? (
    <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
      sleeping
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
      awake
    </span>
  );
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
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
    );
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="Invocations" value={formatNumber(totalInvocations)} />
        <StatCard title="Stored messages" value={formatNumber(data.message_count)} />
        <StatCard title="Cached media analyses" value={formatNumber(data.cached_analysis_count)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Bot status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <SleepBadge sleeping={data.runtime_status.sleeping} />
                {data.runtime_status.sleep_until !== null ? (
                  <span className="text-muted-foreground text-sm">
                    until {formatTime(data.runtime_status.sleep_until)}
                  </span>
                ) : null}
              </div>
              {data.runtime_status.sleeping ? (
                <Button type="button" size="sm" disabled={wake.isPending} onClick={() => setWakeOpen(true)}>
                  Wake now
                </Button>
              ) : null}
            </div>
            <div>
              <p className="text-muted-foreground mb-1 text-xs">Administrator pauses</p>
              {data.runtime_status.paused_chats.length === 0 ? (
                <p className="text-muted-foreground text-sm">None</p>
              ) : (
                <ul className="space-y-1">
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
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Operations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-muted-foreground text-xs">Queued invocations</p>
                <p className="text-xl font-semibold">{formatNumber(queuedInvocations)}</p>
              </div>
              <Button
                type="button"
                variant="destructive"
                disabled={cancel.isPending}
                onClick={() => setCancelOpen(true)}
              >
                Cancel pending
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Expires collecting/queued buckets and aborts queued invocations.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Invocation states</CardTitle>
          </CardHeader>
          <CardContent>
            <TableShell columns={COUNT_COLUMNS} data={data.invocation_states} rowKey={(row) => row.label} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Configured sticker index states</CardTitle>
          </CardHeader>
          <CardContent>
            <TableShell columns={COUNT_COLUMNS} data={data.sticker_index_states} rowKey={(row) => row.label} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Top tools</CardTitle>
          </CardHeader>
          <CardContent>
            <TableShell columns={TOOL_COLUMNS} data={data.top_tools} rowKey={(row) => row.label} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4 pt-4 pb-1">
          <CardTitle className="text-sm">Daily usage</CardTitle>
          <Tabs value={String(days)} onValueChange={(value) => setDays(Number(value))}>
            <TabsList>
              <TabsTrigger value="7">7d</TabsTrigger>
              <TabsTrigger value="30">30d</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="px-2 pb-4">
          {usagePending ? (
            <Skeleton className="h-56 w-full" />
          ) : usageError ? (
            <p className="text-destructive px-4 text-sm break-words">{errorMessage(usageErrorValue)}</p>
          ) : usage === undefined || chartData.length === 0 ? (
            <p className="text-muted-foreground px-4 py-20 text-center text-sm">No usage data</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <ChartCard title="Tokens">
                <TimeSeriesChart data={chartData} series={TOKEN_SERIES} height={200} />
              </ChartCard>
              <ChartCard title="Invocations">
                <TimeSeriesChart data={chartData} series={INVOCATION_SERIES} height={200} />
              </ChartCard>
              <ChartCard title="Tool calls">
                <TimeSeriesChart data={chartData} series={TOOL_SERIES} height={200} />
              </ChartCard>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Today&apos;s usage (UTC)</CardTitle>
        </CardHeader>
        <CardContent>
          <TableShell
            columns={USAGE_COLUMNS}
            data={data.daily_usage}
            rowKey={(row) => `${row.resource}|${row.metric}|${row.scope}`}
          />
        </CardContent>
      </Card>

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
