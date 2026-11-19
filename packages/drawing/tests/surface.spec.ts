import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import type { DrawingController } from '../src';
import { expect, test, type Page } from '@playwright/test';

// The drawing Surface's standalone host (DW1–DW2, N06; ST-700, TS-2405): no Playground state
// or CSS. Desktop and mobile viewports.

type Doc = {
  views: { direction: string; at: [number, number] }[];
  annotations: { text: string }[];
  sheets: unknown[];
};
const content = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { drawingSession: { content: Doc } }).drawingSession.content,
  );
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
/** A toolbar tool, from the overflow menu on a narrow screen. */
async function tool(page: Page, name: string) {
  const shown = button(page, name).filter({ visible: true });
  if (!(await shown.count())) await button(page, 'More editor tools').click();
  return shown.first();
}
/** The left panel, opened on a narrow screen. */
async function panel(page: Page) {
  if (!(await page.getByLabel('Source version', { exact: true }).isVisible()))
    await button(page, 'Toggle Sheets').click();
}

test('place three views, undo and redo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await panel(page);
  await button(page, 'Place views').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  for (const name of ['正面図', '平面図', '右側面図'])
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
    );
  const doc = await content(page);
  expect(doc.views.map((v) => v.direction)).toEqual(['front', 'top', 'right']);
  const svg = await page
    .getByTestId('drawing-sheet')
    .locator('img')
    .evaluate((img: HTMLImageElement) => fetch(img.src).then((r) => r.text()));
  expect(svg).toMatch(/<polyline class="hidden" points="/);
  expect(svg).toMatch(/<polyline class="center" points="/);

  await (await tool(page, 'Undo')).click();
  await expect.poll(async () => (await content(page)).views.length).toBe(0);
  await (await tool(page, 'Redo')).click();
  await expect.poll(async () => (await content(page)).views.length).toBe(3);
  expect(errors).toEqual([]);
});

test('read only: placing views and deleting are refused, the content stays', async ({ page }) => {
  await page.goto('/?readonly=1');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  const before = await content(page);
  await panel(page);
  await expect(button(page, 'Place views')).toBeDisabled();
  await expect(await tool(page, 'Add note')).toBeDisabled();
  // Around the Surface: the controller refuses too.
  const code = await page.evaluate(() =>
    (
      window as unknown as { drawingController: { addSheet(s: string, o: string): string } }
    ).drawingController.addSheet('A4', 'portrait'),
  );
  expect(code).toBe('permission-denied');
  expect(await content(page)).toEqual(before);
});

