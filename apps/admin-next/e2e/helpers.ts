import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

/** State published by globalSetup (see `e2e/global-setup.ts`). */
export interface E2eServerState {
  readonly pid: number;
  readonly baseURL: string;
  readonly username: string;
  readonly password: string;
}

let cachedState: E2eServerState | null = null;

export async function e2eState(): Promise<E2eServerState> {
  if (cachedState !== null) {
    return cachedState;
  }
  const stateFile = process.env.E2E_STATE_FILE;
  if (stateFile === undefined || stateFile.length === 0) {
    throw new Error('E2E_STATE_FILE is not set — run via `bun run admin:test:e2e`');
  }
  cachedState = JSON.parse(await readFile(stateFile, 'utf8')) as E2eServerState;
  return cachedState;
}

export async function adminBase(): Promise<string> {
  return (await e2eState()).baseURL;
}

export async function adminUrl(path: string): Promise<string> {
  return `${await adminBase()}${path}`;
}

/** Calls a test-only hook on the E2E server (`/__e2e/**`). */
export async function e2eFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await adminBase();
  const response = await fetch(`${base}/__e2e${path}`, init);
  if (!response.ok) {
    throw new Error(`E2E hook ${path} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * The Playwright storageState file written by the auth spec after the real
 * setup/login flow; every later spec reuses this session via `test.use`.
 */
export function authStoragePath(): string {
  const stateFile = process.env.E2E_STATE_FILE;
  if (stateFile === undefined || stateFile.length === 0) {
    throw new Error('E2E_STATE_FILE is not set — run via `bun run admin:test:e2e`');
  }
  return `${stateFile}.auth.json`;
}

export interface PageIssues {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly writeApiCalls: string[];
  readonly externalRequests: string[];
}

/**
 * Attaches listeners that record console errors, page errors, non-GET calls
 * to `/api/**` and requests to any origin other than the admin server. A spec
 * that starts the listeners before navigating can assert on the returned
 * arrays after the flow; call `finish()` once the page settles.
 */
export function watchPageIssues(page: Page): () => PageIssues {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const writeApiCalls: string[] = [];
  const externalRequests: string[] = [];
  const base = process.env.E2E_BASE_URL ?? '';

  const onConsole = (message: { type(): string; text(): string }): void => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  };
  const onPageError = (error: Error): void => {
    pageErrors.push(error.message);
  };
  const onRequest = (request: { url(): string; method(): string }): void => {
    const url = request.url();
    const method = request.method();
    if (url.includes('/api/') && method !== 'GET') {
      writeApiCalls.push(`${method} ${url}`);
    }
    if (base.length > 0 && !url.startsWith(base)) {
      externalRequests.push(`${method} ${url}`);
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('request', onRequest);

  return () => {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('request', onRequest);
    return { consoleErrors, pageErrors, writeApiCalls, externalRequests };
  };
}

/** Counts rendered body rows of the first table on the page. */
export function tableBodyRows(page: Page): ReturnType<Page['locator']> {
  return page.locator('table tbody tr');
}
