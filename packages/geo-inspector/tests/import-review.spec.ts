import { test, expect, type Page } from '@playwright/test';
import type {} from '../test-host/import-test';
declare global {
  interface Window {
    reviewHash: { blocked: boolean; completed: boolean; release(): void };
    retiredRemove(): void;
  }
}
async function setup(page: Page) {
  await page.goto('/import.html');
  await page.getByLabel('ID column (optional)', { exact: true }).fill('ID');
  await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
  await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
  for (const [i, name] of ['ID', 'value'].entries()) {
    await page.getByRole('button', { name: 'Add field', exact: true }).click();
    await page.getByLabel(`Input column/property ${i + 1}`, { exact: true }).fill(name);
  }
  await page.getByLabel('Type 2', { exact: true }).selectOption('number');
}
async function file(page: Page, name: string, value: number) {
  await page.getByLabel('Local file', { exact: true }).setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(`ID,lon,lat,value\n001,12,34,${value}`),
  });
}
test('cancelled manifest hashing A cannot overwrite valid preview B source reservation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);
  await page.evaluate(() => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = crypto.subtle.digest.bind(crypto.subtle);
    window.reviewHash = { blocked: false, completed: false, release };
    crypto.subtle.digest = async (algorithm, data) => {
      const paused = new TextDecoder().decode(data).includes('"name":"A.csv"');
      if (paused) {
        window.reviewHash.blocked = true;
        await gate;
      }
      const result = await original(algorithm, data);
      if (paused) window.reviewHash.completed = true;
      return result;
    };
  });
  await file(page, 'A.csv', 1);
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.reviewHash.blocked)).toBe(true);
  expect((await page.evaluate(() => window.geoImportTest.state())).staged).toBe(1);
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  expect((await page.evaluate(() => window.geoImportTest.state())).staged).toBe(0);
  await file(page, 'B.csv', 2);
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preview ready');
  await page.evaluate(() => window.reviewHash.release());
  await expect.poll(() => page.evaluate(() => window.reviewHash.completed)).toBe(true);
  await expect(page.getByRole('status')).toContainText('Preview ready');
  await page.getByRole('button', { name: 'Import previewed data', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Imported 1');
  const state = await page.evaluate(() => window.geoImportTest.state());
  expect(state.content.layers[0].features[0].values['field-2']).toBe(2);
  expect(state.content.sources).toHaveLength(1);
  expect(state.staged).toBe(0);
  expect(state.retained).toBe(1);
  expect(state.errors).toEqual([]);
  expect(errors).toEqual([]);
});
test('retired Remove field callback cannot delete another mapping or invalidate its preview', async ({
  page,
}) => {
  await setup(page);
  await file(page, 'B.csv', 7);
  await page.getByRole('button', { name: 'Remove field 1', exact: true }).evaluate((element) => {
    const button = element as HTMLButtonElement,
      callback = button.onclick!;
    window.retiredRemove = () => {
      if (button.onclick !== null) throw new Error('RetiredHandlerStillAttached');
      callback.call(button, new PointerEvent('click'));
    };
  });
  await page.getByRole('button', { name: 'Remove field 1', exact: true }).click();
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preview ready');
  await page.evaluate(() => {
    window.retiredRemove();
    window.retiredRemove();
  });
  await expect(page.getByRole('status')).toContainText('Preview ready');
  await page.getByRole('button', { name: 'Import previewed data', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Imported 1');
  const state = await page.evaluate(() => window.geoImportTest.state());
  expect(state.content.layers[0].fields.map((f) => f.id)).toEqual(['field-2']);
  expect(state.content.layers[0].features[0].values['field-2']).toBe(7);
  await page.evaluate(() => {
    window.geoImportTest.revoke();
    window.retiredRemove();
  });
  expect((await page.evaluate(() => window.geoImportTest.state())).content).toEqual(state.content);
});
