import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  adminActor,
  createTestCore,
  fakeProvider,
  keyActor,
  parseInput,
  pngBytes,
  publishDefaultConfig,
  PROVIDER_KEY,
  waitFor,
} from './helpers.ts';
import { fingerprintOf, assertIdempotencyKey } from '../src/generations.ts';
import { listSchema } from '../src/contracts.ts';
import type { Generation, GenerationInput } from '../src/contracts.ts';

const baseInput = parseInput({ authoredPrompt: '一只猫', modelId: 'gpt-image-1' });

async function waitForGeneration(run: Awaited<ReturnType<typeof createTestCore>>, id: string): Promise<Generation> {
  return waitFor(() => {
    const row = run.core.generations.getRow(id);
    if (row === null) {
      return null;
    }
    if (row.status === 'queued' || row.status === 'running') {
      return null;
    }
    return run.core.generations.get(id, adminActor);
  });
}

test('resolve expands prompt references in place and orders images by first appearance', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const style = run.core.prompts.create({ name: '风格', body: '水彩画风，柔和', description: '', category: '' });
    const hero = run.core.prompts.create({ name: '主角', body: '短发女孩', description: '', category: '' });
    const imageA = await run.core.images.create({
      name: 'A',
      base64: (await pngBytes({ width: 5, height: 5 })).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    const imageB = await run.core.images.create({
      name: 'B',
      base64: (await pngBytes({ width: 6, height: 6 })).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });

    const authored = `{{prompt:${style.id}}}| {{prompt:${hero.id}}}| {{image:${imageB.id}}} 中间文字 {{image:${imageA.id}}} 再次 {{image:${imageB.id}}} 结束`;
    const snapshot = run.core.generations.resolve(
      parseInput({ authoredPrompt: authored, modelId: 'gpt-image-1', parameters: { quality: 'high' }, outputCount: 2 }),
    );

    assert.equal(snapshot.resolvedPrompt, '水彩画风，柔和| 短发女孩|  中间文字  再次  结束');
    assert.equal(snapshot.finalPrompt, snapshot.resolvedPrompt);
    assert.deepEqual(
      snapshot.promptAssets.map((asset) => asset.name),
      ['风格', '主角'],
    );
    assert.deepEqual(
      snapshot.imageAssets.map((asset) => asset.id),
      [imageB.id, imageA.id],
    );
    assert.deepEqual(snapshot.effectiveParameters, { aspect_ratio: '1:1', quality: 'high', background: 'auto' });
    assert.deepEqual(snapshot.requestSemantics, {
      adapterVersion: 1,
      calls: 2,
      imagesPerCall: 1,
      appendedInstructions: [],
    });
    assert.equal(snapshot.configVersion.length, 32);
    assert.equal(provider.calls.length, 0, 'resolve 不产生上游调用');
  } finally {
    await run.cleanup();
  }
});

