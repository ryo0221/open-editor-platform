import { test, expect } from '@playwright/test';
import type {} from '../test-host/import-test';

test('composition retires a preview, preserves mapping and requires explicit re-preview', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/import.html');
  await page.getByLabel('Local file', { exact: true }).setInputFiles({
    name: 'synthetic.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('lon,lat,name\n12,34,synthetic'),
  });
  await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
  await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Input column/property 1', { exact: true }).fill('name');
  const preview = page.getByRole('button', { name: 'Preview import', exact: true });
  const commit = page.getByRole('button', { name: 'Import previewed data', exact: true });
  const display = page.getByLabel('Display name 1', { exact: true });
  await preview.click();
  await expect(commit).toBeEnabled();
  const before = await page.evaluate(() => window.geoImportTest.state());
  await display.dispatchEvent('compositionstart', { data: '' });
  await expect(commit).toBeDisabled();
  await expect(preview).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel import', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove field 1', exact: true })).toBeDisabled();
  // Direct callbacks must enforce the same guard as disabled browser buttons.
  await page.locator('.geo-import-workbench button').evaluateAll(async (buttons) => {
    for (const element of buttons) {
      const button = element as HTMLButtonElement;
      await button.onclick?.call(button, new PointerEvent('click'));
    }
  });
  await expect(display).toBeVisible();
  expect((await page.evaluate(() => window.geoImportTest.state())).hash).toBe(before.hash);
  // Composition is simulated at the browser DOM boundary, not native OS IME certification.
  await display.evaluate((element) => {
    (element as HTMLInputElement).value = '名称';
  });
  await display.dispatchEvent('input', { isComposing: true, data: '名称' });
  await display.dispatchEvent('compositionend', { data: '名称' });
  await expect(display).toHaveValue('名称');
  await expect(commit).toBeDisabled();
  await expect(preview).toBeEnabled();
  const after = await page.evaluate(() => window.geoImportTest.state());
  expect(after.hash).toBe(before.hash);
  expect(after.staged).toBe(0);
  await preview.click();
  await expect(commit).toBeEnabled();
  await commit.click();
  await expect(page.getByRole('status')).toContainText('Imported 1');
  expect(
    (await page.evaluate(() => window.geoImportTest.state())).content.layers[0].fields[0].name,
  ).toBe('名称');
  expect(errors).toEqual([]);
});
