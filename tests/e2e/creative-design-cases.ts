import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { creativeDesignAddressKey } from '@editor-platform/design/creative-proposal-diff';
import { replacementCoatSource } from '../fixtures/creative-design/content';
let bundle: Promise<{ js: string; css: string }>;
async function host(page: Page) {
  bundle ??= build({
    entryPoints: ['tests/fixtures/creative-design/host.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/creative-design-browser-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((result) => ({
    js: result.outputFiles!.find((file) => file.path.endsWith('.js'))!.text,
    css: result.outputFiles!.find((file) => file.path.endsWith('.css'))?.text ?? '',
  }));
  const files = await bundle;
  await page.route('**/creative-design-host.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await page.route('**/creative-design-host.css', (route) =>
    route.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await page.route('**/creative-design-host', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/creative-design-host.css"><div id="root"></div><script type="module" src="/creative-design-host.js"></script>',
    }),
  );
  await page.goto('/creative-design-host');
  await expect(page.getByRole('heading', { name: 'Creative Design API test host' })).toBeVisible();
}
const source = (page: Page) => page.getByTestId('creative-source');
const read = async (page: Page) => JSON.parse((await source(page).textContent())!);
const click = async (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).click();
async function preview(page: Page, part: string) {
  await page.getByLabel('Creative part', { exact: true }).selectOption(part);
  await click(page, 'Preview change');
  await expect(
    page.getByRole('img', { name: 'Creative proposed preview', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Creative fallback count', { exact: true })).toHaveText('0');
}
export function creativeDesignCases() {
  test('#616 native instance parts preview/reject/apply, Undo/Redo and Host save/reload', async ({
    page,
  }, info) => {
    await host(page);
    const before = await read(page);
    await preview(page, 'bangs');
    await expect(page.getByLabel('Qualified changed parts', { exact: true })).toHaveText(
      JSON.stringify([
        creativeDesignAddressKey({
          instanceId: 'A',
          componentId: 'person',
          elementId: 'bangs',
        }),
      ]),
    );
    expect(await read(page)).toEqual(before);
    await click(page, 'Reject change');
    expect(await read(page)).toEqual(before);
    await expect(page.getByLabel('Host history state', { exact: true })).toContainText(
      '"canUndo":false',
    );
    await preview(page, 'bangs');
    await click(page, 'Apply change');
    const moved = await read(page);
    expect(moved.elements[0].overrides.bangs.bounds.x).toBe(85);
    expect(moved.elements[1]).toEqual(before.elements[1]);
    expect(moved.components).toEqual(before.components);
    await click(page, 'Host undo');
    expect(await read(page)).toEqual(before);
    await click(page, 'Host redo');
    expect(await read(page)).toEqual(moved);
    await preview(page, 'eyes');
    await click(page, 'Apply change');
    expect((await read(page)).elements[0].overrides.eyes.fill).toBe('#ee7733');
    expect((await read(page)).elements[1].overrides).toBeUndefined();
    await click(page, 'Focus part');
    await expect(page.getByLabel('Qualified focus', { exact: true })).toContainText(
      '"focusElementId":"A"',
    );
    await preview(page, 'coat');
    await click(page, 'Apply change');
    const after = await read(page);
    expect(after.elements[0].overrides.coat.src).toBe(replacementCoatSource);
    expect(after.components).toEqual(before.components);
    await click(page, 'Host save');
    await expect(page.getByLabel('Host action status', { exact: true })).toHaveText('Saved');
    await page.reload();
    await expect(source(page)).toContainText('ee7733');
    expect(await read(page)).toEqual(after);
    await expect(
      page.getByRole('application', { name: 'Design canvas', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath('creative-instance-reload.png'),
      fullPage: true,
    });
  });
  test('#616 stale/permission rejection and shared definition apply affects both candidates', async ({
    page,
  }, info) => {
    await host(page);
    const before = await read(page);
    await page.getByLabel('Creative scope', { exact: true }).selectOption('shared');
    await preview(page, 'eyes');
    await click(page, 'Host edit base');
    const changed = await read(page);
    await click(page, 'Apply change');
    await expect(page.getByRole('alert')).toContainText(/draft changed/i);
    expect(await read(page)).toEqual(changed);
    await click(page, 'Host undo');
    expect(await read(page)).toEqual(before);
    await preview(page, 'eyes');
    await page.getByLabel('Host read only', { exact: true }).check();
    await click(page, 'Apply change');
    await expect(page.getByRole('alert')).toContainText(/read.only/i);
    expect(await read(page)).toEqual(before);
    await page.getByLabel('Host read only', { exact: true }).uncheck();
    await expect(page.getByLabel('Qualified changed parts', { exact: true })).toHaveText(
      JSON.stringify([creativeDesignAddressKey({ componentId: 'person', elementId: 'eyes' })]),
    );
    await page.screenshot({
      path: info.outputPath('creative-shared-preview.png'),
      fullPage: true,
    });
    await click(page, 'Apply change');
    const shared = await read(page);
    expect(
      shared.components[0].elements.find((element: { id: string }) => element.id === 'eyes').fill,
    ).toBe('#ee7733');
    expect(shared.elements).toEqual(before.elements);
    // Both independently projected candidates render the changed shared fill.
    const canvas = page.getByRole('application', {
      name: 'Design canvas',
      exact: true,
    });
    await expect(canvas.locator('path[fill="#ee7733"]')).toHaveCount(2);
    await click(page, 'Host undo');
    expect(await read(page)).toEqual(before);
    await click(page, 'Host redo');
    expect(await read(page)).toEqual(shared);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath('creative-shared-applied.png'),
      fullPage: true,
    });
  });
}
