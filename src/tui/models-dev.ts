import { z } from 'zod';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

const ModelLimitSchema = z.object({
  context: z.number().optional(),
  input: z.number().optional(),
  output: z.number().optional(),
});

const ModelCostSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
});

const ModalitiesSchema = z.object({
  input: z.array(z.string()).default(['text']),
  output: z.array(z.string()).default(['text']),
});

const ReasoningOptionSchema = z.object({
  type: z.string(),
  values: z.array(z.string().nullable()).optional(),
});

const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  reasoning: z.boolean().default(false),
  reasoning_options: z.array(ReasoningOptionSchema).optional(),
  modalities: ModalitiesSchema.default({ input: ['text'], output: ['text'] }),
  limit: ModelLimitSchema.optional(),
  cost: ModelCostSchema.optional(),
});

const ProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  doc: z.string().optional(),
  models: z.record(z.string(), ModelSchema),
});

const CatalogSchema = z.record(z.string(), ProviderSchema);

export type ModelsDevModel = z.infer<typeof ModelSchema>;
export type ModelsDevProvider = z.infer<typeof ProviderSchema>;
export type ModelsDevCatalog = z.infer<typeof CatalogSchema>;

export async function fetchModelsDevCatalog(url = MODELS_DEV_URL): Promise<ModelsDevCatalog> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`models.dev returned ${response.status} ${response.statusText}`);
  }
  const raw: unknown = await response.json();
  return CatalogSchema.parse(raw);
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
  if (inputs.has('text')) capabilities.push('text');
  if (inputs.has('image')) capabilities.push('image');
  if (capabilities.length === 0) capabilities.push('text');
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
