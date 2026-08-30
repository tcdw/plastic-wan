import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type, { type Static } from 'typebox';
import type { InvocationContext } from './context-builder.ts';
import { finishToolCall, rejectToolCall, startToolCall, type SqliteStore } from './database.ts';
import { type AlarmListInternalContextPayload, insertInternalContext } from './internal-context.ts';

const ALARM_SUMMARY_MAX_LENGTH = 500;
const ALARM_MAX_PER_INVOCATION = 3;
const ALARM_MAX_FORWARD_MS = 365 * 86_400_000;
const MAX_TELEGRAM_ID = 0x7fff_ffff_ffff_ffffn;
const DELETE_REASON_USER_REQUEST = 'user_requested';

export const AlarmInputSchema = Type.Object(
  {
    target_user_id: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
    summary: Type.String({ minLength: 1, maxLength: ALARM_SUMMARY_MAX_LENGTH }),
    datetime: Type.String({ minLength: 20, maxLength: 64 }),
  },
  { additionalProperties: false },
);

export const ListAlarmInputSchema = Type.Object({}, { additionalProperties: false });
export type ListAlarmInput = Static<typeof ListAlarmInputSchema>;

export const DeleteAlarmInputSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
  },
  { additionalProperties: false },
);

export interface AlarmToolDetails {
  readonly id: string;
  readonly scheduled_at: string;
}

export interface ListAlarmToolDetails {
  readonly items: readonly {
    readonly id: string;
    readonly scheduled_at: string;
    readonly summary: string;
  }[];
}

export interface DeleteAlarmToolDetails {
  readonly id: string;
  readonly state: 'cancelled';
  readonly cancelled_at: string;
}

export interface AlarmToolEnvironment {
  readonly store: SqliteStore;
  readonly context: InvocationContext;
}

export interface AgentMessageRecorder {
  recordAgentMessage(invocationId: bigint, role: 'assistant' | 'tool_result' | 'harness_nudge', text: string): bigint;
}

export interface AlarmListToolDependencies extends AlarmToolEnvironment {
  readonly runtime: AgentMessageRecorder;
}

export interface DeleteAlarmToolDependencies extends AlarmToolEnvironment {}

interface PendingAlarmRow {
  readonly id: bigint;
  readonly scheduled_at: string;
  readonly summary: string;
}

class AlarmQuotaError extends Error {
  constructor() {
    super('alarm quota exceeded');
  }
}