// DW2b (ST-702, TS-2409): a section and a detail, and the switch to a newer version.
test('section, detail and a newer version', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the inspector flow is checked on desktop');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?versions=2');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'Block · v1' });
  await page.getByLabel('Views', { exact: true }).selectOption('front');
  await page.getByLabel('View scale', { exact: true }).selectOption('1:1');
  await button(page, 'Place views').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.getByRole('button', { name: '正面図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await page.getByLabel('Cutting line', { exact: true }).selectOption('down');
  await page.getByLabel('Section offset from centre (mm)', { exact: true }).fill('0');
  await button(page, 'Add section').click();
  await expect(list.getByRole('button', { name: '断面 A–A', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  // A plan section through the hole wall: the hole is left unhatched (even–odd).
  const svg = () =>
    page
      .getByTestId('drawing-sheet')
      .locator('img')
      .evaluate((img: HTMLImageElement) => fetch(img.src).then((r) => r.text()));
  await expect.poll(svg).toMatch(/<path class="hatch" d="M/);
  await page.getByLabel('Detail x from centre (mm)', { exact: true }).fill('20');
  await page.getByLabel('New detail radius (mm)', { exact: true }).fill('8');
  await button(page, 'Add detail').click();
  await expect(list.getByRole('button', { name: '詳細 B', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  await expect.poll(svg).toMatch(/>B<\/text>/);

  // The newer version: one edit for every view of the source; Undo goes back.
  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await button(page, '新しい版を使う Use Block · v2').click();
  type Src = { sources: { versionId: string }[] };
  const sources = async () => ((await content(page)) as unknown as Src).sources;
  await expect.poll(async () => (await sources()).map((s) => s.versionId)).toEqual(['v2']);
  await expect(list.getByRole('button', { name: '断面 A–A', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  await (await tool(page, 'Undo')).click();
  await expect.poll(async () => (await sources()).map((s) => s.versionId)).toEqual(['v1']);
  expect(errors).toEqual([]);
});

// DW3a (ST-703, TS-2412): dimensions picked by snapping to drawn edges, and a leader note.
test('dimensions and a leader by snapping', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the pick flow is checked on desktop');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await page.getByLabel('View scale', { exact: true }).selectOption('1:1');
  await button(page, 'Place views').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  for (const name of ['正面図', '平面図'])
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
    );
  /** Screen point of the nearest snap to a paper point of a view's box corner. */
  type W = {
    drawingController: {
      paper: [number, number];
      state: {
        content: { views: { id: string; direction: string }[] };
        views: Map<string, { graphics: { bounds: [[number, number], [number, number]] } }>;
      };
      snap(p: [number, number], k: string, t: number): { paper: [number, number] } | undefined;
    };
  };
  const sheet = page.getByTestId('drawing-sheet');
  const screen = async (direction: string, kind: string, fx: number, fy: number) => {
    const box = (await sheet.boundingBox())!;
    const p = await page.evaluate(
      ({ direction, kind, fx, fy }) => {
        const c = (window as unknown as W).drawingController;
        const v = c.state.content.views.find((x) => x.direction === direction)!;
        const [[x0, y0], [x1, y1]] = c.state.views.get(v.id)!.graphics.bounds;
        const q: [number, number] = [x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy];
        return { snap: c.snap(q, kind, 1000)!.paper, paper: c.paper };
      },
      { direction, kind, fx, fy },
    );
    const s = box.width / p.paper[0];
    return { x: box.x + p.snap[0] * s, y: box.y + (p.paper[1] - p.snap[1]) * s, s };
  };
  type Dim = { kind: string; type: string; refs: { point: string }[] };
  const annotations = async () =>
    ((await content(page)).annotations as unknown as Dim[]).filter((a) => a.kind !== 'note');

  // The block's 60 mm length in the front view: two corners, then where the line goes.
  await button(page, 'Add dimension').click();
  const a = await screen('front', 'point', 0, 0);
  const b = await screen('front', 'point', 1, 0);
  await page.mouse.move(a.x, a.y);
  await expect(page.getByTestId('drawing-snap')).toBeVisible();
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await expect(page.getByTestId('drawing-pick')).toHaveCount(2);
  await page.mouse.click((a.x + b.x) / 2, a.y + 10 * a.s);
  await expect(list.getByRole('button', { name: '寸法 水平 60', exact: true })).toBeVisible();

  // The hole's diameter in the top view.
  await page.getByLabel('Dimension type', { exact: true }).selectOption('diameter');
  const c = await screen('top', 'circle', 0.5, 0.5);
  await page.mouse.click(c.x, c.y);
  await page.mouse.click(c.x + 15 * c.s, c.y - 15 * c.s);
  await expect(list.getByRole('button', { name: '寸法 直径 10', exact: true })).toBeVisible();

  // A leader to the hole's edge, its text placed off the view.
  await page.keyboard.press('Escape');
  await button(page, 'Add leader').click();
  await page.mouse.click(c.x, c.y);
  await page.mouse.click(c.x + 30 * c.s, c.y - 25 * c.s);
  await expect(list.getByRole('button', { name: '引出線 注記', exact: true })).toBeVisible();
  expect((await annotations()).map((x) => [x.kind, x.kind === 'dimension' ? x.type : ''])).toEqual([
    ['dimension', 'horizontal'],
    ['dimension', 'diameter'],
    ['leader', ''],
  ]);
  const svg = await sheet
    .locator('img')
    .evaluate((img: HTMLImageElement) => fetch(img.src).then((r) => r.text()));
  expect(svg).toContain('>60<');
  expect(svg).toContain('>Ø10<');

  // Chain then baseline in the top view: corner, hole centre, corner. Chain: 30 + 30;
  // baseline: 30, then 60 from the same corner.
  const count = (v: string) =>
    list.getByRole('button', { name: `寸法 水平 ${v}`, exact: true }).count();
  for (const [mode, thirty, sixty] of [
    ['chain', 2, 1],
    ['baseline', 3, 2],
  ] as const) {
    await page.keyboard.press('Escape');
    await button(page, 'Add dimension').click();
    await page.getByLabel('Dimension type', { exact: true }).selectOption('horizontal');
    await page.getByLabel('Dimension mode', { exact: true }).selectOption(mode);
    const p0 = await screen('top', 'point', 0, 0);
    const p1 = await screen('top', 'point', 0.5, 0.5);
    const p2 = await screen('top', 'point', 1, 0);
    await page.mouse.click(p0.x, p0.y);
    await page.mouse.click(p1.x, p1.y);
    await page.mouse.click(p1.x, p0.y + (mode === 'chain' ? 8 : 20) * p0.s);
    await page.mouse.click(p2.x, p2.y);
    await expect.poll(() => count('30')).toBe(thirty);
    expect(await count('60')).toBe(sixty);
  }
  await page.keyboard.press('Escape');

  // A tolerance on the selected dimension shows on the sheet.
  await list.getByRole('button', { name: '寸法 水平 60', exact: true }).first().click();
  await page.getByLabel('Tolerance', { exact: true }).fill('±0.1');
  await page.getByLabel('Tolerance', { exact: true }).press('Enter');
  await expect
    .poll(() =>
      sheet
        .locator('img')
        .evaluate((img: HTMLImageElement) => fetch(img.src).then((r) => r.text())),
    )
    .toContain('>60 ±0.1<');
  expect(errors).toEqual([]);
});

// DW3b (ST-704, TS-2414): a tolerance frame, its datum, surface texture, a weld and a fit.
test('symbols: tolerance frame, datum, surface texture, weld and a fit', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the pick flow is checked on desktop');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await page.getByLabel('Views', { exact: true }).selectOption('front');
  await page.getByLabel('View scale', { exact: true }).selectOption('1:1');
  await button(page, 'Place views').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.getByRole('button', { name: '正面図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  const sheet = page.getByTestId('drawing-sheet');
  const front = (await sheet
    .getByRole('button', { name: 'View 正面図', exact: true })
    .boundingBox())!;
  const top = { x: front.x + front.width * 0.3, y: front.y + 2 };
  const bottom = { x: front.x + front.width * 0.6, y: front.y + front.height - 2 };
  /** Adds a symbol of a type, pointing at `p`, placed `dx`, `dy` px away. */
  const add = async (type: string, p: { x: number; y: number }, dx: number, dy: number) => {
    await button(page, 'Add symbol').click();
    await page.getByLabel('Symbol type', { exact: true }).selectOption(type);
    await page.mouse.move(p.x, p.y);
    await expect(page.getByTestId('drawing-snap')).toBeVisible();
    await page.mouse.click(p.x, p.y);
    await page.mouse.click(p.x + dx, p.y + dy);
  };

  // A perpendicularity frame on the top edge to datum A: red until datum A is drawn.
  await add('gdt', top, 40, -60);
  await expect(list.getByRole('button', { name: '幾何公差 平面度', exact: true })).toBeVisible();
  await page.getByLabel('Characteristic', { exact: true }).selectOption('perpendicularity');
  // It needs a datum: it takes A, which the drawing does not have yet.
  await expect(page.getByLabel('Datums (A B C)', { exact: true })).toHaveValue('A');
  await expect(page.getByTestId('drawing-symbol-status')).toHaveText('データムがありません');
  await add('datum', bottom, -30, 50);
  await expect(list.getByRole('button', { name: 'データム A', exact: true })).toBeVisible();
  await list.getByRole('button', { name: '幾何公差 直角度', exact: true }).click();
  await expect(page.getByTestId('drawing-symbol-status')).toHaveCount(0);

  // Surface texture and a fillet weld all around.
  await add('surface', top, -60, -40);
  await expect(list.getByRole('button', { name: '表面性状 Ra 1.6', exact: true })).toBeVisible();
  await add('weld', bottom, 60, 40);
  await page.getByLabel('Weld side', { exact: true }).selectOption('both');
  await page.getByLabel('全周 All around', { exact: true }).check();
  await expect(list.getByRole('button', { name: '溶接 すみ肉', exact: true })).toBeVisible();

  type Sym = { kind: string; symbol?: Record<string, unknown> };
  const symbols = async () =>
    ((await content(page)).annotations as unknown as Sym[]).filter((a) => a.kind === 'symbol');
  expect((await symbols()).map((s) => s.symbol)).toEqual([
    {
      type: 'gdt',
      characteristic: 'perpendicularity',
      tolerance: '0.05',
      diameter: false,
      modifier: '',
      datums: ['A'],
    },
    { type: 'datum', letter: 'A' },
    { type: 'surface', process: 'removal', text: 'Ra 1.6' },
    {
      type: 'weld',
      weld: 'fillet',
      side: 'both',
      size: '6',
      length: '',
      allAround: true,
      field: false,
    },
  ]);
  const svg = await sheet
    .locator('img')
    .evaluate((img: HTMLImageElement) => fetch(img.src).then((r) => r.text()));
  for (const t of ['>0.05<', '>A<', '>Ra 1.6<', '>6<']) expect(svg).toContain(t);

  // A fit on a dimension: the 60 mm length as 60 H7/g6.
  await page.keyboard.press('Escape');
  await button(page, 'Add dimension').click();
  // The block's lower corners, from the controller's own snap (as the pick flow test does).
  const corner = async (fx: number) => {
    const box = (await sheet.boundingBox())!;
    const p = await page.evaluate((fx) => {
      type C = {
        paper: [number, number];
        state: {
          content: { views: { id: string }[] };
          views: Map<string, { graphics: { bounds: number[][] } }>;
        };
        snap(p: [number, number], k: string, t: number): { paper: [number, number] } | undefined;
      };
      const c = (window as unknown as { drawingController: C }).drawingController;
      const v = c.state.content.views[0]!;
      const [[x0, y0], [x1]] = c.state.views.get(v.id)!.graphics.bounds as [number[], number[]];
      return { snap: c.snap([x0! + (x1! - x0!) * fx, y0!], 'point', 1000)!.paper, paper: c.paper };
    }, fx);
    const k = box.width / p.paper[0];
    return { x: box.x + p.snap[0] * k, y: box.y + (p.paper[1] - p.snap[1]) * k };
  };
  const l = await corner(0);
  const r = await corner(1);
  for (const p of [l, r]) await page.mouse.click(p.x, p.y);
  await page.mouse.click((l.x + r.x) / 2, l.y + 80);
  // Esc from the weld's checkbox closed the Properties panel: open it again.
  if (!(await page.getByLabel('Fit (はめあい)', { exact: true }).isVisible()))
    await button(page, 'Toggle Properties').click();
  await page.getByLabel('Fit (はめあい)', { exact: true }).selectOption('H7/g6');
  await expect
    .poll(() =>
      sheet
        .locator('img')
        .evaluate((img: HTMLImageElement) => fetch(img.src).then((t) => t.text())),
    )
    .toContain('>60 H7/g6<');
  if (process.env.DRAWING_SHOTS) {
    await button(page, 'Zoom in').click();
    await button(page, 'Zoom in').click();
    await page.getByTestId('drawing-stage').evaluate((el) => {
      el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2 - 80;
    });
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw3b-symbols.png` });
  }
  expect(errors).toEqual([]);
});

/** Screen point of the snap nearest a point of a view's box (fractions of its bounds). */
async function snapOnScreen(page: Page, direction: string, kind: string, fx: number, fy: number) {
  type W = {
    drawingController: {
      paper: [number, number];
      state: {
        content: { views: { id: string; direction: string }[] };
        views: Map<string, { graphics: { bounds: [[number, number], [number, number]] } }>;
      };
      snap(p: [number, number], k: string, t: number): { paper: [number, number] } | undefined;
    };
  };
  const box = (await page.getByTestId('drawing-sheet').boundingBox())!;
  const p = await page.evaluate(
    ({ direction, kind, fx, fy }) => {
      const c = (window as unknown as W).drawingController;
      const v = c.state.content.views.find((x) => x.direction === direction)!;
      const [[x0, y0], [x1, y1]] = c.state.views.get(v.id)!.graphics.bounds;
      const q: [number, number] = [x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy];
      return { snap: c.snap(q, kind, 1000)!.paper, paper: c.paper };
    },
    { direction, kind, fx, fy },
  );
  const s = box.width / p.paper[0];
  return { x: box.x + p.snap[0] * s, y: box.y + (p.paper[1] - p.snap[1]) * s, s };
}

// DW3c-1 (ST-705, TS-2416): a newer version numbered otherwise: the length follows its edges'
// names; an end of a name two edges have is ambiguous and is chosen from the candidates; the
// hole whose names changed is unresolved and is picked again on the sheet.
test('dimensions follow a newer version; ambiguous and unresolved ones are chosen again', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'the pick flow is checked on desktop');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?versions=3');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'Block · v1' });
  await page.getByLabel('View scale', { exact: true }).selectOption('1:1');
  await button(page, 'Place views').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  for (const name of ['正面図', '平面図'])
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
    );
  await button(page, 'Add dimension').click();
  const a = await snapOnScreen(page, 'front', 'point', 0, 0);
  const b = await snapOnScreen(page, 'front', 'point', 1, 0);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.mouse.click((a.x + b.x) / 2, a.y + 10 * a.s);
  await expect(list.getByRole('button', { name: '寸法 水平 60', exact: true })).toBeVisible();
  await page.getByLabel('Dimension type', { exact: true }).selectOption('diameter');
  const c = await snapOnScreen(page, 'top', 'circle', 0.5, 0.5);
  await page.mouse.click(c.x, c.y);
  await page.mouse.click(c.x + 15 * c.s, c.y - 15 * c.s);
  await expect(list.getByRole('button', { name: '寸法 直径 10', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('list', { name: 'Unresolved dimensions' })).toHaveCount(0);

  // The newer version: the left end stays on its edge; the right end's name is on two edges now.
  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await button(page, '新しい版を使う Use Block · v3').click();
  const issues = page.getByRole('list', { name: 'Unresolved dimensions' });
  await expect(issues.getByRole('button')).toHaveText([
    '寸法 水平 曖昧 (2 候補)',
    '寸法 直径 未解決',
  ]);
  await expect(list.getByRole('button', { name: '寸法 水平 曖昧', exact: true })).toBeVisible();
  if (process.env.DRAWING_SHOTS) {
    await issues.getByRole('button', { name: /寸法 水平/ }).click();
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw3c-issues.png` });
  }

  // Choosing the candidate on the bottom edge: the length is the new 90 mm.
  await issues.getByRole('button', { name: /寸法 水平/ }).click();
  await expect(page.getByTestId('drawing-ref-issue')).toHaveCount(1);
  await page.getByRole('button', { name: /候補 \d Candidate \(90, 0, 0\)/ }).click();
  await expect(list.getByRole('button', { name: '寸法 水平 90', exact: true })).toBeVisible();

  // Picking the hole again in the top view.
  await issues.getByRole('button', { name: '寸法 直径 未解決', exact: true }).click();
  await button(page, '図で選び直す Pick again').click();
  await expect(page.getByTestId('drawing-pick-prompt')).toHaveText(
    'Click the edge or point it should measure; Esc cancels.',
  );
  const c3 = await snapOnScreen(page, 'top', 'circle', 0.5, 0.5);
  await page.mouse.click(c3.x, c3.y);
  await expect(list.getByRole('button', { name: '寸法 直径 10', exact: true })).toBeVisible();
  await expect(issues).toHaveCount(0);
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw3c-rebind.png` });

  // Undo takes the pick back: unresolved again.
  await (await tool(page, 'Undo')).click();
  await expect(issues.getByRole('button')).toHaveText(['寸法 直径 未解決']);
  expect(errors).toEqual([]);
});

// DW3c-2b (ST-707, TS-2421): a part's PMI imported into a view; on a newer version the changed
// length is updated and confirmed, the gone and stale items are expired, one is detached.
test('PMI imported into a view is updated, confirmed, expired and detached', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the PMI flow is checked on desktop');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?versions=3&pmi=1');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'Block · v1' });
  await page.getByLabel('View scale', { exact: true }).selectOption('1:1');
  await button(page, 'Place views').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.getByRole('button', { name: '平面図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await button(page, 'PMIを取り込む Import PMI (3)').click();
  for (const name of ['PMI データム A', 'PMI Position Ø0.1 Ⓜ | A', 'PMI 60 ±0.1'])
    await expect(list.getByRole('button', { name, exact: true })).toBeVisible();
  // Imported once: nothing left to import in that view.
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await expect(page.getByRole('button', { name: /Import PMI/ })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'PMI to review' })).toHaveCount(0);
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw3c-pmi.png` });

  // v3: the length is 90 now; the hole's tolerance is gone and the datum stale.
  await button(page, '新しい版を使う Use Block · v3').click();
  const review = page.getByRole('list', { name: 'PMI to review' }).getByRole('button');
  await expect(review).toHaveText([
    'PMI データム A 失効・要確認',
    'PMI Position Ø0.1 Ⓜ | A 失効・要確認',
    'PMI 60 ±0.1 内容を更新',
  ]);
  await review.filter({ hasText: '60 ±0.1' }).click();
  await expect(page.getByTestId('drawing-pmi-item')).toHaveText('90 ±0.1 · 内容を更新');
  await expect(page.getByRole('list', { name: 'PMI changes' })).toHaveText('60 ±0.1 → 90 ±0.1');
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw3c-pmi-updated.png` });
  await button(page, '更新を確認 Confirm').click();
  await expect(list.getByRole('button', { name: 'PMI 90 ±0.1', exact: true })).toBeVisible();
  await expect(review).toHaveCount(2);

  // The gone tolerance, kept as a manual frame.
  await review.filter({ hasText: 'Position' }).click();
  await expect(page.getByTestId('drawing-pmi-item')).toHaveText(
    'Position Ø0.1 Ⓜ | A · 失効・要確認',
  );
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw3c-pmi-expired.png` });
  await button(page, '手動の注記へ切り離す Detach').click();
  await expect(review).toHaveText(['PMI データム A 失効・要確認']);
  await expect(list.getByRole('button', { name: /^PMI Position/ })).toHaveCount(0);
  await (await tool(page, 'Undo')).click();
  await expect(review).toHaveCount(2);

  expect(errors).toEqual([]);
});

// DW3c-2b after Codex on #1223: datum A imported into two views, both detached: the second
// letter A cannot be a second manual datum, so it is kept as text.
test('a datum imported twice detaches once as a symbol, then as text', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the PMI flow is checked on desktop');
  await page.goto('/?pmi=1');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await page.getByLabel('View scale', { exact: true }).selectOption('1:1');
  await button(page, 'Place views').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  for (const name of ['平面図', '正面図']) {
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
    );
    await list.getByRole('button', { name, exact: true }).click();
    await button(page, 'PMIを取り込む Import PMI (3)').click();
  }
  const result = await page.evaluate(() => {
    const c = (window as never as { drawingController: DrawingController }).drawingController;
    const datums = () =>
      c.state.content.annotations.filter((a) => a.kind === 'pmi' && a.item.kind === 'datum');
    const refused = datums().map((a) => c.detachPmi(a.id));
    return {
      refused,
      left: datums().length,
      kinds: c.state.content.annotations
        .filter((a) => a.kind === 'symbol' || a.kind === 'leader')
        .map((a) => a.kind),
    };
  });
  expect(result).toEqual({ refused: [undefined, undefined], left: 0, kinds: ['symbol', 'leader'] });
});

// DW4a (ST-708, TS-2424): an assembly's balloons (numbered as its parts list) and its parts list;
// a part left out of the BOM takes no balloon; a balloon picked by hand; Undo.
test('balloons and a parts list on an assembly view', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the balloon flow is checked on desktop');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?assembly=1');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await page.getByLabel('View scale', { exact: true }).selectOption('1:1');
  await button(page, 'Place views').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.getByRole('button', { name: '正面図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await button(page, '風船を付ける Add balloons (2)').click();
  await expect(list.getByRole('button', { name: '風船', exact: true })).toHaveCount(2);
  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await expect(page.getByRole('button', { name: /Add balloons/ })).toHaveCount(0);
  await button(page, '部品欄を置く Add parts list').click();
  await expect(list.getByRole('button', { name: '部品欄', exact: true })).toBeVisible();
  const svg = await page.evaluate(() =>
    (window as never as { drawingController: DrawingController }).drawingController.sheetSvg(),
  );
  for (const t of ['>1<', '>2<', '>品番<', '>B-100<', '>Cube<', '>S45C<']) expect(svg).toContain(t);
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw4-balloons.png` });

  // By hand: the pin (left out of the BOM) takes none; a cube takes the number 2.
  await (await tool(page, 'Add balloon')).click();
  const pin = await snapOnScreen(page, 'front', 'line', 0.5, 0.97);
  await page.mouse.click(pin.x, pin.y);
  await page.mouse.click(pin.x + 25 * pin.s, pin.y - 10 * pin.s);
  await expect(page.getByRole('alert')).toContainText('No part of the assembly there');
  await expect(list.getByRole('button', { name: '風船', exact: true })).toHaveCount(2);
  await (await tool(page, 'Add balloon')).click();
  const cube = await snapOnScreen(page, 'front', 'line', 0.1, 0.55);
  await page.mouse.click(cube.x, cube.y);
  await page.mouse.click(cube.x - 25 * cube.s, cube.y + 20 * cube.s);
  await expect(list.getByRole('button', { name: '風船', exact: true })).toHaveCount(3);
  const numbers = await page.evaluate(() => {
    const c = (window as never as { drawingController: DrawingController }).drawingController;
    return c.state.content.annotations.flatMap((a) =>
      a.kind === 'balloon' ? [c.partRowOf(a.viewId, a.ref)?.item] : [],
    );
  });
  expect(numbers.sort()).toEqual(['1', '2', '2']);
  await (await tool(page, 'Undo')).click();
  await expect(list.getByRole('button', { name: '風船', exact: true })).toHaveCount(2);
  expect(errors).toEqual([]);
});

// DW4b (ST-709, TS-2428): part drawings made from an assembly view: a sheet a part, three views,
// the outline and hole dimensions as candidates; made once; Undo.
test('part drawings made from an assembly view', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the part drawing flow is checked on desktop');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?assembly=1');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await button(page, 'Place views').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.getByRole('button', { name: '正面図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  await list.getByRole('button', { name: '正面図', exact: true }).click();
  await button(page, '部品図を作る Make part drawings').click();
  await expect(page.getByLabel('Sheet name')).toHaveValue('1 Base');
  for (const name of ['正面図', '平面図', '右側面図'])
    await expect(list.getByRole('button', { name, exact: true })).toHaveAttribute(
      'data-view-state',
      'ready',
    );
  const sheets = await page.evaluate(() => {
    const c = (window as never as { drawingController: DrawingController }).drawingController;
    const doc = c.state.content;
    return doc.sheets.slice(1).map((s) => ({
      name: s.name,
      title: [s.title.title, s.title.drawingNumber, s.title.quantity],
      views: doc.views.filter((v) => v.sheetId === s.id).map((v) => v.name),
      dims: doc.annotations.flatMap((a) =>
        a.sheetId === s.id && a.kind === 'dimension'
          ? [[a.type, c.annotationGraphics(a).status]]
          : [],
      ),
      svg: c.sheetSvg(s.id),
    }));
  });
  expect(sheets.map((s) => [s.name, s.title, s.views])).toEqual([
    ['1 Base', ['Base', 'B-100', '1'], ['正面図', '平面図', '右側面図']],
    ['2 Cube', ['Cube', 'C-20', '2'], ['正面図', '平面図', '右側面図']],
  ]);
  // The base: 60 × 20 on the front, 40 deep on the top, its Ø10 hole and its place (30, 20).
  const base = sheets[0]!;
  expect(base.dims.every(([, status]) => status === 'ok')).toBe(true);
  expect(base.dims.map(([t]) => t).sort()).toEqual(
    ['diameter', 'horizontal', 'horizontal', 'vertical', 'vertical', 'vertical'].sort(),
  );
  for (const t of ['>60<', '>40<', '>20<', '>Ø10<', '>30<']) expect(base.svg).toContain(t);
  // The cube (its own saved version): 20 × 20 × 20, no hole.
  const cube = sheets[1]!;
  expect(cube.dims.map(([t, s]) => `${t} ${s}`).sort()).toEqual(
    ['horizontal ok', 'vertical ok', 'vertical ok'].sort(),
  );
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw4-part-drawing.png` });

  // Made once: again, nothing new.
  const again = await page.evaluate(async () => {
    const c = (window as never as { drawingController: DrawingController }).drawingController;
    const asm = c.state.content.views[0]!.id;
    await c.addPartDrawings(asm);
    return [c.state.notice?.code, c.state.content.sheets.length];
  });
  expect(again).toEqual(['part-drawn', 3]);
  await (await tool(page, 'Undo')).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as never as { drawingController: DrawingController }).drawingController.state
            .content.sheets.length,
      ),
    )
    .toBe(1);
  expect(errors).toEqual([]);
});

