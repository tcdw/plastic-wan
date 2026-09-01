import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import Type from 'typebox';
import type { Update } from 'grammy/types';
import sharp from 'sharp';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { previewContext } from '../src/platform/invocation-context.ts';
import type { MediaDownloader } from '../src/capabilities/media/media-download.ts';
import { MediaService } from '../src/capabilities/media/media.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import type { ModelRegistry } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

test('a fresh Agent publishes only through send and audits model usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: 'hello',
    },
  };
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }

  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  faux.setResponses([
    (context, options) => {
      // The faux provider never touches the network, so the snapshot hooks are
      // triggered manually to mirror what real adapters do.
      options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
      void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'published' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('private assistant text'),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry: ModelRegistry = { models, agentModel: model, visionModel: model };
  let messageId = 500;
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    config: loaded.config,
    secrets: new SecretStore(),
    registry,
    modelSwitcher: new AgentModelSwitcher(loaded.config, registry.models),
    telegramApi: api,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
  });
  const outcome = await runtime.run(invocationId, new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(
    store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM telegram_sends WHERE state = 'success'").get()
      ?.count,
  ).toBe(1n);
  expect(
    store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM messages WHERE sent_by_bot = 1').get()?.count,
  ).toBe(1n);
  const assistantTexts = store.db
    .query<{ text: string }, []>("SELECT text FROM agent_messages WHERE role = 'assistant' ORDER BY sequence_no")
    .all()
    .map((row) => row.text);
  expect(assistantTexts).toContain('private assistant text');
  expect(
    store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM model_calls WHERE state = 'success'").get()
      ?.count,
  ).toBe(2n);
  const presented = store.db
    .query<{ tools_json: string | null }, []>(
      "SELECT tools_json FROM model_calls WHERE role = 'agent' ORDER BY id LIMIT 1",
    )
    .get();
  expect(presented?.tools_json).toBe(JSON.stringify(['send']));
  const snapshot = store.db
    .query<{ request_json: string | null; response_json: string | null }, []>(
      "SELECT request_json, response_json FROM model_calls WHERE role = 'agent' AND request_json IS NOT NULL ORDER BY id LIMIT 1",
    )
    .get();
  expect(String(snapshot?.request_json)).toContain('"messages"');
  expect(snapshot?.response_json).toBe(JSON.stringify({ status: 200 }));
  const registryRow = store.db
    .query<{ tool_registry_json: string | null }, [bigint]>('SELECT tool_registry_json FROM invocations WHERE id = ?')
    .get(invocationId);
  expect(registryRow?.tool_registry_json).toContain('"name":"send"');
  expect(registryRow?.tool_registry_json).toContain('"label":"Send to Telegram"');
  expect(registryRow?.tool_registry_json).toContain('Publish exactly one warranted user-visible Telegram message');
  expect(
    store.db
      .query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM agent_messages WHERE role = 'harness_nudge'")
      .get()?.count,
  ).toBe(0n);
  store.close();
});

test('counts tool descriptions in registry limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-tool-budget-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const models = createModels();
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'tiny-context', input: ['text'], contextWindow: 1_000, maxTokens: 100 }],
  });
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry: ModelRegistry = { models, agentModel: model, visionModel: model };
  const runtime = new AgentRuntime({
    store,
    config: loaded.config,
    secrets: new SecretStore(),
    registry,
    modelSwitcher: new AgentModelSwitcher(loaded.config, registry.models),
    telegramApi: {
      sendMessage: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
  });
  const oversizedDescriptionTool: AgentTool = {
    name: 'large_description',
    label: 'Large description',
    description: 'x'.repeat(500),
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };

  expect(() => runtime.validateAdditionalTools(previewContext(), [oversizedDescriptionTool])).toThrow(
    'Tool registry exceeds 10%',
  );
  store.close();
});

test('audits complete redacted model error details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-error-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'trigger a model error',
      },
    },
    received,
  );
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }

  const errorDetail = 'Provider request failed with telegram-secret\nstatus=500\nbody={"error":"upstream exploded"}';
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: errorDetail })]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry: ModelRegistry = { models, agentModel: model, visionModel: model };
  const secrets = new SecretStore();
  await secrets.resolve(loaded.config.telegram.token);
  const runtime = new AgentRuntime({
    store,
    config: loaded.config,
    secrets,
    registry,
    modelSwitcher: new AgentModelSwitcher(loaded.config, registry.models),
    telegramApi: {
      sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
  });

  expect(await runtime.run(invocationId, new AbortController().signal)).toEqual({
    state: 'failed',
    reason: 'model_error',
  });
  expect(
    store.db
      .query<{ state: string; error_code: string | null; error_detail: string | null }, []>(
        'SELECT state, error_code, error_detail FROM model_calls',
      )
      .get(),
  ).toEqual({
    state: 'error',
    error_code: 'model_error',
    error_detail: errorDetail.replace('telegram-secret', '[REDACTED]'),
  });
  store.close();
});

