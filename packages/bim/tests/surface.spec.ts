import { expect, test, type Page } from '@playwright/test';

// The building Surface's test host (R2c-3c). Needs the development kernel (CAD_OCCT_DIST).
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const modelState = (page: Page) => page.getByTestId('bim-model-state');
const ready = (page: Page) => expect(modelState(page)).toHaveText('Model up to date');
const elements = (page: Page) => page.getByRole('navigation', { name: 'Elements' });
const inspector = (page: Page) => page.locator('.bim-inspector');
/** Opens a side panel that a narrow layout keeps closed. */
async function panel(page: Page, name: 'Elements' | 'Inspector') {
  const region = name === 'Elements' ? elements(page) : inspector(page);
  if (!(await region.isVisible()))
    await page.getByRole('button', { name: `Toggle ${name}`, exact: true }).click();
}
/** A toolbar button, from the overflow menu on a compact toolbar. */
async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  return button;
}
const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { bimController: { state: Record<string, never> } })
      .bimController.state as unknown as {
      selection: string[];
      evaluation?: {
        sent: { solids: number };
        elements: Map<string, { status: string; code?: string; measure?: { volumeMm3: number } }>;
      };
    };
    return {
      selection: s.selection,
      sent: s.evaluation?.sent,
      elements: Object.fromEntries(
        [...(s.evaluation?.elements ?? [])].map(([id, r]) => [
          id,
          { status: r.status, code: r.code, volume: r.measure?.volumeMm3 },
        ]),
      ),
    };
  });

test('selects an element from the list and the view, edits it, and undoes the edit', async ({
  page,
}) => {
  await page.goto('/?fixture=box');
  await ready(page);
  await panel(page, 'Elements');
  await elements(page).getByRole('button', { name: 'w-south', exact: true }).click();
  await panel(page, 'Inspector');
  await expect(inspector(page)).toContainText('wall · w-south');
  // Analytic quantities of the 10,000 mm wall.
  await expect(inspector(page).locator('.bim-quantities')).toContainText('Length (mm)');
  const name = inspector(page).getByLabel('Name', { exact: true });
  await name.fill('South wall');
  await name.press('Enter');
  await ready(page);
  await panel(page, 'Elements');
  await expect(elements(page).getByRole('button', { name: 'South wall' })).toBeVisible();
  await (await tool(page, 'Undo')).click();
  await expect(elements(page).getByRole('button', { name: 'w-south', exact: true })).toBeVisible();

  // A click in the 3D view selects the element under the pointer; a click on nothing clears.
  // A narrow layout lays the toolbar menu and the panels over the view: close them first.
  await page.keyboard.press('Escape');
  for (const name of ['Elements', 'Inspector']) {
    const close = page.getByRole('button', { name: `Close ${name}`, exact: true });
    if (test.info().project.name !== 'desktop' && (await close.isVisible())) await close.click();
  }
  await (await tool(page, 'Fit view')).click();
  const view = page.getByTestId('bim-viewport');
  const box = (await view.boundingBox())!;
  await view.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect.poll(async () => (await state(page)).selection.length).toBe(1);
  await view.click({ position: { x: 4, y: box.height - 4 } });
  await expect.poll(async () => (await state(page)).selection.length).toBe(0);
});

test('a type edit rebuilds the shared solid and the walls it opens', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?fixture=box');
  await ready(page);
  await inspector(page).getByRole('tab', { name: 'Types' }).click();
  await inspector(page)
    .getByRole('button', { name: /^Window 1800/ })
    .click();
  const width = inspector(page).getByLabel('Width (mm)', { exact: true });
  await width.fill('1200');
  await width.press('Enter');
  await ready(page);
  const s = await state(page);
  // The window solid and the two walls with windows (north, east).
  expect(s.sent!.solids).toBe(3);
  expect(s.elements['win-n1']!.volume).toBeCloseTo(1200 * 1500 * 50, 3);
});

