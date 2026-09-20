import type { ProviderApi } from './config.ts';
import { extractInputCapabilities, findModel, type ModelsDevCatalog, type ModelsDevModel } from './models-dev.ts';
import type { DiscoveredProviderModel, GeminiModel, OpenRouterModel, VercelModel } from './provider-models.ts';

/**
 * Where one metadata field came from. The two qualified models.dev sources are
 * guesses the admin has to confirm: `models.dev-cross-provider` is the model id
 * found under a provider the descriptor never named, and `models.dev-fuzzy` is a
 * normalized id rather than an exact one.
 */
export type MetadataSource =
  | 'openrouter'
  | 'vercel'
  | 'gemini'
  | 'models.dev'
  | 'models.dev-cross-provider'
  | 'models.dev-fuzzy'
  | 'missing';

/**
 * How far the models.dev lookup had to reach. Only `exact` — the provider the
 * descriptor names, with the model id as listed — is trusted without
 * confirmation: the same id under another provider is a different deployment,
 * with its own prices and limits.
 */
export type ModelsDevConfidence = 'exact' | 'cross-provider' | 'fuzzy';

const CATALOG_SOURCE: Readonly<Record<ModelsDevConfidence, MetadataSource>> = {
  exact: 'models.dev',
  'cross-provider': 'models.dev-cross-provider',
  fuzzy: 'models.dev-fuzzy',
};

/** Whether a source is a guess, which is what `needs_confirmation` reports. */
function isGuessedSource(source: MetadataSource): boolean {
  return source === 'models.dev-cross-provider' || source === 'models.dev-fuzzy';
}

export type DraftField = 'name' | 'reasoning' | 'input' | 'context_window' | 'max_tokens' | 'cost';

export const DRAFT_FIELDS: readonly DraftField[] = [
  'name',
  'reasoning',
  'input',
  'context_window',
  'max_tokens',
  'cost',
];

export interface ModelCostDraft {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

export interface ModelsDevMatch {
  readonly provider: string;
  readonly model: string;
  readonly confidence: ModelsDevConfidence;
}

export interface ModelMetadataDraft {
  readonly id: string;
  readonly name: string | null;
  readonly reasoning: boolean | null;
  readonly input: readonly ('text' | 'image')[] | null;
  readonly context_window: number | null;
  readonly max_tokens: number | null;
  readonly cost: ModelCostDraft | null;
  /**
   * `true` only when models.dev records that assistant messages must replay
   * reasoning content as `reasoning_content`. Everything else stays on Pi's
   * automatic detection, which the panel cannot reproduce.
   */
  readonly requires_reasoning_content: boolean;
  readonly sources: Readonly<Record<DraftField, MetadataSource>>;
  readonly requires_reasoning_content_source: MetadataSource;
  readonly match: ModelsDevMatch | null;
  readonly candidates: readonly ModelsDevMatch[];
  readonly needs_confirmation: readonly DraftField[];
}

export interface ProviderDescriptor {
  readonly kind: 'builtin' | 'custom';
  /** Pi provider id, when the descriptor is a builtin provider. */
  readonly builtinProvider?: string;
  readonly baseUrl: string;
  readonly api: ProviderApi;
}

/**
 * Pi provider ids that models.dev spells differently. Only providers that pass
 * the builtin preset filter are listed; anything else is treated as a relay and
 * matched by model id alone.
 */
const MODELS_DEV_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  'vercel-ai-gateway': 'vercel',
  together: 'togetherai',
  'kimi-coding': 'kimi-code-plan-global',
  'zai-coding-cn': 'zai-coding-plan',
  'qwen-token-plan': 'alibaba-token-plan',
  'qwen-token-plan-cn': 'alibaba-token-plan-cn',
  'qwen-token-plan-individual': 'alibaba-token-plan',
};

/** Hosts whose models.dev provider is known even when the alias is a custom one. */
const MODELS_DEV_HOST_ALIASES: Readonly<Record<string, string>> = {
  'openrouter.ai': 'openrouter',
  'ai-gateway.vercel.sh': 'vercel',
  'api.anthropic.com': 'anthropic',
  'api.deepseek.com': 'deepseek',
  'api.moonshot.ai': 'moonshotai',
  'api.moonshot.cn': 'moonshotai-cn',
  'api.openai.com': 'openai',
  'api.together.ai': 'togetherai',
  'api.z.ai': 'zai',
  'generativelanguage.googleapis.com': 'google',
};

const MAX_FUZZY_CANDIDATES = 5;

