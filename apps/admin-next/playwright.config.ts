import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E for the Admin Panel. The suite drives the real `AdminServer`
 * + real `SqliteStore` + `test/fixtures/admin-seed.ts` synthetic data through
 * the built SPA (`dist/`), served with the production CSP.
 *
 * - `globalSetup` spawns `e2e/server.ts` (a Node process) on a random loopback
 *   port and records the base URL; `globalTeardown` shuts it down.
 * - `*.e2e.ts` is excluded from vitest discovery (separate directory,
 *   non-`.test.ts` names) and this `testMatch`.
 * - `workers: 1` keeps the shared seeded server + session deterministic.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Keep all artifacts out of the repo.
  outputDir: join(tmpdir(), 'plasticwan-admin-e2e-results'),
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
