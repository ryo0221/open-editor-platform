import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import { expect } from './fixtures';

const bundle = build({
  entryPoints: ['tests/fixtures/fiction-map-r0/host.tsx'],
  bundle: true,
  write: false,
  outdir: '/tmp/fiction-map-r0',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
}).then((result) => ({
  js: result.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
  css: result.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
}));
export async function mount(page: Page) {
  const output = await bundle;
  await page.route('**/r0-map.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: output.js }),
  );
  await page.route('**/r0-map.css', (route) =>
    route.fulfill({ contentType: 'text/css', body: output.css }),
  );
  await page.route('**/r0-map', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/r0-map.css"></head><body style="margin:0"><div id="root"></div><script src="/r0-map.js"></script></body></html>',
    }),
  );
  await page.goto('/r0-map');
  await expect(page.getByRole('application', { name: 'R0 map probe' })).toBeVisible();
}
export async function native(page: Page) {
  return JSON.parse((await page.getByTestId('native').textContent())!) as {
    features: {
      id: string;
      kind: string;
      points: { x: number; y: number }[];
      hidden?: boolean;
      locked?: boolean;
    }[];
  };
}
export function svgPoints(points: string | null) {
  if (!points) throw new Error('Missing SVG points');
  return points
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
}
export async function revision(page: Page) {
  return Number(await page.getByTestId('revision').textContent());
}
export function feature(data: Awaited<ReturnType<typeof native>>, id: string) {
  return data.features.find((f) => f.id === id)!;
}
export async function screenPoint(page: Page, featureId: string, x: number, y: number) {
  return page.getByTestId('shape-' + featureId).evaluate(
    (node, local) => {
      const matrix = (node as SVGGraphicsElement).getScreenCTM()!;
      const point = new DOMPoint(local.x, local.y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    },
    { x, y },
  );
}
export async function clickAt(page: Page, id: string, x: number, y: number) {
  const p = await screenPoint(page, id, x, y);
  await page.mouse.click(p.x, p.y);
}
export async function dragFrom(page: Page, p: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 7 });
  await page.mouse.up();
}

/** Shared desktop/390px regression: focus without clicking must not renew pointer preconditions. */
export async function outsideReleaseThenNudge(page: Page, screenshot: string) {
  await mount(page);
  await page.getByRole('button', { name: 'Select concave', exact: true }).click();
  const base = await native(page),
    rev = await revision(page);
  const p = await screenPoint(page, 'concave', 290, 170);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 20, p.y + 15, { steps: 4 });
  expect(svgPoints(await page.getByTestId('shape-concave').getAttribute('points'))).not.toEqual(
    feature(base, 'concave').points,
  );
  expect(await native(page)).toEqual(base);
  await page
    .getByRole('button', { name: 'External revision', exact: true })
    .evaluate((el) => (el as HTMLButtonElement).click());
  const updated = await native(page);
  expect(feature(updated, 'river').points).toEqual(
    feature(base, 'river').points.map((p) => ({ ...p, y: p.y + 5 })),
  );
  await expect
    .poll(async () => svgPoints(await page.getByTestId('shape-concave').getAttribute('points')))
    .toEqual(feature(updated, 'concave').points);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('*')].some((el) => el.hasPointerCapture(1)),
    ),
  ).toBe(false);
  await page.evaluate(() => {
    const host = document.querySelector('[data-testid="stage-host"]')!;
    window.addEventListener(
      'pointerup',
      (e) => {
        document.body.dataset.outsidePointerup = String(!host.contains(e.target as Node));
      },
      { capture: true, once: true },
    );
  });
  await page.mouse.move(5, page.viewportSize()!.height - 8);
  await page.mouse.up();
  await expect(page.locator('body')).toHaveAttribute('data-outside-pointerup', 'true');
  await expect(page.getByTestId('transform-requests')).toHaveText('0');
  expect(await native(page)).toEqual(updated);
  expect(await revision(page)).toBe(rev + 1);
  await page.getByRole('application').focus();
  await page.keyboard.press('ArrowRight');
  const nudged = await native(page);
  expect(await revision(page)).toBe(rev + 2);
  expect(feature(nudged, 'concave').points).toEqual(
    feature(updated, 'concave').points.map((p) => ({ ...p, x: p.x + 1 })),
  );
  await expect(page.getByTestId('error')).toHaveText('');
  await expect(page.getByTestId('transform-requests')).toHaveText('1');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(updated);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await native(page)).toEqual(nudged);
  await page.screenshot({ path: screenshot });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(base);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
}
