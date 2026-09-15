import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  CursorList,
  FilterToolbar,
  SelectFilter,
  StateBadge,
  TableShell,
  TextFilter,
  type ColumnSpec,
} from '@/components/business';
import type { InvocationListItem } from '@/lib/api';
import { formatCost, formatNumber, formatTime } from '@/lib/format';
import { invocationsQuery } from '@/lib/queries';

const INVOCATION_STATES = [
  'queued',
  'running',
  'completed',
  'failed',
  'aborted',
  'outcome_unknown',
  'skipped_budget',
] as const;

function SideEffectBadge({ started }: { readonly started: boolean }): React.ReactElement {
  return started ? (
    <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">
      started
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
      none
    </span>
  );
}

const COLUMNS: readonly ColumnSpec<InvocationListItem>[] = [
  {
    key: 'id',
    title: 'ID',
    width: 220,
    render: (row) => (
      <Link
        to="/invocations/$invocationId"
        params={{ invocationId: row.id }}
        className="font-mono text-xs break-all underline-offset-4 hover:underline"
      >
        {row.id}
      </Link>
    ),
  },
  {
    key: 'state',
    title: 'State',
    render: (row) => <StateBadge state={row.state} />,
  },
  {
    key: 'chat',
    title: 'Chat',
    render: (row) => (
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">{row.chat.title ?? row.chat.telegram_chat_id}</div>
        <div className="text-muted-foreground text-xs">
          {row.chat.type}
          {row.chat.message_thread_id === 0 ? '' : ` · topic ${row.chat.message_thread_id}`}
        </div>
      </div>
    ),
  },
  {
    key: 'turns',
    title: 'Turns',
    align: 'right',
    render: (row) => String(row.turns_used),
  },
  {
    key: 'tools',
    title: 'Tools',
    align: 'right',
    render: (row) => String(row.tool_call_count),
  },
  {
    key: 'sends',
    title: 'Sends',
    align: 'right',
    render: (row) => String(row.sends_used),
  },
  {
    key: 'tokens',
    title: 'Tokens',
    align: 'right',
    render: (row) => formatNumber(row.total_tokens),
  },
  {
    key: 'cost',
    title: 'Cost',
    align: 'right',
    render: (row) => formatCost(row.total_cost),
  },
  {
    key: 'side-effect',
    title: 'Side effect',
    render: (row) => <SideEffectBadge started={row.side_effect_started} />,
  },
  {
    key: 'created',
    title: 'Created',
    render: (row) => formatTime(row.created_at),
  },
];

export default function InvocationsPage(): React.ReactElement {
  const [state, setState] = useState<string | undefined>(undefined);
  const [chat, setChat] = useState<string | undefined>(undefined);
  const filters = useMemo(() => ({ state, chat }), [state, chat]);

  return (
    <div className="space-y-4">
      <FilterToolbar>
        <SelectFilter
          placeholder="State"
          value={state}
          onChange={setState}
          options={INVOCATION_STATES.map((value) => ({ value, label: value }))}
        />
        <TextFilter placeholder="Telegram chat ID" value={chat} onCommit={setChat} onClear={() => setChat(undefined)} />
      </FilterToolbar>
      <CursorList
        factory={invocationsQuery}
        filters={filters}
        renderItems={(items) => (
          <TableShell columns={COLUMNS} data={items} rowKey={(row) => row.id} className="max-w-full overflow-x-auto" />
        )}
      />
    </div>
  );
}
