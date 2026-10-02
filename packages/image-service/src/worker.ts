import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { ImageService } from './assets.ts';
import type { ImageConfigHandle } from './config.ts';
import type { GenerationStatus, SafeError } from './contracts.ts';
import type { ImageDatabase } from './db.ts';
import { AppError, storageFailure } from './errors.ts';
import { type AttemptRow, computeStatus, firstError, type GenerationRow } from './generations.ts';
import { decodeBase64Image, type ImageStore, MAX_IMAGE_BYTES } from './image-store.ts';
import { ProviderCallError, type ProviderClient, type ProviderResult } from './openrouter.ts';
import type { Redactor } from './redactor.ts';
import { redactWith } from './redactor.ts';
import { generationAttempts, generations } from './schema.ts';

/** Simple FIFO counting semaphore; bounds provider calls across the whole process. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits);
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    } else {
      this.permits += 1;
    }
  }
}

export type WorkerLogger = { warn: (message: string) => void } | null;

export type GenerationWorkerDeps = {
  db: ImageDatabase;
  config: ImageConfigHandle;
  images: ImageService;
  store: ImageStore;
  provider: ProviderClient;
  concurrency: number;
  providerTimeoutMs: number;
  shutdownTimeoutMs?: number;
  logger?: WorkerLogger;
  redactor: Redactor;
};

type ItemOutcome = { status: 'succeeded' | 'failed' | 'interrupted'; error: SafeError | null };

const RESTART_ERROR: SafeError = {
  code: 'server_restart',
  message: '服务重启中断了该次上游调用，结果不确定',
  stage: 'interrupted',
};

/** The round was cut short while later items had no attempt yet; they were never sent. */
const INCOMPLETE_ROUND_ERROR: SafeError = {
  code: 'shutdown_incomplete',
  message: '服务中断了本轮执行，未执行的输出项不会自动重发',
  stage: 'interrupted',
};

type RoundVerdict = { status: GenerationStatus; error: SafeError | null };

/**
 * Verdict for a round from its recorded attempts and the item count it was authored
 * with. An item without an attempt was never sent upstream, so it counts as
 * interrupted: a round that is missing items can only be partial (something was
 * delivered) or interrupted, never succeeded. A round with no attempt at all stays
 * queued — nothing was sent, so a restart can resume it with no paid retry.
 */
function roundVerdict(attempts: AttemptRow[], expectedOutputCount: number): RoundVerdict {
  if (attempts.length === 0) {
    return { status: 'queued', error: null };
  }
  const status = computeStatus(attempts);
  const covered = new Set(attempts.map((attempt) => attempt.itemIndex));
  const missingItems = Array.from({ length: expectedOutputCount }, (_, itemIndex) => itemIndex).some(
    (itemIndex) => !covered.has(itemIndex),
  );
  if (!missingItems) {
    return { status, error: status === 'succeeded' ? null : firstError(attempts) };
  }
  let incomplete: GenerationStatus = status;
  if (status === 'succeeded') {
    incomplete = 'partial';
  } else if (status === 'failed') {
    incomplete = 'interrupted';
  }
  return { status: incomplete, error: firstError(attempts) ?? INCOMPLETE_ROUND_ERROR };
}

/**
 * Durable, bounded executor: one upstream call per output item per round, a finite
 * global concurrency, no implicit retries, and honest recovery after a restart.
 * A round resolves its credential exactly once, when execution starts; all items
 * share that value even if the configuration is republished mid-round.
 */
export class GenerationWorker {
  private readonly db: ImageDatabase;
  private readonly config: ImageConfigHandle;
  private readonly images: ImageService;
  private readonly store: ImageStore;
  private readonly provider: ProviderClient;
  private readonly semaphore: Semaphore;
  private readonly providerTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly logger: WorkerLogger;
  private readonly redactor: Redactor;
  private queue: string[] = [];
  private queued = new Set<string>();
  private inFlight = new Set<Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private pumping = false;
  private stopping = false;
  private started = false;
  private unsubConfig: (() => void) | null = null;

