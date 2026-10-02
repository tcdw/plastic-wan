import { z } from 'zod';
import { modelDefinitionSchema, type ModelDefinition, type PublicModel } from './contracts.ts';
import { configUnavailable, providerFailure } from './errors.ts';
import { Redactor } from './redactor.ts';

/**
 * The runtime configuration view of the core: an immutable snapshot of model
 * definitions plus resolved credentials. The core never reads files, env vars or
 * secret stores; the host prepares a validated snapshot and publishes it with
 * `ImageConfigStore.updateConfig`, which swaps the whole object atomically or
 * keeps the previous one.
 */

const credentialRefSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

export const imageConfigSnapshotSchema = z
  .object({
    version: z.string().min(1).max(128),
    models: z.array(modelDefinitionSchema).max(100),
    credentials: z.record(credentialRefSchema, z.string().min(1).max(4096)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.models.map((model) => model.id)).size !== value.models.length) {
      ctx.addIssue({ code: 'custom', message: '模型 ID 重复' });
    }
    for (const model of value.models) {
      if (!(model.credentialRef in value.credentials)) {
        ctx.addIssue({ code: 'custom', message: `模型 ${model.id} 引用了不存在的凭据条目` });
      }
    }
  });

export type ImageConfigSnapshot = {
  readonly version: string;
  readonly models: readonly ModelDefinition[];
  readonly modelsById: ReadonlyMap<string, ModelDefinition>;
  readonly credentials: Readonly<Record<string, string>>;
};

/** Validates and freezes a candidate snapshot; throws on any invalid input. */
export function createImageConfigSnapshot(input: unknown): ImageConfigSnapshot {
  const parsed = imageConfigSnapshotSchema.parse(input);
  return Object.freeze({
    version: parsed.version,
    models: Object.freeze([...parsed.models]),
    modelsById: new Map(parsed.models.map((model) => [model.id, model])),
    credentials: Object.freeze({ ...parsed.credentials }),
  });
}

export class ImageConfigStore {
  private snapshot: ImageConfigSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly redactorInstance: Redactor;

  constructor(redactorInstance?: Redactor) {
    this.redactorInstance = redactorInstance ?? new Redactor();
  }

  /** Read-only access for log scrubbing; secrets register here on publish. */
  get redactor(): Redactor {
    return this.redactorInstance;
  }

  current(): ImageConfigSnapshot {
    if (this.snapshot === null) {
      throw configUnavailable();
    }
    return this.snapshot;
  }

  hasValidConfig(): boolean {
    return this.snapshot !== null;
  }

  model(id: string): ModelDefinition | null {
    return this.snapshot?.modelsById.get(id) ?? null;
  }

  /** Provider credential for a model, resolved from the active snapshot. */
  credentialFor(model: ModelDefinition): string {
    const snapshot = this.current();
    const value = snapshot.credentials[model.credentialRef];
    if (typeof value !== 'string' || value.length === 0) {
      throw providerFailure('credential_missing', '凭据不可用，无法执行生成');
    }
    return value;
  }

  publicModels(): PublicModel[] {
    const snapshot = this.snapshot;
    if (snapshot === null) {
      return [];
    }
    return snapshot.models.map(({ credentialRef: _ignored, ...rest }) => rest);
  }

  /**
   * Atomically publishes a validated snapshot and notifies listeners. Secrets are
   * registered for redaction and never removed here: removing them while an older
   * round is still running would leak the value into a log line.
   */
  updateConfig(next: ImageConfigSnapshot): void {
    this.snapshot = next;
    for (const value of Object.values(next.credentials)) {
      this.redactorInstance.add(value);
    }
    for (const listener of this.listeners) {
      listener();
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Narrow view handed to domain services so they cannot publish configuration. */
export type ImageConfigHandle = Pick<
  ImageConfigStore,
  'current' | 'hasValidConfig' | 'model' | 'credentialFor' | 'publicModels' | 'onChange'
>;
