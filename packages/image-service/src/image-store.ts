import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { inputError, storageFailure } from './errors.ts';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export type AllowedMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** Structural subset of sharp's metadata that this project relies on. */
type SharpMetadata = { format?: string; width?: number; height?: number };

const FORMAT_TO_MIME: Record<string, AllowedMime> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const MIME_TO_EXT: Record<AllowedMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export type VerifiedImage = {
  mime: AllowedMime;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
};

export type StoredImage = VerifiedImage & {
  id: string;
  fileName: string;
  absolutePath: string;
};

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict base64 decode: rejects malformed padding/characters instead of silently dropping them. */
export function decodeBase64Image(value: string): Buffer {
  const cleaned = value.replace(/\s+/g, '');
  if (cleaned.length === 0 || cleaned.length % 4 !== 0 || !BASE64_PATTERN.test(cleaned)) {
    throw inputError('invalid_base64', '图片数据不是有效的 base64');
  }
  const buffer = Buffer.from(cleaned, 'base64');
  const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
  if (buffer.length !== (cleaned.length / 4) * 3 - padding) {
    throw inputError('invalid_base64', '图片数据不是有效的 base64');
  }
  return buffer;
}

export type ImageStoreOptions = { dir: string };

/**
 * Immutable local image files: one file per asset identity, written with O_EXCL and
 * never overwritten or removed by asset deletion (history keeps its bytes). The
 * directory is injected by the host; the core never picks locations on its own.
 */
export class ImageStore {
  readonly dir: string;

  constructor(options: ImageStoreOptions) {
    this.dir = options.dir;
    mkdirSync(this.dir, { recursive: true });
  }

  pathFor(fileName: string): string {
    return path.join(this.dir, fileName);
  }

  exists(fileName: string): boolean {
    try {
      return statSync(this.pathFor(fileName)).isFile();
    } catch {
      return false;
    }
  }

  read(fileName: string): Buffer {
    try {
      return readFileSync(this.pathFor(fileName));
    } catch {
      throw storageFailure('image_file_missing', '图片文件不可读取');
    }
  }

  /** Verifies bytes with sharp; only PNG/JPEG/WebP with real dimensions are accepted. */
  async verifyBytes(bytes: Buffer): Promise<VerifiedImage> {
    if (bytes.length === 0) {
      throw inputError('invalid_image', '图片内容为空');
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw inputError('payload_too_large', '图片超过 20MiB 上限');
    }
    let metadata: SharpMetadata;
    try {
      metadata = (await sharp(bytes, { failOn: 'error' }).metadata()) as SharpMetadata;
    } catch {
      throw inputError('invalid_image', '图片内容无法解码');
    }
    const format = metadata.format ?? '';
    const mime = FORMAT_TO_MIME[format];
    if (mime === undefined) {
      throw inputError('unsupported_format', '仅支持 PNG、JPEG、WebP 图片');
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) {
      throw inputError('invalid_image', '图片尺寸无效');
    }
    return {
      mime,
      width,
      height,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  /** True when the image carries a real alpha channel with non-opaque pixels. */
  async hasTransparency(bytes: Buffer): Promise<boolean> {
    try {
      const stats = await sharp(bytes).ensureAlpha().stats();
      const alpha = stats.channels[3];
      return alpha !== undefined && alpha.min < 255;
    } catch {
      return false;
    }
  }

  /** Writes verified bytes under a fresh immutable identity; never overwrites a file. */
  async store(input: { bytes: Buffer; id?: string; expectedMime?: AllowedMime }): Promise<StoredImage> {
    const verified = await this.verifyBytes(input.bytes);
    if (input.expectedMime !== undefined && input.expectedMime !== verified.mime) {
      throw inputError('mime_mismatch', `图片实际格式为 ${verified.mime}，与声明的 ${input.expectedMime} 不一致`);
    }
    const id = input.id ?? randomUUID();
    const fileName = `${id}.${MIME_TO_EXT[verified.mime]}`;
    try {
      await writeFile(this.pathFor(fileName), input.bytes, { flag: 'wx', mode: 0o600 });
    } catch {
      throw storageFailure('image_write_failed', '图片写入失败');
    }
    return { ...verified, id, fileName, absolutePath: this.pathFor(fileName) };
  }
}
