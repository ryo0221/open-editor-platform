/* global document, innerWidth */
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
  const root = path.join(directory, kind),
    pins = JSON.parse(await readFile(path.join(root, 'editor-pin.json')));
  const server = createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    const name = route === '/' ? 'animation.html' : route.slice(1);
    if (!['animation.html', 'animation.js', 'animation.css'].includes(name)) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader(
      'Content-Type',
      name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    );
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390])
      for (const mode of ['applyInputs', 'flush'])
        for (const easing of ['hold', 'bezier']) {
          const page = await browser.newPage({ viewport: { width, height: 844 } }),
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
          try {
            await page.goto(origin);
            await page.waitForFunction('globalThis.ready');
            const inspect = () => page.evaluate('host.inspect()'),
              button = (name) => page.getByRole('button', { name, exact: true });
            assert.equal(
              await page.locator('code').textContent(),
              pins.packages['@editor-platform/animation'],
            );
            await expect(page.locator('.ae-key-marker').first()).toHaveCSS('position', 'absolute');
            await button('0 ticks · 80').click();
            const initial = await inspect();
            await page.getByLabel('Timeline zoom', { exact: true }).fill('2');
            assert.deepEqual(
              (await inspect()).view.snapshot.revision,
              initial.view.snapshot.revision,
            );
            assert.deepEqual(
              (await inspect()).view.snapshot.content,
              initial.view.snapshot.content,
            );
            assert.equal(
              await page
                .getByLabel('Scrollable timeline', { exact: true })
                .evaluate((e) => e.scrollWidth > e.clientWidth),
              true,
            );
            await page.evaluate((mode) => globalThis.host.armSynchronousFlush(mode), mode);
            await page.getByLabel('Easing', { exact: true }).selectOption(easing);
            const applied = await inspect();
            assert.equal(applied.synchronousFlushes, 1);
            assert.equal(applied.view.state, 'open');
            assert.equal(
              applied.view.snapshot.revision.sequence,
              initial.view.snapshot.revision.sequence + 1,
            );
            assert.equal(applied.inputs.dirty, 0);
            assert.equal(applied.inputs.composing, 0);
            const expected =
              easing === 'hold'
                ? { type: 'hold' }
                : { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
            assert.deepEqual(
              applied.view.snapshot.content.compositions[0].tracks[0].keys[0].easing,
              expected,
            );
            await button('Undo').click();
            assert.deepEqual(
              (await inspect()).view.snapshot.content,
              initial.view.snapshot.content,
            );
            await expect(page.getByLabel('Timeline zoom', { exact: true })).toHaveValue('2');
            await button('Redo').click();
            assert.deepEqual(
              (await inspect()).view.snapshot.content,
              applied.view.snapshot.content,
            );
            await expect(page.getByLabel('Timeline zoom', { exact: true })).toHaveValue('2');
            const beforeSave = await inspect();
            await button('Save through Host').click();
            await expect(page.getByRole('status')).toHaveText('Save: committed');
            assert.deepEqual(
              (await inspect()).view.snapshot.revision,
              beforeSave.view.snapshot.revision,
            );
            assert.deepEqual((await inspect()).errors, []);
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
            );
            await page.reload();
            await page.waitForFunction('globalThis.ready');
            const reopened = await inspect();
            assert.deepEqual(reopened.view.snapshot.content, applied.view.snapshot.content);
            assert.equal(reopened.view.snapshot.revision.sequence, 0);
            assert.notEqual(
              reopened.view.snapshot.revision.sessionId,
              beforeSave.view.snapshot.revision.sessionId,
            );
            assert.deepEqual(reopened.errors, []);
            assert.deepEqual(errors, []);
            assert.deepEqual(external, []);
            reports.push({
              kind,
              width,
              mode,
              easing,
              sourceCommit: pins.sourceCommit,
              result: 'PASS',
            });
            console.log(
              'PASS',
              kind,
              width,
              mode,
              easing,
              'actual Inputs synchronous subscriber / one commit / zoom / Undo+Redo / Save+fresh reopen',
            );
          } finally {
            await page.close();
          }
        }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
await writeFile(
  path.join(directory, 'animation-sync-input-results.json'),
  JSON.stringify(reports, null, 2),
);
