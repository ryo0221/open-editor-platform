import { readFileSync, writeFileSync } from 'node:fs';
import { f31BoxBuilding, f37Office } from '@editor-platform/bim-core';
import { f02Plate, f26Panel, type CadDocument } from '@editor-platform/cad-core';
import type { DrawingDocument } from '@editor-platform/drawing-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// DW2 (docs/cad/drawing-editor.md; ST-701, TS-2404): views of a saved CAD version on a sheet,
// derived from the version kept with the drawing. Needs the development kernel.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const draft = async (page: Page) => (await nativeArtifact(page)).draft.content as DrawingDocument;
const sheetSvg = (page: Page) =>
  page
    .getByTestId('drawing-sheet')
    .locator('img')
    .evaluate((img: HTMLImageElement) => fetch(img.src).then((r) => r.text()));
async function importJson(page: Page, name: string, value: unknown) {
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}

test('three views of a saved plate: aligned, hidden and centre lines, kept with the drawing', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'cad');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'plate.json', {
    ...empty,
    name: 'Plate',
    draft: { ...empty.draft, content: { ...f02Plate(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Plate');
  await save(page, 1);

  await create(page, 'drawing');
  await expect(page.getByLabel('Source version', { exact: true })).toHaveValue(/\//);
  await expect(page.getByLabel('Source version', { exact: true }).locator('option')).toHaveText([
    'Plate · v1',
  ]);
  await page.getByRole('button', { name: 'Place views', exact: true }).click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  for (const name of ['正面図', '平面図', '右側面図'])
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
      { timeout: 120_000 },
    );

  const doc = await draft(page);
  expect(doc.sources).toHaveLength(1);
  expect(doc.views.map((v) => (v.kind === 'cad-projection' ? v.direction : v.kind))).toEqual([
    'front',
    'top',
    'right',
  ]);
  const [front, top, right] = doc.views;
  // Third angle: the top view above the front view, the right side view to its right.
  expect(top!.at[0]).toBeCloseTo(front!.at[0], 6);
  expect(top!.at[1]).toBeGreaterThan(front!.at[1]);
  expect(right!.at[1]).toBeCloseTo(front!.at[1], 6);
  expect(right!.at[0]).toBeGreaterThan(front!.at[0]);
  // The version is kept with the record.
  const record = await nativeArtifact(page);
  expect(record.drawingSources?.map((s) => s.contentHash)).toEqual([doc.sources[0]!.contentHash]);

  // The plate's hole: hidden lines in the front and side views, a centre cross in the top view.
  const svg = await sheetSvg(page);
  expect(svg).toMatch(/<polyline class="thick" points="/);
  expect(svg).toMatch(/<polyline class="hidden" points="/);
  expect(svg).toMatch(/<polyline class="center" points="/);
  expect(svg).toMatch(/正面図 {2}\d+:\d+/);
  if (process.env.DRAWING_SHOTS) writeFileSync(`${process.env.DRAWING_SHOTS}/dw2-plate.svg`, svg);

  // A moved view moves its lines; Undo puts it back.
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await page.getByLabel('Hidden lines (かくれ線)', { exact: true }).uncheck();
  await expect
    .poll(async () => ((await draft(page)).views[1]! as { hiddenLines: boolean }).hiddenLines)
    .toBe(false);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect
    .poll(async () => ((await draft(page)).views[1]! as { hiddenLines: boolean }).hiddenLines)
    .toBe(true);

  // DW2b (ST-702, TS-2408): a section of the front view, hatched, in projection with it, and a
  // detail of the section at a larger scale; the cutting line and the circle on their parents.
  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  await expect(list.getByRole('button', { name: '断面 A–A', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
    { timeout: 120_000 },
  );
  await page.getByRole('button', { name: 'Add detail', exact: true }).click();
  await expect(list.getByRole('button', { name: '詳細 B', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
    { timeout: 120_000 },
  );
  const withSection = await draft(page);
  const section = withSection.views.find((v) => v.kind === 'cad-section')!;
  // In projection with the front view when there is room, else in a free place on the sheet.
  expect(section.at[0]).toBeGreaterThan(10);
  expect(section.at[0]).toBeLessThan(410);
  expect(section.at[1]).toBeGreaterThan(10);
  expect(section.at[1]).toBeLessThan(287);
  const cut = await sheetSvg(page);
  expect(cut).toMatch(/<path class="hatch" d="M/);
  expect(cut).toMatch(/<line class="cut" /);
  expect(cut).toMatch(/断面 A–A {2}\d+:\d+/);
  expect(cut).toMatch(/詳細 B {2}\d+:\d+/);
  if (process.env.DRAWING_SHOTS) writeFileSync(`${process.env.DRAWING_SHOTS}/dw2b-plate.svg`, cut);
  // Deleting the front view takes its section and the section's detail with it; Undo restores.
  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await page.getByRole('button', { name: 'Delete selection', exact: true }).click();
  await expect.poll(async () => (await draft(page)).views.length).toBe(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect.poll(async () => (await draft(page)).views.length).toBe(5);

  // DW3a (ST-703, TS-2411): dimensions snapped to the kernel's edges in the top view: the
  // plate's 80 mm width, then the hole's diameter.
  const sheet = page.getByTestId('drawing-sheet');
  const topBox = (await sheet
    .getByRole('button', { name: 'View 平面図', exact: true })
    .boundingBox())!;
  /** Moves to a screen point and returns where the shown snap is. */
  const snapNear = async (x: number, y: number) => {
    await page.mouse.move(x, y);
    const mark = page.getByTestId('drawing-snap');
    await expect(mark).toBeVisible();
    const m = (await mark.boundingBox())!;
    return { x: m.x + m.width / 2, y: m.y + m.height / 2 };
  };
  await page.getByRole('button', { name: 'Add dimension', exact: true }).click();
  const bottom = topBox.y + topBox.height - 2;
  const p0 = await snapNear(topBox.x + 2, bottom);
  await page.mouse.click(p0.x, p0.y);
  const p1 = await snapNear(topBox.x + topBox.width - 2, bottom);
  await page.mouse.click(p1.x, p1.y);
  await page.mouse.click((p0.x + p1.x) / 2, topBox.y - 20);
  await expect(list.getByRole('button', { name: '寸法 水平 80', exact: true })).toBeVisible();
  await page.getByLabel('Dimension type', { exact: true }).selectOption('diameter');
  const hole = await snapNear(topBox.x + topBox.width / 2, topBox.y + topBox.height / 2);
  await page.mouse.click(hole.x, hole.y);
  await page.mouse.click(topBox.x + topBox.width + 30, topBox.y - 10);
  await expect(list.getByRole('button', { name: '寸法 直径 10', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const dims = await sheetSvg(page);
  expect(dims).toContain('>80<');
  expect(dims).toContain('>Ø10<');
  if (process.env.DRAWING_SHOTS) {
    writeFileSync(`${process.env.DRAWING_SHOTS}/dw3a-plate.svg`, dims);
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw3a-plate.png` });
  }

  // DW3c-1 (ST-705, TS-2417): the plate made wider and saved as v2. The newer version keeps
  // the kernel's edge names, so both dimensions follow: the width is the new 100 mm, the hole
  // still Ø10, and nothing is left to choose again.
  const nav = page.getByRole('navigation', { name: 'Artifacts', exact: true });
  const open = async (name: RegExp) => {
    if (!(await nav.isVisible()))
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await nav.getByRole('button', { name }).click();
  };
  await open(/Plate 3D CAD/);
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  await page
    .getByRole('list', { name: 'Parameters' })
    .getByRole('button', { name: /Width/ })
    .click();
  const value = page.locator('.cad-inspector').getByLabel('Value (mm)');
  await value.fill('100');
  await value.press('Enter');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  await save(page, 2);
  await open(/Drawing 1 Drawing/);
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await page.getByRole('button', { name: '新しい版を使う Use Plate · v2', exact: true }).click();
  await expect(list.getByRole('button', { name: '寸法 水平 100', exact: true })).toBeVisible({
    timeout: 120_000,
  });
  await expect(list.getByRole('button', { name: '寸法 直径 10', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Unresolved dimensions' })).toHaveCount(0);
  const named = (await draft(page)).annotations.flatMap((a) =>
    a.kind === 'dimension' ? a.refs.map((r) => r.name) : [],
  );
  expect(named.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw3c-plate-v2.png` });

  // Reload: the views derive again from the kept version, and the dimensions measure again.
  await page.reload();
  await expect(
    page.getByRole('list', { name: 'Views and notes' }).getByRole('button', {
      name: '正面図',
      exact: true,
    }),
  ).toHaveAttribute('data-view-state', 'ready', { timeout: 120_000 });
  await expect(
    page
      .getByRole('list', { name: 'Views and notes' })
      .getByRole('button', { name: '寸法 水平 100', exact: true }),
  ).toBeVisible({ timeout: 120_000 });
});

const f43 = (name: string) =>
  new URL(`../../packages/cad-kernel-occt/fixtures/f43/${name}`, import.meta.url).pathname;

// DW3c-2a (ST-706, TS-2419): a STEP-imported part is drawn: the drawing keeps the version and the
// asset bytes it names (STEP, BRep, PMI), so a copy of the drawing alone draws it again.
test('views of an imported STEP part, kept with its asset bytes', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'cad');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(f43('pmi-plate.step'));
  await page.getByRole('button', { name: 'Insert body', exact: true }).click();
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  await save(page, 1);

  await create(page, 'drawing');
  await page.getByRole('button', { name: 'Place views', exact: true }).click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  for (const name of ['正面図', '平面図', '右側面図'])
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
      { timeout: 120_000 },
    );
  const svg = await sheetSvg(page);
  expect(svg).toMatch(/<polyline class="thick" points="/);
  const record = await nativeArtifact(page);
  expect(record.drawingAssets?.map((a) => a.kind).sort()).toEqual([
    'normalized-brep',
    'pmi',
    'source-step',
  ]);
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw3c-step-views.png` });

  // A copy of the drawing on its own: the views derive from its kept bytes.
  await importJson(page, 'drawing-copy.json', { ...record, name: 'Drawing copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Drawing copy');
  await expect(list.getByRole('button', { name: '正面図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
    { timeout: 120_000 },
  );
  // Without its assets the copy is refused.
  await importJson(page, 'no-assets.json', { ...record, name: 'No assets', drawingAssets: [] });
  await expect(page.getByRole('alert')).toContainText('Drawing asset missing');
});

// DW3c-2b (ST-707, TS-2422): the STEP part's PMI imported into a view as annotations, which stay
// current in a copy of the drawing (its kept PMI asset).
test('PMI of an imported STEP part, imported into a view', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'cad');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(f43('pmi-plate.step'));
  await page.getByRole('button', { name: 'Insert body', exact: true }).click();
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  await save(page, 1);

  await create(page, 'drawing');
  await page.getByRole('button', { name: 'Place views', exact: true }).click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.getByRole('button', { name: '正面図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
    { timeout: 120_000 },
  );
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await page.getByRole('button', { name: 'PMIを取り込む Import PMI (7)', exact: true }).click();
  const pmi = list.getByRole('button', { name: /^PMI / });
  await expect(pmi).toHaveText([
    'PMI データム A',
    'PMI データム B',
    'PMI Flatness 0.02',
    'PMI Parallelism 0.05 | A',
    'PMI Position Ø0.1 | A | B',
    'PMI 5',
    'PMI Ø10 ±0.05',
  ]);
  // Drawn as frames and datums (their letters are datums of the drawing), none to review.
  const svg = await sheetSvg(page);
  expect(svg).toContain('>Ø10 ±0.05<');
  expect(svg).not.toContain('class="err"');
  await expect(page.getByRole('list', { name: 'PMI to review' })).toHaveCount(0);
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw3c-step-pmi.png` });

  // A copy of the drawing: the items read from its kept PMI asset, still current.
  const record = await nativeArtifact(page);
  await importJson(page, 'drawing-pmi.json', { ...record, name: 'PMI copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('PMI copy');
  await expect(list.getByRole('button', { name: '平面図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
    { timeout: 120_000 },
  );
  await expect(pmi).toHaveCount(7);
  await expect(page.getByRole('list', { name: 'PMI to review' })).toHaveCount(0);
});

// DW4a (ST-708, TS-2426): an assembly made in the CAD Surface (a panel with its door made a part)
// drawn with balloons numbered as its parts list, which lists the CAD BOM.
test('balloons and the parts list of a saved assembly', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'cad');
  const ready = () =>
    expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
      timeout: 90_000,
    });
  await ready();
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'panel.json', {
    ...empty,
    name: 'Panel',
    draft: { ...empty.draft, content: { ...f26Panel(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Panel');
  await ready();
  const bodies = page.getByRole('list', { name: 'Bodies' }).getByRole('button');
  await expect(bodies).toHaveCount(2);
  await bodies.nth(1).click();
  await page.getByRole('button', { name: 'Make part', exact: true }).click();
  await ready();
  await save(page, 1);

  await create(page, 'drawing');
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'Panel · v1' });
  await page.getByRole('button', { name: 'Place views', exact: true }).click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  // The panel lies flat: its door shows in the top view.
  await expect(list.getByRole('button', { name: '平面図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
    { timeout: 120_000 },
  );
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await page.getByRole('button', { name: '風船を付ける Add balloons (2)', exact: true }).click();
  await expect(list.getByRole('button', { name: '風船', exact: true })).toHaveCount(2);
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await page.getByRole('button', { name: '部品欄を置く Add parts list', exact: true }).click();
  const svg = await sheetSvg(page);
  for (const t of ['>1<', '>2<', '>品番<', '>panel-body<', '>door-body<']) expect(svg).toContain(t);
  expect(svg).not.toContain('class="err"');
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw4-assembly.png` });

  // DW4b (ST-709, TS-2429): a part drawing each, the door from its own saved version.
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await page.getByRole('button', { name: '部品図を作る Make part drawings', exact: true }).click();
  await expect(page.getByLabel('Sheet name')).toHaveValue('1 panel-body', { timeout: 120_000 });
  for (const sheet of ['1 panel-body', '2 door-body']) {
    await page.getByRole('button', { name: new RegExp(`^\\d+\\. ${sheet}`) }).click();
    await expect(page.getByLabel('Sheet name')).toHaveValue(sheet);
    for (const name of ['正面図', '平面図', '右側面図'])
      await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
        'data-view-state',
        'ready',
        { timeout: 120_000 },
      );
    const part = await sheetSvg(page);
    expect(part).not.toContain('class="err"');
    // The candidates: at least the width, height and depth.
    expect(part.match(/class="dimension"/g)?.length ?? 0).toBeGreaterThan(0);
  }
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw4-part-drawing-panel.png` });
});

// DW5a (ST-710, TS-2434): a saved building's plan placed on a drawing sheet: the building
// version is kept with the drawing and its plan is cut by the kernel as the building editor does.
test('a saved building’s plan on a drawing sheet', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'bim');
  const template = await nativeArtifact(page);
  const doc = f31BoxBuilding();
  doc.grids = [
    { id: 'g-a', label: 'A', start: [0, -1000], end: [0, 9000] },
    { id: 'g-b', label: 'B', start: [10000, -1000], end: [10000, 9000] },
  ];
  doc.views = [
    {
      id: 'v-1f',
      kind: 'plan',
      name: '1F plan',
      level: 'l-1f',
      cutHeightMm: 1200,
      depthMm: 1200,
      scale: 100,
    },
  ];
  await importJson(page, 'house.json', {
    ...template,
    name: 'House',
    draft: { ...template.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('House');
  await save(page, 1);

  await create(page, 'drawing');
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'House · v1' });
  await expect(page.getByLabel('Building view', { exact: true })).toHaveValue('view:v-1f');
  await page.getByRole('button', { name: 'Place building view', exact: true }).click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.getByRole('button', { name: '1F plan', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
    { timeout: 120_000 },
  );
  const drawing = await draft(page);
  expect(drawing.sources.map((s) => s.kind)).toEqual(['bim']);
  expect(drawing.views).toMatchObject([{ kind: 'bim-view', bimViewId: 'v-1f', scale: '1:100' }]);
  const record = await nativeArtifact(page);
  expect(record.drawingSources?.map((s) => [s.kind, s.contentHash])).toEqual([
    ['bim', drawing.sources[0]!.contentHash],
  ]);
  // The four cut walls filled, outlined thick; the grids as chain lines with their labels.
  const svg = await sheetSvg(page);
  expect(svg.match(/class="area"/g)).toHaveLength(4);
  expect(svg).toMatch(/class="center"/);
  expect(svg).toContain('>A<');
  expect(svg).toContain('1F plan  1:100');
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw5a-house-plan.png` });
  // At 1:50 the plan is twice the size on paper.
  await list.getByRole('button', { name: '1F plan', exact: true }).click();
  await page.getByLabel('Scale', { exact: true }).selectOption('1:50');
  await expect(list.getByRole('button', { name: '1F plan', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
    { timeout: 120_000 },
  );
  expect((await draft(page)).views[0]!.scale).toBe('1:50');
});

// DW5b (ST-711, TS-2439): a saved office's framing plan, framing elevation and front elevation on
// one sheet: members marked with their type's name, the elevation seen by the kernel.
test('a saved office’s framing plan, frame and elevation', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(400_000);
  await page.goto('/');
  await create(page, 'bim');
  const template = await nativeArtifact(page);
  await importJson(page, 'office.json', {
    ...template,
    name: 'Office',
    draft: { ...template.draft, content: f37Office() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Office');
  await save(page, 1);

  await create(page, 'drawing');
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'Office · v1' });
  const picker = page.getByLabel('Building view', { exact: true });
  const list = page.getByRole('list', { name: 'Views and notes' });
  const place = async (option: string, name: string, shot: string) => {
    // A sheet each: each fits its sheet.
    if ((await draft(page)).views.length)
      await page.getByRole('button', { name: 'Add sheet', exact: true }).click();
    await picker.selectOption({ label: option });
    await page.getByRole('button', { name: 'Place building view', exact: true }).click();
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
      { timeout: 180_000 },
    );
    if (process.env.DRAWING_SHOTS)
      await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw5b-office-${shot}.png` });
    svgs.push(await sheetSvg(page));
  };
  const svgs: string[] = [];
  await place('伏図 2F', '2F 伏図', 'framing');
  await place('軸組図 Y1通り', 'Y1 通り軸組図', 'frame');
  await place('立面図 正面 Front elevation', '正面立面図', 'elevation');
  const drawing = await draft(page);
  expect(drawing.sources).toHaveLength(1);
  expect(drawing.views.map((v) => v.kind)).toEqual(['bim-framing', 'bim-frame', 'bim-elevation']);
  expect(new Set(drawing.views.map((v) => v.sheetId)).size).toBe(3);
  // 58 beams on the 2F framing plan and 30 on Y1, each marked; levels and axes on the frame.
  expect(svgs[0]!.match(/>RC beam 400×700</g)).toHaveLength(58);
  expect(svgs[1]!.match(/>RC beam 400×700</g)).toHaveLength(30);
  for (const t of ['>2F +4000<', '>X1<', 'Y1 通り軸組図  1:']) expect(svgs[1]).toContain(t);
  expect(svgs[2]).toContain('正面立面図  1:');
  // The elevation stands outside the axes' ends and still shows all seven X axes.
  for (let i = 1; i <= 7; i++) expect(svgs[2]).toContain(`>X${i}<`);
  // DW5c (TS-2442): the axes' spacings and overall, the storey heights, on the frame and the
  // elevation; the building's member list on the elevation's sheet.
  for (const svg of svgs.slice(1))
    for (const t of ['>7200<', '>43200<', '>4000<']) expect(svg).toContain(t);
  await page.getByRole('button', { name: '部材リストを置く Add member list', exact: true }).click();
  await expect(list.getByRole('button', { name: '部材リスト', exact: true })).toBeVisible();
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw5c-office-member-list.png` });
  const withList = await sheetSvg(page);
  for (const t of ['>符号<', '>RC column 600<', '>600×600<', '>175<', '>700.000<', '>290<'])
    expect(withList).toContain(t);
  // DW6 (TS-2447): the set's sheets as one DXF, the member list's text in it.
  const dxfDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export DXF (all sheets)', exact: true }).click();
  const dxf = await dxfDownload;
  const text = readFileSync(await dxf.path(), 'utf8');
  expect(text).toContain('RC column 600');
  if (process.env.DRAWING_SHOTS) {
    await dxf.saveAs(`${process.env.DRAWING_SHOTS}/dw6-office.dxf`);
    const pdfDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PDF (all sheets)', exact: true }).click();
    await (await pdfDownload).saveAs(`${process.env.DRAWING_SHOTS}/dw6-office.pdf`);
  }
});
