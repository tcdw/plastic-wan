import Compile from 'typebox/compile';
import Type, { type Static } from 'typebox';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

const CATALOG_TIMEOUT_MS = 30_000;
const CATALOG_MAX_BYTES = 32 * 1024 * 1024;
/** The catalog is a whole-catalog download, so it is cached rather than re-fetched per request. */
const CATALOG_TTL_MS = 60 * 60 * 1000;

const ModelLimitSchema = Type.Object({
  context: Type.Optional(Type.Number()),
  input: Type.Optional(Type.Number()),
  output: Type.Optional(Type.Number()),
});

const ModelCostSchema = Type.Object({
  input: Type.Optional(Type.Number()),
  output: Type.Optional(Type.Number()),
  cache_read: Type.Optional(Type.Number()),
  cache_write: Type.Optional(Type.Number()),
});

const ModalitiesSchema = Type.Object({
  input: Type.Optional(Type.Array(Type.String())),
  output: Type.Optional(Type.Array(Type.String())),
});

const ReasoningOptionSchema = Type.Object({
  type: Type.String(),
  values: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Null()]))),
});

/**
 * models.dev records how a provider expects reasoning text to be replayed. The
 * object form names the field the assistant message must carry; the bare
 * boolean form is the older encoding and names nothing, so it cannot be turned
 * into a compat override.
 */
const InterleavedSchema = Type.Union([
  Type.Boolean(),
  Type.Object({ field: Type.Optional(Type.String()) }, { additionalProperties: true }),
]);

const ModelSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  reasoning: Type.Optional(Type.Boolean()),
  reasoning_options: Type.Optional(Type.Array(ReasoningOptionSchema)),
  modalities: Type.Optional(ModalitiesSchema),
  limit: Type.Optional(ModelLimitSchema),
  cost: Type.Optional(ModelCostSchema),
  interleaved: Type.Optional(InterleavedSchema),
});

const ProviderSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  doc: Type.Optional(Type.String()),
  models: Type.Record(Type.String(), ModelSchema),
});

const CatalogSchema = Type.Record(Type.String(), ProviderSchema);
const catalogValidator = Compile(CatalogSchema);

/** Catalog shape as models.dev returns it; `applyDefaults` fills `reasoning` and `modalities`. */
type RawModel = Static<typeof ModelSchema>;
type RawProvider = Static<typeof ProviderSchema>;
type RawCatalog = Static<typeof CatalogSchema>;

