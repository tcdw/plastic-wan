import { input, select, confirm } from "@inquirer/prompts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { SecretRef, TomlConfig } from "../config.ts";
import {
  fetchModelsDevCatalog,
  listProviders as listModelsDevProviders,
  listModels as listModelsDevModels,
  findModel,
  toModelDefaults,
  type ModelsDevCatalog,
  type ModelsDevModel,
} from "./models-dev.ts";
import {
  promptApiAdapter,
  promptBoolean,
  promptInputCapabilities,
  promptNonNegativeNumber,
  promptPositiveInteger,
  promptSecretRef,
  promptString,
} from "./prompts.ts";

type ApiAdapter = "openai-responses" | "openai-completions" | "anthropic-messages";

type BuiltinProviderConfig = {
  kind: "builtin";
  provider: string;
  api_key: SecretRef;
};

type CustomProviderConfig = {
  kind: "custom";
  base_url: string;
  api: ApiAdapter;
  api_key: SecretRef;
  headers?: Record<string, SecretRef>;
  models: ModelConfig[];
};

type ProviderConfig = BuiltinProviderConfig | CustomProviderConfig;

type ModelConfig = {
  id: string;
  name?: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  context_window: number;
  max_tokens: number;
  cost: { input: number; output: number; cache_read: number; cache_write: number };
};

type ProviderAction = "add" | "edit" | "delete" | "back";
type ModelAction = "add" | "edit" | "delete" | "back";
type ProviderKind = "builtin" | "custom";
type CustomProviderField = "base_url" | "api" | "api_key" | "headers" | "models" | "cancel";
type ModelField = "name" | "reasoning" | "input" | "context_window" | "max_tokens" | "cost" | "cancel";

export async function runProviderWizard(config: TomlConfig): Promise<TomlConfig> {
  let providers: Record<string, ProviderConfig> = { ...(config.providers as Record<string, ProviderConfig>) };
  let exit = false;
  while (!exit) {
    const choices: { value: ProviderAction; name: string }[] = [
      { value: "add", name: "Add provider" },
      { value: "edit", name: "Edit provider" },
    ];
    if (Object.keys(providers).length > 0) {
      choices.push({ value: "delete", name: "Delete provider" });
    }
    choices.push({ value: "back", name: "Back to main menu" });
    const action = await select<ProviderAction>({ message: "Configure providers", choices });
    switch (action) {
      case "add": {
        const provider = await addProvider();
        if (provider !== undefined) {
          const config = provider.config as ProviderConfig;
          providers = { ...providers, [provider.alias]: config };
        }
        break;
      }
      case "edit": {
        const alias = await selectProviderAlias(providers);
        if (alias !== undefined) {
          const toEdit = providers[alias] as ProviderConfig;
          const updated: ProviderConfig | undefined = await editProvider(toEdit);
          if (updated !== undefined) {
            providers = { ...providers, [alias]: updated };
          }
        }
        break;
      }
      case "delete": {
        const alias = await selectProviderAlias(providers);
        if (alias !== undefined && (await confirm({ message: `Delete provider "${alias}"?` }))) {
          const { [alias]: _, ...rest } = providers;
          providers = rest;
        }
        break;
      }
      case "back":
      default:
        exit = true;
        break;
    }
  }
  return { ...config, providers: providers as TomlConfig["providers"] };
}

async function selectProviderAlias(providers: Record<string, ProviderConfig>): Promise<string | undefined> {
  const aliases = Object.keys(providers);
  if (aliases.length === 0) return undefined;
  return select<string>({
    message: "Select provider",
    choices: aliases.map((alias) => ({
      value: alias,
      name: describeProvider(alias, providers[alias] as ProviderConfig),
    })),
  });
}

function describeProvider(alias: string, provider: ProviderConfig): string {
  if (provider.kind === "builtin") return `${alias} (built-in: ${provider.provider})`;
  return `${alias} (custom: ${provider.api})`;
}

