import { afterAll, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MediaRow, prepareMediaImage } from '../src/capabilities/media/media-image.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

function ffmpeg(args: readonly string[]): boolean {
  return spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' }).status === 0;
}

function videoSticker(): MediaRow {
  return {
    id: 1n,
    kind: 'sticker',
    fileId: 'sticker-file',
    fileUniqueId: 'sticker-unique',
    mimeType: 'video/webm',
    fileSize: null,
    telegramJson: JSON.stringify({ is_video: true, is_animated: false }),
  };
}

/** Stands in for Telegram: the "downloaded" sticker is whatever file the test prepared. */
function serving(source: string) {
  return { download: async (_fileId: string, destination: string) => copyFile(source, destination) };
}

describe.skipIf(!hasFfmpeg)('video sticker frame extraction', () => {
  test('only WebM is decoded: another container posing as a video sticker is refused', async () => {
    // With format probing on, ffprobe/ffmpeg decode whatever the bytes look like,
    // including playlist and concat formats that open further files or URLs.
    // (This ffmpeg may refuse those itself; older builds do not.) Forcing the
    // Matroska demuxer is observable with any non-WebM input, such as MPEG-TS.
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
    directories.push(directory);
    const transport = join(directory, 'clip.ts');
    expect(
      ffmpeg([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=64x64:rate=10',
        '-t',
        '1',
        '-c:v',
        'mpeg2video',
        '-f',
        'mpegts',
        transport,
      ]),
    ).toBe(true);
    await expect(
      prepareMediaImage(
        videoSticker(),
        join(directory, 'input'),
        directory,
        serving(transport),
        new AbortController().signal,
      ),
    ).rejects.toThrow('ffprobe failed');
  });

  test('a real WebM video sticker still yields a frame', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-'));
    directories.push(directory);
    const webm = join(directory, 'sticker.webm');
    const encoded = ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10', '-t', '1', '-c:v', 'libvpx-vp9', webm]);
    if (!encoded) {
      // This ffmpeg build has no VP9 encoder; the refusal test above still runs.
      return;
    }
    const image = await prepareMediaImage(
      videoSticker(),
      join(directory, 'input'),
      directory,
      serving(webm),
      new AbortController().signal,
    );
    expect(image.width).toBeGreaterThan(0);
  });
});
