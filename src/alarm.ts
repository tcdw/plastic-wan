import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type from 'typebox';
import type { InvocationContext } from './context-builder.ts';
import { finishToolCall, rejectToolCall, startToolCall, type SqliteStore } from './database.ts';

const ALARM_SUMMARY_MAX_LENGTH = 500;
const ALARM_MAX_PER_INVOCATION = 3;
const ALARM_MAX_FORWARD_MS = 365 * 86_400_000;
const MAX_TELEGRAM_ID = 0x7fff_ffff_ffff_ffffn;

export const AlarmInputSchema = Type.Object(
  {
    target_user_id: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
    summary: Type.String({ minLength: 1, maxLength: ALARM_SUMMARY_MAX_LENGTH }),
    datetime: Type.String({ minLength: 20, maxLength: 64 }),
  },
  { additionalProperties: false },
);

export interface AlarmToolDetails {
  readonly id: string;
  readonly scheduled_at: string;
}

export interface AlarmToolEnvironment {
  readonly store: SqliteStore;
  readonly context: InvocationContext;
}

class AlarmQuotaError extends Error {
  constructor() {
    super('alarm quota exceeded');
  }
}

/**
 * Deferred Invocation persistence and audited Agent tool. The Alarm Tool writes
 * the pending row inside the same transaction that enforces the per-invocation
 * quota, so success is an atomic side effect that returns the alarm id and its
 * UTC deadline.
 */
export function createAlarmTool(environment: AlarmToolEnvironment): AgentTool<typeof AlarmInputSchema, AlarmToolDetails> {
  return {
    name: 'alarm',
    label: 'Schedule follow-up',
    description:
      "Schedule a deferred agent invocation in this conversation. target_user_id must be a Telegram user sender visible in the current context. summary is a 1-500 character task note for your future self, NOT the message text to send. datetime must be an absolute ISO 8601 time with an explicit Z or +-HH:MM offset, strictly in the future and no more than 365 days ahead. At most 3 alarms may be created per invocation.",
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
          displayName: sender.displayName,
          summary: input.summary,
          scheduledAt: parsedDatetime.scheduledAt,
          now,
        });
        finishToolCall(environment.store.db, auditId, 'success', `alarm_id=${created.id.toString()} scheduled_at=${created.scheduledAt}`, null, { now });
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

interface InsertAlarmInput {
  readonly targetUserId: bigint;
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
        .query<{ count: bigint }, [bigint]>(
          'SELECT COUNT(*) AS count FROM alarms WHERE created_by_invocation_id = ?',
        )
        .get(context.invocationId)?.count ?? 0n;
    if (count >= BigInt(ALARM_MAX_PER_INVOCATION)) {
      throw new AlarmQuotaError();
    }
    const timestamp = input.now.toISOString();
    const created = store.db
      .query(
        `INSERT INTO alarms(conversation_id, target_user_id, target_display_name, summary, scheduled_at, created_at,
                            created_by_invocation_id, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        context.conversationId,
        input.targetUserId,
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
