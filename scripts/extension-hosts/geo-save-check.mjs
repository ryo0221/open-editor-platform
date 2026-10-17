/* global document, window, crypto, TextEncoder */
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
      pathname === '/' ? 'geo-save.html' : pathname === '/geo-save.js' ? 'geo-save.js' : undefined;
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
      const errors = [],
        external = [],
        origin = `http://127.0.0.1:${server.address().port}`;
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
      await page.goto(origin);
      await page.waitForFunction('globalThis.ready');
      const state = () => page.evaluate('host.state()');
      const button = (name) => page.getByRole('button', { name, exact: true });
      const input = (name) => page.getByLabel(name, { exact: true });
      const clickReopen = async () => {
        const previousSession = (await state()).revision.sessionId;
        await expect(button('Reopen saved')).toBeEnabled();
        await button('Reopen saved').click();
        await expect.poll(async () => {
          const current = await state();
          return current.revision.sessionId !== previousSession && current.view.state === 'open';
        }).toBe(true);
        assert.equal((await state()).view.state, 'open');
      };
      const saveStatus = page.getByRole('status', { name: 'Native save status' });
      assert.equal(await page.locator('code').textContent(), pin);
      const initial = await state();
      await input('Longitude').fill('12.25');
      await input('Latitude').fill('34.25');
      await input('Scalar value').fill('20');
      await button('Save native').click();
      await expect(saveStatus).toHaveText('Saved current capture');
      const saved = await state();
      assert.equal(saved.revision.sequence, 1);
      assert.equal(saved.writes, 1);
      assert.equal(saved.content.layers[0].features[0].values.metric, 20);
      assert.deepEqual(
        saved.content.layers[0].features.slice(1),
        initial.content.layers[0].features.slice(1),
      );
      await page.screenshot({
        path: path.join(root, `geo-save-current-${width}.png`),
        fullPage: true,
      });
      const raw = await page.evaluate('host.raw()');
      const record = JSON.parse(raw);
      assert.deepEqual(record.request.content, saved.content);
      assert.equal(record.request.capture.contentHash, saved.hash);
      assert.deepEqual(record.request.capture, saved.view.lastSave.capture);
      assert.equal(record.receiptId, saved.view.lastSave.receipt.adapterReceiptId);
      await button('Undo').click();
      assert.deepEqual((await state()).content, initial.content);
      const undone = await state();
      await page.evaluate('host.save()');
      assert.equal((await state()).canRedo, true);
      assert.deepEqual((await state()).revision, undone.revision);
      await button('Redo').click();
      await page.evaluate('host.save()');
      const stableRaw = await page.evaluate('host.raw()');
      await input('Longitude').fill('bad');
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      await expect(input('Longitude')).toHaveValue('bad');
      await button('Reopen saved').click();
      await expect(saveStatus).toContainText('GeoPendingInputs');
      assert.equal(await page.evaluate('host.raw()'), stableRaw);
      assert.deepEqual((await state()).content, saved.content);
      await button('Cancel').click();
      await input('Longitude').dispatchEvent('compositionstart', { data: '' });
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      assert.equal((await state()).inputs.composing, 1);
      await button('Reopen saved').click();
      await expect(saveStatus).toContainText('GeoPendingInputs');
      await input('Longitude').dispatchEvent('compositionend', { data: '' });
      await button('Cancel').click();
      // Validate failures atomically; no data, history, scope or stored record changes.
      const beforeRefusal = await state();
      for (const fault of ['hash', 'receipt', 'receipt-value', 'capacity', 'source']) {
        const message = await page.evaluate(async (fault) => {
          const value = JSON.parse(await globalThis.host.raw());
          if (fault === 'hash') value.request.capture.contentHash = 'f'.repeat(64);
          if (fault === 'receipt') delete value.receiptId;
          if (fault === 'receipt-value') value.receiptId = 'wrong-receipt';
          if (fault === 'capacity') value.request.content.layers[0].name = 'x'.repeat(65536);
          if (fault === 'source') {
            value.request.content.sources = [
              {
                id: 'source-1',
                resourceId: 'synthetic-resource',
                pin: {
                  artifactId: 'synthetic-source',
                  versionId: 'version-1',
                  contentHash: 'sha256:' + 'b'.repeat(64),
                },
                bytesHash: 'sha256:' + 'c'.repeat(64),
                format: 'geojson',
                adapterVersion: 'synthetic/1',
                declaredCrs: 'OGC:CRS84',
                axis: 'longitude-latitude',
                attribution: 'Synthetic local test',
              },
            ];
            const canonical = (v) =>
              v && typeof v === 'object'
                ? Array.isArray(v)
                  ? '[' + v.map(canonical).join(',') + ']'
                  : '{' +
                    Object.keys(v)
                      .sort()
                      .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
                      .join(',') +
                    '}'
                : JSON.stringify(v);
            const hash = await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(canonical(value.request.content)),
            );
            value.request.capture.contentHash = Array.from(new Uint8Array(hash), (b) =>
              b.toString(16).padStart(2, '0'),
            ).join('');
          }
          try {
            await globalThis.host.reopenText(JSON.stringify(value));
            return 'unexpected-success';
          } catch (error) {
            return String(error);
          }
        }, fault);
        assert.notEqual(message, 'unexpected-success');
        if (fault === 'source') assert.match(message, /GeoSourceFreeProfileRequired/);
        if (fault === 'hash') assert.match(message, /CaptureHashMismatch/);
        if (fault === 'receipt') assert.match(message, /GeoStoredEnvelope/);
        if (fault === 'receipt-value') assert.match(message, /GeoStoredReceipt/);
        if (fault === 'capacity') assert.match(message, /GeoStoredRecordLimit/);
        const after = await state();
        assert.deepEqual(after.content, beforeRefusal.content);
        assert.deepEqual(after.revision, beforeRefusal.revision);
        assert.equal(after.canUndo, beforeRefusal.canUndo);
        assert.equal(after.canRedo, beforeRefusal.canRedo);
        assert.equal(await page.evaluate('host.raw()'), stableRaw);
      }
      await page.evaluate("host.nonUI('12.5','34.5','30')");
      await button('Reopen saved').click();
      await expect(saveStatus).toHaveText('Reopened acknowledged capture');
      assert.deepEqual((await state()).content, saved.content);
      assert.equal((await state()).revision.sequence, 0);
      assert.equal((await state()).canUndo, false);
      assert.equal((await state()).canRedo, false);
      await page.reload();
      await page.waitForFunction('globalThis.ready');
      assert.deepEqual((await state()).content, saved.content);
      assert.equal((await state()).canUndo, false);
      // A no-write after valid Inputs flush retains that one accepted edit and its Undo.
      await page.evaluate("host.storageMode('no-write')");
      await input('Scalar value').fill('25');
      const rejected = await page.evaluate('host.save()');
      assert.equal(rejected.outcome.state, 'aborted-before-write');
      assert.equal((await state()).content.layers[0].features[0].values.metric, 25);
      assert.equal((await state()).inputs.dirty, 0);
      assert.equal(await page.evaluate('host.raw()'), stableRaw);
      await button('Undo').click();
      assert.deepEqual((await state()).content, saved.content);
      await page.evaluate("host.storageMode('normal')");
      assert.equal((await page.evaluate('host.save()')).outcome.state, 'committed');
      // Actual adapter writes a fixed old capture while a later canonical edit remains unsaved.
      await page.evaluate("host.storageMode('delayed')");
      const writes = (await state()).writes;
      await page.evaluate(() => {
        globalThis.pendingSave = globalThis.host.save();
      });
      await expect.poll(async () => (await state()).writes).toBeGreaterThan(writes);
      await page.evaluate("host.nonUI('12.5','34.5','31')");
      const newer = await state();
      await page.evaluate('host.release()');
      assert.equal((await page.evaluate('pendingSave')).outcome.state, 'committed');
      await expect(saveStatus).toHaveText('Older capture saved; current draft unsaved');
      assert.deepEqual((await state()).revision, newer.revision);
      assert.notDeepEqual((await state()).saved?.revision, newer.revision);
      // Unknown-after-write is not retried or reopened until Host reconciliation.
      await page.evaluate("host.storageMode('uncertain')");
      assert.equal((await page.evaluate('host.save()')).outcome.state, 'indeterminate');
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      await expect(button('Reopen saved')).toBeDisabled();
      assert.match(
        await page.evaluate(() =>
          globalThis.host.reopen().then(
            () => 'unexpected',
            (error) => String(error),
          ),
        ),
        /GeoSavePending/,
      );
      assert.equal((await page.evaluate('host.revoke()')).state, 'incomplete');
      await page.evaluate('host.reconcile()');
      await clickReopen();
      await expect(input('Longitude')).toBeDisabled();
      await expect(button('Save native')).toBeDisabled();
      assert.equal((await page.evaluate("host.nonUI('12','34','8')")).state, 'refused');
      assert.equal((await state()).content.layers[0].features[0].values.metric, 31);
      // Dispatched writes may finish after revoke, but cannot mark that closed scope saved.
      await page.evaluate('host.authorizeEditable()');
      await page.evaluate("host.storageMode('delayed')");
      const lateWrites = (await state()).writes;
      await page.evaluate(() => {
        globalThis.pendingSave = globalThis.host.save();
      });
      await expect.poll(async () => (await state()).writes).toBeGreaterThan(lateWrites);
      const lateCapture = JSON.parse(await page.evaluate('host.raw()')).request.capture;
      assert.equal((await page.evaluate('host.revoke()')).state, 'incomplete');
      await expect(button('Reopen saved')).toBeDisabled();
      await page.evaluate('host.release()');
      assert.equal((await page.evaluate('pendingSave')).state, 'refused');
      await expect.poll(async () => (await state()).observations.at(-1).outcome?.state).toBe('committed');
      assert.notDeepEqual((await state()).saved, lateCapture);
      await clickReopen();
      await expect(input('Longitude')).toBeDisabled();
      assert.equal((await state()).canUndo, false);
      // Functional settlement deadline after real storage write; no performance measurement.
      await page.evaluate('host.authorizeEditable()');
      await page.evaluate("host.storageMode('delayed')");
      const deadlineWrites = (await state()).writes;
      await page.evaluate(() => {
        globalThis.pendingSave = globalThis.host.save();
      });
      await expect.poll(async () => (await state()).writes).toBeGreaterThan(deadlineWrites);
      if (kind === 'reference') await page.evaluate('host.expireSave()');
      const timedOut = await page.evaluate('pendingSave');
      assert.equal(timedOut.outcome.state, 'indeterminate');
      assert.equal(timedOut.outcome.reason, 'deadline');
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      assert.equal((await page.evaluate('host.revoke()')).state, 'incomplete');
      await expect(button('Reopen saved')).toBeDisabled();
      await page.evaluate('host.release()');
      await expect.poll(async () => (await state()).observations.at(-1).outcome?.state).toBe('committed');
      assert.equal((await page.evaluate('pendingSave')).outcome.state, 'indeterminate');
      await clickReopen();
      await expect(input('Longitude')).toBeDisabled();
      // Old scope cancellation before dispatch never overwrites actual saved bytes.
      await page.evaluate('host.authorizeEditable()');
      await page.evaluate("host.storageMode('normal')");
      const beforeCancel = await page.evaluate('host.raw()');
      await page.evaluate('host.pauseBefore()');
      await page.evaluate(() => {
        globalThis.pendingSave = globalThis.host.save();
      });
      await expect.poll(async () => (await state()).observations.some((j) => !j.outcome)).toBe(true);
      await page.evaluate('host.revoke()');
      await page.evaluate('host.releaseBefore()');
      assert.equal((await page.evaluate('pendingSave')).state, 'refused');
      assert.equal(await page.evaluate('host.raw()'), beforeCancel);
      for (const mode of ['no-save', 'no-storage']) {
        await page.evaluate((mode) => globalThis.host.open(mode), mode);
        await expect(button('Save native')).toBeDisabled();
        assert.equal((await page.evaluate('host.save()')).state, 'refused');
      }
      assert.deepEqual((await state()).errors, []);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
      await page.screenshot({ path: path.join(root, `geo-save-${width}.png`), fullPage: true });
      assert.equal((await page.evaluate('host.close()')).state, 'drained');
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      reports.push({ kind, width, sha256: pin, result: 'PASS' });
      console.log(
        'PASS',
        kind,
        width,
        'installed native Save/capture/history/reopen/reload/refusal/pending/late/unknown/revoke',
      );
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
assert.equal(hashes[0], hashes[1]);
await writeFile(path.join(directory, 'geo-save-results.json'), JSON.stringify(reports, null, 2));
