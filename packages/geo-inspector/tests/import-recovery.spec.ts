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
test.afterEach(() => expect(errors).toEqual([]));
const preview = (page: Page) => page.getByRole('button', { name: 'Preview import', exact: true });
const commit = (page: Page) =>
  page.getByRole('button', { name: 'Import previewed data', exact: true });
async function file(page: Page, text: string, name = 'synthetic.csv') {
  await page
    .getByLabel('Local file', { exact: true })
    .setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
}
async function setup(page: Page) {
  await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
  await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Input column/property 1', { exact: true }).fill('value');
  await page.getByLabel('Type 1', { exact: true }).selectOption('number');
}
test('wrong column and scalar type explain repairs and can be retried without native changes', async ({
  page,
}) => {
  await setup(page);
  await file(page, 'lon,lat,value\n12,34,ready');
  const before = await page.evaluate(() => window.geoImportTest.state());
  await page.getByLabel('First coordinate column', { exact: true }).fill('longitude');
  await preview(page).click();
  await expect(page.getByRole('status')).toContainText('csv-column-mapping');
  await expect(page.getByRole('status')).toContainText('exact CSV header');
  await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
  await preview(page).click();
  await expect(
    page.getByRole('region', { name: 'Import geographic data', exact: true }),
  ).toContainText('selected Type');
  await expect(commit(page)).toBeDisabled();
  expect((await page.evaluate(() => window.geoImportTest.state())).hash).toBe(before.hash);
  await page.getByLabel('Type 1', { exact: true }).selectOption('string');
  await preview(page).click();
  await commit(page).click();
  expect(
    (await page.evaluate(() => window.geoImportTest.state())).content.layers[0].features[0].values[
      'field-1'
    ],
  ).toBe('ready');
});
test('axis preview is inspectable before commit; partial exclusions identify logical data rows for correction', async ({
  page,
}, info) => {
  await setup(page);
  await file(page, 'lon,lat,value\n34,12,7\n,12,8');
  await preview(page).click();
  const region = page.getByRole('region', { name: 'Import geographic data', exact: true });
  await expect(region).toContainText('CSV row numbers count data records after the header');
  await expect(region).toContainText('longitude 34; latitude 12');
  await expect(region).toContainText('Both coordinates must be finite numbers');
  await page.getByLabel('CSV coordinate order', { exact: true }).selectOption('latitude-longitude');
  await preview(page).click();
  await expect(region).toContainText('longitude 12; latitude 34');
  await page.getByRole('list', { name: 'Mapped coordinate sample' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/geo-inspector-evidence/recovery-${info.project.name}.png` });
  await page.getByRole('checkbox').check();
  await commit(page).click();
  await expect(region).toContainText('Excluded row 2: coordinate-number');
  await expect(region).toContainText('Both coordinates must be finite numbers');
  const imported = await page.evaluate(() => window.geoImportTest.state());
  expect(imported.content.layers[0].features).toHaveLength(1);
  await page.getByRole('button', { name: 'Undo import', exact: true }).click();
  await file(page, 'lon,lat,value\n34,12,7\n35,12,8', 'corrected.csv');
  await preview(page).click();
  await expect(region).toContainText('Read 2; valid 2; problem 0');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await commit(page).click();
  expect(
    (await page.evaluate(() => window.geoImportTest.state())).content.layers[0].features,
  ).toHaveLength(2);
});
test('cancel then different file clears old consent and diagnostics and imports only new data', async ({
  page,
}) => {
  await setup(page);
  await file(page, 'lon,lat,value\n,34,7', 'A.csv');
  await preview(page).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  await file(page, 'lon,lat,value\n12,34,9', 'B.csv');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(commit(page)).toBeDisabled();
  await expect(
    page.getByRole('region', { name: 'Import geographic data', exact: true }),
  ).not.toContainText('coordinate-number');
  await preview(page).click();
  await commit(page).click();
  const state = await page.evaluate(() => window.geoImportTest.state());
  expect(state.content.layers).toHaveLength(1);
  expect(state.content.layers[0].features[0].values['field-1']).toBe(9);
  expect(state.retained).toBe(1);
  expect(state.staged).toBe(0);
});

test('GeoJSON unmapped property and wrong type provide repair guidance without coercion', async ({
  page,
}) => {
  await page.getByLabel('Format', { exact: true }).selectOption('geojson');
  await page.getByLabel('Local file', { exact: true }).setInputFiles({
    name: 'synthetic.geojson',
    mimeType: 'application/geo+json',
    buffer: Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [12, 34] },
            properties: { flag: 'true' },
          },
        ],
      }),
    ),
  });
  await preview(page).click();
  const region = page.getByRole('region', { name: 'Import geographic data', exact: true });
  await expect(region).toContainText('Add a mapping for every GeoJSON property');
  await expect(commit(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Input column/property 1', { exact: true }).fill('flag');
  await page.getByLabel('Type 1', { exact: true }).selectOption('boolean');
  await preview(page).click();
  await expect(region).toContainText('GeoJSON values must already have the selected type');
  await expect(commit(page)).toBeDisabled();
  await page.getByLabel('Type 1', { exact: true }).selectOption('string');
  await preview(page).click();
  await commit(page).click();
  expect(
    (await page.evaluate(() => window.geoImportTest.state())).content.layers[0].features[0].values[
      'field-1'
    ],
  ).toBe('true');
});
