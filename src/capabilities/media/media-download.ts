import { open, unlink } from 'node:fs/promises';

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

interface TelegramFileApi {
  getFile(fileId: string): Promise<{ readonly file_path?: string }>;
}

export interface MediaDownloader {
  download(fileId: string, destination: string, signal: AbortSignal): Promise<void>;
}

export class TelegramMediaClient implements MediaDownloader {
  readonly #api: TelegramFileApi;
  readonly #token: string;

  constructor(api: TelegramFileApi, token: string) {
    this.#api = api;
    this.#token = token;
  }

  async download(fileId: string, destination: string, signal: AbortSignal): Promise<void> {
    const file = await this.#api.getFile(fileId);
    if (file.file_path === undefined) {
      throw new Error('Telegram getFile response omitted file_path');
    }
    const encodedPath = file.file_path
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const response = await fetch(`https://api.telegram.org/file/bot${this.#token}/${encodedPath}`, {
      signal,
      redirect: 'error',
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Telegram media download failed with status ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error('Telegram media exceeds 20 MB');
    }
    const handle = await open(destination, 'wx', 0o600);
    const reader = response.body.getReader();
    let size = 0;
    let completed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > MAX_DOWNLOAD_BYTES) {
          throw new Error('Telegram media exceeds 20 MB');
        }
        await handle.write(value);
      }
      completed = true;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await handle.close();
      if (!completed) {
        await unlink(destination).catch(() => undefined);
      }
    }
  }
}
