/* global CompositionEvent, crypto */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]);
const failures = [];
const scenarios = [
  'layer',
  'mapping',
  'file',
  'add',
  'remove',
  'cancel',
  'composition',
  'unchanged',
  'previous-draft',
  'save-pending',
  'revoke',
];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const pin = JSON.parse(await readFile(path.join(root, 'editor-pin.json'), 'utf8'));
  const server = createServer(async (request, response) => {
    const file = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (!['geo-source-save.html', 'geo-source-save.js'].includes(file)) {
      response.writeHead(204).end();
      return;
    }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(await readFile(path.join(root, 'dist', file)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390])
      for (const scenario of scenarios) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        try {
          await page.goto(`http://127.0.0.1:${server.address().port}/geo-source-save.html`);
          await page.waitForFunction('globalThis.ready');
          const saved = await page.evaluate('geoSourceHost.save()');
          assert.equal(saved.outcome.state, 'committed');
          const before = await page.evaluate('geoSourceHost.state()');
          const layer = page.getByLabel('Layer name', { exact: true });
          const button = (name) => page.getByRole('button', { name, exact: true });
          if (scenario === 'remove') await button('Add field').click();
          if (scenario === 'previous-draft') await layer.fill('draft-before-reopen');
          let result;
          if (scenario === 'save-pending') {
            await page.evaluate(() => {
              globalThis.geoSourceHost.pauseBefore();
              globalThis.pendingSave = globalThis.geoSourceHost.save();
            });
            result = await page.evaluate(() =>
              globalThis.geoSourceHost.reopen().then(
                () => ({ state: 'opened' }),
                (error) => ({ state: 'refused', message: String(error) }),
              ),
            );
            assert.match(result.message, /GeoSavePending/);
            await page.evaluate(async () => {
              globalThis.geoSourceHost.releaseBefore();
              await globalThis.pendingSave;
            });
          } else {
            // Hold actual WebCrypto validation inside storage.read, after Reopen's initial guards.
            // This changes timing only: the original digest still computes the actual saved hash.
            await page.evaluate(() => {
              const original = crypto.subtle.digest;
              globalThis.restoreDigest = () => {
                crypto.subtle.digest = original;
              };
              crypto.subtle.digest = function (...args) {
                crypto.subtle.digest = original;
                globalThis.hashEntered = true;
                const work = original.apply(this, args);
                return new Promise((resolve, reject) => {
                  globalThis.releaseHash = () => work.then(resolve, reject);
                });
              };
              globalThis.reopenPending = globalThis.geoSourceHost.reopen().then(
                () => ({ state: 'opened' }),
                (error) => ({ state: 'refused', message: String(error) }),
              );
            });
            await page.waitForFunction('globalThis.hashEntered');
            if (scenario === 'layer') await layer.fill('draft-after-reopen-start');
            if (scenario === 'mapping')
              await page
                .getByLabel('First coordinate column', { exact: true })
                .fill('new-longitude');
            if (scenario === 'file')
              await page.getByLabel('Local file', { exact: true }).setInputFiles({
                name: 'new-input.csv',
                mimeType: 'text/csv',
                buffer: Buffer.from('lon,lat\n12,34'),
              });
            if (scenario === 'add') await button('Add field').click();
            if (scenario === 'remove') await button('Remove field 1').click();
            if (scenario === 'cancel') await button('Cancel import').click();
            if (scenario === 'composition')
              await layer.evaluate((input) => {
                input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
              });
            if (scenario === 'revoke') await page.evaluate('geoSourceHost.revoke()');
            result = await page.evaluate(async () => {
              globalThis.releaseHash();
              return await globalThis.reopenPending;
            });
            const replaces = scenario === 'unchanged' || scenario === 'previous-draft';
            if (replaces) {
              assert.equal(result.state, 'opened');
              assert.equal(await layer.inputValue(), 'Imported layer');
            } else {
              assert.equal(
                result.state,
                'refused',
                'input/authority arriving after Reopen must prevent adoption',
              );
              assert.equal(
                result.message,
                scenario === 'composition' ? 'Error: GeoPendingInputs' : 'Error: GeoReopenConflict',
              );
            }
            if (scenario === 'layer')
              assert.equal(await layer.inputValue(), 'draft-after-reopen-start');
            if (scenario === 'mapping')
              assert.equal(
                await page.getByLabel('First coordinate column', { exact: true }).inputValue(),
                'new-longitude',
              );
            if (scenario === 'file')
              assert.equal(
                await page
                  .getByLabel('Local file', { exact: true })
                  .evaluate((input) => input.files[0]?.name),
                'new-input.csv',
              );
            if (scenario === 'add') assert.equal(await button('Remove field 1').count(), 1);
            if (scenario === 'remove') assert.equal(await button('Remove field 1').count(), 0);
            if (scenario === 'composition')
              await layer.evaluate((input) =>
                input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })),
              );
          }
          const after = await page.evaluate('geoSourceHost.state()');
          assert.equal(after.hash, before.hash);
          assert.equal(after.head, before.head);
          assert.equal(after.writes, before.writes);
          assert.equal(after.retained, 0);
          if (!['unchanged', 'previous-draft'].includes(scenario))
            assert.deepEqual(after.revision, before.revision);
          assert.deepEqual(errors, []);
          console.log(
            JSON.stringify({
              kind,
              width,
              scenario,
              sourceCommit: pin.sourceCommit,
              state: 'PASS',
              result,
            }),
          );
        } catch (error) {
          failures.push({ kind, width, scenario, error: String(error) });
          console.log(
            JSON.stringify({
              kind,
              width,
              scenario,
              sourceCommit: pin.sourceCommit,
              state: 'FAIL',
              error: String(error),
            }),
          );
        } finally {
          await page.evaluate(() => globalThis.restoreDigest?.()).catch(() => {});
          await context.close();
        }
      }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
assert.deepEqual(failures, []);
