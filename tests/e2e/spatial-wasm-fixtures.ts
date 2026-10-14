import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export async function checkSpatialSurfaces(page: Page, backend: string) {
  // Observe real ABI calls without changing CanvasStage or the Editor SDK.
  await page.addInitScript(`(() => {
    const real = WebAssembly.instantiate.bind(WebAssembly);
    window.__spatialQueries = 0; window.__spatialDrops = 0;
    WebAssembly.instantiate = async (source, imports) => {
      const instance = await real(source, imports);
      if (!instance.exports?.spatial_query) return instance;
      return { exports: { ...instance.exports,
        spatial_query: (...args) => { window.__spatialQueries++; return instance.exports.spatial_query(...args); },
        spatial_drop: (...args) => { window.__spatialDrops++; return instance.exports.spatial_drop(...args); }
      }};
    };
  })();`);
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../fixtures/spatial/host.tsx', import.meta.url))],
    bundle: true,
    write: false,
    outdir: '/tmp/spatial-host',
    format: 'iife',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await page.route('**/experimental-spatial.wasm', async (route) =>
    route.fulfill({
      contentType: 'application/wasm',
      body: await readFile(new URL('../../work/spatial-wasm/spatial.wasm', import.meta.url)),
    }),
  );
  await page.route('**/spatial-host.html*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto(`/spatial-host.html?backend=${backend}`);
  for (const file of bundle.outputFiles!)
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
  for (const file of bundle.outputFiles!)
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text });
  await expect(page.getByTestId('backend')).toHaveText(backend === 'wasm' ? 'wasm' : 'typescript');
  for (const kind of ['design', 'whiteboard']) {
    const previousCalls = await page.evaluate(() =>
      Number((window as unknown as Record<string, unknown>).__spatialQueries),
    );
    await page.getByLabel('Read only', { exact: true }).uncheck();
    await page.getByLabel('Surface', { exact: true }).selectOption(kind);
    const canvas = page.getByRole('application', {
      name: kind === 'design' ? 'Design canvas' : 'Whiteboard canvas',
      exact: true,
    });
    await expect(canvas).toBeVisible();
    const source = await page.getByTestId('source').textContent();
    await expect(canvas.locator('[data-canvas-target="shape-0"]')).toBeVisible();
    const box = await canvas.boundingBox();
    const nodes = await canvas.locator('[data-canvas-target]').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      }),
    );
    // Start in empty canvas space and encompass visible unlocked and locked nodes.
    const start = {
      x: Math.max(box!.x + 2, Math.min(...nodes.map((b) => b.x)) - 10),
      y: Math.max(box!.y + 2, Math.min(...nodes.map((b) => b.y)) - 10),
    };
    const end = {
      x: Math.min(box!.x + box!.width - 2, Math.max(...nodes.map((b) => b.right)) + 10),
      y: Math.min(box!.y + box!.height - 2, Math.max(...nodes.map((b) => b.bottom)) + 10),
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('selection')).toHaveText('shape-0,shape-1,shape-2');
    expect(await page.getByTestId('source').textContent()).toBe(source);
    await page.getByLabel('Read only', { exact: true }).check();
    await canvas.focus();
    await page.keyboard.press('Delete');
    expect(await page.getByTestId('source').textContent()).toBe(source);
    const calls = await page.evaluate(() =>
      Number((window as unknown as Record<string, unknown>).__spatialQueries),
    );
    if (backend === 'wasm') expect(calls).toBeGreaterThan(previousCalls);
    else expect(calls).toBe(0);
    const previousDrops = await page.evaluate(() =>
      Number((window as unknown as Record<string, unknown>).__spatialDrops),
    );
    await page.getByRole('button', { name: 'Toggle mount', exact: true }).click();
    await expect(canvas).toHaveCount(0);
    if (backend === 'wasm')
      expect(
        await page.evaluate(() =>
          Number((window as unknown as Record<string, unknown>).__spatialDrops),
        ),
      ).toBeGreaterThan(previousDrops);
    await page.getByRole('button', { name: 'Toggle mount', exact: true }).click();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
