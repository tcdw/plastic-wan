import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { type ImageService, type PromptService, toImageAsset } from './assets.ts';
import type { ImageConfigHandle } from './config.ts';
import {
  type Generation,
  type GenerationActor,
  type GenerationAttempt,
  type GenerationInput,
  type GenerationScope,
  type GenerationStatus,
  idempotencyKeySchema,
  type ListQuery,
  type Page,
  type SafeError,
} from './contracts.ts';
import { sha256Hex } from './crypto.ts';
import type { ImageDatabase } from './db.ts';
import { configUnavailable, conflict, forbidden, inputError, notFound } from './errors.ts';
import { resolveSnapshot } from './resolve.ts';
import { generationAttempts, generations, idempotencyKeys, images } from './schema.ts';

export type GenerationRow = typeof generations.$inferSelect;
export type AttemptRow = typeof generationAttempts.$inferSelect;
export type ImageRow = typeof images.$inferSelect;

export function toAttempt(row: AttemptRow): GenerationAttempt {
  return {
    id: row.id,
    generationId: row.generationId,
    round: row.round,
    itemIndex: row.itemIndex,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
    providerRequestId: row.providerRequestId,
    usage: row.usage,
    outputAssetId: row.outputAssetId,
  };
}

export function toGeneration(row: GenerationRow, attempts: AttemptRow[], outputs: ImageRow[]): Generation {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    actorName: row.actorName,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    snapshot: row.snapshot,
    attempts: attempts.map(toAttempt),
    outputs: outputs.map(toImageAsset),
    error: row.error,
    round: row.round,
  };
}

/**
 * Status of the newest round: items are only ever executed once per round, so the
 * latest round's attempts are the current truth for the whole generation.
 */
export function computeStatus(attempts: AttemptRow[]): GenerationStatus {
  if (attempts.length === 0) {
    return 'queued';
  }
  const succeeded = attempts.filter((attempt) => attempt.status === 'succeeded').length;
  const running = attempts.filter((attempt) => attempt.status === 'running').length;
  const interrupted = attempts.filter((attempt) => attempt.status === 'interrupted').length;
  if (running > 0) {
    return 'running';
  }
  if (succeeded === attempts.length) {
    return 'succeeded';
  }
  if (succeeded > 0) {
    return 'partial';
  }
  if (interrupted > 0) {
    return 'interrupted';
  }
  return 'failed';
}

export function firstError(attempts: AttemptRow[]): SafeError | null {
  for (const attempt of attempts) {
    if (attempt.error !== null) {
      return attempt.error;
    }
  }
  return null;
}

/**
 * Idempotency keys use the shared contracts schema (safe characters only), so every
 * adapter and client agree on one rule. Zod is intentionally not surfaced: an
 * invalid key is a stable `inputError`, not an issue dump.
 */
export function assertIdempotencyKey(value: string | undefined): string {
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw inputError('idempotency_key_required', '需要提供 1..128 个安全字符的 Idempotency-Key');
  }
  return parsed.data;
}

