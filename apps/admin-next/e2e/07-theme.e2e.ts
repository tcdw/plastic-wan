import { expect, test } from '@playwright/test';
import { adminUrl, authStoragePath } from './helpers.ts';

/**
 * Regression: while the mode is "system", an OS scheme change must update the
 * theme context value and not only the DOM class. The JSON viewer derives its
 * palette from `resolved`, so before the fix its inline theme variables kept the
 * previous scheme until the provider re-rendered for some other reason.
 */
test.use({ storageState: authStoragePath() });

test('system color scheme change updates the theme context value', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(await adminUrl('/invocations/4001'));

  const overview = page.getByRole('tabpanel', { name: /Overview/ });
  await overview.getByText('View details').first().click();
  await overview
    .getByText(/Payload \(\d+ chars\) — click to expand/)
    .first()
    .click();

  const tree = page.locator('.w-rjv').first();
  await expect(tree).toBeVisible();
  const lightStyle = await tree.getAttribute('style');

  await page.emulateMedia({ colorScheme: 'dark' });

  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect.poll(() => tree.getAttribute('style')).not.toBe(lightStyle);
});
