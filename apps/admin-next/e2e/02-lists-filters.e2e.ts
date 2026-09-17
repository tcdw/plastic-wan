import { expect, test } from '@playwright/test';
import { adminUrl, authStoragePath, tableBodyRows } from './helpers.ts';

/**
 * List pages against the real backend: filters really change the result set
 * and "Load more" appears + fetches the next page under keyset cursoring
 * (no page-jump controls anywhere).
 */
test.use({ storageState: authStoragePath() });

test.describe('invocations list', () => {
  test('Load more fetches the second page (25 → 30 rows)', async ({ page }) => {
    await page.goto(await adminUrl('/invocations'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(rows).toHaveCount(30);
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  });

  test('state filter narrows to completed rows only', async ({ page }) => {
    await page.goto(await adminUrl('/invocations'));
    await page.getByRole('combobox', { name: 'State' }).click();
    await page.getByRole('option', { name: 'completed' }).click();
    await expect(tableBodyRows(page)).toHaveCount(25);
    await expect(page.locator('table tbody tr').filter({ hasText: 'failed' })).toHaveCount(0);
  });

  test('chat filter empties the list for an unknown chat', async ({ page }) => {
    await page.goto(await adminUrl('/invocations'));
    await page.getByRole('combobox', { name: 'Chat', exact: true }).fill('999999999');
    await page.getByRole('combobox', { name: 'Chat', exact: true }).press('Enter');
    await expect(page.getByText('No records match the current filters.')).toBeVisible();
  });
});

test.describe('messages list', () => {
  test('Load more fetches the second page (25 → 30 rows)', async ({ page }) => {
    await page.goto(await adminUrl('/messages'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(rows).toHaveCount(30);
  });

  test('search narrows to the exact seeded message', async ({ page }) => {
    await page.goto(await adminUrl('/messages'));
    await page.getByRole('textbox', { name: 'Search text or caption' }).fill('e2e message 5');
    await page.getByRole('textbox', { name: 'Search text or caption' }).press('Enter');
    await expect(tableBodyRows(page)).toHaveCount(1);
    await expect(page.getByText('e2e message 5', { exact: true })).toBeVisible();
  });

  test('chat filter empties the list for an unknown chat', async ({ page }) => {
    await page.goto(await adminUrl('/messages'));
    await page.getByRole('combobox', { name: 'Chat', exact: true }).fill('999999999');
    await page.getByRole('combobox', { name: 'Chat', exact: true }).press('Enter');
    await expect(page.getByText('No messages match the current filters.')).toBeVisible();
  });
});

test.describe('contexts list', () => {
  test('Load more fetches the second page (25 → 27 rows)', async ({ page }) => {
    await page.goto(await adminUrl('/contexts'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(rows).toHaveCount(27);
  });

  test('chat filter empties the list for an unknown chat', async ({ page }) => {
    await page.goto(await adminUrl('/contexts'));
    await page.getByRole('combobox', { name: 'Chat', exact: true }).fill('999999999');
    await page.getByRole('combobox', { name: 'Chat', exact: true }).press('Enter');
    await expect(page.getByText('No conversation contexts', { exact: true })).toBeVisible();
  });
});

test.describe('alarms list', () => {
  test('target filter keeps the seeded target and empties for an unknown one', async ({ page }) => {
    await page.goto(await adminUrl('/alarms'));
    await page.getByRole('textbox', { name: 'Target user ID' }).fill('42');
    await page.getByRole('textbox', { name: 'Target user ID' }).press('Enter');
    await expect(tableBodyRows(page).first()).toBeVisible();
    await page.getByRole('textbox', { name: 'Target user ID' }).fill('999999');
    await page.getByRole('textbox', { name: 'Target user ID' }).press('Enter');
    await expect(page.getByText('No alarms match these filters.')).toBeVisible();
  });

  test('state filter shows the pre-cancelled alarm', async ({ page }) => {
    await page.goto(await adminUrl('/alarms'));
    await page.getByRole('combobox', { name: 'State' }).click();
    await page.getByRole('option', { name: 'cancelled' }).click();
    await expect(tableBodyRows(page)).toHaveCount(1);
    await expect(page.getByText('e2e alarm already cancelled')).toBeVisible();
  });
});

test.describe('memories list', () => {
  test('Load more fetches the second page (25 → 30 rows)', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(rows).toHaveCount(30);
  });

  test('state=expired keeps only the expired seed memory', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    await page.getByRole('combobox', { name: 'State' }).click();
    await page.getByRole('option', { name: 'expired' }).click();
    await expect(tableBodyRows(page)).toHaveCount(1);
    await expect(page.getByText('Old note that expired already.')).toBeVisible();
  });

  test('chat filter empties the list for an unknown chat', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    await page.getByRole('combobox', { name: 'Chat', exact: true }).fill('999999999');
    await page.getByRole('combobox', { name: 'Chat', exact: true }).press('Enter');
    await expect(page.getByText('No memories match these filters.')).toBeVisible();
  });
});

test.describe('stickers list', () => {
  /** The search-index table is the second table on the page (after the sets table). */
  const stickerRows = (page: Parameters<typeof tableBodyRows>[0]): ReturnType<typeof tableBodyRows> =>
    page.locator('table').nth(1).locator('tbody tr');

  test('Load more fetches the second page (25 → 30 rows)', async ({ page }) => {
    await page.goto(await adminUrl('/stickers'));
    const rows = stickerRows(page);
    await expect(rows).toHaveCount(25);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(rows).toHaveCount(30);
  });

  test('set filter splits the two seeded sets', async ({ page }) => {
    await page.goto(await adminUrl('/stickers'));
    await page.getByRole('combobox', { name: 'Sticker set' }).click();
    await page.getByRole('option', { name: 'legacy' }).click();
    await expect(stickerRows(page)).toHaveCount(12);
    await page.getByRole('combobox', { name: 'Sticker set' }).click();
    await page.getByRole('option', { name: 'mascot' }).click();
    await expect(stickerRows(page)).toHaveCount(18);
  });

  test('index-state filter keeps only error rows', async ({ page }) => {
    await page.goto(await adminUrl('/stickers'));
    await page.getByRole('combobox', { name: 'Index state' }).click();
    await page.getByRole('option', { name: 'error' }).click();
    await expect(stickerRows(page)).toHaveCount(3);
  });

  test('search matches the seeded emoji', async ({ page }) => {
    await page.goto(await adminUrl('/stickers'));
    await page.getByRole('textbox', { name: 'Search description or emoji' }).fill('e2e');
    await page.getByRole('textbox', { name: 'Search description or emoji' }).press('Enter');
    // 28 matches > page size: first page shows 25, Load more reveals all 28
    await expect(stickerRows(page)).toHaveCount(25);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(stickerRows(page)).toHaveCount(28);
  });
});

test.describe('no page-jump controls anywhere', () => {
  for (const route of ['/invocations', '/contexts', '/messages', '/alarms', '/memories', '/stickers']) {
    test(`${route} has no pagination page controls`, async ({ page }) => {
      await page.goto(await adminUrl(route));
      await page.waitForLoadState('networkidle');
      // The API is keyset-cursor only: no numbered pages, no total counts,
      // no next/previous page controls.
      await expect(page.getByText(/Page \d+ of \d+/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Next page$/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Previous page$/ })).toHaveCount(0);
    });
  }
});
