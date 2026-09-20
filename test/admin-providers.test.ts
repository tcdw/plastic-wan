import { afterEach, beforeAll, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { type FileConfig, type LoadedConfig, loadConfig, type ModelFileConfig } from '../src/platform/config.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { loadModelsDevCatalog, resetModelsDevCatalogCache } from '../src/platform/models-dev.ts';
import { createModelRegistry } from '../src/platform/providers.ts';
import { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/store/database.ts';
import { startFixtureServer, stopFixtureServer, testConfigJsonc, writeTestConfig } from './helpers.ts';

const PASSWORD = 'correct-horse-battery';
const directories: string[] = [];

/**
 * The catalog is a whole-catalog download, so the tests seed the module cache
 * with a fixture instead of reaching models.dev. A test that needs the catalog
 * to fail resets the cache and stubs `fetch` for that URL only.
 */
async function seedModelsDevCatalog(): Promise<void> {
  resetModelsDevCatalogCache();
  const fetchImpl = (async () =>
    Response.json({
      openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        models: {
          'deepseek/deepseek-v4-flash': {
            id: 'deepseek/deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            reasoning: true,
            interleaved: { field: 'reasoning_content' },
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 1_048_576, output: 384_000 },
            cost: { input: 0.03612, output: 0.07224, cache_read: 0.007224 },
          },
        },
      },
    })) as unknown as typeof fetch;
  await loadModelsDevCatalog({ fetchImpl, ttlMs: 600_000 });
}

beforeAll(async () => {
  await seedModelsDevCatalog();
});

afterEach(async () => {
  delete process.env.PLASTICWAN_SUPERVISED;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Fixture {
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly configPath: string;
  readonly directory: string;
  readonly cookie: string;
  readonly restarts: () => number;
  read(): Promise<string>;
  file(): FileConfig;
}

interface FixtureOptions {
  readonly transform?: (config: FileConfig) => void;
  readonly onRestart?: () => void;
}

async function adminFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-providers-'));
  directories.push(directory);
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
      const agent = config.providers.agent;
      if (agent?.kind === 'custom') {
        agent.headers = { 'x-route': 'header-secret-value' };
      }
      options.transform?.(config);
    }),
  );
  const loaded = await loadConfig(configPath);
  // Kept so the restart test can restore a loadable file after breaking it.
  await writeFile(join(directory, 'original.jsonc'), await readFile(configPath, 'utf8'));
  const configStore = new RuntimeConfigurationStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore();
  const registry = await createModelRegistry(loaded.config, secrets);
  const switcher = new AgentModelSwitcher(configStore, registry.models);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    models: registry.models,
    modelSwitcher: switcher,
    secrets,
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  let restarts = 0;
  const server = new AdminServer({
    store,
    configStore,
    modelSwitcher: switcher,
    configReloader: reloader,
    secrets,
    models: registry.models,
    requestRestart: () => {
      restarts += 1;
      options.onRestart?.();
    },
  });
  const setup = await server.handle(
    request('/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    }),
  );
  const cookie = sessionCookie(setup);
  return {
    store,
    server,
    loaded,
    configStore,
    configPath,
    directory,
    cookie,
    restarts: () => restarts,
    read: () => readFile(configPath, 'utf8'),
    file: () => JSON.parse(readFileSync(configPath, 'utf8')) as FileConfig,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

// The provider payloads are asserted structurally, so a loose type keeps the
// assertions readable.
async function readJson(response: Response): Promise<any> {
  return await response.json();
}

function model(id: string, overrides: Partial<ModelFileConfig> = {}): ModelFileConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    context_window: 128_000,
    max_tokens: 8_192,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
    ...overrides,
  };
}

async function revisionOf(fixture: Fixture): Promise<string> {
  const view = await readJson(await call(fixture, '/api/providers'));
  return view.revision as string;
}

function call(fixture: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  return fixture.server.handle(request(path, { ...init, headers: { ...init.headers, cookie: fixture.cookie } }));
}

function write(
  fixture: Fixture,
  path: string,
  method: string,
  body: unknown,
  revision: string | null = null,
): Promise<Response> {
  return call(fixture, path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(revision === null ? {} : { 'if-match': revision }),
    },
    body: JSON.stringify(body),
  });
}

