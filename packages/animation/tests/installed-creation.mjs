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
      const original = (await inspect()).view.snapshot.content.compositions[0];
      await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
      const added = (await inspect()).view.snapshot.content.compositions[0].layers.at(-1);
      await expect(
        page.getByRole('button', { name: `rect ${added.id}`, exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await page.getByLabel('Base y', { exact: true }).fill('220');
      await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
      await page
        .getByRole('button', { name: 'Add key at playhead (base value)', exact: true })
        .click();
      await expect(page.getByLabel('Key tick', { exact: true })).toHaveValue('0');
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      await page.getByLabel('Seek', { exact: true }).fill('720000');
      await page
        .getByRole('button', { name: 'Add key at playhead (base value)', exact: true })
        .click();
      await expect(page.getByLabel('Key tick', { exact: true })).toHaveValue('720000');
      await page.getByLabel('Key value', { exact: true }).fill('460');
      await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
      await page.getByRole('button', { name: '0 ticks · 80', exact: true }).click();
      await page.getByLabel('Easing', { exact: true }).selectOption('bezier');
      await page.getByLabel('Bezier x1', { exact: true }).fill('0.25');
      await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
      const end = page.getByRole('button', { name: '720000 ticks · 460', exact: true });
      await end.focus();
      await end.press('Shift+ArrowLeft');
      await end.press('Enter');
      await expect(
        page.getByRole('button', { name: '712000 ticks · 460', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(end).toBeVisible();
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect(
        page.getByRole('button', { name: '712000 ticks · 460', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      await page.getByLabel('Seek', { exact: true }).fill('0');
      const revision = (await inspect()).view.snapshot.revision.sequence;
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction('host.inspect().playback.tick > 0');
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      assert.equal((await inspect()).view.snapshot.revision.sequence, revision);
      await page.getByLabel('Base y', { exact: true }).fill('-');
      await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('complete number');
      assert.equal((await inspect()).view.snapshot.revision.sequence, revision);
      await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('-');
      await page.getByLabel('Base y', { exact: true }).fill('230');
      await page.getByLabel('Base y', { exact: true }).dispatchEvent('compositionstart');
      await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
      assert.equal((await inspect()).view.snapshot.revision.sequence, revision);
      await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('230');
      await page.getByLabel('Base y', { exact: true }).dispatchEvent('compositionend');
      await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('Save: committed');
      const saved = (await inspect()).view.snapshot.content;
      assert.deepEqual(
        saved.compositions[0].layers.slice(0, original.layers.length),
        original.layers,
      );
      assert.deepEqual(
        saved.compositions[0].tracks.filter((t) => t.layerId !== added.id),
        original.tracks,
      );
      await page.reload();
      await page.waitForFunction('globalThis.ready');
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      assert.deepEqual((await inspect()).view.snapshot.content, saved);
      assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
      // Selection is private: fresh entry selects a valid existing layer, not a saved UI ID.
      await expect(
        page.getByRole('navigation', { name: 'Layers' }).locator('[aria-pressed="true"]'),
      ).toHaveCount(1);
      await expect(page.getByLabel('Base y', { exact: true })).toBeEnabled();
      await page.getByRole('button', { name: `rect ${added.id}`, exact: true }).click();
      assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
      await page.getByRole('button', { name: '0 ticks · 80', exact: true }).click();
      await expect(page.getByLabel('Bezier x1', { exact: true })).toHaveValue('0.25');
      await expect(
        page.getByRole('button', { name: '712000 ticks · 460', exact: true }),
      ).toBeVisible();
      await page.getByLabel('Seek', { exact: true }).fill('712000');
      await expect(page.locator('svg rect').last()).toHaveAttribute(
        'transform',
        'matrix(1 0 0 1 460 230)',
      );
      await page.screenshot({ path: path.join(root, `creation-qa-${width}.png`), fullPage: true });
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
        'creation selection, keys/easing, playback, Undo, invalid/IME recovery, Save/reopen',
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
  path.join(directory, 'animation-creation-qa-results.json'),
  JSON.stringify(reports, null, 2),
);
