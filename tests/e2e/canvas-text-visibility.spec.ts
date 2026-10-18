import { build } from 'esbuild';
import { test, expect } from './fixtures';

test('screen text pruning matches full SVG pixels across clipping, alignment, fonts, fit and table cells', async ({
  page,
}, info) => {
  const result = await build({
    entryPoints: ['tests/fixtures/canvas-text-visibility/host.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/canvas-text-visibility',
    format: 'iife',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await page.route('**/text-visibility.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: result.outputFiles!.find((file) => file.path.endsWith('.js'))!.text,
    }),
  );
  await page.route('**/text-visibility.css', (route) =>
    route.fulfill({
      contentType: 'text/css',
      body: result.outputFiles!.find((file) => file.path.endsWith('.css'))!.text,
    }),
  );
  await page.route('**/text-visibility.html*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/text-visibility.css"><body style="margin:0"><div id="root"></div><script src="/text-visibility.js"></script>',
    }),
  );
  await page.goto('/text-visibility.html?full');
  await page.evaluate(() => document.fonts.ready);
  const svg = page.locator('svg');
  await expect(svg.locator('text')).toHaveCount(13);
  const fullNodes = await svg.locator('*').count();
  const expected = await svg.screenshot({ path: info.outputPath('full-text.png') });
  await page.goto('/text-visibility.html');
  await page.evaluate(() => document.fonts.ready);
  await expect(svg.locator('text')).toHaveCount(13);
  expect(await svg.locator('*').count()).toBeLessThan(fullNodes / 2);
  const actual = await svg.screenshot({ path: info.outputPath('visible-text.png') });
  expect(
    actual.equals(expected),
    'Clipped screen drawing must have exactly the full SVG pixels',
  ).toBe(true);
});