test('names a refused edit and changes nothing', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?fixture=box');
  await ready(page);
  await elements(page).getByRole('button', { name: 'win-e1', exact: true }).click();
  const along = inspector(page).getByLabel('Position along wall (mm)', { exact: true });
  await along.fill('50000');
  await along.press('Enter');
  await expect(inspector(page).locator('.bim-notice')).toContainText(
    'Refused: opening-outside-host',
  );
  const applied = await page.evaluate(() => 'bimApplied' in window);
  expect(applied).toBe(false);
});

test('a cascade delete applies only to the delete it was offered for', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?fixture=box');
  await ready(page);
  await elements(page).getByRole('button', { name: 'w-east', exact: true }).click();
  await inspector(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(inspector(page).locator('.bim-notice')).toContainText('Refused: in-use');
  await expect(inspector(page).getByRole('button', { name: /Delete with/ })).toBeVisible();
  // Another element: the offer goes with the refusal.
  await elements(page).getByRole('button', { name: 'w-north', exact: true }).click();
  await expect(inspector(page).getByRole('button', { name: /Delete with/ })).toHaveCount(0);
  await expect(inspector(page).locator('.bim-notice')).toHaveCount(0);
});

test('unchecking a property stores false, not nothing', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?fixture=box');
  await ready(page);
  // The wall type is external; its wall is not marked: mark it, then unmark it.
  await elements(page).getByRole('button', { name: 'w-south', exact: true }).click();
  const external = inspector(page).getByLabel('External', { exact: true });
  await external.check();
  await external.uncheck();
  const common = await page.evaluate(
    () =>
      (
        window as unknown as {
          bimController: { state: { content: { elements: { id: string; common?: unknown }[] } } };
        }
      ).bimController.state.content.elements.find((e) => e.id === 'w-south')!.common,
  );
  expect(common).toEqual({ isExternal: false });
});

test('read only: values are shown, never edited', async ({ page }) => {
  await page.goto('/?fixture=box&readonly=1');
  await ready(page);
  // The level and its grid axes: shown, never added to or deleted.
  await panel(page, 'Inspector');
  await expect(inspector(page)).toContainText('Level name 1F');
  await expect(inspector(page).getByRole('button', { name: /Add level|Delete/ })).toHaveCount(0);
  // Views are not added in view mode.
  await inspector(page).getByRole('tab', { name: 'Drawings' }).click();
  await expect(inspector(page).getByRole('button', { name: /Add plan/ })).toHaveCount(0);
  await inspector(page).getByRole('tab', { name: 'Element' }).click();
  await panel(page, 'Elements');
  await elements(page).getByRole('button', { name: 'd-entrance', exact: true }).click();
  await panel(page, 'Inspector');
  await expect(inspector(page)).toContainText('door · d-entrance');
  await expect(inspector(page).locator('input:not([type=checkbox])')).toHaveCount(0);
  await expect(inspector(page).locator('input[type=checkbox]:not([disabled])')).toHaveCount(0);
  await expect(inspector(page).getByRole('combobox')).toBeDisabled();
  await expect(inspector(page).getByRole('button', { name: /Delete/ })).toHaveCount(0);
  await expect(page.getByText('Read only')).toBeVisible();
});

test('without a kernel build every element is named, and editing still works', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?fixture=box&kernel=missing');
  await ready(page);
  await expect(page.getByText('13 not built')).toBeVisible();
  await expect(elements(page).getByText('kernel-build-unavailable').first()).toBeVisible();
  await elements(page)
    .getByRole('button', { name: /w-south/ })
    .click();
  const name = inspector(page).getByLabel('Name', { exact: true });
  await name.fill('South');
  await name.press('Enter');
  await expect(elements(page).getByRole('button', { name: /^South/ })).toBeVisible();
});

test('the office (F37) builds 766 elements from 45 solids', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?fixture=office');
  await ready(page);
  const s = await state(page);
  expect(Object.keys(s.elements)).toHaveLength(766);
  expect(Object.values(s.elements).every((r) => r.status === 'ok')).toBe(true);
  expect(s.sent!.solids).toBe(45);
  await page.screenshot({ path: test.info().outputPath('bim-office.png') });
});

