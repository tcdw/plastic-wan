import type { RawConfig, SecretRef } from '../platform/config.ts';
import { readBoundedBody } from './read-bounded-body.ts';

/**
 * Fish Audio text-to-speech client, ported from beiwater/jingmei
 * (`src/tools/fish-tts.ts`, BSD-2-Clause). It returns MP3 bytes; error codes are
 * stable and never carry provider response bodies or credentials.
 */

const DEFAULT_ENDPOINT = 'https://api.fish.audio/v1/tts';
const DEFAULT_MODEL = 's2.1-pro-free';
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_TEXT_LENGTH = 4_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export type FishAudioTtsErrorCode =
  | 'missing_api_key'
  | 'invalid_input'
  | 'invalid_options'
  | 'http_error'
  | 'invalid_response'
  | 'audio_too_large'
  | 'timeout'
  | 'network_error';

/** Safe, stable error codes; provider response bodies and credentials are never included. */
export class FishAudioTtsError extends Error {
  readonly code: FishAudioTtsErrorCode;

  constructor(code: FishAudioTtsErrorCode) {
    super(`Fish Audio TTS failed: ${code}`);
    this.name = 'FishAudioTtsError';
    this.code = code;
  }
}

export interface FishAudioTtsOptions {
  readonly model?: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  /** Cancels the request; reported as `timeout` like the built-in deadline. */
  readonly signal?: AbortSignal;
}

/** Generate an MP3 from Fish Audio and return the binary audio for a chat attachment. */
export async function synthesizeFishAudioTts(
  apiKey: string,
  text: string,
  referenceId: string,
  options: FishAudioTtsOptions = {},
): Promise<Uint8Array> {
  if (!apiKey.trim()) {
    throw new FishAudioTtsError('missing_api_key');
  }
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > MAX_TEXT_LENGTH ||
    typeof referenceId !== 'string' ||
    !referenceId.trim() ||
    referenceId.length > 256
  ) {
    throw new FishAudioTtsError('invalid_input');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = options.model ?? DEFAULT_MODEL;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS || !model.trim()) {
    throw new FishAudioTtsError('invalid_options');
  }

  const signal =
    options.signal === undefined
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const response = await (options.fetch ?? fetch)(DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        model,
      },
      body: JSON.stringify({ text, reference_id: referenceId, format: 'mp3' }),
      signal,
    });
    if (!response.ok) {
      throw new FishAudioTtsError('http_error');
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('application/json') || contentType.includes('text/')) {
      throw new FishAudioTtsError('invalid_response');
    }
    const audio = await readBoundedBody(response, MAX_AUDIO_BYTES);
    if (audio === null) {
      throw new FishAudioTtsError('audio_too_large');
    }
    if (audio.byteLength === 0) {
      throw new FishAudioTtsError('invalid_response');
    }
    return audio;
  } catch (error) {
    if (error instanceof FishAudioTtsError) {
      throw error;
    }
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new FishAudioTtsError('timeout');
    }
    throw new FishAudioTtsError('network_error');
  }
}

/** One synthesis call bound to a voice configuration; what `send kind:voice` uses. */
export type VoiceSynthesizer = (text: string, signal?: AbortSignal) => Promise<Uint8Array>;

/**
 * Binds the configured voice to the client. The API key is resolved per clip,
 * so key-jar rotation applies immediately; a resolution failure surfaces as
 * `missing_api_key` without leaking the SecretRef error text.
 */
export function fishAudioSynthesizer(
  voice: NonNullable<RawConfig['voice']>,
  secrets: { resolve(reference: SecretRef): Promise<string> },
  fetchImpl?: FishAudioTtsOptions['fetch'],
): VoiceSynthesizer {
  return async (text, signal) => {
    let apiKey: string;
    try {
      apiKey = await secrets.resolve(voice.api_key);
    } catch {
      throw new FishAudioTtsError('missing_api_key');
    }
    return await synthesizeFishAudioTts(apiKey, text, voice.reference_id, {
      ...(voice.model === undefined ? {} : { model: voice.model }),
      ...(signal === undefined ? {} : { signal }),
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
  };
}
