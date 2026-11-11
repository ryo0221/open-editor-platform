import {
  bimStarter,
  f31BoxBuilding,
  f37Office,
  f40Lattice,
  f47Taper,
  f48Ramp,
  f50Lean,
  f52LeanOpenings,
  f55RampOpenings,
  type BimDocument,
} from '@editor-platform/bim-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground does not offer Building.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const ready = (page: Page) =>
  expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', { timeout: 90_000 });
const inspector = (page: Page) => page.locator('.bim-inspector');
const elements = (page: Page) => page.getByRole('navigation', { name: 'Elements' });
async function panel(page: Page, name: 'Elements' | 'Inspector') {
  const region = name === 'Elements' ? elements(page) : inspector(page);
  if (!(await region.isVisible()))
    await page.getByRole('button', { name: `Toggle ${name}`, exact: true }).click();
}
async function importFile(page: Page, name: string, mimeType: string, buffer: Buffer) {
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({ name, mimeType, buffer });
}
const importJson = (page: Page, name: string, value: unknown) =>
  importFile(page, name, 'application/json', Buffer.from(JSON.stringify(value)));

test('create, edit, Undo, save a version, reload and round-trip native JSON', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  await expect(page.getByText('This building has no elements yet.')).toBeVisible();
  // With nothing selected the inspector edits the level.
  await panel(page, 'Inspector');
  const level = inspector(page).getByLabel('Level name', { exact: true });
  await expect(level).toHaveValue('1F');
  await level.fill('Ground');
  await level.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Ground');
  // Host history drives the session.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(level).toHaveValue('1F');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(level).toHaveValue('Ground');
  await save(page, 1);

  await page.reload();
  await ready(page);
  await panel(page, 'Inspector');
  await expect(inspector(page).getByLabel('Level name', { exact: true })).toHaveValue('Ground');

  const record = await nativeArtifact(page);
  expect(record.kind).toBe('bim');
  expect(record.versions).toHaveLength(1);
  expect((record.draft.content as BimDocument).levels[0]!.name).toBe('Ground');
  expect((record.versions[0]!.content as BimDocument).levels[0]!.name).toBe('Ground');

  // A building with elements, imported as native JSON, evaluates in the Playground.
  await importJson(page, 'box.json', {
    ...record,
    name: 'Box building',
    draft: { ...record.draft, content: f31BoxBuilding() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Box building');
  await ready(page);
  await panel(page, 'Elements');
  await elements(page).getByRole('button', { name: 'w-south', exact: true }).click();
  await panel(page, 'Inspector');
  await expect(inspector(page)).toContainText('wall · w-south');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('bim-playground.png') });
});

