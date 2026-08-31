import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { AGENT_PROMPT_VERSION } from './agent-protocol.ts';
import type { RawConfig } from './config.ts';
import { type SqliteStore, asRunResult, isChatPaused, resolveChatConfig } from './database.ts';
import { activeSleepUntil } from './sleep.ts';
import {
  alarms,
  appState,
  bucketMessages,
  buckets,
  conversations,
  dailyUsage,
  invocations,
  invocationMessages,
  media,
} from './schema.ts';

const RECOVERY_MAX_AGE_MS = 5 * 60_000;
export const STARTUP_CATCH_UP_STATE_KEY = 'telegram_startup_catch_up';

export interface InvocationOutcome {
  readonly state: 'completed' | 'failed' | 'aborted' | 'outcome_unknown';
  readonly reason: string;
}

export type InvocationHandler = (invocationId: bigint, signal: AbortSignal) => Promise<InvocationOutcome>;

interface ActiveInvocation {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

interface InvocationDiagnosticRow {
  readonly telegram_chat_id: bigint;
  readonly bucket_message_count: bigint;
  readonly pending_bucket_count: bigint;
  readonly chat_pending_bucket_count: bigint;
  readonly previous_started_at: string | null;
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
  readonly created_at: string;
}

interface MessageSnapshotRow {
  readonly message_id: bigint;
  readonly conversation_id: bigint;
  readonly message_thread_id: bigint;
  readonly revision_id: bigint;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
  readonly sent_by_bot: bigint;
  readonly revision_no: bigint;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: bigint | null;
  readonly reply_snapshot_json: string | null;
  readonly forward_origin_json: string | null;
  readonly media_group_id: string | null;
  readonly sender_telegram_id: bigint | null;
  readonly sender_display_name: string | null;
  readonly sender_username: string | null;
  readonly source_bucket_id: bigint | null;
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

export class BucketScheduler {
  readonly #store: SqliteStore;
  readonly #config: RawConfig;
  readonly #configHash: string;
  readonly #handler: InvocationHandler;
  readonly #active = new Map<string, ActiveInvocation>();
  #running = false;
  #wakeResolver: (() => void) | undefined;
  #loopPromise: Promise<void> | undefined;
  #lastForcedGcAt = 0;

  constructor(store: SqliteStore, config: RawConfig, configHash: string, handler: InvocationHandler) {
    this.#store = store;
    this.#config = config;
    this.#configHash = configHash;
    this.#handler = handler;
  }

  start(now = new Date()): void {
    if (this.#running) {
      throw new Error('Bucket scheduler is already running');
    }
    this.recover(now);
    this.#running = true;
    this.#loopPromise = this.#loop();
  }

  wake(): void {
    this.#wakeResolver?.();
    this.#wakeResolver = undefined;
  }

  // Aborts invocations currently running in a chat (used by /pause). The
  // queued-invocation and bucket state transitions happen in the command
  // service; this only interrupts live agent work.
  pauseChat(chatId: bigint): void {
    for (const [id, entry] of this.#active) {
      const row = this.#store.orm
        .all<{ chat_id: bigint }>(
          sql`SELECT v.chat_id FROM invocations i JOIN conversations v ON v.id = i.conversation_id WHERE i.id = ${BigInt(id)}`,
        )
        .at(0);
      if (row !== undefined && row.chat_id === chatId) {
        entry.controller.abort(new Error('chat_paused'));
      }
    }
  }

  async stop(graceMilliseconds = 30_000): Promise<void> {
    this.#running = false;
    this.wake();
    await this.#loopPromise;
    const active = [...this.#active.values()];
    if (active.length === 0) {
      return;
    }
    const finished = Promise.allSettled(active.map((entry) => entry.promise));
    let graceTimer: NodeJS.Timeout | undefined;
    const graceElapsed = new Promise<'timeout'>((resolve) => {
      graceTimer = setTimeout(() => resolve('timeout'), graceMilliseconds);
    });
    const result = await Promise.race([finished, graceElapsed]);
    clearTimeout(graceTimer);
    if (result === 'timeout') {
      for (const entry of active) {
        entry.controller.abort(new Error('shutdown'));
      }
      await finished;
    }
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

  async #loop(): Promise<void> {
    while (this.#running) {
      this.processAlarmsDue();
      this.processDue();
      this.#launchQueued();
      const delay = this.#nextDelayMilliseconds();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        this.#wakeResolver = finish;
      });
    }
  }

