import { z } from 'zod';

/**
 * Domain contracts for the image generation core. This module must stay safe to
 * import from browsers and adapters: no Node, SQLite or Sharp imports. Product
 * assumptions from the standalone app (auth, API keys, HTTP URLs, config files)
 * are deliberately absent; ownership is an opaque string supplied by the host.
 */

export const idSchema = z.uuid();
export const nameSchema = z.string().trim().min(1).max(160);
const descriptionSchema = z.string().max(2000);
const categorySchema = z.string().trim().max(80);
export const promptBodySchema = z
  .string()
  .min(1)
  .max(32000)
  .refine((value) => !value.includes('{{') && !value.includes('}}'), 'Prompt 素材不支持递归引用或引用分隔符');
export const promptCreateSchema = z
  .object({
    name: nameSchema,
    body: promptBodySchema,
    description: descriptionSchema.default(''),
    category: categorySchema.default(''),
  })
  .strict();
export const promptUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    body: promptBodySchema.optional(),
    description: descriptionSchema.optional(),
    category: categorySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '至少修改一个字段');
export const maxImageBytes = 20 * 1024 * 1024;
export const imageCreateSchema = z
  .object({
    name: nameSchema,
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(maxImageBytes / 3) * 4),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    description: descriptionSchema.default(''),
    category: categorySchema.default(''),
  })
  .strict();
export const imageUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    category: categorySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '至少修改一个字段');
export const listSchema = z
  .object({
    q: z.string().max(200).default(''),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListQuery = z.infer<typeof listSchema>;
export type Page<T> = { items: T[]; total: number; limit: number; offset: number };
export type PromptAsset = {
  id: string;
  name: string;
  body: string;
  description: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
export type ImageAsset = {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  description: string;
  category: string;
  source: 'upload' | 'generation';
  generationId: string | null;
  outputIndex: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export const parameterNames = [
  'aspect_ratio',
  'resolution',
  'size',
  'quality',
  'output_format',
  'background',
  'output_compression',
  'seed',
] as const;
export const parameterSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        name: z.enum(parameterNames),
        label: nameSchema,
        type: z.literal('enum'),
        options: z.array(z.string().min(1).max(40)).min(1).max(40),
        default: z.string().optional(),
      })
      .strict(),
    z
      .object({
        name: z.enum(parameterNames),
        label: nameSchema,
        type: z.literal('integer'),
        min: z.number().int(),
        max: z.number().int(),
        default: z.number().int().optional(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.type === 'enum' && value.default !== undefined && !value.options.includes(value.default)) {
      ctx.addIssue({ code: 'custom', message: '默认值不在选项中' });
    }
    if (
      value.type === 'integer' &&
      (value.min > value.max ||
        (value.default !== undefined && (value.default < value.min || value.default > value.max)))
    ) {
      ctx.addIssue({ code: 'custom', message: '参数范围或默认值无效' });
    }
    if (['output_compression', 'seed'].includes(value.name) !== (value.type === 'integer')) {
      ctx.addIssue({ code: 'custom', message: '参数映射类型无效' });
    }
    if (value.type === 'enum') {
      const allowed: Partial<Record<string, string[]>> = {
        aspect_ratio: [
          'auto',
          '1:1',
          '16:9',
          '9:16',
          '4:3',
          '3:4',
          '3:2',
          '2:3',
          '4:5',
          '5:4',
          '1:2',
          '2:1',
          '1:4',
          '4:1',
          '1:8',
          '8:1',
          '9:21',
          '21:9',
        ],
        quality: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
        output_format: ['png', 'jpeg', 'webp'],
        background: ['auto', 'transparent', 'opaque'],
        resolution: ['512', '1K', '2K', '4K'],
      };
      if (
        value.name === 'size' &&
        value.options.some(
          (option) =>
            !['512', '1K', '2K', '4K'].includes(option) &&
            !/^(?:[1-9]\d{2}|[1-7]\d{3}|8000)x(?:[1-9]\d{2}|[1-7]\d{3}|8000)$/.test(option),
        )
      ) {
        ctx.addIssue({ code: 'custom', message: '像素尺寸必须在100..8000范围内或使用分辨率档位' });
      }
      if (allowed[value.name] && value.options.some((option) => !allowed[value.name]?.includes(option))) {
        ctx.addIssue({ code: 'custom', message: '不支持的上游参数选项' });
      }
    }
    if (value.type === 'integer' && (value.min < 0 || (value.name === 'output_compression' && value.max > 100))) {
      ctx.addIssue({ code: 'custom', message: '上游整数范围无效' });
    }
  });
export type ParameterDefinition = z.infer<typeof parameterSchema>;
export const modelDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    name: nameSchema,
    provider: z.literal('openrouter'),
    upstreamModel: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    credentialRef: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    providerTag: z.string().regex(/^[a-zA-Z0-9_-]{1,80}(?:\/[a-zA-Z0-9_-]{1,80})?$/),
    capabilities: z
      .object({ maxReferences: z.number().int().min(0).max(16), maxOutputs: z.number().int().min(1).max(10) })
      .strict(),
    parameters: z.array(parameterSchema).max(8),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.parameters.map((p) => p.name)).size !== value.parameters.length) {
      ctx.addIssue({ code: 'custom', message: '参数名称重复' });
    }
    try {
      effectiveParameters(value, {
        authoredPrompt: '配置默认值校验',
        modelId: value.id,
        outputCount: 1,
        parameters: {},
      });
    } catch {
      ctx.addIssue({ code: 'custom', message: '模型默认参数组合无效' });
    }
  });
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;
export type PublicModel = Omit<ModelDefinition, 'credentialRef'>;
export const generationCreateSchema = z
  .object({
    authoredPrompt: z.string().min(1).max(32000),
    modelId: z.string().min(1).max(80),
    parameters: z.record(z.string(), z.union([z.string().max(80), z.number().finite()])).default({}),
    outputCount: z.number().int().min(1).max(10).default(1),
  })
  .strict();
