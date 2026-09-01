import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import Type from 'typebox';
import Compile from 'typebox/compile';
import type { MediaDownloader } from './media-download.ts';
import { pickEnv, readBoundedOutput } from '../../platform/subprocess.ts';

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_PIXELS = 40_000_000;
const MAX_NORMALIZED_BYTES = 10 * 1024 * 1024;

const ALLOWED_IMAGE_FORMATS: Record<string, true> = {
  jpeg: true,
  png: true,
  webp: true,
  svg: true,
};

export const StickerTelegramSchema = Type.Object(
  {
    is_video: Type.Boolean(),
    is_animated: Type.Boolean(),
    thumbnail: Type.Optional(Type.Object({ file_id: Type.String() }, { additionalProperties: true })),
  },
  { additionalProperties: true },
);
const TgsMetadataSchema = Type.Object({ ip: Type.Number(), op: Type.Number() }, { additionalProperties: true });
export const stickerTelegramValidator = Compile(StickerTelegramSchema);
const tgsMetadataValidator = Compile(TgsMetadataSchema);

/** Media row shape shared by the vision service and the image pipeline. */
export interface MediaRow {
  readonly id: bigint;
  readonly kind: string;
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileSize: bigint | null;
  readonly telegramJson: string;
}

export interface NormalizedImage {
  readonly path: string;
  readonly mimeType: 'image/jpeg' | 'image/png';
  readonly width: number;
  readonly height: number;
}

/**
 * Turns a media row into one normalized still image ready for a vision model:
 * downloads the payload, prefers sticker thumbnails, extracts a representative
 * frame from video/TGS stickers via ffmpeg/lottie, then normalizes with sharp.
 */
export async function prepareMediaImage(
  media: MediaRow,
  inputPath: string,
  directory: string,
  downloader: MediaDownloader,
  signal: AbortSignal,
): Promise<NormalizedImage> {
  if (media.kind !== 'sticker') {
    await downloader.download(media.fileId, inputPath, signal);
    return normalizeImage(inputPath, directory);
  }
  let telegram: unknown;
  try {
    telegram = JSON.parse(media.telegramJson);
  } catch {
    throw new Error('Stored sticker metadata is invalid JSON');
  }
  if (!stickerTelegramValidator.Check(telegram)) {
    throw new Error('Stored sticker metadata does not match its schema');
  }
  if (telegram.thumbnail !== undefined) {
    const thumbnailPath = join(directory, 'thumbnail');
    await downloader.download(telegram.thumbnail.file_id, thumbnailPath, signal);
    return normalizeImage(thumbnailPath, directory);
  }
  await downloader.download(media.fileId, inputPath, signal);
  if (!telegram.is_video && !telegram.is_animated) {
    return normalizeImage(inputPath, directory);
  }
  if (telegram.is_video) {
    const outputPath = join(directory, 'representative.png');
    const durationText = await runExternal(
      [
        'ffprobe',
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ],
      true,
      signal,
    );
    const duration = Number.parseFloat(durationText.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('ffprobe returned an invalid sticker duration');
    }
    await runExternal(
      ['ffmpeg', '-v', 'error', '-ss', String(duration / 2), '-i', inputPath, '-frames:v', '1', outputPath],
      false,
      signal,
    );
    return normalizeImage(outputPath, directory);
  }
  const outputPath = join(directory, 'representative.svg');
  const compressed = new Uint8Array(await Bun.file(inputPath).arrayBuffer());
  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder().decode(gunzipSync(compressed)));
  } catch {
    throw new Error('Animated sticker TGS metadata is invalid');
  }
  if (!tgsMetadataValidator.Check(metadata) || metadata.op <= metadata.ip) {
    throw new Error('Animated sticker frame range is invalid');
  }
  const frame = Math.floor((metadata.ip + metadata.op) / 2);
  await runExternal(createLottieCommand([inputPath, outputPath, '--frame', String(frame)]), false, signal);
  return normalizeImage(outputPath, directory);
}

export function createLottieCommand(argumentsList: readonly string[]): string[] {
  if (process.platform !== 'win32') {
    return ['lottie_convert.py', ...argumentsList];
  }
  const runner =
    "import os, runpy, sysconfig; runpy.run_path(os.path.join(sysconfig.get_path('scripts'), 'lottie_convert.py'), run_name='__main__')";
  return ['python', '-c', runner, ...argumentsList];
}

async function runExternal(argv: readonly string[], captureOutput: boolean, signal: AbortSignal): Promise<string> {
  const processHandle = Bun.spawn([...argv], {
    stdin: 'ignore',
    stdout: captureOutput ? 'pipe' : 'ignore',
    stderr: 'ignore',
    env: pickEnv(
      process.platform === 'win32'
        ? ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
        : ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'],
    ),
  });
  const abortProcess = (): void => processHandle.kill();
  signal.addEventListener('abort', abortProcess, { once: true });
  const timeout = setTimeout(() => processHandle.kill(), 30_000);
  try {
    const output =
      captureOutput && processHandle.stdout instanceof ReadableStream
        ? await readBoundedOutput(processHandle.stdout, 65_536, () => {
            processHandle.kill();
            return new Error('Media command output exceeds 64 KiB');
          })
        : '';
    const exitCode = await processHandle.exited;
    if (signal.aborted) {
      throw new Error('Media command aborted');
    }
    if (exitCode !== 0) {
      throw new Error(`${argv[0]} failed with exit code ${exitCode}`);
    }
    return output;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abortProcess);
  }
}

async function normalizeImage(inputPath: string, directory: string): Promise<NormalizedImage> {
  const input = Buffer.from(await Bun.file(inputPath).arrayBuffer());
  if (input.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error('Image input exceeds 20 MB');
  }
  const source = sharp(input, { failOn: 'error', limitInputPixels: MAX_DECODED_PIXELS });
  const metadata = await source.metadata();
  if (metadata.format === undefined || !(metadata.format in ALLOWED_IMAGE_FORMATS)) {
    throw new Error('Unsupported image format');
  }
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error('Image dimensions are unavailable');
  }
  if (metadata.width * metadata.height > MAX_DECODED_PIXELS) {
    throw new Error('Decoded image exceeds pixel limit');
  }
  const transparent = metadata.hasAlpha === true;
  const outputPath = join(directory, transparent ? 'normalized.png' : 'normalized.jpg');
  const pipeline = source.rotate().resize({
    width: 2048,
    height: 2048,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const output = transparent
    ? await pipeline.png().toBuffer({ resolveWithObject: true })
    : await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  if (output.data.byteLength > MAX_NORMALIZED_BYTES) {
    throw new Error('Normalized image exceeds output limit');
  }
  await Bun.write(outputPath, output.data);
  if (process.platform !== 'win32') {
    await chmod(outputPath, 0o600);
  }
  return {
    path: outputPath,
    mimeType: transparent ? 'image/png' : 'image/jpeg',
    width: output.info.width,
    height: output.info.height,
  };
}