test('resolve rejects dangling, malformed, empty and over-limit inputs', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const missing = '00000000-0000-4000-8000-000000000000';
    const cases: [GenerationInput, string][] = [
      [parseInput({ authoredPrompt: `只有图片 {{image:${missing}}}`, modelId: 'gpt-image-1' }), 'missing_reference'],
      [parseInput({ authoredPrompt: '损坏 {{prompt:not-a-uuid}}', modelId: 'gpt-image-1' }), 'malformed_reference'],
      [parseInput({ authoredPrompt: '坏括号 {{ 结尾', modelId: 'gpt-image-1' }), 'malformed_reference'],
    ];
    for (const [input, code] of cases) {
      assert.throws(
        () => run.core.generations.resolve(input),
        (error: { code?: string }) => error.code === code,
        JSON.stringify(input),
      );
    }

    // Unknown model and unsupported parameters.
    assert.throws(
      () => run.core.generations.resolve({ authoredPrompt: 'hi', modelId: 'nope', parameters: {}, outputCount: 1 }),
      (error: { code?: string }) => error.code === 'unknown_model',
    );
    assert.throws(
      () =>
        run.core.generations.resolve({
          authoredPrompt: 'hi',
          modelId: 'gpt-image-1',
          parameters: { seed: 1 },
          outputCount: 1,
        }),
      (error: { code?: string }) => error.code === 'invalid_parameters',
    );

    // More references than the model allows (maxReferences: 2).
    const imageA = await run.core.images.create({
      name: 'A',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    const imageB = await run.core.images.create({
      name: 'B',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    const imageC = await run.core.images.create({
      name: 'C',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    assert.throws(
      () =>
        run.core.generations.resolve({
          authoredPrompt: `{{image:${imageA.id}}} {{image:${imageB.id}}} {{image:${imageC.id}}}`,
          modelId: 'gpt-image-1',
          parameters: {},
          outputCount: 1,
        }),
      (error: { code?: string }) => error.code === 'too_many_references',
    );
    assert.equal(provider.calls.length, 0);
  } finally {
    await run.cleanup();
  }
});

test('resolve reports empty prompts after removing image tokens', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const image = await run.core.images.create({
      name: 'A',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    assert.throws(
      () =>
        run.core.generations.resolve({
          authoredPrompt: `{{image:${image.id}}}`,
          modelId: 'gpt-image-1',
          parameters: {},
          outputCount: 1,
        }),
      (error: { code?: string }) => error.code === 'empty_prompt',
    );
  } finally {
    await run.cleanup();
  }
});

test('create persists a frozen snapshot, calls the image API once per item and stores outputs', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const style = run.core.prompts.create({ name: '风格', body: '水彩画风', description: '', category: '' });
    const reference = await run.core.images.create({
      name: '参考',
      base64: (await pngBytes({ width: 8, height: 9 })).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });

    const created = run.core.generations.create(
      {
        authoredPrompt: `{{prompt:${style.id}}} 一只猫 {{image:${reference.id}}}`,
        modelId: 'gpt-image-1',
        parameters: { quality: 'high', background: 'auto' },
        outputCount: 2,
      },
      adminActor,
      'key-1',
    );
    assert.equal(created.generation.status, 'queued');
    assert.equal(created.generation.source, 'admin');
    assert.equal(created.generation.actorName, 'admin');
    assert.equal(
      created.generation.snapshot.authored.authoredPrompt,
      `{{prompt:${style.id}}} 一只猫 {{image:${reference.id}}}`,
    );
    assert.equal(created.generation.snapshot.resolvedPrompt, '水彩画风 一只猫 ');
    assert.equal(created.generation.snapshot.configVersion, run.core.config.current().version);
    assert.equal(created.generation.snapshot.model.credentialRef, 'openrouter');

    const finished = await waitForGeneration(run, created.generation.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.attempts.length, 2);
    assert.equal(finished.outputs.length, 2);
    assert.equal(provider.calls.length, 2, '每个输出一次调用（n:1）');

    for (const call of provider.calls) {
      assert.equal(call.url, 'https://openrouter.ai/api/v1/images');
      assert.equal(call.headers.authorization, `Bearer ${PROVIDER_KEY}`);
      assert.equal(call.headers['content-type'], 'application/json');
      assert.equal(call.body.model, 'openai/gpt-image-1');
      assert.equal(call.body.n, 1);
      assert.deepEqual(call.body.provider, { only: ['openai'], allow_fallbacks: false });
      assert.equal(call.body.prompt, '水彩画风 一只猫 ');
      assert.equal(call.body.quality, 'high');
      assert.equal(call.body.background, 'auto');
      assert.equal(call.body.aspect_ratio, '1:1');
      const references = call.body.input_references as { type: string; image_url: { url: string } }[];
      assert.equal(references.length, 1);
      assert.equal(references[0]?.type, 'image_url');
      assert.equal(
        references[0]?.image_url.url,
        `data:image/png;base64,${(await pngBytes({ width: 8, height: 9 })).toString('base64')}`,
      );
    }

    const output = finished.outputs[0];
    assert.ok(output !== undefined);
    assert.equal(output.source, 'generation');
    assert.equal(output.generationId, finished.id);
    assert.equal(output.outputIndex, 0);
    assert.equal(output.mime, 'image/png');

    const attempt = finished.attempts.find((entry) => entry.itemIndex === 0);
    assert.ok(attempt !== undefined);
    assert.equal(attempt.status, 'succeeded');
    assert.match(String(attempt.providerRequestId), /^req-[12]$/);
    assert.deepEqual(attempt.usage, { total_tokens: 42, cost: 0.01 });
    assert.equal(attempt.outputAssetId, output.id);
    assert.equal(attempt.error, null);

    // The output image is a first-class asset usable as the next reference.
    const next = run.core.generations.resolve(
      parseInput({ authoredPrompt: `再次 {{image:${output.id}}}`, modelId: 'gpt-image-1' }),
    );
    assert.equal(next.imageAssets[0]?.id, output.id);
  } finally {
    await run.cleanup();
  }
});

test('idempotency replays the original task and rejects the same key with different input', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const first = run.core.generations.create(baseInput, adminActor, 'same-key');
    const second = run.core.generations.create(baseInput, adminActor, 'same-key');
    assert.equal(second.generation.id, first.generation.id);
    assert.equal(second.replayed, true);

    assert.throws(
      () => run.core.generations.create({ ...baseInput, authoredPrompt: '另一只猫' }, adminActor, 'same-key'),
      (error: { code?: string }) => error.code === 'idempotency_conflict',
    );

    assert.throws(
      () => run.core.generations.create(baseInput, adminActor, assertIdempotencyKey(undefined)),
      (error: { code?: string }) => error.code === 'idempotency_key_required',
    );
    assert.throws(
      () => run.core.generations.create(baseInput, adminActor, assertIdempotencyKey('has space and is invalid')),
      (error: { code?: string }) => error.code === 'idempotency_key_required',
    );

    await waitForGeneration(run, first.generation.id);
    assert.equal(provider.calls.length, 1, '重复提交不产生第二次上游调用');
  } finally {
    await run.cleanup();
  }
});

