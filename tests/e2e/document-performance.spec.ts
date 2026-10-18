import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { test, expect } from './fixtures';
let bundled: Promise<{ js: string; css: string }> | undefined;
const development = process.env.ISSUE269_DEV === '1';
const measure = process.env.ISSUE269_MEASURE === '1';
for (const mode of ['copy', 'owned']) {
  test(`large Document ${mode} ${development ? 'dev StrictMode' : 'production'} Host: typing retains unchanged native blocks`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    if (!development)
      bundled ??= build({
        entryPoints: ['tests/fixtures/document-performance/host.tsx'],
        bundle: true,
        write: false,
        outdir: '/tmp/document-performance',
        format: 'iife',
        minify: true,
        define: { 'process.env.NODE_ENV': '"production"' },
      }).then((r) => ({
        js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
        css: r.outputFiles!.find((f) => f.path.endsWith('.css'))!.text,
      }));
    if (!development) {
      const bundle = (await bundled)!;
      await page.route('**/document-performance.js', (r) =>
        r.fulfill({ contentType: 'text/javascript', body: bundle.js }),
      );
      await page.route('**/document-performance.css', (r) =>
        r.fulfill({ contentType: 'text/css', body: bundle.css }),
      );
      await page.route('**/document-performance.html*', (r) =>
        r.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/document-performance.css"></head><body style="margin:0"><div id="root"></div><script src="/document-performance.js"></script></body></html>',
        }),
      );
    }
    const loadStart = Date.now();
    await page.goto(
      development
        ? `/tests/fixtures/document-performance/index.html?${mode}&strict`
        : `/document-performance.html?${mode}`,
    );
    const body = page.getByRole('textbox', { name: 'Document body', exact: true });
    await expect(body).toBeVisible();
    const loadMs = Date.now() - loadStart;
    const initial = await page.evaluate(() => window.documentInputProbe.native());
    await body.click();
    await body.press('Control+Home');
    const warmup = measure ? 5 : 0;
    const count = measure ? warmup + 20 : 12;
    for (let i = 0; i < count; i++) {
      await page.keyboard.press('x');
      await expect
        .poll(() => page.evaluate(() => window.documentInputProbe.samples.length))
        .toBe(i + 1);
    }
    const measured = await page.evaluate(() => ({
      samples: window.documentInputProbe.samples,
      commits: window.documentInputProbe.commits,
      bytes: window.documentInputProbe.sourceBytes,
      blocks: window.documentInputProbe.blocks,
      paintSkipped: window.documentInputProbe.skipped().length,
    }));
    await writeFile(
      info.outputPath('measurements.json'),
      JSON.stringify({ mode, development, warmup, loadMs, ...measured }, null, 2),
    );
    expect(measured.commits).toHaveLength(count);
    if (measure) {
      const samples = measured.samples.slice(warmup).sort((a, b) => a - b);
      expect(
        samples[Math.ceil(samples.length * 0.95) - 1],
        'input p95 <= 100ms',
      ).toBeLessThanOrEqual(100);
    }
    expect(
      measured.commits.slice(1).every((commit) => commit.retained >= measured.blocks - 1),
    ).toBe(true);
    const typed = await page.evaluate(() => window.documentInputProbe.native());
    expect(typed.blocks[0].text).toBe('x'.repeat(count) + initial.blocks[0].text);
    await page.getByRole('button', { name: 'Host undo', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.documentInputProbe.native().blocks[0].text))
      .toBe(initial.blocks[0].text);
    await page.getByRole('button', { name: 'Host redo', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.documentInputProbe.native().blocks[0].text))
      .toBe(typed.blocks[0].text);
    await page.getByRole('button', { name: 'Host external edit', exact: true }).click();
    await expect(body).toContainText('External content');
    await expect(body.locator(':scope > [data-block-id]')).toHaveCount(800);
    await expect
      .poll(() => page.evaluate(() => window.documentInputProbe.skipped().length))
      .toBeGreaterThan(500);
    const last = body.locator('[data-block-id="heading-399"]');
    const lastParagraph = body.locator('[data-block-id="body-399"]');
    const beforeNavigation = await page.evaluate(() =>
      JSON.stringify(window.documentInputProbe.native()),
    );
    await body.press('Control+f');
    await page.getByLabel('Find text', { exact: true }).fill('Section 399: editable document');
    await expect(page.getByText('1 matches', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next match', exact: true }).click();
    await page.getByRole('button', { name: 'Close find', exact: true }).click();
    await expect(last).toBeInViewport();
    await body.press('Control+Home');
    // Outline navigation reaches native content whose text paint has been skipped.
    const outline = page.getByRole('button', {
      name: 'H2 · Section 399: editable document',
      exact: true,
    });
    if (!(await outline.isVisible()))
      await page.getByRole('button', { name: 'Toggle Document outline', exact: true }).click();
    await outline.click();
    if (info.project.name === 'mobile')
      await page.getByRole('button', { name: 'Close Document outline', exact: true }).click();
    await expect(last).toBeInViewport();
    await expect
      .poll(() => page.evaluate(() => window.documentInputProbe.skipped().includes('heading-399')))
      .toBe(false);
    expect(await page.evaluate(() => JSON.stringify(window.documentInputProbe.native()))).toBe(
      beforeNavigation,
    );
    await body.press('Control+End');
    await page.keyboard.insertText('Retained offscreen edit');
    await expect
      .poll(() => page.evaluate(() => window.documentInputProbe.native().blocks.at(-1)!.text))
      .toContain('Retained offscreen edit');
    await expect(lastParagraph).toBeInViewport();
    await page.getByRole('button', { name: 'Host undo', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.documentInputProbe.native().blocks.at(-1)!.text))
      .not.toContain('Retained offscreen edit');
    await page.getByRole('button', { name: 'Host redo', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.documentInputProbe.native().blocks.at(-1)!.text))
      .toContain('Retained offscreen edit');
    await body.focus();
    await page.keyboard.press('Control+a');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(
      'Section 399: editable document',
    );
    await page.emulateMedia({ media: 'print' });
    expect(await last.evaluate((node) => getComputedStyle(node).contentVisibility)).toBe('visible');
    await page.emulateMedia({ media: 'screen' });
    await page.screenshot({ path: info.outputPath(`document-${mode}.png`) });
  });
}
