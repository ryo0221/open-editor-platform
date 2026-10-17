/* global document, innerWidth */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]);
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!['geo-import.html', 'geo-import.js', 'geo-save.html', 'geo-save.js'].includes(name)) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        errors = [];
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
      try {
        await page.goto(`${origin}/geo-import.html`);
        await page.waitForFunction('globalThis.ready');
        const state = () => page.evaluate('geoImportHost.state()');
        const button = (name) => page.getByRole('button', { name, exact: true });
        const file = (text) =>
          page
            .getByLabel('Local file', { exact: true })
            .setInputFiles({ name: 'sites.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
        const region = page.getByRole('region', { name: 'Import geographic data', exact: true });
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
        const initial = await state();
        const sourceA = 'ID,lon,lat,value\nA,10,20,1';
        const sourceB = 'ID,lon,lat,value\n001,12,34,0\n002,,34,1\n003,13,35,2\n004,,35,3';
        await file(sourceA);
        await page.evaluate('geoImportHost.holdSource()');
        await button('Preview import').click();
        await expect.poll(async () => (await state()).staged).toBe(1);
        await button('Cancel import').click();
        await expect.poll(async () => (await state()).staged).toBe(0);
        await file(sourceB);
        await button('Preview import').click();
        await expect(region).toContainText('Read 4; valid 2; problem 2');
        await page.evaluate('geoImportHost.releaseSource()');
        await expect(region).toContainText('Read 4; valid 2; problem 2');
        assert.equal((await state()).staged, 1);
        assert.equal((await state()).retained, 0);
        await expect(button('Import previewed data')).toBeDisabled();
        assert.deepEqual((await state()).content, initial.content);
        // Composition retires the ready preview/lease and requires explicit re-preview.
        const fieldName = page.getByLabel('Display name 1', { exact: true });
        await fieldName.dispatchEvent('compositionstart', { data: '' });
        await expect(button('Preview import')).toBeDisabled();
        await expect(button('Import previewed data')).toBeDisabled();
        await expect(button('Cancel import')).toBeDisabled();
        assert.equal((await state()).staged, 0);
        assert.deepEqual((await state()).content, initial.content);
        await fieldName.fill('Identifier');
        await fieldName.dispatchEvent('compositionend', { data: 'Identifier' });
        await expect(button('Import previewed data')).toBeDisabled();
        await button('Preview import').click();
        await expect(region).toContainText('Read 4; valid 2; problem 2');
        await expect(region).toContainText('CSV row numbers count data records after the header');
        await expect(region).toContainText('longitude 12; latitude 34');
        await expect(region).toContainText('Blocked; see row diagnostics.');
        await page.getByRole('checkbox').check();
        await button('Import previewed data').click();
        await expect(page.getByRole('status')).toContainText('Imported 2; excluded 2');
        const imported = await state();
        assert.equal(imported.staged, 0);
        assert.equal(imported.retained, 1);
        assert.equal(imported.revision.sequence, 1);
        assert.equal(imported.view.canSave, false);
        assert.equal((await page.evaluate('geoImportHost.save()')).state, 'refused');
        assert.deepEqual(imported.originals, [
          {
            resourceId: imported.content.sources[0].resourceId,
            byteLength: Buffer.byteLength(sourceB),
            hash: createHash('sha256').update(sourceB).digest('hex'),
          },
        ]);
        assert.equal(imported.content.sources[0].id, 'source-3');
        assert.equal(imported.content.layers[0].features[0].values['field-1'], '001');
        const feature = imported.content.layers[0].features[1].id;
        await button(`Select ${feature} (Point)`).click();
        await expect(
          page.getByRole('button', { name: `Select point ${feature};`, exact: false }),
        ).toHaveAttribute('aria-pressed', 'true');
        await button('Undo import').click();
        assert.deepEqual((await state()).content, initial.content);
        assert.deepEqual((await state()).originals, imported.originals);
        await button('Redo import').click();
        assert.deepEqual((await state()).content, imported.content);
        assert.deepEqual((await state()).originals, imported.originals);
        // The unapproved 200-feature Host profile is not silently enabled.
        await file(
          [
            'ID,lon,lat,value',
            ...Array.from({ length: 200 }, (_, i) => `${i},${i > 197 ? '' : 12},34,${i}`),
          ].join('\n'),
        );
        await button('Preview import').click();
        await expect(region).toContainText('Read 200; valid 198; problem 2');
        await page.getByRole('checkbox').check();
        await button('Import previewed data').click();
        await expect(page.getByRole('status')).toContainText('feature-limit');
        assert.deepEqual((await state()).content, imported.content);
        assert.equal((await state()).revision.sequence, 3);
        assert.deepEqual((await state()).originals, imported.originals);
        await button('Cancel import').click();
        assert.equal((await state()).staged, 0);
        await page.screenshot({ path: path.join(root, `geo-import-${width}.png`) });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await file(sourceA);
        await page.evaluate('geoImportHost.holdSource()');
        await button('Preview import').click();
        await expect.poll(async () => (await state()).staged).toBe(1);
        await page.evaluate('geoImportHost.revoke()');
        await page.evaluate('geoImportHost.releaseSource()');
        await expect.poll(async () => (await state()).staged).toBe(0);
        assert.equal((await state()).retained, 0);
        assert.deepEqual((await state()).content, imported.content);
        assert.deepEqual((await state()).errors, []);
        assert.deepEqual(errors, []);
        await page.reload();
        await page.waitForFunction('globalThis.ready');
        assert.deepEqual((await state()).content, initial.content);
        assert.equal((await state()).retained, 0);
        await page.goto(origin + '/geo-save.html');
        await page.waitForFunction('globalThis.ready');
        const beforeFocus = await page.evaluate('host.state()');
        for (const kind of ['table', 'map']) {
          const target = page.getByRole('button', {
            name: kind === 'table' ? 'Select point-2 (Point)' : 'Select point point-2;',
            exact: kind === 'table',
          });
          const original = await target.elementHandle();
          await target.focus();
          await page.keyboard.press('Enter');
          await expect(target).toBeFocused();
          assert.equal(await original.evaluate((node) => node.isConnected), true);
          await expect(target).toHaveAttribute('aria-pressed', 'true');
          await page.keyboard.press('Tab');
          await expect(target).not.toBeFocused();
        }
        const selector = page.getByLabel('Scalar field', { exact: true });
        await selector.focus();
        await selector.selectOption('code');
        await expect(selector).toBeFocused();
        const afterFocus = await page.evaluate('host.state()');
        assert.equal(afterFocus.hash, beforeFocus.hash);
        assert.deepEqual(afterFocus.revision, beforeFocus.revision);
        assert.deepEqual(errors, []);
        console.log(
          'PASS',
          kind,
          width,
          'installed import / cancelled A + live B / explicit partial / exact originals / UndoRedo / capacity / revoke / volatile reload',
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
