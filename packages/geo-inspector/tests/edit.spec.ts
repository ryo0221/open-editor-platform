import { test, expect } from '@playwright/test';
import type {} from '../test-host/edit-test';
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
  await page.goto('/edit.html');
  await expect(page.getByRole('region', { name: 'Geo Point editor', exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(errors).toEqual([]);
  expect((await page.evaluate(() => window.geoEditTest.state())).errors).toEqual([]);
});
test('single Apply from stable map selection, scalar+position Undo/Redo and non-UI share authority', async ({
  page,
}, info) => {
  const initial = await page.evaluate(() => window.geoEditTest.state());
  const marker = page.getByRole('button', { name: 'Select point point-2;', exact: false });
  await marker.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.geo-point-editor')).toContainText('Target synthetic-sites/point-2');
  await page.getByLabel('Longitude', { exact: true }).fill('13.5');
  await page.getByLabel('Latitude', { exact: true }).fill('35.5');
  await page.getByLabel('Scalar value', { exact: true }).fill('25');
  expect((await page.evaluate(() => window.geoEditTest.state())).hash).toBe(initial.hash);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const changed = await page.evaluate(() => window.geoEditTest.state());
  expect(changed.revision.sequence).toBe(1);
  expect(changed.content.layers[0].features[1]).toMatchObject({
    id: 'point-2',
    rowId: 'row-2',
    geometry: { type: 'Point', coordinates: [13.5, 35.5] },
    values: { metric: 25, code: '002', active: true },
  });
  expect(changed.content.layers[0].features[0]).toEqual(initial.content.layers[0].features[0]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await page.evaluate(() => window.geoEditTest.state())).content).toEqual(initial.content);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await page.evaluate(() => window.geoEditTest.state())).content).toEqual(changed.content);
  expect((await page.evaluate(() => window.geoEditTest.nonUI('12.25', '34.25', '15'))).state).toBe(
    'applied',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await page.evaluate(() => window.geoEditTest.state())).content).toEqual(changed.content);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `/tmp/geo-inspector-evidence/edit-${info.project.name}.png`,
    fullPage: true,
  });
});
test('invalid/out-of-map buffers are retained; Cancel is native-noop, no-op Apply preserves Redo', async ({
  page,
}) => {
  const before = await page.evaluate(() => window.geoEditTest.state());
  for (const value of ['', 'NaN', '30']) {
    await page.getByLabel('Longitude', { exact: true }).fill(value);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue(value);
    expect((await page.evaluate(() => window.geoEditTest.state())).hash).toBe(before.hash);
    await expect(page.getByRole('status', { name: 'Geo edit status' })).toContainText(
      /GeoInvalidNumber|GeoLocalPointRange/,
    );
    const result = await page.evaluate(
      (value) => window.geoEditTest.nonUI(value, '34', '10'),
      value,
    );
    expect(result.state).toBe('refused');
  }
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await page.evaluate(() => window.geoEditTest.state())).revision).toEqual(before.revision);
  await page.getByLabel('Scalar value', { exact: true }).fill('20');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const undone = await page.evaluate(() => window.geoEditTest.state());
  await page.getByLabel('Longitude', { exact: true }).fill('12.0');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const noop = await page.evaluate(() => window.geoEditTest.state());
  expect(noop.revision).toEqual(undone.revision);
  expect(noop.canRedo).toBe(true);
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
});
test('empty IME cancel pins target; stale detached input cannot edit a newly selected feature', async ({
  page,
}) => {
  const input = page.getByLabel('Longitude', { exact: true });
  const initial = await page.evaluate(() => window.geoEditTest.state());
  await input.dispatchEvent('compositionstart', { data: '' });
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Select point-2 (Point)', exact: true }).click();
  await expect(page.locator('.geo-point-editor')).toContainText('Target synthetic-sites/point-1');
  await input.dispatchEvent('compositionend', { data: '' });
  await page.getByRole('button', { name: 'Select point-2 (Point)', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Geo edit status' })).toContainText(
    'GeoPendingInputs',
  );
  const retired = await input.elementHandle();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Select point-2 (Point)', exact: true }).click();
  await retired!.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '60';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { data: '60', bubbles: true }));
  });
  await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('13');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  expect((await page.evaluate(() => window.geoEditTest.state())).content).toEqual(initial.content);
  await page.getByLabel('Scalar value', { exact: true }).fill('22');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const after = await page.evaluate(() => window.geoEditTest.state());
  expect(after.content.layers[0].features[0]).toEqual(initial.content.layers[0].features[0]);
  expect(after.content.layers[0].features[1].values.metric).toBe(22);
});
test('stale and dirty field/feature switching refuse without buffer loss', async ({ page }) => {
  await page.getByLabel('Scalar value', { exact: true }).fill('20');
  await page.getByLabel('Scalar field', { exact: true }).selectOption('code');
  await expect(page.getByLabel('Scalar field', { exact: true })).toHaveValue('metric');
  await page.evaluate(() => window.geoEditTest.stale());
  const before = await page.evaluate(() => window.geoEditTest.state());
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Geo edit status' })).toContainText(
    'GeoStaleBuffer',
  );
  await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('20');
  expect((await page.evaluate(() => window.geoEditTest.state())).content).toEqual(before.content);
});
test('readonly capability/profile refusal and unsupported geometry preserve native', async ({
  page,
}) => {
  for (const mode of ['readonly', 'no-inputs', 'source'] as const) {
    await page.evaluate((mode) => window.geoEditTest.open(mode), mode);
    await expect(page.getByLabel('Longitude', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    const before = await page.evaluate(() => window.geoEditTest.state());
    expect(before.canUndo).toBe(false);
    await expect(page.locator('.geo-point-editor')).toContainText(
      mode === 'source' ? 'GeoSourceFreeProfileRequired' : 'Read-only: edit and Inputs',
    );
  }
  await page.evaluate(() => window.geoEditTest.open());
  for (const name of ['Select point-4 (null)', 'Select point-5 (LineString)']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByLabel('Longitude', { exact: true })).toBeDisabled();
    await expect(page.locator('.geo-point-editor')).toContainText('GeoPointOnly');
  }
  expect((await page.evaluate(() => window.geoEditTest.state())).canUndo).toBe(false);
});
test('post-open edit loss revokes whole scope; fresh readonly and replacement isolate old callbacks', async ({
  page,
}) => {
  const retired = await page.getByLabel('Longitude', { exact: true }).elementHandle();
  await page.getByLabel('Longitude', { exact: true }).fill('12.5');
  await page.evaluate(() => window.geoEditTest.revoke());
  await expect(page.locator('.geo-point-editor')).toHaveCount(0);
  await expect
    .poll(async () => (await page.evaluate(() => window.geoEditTest.drain())).state)
    .toBe('drained');
  expect((await page.evaluate(() => window.geoEditTest.drain())).failed).toEqual([]);
  await page.evaluate(() => window.geoEditTest.open('readonly'));
  await expect(page.getByLabel('Longitude', { exact: true })).toBeDisabled();
  await page.evaluate(() => window.geoEditTest.replace());
  await retired!.evaluate((element) => {
    (element as HTMLInputElement).value = '60';
    element.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('12');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.geoEditTest.retired())).every(
        (r) => r.state === 'drained' && r.failed.length === 0,
      ),
    )
    .toBe(true);
});

