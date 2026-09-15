import type {
  AgentMessageEntry,
  ContextMessageEntry,
  InvocationDetail,
  ModelCallEntry,
  TelegramSendEntry,
  ToolCallEntry,
} from './api.ts';

/**
 * Pure model for the Invocation "Overview" timeline. No React dependency on
 * purpose: the construction, ordering (same-timestamp `order` tie-break) and
 * send-argument parsing rules are unit-tested here and the views only map the
 * resulting data onto cards.
 *
 * The ordering constants mirror the previous panel's Session Overview
 * ordering so migrated audits keep the exact same event sequence.
 */

const ORDER_QUEUED = -3_000;
const ORDER_STARTED = -2_000;
const ORDER_CONTEXT_BASE = -10_000;
const ORDER_MODEL_STEP = 10;
const ORDER_TOOL_STEP = 10;
const ORDER_TOOL_OFFSET = 2;
const ORDER_AGENT_STEP = 10;
const ORDER_AGENT_OFFSET = 4;
const ORDER_FINISHED = 10_000;

export type JsonObject = Readonly<Record<string, unknown>>;

/** Parses a stored JSON string into an object, or null when absent / not an object. */
export function parseJsonObject(value: string | null): JsonObject | null {
  if (value === null || value.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    return null;
  }
}

/** Returns a non-empty string field, or null when missing / not a string. */
export function stringField(value: JsonObject | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

/** Returns an object field, or null when missing / not a plain object. */
export function objectField(value: JsonObject | null, key: string): JsonObject | null {
  const field = value?.[key];
  return typeof field === 'object' && field !== null && !Array.isArray(field) ? (field as JsonObject) : null;
}

export interface ParsedSendArguments {
  readonly kind: string | null;
  readonly text: string | null;
  readonly sticker_ref: string | null;
  readonly reply_to_message_id: string | null;
}

/**
 * Human-readable projection of a `send` tool call's arguments. Mirrors the old
 * panel's rules (kind/text/sticker_ref read from the JSON object); one
 * deliberate extension: a numeric `reply_to_message_id` is stringified instead
 * of being dropped, keeping every Telegram ID a string on the client.
 */
export function parseSendArguments(argumentsJson: string): ParsedSendArguments {
  const args = parseJsonObject(argumentsJson);
  const replyRaw = args?.reply_to_message_id;
  const replyTo =
    typeof replyRaw === 'string' && replyRaw.length > 0
      ? replyRaw
      : typeof replyRaw === 'number' && Number.isSafeInteger(replyRaw)
        ? String(replyRaw)
        : null;
  return {
    kind: stringField(args, 'kind'),
    text: stringField(args, 'text'),
    sticker_ref: stringField(args, 'sticker_ref'),
    reply_to_message_id: replyTo,
  };
}

export type InvocationTimelineEvent =
  | { readonly kind: 'queued' | 'started' | 'finished'; readonly at: string; readonly order: number }
  | {
      readonly kind: 'context_message';
      readonly at: string;
      readonly order: number;
      readonly message: ContextMessageEntry;
    }
  | { readonly kind: 'model_call'; readonly at: string; readonly order: number; readonly model: ModelCallEntry }
  | {
      readonly kind: 'tool_call';
      readonly at: string;
      readonly order: number;
      readonly tool: ToolCallEntry;
      readonly linkedSend: TelegramSendEntry | null;
    }
  | {
      readonly kind: 'agent_message';
      readonly at: string;
      readonly order: number;
      readonly message: AgentMessageEntry;
    };

/**
 * Stable sort: valid distinct timestamps win; ties (and unparseable
 * timestamps) fall back to the explicit `order` field.
 */
export function sortTimelineEvents(events: readonly InvocationTimelineEvent[]): InvocationTimelineEvent[] {
  return [...events].sort((left, right) => {
    const leftTime = Date.parse(left.at);
    const rightTime = Date.parse(right.at);
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
      const time = leftTime - rightTime;
      if (time !== 0) {
        return time;
      }
    }
    return left.order - right.order;
  });
}

/** Indexes telegram_sends by their string tool_call_id for timeline linkage. */
export function indexSendsByToolCall(sends: readonly TelegramSendEntry[]): ReadonlyMap<string, TelegramSendEntry> {
  return new Map(sends.map((send) => [send.tool_call_id, send]));
}

/** `new` is the current-batch partition; `history` is retained context. */
export function isNewContextSection(section: string): boolean {
  return section === 'new';
}

/** Timeline time of a frozen context message: snapshot telegram_date, else the invocation start. */
export function contextMessageTimestamp(message: ContextMessageEntry, fallback: string): string {
  const snapshot = parseJsonObject(message.snapshot_json);
  return stringField(snapshot, 'telegram_date') ?? fallback;
}

/** Stable React key for a timeline event. */
export function timelineEventKey(event: InvocationTimelineEvent): string {
  switch (event.kind) {
    case 'queued':
      return 'queued';
    case 'started':
      return 'started';
    case 'finished':
      return 'finished';
    case 'context_message':
      return `context-${event.message.sequence_no}`;
    case 'model_call':
      return `model-${event.model.id}`;
    case 'tool_call':
      return `tool-${event.tool.id}`;
    case 'agent_message':
      return `agent-${event.message.sequence_no}`;
  }
}

/**
 * Builds the merged Overview timeline for one invocation and returns it
 * already sorted (time, then order). `send` tool calls carry their linked
 * Telegram send row (matched by `tool_call_id`), so the view never re-derives
 * the association.
 */
export function buildInvocationTimeline(invocation: InvocationDetail): readonly InvocationTimelineEvent[] {
  const events: InvocationTimelineEvent[] = [{ kind: 'queued', at: invocation.created_at, order: ORDER_QUEUED }];
  if (invocation.started_at !== null) {
    events.push({ kind: 'started', at: invocation.started_at, order: ORDER_STARTED });
  }
  for (const message of invocation.context_messages) {
    events.push({
      kind: 'context_message',
      at: contextMessageTimestamp(message, invocation.created_at),
      order: ORDER_CONTEXT_BASE + message.sequence_no,
      message,
    });
  }
  invocation.model_calls.forEach((model, index) => {
    events.push({ kind: 'model_call', at: model.created_at, order: index * ORDER_MODEL_STEP, model });
  });
  const sendsByToolCall = indexSendsByToolCall(invocation.telegram_sends);
  invocation.tool_calls.forEach((tool, index) => {
    events.push({
      kind: 'tool_call',
      at: tool.created_at,
      order: index * ORDER_TOOL_STEP + ORDER_TOOL_OFFSET,
      tool,
      linkedSend: sendsByToolCall.get(tool.tool_call_id) ?? null,
    });
  });
  invocation.agent_messages.forEach((message) => {
    events.push({
      kind: 'agent_message',
      at: message.created_at,
      order: message.sequence_no * ORDER_AGENT_STEP + ORDER_AGENT_OFFSET,
      message,
    });
  });
  if (invocation.finished_at !== null) {
    events.push({ kind: 'finished', at: invocation.finished_at, order: ORDER_FINISHED });
  }
  return sortTimelineEvents(events);
}