async function addProvider(): Promise<{ alias: string; config: ProviderConfig } | undefined> {
  const alias = await input({
    message: "Provider alias",
    validate: (value) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) || "Invalid alias",
  });
  const kind = await select<ProviderKind>({
    message: "Provider kind",
    choices: [
      { value: "builtin", name: "Built-in provider (uses Pi AI model catalog)" },
      { value: "custom", name: "Custom provider (OpenAI/Anthropic-compatible endpoint)" },
    ],
  });
  if (kind === "builtin") {
    const config = await configureBuiltinProvider();
    return { alias, config: config as ProviderConfig };
  }
  const config = await configureCustomProvider();
  return { alias, config: config as ProviderConfig };
}

async function configureBuiltinProvider(): Promise<ProviderConfig> {
  const providers = builtinProviders().sort((a, b) => a.name.localeCompare(b.name));
  const providerId = await select<string>({
    message: "Built-in provider",
    choices: providers.map((provider) => ({ value: provider.id, name: `${provider.name} (${provider.id})` })),
  });
  const apiKey = await promptSecretRef("API key");
  return { kind: "builtin", provider: providerId, api_key: apiKey };
}

async function configureCustomProvider(): Promise<ProviderConfig> {
  const baseUrl = await input({
    message: "Base URL",
    validate: (value) => {
      try {
        const url = new URL(value);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
          return "Must be an HTTP(S) URL without credentials, query, or fragment";
        }
        return true;
      } catch {
        return "Invalid URL";
      }
    },
  });
  const api = await promptApiAdapter();
  const apiKey = await promptSecretRef("API key");
  const headers: Record<string, SecretRef> = {};
  if (await confirm({ message: "Add custom headers?", default: false })) {
    let addMore = true;
    while (addMore) {
      const name = await input({ message: "Header name", validate: (value) => value.trim().length > 0 || "Required" });
      const value = await promptSecretRef(`Value for "${name}"`, false);
      headers[name] = value;
      addMore = await confirm({ message: "Add another header?", default: false });
    }
  }
  const models = await runModelWizard([]);
  const config: ProviderConfig = {
    kind: "custom",
    base_url: baseUrl,
    api,
    api_key: apiKey,
    models,
  };
  if (Object.keys(headers).length > 0) config.headers = headers;
  return config;
}

async function editProvider(provider: ProviderConfig): Promise<ProviderConfig | undefined> {
  if (provider.kind === "builtin") {
    const apiKey = await promptSecretRef("API key");
    return { ...provider, api_key: apiKey };
  }
  let updated: ProviderConfig = { ...provider };
  const action = await select<CustomProviderField>({
    message: "Edit custom provider",
    choices: [
      { value: "base_url", name: `Base URL: ${updated.base_url}` },
      { value: "api", name: `API adapter: ${updated.api}` },
      { value: "api_key", name: "API key" },
      { value: "headers", name: `Custom headers (${Object.keys(updated.headers ?? {}).length})` },
      { value: "models", name: `Models (${updated.models.length})` },
      { value: "cancel", name: "Cancel" },
    ],
  });
  switch (action) {
    case "base_url": {
      const baseUrl = await promptString("Base URL", updated.base_url);
      updated = { ...updated, base_url: baseUrl };
      break;
    }
    case "api": {
      const api = await promptApiAdapter();
      updated = { ...updated, api };
      break;
    }
    case "api_key": {
      updated = { ...updated, api_key: await promptSecretRef("API key") };
      break;
    }
    case "headers": {
      updated = { ...updated, headers: await editHeaders(updated.headers ?? {}) };
      break;
    }
    case "models": {
      updated = { ...updated, models: await runModelWizard(updated.models) };
      break;
    }
    case "cancel":
    default:
      return undefined;
  }
  return updated;
}