test('oversized numeric and multibyte scalar buffers refuse before parsing and remain intact', async ({
  page,
}) => {
  const before = await page.evaluate(() => window.geoEditTest.state());
  const numeric = '0'.repeat(127) + '12';
  await page.getByLabel('Longitude', { exact: true }).fill(numeric);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Geo edit status' })).toContainText(
    'GeoDraftTextLimit',
  );
  await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue(numeric);
  let after = await page.evaluate(() => window.geoEditTest.state());
  expect(after.hash).toBe(before.hash);
  expect(after.revision).toEqual(before.revision);
  expect(after.canUndo).toBe(false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Scalar field', { exact: true }).selectOption('code');
  const scalar = '界'.repeat(3000);
  await page.getByLabel('Scalar value', { exact: true }).fill(scalar);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Geo edit status' })).toContainText(
    'GeoDraftByteLimit',
  );
  await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue(scalar);
  after = await page.evaluate(() => window.geoEditTest.state());
  expect(after.content).toEqual(before.content);
  expect(after.hash).toBe(before.hash);
  expect(after.canUndo).toBe(false);
  expect(after.canRedo).toBe(false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('001');
});

test('attribute table and map share stable selection, edited values and native Undo', async ({
  page,
}, info) => {
  const before = await page.evaluate(() => window.geoEditTest.state());
  const table = page.getByRole('region', { name: 'Attributes synthetic-sites', exact: true });
  await expect(table.getByRole('row')).toHaveCount(6);
  await expect(
    table.getByRole('columnheader', { name: 'Metric (number)', exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole('columnheader', { name: 'Code (string)', exact: true }),
  ).toBeVisible();
  await expect(table.locator('[data-feature-id="point-4"]')).toContainText(
    'null — location unknown',
  );
  await expect(table.locator('[data-feature-id="point-5"]')).toContainText('LineString');
  await expect(table.locator('[data-feature-id="point-1"]')).toContainText('001');
  await page.getByRole('button', { name: 'Select point point-2;', exact: false }).click();
  await expect(
    table.getByRole('button', { name: 'Select point-2 (Point)', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await table.getByRole('button', { name: 'Select point-3 (Point)', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select point point-3;', exact: false }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect((await page.evaluate(() => window.geoEditTest.state())).hash).toBe(before.hash);
  await page.getByLabel('Longitude', { exact: true }).fill('12.5');
  await page.getByLabel('Scalar value', { exact: true }).fill('27');
  await table.getByRole('button', { name: 'Select point-1 (Point)', exact: true }).click();
  await expect(
    table.getByRole('button', { name: 'Select point-3 (Point)', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('27');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const row = table.locator('[data-feature-id="point-3"]');
  await expect(row.getByRole('cell', { name: '12.5', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: '27', exact: true })).toBeVisible();
  await expect(row).toContainText('row-3');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await page.evaluate(() => window.geoEditTest.state())).content).toEqual(before.content);
  await expect(row.getByRole('cell', { name: '10', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(row.getByRole('cell', { name: '27', exact: true })).toBeVisible();
  await table.scrollIntoViewIfNeeded();
  if (info.project.name === 'narrow') {
    expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await table.evaluate((el) => {
      el.scrollLeft = 0;
    });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `/tmp/geo-inspector-evidence/table-${info.project.name}.png`,
    fullPage: true,
  });
});

test('source table shows scalar null, false and literal HTML without hiding nonPoint rows', async ({
  page,
}) => {
  await page.evaluate(() => window.geoEditTest.open('source'));
  const table = page.getByRole('region', { name: 'Attributes synthetic-sites', exact: true });
  await expect(table.getByRole('row')).toHaveCount(4);
  const row = table.locator('[data-feature-id="site-02"]');
  await expect(row.getByRole('cell', { name: 'null', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: 'false', exact: true })).toBeVisible();
  await expect(row).toContainText(
    JSON.stringify('<img src="https://invalid.example/x" onerror="alert(1)">'),
  );
  await expect(table.locator('img,script')).toHaveCount(0);
  await expect(table.locator('[data-feature-id="multi-03"]')).toContainText('MultiPoint');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
});

test('clean disappeared selection refreshes form, map and table through empty and restored history', async ({
  page,
}) => {
  await page.evaluate(() => window.geoEditTest.removeFeatures(['point-1']));
  await expect(page.locator('.geo-point-editor')).toContainText('Target synthetic-sites/point-2');
  await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('13');
  await expect(
    page.getByRole('button', { name: 'Select point point-2;', exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  const afterFirst = await page.evaluate(() => window.geoEditTest.state());
  await page.evaluate(() =>
    window.geoEditTest.removeFeatures(
      // Remove every remaining feature so a stale form cannot survive an empty native layer.
      ['point-2', 'point-3', 'point-4', 'point-5'],
    ),
  );
  const afterRemoval = await page.evaluate(() => window.geoEditTest.state());
  expect(afterRemoval.content.layers[0].features).toHaveLength(0);
  await expect(page.getByLabel('Longitude', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await page.evaluate(() => window.geoEditTest.state())).content).toEqual(
    afterFirst.content,
  );
  await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('13');
  await expect(
    page.getByRole('button', { name: 'Select point point-2;', exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('Longitude', { exact: true })).toHaveCount(0);
});
