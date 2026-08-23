import type { RawConfig } from './config.ts';
import { type SqliteStore, isChatPaused, resolveChatConfig } from './database.ts';

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
    if (this.#running) throw new Error('Bucket scheduler is already running');
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
      const row = this.#store.db
        .query<{ chat_id: bigint }, [bigint]>(
          'SELECT v.chat_id FROM invocations i JOIN conversations v ON v.id = i.conversation_id WHERE i.id = ?',
        )
        .get(BigInt(id));
      if (row !== null && row.chat_id === chatId) entry.controller.abort(new Error('chat_paused'));
    }
  }

  async stop(graceMilliseconds = 30_000): Promise<void> {
    this.#running = false;
    this.wake();
    await this.#loopPromise;
    const active = [...this.#active.values()];
    if (active.length === 0) return;
    const finished = Promise.allSettled(active.map((entry) => entry.promise));
    let graceTimer: NodeJS.Timeout | undefined;
    const graceElapsed = new Promise<'timeout'>((resolve) => {
      graceTimer = setTimeout(() => resolve('timeout'), graceMilliseconds);
    });
    const result = await Promise.race([finished, graceElapsed]);
    clearTimeout(graceTimer);
    if (result === 'timeout') {
      for (const entry of active) entry.controller.abort(new Error('shutdown'));
      await finished;
    }
  }

  recover(now = new Date()): void {
    this.#store.transaction(() => {
      const nowIso = now.toISOString();
      const staleBefore = new Date(now.getTime() - RECOVERY_MAX_AGE_MS).toISOString();
      this.#store.db
        .query(
          "UPDATE invocations SET state = CASE WHEN side_effect_started = 1 THEN 'outcome_unknown' ELSE 'aborted' END, completion_reason = 'process_restart', finished_at = ? WHERE state = 'running'",
        )
        .run(nowIso);
      this.#store.db
        .query(
          "UPDATE buckets SET state = CASE WHEN EXISTS (SELECT 1 FROM invocations i WHERE i.bucket_id = buckets.id AND i.state = 'outcome_unknown') THEN 'outcome_unknown' ELSE 'aborted' END, error_code = 'process_restart', finished_at = ?, updated_at = ? WHERE state = 'running'",
        )
        .run(nowIso, nowIso);
      const expiring = this.#store.db
        .query<{ id: bigint }, [string]>(
          "SELECT id FROM buckets WHERE state IN ('collecting', 'queued') AND first_received_at < ? ORDER BY id",
        )
        .all(staleBefore);
      for (const bucket of expiring) {
        this.#store.db
          .query(
            "UPDATE buckets SET state = 'expired', error_code = 'recovery_age', finished_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(nowIso, nowIso, bucket.id);
        this.#store.db
          .query(
            "UPDATE invocations SET state = 'aborted', completion_reason = 'recovery_age', finished_at = ? WHERE bucket_id = ? AND state = 'queued'",
          )
          .run(nowIso, bucket.id);
      }
    });
  }

  finishStartupCatchUp(startedAt: Date, now = new Date()): bigint[] {
    return this.#store.transaction(() => {
      const state = this.#store.db
        .query<{ value: string }, [string]>('SELECT value FROM app_state WHERE key = ?')
        .get(STARTUP_CATCH_UP_STATE_KEY);
      if (state?.value !== startedAt.toISOString()) {
        throw new Error('Startup catch-up state changed before scheduling');
      }
      const selected = this.#store.db
        .query<StartupMessageRow, [string, bigint]>(
          `WITH session_messages AS (
             SELECT m.id, m.conversation_id, m.chat_id, c.telegram_chat_id,
                    m.telegram_message_id, m.telegram_date,
                    CASE WHEN r.kind <> 'service' AND COALESCE(s.is_bot, 0) = 0 THEN 1 ELSE 0 END AS eligible_human
             FROM messages m
             JOIN message_revisions r ON r.id = m.current_revision_id
             LEFT JOIN senders s ON s.id = r.sender_id
             JOIN chats c ON c.id = m.chat_id
             WHERE m.received_at >= ? AND m.visible = 1 AND m.sent_by_bot = 0
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
           WHERE message_rank <= ?
           ORDER BY chat_id, telegram_date, telegram_message_id`,
        )
        .all(startedAt.toISOString(), BigInt(this.#config.agent.history_messages));
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
        if (latest === undefined) continue;
        const budget = resolveChatConfig(this.#config, this.#store.db, latest.telegram_chat_id)?.budget;
        const skipReason =
          budget === undefined
            ? 'chat_removed'
            : isChatPaused(this.#store.db, latest.chat_id)
              ? 'chat_paused'
              : this.#reserveInvocation(latest.telegram_chat_id, budget.max_invocations_per_day, now)
                ? undefined
                : 'invocation_budget';
        const created =
          skipReason === undefined
            ? this.#store.db
                .query(
                  "INSERT INTO buckets(conversation_id, state, kind, first_received_at, deadline_at, queued_at, created_at, updated_at) VALUES (?, 'queued', 'startup_catch_up', ?, ?, ?, ?, ?)",
                )
                .run(latest.conversation_id, startedAt.toISOString(), timestamp, timestamp, timestamp, timestamp)
            : this.#store.db
                .query(
                  "INSERT INTO buckets(conversation_id, state, kind, first_received_at, deadline_at, finished_at, error_code, created_at, updated_at) VALUES (?, 'skipped_budget', 'startup_catch_up', ?, ?, ?, ?, ?, ?)",
                )
                .run(
                  latest.conversation_id,
                  startedAt.toISOString(),
                  timestamp,
                  timestamp,
                  skipReason,
                  timestamp,
                  timestamp,
                );
        const bucketId = BigInt(created.lastInsertRowid);
        for (const [sequence, message] of messages.entries()) {
          this.#store.db
            .query(
              'INSERT INTO bucket_messages(bucket_id, message_id, sequence_no, source_bucket_id) VALUES (?, ?, ?, ?)',
            )
            .run(bucketId, message.id, BigInt(sequence + 1), bucketId);
        }
        if (skipReason === undefined) {
          invocationIds.push(this.#insertInvocation(bucketId, latest.conversation_id, now, false));
        }
      }
      const cleared = this.#store.db
        .query('DELETE FROM app_state WHERE key = ? AND value = ?')
        .run(STARTUP_CATCH_UP_STATE_KEY, startedAt.toISOString());
      if (cleared.changes !== 1) throw new Error('Startup catch-up state was not cleared');
      return invocationIds;
    });
  }

  processDue(now = new Date()): bigint[] {
    return this.#store.transaction(() => {
      const due = this.#store.db
        .query<BucketRow, [string, string]>(
          `SELECT b.id, b.conversation_id, b.first_received_at, b.deadline_at
           FROM buckets b
           JOIN conversations v ON v.id = b.conversation_id
           WHERE b.state = 'collecting' AND b.deadline_at <= ? AND b.first_received_at >= ?
             AND NOT EXISTS (SELECT 1 FROM chat_pause p WHERE p.chat_id = v.chat_id)
             AND NOT EXISTS (
               SELECT 1 FROM invocations i
               JOIN conversations v2 ON v2.id = i.conversation_id
               WHERE v2.chat_id = v.chat_id AND i.state IN ('queued', 'running')
             )
           ORDER BY b.deadline_at, b.id`,
        )
        .all(now.toISOString(), new Date(now.getTime() - RECOVERY_MAX_AGE_MS).toISOString());
      const invocations: bigint[] = [];
      for (const bucket of due) {
        const invocationId = this.#queueBucket(bucket, now);
        if (invocationId !== undefined) invocations.push(invocationId);
      }
      return invocations;
    });
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      this.processDue();
      this.#launchQueued();
      const delay = this.#nextDelayMilliseconds();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
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
    const row = this.#store.db
      .query<{ deadline_at: string }, []>(
        `SELECT b.deadline_at FROM buckets b
         JOIN conversations v ON v.id = b.conversation_id
         WHERE b.state = 'collecting'
           AND NOT EXISTS (
             SELECT 1 FROM invocations i
             JOIN conversations v2 ON v2.id = i.conversation_id
             WHERE v2.chat_id = v.chat_id AND i.state IN ('queued', 'running')
           )
         ORDER BY b.deadline_at, b.id LIMIT 1`,
      )
      .get();
    if (row === null) return 60_000;
    return Math.max(0, Math.min(60_000, Date.parse(row.deadline_at) - Date.now()));
  }

  #queueBucket(bucket: BucketRow, now: Date): bigint | undefined {
    const chat = this.#store.db
      .query<{ telegram_chat_id: bigint; paused: bigint }, [bigint]>(
        `SELECT c.telegram_chat_id,
                EXISTS(SELECT 1 FROM chat_pause p WHERE p.chat_id = c.id) AS paused
         FROM conversations v JOIN chats c ON c.id = v.chat_id WHERE v.id = ?`,
      )
      .get(bucket.conversation_id);
    if (chat === null) throw new Error(`Bucket ${bucket.id} has no chat`);
    if (chat.paused === 1n) {
      this.#markBucketSkipped(bucket.id, now, 'chat_paused');
      return undefined;
    }
    const budget = resolveChatConfig(this.#config, this.#store.db, chat.telegram_chat_id)?.budget;
    if (budget === undefined) {
      this.#markBucketSkipped(bucket.id, now, 'chat_removed');
      return undefined;
    }
    if (!this.#reserveInvocation(chat.telegram_chat_id, budget.max_invocations_per_day, now)) {
      this.#markBucketSkipped(bucket.id, now, 'invocation_budget');
      return undefined;
    }
    this.#store.db
      .query("UPDATE buckets SET state = 'queued', queued_at = ?, updated_at = ? WHERE id = ? AND state = 'collecting'")
      .run(now.toISOString(), now.toISOString(), bucket.id);
    return this.#insertInvocation(bucket.id, bucket.conversation_id, now, true);
  }

  #insertInvocation(bucketId: bigint, conversationId: bigint, now: Date, includeHistory: boolean): bigint {
    const created = this.#store.db
      .query(
        "INSERT INTO invocations(bucket_id, conversation_id, state, config_hash, prompt_version, created_at) VALUES (?, ?, 'queued', ?, ?, ?)",
      )
      .run(bucketId, conversationId, this.#configHash, 1n, now.toISOString());
    const invocationId = BigInt(created.lastInsertRowid);
    this.#snapshotInvocation(invocationId, bucketId, conversationId, includeHistory);
    return invocationId;
  }

  #snapshotInvocation(invocationId: bigint, bucketId: bigint, conversationId: bigint, includeHistory: boolean): void {
    const history = includeHistory
      ? this.#store.db
          .query<MessageSnapshotRow, [bigint, bigint, bigint]>(
            `SELECT m.id AS message_id, m.conversation_id, v.message_thread_id,
                  r.id AS revision_id, m.telegram_message_id, m.telegram_date, m.sent_by_bot,
                  r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.reply_snapshot_json,
                  r.forward_origin_json, r.media_group_id, s.telegram_id AS sender_telegram_id,
                  s.display_name AS sender_display_name, s.username AS sender_username, NULL AS source_bucket_id
           FROM messages m
           JOIN conversations v ON v.id = m.conversation_id
           JOIN message_revisions r ON r.id = m.current_revision_id
           LEFT JOIN senders s ON s.id = r.sender_id
           WHERE m.conversation_id = ? AND m.visible = 1
             AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.bucket_id = ? AND bm.message_id = m.id)
           ORDER BY m.telegram_date DESC, m.telegram_message_id DESC
           LIMIT ?`,
          )
          .all(conversationId, bucketId, BigInt(this.#config.agent.history_messages))
          .reverse()
      : [];
    const current = this.#store.db
      .query<MessageSnapshotRow, [bigint]>(
        `SELECT m.id AS message_id, m.conversation_id, v.message_thread_id,
                r.id AS revision_id, m.telegram_message_id, m.telegram_date, m.sent_by_bot,
                r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.reply_snapshot_json,
                r.forward_origin_json, r.media_group_id, s.telegram_id AS sender_telegram_id,
                s.display_name AS sender_display_name, s.username AS sender_username, bm.source_bucket_id
         FROM bucket_messages bm
         JOIN messages m ON m.id = bm.message_id
         JOIN conversations v ON v.id = m.conversation_id
         JOIN message_revisions r ON r.id = m.current_revision_id
         LEFT JOIN senders s ON s.id = r.sender_id
         WHERE bm.bucket_id = ? ORDER BY bm.sequence_no`,
      )
      .all(bucketId);
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
    const media = this.#store.db
      .query<
        {
          id: bigint;
          kind: string;
          file_unique_id: string;
          mime_type: string | null;
          width: bigint | null;
          height: bigint | null;
        },
        [bigint]
      >('SELECT id, kind, file_unique_id, mime_type, width, height FROM media WHERE revision_id = ? ORDER BY id')
      .all(message.revision_id)
      .map((entry) => ({
        id: entry.id.toString(),
        kind: entry.kind,
        file_unique_id: entry.file_unique_id,
        mime_type: entry.mime_type,
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
      media,
    });
    this.#store.db
      .query(
        'INSERT INTO invocation_messages(invocation_id, message_id, revision_id, section, sequence_no, source_bucket_id, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        invocationId,
        message.message_id,
        message.revision_id,
        section,
        sequence,
        message.source_bucket_id,
        snapshot,
      );
  }

  #launchQueued(): void {
    while (this.#running && this.#active.size < this.#config.agent.max_concurrency) {
      const invocation = this.#store.transaction(() => {
        const candidate = this.#store.db
          .query<InvocationRow, [string]>(
            `SELECT i.id, i.bucket_id, i.conversation_id FROM invocations i
             JOIN buckets b ON b.id = i.bucket_id
             JOIN conversations v ON v.id = i.conversation_id
             WHERE i.state = 'queued' AND b.deadline_at <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM invocations r
                 JOIN conversations v2 ON v2.id = r.conversation_id
                 WHERE v2.chat_id = v.chat_id AND r.state = 'running'
               )
             ORDER BY i.id LIMIT 1`,
          )
          .get(new Date().toISOString());
        if (candidate === null) return null;
        const now = new Date().toISOString();
        this.#store.db
          .query("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
          .run(now, candidate.id);
        this.#store.db
          .query("UPDATE buckets SET state = 'running', started_at = ?, updated_at = ? WHERE id = ?")
          .run(now, now, candidate.bucket_id);
        return candidate;
      });
      if (invocation === null) return;
      const controller = new AbortController();
      const promise = this.#execute(invocation, controller);
      this.#active.set(invocation.id.toString(), { controller, promise });
    }
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
        this.#store.db
          .query(
            "UPDATE invocations SET state = ?, completion_reason = ?, finished_at = ? WHERE id = ? AND state = 'running'",
          )
          .run(outcome.state, outcome.reason, nowIso, invocation.id);
        this.#store.db
          .query("UPDATE buckets SET state = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'")
          .run(outcome.state, nowIso, nowIso, invocation.bucket_id);
        const started = this.#store.db
          .query<{ started_at: string }, [bigint]>('SELECT started_at FROM invocations WHERE id = ?')
          .get(invocation.id);
        if (started === null) throw new Error(`Invocation ${invocation.id} has no start time`);
        const nextDeadline = new Date(
          Math.max(
            finishedAt.getTime(),
            Date.parse(started.started_at) + this.#config.telegram.bucket_window_seconds * 1_000,
          ),
        ).toISOString();
        const chat = this.#store.db
          .query<{ chat_id: bigint }, [bigint]>('SELECT chat_id FROM conversations WHERE id = ?')
          .get(invocation.conversation_id);
        if (chat === null) throw new Error(`Invocation ${invocation.id} has no chat`);
        this.#store.db
          .query(
            `UPDATE buckets SET deadline_at = ?, updated_at = ?
             WHERE conversation_id IN (SELECT id FROM conversations WHERE chat_id = ?)
               AND state = 'collecting' AND deadline_at < ?`,
          )
          .run(nextDeadline, nowIso, chat.chat_id, nextDeadline);
      });
      persisted = true;
    } finally {
      this.#active.delete(invocation.id.toString());
      if (persisted) this.processDue(finishedAt);
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
      const row = this.#store.db
        .query<InvocationDiagnosticRow, [bigint, bigint, bigint]>(
          `SELECT c.telegram_chat_id,
                  (SELECT COUNT(*) FROM bucket_messages bm WHERE bm.bucket_id = ?) AS bucket_message_count,
                  (SELECT COUNT(*) FROM buckets pb WHERE pb.state IN ('collecting', 'queued')) AS pending_bucket_count,
                  (SELECT COUNT(*) FROM buckets pb
                   JOIN conversations pv ON pv.id = pb.conversation_id
                   WHERE pv.chat_id = v.chat_id AND pb.state IN ('collecting', 'queued')) AS chat_pending_bucket_count,
                  (SELECT MAX(prior.started_at) FROM invocations prior
                   JOIN conversations prior_v ON prior_v.id = prior.conversation_id
                   WHERE prior_v.chat_id = v.chat_id AND prior.id < ? AND prior.started_at IS NOT NULL) AS previous_started_at
           FROM conversations v
           JOIN chats c ON c.id = v.chat_id
           WHERE v.id = ?`,
        )
        .get(invocation.bucket_id, invocation.id, invocation.conversation_id);
      if (row === null) throw new Error('invocation_conversation_missing');
      const currentStartedAt =
        this.#store.db
          .query<{ started_at: string | null }, [bigint]>('SELECT started_at FROM invocations WHERE id = ?')
          .get(invocation.id)?.started_at ?? null;
      const recentInvocations =
        this.#store.db
          .query<{ count: bigint }, [string]>('SELECT COUNT(*) AS count FROM invocations WHERE started_at >= ?')
          .get(new Date(now.getTime() - 60_000).toISOString())?.count ?? 0n;
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
      this.#store.db
        .query<{ amount: bigint }, [string, string]>(
          "SELECT amount FROM daily_usage WHERE utc_date = ? AND scope = 'chat' AND resource = ? AND metric = 'agent_invocations'",
        )
        .get(date, resource)?.amount ?? 0n;
    if (current >= BigInt(limit)) return false;
    this.#store.db
      .query(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'agent_invocations', 1, ?) ON CONFLICT(utc_date, scope, resource, metric) DO UPDATE SET amount = amount + 1, updated_at = excluded.updated_at",
      )
      .run(date, resource, now.toISOString());
    return true;
  }

  #markBucketSkipped(bucketId: bigint, now: Date, reason: string): void {
    const timestamp = now.toISOString();
    this.#store.db
      .query(
        "UPDATE buckets SET state = 'skipped_budget', error_code = ?, finished_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(reason, timestamp, timestamp, bucketId);
  }
}
