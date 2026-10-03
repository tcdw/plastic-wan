import { buildImageRequestBody, modelDefinitionSchema } from '@plasticwan/image-service';
import { afterEach, expect, test, vi } from 'vitest';
import { listOpenRouterImageEndpoints, listOpenRouterImageModels } from '../src/platform/image-models.ts';

const modelId = 'google/gemini-3.1-flash-image';
const parameters = {
  aspect_ratio: { type: 'enum', values: ['1:1', '16:9', '21:9'] },
  quality: { type: 'enum', values: ['low', 'high', 'ultra'] },
  input_references: { type: 'range', min: 0, max: 14 },
  n: { type: 'range', min: 1, max: 1 },
};
function mockEndpoints(supported = parameters) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      id: modelId,
      endpoints: [
        { provider_name: 'Google AI Studio', provider_tag: 'google-ai-studio', supported_parameters: supported },
      ],
    }),
  );
}
afterEach(() => vi.restoreAllMocks());

test('lists only image output models from the public Images API without credentials', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      data: [
        { id: modelId, name: 'Nano Banana', architecture: { output_modalities: ['image'] } },
        { id: modelId, name: 'Nano Banana', architecture: { output_modalities: ['image'] } },
        { id: 'test/vision', name: 'Vision only', architecture: { output_modalities: ['text'] } },
      ],
    }),
  );
  expect(await listOpenRouterImageModels()).toEqual([{ id: modelId, name: 'Nano Banana' }]);
  expect(spy.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/images/models');
  const options = spy.mock.calls[0]?.[1];
  expect(new Headers(options?.headers).has('authorization')).toBe(false);
  expect(options?.redirect).toBe('error');
  expect(options?.signal).toBeInstanceOf(AbortSignal);
});

test('uses endpoint routing tags and supported capabilities to produce a valid config and request', async () => {
  const spy = mockEndpoints();
  const endpoint = (await listOpenRouterImageEndpoints(modelId))[0]!;
  expect(spy.mock.calls[0]?.[0]).toBe(`https://openrouter.ai/api/v1/images/models/${modelId}/endpoints`);
  expect(endpoint.providerTag).toBe('google-ai-studio');
  expect(endpoint.capabilities).toEqual({
    imageInput: true,
    maxInputImages: 14,
    maxOutputs: 1,
    aspectRatios: ['auto', '1:1', '16:9'],
    resolutionClasses: ['auto', 'low', 'high'],
  });
  const model = modelDefinitionSchema.parse({
    id: endpoint.id,
    name: 'Nano Banana',
    provider: 'openrouter',
    upstreamModel: modelId,
    providerTag: endpoint.providerTag,
    credentialRef: 'openrouter',
    capabilities: endpoint.capabilities,
  });
  const body = buildImageRequestBody({
    model,
    prompt: 'landscape',
    aspectRatio: '16:9',
    resolution: 'high',
    inputImages: [],
    credential: 'test-key',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    extendedData: { model: 'wrong/model', aspect_ratio: '1:1', size: 'bad', quality: 'low' },
  });
  expect(body).toEqual({
    model: modelId,
    prompt: 'landscape',
    n: 1,
    provider: { only: ['google-ai-studio'], allow_fallbacks: false },
    aspect_ratio: '16:9',
    quality: 'high',
  });
});

test('missing capabilities stay conservative and required inputs or vector-only outputs cannot be added', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      id: modelId,
      endpoints: [
        { provider_name: 'Default', provider_tag: 'default', supported_parameters: {} },
        {
          provider_name: 'Edit',
          provider_tag: 'edit',
          supported_parameters: { input_references: { type: 'range', min: 1, max: 1 } },
        },
        {
          provider_name: 'Vector',
          provider_tag: 'vector',
          supported_parameters: { output_format: { type: 'enum', values: ['svg'] } },
        },
      ],
    }),
  );
  const endpoints = await listOpenRouterImageEndpoints(modelId);
  expect(endpoints[0]?.capabilities).toEqual({
    imageInput: false,
    maxInputImages: 0,
    maxOutputs: 1,
    aspectRatios: ['auto'],
    resolutionClasses: ['auto'],
  });
  expect(endpoints[1]?.unavailableReason).toContain('参考图');
  expect(endpoints[2]?.unavailableReason).toContain('矢量图');
  expect(new Set(endpoints.map((entry) => entry.id)).size).toBe(3);
});

test('rejects untrusted IDs, invalid metadata, oversized responses and upstream errors', async () => {
  const spy = vi.spyOn(globalThis, 'fetch');
  await expect(listOpenRouterImageEndpoints('../bad?key=secret')).rejects.toThrow('ID');
  await expect(listOpenRouterImageEndpoints('../bad')).rejects.toThrow('ID');
  expect(spy).not.toHaveBeenCalled();
  spy.mockResolvedValueOnce(Response.json({ data: [{ id: modelId }] }));
  await expect(listOpenRouterImageModels()).rejects.toThrow('格式');
  spy.mockResolvedValueOnce(Response.json({ id: 'wrong/model', endpoints: [] }));
  await expect(listOpenRouterImageEndpoints(modelId)).rejects.toThrow('格式');
  spy.mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': String(9 * 1_048_576) } }));
  await expect(listOpenRouterImageModels()).rejects.toThrow('exceeds');
  spy.mockResolvedValueOnce(new Response('private upstream details', { status: 503 }));
  await expect(listOpenRouterImageModels()).rejects.toThrow('HTTP 503');
});