test('lists providers without leaking keys or header values', async () => {
  const fixture = await adminFixture();
  try {
    const response = await call(fixture, '/api/providers');
    expect(response.status).toBe(200);
    const text = await response.clone().text();
    const view = await readJson(response);
    expect(view.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(view.supervised).toBe(false);
    expect(view.agent).toEqual({ provider: 'agent', model: 'agent-model' });
    expect(view.vision).toEqual({ provider: 'vision', model: 'vision-model' });
    expect(view.restart_required).toEqual([]);
    const agent = view.providers.find((entry: any) => entry.alias === 'agent');
    expect(agent).toMatchObject({ kind: 'custom', api: 'openai-responses', base_url: 'https://example.test/v1' });
    expect(agent.header_names).toEqual(['x-route']);
    expect(agent.models).toHaveLength(1);
    expect(agent.models[0]).toMatchObject({ id: 'agent-model', compat: { supports_developer_role: false } });

    // The whole response body, not just the fields under test.
    expect(text).not.toContain('agent-secret');
    expect(text).not.toContain('header-secret-value');
    expect(text).not.toContain('vision-secret');
  } finally {
    fixture.store.close();
  }
});

test('offers the builtin presets the configuration may reference', async () => {
  const fixture = await adminFixture();
  try {
    const view = await readJson(await call(fixture, '/api/provider-presets'));
    const ids = view.presets.map((preset: any) => preset.id);
    expect(ids).toContain('openrouter');
    expect(ids).toContain('google');
    // Rejected by the preset predicate: mixed APIs, an unsupported adapter, or
    // no concrete base URL.
    expect(ids).not.toContain('xai');
    expect(ids).not.toContain('mistral');
    expect(ids).not.toContain('google-vertex');
    const openrouter = view.presets.find((preset: any) => preset.id === 'openrouter');
    expect(openrouter).toMatchObject({
      api: 'openai-completions',
      base_url: 'https://openrouter.ai/api/v1',
    });
  } finally {
    fixture.store.close();
  }
});

test('requires a revision for every provider write', async () => {
  const fixture = await adminFixture();
  try {
    const missing = await write(fixture, '/api/providers', 'POST', { alias: 'relay' });
    expect(missing.status).toBe(400);
    expect(await readJson(missing)).toMatchObject({ error: 'revision_required' });

    const stale = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'relay',
        kind: 'custom',
        base_url: 'https://relay.example.test/v1',
        api: 'openai-completions',
        api_key: 'relay-secret',
        models: [model('relay-model')],
      },
      'f'.repeat(64),
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'config_conflict' });
    expect(fixture.file().providers.relay).toBeUndefined();

    const modelPut = await call(fixture, '/api/model', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'vision', model: 'vision-model' }),
    });
    expect(modelPut.status).toBe(400);
    expect(await readJson(modelPut)).toMatchObject({ error: 'revision_required' });
  } finally {
    fixture.store.close();
  }
});

test('creates, updates, and deletes a provider through the configuration file', async () => {
  const fixture = await adminFixture();
  try {
    const created = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'relay',
        kind: 'custom',
        base_url: 'https://relay.example.test/v1/',
        api: 'openai-completions',
        api_key: 'relay-secret',
        headers: { 'x-route': 'relay-header' },
        models: [model('relay-model', { input: ['text', 'image'] })],
      },
      await revisionOf(fixture),
    );
    expect(created.status).toBe(200);
    const createdView = await readJson(created);
    expect(createdView.apply.restart_required).toContain('providers.relay');
    const relay = createdView.providers.find((entry: any) => entry.alias === 'relay');
    expect(relay).toMatchObject({
      kind: 'custom',
      api: 'openai-completions',
      base_url: 'https://relay.example.test/v1',
      header_names: ['x-route'],
    });
    // Plaintext keys are written as literals and never echoed back.
    const text = await fixture.read();
    expect(text).toContain('relay-secret');
    expect(JSON.stringify(createdView)).not.toContain('relay-secret');
    expect(JSON.stringify(createdView)).not.toContain('relay-header');

    const duplicate = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'relay',
        kind: 'custom',
        base_url: 'https://relay.example.test/v1',
        api: 'openai-completions',
        api_key: 'other',
        models: [model('relay-model')],
      },
      await revisionOf(fixture),
    );
    expect(duplicate.status).toBe(409);
    expect(await readJson(duplicate)).toMatchObject({ error: 'provider_exists' });

    // Changing the address forces the credentials to be re-entered (C5).
    const withoutKey = await write(
      fixture,
      '/api/providers/relay',
      'PUT',
      { base_url: 'https://attacker.example.test/v1' },
      await revisionOf(fixture),
    );
    expect(withoutKey.status).toBe(400);
    expect(await readJson(withoutKey)).toMatchObject({ error: 'credentials_required' });
    expect(fixture.file().providers.relay).toMatchObject({ base_url: 'https://relay.example.test/v1' });

    const withKey = await write(
      fixture,
      '/api/providers/relay',
      'PUT',
      {
        base_url: 'https://relay.example.test/v2',
        api_key: 'relay-secret-2',
        headers: { 'x-route': 'relay-header-2' },
      },
      await revisionOf(fixture),
    );
    expect(withKey.status).toBe(200);
    // The provider itself is still restart-only inside this process, so the
    // reload reports the whole alias rather than the two connection fields.
    expect((await readJson(withKey)).apply.restart_required).toContain('providers.relay');
    const updated = fixture.file().providers.relay;
    expect(updated).toMatchObject({
      base_url: 'https://relay.example.test/v2',
      api_key: 'relay-secret-2',
      headers: { 'x-route': 'relay-header-2' },
    });

    // A header is dropped with `null`; the key stays when it is omitted.
    const dropped = await write(
      fixture,
      '/api/providers/relay',
      'PUT',
      { headers: { 'x-route': null } },
      await revisionOf(fixture),
    );
    expect(dropped.status).toBe(200);
    expect(fixture.file().providers.relay).not.toHaveProperty('headers');
    expect(fixture.file().providers.relay).toMatchObject({ api_key: 'relay-secret-2' });

    const removed = await write(fixture, '/api/providers/relay', 'DELETE', {}, await revisionOf(fixture));
    expect(removed.status).toBe(200);
    expect(fixture.file().providers.relay).toBeUndefined();
  } finally {
    fixture.store.close();
  }
});

