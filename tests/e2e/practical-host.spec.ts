import { test, expect, create, nativeArtifact } from './fixtures';
import { artifactMenu } from './template-fixtures';
import { confirmed, monitor, screenshot, value } from './practical-fixtures';

test('QL independent Host: template API, Japanese input, clipboard fallback, save/reload, pending detach, recovery and permissions', async ({
  page,
  browser,
  browserName,
  baseURL,
}) => {
  test.setTimeout(150000);
  await page.goto('/');
  await create(page, 'slide');
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const artifactId = new URL(page.url()).searchParams.get('shared')!;
  const response = await page.request.post('/collaboration-api/editor/session', {
    data: { actor: 'B', artifactId, domain: 'slide' },
  });
  expect(response.ok()).toBe(true);
  const configuration = { ...(await response.json()), domain: 'slide' };
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const host = await context.newPage(),
    errors = monitor(host);
  await host.goto('/embed.html');
  await host.evaluate(
    (value) => sessionStorage.setItem('ep-independent-host', JSON.stringify(value)),
    configuration,
  );
  await host.reload();
  const synced = () => expect(host.getByLabel('Host sync status')).toContainText('confirmed');
  const content = async () => JSON.parse((await host.locator('.embed-content pre').textContent())!);
  await synced();
  await host.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(host, 'Text', '来訪の受付\n日本語の案内');
  await synced();
  const canvas = host.getByRole('application', { name: 'Slide canvas', exact: true });
  await canvas.focus();
  await canvas.press('Control+c');
  await canvas.press('Control+v');
  await synced();
  expect((await content()).slides[0].objects).toHaveLength(2);
  await host.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await synced();
  expect((await content()).slides[0].objects).toHaveLength(1);
  await host.getByRole('button', { name: 'Preview comparison template', exact: true }).click();
  await expect(
    host.getByRole('dialog', { name: 'Host template preview', exact: true }),
  ).toBeVisible();
  await host.getByRole('button', { name: 'Apply template', exact: true }).click();
  await expect(
    host.getByRole('dialog', { name: 'Host template preview', exact: true }),
  ).toHaveCount(0);
  await synced();
  expect((await content()).slides).toHaveLength(2);
  await host.getByRole('button', { name: 'Host save version', exact: true }).click();
  await expect(host.getByLabel('Host versions')).toHaveText('1 saved version(s)');
  const saved = await content();
  await host.reload();
  await synced();
  expect(await content()).toEqual(saved);
  await expect(host.getByLabel('Host versions')).toHaveText('1 saved version(s)');
  await host.getByRole('button', { name: 'Pause connection', exact: true }).click();
  await host.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(host, 'Text', '接続回復後も保持する入力');
  await expect(host.getByLabel('Host sync status')).toContainText('pending');
  // A failed Host persistence callback must keep the editor and its pending input live.
  await host.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('ep-independent-pending:')) throw new Error('Host storage full');
      return original.call(this, key, value);
    };
    (window as typeof window & { restoreStorage?: () => void }).restoreStorage = () => {
      Storage.prototype.setItem = original;
    };
  });
  await host.getByRole('button', { name: 'Detach editor', exact: true }).click();
  await expect(host.getByRole('alert')).toContainText('Host storage full');
  await expect(host.getByRole('application', { name: 'Slide canvas', exact: true })).toBeVisible();
  await expect(host.getByLabel('Host sync status')).toContainText('pending');
  await host.evaluate(() =>
    (window as typeof window & { restoreStorage?: () => void }).restoreStorage?.(),
  );
  await host.getByRole('button', { name: 'Detach editor', exact: true }).click();
  await expect(host.getByRole('application', { name: 'Slide canvas', exact: true })).toHaveCount(0);
  let requests = 0;
  const observe = (request: { url(): string }) => {
    if (request.url().includes('/collaboration-api/')) requests++;
  };
  host.on('request', observe);
  // Bounded observation covers three former polling intervals; no traffic may survive detach.
  await host.waitForTimeout(1100);
  expect(requests).toBe(0);
  host.off('request', observe);
  await host.getByRole('button', { name: 'Attach editor', exact: true }).click();
  await synced();
  expect(JSON.stringify(await content())).toContain('接続回復後も保持する入力');
  expect((await content()).slides[0].objects).toHaveLength(2);
  await expect
    .poll(async () => (await nativeArtifact(page)).draft.content)
    .toEqual(await content());
  await host.getByRole('button', { name: 'Host save version', exact: true }).click();
  await expect(host.getByLabel('Host versions')).toHaveText('2 saved version(s)');
  await host.evaluate(async ({ token }) => {
    const result = await fetch('/collaboration-api/editor/reference-permissions?domain=slide', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writable: false }),
    });
    if (!result.ok) throw new Error('Permission change failed');
  }, configuration);
  await expect(host.getByLabel('Host sync status')).toContainText('Read only');
  await expect(host.getByRole('button', { name: 'Insert text', exact: true })).toBeDisabled();
  await expect(
    host.getByRole('button', { name: 'Preview comparison template', exact: true }),
  ).toBeDisabled();
  await expect(host.getByRole('button', { name: 'Host save version', exact: true })).toBeDisabled();
  await screenshot(host, `independent-host-${browserName}`);
  await host.reload();
  await expect(host.getByLabel('Host sync status')).toContainText('Read only');
  await context.close();
  expect(errors).toEqual([]);
});
