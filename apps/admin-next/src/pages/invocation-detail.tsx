import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type React from 'react';
import {
  DetailError,
  DetailSkeleton,
  JsonViewer,
  KvList,
  LazyDetails,
  MonoValue,
  PrivateReasoningNote,
  PrivateReasoningTag,
  StateBadge,
  TableShell,
  TextValue,
  type ColumnSpec,
} from '@/components/business';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  AgentMessageEntry,
  ContextMessageEntry,
  InvocationDetail,
  ModelCallEntry,
  TelegramSendEntry,
  ToolCallEntry,
  ToolRegistryEntry,
} from '@/lib/api';
import { formatCost, formatDuration, formatNumber, formatTime } from '@/lib/format';
import { invocationQuery } from '@/lib/queries';
import {
  buildInvocationTimeline,
  isNewContextSection,
  objectField,
  parseJsonObject,
  parseSendArguments,
  stringField,
  timelineEventKey,
  type InvocationTimelineEvent,
  type ParsedSendArguments,
} from '@/lib/timeline';
import { cn } from '@/lib/utils';

function TabEmpty({ message }: { readonly message: string }): React.ReactElement {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Nothing here</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function TabContent({
  count,
  message,
  children,
}: {
  readonly count: number;
  readonly message: string;
  readonly children: React.ReactNode;
}): React.ReactNode {
  if (count === 0) {
    return <TabEmpty message={message} />;
  }
  return <>{children}</>;
}

// --- Small shared renderers -------------------------------------------------

const ROLE_BADGE_CLASSES: Record<string, string> = {
  assistant: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  tool_result: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  harness_nudge: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
};

function RoleBadge({ role }: { readonly role: string }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        ROLE_BADGE_CLASSES[role] ?? 'border-border bg-muted text-muted-foreground',
      )}
    >
      {role}
    </span>
  );
}

function SectionBadge({ section }: { readonly section: string }): React.ReactElement {
  const isNew = isNewContextSection(section);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        isNew
          ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
          : 'border-border bg-muted text-muted-foreground',
      )}
    >
      {isNew ? 'Incoming message' : 'Context history'}
    </span>
  );
}

function YesNoBadge({ value }: { readonly value: boolean }): React.ReactElement {
  return value ? (
    <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">
      yes
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
      no
    </span>
  );
}

// --- Header card + tool registry --------------------------------------------

function ToolRegistryTable({ registry }: { readonly registry: readonly ToolRegistryEntry[] }): React.ReactElement {
  const columns: readonly ColumnSpec<ToolRegistryEntry>[] = [
    {
      key: 'name',
      title: 'Name',
      render: (row) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{row.name}</code>,
    },
    { key: 'label', title: 'Label', render: (row) => row.label },
    {
      key: 'description',
      title: 'Description (as sent to the model)',
      className: 'min-w-64 max-w-2xl',
      render: (row) => <p className="max-w-2xl text-sm break-words">{row.description}</p>,
    },
  ];
  return (
    <LazyDetails
      summaryClassName="text-muted-foreground flex cursor-pointer items-center gap-2 text-sm"
      contentClassName="mt-2"
      summary={
        <>
          Tool registry
          <span className="text-xs">Snapshot of the tools presented to the model</span>
        </>
      }
    >
      <TableShell columns={columns} data={registry} rowKey={(row) => row.name} />
    </LazyDetails>
  );
}

