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
      await expect(page.locator('head link[rel="stylesheet"][href="./animation.css"]')).toHaveCount(
        1,
      );
      await expect(page.locator('.animation-controlled')).toHaveCSS(
        'padding',
        width < 600 ? '12px' : '20px',
      );
      const fieldGroups = await page.locator('.ac-fields').all();
      assert.ok(fieldGroups.length > 0);
      for (const fields of fieldGroups) await expect(fields).toHaveCSS('display', 'grid');
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      assert.equal(await page.locator('code').textContent(), pins['@editor-platform/animation']);
      await page.getByRole('button', { name: '960000 ticks · 400', exact: true }).click();
      await page.getByLabel('Base y', { exact: true }).fill('160');
      await page.getByLabel('Key tick', { exact: true }).fill('720000');
      await page.getByLabel('Key value', { exact: true }).fill('500');
      assert.equal((await page.evaluate('host.setX(99)')).code, 'PendingInputs');
      assert.equal((await page.evaluate('host.inspect()')).view.snapshot.revision.sequence, 0);
      await page.getByLabel('Key tick', { exact: true }).fill('0');
      await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('already exists');
      assert.equal((await page.evaluate('host.inspect()')).view.snapshot.revision.sequence, 0);
      await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('160');
      await page.getByLabel('Key tick', { exact: true }).fill('720000');
      await page.getByLabel('Base y', { exact: true }).dispatchEvent('compositionstart');
      assert.equal((await page.evaluate('host.save()')).state, 'refused');
      assert.equal((await page.evaluate('host.inspect()')).view.snapshot.revision.sequence, 0);
      await page.getByLabel('Base y', { exact: true }).dispatchEvent('compositionend');
      await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
      let state = await page.evaluate('host.inspect()');
      assert.equal(state.view.snapshot.revision.sequence, 1);
      assert.equal(state.view.snapshot.content.compositions[0].layers[0].transform.y, 160);
      assert.equal(state.view.snapshot.content.compositions[0].tracks[0].keys[1].value, 500);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      state = await page.evaluate('host.inspect()');
      assert.equal(state.view.snapshot.content.compositions[0].layers[0].transform.y, 140);
      await page.getByLabel('Base y', { exact: true }).fill('');
      await page.getByLabel('Base y', { exact: true }).fill('140');
      await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
      assert.equal((await page.evaluate('host.inspect()')).view.snapshot.revision.sequence, 2);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      await page.getByLabel('Seek', { exact: true }).fill('360000');
      await expect(page.locator('svg rect').first()).toHaveAttribute(
        'transform',
        'matrix(1 0 0 1 290 160)',
      );
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
      await page.getByLabel('Base y', { exact: true }).fill('170');
      await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
      state = await page.evaluate('host.inspect()');
      assert.equal(state.playback.playing, false);
      assert.ok(state.playback.tick >= 360000);
      await page.getByLabel('Base y', { exact: true }).fill('-');
      const revision = state.view.snapshot.revision.sequence;
      await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
      assert.equal(
        (await page.evaluate('host.inspect()')).view.snapshot.revision.sequence,
        revision,
      );
      await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
      // Cancelled empty IME must not preserve the old layer target.
      const field = page.getByLabel('Base y', { exact: true });
      await field.dispatchEvent('compositionstart');
      await field.dispatchEvent('compositionend');
      await page.getByRole('button', { name: 'rect other-box', exact: true }).click();
      await field.fill('205');
      await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
      state = await page.evaluate('host.inspect()');
      assert.equal(state.view.snapshot.content.compositions[0].layers[0].transform.y, 170);
      assert.equal(state.view.snapshot.content.compositions[0].layers[1].transform.y, 205);
      assert.equal((await page.evaluate('host.setX(123)')).state, 'applied');
      await page.getByLabel('Base y', { exact: true }).fill('210');
      await page.getByRole('button', { name: 'Save through Host', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('Save: committed');
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      await page.screenshot({ path: path.join(root, `animation-${width}.png`), fullPage: true });
      await page.reload();
      await page.waitForFunction('globalThis.ready');
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      state = await page.evaluate('host.inspect()');
      assert.equal(state.view.snapshot.content.compositions[0].layers[0].transform.x, 123);
      assert.equal(state.view.snapshot.content.compositions[0].layers[1].transform.y, 210);
      await page.getByLabel('Base y', { exact: true }).fill('999');
      assert.equal((await page.evaluate('host.deny()')).state, 'drained');
      assert.equal(await page.locator('main svg').count(), 0);
      assert.equal((await page.evaluate('host.setX(22)')).code, 'ScopeRevoked');
      await page.evaluate('host.freshReadOnly()');
      await expect(page.getByRole('button', { name: 'Add rectangle', exact: true })).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'Save through Host', exact: true }),
      ).toBeDisabled();
      assert.equal((await page.evaluate('host.setX(22)')).code, 'EditUnavailable');
      assert.equal((await page.evaluate('host.close()')).state, 'drained');
      assert.equal(await page.locator('main svg').count(), 0);
      assert.equal(await page.locator('main').textContent(), '');
      assert.deepEqual((await page.evaluate('host.inspect()')).errors, []);
      assert.deepEqual(errors, []);
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
        'actual Animation/controller/Player UI/nonUI, one history, save/reload, revoke/readonly/drain',
      );
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
assert.equal(hashes[0], hashes[1]);
await writeFile(path.join(directory, 'animation-results.json'), JSON.stringify(reports, null, 2));
