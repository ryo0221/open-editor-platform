/* global document, window */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]),
  reports = [],
  hashes = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind),
    pins = JSON.parse(await readFile(path.join(root, 'editor-pin.json'))).packages;
  hashes.push(pins['@editor-platform/animation']);
  const server = createServer(async (req, res) => {
    const name =
      req.url === '/'
        ? 'animation.html'
        : req.url === '/animation.js'
          ? 'animation.js'
          : req.url === '/animation.css'
            ? 'animation.css'
            : undefined;
    if (!name) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader(
      'Content-Type',
      name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    );
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } }),
        errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction('globalThis.ready');
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      await expect(page.locator('.ae-key-marker').first()).toHaveCSS('position', 'absolute');
      assert.equal(await page.locator('code').textContent(), pins['@editor-platform/animation']);
      const inspect = () => page.evaluate('host.inspect()');
      await page.getByLabel('Timeline zoom', { exact: true }).fill('4');
      await page.getByRole('button', { name: '0 ticks · 80', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(
        page.getByRole('button', { name: '960000 ticks · 400', exact: true }),
      ).toBeFocused();
      assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
      for (let i = 0; i < 50; i++) await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Enter');
      const moved = page.getByRole('button', { name: '560000 ticks · 400', exact: true });
      await expect(moved).toBeFocused();
      await page.screenshot({
        path: path.join(root, `keyboard-focus-${width}.png`),
        fullPage: true,
      });
      const marker = await moved.boundingBox(),
        rail = await page.getByLabel('Scrollable timeline', { exact: true }).boundingBox();
      assert.ok(
        marker.x >= rail.x && marker.x + marker.width <= rail.x + rail.width,
        'Focused retimed key must remain inside the scroll viewport',
      );
      assert.equal((await inspect()).view.snapshot.revision.sequence, 1);
      const undo = page.getByRole('button', { name: 'Undo', exact: true });
      await undo.focus();
      await page.keyboard.press('Enter');
      await expect(undo).toBeFocused();
      await page.keyboard.press('Tab');
      const redo = page.getByRole('button', { name: 'Redo', exact: true });
      await expect(redo).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(redo).toBeFocused();
      await expect(moved).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      await page.getByLabel('Seek', { exact: true }).fill('480000');
      await page
        .getByRole('button', { name: 'Add key at playhead (base value)', exact: true })
        .click();
      await undo.focus();
      await page.keyboard.press('Enter');
      await expect(undo).toBeFocused();
      await expect(
        page.getByText('Selected key is unavailable. Choose a key to continue.', { exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel('Key value', { exact: true })).toBeDisabled();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await expect(redo).toBeFocused();
      await expect(
        page.getByRole('button', { name: '480000 ticks · 80', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      assert.equal((await inspect()).view.snapshot.revision.sequence, 6);
      assert.deepEqual(errors, []);
      assert.deepEqual((await inspect()).errors, []);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
      reports.push({
        kind,
        width,
        result: 'PASS',
        editorSha256: pins['@editor-platform/animation'],
        adapterSha256: pins['@editor-platform/extension-animation-adapter'],
      });
      console.log(
        'PASS',
        kind,
        width,
        'keyboard focus follows retimed key; Undo/Redo keep toolbar focus and selection context',
      );
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
assert.equal(hashes[0], hashes[1]);
await writeFile(
  path.join(directory, 'animation-keyboard-focus-results.json'),
  JSON.stringify(reports, null, 2),
);
