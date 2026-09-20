import {
  type Api,
  createModels,
  createProvider,
  type Model,
  type Models,
  type MutableModels,
  type OpenAICompletionsCompat,
  type Provider,
  type ProviderAuth,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { builtinProviderApi, findBuiltinProvider } from './builtin-providers.ts';
import type { ModelCompatConfig, ModelFileConfig, RawConfig } from './config.ts';
import type { SecretStore } from './secrets.ts';

export type CustomProviderConfig = Extract<RawConfig['providers'][string], { kind: 'custom' }>;
export type BuiltinProviderConfig = Extract<RawConfig['providers'][string], { kind: 'builtin' }>;

const CUSTOM_ADAPTERS: Record<string, () => ProviderStreams> = {
  'openai-responses': openAIResponsesApi,
  'openai-completions': openAICompletionsApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
};

export interface ModelRegistry {
  /** Shared, mutable registry: a reload replaces a custom provider in place. */
  readonly models: MutableModels;
  readonly visionModel: Model<Api>;
}

/**
 * Registers one provider object per configured alias.
 *
 * Builtin providers keep Pi's base URL, headers and provider-specific logic, but
 * their model list comes from the configuration alone: the catalog decides what
 * may be configured, never what is reachable at runtime.
 */
export async function createModelRegistry(config: RawConfig, secrets: SecretStore): Promise<ModelRegistry> {
  const models = createModels();
  for (const [alias, configured] of Object.entries(config.providers)) {
    const apiKey = await secrets.resolve(configured.api_key);
    if (configured.kind === 'builtin') {
      const source = findBuiltinProvider(configured.provider);
      if (source === undefined) {
        throw new Error(`Unknown built-in provider: ${configured.provider}`);
      }
      const api = builtinProviderApi(source);
      if (api === null) {
        throw new Error(`Built-in provider ${configured.provider} does not expose a single API adapter`);
      }
      if (source.baseUrl === undefined) {
        throw new Error(`Built-in provider ${configured.provider} has no base URL`);
      }
      models.setProvider(
        aliasBuiltinProvider(alias, source, fixedAuth(alias, apiKey), api, source.baseUrl, configured.models),
      );
      continue;
    }
    const headers: Record<string, string> = {};
    for (const [name, reference] of Object.entries(configured.headers ?? {})) {
      headers[name] = await secrets.resolve(reference);
    }
    const adapter = CUSTOM_ADAPTERS[configured.api];
    if (adapter === undefined) {
      throw new Error(`Unsupported custom API adapter: ${configured.api}`);
    }
    const baseUrl = configured.base_url.replace(/\/+$/, '');
    models.setProvider(
      createProvider({
        id: alias,
        name: alias,
        baseUrl,
        headers,
        auth: fixedAuth(alias, apiKey),
        api: adapter(),
        models: customProviderModels(alias, baseUrl, configured),
      }),
    );
  }
  const visionModel = requireModel(models, config.vision.provider, config.vision.model, ['image']);
  if (config.vision.max_output_tokens > visionModel.maxTokens) {
    throw new Error('Vision max_output_tokens exceeds registered model limit');
  }
  return { models, visionModel };
}

/**
 * Rebuilds one custom provider from a new model list, reusing the connection
 * fields the registry resolved at startup.
 *
 * Credentials are never re-resolved: a `command` SecretRef runs a process, and a
 * reload must not have that side effect. `createProvider` stores `baseUrl`,
 * `headers` and `auth` on the provider object as given, so the ones already
 * there are the resolved ones. The `api` adapter comes from the configuration,
 * which is a restart-only field and therefore identical to the startup value.
 */
export function rebuildCustomProvider(models: Models, alias: string, configured: CustomProviderConfig): Provider {
  const existing = requireRegisteredProvider(models, alias);
  if (existing.baseUrl === undefined) {
    throw new Error(`Provider ${alias} has no base URL to preserve`);
  }
  const adapter = CUSTOM_ADAPTERS[configured.api];
  if (adapter === undefined) {
    throw new Error(`Unsupported custom API adapter: ${configured.api}`);
  }
  return createProvider({
    id: alias,
    name: alias,
    baseUrl: existing.baseUrl,
    headers: existing.headers ?? {},
    auth: existing.auth,
    api: adapter(),
    models: customProviderModels(alias, existing.baseUrl, configured),
  });
}

/**
 * Rebuilds one builtin provider from a new model list. Like the custom path, the
 * registry's own auth and base URL are reused, so no SecretRef is resolved
 * again; only the models the configuration enables change.
 */
export function rebuildBuiltinProvider(models: Models, alias: string, configured: BuiltinProviderConfig): Provider {
  const existing = requireRegisteredProvider(models, alias);
  const source = findBuiltinProvider(configured.provider);
  if (source === undefined) {
    throw new Error(`Unknown built-in provider: ${configured.provider}`);
  }
  const api = builtinProviderApi(source);
  if (api === null) {
    throw new Error(`Built-in provider ${configured.provider} does not expose a single API adapter`);
  }
  const baseUrl = existing.baseUrl ?? source.baseUrl;
  if (baseUrl === undefined) {
    throw new Error(`Built-in provider ${configured.provider} has no base URL`);
  }
  return aliasBuiltinProvider(alias, source, existing.auth, api, baseUrl, configured.models);
}

function requireRegisteredProvider(models: Models, alias: string): Provider {
  const existing = models.getProvider(alias);
  if (existing === undefined) {
    throw new Error(`Provider ${alias} is not registered`);
  }
  return existing;
}

function customProviderModels(alias: string, baseUrl: string, configured: CustomProviderConfig): Model<Api>[] {
  return providerModels(alias, configured.api, baseUrl, configured.models);
}

/**
 * The configured model list of one provider. Builtin and custom providers share
 * this mapping: the only difference is where `api` comes from.
 */
function providerModels(alias: string, api: Api, baseUrl: string, models: readonly ModelFileConfig[]): Model<Api>[] {
  return models.map((model) => {
    const built: Model<Api> = {
      id: model.id,
      name: model.name ?? model.id,
      api,
      provider: alias,
      baseUrl,
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.context_window,
      maxTokens: model.max_tokens,
      cost: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cache_read,
        cacheWrite: model.cost.cache_write,
      },
    };
    const compat = model.compat === undefined ? undefined : mapCompat(model.compat);
    return compat === undefined ? built : { ...built, compat };
  });
}

