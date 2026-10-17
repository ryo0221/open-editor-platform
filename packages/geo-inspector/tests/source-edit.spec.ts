import { test, expect } from '@playwright/test';
import type {} from '../test-host/source-edit-test';
const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:4199/')) errors.push(r.url());
  });
  await page.goto('/source-edit.html');
  await page.waitForFunction(() => !!window.geoSourceEditTest);
});
test.afterEach(async ({ page }) => {
  expect(errors).toEqual([]);
  expect((await page.evaluate(() => window.geoSourceEditTest.state())).errors).toEqual([]);
});
test('explicit retained closure enables one Point/scalar edit with exact source and exclusion retention', async ({
  page,
}, info) => {
  const before = await page.evaluate(() => window.geoSourceEditTest.state());
  expect(before.content.layers[0].features).toHaveLength(2);
  expect(before.excluded.map((r) => r.inputRow)).toEqual([3]);
  expect(before.originalHash).toBe(before.content.sources[0].bytesHash);
  await page.getByLabel('Longitude', { exact: true }).fill('12.5');
  await page.getByLabel('Latitude', { exact: true }).fill('34.5');
  await page.getByLabel('Scalar value', { exact: true }).fill('25');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const changed = await page.evaluate(() => window.geoSourceEditTest.state());
  expect(changed.revision.sequence).toBe(1);
  expect(changed.content.sources).toEqual(before.content.sources);
  expect(changed.content.layers[0].features[0]).toMatchObject({
    geometry: { type: 'Point', coordinates: [12.5, 34.5] },
    values: { metric: 25 },
    sourceRef: before.content.layers[0].features[0].sourceRef,
  });
  expect(changed.excluded).toEqual(before.excluded);
  expect(changed.originalHash).toBe(before.originalHash);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await page.evaluate(() => window.geoSourceEditTest.state())).content).toEqual(
    before.content,
  );
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await page.evaluate(() => window.geoSourceEditTest.state())).content).toEqual(
    changed.content,
  );
  expect((await page.evaluate(() => window.geoSourceEditTest.nonUI('30'))).state).toBe('applied');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `/tmp/geo-inspector-evidence/source-edit-${info.project.name}.png`,
    fullPage: true,
  });
});
test('closure loss refuses and preserves dirty IME buffer; restored proof allows explicit retry', async ({
  page,
}) => {
  const before = await page.evaluate(() => window.geoSourceEditTest.state());
  const scalar = page.getByLabel('Scalar value', { exact: true });
  await scalar.fill('44');
  await scalar.dispatchEvent('compositionstart', { data: '' });
  await page.evaluate(() => window.geoSourceEditTest.closure(false));
  expect((await page.evaluate(() => window.geoSourceEditTest.applyInputs())).state).toBe('refused');
  await expect(scalar).toHaveValue('44');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  expect((await page.evaluate(() => window.geoSourceEditTest.state())).hash).toBe(before.hash);
  await scalar.dispatchEvent('compositionend', { data: '44' });
  expect((await page.evaluate(() => window.geoSourceEditTest.applyInputs())).state).toBe('refused');
  await expect(scalar).toHaveValue('44');
  await page.evaluate(() => window.geoSourceEditTest.closure(true));
  await scalar.fill('45');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  expect(
    (await page.evaluate(() => window.geoSourceEditTest.state())).content.layers[0].features[0]
      .values.metric,
  ).toBe(45);
});
test('prepared command rechecks lost closure and changed pin cannot be edited', async ({
  page,
}) => {
  const before = await page.evaluate(() => window.geoSourceEditTest.state());
  expect((await page.evaluate(() => window.geoSourceEditTest.prepareThenLose())).state).toBe(
    'refused',
  );
  expect((await page.evaluate(() => window.geoSourceEditTest.state())).hash).toBe(before.hash);
  await page.evaluate(() => {
    window.geoSourceEditTest.closure(true);
    window.geoSourceEditTest.changedPin();
  });
  const replaced = await page.evaluate(() => window.geoSourceEditTest.state());
  expect((await page.evaluate(() => window.geoSourceEditTest.nonUI('99'))).state).toBe('refused');
  expect((await page.evaluate(() => window.geoSourceEditTest.state())).hash).toBe(replaced.hash);
  await expect(page.getByLabel('Scalar value', { exact: true })).toBeDisabled();
  await expect(page.locator('.geo-point-editor')).toContainText('GeoSourceClosureRequired');
});
test('history proof refusal leaves native untouched and existing Undo/Redo resumes with proof', async ({
  page,
}) => {
  await page.getByLabel('Scalar value', { exact: true }).fill('33');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const changed = await page.evaluate(() => window.geoSourceEditTest.state());
  await page.evaluate(() => window.geoSourceEditTest.history(false));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Geo edit status' })).toContainText(
    'GeoSourceClosureRequired',
  );
  expect((await page.evaluate(() => window.geoSourceEditTest.state())).hash).toBe(changed.hash);
  await page.evaluate(() => window.geoSourceEditTest.history(true));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const restored = await page.evaluate(() => window.geoSourceEditTest.state());
  expect(restored.content).toEqual(changed.content);
  expect(restored.excluded).toEqual(changed.excluded);
  expect(restored.originalHash).toBe(changed.originalHash);
});
