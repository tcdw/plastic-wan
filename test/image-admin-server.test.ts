import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenRouterAdapter } from '@plasticwan/image-service';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createImageBridge } from '../src/image/bridge.ts';
import { createImageService } from '../src/image/service.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { loadConfig } from '../src/platform/config.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeyJar } from './helpers.ts';

// ---------------------------------------------------------------------------
// Regression: the image dispatch used `'bytes' in response` to detect the
// binary content record. Node 26 added a `bytes()` method to Response, so the
// flag matched every Response and the enable request's JSON answer was
// rebuilt as a binary record with an undefined content-type, which crashes
// @hono/node-server's writeHead (ERR_HTTP_INVALID_HEADER_VALUE). The dispatch
// must use the explicit `kind` discriminant; this test pins the panel-facing
// behavior through AdminServer.handle, below the HTTP layer.
// ---------------------------------------------------------------------------

const PASSWORD = 'correct-horse-battery';
const cleanup: Array<() => Promise<void>> = [];
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-admin-server-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
});

afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

interface Fixture {
  readonly server: AdminServer;
  readonly cookie: string;
  readonly configPath: string;
  revision(): Promise<string>;
}

async function fixture(): Promise<Fixture> {
  const configPath = join(directory, 'config.jsonc');
  const staticDir = join(directory, 'bundle');
  await mkdir(join(staticDir, 'static'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
        static_dir: staticDir.replaceAll('\\', '/'),
      };
    }),
  );
  await writeTestKeyJar(directory, {});
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const service = createImageService(store, loaded.config, {
    providerAdapter: createOpenRouterAdapter({
      fetchImpl: async () =>
        new Response(JSON.stringify({ created: 0, data: [{ b64_json: 'AAAA', media_type: 'image/png' }] }), {
          status: 200,
        }),
    }),
  });
  const storeForConfig = await testConfigStore(loaded);
  const reloader = new ConfigReloader({
    loaded,
    store: storeForConfig,
    modelSwitcher: new AgentModelSwitcher(storeForConfig),
    secrets: new SecretStore(keyJarPath(configPath)),
    imageConfig: {
      prepare: (candidate) => service.prepareConfig(candidate, new SecretStore(keyJarPath(configPath))),
      publish: (snapshot) => service.publishConfig(snapshot as Parameters<typeof service.publishConfig>[0]),
    },
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const tasks = new LongTaskService(store.orm, () => undefined);
  const bridge = createImageBridge({
    service,
    store,
    tasks,
    prepareInputImage: async () => ({ base64: '', mime: 'image/png' }),
  });
  const server = new AdminServer({
    store,
    configStore: storeForConfig,
    configReloader: reloader,
    secrets: new SecretStore(keyJarPath(configPath)),
    imageService: service,
    imageBridge: bridge,
  });
  const setup = await server.handle(
    new Request('http://admin.test/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ops', password: PASSWORD }),
    }),
  );
  const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(setup.status).toBe(200);
  cleanup.push(async () => {
    await service.stop();
    store.close();
  });
  return {
    server,
    cookie,
    configPath,
    revision: async () => {
      const res = await server.handle(new Request('http://admin.test/api/providers', { headers: { cookie } }));
      const body = (await res.json()) as { revision: string };
      return body.revision;
    },
  };
}

test('image config enable request answers JSON through the admin dispatch, not a rebuilt binary response', async () => {
  const app = await fixture();
  const models = [
    {
      id: 'gpt-image-1',
      name: 'GPT Image',
      provider: 'openrouter',
      upstreamModel: 'openai/gpt-image-1',
      credentialRef: 'openrouter',
      providerTag: 'openrouter',
      capabilities: {
        imageInput: true,
        maxInputImages: 4,
        maxOutputs: 4,
        aspectRatios: ['auto', '1:1'],
        resolutionClasses: ['auto', 'low', 'medium', 'high'],
      },
    },
  ];
  const res = await app.server.handle(
    new Request('http://admin.test/api/image/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: app.cookie, 'if-match': await app.revision() },
      body: JSON.stringify({ enabled: true, credentials: { openrouter: 'sk-or-test' }, models }),
    }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  const body = (await res.json()) as { enabled: boolean; apply: { applied: readonly string[] } };
  expect(body.enabled).toBe(true);
  expect(body.apply.applied).toContain('image');

  // The section landed in the file with jar references, never plaintext.
  const file = await (await import('node:fs/promises')).readFile(app.configPath, 'utf8');
  expect(file).toContain('"image":');
  expect(file).toContain('"jar"');
  expect(file).toContain('"openrouter"');
  expect(file).not.toContain('sk-or-test');
});

test('image content requests still stream the stored bytes with the asset mime', async () => {
  const app = await fixture();
  const created = await app.server.handle(
    new Request('http://admin.test/api/image/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: app.cookie, origin: 'http://admin.test' },
      body: JSON.stringify({ name: 'anime', body: 'anime style illustration' }),
    }),
  );
  expect(created.status).toBe(201);
  const listing = await app.server.handle(
    new Request('http://admin.test/api/image/prompts', { headers: { cookie: app.cookie } }),
  );
  const body = (await listing.json()) as { items: readonly { id: string }[] };
  expect(body.items.length).toBe(1);
});
