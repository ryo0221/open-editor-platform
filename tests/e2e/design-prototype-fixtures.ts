import { build } from 'esbuild';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { prototypeFixture } from '../fixtures/design-prototype/content';
import { designDrawings } from '@editor-platform/design/model';
let bundled: Promise<{ js: string; css: string }> | undefined;
export async function independentPrototype(
  page: Page,
  edit = false,
  options: { hostContracts?: boolean; legacy?: boolean } = {},
) {
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
  const params = new URLSearchParams(edit ? { edit: '1' } : { view: '1' });
  if (options.hostContracts) params.set('host-contracts', '1');
  if (options.legacy) params.set('legacy', '1');
  await page.goto(`/design-prototype-host?${params}`);
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

export async function assertStyledPrototypeVisibility(page: Page, info: TestInfo) {
  const initial = prototypeFixture();
  initial.styles = [{ id: 'hide', name: 'Hidden', appearance: { hidden: true } }];
  initial.elements.find((e) => e.id === 'Review')!.styleId = 'hide';
  await page.addInitScript((encoded) => {
    if (!sessionStorage.getItem('design-prototype-native'))
      sessionStorage.setItem('design-prototype-native', encoded);
  }, JSON.stringify(initial));
  await independentPrototype(page);
  const region = page.getByRole('region', { name: 'Design prototype', exact: true });
  const start = page.getByLabel('Prototype start frame', { exact: true });
  expect(
    await start.locator('option').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('value'))),
  ).not.toContain('Review');
  await expect(region.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Activate Continue', exact: true }).click();
  await expect(region.getByRole('alert')).toContainText('Frame is missing or hidden: Review');
  await expect(region.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await start.selectOption('State');
  await page.getByRole('button', { name: 'Activate Open dialog', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Overlay Dialog', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Activate Close dialog', exact: true }).click();
  await expect(region.getByRole('heading', { name: 'State', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await page.reload();
  expect(
    await start.locator('option').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('value'))),
  ).not.toContain('Review');
  expect(JSON.parse((await page.getByTestId('prototype-source').textContent())!)).toEqual(initial);
  await page.screenshot({ path: info.outputPath('styled-hidden-prototype.png') });
}

export async function assertStyledPrototypeTransform(page: Page, info: TestInfo) {
  const initial = prototypeFixture();
  initial.components[0].elements![1].bounds = { x: 10, y: 5, width: 90, height: 30 };
  initial.styles = [
    { id: 'transform', name: 'Transform', appearance: { rotation: 90, flipX: true } },
  ];
  const instance = initial.elements.find((e) => e.id === 'next/instance')!;
  instance.styleId = 'transform';
  const drawing = designDrawings(initial, instance).find((d) => d.text === 'Continue')!;
  await page.addInitScript((encoded) => {
    sessionStorage.setItem('design-prototype-native', encoded);
  }, JSON.stringify(initial));
  await independentPrototype(page);
  const region = page.getByRole('region', { name: 'Design prototype', exact: true });
  const svg = region.locator('svg[data-prototype-active="true"]').first();
  const angle = ((drawing.rotation ?? 0) * Math.PI) / 180;
  const world = {
    x: drawing.bounds.x + drawing.bounds.width / 2 + Math.cos(angle) * drawing.bounds.width * 0.3,
    y: drawing.bounds.y + drawing.bounds.height / 2 + Math.sin(angle) * drawing.bounds.width * 0.3,
  };
  const point = await svg.evaluate((svg, world) => {
    const p = new DOMPoint(world.x, world.y).matrixTransform(
      (svg as SVGSVGElement).getScreenCTM()!,
    );
    return { x: p.x, y: p.y };
  }, world);
  const press = () =>
    info.project.name === 'mobile'
      ? page.touchscreen.tap(point.x, point.y)
      : page.mouse.click(point.x, point.y);
  await page.getByRole('button', { name: 'Annotate prototype', exact: true }).click();
  await press();
  const anchor = JSON.parse((await page.getByTestId('prototype-anchor').textContent())!);
  expect(anchor).toMatchObject({
    elementId: instance.id,
    region: { type: 'canvas', ...drawing.bounds },
  });
  await page.getByRole('button', { name: 'Annotate prototype', exact: true }).click();
  await press();
  await expect(region.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
  expect(JSON.parse((await page.getByTestId('prototype-source').textContent())!)).toEqual(initial);
  await page.screenshot({ path: info.outputPath('styled-transform-hotspot.png') });
}
