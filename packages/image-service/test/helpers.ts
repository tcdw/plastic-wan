import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import sharp from 'sharp';
import { createImageConfigSnapshot, ImageConfigStore } from '../src/config.ts';
import {
  type GenerationActor,
  type GenerationInput,
  generationCreateSchema,
  type ModelDefinition,
} from '../src/contracts.ts';
import { createImageCore, type ImageCore } from '../src/core.ts';
import type { ImageDatabase } from '../src/db.ts';
import { ImageStore } from '../src/image-store.ts';
import { imageSchema } from '../src/schema.ts';

/**
 * Domain DDL for tests only. The authoritative migration SQL lives in the host's
 * numbered migrations (added in M2); this fixture mirrors `src/schema.ts` so the
 * core behaviour tests can run against an in-memory or file-backed SQLite.
 */
const DOMAIN_DDL = `
CREATE TABLE IF NOT EXISTS image_prompts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  body          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS image_prompts_deleted_idx ON image_prompts (deleted_at);

CREATE TABLE IF NOT EXISTS image_assets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  bytes         INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL,
  generation_id TEXT,
  output_index  INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS image_assets_deleted_idx ON image_assets (deleted_at);
CREATE INDEX IF NOT EXISTS image_assets_generation_idx ON image_assets (generation_id);

CREATE TABLE IF NOT EXISTS image_generations (
  id             TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  source         TEXT NOT NULL,
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  actor_name     TEXT NOT NULL,
  snapshot       TEXT NOT NULL,
  config_version TEXT NOT NULL,
  round          INTEGER NOT NULL DEFAULT 1,
  error          TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS image_generations_created_idx ON image_generations (created_at DESC);
CREATE INDEX IF NOT EXISTS image_generations_status_idx ON image_generations (status);

CREATE TABLE IF NOT EXISTS image_generation_attempts (
  id                  TEXT PRIMARY KEY,
  generation_id       TEXT NOT NULL,
  round               INTEGER NOT NULL,
  item_index          INTEGER NOT NULL,
  status              TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  error               TEXT,
  provider_request_id TEXT,
  usage               TEXT,
  output_asset_id     TEXT,
  FOREIGN KEY (generation_id) REFERENCES image_generations (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS image_attempts_round_item_idx ON image_generation_attempts (generation_id, round, item_index);
CREATE INDEX IF NOT EXISTS image_attempts_generation_idx ON image_generation_attempts (generation_id);

CREATE TABLE IF NOT EXISTS image_idempotency_keys (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL,
  operation     TEXT NOT NULL,
  key           TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS image_idempotency_actor_operation_key_idx ON image_idempotency_keys (actor_id, operation, key);
`;

export type ProviderCall = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type FakeProvider = {
  fetchImpl: typeof fetch;
  calls: ProviderCall[];
};

export type FakeProviderOptions = {
  /** Response factory; the default returns one PNG per call. */
  respond?: (call: ProviderCall, index: number, init: RequestInit | undefined) => Promise<Response> | Response;
  /** PNG generator used by the default response. */
  image?: () => Promise<Buffer>;
};

export const pngBytes = async (options: { width?: number; height?: number; alpha?: boolean } = {}): Promise<Buffer> => {
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  const channels = options.alpha === true ? 4 : 3;
  const background = options.alpha === true ? { r: 10, g: 20, b: 30, alpha: 0 } : { r: 10, g: 20, b: 30 };
  return sharp({ create: { width, height, channels, background } }).png().toBuffer();
};

export function fakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const calls: ProviderCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const call: ProviderCall = {
      url: String(input),
      headers: Object.fromEntries(headers.entries()),
      body: parsed,
    };
    calls.push(call);
    if (options.respond !== undefined) {
      return options.respond(call, calls.length - 1, init ?? undefined);
    }
    const image = await (options.image ?? pngBytes)();
    return new Response(
      JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }],
        usage: { total_tokens: 42, cost: 0.01 },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `req-${calls.length}` } },
    );
  };
  return { fetchImpl, calls };
}

