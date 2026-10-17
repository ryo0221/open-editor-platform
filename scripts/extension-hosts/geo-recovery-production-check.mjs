/* global CompositionEvent, innerWidth, document */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { readFile, mkdtemp, rename } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]);
const artifactDirectory = await mkdtemp('/tmp/issue76-geo-recovery-');
console.log('EVIDENCE_DIRECTORY', artifactDirectory);
const pendingGuide =
  'Your input is still kept. To preserve changes, Apply, then Save original + native before reopening. Cancel discards pending input. Reopen replaces unsaved changes with the saved version.';
const erroneous = 'ID,lat,lon,amount\n001,35,139,10\n002,36,140,oops\n003,,,30';
const repaired = erroneous.replace('oops', '20');
const state = (page) => page.evaluate('geoSourceHost.state()');
const info = (page) => page.evaluate('geoSourceHost.retained()');
const button = (page, name) => page.getByRole('button', { name, exact: true });
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
  // Pace the representative recorded Host for human review; these are functional checks.
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    slowMo: kind === 'reference' ? 90 : 0,
  });
  try {
    for (const width of [1280, 390]) {
      const record = kind === 'reference' && width === 390;
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        ...(record
          ? { recordVideo: { dir: artifactDirectory, size: { width, height: 900 } } }
          : {}),
      });
      const page = await context.newPage(),
        errors = [];
      const video = page.video();
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
      try {
        await page.goto(origin + '/geo-source-save.html');
        await page.waitForFunction('globalThis.ready');
        const region = page.getByRole('region', { name: 'Import geographic data', exact: true });
        const preview = () =>
          region.getByRole('button', { name: 'Preview import', exact: true }).click();
        const loadFile = (bytes) =>
          region.getByLabel('Local file', { exact: true }).setInputFiles({
            name: bytes === erroneous ? 'needs-repair.csv' : 'repaired.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(bytes),
          });
        await loadFile(erroneous);
        for (const [label, value] of [
          ['ID column (optional)', 'ID'],
          ['First coordinate column', 'latitude'],
          ['Second coordinate column', 'lon'],
        ])
          await region.getByLabel(label, { exact: true }).fill(value);
        for (const [i, name, type] of [
          [1, 'ID', 'string'],
          [2, 'amount', 'boolean'],
        ]) {
          await region.getByRole('button', { name: 'Add field', exact: true }).click();
          await region.getByLabel(`Input column/property ${i}`, { exact: true }).fill(name);
          await region.getByLabel(`Type ${i}`, { exact: true }).selectOption(type);
        }
        const empty = await state(page);
        const unchanged = async () => {
          const current = await state(page);
          assert.equal(current.hash, empty.hash);
          assert.deepEqual(current.revision, empty.revision);
          assert.equal(current.originals.length, 0);
          assert.equal(current.canUndo, false);
        };
        await preview();
        await expect(region).toContainText('Check exact CSV header names');
        await expect(region).toContainText('remove mappings for columns that are not in this file');
        await unchanged();
        await region.getByLabel('First coordinate column', { exact: true }).fill('lat');
        await preview();
        await expect(region).toContainText(
          'Longitude must be between -180 and 180; latitude between -90 and 90',
        );
        await expect(region).toContainText('coordinates are not swapped automatically');
        await unchanged();
        await region
          .getByLabel('CSV coordinate order', { exact: true })
          .selectOption('latitude-longitude');
        await preview();
        await expect(region).toContainText('Check the selected Type for this column/property');
        await expect(region).toContainText('booleans must be true or false');
        await unchanged();
        await region.getByLabel('Type 2', { exact: true }).selectOption('number');
        await preview();
        await expect(region).toContainText(
          'Both coordinates must be finite numbers, not blank text',
        );
        await expect(region).toContainText('explicitly choose preserve-null');
        await unchanged();
        await region
          .getByLabel('Missing coordinate policy', { exact: true })
          .selectOption('preserve-null');
        await preview();
        await expect(region).toContainText('Read 3; valid 2; problem 1');
        await expect(region).toContainText('partial import requires explicit consent');
        await expect(
          region.getByRole('list', { name: 'Mapped coordinate sample', exact: true }),
        ).toContainText('longitude 139; latitude 35');
        await expect(
          region.getByRole('list', { name: 'Mapped coordinate sample', exact: true }),
        ).toContainText('Row 2: Blocked; see row diagnostics.');
        await expect(
          region.getByRole('list', { name: 'Mapped coordinate sample', exact: true }),
        ).toContainText('No location (null geometry)');
        await expect(
          region.getByRole('button', { name: 'Import previewed data', exact: true }),
        ).toBeDisabled();
        await unchanged();
        await region.getByRole('checkbox').check();
        await region.getByRole('button', { name: 'Import previewed data', exact: true }).click();
        await expect
          .poll(async () => (await state(page)).content.layers[0]?.features.length)
          .toBe(2);
        await expect(region).toContainText('Imported 2; excluded 1');
        await expect(region).toContainText('Excluded row 2');
        const partial = await state(page);
        assert.deepEqual(
          partial.content.layers[0].features.map((feature) => feature.values['field-1']),
          ['001', '003'],
        );
        assert.deepEqual(partial.content.layers[0].features[0].geometry.coordinates, [139, 35]);
        assert.equal(partial.content.layers[0].features[1].geometry, null);
        // Correct the source itself, reselect it, and explicitly preview again.
        await loadFile(repaired);
        await preview();
        await expect(region).toContainText('Read 3; valid 3; problem 0');
        await region.getByRole('button', { name: 'Import previewed data', exact: true }).click();
        await expect.poll(async () => (await state(page)).content.layers.length).toBe(2);
        const all = await state(page),
          second = all.content.layers[1],
          target = second.features[0];
        assert.deepEqual(all.content.layers[0], partial.content.layers[0]);
        assert.deepEqual(
          second.features.map((feature) => feature.values['field-1']),
          ['001', '002', '003'],
        );
        assert.equal(second.features[1].values['field-2'], 20);
        assert.equal(second.features[2].geometry, null);
        await page
          .getByRole('region', { name: `Attributes ${second.id}`, exact: true })
          .getByRole('button', { name: `Select ${target.id} (Point)`, exact: true })
          .click();
        await button(page, 'Undo last change').click();
        assert.equal((await state(page)).hash, partial.hash);
        await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('139');
        await expect(
          page.getByRole('region', {
            name: `Attributes ${partial.content.layers[0].id}`,
            exact: true,
          }),
        ).toBeVisible();
        await button(page, 'Redo last change').click();
        assert.equal((await state(page)).hash, all.hash);
        await button(page, 'Save original + native').click();
        await expect.poll(async () => (await info(page)).versions).toBe(1);
        await expect.poll(async () => (await state(page)).retained).toBe(0);
        const saved = JSON.parse(await page.evaluate('geoSourceHost.raw()'));
        assert.equal(Buffer.from(saved.closure[0].bytes, 'base64').toString(), erroneous);
        assert.deepEqual(saved.closure[0].recipe.decision, { mode: 'partial', excludedRows: [2] });
        assert.equal(Buffer.from(saved.closure[1].bytes, 'base64').toString(), repaired);
        assert.deepEqual(saved.closure[1].recipe.decision, { mode: 'all' });
        let savedState = await state(page);
        // Valid dirty input blocks reopening and remains available until explicit Cancel.
        await page.getByLabel('Longitude', { exact: true }).fill('139.25');
        await page.getByLabel('Scalar value', { exact: true }).fill('edited-code');
        await button(page, 'Reopen latest').click();
        await expect(
          page.getByRole('status', { name: 'Source save status', exact: true }),
        ).toContainText(pendingGuide);
        await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('139.25');
        await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('edited-code');
        assert.equal((await state(page)).hash, savedState.hash);
        // Apply commits only the live native. Without Save, Reopen restores the prior saved version.
        await button(page, 'Apply').click();
        const appliedOnly = await state(page);
        assert.notEqual(appliedOnly.hash, savedState.hash);
        assert.equal(appliedOnly.revision.sequence, savedState.revision.sequence + 1);
        assert.equal(appliedOnly.inputs.dirty, 0);
        assert.equal(appliedOnly.head, saved.nativeVersion.versionId);
        assert.deepEqual(JSON.parse(await page.evaluate('geoSourceHost.raw()')), saved);
        assert.equal((await info(page)).versions, 1);
        await button(page, 'Reopen latest').click();
        await expect
          .poll(async () => (await state(page)).revision.sessionId)
          .not.toBe(appliedOnly.revision.sessionId);
        assert.equal((await state(page)).hash, savedState.hash);
        await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('139');
        await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('001');
        // Follow the preservation instructions in order: Apply, Save, then Reopen.
        await page.getByLabel('Longitude', { exact: true }).fill('139.5');
        await page.getByLabel('Scalar value', { exact: true }).fill('preserved-code');
        await button(page, 'Reopen latest').click();
        await expect(
          page.getByRole('status', { name: 'Source save status', exact: true }),
        ).toContainText(pendingGuide);
        await button(page, 'Apply').click();
        const appliedForSave = await state(page);
        assert.notEqual(appliedForSave.hash, savedState.hash);
        assert.equal(appliedForSave.head, saved.nativeVersion.versionId);
        assert.deepEqual(JSON.parse(await page.evaluate('geoSourceHost.raw()')), saved);
        await button(page, 'Save original + native').click();
        await expect.poll(async () => (await info(page)).versions).toBe(2);
        await expect.poll(async () => (await state(page)).retained).toBe(0);
        const updated = JSON.parse(await page.evaluate('geoSourceHost.raw()'));
        assert.equal(updated.request.capture.contentHash, appliedForSave.hash);
        assert.notEqual(updated.nativeVersion.versionId, saved.nativeVersion.versionId);
        assert.equal((await info(page)).head, updated.nativeVersion.versionId);
        assert.deepEqual(updated.closure, saved.closure);
        await button(page, 'Reopen latest').click();
        await expect
          .poll(async () => (await state(page)).revision.sessionId)
          .not.toBe(appliedForSave.revision.sessionId);
        savedState = await state(page);
        assert.equal(savedState.hash, appliedForSave.hash);
        assert.equal(savedState.head, updated.nativeVersion.versionId);
        await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('139.5');
        await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue(
          'preserved-code',
        );
        // Cancel discards only the pending buffer; Reopen keeps the last saved edit.
        await page.getByLabel('Longitude', { exact: true }).fill('139.65');
        await page.getByLabel('Scalar value', { exact: true }).fill('discard-this-input');
        await button(page, 'Reopen latest').click();
        await expect(
          page.getByRole('status', { name: 'Source save status', exact: true }),
        ).toContainText(pendingGuide);
        await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue(
          'discard-this-input',
        );
        assert.equal((await state(page)).hash, savedState.hash);
        await button(page, 'Cancel').click();
        assert.equal((await state(page)).inputs.dirty, 0);
        assert.equal((await state(page)).hash, savedState.hash);
        await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('139.5');
        await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue(
          'preserved-code',
        );
        await button(page, 'Reopen latest').click();
        await expect
          .poll(async () => (await state(page)).revision.sessionId)
          .not.toBe(savedState.revision.sessionId);
        assert.equal((await state(page)).hash, savedState.hash);
        const reopened = await state(page);
        // Composition uses the same public DOM/Inputs boundary; no synthetic native mutation.
        await page.getByLabel('Longitude', { exact: true }).fill('139.75');
        await page
          .getByLabel('Longitude', { exact: true })
          .evaluate((input) =>
            input.dispatchEvent(
              new CompositionEvent('compositionstart', { bubbles: true, data: '5' }),
            ),
          );
        assert.equal((await state(page)).inputs.composing, 1);
        await button(page, 'Reopen latest').click();
        await expect(
          page.getByRole('status', { name: 'Source save status', exact: true }),
        ).toContainText('Finish text composition. ' + pendingGuide);
        assert.equal((await state(page)).inputs.composing, 1);
        assert.equal((await state(page)).hash, reopened.hash);
        assert.deepEqual((await state(page)).revision, reopened.revision);
        await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('139.75');
        await page
          .getByLabel('Longitude', { exact: true })
          .evaluate((input) =>
            input.dispatchEvent(
              new CompositionEvent('compositionend', { bubbles: true, data: '5' }),
            ),
          );
        await button(page, 'Cancel').click();
        assert.equal((await state(page)).inputs.dirty, 0);
        assert.equal((await state(page)).inputs.composing, 0);
        await button(page, 'Reopen latest').click();
        await expect
          .poll(async () => (await state(page)).revision.sessionId)
          .not.toBe(reopened.revision.sessionId);
        assert.equal((await state(page)).hash, savedState.hash);
        assert.equal((await info(page)).versions, 2);
        assert.deepEqual((await state(page)).errors, []);
        assert.deepEqual(errors, []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: path.join(artifactDirectory, `geo-recovery-${kind}-${width}.png`),
        });
        console.log(
          'PASS',
          kind,
          width,
          pin.sourceCommit,
          'wrong column/type/axis guided repair / partial consent / corrected source reimport / clean missing-target fallback / Apply without Save discarded / Apply+Save+Reopen preserved / Cancel discards pending input / IME blocked reopen and recovery / originals+native preserved',
        );
      } catch (error) {
        console.error('FAIL', kind, width, pin.sourceCommit);
        await page
          .screenshot({
            path: path.join(artifactDirectory, `geo-recovery-failure-${kind}-${width}.png`),
          })
          .catch(() => {});
        throw error;
      } finally {
        await context.close();
        if (video) {
          const output = path.join(
            artifactDirectory,
            `geo-recovery-${kind}-${width}-${pin.sourceCommit.slice(0, 8)}.webm`,
          );
          await rename(await video.path(), output);
          console.log('RECORDING', output);
        }
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
