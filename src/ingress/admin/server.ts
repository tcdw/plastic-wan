import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import type { Models, ModelThinkingLevel } from '@earendil-works/pi-ai';
import { assertConfigPermissions, loadConfig, type RawConfig } from '../../platform/config.ts';
import type { ConfigErrorCode, ConfigReloader } from '../../platform/config-reload.ts';
import { type ConfigEdit, readConfigRevision } from '../../platform/config-file.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import type { SqliteStore } from '../../store/database.ts';
import { DEFAULT_MEMORY_TTL_WARNING_DAYS } from '../../context/memory.ts';
import type { AgentModelOption, AgentModelSwitcher } from '../../platform/model-switch.ts';
import type { BucketScheduler } from '../../orchestration/scheduler.ts';
import { wakeFromSleep } from '../../store/sleep.ts';
import { addBotAdmin, listBotAdmins, parseAdminUserId, removeBotAdmin } from '../../store/admins.ts';
import { cancelAlarm, listAlarms, parseAlarmId } from './alarm-admin.ts';
import {
  AdminQueryError,
  getConversationContext,
  getInvocation,
  getMessage,
  type ListQuery,
  listConversationContexts,
  listInvocations,
  listMessages,
  listStickerSets,
  listStickers,
  overview,
  parseId,
  usage,
} from './audit.ts';
import { AdminAuth, AdminAuthError, type AdminCredentials } from './auth.ts';
import {
  createMemory,
  deleteMemory,
  listMemories,
  listMemoryChats,
  parseCreateMemoryBody,
  parseMemoryId,
  parseUpdateMemoryBody,
  updateMemory,
} from './memory-admin.ts';
import { cancelPendingSessions } from './operations.ts';
import {
  appendModels,
  createProvider,
  deleteModel,
  deleteProvider,
  discover,
  listProviderPresets,
  listProviders,
  lookupMetadata,
  parseAlias,
  parseCreateProviderBody,
  parseDiscoverBody,
  parseLookupMetadataBody,
  parseModelBody,
  parseModelsBody,
  parseUpdateProviderBody,
  parseThinkingLevelBody,
  parseVisionBody,
  type ProviderWriteContext,
  PROVIDER_BODY_MAX_BYTES,
  replaceModel,
  supervisedRestartEnabled,
  updateProvider,
  thinkingLevelEdits,
  visionEdits,
} from './providers-admin.ts';

const SESSION_COOKIE = 'plasticwan_admin';
const MAX_BODY_BYTES = 8_192;
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export type AdminConfig = NonNullable<RawConfig['admin']>;

export interface AdminServerOptions {
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly scheduler?: BucketScheduler;
  readonly modelSwitcher?: AgentModelSwitcher;
  readonly configReloader?: ConfigReloader;
  /** Registers panel-supplied plaintext secrets before they are written or sent. */
  readonly secrets?: SecretStore;
  /** The live model registry, used for saved-mode provider discovery. */
  readonly models?: Models;
  /** Starts the graceful shutdown that exits with the restart code. */
  readonly requestRestart?: () => void;
}

/** Model reference problems are user errors; everything else is a conflict. */
const MODEL_ERROR_STATUS: Partial<Record<ConfigErrorCode, number>> = {
  unknown_provider: 400,
  unknown_model: 400,
  not_text_capable: 400,
  model_unusable: 400,
};

/** Write failures the panel can act on, versus the ones that need an operator. */
const CONFIG_WRITE_STATUS: Partial<Record<ConfigErrorCode, number>> = {
  config_conflict: 409,
  config_invalid: 422,
  config_permissions: 409,
  config_symlink: 409,
  config_write_failed: 500,
};

export class AdminServer {
  readonly #store: SqliteStore;
  readonly #admin: AdminConfig;
  readonly #auth: AdminAuth;
  readonly #scheduler: BucketScheduler | undefined;
  readonly #modelSwitcher: AgentModelSwitcher | undefined;
  readonly #configReloader: ConfigReloader | undefined;
  readonly #secrets: SecretStore | undefined;
  readonly #models: Models | undefined;
  readonly #requestRestart: (() => void) | undefined;
  readonly #staticDir: string;
  readonly #memoryWarningDays: number;
  #server: ServerType | undefined;

