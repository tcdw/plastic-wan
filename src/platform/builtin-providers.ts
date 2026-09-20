import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ProviderApi } from './config.ts';

/**
 * The API adapters the configuration supports. Pi ships more (Bedrock, Mistral,
 * Azure, Vertex, …), but the panel and the TUI only ever write these four, and a
 * builtin provider that mixes several of them has no single `api` to record on
 * its configured models.
 */
export const SUPPORTED_PROVIDER_APIS: readonly Api[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
];

let catalog: readonly Provider[] | undefined;

/** Pi's builtin provider catalog, loaded once per process. */
export function listBuiltinProviders(): readonly Provider[] {
  catalog ??= builtinProviders();
  return catalog;
}

export function findBuiltinProvider(id: string): Provider | undefined {
  return listBuiltinProviders().find((provider) => provider.id === id);
}

/**
 * The one API a builtin provider's catalog uses, or `null` when the catalog is
 * empty or mixes several. Pi keeps `api` on every model rather than on the
 * provider, so this is the only way to name a builtin provider's adapter.
 */
export function builtinProviderApi(source: Provider): Api | null {
  const apis = new Set(source.getModels().map((model) => model.api));
  if (apis.size !== 1) {
    return null;
  }
  return [...apis][0] ?? null;
}

export function isSupportedProviderApi(api: Api): api is ProviderApi {
  return SUPPORTED_PROVIDER_APIS.includes(api);
}

/** `builtinProviderApi` narrowed to the adapters the configuration supports. */
export function supportedBuiltinApi(source: Provider): ProviderApi | null {
  const api = builtinProviderApi(source);
  return api !== null && isSupportedProviderApi(api) ? api : null;
}

/**
 * Whether a builtin provider may be referenced from the configuration at all:
 * a non-empty catalog, one supported API, a concrete base URL, and API-key auth.
 * OAuth-only providers and placeholder base URLs (`{account}`) cannot be driven
 * from a single configured key, so they are rejected rather than half-supported.
 */
export function isSupportedBuiltinPreset(source: Provider): boolean {
  if (source.getModels().length === 0) {
    return false;
  }
  const api = builtinProviderApi(source);
  if (api === null || !SUPPORTED_PROVIDER_APIS.includes(api)) {
    return false;
  }
  if (source.baseUrl === undefined || source.baseUrl.includes('{')) {
    return false;
  }
  return source.auth.apiKey !== undefined;
}

/** Presets the panel may offer, sorted by display name. */
export function listBuiltinPresets(): readonly Provider[] {
  return listBuiltinProviders()
    .filter(isSupportedBuiltinPreset)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Pi's own catalog entry for one model, when the provider knows it. */
export function findBuiltinModel(source: Provider, modelId: string): Model<Api> | undefined {
  return source.getModels().find((model) => model.id === modelId);
}