  #nextDelayMilliseconds(): number {
    const deadlines: number[] = [];
    const bucket = this.#store.orm
      .all<{ deadline_at: string }>(
        sql`SELECT b.deadline_at FROM buckets b
         JOIN conversations v ON v.id = b.conversation_id
         WHERE b.state = 'collecting'
           AND NOT EXISTS (
             SELECT 1 FROM invocations i
             JOIN conversations v2 ON v2.id = i.conversation_id
             WHERE v2.chat_id = v.chat_id AND i.state IN ('queued', 'running')
           )
         ORDER BY b.deadline_at, b.id LIMIT 1`,
      )
      .at(0);
    if (bucket !== undefined) {
      deadlines.push(Date.parse(bucket.deadline_at));
    }
    const alarm = this.#store.orm
      .all<{ scheduled_at: string }>(
        sql`SELECT a.scheduled_at FROM alarms a
         JOIN conversations v ON v.id = a.conversation_id
         WHERE a.state = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM invocations i
             JOIN conversations v2 ON v2.id = i.conversation_id
             WHERE v2.chat_id = v.chat_id AND i.state IN ('queued', 'running')
           )
         ORDER BY a.scheduled_at, a.id LIMIT 1`,
      )
      .at(0);
    if (alarm !== undefined) {
      deadlines.push(Date.parse(alarm.scheduled_at));
    }
    if (deadlines.length === 0) {
      return 60_000;
    }
    const next = Math.min(...deadlines);
    return Math.max(0, Math.min(60_000, next - Date.now()));
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
    this.#snapshotInvocation(invocationId, bucketId, conversationId, includeHistory);
    return invocationId;
  }

