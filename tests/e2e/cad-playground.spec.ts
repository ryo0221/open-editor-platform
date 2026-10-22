import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground does not offer CAD.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const state = (page: Page) => page.getByTestId('cad-geometry-state');
const ready = (page: Page) =>
  expect(state(page)).toHaveText('Shape up to date', { timeout: 90_000 });
const bodies = (page: Page) => page.getByRole('list', { name: 'Bodies' }).getByRole('button');
async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  return button;
}
async function importJson(page: Page, name: string, value: unknown) {
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}

test('create, edit, Undo, save a version, reload and round-trip native JSON', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add plate')).click();
  await ready(page);
  await (await tool(page, 'Add cylinder')).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  // Host history drives the session; the Surface re-evaluates.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  await page
    .getByRole('list', { name: 'Parameters' })
    .getByRole('button', { name: /Width/ })
    .click();
  const value = page.locator('.cad-inspector').getByLabel('Value (mm)');
  await value.fill('100');
  await value.press('Enter');
  // Ctrl+S while the edit still evaluates is refused instead of capturing the old value (the
  // refusal clears once the edit is applied); once the kernel is done it saves directly.
  await page.keyboard.press('Control+s');
  await ready(page);
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  const history = page.getByRole('tab', { name: /^History \(\d+\)$/ });
  const direct = (await history.textContent()) === 'History (1)';
  await page.keyboard.press('Escape');
  if (!direct) {
    const refused = page.getByRole('alert');
    if (await refused.isVisible()) {
      await expect(refused).toContainText('形状を計算中です');
      await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    }
    await save(page, 1);
  }

  await page.reload();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'Parameters' })).toContainText('100 mm');

  const record = await nativeArtifact(page);
  expect(record.kind).toBe('cad');
  expect(record.versions).toHaveLength(1);
  const saved = record.versions[0].content as { parameters: { name: string; value: number }[] };
  expect(saved.parameters.find((p) => p.name === 'Width')?.value).toBe(100);
  await importJson(page, 'cad-copy.json', { ...record, name: 'CAD copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('CAD copy');
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);

  const download = page.waitForEvent('download');
  await (await tool(page, 'Export PNG')).click();
  const png = await readFile((await (await download).path())!);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  await page.screenshot({ path: test.info().outputPath('cad-playground.png') });
});

test('unsupported CAD content and capabilities are refused', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const record = await nativeArtifact(page);
  await importJson(page, 'future.json', {
    ...record,
    name: 'Future CAD',
    draft: { ...record.draft, content: { ...record.draft.content, schemaVersion: 2 } },
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Artifact name')).not.toHaveValue('Future CAD');
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open collaboratively' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Comments \(/ })).toBeDisabled();
  await page.keyboard.press('Escape');
});

test('Read only follows the Host toggle in both directions', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  // The toggle lives in the artifact actions menu.
  const setReadOnly = async (checked: boolean) => {
    const more = page.getByRole('button', { name: 'More artifact actions', exact: true });
    await more.click();
    const toggle = page.getByLabel('Read only', { exact: true });
    await toggle.click();
    await expect(toggle).toBeChecked({ checked });
    await more.click();
  };
  await setReadOnly(true);
  await expect(await tool(page, 'Add box')).toBeDisabled();
  await setReadOnly(false);
  await expect(await tool(page, 'Add box')).toBeEnabled();
  await (await tool(page, 'Add box')).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
});

test('narrow layout: add a body and use Host Undo', async ({ page }) => {
  test.skip(test.info().project.name === 'desktop', 'narrow layout');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add box')).click();
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('cad-playground-narrow.png') });
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(page.getByText('Add a body from the toolbar to start.')).toBeVisible();
});