// DW5a (ST-710, TS-2433): a building version's plan placed on the sheet from the picker, drawn
// in the drawing's line classes; its scales are the building editor's; Undo.
test('a building plan placed on the sheet', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the building view flow is checked on desktop');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?bim=1');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'Tower · v1' });
  await expect(page.getByLabel('Building view', { exact: true })).toHaveValue('view:v-1f');
  await button(page, 'Place building view').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.getByRole('button', { name: '1F plan', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  const placed = await page.evaluate(() => {
    const c = (window as never as { drawingController: DrawingController }).drawingController;
    const doc = c.state.content;
    return { sources: doc.sources.map((s) => s.kind), views: doc.views, svg: c.sheetSvg() };
  });
  expect(placed.sources).toEqual(['bim']);
  expect(placed.views).toMatchObject([{ kind: 'bim-view', bimViewId: 'v-1f', scale: '1:100' }]);
  // The cut walls filled and outlined thick, the grids as chain lines, their labels.
  expect(placed.svg).toContain('class="area"');
  expect(placed.svg).toMatch(/class="center"/);
  expect(placed.svg).toContain('>A<');
  expect(placed.svg).toContain('1F plan  1:100');
  // Only the building editor's scales.
  await list.getByRole('button', { name: '1F plan', exact: true }).click();
  await expect(page.getByLabel('Scale', { exact: true }).locator('option')).toHaveText([
    '1:50',
    '1:100',
    '1:200',
    '1:500',
    '1:1000',
  ]);
  // Its lines are the building editor's: no hidden or centre line switches.
  await expect(page.getByLabel('Hidden lines (かくれ線)', { exact: true })).toHaveCount(0);
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw5a-building-plan.png` });
  await (await tool(page, 'Undo')).click();
  await expect(list.getByRole('button', { name: '1F plan', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// DW5b (ST-711, TS-2438): a framing plan from the building view picker, its members heavy and
// marked; the frame's band is asked; Undo.
test('a framing plan placed from the building view picker', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the building view flow is checked on desktop');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?bim=1');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'Tower · v1' });
  const picker = page.getByLabel('Building view', { exact: true });
  await expect(picker.locator('option')).toHaveText([
    '平面図 1F plan',
    '立面図 正面 Front elevation',
    '立面図 背面 Rear elevation',
    '立面図 左側 Left elevation',
    '立面図 右側 Right elevation',
    '伏図 2F',
    '軸組図 A通り',
  ]);
  await picker.selectOption({ label: '軸組図 A通り' });
  await expect(page.getByLabel('Members within (mm)', { exact: true })).toHaveValue('1000');
  await picker.selectOption({ label: '伏図 2F' });
  await expect(page.getByLabel('Members within (mm)', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('View scale', { exact: true })).toHaveValue('fit');
  await button(page, 'Place building view').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.getByRole('button', { name: '2F 伏図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  const placed = await page.evaluate(() => {
    const c = (window as never as { drawingController: DrawingController }).drawingController;
    return { views: c.state.content.views, svg: c.sheetSvg() };
  });
  // The 12 m floor fits the sheet at 1:50.
  expect(placed.views).toMatchObject([{ kind: 'bim-framing', levelId: 'l-2f', scale: '1:50' }]);
  expect(placed.svg.match(/>G1</g)).toHaveLength(2);
  expect(placed.svg).toMatch(/<line class="thick"/);
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw5b-framing.png` });
  await (await tool(page, 'Undo')).click();
  await expect(list.getByRole('button', { name: '2F 伏図', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// DW6 (ST-713, TS-2446): every sheet exported as one PDF (a page each, its text searchable) and
// one DXF (R2000); without the Host's font the PDF is refused with the reason.
test('every sheet exported as PDF and DXF', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await panel(page);
  await button(page, 'Place views').click();
  await expect.poll(async () => (await content(page)).views.length).toBe(3);
  await page.evaluate(() =>
    (window as never as { drawingController: DrawingController }).drawingController.addSheet(
      'A4',
      'portrait',
    ),
  );
  const pdfDownload = page.waitForEvent('download');
  await (await tool(page, 'Export PDF (all sheets)')).click();
  const pdf = await pdfDownload;
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  const bytes = readFileSync(await pdf.path());
  const read = await PDFDocument.load(bytes);
  expect(read.getPageCount()).toBe(2);
  const dxfDownload = page.waitForEvent('download');
  await (await tool(page, 'Export DXF (all sheets)')).click();
  const dxf = await dxfDownload;
  expect(dxf.suggestedFilename()).toMatch(/\.dxf$/);
  const text = readFileSync(await dxf.path(), 'utf8');
  expect(text).toContain('AC1015');
  // The title blocks of both sheets.
  expect(text.match(/\\U\+56F3\\U\+540D/g)).toHaveLength(2);
  // No font from the Host: refused, with the reason.
  await page.goto('/?nofont=1');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  const none = page.waitForEvent('download', { timeout: 2_000 }).catch(() => null);
  await (await tool(page, 'Export PDF (all sheets)')).click();
  expect(await none).toBeNull();
  await expect(page.getByText(/fixed PDF font/)).toBeVisible();
  expect(errors).toEqual([]);
});

// DW6b (ST-714, TS-2451): a sheet with out-of-date PMI is not issued; once it is confirmed and
// the gone items detached, it is issued: revision A on the sheet, the issue listed with its PDF.
test('a sheet issued once its PMI is current', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the issue flow is checked on desktop');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?versions=3&pmi=1');
  await expect(page.getByTestId('drawing-sheet').locator('img')).toBeVisible();
  await page.getByLabel('Source version', { exact: true }).selectOption({ label: 'Block · v1' });
  await page.getByLabel('View scale', { exact: true }).selectOption('1:1');
  await button(page, 'Place views').click();
  const list = page.getByRole('list', { name: 'Views and notes' });
  await expect(list.getByRole('button', { name: '平面図', exact: true })).toHaveAttribute(
    'data-view-state',
    'ready',
  );
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await button(page, 'PMIを取り込む Import PMI (3)').click();
  await list.getByRole('button', { name: '平面図', exact: true }).click();
  await button(page, '新しい版を使う Use Block · v3').click();
  const review = page.getByRole('list', { name: 'PMI to review' }).getByRole('button');
  await expect(review).toHaveCount(3);

  // Refused while PMI is out of date: nothing issued, the sheet's revisions unchanged.
  await page.getByLabel('Issue description', { exact: true }).fill('製作用 For manufacture');
  await button(page, '発行する Issue').click();
  await expect(page.getByTestId('drawing-notice')).toContainText('out of date (失効・要確認)');
  await expect(page.getByTestId('drawing-issue')).toHaveCount(0);
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw6b-issue-refused.png` });

  // Confirm the changed length, detach the gone tolerance and the stale datum.
  await review.filter({ hasText: '60 ±0.1' }).click();
  await button(page, '更新を確認 Confirm').click();
  await review.filter({ hasText: 'Position' }).click();
  await button(page, '手動の注記へ切り離す Detach').click();
  await review.filter({ hasText: 'データム' }).click();
  await button(page, '手動の注記へ切り離す Detach').click();
  await expect(review).toHaveCount(0);

  await button(page, '発行する Issue').click();
  await expect(page.getByTestId('drawing-issue')).toHaveCount(1);
  await expect(page.getByTestId('drawing-issue')).toContainText('Sheet 1 A');
  await expect(page.getByRole('list', { name: 'Revisions' })).toContainText(
    '製作用 For manufacture',
  );
  const issued = await page.evaluate(() =>
    (
      window as never as {
        drawingIssued: {
          content: { sheets: { revisions: { mark: string }[] }[] };
          pdf: Uint8Array;
        }[];
      }
    ).drawingIssued.map((i) => ({
      marks: i.content.sheets[0]!.revisions.map((r) => r.mark),
      pdf: Array.from(i.pdf.slice(0, 5)),
    })),
  );
  expect(issued).toEqual([{ marks: ['A'], pdf: [...Buffer.from('%PDF-')] }]);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download issued PDF Sheet 1 A', exact: true }).click();
  const pdf = await PDFDocument.load(readFileSync(await (await download).path()));
  expect(pdf.getPageCount()).toBe(1);
  if (process.env.DRAWING_SHOTS)
    await page.screenshot({ path: `${process.env.DRAWING_SHOTS}/dw6b-issued.png` });
  expect(errors).toEqual([]);
});