test('refuses a builtin provider edit that is not its key', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.providers.builtin = {
        kind: 'builtin',
        provider: 'openrouter',
        api_key: 'builtin-secret',
        models: [model('deepseek/deepseek-v4-flash-0731')],
      };
    },
  });
  try {
    const view = await readJson(await call(fixture, '/api/providers'));
    const builtin = view.providers.find((entry: any) => entry.alias === 'builtin');
    expect(builtin).toMatchObject({
      kind: 'builtin',
      provider: 'openrouter',
      api: 'openai-completions',
      base_url: 'https://openrouter.ai/api/v1',
      header_names: [],
    });

    const rejected = await write(
      fixture,
      '/api/providers/builtin',
      'PUT',
      { api: 'anthropic-messages' },
      await revisionOf(fixture),
    );
    expect(rejected.status).toBe(400);
    expect(await readJson(rejected)).toMatchObject({ error: 'immutable_field' });

    const key = await write(
      fixture,
      '/api/providers/builtin',
      'PUT',
      { api_key: 'rotated' },
      await revisionOf(fixture),
    );
    expect(key.status).toBe(200);
    expect(fixture.file().providers.builtin).toMatchObject({ api_key: 'rotated' });
  } finally {
    fixture.store.close();
  }
});

test('protects the providers and models that are in use', async () => {
  const fixture = await adminFixture();
  try {
    const provider = await write(fixture, '/api/providers/agent', 'DELETE', {}, await revisionOf(fixture));
    expect(provider.status).toBe(409);
    expect(await readJson(provider)).toMatchObject({ error: 'provider_in_use' });

    const inUseModel = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'DELETE',
      {},
      await revisionOf(fixture),
    );
    expect(inUseModel.status).toBe(409);
    expect(await readJson(inUseModel)).toMatchObject({ error: 'model_in_use' });

    const added = await write(
      fixture,
      '/api/providers/agent/models',
      'POST',
      { models: [model('agent-extra')] },
      await revisionOf(fixture),
    );
    expect(added.status).toBe(200);
    expect(await readJson(added)).toMatchObject({ apply: { applied: ['providers.agent.models[agent-extra]'] } });

    const duplicate = await write(
      fixture,
      '/api/providers/agent/models',
      'POST',
      { models: [model('agent-extra')] },
      await revisionOf(fixture),
    );
    expect(duplicate.status).toBe(409);
    expect(await readJson(duplicate)).toMatchObject({ error: 'model_exists' });

    const replaced = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'PUT',
      model('agent-model', { context_window: 300_000 }),
      await revisionOf(fixture),
    );
    expect(replaced.status).toBe(200);
    expect(await readJson(replaced)).toMatchObject({
      apply: { restart_required: ['providers.agent.models[agent-model]'] },
    });

    const mismatch = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'PUT',
      model('other-model'),
      await revisionOf(fixture),
    );
    expect(mismatch.status).toBe(400);
    expect(await readJson(mismatch)).toMatchObject({ error: 'invalid_model_id' });

    const removed = await write(
      fixture,
      '/api/providers/agent/models/agent-extra',
      'DELETE',
      {},
      await revisionOf(fixture),
    );
    expect(removed.status).toBe(200);
    expect(await readJson(removed)).toMatchObject({ apply: { applied: ['providers.agent.models[agent-extra]'] } });
  } finally {
    fixture.store.close();
  }
});

