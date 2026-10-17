/* global document, innerWidth, structuredClone, CompositionEvent */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]);
const csv = 'code,lon,lat,value\nCSV-001,12,34,7';
const geojson = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'gj-point',
      properties: { code: 'GJ-001', value: 11 },
      geometry: { type: 'Point', coordinates: [13, 35] },
    },
    {
      type: 'Feature',
      id: 'gj-line',
      properties: { code: 'LINE-001', value: 22 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [13, 35],
          [13.1, 35.1],
        ],
      },
    },
    { type: 'Feature', id: 'gj-null', properties: { code: 'NULL-001', value: 33 }, geometry: null },
  ],
});
const state = (page) => page.evaluate('geoSourceHost.state()');
const info = (page) => page.evaluate('geoSourceHost.retained()');
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function importFile(page, format, addFields = false) {
  const region = page.getByRole('region', { name: 'Import geographic data', exact: true });
  await region.getByLabel('Format', { exact: true }).selectOption(format);
  await region
    .getByLabel('Layer name', { exact: true })
    .fill(format === 'csv' ? 'CSV sites' : 'GeoJSON mixed geometry');
  await region.getByLabel('Local file', { exact: true }).setInputFiles({
    name: format === 'csv' ? 'sites.csv' : 'mixed.geojson',
    mimeType: format === 'csv' ? 'text/csv' : 'application/geo+json',
    buffer: Buffer.from(format === 'csv' ? csv : geojson),
  });
  if (format === 'csv') {
    for (const [label, value] of [
      ['ID column (optional)', 'code'],
      ['First coordinate column', 'lon'],
      ['Second coordinate column', 'lat'],
    ])
      await region.getByLabel(label, { exact: true }).fill(value);
  }
  if (addFields)
    for (const [i, name, type] of [
      [1, 'code', 'string'],
      [2, 'value', 'number'],
    ]) {
      await region.getByRole('button', { name: 'Add field', exact: true }).click();
      await region.getByLabel(`Input column/property ${i}`, { exact: true }).fill(name);
      await region.getByLabel(`Type ${i}`, { exact: true }).selectOption(type);
    }
  const before = await state(page);
  await region.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(region).toContainText(
    format === 'csv' ? 'Read 1; valid 1; problem 0' : 'Read 3; valid 3; problem 0',
  );
  await region.getByRole('button', { name: 'Import previewed data', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).revision.sequence)
    .toBe(before.revision.sequence + 1);
  const imported = await state(page);
  assert.equal(imported.content.layers.length, before.content.layers.length + 1);
  return imported.content.layers.at(-1);
}
async function visibleLayer(page, layer) {
  await expect(
    page.getByRole('region', { name: `Local point map ${layer.id}`, exact: true }),
  ).toBeVisible();
  const region = page.getByRole('region', { name: `Attributes ${layer.id}`, exact: true });
  await expect(region).toBeVisible();
  for (const feature of layer.features)
    await expect(
      region.getByRole('button', {
        name: `Select ${feature.id} (${feature.geometry?.type ?? 'null'})`,
        exact: true,
      }),
    ).toBeVisible();
}
async function selectPoint(page, layer) {
  const point = layer.features.find((feature) => feature.geometry?.type === 'Point');
  await page
    .getByRole('region', { name: `Attributes ${layer.id}`, exact: true })
    .getByRole('button', { name: `Select ${point.id} (Point)`, exact: true })
    .click();
  await expect(page.getByLabel('Longitude', { exact: true })).toBeEnabled();
  return point;
}
async function save(page, versions) {
  await button(page, 'Save original + native').click();
  await expect.poll(async () => (await info(page)).versions).toBe(versions);
  await expect.poll(async () => (await state(page)).retained).toBe(0);
  await expect(page.getByRole('status', { name: 'Source save status', exact: true })).toContainText(
    'Saved current capture',
  );
}
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const pin = JSON.parse(await readFile(path.join(root, 'editor-pin.json'), 'utf8'));
  const server = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (!['geo-source-save.html', 'geo-source-save.js'].includes(name)) {
      response.writeHead(204).end();
      return;
    }
    response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const width of [1280, 390]) {
      const profile = await mkdtemp('/tmp/issue76-geo-production-');
      let context, page;
      const errors = [];
      const launch = async () => {
        context = await chromium.launchPersistentContext(profile, {
          executablePath: '/usr/bin/chromium',
          viewport: { width, height: 900 },
        });
        page = context.pages()[0];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await context.route('**/*', (route) => {
          if (new URL(route.request().url()).origin !== origin) {
            errors.push(route.request().url());
            return route.abort();
          }
          return route.continue();
        });
        await page.goto(origin + '/geo-source-save.html');
        await page.waitForFunction('globalThis.ready');
      };
      try {
        await launch();
        const firstLayer = await importFile(page, 'csv', true);
        await visibleLayer(page, firstLayer);
        await save(page, 1);
        const firstVersion = (await info(page)).head;
        // Branch creation after Undo must abandon only the now-missing clean target.
        await button(page, 'Undo last change').click();
        assert.equal((await state(page)).content.layers.length, 0);
        const branchLayer = await importFile(page, 'geojson');
        await visibleLayer(page, branchLayer);
        await expect(page.getByLabel('Longitude', { exact: true })).toBeEnabled();
        await expect(
          page.getByRole('status', { name: 'Geo edit status', exact: true }),
        ).not.toContainText('GeoTargetMissing');
        await button(page, 'Undo last change').click();
        assert.equal((await state(page)).content.layers.length, 0);
        await button(page, 'Redo last change').click();
        await visibleLayer(page, branchLayer);
        await page.getByLabel('Retained version', { exact: true }).selectOption(firstVersion);
        await button(page, 'Reopen selected version').click();
        await expect
          .poll(async () => (await state(page)).content.layers[0]?.id)
          .toBe(firstLayer.id);
        // Explicit reopen resets the import form; combine original CSV with a distinct GeoJSON source.
        const secondLayer = await importFile(page, 'geojson', true);
        await visibleLayer(page, firstLayer);
        await visibleLayer(page, secondLayer);
        const secondPoint = await selectPoint(page, secondLayer);
        await button(page, 'Undo last change').click();
        assert.equal((await state(page)).content.layers.length, 1);
        await visibleLayer(page, firstLayer);
        await expect(page.getByLabel('Longitude', { exact: true })).toBeEnabled();
        await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('12');
        await button(page, 'Redo last change').click();
        await visibleLayer(page, secondLayer);
        const before = await state(page);
        const nativeIdentity = (content) => ({
          sources: content.sources,
          layers: content.layers.map((layer) => ({
            id: layer.id,
            refs: layer.features.map((feature) => ({
              id: feature.id,
              rowId: feature.rowId,
              sourceRef: feature.sourceRef,
            })),
          })),
        });
        const identity = structuredClone(nativeIdentity(before.content));
        const untouched = structuredClone(
          secondLayer.features.filter((feature) => feature.geometry?.type !== 'Point'),
        );
        assert.equal(before.content.sources.length, 2);
        assert.equal(before.originals.length, 2);
        await save(page, 2);
        for (const [layer, lon, lat, value] of [
          [firstLayer, '12.25', '34.25', '8'],
          [secondLayer, '13.5', '35.5', '42'],
        ]) {
          await selectPoint(page, layer);
          await page.getByLabel('Scalar field', { exact: true }).selectOption('field-2');
          await page.getByLabel('Longitude', { exact: true }).fill(lon);
          await page.getByLabel('Latitude', { exact: true }).fill(lat);
          await page.getByLabel('Scalar value', { exact: true }).fill(value);
          const sequence = (await state(page)).revision.sequence;
          if (layer.id === secondLayer.id) {
            const otherPoint = firstLayer.features[0];
            const other = page
              .getByRole('region', { name: `Attributes ${firstLayer.id}`, exact: true })
              .getByRole('button', { name: `Select ${otherPoint.id} (Point)`, exact: true });
            // A dirty target remains pinned when another layer is selected.
            await other.click();
            await expect(
              page.getByRole('status', { name: 'Geo edit status', exact: true }),
            ).toContainText('GeoPendingInputs');
            await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue(lon);
            await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue(value);
            assert.equal((await state(page)).revision.sequence, sequence);
            await page
              .getByLabel('Longitude', { exact: true })
              .evaluate((input) =>
                input.dispatchEvent(
                  new CompositionEvent('compositionstart', { bubbles: true, data: '5' }),
                ),
              );
            assert.equal((await state(page)).inputs.composing, 1);
            await other.click();
            assert.equal((await state(page)).inputs.composing, 1);
            assert.equal((await state(page)).revision.sequence, sequence);
            await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue(lon);
            await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue(value);
            await page
              .getByLabel('Longitude', { exact: true })
              .evaluate((input) =>
                input.dispatchEvent(
                  new CompositionEvent('compositionend', { bubbles: true, data: '5' }),
                ),
              );
          }
          await button(page, 'Apply').click();
          assert.equal((await state(page)).revision.sequence, sequence + 1);
        }
        const edited = await state(page);
        assert.deepEqual(nativeIdentity(edited.content), identity);
        assert.deepEqual(
          edited.content.layers[1].features.filter((feature) => feature.geometry?.type !== 'Point'),
          untouched,
        );
        assert.equal(edited.content.layers[0].features[0].values['field-2'], 8);
        assert.equal(
          edited.content.layers[1].features.find((feature) => feature.id === secondPoint.id).values[
            'field-2'
          ],
          42,
        );
        for (const feature of untouched) {
          await page
            .getByRole('region', { name: `Attributes ${secondLayer.id}`, exact: true })
            .getByRole('button', {
              name: `Select ${feature.id} (${feature.geometry?.type ?? 'null'})`,
              exact: true,
            })
            .click();
          await expect(page.getByLabel('Longitude', { exact: true })).toBeDisabled();
          await expect(
            page.getByRole('region', { name: 'Geo Point editor', exact: true }),
          ).toContainText('GeoPointOnly');
          assert.equal((await state(page)).hash, edited.hash);
        }
        await selectPoint(page, secondLayer);
        // These Host buttons undo Point edits as well as import commands.
        await button(page, 'Undo last change').click();
        assert.equal(
          (await state(page)).content.layers[1].features.find(
            (feature) => feature.id === secondPoint.id,
          ).values['field-2'],
          11,
        );
        await button(page, 'Undo last change').click();
        assert.equal((await state(page)).hash, before.hash);
        await button(page, 'Redo last change').click();
        await button(page, 'Redo last change').click();
        assert.equal((await state(page)).hash, edited.hash);
        await save(page, 3);
        const latest = (await info(page)).head;
        const saved = JSON.parse(await page.evaluate('geoSourceHost.raw()'));
        assert.equal(saved.closure.length, 2);
        for (const [format, bytes] of [
          ['csv', csv],
          ['geojson', geojson],
        ]) {
          const entry = saved.closure.find((item) => item.sourceVersion.content.format === format);
          assert.equal(Buffer.from(entry.bytes, 'base64').toString(), bytes);
          assert.equal(entry.recipe.format, format);
          assert.deepEqual(entry.recipe.decision, { mode: 'all' });
        }
        await context.close();
        await launch();
        const restarted = await state(page);
        assert.equal(restarted.hash, edited.hash);
        assert.equal(restarted.canUndo, false);
        assert.equal(restarted.canRedo, false);
        assert.deepEqual(nativeIdentity(restarted.content), identity);
        assert.deepEqual(
          restarted.content.layers[1].features.filter(
            (feature) => feature.geometry?.type !== 'Point',
          ),
          untouched,
        );
        assert.deepEqual(JSON.parse(await page.evaluate('geoSourceHost.raw()')), saved);
        await visibleLayer(page, firstLayer);
        await visibleLayer(page, secondLayer);
        await page.getByLabel('Retained version', { exact: true }).selectOption(firstVersion);
        await button(page, 'Reopen selected version').click();
        await expect.poll(async () => (await state(page)).originals.length).toBe(1);
        assert.equal((await state(page)).content.layers.length, 1);
        await button(page, 'Reopen latest').click();
        await expect.poll(async () => (await state(page)).hash).toBe(edited.hash);
        assert.equal((await state(page)).head, latest);
        assert.equal((await state(page)).originals.length, 2);
        assert.equal((await info(page)).versions, 3);
        assert.deepEqual((await state(page)).errors, []);
        assert.deepEqual(errors, []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({ path: path.join(root, `geo-production-${width}.png`) });
        console.log(
          'PASS',
          kind,
          width,
          pin.sourceCommit,
          'CSV + mixed GeoJSON / clean deleted-target fallback / dirty+IME target retained / Point+scalar edits / nonPoint+null preserved / UndoRedo / exact originals+refs / atomic Save / real Chromium restart / old+latest reopen',
        );
      } catch (error) {
        if (page) {
          console.error(
            'FAIL',
            kind,
            width,
            pin.sourceCommit,
            JSON.stringify(await state(page).catch(() => null)),
          );
          await page
            .screenshot({ path: path.join(root, `geo-production-failure-${width}.png`) })
            .catch(() => {});
        }
        throw error;
      } finally {
        await context?.close();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
