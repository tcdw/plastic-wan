import { and, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { AGENT_PROMPT_VERSION } from '../platform/agent-protocol.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { type SqliteStore, asRunResult, isChatPaused, resolveChatConfig } from '../store/database.ts';
import { snapshotInvocation } from '../store/invocation-snapshot.ts';
import { ParticipationRegistry, isConversationActive } from '../store/participation.ts';
import { activeSleepUntil } from '../store/sleep.ts';
import { alarms, appState, bucketMessages, buckets, invocationBuckets, invocations } from '../store/schema.ts';

export const RECOVERY_MAX_AGE_MS = 5 * 60_000;
export const STARTUP_CATCH_UP_STATE_KEY = 'telegram_startup_catch_up';
/** Floor for re-checking a batch that is due but whose conversation is mid-round. */
export const MINIMUM_DEFER_MS = 250;

/**
 * Attach side of long-lived invocations. The queue service owns every database
 * transition; it only needs these answers from the runtime that owns the
 * in-memory agent: "is this run still accepting work", "is it between rounds"
 * and "wake it up".
 */
export interface BucketAttachmentTarget {
  isClosing(conversationId: bigint): boolean;
  /** True from the moment a batch is injected until that round's last turn ends. */
  isRoundInProgress(conversationId: bigint): boolean;
  queueInjection(conversationId: bigint, bucketId: bigint): void;
}

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
}

interface StartupMessageRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  readonly chat_id: bigint;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
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
 * Moves one collecting bucket into a running invocation and freezes its
 * messages there, so later edits never change the batch the model will see.
 * Callers run it inside their transaction and then queue the injection. Shared
 * by the due-bucket attach below and the send barrier in `AgentRuntime`.
 */
export function attachBucketToInvocation(
  store: SqliteStore,
  historyMessages: number,
  invocationId: bigint,
  bucketId: bigint,
  conversationId: bigint,
  now: Date,
): void {
  const timestamp = now.toISOString();
  store.orm.insert(invocationBuckets).values({ invocationId, bucketId, attachedAt: timestamp }).run();
  store.orm
    .update(buckets)
    .set({ state: 'running', startedAt: timestamp, updatedAt: timestamp })
    .where(and(eq(buckets.id, bucketId), eq(buckets.state, 'collecting')))
    .run();
  snapshotInvocation(store, historyMessages, invocationId, bucketId, conversationId, false, { append: true });
}

/**
 * Synchronous state transitions that turn due buckets and alarms into queued
 * invocations, plus crash recovery and startup catch-up. No timers live here:
 * the scheduler drives these methods from its event loop.
 */
export class InvocationQueueService {
  readonly #store: SqliteStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #participation: ParticipationRegistry;
  readonly #attachment: BucketAttachmentTarget | undefined;

  constructor(store: SqliteStore, configStore: RuntimeConfigurationStore, attachment?: BucketAttachmentTarget) {
    this.#store = store;
    this.#configStore = configStore;
    this.#participation = new ParticipationRegistry(configStore.current().config);
    this.#attachment = attachment;
  }

