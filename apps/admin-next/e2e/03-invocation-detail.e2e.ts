import { expect, test } from '@playwright/test';
import { adminUrl, authStoragePath } from './helpers.ts';

/**
 * Invocation detail contract: the six tabs render their real fields, failed
 * calls expose a stable error code with expandable redacted details, and
 * assistant text carries the "Private reasoning" marker.
 */
test.use({ storageState: authStoragePath() });

test.describe('completed invocation (4001)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(await adminUrl('/invocations/4001'));
    await expect(page.getByText('Invocation 4001').first()).toBeVisible();
  });

  test('overview timeline renders queued/started/finished and tool events', async ({ page }) => {
    await expect(page.getByText('Agent session started')).toBeVisible();
    await expect(page.getByText('Agent session finished')).toBeVisible();
    await expect(page.getByText('Hello from the seeded invocation').first()).toBeVisible();
    await expect(page.getByText('call_send_001')).toBeVisible();
  });

  test('tool calls tab lists read + send with call ids', async ({ page }) => {
    await page.getByRole('tab', { name: /Tool calls/ }).click();
    const tabpanel = page.getByRole('tabpanel', { name: /Tool calls/ });
    await expect(tabpanel.getByText('call_read_001')).toBeVisible();
    await expect(tabpanel.getByText('call_send_001')).toBeVisible();
    await expect(tabpanel.getByText('read', { exact: true })).toBeVisible();
  });

  test('model calls tab lists both attempts with payload expand', async ({ page }) => {
    await page.getByRole('tab', { name: /Model calls/ }).click();
    const tabpanel = page.getByRole('tabpanel', { name: /Model calls/ });
    await expect(tabpanel.getByText('gpt-4.1-mini', { exact: false })).toHaveCount(2);
    await expect(tabpanel.getByRole('columnheader', { name: 'Attempt' })).toBeVisible();
    await expect(tabpanel.getByRole('cell', { name: '1', exact: true })).toBeVisible();
    await expect(tabpanel.getByRole('cell', { name: '2', exact: true })).toBeVisible();
    await tabpanel.getByRole('button', { name: 'Toggle row details' }).first().click();
    await expect(page.getByText('Last API request payload')).toBeVisible();
  });

  test('model call payloads mount only when their disclosure is expanded', async ({ page }) => {
    const overview = page.getByRole('tabpanel', { name: /Overview/ });
    // A native <details> renders its subtree while collapsed; the payloads must
    // not exist in the DOM until the user expands "View details".
    await expect(overview.getByText('Last API request payload')).toHaveCount(0);
    await expect(overview.getByText('context_messages')).toHaveCount(0);
    await overview.getByText('View details').first().click();
    await expect(overview.getByText('Last API request payload')).toBeVisible();
    await expect(overview.getByText('Last API response status')).toBeVisible();
    // Oversized payloads keep their JSON tree behind a second lazy disclosure.
    await expect(overview.getByText('context_messages')).toHaveCount(0);
    await overview.getByText(/Payload \(\d+ chars\) — click to expand/).click();
    await expect(overview.getByText('context_messages')).toBeVisible();
  });

  test('telegram sends tab shows the delivery record', async ({ page }) => {
    await page.getByRole('tab', { name: /Telegram sends/ }).click();
    await expect(page.getByText('902')).toBeVisible();
    await expect(page.getByText('call_send_001')).toBeVisible();
    await expect(page.getByText('success').first()).toBeVisible();
  });

  test('agent transcript tab marks assistant text as private reasoning', async ({ page }) => {
    await page.getByRole('tab', { name: /Agent transcript/ }).click();
    await expect(page.getByText('Private reasoning', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('private reasoning before calling read')).toBeVisible();
    await expect(page.getByText('I will send the reply via the send tool.')).toBeVisible();
    await expect(
      page.getByText(/Assistant text is private reasoning and is never sent to Telegram directly/),
    ).toBeVisible();
  });

  test('frozen context tab shows history and incoming sections', async ({ page }) => {
    await page.getByRole('tab', { name: /Frozen context/ }).click();
    await expect(page.getByText('Context history')).toBeVisible();
    await expect(page.getByText('Incoming message')).toBeVisible();
    await expect(page.locator('a', { hasText: /^600[12]$/ }).first()).toBeVisible();
  });
});

test.describe('failed invocation (4002)', () => {
  test('overview shows the failed model call with its stable error code', async ({ page }) => {
    await page.goto(await adminUrl('/invocations/4002'));
    await expect(page.getByText('Invocation 4002').first()).toBeVisible();
    await expect(page.getByText('Error provider_timeout')).toBeVisible();
    await expect(page.getByText('model_failed').first()).toBeVisible();
  });

  test('model calls tab exposes redacted error details', async ({ page }) => {
    await page.goto(await adminUrl('/invocations/4002'));
    await page.getByRole('tab', { name: /Model calls/ }).click();
    await expect(page.getByText('provider_timeout', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Toggle row details' }).first().click();
    await expect(page.getByText('Full model error details')).toBeVisible();
    await expect(page.getByText('provider_timeout').first()).toBeVisible();
    // The seeded detail is already redacted; the live key pattern must not appear.
    await expect(page.getByText('sk-***')).toBeVisible();
    await expect(page.getByText(/sk-(?!\*{3})[A-Za-z0-9]/)).toHaveCount(0);
  });

  test('tool calls tab shows the failing read with not_found', async ({ page }) => {
    await page.goto(await adminUrl('/invocations/4002'));
    await page.getByRole('tab', { name: /Tool calls/ }).click();
    await expect(page.getByText('call_read_002')).toBeVisible();
    await expect(page.getByText('not_found')).toBeVisible();
  });

  test('agent transcript carries the private reasoning marker on the failed run', async ({ page }) => {
    await page.goto(await adminUrl('/invocations/4002'));
    await page.getByRole('tab', { name: /Agent transcript/ }).click();
    await expect(page.getByText('Private reasoning', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('trying to answer but the model call failed')).toBeVisible();
  });
});
