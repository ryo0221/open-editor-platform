/* global sessionStorage, location, addEventListener, dispatchEvent, PageTransitionEvent */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
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
    if (req.url === '/away') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<h1>Away</h1>');
      return;
    }
    const name = req.url === '/' ? 'index.html' : req.url === '/main.js' ? 'main.js' : undefined;
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
    const page = await browser.newPage(),
      errors = [],
      notUsed = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    cdp.on('Page.backForwardCacheNotUsed', (event) => notUsed.push(event));
    await page.addInitScript(() => {
      addEventListener('pageshow', (event) => {
        const events = JSON.parse(sessionStorage.getItem('cache-events') ?? '[]');
        events.push({ persisted: event.persisted, url: location.href });
        sessionStorage.setItem('cache-events', JSON.stringify(events));
      });
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    await page.waitForFunction('globalThis.ready');
    assert.equal((await page.evaluate('host.set(7)')).state, 'applied');
    assert.equal((await page.evaluate('host.save()')).outcome.state, 'committed');
    for (const readOnly of [false, true]) {
      if (readOnly) {
        await page.evaluate('host.deny();host.freshReadOnly()');
      }
      const before = await page.evaluate('host.snapshot().snapshot.scope.generation');
      await page.goto(url + 'away');
      await page.goBack({ waitUntil: 'commit' });
      await page.waitForFunction((generation) => {
        const snapshot = globalThis.host?.snapshot();
        return (
          globalThis.ready &&
          snapshot?.state === 'open' &&
          snapshot.snapshot.scope.generation !== generation
        );
      }, before);
      const restored = await page.evaluate('host.snapshot()');
      assert.equal(restored.snapshot.content.value, 7);
      assert.equal(restored.canEdit, !readOnly);
      if (readOnly) assert.equal((await page.evaluate('host.set(9)')).code, 'EditUnavailable');
      else assert.equal((await page.evaluate('host.save()')).outcome.state, 'committed'); // Reopened IDB is usable.
    }
    const events = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('cache-events') ?? '[]'),
    );
    const actual = events.filter((event) => event.persisted && event.url === url).length;
    reports.push({
      kind,
      case: 'actual-back-forward',
      result: actual >= 2 ? 'PASS' : 'NOT RUN',
      persistedRestorations: actual,
      events,
      notUsed,
    });
    console.log(kind, 'actual BFCache', actual >= 2 ? 'PASS' : 'NOT RUN', actual);
    const before = await page.evaluate('host.snapshot().snapshot.scope.generation');
    await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.waitForFunction((generation) => {
      const snapshot = globalThis.host?.snapshot();
      return (
        globalThis.ready &&
        snapshot?.state === 'open' &&
        snapshot.snapshot.scope.generation !== generation
      );
    }, before);
    assert.equal((await page.evaluate('host.snapshot()')).canEdit, false);
    assert.equal(await page.getByLabel('Counter value').textContent(), '7');
    assert.deepEqual(errors, []);
    reports.push({
      kind,
      case: 'synthetic-persisted-lifecycle',
      result: 'PASS',
      readOnlyPreserved: true,
    });
    console.log(kind, 'synthetic lifecycle PASS (separate evidence)');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
await writeFile(path.join(directory, 'bfcache-results.json'), JSON.stringify(reports, null, 2));
