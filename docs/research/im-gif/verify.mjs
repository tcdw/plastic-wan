// Independently compare decoded GIF frame timing with FFprobe, then check whether
// composited full-resolution RGBA frames actually change. No image exports.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { stats, summarize } from './measure.mjs';

const execute = promisify(execFile);
const report = JSON.parse(await readFile(join(import.meta.dirname, 'measurements.json'), 'utf8'));
const records = report.sources.flatMap((source) =>
  source.records.filter((row) => row.status === 'ok' && row.frames > 1).map((row) => ({ ...row, repo: source.repo })),
);
const results = new Array(records.length);
let cursor = 0;
let completed = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (cursor < records.length) {
      const index = cursor++;
      const row = records[index];
      const file = resolve('test-tmp/gif-research', `${row.blob}.gif`);
      const input = ['-v', 'error', '-f', 'gif', '-protocol_whitelist', 'file', '-ignore_loop', '1', '-i', file];
      try {
        const { stdout } = await execute(
          'ffprobe',
          [
            ...input,
            '-count_packets',
            '-show_entries',
            'frame=duration_time:stream=nb_read_packets:format=duration',
            '-of',
            'json',
          ],
          { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        );
        const probe = JSON.parse(stdout);
        assert.equal(probe.frames.length, row.frames, 'FFprobe decoded frame count differs');
        const frameDelaysCs = probe.frames.map((frame) => Math.round(Number(frame.duration_time) * 100));
        assert.deepEqual(
          frameDelaysCs,
          row.delaysCs.map((delay) => (delay === null || delay === 0 ? 10 : delay)),
          'FFprobe frame timing differs',
        );
        const frameDurationSeconds = frameDelaysCs.reduce((sum, delay) => sum + delay, 0) / 100;
        const decoded = await execute(
          'ffmpeg',
          [
            ...input,
            '-an',
            '-map',
            '0:v:0',
            '-threads',
            '1',
            '-pix_fmt',
            'rgba',
            '-fps_mode',
            'passthrough',
            '-f',
            'framemd5',
            'pipe:1',
          ],
          { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        );
        const hashes = decoded.stdout
          .split(/\r?\n/)
          .filter((line) => line && !line.startsWith('#'))
          .map((line) => line.split(',').at(-1).trim());
        assert.equal(hashes.length, row.frames, 'Decoded frame count differs');
        results[index] = {
          repo: row.repo,
          blob: row.blob,
          status: 'ok',
          frameDurationSeconds,
          extraPackets: Number(probe.streams[0].nb_read_packets) - row.frames,
          timingPolicyDifference: Math.abs(frameDurationSeconds - row.durationSeconds) > 0.0001,
          formatDuration: Number(probe.format.duration),
          decodedFrames: hashes.length,
          distinctRgbaFrames: new Set(hashes).size,
          consecutiveRgbaStates: hashes.filter((hash, index) => index === 0 || hashes[index - 1] !== hash).length,
        };
      } catch (error) {
        results[index] = { repo: row.repo, blob: row.blob, status: 'error', error: error.message };
      }
      completed++;
      if (completed % 50 === 0) {
        console.log(`Independent decode: ${completed}/${records.length}`);
      }
    }
  }),
);
const { stdout: ffmpegVersion } = await execute('ffmpeg', ['-version'], { timeout: 10_000 });
const summaries = report.sources.map((source) => {
  const movingBlobs = new Set(
    results
      .filter((row) => row.repo === source.repo && row.status === 'ok' && row.distinctRgbaFrames > 1)
      .map((row) => row.blob),
  );
  const moving = source.records.filter((row) => movingBlobs.has(row.blob));
  const verifiedMoving = results.filter((row) => row.repo === source.repo && movingBlobs.has(row.blob));
  return {
    repo: source.repo,
    changingImageSummary: summarize(moving),
    distinctRgbaFrames: stats(verifiedMoving.map((row) => row.distinctRgbaFrames)),
    consecutiveRgbaStates: stats(verifiedMoving.map((row) => row.consecutiveRgbaStates)),
  };
});
const output = {
  measuredAt: new Date().toISOString(),
  ffmpeg: ffmpegVersion.split(/\r?\n/)[0],
  method:
    'FFprobe decoded per-frame delays vs raw GIF delays (this build uses missing/zero=100ms); extra packets are not counted as images. FFmpeg full-resolution composited RGBA per-frame MD5, no fps conversion and one loop. Global distinct states and consecutive-state runs are separate metrics; neither is a semantic complexity measure.',
  results,
  summaries,
};
await writeFile(join(import.meta.dirname, 'verification.json'), `${JSON.stringify(output, null, 2)}\n`);
if (results.some((row) => row.status !== 'ok')) {
  process.exitCode = 1;
}
for (const source of report.sources) {
  const rows = results.filter((row) => row.repo === source.repo);
  console.log(
    JSON.stringify({
      repo: source.repo,
      checked: rows.length,
      errors: rows.filter((row) => row.status !== 'ok'),
      identicalOnly: rows.filter((row) => row.distinctRgbaFrames === 1).length,
      metadataDurationMismatch: rows.filter(
        (row) => row.status === 'ok' && Math.abs(row.formatDuration - row.frameDurationSeconds) > 0.0001,
      ).length,
    }),
  );
}
