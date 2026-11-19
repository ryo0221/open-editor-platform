import { readFileSync } from 'node:fs';
import { f130Eaxle, sk01Watch, type CadDocument } from '@editor-platform/cad-core';
import type { DrawingDocument } from '@editor-platform/drawing-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// DW8 (docs/cad/drawing-editor.md; ST-719): the example drawing sets made in the Playground.
// Needs the development kernel. With DRAWING_SHOTS set, each sheet's screenshot, the set's PDF
// and a video of the run go there (the demo, never committed).
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');
test.use({
  video: process.env.DRAWING_SHOTS ? { mode: 'on', size: { width: 1280, height: 800 } } : 'off',
});

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
const shot = async (page: Page, name: string) => {
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/${name}.png` });
};

// TS-2458
test('the SK-01 watch: assembly drawing with balloons and parts list, and its part drawings', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(1_800_000);
  await page.goto('/');
  await create(page, 'cad');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const watch = sk01Watch({ id, buildHash });
  await importJson(page, 'sk01.json', {
    ...empty,
    name: 'SK-01',
    draft: { ...empty.draft, content: watch.assembly },
    cadParts: [...watch.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('SK-01');
  await save(page, 1);

  await create(page, 'drawing');
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'SK-01 · v1' });
  await page.getByRole('button', { name: 'Place views', exact: true }).click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  for (const name of ['正面図', '平面図', '右側面図'])
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
      { timeout: 600_000 },
    );
  await shot(page, 'dw8-sk01-views');
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  const balloons = page.getByRole('button', { name: /^風船を付ける Add balloons \(\d+\)$/ });
  await balloons.click();
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await page.getByRole('button', { name: '部品欄を置く Add parts list', exact: true }).click();
  const assembly = await sheetSvg(page);
  expect(assembly).not.toContain('class="err"');
  for (const t of ['>品番<', '>1<']) expect(assembly).toContain(t);
  await shot(page, 'dw8-sk01-assembly');

  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await page.getByRole('button', { name: '部品図を作る Make part drawings', exact: true }).click();
  await expect(page.getByLabel('Sheet name')).toHaveValue(/^1 /, { timeout: 900_000 });
  // Every part drawn: none skipped (Codex on #1260).
  await expect(page.getByTestId('drawing-notice')).toHaveCount(0);
  const doc = await draft(page);
  const sheets = doc.sheets.slice(1);
  expect(sheets).toHaveLength(watch.parts.length);
  for (const [i, sheet] of sheets.entries()) {
    await page
      .getByRole('button', {
        name: new RegExp(`^\\d+\\. ${sheet.name.replace(/[()]/g, '\\$&')}( |$)`),
      })
      .click();
    await expect(page.getByLabel('Sheet name')).toHaveValue(sheet.name);
    await expect(list.locator('[data-view-state=pending]')).toHaveCount(0, { timeout: 300_000 });
    await expect(list.locator('[data-view-state=failed]')).toHaveCount(0);
    const svg = await sheetSvg(page);
    expect(svg, sheet.name).not.toContain('class="err"');
    await shot(page, `dw8-sk01-part-${String(i + 1).padStart(2, '0')}`);
  }
  if (process.env.DRAWING_SHOTS) {
    const pdf = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PDF (all sheets)', exact: true }).click();
    await (await pdf).saveAs(`${process.env.DRAWING_SHOTS}/dw8-sk01.pdf`);
  }
});

/** Opens a sheet by its name in the Sheets list and waits for its views. */
async function openSheet(page: Page, name: string) {
  await page
    .getByRole('button', { name: new RegExp(`^\\d+\\. ${name.replace(/[()]/g, '\\$&')}( |$)`) })
    .click();
  await expect(page.getByLabel('Sheet name')).toHaveValue(name);
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.locator('[data-view-state=pending]')).toHaveCount(0, { timeout: 300_000 });
  await expect(list.locator('[data-view-state=failed]')).toHaveCount(0);
}

// TS-2459 (DW9): the e-Axle F130 (DW7): an assembly drawing with a full section through the
// three shafts, balloons and the parts list, then the part drawings, on which the fits, a
// datum, a run-out and the surface texture of the gears and the case are written.
test('the e-Axle F130: sectioned assembly drawing and part drawings with fits and tolerances', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(3_000_000);
  await page.goto('/');
  await create(page, 'cad');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const axle = f130Eaxle({ id, buildHash });
  await importJson(page, 'f130.json', {
    ...empty,
    name: 'F130 e-Axle',
    draft: { ...empty.draft, content: axle.assembly },
    cadParts: [...axle.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F130 e-Axle');
  await save(page, 1);

  await create(page, 'drawing');
  await page.getByLabel('Size', { exact: true }).selectOption('A2');
  await page
    .getByLabel('Source version', { exact: true })
    .selectOption({ label: 'F130 e-Axle · v1' });
  await page.getByRole('button', { name: 'Place views', exact: true }).click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  for (const name of ['正面図', '平面図', '右側面図'])
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
      { timeout: 900_000 },
    );
  // The full section through the shafts' plane: a horizontal cutting line through the origin of
  // the top view (the input shaft's axis; the counter and output shafts lie on the same plane).
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await page.getByLabel('Cutting line', { exact: true }).selectOption('up');
  await page.getByLabel('断面を原点から Section from the model origin', { exact: true }).check();
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  await expect(list.getByRole('button', { name: '断面 A–A', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
    { timeout: 900_000 },
  );
  // A detail of the gear train in the section, from the input shaft's axis, at 1:2.
  await list.getByRole('button', { name: '断面 A–A', exact: true }).click();
  await page.getByLabel('詳細を原点から Detail from the model origin', { exact: true }).check();
  await page.getByLabel('Detail x from origin (mm)', { exact: true }).fill('95');
  await page.getByLabel('Detail y from origin (mm)', { exact: true }).fill('35');
  await page.getByLabel('New detail radius (mm)', { exact: true }).fill('120');
  await page.getByLabel('New detail scale', { exact: true }).selectOption('1:2');
  await page.getByRole('button', { name: 'Add detail', exact: true }).click();
  await expect(list.getByRole('button', { name: '詳細 B', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
    { timeout: 900_000 },
  );
  await shot(page, 'dw9-eaxle-views');
  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await page.getByRole('button', { name: /^風船を付ける Add balloons \(\d+\)$/ }).click();
  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await page.getByRole('button', { name: '部品欄を置く Add parts list', exact: true }).click();
  const assembly = await sheetSvg(page);
  expect(assembly).not.toContain('class="err"');
  expect(assembly).toContain('class="hatch"');
  expect(assembly).toContain('>品番<');
  await shot(page, 'dw9-eaxle-assembly');

  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await page.getByRole('button', { name: '部品図を作る Make part drawings', exact: true }).click();
  await expect(page.getByLabel('Sheet name')).toHaveValue(/^1 /, { timeout: 1_800_000 });
  const doc = await draft(page);
  const sheets = doc.sheets.slice(1);
  await expect(page.getByTestId('drawing-notice')).toHaveCount(0);
  expect(sheets).toHaveLength(axle.parts.length);
  for (const [i, sheet] of sheets.entries()) {
    await openSheet(page, sheet.name);
    expect(await sheetSvg(page), sheet.name).not.toContain('class="err"');
    await shot(page, `dw9-eaxle-part-${String(i + 1).padStart(2, '0')}`);
  }

  // The final gear: the bore Ø104 H7 is datum A, the tip runs out within 0.03 of it, and the
  // bore is ground to Ra 0.8.
  const finalGear = sheets.find((x) => / Final gear$/.test(x.name))!;
  await openSheet(page, finalGear.name);
  await list.getByRole('button', { name: /^寸法 直径 104/ }).click();
  await page.getByLabel('Fit (はめあい)', { exact: true }).selectOption('H7');
  await expect(list.getByRole('button', { name: /^寸法 直径 104/ })).toBeVisible();
  const top = (await page
    .getByTestId('drawing-sheet')
    .getByRole('button', { name: 'View 平面図', exact: true })
    .boundingBox())!;
  const cx = top.x + top.width / 2;
  const cy = top.y + top.height / 2;
  const mm = top.width / 160; // about the tip circle's diameter
  const snapNear = async (x: number, y: number) => {
    await page.mouse.move(x, y);
    const mark = page.getByTestId('drawing-snap');
    await expect(mark).toBeVisible();
    const m = (await mark.boundingBox())!;
    return { x: m.x + m.width / 2, y: m.y + m.height / 2 };
  };
  const symbol = async (
    type: string,
    target: { x: number; y: number },
    place: { x: number; y: number },
  ) => {
    await page.getByRole('button', { name: 'Add symbol', exact: true }).click();
    await page.getByLabel('Symbol type', { exact: true }).selectOption(type);
    const p = await snapNear(target.x, target.y);
    await page.mouse.click(p.x, p.y);
    await page.mouse.click(place.x, place.y);
  };
  // The bore's edge, below and to the right of the centre.
  const bore = { x: cx + 52 * mm * 0.71, y: cy + 52 * mm * 0.71 };
  await symbol('datum', bore, { x: bore.x + 40 * mm, y: bore.y + 30 * mm });
  await expect(list.getByRole('button', { name: /^データム A/ })).toBeVisible();
  const tip = { x: cx - 78 * mm * 0.71, y: cy - 78 * mm * 0.71 };
  await symbol('gdt', tip, { x: tip.x - 50 * mm, y: tip.y - 20 * mm });
  await page.getByLabel('Characteristic', { exact: true }).selectOption('circular-runout');
  const value = page.getByLabel('Tolerance value', { exact: true });
  await value.fill('0.03');
  await value.press('Enter');
  const bore2 = { x: cx - 52 * mm * 0.71, y: cy + 52 * mm * 0.71 };
  await symbol('surface', bore2, { x: bore2.x - 40 * mm, y: bore2.y + 40 * mm });
  const req = page.getByLabel('Surface requirement', { exact: true });
  await req.fill('Ra 0.8');
  await req.press('Enter');
  await page.keyboard.press('Escape');
  const gear = await sheetSvg(page);
  expect(gear).not.toContain('class="err"');
  for (const t of ['H7', '0.03', 'Ra 0.8', '>A<']) expect(gear).toContain(t);
  await shot(page, 'dw9-eaxle-final-gear');

  // The input gear shaft: its bearing seats Ø30 k6.
  const input = sheets.find((x) => / Input gear shaft$/.test(x.name))!;
  await openSheet(page, input.name);
  await list
    .getByRole('button', { name: /^寸法 直径 30/ })
    .first()
    .click();
  const tol = page.getByLabel('Tolerance', { exact: true });
  await tol.fill('k6');
  await tol.press('Enter');
  expect(await sheetSvg(page)).toContain('k6');
  await shot(page, 'dw9-eaxle-input-shaft');
  if (process.env.DRAWING_SHOTS) {
    const pdf = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PDF (all sheets)', exact: true }).click();
    await (await pdf).saveAs(`${process.env.DRAWING_SHOTS}/dw9-eaxle.pdf`);
  }
});

// DW9 (TS-2459): the 634 m tower's construction drawings from its BIM (DW5): the ground and
// deck plans, the deck's framing plan and the tower's section with the member list. The
// tower's BIM document is local demo data (SKYTREE_BIM: its JSON), so this runs only where it
// is. Its elevation is left out: drawing all 1,228 elements took more than ten minutes.
test('the 634 m tower: plans, framing plan and section with the member list', async ({ page }) => {
  test.skip(!process.env.SKYTREE_BIM, 'SKYTREE_BIM is not set');
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(2_400_000);
  const tower = JSON.parse(readFileSync(process.env.SKYTREE_BIM!, 'utf8')) as unknown;
  await page.goto('/');
  await create(page, 'bim');
  const template = await nativeArtifact(page);
  await importJson(page, 'tower.json', {
    ...template,
    name: 'Tower',
    draft: { ...template.draft, content: tower },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Tower');
  await save(page, 1);

  await create(page, 'drawing');
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'Tower · v1' });
  const picker = page.getByLabel('Building view', { exact: true });
  const list = page.getByRole('list', { name: 'Views and notes' });
  const place = async (
    option: string,
    name: string,
    size: string,
    orientation: 'landscape' | 'portrait',
    shotName: string,
  ) => {
    if ((await draft(page)).views.length)
      await page.getByRole('button', { name: 'Add sheet', exact: true }).click();
    await page.getByLabel('Size', { exact: true }).selectOption(size);
    await page.getByLabel('Sheet orientation', { exact: true }).selectOption(orientation);
    await picker.selectOption({ label: option });
    // To the sheet, not the view's own scale (the tower's section at 1:500 runs off A1).
    await page.getByLabel('View scale', { exact: true }).selectOption('fit');
    await page.getByRole('button', { name: 'Place building view', exact: true }).click();
    // While it is drawn, the sheet says so where it goes: never a blank sheet.
    if (option.startsWith('断面図'))
      await expect(page.getByTestId('drawing-placing')).toContainText(name);
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
      { timeout: 900_000 },
    );
    expect(await sheetSvg(page), name).not.toContain('class="err"');
    await shot(page, shotName);
  };
  await place('平面図 GL plan', 'GL plan', 'A1', 'landscape', 'dw9-tower-gl-plan');
  await place('平面図 Deck 340 plan', 'Deck 340 plan', 'A1', 'landscape', 'dw9-tower-deck-plan');
  await place('伏図 Deck 340', 'Deck 340 伏図', 'A1', 'landscape', 'dw9-tower-deck-framing');
  await place('断面図 Tower section', 'Tower section', 'A1', 'portrait', 'dw9-tower-section');
  // The tower's member list beside its section.
  await page.getByRole('button', { name: '部材リストを置く Add member list', exact: true }).click();
  await expect(list.getByRole('button', { name: '部材リスト', exact: true })).toBeVisible();
  const withList = await sheetSvg(page);
  expect(withList).toContain('>符号<');
  expect(withList).not.toContain('class="err"');
  await shot(page, 'dw9-tower-section-members');
  await expect(page.getByTestId('drawing-placing')).toHaveCount(0);
  if (process.env.DRAWING_SHOTS) {
    // For the video: the finished sheet held, then a closer look, then the whole sheet again.
    await page.waitForTimeout(3000);
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: 'Fit sheet', exact: true }).click();
    await page.waitForTimeout(2000);
  }
  const doc = await draft(page);
  expect(doc.views.map((v) => v.kind)).toEqual(['bim-view', 'bim-view', 'bim-framing', 'bim-view']);
  if (process.env.DRAWING_SHOTS) {
    const pdf = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PDF (all sheets)', exact: true }).click();
    await (await pdf).saveAs(`${process.env.DRAWING_SHOTS}/dw9-tower.pdf`);
  }
});