async function editHeaders(headers: Record<string, SecretRef>): Promise<Record<string, SecretRef>> {
  const choices: { value: string; name: string }[] = [
    { value: "__add", name: "Add header" },
    ...Object.entries(headers).map(([name]) => ({ value: name, name: `Edit "${name}"` })),
    ...Object.entries(headers).map(([name]) => ({ value: `__delete:${name}`, name: `Delete "${name}"` })),
    { value: "__back", name: "Done" },
  ];
  const action = await select<string>({ message: "Custom headers", choices });
  if (action === "__back") return headers;
  if (action === "__add") {
    const name = await input({ message: "Header name", validate: (value) => value.trim().length > 0 || "Required" });
    const value = await promptSecretRef(`Value for "${name}"`, false);
    return { ...headers, [name]: value };
  }
  if (action.startsWith("__delete:")) {
    const name = action.slice("__delete:".length);
    const { [name]: _, ...rest } = headers;
    return rest;
  }
  const value = await promptSecretRef(`Value for "${action}"`, false);
  return { ...headers, [action]: value };
}

async function runModelWizard(models: ModelConfig[]): Promise<ModelConfig[]> {
  let current = [...models];
  let exit = false;
  while (!exit) {
    const choices: { value: ModelAction; name: string }[] = [{ value: "add", name: "Add model" }];
    if (current.length > 0) {
      choices.push({ value: "edit", name: "Edit model" });
      choices.push({ value: "delete", name: "Delete model" });
    }
    choices.push({ value: "back", name: "Done" });
    const action = await select<ModelAction>({ message: `Models (${current.length})`, choices });
    switch (action) {
      case "add": {
        const model = await addModel();
        if (model !== undefined) current = [...current, model];
        break;
      }
      case "edit": {
        const index = await selectModelIndex(current);
        const toEdit = index !== undefined ? current[index] : undefined;
        if (toEdit !== undefined) {
          const model = await editModel(toEdit);
          if (model !== undefined) current = current.map((m, i) => (i === index ? model : m));
        }
        break;
      }
      case "delete": {
        const index = await selectModelIndex(current);
        const toDelete = index !== undefined ? current[index] : undefined;
        if (toDelete !== undefined && (await confirm({ message: `Delete model "${toDelete.id}"?` }))) {
          current = current.filter((_, i) => i !== index);
        }
        break;
      }
      case "back":
      default:
        exit = true;
        break;
    }
  }
  return current;
}

async function selectModelIndex(models: ModelConfig[]): Promise<number | undefined> {
  return select<number>({
    message: "Select model",
    choices: models.map((model, i) => ({ value: i, name: `${model.id} (${model.name ?? model.id})` })),
  });
}

async function addModel(): Promise<ModelConfig | undefined> {
  const id = await input({
    message: "Model ID",
    validate: (value) => value.trim().length > 0 || "Required",
  });
  const useModelsDev = await confirm({ message: "Look up model metadata from models.dev?", default: true });
  let defaults:
    | {
        name: string;
        reasoning: boolean;
        input: Array<"text" | "image">;
        context_window: number;
        max_tokens: number;
        cost: { input: number; output: number; cache_read: number; cache_write: number };
      }
    | undefined;
  if (useModelsDev) {
    defaults = await lookupModelDefaults(id);
  }
  const name = (await promptString("Display name (optional)", defaults?.name ?? id, false)) || id;
  const reasoning = await promptBoolean("Supports reasoning", defaults?.reasoning ?? false);
  const capabilities = await promptInputCapabilities(defaults?.input ?? ["text"]);
  const contextWindow = await promptPositiveInteger("Context window (tokens)", defaults?.context_window ?? 128000);
  const maxTokens = await promptPositiveInteger("Max output tokens", defaults?.max_tokens ?? 4096);
  if (maxTokens > contextWindow) {
    console.error("Max output tokens cannot exceed context window");
    return undefined;
  }
  const costInput = await promptNonNegativeNumber("Input cost per 1M tokens", defaults?.cost.input ?? 0);
  const costOutput = await promptNonNegativeNumber("Output cost per 1M tokens", defaults?.cost.output ?? 0);
  const costCacheRead = await promptNonNegativeNumber("Cache read cost per 1M tokens", defaults?.cost.cache_read ?? 0);
  const costCacheWrite = await promptNonNegativeNumber("Cache write cost per 1M tokens", defaults?.cost.cache_write ?? 0);
  return {
    id,
    name,
    reasoning,
    input: capabilities,
    context_window: contextWindow,
    max_tokens: maxTokens,
    cost: { input: costInput, output: costOutput, cache_read: costCacheRead, cache_write: costCacheWrite },
  };
}

