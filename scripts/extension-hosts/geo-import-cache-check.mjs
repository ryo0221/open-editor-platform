/* global sessionStorage, location, addEventListener */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]),
  reports = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const server = createServer(async (req, res) => {
    if (req.url === '/away') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<h1>Away</h1>');
      return;
    }
    const name =
      req.url === '/'
        ? 'geo-import.html'
        : req.url === '/geo-import.js'
          ? 'geo-import.js'
          : undefined;
    if (!name) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.addInitScript(() => {
        addEventListener('pageshow', (event) => {
          const events = JSON.parse(sessionStorage.getItem('geo-cache-events') ?? '[]');
          events.push({ persisted: event.persisted, url: location.href });
          sessionStorage.setItem('geo-cache-events', JSON.stringify(events));
        });
      });
      const url = `http://127.0.0.1:${server.address().port}/`;
      await page.goto(url);
      await page.waitForFunction('globalThis.ready');
      const state = () => page.evaluate('geoImportHost.state()');
      const button = (name) => page.getByRole('button', { name, exact: true });
      await page.getByLabel('Local file', { exact: true }).setInputFiles({
        name: 'point.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('lon,lat\n12,34'),
      });
      await page.getByLabel('First coordinate column', { exact: true }).fill('lon');
      await page.getByLabel('Second coordinate column', { exact: true }).fill('lat');
      await button('Preview import').click();
      await expect(button('Import previewed data')).toBeEnabled();
      await button('Import previewed data').click();
      await expect.poll(async () => (await state()).retained).toBe(1);
      for (const readonly of [false, true]) {
        const before = (await state()).view.snapshot.scope.generation;
        if (readonly) await page.evaluate('geoImportHost.revoke()');
        await page.goto(url + 'away');
        await page.goBack({ waitUntil: 'commit' });
        await expect
          .poll(async () => {
            try {
              const s = await state();
              return s.view.state === 'open' && s.view.snapshot.scope.generation !== before;
            } catch {
              return false;
            }
          })
          .toBe(true)
          .catch(async (error) => {
            console.log(
              'FAIL return evidence',
              JSON.stringify(
                await page.evaluate(() => ({
                  events: JSON.parse(sessionStorage.getItem('geo-cache-events') ?? '[]'),
                })),
              ),
            );
            throw error;
          });
        const s = await state();
        assert.equal(s.view.canEdit, !readonly);
        assert.equal(s.retained, 0);
        assert.equal(s.staged, 0);
        assert.equal(s.content.layers.length, 0);
        await expect(page.locator('main')).toContainText(
          'Original files and unsaved imports were cleared',
        );
        if (readonly) {
          await expect(page.locator('main')).toContainText('Import permission remains closed');
          await expect(page.getByLabel('Local file', { exact: true })).toHaveCount(0);
        } else await expect(page.getByLabel('Local file', { exact: true })).toBeEnabled();
      }
      const events = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem('geo-cache-events') ?? '[]'),
      );
      const actual = events.filter((e) => e.persisted && e.url === url).length;
      assert.ok(actual >= 2, `actual BFCache restoration required, got ${actual}`);
      assert.deepEqual(errors, []);
      reports.push({ kind, width, result: 'PASS', persistedRestorations: actual, events });
      console.log(
        'PASS',
        kind,
        width,
        'actual BFCache twice / fresh scope / originals cleared / reselect notice / readonly preserved',
      );
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
await writeFile(
  path.join(directory, 'geo-import-cache-results.json'),
  JSON.stringify(reports, null, 2),
);
