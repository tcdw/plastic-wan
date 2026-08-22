import Type from 'typebox';
import Compile from 'typebox/compile';
import type { SecretRef } from '../config.ts';
import type { SecretStore } from '../secrets.ts';
import type { ApiAdapter } from './prompts.ts';

const MAX_MODELS_RESPONSE_BYTES = 1_048_576;
const MODELS_REQUEST_TIMEOUT_MS = 10_000;

const ProviderModelsResponseSchema = Type.Object(
  {
    data: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          name: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const providerModelsResponseValidator = Compile(ProviderModelsResponseSchema);

export interface DiscoveredProviderModel {
  readonly id: string;
  readonly name?: string;
}

export interface ProviderModelDiscoveryConfig {
  readonly baseUrl: string;
  readonly api: ApiAdapter;
  readonly apiKey: SecretRef;
  readonly headers?: Readonly<Record<string, SecretRef>>;
}

export async function fetchProviderModels(
  config: ProviderModelDiscoveryConfig,
  secrets: SecretStore,
): Promise<DiscoveredProviderModel[]> {
  const endpoint = modelsEndpoint(config.baseUrl);
  const headers = new Headers({ accept: 'application/json' });
  for (const [name, reference] of Object.entries(config.headers ?? {})) {
    headers.set(name, await secrets.resolve(reference));
  }
  const apiKey = await secrets.resolve(config.apiKey);
  if (config.api === 'anthropic-messages') {
    if (!headers.has('x-api-key')) headers.set('x-api-key', apiKey);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  } else if (!headers.has('authorization')) {
    headers.set('authorization', `Bearer ${apiKey}`);
  }

  const response = await fetch(endpoint, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(MODELS_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Models endpoint returned ${response.status} ${response.statusText}`.trim());
  }
  const raw = await readJsonResponse(response);
  if (!providerModelsResponseValidator.Check(raw)) {
    throw new Error('Models endpoint returned an invalid OpenAI models response');
  }

  const models = new Map<string, DiscoveredProviderModel>();
  for (const model of raw.data) {
    if (!models.has(model.id)) {
      models.set(model.id, model.name === undefined ? { id: model.id } : { id: model.id, name: model.name });
    }
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function modelsEndpoint(baseUrl: string): string {
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
  return `${parsed.href.replace(/\/+$/, '')}/models`;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODELS_RESPONSE_BYTES) {
    throw new Error(`Models endpoint response exceeds ${MAX_MODELS_RESPONSE_BYTES} bytes`);
  }
  if (response.body === null) throw new Error('Models endpoint returned an empty response');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MODELS_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Models endpoint response exceeds ${MAX_MODELS_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('Models endpoint returned invalid JSON');
  }
}
