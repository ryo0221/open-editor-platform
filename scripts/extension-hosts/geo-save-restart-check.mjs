import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]),
  reports = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind),
    profile = await mkdtemp(path.join(root, 'geo-save-profile-'));
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
  const origin = `http://127.0.0.1:${server.address().port}`,
    errors = [],
    external = [];
  let context;
  const start = async () => {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: '/usr/bin/chromium',
      viewport: { width: 390, height: 844 },
    });
    const page = context.pages()[0];
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
    return page;
  };
  try {
    let page = await start();
    assert.equal((await page.evaluate("host.nonUI('12.25', '34.25', '42')")).state, 'applied');
    assert.equal((await page.evaluate('host.save()')).outcome.state, 'committed');
    const before = await page.evaluate('host.state()'),
      raw = await page.evaluate('host.raw()');
    await context.close();
    context = undefined;
    // New browser process, same existing local adapter/profile and exact same origin.
    page = await start();
    const restored = await page.evaluate('host.state()');
    assert.deepEqual(restored.content, before.content);
    assert.equal(restored.hash, before.hash);
    assert.equal(restored.revision.sequence, 0);
    assert.notEqual(restored.revision.sessionId, before.revision.sessionId);
    assert.equal(restored.canUndo, false);
    assert.equal(restored.canRedo, false);
    assert.equal(await page.evaluate('host.raw()'), raw);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    reports.push({ kind, result: 'PASS', profile, contentHash: restored.hash });
    console.log(
      'PASS',
      kind,
      'actual browser process restart preserves acknowledged whole native, fresh history, record bytes',
    );
  } finally {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
await writeFile(
  path.join(directory, 'geo-save-restart-results.json'),
  JSON.stringify(reports, null, 2),
);
