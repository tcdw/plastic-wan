import { readFile, rm } from 'node:fs/promises';

/**
 * Stops the E2E backend started by globalSetup: asks the hook to shut down
 * gracefully (temp dir + SQLite cleanup happen inside the server process),
 * waits for the process to exit, then force-kills as a fallback.
 */
export default async function globalTeardown(): Promise<void> {
  const stateFile = process.env.E2E_STATE_FILE;
  if (stateFile === undefined || stateFile.length === 0) {
    return;
  }
  let state: { pid: number; baseURL: string } | null = null;
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8')) as { pid: number; baseURL: string };
  } catch {
    await rm(stateFile, { force: true }).catch(() => undefined);
    return;
  }
  try {
    await fetch(`${state.baseURL}/__e2e/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3_000) });
  } catch {
    // The server may already be gone; the exit poll below decides.
  }
  await waitForExit(state.pid, 15_000);
  await rm(stateFile, { force: true }).catch(() => undefined);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // process no longer exists
    }
    if (Date.now() > deadline) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