test('idempotency keys follow the shared safe-character schema on create and retry', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const safeKey = 'A.b_c-1:'.padEnd(128, 'x');
    assert.equal(safeKey.length, 128);
    assert.equal(assertIdempotencyKey(safeKey), safeKey, '安全字符与 128 位上限必须被接受');

    for (const key of ['has space', 'has/slash', 'bang!', 'x'.repeat(129), '']) {
      assert.throws(
        () => {
          assertIdempotencyKey(key);
        },
        `key=${JSON.stringify(key)}`,
      );
    }

    const created = run.core.generations.create(
      { authoredPrompt: '安全幂等键', modelId: 'gpt-image-1', parameters: {}, outputCount: 1 },
      adminActor,
      safeKey,
    );
    await waitForGeneration(run, created.generation.id);
    assert.throws(
      () => assertIdempotencyKey('has space'),
      (error: { code?: string }) => error.code === 'idempotency_key_required',
      'retry 与 create 共用同一个幂等键契约',
    );
    assert.equal(provider.calls.length, 1, '被拒绝的幂等键不产生上游调用');
  } finally {
    await run.cleanup();
  }
});

test('editing or archiving an asset never rewrites accepted snapshots', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const prompt = run.core.prompts.create({ name: '风格', body: '旧正文', description: '', category: '' });
    const image = await run.core.images.create({
      name: '图',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });

    const created = run.core.generations.create(
      {
        authoredPrompt: `{{prompt:${prompt.id}}} {{image:${image.id}}}`,
        modelId: 'gpt-image-1',
        parameters: {},
        outputCount: 1,
      },
      adminActor,
      'snapshot-key',
    );
    const id = created.generation.id;
    const firstRound = await waitForGeneration(run, id);

    run.core.prompts.update(prompt.id, { body: '新正文' });
    run.core.images.remove(image.id);

    const generation = run.core.generations.get(id, adminActor);
    assert.equal(generation.snapshot.promptAssets[0]?.body, '旧正文');
    assert.equal(generation.snapshot.resolvedPrompt, '旧正文 ');
    assert.equal(generation.snapshot.imageAssets[0]?.id, image.id);
    assert.equal(provider.calls[0]?.body.prompt, '旧正文 ');

    // New submissions referencing the archived image fail loudly.
    assert.throws(
      () =>
        run.core.generations.create(
          { authoredPrompt: `再用 {{image:${image.id}}}`, modelId: 'gpt-image-1', parameters: {}, outputCount: 1 },
          adminActor,
          'archived-ref',
        ),
      (error: { code?: string }) => error.code === 'missing_reference',
    );

    // Retrying the original snapshot still works and uses the frozen input.
    const retry = run.core.generations.retry(id, adminActor, 'retry-1');
    assert.equal(retry.replayed, false);
    const retried = await waitForGeneration(run, id);
    assert.equal(retried.round, 2);
    assert.equal(retried.attempts.length, 2, '重试追加尝试而不是覆盖');
    assert.deepEqual([...new Set(retried.attempts.map((attempt) => attempt.round))].sort(), [1, 2]);
    assert.equal(provider.calls.length, 2, '重试会新增一次上游调用');
    assert.equal(provider.calls[1]?.body.prompt, '旧正文 ');
    assert.ok(!retried.attempts.some((attempt) => attempt.round === 1 && attempt.status !== 'succeeded'));
    assert.equal(firstRound.status, 'succeeded');
  } finally {
    await run.cleanup();
  }
});

