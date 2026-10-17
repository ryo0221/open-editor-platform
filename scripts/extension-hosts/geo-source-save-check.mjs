/* global document, innerWidth, structuredClone */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]);
const original = [
  'ID,lon,lat,value',
  ...Array.from(
    { length: 200 },
    (_, i) => `${String(i + 1).padStart(3, '0')},${i > 197 ? '' : 12 + i / 1000},34,${i}`,
  ),
].join('\n');
const expectedHash = 'sha256:' + createHash('sha256').update(original).digest('hex');
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!['geo-source-save.html', 'geo-source-save.js'].includes(name)) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const width of [1280, 390]) {
      const profile = await mkdtemp('/tmp/issue76-source-browser-');
      let context;
      const errors = [];
      const launch = async () => {
        context = await chromium.launchPersistentContext(profile, {
          executablePath: '/usr/bin/chromium',
          viewport: { width, height: 900 },
        });
        const page = context.pages()[0];
        page.on('pageerror', (e) => errors.push(String(e)));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        await page.route('**/*', (r) => {
          if (new URL(r.request().url()).origin !== origin) {
            errors.push(r.request().url());
            return r.abort();
          }
          return r.continue();
        });
        await page.goto(origin + '/geo-source-save.html');
        await page.waitForFunction('globalThis.ready');
        return page;
      };
      try {
        let page = await launch();
        const state = () => page.evaluate('geoSourceHost.state()');
        const info = () => page.evaluate('geoSourceHost.retained()');
        const button = (name) => page.getByRole('button', { name, exact: true });
        await page.getByLabel('Local file', { exact: true }).setInputFiles({
          name: 'sites.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(original),
        });
        await page.getByLabel('ID column (optional)', { exact: true }).fill('ID');
        await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
        await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
        for (const [i, name, type] of [
          [1, 'ID', 'string'],
          [2, 'value', 'number'],
        ]) {
          await button('Add field').click();
          await page.getByLabel(`Input column/property ${i}`, { exact: true }).fill(name);
          await page.getByLabel(`Type ${i}`, { exact: true }).selectOption(type);
        }
        // Admission refuses unsaveable original metadata/recipe before native or retention changes.
        await page.getByLabel('Local file', { exact: true }).setInputFiles({
          name: 'x'.repeat(129),
          mimeType: 'text/csv',
          buffer: Buffer.from('ID,lon,lat,value\n001,12,34,1'),
        });
        await button('Preview import').click();
        await expect(page.getByRole('region', { name: 'Import geographic data' })).toContainText(
          'SourceManifestName',
        );
        assert.equal((await state()).revision.sequence, 0);
        const hugeColumn = 'K'.repeat(70000);
        for (const label of [
          'ID column (optional)',
          'First coordinate column',
          'Input column/property 1',
        ])
          await page.getByLabel(label, { exact: true }).fill(hugeColumn);
        await page.getByLabel('Display name 1', { exact: true }).fill('ID');
        await page.getByLabel('Display name 2', { exact: true }).fill('Value');
        await page.getByLabel('Local file', { exact: true }).setInputFiles({
          name: 'huge.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(hugeColumn + ',lat,value\n12,34,1'),
        });
        await button('Preview import').click();
        await expect(page.getByRole('region', { name: 'Import geographic data' })).toContainText(
          'Read 1; valid 1; problem 0',
        );
        await button('Import previewed data').click();
        await expect(page.getByRole('region', { name: 'Import geographic data' })).toContainText(
          'SourceRecordLimit',
        );
        assert.equal((await state()).revision.sequence, 0);
        assert.equal((await state()).originals.length, 0);
        await page.getByLabel('Local file', { exact: true }).setInputFiles({
          name: 'sites.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(original),
        });
        for (const [label, value] of [
          ['ID column (optional)', 'ID'],
          ['First coordinate column', 'lon'],
          ['Second coordinate column', 'lat'],
          ['Input column/property 1', 'ID'],
          ['Input column/property 2', 'value'],
        ])
          await page.getByLabel(label, { exact: true }).fill(value);
        await button('Preview import').click();
        await expect(page.getByRole('region', { name: 'Import geographic data' })).toContainText(
          'Read 200; valid 198; problem 2',
        );
        await page
          .getByRole('region', { name: 'Import geographic data' })
          .getByRole('checkbox')
          .check();
        await button('Import previewed data').click();
        await expect.poll(async () => (await state()).content.layers[0]?.features.length).toBe(198);
        let imported = await state();
        const originalSources = structuredClone(imported.content.sources);
        const originalRef = structuredClone(imported.content.layers[0].features[0].sourceRef);
        assert.equal(imported.revision.sequence, 1);
        assert.equal(imported.content.layers[0].features[0].values['field-1'], '001');
        assert.equal(imported.originals[0].hash, expectedHash);
        await page.getByLabel('Scalar field', { exact: true }).selectOption('field-2');
        await page.getByLabel('Longitude', { exact: true }).fill('12.5');
        await page.getByLabel('Latitude', { exact: true }).fill('34.5');
        await page.getByLabel('Scalar value', { exact: true }).fill('42');
        assert.equal((await state()).revision.sequence, 1);
        // Host Save flushes the existing aggregate input group into exactly one edit.
        await button('Save original + native').click();
        await expect.poll(async () => (await info()).versions).toBe(1);
        await expect.poll(async () => (await state()).retained).toBe(0);
        imported = await state();
        assert.equal(imported.revision.sequence, 2);
        assert.deepEqual(imported.content.sources, originalSources);
        assert.deepEqual(imported.content.layers[0].features[0].sourceRef, originalRef);
        assert.deepEqual(imported.content.layers[0].features[0].geometry.coordinates, [12.5, 34.5]);
        assert.equal(imported.content.layers[0].features[0].values['field-2'], 42);
        assert.equal(imported.content.layers[0].features[0].values['field-1'], '001');
        assert.equal(imported.originals[0].hash, expectedHash);
        const first = (await info()).head;
        const saved = JSON.parse(await page.evaluate('geoSourceHost.raw()'));
        assert.equal(Buffer.from(saved.closure[0].bytes, 'base64').toString(), original);
        assert.deepEqual(saved.closure[0].recipe.decision, {
          mode: 'partial',
          excludedRows: [199, 200],
        });
        assert.equal(saved.request.capture.contentHash, imported.hash);
        assert.equal(saved.nativeVersion.versionId, first);
        assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= 262144);
        await button('Save original + native').click();
        await expect.poll(async () => (await info()).acknowledgements).toBe(2);
        assert.equal((await info()).versions, 1);
        // Native Undo/Redo uses the existing session. Originals remain available for Redo.
        await button('Undo last change').click();
        assert.equal((await state()).revision.sequence, 3);
        assert.equal((await state()).content.layers[0].features[0].values['field-2'], 0);
        await button('Undo last change').click();
        assert.equal((await state()).content.layers.length, 0);
        await button('Save original + native').click();
        await expect.poll(async () => (await info()).versions).toBe(2);
        await button('Redo last change').click();
        await button('Redo last change').click();
        assert.equal((await state()).hash, imported.hash);
        await button('Save original + native').click();
        await expect.poll(async () => (await info()).versions).toBe(3);
        // Stop the browser process; restore IndexedDB with the same profile and origin.
        await context.close();
        page = await launch();
        assert.equal((await state()).hash, imported.hash);
        assert.equal((await state()).originals[0].hash, expectedHash);
        assert.equal((await state()).canUndo, false);
        assert.equal(
          Buffer.from(
            JSON.parse(await page.evaluate('geoSourceHost.raw()')).closure[0].bytes,
            'base64',
          ).toString(),
          original,
        );
        await page.getByLabel('Retained version', { exact: true }).selectOption(first);
        await button('Reopen selected version').click();
        await expect.poll(async () => (await state()).hash).toBe(imported.hash);
        assert.equal((await info()).versions, 3);
        // Corrupt read admission must preserve the live native and complete originals.
        const corrupt = structuredClone(saved);
        corrupt.closure[0].bytes = 'eA==';
        const rejected = await page.evaluate(async (text) => {
          try {
            await globalThis.geoSourceHost.reopenText(text);
            return false;
          } catch {
            return true;
          }
        }, JSON.stringify(corrupt));
        assert.equal(rejected, true);
        assert.equal((await state()).hash, imported.hash);
        assert.equal((await state()).originals[0].hash, expectedHash);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({ path: path.join(root, `source-save-${width}.png`) });
        assert.deepEqual(errors, []);
        console.log(
          'PASS',
          kind,
          width,
          '200→198 / dirty Point+scalar edit flushed once / exact sourceRef+excluded originals+recipe / atomic Save / no-op / UndoRedo / actual browser restart / old version / corrupt read refusal',
        );
      } finally {
        await context?.close();
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
}
