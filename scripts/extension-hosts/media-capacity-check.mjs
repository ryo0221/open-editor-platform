import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]), media = path.resolve(process.argv[3]), reports = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind), pins = JSON.parse(await readFile(path.join(root, 'editor-pin.json')));
  const server = createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (route === '/favicon.ico') { res.writeHead(204).end(); return; }
      const name = route === '/' ? 'media-demo.html' : route.slice(1);
      if (!/^[a-z0-9.-]+$/.test(name)) throw Error('route');
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(await readFile(path.join(root, 'dist', name)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      try {
        await page.goto(origin);
        await page.waitForFunction('globalThis.ready');
        await page.getByLabel('Animation and GIS recordings').setInputFiles(
          ['animation', 'geo'].map((d) => path.join(media, `editor-platform-${d}-reference-b18369f2.mp4`)),
        );
        const button = (name) => page.getByRole('button', { name, exact: true });
        await button('Load recordings').click();
        await expect.poll(() => page.evaluate('mediaHost.state().lastFrame?.decodedSeconds')).toBe(0);
        const boundary = await page.evaluate(() => {
          let tail = 'clip-recording-animation', previous;
          for (let n = 1; n < 300; n++) {
            const before = globalThis.mediaHost.state(), raw = globalThis.mediaHost.raw();
            const result = globalThis.mediaHost.edit({
              type: 'split', clipId: tail, at: { value: n / (n % 25 === 0 ? 25 : n % 5 === 0 ? 5 : 1), timescale: 25 / (n % 25 === 0 ? 25 : n % 5 === 0 ? 5 : 1) }, rightIds: { [tail]: `s${n}` },
            });
            const after = globalThis.mediaHost.state();
            if (result.state === 'refused' || after.view.state !== 'open')
              return { before, after, raw, previous, result, n, tail };
            previous = raw;
            tail = `s${n}`;
          }
          throw Error('No capacity boundary encountered');
        });
        console.log('BOUNDARY', kind, width, boundary.n, boundary.before.view.snapshot.content.sequence.clips.length, boundary.result, boundary.after.view.state);
        assert.equal(boundary.after.view.state, 'open',
          `controller closed after ${boundary.before.view.snapshot.content.sequence.clips.length} clips: ${JSON.stringify(boundary.result)}`);
        assert.equal(boundary.result.state, 'refused');
        const unchanged = async () => {
          const s = await page.evaluate('mediaHost.state()');
          assert.equal(await page.evaluate('mediaHost.raw()'), boundary.raw);
          assert.deepEqual(s.view.snapshot.revision, boundary.before.view.snapshot.revision);
          assert.equal(s.canUndo, boundary.before.canUndo);
          assert.equal(s.canRedo, boundary.before.canRedo);
          assert.equal(s.pool.stopped, false);
          assert.equal(s.pool.urlsCreated, 2);
          assert.equal(s.pool.urlsReleased, 0);
        };
        await unchanged();
        assert.equal(await page.evaluate('mediaHost.seek(500)'), 'frame');
        assert.equal(await page.evaluate('mediaHost.state().lastFrame.decodedSeconds'), 20);
        await page.getByLabel('Selected clip', { exact: true }).selectOption(boundary.tail);
        await page.getByLabel('Split at sequence frame', { exact: true }).fill(String(boundary.n));
        await button('Split linked clips').click();
        console.log('UI RESULT', await page.evaluate('mediaHost.state().view.lastOperation'), await page.getByRole('status').allTextContents());
        assert.equal(await page.evaluate('mediaHost.state().view.lastOperation.state'), 'refused');
        await unchanged();
        await button('Undo').click();
        assert.equal(await page.evaluate('mediaHost.raw()'), boundary.previous);
        await button('Redo').click();
        assert.equal(await page.evaluate('mediaHost.raw()'), boundary.raw);
        assert.equal(await page.evaluate('mediaHost.seek(500)'), 'frame');
        assert.equal(await page.evaluate('mediaHost.state().pool.stopped'), false);
        assert.deepEqual(errors, []);
        reports.push({kind, width, sourceCommit:pins.sourceCommit, result:'PASS', clips:boundary.before.view.snapshot.content.sequence.clips.length});
        console.log('PASS', kind, width, 'capacity admission / UI + non-UI refusal / exact native and history / live media scope');
      } catch (error) {
        reports.push({kind, width, sourceCommit:pins.sourceCommit, result:'FAIL', error:String(error)});
        console.error('FAIL', kind, width, String(error));
      } finally { await page.close(); }
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
await writeFile(path.join(directory, 'media-capacity-results.json'), JSON.stringify(reports, null, 2));
assert.ok(reports.every((r) => r.result === 'PASS'));
