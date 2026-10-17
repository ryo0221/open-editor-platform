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
      for (const action of ['Delete', 's']) {
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
          await button('Split linked clips').click();
          const split = await page.evaluate('host.state()');
          assert.equal(split.content.sequence.clips.length, 4);
          if (action === 's')
            await page.getByLabel('Split at sequence frame', { exact: true }).fill('62');
          await button('Select clip v').focus();
          for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
          assert.equal(
            await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
            'Select clip clip-1',
          );
          await page.keyboard.press(action);
          const edited = await page.evaluate('host.state()');
          if (action === 'Delete')
            assert.deepEqual(
              edited.content.sequence.clips.map((c) => c.id),
              ['v', 'a'],
              'Delete must target focused right cohort, not old selected left',
            );
          else {
            assert.equal(
              edited.content.sequence.clips.length,
              6,
              'S must split focused right clip',
            );
            assert.deepEqual(
              edited.content.sequence.clips.find((c) => c.id === 'v'),
              split.content.sequence.clips.find((c) => c.id === 'v'),
              'left clip unchanged',
            );
          }
          assert.equal(edited.revision.sequence, split.revision.sequence + 1);
          await button('Undo').click();
          assert.deepEqual((await page.evaluate('host.state()')).content, split.content);
          await button('Redo').click();
          assert.deepEqual((await page.evaluate('host.state()')).content, edited.content);
          await button('Save native JSON').click();
          await expect.poll(async () => (await page.evaluate('host.state()')).writes).toBe(1);
          await button('Reopen saved').click();
          await expect
            .poll(async () => (await page.evaluate('host.state()')).revision.sequence)
            .toBe(0);
          assert.deepEqual((await page.evaluate('host.state()')).content, edited.content);
          await page.reload();
          await page.waitForFunction('globalThis.ready');
          assert.deepEqual((await page.evaluate('host.state()')).content, edited.content);
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
            'keyboard cohort + Undo/Redo + Save/Reopen/reload',
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
