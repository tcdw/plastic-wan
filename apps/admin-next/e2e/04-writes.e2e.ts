import { expect, test } from '@playwright/test';
import { adminUrl, authStoragePath, e2eFetch } from './helpers.ts';

/**
 * Controlled admin operations against the real backend. Every write goes
 * through the UI with its confirmation flow; success/conflict are verified
 * both in the UI and against server state (API responses / database hooks).
 */
test.use({ storageState: authStoragePath() });

test.describe('memories CRUD', () => {
  test('delete the expired seed memory via the confirmation flow', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    const row = page.locator('table tbody tr', { hasText: 'Old note that expired already.' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete memory' }).click();
    await expect(page.getByText('Memory deleted')).toBeVisible();
    await expect(row).toHaveCount(0);
  });

  test('create a memory through the dialog and verify server + UI state', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    await page.getByRole('button', { name: 'New memory' }).click();
    await page.getByLabel('Select a chat').click();
    await page.getByRole('option', { name: /Plastic Wan Test Group/ }).click();
    await page.getByLabel('Content').fill('E2E memory created by test');
    await page.getByLabel('TTL in days').fill('7');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Memory created')).toBeVisible();

    // server state: the row exists in the API
    const listResponse = await page.request.get(await adminUrl('/api/memories?limit=100'));
    expect(listResponse.ok()).toBeTruthy();
    const listBody = (await listResponse.json()) as { items: { content: string }[] };
    expect(listBody.items.some((item) => item.content === 'E2E memory created by test')).toBeTruthy();

    // UI state: load every page, then delete the created memory from its row
    const loadMore = page.getByRole('button', { name: 'Load more' });
    if (await loadMore.isVisible()) {
      await loadMore.click();
    }
    const createdRow = page.locator('table tbody tr', { hasText: 'E2E memory created by test' });
    await expect(createdRow).toBeVisible();
    await createdRow.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete memory' }).click();
    await expect(page.getByText('Memory deleted')).toBeVisible();
    await expect(createdRow).toHaveCount(0);

    const afterResponse = await page.request.get(await adminUrl('/api/memories?limit=100'));
    const afterBody = (await afterResponse.json()) as { items: { content: string }[] };
    expect(afterBody.items.some((item) => item.content === 'E2E memory created by test')).toBeFalsy();
  });
});

test.describe('bot admins', () => {
  test('add and remove a bot admin with UI feedback', async ({ page }) => {
    await page.goto(await adminUrl('/admins'));
    await expect(page.getByText('No bot admins yet.')).toBeVisible();

    await page.getByRole('button', { name: 'Add bot admin' }).click();
    await page.getByLabel('Telegram user ID').fill('123456789');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Bot admin added')).toBeVisible();
    const row = page.locator('table tbody tr', { hasText: '123456789' });
    await expect(row).toBeVisible();
    await expect(row.getByText('admin-panel')).toBeVisible();

    await row.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove admin' }).click();
    await expect(page.getByText('Bot admin removed')).toBeVisible();
    await expect(page.getByText('No bot admins yet.')).toBeVisible();

    const listResponse = await page.request.get(await adminUrl('/api/admins'));
    const listBody = (await listResponse.json()) as { items: { telegram_user_id: string }[] };
    expect(listBody.items.some((item) => item.telegram_user_id === '123456789')).toBeFalsy();
  });
});

test.describe('model hot-switch', () => {
  test('switch to vision and restore the config default', async ({ page }) => {
    await page.goto(await adminUrl('/model'));
    await expect(page.getByText('config default', { exact: true })).toBeVisible();

    await page.getByRole('combobox', { name: 'Provider and model' }).click();
    await page.getByRole('option', { name: /vision \/ vision-model/ }).click();
    await page.getByRole('button', { name: 'Switch', exact: true }).click();
    await expect(page.getByText('runtime switch')).toBeVisible();

    const switched = (await (await page.request.get(await adminUrl('/api/model'))).json()) as {
      current: { model: string };
    };
    expect(switched.current.model).toBe('vision-model');

    await page.getByRole('button', { name: 'Restore default' }).click();
    await expect(page.getByText('config default', { exact: true })).toBeVisible();
    await expect(page.getByText('agent-model').first()).toBeVisible();

    const restored = (await (await page.request.get(await adminUrl('/api/model'))).json()) as {
      current: { model: string };
    };
    expect(restored.current.model).toBe('agent-model');
  });
});

