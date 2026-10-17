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
    if (!['video-edit.html', 'video-edit.js', 'media-demo.html', 'media-demo.js'].includes(name)) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390])
      for (const route of ['video-edit', 'media-demo']) {
        const page = await browser.newPage({ viewport: { width, height: 900 } }),
          errors = [];
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
          await page.goto(`${origin}/${route}.html`);
          await page.waitForFunction('globalThis.ready');
          const actual = route === 'media-demo';
          const state = () => page.evaluate(actual ? 'mediaHost.state()' : 'host.state()');
          const content = async () => {
            const s = await state();
            return actual ? s.view.snapshot.content : s.content;
          };
          const revision = async () => {
            const s = await state();
            return actual ? s.view.snapshot.revision.sequence : s.revision.sequence;
          };
          const button = (name) => page.getByRole('button', { name, exact: true });
          if (actual) {
            await page
              .getByLabel('Animation and GIS recordings')
              .setInputFiles(
                ['animation', 'geo'].map((d) =>
                  path.join(media, `editor-platform-${d}-reference-b18369f2.mp4`),
                ),
              );
            await button('Load recordings').click();
            await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(0);
          }
          await page.getByLabel('Timeline zoom', { exact: true }).fill(actual ? '20' : '80');
          const initial = await content(),
            id = actual ? 'clip-recording-animation' : 'v';
          const drag = async (name, dx, pending) => {
            const target = button(name);
            await target.scrollIntoViewIfNeeded();
            let box;
            // Scrolling replaces visible clip nodes. Resolve the current target.
            await expect
              .poll(async () => {
                box = await target.boundingBox();
                return !!box;
              })
              .toBe(true);
            const p = {
              x: Math.max(25, Math.min(width - 30, box.x + Math.min(box.width / 2, 50))),
              y: box.y + box.height / 2,
            };
            await page.mouse.move(p.x, p.y);
            await page.mouse.down();
            await page.mouse.move(p.x + dx, p.y, { steps: 4 });
            await pending?.();
            await page.mouse.up();
          };
          if (actual) {
            await button('Play preview').click();
            await expect.poll(async () => (await state()).playing).toBe(true);
            await page.getByLabel('Split at sequence frame', { exact: true }).fill('250');
            await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(10);
            assert.equal((await state()).playing, false);
            assert.equal(await revision(), 0);
            // A trim leaves room before the first clip; dragging a full contiguous clip would overlap.
            await drag(`Trim start ${id}`, 20);
            assert.equal(await revision(), 1);
            assert.deepEqual((await content()).sequence.clips[0].start, { value: 1, timescale: 1 });
            await button('Undo').click();
            assert.deepEqual(await content(), initial);
            await button('Redo').click();
            await button('Play preview').click();
            await drag(`Select clip ${id}`, -10, async () => {
              assert.equal((await state()).playing, false);
              assert.equal((await state()).inputs.dirty, 1);
              assert.equal(await revision(), 3);
            });
            assert.equal(await revision(), 4);
            await page.getByLabel('Split at sequence frame', { exact: true }).fill('25');
            await expect.poll(async () => (await state()).lastFrame?.clipId).toBe(id);
            assert.equal((await state()).view.canSave, false);
          } else {
            await drag(`Select clip ${id}`, 32, async () => {
              assert.equal(await revision(), 0);
              assert.equal((await state()).inputs.dirty, 1);
              await button('Save native JSON').evaluate((b) => b.click());
              await expect.poll(async () => (await state()).view.saving).toBe(false);
              assert.equal((await state()).writes, 0);
            });
            assert.equal(await revision(), 1);
            const moved = await content();
            assert.deepEqual(
              moved.sequence.clips.map((c) => c.start),
              [
                { value: 7, timescale: 5 },
                { value: 7, timescale: 5 },
              ],
            );
            await button('Undo').click();
            assert.deepEqual(await content(), initial);
            await button('Redo').click();
            assert.deepEqual(await content(), moved);
            await button('Undo').click();
            await button('Trim start v').focus();
            await page.keyboard.press('ArrowRight');
            const trimmed = await content();
            await button('Undo').click();
            await page.getByLabel('Trim start (rational seconds)').fill('26/25');
            await button('Apply independent trim').click();
            assert.deepEqual(await content(), trimmed);
            await button('Save native JSON').click();
            await expect.poll(async () => (await state()).view.lastSave?.state).toBe('committed');
            const saved = await content(),
              raw = JSON.parse(await page.evaluate('host.raw()'));
            assert.deepEqual(raw.request.content, saved);
            assert.equal(raw.receiptId, (await state()).view.lastSave.receipt.adapterReceiptId);
            await page.reload();
            await page.waitForFunction('globalThis.ready');
            assert.deepEqual(await content(), saved);
            assert.equal(await revision(), 0);
            await page.evaluate('host.authorizeEditable(true)');
            const locked = await content();
            await button('Select clip v').focus();
            await page.keyboard.press('ArrowRight');
            assert.deepEqual(await content(), locked);
            assert.equal(await revision(), 0);
            await page.evaluate('host.authorizeEditable()');
            const normal = await content();
            const startField = page.getByLabel('Trim start (rational seconds)');
            await startField.dispatchEvent('compositionstart', { data: '' });
            await button('Select clip v').focus();
            await page.keyboard.press('ArrowRight');
            assert.deepEqual(await content(), normal);
            await startField.dispatchEvent('compositionend', { data: '' });
            await button('Cancel inputs').click();
            let stale;
            await drag('Select clip v', 32, async () => {
              await page.evaluate('host.stale()');
              stale = await content();
            });
            assert.equal(await revision(), 1);
            assert.deepEqual(await content(), stale);
            await page
              .getByLabel('Split at sequence frame', { exact: true })
              .fill('9007199254740991');
            assert.equal((await state()).view.state, 'open');
            assert.deepEqual(await content(), stale);
            await page.evaluate("host.open('readonly')");
            const readonly = await content();
            await button('Select clip v').focus();
            await page.keyboard.press('ArrowRight');
            assert.deepEqual(await content(), readonly);
            assert.equal(await revision(), 0);
          }
          assert.equal((await state()).inputs.dirty, 0);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await page.screenshot({ path: path.join(root, `video-timeline-${route}-${width}.png`) });
          if (actual) {
            await page.evaluate('mediaHost.revoke()');
            await expect
              .poll(async () => {
                const pool = (await state()).pool;
                return pool.urlsCreated - pool.urlsReleased;
              })
              .toBe(0);
          } else await page.evaluate('host.revoke()');
          assert.deepEqual(errors, []);
          console.log(
            'PASS',
            kind,
            width,
            route,
            'installed timeline / Inputs / history / seek or save',
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
