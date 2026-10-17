import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { test, expect } from './fixtures';
let bundled: Promise<{ js: string; css: string }> | undefined;
for (const mode of ['copy', 'owned']) {
  test(`large Document ${mode} Host: typing retains unchanged native blocks`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
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
    const bundle = await bundled;
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
    const loadStart = Date.now();
    await page.goto(`/document-performance.html?${mode}`);
    const body = page.getByRole('textbox', { name: 'Document body', exact: true });
    await expect(body).toBeVisible();
    const loadMs = Date.now() - loadStart;
    const initial = await page.evaluate(() => window.documentInputProbe.native());
    await body.click();
    await body.press('Control+Home');
    for (let i = 0; i < 12; i++) {
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
    }));
    await writeFile(
      info.outputPath('measurements.json'),
      JSON.stringify({ mode, loadMs, ...measured }, null, 2),
    );
    expect(measured.commits).toHaveLength(12);
    expect(
      measured.commits.slice(1).every((commit) => commit.retained >= measured.blocks - 1),
    ).toBe(true);
    const typed = await page.evaluate(() => window.documentInputProbe.native());
    expect(typed.blocks[0].text).toBe('x'.repeat(12) + initial.blocks[0].text);
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
    await page.screenshot({ path: info.outputPath(`document-${mode}.png`) });
  });
}
