import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('create, edit keys, play, undo, save and reopen the native session', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await page.getByLabel('Base x', { exact: true }).fill('100');
  await page.getByLabel('Base y', { exact: true }).fill('160');
  await page.getByLabel('Base scaleY', { exact: true }).fill('0.9');
  await page.getByLabel('Base scaleX', { exact: true }).fill('1.2');
  await page.getByLabel('Base rotation', { exact: true }).fill('15');
  await page.getByLabel('Base opacity', { exact: true }).fill('0.8');
  await page.getByRole('button', { name: 'Apply base transform' }).click();
  await expect(page.locator('svg rect')).toHaveAttribute('opacity', '0.8');
  await page.getByLabel('Key tick', { exact: true }).fill('0');
  await page.getByLabel('Key value', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Add key', exact: true }).click();
  await page.getByLabel('Key tick', { exact: true }).fill('480000');
  await page.getByLabel('Key value', { exact: true }).fill('400');
  await page.getByRole('button', { name: 'Add key', exact: true }).click();
  await page.getByRole('button', { name: '480000 ticks · 400', exact: true }).click();
  await page.getByLabel('Key value', { exact: true }).fill('460');
  await page.getByRole('button', { name: 'Update selected key' }).click();
  await expect(page.getByRole('button', { name: '480000 ticks · 460', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete selected key' }).click();
  await expect(page.getByRole('button', { name: '480000 ticks · 460', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: '480000 ticks · 460', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('button', { name: '480000 ticks · 460', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await page.getByLabel('Seek', { exact: true }).fill('240000');
  await expect(page.locator('svg')).toHaveAttribute('data-tick', '240000');
  expect(await page.locator('svg rect').getAttribute('transform')).toMatch(/ 280 160\)$/);
  await page.getByLabel('Speed', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect
    .poll(async () => Number(await page.locator('svg').getAttribute('data-tick')))
    .toBeGreaterThan(240000);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: '480000 ticks · 400', exact: true })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save native JSON', exact: true }).click();
  const download = await pending;
  const path = info.outputPath('edited.animation.json');
  await download.saveAs(path);
  const native = JSON.parse(await readFile(path, 'utf8'));
  expect(native.schemaVersion).toBe(1);
  expect(native.compositions[0].tracks[0].keys[1].value).toBe(400);
  expect(native.compositions[0].layers[1].transform.opacity).toBe(0.8);
  await page.getByLabel('Open native JSON', { exact: true }).setInputFiles(path);
  await expect(page.getByRole('status')).toContainText('Undo history reset');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /Rectangle 1/ }).click();
  await expect(page.getByRole('button', { name: '480000 ticks · 400', exact: true })).toBeVisible();
  await expect(page.locator('svg rect')).toHaveAttribute('opacity', '0.8');
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save native JSON', exact: true }).click();
  const again = await saved;
  const path2 = info.outputPath('roundtrip.json');
  await again.saveAs(path2);
  expect(JSON.parse(await readFile(path2, 'utf8'))).toEqual(native);
  await page
    .getByLabel('Open native JSON', { exact: true })
    .setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.getByRole('status')).toContainText('current content retained');
  await expect(page.locator('svg rect')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('editing.png'), fullPage: true });
  expect(errors).toEqual([]);
});
test('duplicate/fractional keys fail without history and final key removal restores base', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await page.getByLabel('Key value', { exact: true }).fill('200');
  await page.getByRole('button', { name: 'Add key', exact: true }).click();
  await expect(page.locator('svg rect')).toHaveAttribute('transform', 'matrix(1 0 0 1 200 140)');
  await page.getByRole('button', { name: 'Add key', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('already exists');
  await page.getByLabel('Key tick', { exact: true }).fill('0.5');
  await page.getByRole('button', { name: 'Add key', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('integer tick');
  await page.getByRole('button', { name: '0 ticks · 200', exact: true }).click();
  await page.getByRole('button', { name: 'Delete selected key' }).click();
  await expect(page.locator('svg rect')).toHaveAttribute('transform', 'matrix(1 0 0 1 80 140)');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('svg rect')).toHaveAttribute('transform', 'matrix(1 0 0 1 200 140)');
  expect(errors).toEqual([]);
});
