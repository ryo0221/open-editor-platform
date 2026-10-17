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
      const baseline = (await inspect()).view.snapshot.content;
      await page.getByRole('button', { name: '960000 ticks · 400', exact: true }).click();
      await page.getByLabel('Base y', { exact: true }).fill('170');
      await page.getByLabel('Key tick', { exact: true }).fill('0');
      await page.getByLabel('Easing', { exact: true }).selectOption('bezier');
      await page.getByLabel('Bezier y2', { exact: true }).fill('-');
      await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
      await expect(page.getByLabel('Key tick', { exact: true })).toBeFocused();
      await expect(page.getByRole('alert')).toContainText('Key tick');
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'rect other-box', exact: true }),
      ).toBeDisabled();
      assert.deepEqual((await inspect()).view.snapshot.content, baseline);
      await page.getByLabel('Key tick', { exact: true }).fill('720000');
      await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
      await expect(page.getByLabel('Bezier y2', { exact: true })).toBeFocused();
      await expect(page.getByLabel('Bezier y2', { exact: true })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      await expect(page.getByRole('alert')).toContainText('Bezier y2');
      await page.screenshot({ path: path.join(root, `input-error-${width}.png`) });
      await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('170');
      await expect(page.getByLabel('Key tick', { exact: true })).toHaveValue('720000');
      await page.getByLabel('Key value', { exact: true }).dispatchEvent('compositionstart');
      await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
      await expect(page.getByLabel('Key value', { exact: true })).toBeFocused();
      await expect(page.getByRole('alert')).toContainText('Key value: finish IME');
      await expect(page.getByLabel('Bezier y2', { exact: true })).toHaveValue('-');
      assert.deepEqual((await inspect()).view.snapshot.content, baseline);
      assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
      await page.getByLabel('Key value', { exact: true }).dispatchEvent('compositionend');
      await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('140');
      await expect(page.getByLabel('Key tick', { exact: true })).toHaveValue('960000');
      await expect(
        page.getByRole('button', { name: '960000 ticks · 400', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
      await page.getByLabel('Base y', { exact: true }).fill('170');
      await page.getByLabel('Key tick', { exact: true }).fill('720000');
      await page.getByLabel('Key value', { exact: true }).fill('500');
      await page.getByLabel('Easing', { exact: true }).selectOption('bezier');
      await page.getByLabel('Bezier y2', { exact: true }).fill('0.75');
      await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('Save: committed');
      const saved = (await inspect()).view.snapshot.content;
      assert.equal((await inspect()).view.snapshot.revision.sequence, 1);
      assert.equal(saved.compositions[0].tracks[0].keys[1].easing.y2, 0.75);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual((await inspect()).view.snapshot.content, baseline);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      assert.deepEqual((await inspect()).view.snapshot.content, saved);
      await page.reload();
      await page.waitForFunction('globalThis.ready');
      assert.deepEqual((await inspect()).view.snapshot.content, saved);
      assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
      assert.deepEqual(errors, []);
      assert.deepEqual((await inspect()).errors, []);
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
        'addressed invalid/IME focus, full draft retention, Cancel, one-history Save, reopen',
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
  path.join(directory, 'animation-input-focus-results.json'),
  JSON.stringify(reports, null, 2),
);
