import { test, expect, type Page } from '@playwright/test';
import type {} from '../test-host/import-test';
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
async function field(page: Page, index: number, input: string, type = 'string') {
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel(`Input column/property ${index}`, { exact: true }).fill(input);
  await page.getByLabel(`Type ${index}`, { exact: true }).selectOption(type);
}
async function csv(page: Page, text: string) {
  await page
    .getByLabel('Local file', { exact: true })
    .setInputFiles({ name: 'sites.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
  await page.getByLabel('ID column (optional)', { exact: true }).fill('ID');
  await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
  await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
  await field(page, 1, 'ID');
  await field(page, 2, 'value', 'number');
}
test('200-row local CSV previews two errors, requires explicit198 commit and one Undo/Redo', async ({
  page,
}, info) => {
  const text = [
    'ID,lon,lat,value',
    ...Array.from(
      { length: 200 },
      (_, i) => `${String(i + 1).padStart(3, '0')},${i > 197 ? '' : 12 + i / 1000},34,${i}`,
    ),
  ].join('\n');
  await csv(page, text);
  const before = await page.evaluate(() => window.geoImportTest.state());
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Import geographic data', exact: true }),
  ).toContainText('Read 200; valid 198; problem 2');
  await expect(
    page.getByRole('button', { name: 'Import previewed data', exact: true }),
  ).toBeDisabled();
  expect((await page.evaluate(() => window.geoImportTest.state())).hash).toBe(before.hash);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Import previewed data', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Imported 198; excluded 2');
  const imported = await page.evaluate(() => window.geoImportTest.state());
  expect(imported.content.layers[0].features).toHaveLength(198);
  expect(imported.content.sources).toHaveLength(1);
  expect(imported.retained).toBe(1);
  expect(imported.content.layers[0].features[0].values['field-1']).toBe('001');
  await expect(
    page.getByRole('region', { name: 'Import geographic data', exact: true }),
  ).toContainText('Excluded row 199');
  const feature = imported.content.layers[0].features[1].id;
  await page.getByRole('button', { name: `Select ${feature} (Point)`, exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Select point ${feature};`, exact: false }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Undo import', exact: true }).click();
  expect((await page.evaluate(() => window.geoImportTest.state())).content).toEqual(before.content);
  await page.getByRole('button', { name: 'Redo import', exact: true }).click();
  expect((await page.evaluate(() => window.geoImportTest.state())).content).toEqual(
    imported.content,
  );
  await page.getByRole('status').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/geo-inspector-evidence/import-${info.project.name}.png` });
});
test('explicit CSV reverse axis and preserve-null retain duplicate external IDs and missing location', async ({
  page,
}) => {
  await csv(page, 'ID,lon,lat,value\n001,34,12,0\n001,,,');
  await page.getByLabel('CSV coordinate order', { exact: true }).selectOption('latitude-longitude');
  await page.getByLabel('Missing coordinate policy', { exact: true }).selectOption('preserve-null');
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preview ready');
  await expect(
    page.getByRole('region', { name: 'Import geographic data', exact: true }),
  ).toContainText('duplicate-external-id');
  await page.getByRole('button', { name: 'Import previewed data', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Imported 2');
  const { content } = await page.evaluate(() => window.geoImportTest.state());
  const [a, b] = content.layers[0].features;
  expect(a.geometry).toEqual({ type: 'Point', coordinates: [12, 34] });
  expect(b.geometry).toBeNull();
  expect(b.values['field-2']).toBeNull();
  expect(a.sourceRef?.externalId).toBe('001');
  expect(b.sourceRef?.externalId).toBe('001');
  expect(a.id).not.toBe(b.id);
});
test('GeoJSON properties map explicitly and mixed geometry/HTML text remain intact', async ({
  page,
}) => {
  await page.getByLabel('Format', { exact: true }).selectOption('geojson');
  const collection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 1,
        geometry: { type: 'Point', coordinates: [12, 34] },
        properties: { name: '<img src=x onerror=alert(1)>', active: false },
      },
      {
        type: 'Feature',
        id: '1',
        geometry: {
          type: 'LineString',
          coordinates: [
            [12, 34],
            [13, 35],
          ],
        },
        properties: { name: '', active: null },
      },
    ],
  };
  await page.getByLabel('Local file', { exact: true }).setInputFiles({
    name: 'data.geojson',
    mimeType: 'application/geo+json',
    buffer: Buffer.from(JSON.stringify(collection)),
  });
  await field(page, 1, 'name');
  await field(page, 2, 'active', 'boolean');
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preview ready');
  await page.getByRole('button', { name: 'Import previewed data', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Imported 2');
  const { content } = await page.evaluate(() => window.geoImportTest.state());
  expect(content.layers[0].features[1].geometry).toEqual(collection.features[1].geometry);
  expect(content.layers[0].features[0].values['field-2']).toBe(false);
  await expect(page.locator('#imported img, #imported script')).toHaveCount(0);
  await expect(page.locator('#imported')).toContainText('<img src=x onerror=alert(1)>');
});
test('mapping changes invalidate preview; cancelled and revoked late preparation cannot commit', async ({
  page,
}) => {
  await csv(page, 'ID,lon,lat,value\n001,12,34,0');
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preview ready');
  await page.getByLabel('Layer name', { exact: true }).fill('Changed');
  await expect(
    page.getByRole('button', { name: 'Import previewed data', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.geoImportTest.holdSource());
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview import', exact: true })).toBeEnabled();
  await page.evaluate(() => window.geoImportTest.releaseSource());
  await expect(page.getByRole('status')).toContainText('Import cancelled');
  expect((await page.evaluate(() => window.geoImportTest.state())).content.layers).toEqual([]);
  await page.evaluate(() => window.geoImportTest.holdSource());
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await page.evaluate(() => {
    window.geoImportTest.revoke();
    window.geoImportTest.releaseSource();
  });
  await expect(
    page.getByRole('region', { name: 'Import geographic data', exact: true }),
  ).toHaveCount(0);
  expect((await page.evaluate(() => window.geoImportTest.state())).content.layers).toEqual([]);
});
test('unmapped columns reject without losing native and stale preview refuses after Undo', async ({
  page,
}) => {
  await csv(page, 'ID,lon,lat,value\n001,12,34,0');
  await page.getByLabel('Input column/property 2', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('csv-column-mapping');
  expect((await page.evaluate(() => window.geoImportTest.state())).staged).toBe(0);
  expect((await page.evaluate(() => window.geoImportTest.state())).content.layers).toEqual([]);
  await page.getByLabel('Input column/property 2', { exact: true }).fill('value');
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preview ready');
  await page.getByRole('button', { name: 'Import previewed data', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Imported 1');
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preview ready');
  await page.getByRole('button', { name: 'Undo import', exact: true }).click();
  const before = await page.evaluate(() => window.geoImportTest.state());
  await page.getByRole('button', { name: 'Import previewed data', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('stale-preview');
  expect((await page.evaluate(() => window.geoImportTest.state())).content).toEqual(before.content);
});

test('complete-view capacity refuses before import and original adoption', async ({ page }) => {
  await page.getByLabel('Format', { exact: true }).selectOption('geojson');
  const value = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'large',
        geometry: { type: 'Point', coordinates: [12, 34] },
        properties: { text: 'x'.repeat(65000) },
      },
    ],
  };
  await page.getByLabel('Local file', { exact: true }).setInputFiles({
    name: 'large.geojson',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await field(page, 1, 'text');
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preview ready');
  const before = await page.evaluate(() => window.geoImportTest.state());
  await page.getByRole('button', { name: 'Import previewed data', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ImportControlledCapacity');
  const after = await page.evaluate(() => window.geoImportTest.state());
  expect(after.content).toEqual(before.content);
  expect(after.revision).toEqual(before.revision);
  expect(after.canUndo).toBe(false);
  expect(after.retained).toBe(0);
});
