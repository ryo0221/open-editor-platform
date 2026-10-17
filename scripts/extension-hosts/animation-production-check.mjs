/* global document, innerWidth */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3] ?? '/tmp/animation-production-check');
await mkdir(evidence, { recursive: true });
const reports = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const pins = JSON.parse(await readFile(path.join(root, 'editor-pin.json')));
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const errors = [],
        external = [];
      const origin = `http://127.0.0.1:${server.address().port}`;
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== origin) {
          external.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      let page;
      const open = async () => {
        page = await context.newPage();
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(origin);
        await page.waitForFunction('globalThis.ready');
        await expect(button('Play')).toBeEnabled();
        assert.equal(
          await page.locator('code').textContent(),
          pins.packages['@editor-platform/animation'],
        );
      };
      const button = (name) => page.getByRole('button', { name, exact: true });
      const field = (name) => page.getByLabel(name, { exact: true });
      const inspect = () => page.evaluate('host.inspect()');
      const content = async () => (await inspect()).view.snapshot.content;
      const revision = async () => (await inspect()).view.snapshot.revision.sequence;
      const commit = async (action) => {
        const before = await revision();
        await action();
        assert.equal(await revision(), before + 1, 'one operation = one history entry');
      };
      try {
        await open();
        const initial = await content();
        await commit(() => button('Add rectangle').click());
        const layers = (await content()).compositions[0].layers;
        const created = layers.at(-1).id;
        await expect(button(`rect ${created}`)).toHaveAttribute('aria-pressed', 'true');
        await field('Base x').fill('40');
        await field('Base y').fill('70');
        await commit(() => button('Apply inputs').click());
        assert.deepEqual(
          (await content()).compositions[0].layers.slice(0, 2),
          initial.compositions[0].layers,
        );
        await commit(() => button('Add key at playhead (base value)').click());
        await expect(field('Key tick')).toHaveValue('0');
        await field('Easing').selectOption('hold');
        await commit(() => button('Apply inputs').click());
        for (const [tick, value] of [
          [480000, 280],
          [960000, 480],
        ]) {
          await field('Seek').fill(String(tick));
          await commit(() => button('Add key at playhead (base value)').click());
          await expect(field('Key tick')).toHaveValue(String(tick));
          await field('Key value').fill(String(value));
          await commit(() => button('Apply inputs').click());
        }
        await button('480000 ticks · 280').click();
        await field('Easing').selectOption('bezier');
        await field('Bezier x1').fill('0.25');
        await field('Bezier y1').fill('0.1');
        await commit(() => button('Apply inputs').click());
        const beforeMove = await content();
        const key = button('480000 ticks · 280');
        await key.focus();
        await key.press('Shift+ArrowLeft');
        assert.deepEqual(await content(), beforeMove);
        assert.equal((await page.evaluate('host.save()')).state, 'refused');
        await commit(() => key.press('Enter'));
        const afterMove = await content();
        assert.equal(
          afterMove.compositions[0].tracks.find((track) => track.layerId === created).keys[1].tick,
          472000,
        );
        await commit(() => button('Undo').click());
        assert.deepEqual(await content(), beforeMove);
        await commit(() => button('Redo').click());
        assert.deepEqual(await content(), afterMove);
        await field('Property').selectOption('y');
        for (const [tick, value] of [
          [0, 70],
          [960000, 230],
        ]) {
          await field('Seek').fill(String(tick));
          await commit(() => button('Add key at playhead (base value)').click());
          if (value !== 70) {
            await field('Key value').fill(String(value));
            await commit(() => button('Apply inputs').click());
          }
        }
        const completed = await content();
        const tracks = completed.compositions[0].tracks.filter(
          (track) => track.layerId === created,
        );
        assert.equal(tracks.length, 2);
        assert.deepEqual(
          tracks.find((track) => track.property === 'x').keys.map((key) => [key.tick, key.value]),
          [
            [0, 40],
            [472000, 280],
            [960000, 480],
          ],
        );
        assert.deepEqual(
          tracks.find((track) => track.property === 'y').keys.map((key) => [key.tick, key.value]),
          [
            [0, 70],
            [960000, 230],
          ],
        );
        assert.deepEqual(completed.compositions[0].tracks[0], initial.compositions[0].tracks[0]);
        await field('Seek').fill('240000');
        await expect(page.locator('svg rect').nth(2)).toHaveAttribute(
          'transform',
          'matrix(1 0 0 1 40 110)',
        );
        const presentationRevision = await revision();
        await button('Play').click();
        await expect.poll(async () => (await inspect()).playback.tick).toBeGreaterThan(240000);
        await button('Pause').click();
        assert.equal((await inspect()).playback.playing, false);
        assert.equal(await revision(), presentationRevision);
        assert.deepEqual(await content(), completed);
        await field('Seek').fill('240000');
        await page.screenshot({
          path: path.join(evidence, `${kind}-${width}-created.png`),
          fullPage: true,
        });
        const oldScope = (await inspect()).view.snapshot.scope;
        await button('Save through Host').click();
        await expect(page.getByRole('status')).toHaveText('Save: committed');
        assert.equal(await revision(), presentationRevision);
        await page.close();
        await open();
        assert.deepEqual(await content(), completed);
        assert.equal(await revision(), 0);
        assert.notEqual((await inspect()).view.snapshot.scope.sessionId, oldScope.sessionId);
        await button(`rect ${created}`).click();
        await field('Property').selectOption('x');
        await button('472000 ticks · 280').click();
        await expect(field('Bezier x1')).toHaveValue('0.25');
        await expect(field('Bezier y1')).toHaveValue('0.1');
        await field('Seek').fill('240000');
        await expect(page.locator('svg rect').nth(2)).toHaveAttribute(
          'transform',
          'matrix(1 0 0 1 40 110)',
        );
        assert.equal((await inspect()).inputs.dirty, 0);
        assert.deepEqual((await inspect()).errors, []);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({
          path: path.join(evidence, `${kind}-${width}-reopened.png`),
          fullPage: true,
        });
        reports.push({
          kind,
          width,
          result: 'PASS',
          sourceCommit: pins.sourceCommit,
          animationSha256: pins.packages['@editor-platform/animation'],
          createdLayer: created,
          finalRevision: presentationRevision,
          createdTracks: 2,
          createdKeys: 5,
          errors,
          external,
        });
        console.log(JSON.stringify(reports.at(-1)));
      } catch (error) {
        await page?.screenshot({
          path: path.join(evidence, `${kind}-${width}-failure.png`),
          fullPage: true,
        });
        throw error;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
assert.equal(new Set(reports.map((report) => report.sourceCommit)).size, 1);
assert.equal(new Set(reports.map((report) => report.animationSha256)).size, 1);
await writeFile(path.join(evidence, 'results.json'), JSON.stringify(reports, null, 2));
