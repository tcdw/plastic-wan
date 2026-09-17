import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  ChatFilter,
  type ColumnSpec,
  CursorList,
  FilterToolbar,
  LIST_TABLE_CLASS,
  TableShell,
  TextFilter,
  ToneBadge,
} from '@/components/business';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import type { MessageListItem } from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { messagesQuery } from '@/lib/queries';

function nonEmpty(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

const ID_LINK =
  'decoration-border hover:decoration-foreground font-medium tabular-nums underline underline-offset-4 transition-colors';

function SenderCell({ row }: { readonly row: MessageListItem }): React.ReactElement {
  if (row.sender === null) {
    return row.sent_by_bot ? (
      <ToneBadge tone="neutral">bot</ToneBadge>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="break-words">{row.sender.display_name}</span>
      {row.sender.is_bot === true ? <ToneBadge tone="neutral">bot</ToneBadge> : null}
    </div>
  );
}

/** Text or caption; non-text kinds carry a neutral kind badge so a sticker row isn't just a dash. */
function MessageCell({ row }: { readonly row: MessageListItem }): React.ReactElement {
  const body = row.text ?? row.caption;
  const showKind = row.kind !== null && row.kind !== 'text';
  if (body === null && !showKind) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex max-w-md items-start gap-2">
      {showKind ? <ToneBadge tone="neutral">{row.kind}</ToneBadge> : null}
      {body === null ? null : <p className="line-clamp-2 break-words">{body}</p>}
    </div>
  );
}

const COLUMNS: readonly ColumnSpec<MessageListItem>[] = [
  {
    key: 'id',
    title: 'ID',
    render: (row) => (
      <Link to="/messages/$messageId" params={{ messageId: row.id }} className={ID_LINK}>
        {row.id}
      </Link>
    ),
  },
  {
    key: 'chat',
    title: 'Chat',
    className: 'min-w-40',
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
  {
    key: 'text',
    title: 'Message',
    className: 'min-w-72 whitespace-normal',
    render: (row) => <MessageCell row={row} />,
  },
  {
    key: 'revision_count',
    title: 'Revisions',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatNumber(row.revision_count),
  },
  {
    key: 'media_count',
    title: 'Media',
    align: 'right',
    className: 'tabular-nums',
    render: (row) => formatNumber(row.media_count),
  },
  {
    key: 'telegram_message_id',
    title: 'Telegram ID',
    className: 'text-muted-foreground ps-6 tabular-nums',
    render: (row) => row.telegram_message_id,
  },
  {
    key: 'received_at',
    title: 'Received',
    className: 'text-muted-foreground',
    render: (row) => formatTime(row.received_at),
  },
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
          <TableShell columns={COLUMNS} data={items} rowKey={(row) => row.id} className={LIST_TABLE_CLASS} />
        )}
      />
    </div>
  );
}
