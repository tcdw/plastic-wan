import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type MutableModels,
  type Provider,
  type ProviderAuth,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { RawConfig } from "./config.ts";
import { SecretStore } from "./secrets.ts";

const CUSTOM_ADAPTERS: Record<string, () => ProviderStreams> = {
  "openai-responses": openAIResponsesApi,
  "openai-completions": openAICompletionsApi,
  "anthropic-messages": anthropicMessagesApi,
};

export interface ModelRegistry {
  readonly models: Models;
  readonly mutableModels: MutableModels;
  readonly agentModel: Model<Api>;
  readonly visionModel: Model<Api>;
}

export async function createModelRegistry(config: RawConfig, secrets: SecretStore): Promise<ModelRegistry> {
  const models = createModels();
  const builtinById = new Map(builtinProviders().map((provider) => [provider.id, provider]));
  for (const [alias, configured] of Object.entries(config.providers)) {
    const apiKey = await secrets.resolve(configured.api_key);
    if (configured.kind === "builtin") {
      const source = builtinById.get(configured.provider);
      if (source === undefined) throw new Error(`Unknown built-in provider: ${configured.provider}`);
      models.setProvider(aliasBuiltinProvider(alias, source, fixedAuth(alias, apiKey)));
      continue;
    }
    const headers: Record<string, string> = {};
    for (const [name, reference] of Object.entries(configured.headers ?? {})) {
      headers[name] = await secrets.resolve(reference);
    }
    const adapter = CUSTOM_ADAPTERS[configured.api];
    if (adapter === undefined) throw new Error(`Unsupported custom API adapter: ${configured.api}`);
    const baseUrl = configured.base_url.replace(/\/+$/, "");
    models.setProvider(createProvider({
      id: alias,
      name: alias,
      baseUrl,
      headers,
      auth: fixedAuth(alias, apiKey),
      api: adapter(),
      models: configured.models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        api: configured.api,
        provider: alias,
        baseUrl,
        reasoning: model.reasoning,
        ...(model.compat === undefined
          ? {}
          : { compat: { supportsDeveloperRole: model.compat.supports_developer_role } }),
        input: [...model.input],
        contextWindow: model.context_window,
        maxTokens: model.max_tokens,
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cache_read,
          cacheWrite: model.cost.cache_write,
        },
      })),
    }));
  }
  const agentModel = requireModel(models, config.agent.provider, config.agent.model, ["text"]);
  const visionModel = requireModel(models, config.vision.provider, config.vision.model, ["image"]);
  if (config.vision.max_output_tokens > visionModel.maxTokens) {
    throw new Error("Vision max_output_tokens exceeds registered model limit");
  }
  return { models, mutableModels: models, agentModel, visionModel };
}

function aliasBuiltinProvider(alias: string, source: Provider, auth: ProviderAuth): Provider {
  const sourceModels = source.getModels();
  const aliasedModels = sourceModels.map((model) => ({ ...model, provider: alias }));
  const fetchDeferred = source.fetchDeferred?.bind(source);
  const cancelDeferred = source.cancelDeferred?.bind(source);
  return {
    id: alias,
    name: source.name,
    ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
    ...(source.headers === undefined ? {} : { headers: source.headers }),
    auth,
    getModels: () => aliasedModels,
    stream: (model, context, options) => source.stream({ ...model, provider: source.id }, context, options),
    streamSimple: (model, context, options) => source.streamSimple({ ...model, provider: source.id }, context, options),
    ...(fetchDeferred === undefined
      ? {}
      : { fetchDeferred: (model, handle, options) => fetchDeferred({ ...model, provider: source.id }, handle, options) }),
    ...(cancelDeferred === undefined
      ? {}
      : { cancelDeferred: (model, handle, options) => cancelDeferred({ ...model, provider: source.id }, handle, options) }),
  };
}

function fixedAuth(alias: string, apiKey: string): ProviderAuth {
  return {
    apiKey: {
      name: `${alias} API key`,
      check: async () => ({ type: "api_key", source: "configured SecretRef" }),
      resolve: async () => ({ auth: { apiKey }, source: "configured SecretRef" }),
    },
  };
}

function requireModel(
  models: Models,
  provider: string,
  modelId: string,
  capabilities: readonly ("text" | "image")[],
): Model<Api> {
  const model = models.getModel(provider, modelId);
  if (model === undefined) throw new Error(`Model ${provider}/${modelId} is not registered`);
  for (const capability of capabilities) {
    if (!model.input.includes(capability)) throw new Error(`Model ${provider}/${modelId} lacks ${capability} input capability`);
  }
  return model;
}
