// Research-only metadata measurement. No runtime or Telegram integration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const sources = [
  {
    repo: 'zhaoolee/ChineseBQB',
    commit: '023726af8347867c33e0e210e6cf17186dda8687',
    tree: '445f406eb7eb190f9a993b0bd0d8a680488f268b',
  },
  {
    repo: 'getActivity/EmojiPackage',
    commit: '6110519a8340b36ae3497c4b062292ca25291b61',
    tree: 'c61fad9a6d5640e1de30ee4f70698056ecb54068',
  },
  {
    repo: 'snipe/animated-gifs',
    commit: 'd5ff840d028c2438497e7a7709d6bb9d5f7c6d68',
    tree: 'fc159a577e0fdcbd86cf607db31ad42796034365',
  },
];
const seed = 'im-gif-20260927:';
const sampleSize = 150;
const cache = resolve('test-tmp/gif-research');
const output = join(import.meta.dirname, 'measurements.json');
const maxBytes = 64 * 1024 * 1024;
const digest = (value) => createHash('sha256').update(value).digest('hex');

// Count image descriptors and inspect timing without decompressing pixels.
// Delays remain unmodified; an explicit analysis policy is reported below.
export function inspectGif(buffer) {
  if (!/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) {
    throw new Error('Not GIF');
  }
  let offset = 6;
  const take = (length) => {
    if (offset + length > buffer.length) {
      throw new Error('Truncated GIF');
    }
    const part = buffer.subarray(offset, offset + length);
    offset += length;
    return part;
  };
  const subBlocks = () => {
    const parts = [];
    for (let length = take(1)[0]; length !== 0; length = take(1)[0]) {
      parts.push(take(length));
    }
    return Buffer.concat(parts);
  };
  const screen = take(7);
  const width = screen.readUInt16LE(0);
  const height = screen.readUInt16LE(2);
  if (screen[4] & 128) {
    take(3 * 2 ** ((screen[4] & 7) + 1));
  }
  let delay = null;
  let loopCount = null;
  let userInput = false;
  let userInputFrames = 0;
  const delaysCs = [];
  while (offset < buffer.length) {
    const marker = take(1)[0];
    if (marker === 0x3b) {
      return { width, height, frames: delaysCs.length, delaysCs, loopCount, userInputFrames };
    }
    if (marker === 0x21) {
      const label = take(1)[0];
      if (label === 0xf9) {
        if (take(1)[0] !== 4) {
          throw new Error('Invalid graphic control extension');
        }
        const control = take(4);
        delay = control.readUInt16LE(1);
        userInput = Boolean(control[0] & 2);
        if (take(1)[0] !== 0) {
          throw new Error('Invalid graphic control terminator');
        }
      } else if (label === 0xff) {
        const application = take(take(1)[0]).toString('ascii');
        const data = subBlocks();
        if (['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(application) && data.length >= 3 && data[0] === 1) {
          loopCount = data.readUInt16LE(1);
        }
      } else {
        subBlocks();
        if (label === 0x01) {
          throw new Error('Plain text rendering requires a different timing model');
        }
      }
    } else if (marker === 0x2c) {
      const image = take(9);
      if (image[8] & 128) {
        take(3 * 2 ** ((image[8] & 7) + 1));
      }
      take(1); // LZW minimum code size.
      subBlocks();
      delaysCs.push(delay);
      if (userInput) {
        userInputFrames++;
      }
      delay = null;
      userInput = false;
    } else {
      throw new Error(`Unexpected GIF block ${marker}`);
    }
  }
  throw new Error('Missing GIF trailer');
}

function selfCheck() {
  const header = Buffer.from('47494638396101000100800000000000ffffff', 'hex');
  const image = Buffer.from('2c0000000001000100000202440100', 'hex');
  const control = (delay) => Buffer.from([0x21, 0xf9, 4, 0, delay, 0, 0, 0]);
  const loop = Buffer.from('21ff0b4e45545343415045322e300301000000', 'hex');
  const fixture = Buffer.concat([header, loop, control(10), image, control(50), image, Buffer.from([0x3b])]);
  assert.deepEqual(inspectGif(fixture), {
    width: 1,
    height: 1,
    frames: 2,
    delaysCs: [10, 50],
    loopCount: 0,
    userInputFrames: 0,
  });
  assert.deepEqual(inspectGif(Buffer.concat([header, control(0), image, image, Buffer.from([0x3b])])).delaysCs, [
    0,
    null,
  ]);
  assert.throws(() => inspectGif(fixture.subarray(0, -1)), /trailer/);
  assert.throws(() => inspectGif(Buffer.from('not gif')), /Not GIF/);
}

async function download(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'plastic-wan-gif-metadata-research' },
    signal: AbortSignal.timeout(60_000),
    redirect: 'error',
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error('Download exceeds 64 MiB');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const quantile = (sorted, probability) => {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
};
export const stats = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }
  const round = (number) => Math.round(number * 1000) / 1000;
  return Object.fromEntries(
    Object.entries({
      min: sorted[0],
      p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p90: quantile(sorted, 0.9),
      p95: quantile(sorted, 0.95),
      max: sorted.at(-1),
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    }).map(([key, value]) => [key, round(value)]),
  );
};