export function createAlarmTool(
  environment: AlarmToolEnvironment,
): AgentTool<typeof AlarmInputSchema, AlarmToolDetails> {
  return {
    name: 'alarm',
    label: 'Schedule follow-up',
    description:
      'Schedule a deferred agent invocation in this conversation. target_user_id must be a Telegram user sender visible in the current context. The creator/owner is derived only from trusted invocation context as the latest new Telegram user sender; never invent or pass creator identity yourself. If no reliable current caller exists (for example alarm-triggered or non-user-new context), this tool is unavailable. summary is a 1-500 character task note for your future self, NOT the message text to send. datetime must be an absolute ISO 8601 time with an explicit Z or +-HH:MM offset, strictly in the future and no more than 365 days ahead. At most 3 alarms may be created per invocation.',
    parameters: AlarmInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, _signal) => {
      const now = new Date();
      const argumentsJson = JSON.stringify(input);
      const targetUserId = parseTargetUserId(input.target_user_id);
      if (targetUserId === null) {
        rejectToolCall(
          environment.store.db,
          environment.context.invocationId,
          toolCallId,
          'alarm',
          argumentsJson,
          true,
          'alarm_target_invalid',
          now,
        );
        throw new Error('alarm target_user_id is not a valid Telegram user id');
      }
      const sender = environment.context.visibleSenders.get(targetUserId.toString());
      if (sender === undefined) {
        rejectToolCall(
          environment.store.db,
          environment.context.invocationId,
          toolCallId,
          'alarm',
          argumentsJson,
          true,
          'alarm_target_not_authorized',
          now,
        );
        throw new Error('alarm target user is not visible in this invocation');
      }
      const callerUserId = environment.context.callerUserId;
      if (callerUserId === null) {
        rejectToolCall(
          environment.store.db,
          environment.context.invocationId,
          toolCallId,
          'alarm',
          argumentsJson,
          true,
          'alarm_caller_not_available',
          now,
        );
        throw new Error('alarm is unavailable because the current caller identity is not reliably known');
      }
      const parsedDatetime = parseAlarmDatetime(input.datetime, now);
      if (!parsedDatetime.ok) {
        rejectToolCall(
          environment.store.db,
          environment.context.invocationId,
          toolCallId,
          'alarm',
          argumentsJson,
          true,
          parsedDatetime.code,
          now,
        );
        throw new Error('alarm datetime is invalid');
      }
      const auditId = startToolCall(
        environment.store.db,
        environment.context.invocationId,
        toolCallId,
        'alarm',
        argumentsJson,
        true,
        now,
      );
      try {
        const created = insertAlarm(environment.store, environment.context, {
          targetUserId,
          createdByUserId: callerUserId,
          displayName: sender.displayName,
          summary: input.summary,
          scheduledAt: parsedDatetime.scheduledAt,
          now,
        });
        finishToolCall(
          environment.store.db,
          auditId,
          'success',
          `alarm_id=${created.id.toString()} scheduled_at=${created.scheduledAt}`,
          null,
          { now },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Scheduled alarm ${created.id.toString()} for ${created.scheduledAt}`,
            },
          ],
          details: { id: created.id.toString(), scheduled_at: created.scheduledAt },
        };
      } catch (error) {
        if (error instanceof AlarmQuotaError) {
          finishToolCall(environment.store.db, auditId, 'error', null, 'alarm_quota_exceeded', { now });
          throw new Error(`alarm quota of ${ALARM_MAX_PER_INVOCATION} per invocation reached`);
        }
        finishToolCall(environment.store.db, auditId, 'error', null, 'alarm_error', { now });
        throw error;
      }
    },
  };
}

export function createListAlarmTool(
  dependencies: AlarmListToolDependencies,
): AgentTool<typeof ListAlarmInputSchema, ListAlarmToolDetails> {
  return {
    name: 'list_alarm',
    label: 'List my pending alarms',
    description:
      "List only the current caller's own pending alarms in stable order (scheduled_at ascending, then id ascending). The caller identity comes from trusted invocation context, never from model parameters. Use this as an internal helper when a user asks what alarms they have, or when you need a stable alarm ID for natural-language deletion. If recent hidden internal context already resolves “the second one” or “the one you just listed”, you may skip list_alarm and go straight to delete_alarm. Do not expose CRUD IDs and ask the user to confirm by ID; do not guess IDs. If the user mentions an alarm but you cannot resolve it uniquely, ask a clarifying question. list_alarm stores a hidden historical mapping for later invocations; that mapping is not current database authority.",
    parameters: ListAlarmInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, _signal) => {
      const now = new Date();
      const argumentsJson = JSON.stringify(input);
      const callerUserId = dependencies.context.callerUserId;
      if (callerUserId === null) {
        rejectToolCall(
          dependencies.store.db,
          dependencies.context.invocationId,
          toolCallId,
          'list_alarm',
          argumentsJson,
          false,
          'alarm_caller_not_available',
          now,
        );
        throw new Error('list_alarm is unavailable because the current caller identity is not reliably known');
      }
      const auditId = startToolCall(
        dependencies.store.db,
        dependencies.context.invocationId,
        toolCallId,
        'list_alarm',
        argumentsJson,
        false,
        now,
      );
      try {
        const items = listPendingAlarms(dependencies.store, dependencies.context.conversationId, callerUserId);
        const details = {
          items: items.map((item) => ({
            id: item.id.toString(),
            scheduled_at: item.scheduled_at,
            summary: item.summary,
          })),
        } satisfies ListAlarmToolDetails;
        const resultText =
          details.items.length === 0
            ? 'count=0'
            : `count=${details.items.length} ${details.items
                .map((item, index) => `${index + 1}:${item.id}@${item.scheduled_at}`)
                .join(' ')}`;
        finishToolCall(dependencies.store.db, auditId, 'success', resultText, null, { now });
        const agentMessageId = dependencies.runtime.recordAgentMessage(
          dependencies.context.invocationId,
          'tool_result',
          JSON.stringify(details),
        );
        persistAlarmListInternalContext(dependencies.store, dependencies.context, agentMessageId, details.items, now);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(details),
            },
          ],
          details,
        };
      } catch (error) {
        finishToolCall(dependencies.store.db, auditId, 'error', null, 'alarm_error', { now });
        throw error;
      }
    },
  };
}

export function createDeleteAlarmTool(
  dependencies: DeleteAlarmToolDependencies,
): AgentTool<typeof DeleteAlarmInputSchema, DeleteAlarmToolDetails> {
  return {
    name: 'delete_alarm',
    label: 'Delete my pending alarm',
    description:
      "Cancel one of the current caller's own pending alarms by stable alarm ID. The caller identity comes only from trusted invocation context, never from model parameters. Prefer resolving natural-language references from hidden internal context or, if needed, from list_alarm. If the target is uniquely identified, delete it directly without asking the user to confirm an internal ID. Do not guess IDs. If there is ambiguity, ask a clarifying question. delete_alarm always re-checks the live database: hidden internal context is historical observation only. For missing IDs, alarms owned by someone else, or alarms no longer pending, the backend returns the same not_found outcome so you do not learn which case occurred.",
    parameters: DeleteAlarmInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, _signal) => {
      const now = new Date();
      const argumentsJson = JSON.stringify(input);
      const callerUserId = dependencies.context.callerUserId;
      if (callerUserId === null) {
        rejectToolCall(
          dependencies.store.db,
          dependencies.context.invocationId,
          toolCallId,
          'delete_alarm',
          argumentsJson,
          true,
          'alarm_caller_not_available',
          now,
        );
        throw new Error('delete_alarm is unavailable because the current caller identity is not reliably known');
      }
      const alarmId = parseTargetUserId(input.id);
      if (alarmId === null) {
        rejectToolCall(
          dependencies.store.db,
          dependencies.context.invocationId,
          toolCallId,
          'delete_alarm',
          argumentsJson,
          true,
          'alarm_not_found',
          now,
        );
        throw new Error('alarm not found');
      }
      const auditId = startToolCall(
        dependencies.store.db,
        dependencies.context.invocationId,
        toolCallId,
        'delete_alarm',
        argumentsJson,
        true,
        now,
      );
      try {
        const deleted = cancelPendingAlarm(
          dependencies.store,
          dependencies.context.conversationId,
          callerUserId,
          alarmId,
          now,
        );
        if (deleted === null) {
          finishToolCall(dependencies.store.db, auditId, 'error', null, 'alarm_not_found', { now });
          throw new Error('alarm not found');
        }
        finishToolCall(
          dependencies.store.db,
          auditId,
          'success',
          `alarm_id=${deleted.id} state=cancelled cancelled_at=${deleted.cancelled_at}`,
          null,
          { now },
        );
        return {
          content: [{ type: 'text', text: `Cancelled alarm ${deleted.id}` }],
          details: deleted,
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'alarm not found') {
          throw error;
        }
        finishToolCall(dependencies.store.db, auditId, 'error', null, 'alarm_error', { now });
        throw error;
      }
    },
  };
}

interface InsertAlarmInput {
  readonly targetUserId: bigint;
  readonly createdByUserId: bigint;
  readonly displayName: string;
  readonly summary: string;
  readonly scheduledAt: string;
  readonly now: Date;
}

function insertAlarm(
  store: SqliteStore,
  context: InvocationContext,
  input: InsertAlarmInput,
): { readonly id: bigint; readonly scheduledAt: string } {
  return store.transaction(() => {
    const count =
      store.db
        .query<{ count: bigint }, [bigint]>('SELECT COUNT(*) AS count FROM alarms WHERE created_by_invocation_id = ?')
        .get(context.invocationId)?.count ?? 0n;
    if (count >= BigInt(ALARM_MAX_PER_INVOCATION)) {
      throw new AlarmQuotaError();
    }
    const timestamp = input.now.toISOString();
    const created = store.db
      .query(
        `INSERT INTO alarms(conversation_id, target_user_id, created_by_user_id, target_display_name, summary,
                            scheduled_at, created_at, created_by_invocation_id, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        context.conversationId,
        input.targetUserId,
        input.createdByUserId,
        input.displayName,
        input.summary,
        input.scheduledAt,
        timestamp,
        context.invocationId,
        timestamp,
      );
    return { id: BigInt(created.lastInsertRowid), scheduledAt: input.scheduledAt };
  });
}

function listPendingAlarms(store: SqliteStore, conversationId: bigint, callerUserId: bigint): PendingAlarmRow[] {
  return store.db
    .query<PendingAlarmRow, [bigint, bigint]>(
      `SELECT id, scheduled_at, summary
       FROM alarms
       WHERE conversation_id = ? AND created_by_user_id = ? AND state = 'pending'
       ORDER BY scheduled_at, id`,
    )
    .all(conversationId, callerUserId);
}

function cancelPendingAlarm(
  store: SqliteStore,
  conversationId: bigint,
  callerUserId: bigint,
  alarmId: bigint,
  now: Date,
): DeleteAlarmToolDetails | null {
  return store.transaction(() => {
    const cancelledAt = now.toISOString();
    const updated = store.db
      .query(
        `UPDATE alarms
         SET state = 'cancelled',
             cancelled_at = ?,
             cancelled_by = 'agent',
             admin_cancelled = 0,
             cancel_reason = ?,
             updated_at = ?
         WHERE id = ? AND conversation_id = ? AND created_by_user_id = ? AND state = 'pending'`,
      )
      .run(cancelledAt, DELETE_REASON_USER_REQUEST, cancelledAt, alarmId, conversationId, callerUserId);
    if (updated.changes !== 1) {
      return null;
    }
    return {
      id: alarmId.toString(),
      state: 'cancelled',
      cancelled_at: cancelledAt,
    };
  });
}

function persistAlarmListInternalContext(
  store: SqliteStore,
  context: InvocationContext,
  sourceAgentMessageId: bigint,
  items: ListAlarmToolDetails['items'],
  now: Date,
): void {
  const observedAt = now.toISOString();
  const payload: AlarmListInternalContextPayload = {
    kind: 'alarm_list',
    version: 1,
    observed_at: observedAt,
    items: [...items],
  };
  insertInternalContext(store.db, {
    conversationId: context.conversationId,
    invocationId: context.invocationId,
    sourceAgentMessageId,
    kind: payload.kind,
    version: payload.version,
    observedAt,
    payloadJson: JSON.stringify(payload),
    createdAt: observedAt,
  });
}

function parseTargetUserId(value: string): bigint | null {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) {
    return null;
  }
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_TELEGRAM_ID ? parsed : null;
  } catch {
    return null;
  }
}

function parseAlarmDatetime(
  value: string,
  now: Date,
): { readonly ok: true; readonly scheduledAt: string } | { readonly ok: false; readonly code: string } {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return { ok: false, code: 'alarm_datetime_invalid' };
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return { ok: false, code: 'alarm_datetime_invalid' };
  }
  if (milliseconds <= now.getTime()) {
    return { ok: false, code: 'alarm_datetime_not_future' };
  }
  if (milliseconds > now.getTime() + ALARM_MAX_FORWARD_MS) {
    return { ok: false, code: 'alarm_datetime_too_far' };
  }
  return { ok: true, scheduledAt: new Date(milliseconds).toISOString() };
}
