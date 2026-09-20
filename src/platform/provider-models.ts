import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { ProviderApi } from './config.ts';

/**
 * One budget for the whole listing rather than a smaller per-page cap: an
 * unpaginated provider answers in a single page, and OpenRouter's is already
 * ~0.7 MB and grows with every model it adds.
 */
const MAX_MODELS_TOTAL_BYTES = 8 * 1_048_576;
const MODELS_REQUEST_TIMEOUT_MS = 10_000;
const MAX_MODELS_PAGES = 20;
const MAX_MODELS_TOTAL = 2_000;
const MAX_ERROR_BODY_CHARS = 512;
const PAGE_SIZE = 1_000;

/** Which extended fields the listing carries, so metadata resolution knows what it may read. */
export type ModelListFormat = 'openrouter' | 'vercel' | 'gemini' | 'openai' | 'anthropic';

const OpenRouterModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    context_length: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    top_provider: Type.Optional(
      Type.Object(
        {
          context_length: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          max_completion_tokens: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        },
        { additionalProperties: true },
      ),
    ),
    architecture: Type.Optional(
      Type.Object({ input_modalities: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: true }),
    ),
    supported_parameters: Type.Optional(Type.Array(Type.String())),
    pricing: Type.Optional(
      Type.Object(
        {
          prompt: Type.Optional(PriceSchema()),
          completion: Type.Optional(PriceSchema()),
          input_cache_read: Type.Optional(PriceSchema()),
          input_cache_write: Type.Optional(PriceSchema()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const VercelModelSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    context_window: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    max_tokens: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    type: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Array(Type.String())),
    modalities: Type.Optional(
      Type.Object({ input: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: true }),
    ),
    pricing: Type.Optional(
      Type.Object(
        {
          input: Type.Optional(PriceSchema()),
          output: Type.Optional(PriceSchema()),
          input_cache_read: Type.Optional(PriceSchema()),
          input_cache_write: Type.Optional(PriceSchema()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const GeminiModelSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    displayName: Type.Optional(Type.String({ minLength: 1 })),
    inputTokenLimit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    outputTokenLimit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    supportedGenerationMethods: Type.Optional(Type.Array(Type.String())),
    thinking: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

/** Per-token prices are strings on OpenRouter and Vercel, numbers on some gateways. */
function PriceSchema() {
  return Type.Union([Type.String(), Type.Number()]);
}

const OpenAiListSchema = Type.Object(
  {
    data: Type.Array(
      Type.Object(
        { id: Type.String({ minLength: 1 }), name: Type.Optional(Type.String()) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const OpenRouterListSchema = Type.Object({ data: Type.Array(OpenRouterModelSchema) }, { additionalProperties: true });

const VercelListSchema = Type.Object({ data: Type.Array(VercelModelSchema) }, { additionalProperties: true });

const AnthropicListSchema = Type.Object(
  {
    data: Type.Array(
      Type.Object(
        { id: Type.String({ minLength: 1 }), display_name: Type.Optional(Type.String()) },
        { additionalProperties: true },
      ),
    ),
    has_more: Type.Optional(Type.Boolean()),
    last_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);

const GeminiListSchema = Type.Object(
  {
    models: Type.Array(GeminiModelSchema),
    nextPageToken: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type OpenRouterModel = Static<typeof OpenRouterModelSchema>;
export type VercelModel = Static<typeof VercelModelSchema>;
export type GeminiModel = Static<typeof GeminiModelSchema>;

export type DiscoveredModelExtension =
  | { readonly format: 'openrouter'; readonly payload: OpenRouterModel }
  | { readonly format: 'vercel'; readonly payload: VercelModel }
  | { readonly format: 'gemini'; readonly payload: GeminiModel }
  | { readonly format: 'openai' }
  | { readonly format: 'anthropic' };

export interface DiscoveredProviderModel {
  readonly id: string;
  readonly name: string | null;
  readonly extension: DiscoveredModelExtension;
}

export interface ProviderDiscoveryRequest {
  /** Pi builtin provider id; only the Vercel AI Gateway listing special case needs it. */
  readonly builtinProvider?: string;
  readonly baseUrl: string;
  readonly api: ProviderApi;
  /**
   * Already-resolved credentials. Whether a SecretRef may be resolved at all is
   * the caller's policy — the Admin Panel never resolves what a request handed
   * it into the process-wide secret set, while the TUI resolves `env` and
   * `command` refs on purpose.
   */
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ProviderModelListing {
  readonly endpoint: string;
  readonly models: readonly DiscoveredProviderModel[];
}

export interface ModelsEndpointPlan {
  readonly endpoint: string;
  readonly auth: 'bearer' | 'x-api-key' | 'x-goog-api-key';
  readonly format: ModelListFormat;
  readonly paginated: boolean;
}

/**
 * The listing endpoint of a provider. The Vercel AI Gateway is matched before
 * the API dispatch: it speaks `anthropic-messages` for completions but exposes an
 * OpenAI-shaped listing under `/v1/models`.
 */
export function planModelsEndpoint(request: {
  readonly builtinProvider?: string;
  readonly baseUrl: string;
  readonly api: ProviderApi;
}): ModelsEndpointPlan {
  const base = stripTrailingSlashes(request.baseUrl);
  const host = parseBaseUrl(request.baseUrl).host.toLowerCase();
  if (request.builtinProvider === 'vercel-ai-gateway' || host === 'ai-gateway.vercel.sh') {
    return { endpoint: `${base}/v1/models`, auth: 'bearer', format: 'vercel', paginated: false };
  }
  switch (request.api) {
    case 'anthropic-messages':
      return { endpoint: `${base}/v1/models`, auth: 'x-api-key', format: 'anthropic', paginated: true };
    case 'google-generative-ai':
      return { endpoint: `${base}/models`, auth: 'x-goog-api-key', format: 'gemini', paginated: true };
    default:
      return {
        endpoint: `${base}/models`,
        auth: 'bearer',
        format: host === 'openrouter.ai' ? 'openrouter' : 'openai',
        paginated: false,
      };
  }
}

export async function fetchProviderModels(request: ProviderDiscoveryRequest): Promise<ProviderModelListing> {
  const plan = planModelsEndpoint(request);
  const extraHeaders = new Headers({ accept: 'application/json' });
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    extraHeaders.set(name, value);
  }
  applyAuth(extraHeaders, plan, request.apiKey);

  const collected = new Map<string, DiscoveredProviderModel>();
  let pageToken: string | undefined;
  let remaining = MAX_MODELS_TOTAL_BYTES;
  for (let page = 0; page < MAX_MODELS_PAGES; page += 1) {
    const url = pageUrl(plan, pageToken);
    const response = await fetch(url, {
      method: 'GET',
      headers: extraHeaders,
      redirect: 'error',
      signal: AbortSignal.timeout(MODELS_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Models endpoint ${plan.endpoint} returned ${response.status} ${response.statusText}: ${await readErrorBody(response)}`.trim(),
      );
    }
    const body = await readBoundedText(response, remaining);
    remaining -= body.bytes;
    const raw = parseJson(body.text);
    const parsed = parsePage(plan.format, raw);
    for (const model of parsed.models) {
      if (!collected.has(model.id)) {
        collected.set(model.id, model);
        if (collected.size > MAX_MODELS_TOTAL) {
          throw new Error(`Models endpoint returned more than ${MAX_MODELS_TOTAL} models`);
        }
      }
    }
    pageToken = parsed.nextPageToken;
    if (pageToken === undefined || !plan.paginated) {
      break;
    }
  }
  return {
    endpoint: plan.endpoint,
    models: [...collected.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function applyAuth(headers: Headers, plan: ModelsEndpointPlan, apiKey: string): void {
  if (plan.auth === 'x-api-key') {
    if (!headers.has('x-api-key')) {
      headers.set('x-api-key', apiKey);
    }
    if (!headers.has('anthropic-version')) {
      headers.set('anthropic-version', '2023-06-01');
    }
    return;
  }
  if (plan.auth === 'x-goog-api-key') {
    if (!headers.has('x-goog-api-key')) {
      headers.set('x-goog-api-key', apiKey);
    }
    return;
  }
  if (!headers.has('authorization')) {
    headers.set('authorization', `Bearer ${apiKey}`);
  }
}

function pageUrl(plan: ModelsEndpointPlan, token: string | undefined): string {
  if (token === undefined) {
    return plan.paginated ? `${plan.endpoint}?${pageSizeParam(plan)}` : plan.endpoint;
  }
  return plan.format === 'gemini'
    ? `${plan.endpoint}?pageSize=${PAGE_SIZE}&pageToken=${encodeURIComponent(token)}`
    : `${plan.endpoint}?limit=${PAGE_SIZE}&after_id=${encodeURIComponent(token)}`;
}

function pageSizeParam(plan: ModelsEndpointPlan): string {
  return plan.format === 'gemini' ? `pageSize=${PAGE_SIZE}` : `limit=${PAGE_SIZE}`;
}

interface ParsedPage {
  readonly models: readonly DiscoveredProviderModel[];
  readonly nextPageToken: string | undefined;
}

function parsePage(format: ModelListFormat, raw: unknown): ParsedPage {
  if (format === 'gemini') {
    if (!geminiListValidator.Check(raw)) {
      throw new Error('Models endpoint returned an invalid Gemini models response');
    }
    const models: DiscoveredProviderModel[] = [];
    for (const model of raw.models) {
      if (!(model.supportedGenerationMethods ?? []).includes('generateContent')) {
        continue;
      }
      models.push({
        id: model.name.replace(/^models\//, ''),
        name: model.displayName ?? null,
        extension: { format: 'gemini', payload: model },
      });
    }
    return {
      models,
      nextPageToken: raw.nextPageToken === undefined || raw.nextPageToken.length === 0 ? undefined : raw.nextPageToken,
    };
  }
  if (format === 'anthropic') {
    if (!anthropicListValidator.Check(raw)) {
      throw new Error('Models endpoint returned an invalid Anthropic models response');
    }
    return {
      models: raw.data.map((model) => ({
        id: model.id,
        name: model.display_name ?? null,
        extension: { format: 'anthropic' as const },
      })),
      nextPageToken:
        raw.has_more === true && typeof raw.last_id === 'string' && raw.last_id.length > 0 ? raw.last_id : undefined,
    };
  }
  if (format === 'vercel') {
    if (!vercelListValidator.Check(raw)) {
      throw new Error('Models endpoint returned an invalid OpenAI models response');
    }
    return {
      models: raw.data
        .filter((model) => model.type === undefined || model.type === 'language')
        .map((model) => ({
          id: model.id,
          name: model.name ?? null,
          extension: { format: 'vercel' as const, payload: model },
        })),
      nextPageToken: undefined,
    };
  }
  if (format === 'openrouter') {
    if (!openRouterListValidator.Check(raw)) {
      throw new Error('Models endpoint returned an invalid OpenAI models response');
    }
    return {
      models: raw.data.map((model) => ({
        id: model.id,
        name: model.name ?? null,
        extension: { format: 'openrouter' as const, payload: model },
      })),
      nextPageToken: undefined,
    };
  }
  if (!openAiListValidator.Check(raw)) {
    throw new Error('Models endpoint returned an invalid OpenAI models response');
  }
  return {
    models: raw.data.map((model) => ({
      id: model.id,
      name: model.name ?? null,
      extension: { format: 'openai' as const },
    })),
    nextPageToken: undefined,
  };
}

const openAiListValidator = Compile(OpenAiListSchema);
const openRouterListValidator = Compile(OpenRouterListSchema);
const vercelListValidator = Compile(VercelListSchema);
const anthropicListValidator = Compile(AnthropicListSchema);
const geminiListValidator = Compile(GeminiListSchema);

export function assertBaseUrl(baseUrl: string): void {
  parseBaseUrl(baseUrl);
}

function parseBaseUrl(baseUrl: string): URL {
  const parsed = new URL(baseUrl);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Base URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  return parsed;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

interface BoundedBody {
  readonly text: string;
  readonly bytes: number;
}

/**
 * Reads one page, counting bytes as they arrive and stopping as soon as the
 * remaining budget is gone. Counting after `response.text()` would let an
 * endpoint that declares no `content-length` buffer its whole body first, which
 * is exactly what the cap exists to prevent.
 */
async function readBoundedText(response: Response, budget: number): Promise<BoundedBody> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > budget) {
    throw new Error(`Models endpoint response exceeds ${MAX_MODELS_TOTAL_BYTES} bytes`);
  }
  if (response.body === null) {
    throw new Error('Models endpoint returned an empty response');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done || chunk.value === undefined) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > budget) {
        throw new Error(`Models endpoint response exceeds ${MAX_MODELS_TOTAL_BYTES} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    // Releases the connection whether the body ended or the budget did.
    await reader.cancel().catch(() => undefined);
  }
  return { text: text + decoder.decode(), bytes };
}

/**
 * Upstream error bodies often echo the request, key included; the caller must
 * pass the message through `SecretStore.redact` before showing it.
 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return '';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Models endpoint returned invalid JSON');
  }
}
