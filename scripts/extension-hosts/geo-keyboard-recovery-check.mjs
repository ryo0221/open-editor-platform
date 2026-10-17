/* global document, innerWidth, innerHeight, requestAnimationFrame */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]);
const evidence = await mkdtemp('/tmp/issue76-geo-keyboard-');
console.log('EVIDENCE_DIRECTORY', evidence);
const state = (page) => page.evaluate('geoSourceHost.state()');
const info = (page) => page.evaluate('geoSourceHost.retained()');
const csv = 'ID,lat,lon,amount\n001,35,139,10\n002,36,140,bad';
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
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage(),
        errors = [],
        trace = [];
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
      let phase = 'setup';
      const inspectFocus = async () => {
        // Check after two paint opportunities, not in the synchronous insertion frame.
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const focus = await page.evaluate(() => {
          const element = document.activeElement;
          if (!element || element === document.body) return null;
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            label:
              element.getAttribute('aria-label') ??
              element.labels?.[0]?.textContent ??
              element.textContent?.trim(),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              rect.x + rect.width / 2 >= 0 &&
              rect.x + rect.width / 2 <= innerWidth &&
              rect.y + rect.height / 2 >= 0 &&
              rect.y + rect.height / 2 <= innerHeight,
          };
        });
        if (focus) {
          trace.push({ phase, ...focus });
          assert.equal(
            focus.visible,
            true,
            `Focused control outside viewport: ${JSON.stringify(focus)}`,
          );
        }
      };
      const tabTo = async (locator, reverse = false) => {
        await expect(locator).toBeEnabled();
        for (let step = 0; step < 160; step++) {
          if (await locator.evaluate((element) => document.activeElement === element)) {
            await inspectFocus();
            return;
          }
          await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab');
          await inspectFocus();
        }
        throw Error('KeyboardTargetUnreachable: ' + (await locator.textContent()));
      };
      const input = async (label, text, reverse = false) => {
        await tabTo(page.getByLabel(label, { exact: true }), reverse);
        await page.keyboard.press('Control+A');
        await page.keyboard.type(text);
        await inspectFocus();
      };
      const choose = async (label, index, reverse = false) => {
        const locator = page.getByLabel(label, { exact: true });
        await tabTo(locator, reverse);
        await page.keyboard.press('Home');
        for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await inspectFocus();
      };
      const activate = async (name, reverse = false, key = 'Enter') => {
        await tabTo(page.getByRole('button', { name, exact: true }), reverse);
        await page.keyboard.press(key);
        await inspectFocus();
      };
      try {
        await page.goto(origin + '/geo-source-save.html');
        await page.waitForFunction('globalThis.ready');
        // Declared setup only: supplied file and one starting focus. No native-picker claim.
        const file = page.getByLabel('Local file', { exact: true });
        await file.setInputFiles({
          name: 'keyboard.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(csv),
        });
        await file.focus();
        await inspectFocus();
        // From this point all control changes/navigation use keyboard events only.
        phase = 'mapping and wrong-column recovery';
        await input('ID column (optional)', 'ID');
        await input('First coordinate column', 'latitude');
        await input('Second coordinate column', 'lon');
        for (const [i, name, typeIndex] of [
          [1, 'ID', 0],
          [2, 'amount', 1],
        ]) {
          await activate('Add field');
          await input(`Input column/property ${i}`, name, true);
          await choose(`Type ${i}`, typeIndex);
        }
        const region = page.getByRole('region', { name: 'Import geographic data', exact: true });
        const empty = await state(page);
        await activate('Preview import');
        await expect(region).toContainText('Check exact CSV header names');
        assert.equal((await state(page)).hash, empty.hash);
        await input('First coordinate column', 'lat', true);
        await activate('Preview import');
        await expect(region).toContainText('coordinates are not swapped automatically');
        assert.equal((await state(page)).hash, empty.hash);
        phase = 'axis and field-type repair';
        await choose('CSV coordinate order', 1, true);
        await activate('Preview import');
        await expect(region).toContainText('Check the selected Type');
        assert.equal((await state(page)).hash, empty.hash);
        await choose('Type 2', 0, true);
        await activate('Preview import');
        await expect(region).toContainText('Read 2; valid 2; problem 0');
        await activate('Import previewed data');
        await expect
          .poll(async () => (await state(page)).content.layers[0]?.features.length)
          .toBe(2);
        const imported = await state(page);
        assert.deepEqual(imported.content.layers[0].features[0].geometry.coordinates, [139, 35]);
        assert.equal(imported.content.layers[0].features[0].values['field-1'], '001');
        assert.equal(imported.content.layers[0].features[1].values['field-2'], 'bad');
        await activate('Save original + native');
        await expect.poll(async () => (await info(page)).versions).toBe(1);
        await expect.poll(async () => (await state(page)).retained).toBe(0);
        const saved = JSON.parse(await page.evaluate('geoSourceHost.raw()'));
        phase = 'invalid Point apply retains every field';
        await choose('Scalar field', 1);
        await input('Longitude', 'west');
        await input('Latitude', '35.25');
        await input('Scalar value', 'kept-data');
        const dirty = await state(page);
        await activate('Apply', true);
        await expect(
          page.getByRole('status', { name: 'Geo edit status', exact: true }),
        ).toContainText('GeoInvalidNumber');
        assert.equal((await state(page)).hash, imported.hash);
        assert.deepEqual((await state(page)).revision, dirty.revision);
        await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('west');
        await expect(page.getByLabel('Latitude', { exact: true })).toHaveValue('35.25');
        await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('kept-data');
        phase = 'correct Point input and Apply without Save';
        await input('Longitude', '139.25');
        await activate('Apply', true);
        const applied = await state(page);
        assert.equal(applied.revision.sequence, dirty.revision.sequence + 1);
        assert.equal(applied.content.layers[0].features[0].values['field-2'], 'kept-data');
        await expect(
          page.getByRole('status', { name: 'Geo edit status', exact: true }),
        ).not.toContainText('GeoInvalidNumber');
        assert.deepEqual(JSON.parse(await page.evaluate('geoSourceHost.raw()')), saved);
        await activate('Reopen latest', true);
        await expect
          .poll(async () => (await state(page)).revision.sessionId)
          .not.toBe(applied.revision.sessionId);
        assert.equal((await state(page)).hash, imported.hash);
        phase = 'dirty refusal then Apply Save Reopen';
        await choose('Scalar field', 1);
        await input('Longitude', '139.5');
        await input('Scalar value', 'persisted-keyboard');
        await activate('Reopen latest', true);
        await expect(
          page.getByRole('status', { name: 'Source save status', exact: true }),
        ).toContainText('Apply, then Save original + native before reopening');
        await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue(
          'persisted-keyboard',
        );
        await activate('Apply');
        const toSave = await state(page);
        await activate('Save original + native', true);
        await expect.poll(async () => (await info(page)).versions).toBe(2);
        await expect.poll(async () => (await state(page)).retained).toBe(0);
        await activate('Reopen latest');
        await expect
          .poll(async () => (await state(page)).revision.sessionId)
          .not.toBe(toSave.revision.sessionId);
        assert.equal((await state(page)).hash, toSave.hash);
        assert.equal(
          (await state(page)).content.layers[0].features[0].values['field-2'],
          'persisted-keyboard',
        );
        phase = 'Space Cancel and reopen recovery';
        await input('Longitude', '139.75');
        await activate('Cancel', true, 'Space');
        assert.equal((await state(page)).inputs.dirty, 0);
        assert.equal((await state(page)).hash, toSave.hash);
        await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('139.5');
        await activate('Reopen latest', true);
        await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('139.5');
        assert.equal((await state(page)).hash, toSave.hash);
        assert.equal((await info(page)).versions, 2);
        assert.deepEqual((await state(page)).errors, []);
        assert.deepEqual(errors, []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({ path: path.join(evidence, `${kind}-${width}.png`) });
        console.log(
          'PASS',
          kind,
          width,
          pin.sourceCommit,
          trace.length,
          'keyboard focus steps / wrong column-axis-type recovery / invalid Point full retention / Apply≠Save / Apply+Save+Reopen / ShiftTab + Space Cancel',
        );
      } catch (error) {
        console.error('FAIL', kind, width, pin.sourceCommit, phase);
        await page
          .screenshot({ path: path.join(evidence, `${kind}-${width}-failure.png`) })
          .catch(() => {});
        throw error;
      } finally {
        await writeFile(
          path.join(evidence, `${kind}-${width}-focus.json`),
          JSON.stringify(trace, null, 2),
        );
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
