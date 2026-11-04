import { test, expect } from '../e2e/fixtures';
import type { Page } from '@playwright/test';
import type { FictionMapContent } from '@editor-platform/fiction-map/model';
async function native(page: Page): Promise<FictionMapContent> {
  return JSON.parse((await page.getByTestId('native').textContent())!);
}
async function revision(page: Page) {
  return (await page.getByTestId('revision').textContent())!;
}
async function xy(page: Page, x: number, y: number) {
  return page.locator('[data-fiction-world]').evaluate(
    (el, p) => {
      const m = (el as SVGGElement).getScreenCTM()!;
      const axis = new URLSearchParams(location.search).get('axis');
      const q = new DOMPoint(p.x, axis === 'up' ? -p.y : p.y).matrixTransform(m);
      return { x: q.x, y: q.y };
    },
    { x, y },
  );
}
async function visiblePoint(page: Page, x: number, y: number) {
  let p = await xy(page, x, y);
  const height = page.viewportSize()!.height;
  if (p.y < 20 || p.y > height - 20) {
    await page.evaluate(({ y, h }) => window.scrollBy(0, y - h / 2), { y: p.y, h: height });
    p = await xy(page, x, y);
  }
  return p;
}
async function clickWorld(page: Page, x: number, y: number) {
  const p = await visiblePoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}
