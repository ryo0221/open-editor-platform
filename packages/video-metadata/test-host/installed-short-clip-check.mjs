/* global document, innerWidth */
import { chromium, expect } from '@playwright/test';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = process.argv[2];
let failed = 0;
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind, 'dist');
  const server = createServer(async (req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!['video-edit.html', 'video-edit.js'].includes(file)) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, file)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390])
      for (const action of [
        'short',
        'zoom-scroll',
        'pending',
        'roundtrip',
        'locked',
        'readonly',
        'cancel-noop',
      ]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } }),
          errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        try {
          await page.goto(`http://127.0.0.1:${server.address().port}/video-edit.html`);
          await page.waitForFunction('globalThis.ready');
          const button = (name) => page.getByRole('button', { name, exact: true });

          const state = () => page.evaluate('host.state()');
          const drag = async (name, dx) => {
            const target = button(name);
            await target.scrollIntoViewIfNeeded();
            let box;
            await expect
              .poll(async () => {
                box = await target.boundingBox();
                return !!box;
              })
              .toBe(true);
            const x = box.x + box.width / 2,
              y = box.y + box.height / 2;
            const before = await state();
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + dx, y, { steps: 3 });
            assert.equal((await state()).revision.sequence, before.revision.sequence);
            await page.mouse.up();
            assert.equal((await state()).revision.sequence, before.revision.sequence + 1);
          };
          if (action === 'short') {
            await page.getByLabel('Split at sequence frame', { exact: true }).fill('26');
            await button('Split linked clips').click();
            const split = await state();
            assert.deepEqual(split.content.sequence.clips[0].duration, { value: 1, timescale: 25 });
            await page.getByLabel('Selected clip', { exact: true }).selectOption('v');
            await button('Trim selected end').focus();
            await page.keyboard.press('ArrowRight');
            assert.deepEqual(
              (await state()).content,
              split.content,
              'overlapping extension refused',
            );
            await page.getByLabel('Selected clip', { exact: true }).selectOption('clip-1');
            await button('Delete linked clips').click();
            await page.getByLabel('Selected clip', { exact: true }).selectOption('v');
            await drag('Trim selected end', 3.2);
            assert.deepEqual((await state()).content.sequence.clips[0].duration, {
              value: 2,
              timescale: 25,
            });
            await button('Trim selected start').focus();
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('ArrowLeft');
            assert.deepEqual((await state()).content.sequence.clips[0].start, {
              value: 23,
              timescale: 25,
            });
            await button('Undo').click();
            assert.deepEqual((await state()).content.sequence.clips[0].start, {
              value: 24,
              timescale: 25,
            });
            await drag('Move selected clip', 3.2);
            assert.deepEqual((await state()).content.sequence.clips[0].start, {
              value: 1,
              timescale: 1,
            });
            await page.screenshot({
              path: `/tmp/video-short-${kind}-${width}.png`,
              fullPage: true,
            });
          } else if (action === 'zoom-scroll') {
            await page.evaluate(() =>
              globalThis.host.edit({ type: 'resize', duration: { value: 10, timescale: 1 } }),
            );
            await page.getByLabel('Timeline zoom', { exact: true }).fill('200');
            const canvas = page.getByLabel('Timeline tracks', { exact: true });
            await canvas.scrollIntoViewIfNeeded();
            await canvas.evaluate((el) => {
              el.parentElement.scrollLeft = 120;
            });
            const target = button('Select clip v');
            let box;
            await expect
              .poll(async () => {
                box = await target.boundingBox();
                return !!box;
              })
              .toBe(true);
            const x = Math.min(width - 70, box.x + box.width / 2),
              y = box.y + box.height / 2;
            const before = await state();
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + 16, y, { steps: 3 });
            assert.equal((await state()).revision.sequence, before.revision.sequence);
            await page.mouse.up();
            assert.equal((await state()).revision.sequence, before.revision.sequence + 1);
            assert.deepEqual((await state()).content.sequence.clips[0].start, {
              value: 27,
              timescale: 25,
            });
            await button('Undo').click();
            assert.deepEqual((await state()).content, before.content);
          } else if (action === 'roundtrip') {
            await page.getByLabel('Split at sequence frame', { exact: true }).fill('26');
            await button('Split linked clips').click();
            await button('Trim selected start').focus();
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('ArrowLeft');
            await button('Trim selected end').focus();
            await page.keyboard.press('ArrowLeft');
            const beforeLastTrim = await state();
            await page.keyboard.press('ArrowLeft');
            const trimmed = await state();
            assert.deepEqual(trimmed.content.sequence.clips[0].start, { value: 23, timescale: 25 });
            assert.deepEqual(trimmed.content.sequence.clips[0].duration, {
              value: 1,
              timescale: 25,
            });
            for (const frame of ['23', '24']) {
              await page.getByLabel('Split at sequence frame', { exact: true }).fill(frame);
              await button('Split linked clips').click();
              assert.deepEqual((await state()).content, trimmed.content, 'boundary split refused');
              assert.deepEqual((await state()).revision, trimmed.revision);
            }
            await button('Move selected clip').focus();
            await page.keyboard.press('s');
            assert.deepEqual((await state()).revision, trimmed.revision);
            await button('Undo').click();
            assert.deepEqual((await state()).content, beforeLastTrim.content);
            await button('Redo').click();
            assert.deepEqual((await state()).content, trimmed.content);
            await button('Save native JSON').click();
            await expect.poll(async () => (await state()).view.lastSave?.state).toBe('committed');
            await button('Reopen saved').click();
            await expect.poll(async () => (await state()).revision.sequence).toBe(0);
            assert.deepEqual((await state()).content, trimmed.content);
            await page.reload();
            await page.waitForFunction('globalThis.ready');
            assert.deepEqual((await state()).content, trimmed.content);
            await expect(page.getByLabel('Split target help', { exact: true })).toContainText(
              'does not follow Player',
            );
          } else if (action === 'locked' || action === 'readonly') {
            await page.evaluate(
              action === 'locked' ? 'host.authorizeEditable(true)' : "host.open('readonly')",
            );
            if (action === 'locked')
              await page.getByLabel('Selected clip', { exact: true }).selectOption('a');
            const before = await state();
            for (const name of ['Move selected clip', 'Trim selected start', 'Trim selected end']) {
              const control = button(name);
              await expect(control).toBeDisabled();
              // Browser-dispatched events exercise the guarded path in addition to native disabled affordance.
              await control.dispatchEvent('keydown', { key: 'ArrowRight' });
              await control.dispatchEvent('pointerdown', {
                pointerId: 7,
                clientX: 100,
                clientY: 100,
              });
              await page
                .getByLabel('Timeline tracks', { exact: true })
                .dispatchEvent('pointerup', { pointerId: 7 });
              assert.deepEqual((await state()).content, before.content);
              assert.deepEqual((await state()).revision, before.revision);
              assert.equal((await state()).inputs.dirty, 0);
            }
            if (action === 'locked') {
              await page.getByLabel('Selected clip', { exact: true }).selectOption('v');
              await button('Move selected clip').focus();
              await page.keyboard.press('ArrowRight');
              assert.deepEqual(
                (await state()).content,
                before.content,
                'linked locked audio refuses video move',
              );
              assert.deepEqual((await state()).revision, before.revision);
            }
          } else if (action === 'cancel-noop') {
            await page.evaluate(() =>
              globalThis.host.edit({ type: 'resize', duration: { value: 10, timescale: 1 } }),
            );
            await button('Move +1 frame').click();
            const moved = await state();
            await button('Undo').click();
            const before = await state();
            await page.getByLabel('Timeline zoom', { exact: true }).fill('200');
            const canvas = page.getByLabel('Timeline tracks', { exact: true });
            await canvas.evaluate((el) => {
              el.parentElement.scrollLeft = 120;
            });
            const start = async () => {
              const control = button('Move selected clip');
              await control.scrollIntoViewIfNeeded();
              const box = await control.boundingBox();
              const x = box.x + box.width / 2,
                y = box.y + box.height / 2;
              await page.mouse.move(x, y);
              await page.mouse.down();
              return { x, y };
            };
            for (const mode of ['escape', 'zoom', 'noop']) {
              const p = await start();
              if (mode !== 'noop') await page.mouse.move(p.x + 16, p.y, { steps: 3 });
              if (mode === 'escape') {
                await canvas.evaluate((el) => {
                  el.parentElement.scrollLeft += 20;
                });
                await page.keyboard.press('Escape');
              }
              if (mode === 'zoom')
                await page.getByLabel('Timeline zoom', { exact: true }).fill('120');
              await page.mouse.up();
              assert.deepEqual((await state()).content, before.content);
              assert.deepEqual((await state()).revision, before.revision);
              assert.equal((await state()).inputs.dirty, 0);
              assert.equal((await state()).canRedo, true);
            }
            await button('Redo').click();
            assert.deepEqual((await state()).content, moved.content);
            await button('Undo').click();
            assert.deepEqual((await state()).content, before.content);
          } else {
            const initial = await state();
            await page.getByLabel('Trim start (rational seconds)').fill('26/25');
            await button('Select clip a').click();
            await button('Undo').click();
            assert.deepEqual((await state()).content, initial.content);
            assert.deepEqual((await state()).revision, initial.revision);
            assert.equal(
              await page.getByLabel('Trim start (rational seconds)').inputValue(),
              '26/25',
            );
            assert.equal(await page.getByLabel('Selected clip', { exact: true }).inputValue(), 'v');
            await button('Cancel inputs').click();
            await button('Select clip a').click();
            assert.equal(await page.getByLabel('Selected clip', { exact: true }).inputValue(), 'a');
            await page.getByLabel('Trim start (rational seconds)').fill('26/25');
            await button('Apply independent trim').click();
            assert.equal((await state()).revision.sequence, initial.revision.sequence + 1);
            await button('Undo').click();
            assert.deepEqual((await state()).content, initial.content);
          }
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.deepEqual(errors, []);
          console.log('PASS', kind, width, action, 'short-clip/zoom/pending-input operation gate');
        } catch (e) {
          failed++;
          console.log('FAIL', kind, width, action, String(e));
        } finally {
          await page.close();
        }
      }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
console.log(JSON.stringify({ passed: 28 - failed, failed }));
process.exitCode = failed ? 1 : 0;
