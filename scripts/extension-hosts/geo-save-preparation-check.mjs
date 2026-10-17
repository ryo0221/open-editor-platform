/* global crypto */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]),
  reports = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
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
    const page = await browser.newPage(),
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
    await page.goto(origin);
    await page.waitForFunction('globalThis.ready');
    await page.evaluate('host.save()');
    const stored = await page.evaluate('host.raw()');
    await page.getByLabel('Scalar value', { exact: true }).fill('55');
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let first = true;
      globalThis.restoreDigest = () => {
        crypto.subtle.digest = digest;
      };
      crypto.subtle.digest = (...args) => {
        if (!first) return digest(...args);
        first = false;
        return new Promise((resolve, reject) => {
          globalThis.releaseDigest = () => {
            void digest(...args).then(resolve, reject);
          };
        });
      };
      globalThis.pendingSave = globalThis.host.save();
    });
    const prepared = await page.evaluate('host.state()');
    const buttonDisabled = await page
      .getByRole('button', { name: 'Reopen saved', exact: true })
      .isDisabled();
    assert.equal(prepared.view.saving, true);
    assert.equal(prepared.content.layers[0].features[0].values.metric, 55);
    assert.equal(prepared.inputs.dirty, 0);
    assert.equal(
      prepared.observations.some((job) => !job.outcome || job.outcome.state === 'indeterminate'),
      false,
    );
    assert.equal(await page.evaluate('host.raw()'), stored);
    assert.notDeepEqual(prepared.saved?.revision, prepared.revision);
    await page.evaluate(() => {
      globalThis.reopenResult = 'pending';
      globalThis.reopenAttempt = globalThis.host.reopen().then(
        () => {
          globalThis.reopenResult = 'opened';
        },
        (error) => {
          globalThis.reopenResult = String(error);
        },
      );
    });
    await expect.poll(() => page.evaluate(
      async () =>
        globalThis.reopenResult !== 'pending' ||
        (await globalThis.host.state()).scope === 'revoked',
    )).toBe(true);
    const during = await page.evaluate('host.state()');
    await page.evaluate(() => {
      globalThis.restoreDigest();
      globalThis.releaseDigest();
    });
    await page.evaluate('reopenAttempt');
    const save = await page.evaluate('pendingSave'),
      after = await page.evaluate('host.state()');
    const refusal = await page.evaluate('reopenResult');
    let result = 'PASS',
      failure;
    try {
      assert.equal(buttonDisabled, true);
      assert.match(refusal, /GeoSavePending/);
      assert.equal(during.scope, 'open');
      assert.equal(during.view.saving, true);
      assert.deepEqual(during.revision, prepared.revision);
      assert.deepEqual(during.content, prepared.content);
      assert.equal(during.canUndo, prepared.canUndo);
      assert.equal(during.canRedo, prepared.canRedo);
      assert.equal(save.outcome?.state, 'committed');
      assert.deepEqual(after.content, prepared.content);
      assert.deepEqual(after.revision, prepared.revision);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    } catch (error) {
      result = 'FAIL';
      failure = String(error);
    }
    reports.push({ kind, result, failure, buttonDisabled, refusal, save, prepared, during, after });
    console.log(
      result,
      kind,
      'first digest delayed: preparation save/reopen exclusion',
      failure ?? '',
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
await writeFile(
  path.join(directory, 'geo-save-preparation-results.json'),
  JSON.stringify(reports, null, 2),
);
assert.ok(reports.every((r) => r.result === 'PASS'));