test('passes Telegram photos directly to the multimodal agent and keeps stickers tool-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-image-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({
    create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  const update: Update = {
    update_id: 2,
    message: {
      message_id: 20,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      photo: [
        { file_id: 'photo-small', file_unique_id: 'photo-small-unique', width: 8, height: 4, file_size: 50 },
        { file_id: 'photo-large', file_unique_id: 'photo-large-unique', width: 16, height: 8, file_size: 100 },
      ],
      sticker: {
        file_id: 'sticker-file',
        file_unique_id: 'sticker-unique',
        width: 64,
        height: 64,
        is_animated: false,
        is_video: false,
        type: 'regular',
      },
    },
  };
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }

  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const inlineImageBytes = Buffer.from('provider inline image bytes');
  const inlineImageDataUrl = `data:image/jpeg;base64,${inlineImageBytes.toString('base64')}`;
  faux.setResponses([
    (context, options) => {
      const providerPayload = {
        model: 'agent-model',
        messages: [{ content: [{ type: 'image_url', image_url: { url: inlineImageDataUrl } }] }],
      };
      options?.onPayload?.(providerPayload, faux.getModel());
      expect(providerPayload.messages[0]?.content[0]?.image_url.url).toBe(inlineImageDataUrl);
      const user = context.messages[0];
      expect(user?.role).toBe('user');
      if (user?.role !== 'user' || typeof user.content === 'string') {
        throw new Error('Expected multimodal user content');
      }
      const images = user.content.filter((entry) => entry.type === 'image');
      expect(images).toHaveLength(1);
      expect(images[0]?.mimeType).toBe('image/jpeg');
      expect(user.content[0]).toMatchObject({ type: 'text' });
      expect(user.content).toContainEqual({ type: 'text', text: expect.stringContaining('"image_ref":"figure_1"') });
      return fauxAssistantMessage('saw the photo');
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry: ModelRegistry = { models, agentModel: model, visionModel: model };
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      expect(fileId).toBe('photo-large');
      await Bun.write(destination, Bun.file(fixturePath));
    },
  };
  const media = new MediaService({
    store,
    config: loaded.config,
    secrets: new SecretStore(),
    registry,
    mediaClient: downloader,
    modelGate: new KeyedSemaphore(),
  });
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: 502, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    config: loaded.config,
    secrets: new SecretStore(),
    registry,
    modelSwitcher: new AgentModelSwitcher(loaded.config, registry.models),
    telegramApi: api,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    directImageLoader: (context, signal) => media.loadDirectImages(context.directImages, signal),
  });
  const outcome = await runtime.run(invocationId, new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM media').get()?.count).toBe(2n);
  expect(
    store.db
      .query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'read_image'")
      .get()?.count,
  ).toBe(0n);
  expect(
    store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM model_calls WHERE role = 'vision_chat'").get()
      ?.count,
  ).toBe(0n);
  const requestJson = store.db
    .query<{ request_json: string | null }, []>(
      "SELECT request_json FROM model_calls WHERE role = 'agent' AND request_json IS NOT NULL ORDER BY id LIMIT 1",
    )
    .get()?.request_json;
  expect(requestJson).not.toContain(inlineImageDataUrl);
  expect(requestJson === null || requestJson === undefined ? null : JSON.parse(requestJson)).toMatchObject({
    messages: [
      {
        content: [
          {
            image_url: {
              url: {
                __plasticwan_audit_omission__: 'base64_image',
                mime_type: 'image/jpeg',
                encoded_characters: inlineImageBytes.toString('base64').length,
                decoded_bytes: inlineImageBytes.byteLength,
                sha256: createHash('sha256').update(inlineImageBytes).digest('hex'),
              },
            },
          },
        ],
      },
    ],
  });
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  store.close();
});
test('lets a text-only agent read a Telegram photo through read_image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-fallback-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom' || provider.models[0] === undefined) {
      throw new Error('Expected custom agent provider fixture');
    }
    provider.models[0].input = ['text'];
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 3,
      message: {
        message_id: 30,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        photo: [{ file_id: 'photo-file', file_unique_id: 'photo-unique', width: 16, height: 8, file_size: 100 }],
      },
    },
    received,
  );
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }

  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  let photoRef: string | undefined;
  agentFaux.setResponses([
    (context) => {
      const content = context.messages[0]?.content;
      if (typeof content !== 'string') {
        const text = content?.find((entry) => entry.type === 'text')?.text ?? '';
        const match = /"image_ref":"([^"]+)"/.exec(text);
        photoRef = match?.[1];
      }
      if (photoRef === undefined) {
        throw new Error('Text-only agent context omitted image_ref');
      }
      return fauxAssistantMessage(fauxToolCall('read_image', { image_ref: photoRef }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('understood'),
  ]);
  const visionFaux = fauxProvider({
    provider: 'vision',
    models: [{ id: 'vision-model', input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 }],
  });
  visionFaux.setResponses([fauxAssistantMessage('A dark rectangle.')]);
  const models = createModels();
  models.setProvider(agentFaux.provider);
  models.setProvider(visionFaux.provider);
  const agentModel = agentFaux.getModel();
  const visionModel = visionFaux.getModel();
  const registry: ModelRegistry = { models, agentModel, visionModel };
  const media = new MediaService({
    store,
    config: loaded.config,
    secrets: new SecretStore(),
    registry,
    mediaClient: {
      download: async (fileId, destination, signal) => {
        signal.throwIfAborted();
        expect(fileId).toBe('photo-file');
        await Bun.write(destination, Bun.file(fixturePath));
      },
    },
    modelGate: new KeyedSemaphore(),
  });
  const runtime = new AgentRuntime({
    store,
    config: loaded.config,
    secrets: new SecretStore(),
    registry,
    modelSwitcher: new AgentModelSwitcher(loaded.config, registry.models),
    telegramApi: {
      sendMessage: async () => ({ message_id: 601, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 602, date: 1_700_000_100, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    additionalTools: (context, _state, deadline) => [media.createReadImageTool(context, deadline)],
  });
  const outcome = await runtime.run(invocationId, new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(agentFaux.state.callCount).toBe(2);
  expect(visionFaux.state.callCount).toBe(1);
  expect(
    store.db
      .query<{ count: bigint }, []>(
        "SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'read_image' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  expect(
    store.db
      .query<{ count: bigint }, []>(
        "SELECT COUNT(*) AS count FROM model_calls WHERE role = 'vision_chat' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  const presented = store.db
    .query<{ tools_json: string | null }, []>(
      "SELECT tools_json FROM model_calls WHERE role = 'agent' ORDER BY id LIMIT 1",
    )
    .get();
  const toolsJson = presented?.tools_json ?? null;
  expect(toolsJson === null ? null : JSON.parse(toolsJson)).toEqual(['send', 'read_image']);
  store.close();
});

test('nudges the model once to use send when it drafts a private reply and never re-nudges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-agent-nudge-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: 'hello',
    },
  };
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }

  // Turn 1: a would-be reply drafted as private assistant text, no send call.
  // Turn 2: after the nudge, the model still forgets send — proving no re-nudge.
  let sawNudge = false;
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  faux.setResponses([
    fauxAssistantMessage('this is a long private reply that the model forgot to send via the send tool'),
    (context) => {
      const lastUser = [...context.messages].reverse().find((message) => message.role === 'user');
      const content = lastUser?.content;
      const nudgeText = Array.isArray(content) ? (content.find((block) => block.type === 'text')?.text ?? '') : '';
      if (nudgeText.includes('call the send tool')) {
        sawNudge = true;
      }
      return fauxAssistantMessage('another long private reply that still forgets to call send');
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry: ModelRegistry = { models, agentModel: model, visionModel: model };
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    config: loaded.config,
    secrets: new SecretStore(),
    registry,
    modelSwitcher: new AgentModelSwitcher(loaded.config, registry.models),
    telegramApi: api,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
  });
  const outcome = await runtime.run(invocationId, new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(sawNudge).toBe(true);
  expect(
    store.db
      .query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM agent_messages WHERE role = 'harness_nudge'")
      .get()?.count,
  ).toBe(1n);
  expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM telegram_sends').get()?.count).toBe(0n);
  expect(faux.state.callCount).toBe(2);
  store.close();
});
