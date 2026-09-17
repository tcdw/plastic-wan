import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  ChatFilter,
  type ColumnSpec,
  CursorList,
  FilterToolbar,
  LIST_TABLE_CLASS,
  TableShell,
} from '@/components/business';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import type { ConversationContextListItem } from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { conversationContextsQuery } from '@/lib/queries';

const ID_LINK =
  'decoration-border hover:decoration-foreground font-medium tabular-nums underline underline-offset-4 transition-colors';

const COLUMNS: readonly ColumnSpec<ConversationContextListItem>[] = [
  {
    key: 'conversation',
    title: 'ID',
    render: (row) => (
      <Link to="/contexts/$conversationId" params={{ conversationId: row.conversation_id }} className={ID_LINK}>
        {row.conversation_id}
      </Link>
    ),
  },
  {
    key: 'chat',
    title: 'Chat',
    className: 'min-w-48',
    render: (row) => (
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium break-words">{row.chat_title ?? row.telegram_chat_id}</div>
        <div className="text-muted-foreground text-xs">
          {row.chat_type}
          {row.message_thread_id === 0 ? '' : ` · topic ${row.message_thread_id}`}
        </div>
      </div>
    ),
  },
  {
    key: 'window',
    title: 'Seq window',
    className: 'tabular-nums',
    render: (row) => `${row.head_seq}–${row.next_seq}`,
  },
  {
    key: 'message_count',
    title: 'Messages',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatNumber(row.message_count),
  },
  {
    key: 'send_count_total',
    title: 'Sends',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatNumber(row.send_count_total),
  },
  {
    key: 'active_invocation',
    title: 'Active session',
    className: 'ps-6',
    render: (row) =>
      row.active_invocation_id === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <Link to="/invocations/$invocationId" params={{ invocationId: row.active_invocation_id }} className={ID_LINK}>
          {row.active_invocation_id}
        </Link>
      ),
  },
  {
    key: 'last_active_at',
    title: 'Last active',
    className: 'text-muted-foreground',
    render: (row) => formatTime(row.last_active_at),
  },
  {
    key: 'last_gc_at',
    title: 'Last GC',
    className: 'text-muted-foreground',
    render: (row) => formatTime(row.last_gc_at),
  },
];

export default function ContextsPage(): React.ReactElement {
  const [chat, setChat] = useState<string | undefined>(undefined);
  const filters = useMemo(() => ({ chat }), [chat]);

  return (
    <div className="space-y-4">
      <FilterToolbar>
        <ChatFilter value={chat} onChange={setChat} />
      </FilterToolbar>
      <CursorList
        factory={conversationContextsQuery}
        filters={filters}
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No conversation contexts</EmptyTitle>
              <EmptyDescription>No conversation contexts match these filters.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
        renderItems={(items) => (
          <TableShell
            columns={COLUMNS}
            data={items}
            rowKey={(row) => row.conversation_id}
            className={LIST_TABLE_CLASS}
          />
        )}
      />
    </div>
  );
}
