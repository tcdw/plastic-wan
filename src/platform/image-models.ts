import { createHash } from 'node:crypto';
import { aspectRatios, type ModelCapability, resolutionClasses } from '@plasticwan/image-service';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { readBoundedText } from './provider-models.ts';

const CATALOG_URL = 'https://openrouter.ai/api/v1/images/models';
const ModelId = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]*/[a-zA-Z0-9][a-zA-Z0-9_.-]*$', maxLength: 200 });
const EnumParameter = Type.Object({ type: Type.Literal('enum'), values: Type.Array(Type.String()) });
const RangeParameter = Type.Object({
  type: Type.Literal('range'),
  min: Type.Integer({ minimum: 0 }),
  max: Type.Integer({ minimum: 0 }),
});
const Parameters = Type.Object({
  aspect_ratio: Type.Optional(EnumParameter),
  quality: Type.Optional(EnumParameter),
  output_format: Type.Optional(EnumParameter),
  input_references: Type.Optional(RangeParameter),
  n: Type.Optional(RangeParameter),
});
const catalogValidator = Compile(
  Type.Object({
    data: Type.Array(
      Type.Object({
        id: ModelId,
        name: Type.String({ minLength: 1 }),
        architecture: Type.Object({ output_modalities: Type.Array(Type.String()) }),
      }),
      { maxItems: 2000 },
    ),
  }),
);
const endpointsValidator = Compile(
  Type.Object({
    id: ModelId,
    endpoints: Type.Array(
      Type.Object({
        provider_name: Type.String({ minLength: 1 }),
        provider_tag: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}(?:/[a-zA-Z0-9_-]{1,80})?$' }),
        supported_parameters: Parameters,
      }),
      { maxItems: 200 },
    ),
  }),
);
const modelIdValidator = Compile(ModelId);

async function fetchImageMetadata(url: string): Promise<unknown> {
  // This public catalog needs no credential, including before images are enabled.
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenRouter 模型目录返回 HTTP ${response.status}`);
  }
  const body = await readBoundedText(response, 8 * 1_048_576);
  return JSON.parse(body.text) as unknown;
}

export async function listOpenRouterImageModels() {
  const payload = await fetchImageMetadata(CATALOG_URL);
  if (!catalogValidator.Check(payload)) {
    throw new Error('OpenRouter 图片模型目录格式不正确');
  }
  return [
    ...new Map(
      payload.data
        .filter((model) => model.architecture.output_modalities.includes('image'))
        .map((model) => [model.id, { id: model.id, name: model.name.slice(0, 80) }]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

function capabilities(parameters: Static<typeof Parameters>): ModelCapability {
  const maxInputImages = Math.min(16, parameters.input_references?.max ?? 0);
  return {
    imageInput: maxInputImages > 0,
    maxInputImages,
    maxOutputs: Math.max(1, Math.min(10, parameters.n?.max ?? 1)),
    // Auto omits the upstream parameter; only advertise explicit values the endpoint lists.
    aspectRatios: aspectRatios.filter((ratio) => ratio === 'auto' || parameters.aspect_ratio?.values.includes(ratio)),
    resolutionClasses: resolutionClasses.filter(
      (level) => level === 'auto' || parameters.quality?.values.includes(level),
    ),
  };
}

export function validImageModelId(value: unknown): value is string {
  return modelIdValidator.Check(value);
}

export async function listOpenRouterImageEndpoints(modelId: string) {
  if (!validImageModelId(modelId)) {
    throw new Error('图片模型 ID 不合法');
  }
  const payload = await fetchImageMetadata(`${CATALOG_URL}/${modelId}/endpoints`);
  if (!endpointsValidator.Check(payload) || payload.id !== modelId) {
    throw new Error('OpenRouter 图片供应商目录格式不正确');
  }
  return payload.endpoints.map((endpoint) => {
    const parameters = endpoint.supported_parameters;
    const formats = parameters.output_format?.values;
    const unavailableReason =
      (parameters.input_references?.min ?? 0) > 0
        ? '此模型要求必填参考图，当前生图流程暂不支持'
        : formats !== undefined && !formats.some((format) => ['png', 'jpeg', 'webp'].includes(format))
          ? '此模型仅输出矢量图，当前图库暂不支持'
          : parameters.n !== undefined && (parameters.n.min > 1 || parameters.n.max < 1)
            ? '此供应商不支持单张生成'
            : null;
    const suffix = createHash('sha256').update(`${modelId}/${endpoint.provider_tag}`).digest('hex').slice(0, 8);
    return {
      id: `${modelId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70)}-${suffix}`,
      providerTag: endpoint.provider_tag,
      providerName: endpoint.provider_name,
      capabilities: capabilities(parameters),
      unavailableReason,
    };
  });
}
