/* global document, window, URL, Storage, IDBObjectStore, Event */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]),
  reports = [];
const evidence = await mkdtemp(path.join(tmpdir(), 'animation-new-artifact-'));
console.log('Evidence directory:', evidence);
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const pins = JSON.parse(await readFile(path.join(root, 'editor-pin.json')));
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
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', slowMo: 100 });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        recordVideo: { dir: path.join(evidence, 'raw'), size: { width, height: 844 } },
      });
      const videos = [];
      const errors = [];
      let pagesCreated = 0;
      const navigations = new Map();
      context.on('page', (page) => {
        pagesCreated++;
        videos.push(page.video());
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
      await expect(newButton(page)).toBeEnabled();
      await expect(reopen(page)).toBeDisabled();
      await save(page);
      const original = (await inspect(page)).view.snapshot;
      const opened = context.waitForEvent('page');
      await newButton(page).click();
      const fresh = await opened;
      await ready(fresh);
      assert.equal(await fresh.evaluate('window.opener'), null);
      const empty = (await inspect(fresh)).view.snapshot;
      assert.notEqual(empty.scope.artifactId, original.scope.artifactId);
      assert.notEqual(empty.scope.sessionId, original.scope.sessionId);
      assert.deepEqual(empty.content.compositions[0].layers, []);
      assert.deepEqual(empty.content.compositions[0].tracks, []);
      assert.deepEqual((await inspect(page)).view.snapshot, original);
      assert.equal(new URL(fresh.url()).searchParams.get('artifact').length, 36);
      await button(fresh, 'Add rectangle').click();
      await expect(newButton(fresh)).toBeDisabled();
      await button(fresh, 'Undo').click();
      await expect(newButton(fresh)).toBeEnabled();
      await button(fresh, 'Redo').click();
      await expect(newButton(fresh)).toBeDisabled();
      // Saving is synchronous at entry, even when the adapter settles immediately.
      const savingBoundary = await captureBoundary(fresh);
      const savingGuard = await fresh.evaluate(() => {
        const find = (name) =>
          [...document.querySelectorAll('button')].find((b) => b.textContent === name);
        find('Save through Host').click();
        const saving = globalThis.host.inspect().view.saving;
        find('New empty Animation').dispatchEvent(new Event('click'));
        find('Reopen saved Animation').dispatchEvent(new Event('click'));
        return {
          saving,
          message: document.querySelector('[data-animation-artifact-notice]').textContent,
        };
      });
      assert.equal(savingGuard.saving, true);
      assert.match(savingGuard.message, /current save/);
      await expect(fresh.getByRole('status')).toHaveText('Save: committed');
      await expect(newButton(fresh)).toBeEnabled();
      await unchangedBoundary(fresh, savingBoundary);
      const canonical = (await inspect(fresh)).view.snapshot;
      const y = fresh.getByLabel('Base y', { exact: true });
      await y.fill('-');
      await expect(newButton(fresh)).toBeDisabled();
      await expect(reopen(fresh)).toBeDisabled();
      await expect(notice(fresh)).toContainText('pending inputs');
      // Programmatic dispatch bypasses disabled presentation; action boundary must still refuse.
      await refuseBoth(fresh);
      assert.deepEqual((await inspect(fresh)).view.snapshot, canonical);
      await expect(y).toHaveValue('-');
      await button(fresh, 'Cancel inputs').click();
      await expect(newButton(fresh)).toBeEnabled();
      await y.dispatchEvent('compositionstart');
      await expect(newButton(fresh)).toBeDisabled();
      await expect(notice(fresh)).toContainText('composition');
      await refuseBoth(fresh);
      await y.dispatchEvent('compositionend');
      await expect(newButton(fresh)).toBeEnabled();
      await button(fresh, 'Add key at playhead (base value)').click();
      await fresh.getByLabel('Seek', { exact: true }).fill('720000');
      await button(fresh, 'Add key at playhead (base value)').click();
      await fresh.getByLabel('Key value', { exact: true }).fill('460');
      await button(fresh, 'Apply inputs').click();
      await fresh.getByLabel('Seek', { exact: true }).fill('720000');
      await expect(fresh.locator('svg rect').last()).toHaveAttribute('transform', /460/);
      await fresh.getByLabel('Seek', { exact: true }).fill('360000');
      await expect(fresh.locator('svg rect').last()).toHaveAttribute(
        'transform',
        'matrix(1 0 0 1 270 140)',
      );
      await fresh.getByLabel('Seek', { exact: true }).fill('0');
      const rev = (await inspect(fresh)).view.snapshot.revision;
      await button(fresh, 'Play').click();
      await fresh.waitForFunction('host.inspect().playback.tick > 0');
      await button(fresh, 'Pause').click();
      assert.deepEqual((await inspect(fresh)).view.snapshot.revision, rev);
      await save(fresh);
      const saved = (await inspect(fresh)).view.snapshot;
      const url = fresh.url();
      await reopen(fresh).click();
      await ready(fresh);
      const resumed = (await inspect(fresh)).view.snapshot;
      assert.equal(fresh.url(), url);
      assert.equal(resumed.scope.artifactId, saved.scope.artifactId);
      assert.deepEqual(resumed.content, saved.content);
      assert.equal(resumed.revision.sequence, 0);
      await fresh.getByLabel('Seek', { exact: true }).fill('360000');
      await expect(fresh.locator('svg rect').last()).toHaveAttribute(
        'transform',
        'matrix(1 0 0 1 270 140)',
      );
      await page.reload();
      await ready(page);
      assert.deepEqual((await inspect(page)).view.snapshot.content, original.content);
      await fresh.evaluate(() => {
        globalThis.popupOpenCalls = 0;
        window.open = () => {
          globalThis.popupOpenCalls++;
          return null;
        };
      });
      await newButton(fresh).click();
      await expect(notice(fresh)).toContainText('Allow a new tab');
      assert.equal(await fresh.evaluate('globalThis.popupOpenCalls'), 1);
      assert.deepEqual((await inspect(fresh)).view.snapshot, resumed);
      await fresh.screenshot({
        path: path.join(evidence, `${kind}-new-artifact-${width}.png`),
        fullPage: true,
      });
      assert.ok(
        await fresh.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
      // Storage-boundary exception, not a physical-quota or durability claim.
      await fresh.evaluate((kind) => {
        if (kind === 'reference')
          Storage.prototype.setItem = () => {
            throw Error('injected storage exception');
          };
        else
          IDBObjectStore.prototype.put = () => {
            throw Error('injected storage exception');
          };
      }, kind);
      await button(fresh, 'Save through Host').click();
      await expect(notice(fresh)).toContainText('Save result is unknown');
      const popupCallsBeforeRefusal = await fresh.evaluate('globalThis.popupOpenCalls');
      await expect(newButton(fresh)).toBeDisabled();
      await expect(reopen(fresh)).toBeDisabled();
      await refuseBoth(fresh);
      assert.equal(
        await fresh.evaluate('globalThis.popupOpenCalls'),
        popupCallsBeforeRefusal,
        'indeterminate guard must not invoke window.open, even when popups are blocked',
      );
      assert.equal(fresh.url(), url);
      assert.deepEqual((await inspect(fresh)).view.snapshot.content, saved.content);
      const bad = await context.newPage();
      await bad.goto(base + '?artifact=invalid');
      await expect(bad.locator('main')).toContainText('Invalid Animation artifact URL');
      assert.equal(await bad.evaluate('globalThis.ready'), undefined);
      await bad.goto(
        base + '?artifact=' + new URL(url).searchParams.get('artifact') + '&artifact=duplicate',
      );
      await expect(bad.locator('main')).toContainText('Invalid Animation artifact URL');
      await page.evaluate('host.deny()');
      await expect(newButton(page)).toBeDisabled();
      await expect(reopen(page)).toBeDisabled();
      await expect(notice(page)).toContainText('unavailable or read-only');
      assert.deepEqual(errors, []);
      const videoPath = path.join(evidence, `${kind}-${width}-new-popup-ui.webm`);
      const freshVideo = fresh.video();
      await context.close();
      await freshVideo.saveAs(videoPath);
      for (const video of videos) await video.delete();
      reports.push({
        kind,
        width,
        result: 'PASS',
        sourceCommit: pins.sourceCommit,
        animationSha256: pins.packages['@editor-platform/animation'],
        videoPath,
        popupCallsBeforeRefusal,
        intermediatePlayer: { tick: 360000, x: 270, y: 140 },
        originalScope: original.scope,
        newScope: saved.scope,
        reopenedScope: resumed.scope,
      });
      console.log(
        'PASS',
        kind,
        width,
        'New empty → author → Player → Save/reopen; guards and isolation',
      );
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
await writeFile(
  path.join(evidence, 'animation-new-artifact-results.json'),
  JSON.stringify(reports, null, 2),
);
