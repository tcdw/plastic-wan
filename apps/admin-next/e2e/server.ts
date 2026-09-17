/**
 * E2E backend process. Started by Playwright's globalSetup as a child process
 * so the real `AdminServer` + real `SqliteStore` + the synthetic admin fixture
 * run under Node.js. It binds 127.0.0.1 on a random port and prints:
 *
 *   E2E_READY base=http://127.0.0.1:<port>
 *
 * The wrapper serves two trees on that single port:
 * - `/__e2e/**`  test-only hooks (state manipulation + shutdown);
 * - everything else is handed to `AdminServer.handle` (real API + static SPA).
 *
 * Graceful shutdown: POST /__e2e/shutdown, or SIGTERM/SIGINT. The temp
 * directory and its SQLite file are removed on shutdown. Nothing here reads
 * dev-data/, starts `serve`, or touches any user process.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { and, eq, sql } from 'drizzle-orm';
import { AdminServer } from '../../../src/ingress/admin/server.ts';
import { type LoadedConfig, loadConfig } from '../../../src/platform/config.ts';
import { AgentModelSwitcher } from '../../../src/platform/model-switch.ts';
import { createModelRegistry } from '../../../src/platform/providers.ts';
import { SecretStore } from '../../../src/platform/secrets.ts';
import { asRunResult, SqliteStore } from '../../../src/store/database.ts';
import { adminSessions, alarms } from '../../../src/store/schema.ts';
import { enterSleep, wakeFromSleep } from '../../../src/store/sleep.ts';
import { seedAdminBulkRows, seedAdminFixture } from '../../../test/fixtures/admin-seed.ts';
import { testConfigJsonc, writeTestConfig } from '../../../test/helpers.ts';

const ADMIN_USERNAME = 'e2e-admin';
const ADMIN_PASSWORD = 'e2e-correct-horse';

let store: SqliteStore | null = null;
let server: ServerType | null = null;
let directory = '';
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    if (server !== null) {
      if ('closeAllConnections' in server) {
        server.closeAllConnections();
      }
      server.close();
    }
  } catch {
    // best effort
  }
  try {
    store?.close();
  } catch {
    // best effort
  }
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // best effort
  }
  process.exit(0);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleHook(request: Request, url: URL): Promise<Response> {
  const route = url.pathname.slice('/__e2e'.length);
  if (request.method === 'GET' && route === '/health') {
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/shutdown') {
    setTimeout(() => void shutdown(), 50);
    return json({ status: 'stopping' });
  }
  if (request.method === 'POST' && route === '/revoke-sessions') {
    const result = store === null ? null : asRunResult(store.orm.delete(adminSessions).run());
    return json({ deleted: Number(result?.changes ?? 0) });
  }
  if (request.method === 'POST' && route === '/enter-sleep') {
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const transition = enterSleep(store.orm);
    return json({ sleep_until: transition.sleepUntil, entered: transition.entered });
  }
  if (request.method === 'POST' && route === '/wake') {
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    return json({ was_sleeping: wakeFromSleep(store.orm) });
  }
  if (request.method === 'POST' && route === '/set-alarm-terminal') {
    const id = url.searchParams.get('id');
    if (id === null || !/^\d{1,19}$/.test(id)) {
      return json({ error: 'invalid_id' }, 400);
    }
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const now = new Date().toISOString();
    const result = asRunResult(
      store.orm
        .update(alarms)
        .set({ state: 'fired', firedAt: now, updatedAt: now })
        .where(and(eq(alarms.id, BigInt(id)), eq(alarms.state, 'pending')))
        .run(),
    );
    return json({ updated: Number(result.changes) });
  }
  if (request.method === 'GET' && route === '/alarm-state') {
    const id = url.searchParams.get('id');
    if (id === null || !/^\d{1,19}$/.test(id)) {
      return json({ error: 'invalid_id' }, 400);
    }
    const row =
      store?.orm
        .select({ state: alarms.state, cancelledBy: alarms.cancelledBy })
        .from(alarms)
        .where(eq(alarms.id, BigInt(id)))
        .get() ?? null;
    return row === null ? json({ state: null }) : json({ state: row.state, cancelled_by: row.cancelledBy });
  }
  if (request.method === 'GET' && route === '/session-count') {
    const row = store?.orm.select({ count: sql`COUNT(*)` }).from(adminSessions).get();
    return json({ count: Number(row?.count ?? 0n) });
  }
  return json({ error: 'not_found' }, 404);
}

async function main(): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-e2e-'));
  const configPath = join(directory, 'config.jsonc');
  const staticDir = resolve(join(import.meta.dirname, '..', 'dist'));
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 1,
        session_ttl_hours: 12,
        static_dir: staticDir.replaceAll('\\', '/'),
      };
    }),
  );
  const loaded: LoadedConfig = await loadConfig(configPath);
  const adminConfig = loaded.config.admin;
  if (adminConfig === undefined) {
    throw new Error('Admin config is missing from the E2E config');
  }
  // Production validation demands port >= 1; tests bind an OS-assigned port
  // by overriding to 0 in memory after a normal load.
  adminConfig.port = 0;

  store = await SqliteStore.open(loaded.config);
  seedAdminFixture(store);
  seedAdminBulkRows(store);

  const registry = await createModelRegistry(loaded.config, new SecretStore());
  const modelSwitcher = new AgentModelSwitcher(loaded.config, registry.models);
  const admin = new AdminServer({ store, config: loaded.config, modelSwitcher });

  const started = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/__e2e/')) {
        return await handleHook(request, url);
      }
      return await admin.handle(request);
    },
  });
  server = started;
  // @hono/node-server binds asynchronously; Bun.serve was listening on return.
  await new Promise<void>((resolve, reject) => {
    started.once('listening', resolve);
    started.once('error', reject);
  });
  const address = started.address();
  if (address === null || typeof address === 'string') {
    throw new Error('E2E server did not bind a port');
  }
  const port = address.port;
  console.log(`E2E_READY base=http://127.0.0.1:${port}`);
  // Exposed to the specs so they can log in again after revoking sessions.
  console.log(`E2E_CREDENTIALS ${ADMIN_USERNAME} ${ADMIN_PASSWORD}`);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('uncaughtException', (error) => {
  console.error(`E2E_SERVER_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  void shutdown();
});
process.on('unhandledRejection', (reason) => {
  console.error(`E2E_SERVER_ERROR ${reason instanceof Error ? reason.message : String(reason)}`);
  void shutdown();
});

void main().catch((error) => {
  console.error(`E2E_SERVER_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