async function details(page: Page) {
  const b = page.getByRole('button', { name: 'Layers and inspector', exact: true });
  if (!(await page.getByLabel('Map details').isVisible())) await b.click();
}
async function feature(page: Page, name: string) {
  await details(page);
  await page.locator('.fm-features').getByRole('button', { name, exact: true }).click();
}
async function select(page: Page, ids: string[]) {
  await expect(page.getByTestId('selection')).toHaveText(JSON.stringify(ids));
}
async function dragStart(page: Page, x: number, y: number, dx: number, dy: number) {
  const p = await visiblePoint(page, x, y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 5 });
  return p;
}
async function host(page: Page) {
  if (!(await page.getByRole('button', { name: 'External native update' }).isVisible()))
    await page.getByText('Host test controls', { exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
});

test('rendered shapes, concave empty space, label owner and overlap order', async ({ page }) => {
  await clickWorld(page, 210, 210);
  await select(page, []);
  await clickWorld(page, 80, 95);
  await select(page, ['overlap']);
  await details(page);
  const overlap = page.getByRole('region', { name: 'Overlapping features' }); // section uses aria-label, accessible region
  await expect(overlap.getByRole('button').first()).toContainText('Harbor');
  await overlap.getByRole('button').filter({ hasText: 'Cape' }).click();
  await select(page, ['region']);
  await page.locator('[data-fiction-label="town"]').click();
  await select(page, ['town']);
  const before = await native(page),
    r = await revision(page);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(r);
});
test('AABB marquee remains explicit and differs from exact concave click', async ({ page }) => {
  await clickWorld(page, 210, 210);
  await select(page, []);
  const a = await xy(page, 35, 45),
    b = await xy(page, 275, 275);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await select(page, ['region', 'overlap']);
  await expect(page.locator('.fm-hint')).toContainText('bounding boxes');
});
test('create place, path and explicitly closed region through one local history', async ({
  page,
}) => {
  const before = await native(page);
  await page.getByRole('button', { name: 'Add place', exact: true }).click();
  await clickWorld(page, 430, 290);
  await expect
    .poll(async () => (await native(page)).features.length)
    .toBe(before.features.length + 1);
  await page.getByRole('button', { name: 'Draw path', exact: true }).click();
  await clickWorld(page, 280, 310);
  await clickWorld(page, 440, 330);
  await page.getByRole('button', { name: 'Finish shape', exact: true }).click();
  await page.getByRole('button', { name: 'Draw region', exact: true }).click();
  for (const p of [
    [200, 280],
    [260, 280],
    [230, 340],
  ])
    await clickWorld(page, p[0], p[1]);
  await page.getByRole('button', { name: 'Finish shape', exact: true }).click();
  const after = await native(page);
  expect(after.features).toHaveLength(7);
  const g = after.features[6].geometry;
  expect(g.type).toBe('polygon');
  if (g.type === 'polygon') expect(g.outer[0]).toEqual(g.outer.at(-1));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).features).toHaveLength(6);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await native(page)).toEqual(after);
});
test('invalid ring and cancelled tap never change native, history or revision', async ({
  page,
}) => {
  const before = await native(page),
    r = await revision(page),
    h = await page.getByTestId('history').textContent();
  await page.getByRole('button', { name: 'Draw region', exact: true }).click();
  for (const p of [
    [300, 300],
    [440, 360],
    [300, 360],
    [440, 300],
  ])
    await clickWorld(page, p[0], p[1]);
  await page.getByRole('button', { name: 'Finish shape', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveAttribute('data-diagnostic-code', 'invalid-geometry');
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(r);
  expect(await page.getByTestId('history').textContent()).toBe(h);
  await page.getByRole('button', { name: 'Cancel drawing', exact: true }).click();
  await page.getByRole('button', { name: 'Add place', exact: true }).click();
  const p = await xy(page, 400, 300);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page
    .locator('[data-fiction-draw]')
    .dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
  await page.mouse.up();
  expect(await native(page)).toEqual(before);
});
test('move preview is private, commit once, outside pointerup then Arrow and Undo', async ({
  page,
}) => {
  const before = await native(page),
    r = await revision(page);
  await dragStart(page, 340, 260, 24, 16);
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(r);
  await page.mouse.up();
  const moved = await native(page);
  expect(moved).not.toEqual(before);
  expect(moved.features[3].worldEntityRef).toEqual(before.features[3].worldEntityRef);
  expect(moved.features[3].id).toBe('town');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await native(page)).toEqual(moved);
  const town = moved.features[3].geometry;
  if (town.type !== 'point') throw Error('point');
  const p = await xy(page, ...town.coordinates);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(-10, p.y, { steps: 5 });
  await page.mouse.up(); // invalid out-of-document move may reject; keyboard must use latest base.
  const current = await native(page);
  await page.getByRole('application', { name: 'Fiction Map canvas' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => JSON.stringify(await native(page)))
    .not.toBe(JSON.stringify(current));
  await page.keyboard.press('Control+z');
  expect(await native(page)).toEqual(current);
});
test('revision change cancels nonempty object preview before pointerup, keeps external update', async ({
  page,
}) => {
  await host(page);
  await dragStart(page, 340, 260, 32, 20);
  await page
    .getByRole('button', { name: 'External native update' })
    .evaluate((e: HTMLButtonElement) => e.click());
  await expect.poll(async () => (await native(page)).features[3].name).toBe('External port');
  const after = await native(page),
    r = await revision(page);
  const p = await xy(page, 380, 280);
  await expect
    .poll(async () =>
      page.locator('[data-fiction-feature="town"] circle').evaluate((el) => {
        const p = new DOMPoint(
          Number(el.getAttribute('cx')),
          Number(el.getAttribute('cy')),
        ).matrixTransform((el as SVGGraphicsElement).getScreenCTM()!);
        return p.x;
      }),
    )
    .toBeCloseTo(p.x, 4);
  await page.mouse.up();
  expect(await native(page)).toEqual(after);
  expect(await revision(page)).toBe(r);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).features[3].name).toBe('Port');
});
test('same revision render and camera update preserve object gesture', async ({ page }) => {
  await host(page);
  const r = await revision(page);
  await dragStart(page, 340, 260, 24, 12);
  await page
    .getByRole('button', { name: 'Same revision render' })
    .evaluate((e: HTMLButtonElement) => e.click());
  expect(await revision(page)).toBe(r);
  await page
    .getByRole('button', { name: 'Camera update' })
    .evaluate((e: HTMLButtonElement) => e.click());
  expect(await revision(page)).toBe(r);
  await page.mouse.up();
  expect(await revision(page)).not.toBe(r);
  await expect(page.getByTestId('host-status')).toHaveText('Changed');
});
test('readOnly and locking cancel object edit, preserve selection and allow fresh move after unlock', async ({
  page,
}) => {
  await host(page);
  const before = await native(page),
    r = await revision(page);
  await dragStart(page, 340, 260, 30, 20);
  await page.getByLabel('Host read only').evaluate((e: HTMLInputElement) => e.click());
  await page.mouse.up();
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(r);
  await select(page, ['town']);
  await page.getByLabel('Host read only').uncheck();
  await page.getByRole('button', { name: 'Toggle selected lock' }).click();
  await page.getByRole('application').focus();
  await page.keyboard.press('ArrowRight');
  expect(await native(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Edit vertices', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Toggle selected lock' }).click();
  await page.getByRole('application').focus();
  await page.keyboard.press('ArrowRight');
  expect(await native(page)).not.toEqual(before);
  await expect(page.getByRole('button', { name: /Resize/ })).toHaveCount(0);
});
test('vertex first/closure commit, Undo, revision cancellation and nudge remain separate', async ({
  page,
}) => {
  await feature(page, 'Cape');
  const before = await native(page);
  await page.getByRole('button', { name: 'Edit vertices', exact: true }).click();
  const h = page.getByRole('button', { name: 'Vertex 1 of Cape', exact: true });
  const box = (await h.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2 + 5, { steps: 5 });
  expect(await native(page)).toEqual(before);
  await page.mouse.up();
  const after = await native(page),
    g = after.features[0].geometry;
  if (g.type !== 'polygon') throw Error('polygon');
  expect(g.outer[0]).toEqual(g.outer.at(-1));
  expect(g).not.toEqual(before.features[0].geometry);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(before);
  await host(page);
  const b = (await h.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 20, b.y + b.height / 2 + 10);
  await page
    .getByRole('button', { name: 'External native update' })
    .evaluate((e: HTMLButtonElement) => e.click());
  const external = await native(page);
  await page.mouse.up();
  expect(await native(page)).toEqual(external);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('application').focus();
  await page.keyboard.press('ArrowRight');
  expect((await native(page)).features[0].geometry).not.toEqual(before.features[0].geometry);
  await page.keyboard.press('Control+z');
  expect(await native(page)).toEqual(external);
});
test('Inspector IME guard, stable IDs/refs and stale draft rejection preserve focus and camera', async ({
  page,
}) => {
  await feature(page, 'Port');
  const before = await native(page),
    r = await revision(page),
    v = await page.getByTestId('view').textContent(),
    input = page.getByLabel('Feature name', { exact: true });
  await input.fill('港');
  await input.dispatchEvent('compositionstart');
  expect(
    await input.evaluate((el) => {
      const e = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    }),
  ).toBe(false);
  await input.press('Enter');
  expect(await revision(page)).toBe(r);
  await input.dispatchEvent('compositionend');
  await page.getByRole('button', { name: 'Apply feature', exact: true }).click();
  const after = await native(page);
  expect(after.features[3]).toEqual({ ...before.features[3], name: '港' });
  expect(await page.getByTestId('view').textContent()).toBe(v);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(before);
  await input.fill('Local pending');
  await host(page);
  await input.focus();
  await page
    .getByRole('button', { name: 'External native update' })
    .evaluate((e: HTMLButtonElement) => e.click());
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Local pending');
  const external = await native(page);
  await page.getByRole('button', { name: 'Apply feature', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveAttribute('data-diagnostic-code', 'stale-revision');
  expect(await native(page)).toEqual(external);
  await page.getByRole('button', { name: 'Cancel edits', exact: true }).click();
  await expect(input).toHaveValue('External port');
});
test('local layer visibility does not edit native/history and removes label/geometry hits', async ({
  page,
}) => {
  await details(page);
  const before = await native(page),
    r = await revision(page);
  await page.getByLabel('Places', { exact: true }).uncheck();
  await expect(page.locator('[data-fiction-feature="town"]')).toHaveCount(0);
  await clickWorld(page, 340, 260);
  await select(page, []);
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(r);
  await page.getByLabel('Places', { exact: true }).check();
  await clickWorld(page, 340, 260);
  await select(page, ['town']);
});
test('narrow layout, accessible controls and screenshot', async ({ page }, testInfo) => {
  await feature(page, 'Port');
  await expect(page.getByLabel('Feature name', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: `/tmp/fiction-map-d2/${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test('y-up projection keeps moves and creation in native axis, CSS-width line hits at zoom', async ({
  page,
}) => {
  await page.goto('/?axis=up');
  await clickWorld(page, 400, 80);
  await select(page, ['road']);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await clickWorld(page, 340, 260);
  await select(page, ['town']);
  const before = await native(page);
  await dragStart(page, 340, 260, 10, 10);
  await page.mouse.up();
  const g = (await native(page)).features[3].geometry,
    old = before.features[3].geometry;
  if (g.type !== 'point' || old.type !== 'point') throw Error('point');
  expect(g.coordinates[1]).toBeLessThan(old.coordinates[1]);
});

test('Escape cancels private drawing from focused Canvas without creating native', async ({
  page,
}) => {
  const before = await native(page),
    r = await revision(page);
  await page.getByRole('button', { name: 'Draw path', exact: true }).click();
  await clickWorld(page, 300, 300);
  await clickWorld(page, 400, 300);
  await page.getByRole('application').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByText('2 draft vertices', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(r);
});
test('mixed locked controlled selection rejects the whole nudge, no partial edit', async ({
  page,
}) => {
  await feature(page, 'Port');
  await host(page);
  await page.getByRole('button', { name: 'Toggle selected lock' }).click();
  await page.getByRole('button', { name: 'Select all from Host' }).click();
  const before = await native(page),
    r = await revision(page);
  await page.getByRole('application').focus();
  await page.keyboard.press('ArrowRight');
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(r);
  await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled();
});
test('session replacement cancels preview and old events cannot commit', async ({ page }) => {
  await host(page);
  await dragStart(page, 340, 260, 20, 10);
  const before = await native(page),
    old = await revision(page);
  await page
    .getByRole('button', { name: 'Replace session' })
    .evaluate((e: HTMLButtonElement) => e.click());
  const next = await revision(page);
  expect(next).not.toBe(old);
  await page.mouse.up();
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(next);
  await dragStart(page, 340, 260, 20, 10);
  await page.mouse.up();
  expect(await native(page)).not.toEqual(before);
});
test('text Arrow/Delete stay in the input, invalid numeric bounds and delete are atomic', async ({
  page,
}) => {
  await feature(page, 'Port');
  const before = await native(page),
    r = await revision(page),
    name = page.getByLabel('Feature name', { exact: true });
  await name.focus();
  await name.press('ArrowLeft');
  await name.press('Delete');
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(r);
  await page.getByRole('button', { name: 'Cancel edits', exact: true }).click();
  await page.getByLabel('Feature x', { exact: true }).fill('1048577');
  await page.getByRole('button', { name: 'Apply feature', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveAttribute(
    'data-diagnostic-code',
    'coordinate-out-of-range',
  );
  expect(await native(page)).toEqual(before);
  await page.getByRole('button', { name: 'Cancel edits', exact: true }).click();
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click();
  expect((await native(page)).features.some((f) => f.id === 'town')).toBe(false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(before);
});
test('new layer IME guard and explicit apply use the same history', async ({ page }) => {
  await details(page);
  const before = await native(page),
    r = await revision(page),
    input = page.getByLabel('New layer name', { exact: true });
  await input.fill('注記');
  await input.dispatchEvent('compositionstart');
  expect(
    await input.evaluate((el) => {
      const e = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    }),
  ).toBe(false);
  await input.press('Enter');
  expect(await revision(page)).toBe(r);
  await input.dispatchEvent('compositionend');
  // Legacy IME may omit keyup. A new explicit pointer action must not stay blocked.
  await input.dispatchEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true });
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  expect((await native(page)).layers).toHaveLength(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(before);
});

test('rendered CSS stroke boundary matches explicit world query at multiple zooms', async ({
  page,
}) => {
  for (let i = 0; i < 3; i++) {
    const origin = await xy(page, 400, 80),
      m = await page.locator('[data-fiction-world]').evaluate((el) => {
        const m = (el as SVGGElement).getScreenCTM()!;
        return Math.hypot(m.a, m.b);
      });
    await clickWorld(page, 400, 80 + 3 / m);
    await select(page, ['road']);
    await clickWorld(page, 400, 80 + 6 / m);
    await select(page, []);
    expect(origin.x).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  }
});

test('keyboard vertex nudge has one native Undo and keeps explicit closure', async ({ page }) => {
  await feature(page, 'Cape');
  await page.getByRole('button', { name: 'Edit vertices', exact: true }).click();
  const before = await native(page),
    h = page.getByRole('button', { name: 'Vertex 1 of Cape', exact: true });
  await h.focus();
  await h.press('ArrowRight');
  const g = (await native(page)).features[0].geometry;
  if (g.type !== 'polygon') throw Error('polygon');
  expect(g.outer[0]).toEqual([51, 60]);
  expect(g.outer.at(-1)).toEqual([51, 60]);
  await h.press('Control+z');
  expect(await native(page)).toEqual(before);
});

test('Host selection change cancels a vertex drag without editing the new feature', async ({
  page,
}) => {
  await feature(page, 'Cape');
  await page.getByRole('button', { name: 'Edit vertices', exact: true }).click();
  await host(page);
  const h = page.getByRole('button', { name: 'Vertex 1 of Cape', exact: true }),
    b = (await h.boundingBox())!;
  const before = await native(page),
    r = await revision(page),
    painted = await page.locator('[data-fiction-feature="overlap"] polygon').getAttribute('points');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2 + 20, { steps: 5 });
  await page
    .getByRole('button', { name: 'Select Harbor from Host' })
    .evaluate((el: HTMLButtonElement) => el.click());
  await select(page, ['overlap']);
  await expect(page.locator('[data-fiction-feature="overlap"] polygon')).toHaveAttribute(
    'points',
    painted!,
  );
  await expect
    .poll(() =>
      page
        .getByRole('button', { name: 'Vertex 1 of Harbor', exact: true })
        .evaluate((el) => el.hasPointerCapture(1)),
    )
    .toBe(false);
  await page.mouse.up();
  expect(await native(page)).toEqual(before);
  expect(await revision(page)).toBe(r);
  const fresh = page.getByRole('button', { name: 'Vertex 1 of Harbor', exact: true }),
    f = (await fresh.boundingBox())!;
  await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
  await page.mouse.down();
  await page.mouse.move(f.x + f.width / 2 + 15, f.y + f.height / 2 + 10, { steps: 5 });
  await page.mouse.up();
  const after = await native(page);
  expect(after.features[0]).toEqual(before.features[0]);
  expect(after.features[1].geometry).not.toEqual(before.features[1].geometry);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(before);
});
test('axis-aligned path preview stays finite and translates without inventing extents', async ({
  page,
}) => {
  await host(page);
  await page.getByRole('button', { name: 'Add axis paths' }).click();
  for (const [id, x, y] of [
    ['horizontal', 380, 300],
    ['vertical', 550, 280],
  ] as const) {
    // Capture baseline after bringing the drag point into the viewport.
    await visiblePoint(page, x, y);
    const shape = page.locator(`[data-fiction-feature="${id}"] polyline`),
      before = await native(page),
      start = (await shape.boundingBox())!;
    await dragStart(page, x, y, 24, 16);
    const preview = (await shape.boundingBox())!;
    expect(preview.x - start.x).toBeCloseTo(24, 3);
    expect(preview.y - start.y).toBeCloseTo(16, 3);
    await expect(shape.locator('..')).not.toHaveAttribute('transform', /NaN|Infinity/);
    expect(await native(page)).toEqual(before);
    await page.mouse.up();
    expect((await native(page)).features.find((f) => f.id === id)!.geometry).not.toEqual(
      before.features.find((f) => f.id === id)!.geometry,
    );
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await native(page)).toEqual(before);
  }
});

test('creation falls back from a hidden active layer to a visible layer', async ({ page }) => {
  await details(page);
  await page.getByRole('button', { name: 'Draw on Terrain', exact: true }).click();
  const before = await native(page),
    r = await revision(page);
  await page.getByLabel('Terrain', { exact: true }).uncheck();
  expect(await revision(page)).toBe(r);
  expect(await native(page)).toEqual(before);
  await page.getByRole('button', { name: 'Add place', exact: true }).click();
  await clickWorld(page, 420, 300);
  await expect.poll(async () => (await native(page)).features.length).toBe(5);
  expect((await native(page)).features.at(-1)!.layerId).toBe('places');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(before);
  await page.getByLabel('Places', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Add place', exact: true })).toBeDisabled();
});

test('Host feature change drops the old vertex focus and requires a fresh point selection', async ({
  page,
}) => {
  await host(page);
  await feature(page, 'Cape');
  await page.getByRole('button', { name: 'Edit vertices', exact: true }).click();
  const cape = page.getByRole('button', { name: 'Vertex 1 of Cape', exact: true });
  await cape.focus();
  await expect(cape).toBeFocused();
  await expect(cape).toHaveAttribute('aria-pressed', 'true');
  const before = await native(page),
    r = await revision(page),
    history = await page.getByTestId('history').textContent();
  await page
    .getByRole('button', { name: 'Select Harbor from Host' })
    .evaluate((el: HTMLButtonElement) => el.click());
  await select(page, ['overlap']);
  const oldFocus = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  // Page keyboard deliberately avoids focusing/selecting the new handle for us.
  await page.keyboard.press('ArrowRight');
  expect(await native(page), `No new vertex selected; retained focus: ${oldFocus}`).toEqual(before);
  expect(await revision(page)).toBe(r);
  expect(await page.getByTestId('history').textContent()).toBe(history);
  const harbor = page.getByRole('button', { name: 'Vertex 1 of Harbor', exact: true });
  await expect(harbor).not.toBeFocused();
  await expect(harbor).toHaveAttribute('aria-pressed', 'false');
  await harbor.focus();
  await expect(harbor).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowRight');
  const changed = await native(page),
    g = changed.features[1].geometry;
  expect(changed.features[0]).toEqual(before.features[0]);
  if (g.type !== 'polygon') throw Error('polygon');
  expect(g.outer[0]).toEqual([71, 80]);
  expect(g.outer.at(-1)).toEqual([71, 80]);
  expect(JSON.parse(await revision(page)).sequence).toBe(JSON.parse(r).sequence + 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await native(page)).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await native(page)).toEqual(changed);
});
