import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { AGENT_PROMPT_VERSION } from '../platform/agent-protocol.ts';
import type { RawConfig } from '../platform/config.ts';
import { type SqliteStore, asRunResult, isChatPaused, resolveChatConfig } from '../store/database.ts';
import { snapshotInvocation } from '../store/invocation-snapshot.ts';
import { activeSleepUntil } from '../store/sleep.ts';
import { alarms, appState, bucketMessages, buckets, dailyUsage, invocations } from '../store/schema.ts';

export const RECOVERY_MAX_AGE_MS = 5 * 60_000;
export const STARTUP_CATCH_UP_STATE_KEY = 'telegram_startup_catch_up';

interface BucketRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  readonly first_received_at: string;
  readonly deadline_at: string;
}

interface InvocationRow {
  readonly id: bigint;
  readonly bucket_id: bigint;
  readonly conversation_id: bigint;
}

interface SleepingInvocationRow extends InvocationRow {
  readonly telegram_chat_id: bigint;
  readonly created_at: string;
}

interface StartupMessageRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  readonly chat_id: bigint;
  readonly telegram_chat_id: bigint;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
}

interface AlarmDueRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  readonly chat_id: bigint;
  readonly telegram_chat_id: bigint;
  readonly message_thread_id: bigint;
  readonly scheduled_at: string;
}

/**
 * Synchronous state transitions that turn due buckets and alarms into queued
 * invocations, plus crash recovery and startup catch-up. No timers live here:
 * the scheduler drives these methods from its event loop.
 */
export class InvocationQueueService {
  readonly #store: SqliteStore;
  readonly #config: RawConfig;
  readonly #configHash: string;

  constructor(store: SqliteStore, config: RawConfig, configHash: string) {
    this.#store = store;
    this.#config = config;
    this.#configHash = configHash;
  }