export function summarize(records) {
  const valid = records.filter((record) => record.status === 'ok');
  const animated = valid.filter((record) => record.frames > 1 && record.userInputFrames === 0);
  return {
    selected: records.length,
    failed: records.filter((record) => record.status !== 'ok').length,
    static: valid.filter((record) => record.frames <= 1).length,
    userInput: valid.filter((record) => record.userInputFrames > 0).length,
    animated: animated.length,
    durationSeconds: stats(animated.map((record) => record.durationSeconds)),
    rawDurationSeconds: stats(animated.map((record) => record.rawDurationSeconds)),
    frames: stats(animated.map((record) => record.frames)),
    effectiveFps: stats(animated.map((record) => record.frames / record.durationSeconds)),
    fileMiB: stats(animated.map((record) => record.bytes / (1024 * 1024))),
    variableDelay: animated.filter((record) => new Set(record.delaysCs).size > 1).length,
    normalizedDelay: animated.filter((record) => record.delaysCs.some((delay) => delay === null || delay < 2)).length,
    durationWithinSeconds: Object.fromEntries(
      [1, 2, 3, 5, 6, 10, 15, 30].map((limit) => [
        limit,
        animated.filter((record) => record.durationSeconds <= limit).length,
      ]),
    ),
    framesWithin: Object.fromEntries(
      [4, 8, 12, 16, 24, 50, 100, 200, 500].map((limit) => [
        limit,
        animated.filter((record) => record.frames <= limit).length,
      ]),
    ),
  };
}

async function main() {
  selfCheck();
  await mkdir(cache, { recursive: true });
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    sharp: sharp.versions.sharp,
    seed,
    sampleSize,
    method:
      'Unique Git blob SHA per repository; exclude README paths; select lowest SHA-256(seed + blob SHA). Raw one-loop delays; explicit analysis policy replaces delays below 2 cs or missing with 10 cs, not a claim about every player. Quantiles use linear interpolation.',
    sources: [],
  };
  for (const source of sources) {
    const treePath = join(cache, `${source.repo.replace('/', '-')}-tree.json`);
    let tree;
    try {
      tree = JSON.parse(await readFile(treePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      tree = JSON.parse(
        (await download(`https://api.github.com/repos/${source.repo}/git/trees/${source.commit}?recursive=1`)).toString(
          'utf8',
        ),
      );
      await writeFile(treePath, JSON.stringify(tree));
    }
    if (tree.truncated || !Array.isArray(tree.tree) || ![source.commit, source.tree].includes(tree.sha)) {
      throw new Error('Incomplete repository tree');
    }
    const candidates = tree.tree.filter(
      (entry) => entry.type === 'blob' && /\.gif$/i.test(entry.path) && !/^README(?:\.|\/)/i.test(entry.path),
    );
    const unique = [...new Map(candidates.map((entry) => [entry.sha, entry])).values()];
    const selected = unique
      .toSorted((a, b) => digest(seed + a.sha).localeCompare(digest(seed + b.sha)))
      .slice(0, sampleSize);
    const result = {
      ...source,
      candidatePaths: candidates.length,
      uniqueBlobs: unique.length,
      records: new Array(selected.length),
    };
    let cursor = 0;
    let completed = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < selected.length) {
          const index = cursor++;
          const entry = selected[index];
          const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
          const row = { path: entry.path, blob: entry.sha, url };
          try {
            const file = join(cache, `${entry.sha}.gif`);
            let buffer;
            try {
              buffer = await readFile(file);
            } catch (error) {
              if (error.code !== 'ENOENT') {
                throw error;
              }
              if (entry.size > maxBytes) {
                throw new Error('Declared size exceeds 64 MiB');
              }
              buffer = await download(url);
              await writeFile(file, buffer);
            }
            assert.equal(buffer.length, entry.size);
            assert.equal(createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex'), entry.sha);
            const metadata = inspectGif(buffer);
            const reference = await sharp(buffer, { limitInputPixels: 64_000_000 }).metadata();
            assert.equal(metadata.frames, reference.pages ?? 1, 'Sharp frame count differs');
            assert.equal(metadata.width, reference.width);
            assert.equal(metadata.height, reference.height);
            if (reference.delay) {
              assert.deepEqual(
                metadata.delaysCs.map((delay) => (delay ?? 10) * 10),
                reference.delay,
                'Sharp delay differs',
              );
            }
            const rawDurationSeconds = metadata.delaysCs.reduce((sum, delay) => sum + (delay ?? 0), 0) / 100;
            const durationSeconds =
              metadata.delaysCs.reduce((sum, delay) => sum + (delay === null || delay < 2 ? 10 : delay), 0) / 100;
            result.records[index] = {
              ...row,
              status: 'ok',
              bytes: buffer.length,
              ...metadata,
              rawDurationSeconds,
              durationSeconds,
            };
          } catch (error) {
            result.records[index] = { ...row, status: 'error', error: error.message };
          }
          completed++;
          if (completed % 25 === 0) {
            console.log(`${source.repo}: ${completed}/${selected.length}`);
          }
        }
      }),
    );
    result.summary = summarize(result.records);
    report.sources.push(result);
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ repo: source.repo, ...result.summary }));
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-check')) {
    selfCheck();
    console.log('Metadata parser checks passed');
  } else {
    await main();
  }
}
