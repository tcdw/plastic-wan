import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { AdminServer } from "../src/admin/server.ts";
import { loadConfig, type LoadedConfig } from "../src/config.ts";
import { SqliteStore } from "../src/database.ts";
import { BucketScheduler } from "../src/scheduler.ts";
import { TelegramIngestion } from "../src/telegram-ingestion.ts";
import { testConfigToml } from "./helpers.ts";

const PASSWORD = "correct-horse-battery";
const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

interface Fixture {
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly loaded: LoadedConfig;
  readonly directory: string;
}

async function fixture(extra = ""): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-admin-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  const staticDir = join(directory, "bundle");
  await Bun.write(join(staticDir, "index.html"), "<!doctype html><title>admin</title>");
  await Bun.write(join(staticDir, "static", "app.js"), "console.log('admin');");
  await Bun.write(
    configPath,
    `${testConfigToml(directory)}
[admin]
enabled = true
host = "127.0.0.1"
port = 8899
session_ttl_hours = 12
static_dir = ${JSON.stringify(staticDir.replaceAll("\\", "/"))}
${extra}`,
  );
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return { store, server: new AdminServer({ store, config: loaded.config }), loaded, directory };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function post(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== undefined) headers["cookie"] = cookie;
  return request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (header === null) throw new Error("Expected a session cookie");
  return header.slice(0, header.indexOf(";"));
}

// Audit payloads are asserted structurally, so a loose type keeps assertions readable.
async function readJson(response: Response): Promise<any> {
  return await response.json();
}

test("admin panel demands first-run setup, then authenticates and revokes sessions", async () => {
  const { store, server } = await fixture();
  try {
    const initial = await readJson((await server.handle(request("/api/auth/session"))));
    expect(initial).toEqual({ setup_required: true, authenticated: false, username: null, expires_at: null });

    const unauthenticated = await server.handle(request("/api/invocations"));
    expect(unauthenticated.status).toBe(401);
    expect(await readJson(unauthenticated)).toMatchObject({ error: "unauthenticated" });

    const weak = await server.handle(post("/api/auth/setup", { username: "owner", password: "short" }));
    expect(weak.status).toBe(400);
    expect(await readJson(weak)).toMatchObject({ error: "invalid_password" });
    expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM admin_users").get()?.count).toBe(0n);

    const created = await server.handle(post("/api/auth/setup", { username: "owner", password: PASSWORD }));
    expect(created.status).toBe(200);
    const cookie = sessionCookie(created);
    expect(created.headers.get("set-cookie")).toContain("HttpOnly");
    expect(created.headers.get("set-cookie")).toContain("SameSite=Strict");

    const repeat = await server.handle(post("/api/auth/setup", { username: "other", password: PASSWORD }));
    expect(repeat.status).toBe(409);
    expect(await readJson(repeat)).toMatchObject({ error: "setup_complete" });

    const session = await readJson((await server.handle(request("/api/auth/session", { headers: { cookie } }))));
    expect(session).toMatchObject({ setup_required: false, authenticated: true, username: "owner" });

    const authorized = await server.handle(request("/api/invocations", { headers: { cookie } }));
    expect(authorized.status).toBe(200);
    expect(await readJson(authorized)).toEqual({ items: [], next_cursor: null });

    expect((await server.handle(post("/api/auth/logout", {}, cookie))).status).toBe(200);
    const afterLogout = await server.handle(request("/api/invocations", { headers: { cookie } }));
    expect(afterLogout.status).toBe(401);
    expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM admin_sessions").get()?.count).toBe(0n);
  } finally {
    store.close();
  }
});

