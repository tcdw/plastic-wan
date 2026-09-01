import { and, eq, sql } from 'drizzle-orm';
import type { RawConfig } from '../platform/config.ts';
import type { SqliteStore } from '../store/database.ts';
import { InvocationQueueService } from './invocation-queue.ts';
import { activeSleepUntil } from '../store/sleep.ts';
import { alarms, buckets, conversations, invocations } from '../store/schema.ts';

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

interface InvocationRow {
  readonly id: bigint;
  readonly bucket_id: bigint;
  readonly conversation_id: bigint;
}

export { STARTUP_CATCH_UP_STATE_KEY } from './invocation-queue.ts';

/**
 * Event loop and concurrency governor. Delegates bucket/alarm state
 * transitions to InvocationQueueService and agent execution to the
 * InvocationHandler, then persists terminal outcomes.
 */
export class BucketScheduler {
  readonly #store: SqliteStore;
  readonly #config: RawConfig;
  readonly #queue: InvocationQueueService;
  readonly #handler: InvocationHandler;
  readonly #active = new Map<string, ActiveInvocation>();
  #running = false;
  #wakeResolver: (() => void) | undefined;
  #loopPromise: Promise<void> | undefined;
  #lastForcedGcAt = 0;

  constructor(store: SqliteStore, config: RawConfig, configHash: string, handler: InvocationHandler) {
    this.#store = store;
    this.#config = config;
    this.#queue = new InvocationQueueService(store, config, configHash);
    this.#handler = handler;
  }

  start(now = new Date()): void {
    if (this.#running) {
      throw new Error('Bucket scheduler is already running');
    }
    this.#queue.recover(now);
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
    this.#queue.recover(now);
  }

  finishStartupCatchUp(startedAt: Date, now = new Date()): bigint[] {
    return this.#queue.finishStartupCatchUp(startedAt, now);
  }

  processDue(now = new Date()): bigint[] {
    return this.#queue.processDue(now);
  }

  processAlarmsDue(now = new Date()): bigint[] {
    return this.#queue.processAlarmsDue(now);
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

  #launchQueued(): void {
    const sleepUntil = activeSleepUntil(this.#store.orm);
    if (sleepUntil !== null) {
      this.#queue.skipQueuedInvocations(sleepUntil, new Date());
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
}
