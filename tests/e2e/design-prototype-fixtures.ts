import { build } from 'esbuild';
import { type Page } from '@playwright/test';
let bundled: Promise<{ js: string; css: string }> | undefined;
export async function independentPrototype(page: Page, edit = false) {
  bundled ??= build({
    entryPoints: ['tests/fixtures/design-prototype/host.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/design-prototype-bundle',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((r) => ({
    js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css: r.outputFiles!.find((f) => f.path.endsWith('.css'))!.text,
  }));
  const bundle = await bundled;
  await page.route('**/design-prototype-host.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: bundle.js }),
  );
  await page.route('**/design-prototype-host.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: bundle.css }),
  );
  await page.route('**/design-prototype-host?*', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/design-prototype-host.css"></head><body style="margin:0"><div id="root"></div><script src="/design-prototype-host.js"></script></body></html>',
    }),
  );
  await page.goto(`/design-prototype-host?${edit ? 'edit=1' : 'view=1'}`);
}
export async function followPrototype(page: Page, tap = false) {
  const activate = async (name: string) => {
    const target = page.getByRole('button', { name: `Activate ${name}`, exact: true });
    if (tap) await target.tap();
    else await target.click();
  };
  await page.getByLabel('Prototype flow', { exact: true }).selectOption('happy');
  await activate('Continue');
  await activate('Show state');
  await activate('Open dialog');
  await activate('Close dialog');
  await activate('Open dialog');
  await activate('Finish');
}
