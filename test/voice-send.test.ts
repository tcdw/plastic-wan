import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createSendTool, type SendToolEnvironment, type TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { loadConfig } from '../src/platform/config.ts';
import type { InvocationContext } from '../src/platform/invocation-context.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import {
  buckets,
  chats,
  conversations,
  invocations,
  messageRevisions,
  telegramSends,
  toolCalls,
} from '../src/store/schema.ts';
import { FishAudioTtsError, fishAudioSynthesizer, type VoiceSynthesizer } from '../src/voice/fish-tts.ts';
import { testConfigJsonc, writeTestConfig, writeTestKeyJar } from './helpers.ts';

// send kind:voice synthesizes the text with Fish Audio and delivers one MP3
// audio message in the same call, captioned with its transcript.

const REFERENCE_ID = '0123456789abcdef0123456789abcdef';
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

const cleanup: Array<() => void | Promise<void>> = [];
let directory: string;
let configPath: string;
let store: SqliteStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-voice-send-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.voice = { api_key: { jar: 'fish_audio' }, reference_id: REFERENCE_ID, model: 's2.1-pro' };
    }),
  );
  await writeTestKeyJar(directory, { fish_audio: 'fish-key-v1' });
  const loaded = await loadConfig(configPath);
  store = await SqliteStore.open(loaded.config);
  cleanup.push(() => store.close());
  const now = new Date().toISOString();
  store.orm
    .insert(chats)
    .values({ id: 100n, telegramChatId: 100n, canonicalChatId: 100n, type: 'private', updatedAt: now })
    .run();
  store.orm.insert(conversations).values({ id: 42n, chatId: 100n, createdAt: now, updatedAt: now }).run();
  store.orm
    .insert(buckets)
    .values({
      id: 1n,
      conversationId: 42n,
      state: 'completed',
      kind: 'realtime',
      firstReceivedAt: now,
      deadlineAt: now,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: now,
    })
    .run();
  store.orm
    .insert(invocations)
    .values({
      id: 7n,
      bucketId: 1n,
      conversationId: 42n,
      state: 'running',
      configHash: 'test',
      promptVersion: 1n,
      createdAt: now,
      startedAt: now,
    })
    .run();
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

type SentAudio = { chatId: string; bytes: number[]; fileName: string; caption: string | undefined };

function audioApi(sent: SentAudio[]): TelegramSendApi {
  return {
    sendMessage: async () => ({ message_id: 1, date: 0, chat: { id: 100 } }),
    sendSticker: async () => ({ message_id: 2, date: 0, chat: { id: 100 } }),
    sendGeneratedAudio: async (chatId, bytes, fileName, options) => {
      sent.push({ chatId, bytes: Array.from(bytes), fileName, caption: options.caption });
      return { message_id: 600, date: 0, chat: { id: 100 } };
    },
  };
}

function sendTool(api: TelegramSendApi, overrides: Partial<SendToolEnvironment> = {}) {
  const context = {
    invocationId: 7n,
    conversationId: 42n,
    chatId: 100n,
    threadId: 0n,
    systemPrompt: '',
    userPrompt: '',
    directImages: [],
    visibleSenders: new Map(),
    callerUserId: 1n,
    completion: null,
    omittedNewMessages: 0,
  } as unknown as InvocationContext;
  return createSendTool({
    store,
    api,
    context,
    capabilities: {
      resolveMedia: () => undefined,
      resolveStickerRef: () => undefined,
      resolveReplyTarget: () => undefined,
      registerStickerRef: () => 'stk_x',
    },
    sendRateLimit: { sendsPerWindow: 10, windowSeconds: 60 },
    maxTextLength: 4096,
    disallowBlankLines: false,
    deadline: Date.now() + 60_000,
    bot: { id: 777n, displayName: 'bot', username: 'bot' },
    ...overrides,
  });
}

function rejectedCodes(): (string | null)[] {
  return store.orm
    .select({ errorCode: toolCalls.errorCode })
    .from(toolCalls)
    .all()
    .map((row) => row.errorCode);
}

