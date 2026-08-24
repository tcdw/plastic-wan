import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import sharp from 'sharp';
import { KeyedSemaphore } from '../src/concurrency.ts';
import { loadConfig } from '../src/config.ts';
import { ContextBuilder } from '../src/context-builder.ts';
import { SqliteStore } from '../src/database.ts';
import { createLottieCommand, type MediaDownloader, MediaService } from '../src/media.ts';
import type { ModelRegistry } from '../src/providers.ts';
import { SecretStore } from '../src/secrets.ts';
import { BucketScheduler } from '../src/scheduler.ts';
import { TelegramIngestion } from '../src/telegram-ingestion.ts';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

test('builds an executable Lottie command for the host platform', () => {
  const command = createLottieCommand(['input.tgs', 'output.png']);
  expect(command.slice(-2)).toEqual(['input.tgs', 'output.png']);
  if (process.platform === 'win32') {
    expect(command.slice(0, 2)).toEqual(['python', '-c']);
  } else {
    expect(command[0]).toBe('lottie_convert.py');
  }
});

test('read_image normalizes once and reuses the 30-day description cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 32, height: 16, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      photo: [
        {
          file_id: 'file-id',
          file_unique_id: 'unique-id',
          width: 32,
          height: 16,
          file_size: 100,
        },
      ],
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
  const context = new ContextBuilder(store, loaded.config).build(invocationId, 200_000, 0, 32768);
  const [imageRef] = context.imageCapabilities.keys();
  if (imageRef === undefined) {
    throw new Error('Expected an image capability');
  }
  expect(context.directImages).toEqual([]);

  const faux = fauxProvider({
    provider: 'vision',
    models: [
      { id: 'vision-model', reasoning: true, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 },
    ],
  });
  let visionReasoning: string | undefined;
  faux.setResponses([
    (_context, options) => {
      visionReasoning = options?.reasoning;
      return fauxAssistantMessage('A translucent red rectangle.');
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry: ModelRegistry = { models, agentModel: model, visionModel: model };
  let downloads = 0;
  const downloader: MediaDownloader = {
    download: async (_fileId, destination, signal) => {
      signal.throwIfAborted();
      downloads += 1;
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
  const tool = media.createReadImageTool(context, Date.now() + 60_000);
  const first = await tool.execute('read-1', { image_ref: imageRef });
  const second = await tool.execute('read-2', { image_ref: imageRef });
  expect(first.content).toEqual([{ type: 'text', text: 'A translucent red rectangle.' }]);
  expect(second.details.cached).toBe(true);
  expect(downloads).toBe(1);
  expect(faux.state.callCount).toBe(1);
  expect(visionReasoning).toBe('low');
  expect(
    store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM media_analyses WHERE state = 'success'").get()
      ?.count,
  ).toBe(1n);
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  store.close();
});
