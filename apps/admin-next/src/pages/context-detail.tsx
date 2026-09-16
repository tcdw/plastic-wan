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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import type {
  ConversationContextDetail,
  ConversationContextMessageEntry,
  ConversationContextRefEntry,
} from '@/lib/api';
import { formatNumber, formatTime } from '@/lib/format';
import { conversationContextQuery } from '@/lib/queries';

function RoleBadge({ role }: { readonly role: string }): React.ReactElement {
  return <ToneBadge tone="neutral">{role}</ToneBadge>;
}

function CheckpointBadge({ isCheckpoint }: { readonly isCheckpoint: boolean }): React.ReactElement {
  if (!isCheckpoint) {
    return <span className="text-muted-foreground">—</span>;
  }
  return <ToneBadge tone="info">checkpoint</ToneBadge>;
}

function InvocationLink({ id }: { readonly id: string | null }): React.ReactElement {
  if (id === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <Link
      to="/invocations/$invocationId"
      params={{ invocationId: id }}
      className="font-mono text-xs break-all underline-offset-4 hover:underline"
    >
      {id}
    </Link>
  );
}

const MESSAGE_COLUMNS: readonly ColumnSpec<ConversationContextMessageEntry>[] = [
  { key: 'seq', title: 'Seq', align: 'right', width: 70, render: (row) => String(row.seq) },
  { key: 'role', title: 'Role', render: (row) => <RoleBadge role={row.role} /> },
  { key: 'checkpoint', title: 'Checkpoint', render: (row) => <CheckpointBadge isCheckpoint={row.is_checkpoint} /> },
  {
    key: 'send_seq',
    title: 'Send seq',
    align: 'right',
    render: (row) => (row.send_seq === null ? <span className="text-muted-foreground">—</span> : String(row.send_seq)),
  },
  { key: 'est_tokens', title: 'Est. tokens', align: 'right', render: (row) => formatNumber(row.est_tokens) },
  { key: 'invocation', title: 'Session', render: (row) => <InvocationLink id={row.invocation_id} /> },
  { key: 'evicted_at', title: 'Evicted', render: (row) => formatTime(row.evicted_at) },
  { key: 'created_at', title: 'Created', render: (row) => formatTime(row.created_at) },
];

function RetainedMessages({ context }: { readonly context: ConversationContextDetail }): React.ReactElement {
  if (context.messages.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No retained messages</EmptyTitle>
          <EmptyDescription>The retention window for this conversation is empty.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <TableShell
      columns={MESSAGE_COLUMNS}
      data={context.messages}
      rowKey={(row) => String(row.seq)}
      expandedRender={(row) => (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">Payload preview</p>
          <JsonViewer value={row.payload_preview} />
          {row.payload_truncated ? (
            <p className="text-muted-foreground text-xs">Preview truncated; the stored payload is longer.</p>
          ) : null}
        </div>
      )}
    />
  );
}

const REF_COLUMNS: readonly ColumnSpec<ConversationContextRefEntry>[] = [
  {
    key: 'ref',
    title: 'Ref',
    render: (row) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">{row.ref}</code>,
  },
  { key: 'kind', title: 'Kind', render: (row) => <RoleBadge role={row.kind} /> },
  { key: 'source_seq', title: 'Source seq', align: 'right', render: (row) => String(row.source_seq) },
  { key: 'expires_at', title: 'Expires', render: (row) => formatTime(row.expires_at) },
];

function CapabilityRefs({ context }: { readonly context: ConversationContextDetail }): React.ReactElement {
  if (context.refs.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No live capability refs</EmptyTitle>
          <EmptyDescription>
            No media or reply capabilities are currently authorized for this conversation.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <TableShell columns={REF_COLUMNS} data={context.refs} rowKey={(row) => row.ref} />;
}

export function ContextDetailView({ id }: { readonly id: string }): React.ReactElement {
  const { data, isPending, isError, error } = useQuery(conversationContextQuery(id));

  if (isPending) {
    return <DetailSkeleton />;
  }
  if (isError) {
    return (
      <DetailError
        error={error}
        notFoundTitle="Conversation context not found"
        failedTitle="Failed to load conversation context"
        backTo="/contexts"
        backLabel="Back to conversation contexts"
      />
    );
  }
  if (data === undefined) {
    return (
      <DetailError
        error={new Error('Conversation context data is missing')}
        notFoundTitle="Conversation context not found"
        failedTitle="Failed to load conversation context"
        backTo="/contexts"
        backLabel="Back to conversation contexts"
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card className="gap-4 py-5">
        <CardHeader className="flex-row items-start justify-between gap-4 px-5 py-0">
          <CardTitle className="font-mono text-base break-all">Conversation context {data.conversation_id}</CardTitle>
          <Link to="/contexts" className="text-primary shrink-0 text-sm underline-offset-4 hover:underline">
            Back to list
          </Link>
        </CardHeader>
        <CardContent className="space-y-4 px-5 py-0">
          <KvList
            items={[
              { label: 'Conversation ID', value: <MonoValue value={data.conversation_id} /> },
              { label: 'Chat', value: <TextValue value={data.chat_title ?? data.telegram_chat_id} /> },
              { label: 'Chat ID', value: <MonoValue value={data.telegram_chat_id} /> },
              { label: 'Chat type', value: <TextValue value={data.chat_type} /> },
              { label: 'Topic', value: String(data.message_thread_id) },
              { label: 'Sends (total)', value: formatNumber(data.send_count_total) },
              { label: 'Head seq', value: formatNumber(data.head_seq) },
              { label: 'Next seq', value: formatNumber(data.next_seq) },
              { label: 'Retained messages', value: formatNumber(data.message_count) },
              { label: 'Last active', value: formatTime(data.last_active_at) },
              { label: 'Last GC', value: formatTime(data.last_gc_at) },
              { label: 'Active session', value: <InvocationLink id={data.active_invocation_id} /> },
              { label: 'System prompt hash', value: <MonoValue value={data.system_prompt_hash} /> },
              { label: 'Created', value: formatTime(data.created_at) },
              { label: 'Updated', value: formatTime(data.updated_at) },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Retained messages ({data.messages.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <RetainedMessages context={data} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Capability refs ({data.refs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <CapabilityRefs context={data} />
        </CardContent>
      </Card>
    </div>
  );
}
