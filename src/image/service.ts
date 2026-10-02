import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  createImageConfigSnapshot,
  createImageCore,
  createOpenRouterAdapter,
  type ImageConfigSnapshot,
  type ImageCore,
  type ImageProviderAdapter,
  ImageStore,
  imageSchema,
  modelDefinitionSchema,
} from '@plasticwan/image-service';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { RawConfig } from '../platform/config.ts';
import type { SecretStore } from '../platform/secrets.ts';
import type { SqliteStore } from '../store/database.ts';

/**
 * Process-level assembly of the image generation core.
 *
 * The core borrows the host's SQLite connection (a second Drizzle view over the
 * same better-sqlite3 handle — transactions and WAL semantics stay shared) and
 * stores original image files under `<data_dir>/images`. Original image files
 * are archive data, not media cache: they never inherit the media TTL and are
 * snapshotted by `backupDatabase` next to the SQLite copy.
 */
export type ImageService = {
  core: ImageCore;
  /** Directory that holds the original image files, next to the database. */
  imageDir: string;
  stop(): Promise<void>;
  /**
   * Candidate preparation for `ConfigReloader`: resolves the image section's
   * SecretRefs against the key jar and validates the models through the
   * package contract. Returns undefined when no image section is configured.
   * Throws `SecretResolutionError` or a zod error; the caller reports the
   * failure and keeps the previously published snapshot.
   */
  prepareConfig(candidate: RawConfig, secrets: SecretStore): Promise<ImageConfigSnapshot | undefined>;
  /** Atomically republishes a prepared snapshot; queued work wakes on publish. */
  publishConfig(snapshot: ImageConfigSnapshot): void;
};

export type ImageServiceOptions = {
  /** Defaults to global fetch; tests inject a fake provider transport. */
  providerFetch?: typeof fetch;
  /** The Phase 1 adapter set holds exactly the OpenRouter adapter. */
  providerAdapter?: ImageProviderAdapter;
  logger?: { warn: (message: string) => void };
};

export function createImageService(
  store: SqliteStore,
  config: RawConfig,
  options: ImageServiceOptions = {},
): ImageService {
  const imageDir = join(config.data_dir, 'images');
  // A second Drizzle view over the borrowed connection; the core only ever sees
  // this typed handle and never the raw database or its lifecycle.
  const db = drizzle(store.db, { schema: imageSchema });
  const imageStore = new ImageStore({ dir: imageDir });
  const core = createImageCore({
    db,
    store: imageStore,
    providerAdapter: options.providerAdapter ?? createOpenRouterAdapter({ fetchImpl: options.providerFetch ?? fetch }),
    // The worker starts with the process and drains on shutdown; startup
    // reconciliation (running -> interrupted, claim-less rounds -> queued)
    // runs inside worker.start() before the loop begins.
    startWorker: true,
    concurrency: 1,
    providerTimeoutMs: 120_000,
    // Generous shutdown budget: in-flight provider calls are paid for, so give
    // them a chance to land before they are marked interrupted.
    shutdownTimeoutMs: 30_000,
    logger: options.logger ?? null,
  });
  return {
    core,
    imageDir,
    stop: () => core.stop(),
    async prepareConfig(candidate, secrets) {
      const image = candidate.image;
      if (image === undefined) {
        return undefined;
      }
      const credentials: Record<string, string> = {};
      for (const [name, ref] of Object.entries(image.credentials)) {
        credentials[name] = await secrets.resolve(ref);
      }
      const models = image.models.map((model) => modelDefinitionSchema.parse(model));
      return createImageConfigSnapshot({
        // The snapshot's identity covers models and resolved credential values
        // alike, so a key-jar rotation yields a new version even when the
        // configuration file itself did not change.
        version: createHash('sha256').update(JSON.stringify({ models, credentials })).digest('hex').slice(0, 32),
        models,
        credentials,
      });
    },
    publishConfig(snapshot) {
      core.updateConfig(snapshot);
    },
  };
}
