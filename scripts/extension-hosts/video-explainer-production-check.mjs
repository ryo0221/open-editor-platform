/* global document, innerWidth */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]),
  media = path.resolve(process.argv[3]),
  evidence = path.resolve(process.argv[4]);
await mkdir(evidence, { recursive: true });
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
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        recordVideo: { dir: evidence, size: { width, height: 900 } },
      });
      const page = await context.newPage(),
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
        const initial = await content(),
          edits = [];
        const commit = async (label, action) => {
          const previous = await revision();
          await action();
          assert.equal(await revision(), previous + 1);
          edits.push({ label, revision: await revision(), content: await content() });
        };
        // Try the alternate order, then choose Animation as the opening.
        await commit('Try GIS first', () => button('Reverse clip order').click());
        await button('Undo').click();
        assert.deepEqual(await content(), initial);
        await input('Selected clip').selectOption('clip-recording-animation');
        await input('Trim end (rational seconds)').fill('4');
        await commit('Animation opening: source 0..4 seconds', () =>
          button('Apply independent trim').click(),
        );
        await input('Split at sequence frame').fill('50');
        await commit('Split Animation at 2 seconds', () => button('Split linked clips').click());
        const animationRight = (await content()).sequence.clips.find(
          (c) => c.sourceId === 'recording-animation' && c.id !== 'clip-recording-animation',
        ).id;
        await input('Selected clip').selectOption('clip-recording-geo');
        await input('Trim end (rational seconds)').fill('796/25');
        await commit('GIS ending: source 0..4 seconds', () =>
          button('Apply independent trim').click(),
        );
        await input('Timeline zoom').fill('20');
        // Keep each gesture within even the 390px viewport. 20px = 1 second.
        for (const [i, dx] of [-100, -100, -100, -100, -76.8].entries()) {
          await commit(`Close the inter-clip gap, drag ${i + 1}`, async () => {
            const handle = button('Move selected clip');
            await handle.scrollIntoViewIfNeeded();
            const box = await handle.boundingBox();
            assert.ok(box);
            const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            assert.ok(point.x + dx > 0);
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            await page.mouse.move(point.x + dx, point.y, { steps: 6 });
            await page.mouse.up();
          });
        }
        const beforeResize = await content();
        assert.deepEqual(beforeResize.sequence.duration, { value: 1391, timescale: 25 });
        await input('Sequence duration (rational seconds)').fill('8');
        await commit('Set the sequence end to 8 seconds', () =>
          button('Apply sequence duration').click(),
        );
        const final = await content();
        assert.deepEqual(final, {
          ...beforeResize,
          sequence: { ...beforeResize.sequence, duration: { value: 8, timescale: 1 } },
        });
        const ordered = [...final.sequence.clips].sort(
          (a, b) => a.start.value / a.start.timescale - b.start.value / b.start.timescale,
        );
        assert.deepEqual(
          ordered.map((c) => [c.id, c.start, c.duration, c.sourceIn, c.sourceOut]),
          [
            [
              'clip-recording-animation',
              { value: 0, timescale: 1 },
              { value: 2, timescale: 1 },
              { value: 0, timescale: 1 },
              { value: 2, timescale: 1 },
            ],
            [
              animationRight,
              { value: 2, timescale: 1 },
              { value: 2, timescale: 1 },
              { value: 2, timescale: 1 },
              { value: 4, timescale: 1 },
            ],
            [
              'clip-recording-geo',
              { value: 4, timescale: 1 },
              { value: 4, timescale: 1 },
              { value: 0, timescale: 1 },
              { value: 4, timescale: 1 },
            ],
          ],
        );
        await button('Undo').click();
        assert.deepEqual(await content(), beforeResize);
        await button('Redo').click();
        assert.deepEqual(await content(), final);
        const frames = [];
        for (const [frame, clipId, decodedSeconds] of [
          [49, 'clip-recording-animation', 1.96],
          [50, animationRight, 2],
          [99, animationRight, 3.96],
          [100, 'clip-recording-geo', 0],
          [199, 'clip-recording-geo', 3.96],
        ]) {
          await input('Preview sequence frame').fill(String(frame));
          await button('Seek preview').click();
          await expect.poll(async () => (await state()).lastFrame?.clipId).toBe(clipId);
          await expect
            .poll(async () => (await state()).lastFrame?.decodedSeconds)
            .toBe(decodedSeconds);
          frames.push({ frame, ...(await state()).lastFrame });
        }
        await input('Preview sequence frame').fill('0');
        await button('Seek preview').click();
        await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(0);
        // lastFrame is deliberately cleared during each prepare. Retain positive
        // observations so polling does not repeatedly sample that transient gap.
        await page.evaluate(() => {
          const observed = new Map();
          const timer = globalThis.setInterval(() => {
            const frame = globalThis.mediaHost.state().lastFrame;
            if (frame) observed.set(frame.clipId, frame);
          }, 10);
          globalThis.explainerObservation = {
            ids: () => [...observed.keys()],
            stop: () => {
              globalThis.clearInterval(timer);
              return [...observed.values()];
            },
          };
        });
        await button('Play preview').click();
        await expect
          .poll(() => page.evaluate(() => globalThis.explainerObservation.ids()), {
            timeout: 10000,
          })
          .toEqual(['clip-recording-animation', animationRight, 'clip-recording-geo']);
        await expect(page.getByLabel('Host media preview')).toHaveText('Gap — no active clip', {
          timeout: 10000,
        });
        // The Host must stop itself at native duration; an explicit Pause would mask a bug.
        await expect.poll(async () => (await state()).playing).toBe(false);
        await expect(input('Preview sequence frame')).toHaveValue('200');
        const playedFrames = await page.evaluate(() => globalThis.explainerObservation.stop());
        assert.equal((await state()).lastFrame, undefined);
        assert.equal((await state()).playing, false);
        assert.deepEqual(await content(), final);
        assert.equal((await state()).view.canSave, false);
        await expect(button('Save native JSON')).toBeDisabled();
        assert.equal((await state()).inputs.dirty, 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        // Return to the GIS scene for the final review image, not a misleading saved/export state.
        await input('Preview sequence frame').fill('150');
        await button('Seek preview').click();
        await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(2);
        await page.screenshot({
          path: path.join(evidence, `${kind}-${width}.png`),
          fullPage: true,
        });
        const pin = JSON.parse(await readFile(path.join(root, 'editor-pin.json'), 'utf8'));
        await writeFile(
          path.join(evidence, `${kind}-${width}.json`),
          JSON.stringify(
            {
              title: 'Animation then GIS — eight-second native sequence preview',
              sourceCommit: pin.sourceCommit,
              editorTarball: pin.packages['@editor-platform/video-metadata'],
              capture: 'External Playwright UI recording; not Video export or persisted media',
              activeRange: { startSeconds: 0, endExclusiveSeconds: 8 },
              limitation:
                'Native duration is 8 seconds; playback stops at the exclusive end. Media persistence/export remains unauthorized and is not claimed.',
              final,
              edits,
              frames,
              playedFrames,
              errors,
            },
            null,
            2,
          ),
        );
        await page.evaluate('mediaHost.revoke()');
        const closed = await state();
        assert.equal(closed.pool.urlsCreated, closed.pool.urlsReleased);
        assert.deepEqual(errors, []);
        console.log(
          'PASS',
          kind,
          width,
          'contiguous Animation 0..4 then GIS 4..8 / duration 8 without source/clip changes / UndoRedo / exact decoded joins / automatic end at frame200 / media Save disabled / external UI recording',
        );
      } catch (error) {
        await page.screenshot({
          path: path.join(evidence, `${kind}-${width}-failure.png`),
          fullPage: true,
        });
        await writeFile(
          path.join(evidence, `${kind}-${width}-failure.json`),
          JSON.stringify(
            { error: String(error), state: await page.evaluate('mediaHost.state()'), errors },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        const video = page.video();
        await context.close();
        await video.saveAs(path.join(evidence, `${kind}-${width}.webm`));
      }
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
