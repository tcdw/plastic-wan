import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  ConfirmDialog,
  CursorList,
  FilterToolbar,
  KvList,
  MonoValue,
  SelectFilter,
  StateBadge,
  TableShell,
  TextFilter,
  TextValue,
  type ColumnSpec,
} from '@/components/business';
import { Button } from '@/components/ui/button';
import { type AlarmListItem, cancelAlarm } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { alarmsQuery } from '@/lib/queries';

const ALARM_STATES = ['pending', 'firing', 'fired', 'cancelled'] as const;

function ChatCell({ row }: { readonly row: AlarmListItem }): React.ReactElement {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="font-medium">{row.chat.title ?? row.chat.telegram_chat_id}</div>
      <div className="text-muted-foreground text-xs">
        {row.chat.telegram_chat_id}
        {row.chat.message_thread_id === '0' ? '' : ` · topic ${row.chat.message_thread_id}`}
      </div>
    </div>
  );
}

function TargetCell({ row }: { readonly row: AlarmListItem }): React.ReactElement {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="font-medium">{row.target_display_name}</div>
      <div className="text-muted-foreground text-xs">{row.target_user_id}</div>
    </div>
  );
}

function InvocationLink({ id }: { readonly id: string }): React.ReactElement {
  return (
    <Link
      to="/invocations/$invocationId"
      params={{ invocationId: id }}
      className="font-mono text-xs break-all underline-offset-4 hover:underline"
    >
      Tool session {id}
    </Link>
  );
}

function AlarmDetails({ row }: { readonly row: AlarmListItem }): React.ReactElement {
  const createdBy = row.created_by_invocation_id;
  const fired = `${formatTime(row.fired_at)}${row.invocation_outcome === null ? '' : ` · outcome ${row.invocation_outcome}`}${row.completion_reason === null ? '' : ` (${row.completion_reason})`}`;
  const cancelled = `${formatTime(row.cancelled_at)}${row.cancelled_by === null ? '' : ` · by ${row.cancelled_by}`}${row.cancel_reason === null ? '' : ` · reason ${row.cancel_reason}`}${row.admin_cancelled ? ' · admin-cancelled' : ''}`;
  return (
    <KvList
      items={[
        { label: 'Alarm ID', value: <MonoValue value={row.id} /> },
        { label: 'Conversation ID', value: <MonoValue value={row.conversation_id} /> },
        { label: 'Scheduled (UTC)', value: <MonoValue value={row.scheduled_at} /> },
        {
          label: 'Telegram chat / thread',
          value: `${row.chat.telegram_chat_id}${row.chat.message_thread_id === '0' ? '' : ` · thread ${row.chat.message_thread_id}`}`,
        },
        { label: 'Target user ID', value: <MonoValue value={row.target_user_id} /> },
        { label: 'Summary', value: <span className="text-wrap whitespace-pre-wrap">{row.summary}</span> },
        {
          label: 'Created',
          value: `${formatTime(row.created_at)}${createdBy === null ? '' : ` · created by Tool session ${createdBy}`}`,
        },
        { label: 'Fired', value: fired },
        { label: 'Cancelled', value: cancelled },
        { label: 'Updated', value: formatTime(row.updated_at) },
        {
          label: 'Invocation',
          value: row.invocation_id === null ? <TextValue value={null} /> : <InvocationLink id={row.invocation_id} />,
        },
      ]}
    />
  );
}

export default function AlarmsPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [state, setState] = useState<string | undefined>(undefined);
  const [chat, setChat] = useState<string | undefined>(undefined);
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [cancelling, setCancelling] = useState<AlarmListItem | null>(null);
  const filters = useMemo(() => ({ state, chat, target }), [state, chat, target]);

  const cancel = useMutation({
    mutationFn: cancelAlarm,
    onSuccess: () => {
      setCancelling(null);
      toast.success('Alarm cancelled');
      void queryClient.invalidateQueries({ queryKey: ['alarms'] });
    },
    onError: () => {
      // 409 (alarm_not_pending) or any other failure: keep the dialog open
      // with the real message and refresh anyway so the list shows the true
      // state (a 409 means the alarm is no longer pending).
      void queryClient.invalidateQueries({ queryKey: ['alarms'] });
    },
  });

  const columns: readonly ColumnSpec<AlarmListItem>[] = [
    { key: 'state', title: 'Status', render: (row) => <StateBadge state={row.state} /> },
    { key: 'scheduled_at', title: 'Scheduled', render: (row) => formatTime(row.scheduled_at) },
    { key: 'chat', title: 'Chat/Topic', render: (row) => <ChatCell row={row} /> },
    { key: 'target', title: 'Target user', render: (row) => <TargetCell row={row} /> },
    {
      key: 'summary',
      title: 'Summary',
      className: 'max-w-72 min-w-40 whitespace-normal',
      render: (row) => <div className="line-clamp-1">{row.summary}</div>,
    },
    {
      key: 'invocation',
      title: 'Invocation',
      render: (row) => {
        const id = row.invocation_id ?? row.created_by_invocation_id;
        return id === null ? <span className="text-muted-foreground">—</span> : <InvocationLink id={id} />;
      },
    },
    {
      key: 'action',
      title: 'Action',
      render: (row) =>
        row.state === 'pending' ? (
          <Button type="button" size="sm" variant="destructive" onClick={() => setCancelling(row)}>
            Cancel
          </Button>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <FilterToolbar>
        <SelectFilter
          placeholder="State"
          value={state}
          onChange={setState}
          options={ALARM_STATES.map((value) => ({ value, label: value }))}
        />
        <TextFilter placeholder="Telegram chat ID" value={chat} onCommit={setChat} onClear={() => setChat(undefined)} />
        <TextFilter
          placeholder="Target user ID"
          value={target}
          onCommit={setTarget}
          onClear={() => setTarget(undefined)}
        />
      </FilterToolbar>
      <CursorList
        factory={alarmsQuery}
        filters={filters}
        empty={<div className="text-muted-foreground py-8 text-center text-sm">No alarms match these filters.</div>}
        renderItems={(items) => (
          <TableShell
            columns={columns}
            data={items}
            rowKey={(row) => row.id}
            expandedRender={(row) => <AlarmDetails row={row} />}
            className="max-w-full overflow-x-auto"
          />
        )}
      />
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) {
            setCancelling(null);
          }
        }}
        title="Cancel this pending alarm?"
        description="It will remain visible in audit history."
        confirmText="Cancel alarm"
        destructive
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() => {
          if (cancelling !== null) {
            cancel.mutate(cancelling.id);
          }
        }}
      />
    </div>
  );
}
