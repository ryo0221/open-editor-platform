import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]),
  media = path.resolve(process.argv[3]),
  reports = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind),
    pins = JSON.parse(await readFile(path.join(root, 'editor-pin.json')));
  const server = createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      const name = route === '/' ? 'media-demo.html' : route.slice(1);
      if (!/^[a-z0-9.-]+$/.test(name)) throw Error('route');
      const file = path.join(root, 'dist', name);
      res.setHeader(
        'Content-Type',
        name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
      );
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        errors = [],
        external = [];
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
      const state = () => page.evaluate('mediaHost.state()'),
        button = (name) => page.getByRole('button', { name, exact: true });
      await page
        .getByLabel('Animation and GIS recordings')
        .setInputFiles(
          ['animation', 'geo'].map((d) =>
            path.join(media, `editor-platform-${d}-reference-b18369f2.mp4`),
          ),
        );
      await button('Load recordings').click();
      await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(0);
      assert.equal(
        await page.locator('code').textContent(),
        pins.packages['@editor-platform/video-metadata'],
      );
      const initial = (await state()).view.snapshot.content;
      assert.equal(initial.sources.length, 2);
      assert.ok(!JSON.stringify(initial).includes('blob:'));
      assert.equal((await state()).view.canSave, false);
      await button('Reverse clip order').click();
      await expect.poll(async () => (await state()).lastFrame?.sourceId).toBe('recording-geo');
      assert.equal((await state()).view.snapshot.revision.sequence, 1);
      await button('Undo').click();
      await expect
        .poll(async () => (await state()).lastFrame?.sourceId)
        .toBe('recording-animation');
      assert.deepEqual((await state()).view.snapshot.content, initial);
      const noOp = await page.evaluate(
        'mediaHost.order(["clip-recording-animation","clip-recording-geo"])',
      );
      assert.notEqual(noOp.state, 'refused');
      assert.equal((await state()).canRedo, true);
      await button('Redo').click();
      await expect.poll(async () => (await state()).lastFrame?.sourceId).toBe('recording-geo');
      await button('Undo').click();
      await expect
        .poll(async () => (await state()).lastFrame?.sourceId)
        .toBe('recording-animation');
      await page.getByLabel('Preview sequence frame').fill('125');
      await button('Seek preview').click();
      await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(5);
      const beforePlay = (await state()).rendered;
      await button('Play preview').click();
      await expect.poll(async () => (await state()).playing).toBe(true);
      await expect
        // lastFrame is deliberately cleared during every detached preparation.
        // Observe completed presentations, then inspect PTS after edit intent pauses playback.
        .poll(async () => (await state()).rendered)
        .toBeGreaterThan(beforePlay + 2)
        .catch(async (error) => {
          console.error(
            'PLAY FAILURE',
            await state(),
            await page.getByRole('status', { name: 'Host media preview' }).textContent(),
          );
          throw error;
        });
      await page.getByLabel('Trim start (rational seconds)', { exact: true }).fill('1');
      await expect.poll(async () => (await state()).playing).toBe(false);
      await expect
        .poll(async () => (await state()).lastFrame?.decodedSeconds ?? 0)
        .toBeGreaterThan(5);
      await button('Apply independent trim').click();
      await expect
        .poll(async () => (await state()).view.snapshot.content.sequence.clips[0].sourceIn.value)
        .toBe(1);
      await page.getByLabel('Split at sequence frame', { exact: true }).fill('250');
      await button('Split linked clips').click();
      assert.equal((await state()).view.snapshot.content.sequence.clips.length, 3);
      await page.evaluate('mediaHost.seek(300)');
      assert.equal((await state()).lastFrame.decodedSeconds, 12);
      await button('Undo').click();
      assert.equal((await state()).view.snapshot.content.sequence.clips.length, 2);
      await button('Undo').click();
      assert.deepEqual((await state()).view.snapshot.content, initial);
      const race = await page.evaluate(async () => {
        const old = globalThis.mediaHost.seek(25);
        const fresh = globalThis.mediaHost.seek(500);
        return [await old, await fresh];
      });
      assert.equal(race[0], 'superseded');
      assert.equal(race[1], 'frame');
      assert.equal((await state()).lastFrame.decodedSeconds, 20);
      assert.equal((await state()).prepared, (await state()).released);
      await page.screenshot({ path: path.join(root, `real-media-${width}.png`), fullPage: true });
      // A valid native sub-frame source window cannot be relabeled as its preceding decoded frame.
      assert.match(
        await page.evaluate(
          'mediaHost.probeWindow({value:1,timescale:100},{value:2,timescale:100},{value:15,timescale:1000}).then(()=>"unexpected",e=>String(e))',
        ),
        /MediaFrameOutsideWindow/,
      );
      const closed = await page.evaluate(async () => {
        const pending = globalThis.mediaHost.seek(400);
        globalThis.mediaHost.revoke();
        return await pending;
      });
      assert.equal(closed, 'superseded');
      assert.deepEqual((await state()).pool, {
        stopped: true,
        assets: [],
        urlsCreated: 2,
        urlsReleased: 2,
      });
      assert.equal((await state()).view.state, 'revoked');
      assert.equal((await state()).lastFrame, undefined);
      assert.match(
        await page.evaluate('mediaHost.seek(0).then(()=>"unexpected",e=>String(e))'),
        /ScopeRevoked/,
      );
      await page.reload();
      await page.waitForFunction('globalThis.ready');
      assert.deepEqual((await state()).pool.assets, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      reports.push({ kind, width, sourceCommit: pins.sourceCommit, result: 'PASS' });
      console.log(
        'PASS',
        kind,
        width,
        'installed H264 recordings / native edits / history / frame mapping / terminal lease',
      );
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
await writeFile(path.join(directory, 'media-demo-results.json'), JSON.stringify(reports, null, 2));
