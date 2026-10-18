import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { canonicalJson } from '@editor-platform/artifact-core';
import type {} from '../test-host/export-test';
declare global {
  interface Window {
    exportDigest: { blocked: boolean; done: boolean; release(): void };
  }
}
const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4199/')) errors.push(request.url());
  });
  await page.goto('/export.html');
  await page.waitForFunction(() => !!window.geoExportTest);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});
const status = (page: Page) => page.getByRole('status', { name: 'Geo export status' });
async function load(page: Page) {
  await page.getByRole('button', { name: 'Load saved geographic version' }).click();
  await expect(status(page)).toContainText('Saved version loaded');
  await page.getByLabel('Export layer', { exact: true }).selectOption('synthetic-sites');
}
async function preview(page: Page, format = 'geojson') {
  await load(page);
  await page.getByLabel('Export format', { exact: true }).selectOption(format);
  for (const field of ['code', 'value', 'active'])
    await page.getByLabel(`Include attribute ${field}`, { exact: true }).check();
  await page.getByRole('button', { name: 'Preview data export' }).click();
  await expect(status(page)).toContainText('Preview ready');
}
async function acknowledge(page: Page) {
  for (const checkbox of await page
    .getByRole('region', { name: 'Export preview', exact: true })
    .getByRole('checkbox')
    .all())
    await checkbox.check();
}
async function holdDigest(page: Page) {
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    window.exportDigest = { release, blocked: false, done: false };
    crypto.subtle.digest = async (algorithm, data) => {
      window.exportDigest.blocked = true;
      await gate;
      const result = await digest(algorithm, data);
      window.exportDigest.done = true;
      return result;
    };
  });
}
test('explicit attribute selection and losses; real ZIP has typed GeoJSON, exact hashes, provenance and no native change', async ({
  page,
}, info) => {
  const before = (await page.evaluate(() => window.geoExportTest.state())).saved;
  await load(page);
  for (const checkbox of await page.getByRole('checkbox').all())
    await expect(checkbox).not.toBeChecked();
  // Keyboard selection works without changing native content or selecting hidden attributes.
  await page.getByLabel('Include attribute code', { exact: true }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Preview data export' }).click();
  const review = page.getByRole('region', { name: 'Export preview', exact: true });
  await expect(review).toContainText('3 features; 1 null geometries');
  await expect(review).toContainText('Omitted: value, active');
  await expect(page.getByRole('button', { name: 'Export data and receipt' })).toBeDisabled();
  await acknowledge(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export data and receipt' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('geographic-data.zip');
  const files = unzipSync(new Uint8Array(await readFile((await download.path())!)));
  expect(Object.keys(files).sort()).toEqual([
    'geographic-data.geojson',
    'geographic-data.receipt.json',
  ]);
  const data = JSON.parse(strFromU8(files['geographic-data.geojson'])),
    receipt = JSON.parse(strFromU8(files['geographic-data.receipt.json']));
  expect(data.features[0]).toEqual({
    type: 'Feature',
    id: 'site-01',
    geometry: { type: 'Point', coordinates: [12, 34] },
    properties: { code: '001' },
  });
  expect(data.features[1].geometry).toBeNull();
  expect(data.features[2].geometry).toEqual(before.content.layers[0].features[2].geometry);
  expect(receipt.input).toEqual(before.pin);
  expect(receipt.rows[0].sourceRef.externalId).toBe('001');
  expect(receipt.sources).toEqual(before.content.sources);
  expect(receipt.output.bytesHash).toBe(
    `sha256:${createHash('sha256').update(files['geographic-data.geojson']).digest('hex')}`,
  );
  expect(receipt.input.contentHash).toBe(
    `sha256:${createHash('sha256').update(canonicalJson(before.content)).digest('hex')}`,
  );
  await expect(status(page)).toContainText('Exported data');
  expect((await page.evaluate(() => window.geoExportTest.state())).saved).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `/tmp/geo-inspector-evidence/export-${info.project.name}.png`,
    fullPage: true,
  });
  await expect.poll(() => page.evaluate(() => window.geoExportTest.state().urls)).toBe(0);
});
test('CSV export acknowledges JSON-scalar encoding, preserves null/zero/false and renders HTML as text', async ({
  page,
}) => {
  await preview(page, 'csv');
  await expect(page.getByRole('region', { name: 'Export preview', exact: true })).toContainText(
    'JSON scalars',
  );
  await acknowledge(page);
  await page.getByRole('button', { name: 'Export data and receipt' }).click();
  await expect(status(page)).toContainText('Exported data');
  const state = await page.evaluate(() => window.geoExportTest.state());
  expect(state.delivered[0].data.name).toBe('geographic-data.csv');
  expect(state.delivered[0].data.text).toContain('"0","true"');
  expect(state.delivered[0].data.text).toContain('"null","false"');
  expect(state.delivered[0].data.text).toContain('"""001"""');
  expect(await page.locator('img').count()).toBe(0);
});
test('field or format changes invalidate preview and acknowledgements; cancel never delivers', async ({
  page,
}) => {
  await preview(page);
  await acknowledge(page);
  await page.getByLabel('Include attribute code', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Export data and receipt' })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Export preview', exact: true })).toBeEmpty();
  await page.getByRole('button', { name: 'Preview data export' }).click();
  await acknowledge(page);
  await page.getByLabel('Export format', { exact: true }).selectOption('csv');
  await expect(page.getByRole('button', { name: 'Export data and receipt' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel data export' }).click();
  expect((await page.evaluate(() => window.geoExportTest.state())).delivered).toEqual([]);
});
test('export grant, missing original closure and invalid inputs refuse output; explicit retry succeeds', async ({
  page,
}) => {
  await preview(page);
  await acknowledge(page);
  for (const flag of ['grant', 'closure', 'inputs'] as const) {
    await page.evaluate((key) => window.geoExportTest[key](false), flag);
    await page.getByRole('button', { name: 'Export data and receipt' }).click();
    await expect(status(page)).toContainText('export-not-authorized');
    expect((await page.evaluate(() => window.geoExportTest.state())).delivered).toEqual([]);
    await page.evaluate((key) => window.geoExportTest[key](true), flag);
  }
  await page.getByRole('button', { name: 'Export data and receipt' }).click();
  await expect(status(page)).toContainText('Exported data');
});
test('real original-byte corruption refuses preview and recapture without native mutation', async ({
  page,
}) => {
  await load(page);
  const before = (await page.evaluate(() => window.geoExportTest.state())).saved;
  await page.evaluate(() => window.geoExportTest.corruptOriginal());
  await page.getByRole('button', { name: 'Preview data export' }).click();
  await expect(status(page)).toContainText('export-not-authorized');
  await page.getByRole('button', { name: 'Load saved geographic version' }).click();
  await expect(status(page)).toContainText('source-bytes-mismatch');
  const after = await page.evaluate(() => window.geoExportTest.state());
  expect(after.saved).toEqual(before);
  expect(after.delivered).toEqual([]);
});
test('selection change during output hashing discards late result', async ({ page }) => {
  await preview(page);
  await acknowledge(page);
  await holdDigest(page);
  await page.getByRole('button', { name: 'Export data and receipt' }).click();
  await expect.poll(() => page.evaluate(() => window.exportDigest.blocked)).toBe(true);
  await page.getByLabel('Include attribute code', { exact: true }).uncheck();
  await page.evaluate(() => window.exportDigest.release());
  await expect.poll(() => page.evaluate(() => window.exportDigest.done)).toBe(true);
  expect((await page.evaluate(() => window.geoExportTest.state())).delivered).toEqual([]);
  await expect(status(page)).toContainText('Choose attributes');
});
test('revocation during output hashing closes and discards late result', async ({ page }) => {
  await preview(page);
  await acknowledge(page);
  await holdDigest(page);
  await page.getByRole('button', { name: 'Export data and receipt' }).click();
  await expect.poll(() => page.evaluate(() => window.exportDigest.blocked)).toBe(true);
  await page.evaluate(() => {
    window.geoExportTest.revoke();
    window.exportDigest.release();
  });
  await expect.poll(() => page.evaluate(() => window.exportDigest.done)).toBe(true);
  expect((await page.evaluate(() => window.geoExportTest.state())).delivered).toEqual([]);
  await expect(status(page)).toContainText('scope closed');
  await expect(page.getByRole('button', { name: 'Export data and receipt' })).toBeDisabled();
});
test('cancelled capture cannot restore a retired version; invalid input is preserved by refusal', async ({
  page,
}) => {
  await page.evaluate(() => window.geoExportTest.holdCapture());
  await page.getByRole('button', { name: 'Load saved geographic version' }).click();
  await expect(status(page)).toContainText('Preparing saved version');
  await page.getByRole('button', { name: 'Cancel data export' }).click();
  await page.evaluate(() => window.geoExportTest.releaseCapture());
  await expect(page.getByLabel('Export layer', { exact: true })).toBeDisabled();
  await page.evaluate(() => window.geoExportTest.inputs(false));
  await page.getByRole('button', { name: 'Load saved geographic version' }).click();
  await expect(status(page)).toContainText('inputs-not-ready');
  expect((await page.evaluate(() => window.geoExportTest.state())).delivered).toEqual([]);
});
test('Host revocation inside preview authorization cannot repopulate the closed surface', async ({
  page,
}) => {
  await load(page);
  await page.evaluate(() => window.geoExportTest.revokeDuringAuthorization(1));
  await page.getByRole('button', { name: 'Preview data export' }).click();
  await expect(status(page)).toContainText('scope closed');
  await expect(page.getByRole('region', { name: 'Export preview', exact: true })).toBeEmpty();
  expect((await page.evaluate(() => window.geoExportTest.state())).delivered).toEqual([]);
});
test('Host revocation inside final delivery authorization cannot hand off files', async ({
  page,
}) => {
  await preview(page);
  await acknowledge(page);
  // Three core checks, then the workbench's final handoff check: revoke reentrantly.
  await page.evaluate(() => window.geoExportTest.revokeDuringAuthorization(4));
  await page.getByRole('button', { name: 'Export data and receipt' }).click();
  await expect(status(page)).toContainText('scope closed');
  expect((await page.evaluate(() => window.geoExportTest.state())).delivered).toEqual([]);
});