  recover(now = new Date()): void {
    this.#store.transaction(() => {
      const nowIso = now.toISOString();
      const staleBefore = new Date(now.getTime() - RECOVERY_MAX_AGE_MS).toISOString();
      this.#store.orm.run(
        sql`UPDATE invocations SET state = CASE WHEN side_effect_started = 1 THEN 'outcome_unknown' ELSE 'aborted' END, completion_reason = 'process_restart', finished_at = ${nowIso} WHERE state = 'running'`,
      );
      this.#store.orm.run(
        sql`UPDATE buckets SET state = CASE WHEN EXISTS (SELECT 1 FROM invocations i WHERE i.bucket_id = buckets.id AND i.state = 'outcome_unknown') THEN 'outcome_unknown' ELSE 'aborted' END, error_code = 'process_restart', finished_at = ${nowIso}, updated_at = ${nowIso} WHERE state = 'running'`,
      );
      const expiring = this.#store.orm
        .select({ id: buckets.id })
        .from(buckets)
        .where(and(inArray(buckets.state, ['collecting', 'queued']), lt(buckets.firstReceivedAt, staleBefore)))
        .orderBy(buckets.id)
        .all();
      for (const bucket of expiring) {
        this.#store.orm
          .update(buckets)
          .set({ state: 'expired', errorCode: 'recovery_age', finishedAt: nowIso, updatedAt: nowIso })
          .where(eq(buckets.id, bucket.id))
          .run();
        this.#store.orm
          .update(invocations)
          .set({ state: 'aborted', completionReason: 'recovery_age', finishedAt: nowIso })
          .where(and(eq(invocations.bucketId, bucket.id), eq(invocations.state, 'queued')))
          .run();
      }
      // A firing alarm owns a claimed invocation. Recovery never returns it to
      // pending: any queued result invocation is aborted, and the alarm closes as
      // fired with an outcome_unknown result so it can never re-send.
      const firing = this.#store.orm
        .select({ id: alarms.id, invocationId: alarms.invocationId })
        .from(alarms)
        .where(eq(alarms.state, 'firing'))
        .all();
      for (const alarm of firing) {
        if (alarm.invocationId !== null) {
          this.#store.orm
            .update(invocations)
            .set({ state: 'aborted', completionReason: 'process_restart', finishedAt: nowIso })
            .where(and(eq(invocations.id, alarm.invocationId), eq(invocations.state, 'queued')))
            .run();
        }
        this.#store.orm
          .update(alarms)
          .set({
            state: 'fired',
            invocationOutcome: 'outcome_unknown',
            completionReason: 'outcome_unknown',
            updatedAt: nowIso,
          })
          .where(and(eq(alarms.id, alarm.id), eq(alarms.state, 'firing')))
          .run();
      }
    });
  }

  finishStartupCatchUp(startedAt: Date, now = new Date()): bigint[] {
    const sleepUntil = activeSleepUntil(this.#store.orm, now);
    return this.#store.transaction(() => {
      const state = this.#store.orm
        .select({ value: appState.value })
        .from(appState)
        .where(eq(appState.key, STARTUP_CATCH_UP_STATE_KEY))
        .get();
      if (state?.value !== startedAt.toISOString()) {
        throw new Error('Startup catch-up state changed before scheduling');
      }
      const selected = this.#store.orm.all<StartupMessageRow>(
        sql`WITH session_messages AS (
           SELECT m.id, m.conversation_id, m.chat_id, c.telegram_chat_id,
                  m.telegram_message_id, m.telegram_date,
                  CASE WHEN r.kind <> 'service' AND COALESCE(s.is_bot, 0) = 0
                            AND (r.kind <> 'sticker' OR r.text IS NOT NULL OR r.caption IS NOT NULL
                                 OR EXISTS (SELECT 1 FROM media WHERE revision_id = r.id AND kind <> 'sticker')
                                 OR ${this.#config.telegram.sticker_trigger_enabled === true ? 1n : 0n} = 1) THEN 1 ELSE 0 END AS eligible_human
           FROM messages m
           JOIN message_revisions r ON r.id = m.current_revision_id
           LEFT JOIN senders s ON s.id = r.sender_id
           JOIN chats c ON c.id = m.chat_id
           WHERE m.received_at >= ${startedAt.toISOString()} AND m.visible = 1 AND m.sent_by_bot = 0
         ),
         ranked AS (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY chat_id ORDER BY telegram_date DESC, telegram_message_id DESC
           ) AS message_rank
           FROM session_messages
           WHERE chat_id IN (SELECT chat_id FROM session_messages WHERE eligible_human = 1)
         )
         SELECT id, conversation_id, chat_id, telegram_chat_id, telegram_message_id, telegram_date
         FROM ranked
         WHERE message_rank <= ${BigInt(this.#config.agent.history_messages)}
         ORDER BY chat_id, telegram_date, telegram_message_id`,
      );
      const grouped = new Map<string, StartupMessageRow[]>();
      for (const message of selected) {
        const key = message.chat_id.toString();
        const messages = grouped.get(key);
        if (messages === undefined) {
          grouped.set(key, [message]);
        } else {
          messages.push(message);
        }
      }
      const timestamp = now.toISOString();
      const invocationIds: bigint[] = [];
      for (const messages of grouped.values()) {
        const latest = messages.at(-1);
        if (latest === undefined) {
          continue;
        }
        const budget = resolveChatConfig(this.#config, this.#store.orm, latest.telegram_chat_id)?.budget;
        const skipReason =
          budget === undefined
            ? 'chat_removed'
            : isChatPaused(this.#store.orm, latest.chat_id)
              ? 'chat_paused'
              : sleepUntil !== null
                ? 'sleeping'
                : this.#reserveInvocation(latest.telegram_chat_id, budget.max_invocations_per_day, now)
                  ? undefined
                  : 'invocation_budget';
        const created =
          skipReason === undefined
            ? this.#store.orm
                .insert(buckets)
                .values({
                  conversationId: latest.conversation_id,
                  state: 'queued',
                  kind: 'startup_catch_up',
                  firstReceivedAt: startedAt.toISOString(),
                  deadlineAt: timestamp,
                  queuedAt: timestamp,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
                .returning({ id: buckets.id })
                .get()
            : this.#store.orm
                .insert(buckets)
                .values({
                  conversationId: latest.conversation_id,
                  state: 'skipped_budget',
                  kind: 'startup_catch_up',
                  firstReceivedAt: startedAt.toISOString(),
                  deadlineAt: timestamp,
                  finishedAt: timestamp,
                  errorCode: skipReason,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
                .returning({ id: buckets.id })
                .get();
        if (created === undefined) {
          throw new Error('buckets insert returned no row');
        }
        const bucketId = created.id;
        if (skipReason === 'sleeping' && sleepUntil !== null) {
          this.#logSleepingSkip(latest.telegram_chat_id, bucketId, null, sleepUntil);
        }
        for (const [sequence, message] of messages.entries()) {
          this.#store.orm
            .insert(bucketMessages)
            .values({ bucketId, messageId: message.id, sequenceNo: BigInt(sequence + 1), sourceBucketId: bucketId })
            .run();
        }
        if (skipReason === undefined) {
          invocationIds.push(this.#insertInvocation(bucketId, latest.conversation_id, now, false));
        }
      }
      const cleared = asRunResult(
        this.#store.orm
          .delete(appState)
          .where(and(eq(appState.key, STARTUP_CATCH_UP_STATE_KEY), eq(appState.value, startedAt.toISOString())))
          .run(),
      );
      if (cleared.changes !== 1) {
        throw new Error('Startup catch-up state was not cleared');
      }
      return invocationIds;
    });
  }

  processDue(now = new Date()): bigint[] {
    const sleepUntil = activeSleepUntil(this.#store.orm, now);
    return this.#store.transaction(() => {
      const due = this.#store.orm.all<BucketRow>(
        sql`SELECT b.id, b.conversation_id, b.first_received_at, b.deadline_at
         FROM buckets b
         JOIN conversations v ON v.id = b.conversation_id
         WHERE b.state = 'collecting' AND b.deadline_at <= ${now.toISOString()} AND b.first_received_at >= ${new Date(now.getTime() - RECOVERY_MAX_AGE_MS).toISOString()}
           AND NOT EXISTS (SELECT 1 FROM chat_pause p WHERE p.chat_id = v.chat_id)
           AND NOT EXISTS (
             SELECT 1 FROM invocations i
             JOIN conversations v2 ON v2.id = i.conversation_id
             WHERE v2.chat_id = v.chat_id AND i.state IN ('queued', 'running')
           )
         ORDER BY b.deadline_at, b.id`,
      );
      const invocations: bigint[] = [];
      for (const bucket of due) {
        const invocationId = this.#queueBucket(bucket, now, sleepUntil);
        if (invocationId !== undefined) {
          invocations.push(invocationId);
        }
      }
      return invocations;
    });
  }

  processAlarmsDue(now = new Date()): bigint[] {
    const nowIso = now.toISOString();
    return this.#store.transaction(() => {
      const due = this.#store.orm.all<AlarmDueRow>(
        sql`SELECT a.id, a.conversation_id, v.chat_id, c.telegram_chat_id, v.message_thread_id, a.scheduled_at
         FROM alarms a
         JOIN conversations v ON v.id = a.conversation_id
         JOIN chats c ON c.id = v.chat_id
         WHERE a.state = 'pending' AND a.scheduled_at <= ${nowIso}
         ORDER BY a.scheduled_at, a.id`,
      );
      const invocations: bigint[] = [];
      for (const alarm of due) {
        const cancelReason = this.#alarmCancelReason(alarm);
        if (cancelReason !== undefined) {
          this.#cancelAlarm(alarm.id, cancelReason, nowIso);
          continue;
        }
        if (this.#chatRunning(alarm.chat_id)) {
          continue;
        }
        const claimed = asRunResult(
          this.#store.orm
            .update(alarms)
            .set({ state: 'firing', firedAt: nowIso, updatedAt: nowIso })
            .where(and(eq(alarms.id, alarm.id), eq(alarms.state, 'pending')))
            .run(),
        );
        if (claimed.changes !== 1) {
          continue;
        }
        invocations.push(this.#insertAlarmInvocation(alarm, now));
      }
      return invocations;
    });
  }

  skipQueuedInvocations(sleepUntil: string, now: Date): void {
    const queued = this.#store.transaction(() => {
      const rows = this.#store.orm.all<SleepingInvocationRow>(
        sql`SELECT i.id, i.bucket_id, i.conversation_id, i.created_at, c.telegram_chat_id
         FROM invocations i
         JOIN conversations v ON v.id = i.conversation_id
         JOIN chats c ON c.id = v.chat_id
         WHERE i.state = 'queued'
           AND NOT EXISTS (SELECT 1 FROM alarms a WHERE a.invocation_id = i.id AND a.state = 'firing')
         ORDER BY i.id`,
      );
      for (const invocation of rows) {
        const nowIso = now.toISOString();
        this.#store.orm
          .update(invocations)
          .set({ state: 'skipped_budget', completionReason: 'sleeping', finishedAt: nowIso })
          .where(and(eq(invocations.id, invocation.id), eq(invocations.state, 'queued')))
          .run();
        this.#store.orm
          .update(buckets)
          .set({ state: 'skipped_budget', errorCode: 'sleeping', finishedAt: nowIso, updatedAt: nowIso })
          .where(eq(buckets.id, invocation.bucket_id))
          .run();
        this.#store.orm.run(
          sql`UPDATE daily_usage
             SET amount = MAX(0, amount - 1), updated_at = ${nowIso}
             WHERE utc_date = ${invocation.created_at.slice(0, 10)} AND scope = 'chat' AND resource = ${invocation.telegram_chat_id.toString()} AND metric = 'agent_invocations'`,
        );
      }
      return rows;
    });
    for (const invocation of queued) {
      this.#logSleepingSkip(invocation.telegram_chat_id, invocation.bucket_id, invocation.id, sleepUntil);
    }
  }

  #logSleepingSkip(chatId: bigint, bucketId: bigint, invocationId: bigint | null, sleepUntil: string): void {
    console.log(
      JSON.stringify({
        event: 'agent_session_skipped_sleeping',
        chat_id: chatId.toString(),
        bucket_id: bucketId.toString(),
        invocation_id: invocationId?.toString() ?? null,
        sleep_until: sleepUntil,
        at: new Date().toISOString(),
      }),
    );
  }

  #alarmCancelReason(alarm: AlarmDueRow): string | undefined {
    const chatConfig = resolveChatConfig(this.#config, this.#store.orm, alarm.telegram_chat_id);
    if (chatConfig === undefined) {
      return 'chat_removed';
    }
    if (isChatPaused(this.#store.orm, alarm.chat_id)) {
      return 'chat_paused';
    }
    if (
      chatConfig.topic_ids !== undefined &&
      !chatConfig.topic_ids.some((topicId) => BigInt(topicId) === alarm.message_thread_id)
    ) {
      return 'topic_removed';
    }
    return undefined;
  }

  #chatRunning(chatId: bigint): boolean {
    return (
      this.#store.orm
        .all<{ present: bigint }>(
          sql`SELECT 1 AS present FROM invocations i
           JOIN conversations v ON v.id = i.conversation_id
           WHERE v.chat_id = ${chatId} AND i.state = 'running'
           LIMIT 1`,
        )
        .at(0) !== undefined
    );
  }

  #cancelAlarm(alarmId: bigint, reason: string, nowIso: string): void {
    this.#store.orm
      .update(alarms)
      .set({ state: 'cancelled', cancelledAt: nowIso, cancelReason: reason, adminCancelled: false, updatedAt: nowIso })
      .where(and(eq(alarms.id, alarmId), eq(alarms.state, 'pending')))
      .run();
  }

  #insertAlarmInvocation(alarm: AlarmDueRow, now: Date): bigint {
    const timestamp = now.toISOString();
    const created = this.#store.orm
      .insert(buckets)
      .values({
        conversationId: alarm.conversation_id,
        state: 'queued',
        kind: 'realtime',
        firstReceivedAt: timestamp,
        deadlineAt: timestamp,
        queuedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: buckets.id })
      .get();
    if (created === undefined) {
      throw new Error('buckets insert returned no row');
    }
    const bucketId = created.id;
    const invocationId = this.#insertInvocation(bucketId, alarm.conversation_id, now, true);
    this.#store.orm.update(alarms).set({ invocationId }).where(eq(alarms.id, alarm.id)).run();
    return invocationId;
  }

  #queueBucket(bucket: BucketRow, now: Date, sleepUntil: string | null): bigint | undefined {
    const chat = this.#store.orm
      .all<{ telegram_chat_id: bigint; paused: bigint }>(
        sql`SELECT c.telegram_chat_id,
                EXISTS(SELECT 1 FROM chat_pause p WHERE p.chat_id = c.id) AS paused
         FROM conversations v JOIN chats c ON c.id = v.chat_id WHERE v.id = ${bucket.conversation_id}`,
      )
      .at(0);
    if (chat === undefined) {
      throw new Error(`Bucket ${bucket.id} has no chat`);
    }
    if (chat.paused === 1n) {
      this.#markBucketSkipped(bucket.id, now, 'chat_paused');
      return undefined;
    }
    const budget = resolveChatConfig(this.#config, this.#store.orm, chat.telegram_chat_id)?.budget;
    if (budget === undefined) {
      this.#markBucketSkipped(bucket.id, now, 'chat_removed');
      return undefined;
    }
    if (sleepUntil !== null) {
      this.#markBucketSkipped(bucket.id, now, 'sleeping');
      this.#logSleepingSkip(chat.telegram_chat_id, bucket.id, null, sleepUntil);
      return undefined;
    }
    if (!this.#reserveInvocation(chat.telegram_chat_id, budget.max_invocations_per_day, now)) {
      this.#markBucketSkipped(bucket.id, now, 'invocation_budget');
      return undefined;
    }
    this.#store.orm
      .update(buckets)
      .set({ state: 'queued', queuedAt: now.toISOString(), updatedAt: now.toISOString() })
      .where(and(eq(buckets.id, bucket.id), eq(buckets.state, 'collecting')))
      .run();
    return this.#insertInvocation(bucket.id, bucket.conversation_id, now, true);
  }

  #insertInvocation(bucketId: bigint, conversationId: bigint, now: Date, includeHistory: boolean): bigint {
    const created = this.#store.orm
      .insert(invocations)
      .values({
        bucketId,
        conversationId,
        state: 'queued',
        configHash: this.#configHash,
        promptVersion: AGENT_PROMPT_VERSION,
        createdAt: now.toISOString(),
      })
      .returning({ id: invocations.id })
      .get();
    if (created === undefined) {
      throw new Error('invocations insert returned no row');
    }
    const invocationId = created.id;
    snapshotInvocation(
      this.#store,
      this.#config.agent.history_messages,
      invocationId,
      bucketId,
      conversationId,
      includeHistory,
    );
    return invocationId;
  }

  #reserveInvocation(chatId: bigint, limit: number, now: Date): boolean {
    const date = now.toISOString().slice(0, 10);
    const resource = chatId.toString();
    const current =
      this.#store.orm
        .select({ amount: dailyUsage.amount })
        .from(dailyUsage)
        .where(
          and(
            eq(dailyUsage.utcDate, date),
            eq(dailyUsage.scope, 'chat'),
            eq(dailyUsage.resource, resource),
            eq(dailyUsage.metric, 'agent_invocations'),
          ),
        )
        .get()?.amount ?? 0n;
    if (current >= BigInt(limit)) {
      return false;
    }
    this.#store.orm
      .insert(dailyUsage)
      .values({
        utcDate: date,
        scope: 'chat',
        resource,
        metric: 'agent_invocations',
        amount: 1n,
        updatedAt: now.toISOString(),
      })
      .onConflictDoUpdate({
        target: [dailyUsage.utcDate, dailyUsage.scope, dailyUsage.resource, dailyUsage.metric],
        set: { amount: sql`${dailyUsage.amount} + 1`, updatedAt: sql`excluded.updated_at` },
      })
      .run();
    return true;
  }

  #markBucketSkipped(bucketId: bigint, now: Date, reason: string): void {
    const timestamp = now.toISOString();
    this.#store.orm
      .update(buckets)
      .set({ state: 'skipped_budget', errorCode: reason, finishedAt: timestamp, updatedAt: timestamp })
      .where(eq(buckets.id, bucketId))
      .run();
  }
}
