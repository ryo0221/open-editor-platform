import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { test, expect } from './fixtures';
let bundled: Promise<{ js: string; css: string }> | undefined;
const development = process.env.ISSUE269_DEV === '1';
const measure = process.env.ISSUE269_MEASURE === '1';
for (const mode of ['mutable', 'immutable']) {
  test(`large ${mode} ${development ? 'dev StrictMode' : 'production'} Design: prototype toggles preserve the editing projection`, async ({
    page,
  }, info) => {
    test.setTimeout(180000);
    if (!development)
      bundled ??= build({
        entryPoints: ['tests/fixtures/design-prototype/large-host.tsx'],
        bundle: true,
        write: false,
        outdir: '/tmp/design-prototype-large',
        format: 'iife',
        minify: true,
        define: { 'process.env.NODE_ENV': '"production"' },
      }).then((result) => ({
        js: result.outputFiles!.find((file) => file.path.endsWith('.js'))!.text,
        css: result.outputFiles!.find((file) => file.path.endsWith('.css'))!.text,
      }));
    if (!development) {
      const bundle = (await bundled)!;
      await page.route('**/large-design.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: bundle.js }),
      );
      await page.route('**/large-design.css', (route) =>
        route.fulfill({ contentType: 'text/css', body: bundle.css }),
      );
      await page.route('**/large-design.html*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/large-design.css"></head><body style="margin:0"><div id="root"></div><script src="/large-design.js"></script></body></html>',
        }),
      );
    }
    const loadStart = Date.now();
    await page.goto(
      development
        ? `/tests/fixtures/design-prototype/large.html?${mode}&strict`
        : `/large-design.html?${mode}`,
    );
    await expect(page.getByRole('application', { name: 'Design canvas', exact: true })).toBeVisible(
      { timeout: 90000 },
    );
    const showOpenButton = async () => {
      if (!(await page.getByRole('button', { name: 'Open prototype', exact: true }).isVisible()))
        await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    };
    await showOpenButton();
    await expect(page.getByRole('button', { name: 'Open prototype', exact: true })).toBeEnabled({
      timeout: 90000,
    });
    const loadMs = Date.now() - loadStart;
    const before = await page.evaluate(() => ({
      visits: window.designPrototypeProbe.visits(),
      draws: window.designPrototypeProbe.draws(),
      native: window.designPrototypeProbe.native(),
      stats: window.designPrototypeProbe.stats,
      dom: document.querySelectorAll('*').length,
    }));
    expect(before.dom).toBeLessThan(60000);
    const timings: { open: number; close: number }[] = [];
    const warmup = measure ? 5 : 0;
    for (let i = 0; i < (measure ? warmup + 20 : 3); i++) {
      await showOpenButton();
      const open = await page.evaluate(async () => {
        const start = performance.now();
        Array.from(document.querySelectorAll('button'))
          .find((button) => button.textContent?.trim() === 'Open prototype')!
          .click();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return performance.now() - start;
      });
      await expect(
        page.getByRole('dialog', { name: 'Design prototype', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Frame 0', exact: true })).toBeVisible();
      const close = await page.evaluate(async () => {
        const start = performance.now();
        (
          document.querySelector('button[aria-label="Close Design prototype"]') as HTMLButtonElement
        ).click();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return performance.now() - start;
      });
      await expect(page.getByRole('dialog', { name: 'Design prototype', exact: true })).toHaveCount(
        0,
      );
      timings.push({ open, close });
      await writeFile(
        info.outputPath('measurements.json'),
        JSON.stringify(
          {
            mode,
            development,
            warmup,
            loadMs,
            stats: before.stats,
            dom: before.dom,
            visitsBefore: before.visits,
            visitsAfter: await page.evaluate(() => window.designPrototypeProbe.visits()),
            timings,
          },
          null,
          2,
        ),
      );
      expect(await page.evaluate(() => window.designPrototypeProbe.visits())).toBe(before.visits);
      expect(await page.evaluate(() => window.designPrototypeProbe.draws())).toBe(before.draws);
      expect(await page.evaluate(() => window.designPrototypeProbe.native())).toBe(before.native);
    }
    if (measure) {
      for (const action of ['open', 'close'] as const) {
        const samples = timings
          .slice(warmup)
          .map((sample) => sample[action])
          .sort((a, b) => a - b);
        expect(
          samples[Math.ceil(samples.length * 0.95) - 1],
          `${action} p95 <= 500ms`,
        ).toBeLessThanOrEqual(500);
      }
    }
    await info.attach('toggle-measurements', {
      body: JSON.stringify(
        { mode, loadMs, stats: before.stats, dom: before.dom, timings },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    await page.getByRole('button', { name: 'Host update title', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.designPrototypeProbe.visits()))
      .toBeGreaterThan(before.visits);
    await showOpenButton();
    await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Updated frame', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`prototype-${mode}.png`) });
    await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Design prototype', exact: true })).toHaveCount(
      0,
    );
    await showOpenButton();
    await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Design prototype', exact: true })).toHaveCount(
      0,
    );
  });
}
