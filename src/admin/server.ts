import { join, resolve, sep } from "node:path";
import type { Server } from "bun";
import type { RawConfig } from "../config.ts";
import type { SqliteStore } from "../database.ts";
import type { BucketScheduler } from "../scheduler.ts";
import { AdminAuth, AdminAuthError, type AdminCredentials } from "./auth.ts";
import {
  AdminQueryError,
  getInvocation,
  getMessage,
  listInvocations,
  listMessages,
  listStickerSets,
  listStickers,
  overview,
  parseId,
  usage,
  type ListQuery,
} from "./audit.ts";
import { cancelPendingSessions } from "./operations.ts";

const SESSION_COOKIE = "plasticwan_admin";
const MAX_BODY_BYTES = 8_192;
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/vnd.microsoft.icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export type AdminConfig = NonNullable<RawConfig["admin"]>;

export interface AdminServerOptions {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly scheduler?: BucketScheduler;
}

export class AdminServer {
  readonly #store: SqliteStore;
  readonly #admin: AdminConfig;
  readonly #auth: AdminAuth;
  readonly #scheduler: BucketScheduler | undefined;
  readonly #staticDir: string;
  #server: Server<undefined> | undefined;

  constructor(options: AdminServerOptions) {
    const admin = options.config.admin;
    if (admin === undefined) throw new Error("Admin panel is not configured");
    this.#store = options.store;
    this.#admin = admin;
    this.#auth = new AdminAuth(options.store.db, admin.session_ttl_hours);
    this.#scheduler = options.scheduler;
    this.#staticDir = resolve(admin.static_dir ?? join(import.meta.dir, "..", "..", "apps", "admin", "dist"));
  }