/** The one place that turns the file's snake_case compat into Pi's camelCase. */
export function mapCompat(compat: ModelCompatConfig): NonNullable<Model<Api>['compat']> | undefined {
  const mapped: OpenAICompletionsCompat = {};
  if (compat.supports_developer_role !== undefined) {
    mapped.supportsDeveloperRole = compat.supports_developer_role;
  }
  if (compat.thinking_format !== undefined) {
    mapped.thinkingFormat = compat.thinking_format;
  }
  if (compat.max_tokens_field !== undefined) {
    mapped.maxTokensField = compat.max_tokens_field;
  }
  if (compat.requires_reasoning_content !== undefined) {
    mapped.requiresReasoningContentOnAssistantMessages = compat.requires_reasoning_content;
  }
  if (compat.cache_control_format !== undefined) {
    mapped.cacheControlFormat = compat.cache_control_format;
  }
  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

/**
 * Re-exposes a builtin provider under its configured alias.
 *
 * Requests must keep Pi's own provider id: automatic compat detection keys off
 * it (OpenRouter's cache-control format, DeepSeek's reasoning replay), so the
 * alias is only ever the registry key. `api` is the catalog's single adapter,
 * which is what the configured models are built with.
 */
function aliasBuiltinProvider(
  alias: string,
  source: Provider,
  auth: ProviderAuth,
  api: Api,
  baseUrl: string,
  configuredModels: readonly ModelFileConfig[],
): Provider {
  const aliasedModels = providerModels(alias, api, baseUrl, configuredModels);
  const fetchDeferred = source.fetchDeferred?.bind(source);
  const cancelDeferred = source.cancelDeferred?.bind(source);
  return {
    id: alias,
    name: source.name,
    baseUrl,
    ...(source.headers === undefined ? {} : { headers: source.headers }),
    auth,
    getModels: () => aliasedModels,
    stream: (model, context, options) => source.stream({ ...model, provider: source.id }, context, options),
    streamSimple: (model, context, options) => source.streamSimple({ ...model, provider: source.id }, context, options),
    ...(fetchDeferred === undefined
      ? {}
      : {
          fetchDeferred: (model, handle, options) => fetchDeferred({ ...model, provider: source.id }, handle, options),
        }),
    ...(cancelDeferred === undefined
      ? {}
      : {
          cancelDeferred: (model, handle, options) =>
            cancelDeferred({ ...model, provider: source.id }, handle, options),
        }),
  };
}

function fixedAuth(alias: string, apiKey: string): ProviderAuth {
  return {
    apiKey: {
      name: `${alias} API key`,
      check: async () => ({ type: 'api_key', source: 'configured SecretRef' }),
      resolve: async () => ({ auth: { apiKey }, source: 'configured SecretRef' }),
    },
  };
}

export function requireModel(
  models: Models,
  provider: string,
  modelId: string,
  capabilities: readonly ('text' | 'image')[],
): Model<Api> {
  const model = models.getModel(provider, modelId);
  if (model === undefined) {
    throw new Error(`Model ${provider}/${modelId} is not registered`);
  }
  for (const capability of capabilities) {
    if (!model.input.includes(capability)) {
      throw new Error(`Model ${provider}/${modelId} lacks ${capability} input capability`);
    }
  }
  return model;
}