export function modelsDevProviderId(descriptor: ProviderDescriptor): string | null {
  if (descriptor.builtinProvider !== undefined) {
    return MODELS_DEV_PROVIDER_ALIASES[descriptor.builtinProvider] ?? descriptor.builtinProvider;
  }
  let host: string;
  try {
    host = new URL(descriptor.baseUrl).host.toLowerCase();
  } catch {
    return null;
  }
  return MODELS_DEV_HOST_ALIASES[host] ?? null;
}

/**
 * Turns a provider listing into one metadata draft per model. Nothing is
 * defaulted: a field no source can fill stays `null` and is reported in
 * `needs_confirmation`, and a value that only a fuzzy models.dev match backs is
 * reported the same way.
 */
export function resolveModelDrafts(
  descriptor: ProviderDescriptor,
  models: readonly DiscoveredProviderModel[],
  catalog: ModelsDevCatalog,
): readonly ModelMetadataDraft[] {
  const hint = modelsDevProviderId(descriptor);
  return models.map((model) => resolveModelDraft(model, matchModelsDev(catalog, hint, model.id)));
}

interface ModelsDevLookup {
  readonly match: ModelsDevMatch | null;
  readonly model: ModelsDevModel | null;
  readonly candidates: readonly ModelsDevMatch[];
}

function resolveModelDraft(model: DiscoveredProviderModel, lookup: ModelsDevLookup): ModelMetadataDraft {
  const primary = readExtension(model.extension);
  const fromCatalog = lookup.model === null ? null : readModelsDev(lookup.model);
  const catalogSource: MetadataSource = lookup.match === null ? 'missing' : CATALOG_SOURCE[lookup.match.confidence];
  const sources = {} as Record<DraftField, MetadataSource>;
  const values = {} as Record<DraftField, unknown>;
  for (const field of DRAFT_FIELDS) {
    const own = primary?.fields[field];
    if (primary !== null && own !== null && own !== undefined) {
      values[field] = own;
      sources[field] = primary.source;
      continue;
    }
    const fallback = fromCatalog?.[field];
    if (fallback !== null && fallback !== undefined) {
      values[field] = fallback;
      sources[field] = catalogSource;
      continue;
    }
    values[field] = null;
    sources[field] = 'missing';
  }
  const contextWindow = values.context_window as number | null;
  const maxTokens = values.max_tokens as number | null;
  const inconsistent = contextWindow !== null && maxTokens !== null && maxTokens > contextWindow;
  const needsConfirmation = DRAFT_FIELDS.filter(
    (field) => values[field] === null || (isGuessedSource(sources[field]) && field !== 'name'),
  );
  if (inconsistent && !needsConfirmation.includes('max_tokens')) {
    needsConfirmation.push('max_tokens');
  }
  const requiresReasoningContent = readInterleavedReasoningContent(lookup.model?.interleaved);
  return {
    id: model.id,
    name: (values.name as string | null) ?? null,
    reasoning: (values.reasoning as boolean | null) ?? null,
    input: (values.input as readonly ('text' | 'image')[] | null) ?? null,
    context_window: contextWindow,
    max_tokens: maxTokens,
    cost: (values.cost as ModelCostDraft | null) ?? null,
    requires_reasoning_content: requiresReasoningContent,
    sources,
    // Only the one `interleaved` form maps to an override; every other shape —
    // absent, a bare boolean, another field name — leaves the value on Pi's own
    // detection, which no source filled in.
    requires_reasoning_content_source: requiresReasoningContent ? catalogSource : 'missing',
    match: lookup.match,
    candidates: lookup.candidates,
    needs_confirmation: needsConfirmation,
  };
}

function readInterleavedReasoningContent(interleaved: ModelsDevModel['interleaved']): boolean {
  return typeof interleaved === 'object' && interleaved !== null && interleaved.field === 'reasoning_content';
}

type DraftFields = Partial<Record<DraftField, unknown>>;

interface ExtensionFields {
  readonly source: MetadataSource;
  readonly fields: DraftFields;
}

function readExtension(extension: DiscoveredProviderModel['extension']): ExtensionFields | null {
  switch (extension.format) {
    case 'openrouter':
      return { source: 'openrouter', fields: readOpenRouter(extension.payload) };
    case 'vercel':
      return { source: 'vercel', fields: readVercel(extension.payload) };
    case 'gemini':
      return { source: 'gemini', fields: readGemini(extension.payload) };
    default:
      return null;
  }
}

function readOpenRouter(model: OpenRouterModel): DraftFields {
  return {
    name: model.name ?? null,
    reasoning: model.supported_parameters?.includes('reasoning') ?? null,
    input: readModalities(model.architecture?.input_modalities),
    context_window: model.context_length ?? model.top_provider?.context_length ?? null,
    max_tokens: model.top_provider?.max_completion_tokens ?? null,
    cost: readPricing(model.pricing, 'prompt', 'completion'),
  };
}

