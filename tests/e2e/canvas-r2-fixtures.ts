import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import type { Controls } from '../fixtures/canvas-r2/host';
const bundle = build({
  entryPoints: ['tests/fixtures/canvas-r2/host.tsx'],
  bundle: true,
  write: false,
  outdir: '/tmp/canvas-r2',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
}).then((r) => ({
  js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
  css: r.outputFiles!.find((f) => f.path.endsWith('.css'))!.text,
}));
export async function mountR2(page: Page, controls: Partial<Controls> = {}) {
  const data = await bundle;
  await page.route('**/canvas-r2.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: data.js }),
  );
  await page.route('**/canvas-r2.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: data.css }),
  );
  await page.route('**/canvas-r2', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/canvas-r2.css"></head><body style="margin:0;overflow-wrap:anywhere"><div id="root"></div><script src="/canvas-r2.js"></script></body></html>',
    }),
  );
  await page.goto('/canvas-r2');
  await expect(page.getByRole('application', { name: 'R2 object probe' })).toBeVisible();
  await setR2(page, controls);
}
export const setR2 = (page: Page, controls: Partial<Controls>) =>
  page.evaluate((c) => window.r2Probe.set(c), controls);
export const stateR2 = (page: Page) => page.evaluate(() => window.r2Probe.snapshot());
export async function paintR2(page: Page, id = 'a') {
  return page
    .getByTestId('paint-' + id)
    .evaluate((el) =>
      Object.fromEntries(
        ['x', 'y', 'width', 'height', 'data-rotation'].map((k) => [k, Number(el.getAttribute(k))]),
      ),
    );
}
export async function startR2(page: Page, mode = 'move', handle = 'se') {
  const locator =
    mode === 'move'
      ? page.getByTestId('paint-a')
      : page.getByRole('button', {
          name: mode === 'resize' ? 'Resize ' + handle : 'Rotate selection',
          exact: true,
        });
  const box = (await locator.boundingBox())!;
  const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  const end = { x: p.x + 30, y: p.y + 22 };
  await page.mouse.move(end.x, end.y, { steps: 3 });
  return end;
}