  constructor(deps: GenerationWorkerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.images = deps.images;
    this.store = deps.store;
    this.provider = deps.provider;
    this.semaphore = new Semaphore(deps.concurrency);
    this.providerTimeoutMs = deps.providerTimeoutMs;
    this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 5000;
    this.logger = deps.logger ?? null;
    this.redactor = deps.redactor;
  }

  get pending(): number {
    return this.queue.length + this.inFlight.size;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Recovery then drain: queued work resumes, running work is recorded as interrupted. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopping = false;
    // Wake-up is purely event-driven: the config store notifies every publish, and
    // only a publish of a usable snapshot can make queued work runnable.
    this.unsubConfig = this.config.onChange(() => {
      this.wake();
    });
    this.recoverInterrupted();
    const pending = this.db
      .select({ id: generations.id })
      .from(generations)
      .where(eq(generations.status, 'queued'))
      .orderBy(asc(generations.createdAt))
      .all();
    for (const row of pending) {
      this.enqueue(row.id);
    }
  }

  enqueue(generationId: string): void {
    if (this.stopping || !this.started) {
      return;
    }
    if (this.queued.has(generationId)) {
      return;
    }
    this.queued.add(generationId);
    this.queue.push(generationId);
    void this.pump();
  }

  /** Aborts in-flight calls, waits a bounded time for their attempts to be recorded. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.unsubConfig?.();
    this.unsubConfig = null;
    this.queue = [];
    this.queued.clear();
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    const deadline = Date.now() + this.shutdownTimeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([Promise.all([...this.inFlight]), delay(25)]);
    }
    if (this.inFlight.size > 0) {
      this.logger?.warn('关闭超时：仍有上游调用未收尾，已标记为中断');
    }
  }

  private recoverInterrupted(): void {
    const running = this.db.select().from(generationAttempts).where(eq(generationAttempts.status, 'running')).all();
    const now = new Date().toISOString();
    const affected = new Set<string>();
    for (const attempt of running) {
      affected.add(attempt.generationId);
      this.db
        .update(generationAttempts)
        .set({ status: 'interrupted', finishedAt: now, error: RESTART_ERROR })
        .where(eq(generationAttempts.id, attempt.id))
        .run();
    }

    // Recompute every generation that claims to be running: attempts that were
    // in flight become interrupted, and a round with no attempt at all (crash or
    // shutdown before the call was made) returns to queued so it can be resumed.
    // A round that already has attempts but is missing items stays partial or
    // interrupted: those items were never sent, so they are not a success.
    const claimed = this.db
      .select({ id: generations.id })
      .from(generations)
      .where(eq(generations.status, 'running'))
      .all();
    for (const row of claimed) {
      affected.add(row.id);
    }

    for (const generationId of affected) {
      const row = this.db.select().from(generations).where(eq(generations.id, generationId)).get();
      if (row === undefined) {
        continue;
      }
      const attempts = this.attemptsForRound(generationId, row.round);
      const verdict = roundVerdict(attempts, row.snapshot.authored.outputCount);
      this.db
        .update(generations)
        .set({
          status: verdict.status,
          error: verdict.error,
          finishedAt: verdict.status === 'queued' || verdict.status === 'running' ? null : now,
        })
        .where(eq(generations.id, generationId))
        .run();
    }
  }

  private attemptsForRound(generationId: string, round: number): AttemptRow[] {
    return this.db
      .select()
      .from(generationAttempts)
      .where(and(eq(generationAttempts.generationId, generationId), eq(generationAttempts.round, round)))
      .orderBy(asc(generationAttempts.itemIndex))
      .all();
  }

  /** Coalesced wake-up for publish events; pump() itself is re-entrancy safe. */
  private wake(): void {
    if (this.stopping || !this.started) {
      return;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (!this.stopping) {
        // No usable config snapshot means a queued generation cannot be attempted at
        // all: claiming it would record an attempt that failed before any provider
        // call, which is not an execution outcome and must not force a manual paid
        // retry. The generation stays queued in SQLite and in this queue; start()
        // subscribes to publishes above, so the next valid publish resumes it.
        // Nothing polls while the configuration is invalid.
        if (!this.config.hasValidConfig()) {
          break;
        }
        const next = this.queue.shift();
        if (next === undefined) {
          break;
        }
        this.queued.delete(next);
        const task = this.runGeneration(next).catch((error: unknown) => {
          this.logger?.warn(`生成任务执行异常：${redactWith(this.redactor, error)}`);
        });
        this.inFlight.add(task);
        void task.finally(() => {
          this.inFlight.delete(task);
        });
        // Phase 1 throughput simplification: generations are drained one at a time;
        // parallelism lives inside a round, where items share the bounded semaphore.
        await task;
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runGeneration(generationId: string): Promise<void> {
    const row = this.db.select().from(generations).where(eq(generations.id, generationId)).get();
    if (row === undefined || row.status !== 'queued') {
      return;
    }
    const now = new Date().toISOString();
    const claimed = this.db
      .update(generations)
      .set({ status: 'running', startedAt: now, finishedAt: null, error: null })
      .where(and(eq(generations.id, generationId), eq(generations.status, 'queued')))
      .run();
    if (claimed.changes === 0) {
      return;
    }

    const outputCount = row.snapshot.authored.outputCount;
    const items = Array.from({ length: outputCount }, (_, index) => index);
    // Round-scoped credential: resolved exactly once, when the round starts, and
    // shared by every output item. A mid-round republish never swaps the key.
    let credential: string;
    try {
      credential = this.config.credentialFor(row.snapshot.model);
    } catch (error) {
      const safe: SafeError =
        error instanceof AppError
          ? error.toSafeError()
          : { code: 'internal_error', message: '内部错误', stage: 'provider' };
      for (const itemIndex of items) {
        this.recordCredentialFailure(row, itemIndex, safe);
      }
      this.finalize(generationId, row.round);
      return;
    }
    await Promise.all(items.map((itemIndex) => this.runItem(row, itemIndex, credential)));
    this.finalize(generationId, row.round);
  }

  /** Records a failed attempt for an item that never reached the provider. */
  private recordCredentialFailure(row: GenerationRow, itemIndex: number, error: SafeError): void {
    const now = new Date().toISOString();
    this.db
      .insert(generationAttempts)
      .values({
        id: randomUUID(),
        generationId: row.id,
        round: row.round,
        itemIndex,
        status: 'failed',
        startedAt: now,
        finishedAt: now,
        error,
        providerRequestId: null,
        usage: null,
        outputAssetId: null,
      })
      .onConflictDoNothing()
      .run();
  }

  private async runItem(row: GenerationRow, itemIndex: number, credential: string): Promise<void> {
    if (this.stopping) {
      return;
    }
    await this.semaphore.acquire();
    const attemptId = randomUUID();
    const controller = new AbortController();
    this.controllers.set(attemptId, controller);
    try {
      if (this.stopping) {
        return;
      }
      const startedAt = new Date().toISOString();
      this.db
        .insert(generationAttempts)
        .values({
          id: attemptId,
          generationId: row.id,
          round: row.round,
          itemIndex,
          status: 'running',
          startedAt,
          finishedAt: null,
          error: null,
          providerRequestId: null,
          usage: null,
          outputAssetId: null,
        })
        .run();
      const outcome = await this.executeItem(row, itemIndex, credential, controller.signal);
      this.db
        .update(generationAttempts)
        .set({
          status: outcome.status,
          finishedAt: new Date().toISOString(),
          error: outcome.error,
          providerRequestId: outcome.providerRequestId ?? null,
          usage: outcome.usage ?? null,
          outputAssetId: outcome.outputAssetId ?? null,
        })
        .where(eq(generationAttempts.id, attemptId))
        .run();
    } catch (error) {
      // Never let an unexpected failure escape without a recorded attempt.
      this.db
        .update(generationAttempts)
        .set({
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: { code: 'internal_error', message: '内部错误', stage: 'storage' },
        })
        .where(eq(generationAttempts.id, attemptId))
        .run();
      this.logger?.warn(`尝试记录失败：${redactWith(this.redactor, error)}`);
    } finally {
      this.controllers.delete(attemptId);
      this.semaphore.release();
    }
  }

  private async executeItem(
    row: GenerationRow,
    itemIndex: number,
    credential: string,
    signal: AbortSignal,
  ): Promise<
    ItemOutcome & {
      providerRequestId?: string | null;
      usage?: Record<string, number> | null;
      outputAssetId?: string | null;
    }
  > {
    const snapshot = row.snapshot;
    try {
      const references = snapshot.imageAssets.map((asset) => {
        const { bytes } = this.images.readContent(asset.id);
        return { mime: asset.mime, base64: bytes.toString('base64') };
      });
      const result = await this.provider.generate({
        model: snapshot.model,
        prompt: snapshot.finalPrompt,
        parameters: snapshot.effectiveParameters,
        references,
        credential,
        timeoutMs: this.providerTimeoutMs,
        signal,
      });
      const asset = await this.storeOutput(row, itemIndex, result);
      return {
        status: 'succeeded',
        error: null,
        providerRequestId: result.providerRequestId,
        usage: result.usage,
        outputAssetId: asset.id,
      };
    } catch (error) {
      return { ...safeOutcome(error), providerRequestId: null, usage: null, outputAssetId: null };
    }
  }

  private async storeOutput(row: GenerationRow, itemIndex: number, result: ProviderResult) {
    let bytes: Buffer;
    try {
      bytes = decodeBase64Image(result.base64);
    } catch {
      throw storageFailure('output_decode_failed', '上游返回的图像数据无法解码');
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw storageFailure('output_too_large', '输出图片超过 20MiB 上限');
    }
    let verified: Awaited<ReturnType<ImageStore['verifyBytes']>>;
    try {
      verified = await this.store.verifyBytes(bytes);
    } catch (error) {
      throw storageFailure(
        'output_format_rejected',
        error instanceof AppError ? error.message : '输出图片格式不受支持',
      );
    }
    if (result.mediaType !== null && result.mediaType !== verified.mime) {
      throw storageFailure('output_format_rejected', '上游声明的图片格式与实际内容不一致');
    }
    if (row.snapshot.effectiveParameters.background === 'transparent') {
      const hasAlpha = await this.store.hasTransparency(bytes);
      if (!hasAlpha) {
        throw storageFailure('transparent_not_supported', '模型返回的图片没有真实透明像素');
      }
    }
    const stored = await this.store.store({ bytes });
    return this.images.persist(stored, {
      name: `${row.snapshot.model.name} 输出 ${itemIndex + 1}`,
      description: '',
      category: '',
      source: 'generation',
      generationId: row.id,
      outputIndex: itemIndex,
    });
  }

  private finalize(generationId: string, round: number): void {
    const row = this.db.select().from(generations).where(eq(generations.id, generationId)).get();
    if (row === undefined || row.status !== 'running') {
      return;
    }
    const attempts = this.attemptsForRound(generationId, round);
    const verdict = roundVerdict(attempts, row.snapshot.authored.outputCount);
    this.db
      .update(generations)
      .set({
        status: verdict.status,
        error: verdict.error,
        finishedAt: verdict.status === 'queued' || verdict.status === 'running' ? null : new Date().toISOString(),
      })
      .where(eq(generations.id, generationId))
      .run();
  }
}

function safeOutcome(error: unknown): ItemOutcome {
  if (error instanceof ProviderCallError) {
    return {
      status: error.kind === 'interrupted' ? 'interrupted' : 'failed',
      error: error.toSafeError(),
    };
  }
  if (error instanceof AppError) {
    return { status: 'failed', error: error.toSafeError() };
  }
  return { status: 'failed', error: { code: 'internal_error', message: '内部错误', stage: 'storage' } };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
