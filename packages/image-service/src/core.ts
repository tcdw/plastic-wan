import { createImageService, createPromptService, type ImageService, type PromptService } from './assets.ts';
import { type ImageConfigHandle, type ImageConfigSnapshot, ImageConfigStore } from './config.ts';
import type { ImageDatabase } from './db.ts';
import { createGenerationService, type GenerationService } from './generations.ts';
import type { ImageStore } from './image-store.ts';
import type { ImageProviderAdapter } from './provider.ts';
import { GenerationWorker } from './worker.ts';

/**
 * The assembled image generation core. It owns prompts, images, generations, the
 * provider adapter and the worker, and it deliberately owns nothing else: no HTTP
 * server, no MCP endpoint, no database connection, no file watcher, no auth. The
 * host opens the database, prepares configuration snapshots and injects them via
 * `config.updateConfig`; `stop()` waits for in-flight provider work to settle.
 */
export type ImageCoreOptions = {
  db: ImageDatabase;
  store: ImageStore;
  providerAdapter: ImageProviderAdapter;
  startWorker: boolean;
  concurrency: number;
  providerTimeoutMs: number;
  shutdownTimeoutMs?: number;
  logger?: { warn: (message: string) => void } | null;
  /** Supply when the host wants to own the config store; a fresh one is created otherwise. */
  configStore?: ImageConfigStore;
};

export type ImageCore = ReturnType<typeof createImageCore>;

export function createImageCore(options: ImageCoreOptions) {
  const config = options.configStore ?? new ImageConfigStore();
  const redactor = config.redactor;
  const prompts = createPromptService({ db: options.db });
  const images = createImageService({ db: options.db, store: options.store });
  const provider = options.providerAdapter;
  const worker = new GenerationWorker({
    db: options.db,
    config,
    images,
    store: options.store,
    provider,
    concurrency: options.concurrency,
    providerTimeoutMs: options.providerTimeoutMs,
    ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    logger: options.logger ?? null,
    redactor,
  });
  const generations = createGenerationService({
    db: options.db,
    prompts,
    images,
    config,
    enqueue: (generationId) => {
      worker.enqueue(generationId);
    },
  });

  if (options.startWorker) {
    worker.start();
  }

  return {
    prompts,
    images,
    generations,
    adapter: provider,
    worker,
    config,
    /** Publishes a validated configuration snapshot atomically (or keeps the old one). */
    updateConfig: (snapshot: ImageConfigSnapshot): void => {
      config.updateConfig(snapshot);
    },
    async stop(): Promise<void> {
      await worker.stop();
    },
  };
}

export type { GenerationService, ImageConfigHandle, ImageConfigSnapshot, ImageService, PromptService };
