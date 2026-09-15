import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { type ColumnSpec, CursorList, FilterToolbar, TableShell, TextFilter } from '@/components/business';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import type { ConversationContextListItem } from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { conversationContextsQuery } from '@/lib/queries';

/** TextFilter commits a trimmed string; an empty commit means "no filter". */
function nonEmpty(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

const COLUMNS: readonly ColumnSpec<ConversationContextListItem>[] = [
  {
    key: 'chat',
    title: 'Chat/Topic',
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
    key: 'conversation',
    title: 'Conversation',
    render: (row) => (
      <Link
        to="/contexts/$conversationId"
        params={{ conversationId: row.conversation_id }}
        className="font-mono text-xs break-all underline-offset-4 hover:underline"
      >
        {row.conversation_id}
      </Link>
    ),
  },
  {
    key: 'window',
    title: 'Seq window',
    render: (row) => (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
        {row.head_seq}–{row.next_seq}
      </code>
    ),
  },
  {
    key: 'message_count',
    title: 'Messages',
    align: 'right',
    render: (row) => formatNumber(row.message_count),
  },
  {
    key: 'send_count_total',
    title: 'Sends',
    align: 'right',
    render: (row) => formatNumber(row.send_count_total),
  },
  { key: 'last_active_at', title: 'Last active', render: (row) => formatTime(row.last_active_at) },
  { key: 'last_gc_at', title: 'Last GC', render: (row) => formatTime(row.last_gc_at) },
  {
    key: 'active_invocation',
    title: 'Active session',
    render: (row) =>
      row.active_invocation_id === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <Link
          to="/invocations/$invocationId"
          params={{ invocationId: row.active_invocation_id }}
          className="font-mono text-xs break-all underline-offset-4 hover:underline"
        >
          Tool session {row.active_invocation_id}
        </Link>
      ),
  },
];

export default function ContextsPage(): React.ReactElement {
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [chat, setChat] = useState<string | undefined>(undefined);
  const [conversation, setConversation] = useState<string | undefined>(undefined);
  const filters = useMemo(() => ({ search, chat, conversation }), [search, chat, conversation]);

  return (
    <div className="space-y-4">
      <FilterToolbar>
        <TextFilter
          placeholder="Chat title or username"
          value={search}
          onCommit={(value) => setSearch(nonEmpty(value))}
          onClear={() => setSearch(undefined)}
        />
        <TextFilter
          placeholder="Telegram chat ID"
          value={chat}
          onCommit={(value) => setChat(nonEmpty(value))}
          onClear={() => setChat(undefined)}
        />
        <TextFilter
          placeholder="Conversation ID"
          value={conversation}
          onCommit={(value) => setConversation(nonEmpty(value))}
          onClear={() => setConversation(undefined)}
        />
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
            className="max-w-full overflow-x-auto"
          />
        )}
      />
    </div>
  );
}
