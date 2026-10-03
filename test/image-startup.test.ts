import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { serve } from '../src/application.ts';
import * as imageService from '../src/image/service.ts';
import { testConfigJsonc, writeTestConfig, writeTestKeyJar } from './helpers.ts';

const { getMe } = vi.hoisted(() => ({ getMe: vi.fn() }));
vi.mock('grammy', () => ({
  Bot: class {
    api = { getMe };
  },
}));

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-startup-'));
  // Stop at the first Telegram call after real local startup, before polling or sends.
  getMe.mockReset().mockRejectedValue(new Error('telegram-startup-boundary'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const imageConfig = {
  credentials: { openrouter: { jar: 'image-startup' } },
  models: [
    {
      id: 'startup-image',
      name: 'Startup Image',
      provider: 'openrouter',
      upstreamModel: 'openai/gpt-image-1',
      credentialRef: 'openrouter',
      providerTag: 'openai',
      capabilities: {
        imageInput: true,
        maxInputImages: 2,
        maxOutputs: 1,
        aspectRatios: ['auto', '1:1'],
        resolutionClasses: ['auto'],
      },
    },
  ],
};

async function writeConfig(image: unknown): Promise<string> {
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      (config as Record<string, unknown>).image = image;
    }),
  );
  return configPath;
}

test('serve loads persisted image configuration before Telegram startup and restores it on the next start', async () => {
  const configPath = await writeConfig(imageConfig);
  await writeTestKeyJar(directory, { 'image-startup': 'fixture-image-secret' });
  const create = vi.spyOn(imageService, 'createImageService');
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  for (let start = 0; start < 2; start += 1) {
    await expect(serve(configPath)).rejects.toThrow('telegram-startup-boundary');
    const created = create.mock.results[start];
    if (created?.type !== 'return') {
      throw new Error('Image service was not created');
    }
    expect(created.value.core.config.hasValidConfig()).toBe(true);
    expect(created.value.core.config.current().models.map((model) => model.id)).toEqual(['startup-image']);
    expect(created.value.core.config.current().credentials.openrouter).toBe('fixture-image-secret');
  }
  const events = log.mock.calls.map(([line]) => JSON.parse(String(line)));
  expect(events.filter((entry) => entry.event === 'image_service_started').map((entry) => entry.enabled)).toEqual([
    true,
    true,
  ]);
  expect(JSON.stringify(events)).not.toContain('fixture-image-secret');
  expect(getMe).toHaveBeenCalledTimes(2);
});

test.each([
  { name: 'absent', image: undefined },
  { name: 'invalid', image: { credentials: {}, models: 'invalid' } },
  { name: 'unresolved credential', image: imageConfig },
])(
  '$name image configuration leaves the optional capability disabled without blocking bot startup',
  async ({ image }) => {
    const configPath = await writeConfig(image);
    const create = vi.spyOn(imageService, 'createImageService');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(serve(configPath)).rejects.toThrow('telegram-startup-boundary');
    const created = create.mock.results[0];
    if (created?.type !== 'return') {
      throw new Error('Image service was not created');
    }
    expect(created.value.core.config.hasValidConfig()).toBe(false);
    const events = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events.find((entry) => entry.event === 'image_service_started')).toMatchObject({ enabled: false });
    if (image !== undefined) {
      expect(events.some((entry) => entry.event === 'config_warnings' || entry.event === 'image_service_warning')).toBe(
        true,
      );
    }
    expect(getMe).toHaveBeenCalledOnce();
  },
);
