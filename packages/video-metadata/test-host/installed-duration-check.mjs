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
      for (const action of ['sequence', 'readonly']) {
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
          const input = page.getByLabel('Sequence duration (rational seconds)', { exact: true });
          if (action === 'readonly') {
            await page.evaluate("host.open('readonly')");
            await expect(input).toBeDisabled();
            await expect(button('Apply sequence duration')).toBeDisabled();
          } else {
            await page.evaluate(async () => {
              const content = (await globalThis.host.state()).content;
              content.sequence.duration = { value: 1391, timescale: 25 };
              const clip = content.sequence.clips[0];
              delete clip.linkGroupId;
              content.sequence.clips = [
                {
                  ...clip,
                  start: { value: 0, timescale: 1 },
                  duration: { value: 4, timescale: 1 },
                  sourceOut: { value: 6, timescale: 1 },
                },
                {
                  ...clip,
                  id: 'second',
                  start: { value: 4, timescale: 1 },
                  duration: { value: 4, timescale: 1 },
                  sourceOut: { value: 6, timescale: 1 },
                },
              ];
              await globalThis.host.open('editable', content);
            });
            const initial = await state();
            await expect(input).toHaveValue('1391/25');
            await input.fill('8');
            await button('Apply sequence duration').click();
            const resized = await state();
            assert.equal(resized.revision.sequence, 1);
            assert.deepEqual(resized.content.sequence.duration, { value: 8, timescale: 1 });
            assert.deepEqual(resized.content.sequence.clips, initial.content.sequence.clips);
            assert.deepEqual(resized.content.sources, initial.content.sources);
            await input.fill('7');
            await button('Apply sequence duration').click();
            assert.deepEqual((await state()).content, resized.content);
            assert.deepEqual((await state()).revision, resized.revision);
            await button('Cancel inputs').click();
            await input.fill('9'); // Valid without composition: isolate the IME refusal gate.
            await input.dispatchEvent('compositionstart');
            await button('Apply sequence duration').click();
            assert.deepEqual((await state()).content, resized.content);
            assert.deepEqual((await state()).revision, resized.revision);
            await button('Save native JSON').click();
            assert.equal((await state()).writes, 0);
            assert.deepEqual((await state()).content, resized.content);
            assert.deepEqual((await state()).revision, resized.revision);
            await input.dispatchEvent('compositionend');
            await button('Undo').click();
            assert.deepEqual((await state()).revision, resized.revision);
            await button('Apply sequence duration').click();
            const afterComposition = await state();
            assert.equal(afterComposition.revision.sequence, resized.revision.sequence + 1);
            assert.deepEqual(afterComposition.content.sequence.duration, {
              value: 9,
              timescale: 1,
            });
            assert.deepEqual(
              afterComposition.content.sequence.clips,
              resized.content.sequence.clips,
            );
            await button('Undo').click();
            assert.deepEqual((await state()).content, resized.content);
            await expect(input).toHaveValue('8/1');
            await button('Undo').click();
            assert.deepEqual((await state()).content, initial.content);
            const undone = await state();
            await input.fill('1391/25');
            await button('Apply sequence duration').click();
            assert.deepEqual((await state()).revision, undone.revision);
            assert.equal((await state()).canRedo, true);
            await button('Redo').click();
            assert.deepEqual((await state()).content, resized.content);
            await button('Save native JSON').click();
            await expect.poll(async () => (await state()).view.lastSave?.state).toBe('committed');
            assert.deepEqual(
              JSON.parse(await page.evaluate('host.raw()')).request.content,
              resized.content,
            );
            await button('Reopen saved').click();
            await expect.poll(async () => (await state()).revision.sequence).toBe(0);
            assert.deepEqual((await state()).content, resized.content);
            await page.reload();
            await page.waitForFunction('globalThis.ready');
            assert.deepEqual((await state()).content, resized.content);
            await expect(input).toHaveValue('8/1');
            await page.screenshot({
              path: `/tmp/video-duration-${kind}-${width}.png`,
              fullPage: true,
            });
            await input.fill('9');
            await page.evaluate('host.revoke()');
            assert.deepEqual((await state()).content, resized.content);
          }
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.deepEqual(errors, []);
          console.log(
            'PASS',
            kind,
            width,
            action,
            'duration / boundaries / Inputs / UndoRedo / SaveReopen / revoke',
          );
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
console.log(JSON.stringify({ passed: 8 - failed, failed }));
process.exitCode = failed ? 1 : 0;
