import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ChatFilter,
  CursorList,
  FilterToolbar,
  LIST_TABLE_CLASS,
  SelectFilter,
  StateBadge,
  TableShell,
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

const COLUMNS: readonly ColumnSpec<InvocationListItem>[] = [
  {
    key: 'id',
    title: 'ID',
    render: (row) => (
      <Link
        to="/invocations/$invocationId"
        params={{ invocationId: row.id }}
        className="decoration-border hover:decoration-foreground font-medium tabular-nums underline underline-offset-4 transition-colors"
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
    className: 'tabular-nums',
    render: (row) => String(row.turns_used),
  },
  {
    key: 'tools',
    title: 'Tools',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => String(row.tool_call_count),
  },
  {
    key: 'sends',
    title: 'Sends',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => String(row.sends_used),
  },
  {
    key: 'tokens',
    title: 'Tokens',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatNumber(row.total_tokens),
  },
  {
    key: 'cost',
    title: 'Cost',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatCost(row.total_cost),
  },
  {
    key: 'side-effect',
    title: 'Side effect',
    className: 'ps-6',
    render: (row) => (row.side_effect_started ? 'started' : <span className="text-muted-foreground">none</span>),
  },
  {
    key: 'created',
    title: 'Created',
    className: 'text-muted-foreground',
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
        <ChatFilter value={chat} onChange={setChat} />
      </FilterToolbar>
      <p className="text-muted-foreground text-xs">
        Tokens counts the prompt tokens a call had to process plus the tokens it generated. Cache reads and writes are
        excluded from that total and from the daily budget; they are listed per model call on the invocation page.
      </p>
      <CursorList
        factory={invocationsQuery}
        filters={filters}
        renderItems={(items) => (
          <TableShell columns={COLUMNS} data={items} rowKey={(row) => row.id} className={LIST_TABLE_CLASS} />
        )}
      />
    </div>
  );
}
