import { expect, test } from '@playwright/test';
import { adminUrl, authStoragePath } from './helpers.ts';
import {
  E2E_BUILTIN_ALIAS,
  E2E_RELAY_ALIAS,
  E2E_RELAY_COMPLETE_MODEL,
  E2E_RELAY_INCOMPLETE_MODEL,
  E2E_RELAY_MANUAL_MODEL,
  E2E_SECRETS,
} from './models-fixture.ts';

/**
 * The Models page against the real `AdminServer`: provider list and detail,
 * write-only credentials, the discovery dialog (saved mode against a loopback
 * upstream started by `e2e/server.ts`), manual metadata lookup, and the
 * pending-restart feedback. Every write goes through the UI and is verified
 * against the API afterwards.
 */
test.use({ storageState: authStoragePath() });

test.describe('models page', () => {
  test('renders the provider list, the model table and the write-only key field', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await expect(page.getByText('Providers')).toBeVisible();
    await expect(page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` })).toBeVisible();
    await expect(page.getByText('Agent 在用').first()).toBeVisible();

    // Builtin providers show Pi's address read-only and only allow the key to change.
    await page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` }).click();
    await expect(page.getByText('https://openrouter.ai/api/v1')).toBeVisible();
    const keyInput = page.getByLabel('API Key');
    await expect(keyInput).toHaveAttribute('type', 'password');
    await expect(keyInput).toHaveAttribute('autocomplete', 'new-password');
    await expect(keyInput).toHaveValue('');
    await expect(page.getByText('已设置，留空以保持当前设置')).toBeVisible();
    await expect(page.getByRole('button', { name: '检测' })).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('never renders a configured secret, and the API never returns one', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    const secrets = [...Object.values(E2E_SECRETS), 'telegram-secret', 'agent-secret', 'vision-secret'];
    for (const alias of [E2E_BUILTIN_ALIAS, E2E_RELAY_ALIAS, 'agent', 'vision']) {
      await page.getByRole('button', { name: `Provider ${alias}` }).click();
      await expect(page.getByLabel('API Key')).toBeVisible();
      const html = await page.content();
      for (const secret of secrets) {
        expect(html, `${alias} connection card leaked ${secret}`).not.toContain(secret);
      }
    }

    // Header names are shown; header values never are.
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await expect(page.locator('#provider-header-name-0')).toHaveValue('x-relay-token');
    await expect(page.locator('#provider-header-value-0')).toHaveValue('');

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const serialized = JSON.stringify(view);
    for (const secret of Object.values(E2E_SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
    expect(view.providers.map((provider: { alias: string }) => provider.alias)).toContain(E2E_RELAY_ALIAS);
  });

  test('saving a builtin key reports 已保存，待重启 and offers the restart', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_BUILTIN_ALIAS}` }).click();
    await page.getByLabel('API Key').fill('e2e-rotated-builtin-key');
    await page.getByRole('button', { name: 'Save' }).click();

    // A connection field is restart-only: the feedback must not claim it is live.
    await expect(page.getByText('已保存，待重启')).toBeVisible();
    await expect(page.getByRole('alert').getByText(`providers.${E2E_BUILTIN_ALIAS}.api_key`)).toBeVisible();
    await expect(page.getByRole('button', { name: '立即重启' })).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    expect(view.supervised).toBe(true);
    expect(view.restart_required).toContain(`providers.${E2E_BUILTIN_ALIAS}.api_key`);
    expect(JSON.stringify(view)).not.toContain('e2e-rotated-builtin-key');

    // The provider is not in the running registry while its connection waits, so
    // discovery asks for the key once and says a restart removes the need.
    await page.getByRole('button', { name: '获取模型列表' }).click();
    await expect(page.locator('#picker-api-key')).toBeVisible();
    await expect(page.getByText('重启之后就不用再填了', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('discovery resolves metadata from the local upstream and blocks unconfirmed drafts', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: '获取模型列表' }).click();

    // Saved mode: the running registry's connection, which points at the loopback upstream.
    await page.getByRole('button', { name: '获取', exact: true }).click();
    await expect(page.getByText('endpoint:')).toBeVisible();

    const completeRow = page.locator('li').filter({ hasText: E2E_RELAY_COMPLETE_MODEL });
    const incompleteRow = page.locator('li').filter({ hasText: E2E_RELAY_INCOMPLETE_MODEL });
    await expect(completeRow).toBeVisible();
    await expect(incompleteRow).toBeVisible();
    // Every field of the second model is missing, so it needs confirmation first.
    await expect(incompleteRow.getByText('需确认', { exact: false })).toBeVisible();

    await page.getByLabel(`Select ${E2E_RELAY_COMPLETE_MODEL}`).check();
    await page.getByLabel(`Select ${E2E_RELAY_INCOMPLETE_MODEL}`).check();
    await expect(page.getByRole('button', { name: /添加 \d+ 个模型/ })).toBeDisabled();

    await incompleteRow.getByRole('button', { name: '编辑' }).click();
    await expect(page.getByText('需确认的字段：', { exact: false })).toBeVisible();
    await page.locator('#model-context').fill('64000');
    await page.locator('#model-max-tokens').fill('8192');
    await page.locator('#model-input-text').check();
    await page.locator('#model-cost-input').fill('0.1');
    await page.locator('#model-cost-output').fill('0.2');
    await page.locator('#model-cost-cache_read').fill('0');
    await page.locator('#model-cost-cache_write').fill('0');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(incompleteRow.getByText('已确认')).toBeVisible();
    await page.getByRole('button', { name: /添加 \d+ 个模型/ }).click();
    await expect(page.getByText('已生效').first()).toBeVisible();

    // The write went through the real server: both models are in the file now.
    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    expect(relay.models.map((model: { id: string }) => model.id)).toEqual(
      expect.arrayContaining([E2E_RELAY_COMPLETE_MODEL, E2E_RELAY_INCOMPLETE_MODEL]),
    );
    await expect(page.locator('table tbody tr', { hasText: E2E_RELAY_COMPLETE_MODEL })).toBeVisible();
  });

  test('adds a model by id through lookup-metadata', async ({ page }) => {
    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}` }).click();
    await page.getByRole('button', { name: '手动添加' }).click();
    await page.getByLabel('模型 id（每行一个，或用逗号分隔）').fill(E2E_RELAY_MANUAL_MODEL);
    await page.getByRole('button', { name: '获取元数据' }).click();

    // A single id opens the edit dialog straight away: the metadata comes from
    // models.dev and is confirmed there before anything is written.
    await expect(page.getByText('确认 relay-manual-model')).toBeVisible();
    await expect(page.locator('#model-context')).toHaveValue('64000');
    await page.getByRole('button', { name: 'Save' }).click();

    const row = page.locator('li').filter({ hasText: E2E_RELAY_MANUAL_MODEL });
    await expect(row.getByText('已确认')).toBeVisible();
    await page.getByRole('button', { name: '添加 1 个模型' }).click();
    await expect(page.getByText('已生效').first()).toBeVisible();

    const view = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relay = view.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS);
    expect(relay.models.map((model: { id: string }) => model.id)).toContain(E2E_RELAY_MANUAL_MODEL);
  });

  test('creates a custom provider through the wizard and reports the pending restart', async ({ page }) => {
    // The wizard has to reach the same loopback upstream as the relay provider.
    const before = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const relayBaseUrl = before.providers.find((provider: { alias: string }) => provider.alias === E2E_RELAY_ALIAS)
      .base_url as string;

    await page.goto(await adminUrl('/models'));
    await page.getByRole('button', { name: '新建 Provider' }).click();

    await page.locator('#wizard-kind').click();
    await page.getByRole('option', { name: /custom/ }).click();
    await page.locator('#wizard-alias').fill('relay2');
    await page.locator('#wizard-base-url').fill(relayBaseUrl);
    await page.getByRole('button', { name: 'Next' }).click();

    await page.locator('#wizard-api-key').fill(E2E_SECRETS.wizard);
    await page.getByRole('button', { name: 'Next' }).click();

    // The provider is not in the running registry yet, so the listing is fetched
    // in temporary mode with the key that was just typed.
    await page.getByRole('button', { name: '获取模型列表' }).click();
    const row = page.locator('li').filter({ hasText: E2E_RELAY_COMPLETE_MODEL });
    await expect(row).toBeVisible();
    await page.getByLabel(`Select ${E2E_RELAY_COMPLETE_MODEL}`).check();
    await page.getByRole('button', { name: '创建 Provider' }).click();

    await expect(page.getByRole('dialog').getByText('已保存，待重启')).toBeVisible();
    await expect(page.getByRole('button', { name: '立即重启' })).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    await expect(page.getByRole('button', { name: 'Provider relay2' })).toBeVisible();
    const after = await (await page.request.get(await adminUrl('/api/providers'))).json();
    const created = after.providers.find((provider: { alias: string }) => provider.alias === 'relay2');
    expect(created.models.map((model: { id: string }) => model.id)).toEqual([E2E_RELAY_COMPLETE_MODEL]);
    expect(after.restart_required).toContain('providers.relay2');
    expect(JSON.stringify(after)).not.toContain(E2E_SECRETS.wizard);
  });
});