  #snapshotInvocation(invocationId: bigint, bucketId: bigint, conversationId: bigint, includeHistory: boolean): void {
    // History stops at the per-chat context cutoff (`/cut_topic`), if one
    // exists: messages at or below the cutoff Telegram message ID never enter
    // a new invocation snapshot. Live bucket messages are unaffected.
    const history = includeHistory
      ? this.#store.orm
          .all<MessageSnapshotRow>(
            sql`SELECT m.id AS message_id, m.conversation_id, v.message_thread_id,
                  r.id AS revision_id, m.telegram_message_id, m.telegram_date, m.sent_by_bot,
                  r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.reply_snapshot_json,
                  r.forward_origin_json, r.media_group_id, s.telegram_id AS sender_telegram_id,
                  s.display_name AS sender_display_name, s.username AS sender_username, NULL AS source_bucket_id
           FROM messages m
           JOIN conversations v ON v.id = m.conversation_id
           JOIN message_revisions r ON r.id = m.current_revision_id
           LEFT JOIN senders s ON s.id = r.sender_id
           WHERE m.conversation_id = ${conversationId} AND m.visible = 1
             AND (v.chat_id NOT IN (SELECT chat_id FROM chat_context_cutoffs)
                  OR m.telegram_message_id > (SELECT telegram_message_id FROM chat_context_cutoffs WHERE chat_id = v.chat_id))
             AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.bucket_id = ${bucketId} AND bm.message_id = m.id)
           ORDER BY m.telegram_date DESC, m.telegram_message_id DESC
           LIMIT ${BigInt(this.#config.agent.history_messages)}`,
          )
          .reverse()
      : [];
    const current = this.#store.orm.all<MessageSnapshotRow>(
      sql`SELECT m.id AS message_id, m.conversation_id, v.message_thread_id,
              r.id AS revision_id, m.telegram_message_id, m.telegram_date, m.sent_by_bot,
              r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.reply_snapshot_json,
              r.forward_origin_json, r.media_group_id, s.telegram_id AS sender_telegram_id,
              s.display_name AS sender_display_name, s.username AS sender_username, bm.source_bucket_id
         FROM bucket_messages bm
         JOIN messages m ON m.id = bm.message_id
         JOIN conversations v ON v.id = m.conversation_id
         JOIN message_revisions r ON r.id = m.current_revision_id
         LEFT JOIN senders s ON s.id = r.sender_id
         WHERE bm.bucket_id = ${bucketId} ORDER BY bm.sequence_no`,
    );
    let sequence = 1n;
    for (const message of history) {
      this.#insertSnapshot(invocationId, message, 'history', sequence);
      sequence += 1n;
    }
    for (const message of current) {
      this.#insertSnapshot(invocationId, message, 'new', sequence);
      sequence += 1n;
    }
  }

  #insertSnapshot(
    invocationId: bigint,
    message: MessageSnapshotRow,
    section: 'history' | 'new',
    sequence: bigint,
  ): void {
    const mediaRows = this.#store.orm
      .select({
        id: media.id,
        kind: media.kind,
        fileUniqueId: media.fileUniqueId,
        mimeType: media.mimeType,
        width: media.width,
        height: media.height,
      })
      .from(media)
      .where(eq(media.revisionId, message.revision_id))
      .orderBy(media.id)
      .all()
      .map((entry) => ({
        id: entry.id.toString(),
        kind: entry.kind,
        file_unique_id: entry.fileUniqueId,
        mime_type: entry.mimeType,
        width: entry.width?.toString() ?? null,
        height: entry.height?.toString() ?? null,
      }));
    const snapshot = JSON.stringify({
      message_id: message.telegram_message_id.toString(),
      message_thread_id: message.message_thread_id.toString(),
      telegram_date: message.telegram_date,
      sent_by_bot: message.sent_by_bot === 1n,
      revision: message.revision_no.toString(),
      sender: {
        id: message.sender_telegram_id?.toString() ?? null,
        name: message.sender_display_name,
        username: message.sender_username,
      },
      kind: message.kind,
      text: message.text,
      caption: message.caption,
      reply_to_message_id: message.reply_to_message_id?.toString() ?? null,
      reply_snapshot: message.reply_snapshot_json === null ? null : JSON.parse(message.reply_snapshot_json),
      forward_origin: message.forward_origin_json === null ? null : JSON.parse(message.forward_origin_json),
      media_group_id: message.media_group_id,
      media: mediaRows,
    });
    this.#store.orm
      .insert(invocationMessages)
      .values({
        invocationId,
        messageId: message.message_id,
        revisionId: message.revision_id,
        section,
        sequenceNo: sequence,
        sourceBucketId: message.source_bucket_id,
        snapshotJson: snapshot,
      })
      .run();
  }

  #launchQueued(): void {
    const sleepUntil = activeSleepUntil(this.#store.orm);
    if (sleepUntil !== null) {
      this.#skipQueuedInvocations(sleepUntil, new Date());
    }
    while (this.#running && this.#active.size < this.#config.agent.max_concurrency) {
      const invocation = this.#store.transaction(() => {
        const candidate = this.#store.orm
          .all<InvocationRow>(
            sql`SELECT i.id, i.bucket_id, i.conversation_id FROM invocations i
             JOIN buckets b ON b.id = i.bucket_id
             JOIN conversations v ON v.id = i.conversation_id
             LEFT JOIN alarms a ON a.invocation_id = i.id AND a.state = 'firing'
             WHERE i.state = 'queued' AND b.deadline_at <= ${new Date().toISOString()}
               AND NOT EXISTS (
                 SELECT 1 FROM invocations r
                 JOIN conversations v2 ON v2.id = r.conversation_id
                 WHERE v2.chat_id = v.chat_id AND r.state = 'running'
               )
             ORDER BY CASE WHEN a.id IS NOT NULL THEN 0 ELSE 1 END, i.id
             LIMIT 1`,
          )
          .at(0);
        if (candidate === undefined) {
          return null;
        }
        const now = new Date().toISOString();
        this.#store.orm
          .update(invocations)
          .set({ state: 'running', startedAt: now })
          .where(eq(invocations.id, candidate.id))
          .run();
        this.#store.orm
          .update(buckets)
          .set({ state: 'running', startedAt: now, updatedAt: now })
          .where(eq(buckets.id, candidate.bucket_id))
          .run();
        return candidate;
      });
      if (invocation === null) {
        return;
      }
      const controller = new AbortController();
      const promise = this.#execute(invocation, controller);
      this.#active.set(invocation.id.toString(), { controller, promise });
    }
  }

  #skipQueuedInvocations(sleepUntil: string, now: Date): void {
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

  async #execute(invocation: InvocationRow, controller: AbortController): Promise<void> {
    const executionStartedAt = performance.now();
    this.#logInvocationDiagnostic('agent_invocation_start', invocation, this.#active.size + 1, null, null, null);
    let outcome: InvocationOutcome;
    try {
      outcome = await this.#handler(invocation.id, controller.signal);
    } catch (error) {
      outcome = {
        state: controller.signal.aborted ? 'aborted' : 'failed',
        reason: error instanceof Error ? error.name : 'invocation_error',
      };
    }
    const finishedAt = new Date();
    let persisted = false;
    try {
      this.#store.transaction(() => {
        const nowIso = finishedAt.toISOString();
        this.#store.orm
          .update(invocations)
          .set({ state: outcome.state, completionReason: outcome.reason, finishedAt: nowIso })
          .where(and(eq(invocations.id, invocation.id), eq(invocations.state, 'running')))
          .run();
        this.#store.orm
          .update(buckets)
          .set({ state: outcome.state, finishedAt: nowIso, updatedAt: nowIso })
          .where(and(eq(buckets.id, invocation.bucket_id), eq(buckets.state, 'running')))
          .run();
        const started = this.#store.orm
          .all<{ started_at: string }>(sql`SELECT started_at FROM invocations WHERE id = ${invocation.id}`)
          .at(0);
        if (started === undefined) {
          throw new Error(`Invocation ${invocation.id} has no start time`);
        }
        const nextDeadline = new Date(
          Math.max(
            finishedAt.getTime(),
            Date.parse(started.started_at) + this.#config.telegram.bucket_window_seconds * 1_000,
          ),
        ).toISOString();
        const chat = this.#store.orm
          .select({ chatId: conversations.chatId })
          .from(conversations)
          .where(eq(conversations.id, invocation.conversation_id))
          .get();
        if (chat === undefined) {
          throw new Error(`Invocation ${invocation.id} has no chat`);
        }
        this.#store.orm.run(
          sql`UPDATE buckets SET deadline_at = ${nextDeadline}, updated_at = ${nowIso}
             WHERE conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chat.chatId})
               AND state = 'collecting' AND deadline_at < ${nextDeadline}`,
        );
        this.#store.orm
          .update(alarms)
          .set({
            state: 'fired',
            invocationOutcome: outcome.state,
            completionReason: outcome.reason,
            updatedAt: nowIso,
          })
          .where(and(eq(alarms.invocationId, invocation.id), eq(alarms.state, 'firing')))
          .run();
      });
      persisted = true;
    } finally {
      this.#active.delete(invocation.id.toString());
      if (persisted) {
        this.processAlarmsDue(finishedAt);
        this.processDue(finishedAt);
      }
      this.#logInvocationDiagnostic(
        'agent_invocation_end',
        invocation,
        this.#active.size,
        Math.round(performance.now() - executionStartedAt),
        outcome,
        persisted,
      );
      this.wake();
    }
  }

  #logInvocationDiagnostic(
    event: 'agent_invocation_start' | 'agent_invocation_end',
    invocation: InvocationRow,
    activeAgentSessions: number,
    durationMs: number | null,
    outcome: InvocationOutcome | null,
    persisted: boolean | null,
  ): void {
    try {
      const now = new Date();
      const row = this.#store.orm
        .all<InvocationDiagnosticRow>(
          sql`SELECT c.telegram_chat_id,
                  (SELECT COUNT(*) FROM bucket_messages bm WHERE bm.bucket_id = ${invocation.bucket_id}) AS bucket_message_count,
                  (SELECT COUNT(*) FROM buckets pb WHERE pb.state IN ('collecting', 'queued')) AS pending_bucket_count,
                  (SELECT COUNT(*) FROM buckets pb
                   JOIN conversations pv ON pv.id = pb.conversation_id
                   WHERE pv.chat_id = v.chat_id AND pb.state IN ('collecting', 'queued')) AS chat_pending_bucket_count,
                  (SELECT MAX(prior.started_at) FROM invocations prior
                   JOIN conversations prior_v ON prior_v.id = prior.conversation_id
                   WHERE prior_v.chat_id = v.chat_id AND prior.id < ${invocation.id} AND prior.started_at IS NOT NULL) AS previous_started_at
           FROM conversations v
           JOIN chats c ON c.id = v.chat_id
           WHERE v.id = ${invocation.conversation_id}`,
        )
        .at(0);
      if (row === undefined) {
        throw new Error('invocation_conversation_missing');
      }
      const currentStartedAt =
        this.#store.orm
          .all<{ started_at: string | null }>(sql`SELECT started_at FROM invocations WHERE id = ${invocation.id}`)
          .at(0)?.started_at ?? null;
      const recentInvocations =
        this.#store.orm
          .all<{ count: bigint }>(
            sql`SELECT COUNT(*) AS count FROM invocations WHERE started_at >= ${new Date(now.getTime() - 60_000).toISOString()}`,
          )
          .at(0)?.count ?? 0n;
      const memory = process.memoryUsage();
      let gcMemory: NodeJS.MemoryUsage | null = null;
      if (event === 'agent_invocation_end' && now.getTime() - this.#lastForcedGcAt >= 60_000) {
        this.#lastForcedGcAt = now.getTime();
        Bun.gc(true);
        gcMemory = process.memoryUsage();
      }
      console.log(
        JSON.stringify({
          event,
          invocation_id: invocation.id.toString(),
          session_id: invocation.id.toString(),
          chat_id: row.telegram_chat_id.toString(),
          bucket_message_count: Number(row.bucket_message_count),
          pending_bucket_count: Number(row.pending_bucket_count),
          chat_pending_bucket_count: Number(row.chat_pending_bucket_count),
          active_agent_sessions: activeAgentSessions,
          invocations_started_last_minute: Number(recentInvocations),
          invocation_duration_ms: durationMs,
          previous_invocation_gap_ms:
            currentStartedAt === null || row.previous_started_at === null
              ? null
              : Date.parse(currentStartedAt) - Date.parse(row.previous_started_at),
          outcome_state: outcome?.state ?? null,
          outcome_reason: outcome?.reason ?? null,
          terminal_state_persisted: persisted,
          rss_bytes: memory.rss,
          heap_used_bytes: memory.heapUsed,
          heap_total_bytes: memory.heapTotal,
          external_bytes: memory.external,
          array_buffers_bytes: memory.arrayBuffers,
          forced_gc: gcMemory !== null,
          gc_rss_bytes: gcMemory?.rss ?? null,
          gc_heap_used_bytes: gcMemory?.heapUsed ?? null,
          gc_heap_total_bytes: gcMemory?.heapTotal ?? null,
          gc_external_bytes: gcMemory?.external ?? null,
          gc_array_buffers_bytes: gcMemory?.arrayBuffers ?? null,
          bun_version: Bun.version,
          at: now.toISOString(),
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          event: 'agent_invocation_diagnostic_failed',
          invocation_id: invocation.id.toString(),
          error: error instanceof Error ? error.name : 'diagnostic_error',
          at: new Date().toISOString(),
        }),
      );
    }
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
