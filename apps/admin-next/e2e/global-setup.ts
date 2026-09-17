import { type ChildProcess, spawn } from 'node:child_process';
import { access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface E2eServerState {
  readonly pid: number;
  readonly baseURL: string;
  readonly username: string;
  readonly password: string;
}

const READY_TIMEOUT_MS = 60_000;

/**
 * Starts the E2E backend (real AdminServer + SqliteStore + seeded fixture)
 * as a child Node process, waits for its `E2E_READY` line, and publishes the
 * state file path + base URL through the environment for the workers.
 */
export default async function globalSetup(): Promise<void> {
  const root = process.cwd();
  await access(join(root, 'dist', 'index.html'));

  const stateFile = join(tmpdir(), 'plasticwan-admin-e2e-state.json');
  await rm(stateFile, { force: true });

  const child = spawn(process.execPath, ['e2e/server.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  if (child.pid === undefined) {
    throw new Error('Failed to spawn the E2E server process');
  }

  let baseURL: string | null = null;
  let username = 'e2e-admin';
  let password = 'e2e-correct-horse';
  let stdout = '';
  child.stdout?.on('data', (chunk: string | Buffer) => {
    stdout += String(chunk);
  });
  try {
    const ready = await waitForReady(child, () => stdout);
    baseURL = ready.baseURL;
    username = ready.username;
    password = ready.password;
  } catch (error) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already dead
    }
    throw new Error(
      `E2E server did not become ready.${stdout.length === 0 ? '' : `\nServer output:\n${stdout}`}\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const state: E2eServerState = { pid: child.pid, baseURL, username, password };
  await writeFile(stateFile, JSON.stringify(state), 'utf8');
  process.env.E2E_STATE_FILE = stateFile;
  process.env.E2E_BASE_URL = baseURL;
  process.env.E2E_USERNAME = username;
  process.env.E2E_PASSWORD = password;
}

function waitForReady(
  child: ChildProcess,
  readStdout: () => string,
): Promise<{ baseURL: string; username: string; password: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
    const onData = (): void => {
      const output = readStdout();
      const ready = output.match(/E2E_READY base=(\S+)/);
      const credentials = output.match(/E2E_CREDENTIALS (\S+) (\S+)/);
      if (ready !== null && ready[1] !== undefined) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        resolve({
          baseURL: ready[1],
          username: credentials?.[1] ?? 'e2e-admin',
          password: credentials?.[2] ?? 'e2e-correct-horse',
        });
      }
    };
    const onError = (error: Error): void => {
      clearTimeout(timer);
      reject(error);
    };
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      reject(new Error(`E2E server exited early with code ${String(code)}`));
    };
    child.stdout?.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}