  constructor(options: AdminServerOptions) {
    const config = options.configStore.current().config;
    const admin = config.admin;
    if (admin === undefined) {
      throw new Error('Admin panel is not configured');
    }
    this.#store = options.store;
    this.#admin = admin;
    this.#auth = new AdminAuth(options.store.orm, admin.session_ttl_hours);
    this.#scheduler = options.scheduler;
    this.#modelSwitcher = options.modelSwitcher;
    this.#configReloader = options.configReloader;
    this.#secrets = options.secrets;
    this.#models = options.models;
    this.#requestRestart = options.requestRestart;
    this.#staticDir = resolve(
      admin.static_dir ?? join(import.meta.dirname, '..', '..', '..', 'apps', 'admin-next', 'dist'),
    );
    this.#memoryWarningDays = config.agent.memory_ttl_warning_days ?? DEFAULT_MEMORY_TTL_WARNING_DAYS;
  }

  async start(): Promise<{ readonly hostname: string; readonly port: number }> {
    if (this.#server !== undefined) {
      throw new Error('Admin server is already listening');
    }
    this.#auth.purgeExpired();
    const server = serve({
      fetch: (request) => this.handle(request),
      hostname: this.#admin.host,
      port: this.#admin.port,
      serverOptions: {
        // Idle header waiting and idle keep-alive sockets are cut at 30s, while
        // slow but actively streaming responses are not interrupted.
        headersTimeout: 30_000,
        keepAliveTimeout: 30_000,
      },
    });
    this.#server = server;
    try {
      // @hono/node-server binds asynchronously, so wait for the event before
      // treating the panel as listening. The error listener surfaces bind
      // failures such as EADDRINUSE instead of leaving only an unhandled
      // 'error' event on stderr.
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    } catch (error) {
      this.#server = undefined;
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Admin server did not report a listening address');
    }
    return { hostname: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) {
      return;
    }
    await closeServer(server);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    try {
      if (segments[0] === 'api') {
        return await this.#api(request, url, segments.slice(1));
      }
      return await this.#staticAsset(request, segments);
    } catch (error) {
      if (error instanceof AdminAuthError || error instanceof AdminQueryError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      console.error(
        JSON.stringify({
          event: 'admin_request_failed',
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        }),
      );
      return json({ error: 'internal_error', message: 'Admin request failed' }, 500);
    }
  }

  async #api(request: Request, url: URL, segments: readonly string[]): Promise<Response> {
    if (
      request.method !== 'GET' &&
      request.method !== 'POST' &&
      request.method !== 'PUT' &&
      request.method !== 'DELETE'
    ) {
      return json({ error: 'method_not_allowed', message: 'Unsupported method' }, 405);
    }
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE') {
      const origin = request.headers.get('origin');
      if (origin !== null && new URL(origin).host !== url.host) {
        return json({ error: 'bad_origin', message: 'Cross-origin admin requests are rejected' }, 403);
      }
    }
    const route = segments.join('/');
    if (route === 'auth/session' && request.method === 'GET') {
      const session = this.#auth.authenticate(readCookie(request, SESSION_COOKIE));
      return json({
        setup_required: this.#auth.setupRequired(),
        authenticated: session !== null,
        username: session?.username ?? null,
        expires_at: session?.expiresAt ?? null,
      });
    }
    if (route === 'auth/setup' && request.method === 'POST') {
      const token = await this.#auth.createFirstUser(await readCredentials(request));
      return json({ status: 'ok' }, 200, this.#sessionCookie(token));
    }
    if (route === 'auth/login' && request.method === 'POST') {
      const clientKey = request.headers.get('x-forwarded-for') ?? 'local';
      const token = await this.#auth.login(await readCredentials(request), new Date(), clientKey);
      return json({ status: 'ok' }, 200, this.#sessionCookie(token));
    }
    if (route === 'auth/logout' && request.method === 'POST') {
      this.#auth.logout(readCookie(request, SESSION_COOKIE));
      return json({ status: 'ok' }, 200, `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    }
    const session = this.#auth.authenticate(readCookie(request, SESSION_COOKIE));
    if (session === null) {
      return json({ error: 'unauthenticated', message: 'Admin session is required' }, 401);
    }
    if (route === 'auth/credentials' && request.method === 'POST') {
      const token = await this.#auth.changeCredentials(session.userId, await readCredentials(request));
      return json({ status: 'ok' }, 200, this.#sessionCookie(token));
    }
    if (route === 'cancel-pending-sessions' && request.method === 'POST') {
      const result = cancelPendingSessions(this.#store.orm, new Date());
      this.#scheduler?.wake();
      return json(result);
    }
    if (route === 'wake' && request.method === 'POST') {
      const wasSleeping = wakeFromSleep(this.#store.orm);
      if (wasSleeping) {
        this.#scheduler?.wake();
      }
      return json({ status: 'awake', was_sleeping: wasSleeping });
    }
    const query: ListQuery = {
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      state: url.searchParams.get('state'),
      chat: url.searchParams.get('chat'),
      set: url.searchParams.get('set'),
      search: url.searchParams.get('search'),
      target: url.searchParams.get('target'),
    };
    if (route === 'memories' && request.method === 'GET') {
      return json(listMemories(this.#store.orm, query, this.#memoryWarningDays));
    }
    if (route === 'memories' && request.method === 'POST') {
      const body = parseCreateMemoryBody(await readJsonObject(request));
      return json(createMemory(this.#store.orm, body, this.#memoryWarningDays));
    }
    if (route === 'memories/chats' && request.method === 'GET') {
      return json({ items: listMemoryChats(this.#store.orm) });
    }
    if (segments[0] === 'memories' && segments.length === 2) {
      if (segments[1] === 'chats') {
        return json({ error: 'method_not_allowed', message: 'Memories chat options are read-only' }, 405);
      }
      const id = parseMemoryId(segments[1] ?? '');
      if (request.method === 'PUT') {
        const body = parseUpdateMemoryBody(await readJsonObject(request));
        return json(updateMemory(this.#store.orm, id, body, this.#memoryWarningDays));
      }
      if (request.method === 'DELETE') {
        deleteMemory(this.#store.orm, id);
        return json({ status: 'ok' });
      }
    }
    if (route === 'admins' && request.method === 'GET') {
      return json({ items: listBotAdmins(this.#store.orm) });
    }
    if (route === 'admins' && request.method === 'POST') {
      const body = await readJsonObject(request);
      return json(addBotAdmin(this.#store.orm, parseAdminUserId(body.telegram_user_id), 'admin-panel'));
    }
    if (segments[0] === 'admins' && segments.length === 2 && request.method === 'DELETE') {
      removeBotAdmin(this.#store.orm, parseAdminUserId(segments[1] ?? '', 'admin_id'));
      return json({ status: 'ok' });
    }
    if (segments[0] === 'alarms' && segments.length === 2 && request.method === 'DELETE') {
      const id = parseAlarmId(segments[1] ?? '');
      const result = cancelAlarm(this.#store.orm, id, session.username);
      this.#scheduler?.wake();
      return json(result);
    }
    if (route === 'model') {
      const switcher = this.#modelSwitcher;
      const reloader = this.#configReloader;
      if (switcher === undefined || reloader === undefined) {
        return json({ error: 'model_switch_unavailable', message: 'Runtime model switching is not wired' }, 503);
      }
      // `GET /model` was removed with the Model page: the Models page reads the
      // file view from `GET /providers` and gets the live model back from here.
      if (request.method === 'PUT') {
        const revision = requiredRevision(request);
        if (revision === null) {
          return revisionRequired();
        }
        const body = await readJsonObject(request);
        if (typeof body.provider !== 'string' || typeof body.model !== 'string') {
          return json({ error: 'invalid_model_reference', message: 'provider and model must be strings' }, 400);
        }
        const result = await reloader.setAgentModel(body.provider, body.model, revision);
        if (!result.ok) {
          const status = MODEL_ERROR_STATUS[result.code] ?? 409;
          const message = result.fileWritten
            ? `config.jsonc was updated but not applied: ${result.message}`
            : result.message;
          return json({ error: result.code, message }, status);
        }
        return json({
          ...this.#modelState(switcher, switcher.current()),
          apply: { applied: result.applied, restart_required: result.restartRequired },
        });
      }
    }
    if (route === 'provider-presets' && request.method === 'GET') {
      return json({ presets: listProviderPresets() });
    }
    if (segments[0] === 'providers') {
      return await this.#providers(request, segments);
    }
    if (route === 'vision' && request.method === 'PUT') {
      const body = parseVisionBody(await readJsonObject(request));
      return await this.#providerWrite(request, (context) => visionEdits(context, body));
    }
    if (route === 'thinking-level' && request.method === 'PUT') {
      const body = parseThinkingLevelBody(await readJsonObject(request));
      return await this.#providerWrite(request, (context) => thinkingLevelEdits(context, body));
    }
    if (route === 'restart' && request.method === 'POST') {
      return await this.#restart();
    }
    if (route === 'config/apply' && request.method === 'POST') {
      const reloader = this.#configReloader;
      if (reloader === undefined) {
        return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
      }
      const result = await reloader.reloadFromFile();
      if (!result.ok) {
        return json({ error: result.code, message: result.message }, 422);
      }
      return json({
        status: 'applied',
        applied: result.applied,
        restart_required: result.restartRequired,
        outside_serve: result.outsideServe,
        generation: result.status.generation,
        active_hash: result.status.activeHash,
        file_hash: result.status.fileHash,
      });
    }
    if (route === 'config/status' && request.method === 'GET') {
      const reloader = this.#configReloader;
      if (reloader === undefined) {
        return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
      }
      const status = reloader.status();
      return json({
        generation: status.generation,
        active_hash: status.activeHash,
        file_hash: status.fileHash,
        restart_required: status.restartRequired,
        last_error: status.lastError,
      });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method_not_allowed', message: 'Audit routes are read-only' }, 405);
    }
    if (route === 'overview') {
      return json(overview(this.#store.orm));
    }
    if (route === 'alarms') {
      return json(listAlarms(this.#store.orm, query));
    }
    if (route === 'usage') {
      const daysParam = url.searchParams.get('days');
      const days = daysParam === null ? 7 : Number.parseInt(daysParam, 10);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        return json({ error: 'invalid_days', message: 'days must be an integer between 1 and 90' }, 400);
      }
      return json(usage(this.#store.orm, days));
    }
    if (route === 'invocations') {
      return json(listInvocations(this.#store.orm, query));
    }
    if (segments[0] === 'invocations' && segments.length === 2) {
      const found = getInvocation(this.#store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null ? json({ error: 'not_found', message: 'Invocation does not exist' }, 404) : json(found);
    }
    if (route === 'contexts') {
      return json(listConversationContexts(this.#store.orm, query));
    }
    if (segments[0] === 'contexts' && segments.length === 2) {
      const found = getConversationContext(this.#store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null
        ? json({ error: 'not_found', message: 'Conversation context does not exist' }, 404)
        : json(found);
    }
    if (route === 'messages') {
      return json(listMessages(this.#store.orm, query));
    }
    if (segments[0] === 'messages' && segments.length === 2) {
      const found = getMessage(this.#store.orm, parseId(segments[1] ?? '', 'id'));
      return found === null ? json({ error: 'not_found', message: 'Message does not exist' }, 404) : json(found);
    }
    if (route === 'sticker-sets') {
      return json({ items: listStickerSets(this.#store.orm) });
    }
    if (route === 'stickers') {
      return json(listStickers(this.#store.orm, query));
    }
    return json({ error: 'not_found', message: 'Unknown admin API route' }, 404);
  }

  /**
   * `/api/providers` — the model manager's read and write surface.
   *
   * Model ids may contain `/`, so the path is split on `/` first and each segment
   * is decoded afterwards: `PUT /providers/:alias/models/:id` only matches when
   * the client encoded the id.
   */
  async #providers(request: Request, segments: readonly string[]): Promise<Response> {
    const reloader = this.#configReloader;
    if (reloader === undefined || this.#secrets === undefined || this.#models === undefined) {
      return json({ error: 'providers_unavailable', message: 'Provider management is not wired' }, 503);
    }
    const parts = decodeSegments(segments);
    if (parts === null) {
      return json({ error: 'invalid_path', message: 'Path segments must be valid percent-encoded UTF-8' }, 400);
    }
    const second = parts[1];
    const third = parts[2];
    const fourth = parts[3];
    // Checked before the body is parsed, so a missing revision is reported as
    // such even when the payload is malformed too. Discovery and metadata lookup
    // write nothing and therefore need no revision.
    const readShapedPost = parts.length === 2 && (second === 'discover' || second === 'lookup-metadata');
    if (request.method !== 'GET' && !readShapedPost && requiredRevision(request) === null) {
      return revisionRequired();
    }
    if (parts.length === 1 && request.method === 'GET') {
      return json(await this.#providersView(reloader));
    }
    if (parts.length === 1 && request.method === 'POST') {
      const body = parseCreateProviderBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await this.#providerWrite(request, (context) => createProvider(context, body));
    }
    if (parts.length === 2 && second === 'discover' && request.method === 'POST') {
      const body = parseDiscoverBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await this.#providerResponse((context) => discover(context, body));
    }
    if (parts.length === 2 && second === 'lookup-metadata' && request.method === 'POST') {
      const body = parseLookupMetadataBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await this.#providerResponse((context) => lookupMetadata(body, context.secrets));
    }
    if (parts.length === 2 && second !== undefined && request.method === 'PUT') {
      const alias = parseAlias(second);
      const body = parseUpdateProviderBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await this.#providerWrite(request, (context) => updateProvider(context, alias, body));
    }
    if (parts.length === 2 && second !== undefined && request.method === 'DELETE') {
      const alias = parseAlias(second);
      return await this.#providerWrite(request, (context) => deleteProvider(context, alias));
    }
    if (parts.length === 3 && second !== undefined && third === 'models' && request.method === 'POST') {
      const alias = parseAlias(second);
      const models = parseModelsBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await this.#providerWrite(request, (context) => appendModels(context, alias, models));
    }
    if (parts.length === 4 && second !== undefined && third === 'models' && fourth !== undefined) {
      const alias = parseAlias(second);
      if (request.method === 'PUT') {
        const model = parseModelBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
        return await this.#providerWrite(request, (context) => replaceModel(context, alias, fourth, model));
      }
      if (request.method === 'DELETE') {
        return await this.#providerWrite(request, (context) => deleteModel(context, alias, fourth));
      }
    }
    return json({ error: 'not_found', message: 'Unknown providers route' }, 404);
  }

  /**
   * A write endpoint: the file is read for the prechecks, the edits are applied
   * inside the reloader's lock, and the response carries both the apply summary
   * and the refreshed view so the panel needs no second round trip.
   */
  async #providerWrite(
    request: Request,
    build: (context: ProviderWriteContext) => Promise<ConfigEdit[]> | ConfigEdit[],
  ): Promise<Response> {
    const reloader = this.#configReloader;
    const secrets = this.#secrets;
    if (reloader === undefined || secrets === undefined) {
      return json({ error: 'providers_unavailable', message: 'Provider management is not wired' }, 503);
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    let context: ProviderWriteContext;
    try {
      context = await this.#providerContext(reloader);
    } catch (error) {
      return json({ error: 'config_invalid', message: this.#redact(error) }, 422);
    }
    let edits: readonly ConfigEdit[];
    try {
      edits = await build(context);
    } catch (error) {
      if (error instanceof AdminQueryError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      return json({ error: 'provider_write_failed', message: this.#redact(error) }, 500);
    }
    const result = await reloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    return json({
      ...(await this.#providersView(reloader)),
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  }

  /** A read-shaped POST: provider discovery and metadata lookup write nothing. */
  async #providerResponse(build: (context: ProviderWriteContext) => Promise<unknown>): Promise<Response> {
    const reloader = this.#configReloader;
    const secrets = this.#secrets;
    if (reloader === undefined || secrets === undefined) {
      return json({ error: 'providers_unavailable', message: 'Provider management is not wired' }, 503);
    }
    let context: ProviderWriteContext;
    try {
      context = await this.#providerContext(reloader);
    } catch (error) {
      return json({ error: 'config_invalid', message: this.#redact(error) }, 422);
    }
    try {
      return json(await build(context));
    } catch (error) {
      if (error instanceof AdminQueryError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      // Upstream failures echo the request, key included.
      return json({ error: 'provider_discovery_failed', message: this.#redact(error) }, 502);
    }
  }

  async #providerContext(reloader: ConfigReloader): Promise<ProviderWriteContext> {
    const secrets = this.#secrets;
    const models = this.#models;
    if (secrets === undefined || models === undefined) {
      throw new Error('Provider management is not wired');
    }
    const loaded = await loadConfig(reloader.configPath);
    return {
      file: loaded.fileConfig,
      secrets,
      models,
      restartRequired: reloader.status().restartRequired,
    };
  }

  /**
   * The panel reads the file, not the active configuration: a pending restart
   * must be visible as what is on disk, and the revision is the file's own.
   */
  async #providersView(reloader: ConfigReloader): Promise<ReturnType<typeof listProviders>> {
    let loaded: Awaited<ReturnType<typeof loadConfig>>;
    try {
      loaded = await loadConfig(reloader.configPath);
    } catch (error) {
      throw new AdminQueryError('config_invalid', this.#redact(error), 422);
    }
    const revision = await readConfigRevision(reloader.configPath);
    return listProviders(loaded.fileConfig, revision, reloader.status().restartRequired);
  }

  /**
   * Restarts `serve` by exiting with a dedicated code, once the configuration on
   * disk is known to load. A process that cannot come back up stops the bot
   * until an operator intervenes, so this check is not optional.
   */
  async #restart(): Promise<Response> {
    if (!supervisedRestartEnabled()) {
      return json(
        {
          error: 'restart_unsupported',
          message:
            'This deployment does not declare an external supervisor; set PLASTICWAN_SUPERVISED=1 when something restarts the process',
        },
        409,
      );
    }
    const reloader = this.#configReloader;
    const requestRestart = this.#requestRestart;
    if (reloader === undefined || requestRestart === undefined) {
      return json({ error: 'restart_unavailable', message: 'Restarting is not wired' }, 503);
    }
    try {
      await assertConfigPermissions(reloader.configPath);
      await loadConfig(reloader.configPath);
    } catch (error) {
      return json({ error: 'config_invalid', message: this.#redact(error) }, 422);
    }
    // The response has to leave the socket before the shutdown closes it, and
    // `stop()` destroys live connections rather than draining them. Two things
    // keep the 202 intact: the adaptor writes it while resolving this promise,
    // which runs before the `setImmediate` callback, and `serve`'s shutdown only
    // reaches `admin.stop()` after `bot.stop()` has unblocked long polling. The
    // second one is a property of the caller, so `requestRestart` states it too.
    setImmediate(() => requestRestart());
    return json({ status: 'restarting' }, 202);
  }

  #redact(error: unknown): string {
    const message = messageOf(error);
    return this.#secrets === undefined ? message : this.#secrets.redact(message);
  }

  #modelState(
    switcher: AgentModelSwitcher,
    current: AgentModelOption,
  ): {
    readonly current: {
      readonly provider: string;
      readonly model: string;
      readonly name: string;
      readonly context_window: number;
      readonly max_tokens: number;
      readonly thinking_level: ModelThinkingLevel;
    };
    readonly options: readonly { readonly provider: string; readonly model: string; readonly name: string }[];
  } {
    return {
      current: {
        provider: current.provider,
        model: current.model,
        name: current.name,
        context_window: current.contextWindow,
        max_tokens: current.maxTokens,
        thinking_level: switcher.thinkingLevel(),
      },
      options: switcher.list().map((option) => ({
        provider: option.provider,
        model: option.model,
        name: option.name,
      })),
    };
  }

  async #staticAsset(request: Request, segments: readonly string[]): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed', message: 'Only GET and HEAD are supported' }, 405);
    }
    const relative = segments.length === 0 ? 'index.html' : segments.join('/');
    const candidate = resolve(this.#staticDir, relative);
    if (candidate !== this.#staticDir && !candidate.startsWith(this.#staticDir + sep)) {
      return json({ error: 'not_found', message: 'Asset does not exist' }, 404);
    }
    const direct = await readAsset(candidate);
    if (direct !== undefined) {
      return asset(direct, candidate);
    }
    const indexPath = join(this.#staticDir, 'index.html');
    const index = await readAsset(indexPath);
    if (index !== undefined) {
      return asset(index, indexPath);
    }
    return json(
      {
        error: 'admin_bundle_missing',
        message: `Admin bundle is absent: ${this.#staticDir}. Run pnpm run admin:build.`,
      },
      503,
    );
  }

  #sessionCookie(token: string): string {
    const maxAge = Math.floor(this.#auth.sessionTtlMs / 1000);
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  }
}

/**
 * Decodes the path segments, or `null` when one of them is not valid
 * percent-encoding. A malformed id is the caller's mistake, not a server fault,
 * so it must not surface as `internal_error`.
 */
function decodeSegments(segments: readonly string[]): string[] | null {
  try {
    return segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/**
 * The revision of the configuration the caller last read, from `If-Match`.
 * Surrounding quotes and a weak prefix are accepted so an ETag-shaped header
 * works as well as the bare digest.
 */
function requiredRevision(request: Request): string | null {
  const header = request.headers.get('if-match');
  if (header === null) {
    return null;
  }
  const revision = header.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return revision.length === 0 ? null : revision;
}

function revisionRequired(): Response {
  return json(
    { error: 'revision_required', message: 'If-Match with the current configuration revision is required' },
    400,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(body: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (cookie !== undefined) {
    headers.set('set-cookie', cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function closeServer(server: ServerType): Promise<void> {
  // Only the plain HTTP server variant exposes closeAllConnections; the
  // adaptor never creates HTTP/2 servers in this project.
  if ('closeAllConnections' in server) {
    server.closeAllConnections();
  }
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function asset(body: Buffer, path: string): Response {
  const extension = path.slice(path.lastIndexOf('.'));
  const isHtml = extension === '.html';
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'cache-control': isHtml ? 'no-store' : 'public, max-age=3600',
  });
  return new Response(new Uint8Array(body), { headers });
}

async function readAsset(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function readCookie(request: Request, name: string): string {
  const header = request.headers.get('cookie');
  if (header === null) {
    return '';
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    return part.slice(separator + 1).trim();
  }
  return '';
}

async function readJsonObject(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new AdminAuthError(413, 'body_too_large', 'Request body is too large');
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new AdminAuthError(413, 'body_too_large', 'Request body is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdminAuthError(400, 'invalid_body', 'Request body must be JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AdminAuthError(400, 'invalid_body', 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function readCredentials(request: Request): Promise<AdminCredentials> {
  const record = await readJsonObject(request);
  const username = record.username;
  const password = record.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new AdminAuthError(400, 'invalid_body', 'username and password must be strings');
  }
  return { username, password };
}
