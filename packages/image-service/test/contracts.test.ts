import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  effectiveParameters,
  generationCreateSchema,
  idempotencyKeySchema,
  imageUpdateSchema,
  modelDefinitionSchema,
  promptCreateSchema,
  promptUpdateSchema,
  removeReference,
  scanReferences,
} from '../src/contracts.ts';

const id = '550e8400-e29b-41d4-a716-446655440000';
test('PATCH不注入默认值且禁止空更新，Prompt禁止递归引用', () => {
  assert.deepEqual(promptUpdateSchema.parse({ name: 'rename' }), { name: 'rename' });
  assert.deepEqual(imageUpdateSchema.parse({ name: 'rename' }), { name: 'rename' });
  assert.throws(() => promptUpdateSchema.parse({}));
  assert.throws(() => imageUpdateSchema.parse({}));
  assert.throws(() => promptCreateSchema.parse({ name: 'recursive', body: `hello {{prompt:${id}}}` }));
  assert.throws(() => idempotencyKeySchema.parse('unsafe/key'));
  assert.equal(idempotencyKeySchema.parse('request:123'), 'request:123');
});
test('引用稳定、顺序明确、按身份移除所有重复出现', () => {
  const text = `draw {{prompt:${id}}} with {{image:${id}}} {{prompt:${id}}}`;
  assert.deepEqual(
    scanReferences(text).map(({ kind, id: refId }) => [kind, refId]),
    [
      ['prompt', id],
      ['image', id],
      ['prompt', id],
    ],
  );
  assert.equal(removeReference(text, 'prompt', id), `draw  with {{image:${id}}} `);
  assert.throws(() => scanReferences('{{prompt:missing}}'));
  assert.throws(() => scanReferences(`{{image:${id}}`));
  assert.throws(() => scanReferences('{{unknown:thing}}'));
});
test('严格生成 schema 不接受漂移引用列表或任意请求参数', () => {
  assert.equal(generationCreateSchema.parse({ authoredPrompt: 'draw', modelId: 'model' }).outputCount, 1);
  assert.throws(() => generationCreateSchema.parse({ authoredPrompt: 'draw', modelId: 'model', referenceIds: [] }));
});
test('默认值和模型能力双重校验，未知参数、非法值与组合被拒绝', () => {
  const model = modelDefinitionSchema.parse({
    id: 'model',
    name: 'Model',
    provider: 'openrouter',
    upstreamModel: 'openai/gpt-image-1',
    credentialRef: 'openrouter',
    providerTag: 'openai',
    capabilities: { maxReferences: 1, maxOutputs: 2 },
    parameters: [{ name: 'quality', label: '质量', type: 'enum', options: ['auto', 'low'], default: 'auto' }],
  });
  const input = generationCreateSchema.parse({ authoredPrompt: 'draw', modelId: 'model' });
  assert.deepEqual(effectiveParameters(model, input), { quality: 'auto' });
  assert.throws(() => effectiveParameters(model, { ...input, parameters: { authorization: 'secret' } }));
  assert.throws(() => effectiveParameters(model, { ...input, parameters: { quality: 'high' } }));
  assert.throws(() => effectiveParameters(model, { ...input, outputCount: 3 }));
  assert.throws(() =>
    modelDefinitionSchema.parse({
      ...model,
      parameters: [{ name: 'quality', label: '质量', type: 'integer', min: 0, max: 5 }],
    }),
  );
  assert.throws(() =>
    modelDefinitionSchema.parse({
      ...model,
      parameters: [{ name: 'background', label: '背景', type: 'enum', options: ['magenta'] }],
    }),
  );
});
test('providerTag 接受带区域的上游端点标签，quality 接受扩展档位', () => {
  const base = {
    id: 'model',
    name: 'Model',
    provider: 'openrouter',
    upstreamModel: 'google/gemini-3-pro-image',
    credentialRef: 'openrouter',
    capabilities: { maxReferences: 14, maxOutputs: 1 },
    parameters: [{ name: 'quality', label: '质量', type: 'enum', options: ['auto', 'xhigh', 'max'], default: 'auto' }],
  };
  assert.equal(
    modelDefinitionSchema.parse({ ...base, providerTag: 'google-ai-studio/global' }).providerTag,
    'google-ai-studio/global',
  );
  for (const providerTag of ['google-ai-studio/', '/global', 'a/b/c', 'google ai']) {
    assert.throws(() => modelDefinitionSchema.parse({ ...base, providerTag }));
  }
  assert.throws(() =>
    modelDefinitionSchema.parse({
      ...base,
      providerTag: 'openai',
      parameters: [{ name: 'quality', label: '质量', type: 'enum', options: ['ultra'] }],
    }),
  );
});
test('尺寸与比例/分辨率不能同时生效，默认值也受组合校验', () => {
  const model = modelDefinitionSchema.parse({
    id: 'sizes',
    name: '尺寸模型',
    provider: 'openrouter',
    upstreamModel: 'openai/gpt-image-1',
    credentialRef: 'openrouter',
    providerTag: 'openai',
    capabilities: { maxReferences: 0, maxOutputs: 1 },
    parameters: [
      { name: 'size', label: '尺寸', type: 'enum', options: ['1024x1024'] },
      { name: 'resolution', label: '分辨率', type: 'enum', options: ['1K'] },
      { name: 'aspect_ratio', label: '比例', type: 'enum', options: ['1:1'] },
    ],
  });
  const input = generationCreateSchema.parse({ authoredPrompt: 'draw', modelId: model.id });
  assert.deepEqual(effectiveParameters(model, { ...input, parameters: { size: '1024x1024' } }), { size: '1024x1024' });
  assert.throws(
    () => effectiveParameters(model, { ...input, parameters: { size: '1024x1024', resolution: '1K' } }),
    /size/,
  );
  assert.throws(
    () => effectiveParameters(model, { ...input, parameters: { size: '1024x1024', aspect_ratio: '1:1' } }),
    /size/,
  );
  assert.throws(() =>
    modelDefinitionSchema.parse({
      ...model,
      parameters: model.parameters.map((p) =>
        p.name === 'size' ? { ...p, default: '1024x1024' } : p.name === 'resolution' ? { ...p, default: '1K' } : p,
      ),
    }),
  );
});
