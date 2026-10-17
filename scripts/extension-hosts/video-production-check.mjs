/* global document, innerWidth */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]),
  media = path.resolve(process.argv[3]);
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!['media-demo.html', 'media-demo.js'].includes(name)) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        errors = [];
      const origin = `http://127.0.0.1:${server.address().port}`;
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.route('**/*', (r) => {
        if (new URL(r.request().url()).origin !== origin) {
          errors.push(r.request().url());
          return r.abort();
        }
        return r.continue();
      });
      try {
        await page.goto(origin + '/media-demo.html');
        await page.waitForFunction('globalThis.ready');
        const state = () => page.evaluate('mediaHost.state()'),
          button = (name) => page.getByRole('button', { name, exact: true }),
          input = (name) => page.getByLabel(name, { exact: true });
        const content = async () => (await state()).view.snapshot.content,
          revision = async () => (await state()).view.snapshot.revision.sequence;
        await input('Animation and GIS recordings').setInputFiles(
          ['animation', 'geo'].map((d) =>
            path.join(media, `editor-platform-${d}-reference-b18369f2.mp4`),
          ),
        );
        await button('Load recordings').click();
        await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(0);
        const history = [await content()];
        const commit = async (action) => {
          const previous = await revision();
          await action();
          assert.equal(await revision(), previous + 1);
          history.push(await content());
        };
        await commit(() => button('Reverse clip order').click());
        await input('Selected clip').selectOption('clip-recording-geo');
        await input('Trim start (rational seconds)').fill('1');
        await input('Trim end (rational seconds)').fill('9');
        await commit(() => button('Apply independent trim').click());
        await input('Split at sequence frame').fill('125');
        await commit(() => button('Split linked clips').click());
        const right = (await content()).sequence.clips.find(
          (c) => c.sourceId === 'recording-geo' && c.id !== 'clip-recording-geo',
        ).id;
        await commit(() => button('Delete linked clips').click());
        await input('Selected clip').selectOption(right);
        await commit(() => button('Move +1 frame').click());
        await input('Selected clip').selectOption('clip-recording-animation');
        await input('Trim end (rational seconds)').fill('179/5');
        await commit(() => button('Apply independent trim').click());
        const final = await content();
        assert.equal(history.length, 7);
        assert.equal(final.sequence.clips.length, 2);
        const gis = final.sequence.clips.find((c) => c.id === right);
        assert.deepEqual(gis.start, { value: 126, timescale: 25 });
        assert.deepEqual(gis.duration, { value: 4, timescale: 1 });
        assert.deepEqual(gis.sourceIn, { value: 5, timescale: 1 });
        assert.deepEqual(gis.sourceOut, { value: 9, timescale: 1 });
        const animation = final.sequence.clips.find((c) => c.id === 'clip-recording-animation');
        assert.deepEqual(animation.start, { value: 139, timescale: 5 });
        assert.deepEqual(animation.duration, { value: 8, timescale: 1 });
        for (let i = history.length - 2; i >= 0; i--) {
          await button('Undo').click();
          assert.deepEqual(await content(), history[i]);
        }
        assert.equal((await state()).canUndo, false);
        for (let i = 1; i < history.length; i++) {
          await button('Redo').click();
          assert.deepEqual(await content(), history[i]);
        }
        assert.equal((await state()).canRedo, false);
        const seek = async (frame, id, sourceSeconds) => {
          await input('Preview sequence frame').fill(String(frame));
          await button('Seek preview').click();
          if (id) {
            await expect.poll(async () => (await state()).lastFrame?.clipId).toBe(id);
            await expect
              .poll(async () => (await state()).lastFrame?.decodedSeconds)
              .toBe(sourceSeconds);
          } else {
            await expect(page.getByLabel('Host media preview')).toHaveText('Gap — no active clip');
            assert.equal((await state()).lastFrame, undefined);
            const blank = await page.getByLabel('Decoded recording frame').evaluate((canvas) => {
              const pixels = canvas
                .getContext('2d')
                .getImageData(0, 0, canvas.width, canvas.height).data;
              return pixels.every((channel) => channel === 0);
            });
            assert.equal(blank, true);
          }
        };
        // Non-ripple edits intentionally leave gaps. No previous picture may remain in a gap.
        await seek(126, right, 5);
        await seek(125);
        await seek(225, right, 8.96);
        await seek(226);
        await seek(695, 'clip-recording-animation', 0);
        await seek(894, 'clip-recording-animation', 7.96);
        await seek(895);
        await seek(890, 'clip-recording-animation', 7.8);
        await button('Play preview').click();
        await expect(page.getByLabel('Host media preview')).toHaveText('Gap — no active clip');
        await button('Pause preview').click();
        assert.equal((await state()).playing, false);
        assert.equal((await state()).lastFrame, undefined);
        assert.deepEqual(await content(), final);
        assert.equal((await state()).view.canSave, false);
        await expect(button('Save native JSON')).toBeDisabled();
        assert.equal((await state()).inputs.dirty, 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await input('Timeline zoom').fill('20');
        await page.screenshot({
          path: path.join(root, `video-production-${width}.png`),
          fullPage: true,
        });
        await page.evaluate('mediaHost.revoke()');
        const closed = await state();
        assert.equal(closed.pool.urlsCreated, closed.pool.urlsReleased);
        assert.deepEqual(errors, []);
        console.log(
          'PASS',
          kind,
          width,
          'six-edit production / exact all Undo+Redo / trimmed source windows / boundary gaps blank / playback into gap / no media Save',
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
