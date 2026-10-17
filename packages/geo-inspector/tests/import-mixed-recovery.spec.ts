import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type {} from '../test-host/import-test';
declare global {
  interface Window {
    retiredImportSelection(): void;
  }
}
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
  await page.goto('/import.html');
});
test.afterEach(async ({ page }) => {
  expect(errors).toEqual([]);
  expect((await page.evaluate(() => window.geoImportTest.state())).errors).toEqual([]);
});
const preview = (page: Page) => page.getByRole('button', { name: 'Preview import', exact: true });
const commit = (page: Page) =>
  page.getByRole('button', { name: 'Import previewed data', exact: true });
const region = (page: Page) =>
  page.getByRole('region', { name: 'Import geographic data', exact: true });
async function localFile(page: Page, name: string, text: string) {
  await page
    .getByLabel('Local file', { exact: true })
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
}
async function field(page: Page, name: string, type = 'string') {
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Input column/property 1', { exact: true }).fill(name);
  await page.getByLabel('Type 1', { exact: true }).selectOption(type);
}

test('mixed/null/nested GeoJSON diagnostics agree with exact retained shapes and excluded rows', async ({
  page,
}) => {
  const shapes = [
    { type: 'Point', coordinates: [12, 34] },
    null,
    {
      type: 'LineString',
      coordinates: [
        [12, 34],
        [13, 35],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [12, 34],
          [14, 34],
          [14, 36],
          [12, 34],
        ],
        [
          [12.5, 34.2],
          [13, 34.2],
          [13, 34.5],
          [12.5, 34.2],
        ],
      ],
    },
    {
      type: 'MultiPoint',
      coordinates: [
        [12, 34],
        [13, 35],
      ],
    },
  ];
  const collection = {
    type: 'FeatureCollection',
    features: [
      ...shapes.map((geometry, i) => ({
        type: 'Feature',
        id: `keep-${i}`,
        geometry,
        properties: { tag: `value-${i}` },
      })),
      {
        type: 'Feature',
        id: 'nested-null',
        geometry: null,
        properties: { tag: { nested: ['original retained'] } },
      },
      {
        type: 'Feature',
        id: 'collection',
        geometry: { type: 'GeometryCollection', geometries: [] },
        properties: { tag: 'unsupported' },
      },
    ],
  };
  const bytes = JSON.stringify(collection);
  await page.getByLabel('Format', { exact: true }).selectOption('geojson');
  await localFile(page, 'mixed.geojson', bytes);
  await field(page, 'tag');
  await preview(page).click();
  await expect(region(page)).toContainText('Read 7; valid 5; problem 2');
  await expect(region(page)).toContainText('Row 6: error nested-property');
  await expect(region(page)).toContainText('Row 7: error unsupported-geometry');
  await expect(region(page)).toContainText('topology-not-checked');
  await expect(page.getByRole('list', { name: 'Mapped coordinate sample' })).toContainText(
    'Row 2: No location (null geometry).',
  );
  await expect(commit(page)).toBeDisabled();
  await page.getByRole('checkbox').check();
  await commit(page).click();
  await expect(region(page)).toContainText('Excluded row 6: nested-property');
  await expect(region(page)).toContainText('Excluded row 7:');
  await expect(region(page)).toContainText('GeoJSON row numbers count features starting at 1.');
  const imported = await page.evaluate(() => window.geoImportTest.state());
  expect(imported.content.layers[0].features.map((f) => f.geometry)).toEqual(shapes);
  expect(imported.content.layers[0].features.map((f) => f.sourceRef?.externalId)).toEqual(
    shapes.map((_, i) => `keep-${i}`),
  );
  expect(imported.content.sources[0].bytesHash).toBe(
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  );
  expect(imported.retained).toBe(1);
  expect(await page.evaluate(() => window.geoImportTest.retainedHashes())).toEqual([
    {
      resourceId: imported.content.sources[0].resourceId,
      bytesHash: imported.content.sources[0].bytesHash,
    },
  ]);
  await expect(page.locator('#imported')).toContainText('1 displayed · 4 non-Point/null retained');
  await expect(page.locator('#imported tbody tr')).toHaveCount(5);
  await page.getByRole('button', { name: 'Undo import', exact: true }).click();
  const undone = await page.evaluate(() => window.geoImportTest.state());
  expect(undone.content.layers).toHaveLength(0);
  expect(undone.content.sources).toHaveLength(0);
  expect(undone.retained).toBe(1);
  await page.getByRole('button', { name: 'Redo import', exact: true }).click();
  expect((await page.evaluate(() => window.geoImportTest.state())).content).toEqual(
    imported.content,
  );
});

