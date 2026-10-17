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
      const end = page.getByRole('button', { name: '960000 ticks · 400', exact: true });
      await end.focus();
      await end.press('Shift+ArrowLeft');
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      assert.equal((await page.evaluate('host.setX(99)')).code, 'PendingInputs');
      assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
      await end.press('Escape');
      await end.press('Shift+ArrowLeft');
      await end.press('Enter');
      await expect(
        page.getByRole('button', { name: '952000 ticks · 400', exact: true }),
      ).toBeVisible();
      assert.equal((await inspect()).view.snapshot.revision.sequence, 1);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(end).toBeVisible();
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      const moved = page.getByRole('button', { name: '952000 ticks · 400', exact: true });
      await moved.scrollIntoViewIfNeeded();
      const box = await moved.boundingBox();
      const before = (await inspect()).view.snapshot.revision.sequence;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2);
      assert.equal((await inspect()).view.snapshot.revision.sequence, before);
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      await page.mouse.up();
      assert.equal((await inspect()).view.snapshot.revision.sequence, before + 1);
      const changedTick = (await inspect()).view.snapshot.content.compositions[0].tracks[0].keys[1]
        .tick;
      assert.ok(changedTick < 952000 && changedTick > 0);
      await page.getByRole('button', { name: '0 ticks · 80', exact: true }).click();
      await page.getByLabel('Easing', { exact: true }).selectOption('hold');
      await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      await page.getByLabel('Seek', { exact: true }).fill('240000');
      await expect(page.locator('svg rect').first()).toHaveAttribute(
        'transform',
        'matrix(1 0 0 1 80 140)',
      );
      await page.getByLabel('Easing', { exact: true }).selectOption('bezier');
      await page.getByLabel('Bezier x1', { exact: true }).fill('-');
      await page.getByLabel('Base y', { exact: true }).fill('175');
      const revision = (await inspect()).view.snapshot.revision.sequence;
      await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('complete number');
      assert.equal((await inspect()).view.snapshot.revision.sequence, revision);
      await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('175');
      await page.getByLabel('Bezier x1', { exact: true }).fill('0.25');
      await page.getByLabel('Bezier x1', { exact: true }).dispatchEvent('compositionstart');
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      await page.getByLabel('Bezier x1', { exact: true }).dispatchEvent('compositionend');
      await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('Save: committed');
      assert.equal((await inspect()).view.snapshot.revision.sequence, revision + 1);
      const saved = (await inspect()).view.snapshot.content;
      await page.screenshot({ path: path.join(root, `timeline-${width}.png`), fullPage: true });
      await page.reload();
      await page.waitForFunction('globalThis.ready');
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      assert.deepEqual((await inspect()).view.snapshot.content, saved);
      assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
      await page.getByRole('button', { name: '0 ticks · 80', exact: true }).click();
      await expect(page.getByLabel('Bezier x1', { exact: true })).toHaveValue('0.25');
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
        'installed timeline/easing, pointer/keyboard, atomic inputs, IME, Host save/fresh reopen',
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
  path.join(directory, 'animation-timeline-results.json'),
  JSON.stringify(reports, null, 2),
);
