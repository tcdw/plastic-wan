import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, SqliteStore } from "../src/database.ts";
import { loadConfig } from "../src/config.ts";
import { SecretStore } from "../src/secrets.ts";
import { createModelRegistry } from "../src/providers.ts";
import { testConfigToml, writeTestConfig } from "./helpers.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  await writeTestConfig(directory, configPath);
  return { directory, configPath };
}

describe("configuration", () => {
  test("accepts the complete version 1 contract", async () => {
    const { configPath } = await fixture();
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent.max_sends).toBe(6);
    expect(loaded.config.telegram.bucket_window_seconds).toBe(15);
    const agentProvider = loaded.config.providers.agent;
    expect(agentProvider?.kind).toBe("custom");
    if (agentProvider?.kind !== "custom") throw new Error("Expected the custom agent provider");
    expect(agentProvider.models[0]?.compat?.supports_developer_role).toBe(false);
    const registry = await createModelRegistry(loaded.config, new SecretStore());
    expect(registry.agentModel.compat).toMatchObject({ supportsDeveloperRole: false });
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects unknown fields", async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(configPath, `${testConfigToml(directory)}\nunknown = true\n`);
    await expect(loadConfig(configPath)).rejects.toThrow("Invalid config");
  });

  test("rejects bucket windows outside one to three hundred seconds", async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(configPath, testConfigToml(directory).replace("bucket_window_seconds = 15", "bucket_window_seconds = 0"));
    await expect(loadConfig(configPath)).rejects.toThrow("Invalid config");
    await Bun.write(configPath, testConfigToml(directory).replace("bucket_window_seconds = 15", "bucket_window_seconds = 301"));
    await expect(loadConfig(configPath)).rejects.toThrow("Invalid config");
  });


  test("accepts an agent model without image input", async () => {
    const { directory, configPath } = await fixture();
    const config = testConfigToml(directory).replace('input = ["text", "image"]', 'input = ["text"]');
    await Bun.write(configPath, config);
    const loaded = await loadConfig(configPath);
    const registry = await createModelRegistry(loaded.config, new SecretStore());
    expect(registry.agentModel.input).toEqual(["text"]);
  });

  test("rejects a vision model without image input", async () => {
    const { directory, configPath } = await fixture();
    const config = testConfigToml(directory);
    const firstModel = config.indexOf('input = ["text", "image"]');
    const secondModel = config.indexOf('input = ["text", "image"]', firstModel + 1);
    await Bun.write(configPath, `${config.slice(0, secondModel)}input = ["text"]${config.slice(secondModel + 'input = ["text", "image"]'.length)}`);
    await expect(loadConfig(configPath)).rejects.toThrow("vision.model vision-model lacks image input capability");
  });

  test("rejects developer-role compatibility for an Anthropic adapter", async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(configPath, testConfigToml(directory).replace('api = "openai-responses"', 'api = "anthropic-messages"'));
    await expect(loadConfig(configPath)).rejects.toThrow("supports_developer_role requires an OpenAI API adapter");
  });
});

describe("secrets", () => {
  test("removes one trailing newline and redacts exact values", async () => {
    const store = new SecretStore();
    const value = await store.resolve({ command: [process.execPath, "-e", "process.stdout.write('secret-value\\n')"] });
    expect(value).toBe("secret-value");
    expect(store.redact("failed secret-value request")).toBe("failed [REDACTED] request");
  });
});

describe("database", () => {
  test("applies migrations and creates a consistent backup", async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    const version = store.db.query<{ version: bigint }, []>("SELECT MAX(version) AS version FROM schema_migrations").get();
    expect(version?.version).toBe(6n);
    store.close();

    const backupPath = await backupDatabase(config);
    expect(await Bun.file(backupPath).exists()).toBe(true);
  });
});