export type GenerationInput = z.infer<typeof generationCreateSchema>;
export const idempotencyKeySchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/, '幂等键必须为1..128位安全字符');

/**
 * Ownership vocabulary. `source` names the calling surface (for example "admin"
 * or "agent"), `scopes` are checked per operation, and `privileged` marks an
 * actor the host vouches for (it bypasses per-scope checks). The core never
 * interprets these values beyond equality and scope membership.
 */
export const generationScopes = [
  'asset:read',
  'asset:write',
  'asset:delete',
  'generation:read',
  'generation:create',
  'model:read',
] as const;
export type GenerationScope = (typeof generationScopes)[number];
export const generationSourceSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9._-]*$/);
export type GenerationSource = string;
export type GenerationActor = {
  id: string;
  name: string;
  source: GenerationSource;
  scopes: readonly GenerationScope[];
  privileged: boolean;
};

export type GenerationSnapshot = {
  schemaVersion: 1;
  authored: GenerationInput;
  resolvedPrompt: string;
  finalPrompt: string;
  promptAssets: PromptAsset[];
  imageAssets: ImageAsset[];
  model: ModelDefinition;
  configVersion: string;
  effectiveParameters: Record<string, string | number>;
  requestSemantics: { adapterVersion: 1; calls: number; imagesPerCall: 1; appendedInstructions: string[] };
};
export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';
export type SafeError = { code: string; message: string; stage?: 'input' | 'provider' | 'storage' | 'interrupted' };
export type GenerationAttempt = {
  id: string;
  generationId: string;
  round: number;
  itemIndex: number;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  error: SafeError | null;
  providerRequestId: string | null;
  usage: Record<string, number> | null;
  outputAssetId: string | null;
};
export type Generation = {
  id: string;
  status: GenerationStatus;
  source: GenerationSource;
  actorName: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  snapshot: GenerationSnapshot;
  attempts: GenerationAttempt[];
  outputs: ImageAsset[];
  error: SafeError | null;
  round: number;
};
export type ResolvedInput = { snapshot: GenerationSnapshot };
export type ErrorResponse = { error: SafeError };

export type Reference = { kind: 'prompt' | 'image'; id: string; token: string; start: number; end: number };
export function referenceToken(kind: Reference['kind'], id: string): string {
  return `{{${kind}:${id}}}`;
}
export function scanReferences(text: string): Reference[] {
  const pattern = /\{\{(prompt|image):([0-9a-fA-F-]{36})\}\}/g;
  const references: Reference[] = [];
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const id = idSchema.parse(match[2]);
    references.push({
      kind: match[1] as Reference['kind'],
      id: id.toLowerCase(),
      token: match[0],
      start: match.index,
      end: pattern.lastIndex,
    });
    match = pattern.exec(text);
  }
  const remainder = text.replace(pattern, '');
  if (remainder.includes('{{') || remainder.includes('}}')) {
    throw new Error('素材引用语法损坏；请使用 {{prompt:UUID}} 或 {{image:UUID}}');
  }
  return references;
}
export function removeReference(text: string, kind: Reference['kind'], id: string): string {
  const refs = scanReferences(text).filter((ref) => ref.kind === kind && ref.id === id.toLowerCase());
  for (const ref of refs.reverse()) {
    text = text.slice(0, ref.start) + text.slice(ref.end);
  }
  return text;
}
export function effectiveParameters(
  model: ModelDefinition,
  authored: GenerationInput,
): Record<string, string | number> {
  if (authored.outputCount > model.capabilities.maxOutputs) {
    throw new Error('输出数量超出模型限制');
  }
  const result: Record<string, string | number> = {};
  for (const name of Object.keys(authored.parameters)) {
    if (!model.parameters.some((p) => p.name === name)) {
      throw new Error(`模型不支持参数：${name}`);
    }
  }
  for (const p of model.parameters) {
    const value = authored.parameters[p.name] ?? p.default;
    if (value === undefined) {
      continue;
    }
    if (
      p.type === 'enum'
        ? typeof value !== 'string' || !p.options.includes(value)
        : typeof value !== 'number' || !Number.isInteger(value) || value < p.min || value > p.max
    ) {
      throw new Error(`参数值无效：${p.label}`);
    }
    result[p.name] = value;
  }
  if (result.size !== undefined && (result.resolution !== undefined || result.aspect_ratio !== undefined)) {
    throw new Error('size 不能与 resolution 或 aspect_ratio 同时设置');
  }
  if (result.background === 'transparent' && result.output_format === 'jpeg') {
    throw new Error('透明背景不能使用 JPEG');
  }
  if (result.output_compression !== undefined && result.output_format !== 'jpeg' && result.output_format !== 'webp') {
    throw new Error('压缩率只能用于 JPEG 或 WebP');
  }
  return result;
}