function readVercel(model: VercelModel): DraftFields {
  return {
    name: model.name ?? null,
    reasoning: model.tags?.includes('reasoning') ?? null,
    input: readModalities(model.modalities?.input),
    context_window: model.context_window ?? null,
    max_tokens: model.max_tokens ?? null,
    cost: readPricing(model.pricing, 'input', 'output'),
  };
}

function readGemini(model: GeminiModel): DraftFields {
  return {
    name: model.displayName ?? null,
    reasoning: model.thinking ?? null,
    // The native listing says nothing about input modalities; models.dev does.
    input: null,
    context_window: model.inputTokenLimit ?? null,
    max_tokens: model.outputTokenLimit ?? null,
    cost: null,
  };
}

function readModelsDev(model: ModelsDevModel): DraftFields {
  return {
    name: model.name,
    reasoning: model.reasoning,
    input: extractInputCapabilities(model),
    context_window: model.limit?.context ?? model.limit?.input ?? null,
    max_tokens: model.limit?.output ?? null,
    cost:
      model.cost === undefined
        ? null
        : {
            input: model.cost.input ?? 0,
            output: model.cost.output ?? 0,
            cache_read: model.cost.cache_read ?? 0,
            cache_write: model.cost.cache_write ?? 0,
          },
  };
}

function readModalities(modalities: readonly string[] | undefined): readonly ('text' | 'image')[] | null {
  if (modalities === undefined) {
    return null;
  }
  const input = modalities.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image');
  return input.length === 0 ? null : input;
}

/**
 * Both OpenRouter and Vercel quote prices per token, while the configuration
 * stores USD per million tokens.
 */
function readPricing(
  pricing: Record<string, string | number | undefined> | undefined,
  inputKey: string,
  outputKey: string,
): ModelCostDraft | null {
  if (pricing === undefined) {
    return null;
  }
  const input = perMillion(pricing[inputKey]);
  const output = perMillion(pricing[outputKey]);
  if (input === null && output === null) {
    return null;
  }
  return {
    input: input ?? 0,
    output: output ?? 0,
    cache_read: perMillion(pricing.input_cache_read) ?? 0,
    cache_write: perMillion(pricing.input_cache_write) ?? 0,
  };
}

function perMillion(value: string | number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Number((parsed * 1_000_000).toFixed(6));
}

function matchModelsDev(catalog: ModelsDevCatalog, hint: string | null, modelId: string): ModelsDevLookup {
  if (hint !== null) {
    const hinted = findModel(catalog, hint, modelId);
    if (hinted !== undefined) {
      return { match: { provider: hint, model: modelId, confidence: 'exact' }, model: hinted, candidates: [] };
    }
  }
  const providerIds = Object.keys(catalog).sort();
  for (const providerId of providerIds) {
    const found = findModel(catalog, providerId, modelId);
    if (found !== undefined) {
      // The id is exact but the provider is not the one being configured, which
      // is the normal case for an unknown relay. Prices, limits and capabilities
      // belong to that other provider's deployment, so the draft is a lead for
      // the admin to confirm rather than an answer.
      return {
        match: { provider: providerId, model: modelId, confidence: 'cross-provider' },
        model: found,
        candidates: [],
      };
    }
  }
  const normalized = normalizeModelId(modelId);
  const candidates: ModelsDevMatch[] = [];
  for (const providerId of providerIds) {
    for (const candidateId of Object.keys(catalog[providerId]?.models ?? {})) {
      if (normalizeModelId(candidateId) !== normalized) {
        continue;
      }
      candidates.push({ provider: providerId, model: candidateId, confidence: 'fuzzy' });
      if (candidates.length >= MAX_FUZZY_CANDIDATES) {
        break;
      }
    }
    if (candidates.length >= MAX_FUZZY_CANDIDATES) {
      break;
    }
  }
  const preferred = candidates.find((candidate) => candidate.provider === hint) ?? candidates[0];
  const preferredModel = preferred === undefined ? undefined : findModel(catalog, preferred.provider, preferred.model);
  if (preferred === undefined || preferredModel === undefined) {
    return { match: null, model: null, candidates: [] };
  }
  return { match: preferred, model: preferredModel, candidates };
}

/**
 * Relay ids carry routing decoration the catalog does not have: a `~` alias
 * marker, a `:free`-style suffix, and a vendor prefix that only matches when the
 * rest of the id does.
 */
export function normalizeModelId(modelId: string): string {
  const withoutPrefix = modelId.replace(/^~/, '').toLowerCase();
  const withoutSuffix = withoutPrefix.replace(/:(free|nitro|extended|thinking|online)$/, '');
  const separator = withoutSuffix.indexOf('/');
  return separator < 0 ? withoutSuffix : withoutSuffix.slice(separator + 1);
}
