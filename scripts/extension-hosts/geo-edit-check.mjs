/* global document, window, InputEvent, CompositionEvent */
// Preparation harness: requires the reviewed editable archive and independent consumers.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]),
  reports = [],
  hashes = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const pin = JSON.parse(await readFile(path.join(root, 'editor-pin.json'))).packages[
    '@editor-platform/geo-inspector'
  ];
  hashes.push(pin);
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file =
      pathname === '/' ? 'geo-edit.html' : pathname === '/geo-edit.js' ? 'geo-edit.js' : undefined;
    if (!file) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', file)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.setDefaultTimeout(30000);
      const errors = [],
        external = [],
        origin = `http://127.0.0.1:${server.address().port}`;
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== origin) {
          external.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(origin);
      await page.waitForFunction('globalThis.ready');
      const state = () => page.evaluate('host.state()');
      const button = (name) => page.getByRole('button', { name, exact: true });
      const input = (name) => page.getByLabel(name, { exact: true });
      assert.equal(await page.locator('code').textContent(), pin);
      assert.deepEqual((await page.evaluate('host.manifest()')).permissions, [
        'artifact:read',
        'artifact:edit',
      ]);
      assert.equal((await page.evaluate('host.manifest()')).addons.save, undefined);
      const initial = await state();
      assert.deepEqual(initial.content.sources, []);
      const hostile = await page.evaluate(async () => {
        const draft = globalThis.host.draft();
        let reads = 0;
        Object.defineProperty(draft.target, 'featureId', {
          enumerable: true,
          get() {
            return ++reads === 1 ? 'point-1' : 'point-2';
          },
        });
        const result = globalThis.host.offer(draft);
        return { result, reads };
      });
      assert.equal(hostile.result.state, 'refused');
      assert.equal(hostile.reads, 0);
      assert.deepEqual((await state()).content, initial.content);
      const limits = await page.evaluate(() => {
        const draft = globalThis.host.draft();
        return [
          globalThis.host.offer({ ...draft, longitude: '0'.repeat(127) + '12' }),
          globalThis.host.offer({ ...draft, scalar: '0'.repeat(4094) + '10' }),
          globalThis.host.offer({ ...draft, scalar: '0'.repeat(4095) + '10' }),
        ];
      });
      assert.equal(limits[0].state, 'refused');
      assert.equal(limits[1].state, 'unchanged');
      assert.equal(limits[2].state, 'refused');
      assert.deepEqual((await state()).revision, initial.revision);
      await input('Longitude').fill('12.25');
      await input('Latitude').fill('34.25');
      await input('Scalar value').fill('20');
      assert.deepEqual((await state()).content, initial.content);
      assert.equal((await page.evaluate("host.nonUI('12.5', '34.5', '30')")).state, 'refused');
      await button('Apply').click();
      const applied = await state();
      assert.equal(applied.revision.sequence, 1);
      assert.deepEqual(applied.content.layers[0].features[0].geometry.coordinates, [12.25, 34.25]);
      assert.equal(applied.content.layers[0].features[0].values.metric, 20);
      assert.deepEqual(applied.content.layers[0].features[0], {
        ...initial.content.layers[0].features[0],
        geometry: { type: 'Point', coordinates: [12.25, 34.25] },
        values: { ...initial.content.layers[0].features[0].values, metric: 20 },
      });
      assert.deepEqual(
        applied.content.layers[0].features.slice(1),
        initial.content.layers[0].features.slice(1),
      );
      assert.deepEqual(applied.content.layers[0].fields, initial.content.layers[0].fields);
      assert.deepEqual(applied.content.sources, initial.content.sources);

      await page.screenshot({
        path: path.join(root, `geo-edit-applied-${width}.png`),
        fullPage: true,
      });
      await button('Undo').click();
      assert.deepEqual((await state()).content, initial.content);
      const undone = await state();
      await input('Longitude').fill('12.0');
      await button('Apply').click();
      assert.deepEqual((await state()).revision, undone.revision);
      assert.equal((await state()).canRedo, true);
      await button('Redo').click();
      assert.deepEqual((await state()).content, applied.content);
      assert.equal((await page.evaluate("host.nonUI('12.5', '34.5', '30')")).state, 'applied');
      await button('Undo').click();
      assert.deepEqual((await state()).content, applied.content);
      for (const value of ['', 'NaN', '30']) {
        await input('Longitude').fill(value);
        await button('Apply').click();
        await expect(input('Longitude')).toHaveValue(value);
        assert.deepEqual((await state()).content, applied.content);
      }
      await button('Cancel').click();
      const oldInput = await input('Longitude').elementHandle();
      await input('Longitude').dispatchEvent('compositionstart', { data: '' });
      await expect(button('Apply')).toBeDisabled();
      await expect(button('Cancel')).toBeDisabled();
      await button('Select point-2 (Point)').click();
      await expect(page.locator('.geo-point-editor')).toContainText('Target sites/point-1');
      await input('Longitude').dispatchEvent('compositionend', { data: '' });
      await button('Select point-2 (Point)').click();
      await expect(page.getByRole('status', { name: 'Geo edit status' })).toContainText(
        'GeoPendingInputs',
      );
      await button('Cancel').click();
      await button('Select point-2 (Point)').click();
      await oldInput.evaluate((element) => {
        element.value = '60';
        element.dispatchEvent(new InputEvent('input', { bubbles: true }));
        element.dispatchEvent(
          new CompositionEvent('compositionend', { data: '60', bubbles: true }),
        );
      });
      await expect(input('Longitude')).toHaveValue('13');
      await expect(button('Apply')).toBeDisabled();
      await oldInput.dispose();
      await input('Scalar value').fill('22');
      await input('Scalar field').selectOption('code');
      await expect(input('Scalar field')).toHaveValue('metric');
      await page.evaluate('host.stale()');
      const stale = await state();
      await button('Apply').click();
      await expect(page.getByRole('status', { name: 'Geo edit status' })).toContainText(
        'GeoStaleBuffer',
      );
      assert.deepEqual((await state()).content, stale.content);
      await page.evaluate('host.reopen()');
      assert.deepEqual((await state()).content, stale.content);
      assert.equal((await state()).canUndo, false);
      assert.equal((await state()).revision.sequence, 0);
      await input('Scalar value').fill('23');
      await page.evaluate('host.deleteTarget()');
      const removed = await state();
      await button('Apply').click();
      assert.deepEqual((await state()).content, removed.content);
      await button('Cancel').click();
      await expect(input('Longitude')).toHaveCount(0);
      await button('Select point-2 (Point)').click();
      await expect(input('Longitude')).toHaveValue('13');
      await input('Longitude').fill('13.25');
      assert.equal((await page.evaluate('host.revoke()')).state, 'drained');
      assert.equal(await page.locator('.geo-point-editor').count(), 0);
      const revokedNative = (await state()).content;
      await page.evaluate('host.reopen()');
      await expect(input('Longitude')).toBeDisabled();
      await expect(button('Apply')).toBeDisabled();
      const reopenedReadOnly = await state();
      assert.deepEqual(reopenedReadOnly.content, revokedNative);
      assert.equal(reopenedReadOnly.canUndo, false);
      assert.equal(reopenedReadOnly.canRedo, false);
      assert.equal(reopenedReadOnly.revision.sequence, 0);
      assert.equal(
        (await page.evaluate("host.nonUI('13.5', '35.5', '30', 'point-2')")).state,
        'refused',
      );
      const denied = await state();
      assert.deepEqual(denied.content, reopenedReadOnly.content);
      assert.deepEqual(denied.revision, reopenedReadOnly.revision);
      assert.equal(denied.canUndo, false);
      assert.equal(denied.canRedo, false);
      assert.equal(
        await page.evaluate(
          (kind) => window.sessionStorage.getItem(kind + '-geo-edit-readonly'),
          kind,
        ),
        'readonly',
      );
      for (const mode of ['readonly', 'no-inputs']) {
        await page.evaluate((mode) => globalThis.host.open(mode), mode);
        await expect(input('Longitude')).toBeDisabled();
        await expect(button('Apply')).toBeDisabled();
        const before = await state();
        assert.equal((await page.evaluate("host.nonUI('12.5', '34.5', '30')")).state, 'refused');
        assert.deepEqual((await state()).content, before.content);
      }
      await page.evaluate('host.authorizeEditable()');
      for (const name of ['Select point-4 (null)', 'Select point-5 (LineString)']) {
        await button(name).click();
        await expect(input('Longitude')).toBeDisabled();
        await expect(page.locator('.geo-point-editor')).toContainText('GeoPointOnly');
      }
      assert.equal(await button('Save').count(), 0);
      assert.deepEqual((await state()).errors, []);
      assert.ok(
        (await page.evaluate('host.retired()')).every(
          (value) => value.state === 'drained' && value.failed.length === 0,
        ),
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
      await page.screenshot({ path: path.join(root, `geo-edit-${width}.png`), fullPage: true });
      assert.equal((await page.evaluate('host.close()')).state, 'drained');
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      reports.push({ kind, width, sha256: pin, result: 'PASS' });
      console.log(
        'PASS',
        kind,
        width,
        'installed Geo editing, atomic UI/nonUI history, capability/Inputs refusal, dirty/IME/stale/revoke',
      );
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
assert.equal(hashes[0], hashes[1]);
await writeFile(path.join(directory, 'geo-edit-results.json'), JSON.stringify(reports, null, 2));
