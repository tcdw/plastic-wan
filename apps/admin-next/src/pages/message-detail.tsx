import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  DetailError,
  DetailSkeleton,
  type ColumnSpec,
  JsonViewer,
  KvList,
  MonoValue,
  TableShell,
  TextValue,
  ToneBadge,
} from '@/components/business';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { MediaEntry, MessageDetail, RevisionEntry } from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { messageQuery } from '@/lib/queries';

function YesNoBadge({ value }: { readonly value: boolean }): React.ReactElement {
  return value ? <ToneBadge tone="success">yes</ToneBadge> : <ToneBadge tone="neutral">no</ToneBadge>;
}

function DetailHeader({ message }: { readonly message: MessageDetail }): React.ReactElement {
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="flex-row items-start justify-between gap-4 px-5 py-0">
        <CardTitle className="font-mono text-base break-all">Message {message.id}</CardTitle>
        <Link to="/messages" className="text-primary shrink-0 text-sm underline-offset-4 hover:underline">
          Back to list
        </Link>
      </CardHeader>
      <CardContent className="space-y-4 px-5 py-0">
        <KvList
          items={[
            { label: 'Telegram message ID', value: <MonoValue value={message.telegram_message_id} /> },
            { label: 'Chat', value: <TextValue value={message.chat.title ?? message.chat.telegram_chat_id} /> },
            { label: 'Chat ID', value: <MonoValue value={message.chat.telegram_chat_id} /> },
            { label: 'Chat type', value: <TextValue value={message.chat.type} /> },
            { label: 'Topic', value: String(message.chat.message_thread_id) },
            { label: 'Visible', value: <YesNoBadge value={message.visible} /> },
            { label: 'Sent by bot', value: <YesNoBadge value={message.sent_by_bot} /> },
            { label: 'Telegram date', value: formatTime(message.telegram_date) },
            { label: 'Received', value: formatTime(message.received_at) },
          ]}
        />
      </CardContent>
    </Card>
  );
}

const REVISION_COLUMNS: readonly ColumnSpec<RevisionEntry>[] = [
  { key: 'revision_no', title: '#', align: 'right', width: 60, render: (row) => String(row.revision_no) },
  { key: 'kind', title: 'Kind', render: (row) => row.kind },
  {
    key: 'sender',
    title: 'Sender',
    render: (row) => <TextValue value={row.sender?.display_name ?? null} />,
  },
  {
    key: 'text',
    title: 'Text',
    className: 'min-w-72 max-w-2xl whitespace-normal',
    render: (row) => (
      <p className="max-w-2xl text-sm break-words whitespace-pre-wrap">{row.text ?? row.caption ?? '—'}</p>
    ),
  },
  {
    key: 'reply_to_message_id',
    title: 'Reply to',
    render: (row) => <TextValue value={row.reply_to_message_id} />,
  },
  { key: 'created_at', title: 'Created', render: (row) => formatTime(row.created_at) },
];

function RevisionsTable({ message }: { readonly message: MessageDetail }): React.ReactElement {
  return (
    <TableShell
      columns={REVISION_COLUMNS}
      data={message.revisions}
      rowKey={(row) => row.id}
      emptyText="No revisions."
      expandedRender={(row) => (
        <div className="space-y-2">
          <div>
            <p className="text-muted-foreground mb-1 text-xs">Reply snapshot</p>
            <JsonViewer value={row.reply_snapshot_json} />
          </div>
          <div>
            <p className="text-muted-foreground mb-1 text-xs">Forward origin</p>
            <JsonViewer value={row.forward_origin_json} />
          </div>
          <div>
            <p className="text-muted-foreground mb-1 text-xs">Service payload</p>
            <JsonViewer value={row.service_json} />
          </div>
        </div>
      )}
    />
  );
}

const MEDIA_COLUMNS: readonly ColumnSpec<MediaEntry>[] = [
  { key: 'kind', title: 'Kind', render: (row) => row.kind },
  {
    key: 'file_unique_id',
    title: 'File unique ID',
    render: (row) => (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">{row.file_unique_id}</code>
    ),
  },
  { key: 'mime_type', title: 'MIME', render: (row) => <TextValue value={row.mime_type} /> },
  {
    key: 'file_size',
    title: 'Size',
    align: 'right',
    render: (row) => formatNumber(row.file_size),
  },
  {
    key: 'dimensions',
    title: 'Dimensions',
    render: (row) =>
      row.width === null || row.height === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        `${row.width}×${row.height}`
      ),
  },
  {
    key: 'analysis',
    title: 'Media analysis',
    className: 'min-w-56 max-w-md',
    render: (row) => <TextValue value={row.analysis_description ?? row.analysis_state} />,
  },
];

function MediaTable({ message }: { readonly message: MessageDetail }): React.ReactElement {
  return <TableShell columns={MEDIA_COLUMNS} data={message.media} rowKey={(row) => row.id} emptyText="No media." />;
}

export function MessageDetailView({ id }: { readonly id: string }): React.ReactElement {
  const { data, isPending, isError, error } = useQuery(messageQuery(id));

  if (isPending) {
    return <DetailSkeleton />;
  }
  if (isError) {
    return (
      <DetailError
        error={error}
        notFoundTitle="Message not found"
        failedTitle="Failed to load message"
        backTo="/messages"
        backLabel="Back to messages"
      />
    );
  }
  if (data === undefined) {
    return (
      <DetailError
        error={new Error('Message data is missing')}
        notFoundTitle="Message not found"
        failedTitle="Failed to load message"
        backTo="/messages"
        backLabel="Back to messages"
      />
    );
  }

  return (
    <div className="space-y-4">
      <DetailHeader message={data} />
      <Card>
        <CardHeader>
          <CardTitle>Revisions ({data.revisions.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <RevisionsTable message={data} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Media ({data.media.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <MediaTable message={data} />
        </CardContent>
      </Card>
    </div>
  );
}
