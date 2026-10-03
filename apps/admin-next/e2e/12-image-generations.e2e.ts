import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import type { ImageGenerationRecord } from '../src/lib/api.ts';
import { adminUrl, authStoragePath, watchPageIssues } from './helpers.ts';

test.use({ storageState: authStoragePath() });

const generation: ImageGenerationRecord = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  status: 'failed',
  source: 'admin',
  actorName: 'e2e-admin',
  createdAt: '2026-10-03T01:00:00.000Z',
  finishedAt: '2026-10-03T01:00:05.000Z',
  snapshot: {
    authored: {
      authoredPrompt: 'Draw a moonlit garden',
      modelId: 'fixture-image-model',
      aspectRatio: '16:9',
      resolution: 'auto',
      outputCount: 1,
    },
    resolvedPrompt: 'Draw a moonlit garden with blue flowers',
    finalPrompt: 'Draw a moonlit garden with blue flowers, watercolor',
    promptAssets: [{ id: 'prompt-fixture', name: 'Watercolor style' }],
    imageAssets: [],
  },
  outputs: [],
  attempts: [
    {
      id: 'attempt-fixture',
      round: 1,
      itemIndex: 0,
      status: 'failed',
      startedAt: '2026-10-03T01:00:01.000Z',
      finishedAt: '2026-10-03T01:00:05.000Z',
      error: { code: 'provider_timeout', message: 'Fixture upstream timed out' },
      providerRequestId: 'fixture-request-id',
      usage: { input_tokens: 42 },
      outputAssetId: null,
    },
  ],
  error: { code: 'provider_timeout', message: 'Fixture generation failed' },
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/image/**', async (route) => {
    expect(route.request().method()).toBe('GET');
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/image/status') {
      await route.fulfill({ json: { enabled: true, models: [] } });
    } else if (path === '/api/image/generations') {
      await route.fulfill({ json: { items: [generation], total: 1, limit: 60, offset: 0 } });
    } else if (path === `/api/image/generations/${generation.id}`) {
      await route.fulfill({ json: generation });
    } else {
      await route.fulfill({ status: 404, json: { error: 'not_found' } });
    }
  });
});

test('deep link and reload show generation audit details without the history list', async ({ page }) => {
  const finish = watchPageIssues(page);
  const detailPath = `/image-generations/${generation.id}`;
  await page.goto(await adminUrl(detailPath));
  await expect(page.getByText('Generation ID', { exact: true })).toBeVisible();
  await expect(page.getByText(generation.id, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Generation history', exact: true })).toHaveCount(0);
  await expect(page.getByText('failed', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Error: provider_timeout', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture generation failed', { exact: true })).toBeVisible();
  await expect(page.getByText('Attempt log', { exact: true })).toBeVisible();
  await expect(page.getByText('fixture-request-id', { exact: true })).toBeVisible();
  await expect(page.getByText('input_tokens 42', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture upstream timed out', { exact: true })).toBeVisible();
  await expect(page.getByText(generation.snapshot.finalPrompt, { exact: true })).toBeVisible();
  await expect(page.getByText('This generation used no reference images', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Generation ID', { exact: true })).toBeVisible();
  await expect(page.getByText(generation.id, { exact: true })).toBeVisible();
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.consoleErrors).toEqual([]);
  expect(issues.writeApiCalls).toEqual([]);
});

test('reference previews use the frozen names and order, load the original assets, and fit a narrow screen', async ({
  page,
}) => {
  const finish = watchPageIssues(page);
  const references = [
    { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'Garden at submission' },
    { id: 'cccccccc-3333-4333-8333-333333333333', name: 'Character at submission' },
  ];
  const bytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#88aacc' } })
    .png()
    .toBuffer();
  await page.route(`**/api/image/generations/${generation.id}`, (route) =>
    route.fulfill({ json: { ...generation, snapshot: { ...generation.snapshot, imageAssets: references } } }),
  );
  await page.route('**/api/image/images/*/content', (route) =>
    route.fulfill({ contentType: 'image/png', body: bytes }),
  );
  await page.goto(await adminUrl(`/image-generations/${generation.id}`));
  const gallery = page.getByRole('region', { name: 'Reference images', exact: true });
  await expect(gallery.locator('figcaption')).toHaveText(['1 · Garden at submission', '2 · Character at submission']);
  for (const reference of references) {
    const preview = gallery.getByRole('img', { name: reference.name, exact: true });
    await expect(preview).toHaveAttribute('src', `/api/image/images/${reference.id}/content`);
    await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(32);
    const link = gallery.getByRole('link', { name: `View original: ${reference.name}`, exact: true });
    await expect(link).toHaveAttribute('href', `/api/image/images/${reference.id}/content`);
    await expect(link).toHaveAttribute('target', '_blank');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(gallery).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.consoleErrors).toEqual([]);
  expect(issues.writeApiCalls).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
});

test('missing reference content keeps its snapshot name and the audit details visible', async ({ page }) => {
  const finish = watchPageIssues(page);
  await page.route(`**/api/image/generations/${generation.id}`, (route) =>
    route.fulfill({
      json: {
        ...generation,
        snapshot: {
          ...generation.snapshot,
          imageAssets: [{ id: 'dddddddd-4444-4444-8444-444444444444', name: 'Original reference' }],
        },
      },
    }),
  );
  await page.goto(await adminUrl(`/image-generations/${generation.id}`));
  const gallery = page.getByRole('region', { name: 'Reference images', exact: true });
  await expect(
    gallery.getByText('Image failed to load; the original may have been cleaned up or is temporarily unavailable', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(gallery.locator('figcaption')).toHaveText('1 · Original reference');
  await expect(gallery.getByRole('img')).toHaveCount(0);
  await expect(page.getByText(generation.snapshot.finalPrompt, { exact: true })).toBeVisible();
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.writeApiCalls).toEqual([]);
});

test('history links open the audit detail and return to the history list', async ({ page }) => {
  const finish = watchPageIssues(page);
  await page.goto(await adminUrl('/image-generations'));
  await expect(page.getByRole('heading', { name: 'Generation history', exact: true })).toBeVisible();
  await page.getByRole('link', { name: `${generation.id.slice(0, 8)}…`, exact: true }).click();
  await expect(page).toHaveURL(await adminUrl(`/image-generations/${generation.id}`));
  await expect(page.getByText('Generation ID', { exact: true })).toBeVisible();
  await expect(page.getByText(generation.snapshot.finalPrompt, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Generation history', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '← Back to list', exact: true }).click();
  await expect(page).toHaveURL(await adminUrl('/image-generations'));
  await expect(page.getByRole('heading', { name: 'Generation history', exact: true })).toBeVisible();
  await expect(page.getByText('Generation ID', { exact: true })).toHaveCount(0);
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.consoleErrors).toEqual([]);
  expect(issues.writeApiCalls).toEqual([]);
});
