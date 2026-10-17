/* global window, document */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]);
const hashes = [];
const reports = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind),
    verification = JSON.parse(await readFile(path.join(root, 'verification.json')));
  hashes.push(verification.editorSha256);
  const server = createServer(async (req, res) => {
    const file = req.url === '/' ? 'index.html' : req.url === '/main.js' ? 'main.js' : undefined;
    if (!file) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', file)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } }),
        errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction('globalThis.ready');
      const value = () => page.getByLabel('Counter value').textContent();
      assert.equal(await value(), '0');
      assert.equal(await page.locator('code').textContent(), verification.editorSha256);
      await page.getByRole('button', { name: 'Increment', exact: true }).click();
      assert.equal(await value(), '1');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.equal(await value(), '0');
      // No-op must leave the existing redo branch intact.
      assert.deepEqual(await page.evaluate('host.set(0)'), { state: 'unchanged' });
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      assert.equal(await value(), '1');
      assert.deepEqual(await page.evaluate('host.set(7)'), { state: 'applied' });
      assert.equal(await value(), '7');
      assert.equal((await page.evaluate('host.set(1001)')).code, 'InvalidContent');
      assert.equal(await value(), '7');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'committed' }).waitFor();
      await page.screenshot({ path: path.join(root, `counter-${width}.png`), fullPage: true });
      await page.reload();
      await page.waitForFunction('globalThis.ready');
      assert.equal(await value(), '7');
      await page.evaluate("host.mode('no-write')");
      assert.equal((await page.evaluate('host.save()')).outcome.state, 'aborted-before-write');
      await page.evaluate("host.mode('uncertain')");
      assert.equal((await page.evaluate('host.save()')).outcome.state, 'indeterminate');
      assert.equal((await page.evaluate('host.save()')).code, 'SaveBusy');
      await page.evaluate('host.deny()');
      assert.equal(await page.getByLabel('Counter value').count(), 0);
      assert.equal((await page.evaluate('host.set(9)')).code, 'ScopeRevoked');
      await page.evaluate('host.freshReadOnly()');
      assert.equal(await value(), '7');
      assert.equal(
        await page.getByRole('button', { name: 'Increment', exact: true }).isDisabled(),
        true,
      );
      assert.equal((await page.evaluate('host.set(9)')).code, 'EditUnavailable');
      assert.equal(await value(), '7');
      const retired = await page.evaluate('host.retiredDrain()');
      assert.ok(retired.length > 0);
      assert.equal(retired[0].state, 'incomplete');
      assert.ok(retired[0].pending.some((id) => id.startsWith('save:')));
      const closed = await page.evaluate('host.close()');
      assert.equal(closed.report.state, 'drained');
      assert.equal(closed.subscriptions, 0);
      assert.deepEqual(closed.errors, []);
      assert.deepEqual(errors, []);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
      reports.push({
        kind,
        width,
        editorSha256: verification.editorSha256,
        state: 'PASS',
        checks: [
          'UI increment',
          'undo/redo',
          'noop preserves redo',
          'same nonUI entry',
          'acknowledged save/reload',
          'no-write',
          'indeterminate and SaveBusy',
          'revoke',
          'fresh readonly UI/nonUI refusal',
          'new scope drains; retired uncertain save remains explicitly incomplete',
          'no browser errors',
        ],
      });
      console.log('PASS', kind, width, 'same-tarball UI/nonUI authority/save/reopen/drain');
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
assert.equal(hashes[0], hashes[1], 'both Hosts use identical editor tarball');
await writeFile(path.join(directory, 'browser-results.json'), JSON.stringify(reports, null, 2));
