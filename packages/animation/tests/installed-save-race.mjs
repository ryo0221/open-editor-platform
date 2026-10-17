/* global URL, crypto, window */
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
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const name =
      pathname === '/' || pathname === '/animation.html'
        ? 'animation.html'
        : ['/animation.js', '/animation.css'].includes(pathname)
          ? pathname.slice(1)
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
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const errors = [];
      let pagesCreated = 0;
      const navigations = new Map();
      context.on('page', (page) => {
        pagesCreated++;
        navigations.set(page, 0);
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) navigations.set(page, navigations.get(page) + 1);
        });
        page.on('pageerror', (e) => errors.push(String(e)));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
      });
      const page = await context.newPage();
      const base = `http://127.0.0.1:${server.address().port}/animation.html`;
      const ready = (p) => p.waitForFunction('globalThis.ready');
      const inspect = (p) => p.evaluate('host.inspect()');
      const button = (p, name) => p.getByRole('button', { name, exact: true });
      const newButton = (p) => button(p, 'New empty Animation');
      const reopen = (p) => button(p, 'Reopen saved Animation');
      const notice = (p) => p.locator('[data-animation-artifact-notice]');
      const captureBoundary = async (p) => ({
        scope: (await inspect(p)).view.snapshot.scope,
        pagesCreated,
        navigations: navigations.get(p),
      });
      const unchangedBoundary = async (p, before) => {
        // Cross a rendering boundary: an unintended reload destroys this context
        // or changes the observed main-frame count/scope even if native bytes match.
        await p.evaluate(
          () =>
            new Promise((resolve) =>
              window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
            ),
        );
        assert.deepEqual(await captureBoundary(p), before);
      };
      const refuseBoth = async (p) => {
        const before = await captureBoundary(p);
        await newButton(p).dispatchEvent('click');
        await reopen(p).dispatchEvent('click');
        await unchangedBoundary(p, before);
      };
      const save = async (p) => {
        await button(p, 'Save through Host').click();
        await expect(p.getByRole('status')).toHaveText('Save: committed');
        await expect(newButton(p)).toBeEnabled();
      };
      await page.goto(base);
      await ready(page);
      await save(page);
      const original = (await inspect(page)).view.snapshot;
      const race = await page.evaluate(async () => {
        const host = globalThis.host;
        const a = host.inspect().view.snapshot.content.compositions[0].layers[0].transform.x;
        host.setX(a + 17);
        const b = host.inspect().view.snapshot;
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        let entered = false;
        // Hold hashing after Save captured B, before either real storage write.
        crypto.subtle.digest = async (...args) => {
          entered = true;
          await gate;
          return digest(...args);
        };
        const pending = host.save();
        const saving = host.inspect().view.saving;
        const edit = host.setX(a);
        const current = host.inspect().view.snapshot;
        release();
        const outcome = await pending;
        crypto.subtle.digest = digest;
        return { entered, saving, edit, b, current, outcome };
      });
      assert.equal(race.entered, true);
      assert.equal(race.saving, true);
      assert.equal(race.edit.state, 'applied');
      assert.equal(race.outcome.outcome.state, 'committed');
      assert.deepEqual(race.current.content, original.content);
      assert.notDeepEqual(race.current.revision, race.b.revision);
      const storedPage = await context.newPage();
      await storedPage.goto(base);
      await ready(storedPage);
      assert.deepEqual((await inspect(storedPage)).view.snapshot.content, race.b.content);
      await storedPage.close();
      const guarded = (await newButton(page).isDisabled()) && (await reopen(page).isDisabled());
      if (guarded) {
        await expect(notice(page)).toContainText('Save changes');
        await refuseBoth(page);
        assert.deepEqual((await inspect(page)).view.snapshot, race.current);
        assert.equal(context.pages().length, 1);
        // A new exact-current receipt can restore clean status; ordinary reopen stays valid.
        await save(page);
        await reopen(page).click();
        await ready(page);
        const resumed = (await inspect(page)).view.snapshot;
        assert.deepEqual(resumed.content, original.content);
        assert.notEqual(resumed.scope.sessionId, original.scope.sessionId);
        assert.equal(resumed.revision.sequence, 0);
        await expect(newButton(page)).toBeEnabled();
      } else {
        await reopen(page).click();
        await ready(page);
        assert.deepEqual((await inspect(page)).view.snapshot.content, race.b.content);
      }
      assert.deepEqual(errors, []);
      reports.push({
        kind,
        width,
        result: guarded ? 'PASS' : 'FAIL',
        capturedRevision: race.b.revision,
        currentRevision: race.current.revision,
        persistedB: true,
        guarded,
        replacedAWithB: !guarded,
      });
      console.log(
        guarded ? 'PASS' : 'FAIL',
        kind,
        width,
        'captured B / live A save completion guards',
      );
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
await writeFile(
  path.join(directory, 'animation-save-race-results.json'),
  JSON.stringify(reports, null, 2),
);

assert.ok(
  reports.every((report) => report.result === 'PASS'),
  'stale save baseline must refuse New/Reopen',
);