/** A plan point (mm) of the starter's 1F plan as a page position: the empty plan frames 20 m. */
async function planAt(page: Page) {
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  const px = box.height / 2 / (20_000 * 0.65);
  return (x: number, y: number) =>
    [box.x + box.width / 2 + (x - 5_000) * px, box.y + box.height / 2 - (y - 5_000) * px] as const;
}

test('draws a room on the level plan: walls that join, a door and a slab, each one Undo step', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'drawing is closed on a narrow screen');
  await page.goto('/?fixture=starter');
  await ready(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Wall', exact: true }).click();
  await expect(page.getByTestId('bim-draft-hint')).toContainText('Wall: click the start');
  const at = await planAt(page);
  const room: [number, number][] = [
    [0, 0],
    [8_000, 0],
    [8_000, 6_000],
    [0, 6_000],
    [0, 0],
  ];
  for (const [x, y] of room) await page.mouse.click(...at(x, y));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Door', exact: true }).click();
  await page.mouse.click(...at(4_000, 0));
  await page.getByRole('button', { name: 'Slab', exact: true }).click();
  for (const [x, y] of room) await page.mouse.click(...at(x, y));
  await ready(page);
  const doc = await page.evaluate(() => {
    const s = (window as unknown as { bimController: { state: { content: unknown } } })
      .bimController.state.content as {
      elements: { id: string; kind: string; start?: { xy: number[] }; alongMm?: number }[];
      joins: unknown[];
    };
    return s;
  });
  expect(doc.elements.map((e) => e.kind)).toEqual(['wall', 'wall', 'wall', 'wall', 'door', 'slab']);
  expect(doc.elements.slice(0, 4).map((e) => e.start!.xy)).toEqual(room.slice(0, 4));
  // Every corner is joined.
  expect(doc.joins).toHaveLength(4);
  expect(doc.elements[4]!.alongMm).toBe(3_550);
  const s = await state(page);
  expect(Object.values(s.elements).every((r) => r.status === 'ok')).toBe(true);
  // One drawing is one Undo step: the slab goes, the door stays.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(elements(page).getByRole('button', { name: 's-1', exact: true })).toHaveCount(0);
  await expect(elements(page).getByRole('button', { name: 'd-1', exact: true })).toBeVisible();
  // A door away from every wall is refused and named.
  await page.getByRole('button', { name: 'Door', exact: true }).click();
  await page.mouse.click(...at(4_000, 3_000));
  await expect(inspector(page).locator('.bim-notice')).toContainText('no-wall-here');
  await page.screenshot({ path: test.info().outputPath('bim-plan.png') });
});