test("admin login persists only hashes and rejects invalid credentials", async () => {
  const { store, server } = await fixture();
  try {
    const created = await server.handle(post("/api/auth/setup", { username: "owner", password: PASSWORD }));
    const cookie = sessionCookie(created);
    const token = cookie.slice(cookie.indexOf("=") + 1);

    const stored = store.db.query<{ password_hash: string }, []>("SELECT password_hash FROM admin_users").get();
    expect(stored?.password_hash).toStartWith("$argon2id$");
    expect(stored?.password_hash).not.toContain(PASSWORD);
    const sessionRow = store.db.query<{ token_hash: string }, []>("SELECT token_hash FROM admin_sessions").get();
    expect(sessionRow?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionRow?.token_hash).not.toBe(token);

    const wrongPassword = await server.handle(post("/api/auth/login", { username: "owner", password: "wrong-password-value" }));
    expect(wrongPassword.status).toBe(401);
    expect(await readJson(wrongPassword)).toMatchObject({ error: "invalid_credentials" });
    const unknownUser = await server.handle(post("/api/auth/login", { username: "ghost", password: PASSWORD }));
    expect(unknownUser.status).toBe(401);
    expect(await readJson(unknownUser)).toMatchObject({ error: "invalid_credentials" });

    const loggedIn = await server.handle(post("/api/auth/login", { username: "owner", password: PASSWORD }));
    expect(loggedIn.status).toBe(200);
    const second = sessionCookie(loggedIn);
    expect(second).not.toBe(cookie);
    expect((await server.handle(request("/api/auth/session", { headers: { cookie: second } }))).status).toBe(200);
    expect(store.db.query<{ last_login_at: string | null }, []>("SELECT last_login_at FROM admin_users").get()?.last_login_at).not.toBeNull();

    const crossOrigin = await server.handle(
      request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.test" },
        body: JSON.stringify({ username: "owner", password: PASSWORD }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await readJson(crossOrigin)).toMatchObject({ error: "bad_origin" });
  } finally {
    store.close();
  }
});

test("audit routes expose tool sessions, messages and sticker cache", async () => {
  const { store, server, loaded } = await fixture();
  try {
    const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
    const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({ state: "completed", reason: "done" }));
    const received = new Date("2026-03-01T00:00:00.000Z");
    ingestion.ingest(textUpdate(1, 10, "hello audit panel"), received);
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) throw new Error("Expected an invocation");
    const iso = received.toISOString();
    store.db
      .query("UPDATE invocations SET state = 'completed', started_at = ?, finished_at = ?, completion_reason = 'done', turns_used = 1, tool_calls_used = 1, sends_used = 1 WHERE id = ?")
      .run(received.toISOString(), received.toISOString(), invocationId);
    store.db
      .query("INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, duration_ms, created_at, finished_at) VALUES (?, 'call-1', 'send', '{\"text\":\"hi\"}', 'sent', 'success', 1, 42, ?, ?)")
      .run(invocationId, iso, iso);
    const toolRow = store.db.query<{ id: bigint }, []>("SELECT id FROM tool_calls WHERE tool_call_id = 'call-1'").get();
    if (toolRow === null) throw new Error("Expected the tool call row");
    store.db
      .query("INSERT INTO telegram_sends(tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, created_at, finished_at) VALUES (?, (SELECT conversation_id FROM invocations WHERE id = ?), 'text', '{\"text\":\"hi\"}', 'success', 555, ?, ?)")
      .run(toolRow.id, invocationId, iso, iso);
    store.db
      .query("INSERT INTO model_calls(invocation_id, role, provider, model, attempt, state, input_tokens, output_tokens, total_tokens, cost, duration_ms, created_at, finished_at) VALUES (?, 'agent', 'agent', 'agent-model', 1, 'success', 100, 20, 120, 0.5, 900, ?, ?)")
      .run(invocationId, iso, iso);
    store.db
      .query("INSERT INTO agent_messages(invocation_id, sequence_no, role, text, created_at) VALUES (?, 1, 'assistant', 'private reasoning', ?)")
      .run(invocationId, iso);
    store.db
      .query("INSERT INTO sticker_sets(alias, telegram_name, title, configured, sync_state, last_synced_at, updated_at) VALUES ('cats', 'CatPack', 'Cat Pack', 1, 'success', ?, ?)")
      .run(iso, iso);
    store.db
      .query("INSERT INTO media_analyses(file_unique_id, analysis_version, provider, model, prompt_version, kind, state, description, metadata_json, created_at, updated_at) VALUES ('uniq-1', 'v1', 'vision', 'vision-model', 1, 'sticker', 'success', 'a grinning cat', '{\"tags_en\":[\"cat\"]}', ?, ?)")
      .run(iso, iso);
    const analysis = store.db.query<{ id: bigint }, []>("SELECT id FROM media_analyses WHERE file_unique_id = 'uniq-1'").get();
    if (analysis === null) throw new Error("Expected the analysis row");
    store.db
      .query("INSERT INTO stickers(sticker_set_id, file_unique_id, file_id, emoji, format, active, current_analysis_id, index_state, updated_at) VALUES ((SELECT id FROM sticker_sets WHERE alias = 'cats'), 'uniq-1', 'file-1', '😺', 'static', 1, ?, 'success', ?)")
      .run(analysis.id, iso);

    const cookie = sessionCookie(await server.handle(post("/api/auth/setup", { username: "owner", password: PASSWORD })));
    const headers = { cookie };

    const invocations = await readJson((await server.handle(request("/api/invocations", { headers }))));
    expect(invocations.items).toHaveLength(1);
    expect(invocations.items[0]).toMatchObject({
      id: invocationId.toString(),
      tool_call_count: 1,
      total_tokens: 120,
      chat: { telegram_chat_id: "123456789", type: "private" },
    });

    const detail = await readJson((await server.handle(request(`/api/invocations/${invocationId}`, { headers }))));
    expect(detail.tool_calls[0]).toMatchObject({ tool_name: "send", state: "success", side_effect: true, duration_ms: 42 });
    expect(detail.model_calls[0]).toMatchObject({ provider: "agent", model: "agent-model", total_tokens: 120 });
    expect(detail.agent_messages[0]).toMatchObject({ role: "assistant", text: "private reasoning" });
    expect(detail.telegram_sends[0]).toMatchObject({ kind: "text", state: "success", telegram_message_id: "555" });
    expect(detail.context_messages.some((entry: { section: string }) => entry.section === "new")).toBe(true);

    const missing = await server.handle(request("/api/invocations/999999", { headers }));
    expect(missing.status).toBe(404);
    const badId = await server.handle(request("/api/invocations/not-a-number", { headers }));
    expect(badId.status).toBe(400);
    expect(await readJson(badId)).toMatchObject({ error: "invalid_id" });

    const messages = await readJson((await server.handle(request("/api/messages?search=audit", { headers }))));
    expect(messages.items).toHaveLength(1);
    expect(messages.items[0]).toMatchObject({ telegram_message_id: "10", text: "hello audit panel", revision_count: 1 });
    const filteredOut = await readJson((await server.handle(request("/api/messages?search=absent-text", { headers }))));
    expect(filteredOut.items).toHaveLength(0);
    const messageDetail = await readJson((await server.handle(request(`/api/messages/${messages.items[0].id}`, { headers }))));
    expect(messageDetail.revisions[0]).toMatchObject({ revision_no: 1, text: "hello audit panel" });

    const sets = await readJson((await server.handle(request("/api/sticker-sets", { headers }))));
    expect(sets.items[0]).toMatchObject({ alias: "cats", sync_state: "success", sticker_count: 1, indexed_count: 1 });
    const stickers = await readJson((await server.handle(request("/api/stickers?set=cats&state=success&search=grinning", { headers }))));
    expect(stickers.items).toHaveLength(1);
    expect(stickers.items[0]).toMatchObject({
      set_alias: "cats",
      file_unique_id: "uniq-1",
      index_state: "success",
      analysis: { provider: "vision", model: "vision-model", description: "a grinning cat", prompt_version: 1 },
    });
    const otherSet = await readJson((await server.handle(request("/api/stickers?set=dogs", { headers }))));
    expect(otherSet.items).toHaveLength(0);

    const overview = await readJson((await server.handle(request("/api/overview", { headers }))));
    expect(overview.invocation_states).toContainEqual({ label: "completed", count: 1 });
    expect(overview.top_tools).toContainEqual({ label: "send", count: 1 });
    expect(overview.message_count).toBe(1);
    expect(overview.cached_analysis_count).toBe(1);

    const rejectedLimit = await server.handle(request("/api/invocations?limit=500", { headers }));
    expect(rejectedLimit.status).toBe(400);
    expect(await readJson(rejectedLimit)).toMatchObject({ error: "invalid_limit" });
    const rejectedFilter = await server.handle(request("/api/stickers?state=success'%20OR%201=1", { headers }));
    expect(rejectedFilter.status).toBe(400);
    expect(await readJson(rejectedFilter)).toMatchObject({ error: "invalid_state" });
    const writeAttempt = await server.handle(post("/api/invocations", {}, cookie));
    expect(writeAttempt.status).toBe(405);
  } finally {
    store.close();
  }
});

test("admin static serving falls back to index.html and refuses traversal", async () => {
  const { store, server } = await fixture();
  try {
    const index = await server.handle(request("/"));
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await index.text()).toContain("<title>admin</title>");

    const deepRoute = await server.handle(request("/invocations/42"));
    expect(deepRoute.status).toBe(200);
    expect(await deepRoute.text()).toContain("<title>admin</title>");

    const script = await server.handle(request("/static/app.js"));
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

    const traversal = await server.handle(request("/../../config.toml"));
    expect(traversal.status).toBe(200);
    expect(await traversal.text()).not.toContain("telegram-secret");
  } finally {
    store.close();
  }
});

test("admin config rejects a non-loopback bind host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-admin-host-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  await Bun.write(
    configPath,
    `${testConfigToml(directory)}
[admin]
enabled = true
host = "0.0.0.0"
port = 8899
session_ttl_hours = 12
`,
  );
  await expect(loadConfig(configPath)).rejects.toThrow("admin.host must be a loopback address");
});

function textUpdate(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: "private", first_name: "Owner" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      text,
    },
  };
}