test('retry is rejected while running and replays with the same idempotency key', async () => {
  let gateResolve!: () => void;
  const gate = new Promise<void>((resolve) => {
    gateResolve = resolve;
  });
  const provider = fakeProvider({
    respond: async () => {
      await gate;
      return new Response(
        JSON.stringify({ data: [{ b64_json: (await pngBytes()).toString('base64'), media_type: 'image/png' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const created = run.core.generations.create(
      { authoredPrompt: '慢任务', modelId: 'gpt-image-1', parameters: {}, outputCount: 1 },
      adminActor,
      'gating',
    );
    const id = created.generation.id;
    await waitFor(() => (run.core.generations.getRow(id)?.status === 'running' ? true : null));

    assert.throws(
      () => run.core.generations.retry(id, adminActor, 'retry-while-running'),
      (error: { code?: string }) => error.code === 'generation_running',
    );

    gateResolve();
    await waitForGeneration(run, id);

    const retry = run.core.generations.retry(id, adminActor, 'retry-replay');
    const replay = run.core.generations.retry(id, adminActor, 'retry-replay');
    assert.equal(replay.generation.round, retry.generation.round);
    assert.equal(replay.replayed, true);
    const finished = await waitForGeneration(run, id);
    assert.equal(finished.round, 2);
    assert.equal(provider.calls.length, 2, '重放不产生额外调用');
  } finally {
    await run.cleanup();
  }
});

test('list, detail and scoping keep generations readable per actor', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const mine = run.core.generations.create(
      { authoredPrompt: '管理员的猫', modelId: 'gpt-image-1', parameters: {}, outputCount: 1 },
      adminActor,
      'admin-task',
    );
    const theirs = run.core.generations.create(
      { authoredPrompt: '客户端的猫', modelId: 'gpt-image-1', parameters: {}, outputCount: 1 },
      keyActor,
      'agent-task',
    );
    assert.equal(theirs.generation.source, 'http');
    assert.equal(theirs.generation.actorName, 'agent');

    const adminList = run.core.generations.list(listSchema.parse({}), adminActor);
    assert.equal(adminList.total, 2);
    const agentList = run.core.generations.list(listSchema.parse({}), keyActor);
    assert.equal(agentList.total, 1);
    assert.equal(agentList.items[0]?.id, theirs.generation.id);

    assert.throws(
      () => run.core.generations.get(mine.generation.id, keyActor),
      (error: { code?: string }) => error.code === 'not_found',
      '受限 actor 不能看到他人的任务',
    );

    await waitForGeneration(run, theirs.generation.id);
    await waitForGeneration(run, mine.generation.id);
  } finally {
    await run.cleanup();
  }
});

test('fingerprintOf sorts object keys recursively and keeps array order', () => {
  const left = {
    actorId: 'a',
    operation: 'generation:create',
    input: {
      authoredPrompt: 'cat',
      modelId: 'gpt-image-1',
      parameters: { quality: 'high', background: 'auto' },
      outputCount: 1,
    },
  };
  const right = {
    input: {
      outputCount: 1,
      parameters: { background: 'auto', quality: 'high' },
      modelId: 'gpt-image-1',
      authoredPrompt: 'cat',
    },
    operation: 'generation:create',
    actorId: 'a',
  };
  assert.equal(fingerprintOf(left), fingerprintOf(right));
  assert.notEqual(
    fingerprintOf({ parameters: { quality: 'high' } }),
    fingerprintOf({ parameters: { quality: 'low' } }),
  );
  assert.notEqual(fingerprintOf({ tags: ['a', 'b'] }), fingerprintOf({ tags: ['b', 'a'] }));
  assert.equal(
    fingerprintOf({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }),
    fingerprintOf({ b: { c: [1, { e: 3, d: 2 }] }, a: 1 }),
  );
});

test('idempotent replay survives archived references and a removed model', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const prompt = run.core.prompts.create({ name: '风格', body: '旧正文', description: '', category: '' });
    const image = await run.core.images.create({
      name: '参考',
      base64: (await pngBytes()).toString('base64'),
      mime: 'image/png',
      description: '',
      category: '',
      source: 'upload',
    });
    const input: GenerationInput = {
      authoredPrompt: `{{prompt:${prompt.id}}} {{image:${image.id}}}`,
      modelId: 'gpt-image-1',
      parameters: { quality: 'high', background: 'auto' },
      outputCount: 1,
    };
    const first = run.core.generations.create(input, adminActor, 'archive-replay');
    const id = first.generation.id;
    const finished = await waitForGeneration(run, id);
    assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));
    const callsAfterFirst = provider.calls.length;

    // Archive both referenced assets and remove the model from the active config.
    run.core.prompts.remove(prompt.id);
    run.core.images.remove(image.id);
    const { createImageConfigSnapshot } = await import('../src/config.ts');
    run.config.updateConfig(createImageConfigSnapshot({ version: 'v2', models: [], credentials: {} }));
    assert.equal(run.core.config.model('gpt-image-1'), null);

    // A fresh request is still resolved against current state and fails loudly.
    assert.throws(
      () => run.core.generations.create(input, adminActor, 'archive-fresh'),
      (error: { code?: string }) => error.code === 'unknown_model',
    );

    // The accepted request replays as-is: same id, original snapshot, no new call.
    const replay = run.core.generations.create(input, adminActor, 'archive-replay');
    assert.equal(replay.generation.id, id);
    assert.equal(replay.generation.snapshot.model.id, 'gpt-image-1');
    assert.equal(replay.generation.snapshot.resolvedPrompt, finished.snapshot.resolvedPrompt);
    assert.equal(provider.calls.length, callsAfterFirst);
  } finally {
    await run.cleanup();
  }
});

test('parameter key order does not change the create fingerprint', async () => {
  const provider = fakeProvider();
  const run = await createTestCore({ providerFetch: provider.fetchImpl });
  try {
    publishDefaultConfig(run.config);
    const payload: GenerationInput = {
      authoredPrompt: '一只猫',
      modelId: 'gpt-image-1',
      parameters: { quality: 'high', background: 'auto' },
      outputCount: 1,
    };
    const first = run.core.generations.create(payload, adminActor, 'parameter-order');
    const finished = await waitForGeneration(run, first.generation.id);

    const reordered = run.core.generations.create(
      { ...payload, parameters: { background: 'auto', quality: 'high' } },
      adminActor,
      'parameter-order',
    );
    assert.equal(reordered.replayed, true, '同语义不同键序必须重放原任务');
    assert.equal(reordered.generation.id, first.generation.id);
    assert.deepEqual(reordered.generation.snapshot.effectiveParameters, finished.snapshot.effectiveParameters);

    assert.throws(
      () =>
        run.core.generations.create(
          { ...payload, parameters: { quality: 'low', background: 'auto' } },
          adminActor,
          'parameter-order',
        ),
      (error: { code?: string }) => error.code === 'idempotency_conflict',
    );
    assert.equal(provider.calls.length, 1, '重放与冲突都不产生新的上游调用');
  } finally {
    await run.cleanup();
  }
});