test('discovers models in saved mode from the registry connection', async () => {
  const upstream = await startFixtureServer((incoming) => {
    expect(new URL(incoming.url).pathname).toBe('/v1/models');
    expect(incoming.headers.get('authorization')).toBe('Bearer agent-secret');
    expect(incoming.headers.get('x-route')).toBe('header-secret-value');
    return Response.json({
      object: 'list',
      data: [
        {
          id: 'agent-model',
          name: 'Agent Model',
          context_length: 200_000,
          top_provider: { max_completion_tokens: 32_768 },
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['reasoning'],
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
        { id: 'fresh-model', name: 'Fresh', context_length: 100_000, top_provider: { max_completion_tokens: 4_096 } },
      ],
    });
  });
  const fixture = await adminFixture({
    transform: (config) => {
      const agent = config.providers.agent;
      if (agent?.kind !== 'custom') {
        throw new Error('Expected a custom agent provider');
      }
      agent.base_url = `http://127.0.0.1:${upstream.port}/v1`;
    },
  });
  try {
    const discovered = await write(fixture, '/api/providers/discover', 'POST', { alias: 'agent' });
    expect(discovered.status).toBe(200);
    const body = await readJson(discovered);
    expect(body.endpoint).toBe(`http://127.0.0.1:${upstream.port}/v1/models`);
    expect(body.metadata_source_error).toBeNull();
    const existing = body.models.find((entry: any) => entry.id === 'agent-model');
    expect(existing).toMatchObject({ configured: true });
    // The fixture endpoint is OpenAI-shaped without extensions, so only
    // models.dev could have filled the limits, and it does not know this id.
    expect(existing.context_window).toBeNull();
    expect(existing.sources.context_window).toBe('missing');
    const fresh = body.models.find((entry: any) => entry.id === 'fresh-model');
    expect(fresh).toMatchObject({ configured: false });
    expect(fresh.needs_confirmation).toContain('input');

    // A pending connection change must not send the old credentials to a new
    // address, so discovery refuses until the restart.
    const changed = await write(
      fixture,
      '/api/providers/agent',
      'PUT',
      { base_url: `http://127.0.0.1:${upstream.port}/v2`, api_key: 'agent-secret', headers: { 'x-route': 'r' } },
      await revisionOf(fixture),
    );
    expect(changed.status).toBe(200);
    const pending = await write(fixture, '/api/providers/discover', 'POST', { alias: 'agent' });
    expect(pending.status).toBe(409);
    expect(await readJson(pending)).toMatchObject({ error: 'restart_pending' });
  } finally {
    fixture.store.close();
    await stopFixtureServer(upstream.server);
  }
});

test('redacts an upstream error that echoes the submitted key', async () => {
  const upstream = await startFixtureServer(() =>
    Response.json({ error: { message: 'invalid key: temporary-secret' } }, { status: 401 }),
  );
  const fixture = await adminFixture();
  try {
    const response = await write(fixture, '/api/providers/discover', 'POST', {
      kind: 'custom',
      base_url: `http://127.0.0.1:${upstream.port}/v1`,
      api: 'openai-completions',
      api_key: 'temporary-secret',
    });
    expect(response.status).toBe(502);
    const body = await readJson(response);
    expect(body.error).toBe('provider_discovery_failed');
    expect(body.message).toContain('[REDACTED]');
    expect(body.message).not.toContain('temporary-secret');
  } finally {
    fixture.store.close();
    await stopFixtureServer(upstream.server);
  }
});

test('checks the vision model before writing it', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      const agent = config.providers.agent;
      if (agent?.kind !== 'custom') {
        throw new Error('Expected a custom agent provider');
      }
      agent.models.push({
        id: 'tiny-vision',
        name: 'Tiny Vision',
        reasoning: false,
        input: ['text', 'image'],
        context_window: 4_096,
        max_tokens: 1_024,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      });
      agent.models.push({
        id: 'text-only',
        name: 'Text Only',
        reasoning: false,
        input: ['text'],
        context_window: 200_000,
        max_tokens: 32_768,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      });
    },
  });
  try {
    const revision = await revisionOf(fixture);
    const missing = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'ghost' }, revision);
    expect(missing.status).toBe(400);
    expect(await readJson(missing)).toMatchObject({ error: 'unknown_model' });

    const textOnly = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'text-only' }, revision);
    expect(textOnly.status).toBe(400);
    expect(await readJson(textOnly)).toMatchObject({ error: 'not_image_capable' });

    const tooSmall = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'tiny-vision' }, revision);
    expect(tooSmall.status).toBe(400);
    expect(await readJson(tooSmall)).toMatchObject({ error: 'max_output_tokens_exceeded' });

    const ok = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'agent-model' }, revision);
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toMatchObject({ apply: { restart_required: ['vision.model', 'vision.provider'] } });
    expect(fixture.file().vision).toMatchObject({ provider: 'agent', model: 'agent-model' });
    // The running process keeps the old vision model until it restarts.
    expect(fixture.configStore.current().config.vision).toMatchObject({ provider: 'vision', model: 'vision-model' });
  } finally {
    fixture.store.close();
  }
});