test('long multibyte names and quoted CRLF records preserve values and identify logical error rows', async ({
  page,
}, info) => {
  const name = '調査結果📍'.repeat(30);
  await page.getByLabel('First coordinate column', { exact: true }).fill('経度');
  await page.getByLabel('Second coordinate column', { exact: true }).fill('緯度');
  await field(page, name, 'number');
  const firstValue = '第一行\r\n第二行, "引用"';
  await localFile(
    page,
    'quoted.csv',
    `経度,緯度,${name}\r\n12,34,"第一行\r\n第二行, ""引用"""\r\n,35,修正対象\r\n13,35,第三行\r\n`,
  );
  await preview(page).click();
  await expect(region(page)).toContainText(`row:1.${name}`);
  await expect(region(page)).toContainText('selected Type');
  await page.getByLabel('Type 1', { exact: true }).selectOption('string');
  await preview(page).click();
  await expect(region(page)).toContainText('Read 3; valid 2; problem 1');
  await expect(region(page)).toContainText('Row 2: error coordinate-number');
  await expect(region(page)).toContainText('not physical file lines');
  await page.getByRole('checkbox').check();
  await commit(page).click();
  await expect(region(page)).toContainText('Excluded row 2: coordinate-number');
  await expect(region(page)).toContainText('not physical file lines');
  const imported = await page.evaluate(() => window.geoImportTest.state());
  expect(imported.content.layers[0].fields[0].name).toBe(name);
  expect(imported.content.layers[0].features.map((f) => f.values['field-1'])).toEqual([
    firstValue,
    '第三行',
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('status').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/geo-inspector-evidence/mixed-crlf-${info.project.name}.png`,
  });
});

test('duplicate multibyte headers refuse before import and corrected headers can be retried', async ({
  page,
}) => {
  await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
  await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
  await field(page, '名称📍');
  const before = await page.evaluate(() => window.geoImportTest.state());
  await localFile(page, 'duplicate.csv', 'lon,lat,名称📍,名称📍\r\n12,34,A,B');
  await preview(page).click();
  await expect(page.getByRole('status')).toContainText('csv-header');
  await expect(page.getByRole('status')).toContainText('unique name');
  await expect(commit(page)).toBeDisabled();
  const refused = await page.evaluate(() => window.geoImportTest.state());
  expect(refused.hash).toBe(before.hash);
  expect(refused.staged).toBe(0);
  await localFile(page, 'corrected.csv', 'lon,lat,名称📍\r\n12,34,A');
  await preview(page).click();
  await commit(page).click();
  expect(
    (await page.evaluate(() => window.geoImportTest.state())).content.layers[0].features[0].values[
      'field-1'
    ],
  ).toBe('A');
});

test('Undo/Redo then another file keeps source pins distinct and retired selections inert', async ({
  page,
}) => {
  await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
  await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
  await field(page, 'tag');
  await localFile(page, 'A.csv', 'lon,lat,tag\n12,34,A');
  await preview(page).click();
  await commit(page).click();
  const a = await page.evaluate(() => window.geoImportTest.state());
  const idA = a.content.layers[0].features[0].id;
  const rowA = page.getByRole('button', { name: `Select ${idA} (Point)`, exact: true });
  await rowA.click();
  await rowA.evaluate((element) => {
    const button = element as HTMLButtonElement,
      callback = button.onclick!;
    window.retiredImportSelection = () => {
      callback.call(button, new PointerEvent('click'));
    };
  });
  await page.getByRole('button', { name: 'Undo import', exact: true }).click();
  await page.evaluate(() => window.retiredImportSelection());
  await expect(page.locator('#imported tbody tr')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo import', exact: true }).click();
  expect((await page.evaluate(() => window.geoImportTest.state())).content).toEqual(a.content);
  await localFile(page, 'B.csv', 'lon,lat,tag\n13,35,B');
  await preview(page).click();
  await commit(page).click();
  const b = await page.evaluate(() => window.geoImportTest.state());
  expect(b.content.layers).toHaveLength(2);
  expect(b.content.layers[0]).toEqual(a.content.layers[0]);
  expect(b.content.sources[0]).toEqual(a.content.sources[0]);
  expect(b.content.sources[0].id).not.toBe(b.content.sources[1].id);
  expect(b.content.sources[0].pin).not.toEqual(b.content.sources[1].pin);
  expect(b.content.sources[0].bytesHash).not.toBe(b.content.sources[1].bytesHash);
  const idB = b.content.layers[1].features[0].id;
  expect(idB).not.toBe(idA);
  await page.getByRole('button', { name: `Select ${idB} (Point)`, exact: true }).click();
  await page.evaluate(() => window.retiredImportSelection());
  await expect(
    page.getByRole('button', { name: `Select point ${idB};`, exact: false }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(rowA).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Undo import', exact: true }).click();
  expect((await page.evaluate(() => window.geoImportTest.state())).content).toEqual(a.content);
  await page.getByRole('button', { name: 'Redo import', exact: true }).click();
  const restored = await page.evaluate(() => window.geoImportTest.state());
  expect(restored.content).toEqual(b.content);
  expect(restored.retained).toBe(2);
  expect(await page.evaluate(() => window.geoImportTest.retainedHashes())).toEqual(
    b.content.sources.map(({ resourceId, bytesHash }) => ({ resourceId, bytesHash })),
  );
});

test('preserve-null does not retain a row with a separate scalar error', async ({ page }) => {
  await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
  await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
  await page.getByLabel('Missing coordinate policy', { exact: true }).selectOption('preserve-null');
  await field(page, 'metric', 'number');
  await localFile(page, 'null-errors.csv', 'lon,lat,metric\r\n,,0\r\n,,invalid');
  await preview(page).click();
  await expect(region(page)).toContainText('Read 2; valid 1; problem 1');
  await expect(region(page)).toContainText('Row 2: warning null-geometry');
  await expect(region(page)).toContainText('Row 2: error attribute-type');
  await expect(commit(page)).toBeDisabled();
  await page.getByRole('checkbox').check();
  await commit(page).click();
  await expect(region(page)).toContainText('Excluded row 2: attribute-type');
  const { content } = await page.evaluate(() => window.geoImportTest.state());
  expect(content.layers[0].features).toHaveLength(1);
  expect(content.layers[0].features[0].geometry).toBeNull();
  expect(content.layers[0].features[0].values['field-1']).toBe(0);
});
