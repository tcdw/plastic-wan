import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  DetailError,
  DetailSkeleton,
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
  const { t } = useTranslation();
  if (!isCheckpoint) {
    return <span className="text-muted-foreground">—</span>;
  }
  return <ToneBadge tone="info">{t('invocations.contextDetail.checkpoint')}</ToneBadge>;
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

function RetainedMessages({ context }: { readonly context: ConversationContextDetail }): React.ReactElement {
  const { t } = useTranslation();
  if (context.messages.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t('invocations.contextDetail.emptyMessages.title')}</EmptyTitle>
          <EmptyDescription>{t('invocations.contextDetail.emptyMessages.description')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const MESSAGE_COLUMNS: readonly ColumnSpec<ConversationContextMessageEntry>[] = [
    {
      key: 'seq',
      title: t('invocations.contextDetail.messageColumns.seq'),
      align: 'right',
      width: 70,
      render: (row) => String(row.seq),
    },
    {
      key: 'role',
      title: t('invocations.contextDetail.messageColumns.role'),
      render: (row) => <RoleBadge role={row.role} />,
    },
    {
      key: 'checkpoint',
      title: t('invocations.contextDetail.messageColumns.checkpoint'),
      render: (row) => <CheckpointBadge isCheckpoint={row.is_checkpoint} />,
    },
    {
      key: 'send_seq',
      title: t('invocations.contextDetail.messageColumns.sendSeq'),
      align: 'right',
      render: (row) =>
        row.send_seq === null ? <span className="text-muted-foreground">—</span> : String(row.send_seq),
    },
    {
      key: 'est_tokens',
      title: t('invocations.contextDetail.messageColumns.estTokens'),
      align: 'right',
      render: (row) => formatNumber(row.est_tokens),
    },
    {
      key: 'invocation',
      title: t('invocations.contextDetail.messageColumns.session'),
      render: (row) => <InvocationLink id={row.invocation_id} />,
    },
    {
      key: 'evicted_at',
      title: t('invocations.contextDetail.messageColumns.evicted'),
      render: (row) => formatTime(row.evicted_at),
    },
    {
      key: 'created_at',
      title: t('invocations.contextDetail.messageColumns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];
  return (
    <TableShell
      columns={MESSAGE_COLUMNS}
      data={context.messages}
      rowKey={(row) => String(row.seq)}
      expandedRender={(row) => (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">{t('invocations.contextDetail.payloadPreview')}</p>
          <JsonViewer value={row.payload_preview} />
          {row.payload_truncated ? (
            <p className="text-muted-foreground text-xs">{t('invocations.contextDetail.previewTruncated')}</p>
          ) : null}
        </div>
      )}
    />
  );
}

function CapabilityRefs({ context }: { readonly context: ConversationContextDetail }): React.ReactElement {
  const { t } = useTranslation();
  if (context.refs.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t('invocations.contextDetail.emptyRefs.title')}</EmptyTitle>
          <EmptyDescription>{t('invocations.contextDetail.emptyRefs.description')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const REF_COLUMNS: readonly ColumnSpec<ConversationContextRefEntry>[] = [
    {
      key: 'ref',
      title: t('invocations.contextDetail.refColumns.ref'),
      render: (row) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">{row.ref}</code>,
    },
    {
      key: 'kind',
      title: t('invocations.contextDetail.refColumns.kind'),
      render: (row) => <RoleBadge role={row.kind} />,
    },
    {
      key: 'source_seq',
      title: t('invocations.contextDetail.refColumns.sourceSeq'),
      align: 'right',
      render: (row) => String(row.source_seq),
    },
    {
      key: 'expires_at',
      title: t('invocations.contextDetail.refColumns.expires'),
      render: (row) => formatTime(row.expires_at),
    },
  ];
  return <TableShell columns={REF_COLUMNS} data={context.refs} rowKey={(row) => row.ref} />;
}

export function ContextDetailView({ id }: { readonly id: string }): React.ReactElement {
  const { t } = useTranslation();
  const { data, isPending, isError, error } = useQuery(conversationContextQuery(id));

  if (isPending) {
    return <DetailSkeleton />;
  }
  if (isError) {
    return (
      <DetailError
        error={error}
        notFoundTitle={t('invocations.contextDetail.notFound')}
        failedTitle={t('invocations.contextDetail.loadFailed')}
        backTo="/contexts"
        backLabel={t('invocations.contextDetail.backToContexts')}
      />
    );
  }
  if (data === undefined) {
    return (
      <DetailError
        error={new Error(t('invocations.contextDetail.dataMissing'))}
        notFoundTitle={t('invocations.contextDetail.notFound')}
        failedTitle={t('invocations.contextDetail.loadFailed')}
        backTo="/contexts"
        backLabel={t('invocations.contextDetail.backToContexts')}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card className="gap-4 py-5">
        <CardHeader className="flex-row items-start justify-between gap-4 px-5 py-0">
          <CardTitle className="font-mono text-base break-all">
            {t('invocations.contextDetail.title', { id: data.conversation_id })}
          </CardTitle>
          <Link to="/contexts" className="text-primary shrink-0 text-sm underline-offset-4 hover:underline">
            {t('invocations.contextDetail.backToList')}
          </Link>
        </CardHeader>
        <CardContent className="space-y-4 px-5 py-0">
          <KvList
            items={[
              {
                label: t('invocations.contextDetail.kv.conversationId'),
                value: <MonoValue value={data.conversation_id} />,
              },
              {
                label: t('invocations.contextDetail.kv.chat'),
                value: <TextValue value={data.chat_title ?? data.telegram_chat_id} />,
              },
              { label: t('invocations.contextDetail.kv.chatId'), value: <MonoValue value={data.telegram_chat_id} /> },
              { label: t('invocations.contextDetail.kv.chatType'), value: <TextValue value={data.chat_type} /> },
              { label: t('invocations.contextDetail.kv.topic'), value: String(data.message_thread_id) },
              { label: t('invocations.contextDetail.kv.sendsTotal'), value: formatNumber(data.send_count_total) },
              { label: t('invocations.contextDetail.kv.headSeq'), value: formatNumber(data.head_seq) },
              { label: t('invocations.contextDetail.kv.nextSeq'), value: formatNumber(data.next_seq) },
              { label: t('invocations.contextDetail.kv.retainedMessages'), value: formatNumber(data.message_count) },
              { label: t('invocations.contextDetail.kv.lastActive'), value: formatTime(data.last_active_at) },
              { label: t('invocations.contextDetail.kv.lastGc'), value: formatTime(data.last_gc_at) },
              {
                label: t('invocations.contextDetail.kv.activeSession'),
                value: <InvocationLink id={data.active_invocation_id} />,
              },
              {
                label: t('invocations.contextDetail.kv.systemPromptHash'),
                value: <MonoValue value={data.system_prompt_hash} />,
              },
              { label: t('invocations.contextDetail.kv.created'), value: formatTime(data.created_at) },
              { label: t('invocations.contextDetail.kv.updated'), value: formatTime(data.updated_at) },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('invocations.contextDetail.messagesTitle', { count: data.messages.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          <RetainedMessages context={data} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('invocations.contextDetail.refsTitle', { count: data.refs.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          <CapabilityRefs context={data} />
        </CardContent>
      </Card>
    </div>
  );
}
