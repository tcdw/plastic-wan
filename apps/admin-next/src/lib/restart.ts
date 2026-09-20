const POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Waits until the admin API answers again. `POST /api/restart` makes `serve`
 * exit with code 75 and something external starts it again, so the page is
 * disconnected for a while — the caller keeps polling instead of showing an
 * error for an expected outage.
 */
export async function waitForAdminServer(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
      if (response.ok) {
        return true;
      }
    } catch {
      // Still restarting: the socket is refused until the new process listens.
    }
  }
  return false;
}