test('draws arc walls and an arc slab edge by three points (OH-U2)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'drawing is closed on a narrow screen');
  await page.goto('/?fixture=starter');
  await ready(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Wall', exact: true }).click();
  const arc = page.getByRole('button', { name: 'Arc', exact: true });
  await arc.click();
  await expect(arc).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('bim-draft-hint')).toContainText('then a point on the arc');
  const at = await planAt(page);
  // Start, end, a point on the arc; the run goes on from the end. The arc follows the pointer.
  await page.mouse.click(...at(0, 0));
  await page.mouse.click(...at(8_000, 0));
  await page.mouse.move(...at(4_000, -2_000));
  await page.screenshot({ path: test.info().outputPath('bim-arc-preview.png') });
  for (const [x, y] of [
    [4_000, -2_000],
    [8_000, 6_000],
    [10_000, 3_000],
  ] as const)
    await page.mouse.click(...at(x, y));
  await page.keyboard.press('Escape');
  // A slab: an arc edge, then Arc off for straight edges, closed on the first corner.
  await page.getByRole('button', { name: 'Slab', exact: true }).click();
  await expect(arc).toHaveAttribute('aria-pressed', 'true');
  for (const [x, y] of [
    [0, 0],
    [8_000, 0],
    [4_000, -2_000],
  ] as const)
    await page.mouse.click(...at(x, y));
  await arc.click();
  for (const [x, y] of [
    [8_000, 6_000],
    [0, 6_000],
    [0, 0],
  ] as const)
    await page.mouse.click(...at(x, y));
  // A space of one arc, then Arc off: a click on the first corner closes it by the chord.
  await page.getByRole('button', { name: 'Space', exact: true }).click();
  await arc.click();
  for (const [x, y] of [
    [-8_000, -4_000],
    [0, -4_000],
    [-4_000, -6_000],
  ] as const)
    await page.mouse.click(...at(x, y));
  await arc.click();
  await page.mouse.click(...at(-8_000, -4_000));
  await ready(page);
  const doc = await page.evaluate(
    () =>
      (window as unknown as { bimController: { state: { content: unknown } } }).bimController.state
        .content as {
        elements: {
          kind: string;
          start?: { xy: number[] };
          end?: { xy: number[] };
          bulge?: number;
          boundary?: number[][];
        }[];
      },
  );
  expect(doc.elements.map((e) => e.kind)).toEqual(['wall', 'wall', 'slab', 'space']);
  const [w1, w2, slab, space] = doc.elements;
  expect([w1!.start!.xy, w1!.end!.xy, w2!.start!.xy, w2!.end!.xy]).toEqual([
    [0, 0],
    [8_000, 0],
    [8_000, 0],
    [8_000, 6_000],
  ]);
  // Sagitta 2,000 over a half chord of 4,000 (counter-clockwise), and 2,000 over 3,000.
  expect(w1!.bulge).toBeCloseTo(0.5, 9);
  expect(w2!.bulge).toBeCloseTo(2 / 3, 9);
  expect(slab!.boundary!.map((v) => v.slice(0, 2))).toEqual([
    [0, 0],
    [8_000, 0],
    [8_000, 6_000],
    [0, 6_000],
  ]);
  expect(slab!.boundary![0]![2]).toBeCloseTo(0.5, 9);
  expect(slab!.boundary!.slice(1).every((v) => v.length === 2)).toBe(true);
  // The arc is split at its middle (a loop needs three corners); the chord closes it.
  expect(space!.boundary!.map((v) => v.slice(0, 2).map(Math.round))).toEqual([
    [-8_000, -4_000],
    [-4_000, -6_000],
    [0, -4_000],
  ]);
  expect(space!.boundary!.slice(0, 2).every((v) => (v[2] ?? 0) > 0)).toBe(true);
  expect(space!.boundary![2]!.length).toBe(2);
  const s = await state(page);
  expect(Object.values(s.elements).every((r) => r.status === 'ok')).toBe(true);
  await page.screenshot({ path: test.info().outputPath('bim-arcs.png') });
});

test('drawing is closed with its reason when read only or on a narrow screen', async ({ page }) => {
  const narrow = test.info().project.name !== 'desktop';
  await page.goto(narrow ? '/?fixture=box' : '/?fixture=box&readonly=1');
  await ready(page);
  await (await tool(page, 'Plan')).click();
  const wall = await tool(page, 'Wall');
  await expect(wall).toBeDisabled();
  await expect(wall).toHaveAttribute(
    'title',
    narrow ? /Drawing needs a wider screen/ : /Read only/,
  );
  if (narrow) {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('bim-draft-hint')).toContainText('Drawing is closed');
    // Values are still edited on a narrow screen.
    await panel(page, 'Elements');
    await elements(page).getByRole('button', { name: 'w-south', exact: true }).click();
    await panel(page, 'Inspector');
    await expect(inspector(page).getByLabel('Name', { exact: true })).toBeEditable();
  }
});

