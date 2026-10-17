/* global sessionStorage, location, addEventListener, dispatchEvent, PageTransitionEvent */
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
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/away') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<h1>Away</h1>');
      return;
    }
    const name =
      pathname === '/' ? 'readonly.html' : pathname === '/readonly.js' ? 'readonly.js' : undefined;
    if (!name) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
  try {
    for (const domain of ['geo', 'video'])
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } }),
          errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.addInitScript(() =>
          addEventListener('pageshow', (event) => {
            const events = JSON.parse(sessionStorage.getItem('cache-events') ?? '[]');
            events.push({ persisted: event.persisted, url: location.href });
            sessionStorage.setItem('cache-events', JSON.stringify(events));
          }),
        );
        const origin = `http://127.0.0.1:${server.address().port}/`,
          url = origin + '?domain=' + domain + (domain === 'geo' ? '&fixture=points' : '');
        await page.goto(url);
        await page.waitForFunction('globalThis.ready');
        const before = await page.evaluate('host.inspect().generation');
        await page.goto(origin + 'away');
        await page.goBack({ waitUntil: 'commit' });
        await page.waitForFunction(
          (generation) =>
            globalThis.ready &&
            globalThis.host?.inspect().status === 'Ready' &&
            globalThis.host?.inspect().generation !== generation,
          before,
        );
        assert.ok((await page.locator('main').textContent()).length > 0);
        if (domain === 'geo') assert.equal(await page.locator('.geo-point-map svg').count(), 1);
        await page.evaluate('host.deny()');
        await page.goto(origin + 'away');
        await page.goBack({ waitUntil: 'commit' });
        await page.waitForFunction(
          "globalThis.ready && globalThis.host?.inspect().status?.includes('grant')",
        );
        assert.equal(await page.locator('main').textContent(), '');
        const events = await page.evaluate(() =>
            JSON.parse(sessionStorage.getItem('cache-events') ?? '[]'),
          ),
          actual = events.filter((event) => event.persisted && event.url === url).length;
        reports.push({
          kind,
          domain,
          width,
          case: 'actual-back-forward',
          result: actual >= 2 ? 'PASS' : 'NOT RUN',
          persistedRestorations: actual,
          events,
        });
        console.log(
          kind,
          domain,
          width,
          'actual BFCache',
          actual >= 2 ? 'PASS' : 'NOT RUN',
          actual,
        );
        const instance = await page.evaluate('host.inspect().instance');
        await page.evaluate(() => {
          dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
          dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        });
        await page.waitForFunction(
          (previous) => globalThis.ready && globalThis.host?.inspect().instance !== previous,
          instance,
        );
        await page.waitForFunction(
          "globalThis.ready && globalThis.host?.inspect().status?.includes('grant')",
        );
        assert.equal(await page.locator('main').textContent(), '');
        assert.deepEqual(errors, []);
        reports.push({ kind, domain, width, case: 'synthetic-denied-restore', result: 'PASS' });
        await page.close();
      }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
await writeFile(
  path.join(directory, 'readonly-cache-results.json'),
  JSON.stringify(reports, null, 2),
);