  start(): { readonly hostname: string; readonly port: number } {
    if (this.#server !== undefined) throw new Error("Admin server is already listening");
    this.#auth.purgeExpired();
    const server = Bun.serve({
      hostname: this.#admin.host,
      port: this.#admin.port,
      idleTimeout: 30,
      fetch: (request) => this.handle(request),
    });
    this.#server = server;
    return { hostname: server.hostname ?? this.#admin.host, port: server.port ?? this.#admin.port };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await server.stop(true);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    try {
      if (segments[0] === "api") return await this.#api(request, url, segments.slice(1));
      return await this.#staticAsset(request, segments);
    } catch (error) {
      if (error instanceof AdminAuthError || error instanceof AdminQueryError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      console.error(JSON.stringify({
        event: "admin_request_failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      }));
      return json({ error: "internal_error", message: "Admin request failed" }, 500);
    }
  }

  async #api(request: Request, url: URL, segments: readonly string[]): Promise<Response> {
    if (request.method !== "GET" && request.method !== "POST") {
      return json({ error: "method_not_allowed", message: "Only GET and POST are supported" }, 405);
    }
    if (request.method === "POST") {
      const origin = request.headers.get("origin");
      if (origin !== null && new URL(origin).host !== url.host) {
        return json({ error: "bad_origin", message: "Cross-origin admin requests are rejected" }, 403);
      }
    }
    const route = segments.join("/");
    if (route === "auth/session" && request.method === "GET") {
      const session = this.#auth.authenticate(readCookie(request, SESSION_COOKIE));
      return json({
        setup_required: this.#auth.setupRequired(),
        authenticated: session !== null,
        username: session?.username ?? null,
        expires_at: session?.expiresAt ?? null,
      });
    }
    if (route === "auth/setup" && request.method === "POST") {
      const token = await this.#auth.createFirstUser(await readCredentials(request));
      return json({ status: "ok" }, 200, this.#sessionCookie(token));
    }
    if (route === "auth/login" && request.method === "POST") {
      const clientKey = request.headers.get("x-forwarded-for") ?? "local";
      const token = await this.#auth.login(await readCredentials(request), new Date(), clientKey);
      return json({ status: "ok" }, 200, this.#sessionCookie(token));
    }
    if (route === "auth/logout" && request.method === "POST") {
      this.#auth.logout(readCookie(request, SESSION_COOKIE));
      return json({ status: "ok" }, 200, `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    }
    const session = this.#auth.authenticate(readCookie(request, SESSION_COOKIE));
    if (session === null) return json({ error: "unauthenticated", message: "Admin session is required" }, 401);
    if (route === "cancel-pending-sessions" && request.method === "POST") {
      const result = cancelPendingSessions(this.#store.db, new Date());
      this.#scheduler?.wake();
      return json(result);
    }
    if (request.method !== "GET") return json({ error: "method_not_allowed", message: "Audit routes are read-only" }, 405);
    const query: ListQuery = {
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
      state: url.searchParams.get("state"),
      chat: url.searchParams.get("chat"),
      set: url.searchParams.get("set"),
      search: url.searchParams.get("search"),
    };
    const database = this.#store.db;
    if (route === "overview") return json(overview(database));
    if (route === "usage") {
      const daysParam = url.searchParams.get("days");
      const days = daysParam === null ? 7 : Number.parseInt(daysParam, 10);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        return json({ error: "invalid_days", message: "days must be an integer between 1 and 90" }, 400);
      }
      return json(usage(database, days));
    }
    if (route === "invocations") return json(listInvocations(database, query));
    if (segments[0] === "invocations" && segments.length === 2) {
      const found = getInvocation(database, parseId(segments[1] ?? "", "id"));
      return found === null ? json({ error: "not_found", message: "Invocation does not exist" }, 404) : json(found);
    }
    if (route === "messages") return json(listMessages(database, query));
    if (segments[0] === "messages" && segments.length === 2) {
      const found = getMessage(database, parseId(segments[1] ?? "", "id"));
      return found === null ? json({ error: "not_found", message: "Message does not exist" }, 404) : json(found);
    }
    if (route === "sticker-sets") return json({ items: listStickerSets(database) });
    if (route === "stickers") return json(listStickers(database, query));
    return json({ error: "not_found", message: "Unknown admin API route" }, 404);
  }

  async #staticAsset(request: Request, segments: readonly string[]): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed", message: "Only GET and HEAD are supported" }, 405);
    }
    const relative = segments.length === 0 ? "index.html" : segments.join("/");
    const candidate = resolve(this.#staticDir, relative);
    if (candidate !== this.#staticDir && !candidate.startsWith(this.#staticDir + sep)) {
      return json({ error: "not_found", message: "Asset does not exist" }, 404);
    }
    const direct = Bun.file(candidate);
    if (await direct.exists()) return asset(direct, candidate);
    const indexPath = join(this.#staticDir, "index.html");
    const index = Bun.file(indexPath);
    if (await index.exists()) return asset(index, indexPath);
    return json(
      { error: "admin_bundle_missing", message: `Admin bundle is absent: ${this.#staticDir}. Run bun run admin:build.` },
      503,
    );
  }

  #sessionCookie(token: string): string {
    const maxAge = Math.floor(this.#auth.sessionTtlMs / 1000);
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  }
}

function json(body: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({ ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (cookie !== undefined) headers.set("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function asset(file: Bun.BunFile, path: string): Response {
  const extension = path.slice(path.lastIndexOf("."));
  const isHtml = extension === ".html";
  const headers = new Headers({
    ...SECURITY_HEADERS,
    "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "cache-control": isHtml ? "no-store" : "public, max-age=3600",
  });
  return new Response(file, { headers });
}

function readCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie");
  if (header === null) return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

async function readCredentials(request: Request): Promise<AdminCredentials> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new AdminAuthError(413, "body_too_large", "Request body is too large");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new AdminAuthError(413, "body_too_large", "Request body is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdminAuthError(400, "invalid_body", "Request body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new AdminAuthError(400, "invalid_body", "Request body must be a JSON object");
  const record = parsed as Record<string, unknown>;
  const username = record["username"];
  const password = record["password"];
  if (typeof username !== "string" || typeof password !== "string") {
    throw new AdminAuthError(400, "invalid_body", "username and password must be strings");
  }
  return { username, password };
}
