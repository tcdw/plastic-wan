// Manual verification probe for the admin dev proxy Origin rewrite
// (vite.config.ts ALLOWED_ORIGINS: only http://localhost:5273 and
// http://127.0.0.1:5273 get their Origin rewritten to the API target; any
// other origin passes through untouched so the backend origin check rejects
// cross-site writes).
//
// Run from the repo root:
//   bun run scripts/admin-dev-proxy-probe.ts
//
// It starts an echo server (127.0.0.1:8891) that mirrors the Host/Origin
// headers it receives, starts `vite dev` in apps/admin-next with
// ADMIN_API_TARGET=http://127.0.0.1:8891, then curls three cases through the
// proxy and asserts the backend would accept/reject each one. Exits non-zero
// on failure and kills the vite process tree when done.
//
// Why not part of the default `bun test`: it needs a real `vite dev` server
// on a fixed port plus curl, so it is slow and flaky in CI/headless runs.
// Browser-level dev-proxy behavior is covered manually; production serving
// (no proxy) is what the automated tests exercise.

import { spawn, type Subprocess } from 'bun';
import { join } from 'node:path';

const PROBE_PORT = 8891;
const VITE_PORT = 5273;
const API_TARGET = `http://127.0.0.1:${PROBE_PORT}`;
const VITE_BASE = `http://127.0.0.1:${VITE_PORT}`;

const children: Subprocess[] = [];

function killTree(proc: Subprocess): void {
  // Synchronous so taskkill finishes before the script exits and the whole
  // vite tree (bun → node/vite → esbuild) is actually gone.
  Bun.spawnSync(['taskkill', '/PID', String(proc.pid), '/T', '/F'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) {
        return;
      }
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function curlOnce(header: string | null): Promise<string> {
  const args = ['-s', '--max-time', '10'];
  if (header !== null) {
    args.push('-H', header);
  }
  args.push(`${VITE_BASE}/api/probe`);
  const proc = spawn({ cmd: ['curl', ...args], stdout: 'pipe', stderr: 'pipe' });
  children.push(proc);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

const probe = Bun.serve({
  hostname: '127.0.0.1',
  port: PROBE_PORT,
  fetch: (req) =>
    Response.json({
      host: req.headers.get('host'),
      origin: req.headers.get('origin'),
      path: new URL(req.url).pathname,
    }),
});

let vite: Subprocess | undefined;
let pass = true;
try {
  console.log(`echo probe listening on ${API_TARGET}`);
  vite = spawn({
    cmd: ['bun', 'run', 'dev'],
    cwd: join(import.meta.dir, '..', 'apps', 'admin-next'),
    env: { ...process.env, ADMIN_API_TARGET: API_TARGET },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(vite);
  await waitFor(`${VITE_BASE}/`, 20_000);
  console.log(`vite dev listening on ${VITE_BASE}`);

  const allowed = await curlOnce('Origin: http://localhost:5273');
  const evil = await curlOnce('Origin: http://evil.example');
  const none = await curlOnce(null);

  console.log('\n--- case 1: Origin=http://localhost:5273 (allowed) ---');
  console.log(allowed);
  console.log('\n--- case 2: Origin=http://evil.example ---');
  console.log(evil);
  console.log('\n--- case 3: no Origin header ---');
  console.log(none);

  const parse = (body: string): { host: string | null; origin: string | null } =>
    JSON.parse(body) as {
      host: string | null;
      origin: string | null;
    };

  const a = parse(allowed);
  const allowedOk =
    a.host === `127.0.0.1:${PROBE_PORT}` &&
    a.origin === `http://127.0.0.1:${PROBE_PORT}` &&
    new URL(a.origin as string).host === a.host;
  console.log(`\ncase 1 (allowed) => host=${a.host} origin=${a.origin} host===origin.host: ${allowedOk}`);
  pass &&= allowedOk;

  const e = parse(evil);
  const evilOk = e.origin === 'http://evil.example' && e.host === `127.0.0.1:${PROBE_PORT}`;
  console.log(
    `case 2 (evil) => origin untouched: ${evilOk} (backend would 403: ${e.origin !== null && new URL(e.origin).host !== e.host})`,
  );
  pass &&= evilOk;

  const n = parse(none);
  const noneOk = n.origin === null && n.host === `127.0.0.1:${PROBE_PORT}`;
  console.log(`case 3 (no origin) => origin untouched: ${noneOk}`);
  pass &&= noneOk;

  console.log(pass ? '\nPROXY PROBE PASSED.' : '\nPROXY PROBE FAILED.');
} finally {
  probe.stop(true);
  if (vite !== undefined) {
    killTree(vite);
  }
}
process.exit(pass ? 0 : 1);