test('send kind:voice synthesizes the text and delivers one MP3 captioned with its transcript', async () => {
  const spoken: string[] = [];
  const synthesize: VoiceSynthesizer = async (text) => {
    spoken.push(text);
    return MP3;
  };
  const sent: SentAudio[] = [];
  const result = await sendTool(audioApi(sent), { voice: { synthesize } }).execute?.('call-voice', {
    kind: 'voice',
    text: '晚上好，今天辛苦了',
  });

  expect(result?.details.telegramMessageId).toBe('600');
  expect(spoken).toEqual(['晚上好，今天辛苦了']);
  expect(sent).toEqual([
    { chatId: '100', bytes: Array.from(MP3), fileName: 'voice-reply.mp3', caption: '🎙️ 晚上好，今天辛苦了' },
  ]);
  expect(store.orm.select().from(telegramSends).get()).toMatchObject({
    kind: 'voice',
    state: 'success',
    telegramMessageId: 600n,
  });
  // Canonical history keeps the transcript, so later rounds know what was said.
  expect(store.orm.select().from(messageRevisions).get()).toMatchObject({
    kind: 'voice',
    text: null,
    caption: '🎙️ 晚上好，今天辛苦了',
  });
});

test('a failed synthesis sends nothing and reports a safe error code', async () => {
  const sent: SentAudio[] = [];
  const synthesize: VoiceSynthesizer = async () => {
    throw new FishAudioTtsError('http_error');
  };
  await expect(
    sendTool(audioApi(sent), { voice: { synthesize } }).execute?.('call-voice', { kind: 'voice', text: 'hello' }),
  ).rejects.toThrow('Voice synthesis failed (voice_http_error); nothing was sent');
  expect(sent).toHaveLength(0);
  expect(store.orm.select().from(telegramSends).all()).toHaveLength(0);
  expect(rejectedCodes()).toEqual(['voice_http_error']);
});

test('voice is rejected without configuration, over the caption limit, or with parse_mode, before any synthesis', async () => {
  let synthesized = 0;
  const synthesize: VoiceSynthesizer = async () => {
    synthesized += 1;
    return MP3;
  };
  const sent: SentAudio[] = [];
  await expect(sendTool(audioApi(sent)).execute?.('call-disabled', { kind: 'voice', text: 'hello' })).rejects.toThrow(
    'voice replies are not enabled',
  );
  const enabled = sendTool(audioApi(sent), { voice: { synthesize } });
  await expect(enabled.execute?.('call-long', { kind: 'voice', text: 'a'.repeat(1001) })).rejects.toThrow(
    'voice text must not exceed 1000 characters',
  );
  await expect(
    enabled.execute?.('call-markdown', { kind: 'voice', text: 'hi', parse_mode: 'MarkdownV2' }),
  ).rejects.toThrow('send input fields do not match its kind');
  expect(synthesized).toBe(0);
  expect(sent).toHaveLength(0);
  expect(rejectedCodes()).toEqual(['voice_disabled', 'voice_text_too_long', 'send_input_invalid']);
});

test('messages that arrive while the clip is synthesized hold the voice send back', async () => {
  let newMessages = false;
  const synthesize: VoiceSynthesizer = async () => {
    newMessages = true;
    return MP3;
  };
  const sent: SentAudio[] = [];
  await expect(
    sendTool(audioApi(sent), { voice: { synthesize }, holdForNewMessages: () => newMessages }).execute?.('call-voice', {
      kind: 'voice',
      text: 'hello',
    }),
  ).rejects.toThrow('Not sent: new messages arrived');
  expect(sent).toHaveLength(0);
  expect(rejectedCodes()).toEqual(['send_barrier']);
});

test('the configured synthesizer resolves the key from the key jar and sends the configured voice', async () => {
  const loaded = await loadConfig(configPath);
  const voice = loaded.config.voice;
  if (voice === undefined) {
    throw new Error('voice section missing from the test configuration');
  }
  const requests: Request[] = [];
  const synthesize = fishAudioSynthesizer(voice, new SecretStore(keyJarPath(configPath)), async (input, init) => {
    requests.push(new Request(String(input), init));
    return new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } });
  });

  expect(Array.from(await synthesize('hello'))).toEqual(Array.from(MP3));
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer fish-key-v1');
  expect(requests[0]?.headers.get('model')).toBe('s2.1-pro');
  expect(await requests[0]?.json()).toEqual({ text: 'hello', reference_id: REFERENCE_ID, format: 'mp3' });

  const missingKey = fishAudioSynthesizer(
    { ...voice, api_key: { jar: 'absent' } },
    new SecretStore(keyJarPath(configPath)),
  );
  await expect(missingKey('hello')).rejects.toMatchObject({ code: 'missing_api_key' });
});
