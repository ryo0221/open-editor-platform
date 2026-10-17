/* global document, innerWidth */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]),
  reports = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind),
    pins = JSON.parse(await readFile(path.join(root, 'editor-pin.json')));
  const server = createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (!['/', '/geo-save.html', '/geo-save.js'].includes(route)) {
      res.writeHead(204).end();
      return;
    }
    const file = route === '/geo-save.js' ? 'geo-save.js' : 'geo-save.html';
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', file)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } }),
        errors = [],
        external = [];
      const origin = `http://127.0.0.1:${server.address().port}`;
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== origin) {
          external.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      try {
        await page.goto(origin);
        await page.waitForFunction('globalThis.ready');
        const state = () => page.evaluate('host.state()');
        const button = (name) => page.getByRole('button', { name, exact: true });
        const input = (name) => page.getByLabel(name, { exact: true });
        // Existing Host admission accepts this source-free native fixture. No source refs are removed.
        await page.evaluate(async () => {
          const content = (await globalThis.host.state()).content;
          content.layers[0].features[1].values = {
            metric: null,
            code: '<img src="https://invalid.example/x" onerror="alert(1)">',
            active: false,
          };
          content.layers[0].features[2].values = { metric: 0, code: '', active: false };
          content.layers[0].features[3].values = { metric: null, code: 'null', active: false };
          await globalThis.host.open('editable', content);
        });
        assert.equal(
          await page.locator('code').textContent(),
          pins.packages['@editor-platform/geo-inspector'],
        );
        const table = page.getByRole('region', { name: 'Attributes sites', exact: true });
        const editStatus = page.getByRole('status', { name: 'Geo edit status' });
        const saveStatus = page.getByRole('status', { name: 'Native save status' });
        const nativeRows = async (content) => {
          const layer = content.layers[0];
          await expect(table.getByRole('row')).toHaveCount(layer.features.length + 1);
          for (const field of layer.fields)
            await expect(
              table.getByRole('columnheader', {
                name: `${field.name} (${field.type})`,
                exact: true,
              }),
            ).toBeAttached();
          for (const f of layer.features) {
            const row = table.locator(`[data-feature-id="${f.id}"]`);
            await expect(row).toContainText(`Row ${f.rowId}`);
            const point = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
            assert.deepEqual(await row.locator('td').allTextContents(), [
              f.geometry?.type ?? 'null — location unknown',
              point ? String(point[0]) : '—',
              point ? String(point[1]) : '—',
              ...layer.fields.map((field) => {
                const v = f.values[field.id];
                return v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(v);
              }),
            ]);
          }
          await expect(table.locator('img,script')).toHaveCount(0);
        };
        const initial = await state();
        assert.equal(initial.view.canSave, true);
        await expect(editStatus).not.toContainText('No Save capability');
        await nativeRows(initial.content);
        const mapPoint = (id) =>
          page.getByRole('button', { name: `Select point ${id};`, exact: false });
        const rowButton = (id) =>
          table.getByRole('button', { name: `Select ${id} (Point)`, exact: true });
        await mapPoint('point-2').click();
        await expect(rowButton('point-2')).toHaveAttribute('aria-pressed', 'true');
        await rowButton('point-3').click();
        await expect(mapPoint('point-3')).toHaveAttribute('aria-pressed', 'true');
        assert.equal((await state()).hash, initial.hash);
        assert.deepEqual((await state()).revision, initial.revision);
        await input('Longitude').fill('bad');
        await input('Scalar value').fill('27');
        for (const target of [rowButton('point-1'), mapPoint('point-2')]) {
          await target.click();
          await expect(editStatus).toContainText('GeoPendingInputs');
          await expect(rowButton('point-3')).toHaveAttribute('aria-pressed', 'true');
          await expect(input('Longitude')).toHaveValue('bad');
          await expect(input('Scalar value')).toHaveValue('27');
        }
        await button('Apply').click();
        assert.deepEqual((await state()).content, initial.content);
        await expect(input('Longitude')).toHaveValue('bad');
        await input('Longitude').fill('12.5');
        await button('Apply').click();
        const edited = await state();
        assert.equal(edited.revision.sequence, initial.revision.sequence + 1);
        assert.deepEqual(edited.content.layers[0].features[2].geometry.coordinates, [12.5, 34]);
        assert.deepEqual(edited.content.layers[0].features[2].values, {
          metric: 27,
          code: '',
          active: false,
        });
        assert.deepEqual(
          edited.content.layers[0].features.filter((f) => f.id !== 'point-3'),
          initial.content.layers[0].features.filter((f) => f.id !== 'point-3'),
        );
        await nativeRows(edited.content);
        await button('Undo').click();
        assert.deepEqual((await state()).content, initial.content);
        await nativeRows(initial.content);
        await button('Redo').click();
        assert.deepEqual((await state()).content, edited.content);
        await nativeRows(edited.content);
        // Synthetic composition events exercise the actual input boundary, not native IME certification.
        await input('Longitude').dispatchEvent('compositionstart', { data: '' });
        await input('Longitude').fill('12.75');
        await rowButton('point-1').click();
        await mapPoint('point-2').click();
        await expect(rowButton('point-3')).toHaveAttribute('aria-pressed', 'true');
        await expect(button('Apply')).toBeDisabled();
        assert.equal((await page.evaluate('host.save()')).state, 'refused');
        assert.deepEqual((await state()).content, edited.content);
        await expect(input('Longitude')).toHaveValue('12.75');
        await input('Longitude').dispatchEvent('compositionend', { data: '12.75' });
        await button('Cancel').click();
        await button('Save native').click();
        await expect(saveStatus).toHaveText('Saved current capture');
        const saved = await state(),
          record = JSON.parse(await page.evaluate('host.raw()'));
        assert.deepEqual(record.request.content, edited.content);
        assert.equal(record.request.capture.contentHash, saved.hash);
        assert.deepEqual(record.request.capture, saved.view.lastSave.capture);
        assert.equal(record.receiptId, saved.view.lastSave.receipt.adapterReceiptId);
        await page.reload();
        await page.waitForFunction('globalThis.ready');
        assert.deepEqual((await state()).content, edited.content);
        await nativeRows(edited.content);
        const session = (await state()).revision.sessionId;
        await input('Longitude').fill('bad');
        await button('Reopen saved').click();
        await expect(saveStatus).toContainText('GeoPendingInputs');
        await expect(input('Longitude')).toHaveValue('bad');
        assert.equal((await state()).revision.sessionId, session);
        assert.deepEqual((await state()).content, edited.content);
        await button('Cancel').click();
        await button('Reopen saved').click();
        await expect.poll(async () => (await state()).revision.sessionId !== session).toBe(true);
        await nativeRows(edited.content);
        await table.scrollIntoViewIfNeeded();
        if (width === 390)
          assert.equal(await table.evaluate((el) => el.scrollWidth > el.clientWidth), true);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: path.join(root, `geo-linked-table-${width}.png`),
          fullPage: true,
        });
        await page.evaluate(() => {
          globalThis.retiredTableButton = document.querySelector('.geo-feature-table button');
        });
        await page.evaluate('host.revoke()');
        await page.evaluate('retiredTableButton.click()');
        assert.deepEqual((await state()).content, edited.content);
        assert.equal((await state()).view.state, 'revoked');
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        reports.push({ kind, width, sourceCommit: pins.sourceCommit, result: 'PASS' });
        console.log(
          'PASS',
          kind,
          width,
          'installed linked map/table / all attrs / atomic edit + history / dirty + composition / real save + reopen / revoke',
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
await writeFile(path.join(directory, 'geo-table-results.json'), JSON.stringify(reports, null, 2));
