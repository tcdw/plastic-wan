import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { loadConfig } from "../src/config.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { ContextBuilder } from "../src/context-builder.ts";
import { SqliteStore } from "../src/database.ts";
import { McpManager } from "../src/mcp.ts";
import { BucketScheduler } from "../src/scheduler.ts";
import { SecretStore } from "../src/secrets.ts";
import { TelegramIngestion } from "../src/telegram-ingestion.ts";
import { testConfigToml, writeTestConfig } from "./helpers.ts";

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

test("stdio MCP discovery, result bounds, audit, and dual budget reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-mcp-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  const fixturePath = join(import.meta.dir, "fixtures", "mcp-server.ts");
  const mcpToml = `
[mcp]
[[mcp.servers]]
alias = "local"
transport = "stdio"
command = [${JSON.stringify(process.execPath)}, "run", ${JSON.stringify(fixturePath)}]
required = true
tools = ["echo"]
payload_max_bytes = 1048576
result_max_bytes = 128

[[mcp.servers.tool_policies]]
name = "echo"
read_only = true
timeout_seconds = 5
per_chat_daily_calls = 1
global_daily_calls = 2
`;
  await writeTestConfig(directory, configPath, `${testConfigToml(directory)}${mcpToml}`);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const manager = new McpManager(store, loaded.config, new SecretStore());
  try {
    let validatedNames: string[] = [];
    manager.setRegistryValidator((tools) => {
      validatedNames = tools.map((tool) => tool.name);
    });
    await manager.start();
    expect(validatedNames).toEqual(["local__echo"]);
    expect(store.db.query<{ state: string }, []>("SELECT state FROM mcp_server_state WHERE alias = 'local'").get()?.state).toBe("ready");

    const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
    const received = new Date("2026-08-15T00:00:00.000Z");
    const update: Update = {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: "private", first_name: "Owner" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        text: "search",
      },
    };
    ingestion.ingest(update, received);
    const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({ state: "completed", reason: "done" }));
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) throw new Error("Expected a due invocation");
    const context = new ContextBuilder(store, loaded.config).build(invocationId, 200_000, 0);
    const [tool] = manager.createTools(context, Date.now() + 30_000);
    if (tool === undefined) throw new Error("MCP tool was not exposed");

    const result = await tool.execute("mcp-1", { text: "x".repeat(400) });
    const text = result.content.find((entry) => entry.type === "text");
    if (text === undefined || text.type !== "text") throw new Error("MCP result omitted text");
    expect(text.text.endsWith("[tool result truncated]")).toBe(true);
    expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(128);

    await expect(tool.execute("mcp-2", { text: "blocked" })).rejects.toThrow("budget");
    await expect(tool.execute("mcp-3", {})).rejects.toThrow("arguments");
    const calls = store.db
      .query<{ state: string; error_code: string | null }, []>("SELECT state, error_code FROM tool_calls ORDER BY id")
      .all();
    expect(calls).toEqual([
      { state: "success", error_code: null },
      { state: "blocked_budget", error_code: "blocked_budget" },
      { state: "error", error_code: "invalid_arguments" },
    ]);
    const usage = store.db
      .query<{ scope: string; amount: bigint }, []>("SELECT scope, amount FROM daily_usage WHERE metric = 'tool_calls' ORDER BY scope")
      .all();
    expect(usage).toEqual([
      { scope: "mcp_chat", amount: 1n },
      { scope: "mcp_global", amount: 1n },
    ]);
  } finally {
    await manager.stop();
    store.close();
  }
});

test("Streamable HTTP MCP uses static headers and rejects redirects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-mcp-http-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  const server = new McpServer({ name: "plasticwan-http-test", version: "1.0.0" });
  server.registerTool(
    "lookup",
    {
      description: "Return a keyed value",
      inputSchema: z.object({ key: z.string().min(1) }),
    },
    ({ key }) => ({ content: [{ type: "text", text: `value:${key}` }] }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (request.headers.get("authorization") !== "Bearer static-secret") return new Response("unauthorized", { status: 401 });
      return transport.handleRequest(request);
    },
  });
  const mcpToml = `
[mcp]
[[mcp.servers]]
alias = "web"
transport = "streamable_http"
url = ${JSON.stringify(`http://127.0.0.1:${http.port}/mcp`)}
follow_redirects = false
required = true
tools = ["lookup"]
payload_max_bytes = 1048576
result_max_bytes = 32768
headers = { Authorization = "Bearer static-secret" }

[[mcp.servers.tool_policies]]
name = "lookup"
read_only = true
timeout_seconds = 5
per_chat_daily_calls = 2
global_daily_calls = 2
`;
  await writeTestConfig(directory, configPath, `${testConfigToml(directory)}${mcpToml}`);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const manager = new McpManager(store, loaded.config, new SecretStore());
  try {
    await manager.start();
    const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
    const received = new Date("2026-08-15T00:00:00.000Z");
    ingestion.ingest({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: "private", first_name: "Owner" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        text: "lookup",
      },
    }, received);
    const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({ state: "completed", reason: "done" }));
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) throw new Error("Expected a due invocation");
    const context = new ContextBuilder(store, loaded.config).build(invocationId, 200_000, 0);
    const [tool] = manager.createTools(context, Date.now() + 30_000);
    if (tool === undefined) throw new Error("HTTP MCP tool was not exposed");
    const result = await tool.execute("http-1", { key: "answer" });
    const text = result.content.find((entry) => entry.type === "text");
    if (text === undefined || text.type !== "text") throw new Error("HTTP MCP result omitted text");
    expect(text.text).toContain("value:answer");
  } finally {
    await manager.stop();
    http.stop(true);
    await server.close();
    store.close();
  }

  const redirectConfigPath = join(directory, "redirect.toml");
  const redirect = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.redirect("http://127.0.0.1/", 302),
  });
  try {
    const redirectToml = mcpToml
      .replace(`http://127.0.0.1:${http.port}/mcp`, `http://127.0.0.1:${redirect.port}/mcp`)
      .replace('headers = { Authorization = "Bearer static-secret" }', 'headers = {}');
    await Bun.write(redirectConfigPath, `${testConfigToml(directory)}${redirectToml}`);
    const redirectLoaded = await loadConfig(redirectConfigPath);
    const redirectStore = await SqliteStore.open({
      ...redirectLoaded.config,
      paths: {
        ...redirectLoaded.config.paths,
        database: join(directory, "redirect.sqlite"),
      },
    });
    const redirectManager = new McpManager(redirectStore, redirectLoaded.config, new SecretStore());
    try {
      await expect(redirectManager.start()).rejects.toThrow("Required MCP server");
    } finally {
      await redirectManager.stop();
      redirectStore.close();
    }
  } finally {
    redirect.stop(true);
  }
});