export type ModelsDevModel = Omit<RawModel, 'reasoning' | 'modalities'> & {
  reasoning: boolean;
  modalities: { input: string[]; output: string[] };
};
export type ModelsDevProvider = Omit<RawProvider, 'models'> & { models: Record<string, ModelsDevModel> };
export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface ModelsDevCatalogOptions {
  readonly url?: string;
  readonly ttlMs?: number;
  /** Test seam: replaced instead of the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

function parseCatalog(raw: unknown): RawCatalog {
  if (!catalogValidator.Check(raw)) {
    const error = [...catalogValidator.Errors(raw)][0];
    throw new Error(
      error === undefined
        ? 'models.dev returned an invalid catalog'
        : `models.dev catalog failed validation at ${error.instancePath || '/'}: ${error.message}`,
    );
  }
  return raw;
}

/** Fetches and validates the catalog without any caching. */
export async function fetchModelsDevCatalog(
  url = MODELS_DEV_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelsDevCatalog> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`models.dev returned ${response.status} ${response.statusText}`.trim());
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > CATALOG_MAX_BYTES) {
    throw new Error(`models.dev catalog exceeds ${CATALOG_MAX_BYTES} bytes`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > CATALOG_MAX_BYTES) {
    throw new Error(`models.dev catalog exceeds ${CATALOG_MAX_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error('models.dev returned invalid JSON');
  }
  return applyDefaults(parseCatalog(raw));
}

let cachedCatalog: { readonly catalog: ModelsDevCatalog; readonly expiresAt: number } | undefined;
let pendingCatalog: Promise<ModelsDevCatalog> | undefined;

/**
 * Cached catalog accessor. A failure is not cached, and concurrent callers share
 * one request instead of downloading the whole catalog several times.
 */
export async function loadModelsDevCatalog(options: ModelsDevCatalogOptions = {}): Promise<ModelsDevCatalog> {
  const now = Date.now();
  if (cachedCatalog !== undefined && cachedCatalog.expiresAt > now) {
    return cachedCatalog.catalog;
  }
  if (pendingCatalog !== undefined) {
    return await pendingCatalog;
  }
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  const pending = fetchModelsDevCatalog(options.url ?? MODELS_DEV_URL, options.fetchImpl ?? fetch).then((catalog) => {
    cachedCatalog = { catalog, expiresAt: Date.now() + ttlMs };
    return catalog;
  });
  pendingCatalog = pending;
  try {
    return await pending;
  } finally {
    pendingCatalog = undefined;
  }
}

/** Drops the cached catalog; tests use it to isolate cases. */
export function resetModelsDevCatalogCache(): void {
  cachedCatalog = undefined;
}

/** Fills the `reasoning` and `modalities` fields models.dev may omit. */
function applyDefaults(catalog: RawCatalog): ModelsDevCatalog {
  const normalized: ModelsDevCatalog = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    const models: Record<string, ModelsDevModel> = {};
    for (const [modelId, model] of Object.entries(provider.models)) {
      models[modelId] = {
        ...model,
        reasoning: model.reasoning ?? false,
        modalities: {
          input: model.modalities?.input ?? ['text'],
          output: model.modalities?.output ?? ['text'],
        },
      };
    }
    normalized[providerId] = { ...provider, models };
  }
  return normalized;
}

export function findModel(catalog: ModelsDevCatalog, providerId: string, modelId: string): ModelsDevModel | undefined {
  return catalog[providerId]?.models[modelId];
}

export function listProviders(catalog: ModelsDevCatalog): ModelsDevProvider[] {
  return Object.values(catalog).sort((a, b) => a.name.localeCompare(b.name));
}

export function listModels(provider: ModelsDevProvider): ModelsDevModel[] {
  return Object.values(provider.models).sort((a, b) => a.name.localeCompare(b.name));
}

export function extractInputCapabilities(model: ModelsDevModel): Array<'text' | 'image'> {
  const capabilities: Array<'text' | 'image'> = [];
  const inputs = new Set(model.modalities.input);
  if (inputs.has('text')) {
    capabilities.push('text');
  }
  if (inputs.has('image')) {
    capabilities.push('image');
  }
  if (capabilities.length === 0) {
    capabilities.push('text');
  }
  return capabilities;
}

export function extractReasoningEffortOptions(model: ModelsDevModel): string[] {
  for (const option of model.reasoning_options ?? []) {
    if (option.type === 'effort' && option.values !== undefined) {
      return option.values.filter((value): value is string => value !== null);
    }
  }
  return [];
}

export function toModelDefaults(model: ModelsDevModel): {
  name: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  context_window: number;
  max_tokens: number;
  cost: { input: number; output: number; cache_read: number; cache_write: number };
  reasoning_effort_options: string[];
} {
  const limit = model.limit ?? {};
  const cost = model.cost ?? {};
  const contextWindow = limit.context ?? limit.input ?? 0;
  const maxTokens = limit.output ?? 0;
  return {
    name: model.name,
    reasoning: model.reasoning,
    input: extractInputCapabilities(model),
    context_window: contextWindow > 0 ? contextWindow : 128000,
    max_tokens: maxTokens > 0 ? maxTokens : 4096,
    cost: {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cache_read: cost.cache_read ?? 0,
      cache_write: cost.cache_write ?? 0,
    },
    reasoning_effort_options: extractReasoningEffortOptions(model),
  };
}
