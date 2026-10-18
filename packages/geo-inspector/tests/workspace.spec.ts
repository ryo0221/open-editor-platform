import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeck } from '@editor-platform/slide/model';
import type { GeoDocument } from '@editor-platform/geo-core';
type State = {
  content: GeoDocument;
  hash: string;
  revision: { sessionId: string; sequence: number };
  inputs: { dirty: number; composing: number };
  canUndo: boolean;
  canRedo: boolean;
  originals: { hash: string }[];
  errors: string[];
};
const state = (page: Page) => page.evaluate('geoSourceHost.state()') as Promise<State>;
const retained = (page: Page) =>
  page.evaluate('geoSourceHost.retained()') as Promise<{
    head: string;
    versionIds: string[];
    versions: number;
  }>;
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('request', (r) => {
    if (
      !/^(http:\/\/127\.0\.0\.1:4199\/|blob:http:\/\/127\.0\.0\.1:4199\/|data:image\/)/.test(
        r.url(),
      )
    )
      errors.push(r.url());
  });
  await page.goto('/workspace.html');
  await page.waitForFunction('globalThis.ready');
});
test.afterEach(async ({ page }) => {
  expect(errors).toEqual([]);
  expect((await state(page)).errors).toEqual([]);
});
test.setTimeout(120000);
async function importFile(
  page: Page,
  options: {
    text: string;
    name: string;
    format: 'csv' | 'geojson';
    fields: [string, 'string' | 'number' | 'boolean'][];
    table?: boolean;
    partial?: boolean;
    missing?: 'preserve-null';
  },
) {
  await page.getByLabel('Local file', { exact: true }).setInputFiles({
    name: options.name,
    mimeType: options.format === 'csv' ? 'text/csv' : 'application/geo+json',
    buffer: Buffer.from(options.text),
  });
  await page.getByLabel('Format', { exact: true }).selectOption(options.format);
  await page.getByLabel('Layer name', { exact: true }).fill(options.name);
  if (options.format === 'csv') {
    await page.getByLabel('ID column (optional)', { exact: true }).fill(options.fields[0][0]);
    await page
      .getByLabel('Missing coordinate policy', { exact: true })
      .selectOption(options.table ? 'attribute-table' : (options.missing ?? 'reject'));
    if (!options.table) {
      await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
      await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
    }
  }
  const count = await page.getByLabel(/^Input column\/property \d+$/).count();
  for (let i = count; i < options.fields.length; i++) await button(page, 'Add field').click();
  for (let i = 0; i < options.fields.length; i++) {
    await page
      .getByLabel(`Input column/property ${i + 1}`, { exact: true })
      .fill(options.fields[i][0]);
    await page.getByLabel(`Display name ${i + 1}`, { exact: true }).fill(options.fields[i][0]);
    await page.getByLabel(`Type ${i + 1}`, { exact: true }).selectOption(options.fields[i][1]);
  }
  await button(page, 'Preview import').click();
  if (options.partial) {
    await expect(
      page.getByRole('region', { name: 'Import geographic data', exact: true }),
    ).toContainText('Read 200; valid 198; problem 2');
    expect((await state(page)).content.layers).toHaveLength(0);
    await page
      .getByRole('region', { name: 'Import geographic data', exact: true })
      .getByRole('checkbox')
      .check();
  }
  const before = (await state(page)).content.layers.length;
  await button(page, 'Import previewed data').click();
  await expect.poll(async () => (await state(page)).content.layers.length).toBe(before + 1);
}
async function save(page: Page) {
  const before = (await retained(page)).versions;
  await button(page, 'Save original + native').click();
  await expect.poll(async () => (await retained(page)).versions).toBe(before + 1);
  await expect(button(page, 'Reopen latest')).toBeEnabled();
  return (await retained(page)).head;
}
async function download(page: Page, label: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: label, exact: true }).click();
  const file = await pending;
  expect(await file.failure()).toBeNull();
  return readFile((await file.path())!);
}
test('UC1/AC01,03,07,08,09: 200→198, private map/table, atomic edit, saved style/view, real PNG+receipt and Slide', async ({
  page,
}, info) => {
  const csv = [
    'ID,lon,lat,name,category,value',
    ...Array.from(
      { length: 200 },
      (_, i) =>
        `${String(i + 1).padStart(3, '0')},${i > 197 ? '' : 12 + i / 1000},34,Site${i},${i % 2 ? 'B' : 'A'},${i}`,
    ),
  ].join('\n');
  await importFile(page, {
    text: csv,
    name: 'Sites',
    format: 'csv',
    fields: [
      ['ID', 'string'],
      ['name', 'string'],
      ['category', 'string'],
      ['value', 'number'],
    ],
    partial: true,
  });
  const imported = await state(page);
  expect(imported.content.layers[0].features).toHaveLength(198);
  const layer = imported.content.layers[0],
    feature = layer.features[1];
  await button(page, 'Fit map').click();
  await page
    .getByRole('table', { name: 'Sites attributes', exact: true })
    .getByRole('button', { name: `${feature.id} · Point`, exact: true })
    .click();
  await expect(page.locator(`svg g[data-feature-id="${feature.id}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  for (const name of [
    'Pan east',
    'Zoom in',
    'Zoom out',
    'Map',
    'Table',
    'Inspector',
    'Show all panels',
  ])
    await button(page, name).click();
  expect((await state(page)).hash).toBe(imported.hash);
  expect((await state(page)).revision).toEqual(imported.revision);
  await page.getByLabel('Scalar field', { exact: true }).selectOption('field-4');
  await page.getByLabel('Longitude', { exact: true }).fill('12.5');
  await page.getByLabel('Latitude', { exact: true }).fill('34.5');
  await page.getByLabel('Scalar value', { exact: true }).fill('42');
  await button(page, 'Table').click();
  await button(page, 'Inspector').click();
  await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('42');
  await button(page, 'Show all panels').click();
  await save(page);
  const edited = await state(page);
  expect(edited.revision.sequence).toBe(imported.revision.sequence + 1);
  expect(edited.content.layers[0].features[1].values['field-4']).toBe(42);
  await page.getByLabel('Symbol mode', { exact: true }).selectOption('category');
  await page.getByLabel('Style field', { exact: true }).selectOption('field-3');
  await page.getByLabel('Label field', { exact: true }).selectOption('field-2');
  await page.getByLabel('Categories JSON', { exact: true }).fill(
    JSON.stringify([
      { value: 'A', color: '#0077aa' },
      { value: 'B', color: '#ee7700' },
    ]),
  );
  await button(page, 'Apply').click();
  await page.getByLabel('Annotation text', { exact: true }).fill('Synthetic sites');
  await page.getByLabel('Annotation longitude', { exact: true }).fill('12');
  await page.getByLabel('Annotation latitude', { exact: true }).fill('34');
  await button(page, 'Add annotation').click();
  await button(page, 'Save named view').click();
  const head = await save(page);
  await page.getByLabel('Retained version', { exact: true }).selectOption(head);
  const view = (await state(page)).content.workspace!.views[0];
  await page.getByLabel('PNG saved view', { exact: true }).selectOption(view.id);
  await button(page, 'Generate fixed PNG').click();
  await expect(page.getByRole('link', { name: 'Download fixed PNG', exact: true })).toBeVisible();
  const bytes = await download(page, 'Download fixed PNG'),
    receipt = JSON.parse((await download(page, 'Download PNG receipt')).toString());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.readUInt32BE(16)).toBe(960);
  expect(bytes.readUInt32BE(20)).toBe(600);
  expect(receipt.input.versionId).toBe(head);
  expect(receipt.namedViewId).toBe(view.id);
  expect(receipt.outputBytesHash).toBe(
    'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  );
  expect(receipt.attribution).not.toHaveLength(0);
  await button(page, 'Place PNG on Slide').click();
  const native = await download(page, 'Download Slide with fixed map image'),
    artifact = JSON.parse(native.toString());
  expect(isDeck(artifact.draft.content)).toBe(true);
  expect(artifact.kind).toBe('slide');
  expect(artifact.draft.content.slides[0].notes).toContain(receipt.input.versionId);
  const pngInSlide = Buffer.from(
    artifact.draft.content.slides[0].objects[0].src.split(',')[1],
    'base64',
  );
  expect(pngInSlide).toEqual(bytes);
  const directory = `/tmp/issue97-complete-evidence/${info.project.name}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/geographic-map.slide.json`, native);
  await writeFile(`${directory}/map.png`, bytes);
  await writeFile(`${directory}/map.receipt.json`, JSON.stringify(receipt, null, 2));
  const fixed = Buffer.from(bytes);
  await page.getByLabel('Scalar value', { exact: true }).fill('43');
  await button(page, 'Apply').click();
  expect(bytes).toEqual(fixed);
  await expect(page.getByRole('link', { name: 'Download fixed PNG', exact: true })).toHaveCount(0);
  await page.getByLabel('Retained version', { exact: true }).selectOption(head);
  await button(page, 'Reopen selected version').click();
  expect((await state(page)).content.workspace!.views[0]).toEqual(view);
  await page.reload();
  await page.waitForFunction('globalThis.ready');
  expect((await state(page)).content.workspace!.views[0]).toEqual(view);
  await page
    .getByRole('region', { name: 'Geographic editor', exact: true })
    .screenshot({ path: `${directory}/workspace.png` });
});
test('UC2 AC05/06:47-region table join, zero/missing/denominator diagnostics, fixed classes and view', async ({
  page,
}) => {
  const geo = {
    type: 'FeatureCollection',
    features: Array.from({ length: 47 }, (_, i) => ({
      type: 'Feature',
      id: String(i + 1).padStart(2, '0'),
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [i, 0],
            [i + 0.5, 0],
            [i + 0.5, 0.5],
            [i, 0.5],
            [i, 0],
          ],
        ],
      },
      properties: { code: String(i + 1).padStart(2, '0') },
    })),
  };
  await importFile(page, {
    text: JSON.stringify(geo),
    name: 'Regions',
    format: 'geojson',
    fields: [['code', 'string']],
  });
  await importFile(page, {
    text: [
      'code,count,population',
      ...Array.from(
        { length: 47 },
        (_, i) =>
          `${i === 46 ? 'unmatched' : String(i + 1).padStart(2, '0')},${i === 2 ? '' : i},${i === 3 ? 0 : 100}`,
      ),
    ].join('\n'),
    name: 'Regional metrics',
    format: 'csv',
    fields: [
      ['code', 'string'],
      ['count', 'number'],
      ['population', 'number'],
    ],
    table: true,
  });
  await save(page);
  const saved = await state(page),
    left = saved.content.layers[0],
    right = saved.content.layers[1];
  await page.getByLabel('Boundary layer', { exact: true }).selectOption(left.id);
  await page.getByLabel('Table layer', { exact: true }).selectOption(right.id);
  await page.getByLabel('Boundary key field ID', { exact: true }).fill('field-1');
  await page.getByLabel('Table key field ID', { exact: true }).fill('field-1');
  await button(page, 'Create pinned join').click();
  await expect.poll(async () => (await state(page)).content.workspace?.joins.length).toBe(1);
  const join = (await state(page)).content.workspace!.joins[0];
  expect(join.rows.filter((r) => r.status === 'matched')).toHaveLength(46);
  expect(join.rows[0].values['field-1']).toBe('01');
  expect(join.rows[46].status).toBe('unmatched');
  await page.getByLabel('Style layer', { exact: true }).selectOption(left.id);
  await page.getByLabel('Symbol mode', { exact: true }).selectOption('classes');
  await page.getByLabel('Metric kind', { exact: true }).selectOption('rate');
  await page.getByLabel('Numerator field', { exact: true }).selectOption(`join:${join.id}:field-2`);
  await page
    .getByLabel('Denominator field', { exact: true })
    .selectOption(`join:${join.id}:field-3`);
  await page.getByLabel('Rate multiplier', { exact: true }).fill('100');
  for (const [label, value] of [
    ['Indicator', 'Inspection rate'],
    ['Unit', '%'],
    ['Period', '2026'],
    ['Class boundaries', '10,30'],
  ] as const)
    await page.getByLabel(label, { exact: true }).fill(value);
  await button(page, 'Apply').click();
  const grid = page.getByRole('table', { name: 'Regions attributes', exact: true });
  await expect(grid).toContainText('zero-denominator');
  await expect(grid).toContainText('missing');
  await expect(grid).toContainText('unmatched');
  await expect(grid).toContainText('value: 0');
  await expect(page.getByRole('region', { name: 'Map', exact: true })).toContainText(
    'Inspection rate · % · 2026',
  );
  await button(page, 'Fit map').click();
  await button(page, 'Save named view').click();
  const before = (await state(page)).content.workspace!.views[0];
  await save(page);
  await button(page, 'Pan east').click();
  await button(page, 'Use saved view').click();
  expect((await state(page)).content.workspace!.views[0]).toEqual(before);
  await button(page, 'Reopen latest').click();
  expect((await state(page)).content.workspace!.joins[0]).toEqual(join);
});
test('UC3/5 AC03/04/07: create line/polygon, reject self-intersection, Undo/Redo and preserve invalid/IME', async ({
  page,
}) => {
  await page.getByLabel('Geometry type', { exact: true }).selectOption('LineString');
  await page.getByLabel('New coordinates JSON', { exact: true }).fill('[[179,0],[-179,0]]');
  await button(page, 'Create feature').click();
  await expect.poll(async () => (await state(page)).content.layers.length).toBe(1);
  await page.getByLabel('Geometry type', { exact: true }).selectOption('Polygon');
  await page
    .getByLabel('New coordinates JSON', { exact: true })
    .fill('[[[0,0],[2,0],[2,2],[0,0]]]');
  await button(page, 'Create feature').click();
  await expect.poll(async () => (await state(page)).content.layers[0].features.length).toBe(2);
  const polygon = (await state(page)).content.layers[0].features[1];
  await page
    .getByRole('table')
    .getByRole('button', { name: `${polygon.id} · Polygon`, exact: true })
    .click();
  const before = await state(page);
  await page.getByLabel('Geometry JSON', { exact: true }).fill('not json');
  await button(page, 'Save original + native').click();
  await expect(page.getByLabel('Geometry JSON', { exact: true })).toHaveValue('not json');
  expect((await state(page)).hash).toBe(before.hash);
  await page.getByLabel('Geometry JSON', { exact: true }).dispatchEvent('compositionstart');
  await button(page, 'Reopen latest').click();
  expect((await state(page)).inputs.composing).toBe(1);
  await page.getByLabel('Geometry JSON', { exact: true }).dispatchEvent('compositionend');
  await button(page, 'Cancel').click();
  await page
    .getByLabel('Geometry JSON', { exact: true })
    .fill('{"type":"Polygon","coordinates":[[[0,0],[2,2],[0,2],[2,0],[0,0]]]}');
  await button(page, 'Apply').click();
  expect((await state(page)).hash).toBe(before.hash);
  await expect(page.getByRole('status', { name: 'Geo edit status', exact: true })).toContainText(
    'self-intersection',
  );
  await button(page, 'Cancel').click();
  await page
    .getByLabel('Geometry JSON', { exact: true })
    .fill('{"type":"Polygon","coordinates":[[[0,0],[3,0],[3,3],[0,0]]]}');
  await page.getByLabel('Scalar value', { exact: true }).fill('Proposed area');
  await page.getByLabel('Scalar is null', { exact: true }).uncheck();
  await button(page, 'Apply').click();
  const changed = await state(page);
  expect(changed.hash).not.toBe(before.hash);
  await button(page, 'Undo last change').click();
  expect((await state(page)).hash).toBe(before.hash);
  await button(page, 'Redo last change').click();
  expect((await state(page)).hash).toBe(changed.hash);
});

test('M2 reimport: full198 replacement stays staged until explicit adoption, stable IDs and old versions survive', async ({
  page,
}) => {
  const data = (updated: boolean) =>
    [
      'ID,lon,lat,name,category,value',
      ...Array.from(
        { length: 200 },
        (_, i) =>
          `${String(i + 1).padStart(3, '0')},${i > 197 ? '' : 12 + i / 1000},34,Site${i},A,${updated && i === 0 ? 99 : i}`,
      ),
    ].join('\n');
  await importFile(page, {
    text: data(false),
    name: 'Sites',
    format: 'csv',
    fields: [
      ['ID', 'string'],
      ['name', 'string'],
      ['category', 'string'],
      ['value', 'number'],
    ],
    partial: true,
  });
  const oldVersion = await save(page),
    before = await state(page),
    layer = before.content.layers[0];
  await page.getByLabel('Refresh original layer', { exact: true }).selectOption(layer.id);
  await page
    .getByLabel('Replacement source file', { exact: true })
    .setInputFiles({ name: 'updated.csv', mimeType: 'text/csv', buffer: Buffer.from(data(true)) });
  await button(page, 'Preview replacement file').click();
  await expect(page.getByRole('region', { name: 'Geographic editor', exact: true })).toContainText(
    '"problem": 2',
  );
  expect((await state(page)).hash).toBe(before.hash);
  await button(page, 'Apply previewed replacement').click();
  await expect(page.getByRole('status', { name: 'Geo edit status', exact: true })).toContainText(
    'import-blocked',
  );
  expect((await state(page)).hash).toBe(before.hash);
  await page
    .getByLabel('Explicitly exclude the listed invalid replacement rows', { exact: true })
    .check();
  await button(page, 'Apply previewed replacement').click();
  await expect
    .poll(async () => (await state(page)).content.layers[0].features[0].values['field-4'])
    .toBe(99);
  const after = await state(page);
  expect(after.content.layers).toHaveLength(1);
  expect(after.content.layers[0].features.map((f) => [f.id, f.rowId])).toEqual(
    layer.features.map((f) => [f.id, f.rowId]),
  );
  expect(after.content.sources).toHaveLength(2);
  await button(page, 'Undo last change').click();
  expect((await state(page)).hash).toBe(before.hash);
  await button(page, 'Redo last change').click();
  expect((await state(page)).hash).toBe(after.hash);
  await save(page);
  await page.getByLabel('Retained version', { exact: true }).selectOption(oldVersion);
  await button(page, 'Reopen selected version').click();
  await expect.poll(async () => (await state(page)).hash).toBe(before.hash);
});

test('M2 assets: unknown location preserved, local photo retained/reloaded, missing original refuses Save without losing features', async ({
  page,
}) => {
  await importFile(page, {
    text: 'ID,lon,lat,value\n001,12,34,1\n002,,,0',
    name: 'Assets',
    format: 'csv',
    fields: [
      ['ID', 'string'],
      ['value', 'number'],
    ],
    missing: 'preserve-null',
  });
  expect((await state(page)).content.layers[0].features[1].geometry).toBeNull();
  for (const [label, value] of [
    ['Asset ID', 'asset-001'],
    ['Inspection date', '2026-10-18'],
    ['Location accuracy (meters)', '3.5'],
    ['Asset notes', '<img src="https://invalid.test/x" onerror="alert(1)">'],
  ] as const)
    await page.getByLabel(label, { exact: true }).fill(value);
  await button(page, 'Save asset inspection').click();
  const base64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    c.getContext('2d')!.fillRect(0, 0, 2, 2);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page
    .getByLabel('Local inspection photo', { exact: true })
    .setInputFiles({
      name: 'inspection.png',
      mimeType: 'image/png',
      buffer: Buffer.from(base64, 'base64'),
    });
  await button(page, 'Attach selected local photo').click();
  await expect
    .poll(async () => (await state(page)).content.workspace!.assets[0].photos.length)
    .toBe(1);
  const withPhoto = await state(page),
    source = withPhoto.content.sources.find((s) => s.format === 'png')!;
  expect(source.bytesHash).toBe(
    'sha256:' + createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'),
  );
  await save(page);
  await page.reload();
  await page.waitForFunction('globalThis.ready');
  await button(page, 'Inspect retained photos').click();
  await expect(page.getByRole('img', { name: 'inspection.png', exact: true })).toBeVisible();
  expect((await state(page)).content.workspace!.assets[0].notes).toContain('<img');
  const before = await state(page);
  await page.evaluate(
    (id) =>
      (
        globalThis as unknown as { geoSourceHost: { loseOriginal(id: string): void } }
      ).geoSourceHost.loseOriginal(id),
    source.resourceId,
  );
  await page.getByLabel('Scalar value', { exact: true }).fill('changed');
  await button(page, 'Save original + native').click();
  expect((await state(page)).hash).toBe(before.hash);
  expect((await state(page)).content.layers[0].features).toHaveLength(2);
  await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('changed');
});

test('M2 two-version comparison records typed changes, pins, explicit tolerance and uncertain missing records', async ({
  page,
}) => {
  await importFile(page, {
    text: 'ID,lon,lat,value\n001,12,34,1\n002,13,35,2',
    name: 'Versions',
    format: 'csv',
    fields: [
      ['ID', 'string'],
      ['value', 'number'],
    ],
  });
  const first = await save(page);
  await page.getByLabel('Scalar field', { exact: true }).selectOption('field-2');
  await page.getByLabel('Scalar value', { exact: true }).fill('10');
  await page.getByLabel('Longitude', { exact: true }).fill('12.0001');
  await button(page, 'Apply').click();
  const layer = (await state(page)).content.layers[0],
    remove = layer.features[1];
  await page
    .getByRole('table')
    .getByRole('button', { name: `${remove.id} · Point`, exact: true })
    .click();
  await button(page, 'Delete selected feature').click();
  const second = await save(page);
  await page.getByLabel('Before version', { exact: true }).selectOption(first);
  await page.getByLabel('After version', { exact: true }).selectOption(second);
  await page.getByLabel('Comparison field IDs (comma separated)', { exact: true }).fill('field-2');
  await page.getByLabel('Coordinate tolerance (degrees)', { exact: true }).fill('0.001');
  await button(page, 'Compare retained versions').click();
  await expect.poll(async () => (await state(page)).content.workspace?.comparisons.length).toBe(1);
  const result = (await state(page)).content.workspace!.comparisons[0];
  expect(result.before.versionId).toBe(first);
  expect(result.after.versionId).toBe(second);
  expect(result.changes.map((c) => c.kind)).toEqual(['changed', 'no-counterpart']);
  expect(result.changes[0].geometryChanged).toBe(false);
});

test('AC12 PNG digest cannot revive output after dirty input is cancelled', async ({ page }) => {
  await page.getByLabel('New coordinates JSON', { exact: true }).fill('[12,34]');
  await button(page, 'Create feature').click();
  await button(page, 'Save named view').click();
  const head = await save(page);
  await page.getByLabel('Retained version', { exact: true }).selectOption(head);
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    Object.assign(globalThis, { pngDigestEntered: false });
    crypto.subtle.digest = async (...args) => {
      crypto.subtle.digest = digest;
      Object.assign(globalThis, { pngDigestEntered: true });
      await new Promise<void>((resolve) =>
        Object.assign(globalThis, { releasePngDigest: resolve }),
      );
      return digest(...args);
    };
  });
  await button(page, 'Generate fixed PNG').click();
  await page.waitForFunction('globalThis.pngDigestEntered');
  await page.getByLabel('Scalar value', { exact: true }).fill('pending');
  await button(page, 'Cancel').click();
  await page.evaluate('releasePngDigest()');
  await expect(page.getByRole('status', { name: 'Geo edit status', exact: true })).toContainText(
    'Changed',
  );
  await expect(page.getByRole('link', { name: 'Download fixed PNG', exact: true })).toHaveCount(0);
});