  recover(now = new Date()): void {
    this.#store.transaction(() => {
      const nowIso = now.toISOString();
      const staleBefore = new Date(now.getTime() - RECOVERY_MAX_AGE_MS).toISOString();
      this.#store.orm.run(
        sql`UPDATE invocations SET state = CASE WHEN side_effect_started = 1 THEN 'outcome_unknown' ELSE 'aborted' END, completion_reason = 'process_restart', finished_at = ${nowIso} WHERE state = 'running'`,
      );
      // Every attached bucket — the opening one included — decides its state
      // from the invocation it was attached to, not from `invocations.bucket_id`.
      this.#store.orm.run(
        sql`UPDATE buckets SET state = CASE WHEN EXISTS (SELECT 1 FROM invocation_buckets ib JOIN invocations i ON i.id = ib.invocation_id WHERE ib.bucket_id = buckets.id AND i.state = 'outcome_unknown') THEN 'outcome_unknown' ELSE 'aborted' END, error_code = 'process_restart', finished_at = ${nowIso}, updated_at = ${nowIso}
           WHERE state = 'running' AND EXISTS (SELECT 1 FROM invocation_buckets ib WHERE ib.bucket_id = buckets.id)`,
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
           SELECT m.id, m.conversation_id, m.chat_id, c.telegram_chat_id, c.type AS chat_type,
                  m.telegram_message_id, m.telegram_date,
                  CASE WHEN r.kind <> 'service' AND COALESCE(s.is_bot, 0) = 0
                            AND (r.kind <> 'sticker' OR r.text IS NOT NULL OR r.caption IS NOT NULL
                                 OR EXISTS (SELECT 1 FROM media WHERE revision_id = r.id AND kind <> 'sticker')
                                 OR ${this.#configStore.current().config.telegram.sticker_trigger_enabled === true ? 1n : 0n} = 1) THEN 1 ELSE 0 END AS eligible_human
           FROM messages m
           JOIN message_revisions r ON r.id = m.current_revision_id
           LEFT JOIN senders s ON s.id = r.sender_id
           JOIN chats c ON c.id = m.chat_id
           WHERE m.received_at >= ${startedAt.toISOString()} AND m.visible = 1 AND m.sent_by_bot = 0
         ),
         ranked AS (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY conversation_id ORDER BY telegram_date DESC, telegram_message_id DESC
           ) AS message_rank
           FROM session_messages
           WHERE conversation_id IN (SELECT conversation_id FROM session_messages WHERE eligible_human = 1)
         )
         SELECT id, conversation_id, chat_id, telegram_chat_id, chat_type, telegram_message_id, telegram_date
         FROM ranked
         WHERE message_rank <= ${BigInt(this.#configStore.current().config.agent.history_messages)}
         ORDER BY conversation_id, telegram_date, telegram_message_id`,
      );
      // One catch-up bucket per Conversation: forum topics are separate
      // sessions with their own participation state, and the bucket snapshot
      // does not filter its messages by conversation.
      const grouped = new Map<string, StartupMessageRow[]>();
      for (const message of selected) {
        const key = message.conversation_id.toString();
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
        const skipReason =
          resolveChatConfig(this.#configStore.current().config, this.#store.orm, latest.telegram_chat_id) === undefined
            ? 'chat_removed'
            : isChatPaused(this.#store.orm, latest.chat_id)
              ? 'chat_paused'
              : sleepUntil !== null
                ? 'sleeping'
                : this.#participationBlocks(latest, now)
                  ? 'participation_gated'
                  : undefined;
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
      // A bucket whose conversation already has a *running* invocation is
      // injected into it (below) instead of starting its own run. Everything
      // else keeps the previous chat-level pacing: a queued invocation will
      // open with this bucket, and a running invocation of a *different*
      // conversation in the same chat still owns the chat, because agent
      // sessions stay serialized per chat.
      // No age ceiling here. A batch collects for as long as its Conversation is
      // busy — the runtime pushes its deadline one window at a time while the
      // round runs — so a batch that is entirely legitimate is older than
      // `RECOVERY_MAX_AGE_MS` by the time it comes due. Filtering those out left
      // them `collecting` forever: the run ends without taking them, nothing
      // re-queues them, and every later message of that Conversation joins the
      // same dead batch while the scheduler keeps waking on its already-passed
      // deadline (observed: invocations/1320, where a 30-minute round left the
      // next batch stranded and the chat went silent for good). The five-minute
      // rule is a *startup* rule: `recover()` expires that work before this
      // method is ever called, so nothing stale can reach the queue from here.
      const due = this.#store.orm.all<BucketRow>(
        sql`SELECT b.id, b.conversation_id, b.first_received_at, b.deadline_at
         FROM buckets b
         JOIN conversations v ON v.id = b.conversation_id
         WHERE b.state = 'collecting' AND b.deadline_at <= ${now.toISOString()}
           AND NOT EXISTS (SELECT 1 FROM chat_pause p WHERE p.chat_id = v.chat_id)
           AND NOT EXISTS (
             SELECT 1 FROM invocations i
             JOIN conversations v2 ON v2.id = i.conversation_id
             WHERE v2.chat_id = v.chat_id
               AND (i.state = 'queued' OR (i.state = 'running' AND i.conversation_id <> b.conversation_id))
           )
         ORDER BY b.deadline_at, b.id`,
      );
      const invocations: bigint[] = [];
      for (const bucket of due) {
        const running = this.#runningInvocation(bucket.conversation_id);
        if (running !== undefined) {
          // A run that is still working on its round has not been free for the
          // batch's window yet, so the batch keeps collecting: its window starts
          // when the round ends (`AgentRuntime` pushes the deadline then). Handing
          // it over here would inject a batch that collected almost nothing, and
          // would also split the messages that arrive during a long round across
          // two batches.
          if (this.#attachment?.isRoundInProgress(bucket.conversation_id) === true) {
            this.#deferBucket(bucket, now);
            continue;
          }
          if (this.#attachBucket(bucket, running, now, sleepUntil)) {
            continue;
          }
          // The run is closing and cannot take this batch; leave the bucket
          // collecting so the next invocation picks it up.
          continue;
        }
        const invocationId = this.#queueBucket(bucket, now, sleepUntil);
        if (invocationId !== undefined) {
          invocations.push(invocationId);
        }
      }
      return invocations;
    });
  }

  /**
   * Hands one due bucket to the invocation already running for its
   * Conversation. The frozen-input invariant is kept: the batch is snapshotted
   * into `invocation_messages` now, so later edits cannot change what the model
   * will see.
   */
  #attachBucket(bucket: BucketRow, invocationId: bigint, now: Date, sleepUntil: string | null): boolean {
    const attachment = this.#attachment;
    if (attachment === undefined || attachment.isClosing(bucket.conversation_id)) {
      return false;
    }
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
    const timestamp = now.toISOString();
    attachBucketToInvocation(
      this.#store,
      this.#configStore.current().config.agent.history_messages,
      invocationId,
      bucket.id,
      bucket.conversation_id,
      now,
    );
    if (sleepUntil !== null) {
      this.#logSleepingSkip(chat.telegram_chat_id, bucket.id, invocationId, sleepUntil);
    }
    attachment.queueInjection(bucket.conversation_id, bucket.id);
    console.log(
      JSON.stringify({
        event: 'bucket_attached',
        invocation_id: invocationId.toString(),
        bucket_id: bucket.id.toString(),
        conversation_id: bucket.conversation_id.toString(),
        chat_id: chat.telegram_chat_id.toString(),
        at: timestamp,
      }),
    );
    return true;
  }

  /**
   * Keeps a due batch collecting because its conversation is mid-round. The
   * window restarts from now, which is only an approximation — the exact anchor
   * is the round end, which the runtime writes when it gets there — but it also
   * keeps the scheduler from waking on an already-passed deadline over and over.
   */
  #deferBucket(bucket: BucketRow, now: Date): void {
    const deferMilliseconds = Math.max(
      this.#configStore.current().config.telegram.bucket_window_seconds * 1_000,
      MINIMUM_DEFER_MS,
    );
    const atLeast = new Date(now.getTime() + deferMilliseconds).toISOString();
    this.#store.orm.run(
      sql`UPDATE buckets SET deadline_at = ${atLeast}, updated_at = ${now.toISOString()}
         WHERE id = ${bucket.id} AND state = 'collecting' AND deadline_at < ${atLeast}`,
    );
  }

  /**
   * Re-queues buckets that were attached mid-run but never injected, so a batch
   * that arrived while the model was working is not silently dropped. The
   * opening bucket is excluded: it is the trigger of the run, so its state
   * follows the invocation's terminal transition instead.
   */
  releaseUninjectedBuckets(invocationId: bigint, now: Date): void {
    const rows = this.#store.orm
      .select({ bucketId: invocationBuckets.bucketId, conversationId: buckets.conversationId })
      .from(invocationBuckets)
      .innerJoin(buckets, eq(buckets.id, invocationBuckets.bucketId))
      .innerJoin(invocations, eq(invocations.id, invocationBuckets.invocationId))
      .where(
        and(
          eq(invocationBuckets.invocationId, invocationId),
          isNull(invocationBuckets.injectedAt),
          ne(invocationBuckets.bucketId, invocations.bucketId),
        ),
      )
      .all();
    for (const row of rows) {
      const timestamp = now.toISOString();
      const released = this.#store.orm
        .update(buckets)
        .set({ state: 'queued', queuedAt: timestamp, updatedAt: timestamp })
        .where(and(eq(buckets.id, row.bucketId), eq(buckets.state, 'running')))
        .run();
      // An admin cancel expires attached batches before aborting the run; those
      // must not come back as a new invocation.
      if (asRunResult(released).changes === 0) {
        continue;
      }
      this.#insertInvocation(row.bucketId, row.conversationId, now, false);
      console.log(
        JSON.stringify({
          event: 'bucket_requeued',
          invocation_id: invocationId.toString(),
          bucket_id: row.bucketId.toString(),
          conversation_id: row.conversationId.toString(),
          at: timestamp,
        }),
      );
    }
  }

  #runningInvocation(conversationId: bigint): bigint | undefined {
    return this.#store.orm
      .all<{ id: bigint }>(
        sql`SELECT id FROM invocations WHERE conversation_id = ${conversationId} AND state = 'running' ORDER BY id DESC LIMIT 1`,
      )
      .at(0)?.id;
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
        sql`SELECT i.id, i.bucket_id, i.conversation_id, c.telegram_chat_id
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
    const chatConfig = resolveChatConfig(this.#configStore.current().config, this.#store.orm, alarm.telegram_chat_id);
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

  // A chat outside its active periods only receives a catch-up bucket when a
  // mention, reply, or keyword hit already refreshed its attention window.
  #participationBlocks(message: StartupMessageRow, now: Date): boolean {
    const rule = this.#participation.ruleFor(this.#store.orm, message.telegram_chat_id, message.chat_type);
    return rule !== undefined && !isConversationActive(this.#store.orm, rule, message.conversation_id, now);
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
    if (resolveChatConfig(this.#configStore.current().config, this.#store.orm, chat.telegram_chat_id) === undefined) {
      this.#markBucketSkipped(bucket.id, now, 'chat_removed');
      return undefined;
    }
    if (sleepUntil !== null) {
      this.#markBucketSkipped(bucket.id, now, 'sleeping');
      this.#logSleepingSkip(chat.telegram_chat_id, bucket.id, null, sleepUntil);
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
    const current = this.#configStore.current();
    const created = this.#store.orm
      .insert(invocations)
      .values({
        bucketId,
        conversationId,
        state: 'queued',
        configHash: current.hash,
        promptVersion: AGENT_PROMPT_VERSION,
        createdAt: now.toISOString(),
      })
      .returning({ id: invocations.id })
      .get();
    if (created === undefined) {
      throw new Error('invocations insert returned no row');
    }
    const invocationId = created.id;
    // The opening bucket is joined like every attached one, so terminal state
    // transitions and un-injected releases can be uniform.
    this.#store.orm.insert(invocationBuckets).values({ invocationId, bucketId, attachedAt: now.toISOString() }).run();
    snapshotInvocation(
      this.#store,
      current.config.agent.history_messages,
      invocationId,
      bucketId,
      conversationId,
      includeHistory,
    );
    return invocationId;
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