function DetailHeader({ invocation }: { readonly invocation: InvocationDetail }): React.ReactElement {
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="flex-row items-start justify-between gap-4 px-5 py-0">
        <CardTitle className="font-mono text-base break-all">Invocation {invocation.id}</CardTitle>
        <Link to="/invocations" className="text-primary shrink-0 text-sm underline-offset-4 hover:underline">
          Back to list
        </Link>
      </CardHeader>
      <CardContent className="space-y-4 px-5 py-0">
        <KvList
          items={[
            { label: 'State', value: <StateBadge state={invocation.state} /> },
            { label: 'Completion reason', value: <TextValue value={invocation.completion_reason} /> },
            { label: 'Error code', value: <TextValue value={invocation.error_code} /> },
            { label: 'Chat', value: <TextValue value={invocation.chat.title ?? invocation.chat.telegram_chat_id} /> },
            { label: 'Chat ID', value: <MonoValue value={invocation.chat.telegram_chat_id} /> },
            { label: 'Topic', value: String(invocation.chat.message_thread_id) },
            { label: 'Bucket', value: <MonoValue value={invocation.bucket_id} /> },
            { label: 'Created', value: formatTime(invocation.created_at) },
            { label: 'Started', value: formatTime(invocation.started_at) },
            { label: 'Finished', value: formatTime(invocation.finished_at) },
            { label: 'Tokens', value: formatNumber(invocation.total_tokens) },
            { label: 'Cost', value: formatCost(invocation.total_cost) },
            { label: 'Config hash', value: <MonoValue value={invocation.config_hash.slice(0, 16)} /> },
            { label: 'Prompt version', value: String(invocation.prompt_version) },
            { label: 'Tool registry hash', value: <TextValue value={invocation.tool_registry_hash} /> },
          ]}
        />
        {invocation.tool_registry !== null && invocation.tool_registry.length > 0 ? (
          <ToolRegistryTable registry={invocation.tool_registry} />
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- Overview timeline --------------------------------------------------------

function TimelineCard({
  header,
  extra,
  children,
}: {
  readonly header: React.ReactNode;
  readonly extra?: string;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  return (
    <Card className="gap-2 py-3">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 px-3 py-0">
        <div className="flex flex-wrap items-center gap-1.5">{header}</div>
        {extra !== undefined ? <span className="text-muted-foreground text-xs">{extra}</span> : null}
      </CardHeader>
      {children !== undefined ? <CardContent className="space-y-2 px-3 py-0">{children}</CardContent> : null}
    </Card>
  );
}

function SendContent({
  parsed,
  send,
}: {
  readonly parsed: ParsedSendArguments;
  readonly send: TelegramSendEntry | null;
}): React.ReactElement {
  const content =
    parsed.kind === 'text'
      ? parsed.text
      : parsed.kind === 'sticker' && parsed.sticker_ref !== null
        ? `Sticker ${parsed.sticker_ref}`
        : null;
  return (
    <div className="space-y-1.5">
      {content === null ? (
        <p className="text-muted-foreground text-sm">No send content recorded</p>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{content}</p>
      )}
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
        {parsed.reply_to_message_id !== null ? (
          <span>Reply to Telegram message {parsed.reply_to_message_id}</span>
        ) : null}
        {send !== null ? (
          <>
            <span>Telegram delivery</span>
            <StateBadge state={send.state} />
            {send.telegram_message_id !== null ? <span>Message {send.telegram_message_id}</span> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ToolCallCard({
  tool,
  send,
}: {
  readonly tool: ToolCallEntry;
  readonly send: TelegramSendEntry | null;
}): React.ReactElement {
  const parsed = parseSendArguments(tool.arguments_json);
  return (
    <TimelineCard
      header={
        <>
          <span
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
              tool.tool_name === 'send'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
            )}
          >
            {tool.tool_name}
          </span>
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{tool.tool_call_id}</code>
          <StateBadge state={tool.state} />
        </>
      }
      extra={formatTime(tool.created_at)}
    >
      {tool.tool_name === 'send' ? <SendContent parsed={parsed} send={send} /> : null}
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
        <span>Duration {formatDuration(tool.duration_ms)}</span>
        {tool.error_code !== null ? <span className="text-destructive">Error {tool.error_code}</span> : null}
      </div>
      <LazyDetails
        summary="Arguments and result"
        summaryClassName="text-muted-foreground cursor-pointer text-xs"
        contentClassName="mt-2 space-y-2"
      >
        <JsonViewer value={tool.arguments_json} title="Arguments" />
        <JsonViewer value={tool.result_text} title="Result" />
      </LazyDetails>
    </TimelineCard>
  );
}

function ContextMessageCard({ message }: { readonly message: ContextMessageEntry }): React.ReactElement {
  const snapshot = parseJsonObject(message.snapshot_json);
  const sender = objectField(snapshot, 'sender');
  const username = stringField(sender, 'username');
  const senderName = stringField(sender, 'name') ?? (username === null ? 'Unknown sender' : `@${username}`);
  const telegramMessageId = stringField(snapshot, 'message_id');
  const kind = stringField(snapshot, 'kind') ?? 'message';
  const text = stringField(snapshot, 'text') ?? stringField(snapshot, 'caption');
  const media = snapshot?.media;
  const mediaCount = Array.isArray(media) ? media.length : 0;
  const sentByBot = snapshot?.sent_by_bot === true;
  return (
    <TimelineCard
      header={
        <>
          <SectionBadge section={message.section} />
          <span className="text-sm font-medium">{senderName}</span>
          {username !== null && senderName !== `@${username}` ? (
            <span className="text-muted-foreground text-xs">@{username}</span>
          ) : null}
          {sentByBot ? <span className="text-muted-foreground text-xs">bot</span> : null}
        </>
      }
      extra={formatTime(stringField(snapshot, 'telegram_date'))}
    >
      {text === null ? (
        <p className="text-muted-foreground text-sm">
          {kind}
          {mediaCount === 0 ? '' : ` · ${mediaCount} media`}
        </p>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{text}</p>
      )}
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span>{telegramMessageId === null ? kind : `Telegram message ${telegramMessageId} · ${kind}`}</span>
        <Link
          to="/messages/$messageId"
          params={{ messageId: message.message_id }}
          className="text-primary underline-offset-4 hover:underline"
        >
          Open message record
        </Link>
      </div>
    </TimelineCard>
  );
}

const AGENT_ROLE_LABELS: Record<string, { readonly label: string; readonly note: string | null }> = {
  assistant: { label: 'Assistant private text', note: 'Not published to Telegram' },
  tool_result: { label: 'Tool result', note: null },
  harness_nudge: { label: 'Harness nudge', note: 'Reminder to use send' },
};

function AgentMessageCard({ message }: { readonly message: AgentMessageEntry }): React.ReactElement {
  const meta = AGENT_ROLE_LABELS[message.role] ?? { label: message.role, note: null };
  return (
    <TimelineCard
      header={
        <>
          <RoleBadge role={message.role} />
          <span className="text-sm">{meta.label}</span>
          {meta.note !== null ? <span className="text-muted-foreground text-xs">{meta.note}</span> : null}
          {message.role === 'assistant' ? <PrivateReasoningTag /> : null}
        </>
      }
      extra={formatTime(message.created_at)}
    >
      {message.text.length === 0 ? (
        <p className="text-muted-foreground text-sm">No text content</p>
      ) : message.role === 'tool_result' ? (
        <LazyDetails
          summary="View tool result passed to the agent"
          summaryClassName="text-muted-foreground cursor-pointer text-xs"
          contentClassName="mt-1 text-sm break-words whitespace-pre-wrap"
        >
          {message.text}
        </LazyDetails>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{message.text}</p>
      )}
    </TimelineCard>
  );
}

function ModelCallCard({ model }: { readonly model: ModelCallEntry }): React.ReactElement {
  const hasDetails = model.error_detail !== null || model.request_json !== null || model.response_json !== null;
  return (
    <TimelineCard
      header={
        <>
          <span className="inline-flex items-center rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-sky-700 dark:text-sky-300">
            Model call
          </span>
          <span className="text-sm font-medium">
            {model.provider}/{model.model}
          </span>
          <StateBadge state={model.state} />
        </>
      }
      extra={formatTime(model.created_at)}
    >
      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
        <span>Attempt {model.attempt}</span>
        <span>Tokens {formatNumber(model.total_tokens)}</span>
        <span>Cost {formatCost(model.cost)}</span>
        <span>Duration {formatDuration(model.duration_ms)}</span>
        {model.error_code !== null ? <span className="text-destructive">Error {model.error_code}</span> : null}
      </div>
      {hasDetails ? (
        <LazyDetails
          summary="View details"
          summaryClassName="text-muted-foreground cursor-pointer text-xs"
          contentClassName="mt-2 space-y-2"
        >
          {model.error_detail !== null ? (
            <div>
              <p className="text-muted-foreground text-xs">Full model error details</p>
              <pre className="text-destructive mt-1 max-h-60 overflow-auto rounded border bg-muted/20 p-2 text-xs break-words whitespace-pre-wrap">
                {model.error_detail}
              </pre>
            </div>
          ) : null}
          {model.request_json !== null ? (
            <JsonViewer value={model.request_json} initiallyCollapsed title="Last API request payload" />
          ) : null}
          {model.response_json !== null ? (
            <JsonViewer value={model.response_json} initiallyCollapsed title="Last API response status" />
          ) : null}
        </LazyDetails>
      ) : null}
    </TimelineCard>
  );
}

function TimelineItem({ event }: { readonly event: InvocationTimelineEvent }): React.ReactElement {
  switch (event.kind) {
    case 'queued':
      return (
        <TimelineCard
          header={
            <>
              <span className="text-sm font-medium">Invocation queued</span>
              <span className="text-muted-foreground text-xs">{formatTime(event.at)}</span>
            </>
          }
        />
      );
    case 'started':
      return (
        <TimelineCard
          header={
            <>
              <span className="text-sm font-medium">Agent session started</span>
              <span className="text-muted-foreground text-xs">{formatTime(event.at)}</span>
            </>
          }
        />
      );
    case 'finished':
      return (
        <TimelineCard
          header={
            <>
              <span className="text-sm font-medium">Agent session finished</span>
              <span className="text-muted-foreground text-xs">{formatTime(event.at)}</span>
            </>
          }
        />
      );
    case 'context_message':
      return <ContextMessageCard message={event.message} />;
    case 'model_call':
      return <ModelCallCard model={event.model} />;
    case 'tool_call':
      return <ToolCallCard tool={event.tool} send={event.linkedSend} />;
    case 'agent_message':
      return <AgentMessageCard message={event.message} />;
  }
}

function OverviewTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactElement {
  const events = buildInvocationTimeline(invocation);
  if (events.length === 0) {
    return <TabEmpty message="No timeline events were recorded for this invocation." />;
  }
  return (
    <ol className="ml-1 space-y-4 border-l border-border pl-6">
      {events.map((event) => (
        <li key={timelineEventKey(event)} className="relative">
          <span
            className={cn(
              'absolute top-5 -left-[29px] size-2.5 rounded-full',
              event.kind === 'finished' ? 'bg-destructive' : 'bg-primary',
            )}
          />
          <TimelineItem event={event} />
        </li>
      ))}
    </ol>
  );
}

// --- Tabs ---------------------------------------------------------------------

const TOOL_CALL_COLUMNS: readonly ColumnSpec<ToolCallEntry>[] = [
  {
    key: 'tool',
    title: 'Tool',
    render: (row) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{row.tool_name}</code>,
  },
  { key: 'call-id', title: 'Call ID', render: (row) => <MonoValue value={row.tool_call_id} /> },
  { key: 'state', title: 'State', render: (row) => <StateBadge state={row.state} /> },
  { key: 'side-effect', title: 'Side effect', render: (row) => <YesNoBadge value={row.side_effect} /> },
  { key: 'error', title: 'Error', render: (row) => <TextValue value={row.error_code} /> },
  { key: 'duration', title: 'Duration', align: 'right', render: (row) => formatDuration(row.duration_ms) },
  { key: 'created', title: 'Created', render: (row) => formatTime(row.created_at) },
];

function SendArgumentsSummary({ argumentsJson }: { readonly argumentsJson: string }): React.ReactElement {
  const parsed = parseSendArguments(argumentsJson);
  return (
    <div className="mb-2">
      <p className="text-muted-foreground mb-1 text-xs">Parsed send arguments</p>
      <KvList
        className="sm:grid-cols-2 lg:grid-cols-4"
        items={[
          { label: 'Kind', value: <TextValue value={parsed.kind} /> },
          { label: 'Text', value: <TextValue value={parsed.text} /> },
          { label: 'Sticker ref', value: <TextValue value={parsed.sticker_ref} /> },
          { label: 'Reply to message', value: <TextValue value={parsed.reply_to_message_id} /> },
        ]}
      />
    </div>
  );
}

function ToolCallsTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  return (
    <TabContent count={invocation.tool_calls.length} message="No tool calls were recorded for this invocation.">
      <TableShell
        columns={TOOL_CALL_COLUMNS}
        data={invocation.tool_calls}
        rowKey={(row) => row.id}
        expandedRender={(row) => (
          <div className="space-y-3">
            {row.tool_name === 'send' ? <SendArgumentsSummary argumentsJson={row.arguments_json} /> : null}
            <div>
              <p className="text-muted-foreground mb-1 text-xs">Arguments</p>
              <JsonViewer value={row.arguments_json} />
            </div>
            <div>
              <p className="text-muted-foreground mb-1 text-xs">Result</p>
              <JsonViewer value={row.result_text} />
            </div>
          </div>
        )}
      />
    </TabContent>
  );
}

const MODEL_CALL_COLUMNS: readonly ColumnSpec<ModelCallEntry>[] = [
  { key: 'role', title: 'Role', render: (row) => row.role },
  { key: 'provider', title: 'Provider', render: (row) => row.provider },
  { key: 'model', title: 'Model', render: (row) => row.model },
  { key: 'attempt', title: 'Attempt', align: 'right', render: (row) => String(row.attempt) },
  {
    key: 'tools',
    title: 'Tools in request',
    className: 'min-w-40',
    render: (row) =>
      row.tools === null ? (
        <TextValue value={null} />
      ) : (
        <div className="flex flex-wrap gap-1">
          {row.tools.map((name) => (
            <code key={name} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              {name}
            </code>
          ))}
        </div>
      ),
  },
  { key: 'state', title: 'State', render: (row) => <StateBadge state={row.state} /> },
  { key: 'input', title: 'Input', align: 'right', render: (row) => formatNumber(row.input_tokens) },
  { key: 'output', title: 'Output', align: 'right', render: (row) => formatNumber(row.output_tokens) },
  { key: 'total', title: 'Total', align: 'right', render: (row) => formatNumber(row.total_tokens) },
  { key: 'cost', title: 'Cost', align: 'right', render: (row) => formatCost(row.cost) },
  { key: 'duration', title: 'Duration', align: 'right', render: (row) => formatDuration(row.duration_ms) },
  { key: 'error', title: 'Error', render: (row) => <TextValue value={row.error_code} /> },
];

function ModelCallsTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  return (
    <TabContent count={invocation.model_calls.length} message="No model calls were recorded for this invocation.">
      <TableShell
        columns={MODEL_CALL_COLUMNS}
        data={invocation.model_calls}
        rowKey={(row) => row.id}
        isExpandable={(row) => row.error_detail !== null || row.request_json !== null || row.response_json !== null}
        expandedRender={(row) => (
          <div className="space-y-3">
            {row.request_json !== null ? (
              <JsonViewer value={row.request_json} title="Last API request payload" />
            ) : null}
            {row.response_json !== null ? (
              <JsonViewer value={row.response_json} title="Last API response status" />
            ) : null}
            {row.error_detail !== null ? (
              <div>
                <p className="text-muted-foreground mb-1 text-xs">Full model error details</p>
                <pre className="max-h-60 overflow-auto rounded border bg-muted/20 p-2 text-xs break-words whitespace-pre-wrap">
                  {row.error_detail}
                </pre>
              </div>
            ) : null}
          </div>
        )}
      />
    </TabContent>
  );
}

const SEND_COLUMNS: readonly ColumnSpec<TelegramSendEntry>[] = [
  { key: 'kind', title: 'Kind', render: (row) => row.kind },
  { key: 'state', title: 'State', render: (row) => <StateBadge state={row.state} /> },
  { key: 'message', title: 'Telegram message', render: (row) => <TextValue value={row.telegram_message_id} /> },
  { key: 'tool-call', title: 'Tool call', render: (row) => <MonoValue value={row.tool_call_id} /> },
  { key: 'error', title: 'Error', render: (row) => <TextValue value={row.error_code} /> },
  { key: 'created', title: 'Created', render: (row) => formatTime(row.created_at) },
];

function TelegramSendsTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  return (
    <TabContent count={invocation.telegram_sends.length} message="No Telegram sends were recorded for this invocation.">
      <TableShell
        columns={SEND_COLUMNS}
        data={invocation.telegram_sends}
        rowKey={(row) => row.id}
        expandedRender={(row) => (
          <div>
            <p className="text-muted-foreground mb-1 text-xs">Request payload</p>
            <JsonViewer value={row.request_json} />
          </div>
        )}
      />
    </TabContent>
  );
}

const AGENT_COLUMNS: readonly ColumnSpec<AgentMessageEntry>[] = [
  { key: 'sequence', title: '#', align: 'right', width: 60, render: (row) => String(row.sequence_no) },
  {
    key: 'role',
    title: 'Role',
    render: (row) => (
      <div className="flex flex-wrap items-center gap-1.5">
        <RoleBadge role={row.role} />
        {row.role === 'assistant' ? <PrivateReasoningTag /> : null}
      </div>
    ),
  },
  {
    key: 'text',
    title: 'Text',
    className: 'min-w-64 max-w-2xl whitespace-normal',
    render: (row) => <p className="text-sm break-words whitespace-pre-wrap">{row.text}</p>,
  },
  { key: 'created', title: 'Created', render: (row) => formatTime(row.created_at) },
];

function AgentTranscriptTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  return (
    <div className="space-y-3">
      <PrivateReasoningNote />
      <TabContent
        count={invocation.agent_messages.length}
        message="No agent messages were recorded for this invocation."
      >
        <TableShell
          columns={AGENT_COLUMNS}
          data={invocation.agent_messages}
          rowKey={(row) => String(row.sequence_no)}
        />
      </TabContent>
    </div>
  );
}

const CONTEXT_COLUMNS: readonly ColumnSpec<ContextMessageEntry>[] = [
  { key: 'section', title: 'Section', render: (row) => <SectionBadge section={row.section} /> },
  { key: 'sequence', title: '#', align: 'right', width: 60, render: (row) => String(row.sequence_no) },
  {
    key: 'message',
    title: 'Message',
    render: (row) => (
      <Link
        to="/messages/$messageId"
        params={{ messageId: row.message_id }}
        className="font-mono text-xs break-all underline-offset-4 hover:underline"
      >
        {row.message_id}
      </Link>
    ),
  },
  { key: 'revision', title: 'Revision', render: (row) => <MonoValue value={row.revision_id} /> },
  { key: 'omitted', title: 'Omitted before', align: 'right', render: (row) => String(row.omitted_before) },
];

function FrozenContextTab({ invocation }: { readonly invocation: InvocationDetail }): React.ReactNode {
  return (
    <TabContent
      count={invocation.context_messages.length}
      message="No context messages were frozen for this invocation."
    >
      <TableShell
        columns={CONTEXT_COLUMNS}
        data={invocation.context_messages}
        rowKey={(row) => `${row.section}-${row.sequence_no}`}
        expandedRender={(row) => (
          <div>
            <p className="text-muted-foreground mb-1 text-xs">Snapshot</p>
            <JsonViewer value={row.snapshot_json} />
          </div>
        )}
      />
    </TabContent>
  );
}

// --- Page -----------------------------------------------------------------------

export function InvocationDetailView({ id }: { readonly id: string }): React.ReactElement {
  const { data, isPending, isError, error } = useQuery(invocationQuery(id));

  if (isPending) {
    return <DetailSkeleton />;
  }
  if (isError) {
    return (
      <DetailError
        error={error}
        notFoundTitle="Invocation not found"
        failedTitle="Failed to load invocation"
        backTo="/invocations"
        backLabel="Back to tool sessions"
      />
    );
  }
  if (data === undefined) {
    return (
      <DetailError
        error={new Error('Invocation data is missing')}
        notFoundTitle="Invocation not found"
        failedTitle="Failed to load invocation"
        backTo="/invocations"
        backLabel="Back to tool sessions"
      />
    );
  }

  return (
    <div className="space-y-4">
      <DetailHeader invocation={data} />
      <Card className="gap-0 py-4">
        <CardContent className="px-0 py-0">
          <Tabs defaultValue="overview">
            <TabsList className="mx-4 flex-wrap">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="tools">Tool calls ({data.tool_calls.length})</TabsTrigger>
              <TabsTrigger value="models">Model calls ({data.model_calls.length})</TabsTrigger>
              <TabsTrigger value="sends">Telegram sends ({data.telegram_sends.length})</TabsTrigger>
              <TabsTrigger value="agent">Agent transcript ({data.agent_messages.length})</TabsTrigger>
              <TabsTrigger value="context">Frozen context ({data.context_messages.length})</TabsTrigger>
            </TabsList>
            <div className="p-4 md:p-6">
              <TabsContent value="overview">
                <OverviewTab invocation={data} />
              </TabsContent>
              <TabsContent value="tools">
                <ToolCallsTab invocation={data} />
              </TabsContent>
              <TabsContent value="models">
                <ModelCallsTab invocation={data} />
              </TabsContent>
              <TabsContent value="sends">
                <TelegramSendsTab invocation={data} />
              </TabsContent>
              <TabsContent value="agent">
                <AgentTranscriptTab invocation={data} />
              </TabsContent>
              <TabsContent value="context">
                <FrozenContextTab invocation={data} />
              </TabsContent>
            </div>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
