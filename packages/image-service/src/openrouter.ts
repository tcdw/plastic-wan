import type { ModelDefinition } from './contracts.ts';
import { AppError } from './errors.ts';

/**
 * OpenRouter dedicated Image API (verified 2026-10-01):
 *   POST https://openrouter.ai/api/v1/images
 *   body: { model, prompt, n, input_references?, provider?, <declared parameters> }
 *   response: { created, data: [{ b64_json, media_type? }], usage? }
 *
 * The endpoint is fixed by the Phase 1 adapter; there is deliberately no configurable
 * provider URL and no mock provider in production code.
 */
export const OPENROUTER_IMAGES_ENDPOINT = 'https://openrouter.ai/api/v1/images';
export const ADAPTER_VERSION = 1 as const;

export type ProviderReference = { mime: string; base64: string };

export type ProviderRequest = {
  model: ModelDefinition;
  prompt: string;
  parameters: Record<string, string | number>;
  references: ProviderReference[];
  credential: string;
  /** Milliseconds before the call is abandoned as an uncertain (interrupted) call. */
  timeoutMs: number;
  /** Optional caller-owned abort signal, e.g. server shutdown. */
  signal?: AbortSignal;
};

export type ProviderResult = {
  base64: string;
  mediaType: string | null;
  providerRequestId: string | null;
  usage: Record<string, number> | null;
};

export type ProviderCallKind = 'http' | 'interrupted' | 'protocol';

export class ProviderCallError extends AppError {
  readonly kind: ProviderCallKind;

  constructor(kind: ProviderCallKind, code: string, message: string) {
    super(code, message, kind === 'interrupted' ? 'interrupted' : 'provider');
    this.name = 'ProviderCallError';
    this.kind = kind;
  }
}

/** Parameter names that are owned by the adapter and may never be authored away. */
const RESERVED_BODY_KEYS = new Set(['model', 'prompt', 'n', 'input_references', 'provider']);

export function buildImageRequestBody(
  request: Omit<ProviderRequest, 'credential' | 'timeoutMs' | 'signal'>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model.upstreamModel,
    prompt: request.prompt,
    n: 1,
    provider: { only: [request.model.providerTag], allow_fallbacks: false },
  };
  for (const [name, value] of Object.entries(request.parameters)) {
    if (RESERVED_BODY_KEYS.has(name)) {
      continue;
    }
    body[name] = value;
  }
  if (request.references.length > 0) {
    body.input_references = request.references.map((reference) => ({
      type: 'image_url',
      image_url: { url: `data:${reference.mime};base64,${reference.base64}` },
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

export type ProviderClient = ReturnType<typeof createProviderClient>;

export function createProviderClient(options: { fetchImpl: typeof fetch; endpoint?: string }) {
  const fetchImpl = options.fetchImpl;
  const endpoint = options.endpoint ?? OPENROUTER_IMAGES_ENDPOINT;

  async function generate(request: ProviderRequest): Promise<ProviderResult> {
    const body = buildImageRequestBody(request);
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${request.credential}`,
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

  return { generate, endpoint, adapterVersion: ADAPTER_VERSION };
}
