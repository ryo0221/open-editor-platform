/* global sessionStorage, location, addEventListener, dispatchEvent, PageTransitionEvent */
import { chromium, expect } from '@playwright/test';
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
    const name =
      req.url === '/'
        ? 'animation.html'
        : req.url === '/animation.js'
          ? 'animation.js'
          : req.url === '/animation.css'
            ? 'animation.css'
            : undefined;
    if (!name) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader(
      'Content-Type',
      name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    );
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
  try {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.addInitScript(() =>
      addEventListener('pageshow', (event) => {
        const events = JSON.parse(sessionStorage.getItem('cache-events') ?? '[]');
        events.push({ persisted: event.persisted, url: location.href });
        sessionStorage.setItem('cache-events', JSON.stringify(events));
      }),
    );
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    await page.waitForFunction('globalThis.ready');
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
    assert.equal((await page.evaluate('host.setX(123)')).state, 'applied');
    assert.equal((await page.evaluate('host.save()')).outcome.state, 'committed');
    for (const readOnly of [false, true]) {
      if (readOnly) {
        await page.evaluate('host.deny()');
        await page.evaluate('host.freshReadOnly()');
      }
      const before = await page.evaluate('host.inspect().view.snapshot.scope.generation');
      await page.goto(url + 'away');
      await page.goBack({ waitUntil: 'commit' });
      await page.waitForFunction(
        (generation) =>
          globalThis.ready &&
          globalThis.host?.inspect().view.state === 'open' &&
          globalThis.host?.inspect().view.snapshot.scope.generation !== generation,
        before,
      );
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      const state = await page.evaluate('host.inspect()');
      assert.equal(state.view.canEdit, !readOnly);
      assert.equal(state.view.snapshot.content.compositions[0].layers[0].transform.x, 123);
      if (readOnly) assert.equal((await page.evaluate('host.setX(999)')).code, 'EditUnavailable');
      else assert.equal((await page.evaluate('host.save()')).outcome.state, 'committed');
    }
    const events = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem('cache-events') ?? '[]'),
      ),
      actual = events.filter((event) => event.persisted && event.url === url).length;
    reports.push({
      kind,
      case: 'actual-back-forward',
      result: actual >= 2 ? 'PASS' : 'NOT RUN',
      persistedRestorations: actual,
      events,
    });
    console.log(kind, 'Animation actual BFCache', actual >= 2 ? 'PASS' : 'NOT RUN', actual);
    const before = await page.evaluate('host.inspect().view.snapshot.scope.generation');
    await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.waitForFunction(
      (generation) =>
        globalThis.ready &&
        globalThis.host?.inspect().view.state === 'open' &&
        globalThis.host?.inspect().view.snapshot.scope.generation !== generation,
      before,
    );
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
    assert.equal((await page.evaluate('host.inspect()')).view.canEdit, false);
    assert.equal((await page.evaluate('host.close()')).state, 'drained');
    assert.equal(await page.locator('main').textContent(), '');
    assert.deepEqual(errors, []);
    reports.push({ kind, case: 'synthetic-readonly-restore', result: 'PASS' });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
await writeFile(
  path.join(directory, 'animation-cache-results.json'),
  JSON.stringify(reports, null, 2),
);
