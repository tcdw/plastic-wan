import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, SqliteStore } from "../src/database.ts";
import { loadConfig } from "../src/config.ts";
import { SecretStore } from "../src/secrets.ts";
import { testConfigToml } from "./helpers.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  await Bun.write(configPath, testConfigToml(directory));
  return { directory, configPath };
}

describe("configuration", () => {
  test("accepts the complete version 1 contract", async () => {
    const { configPath } = await fixture();
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent.max_sends).toBe(6);
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects unknown fields", async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(configPath, `${testConfigToml(directory)}\nunknown = true\n`);
    await expect(loadConfig(configPath)).rejects.toThrow("Invalid config");
  });

  test("rejects a vision model without image input", async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(configPath, testConfigToml(directory).replace('input = ["text", "image"]', 'input = ["text"]'));
    await expect(loadConfig(configPath)).rejects.toThrow("lacks image input capability");
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
    expect(version?.version).toBe(3n);
    store.close();

    const backupPath = await backupDatabase(config);
    expect(await Bun.file(backupPath).exists()).toBe(true);
  });
});
