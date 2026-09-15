import { expect, test } from '@playwright/test';
import { adminUrl, authStoragePath } from './helpers.ts';

/**
 * Backend trust boundary, asserted with raw API requests against the real
 * AdminServer (no mocks): the session gate, the read-only audit contract and
 * the cross-origin write rejection must each answer with the exact HTTP status
 * plus the stable error code, not just a non-200.
 *
 * - no session cookie on a protected route → 401 `unauthenticated`
 * - a write method on an audit read-only route → 405 `method_not_allowed`
 * - a cross-origin write (evil Origin) → 403 `bad_origin` (rejected before
 *   any session check, so even a valid cookie cannot bypass it)
 */

test('GET a protected API route without a session cookie → 401 unauthenticated', async ({ request }) => {
  const response = await request.get(await adminUrl('/api/overview'));
  expect(response.status()).toBe(401);
  const body = (await response.json()) as { error: string };
  expect(body.error).toBe('unauthenticated');
});

test('GET a protected list route without a session cookie → 401 unauthenticated', async ({ request }) => {
  const response = await request.get(await adminUrl('/api/invocations'));
  expect(response.status()).toBe(401);
  const body = (await response.json()) as { error: string };
  expect(body.error).toBe('unauthenticated');
});

test.describe('with a valid session cookie', () => {
  test.use({ storageState: authStoragePath() });

  test('POST to the audit read-only invocations route → 405 method_not_allowed', async ({ request }) => {
    const response = await request.post(await adminUrl('/api/invocations'));
    expect(response.status()).toBe(405);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('method_not_allowed');
  });

  test('PUT to the audit read-only overview route → 405 method_not_allowed', async ({ request }) => {
    const response = await request.put(await adminUrl('/api/overview'));
    expect(response.status()).toBe(405);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('method_not_allowed');
  });

  test('cross-origin POST to /api/wake → 403 bad_origin', async ({ request }) => {
    const response = await request.post(await adminUrl('/api/wake'), {
      headers: { Origin: 'http://evil.example' },
    });
    expect(response.status()).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('bad_origin');
  });
});
