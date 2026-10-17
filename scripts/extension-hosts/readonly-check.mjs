/* global document, window */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]),
  reports = [];
const pins = {};
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  pins[kind] = JSON.parse(await readFile(path.join(root, 'editor-pin.json'))).packages;
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    const file =
      name === '/' ? 'readonly.html' : name === '/readonly.js' ? 'readonly.js' : undefined;
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
    for (const domain of ['geo', 'video'])
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } }),
          errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/?domain=${domain}`);
        await page.waitForFunction('globalThis.ready');
        assert.equal(await page.getByRole('status').last().textContent(), 'Ready');
        const body = await page.locator('main').textContent();
        assert.match(body, domain === 'geo' ? /site-1/ : /native-video/);
        const name = '@editor-platform/' + (domain === 'geo' ? 'geo-inspector' : 'video-metadata');
        assert.equal(await page.locator('code').textContent(), pins[kind][name]);
        assert.equal(await page.locator('main input,main textarea').count(), 0);
        await page.screenshot({ path: path.join(root, `${domain}-${width}.png`), fullPage: true });
        assert.equal((await page.evaluate('host.deny()')).state, 'drained');
        assert.equal(await page.locator('main').textContent(), '');
        await page.evaluate('host.fresh()');
        assert.equal(await page.getByRole('status').last().textContent(), 'Ready');
        await page.evaluate('host.change()');
        assert.match(
          await page.locator('main').textContent(),
          domain === 'geo' ? /Changed sites/ : /changed-video/,
        );
        await page.evaluate('host.invalid()');
        assert.match(await page.getByRole('status').last().textContent(), /InvalidContent/);
        assert.equal(await page.locator('main').textContent(), '');
        await page.evaluate('host.oversized()');
        assert.match(await page.getByRole('status').last().textContent(), /DataLimit/);
        assert.equal(await page.locator('main').textContent(), '');
        await page.evaluate('host.fresh()');
        assert.equal((await page.evaluate('host.close()')).state, 'drained');
        assert.deepEqual(errors, []);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        );
        reports.push({ kind, domain, width, sha256: pins[kind][name], result: 'PASS' });
        console.log(
          'PASS',
          kind,
          domain,
          width,
          'verified bytes, native readonly mount, admission diagnostics, Basic limit, revoke/fresh/drain',
        );
        await page.close();
      }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
for (const name of ['@editor-platform/geo-inspector', '@editor-platform/video-metadata'])
  assert.equal(pins.reference[name], pins.independent[name]);
await writeFile(path.join(directory, 'readonly-results.json'), JSON.stringify(reports, null, 2));