test('draws grid axes, stands a column on a crossing, moves the axis, and adds a level', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'drawing is closed on a narrow screen');
  await page.goto('/?fixture=starter');
  await ready(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Grid axis', exact: true }).click();
  const at = await planAt(page);
  for (const [x, y] of [
    [0, 0],
    [10_000, 0],
    [2_000, -2_000],
    [2_000, 8_000],
  ] as const)
    await page.mouse.click(...at(x, y));
  await page.getByRole('button', { name: 'Column', exact: true }).click();
  await page.mouse.click(...at(2_100, 100));
  await ready(page);
  const content = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            bimController: {
              state: { content: { grids: unknown[]; levels: unknown[]; elements: unknown[] } };
            };
          }
        ).bimController.state.content,
    );
  let doc = await content();
  expect(doc.grids).toMatchObject([
    { id: 'g-1', label: 'A', start: [0, 0], end: [10_000, 0] },
    { id: 'g-2', label: '1', start: [2_000, -2_000], end: [2_000, 8_000] },
  ]);
  expect(doc.elements).toMatchObject([{ kind: 'column', at: { grid: ['g-1', 'g-2'] } }]);

  // The axes can be hidden from the view and shown again.
  const viewport = page.getByTestId('bim-viewport');
  await expect(viewport).toHaveAttribute('data-axes', '2');
  const showAxes = elements(page).getByLabel('Show grid axes', { exact: true });
  await expect(elements(page)).toContainText('Grid axes (2)');
  await showAxes.uncheck();
  await expect(viewport).toHaveAttribute('data-axes', '0');
  await showAxes.check();
  await expect(viewport).toHaveAttribute('data-axes', '2');

  // The inspector of the level lists the axes; moving axis 1 moves the column with it.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const axes = inspector(page).getByRole('region', { name: 'Grid axes' });
  await axes.getByRole('button', { name: '1', exact: true }).click();
  for (const label of ['Start x (mm)', 'End x (mm)']) {
    const field = axes.getByLabel(label, { exact: true });
    await field.fill('3000');
    await field.press('Enter');
  }
  await ready(page);
  doc = await content();
  expect(doc.grids[1]).toMatchObject({ start: [3_000, -2_000], end: [3_000, 8_000] });
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  // In use: a plain delete is refused and names the column; only then is the cascade offered.
  await axes.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(inspector(page).locator('.bim-notice')).toContainText('in-use');
  await expect(axes.getByRole('button', { name: 'Delete with 1 dependent' })).toBeVisible();

  await inspector(page).getByRole('button', { name: 'Add level above', exact: true }).click();
  doc = await content();
  expect(doc.levels).toHaveLength(4);
  await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('4F');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await content()).levels).toHaveLength(3);

  // The column's place by numbers: on the crossing it names the axes; a typed X places it there.
  await elements(page).getByRole('button', { name: 'c-1', exact: true }).click();
  await expect(inspector(page).getByTestId('bim-on-grid')).toContainText('A and 1');
  const x = inspector(page).getByLabel('X (mm)', { exact: true });
  await expect(x).toHaveValue('3000');
  await expect(inspector(page).getByLabel('Y (mm)', { exact: true })).toHaveValue('0');
  await x.fill('4500');
  await x.press('Enter');
  await ready(page);
  expect((await content()).elements).toMatchObject([{ kind: 'column', at: { xy: [4_500, 0] } }]);
  await expect(inspector(page).getByTestId('bim-on-grid')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('bim-grid.png') });
});

test('a plan picks what it shows, and a double-click places one column', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'drawing is closed on a narrow screen');
  await page.goto('/?fixture=box');
  await ready(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  // The middle of the 1F plan: the floor slab, not the roof above the cut.
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await state(page)).selection).toEqual(['s-1f']);

  await page.goto('/?fixture=starter');
  await ready(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Column', exact: true }).click();
  const at = await planAt(page);
  await page.mouse.dblclick(...at(2_000, 2_000));
  await ready(page);
  const count = await page.evaluate(
    () =>
      (window as unknown as { bimController: { state: { content: { elements: unknown[] } } } })
        .bimController.state.content.elements.length,
  );
  expect(count).toBe(1);
});

