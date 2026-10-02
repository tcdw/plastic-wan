import { AppError } from './errors.ts';
import type { ImageProviderAdapter, ProviderImage, ProviderInvocation } from './provider.ts';

/**
 * OpenRouter adapter: the first provider plugin over the lossy core API.
 * Verified 2026-10-01: POST https://openrouter.ai/api/v1/images with
 * { model, prompt, n, size?, quality?, input_references?, provider?, <extended> }.
 *
 * Intent mapping (the core's aspectRatio/resolution are classes, not pixels):
 *   aspectRatio -> size ('1:1' -> 1024x1024, '2:3' -> 1024x1536, '3:2' -> 1536x1024,
 *   'auto' -> 'auto'); ratios the vendor does not offer must not be routed here —
 *   models declare supported ratios in their capabilities and the core rejects
 *   the rest before a paid call. resolution -> quality ('auto' passthrough).
 * extendedData entries are merged into the body top level: this adapter treats
 * them as extra OpenAI image parameters and never lets them shadow reserved keys.
 */
export const OPENROUTER_IMAGES_ENDPOINT = 'https://openrouter.ai/api/v1/images';
export const ADAPTER_VERSION = 1 as const;

export const ADAPTER_ID = 'openrouter' as const;

const SIZE_BY_ASPECT_RATIO: Record<string, string> = {
  auto: 'auto',
  '1:1': '1024x1024',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
};

/** Parameter names owned by the adapter; extendedData may never shadow them. */
const RESERVED_BODY_KEYS = new Set(['model', 'prompt', 'n', 'size', 'quality', 'input_references', 'provider']);

export function buildImageRequestBody(invocation: ProviderInvocation): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: invocation.model.upstreamModel,
    prompt: invocation.prompt,
    n: 1,
    provider: { only: [invocation.model.providerTag], allow_fallbacks: false },
  };
  const size = SIZE_BY_ASPECT_RATIO[invocation.aspectRatio];
  if (size === undefined) {
    throw new AppError('unsupported_aspect_ratio', `适配器不支持画面比例 ${invocation.aspectRatio}`, 'input');
  }
  if (invocation.aspectRatio !== 'auto') {
    body.size = size;
  }
  if (invocation.resolution !== 'auto') {
    body.quality = invocation.resolution;
  }
  if (invocation.extendedData !== undefined) {
    for (const [key, value] of Object.entries(invocation.extendedData)) {
      if (RESERVED_BODY_KEYS.has(key)) {
        continue;
      }
      body[key] = value;
    }
  }
  if (invocation.inputImages.length > 0) {
    body.input_references = invocation.inputImages.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mime};base64,${image.base64}` },
    }));
  }
  return body;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function numericUsage(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const usage: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      usage[key] = entry;
    }
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

export type ProviderCallKind = 'http' | 'interrupted' | 'protocol';

export class ProviderCallError extends AppError {
  readonly kind: ProviderCallKind;

  constructor(kind: ProviderCallKind, code: string, message: string) {
    super(code, message, kind === 'interrupted' ? 'interrupted' : 'provider');
    this.name = 'ProviderCallError';
    this.kind = kind;
  }
}

/**
 * The Phase 1 adapter set holds exactly this adapter; `ModelDefinition.provider`
 * is validated against `ADAPTER_ID` by the config schema. Future plugins add
 * their own adapter module — the core stays vendor-agnostic.
 */
export function createOpenRouterAdapter(options: {
  fetchImpl: typeof fetch;
  endpoint?: string;
}): ImageProviderAdapter & {
  endpoint: string;
  adapterVersion: typeof ADAPTER_VERSION;
} {
  const fetchImpl = options.fetchImpl;
  const endpoint = options.endpoint ?? OPENROUTER_IMAGES_ENDPOINT;

  async function generate(invocation: ProviderInvocation): Promise<ProviderImage> {
    const body = buildImageRequestBody(invocation);
    const timeout = AbortSignal.timeout(invocation.timeoutMs);
    const signal = AbortSignal.any([invocation.signal, timeout]);

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${invocation.credential}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ProviderCallError('interrupted', 'provider_interrupted', '上游调用超时或被中断，结果不确定');
      }
      throw new ProviderCallError('interrupted', 'provider_unreachable', '无法连接上游服务，结果不确定');
    }

    if (!response.ok) {
      throw new ProviderCallError('http', 'provider_http_error', `上游返回 HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderCallError('protocol', 'provider_protocol_error', '上游响应无法解析');
    }

    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const data = Array.isArray(record.data) ? record.data : [];
    const first =
      data.length > 0 && typeof data[0] === 'object' && data[0] !== null ? (data[0] as Record<string, unknown>) : null;
    const base64 = first !== null && typeof first.b64_json === 'string' ? first.b64_json : null;
    if (base64 === null || base64.length === 0) {
      throw new ProviderCallError('protocol', 'provider_protocol_error', '上游响应缺少图像数据');
    }
    const mediaType = first !== null && typeof first.media_type === 'string' ? first.media_type : null;
    const headerRequestId = response.headers.get('x-request-id') ?? response.headers.get('x-openrouter-request-id');
    const bodyRequestId = typeof record.id === 'string' ? record.id : null;

    return {
      base64,
      mediaType,
      providerRequestId: headerRequestId ?? bodyRequestId,
      usage: numericUsage(record.usage),
    };
  }

  return { id: ADAPTER_ID, generate, endpoint, adapterVersion: ADAPTER_VERSION };
}