async function editModel(model: ModelConfig): Promise<ModelConfig | undefined> {
  const action = await select<ModelField>({
    message: `Edit model ${model.id}`,
    choices: [
      { value: "name", name: `Name: ${model.name ?? model.id}` },
      { value: "reasoning", name: `Reasoning: ${model.reasoning}` },
      { value: "input", name: `Input: ${model.input.join(", ")}` },
      { value: "context_window", name: `Context window: ${model.context_window}` },
      { value: "max_tokens", name: `Max output tokens: ${model.max_tokens}` },
      { value: "cost", name: "Cost" },
      { value: "cancel", name: "Cancel" },
    ],
  });
  switch (action) {
    case "name": {
      const name = await promptString("Display name", model.name ?? model.id);
      return { ...model, name };
    }
    case "reasoning": {
      const reasoning = await promptBoolean("Supports reasoning", model.reasoning);
      return { ...model, reasoning };
    }
    case "input": {
      const capabilities = await promptInputCapabilities(model.input);
      return { ...model, input: capabilities };
    }
    case "context_window": {
      const contextWindow = await promptPositiveInteger("Context window", model.context_window);
      return { ...model, context_window: contextWindow };
    }
    case "max_tokens": {
      const maxTokens = await promptPositiveInteger("Max output tokens", model.max_tokens);
      if (maxTokens > model.context_window) {
        console.error("Max output tokens cannot exceed context window");
        return model;
      }
      return { ...model, max_tokens: maxTokens };
    }
    case "cost": {
      const inputCost = await promptNonNegativeNumber("Input cost", model.cost.input);
      const outputCost = await promptNonNegativeNumber("Output cost", model.cost.output);
      const cacheRead = await promptNonNegativeNumber("Cache read cost", model.cost.cache_read);
      const cacheWrite = await promptNonNegativeNumber("Cache write cost", model.cost.cache_write);
      return { ...model, cost: { input: inputCost, output: outputCost, cache_read: cacheRead, cache_write: cacheWrite } };
    }
    case "cancel":
    default:
      return undefined;
  }
}

async function lookupModelDefaults(id: string): Promise<
  | {
      name: string;
      reasoning: boolean;
      input: Array<"text" | "image">;
      context_window: number;
      max_tokens: number;
      cost: { input: number; output: number; cache_read: number; cache_write: number };
    }
  | undefined
> {
  let catalog: ModelsDevCatalog;
  try {
    ({ catalog } = await fetchModelsDevCatalog());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to fetch models.dev catalog: ${message}`);
    return undefined;
  }
  const providers = listModelsDevProviders(catalog);
  const providerId = await select<string>({
    message: "models.dev provider",
    choices: providers.map((provider) => ({ value: provider.id, name: `${provider.name} (${provider.id})` })),
  });
  const provider = providers.find((p) => p.id === providerId);
  if (provider === undefined) return undefined;
  const exact = findModel(catalog, providerId, id);
  let model: ModelsDevModel | undefined = exact;
  if (model === undefined) {
    const models = listModelsDevModels(provider);
    const modelId = await select<string>({
      message: `Select model ("${id}" not found in ${provider.name})`,
      choices: models.map((m) => ({ value: m.id, name: `${m.name} (${m.id})` })),
    });
    model = findModel(catalog, providerId, modelId);
  }
  if (model === undefined) return undefined;
  const defaults = toModelDefaults(model);
  console.log(`Filled from models.dev: ${model.name}`);
  return defaults;
}
