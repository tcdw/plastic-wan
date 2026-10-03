import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  CursorList,
  FilterToolbar,
  LIST_TABLE_CLASS,
  SelectFilter,
  StateBadge,
  TableShell,
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

export default function InvocationsPage(): React.ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<string | undefined>(undefined);
  const [chat, setChat] = useState<string | undefined>(undefined);
  const filters = useMemo(() => ({ state, chat }), [state, chat]);

  const COLUMNS: readonly ColumnSpec<InvocationListItem>[] = [
    {
      key: 'id',
      title: t('invocations.invocations.columns.id'),
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
      title: t('invocations.invocations.columns.state'),
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'chat',
      title: t('invocations.invocations.columns.chat'),
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
      title: t('invocations.invocations.columns.turns'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => String(row.turns_used),
    },
    {
      key: 'tools',
      title: t('invocations.invocations.columns.tools'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => String(row.tool_call_count),
    },
    {
      key: 'sends',
      title: t('invocations.invocations.columns.sends'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => String(row.sends_used),
    },
    {
      key: 'tokens',
      title: t('invocations.invocations.columns.tokens'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.total_tokens),
    },
    {
      key: 'cost',
      title: t('invocations.invocations.columns.cost'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatCost(row.total_cost),
    },
    {
      key: 'side-effect',
      title: t('invocations.invocations.columns.sideEffect'),
      className: 'ps-6',
      render: (row) => (row.side_effect_started ? 'started' : <span className="text-muted-foreground">none</span>),
    },
    {
      key: 'created',
      title: t('invocations.invocations.columns.created'),
      className: 'text-muted-foreground',
      render: (row) => formatTime(row.created_at),
    },
  ];

  return (
    <div className="space-y-4">
      <FilterToolbar>
        <SelectFilter
          placeholder={t('invocations.invocations.statePlaceholder')}
          value={state}
          onChange={setState}
          options={INVOCATION_STATES.map((value) => ({ value, label: value }))}
        />
        <ChatFilter value={chat} onChange={setChat} />
      </FilterToolbar>
      <p className="text-muted-foreground text-xs">{t('invocations.invocations.tokensNote')}</p>
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