test('Enter on a toolbar button is that button, not the end of a slab', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'drawing is closed on a narrow screen');
  await page.goto('/?fixture=starter');
  await ready(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Slab', exact: true }).click();
  const at = await planAt(page);
  for (const [x, y] of [
    [0, 0],
    [4_000, 0],
    [4_000, 3_000],
  ] as const)
    await page.mouse.click(...at(x, y));
  const count = () =>
    page.evaluate(
      () =>
        (window as unknown as { bimController: { state: { content: { elements: unknown[] } } } })
          .bimController.state.content.elements.length,
    );
  await page.getByRole('button', { name: 'Fit view', exact: true }).focus();
  await page.keyboard.press('Enter');
  expect(await count()).toBe(0);
  // From the view (nothing focused), Enter closes the slab.
  await page.mouse.click(...at(0, 3_000));
  await page.keyboard.press('Enter');
  await ready(page);
  expect(await count()).toBe(1);
});

test('adds a plan and a section, opens their drawings, and writes SVG and PNG', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'the section is drawn on the plan');
  await page.goto('/?fixture=box');
  await ready(page);
  await panel(page, 'Inspector');
  await inspector(page).getByRole('tab', { name: 'Drawings' }).click();
  await inspector(page).getByRole('button', { name: 'Add plan of 1F' }).click();
  await inspector(page)
    .getByRole('button', { name: /^1F plan/ })
    .click();
  await expect(inspector(page).getByLabel('Cut height (mm)')).toHaveValue('1200');
  await inspector(page).getByRole('button', { name: 'Open drawing' }).click();
  const drawingState = page.getByTestId('bim-drawing-state');
  await expect(drawingState).toHaveText('Drawing up to date', { timeout: 60_000 });
  await expect(page.getByTestId('bim-drawing-image')).toBeVisible();

  // The SVG as drawn: the four walls cut, the door's swing.
  const [svgFile] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export SVG' }).click(),
  ]);
  expect(svgFile.suggestedFilename()).toBe('Building - 1F plan.svg');
  const svg = await (await import('node:fs/promises')).readFile((await svgFile.path())!, 'utf8');
  expect(svg).toContain('data-scale="1:100"');
  expect(svg.match(/class="cut cut-wall/g)).toHaveLength(4);
  expect(svg).toContain('class="door-swing"');
  const [pngFile] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export PNG' }).click(),
  ]);
  expect(pngFile.suggestedFilename()).toBe('Building - 1F plan.png');
  const png = await (await import('node:fs/promises')).readFile((await pngFile.path())!);
  expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');

  // The export boundary: a draft that cannot be committed refuses the export; one that can is
  // committed first and is in the file.
  const cut = inspector(page).getByLabel('Cut height (mm)');
  let downloads = 0;
  page.on('download', () => downloads++);
  await cut.fill('0');
  await page.getByRole('button', { name: 'Export SVG' }).click();
  await expect(page.locator('.bim-drawing [role="alert"]')).toContainText('Export failed');
  expect(downloads).toBe(0);
  await cut.fill('2500');
  const [committed] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export SVG' }).click(),
  ]);
  expect(committed.suggestedFilename()).toBe('Building - 1F plan.svg');
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            bimController: { state: { content: { views: { cutHeightMm?: number }[] } } };
          }
        ).bimController.state.content.views[0]!.cutHeightMm,
    ),
  ).toBe(2500);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(cut).toHaveValue('1200');

  // A view edit is one Undo step and draws again.
  await inspector(page).getByLabel('Scale').selectOption('50');
  await expect(drawingState).toHaveText('Drawing up to date', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(inspector(page).getByLabel('Scale')).toHaveValue('100');

  // A section drawn on the plan across the box, then its drawing.
  await page.getByRole('button', { name: 'Close drawing', exact: true }).first().click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Section', exact: true }).click();
  // Top to bottom through the middle of the box.
  const view = (await page.getByTestId('bim-viewport').boundingBox())!;
  await page.mouse.click(view.x + view.width / 2, view.y + view.height * 0.1);
  await page.mouse.click(view.x + view.width / 2, view.y + view.height * 0.9);
  await inspector(page)
    .getByRole('button', { name: /^Section 1/ })
    .click();
  await inspector(page).getByRole('button', { name: 'Open drawing' }).click();
  await expect(drawingState).toHaveText('Drawing up to date', { timeout: 60_000 });
  await page.screenshot({ path: test.info().outputPath('bim-section.png') });
});
