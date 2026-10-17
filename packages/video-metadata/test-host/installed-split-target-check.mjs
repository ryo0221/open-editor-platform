/* global document, innerWidth */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = process.argv[2];
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
    for (const width of [1280, 390]) {
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
        const initial = await page.evaluate('host.state()');
        await page.getByLabel('Split at sequence frame', { exact: true }).fill('50');
        await expect(page.locator('[data-playhead]')).toHaveText('▼ Split 50f');
        await expect(page.getByLabel('Split target help')).toContainText(
          'does not follow Player playback or Player seeking',
        );
        assert.match(
          await button('Split linked clips').getAttribute('title'),
          /not the current Player position/,
        );
        assert.deepEqual((await page.evaluate('host.state()')).revision, initial.revision);
        await button('Split linked clips').click();
        let state = await page.evaluate('host.state()');
        assert.equal(state.revision.sequence, initial.revision.sequence + 1);
        assert.deepEqual(state.content.sequence.clips.find((c) => c.id === 'v').duration, {
          value: 1,
          timescale: 1,
        });
        assert.deepEqual(state.content.sequence.clips.find((c) => c.id === 'clip-1').start, {
          value: 2,
          timescale: 1,
        });
        await button('Undo').click();
        assert.deepEqual((await page.evaluate('host.state()')).content, initial.content);
        await page.getByLabel('Split at sequence frame', { exact: true }).fill('37');
        await button('Select clip v').focus();
        await page.keyboard.press('s');
        state = await page.evaluate('host.state()');
        assert.equal(state.revision.sequence, initial.revision.sequence + 3);
        assert.deepEqual(state.content.sequence.clips.find((c) => c.id === 'v').duration, {
          value: 12,
          timescale: 25,
        });
        assert.deepEqual(state.content.sequence.clips.find((c) => c.id === 'clip-1').start, {
          value: 37,
          timescale: 25,
        });
        await expect(page.locator('[data-playhead]')).toHaveText('▼ Split 37f');
        await button('Undo').click();
        assert.deepEqual((await page.evaluate('host.state()')).content, initial.content);
        await page.screenshot({
          path: `/tmp/video-split-target-${kind}-${width}.png`,
          fullPage: true,
        });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.deepEqual(errors, []);
        console.log('PASS', kind, width, 'explicit target; click/S exact split; one history; Undo');
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
