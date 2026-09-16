import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  ChatFilter,
  type ColumnSpec,
  CursorList,
  FilterToolbar,
  MonoValue,
  TableShell,
  TextFilter,
  TextValue,
} from '@/components/business';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import type { MessageListItem } from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { messagesQuery } from '@/lib/queries';

function nonEmpty(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

function BotTag(): React.ReactElement {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
      bot
    </span>
  );
}

function SenderCell({ row }: { readonly row: MessageListItem }): React.ReactElement {
  if (row.sender === null) {
    return row.sent_by_bot ? <BotTag /> : <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="break-words">{row.sender.display_name}</span>
      {row.sender.is_bot === true ? <BotTag /> : null}
    </div>
  );
}

const COLUMNS: readonly ColumnSpec<MessageListItem>[] = [
  {
    key: 'id',
    title: 'ID',
    width: 220,
    render: (row) => (
      <Link
        to="/messages/$messageId"
        params={{ messageId: row.id }}
        className="font-mono text-xs break-all underline-offset-4 hover:underline"
      >
        {row.id}
      </Link>
    ),
  },
  { key: 'telegram_message_id', title: 'Telegram ID', render: (row) => <MonoValue value={row.telegram_message_id} /> },
  {
    key: 'chat',
    title: 'Chat',
    className: 'min-w-48',
    render: (row) => (
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium break-words">{row.chat.title ?? row.chat.telegram_chat_id}</div>
        <div className="text-muted-foreground text-xs">
          {row.chat.type}
          {row.chat.message_thread_id === 0 ? '' : ` · topic ${row.chat.message_thread_id}`}
        </div>
      </div>
    ),
  },
  { key: 'sender', title: 'Sender', render: (row) => <SenderCell row={row} /> },
  { key: 'kind', title: 'Kind', render: (row) => <TextValue value={row.kind} /> },
  {
    key: 'text',
    title: 'Text',
    className: 'min-w-72 max-w-md whitespace-normal',
    render: (row) => (
      <p className="max-w-md text-sm break-words line-clamp-2">
        {row.text ?? row.caption ?? <span className="text-muted-foreground">—</span>}
      </p>
    ),
  },
  { key: 'revision_count', title: 'Revisions', align: 'right', render: (row) => formatNumber(row.revision_count) },
  { key: 'media_count', title: 'Media', align: 'right', render: (row) => formatNumber(row.media_count) },
  { key: 'received_at', title: 'Received', render: (row) => formatTime(row.received_at) },
];

export default function MessagesPage(): React.ReactElement {
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [chat, setChat] = useState<string | undefined>(undefined);
  const filters = useMemo(() => ({ search, chat }), [search, chat]);

  return (
    <div className="space-y-4">
      <FilterToolbar>
        <TextFilter
          placeholder="Search text or caption"
          value={search}
          onCommit={(value) => setSearch(nonEmpty(value))}
          onClear={() => setSearch(undefined)}
          widthClassName="w-72"
        />
        <ChatFilter value={chat} onChange={setChat} />
      </FilterToolbar>
      <CursorList
        factory={messagesQuery}
        filters={filters}
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No messages</EmptyTitle>
              <EmptyDescription>No messages match the current filters.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
        renderItems={(items) => (
          <TableShell columns={COLUMNS} data={items} rowKey={(row) => row.id} className="max-w-full overflow-x-auto" />
        )}
      />
    </div>
  );
}
