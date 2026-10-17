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
        await button('Reverse clip order').click();
        await input('Selected clip').selectOption('clip-recording-geo');
        await input('Trim end (rational seconds)').fill('8');
        await button('Apply independent trim').click();
        await input('Split at sequence frame').fill('100');
        await button('Split linked clips').click();
        await input('Timeline zoom').fill('20');
        const before = await content(),
          left = 'clip-recording-geo';
        const right = before.sequence.clips.find(
          (c) => c.sourceId === 'recording-geo' && c.id !== left,
        ).id;
        assert.equal(await revision(), 3);
        const leftClip = before.sequence.clips.find((c) => c.id === left);
        const rightClip = before.sequence.clips.find((c) => c.id === right);
        assert.deepEqual(leftClip.start, { value: 0, timescale: 1 });
        assert.deepEqual(leftClip.duration, { value: 4, timescale: 1 });
        assert.deepEqual(rightClip.start, { value: 4, timescale: 1 });
        assert.deepEqual(rightClip.duration, { value: 4, timescale: 1 });
        assert.deepEqual(
          before.sequence.clips.find((c) => c.sourceId === 'recording-animation').start,
          { value: 139, timescale: 5 },
        );
        const focusRight = async () => {
          await button(`Select clip ${left}`).click();
          await button(`Select clip ${left}`).focus();
          for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
          await expect(button(`Select clip ${right}`)).toBeFocused();
          await expect(input('Selected clip')).toHaveValue(left);
        };
        await input('Split at sequence frame').fill('150');
        await focusRight();
        const firstRevision = await revision();
        await page.keyboard.press('s');
        assert.equal(await revision(), firstRevision + 1);
        let changed = await content();
        assert.equal(changed.sequence.clips.length, before.sequence.clips.length + 1);
        assert.deepEqual(
          changed.sequence.clips.find((c) => c.id === left),
          before.sequence.clips.find((c) => c.id === left),
        );
        assert.deepEqual(changed.sequence.clips.find((c) => c.id === right).duration, {
          value: 2,
          timescale: 1,
        });
        await button('Undo').click();
        assert.deepEqual(await content(), before);
        await button('Redo').click();
        assert.deepEqual(await content(), changed);
        await button('Undo').click();
        await focusRight();
        const deleteRevision = await revision();
        await page.keyboard.press('Delete');
        assert.equal(await revision(), deleteRevision + 1);
        changed = await content();
        assert.equal(
          changed.sequence.clips.some((c) => c.id === right),
          false,
        );
        assert.deepEqual(
          changed.sequence.clips.find((c) => c.id === left),
          before.sequence.clips.find((c) => c.id === left),
        );
        await button('Undo').click();
        assert.deepEqual(await content(), before);
        assert.equal((await state()).canRedo, true);
        const baseline = await revision();
        const down = async () => {
          const target = button(`Select clip ${right}`);
          await target.scrollIntoViewIfNeeded();
          let box;
          await expect
            .poll(async () => {
              box = await target.boundingBox();
              return !!box;
            })
            .toBe(true);
          const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          return point;
        };
        let point = await down();
        await page.mouse.move(point.x + 20, point.y);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        assert.equal(await revision(), baseline);
        assert.deepEqual(await content(), before);
        assert.equal((await state()).canRedo, true);
        await down();
        await page.mouse.up();
        assert.equal(await revision(), baseline);
        assert.equal((await state()).canRedo, true);
        await button('Redo').click();
        assert.deepEqual(await content(), changed);
        await button('Undo').click();
        // Check the real decoded half-open join, not just ruler geometry.
        await page.evaluate('mediaHost.seek(99)');
        await expect.poll(async () => (await state()).lastFrame?.clipId).toBe(left);
        assert.equal((await state()).lastFrame.decodedSeconds, 3.96);
        await page.evaluate('mediaHost.seek(100)');
        await expect.poll(async () => (await state()).lastFrame?.clipId).toBe(right);
        assert.equal((await state()).lastFrame.decodedSeconds, 4);
        const joinedRevision = await revision();
        await input('Split at sequence frame').fill('100');
        await input('Preview sequence frame').fill('50');
        await button('Seek preview').click();
        await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(2);
        await expect(page.locator('[data-playhead]')).toHaveText('▼ Split 100f');
        await expect(input('Split at sequence frame')).toHaveValue('100');
        await expect(page.getByLabel('Split target help')).toContainText(
          'does not follow Player playback or Player seeking',
        );
        const rendered = (await state()).rendered;
        await button('Play preview').click();
        await expect.poll(async () => (await state()).rendered).toBeGreaterThan(rendered + 2);
        point = await down();
        assert.equal((await state()).playing, false);
        assert.equal((await state()).inputs.dirty, 1);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        assert.equal(await revision(), joinedRevision);
        assert.deepEqual(await content(), before);
        await expect(page.locator('[data-playhead]')).toHaveText('▼ Split 100f');
        const racing = await page.evaluate(async () => {
          const previous = globalThis.mediaHost.state().rendered;
          const results = await Promise.all([
            globalThis.mediaHost.seek(0),
            globalThis.mediaHost.seek(100),
          ]);
          return { results, presented: globalThis.mediaHost.state().rendered - previous };
        });
        assert.equal(racing.results[0], 'superseded');
        assert.equal(racing.results[1], 'frame');
        assert.equal(racing.presented, 1);
        assert.equal((await state()).lastFrame.clipId, right);
        assert.equal((await state()).lastFrame.decodedSeconds, 4);
        assert.equal((await state()).view.canSave, false);
        assert.equal((await state()).inputs.dirty, 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({ path: path.join(root, `media-focus-operation-${width}.png`) });
        await page.evaluate('mediaHost.revoke()');
        const closed = await state();
        assert.equal(closed.pool.urlsCreated, closed.pool.urlsReleased);
        assert.deepEqual(errors, []);
        console.log(
          'PASS',
          kind,
          width,
          'actual recordings / reorder+trim / Tab-right S+Delete / one command / UndoRedo / cancel+noopRedo / join / split100 vs Player50 / edit pause / stale-frame supersession',
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