export const defaultModel = (overrides: Partial<ModelDefinition> = {}): ModelDefinition => ({
  id: 'gpt-image-1',
  name: 'GPT Image 1',
  provider: 'openrouter',
  upstreamModel: 'openai/gpt-image-1',
  credentialRef: 'openrouter',
  providerTag: 'openai',
  capabilities: { maxReferences: 2, maxOutputs: 4 },
  parameters: [
    { name: 'aspect_ratio', label: '画面比例', type: 'enum', options: ['auto', '1:1', '2:3'], default: '1:1' },
    { name: 'quality', label: '质量', type: 'enum', options: ['auto', 'low', 'high'], default: 'auto' },
    { name: 'background', label: '背景', type: 'enum', options: ['auto', 'transparent'], default: 'auto' },
  ],
  ...overrides,
});

export const PROVIDER_KEY = 'sk-or-v1-test-provider-secret';

export const adminActor: GenerationActor = {
  id: 'admin:admin',
  name: 'admin',
  source: 'admin',
  scopes: [],
  privileged: true,
};

export const keyActor: GenerationActor = {
  id: 'key-1',
  name: 'agent',
  source: 'http',
  scopes: ['generation:read', 'generation:create'],
  privileged: false,
};

/** Config version shaped like the host's 32-hex identifier. */
export function configVersionFor(models: ModelDefinition[]): string {
  return createHash('sha256').update(JSON.stringify({ models })).digest('hex').slice(0, 32);
}

export type TestCore = {
  core: ImageCore;
  client: Database.Database;
  db: ImageDatabase;
  storeDir: string;
  config: ImageConfigStore;
  file: string;
  cleanup: () => Promise<void>;
};

export type TestCoreOptions = {
  providerFetch: typeof fetch;
  startWorker?: boolean;
  concurrency?: number;
  providerTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** File path for restart/crash tests; in-memory by default. */
  file?: string;
};

/** Opens a domain database (applying the test DDL) without running migrations. */
export function openTestDatabase(file = ':memory:'): { client: Database.Database; db: ImageDatabase } {
  const client = new Database(file);
  client.exec(DOMAIN_DDL);
  return { client, db: drizzle(client, { schema: imageSchema }) };
}

export async function createTestCore(options: TestCoreOptions): Promise<TestCore> {
  const file = options.file ?? ':memory:';
  const { client, db } = openTestDatabase(file);
  const storeDir = mkdtempSync(path.join(tmpdir(), 'image-service-test-'));
  const config = new ImageConfigStore();
  const core = createImageCore({
    db,
    store: new ImageStore({ dir: storeDir }),
    providerFetch: options.providerFetch,
    startWorker: options.startWorker ?? true,
    concurrency: options.concurrency ?? 2,
    providerTimeoutMs: options.providerTimeoutMs ?? 5000,
    ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    logger: null,
    configStore: config,
  });
  return {
    core,
    client,
    db,
    storeDir,
    config,
    file,
    cleanup: async () => {
      await core.stop();
      try {
        client.close();
      } catch {
        // Tests may already have closed the handle to simulate a crash.
      }
      try {
        rmSync(storeDir, { recursive: true, force: true });
      } catch {
        // temp dirs are disposable
      }
    },
  };
}

export function publishDefaultConfig(config: ImageConfigStore, models: ModelDefinition[] = [defaultModel()]): void {
  config.updateConfig(
    createImageConfigSnapshot({
      version: configVersionFor(models),
      models,
      credentials: { openrouter: PROVIDER_KEY, openrouter2: PROVIDER_KEY },
    }),
  );
}

/** Validates authored input through the public boundary before it reaches the core. */
export function parseInput(
  input: Partial<GenerationInput> & { authoredPrompt: string; modelId: string },
): GenerationInput {
  return generationCreateSchema.parse(input);
}

export async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined && value !== false) {
      return value as T;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor 超时');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}
