/* global document, window, crypto, TextEncoder, MouseEvent */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]),
  reports = [];
const pins = {};
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  pins[kind] = JSON.parse(await readFile(path.join(root, 'editor-pin.json'))).packages;
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    const file =
      name === '/' ? 'readonly.html' : name === '/readonly.js' ? 'readonly.js' : undefined;
    if (!file) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', file)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390])
      for (const fixture of ['points', 'dateline', 'polar', 'wide']) {
        const page = await browser.newPage({ viewport: { width, height: 844 } }),
          errors = [],
          external = [];
        page.setDefaultTimeout(30000);
        const origin = `http://127.0.0.1:${server.address().port}`;
        await page.route('**/*', (route) => {
          if (new URL(route.request().url()).origin !== origin) {
            external.push(route.request().url());
            return route.abort();
          }
          return route.continue();
        });
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(`${origin}/?domain=geo&fixture=${fixture}`);
        await page.waitForFunction('globalThis.ready');
        assert.equal(await page.getByRole('status').last().textContent(), 'Ready');
        const name = '@editor-platform/geo-inspector';
        assert.equal(await page.locator('code').textContent(), pins[kind][name]);
        const before = await page.evaluate('host.native()');
        assert.deepEqual(JSON.parse(before.json).sources, []);
        assert.equal(before.canUndo, false);
        assert.equal(before.canRedo, false);
        const map = page.getByRole('region', { name: 'Local point map sites', exact: true });
        await expect(map).toContainText(
          'Distances, areas and projection accuracy are not guaranteed',
        );
        if (fixture === 'points') {
          await expect(map.getByRole('button')).toHaveCount(3);
          const first = map.getByRole('button', { name: 'Select point site-1;', exact: false });
          const second = map.getByRole('button', { name: 'Select point site-2;', exact: false });
          const third = map.getByRole('button', { name: 'Select point site-3;', exact: false });
          const positions = await map.locator('svg [role=button]').evaluateAll((markers) =>
            markers.map((marker) =>
              marker
                .getAttribute('transform')
                .match(/-?[0-9.]+/g)
                .map(Number),
            ),
          );
          assert.ok(positions[1][0] > positions[0][0], 'longitude east/right');
          assert.ok(positions[1][1] < positions[0][1], 'latitude north/up');
          assert.deepEqual(positions[0], positions[2], 'coincident positions retain separate IDs');
          await first.focus();
          await page.keyboard.press('Tab');
          await expect(second).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(second).toHaveAttribute('aria-pressed', 'true');
          const row = page.getByText('Feature site-2', { exact: true }).locator('..');
          await expect(row).toHaveAttribute('open', '');
          await expect(row.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
          await third.focus();
          await page.keyboard.press('Space');
          await expect(third).toHaveAttribute('aria-pressed', 'true');
          await expect(second).toHaveAttribute('aria-pressed', 'false');
          await page.getByRole('button', { name: 'Select feature site-1', exact: true }).click();
          await expect(first).toHaveAttribute('aria-pressed', 'true');
          await page.getByText('Feature site-4', { exact: true }).click();
          await page.getByRole('button', { name: 'Select feature site-4', exact: true }).click();
          await expect(map.locator('[aria-pressed=true]')).toHaveCount(0);
          await expect(page.getByRole('status', { name: 'Geo selection' })).toContainText('site-4');
          await expect(map).toContainText('site-4: null geometry');
          await expect(map).toContainText('site-5: LineString');
        } else {
          await expect(map).toContainText(
            { dateline: 'Dateline/wide', polar: 'Polar/high', wide: 'Local frame exceeded' }[
              fixture
            ],
          );
          await expect(map.locator('svg')).toHaveCount(0);
          await page.getByRole('button', { name: 'Select feature site-1', exact: true }).click();
        }
        assert.deepEqual(await page.evaluate('host.native()'), before);
        const hash = await page.evaluate(async () => {
          const bytes = new TextEncoder().encode(globalThis.host.native().json);
          return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('');
        });
        assert.equal(await page.locator('main input,main textarea').count(), 0);
        await page.screenshot({
          path: path.join(root, `geo-point-${fixture}-${width}.png`),
          fullPage: true,
        });
        if (fixture === 'points') {
          const retired = await page.locator('svg [role=button]').first().elementHandle();
          assert.equal((await page.evaluate('host.deny()')).state, 'drained');
          assert.equal(await page.locator('main').textContent(), '');
          await page.evaluate('host.fresh()');
          const selection = await page.getByRole('status', { name: 'Geo selection' }).textContent();
          await retired.evaluate((marker) =>
            marker.dispatchEvent(new MouseEvent('click', { bubbles: true })),
          );
          assert.equal(
            await page.getByRole('status', { name: 'Geo selection' }).textContent(),
            selection,
          );
          await retired.dispose();
          await page.evaluate('host.change()');
          await expect(page.locator('main')).toContainText('Changed sites');
          await expect(page.locator('.geo-point-map svg')).toHaveCount(1);
          await page.evaluate('host.stale()');
          await page
            .getByRole('button', { name: 'Select point site-2;', exact: false })
            .press('Enter');
          await expect(page.locator('.geo-inspector')).toHaveCount(0);
          await page.evaluate('host.close()');
          await page.evaluate('host.fresh()');
          await expect(page.locator('.geo-point-map svg')).toHaveCount(1);
        }
        assert.equal((await page.evaluate('host.close()')).state, 'drained');
        assert.equal(await page.locator('main').textContent(), '');
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        );
        reports.push({
          kind,
          fixture,
          width,
          sha256: pins[kind][name],
          nativeJsonSha256: hash,
          result: 'PASS',
        });
        console.log(
          'PASS',
          kind,
          fixture,
          width,
          'installed Geo points, selection/native preservation, diagnostics, no external request, revoke/drain',
        );
        await page.close();
      }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
for (const name of ['@editor-platform/geo-inspector'])
  assert.equal(pins.reference[name], pins.independent[name]);
await writeFile(path.join(directory, 'geo-point-results.json'), JSON.stringify(reports, null, 2));