test('restarts only when the deployment declares a supervisor and the file loads', async () => {
  let restarts = 0;
  const fixture = await adminFixture({ onRestart: () => (restarts += 1) });
  try {
    const unsupervised = await call(fixture, '/api/restart', { method: 'POST' });
    expect(unsupervised.status).toBe(409);
    expect(await readJson(unsupervised)).toMatchObject({ error: 'restart_unsupported' });
    expect(restarts).toBe(0);

    process.env.PLASTICWAN_SUPERVISED = '1';
    await writeFile(fixture.configPath, '{ "version": 1 }');
    const invalid = await call(fixture, '/api/restart', { method: 'POST' });
    expect(invalid.status).toBe(422);
    expect(await readJson(invalid)).toMatchObject({ error: 'config_invalid' });
    expect(restarts).toBe(0);

    await writeFile(fixture.configPath, await readFile(join(fixture.directory, 'original.jsonc'), 'utf8'));
    const restarted = await call(fixture, '/api/restart', { method: 'POST' });
    expect(restarted.status).toBe(202);
    expect(await readJson(restarted)).toEqual({ status: 'restarting' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(restarts).toBe(1);
  } finally {
    fixture.store.close();
  }
});

test('still lists models when the models.dev catalog is unreachable', async () => {
  const upstream = await startFixtureServer(() =>
    Response.json({
      object: 'list',
      data: [{ id: 'fresh-model', name: 'Fresh' }],
    }),
  );
  const fixture = await adminFixture();
  const originalFetch = globalThis.fetch;
  try {
    resetModelsDevCatalogCache();
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('models.dev')) {
        return Promise.reject(new Error('models.dev is unreachable'));
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const response = await write(fixture, '/api/providers/discover', 'POST', {
      kind: 'custom',
      base_url: `http://127.0.0.1:${upstream.port}/v1`,
      api: 'openai-completions',
      api_key: 'temporary-secret',
    });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.endpoint).toBe(`http://127.0.0.1:${upstream.port}/v1/models`);
    expect(body.metadata_source_error).toContain('models.dev is unreachable');
    // The listing survives; only the metadata models.dev would have supplied is
    // missing, and the admin confirms it in the edit dialog.
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({ id: 'fresh-model', context_window: null });
    expect(body.models[0].needs_confirmation).toContain('context_window');

    const lookup = await write(fixture, '/api/providers/lookup-metadata', 'POST', {
      kind: 'custom',
      base_url: 'https://relay.example.test/v1',
      api: 'openai-completions',
      ids: ['some-model'],
    });
    expect(lookup.status).toBe(200);
    const lookupBody = await readJson(lookup);
    expect(lookupBody.metadata_source_error).toContain('models.dev is unreachable');
    expect(lookupBody.models[0].sources.context_window).toBe('missing');
  } finally {
    globalThis.fetch = originalFetch;
    fixture.store.close();
    await stopFixtureServer(upstream.server);
    await seedModelsDevCatalog();
  }
});

test('rejects cross-origin provider writes', async () => {
  const fixture = await adminFixture();
  try {
    const response = await fixture.server.handle(
      request('/api/providers', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: fixture.cookie,
          origin: 'http://evil.example.test',
        },
        body: JSON.stringify({ alias: 'relay' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({ error: 'bad_origin' });
  } finally {
    fixture.store.close();
  }
});
