import { expect, test } from 'vitest';
import { FishAudioTtsError, synthesizeFishAudioTts } from '../src/voice/fish-tts.ts';

// Ported from beiwater/jingmei test/fish-tts.test.ts (bun:test → vitest).

test('sends the multilingual text and returns the MP3 bytes', async () => {
  let request: Request | undefined;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    request = new Request(String(input), init);
    return new Response(new Uint8Array([0x49, 0x44, 0x33]), { headers: { 'content-type': 'audio/mpeg' } });
  };

  const audio = await synthesizeFishAudioTts('unit-test-key', '你好、こんにちは、hello', 'voice-123', {
    fetch: fetcher,
  });

  expect(Array.from(audio)).toEqual([0x49, 0x44, 0x33]);
  expect(request?.url).toBe('https://api.fish.audio/v1/tts');
  expect(request?.headers.get('authorization')).toBe('Bearer unit-test-key');
  expect(request?.headers.get('model')).toBe('s2.1-pro-free');
  expect(await request?.json()).toEqual({ text: '你好、こんにちは、hello', reference_id: 'voice-123', format: 'mp3' });
});

test('rejects invalid input before making a request', async () => {
  let requested = false;
  const fetcher = async () => {
    requested = true;
    return new Response();
  };

  await expect(synthesizeFishAudioTts('unit-test-key', '  ', 'voice', { fetch: fetcher })).rejects.toMatchObject({
    code: 'invalid_input',
  });
  await expect(synthesizeFishAudioTts(' ', 'hello', 'voice', { fetch: fetcher })).rejects.toMatchObject({
    code: 'missing_api_key',
  });
  expect(requested).toBe(false);
});

test('does not expose provider error bodies', async () => {
  const fetcher = async () => new Response('private provider detail', { status: 401 });
  const error = await synthesizeFishAudioTts('unit-test-key', 'hello', 'voice', { fetch: fetcher }).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(FishAudioTtsError);
  expect((error as Error).message).toBe('Fish Audio TTS failed: http_error');
});

test('rejects JSON responses and oversized audio', async () => {
  const jsonFetcher = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  await expect(synthesizeFishAudioTts('unit-test-key', 'hello', 'voice', { fetch: jsonFetcher })).rejects.toMatchObject(
    { code: 'invalid_response' },
  );

  const largeFetcher = async () => new Response(null, { headers: { 'content-length': String(9 * 1024 * 1024) } });
  await expect(
    synthesizeFishAudioTts('unit-test-key', 'hello', 'voice', { fetch: largeFetcher }),
  ).rejects.toMatchObject({ code: 'audio_too_large' });

  // A streamed body without content-length is cut off at the cap as well.
  const streamedFetcher = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      }),
      { headers: { 'content-type': 'audio/mpeg' } },
    );
  await expect(
    synthesizeFishAudioTts('unit-test-key', 'hello', 'voice', { fetch: streamedFetcher }),
  ).rejects.toMatchObject({ code: 'audio_too_large' });
});

test('maps an aborted request to a safe timeout error', async () => {
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      });
    });
  await expect(
    synthesizeFishAudioTts('unit-test-key', 'hello', 'voice', { fetch: fetcher, timeoutMs: 5 }),
  ).rejects.toMatchObject({ code: 'timeout' });

  const controller = new AbortController();
  const pending = synthesizeFishAudioTts('unit-test-key', 'hello', 'voice', {
    fetch: fetcher,
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'timeout' });
});