test('a tall section fits the pane, draws at 1:500, and a coarser PNG says so (TW0c)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  // One column 90 m tall, and a section through it at 1:50 (a sheet about 1.9 m tall).
  const doc = bimStarter();
  doc.levels[2]!.elevationMm = 90_000;
  doc.elements = [
    {
      id: 'c-1',
      kind: 'column',
      typeId: 't-column-600',
      at: { xy: [0, 0] },
      rotationRad: 0,
      base: { level: 'l-1f', offsetMm: 0 },
      top: { level: 'l-rf', offsetMm: 0 },
    },
  ];
  doc.views = [
    {
      id: 'v-a',
      kind: 'section',
      name: 'Tall section',
      line: [
        [-3000, 0],
        [3000, 0],
      ],
      direction: 'left',
      depthMm: 5000,
      scale: 50,
    },
  ];
  await importJson(page, 'tall.json', {
    ...template,
    name: 'Tall',
    draft: { ...template.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Tall');
  await ready(page);
  await panel(page, 'Inspector');
  await inspector(page).getByRole('tab', { name: 'Drawings' }).click();
  await inspector(page)
    .getByRole('button', { name: /^Tall section/ })
    .click();
  await inspector(page).getByRole('button', { name: 'Open drawing' }).click();
  const state = page.getByTestId('bim-drawing-state');
  await expect(state).toHaveText('Drawing up to date', { timeout: 120_000 });
  // Fit is the default: the whole sheet is inside the pane.
  await expect(page.getByRole('button', { name: 'Fit drawing' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const sheet = (await page.locator('.bim-drawing-sheet').boundingBox())!;
  const image = (await page.getByTestId('bim-drawing-image').boundingBox())!;
  expect(image.height).toBeLessThanOrEqual(sheet.height + 1);
  expect(image.y).toBeGreaterThanOrEqual(sheet.y - 1);
  await page.screenshot({ path: test.info().outputPath('bim-tall-fit.png') });
  // At 1:50 the PNG would pass 8192 px: it is made coarser and says so.
  const [png] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export PNG' }).click(),
  ]);
  expect(png.suggestedFilename()).toBe('Tall - Tall section.png');
  await expect(page.getByTestId('bim-png-notice')).toContainText('dpi, not 150');
  // At 1:500 it keeps 150 dpi.
  await inspector(page).getByRole('combobox', { name: 'Scale' }).selectOption('500');
  await expect(page.locator('.bim-drawing-bar')).toContainText('1:500');
  await expect(state).toHaveText('Drawing up to date', { timeout: 120_000 });
  await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export PNG' }).click(),
  ]);
  await expect(page.getByTestId('bim-png-notice')).toHaveCount(0);
  // Without fit the sheet keeps its width and scrolls.
  await page.getByRole('button', { name: 'Fit drawing' }).click();
  await expect(page.getByRole('button', { name: 'Fit drawing' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('the working plan sees down to its depth, and picks nothing below it (TW0b)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  // Seen from the RF plan (6,000 mm): c-1 from 1F to 2F (3,000 mm) at x -3,000, and c-2 from
  // 1F to 2,000 mm above RF at x 3,000, which runs through the cut and below the depth.
  const doc = bimStarter();
  const column = (id: string, x: number, top: { level: string; offsetMm: number }) => ({
    id,
    kind: 'column' as const,
    typeId: 't-column-600',
    at: { xy: [x, 0] as [number, number] },
    rotationRad: 0,
    base: { level: 'l-1f', offsetMm: 0 },
    top,
  });
  doc.elements = [
    column('c-1', -3000, { level: 'l-2f', offsetMm: 0 }),
    column('c-2', 3000, { level: 'l-rf', offsetMm: 2000 }),
  ];
  await importJson(page, 'depth.json', {
    ...template,
    name: 'Depth',
    draft: { ...template.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Depth');
  await ready(page);
  await page.getByRole('combobox', { name: 'Level', exact: true }).selectOption({ label: 'RF' });
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  // The default: cut 1,200 mm above RF, down to 2F.
  const cut = page.getByLabel('Plan cut (mm)', { exact: true });
  const depth = page.getByLabel('Plan depth (mm)', { exact: true });
  await expect(cut).toHaveValue('1200');
  await expect(depth).toHaveValue('4200');
  await panel(page, 'Inspector');
  // The plan frames the columns' bounds (x -3,300 to 3,300) about its centre.
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  const span = Math.max(6600 / (box.width / box.height), 600, 2000) * 0.65;
  const clickAt = (x: number) =>
    page.mouse.click(box.x + box.width / 2 + (x * box.height) / (2 * span), box.y + box.height / 2);
  const picked = (id: string) => expect(inspector(page)).toContainText(`column · ${id}`);
  // c-2 runs through the seen range: picked, though it leaves it below the depth.
  await clickAt(3000);
  await picked('c-2');
  // 2,000 mm down from the cut stops above c-1: nothing to pick there.
  await depth.fill('2000');
  await depth.press('Enter');
  await clickAt(-3000);
  await expect(inspector(page)).not.toContainText('column · c-');
  await clickAt(3000);
  await picked('c-2');
  await page.screenshot({ path: test.info().outputPath('bim-plan-shallow.png') });
  // Down to 1F, c-1 is drawn and picked.
  await depth.fill('7200');
  await depth.press('Enter');
  await clickAt(-3000);
  await picked('c-1');
  await page.screenshot({ path: test.info().outputPath('bim-plan-deep.png') });
  // A depth less than the cut still shows a wall in progress over the level.
  await depth.fill('500');
  await depth.press('Enter');
  await page.getByRole('button', { name: 'Wall', exact: true }).click();
  await clickAt(-3000);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 100);
  await page.screenshot({ path: test.info().outputPath('bim-plan-draft.png') });
  // So does a cut 2 mm above the level: the wall in progress lies under the cut.
  await cut.fill('2');
  await cut.press('Enter');
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 100);
  await page.screenshot({ path: test.info().outputPath('bim-plan-low-cut.png') });
});

test('a grid axis shows its bubble at one end only (TW0e)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  const doc = f31BoxBuilding();
  doc.grids = [{ id: 'g-a', label: 'A', start: [0, -1000], end: [0, 9000] }];
  await importJson(page, 'grid.json', {
    ...template,
    name: 'Grid',
    draft: { ...template.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Grid');
  await ready(page);
  await panel(page, 'Inspector');
  await inspector(page).getByRole('button', { name: 'A', exact: true }).click();
  const bubbles = inspector(page).getByRole('combobox', { name: 'Bubbles' });
  await expect(bubbles).toHaveValue('both');
  await bubbles.selectOption('start');
  const grid = async () => ((await nativeArtifact(page)).draft.content as BimDocument).grids[0];
  expect(await grid()).toMatchObject({ id: 'g-a', bubbles: 'start' });
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('bim-grid-start.png') });
  // Both ends again leaves the key out.
  await bubbles.selectOption('both');
  expect(await grid()).toEqual(doc.grids[0]);
});

test('draws a brace with Member, sets its heights, Undo/Redo, saves and reloads (TW2)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  // Two columns frame the plan (x -3,300 to 3,300) as in the depth test.
  const doc = bimStarter();
  const column = (id: string, x: number) => ({
    id,
    kind: 'column' as const,
    typeId: 't-column-600',
    at: { xy: [x, 0] as [number, number] },
    rotationRad: 0,
    base: { level: 'l-1f', offsetMm: 0 },
    top: { level: 'l-2f', offsetMm: 0 },
  });
  doc.elements = [column('c-1', -3000), column('c-2', 3000)];
  await importJson(page, 'brace.json', {
    ...template,
    name: 'Brace',
    draft: { ...template.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Brace');
  await ready(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await panel(page, 'Inspector');
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  const span = Math.max(6600 / (box.width / box.height), 600, 2000) * 0.65;
  const clickAt = (x: number) =>
    page.mouse.click(box.x + box.width / 2 + (x * box.height) / (2 * span), box.y + box.height / 2);
  await page.getByRole('button', { name: 'Member', exact: true }).click();
  await clickAt(-2000);
  await clickAt(2000);
  const member = async () =>
    ((await nativeArtifact(page)).draft.content as BimDocument).elements.find(
      (e) => e.kind === 'member',
    );
  await expect.poll(member).toMatchObject({
    id: 'm-1',
    start: { height: { level: 'l-1f', offsetMm: 0 } },
    end: { height: { level: 'l-2f', offsetMm: 0 } },
  });
  await ready(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await panel(page, 'Elements');
  await elements(page).getByRole('button', { name: 'm-1', exact: true }).click();
  await expect(inspector(page)).toContainText('member · m-1');
  // The end 1,500 mm above 2F, then the start on 2F: a brace that falls the other way.
  const endOffset = inspector(page).getByLabel('End offset (mm)', { exact: true });
  await endOffset.fill('1500');
  await endOffset.press('Enter');
  await expect.poll(member).toMatchObject({ end: { height: { level: 'l-2f', offsetMm: 1500 } } });
  await inspector(page)
    .getByRole('combobox', { name: 'Start level', exact: true })
    .selectOption({ label: 'RF' });
  await expect.poll(member).toMatchObject({ start: { height: { level: 'l-rf' } } });
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(inspector(page)).toContainText('Length');
  // Host history: Undo the level, then the offset; Redo both.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(member).toMatchObject({ start: { height: { level: 'l-1f' } } });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(member).toMatchObject({ end: { height: { offsetMm: 0 } } });
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(member).toMatchObject({
    start: { height: { level: 'l-rf' } },
    end: { height: { level: 'l-2f', offsetMm: 1500 } },
  });
  await save(page, 1);
  await page.reload();
  await ready(page);
  const record = await nativeArtifact(page);
  const kept = (record.versions[0]!.content as BimDocument).elements.find((e) => e.id === 'm-1');
  expect(kept).toMatchObject({
    kind: 'member',
    start: { height: { level: 'l-rf', offsetMm: 0 } },
    end: { height: { level: 'l-2f', offsetMm: 1500 } },
  });
  expect((record.draft.content as BimDocument).types.some((t) => t.kind === 'member')).toBe(true);
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('bim-member.png') });
});

test('shows the schedule by type and level, and exports it as CSV (TW3)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  await importJson(page, 'lattice.json', {
    ...template,
    name: 'Lattice',
    draft: { ...template.draft, content: f40Lattice() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Lattice');
  await ready(page);
  await panel(page, 'Inspector');
  await inspector(page).getByRole('tab', { name: 'Schedule' }).click();
  const table = inspector(page).getByRole('table', { name: 'Schedule' });
  const tube = table.getByRole('row').filter({ hasText: 'Steel tube 400' });
  await expect(tube).toContainText('member · GL');
  await expect(tube).toContainText('13.00');
  await expect(table.getByRole('row').filter({ hasText: 'Subtotal metal' })).toContainText('4');
  await page.screenshot({ path: test.info().outputPath('bim-schedule.png') });
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    inspector(page).getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  expect(csv.suggestedFilename()).toBe('Lattice - Schedule.csv');
  const fs = await import('node:fs/promises');
  const text = (await fs.readFile((await csv.path())!)).toString('utf8');
  expect(text.split('\r\n')[0]).toBe(
    'Kind,Type,Level,Material,Count,Length (m),Area (m²),Volume (m³),Not measured',
  );
  expect(text).toContain('member,Steel tube 400,GL,metal,2,13.000,');
});

test("sets a column's top scale and a slab's slope in the Inspector, Undo, saves and reloads (TW5)", async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  // F48's ramps and F47's types with its round column, both on GL–L1.
  const doc = f48Ramp();
  const taper = f47Taper();
  doc.types = taper.types;
  const round = taper.elements.find((e) => e.id === 'c-round')!;
  if (round.kind === 'column') delete round.topScale;
  doc.elements.push(round);
  await importJson(page, 'ramp.json', {
    ...template,
    name: 'Ramp',
    draft: { ...template.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Ramp');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const byId = async (id: string) =>
    ((await nativeArtifact(page)).draft.content as BimDocument).elements.find((e) => e.id === id);
  await panel(page, 'Elements');
  await panel(page, 'Inspector');
  // The column: a top scale of 0.5, then back to 1 (no taper).
  await elements(page).getByRole('button', { name: 'c-round', exact: true }).click();
  const scale = inspector(page).getByLabel('Top scale', { exact: true });
  await scale.fill('0.5');
  await scale.press('Enter');
  await expect.poll(() => byId('c-round')).toMatchObject({ topScale: 0.5 });
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The ramp: its slope edge and end top, then level, then Undo.
  await elements(page).getByRole('button', { name: 's-ramp', exact: true }).click();
  const edge = inspector(page).getByRole('combobox', { name: 'Slope edge', exact: true });
  await expect(edge).toHaveValue('3');
  await expect(inspector(page)).toContainText('Sloped top area');
  const endTop = inspector(page).getByLabel('Slope end top offset from L1 (mm)', { exact: true });
  // An empty draft keeps the field: Level does not drop it unseen.
  await endTop.fill('');
  await edge.selectOption({ label: 'Level' });
  await expect(endTop).toBeVisible();
  await expect(edge).toHaveValue('3');
  await endTop.fill('-500');
  await endTop.press('Enter');
  await expect
    .poll(() => byId('s-ramp'))
    .toMatchObject({
      slope: { edge: 3, endTop: { level: 'l-1', offsetMm: -500 } },
    });
  await edge.selectOption({ label: 'Level' });
  await expect.poll(async () => (await byId('s-ramp')) as object).not.toHaveProperty('slope');
  await expect(inspector(page)).not.toContainText('Sloped top area');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => byId('s-ramp')).toMatchObject({ slope: { edge: 3 } });
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await save(page, 1);
  await page.reload();
  await ready(page);
  const record = await nativeArtifact(page);
  const kept = (record.versions[0]!.content as BimDocument).elements;
  expect(kept.find((e) => e.id === 's-ramp')).toMatchObject({
    slope: { edge: 3, endTop: { level: 'l-1', offsetMm: -500 } },
  });
  expect(kept.find((e) => e.id === 'c-round')).toMatchObject({ topScale: 0.5 });
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('bim-ramp.png') });
});

test('zooms to the selection in 3D and in a plan (FU1)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  await importJson(page, 'zoom.json', {
    ...template,
    name: 'Zoom',
    draft: { ...template.draft, content: f50Lean() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Zoom');
  await ready(page);
  const zoom = page.getByRole('button', { name: 'Zoom to selection', exact: true });
  // Nothing selected: nothing to frame.
  await expect(zoom).toBeDisabled();
  await page.getByRole('button', { name: 'Fit view', exact: true }).click();
  const view = page.getByTestId('bim-viewport');
  const whole = await view.screenshot();
  await panel(page, 'Elements');
  await elements(page).getByRole('button', { name: 'w-free', exact: true }).click();
  await expect(zoom).toBeEnabled();
  await zoom.click();
  // The camera moved in to the wall: the view is drawn differently.
  await expect.poll(async () => (await view.screenshot()).equals(whole)).toBe(false);
  const near = await view.screenshot();
  // In a plan too, framed from above.
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Fit view', exact: true }).click();
  const plan = await view.screenshot();
  await zoom.click();
  await expect.poll(async () => (await view.screenshot()).equals(plan)).toBe(false);
  expect(near.equals(whole)).toBe(false);
});

test("sets a wall's lean in the Inspector, back to upright, Undo, saves and reloads (LR2c)", async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  await importJson(page, 'lean.json', {
    ...template,
    name: 'Lean',
    draft: { ...template.draft, content: f50Lean() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Lean');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const byId = async (id: string) =>
    ((await nativeArtifact(page)).draft.content as BimDocument).elements.find((e) => e.id === id);
  await panel(page, 'Elements');
  await panel(page, 'Inspector');
  await elements(page).getByRole('button', { name: 'w-free', exact: true }).click();
  const lean = inspector(page).getByLabel('Lean (°)', { exact: true });
  await expect(lean).toHaveValue('15');
  await lean.fill('20');
  await lean.press('Enter');
  await expect
    .poll(async () => ((await byId('w-free')) as { lean?: number }).lean)
    .toBeCloseTo((20 * Math.PI) / 180, 12);
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // 0° is upright: no lean kept.
  await lean.fill('0');
  await lean.press('Enter');
  await expect.poll(async () => (await byId('w-free')) as object).not.toHaveProperty('lean');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(lean).toHaveValue('20');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await save(page, 1);
  await page.reload();
  await ready(page);
  const record = await nativeArtifact(page);
  const kept = (record.versions[0]!.content as BimDocument).elements.find((e) => e.id === 'w-free');
  expect((kept as { lean?: number }).lean).toBeCloseTo((20 * Math.PI) / 180, 12);
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('bim-lean.png') });
});

test('places a window on a leaning wall, moves it in the Inspector, refuses an overlap, saves and reloads (FU3c)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  // F52's w-free and its door alone, moved to y = 600: it leans 15° to its right, down to
  // y = 600 − 4,000·tan 15° = −472 mm at the top, so the plan's centre is over its slanted
  // body, more than 500 mm from its foot.
  const doc = f52LeanOpenings();
  doc.elements = doc.elements.filter((e) => e.id === 'w-free' || e.id === 'door-free');
  const wall = doc.elements.find((e) => e.id === 'w-free') as Extract<
    BimDocument['elements'][number],
    { kind: 'wall' }
  >;
  wall.start = { xy: [-3000, 600] };
  wall.end = { xy: [3000, 600] };
  doc.joins = [];
  await importJson(page, 'lean-openings.json', {
    ...template,
    name: 'Lean openings',
    draft: { ...template.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Lean openings');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const byId = async (id: string) =>
    ((await nativeArtifact(page)).draft.content as BimDocument).elements.find((e) => e.id === id);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Fit view', exact: true }).click();
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  await page.getByRole('button', { name: 'Window', exact: true }).click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // Centred on the click, about 3,000 mm along the wall.
  await expect.poll(async () => byId('win-1')).toMatchObject({ kind: 'window', hostId: 'w-free' });
  const placed = (await byId('win-1')) as { alongMm: number; sillMm: number };
  expect(Math.abs(placed.alongMm + 900 - 3000)).toBeLessThan(500);
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await panel(page, 'Elements');
  await panel(page, 'Inspector');
  await elements(page).getByRole('button', { name: 'win-1', exact: true }).click();
  await expect(inspector(page)).toContainText('window · win-1');
  const along = inspector(page).getByLabel('Position along wall (mm)', { exact: true });
  const sill = inspector(page).getByLabel('Sill height (mm)', { exact: true });
  await along.fill('1200');
  await along.press('Enter');
  await sill.fill('1000');
  await sill.press('Enter');
  await expect.poll(async () => byId('win-1')).toMatchObject({ alongMm: 1200, sillMm: 1000 });
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Onto the door, 4,000 mm along the same wall: refused, the window stays.
  await along.fill('3500');
  await along.press('Enter');
  await expect(page.locator('.bim-notice')).toContainText('Refused: opening-overlap');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  // The refused input is kept for correction; putting it back leaves the window where it was.
  await along.fill('1200');
  await along.press('Enter');
  await expect.poll(async () => byId('win-1')).toMatchObject({ alongMm: 1200 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(sill).toHaveValue(String(placed.sillMm));
  await ready(page);
  await save(page, 1);
  await page.reload();
  await ready(page);
  const record = await nativeArtifact(page);
  const kept = (record.versions[0]!.content as BimDocument).elements.find((e) => e.id === 'win-1');
  expect(kept).toMatchObject({ alongMm: 1200, sillMm: placed.sillMm });
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('bim-lean-window.png') });
});

test('places a spiral ramp with Ramp, sets its turn and radius, Undo, saves and reloads (LR3c)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  // Two columns frame the plan (x -3,300 to 3,300) as in the brace test.
  const doc = bimStarter();
  const column = (id: string, x: number) => ({
    id,
    kind: 'column' as const,
    typeId: 't-column-600',
    at: { xy: [x, 0] as [number, number] },
    rotationRad: 0,
    base: { level: 'l-1f', offsetMm: 0 },
    top: { level: 'l-2f', offsetMm: 0 },
  });
  doc.elements = [column('c-1', -3000), column('c-2', 3000)];
  await importJson(page, 'spiral.json', {
    ...template,
    name: 'Spiral',
    draft: { ...template.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Spiral');
  await ready(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await panel(page, 'Inspector');
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  await page.getByRole('button', { name: 'Ramp', exact: true }).click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const ramp = async () =>
    ((await nativeArtifact(page)).draft.content as BimDocument).elements.find(
      (e) => e.kind === 'ramp',
    ) as Extract<BimDocument['elements'][number], { kind: 'ramp' }> | undefined;
  await expect.poll(ramp).toMatchObject({
    id: 'r-1',
    center: { xy: [0, 0] },
    sweepRad: 2 * Math.PI,
    base: { level: 'l-1f', offsetMm: 0 },
    top: { level: 'l-2f', offsetMm: 0 },
  });
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await panel(page, 'Elements');
  await elements(page).getByRole('button', { name: 'r-1', exact: true }).click();
  await expect(inspector(page)).toContainText('ramp · r-1');
  await expect(inspector(page)).toContainText('Walking surface area');
  // One and a half turns, then a narrower way.
  const turn = inspector(page).getByLabel('Turn (°, + counter-clockwise)', { exact: true });
  await expect(turn).toHaveValue('360');
  await turn.fill('540');
  await turn.press('Enter');
  await expect.poll(async () => (await ramp())?.sweepRad).toBeCloseTo(3 * Math.PI, 12);
  const outer = inspector(page).getByLabel('Outer radius (mm)', { exact: true });
  await outer.fill('3000');
  await outer.press('Enter');
  await expect.poll(ramp).toMatchObject({ outerRadiusMm: 3000 });
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(ramp).toMatchObject({ outerRadiusMm: 3500 });
  await save(page, 1);
  await page.reload();
  await ready(page);
  const record = await nativeArtifact(page);
  const kept = (record.versions[0]!.content as BimDocument).elements.find((e) => e.id === 'r-1');
  expect(kept).toMatchObject({ kind: 'ramp', outerRadiusMm: 3500 });
  expect((kept as { sweepRad: number }).sweepRad).toBeCloseTo(3 * Math.PI, 12);
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('bim-spiral.png') });
});

test("adds a railing from a ramp's Inspector, sets its height and side, Undo, saves and reloads (LS5)", async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  // F55 without its railings: the ramps and their openings.
  const doc = f55RampOpenings();
  doc.elements = doc.elements.filter((e) => e.kind !== 'railing');
  await importJson(page, 'railings.json', {
    ...template,
    name: 'Railings',
    draft: { ...template.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Railings');
  await ready(page);
  await panel(page, 'Elements');
  await panel(page, 'Inspector');
  await elements(page).getByRole('button', { name: 'r-spiral', exact: true }).click();
  await expect(inspector(page)).toContainText('ramp · r-spiral');
  await inspector(page).getByRole('button', { name: 'Add outer railing', exact: true }).click();
  const railing = async () =>
    ((await nativeArtifact(page)).draft.content as BimDocument).elements.find(
      (e) => e.kind === 'railing',
    );
  await expect.poll(railing).toMatchObject({
    id: 'rail-1',
    hostId: 'r-spiral',
    side: 'outer',
    heightMm: 1100,
  });
  // The new railing is selected, with its quantities.
  await expect(inspector(page)).toContainText('railing · rail-1');
  await ready(page);
  await expect(inspector(page)).toContainText('Side area');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const height = inspector(page).getByLabel('Height (mm)', { exact: true });
  await height.fill('1200');
  await height.press('Enter');
  await expect.poll(railing).toMatchObject({ heightMm: 1200 });
  await inspector(page).getByLabel('Side', { exact: true }).selectOption('inner');
  await expect.poll(railing).toMatchObject({ side: 'inner', heightMm: 1200 });
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(railing).toMatchObject({ side: 'outer', heightMm: 1200 });
  await save(page, 1);
  await page.reload();
  await ready(page);
  const record = await nativeArtifact(page);
  const kept = (record.versions[0]!.content as BimDocument).elements.find((e) => e.id === 'rail-1');
  expect(kept).toMatchObject({ kind: 'railing', side: 'outer', heightMm: 1200 });
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('bim-railing.png') });
});

test('draws a straight stair with Stair, sets its risers and tread, Undo, saves and reloads (LS6)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  const doc = bimStarter();
  doc.elements = [];
  await importJson(page, 'stair.json', {
    ...template,
    name: 'Stair',
    draft: { ...template.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Stair');
  await ready(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await panel(page, 'Inspector');
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  await page.getByRole('button', { name: 'Stair', exact: true }).click();
  // Its foot, then a point up the flight to the east.
  await page.mouse.click(box.x + box.width / 2 - 80, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2 + 80, box.y + box.height / 2);
  const stair = async () =>
    ((await nativeArtifact(page)).draft.content as BimDocument).elements.find(
      (e) => e.kind === 'stair',
    ) as Extract<BimDocument['elements'][number], { kind: 'stair' }> | undefined;
  await expect.poll(stair).toMatchObject({
    id: 'st-1',
    directionRad: 0,
    risers: 17,
    widthMm: 1200,
    base: { level: 'l-1f', offsetMm: 0 },
    top: { level: 'l-2f', offsetMm: 0 },
  });
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await panel(page, 'Elements');
  await elements(page).getByRole('button', { name: 'st-1', exact: true }).click();
  await expect(inspector(page)).toContainText('stair · st-1');
  await expect(inspector(page)).toContainText('Tread area');
  const risers = inspector(page).getByLabel('Risers', { exact: true });
  await expect(risers).toHaveValue('17');
  await risers.fill('18');
  await risers.press('Enter');
  await expect.poll(stair).toMatchObject({ risers: 18 });
  const tread = inspector(page).getByLabel('Tread (mm)', { exact: true });
  await tread.fill('250');
  await tread.press('Enter');
  await expect.poll(stair).toMatchObject({ risers: 18, treadMm: 250 });
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await stair())?.treadMm).not.toBe(250);
  const before = (await stair())!.treadMm;
  await save(page, 1);
  await page.reload();
  await ready(page);
  const record = await nativeArtifact(page);
  const kept = (record.versions[0]!.content as BimDocument).elements.find((e) => e.id === 'st-1');
  expect(kept).toMatchObject({ kind: 'stair', risers: 18, treadMm: before });
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('bim-stair.png') });
});

test('a narrow screen shows the building and its inspector', async ({ page }) => {
  test.skip(test.info().project.name === 'desktop', 'narrow flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  await panel(page, 'Inspector');
  await expect(inspector(page).getByLabel('Level name', { exact: true })).toHaveValue('1F');
  await page.screenshot({ path: test.info().outputPath('bim-playground-narrow.png') });
});

test('places a saved CAD version as a part, keeps it with the building and reads it back', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  // A 3D CAD part with one saved version.
  await create(page, 'cad');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const addPlate = page.getByRole('button', { name: 'Add plate', exact: true });
  if (!(await addPlate.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await addPlate.click();
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const cadName = await page.getByLabel('Artifact name').inputValue();
  await save(page, 1);

  await create(page, 'bim');
  await ready(page);
  await panel(page, 'Inspector');
  await inspector(page).getByRole('tab', { name: 'Types' }).click();
  await inspector(page).getByRole('button', { name: 'Add part from CAD…' }).click();
  await inspector(page)
    .getByRole('button', { name: `Add ${cadName}`, exact: true })
    .click();
  await expect(
    inspector(page).getByRole('button', { name: new RegExp(`^${cadName} v1`) }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Part', exact: true }).click();
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('1 elements');
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  await save(page, 1);

  const record = await nativeArtifact(page);
  const content = record.draft.content as BimDocument;
  const type = content.types.find((t) => t.kind === 'part')!;
  expect(type).toMatchObject({ kind: 'part', source: { versionId: expect.any(String) } });
  expect(record.cadParts?.map((p) => p.contentHash)).toEqual([
    type.kind === 'part' && type.source.contentHash,
  ]);
  expect(content.elements).toMatchObject([{ kind: 'part', typeId: type.id }]);

  // After a reload the shape is read again from the version the building keeps.
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('1 elements');
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  await page.getByRole('button', { name: 'Fit view', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('bim-part.png') });
});

/** F37 as the file holds it: elements by ID, without the GlobalIds an IFC import keeps. */
function comparable(doc: BimDocument) {
  const d = structuredClone(doc);
  d.levels.sort((a, b) => a.elevationMm - b.elevationMm);
  d.elements.sort((a, b) => a.id.localeCompare(b.id));
  for (const e of d.elements) delete e.ifcGlobalId;
  return d;
}
const count = (text: string, entity: string) => text.split(`=${entity}(`).length - 1;

test('F37: an office building is placed, saved, reloaded, round-tripped, written as IFC and drawn', async ({
  page,
}) => {
  // CAD69 (R2c-6): the representative building through the whole Playground flow.
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(900_000);
  const fs = await import('node:fs/promises');
  const read = async (d: { path(): Promise<string | null> }) => fs.readFile((await d.path())!);
  await page.goto('/');
  // A 3D CAD part with one saved version, to place in the building.
  await create(page, 'cad');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const addPlate = page.getByRole('button', { name: 'Add plate', exact: true });
  if (!(await addPlate.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await addPlate.click();
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const cadName = await page.getByLabel('Artifact name').inputValue();
  await save(page, 1);

  // F37 (six levels, 766 elements) and its X3 section, as a native building file.
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  const office = f37Office();
  office.views = [
    {
      id: 'v-x3',
      kind: 'section',
      name: 'X3 section',
      line: [
        [14400, -2000],
        [14400, 30800],
      ],
      direction: 'left',
      depthMm: 20000,
      scale: 100,
    },
  ];
  await importJson(page, 'office.json', {
    ...template,
    name: 'Office',
    draft: { ...template.draft, content: office },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Office');
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('766 elements');

  // On 2F: the CAD version as a part type, one part placed, and the 2F plan.
  await page.getByRole('combobox', { name: 'Level' }).selectOption({ label: '2F' });
  await panel(page, 'Inspector');
  await inspector(page).getByRole('tab', { name: 'Types' }).click();
  await inspector(page).getByRole('button', { name: 'Add part from CAD…' }).click();
  await inspector(page)
    .getByRole('button', { name: `Add ${cadName}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Part', exact: true }).click();
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('767 elements');
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await inspector(page).getByRole('tab', { name: 'Drawings' }).click();
  await inspector(page).getByRole('button', { name: 'Add plan of 2F' }).click();
  await save(page, 1);

  // Reload, then the native file round trip: the same content and the part version with it.
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('767 elements');
  const saved = await nativeArtifact(page);
  const content = saved.draft.content as BimDocument;
  expect(content.views.map((v) => v.name).sort()).toEqual(['2F plan', 'X3 section']);
  expect(saved.versions).toHaveLength(1);
  expect(saved.cadParts).toHaveLength(1);
  await importJson(page, 'office-copy.json', { ...saved, name: 'Office copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Office copy');
  await ready(page);
  const copy = await nativeArtifact(page);
  expect(copy.draft.content).toEqual(content);
  expect(copy.versions.map((v) => v.contentHash)).toEqual(saved.versions.map((v) => v.contentHash));
  expect(copy.cadParts).toEqual(saved.cadParts);

  // IFC4 of the whole building: levels, elements, types and the part with its version.
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  const [ifcFile] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByRole('button', { name: 'Export IFC', exact: true }).click(),
  ]);
  expect(ifcFile.suggestedFilename()).toBe('Office copy.ifc');
  const ifc = (await read(ifcFile)).toString('utf8');
  expect(ifc).toContain("FILE_SCHEMA(('IFC4'))");
  expect(count(ifc, 'IFCBUILDINGSTOREY')).toBe(6);
  expect(count(ifc, 'IFCWALL')).toBe(25);
  expect(count(ifc, 'IFCCOLUMN')).toBe(175);
  expect(count(ifc, 'IFCBEAM')).toBe(290);
  expect(count(ifc, 'IFCDOOR')).toBe(60);
  expect(count(ifc, 'IFCWINDOW')).toBe(200);
  expect(count(ifc, 'IFCWALLTYPE')).toBeGreaterThan(0);
  expect(ifc).toContain("'EP_PartReference'");
  // TW0a: a solid part without cavities is a triangulated face set.
  expect(ifc).toContain('IFCTRIANGULATEDFACESET');

  // That IFC imported is the same building, its part read from the same CAD version.
  await importFile(page, 'office-ifc.ifc', 'application/x-step', Buffer.from(ifc));
  await expect(page.getByLabel('Artifact name')).toHaveValue('office-ifc');
  await expect(page.getByTestId('bim-ifc-report')).toHaveCount(0);
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('767 elements');
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  const imported = await nativeArtifact(page);
  expect(comparable(imported.draft.content as BimDocument)).toEqual(comparable(content));
  expect(imported.cadParts).toEqual(saved.cadParts);

  // The 2F plan and the X3 section of the imported building, as SVG and PNG.
  await panel(page, 'Inspector');
  await inspector(page).getByRole('tab', { name: 'Drawings' }).click();
  const state = page.getByTestId('bim-drawing-state');
  const svgs: Record<string, string> = {};
  for (const [view, file] of [
    ['2F plan', 'office-ifc - 2F plan'],
    ['X3 section', 'office-ifc - X3 section'],
  ] as const) {
    await inspector(page)
      .getByRole('button', { name: new RegExp(`^${view}`) })
      .click();
    await inspector(page).getByRole('button', { name: 'Open drawing' }).click();
    await expect(state).toHaveText('Drawing up to date', { timeout: 300_000 });
    await expect(page.locator('.bim-drawing [role="status"]')).toHaveCount(0);
    const [svg] = await Promise.all([
      page.waitForEvent('download', { timeout: 300_000 }),
      page.getByRole('button', { name: 'Export SVG' }).click(),
    ]);
    expect(svg.suggestedFilename()).toBe(`${file}.svg`);
    svgs[view] = (await read(svg)).toString('utf8');
    const [png] = await Promise.all([
      page.waitForEvent('download', { timeout: 300_000 }),
      page.getByRole('button', { name: 'Export PNG' }).click(),
    ]);
    expect(png.suggestedFilename()).toBe(`${file}.png`);
    expect((await read(png)).subarray(1, 4).toString()).toBe('PNG');
    await page.screenshot({ path: test.info().outputPath(`f37-${view.replace(' ', '-')}.png`) });
    await page.getByRole('button', { name: 'Close drawing', exact: true }).first().click();
  }
  // The plan cuts the 2F walls and columns; the section cuts the slabs and beams on X3.
  expect(svgs['2F plan']).toContain('class="cut cut-wall');
  expect(svgs['2F plan']).toContain('class="cut cut-column');
  expect(svgs['X3 section']).toContain('class="cut cut-slab');
  expect(svgs['X3 section']).toContain('class="cut cut-beam');
  await fs.writeFile(test.info().outputPath('f37-2F-plan.svg'), svgs['2F plan']!);
  await fs.writeFile(test.info().outputPath('f37-X3-section.svg'), svgs['X3 section']!);
});