/**
 * Canonical form for fingerprinting: object keys are sorted recursively so two
 * payloads with the same semantics but different key order hash identically;
 * arrays keep their order because order is part of the meaning.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) {
        continue;
      }
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

export function fingerprintOf(value: unknown): string {
  return sha256Hex(JSON.stringify(canonicalize(value)));
}

export type GenerationService = ReturnType<typeof createGenerationService>;

export type CreateGenerationResult = { generation: Generation; replayed: boolean };

export type GenerationServiceDeps = {
  db: ImageDatabase;
  prompts: PromptService;
  images: ImageService;
  config: ImageConfigHandle;
  enqueue: (generationId: string) => void;
};

export function createGenerationService(deps: GenerationServiceDeps) {
  const { db } = deps;

  function attemptsFor(generationId: string): AttemptRow[] {
    return db
      .select()
      .from(generationAttempts)
      .where(eq(generationAttempts.generationId, generationId))
      .orderBy(generationAttempts.round, generationAttempts.itemIndex)
      .all();
  }

  function outputsFor(generationId: string): ImageRow[] {
    return db.select().from(images).where(eq(images.generationId, generationId)).orderBy(images.outputIndex).all();
  }

  function getRow(id: string): GenerationRow | null {
    return db.select().from(generations).where(eq(generations.id, id)).get() ?? null;
  }

  function load(row: GenerationRow): Generation {
    return toGeneration(row, attemptsFor(row.id), outputsFor(row.id));
  }

  function get(id: string, actor: GenerationActor): Generation {
    const row = getRow(id);
    if (row === null) {
      throw notFound('生成任务不存在');
    }
    if (!canSee(row, actor)) {
      throw notFound('生成任务不存在');
    }
    return load(row);
  }

  /** Privileged actors see everything; scoped actors only their own generations. */
  function canSee(row: GenerationRow, actor: GenerationActor): boolean {
    return actor.privileged || row.actorId === actor.id;
  }

  function list(query: ListQuery, actor: GenerationActor): Page<Generation> {
    const own: SQL | undefined = actor.privileged ? undefined : eq(generations.actorId, actor.id);
    const total = db.select({ value: count() }).from(generations).where(own).get()?.value ?? 0;
    const rows = db
      .select()
      .from(generations)
      .where(own)
      .orderBy(desc(generations.createdAt), desc(generations.id))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    return { items: rows.map(load), total, limit: query.limit, offset: query.offset };
  }

  /** Resolves input against the current configuration without creating anything. */
  function resolve(input: GenerationInput) {
    const snapshot = deps.config.current();
    const model = snapshot.modelsById.get(input.modelId);
    if (model === undefined) {
      throw inputError('unknown_model', '模型不存在或已被配置移除');
    }
    return resolveSnapshot(
      { prompts: deps.prompts, images: deps.images, configVersion: snapshot.version },
      input,
      model,
    );
  }

  function findIdempotent(actorId: string, operation: string, key: string) {
    return (
      db
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.actorId, actorId),
            eq(idempotencyKeys.operation, operation),
            eq(idempotencyKeys.key, key),
          ),
        )
        .get() ?? null
    );
  }

  function replay(row: typeof idempotencyKeys.$inferSelect, fingerprint: string): GenerationRow {
    if (row.fingerprint !== fingerprint) {
      throw conflict('idempotency_conflict', '相同 Idempotency-Key 已用于不同的请求内容');
    }
    const generation = getRow(row.generationId);
    if (generation === null) {
      throw notFound('生成任务不存在');
    }
    return generation;
  }

  function create(input: GenerationInput, actor: GenerationActor, idempotencyKey: string): CreateGenerationResult {
    const operation = 'generation:create';
    // Idempotency is resolved from the authored input alone, before the current
    // configuration or assets are consulted: replaying an accepted request must
    // never fail because its references were archived or its model was removed.
    const fingerprint = fingerprintOf({ actorId: actor.id, operation, input });
    const existing = findIdempotent(actor.id, operation, idempotencyKey);
    if (existing !== null) {
      return { generation: load(replay(existing, fingerprint)), replayed: true };
    }

    const snapshot = resolve(input);
    const now = new Date().toISOString();
    const row: GenerationRow = {
      id: randomUUID(),
      status: 'queued',
      source: actor.source,
      actorKind: actor.privileged ? 'privileged' : 'scoped',
      actorId: actor.id,
      actorName: actor.name,
      snapshot,
      configVersion: snapshot.configVersion,
      round: 1,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    db.transaction((tx) => {
      tx.insert(generations).values(row).run();
      tx.insert(idempotencyKeys)
        .values({
          id: randomUUID(),
          actorId: actor.id,
          operation,
          key: idempotencyKey,
          fingerprint,
          generationId: row.id,
          createdAt: now,
        })
        .run();
    });
    deps.enqueue(row.id);
    return { generation: load(row), replayed: false };
  }

  function retry(generationId: string, actor: GenerationActor, idempotencyKey: string): CreateGenerationResult {
    const row = getRow(generationId);
    if (row === null) {
      throw notFound('生成任务不存在');
    }
    if (!canSee(row, actor)) {
      throw notFound('生成任务不存在');
    }

    // Idempotency is resolved before state checks so a replay always returns the task
    // it originally referred to, even while the new round is already running.
    const operation = 'generation:retry';
    const fingerprint = fingerprintOf({ actorId: actor.id, operation, generationId });
    const existing = findIdempotent(actor.id, operation, idempotencyKey);
    if (existing !== null) {
      return { generation: load(replay(existing, fingerprint)), replayed: true };
    }

    if (row.status === 'queued' || row.status === 'running') {
      throw conflict('generation_running', '任务正在执行，不能重试');
    }
    try {
      deps.config.credentialFor(row.snapshot.model);
    } catch {
      throw configUnavailable('当前配置缺少该模型所需的凭据');
    }
    const nextRound = row.round + 1;

    const now = new Date().toISOString();
    const updated = db.transaction((tx) => {
      const result = tx
        .update(generations)
        .set({ status: 'queued', round: nextRound, error: null, startedAt: null, finishedAt: null })
        .where(and(eq(generations.id, generationId), eq(generations.round, row.round)))
        .run();
      if (result.changes === 0) {
        return null;
      }
      tx.insert(idempotencyKeys)
        .values({
          id: randomUUID(),
          actorId: actor.id,
          operation,
          key: idempotencyKey,
          fingerprint,
          generationId,
          createdAt: now,
        })
        .run();
      return true;
    });
    if (updated === null) {
      throw conflict('generation_running', '任务状态已改变，请刷新后重试');
    }
    deps.enqueue(generationId);
    const reloaded = getRow(generationId);
    if (reloaded === null) {
      throw notFound('生成任务不存在');
    }
    return { generation: load(reloaded), replayed: false };
  }

  function requireScope(actor: GenerationActor, scope: GenerationScope): void {
    if (actor.privileged) {
      return;
    }
    if (!actor.scopes.includes(scope)) {
      throw forbidden(`缺少权限：${scope}`);
    }
  }

  return { get, list, create, retry, resolve, load, attemptsFor, outputsFor, getRow, requireScope };
}
