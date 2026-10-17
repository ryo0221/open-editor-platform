/* global document, innerWidth */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { URL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3] ?? '/tmp/animation-bezier-check');
const emptyEmbedding = process.argv[4] === 'empty-embedding';
await mkdir(evidence, { recursive: true });
const results = [];
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
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        recordVideo: { dir: path.join(evidence, 'videos'), size: { width, height: 844 } },
      });
      const page = await context.newPage(),
        errors = [],
        external = [];
      const origin = `http://127.0.0.1:${server.address().port}`;
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== origin) {
          external.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      const button = (name) => page.getByRole('button', { name, exact: true });
      const field = (name) => page.getByLabel(name, { exact: true });
      const inspect = () => page.evaluate('host.inspect()');
      const content = async () => (await inspect()).view.snapshot.content;
      try {
        await page.goto(origin);
        await page.waitForFunction('globalThis.ready');
        await expect(button('Play')).toBeEnabled();
        assert.equal(
          await page.locator('code').textContent(),
          pins.packages['@editor-platform/animation'],
        );
        const initial = await content();
        if (emptyEmbedding) {
          assert.deepEqual(initial.compositions[0].layers, []);
          assert.deepEqual(initial.compositions[0].tracks, []);
          assert.equal(await page.locator('svg rect').count(), 0);
          await page.screenshot({
            path: path.join(evidence, `${kind}-${width}-empty.png`),
            fullPage: true,
          });
        }
        await button('Add rectangle').click();
        const created = (await content()).compositions[0].layers.at(-1).id;
        await expect(button(`rect ${created}`)).toHaveAttribute('aria-pressed', 'true');
        await field('Base x').fill('40');
        await field('Base y').fill('70');
        await button('Apply inputs').click();
        await button('Add key at playhead (base value)').click();
        await field('Easing').selectOption('bezier');
        // x(t)=t, y(t)=t^3: an independent closed-form oracle, not the evaluator under test.
        for (const [name, value] of [
          ['x1', 1 / 3],
          ['y1', 0],
          ['x2', 2 / 3],
          ['y2', 0],
        ])
          await field(`Bezier ${name}`).fill(String(value));
        await button('Apply inputs').click();
        await field('Seek').fill('960000');
        await button('Add key at playhead (base value)').click();
        await field('Key value').fill('440');
        await button('Apply inputs').click();
        const saved = await content();
        assert.deepEqual(saved.compositions[0].layers.slice(0, -1), initial.compositions[0].layers);
        const track = saved.compositions[0].tracks.find((track) => track.layerId === created);
        assert.deepEqual(
          track.keys.map((key) => [key.tick, key.value]),
          [
            [0, 40],
            [960000, 440],
          ],
        );
        assert.deepEqual(track.keys[0].easing, {
          type: 'bezier',
          x1: 1 / 3,
          y1: 0,
          x2: 2 / 3,
          y2: 0,
        });
        const samples = [];
        const sample = async (stage) => {
          for (const fraction of [0.25, 0.5, 0.75]) {
            await field('Seek').fill(String(960000 * fraction));
            const expectedX = 40 + 400 * fraction ** 3;
            await expect
              .poll(async () => {
                const transform = await page.locator('svg rect').last().getAttribute('transform');
                return Number(transform.match(/^matrix\(([^)]+)\)$/)[1].split(/[,\s]+/)[4]);
              })
              .toBeCloseTo(expectedX, 3);
            const transform = await page.locator('svg rect').last().getAttribute('transform');
            const components = transform
              .match(/^matrix\(([^)]+)\)$/)[1]
              .split(/[,\s]+/)
              .map(Number);
            assert.equal(components[5], 70);
            samples.push({ stage, fraction, expectedX, actualX: components[4] });
          }
        };
        await sample('before-save');
        await button('Undo').click();
        assert.equal(
          (await content()).compositions[0].tracks.find((track) => track.layerId === created)
            .keys[1].value,
          40,
        );
        await button('Redo').click();
        assert.deepEqual(await content(), saved);
        const prior = (await inspect()).view.snapshot;
        await button('Save through Host').click();
        await expect(page.getByRole('status')).toHaveText('Save: committed');
        assert.deepEqual((await inspect()).view.snapshot.revision, prior.revision);
        await page.reload();
        await page.waitForFunction('globalThis.ready');
        await expect(button('Play')).toBeEnabled();
        assert.deepEqual(await content(), saved);
        assert.notEqual((await inspect()).view.snapshot.scope.sessionId, prior.scope.sessionId);
        assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
        await button(`rect ${created}`).click();
        await button('0 ticks · 40').click();
        await sample('after-reopen');
        await page.screenshot({
          path: path.join(evidence, `${kind}-${width}-bezier.png`),
          fullPage: true,
        });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        assert.deepEqual((await inspect()).errors, []);
        results.push({
          kind,
          width,
          mode: emptyEmbedding ? 'public-embedding-empty-fixture' : 'unmodified-installed-host',
          sourceCommit: pins.sourceCommit,
          animationSha256: pins.packages['@editor-platform/animation'],
          result: 'PASS',
          samples,
        });
        console.log(JSON.stringify(results.at(-1)));
      } finally {
        const video = page.video();
        await context.close();
        await video.saveAs(path.join(evidence, `${kind}-${width}-actual-ui.webm`));
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
await writeFile(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