test.describe('alarm cancel + conflict path', () => {
  test('cancel a pending alarm and see it as cancelled', async ({ page }) => {
    await page.goto(await adminUrl('/alarms'));
    const row = page.locator('table tbody tr', { hasText: 'Remind Alice about the fixture data' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel alarm' }).click();
    await expect(page.getByText('Alarm cancelled')).toBeVisible();

    const state = await e2eFetch<{ state: string; cancelled_by: string | null }>('/alarm-state?id=10001');
    expect(state.state).toBe('cancelled');
    expect(state.cancelled_by).toBe(process.env.E2E_USERNAME ?? 'e2e-admin');

    // UI reflects the new state through the state filter
    await page.getByRole('combobox', { name: 'State' }).click();
    await page.getByRole('option', { name: 'cancelled' }).click();
    const cancelledRow = page.locator('table tbody tr', { hasText: 'Remind Alice about the fixture data' });
    await expect(cancelledRow).toBeVisible();
    await expect(cancelledRow.getByText('cancelled')).toBeVisible();
  });

  test('cancelling an alarm that became terminal shows alarm_not_pending and refreshes', async ({ page }) => {
    await page.goto(await adminUrl('/alarms'));
    // `e2e alarm 1` is also a substring of `e2e alarm 10`…`e2e alarm 19`
    const row = page.locator('table tbody tr', { hasText: /e2e alarm 1(?!\d)/ });
    await expect(row).toBeVisible();

    // Turn the alarm into a terminal state behind the UI's back. `e2e alarm 1`
    // is the seed row with id 10100 (bulk alarms start at 10100).
    const fired = await e2eFetch<{ updated: number }>('/set-alarm-terminal?id=10100', { method: 'POST' });
    expect(fired.updated).toBe(1);

    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel alarm' }).click();

    // 409 alarm_not_pending: dialog stays open with the real error...
    await expect(page.getByText('alarm_not_pending', { exact: false })).toBeVisible();
    await expect(page.getByText('Only pending alarms can be cancelled')).toBeVisible();
    // ...and the list refreshes to the true state.
    const state = await e2eFetch<{ state: string }>('/alarm-state?id=10100');
    expect(state.state).toBe('fired');

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await page.getByRole('combobox', { name: 'State' }).click();
    await page.getByRole('option', { name: 'fired' }).click();
    const firedRow = page.locator('table tbody tr', { hasText: /e2e alarm 1(?!\d)/ });
    await expect(firedRow).toBeVisible();
    await expect(firedRow.getByText('fired')).toBeVisible();
  });
});

test.describe('overview operations', () => {
  test('cancel pending sessions reports the audit result', async ({ page }) => {
    await page.goto(await adminUrl('/'));
    await page.getByRole('button', { name: 'Cancel pending' }).click();
    await page.getByRole('button', { name: 'Cancel pending sessions' }).click();
    await expect(page.getByText(/Canceled 0 buckets \/ 0 invocations/)).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('wake the sleeping bot and see the status flip to awake', async ({ page }) => {
    const sleep = await e2eFetch<{ entered: boolean; sleep_until: string }>('/enter-sleep', { method: 'POST' });
    expect(sleep.entered).toBeTruthy();

    await page.goto(await adminUrl('/'));
    await expect(page.getByText('sleeping')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wake now' })).toBeVisible();

    await page.getByRole('button', { name: 'Wake now' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Wake now' }).click();
    await expect(page.getByText('Bot is awake')).toBeVisible();
    await expect(page.getByText('awake', { exact: true })).toBeVisible();
  });
});
