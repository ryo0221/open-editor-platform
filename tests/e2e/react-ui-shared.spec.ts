import { test, expect, nativeArtifact } from './fixtures';
import type { Page } from '@playwright/test';
async function more(page: Page, action: string) {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
  await page.keyboard.press('Escape');
}
test('W4 independent peers preserve prop edits through selective Undo, reconnect/retry and stale proposal', async ({
  page: a,
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const b = await context.newPage();
  const errors: string[] = [];
  b.on('pageerror', (error) => errors.push(error.message));
  b.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    await a.goto('/');
    await a.getByRole('button', { name: 'New React UI', exact: true }).click();
    await more(a, 'Open collaboratively');
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    const peer = await a
      .getByRole('link', { name: 'Open peer editor', exact: true })
      .getAttribute('href');
    await a.keyboard.press('Escape');
    await b.goto(peer!);
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    for (const page of [a, b])
      await page.getByRole('button', { name: 'buy · Button', exact: true }).click();
    await a.getByLabel('Prop label', { exact: true }).fill('A action');
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    await b.getByLabel('Prop variant', { exact: true }).selectOption('secondary');
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    await expect(b.getByLabel('Prop label', { exact: true })).toHaveValue('A action');
    await a.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    await expect(b.getByLabel('Prop label', { exact: true })).toHaveValue('Add to cart');
    await expect(b.getByLabel('Prop variant', { exact: true })).toHaveValue('secondary');
    await a.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(b.getByLabel('Prop label', { exact: true })).toHaveValue('A action');
    await more(a, 'Pause transport (reference)');
    await a.getByLabel('Prop label', { exact: true }).fill('Offline action');
    await expect(a.locator('.save-status')).toContainText('pending');
    await expect(b.getByLabel('Prop label', { exact: true })).toHaveValue('A action');
    await more(a, 'Resume transport (reference)');
    await expect(b.getByLabel('Prop label', { exact: true })).toHaveValue('Offline action');
    await more(a, 'Lose next acknowledgement (reference)');
    await a.getByLabel('Prop label', { exact: true }).fill('Once action');
    await expect(a.locator('.save-status')).toContainText('pending');
    await expect(b.getByLabel('Prop label', { exact: true })).toHaveValue('Once action');
    await more(a, 'Reconnect shared session');
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    const revision = await a.locator('.save-status').textContent();
    await more(a, 'Reconnect shared session');
    expect(await a.locator('.save-status').textContent()).toBe(revision);
    await more(a, 'Agent proposal demo');
    await expect(
      a.getByRole('complementary', { name: 'Shared proposal preview', exact: true }),
    ).toBeVisible();
    await b.getByLabel('Prop label', { exact: true }).fill('Peer wins');
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    await a.getByRole('button', { name: 'Apply shared proposal', exact: true }).click();
    await expect(a.locator('.error-banner')).toContainText('dependency changed');
    await a.getByRole('button', { name: 'Cancel shared proposal', exact: true }).click();
    await expect(a.getByLabel('Prop label', { exact: true })).toHaveValue('Peer wins');
    await a.reload();
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    await a.getByRole('button', { name: 'buy · Button', exact: true }).click();
    await expect(a.getByLabel('Prop label', { exact: true })).toHaveValue('Peer wins');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
test('W4 explicit breaking component and environment revision keeps data, bindings, node IDs and old pins', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New React UI', exact: true }).click();
  await page.getByRole('button', { name: 'Load example Contact form', exact: true }).click();
  await page.getByRole('button', { name: 'title · Text', exact: true }).click();
  await page.getByRole('button', { name: 'Review component revision', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review React revision', exact: true });
  await dialog.getByLabel('Revision prop mapping', { exact: true }).fill('{}');
  await dialog.getByRole('button', { name: 'Preview revision', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('Revision prop mapping', { exact: true }).fill('{"text":"content"}');
  await dialog.getByRole('button', { name: 'Preview revision', exact: true }).click();
  await dialog.getByRole('button', { name: 'Adopt revision', exact: true }).click();
  const frame = page.frameLocator('iframe[title="React component preview"]');
  await expect(frame.getByText('Contact us', { exact: true })).toHaveAttribute(
    'data-component-version',
    '2',
  );
  const record = await nativeArtifact(page);
  const document = record.draft.content as unknown as {
    nodes: { id: string; component: { version: string }; bindings: object }[];
    components: { ref: { componentId: string; version: string } }[];
  };
  expect(document.nodes.find((n) => n.id === 'title')!.bindings).toMatchObject({
    content: { input: 'title' },
  });
  expect(
    document.components.filter((c) => c.ref.componentId === 'Text').map((c) => c.ref.version),
  ).toEqual(['1.0.0', '2.0.0']);
  await page.getByRole('button', { name: 'Review environment revision', exact: true }).click();
  await dialog.getByRole('button', { name: 'Preview revision', exact: true }).click();
  await dialog.getByRole('button', { name: 'Adopt revision', exact: true }).click();
  await expect(frame.getByRole('region', { name: 'Reference card' })).toHaveAttribute(
    'data-theme',
    'dark',
  );
  await page.getByRole('button', { name: 'Interact', exact: true }).click();
  await expect(frame.locator('[data-preview-mode]')).toHaveAttribute(
    'data-preview-mode',
    'interact',
  );
  await frame.getByRole('textbox', { name: 'Name', exact: true }).fill('Revision');
  await frame.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(frame.getByText('Thanks Revision', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(frame.getByRole('region', { name: 'Reference card' })).toHaveAttribute(
    'data-theme',
    'light',
  );
});
