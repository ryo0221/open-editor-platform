import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';

// The building Surface's test host (R2c-3c). Needs the development kernel (CAD_OCCT_DIST).
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

/** A small RGB PNG drawn by `pixel` (#662 textures). */
function png(size: number, pixel: (x: number, y: number) => number[]): Uint8Array {
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) rows.set(pixel(x, y), y * (size * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

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

test('realistic lighting draws the building with environment light and shadows (#665)', async ({
  page,
}) => {
  await page.goto('/?fixture=box');
  await ready(page);
  const canvas = page.getByTestId('bim-viewport').locator('canvas');
  await expect(canvas).toHaveAttribute('data-lighting', 'standard');
  const button = await tool(page, 'Realistic lighting');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.click();
  await expect(canvas).toHaveAttribute('data-lighting', 'realistic');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: test.info().outputPath('bim-realistic.png') });
  // A click still selects the element under the pointer: the ground is never picked.
  await (await tool(page, 'Fit view')).click();
  const view = page.getByTestId('bim-viewport');
  const box = (await view.boundingBox())!;
  await view.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect.poll(async () => (await state(page)).selection.length).toBe(1);
  await (await tool(page, 'Realistic lighting')).click();
  await expect(canvas).toHaveAttribute('data-lighting', 'standard');
});

test('renders a path-traced PNG of the 3D view, and Cancel goes back to editing (#664)', async ({
  page,
}) => {
  // Software WebGL (no GPU) compiles the path-tracing shader for about a minute.
  test.setTimeout(480_000);
  await page.goto('/?fixture=box');
  await ready(page);
  await (await tool(page, 'Fit view')).click();
  await (await tool(page, 'Render image')).click();
  const dialog = page.getByRole('dialog', { name: 'Render image' });
  await dialog.getByLabel('Width (px)').fill('160');
  await dialog.getByLabel('Height (px)').fill('100');
  await dialog.getByLabel('Samples').fill('2');
  await dialog.getByLabel('Time limit (s, 0 = none)').fill('0');
  await dialog.getByRole('button', { name: 'Render', exact: true }).click();
  await expect(dialog.getByTestId('view-render-done')).toHaveText(
    '160 × 100 px, 2 samples (all samples)',
    { timeout: 400_000 },
  );
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save PNG' }).click();
  const file = await readFile((await (await download).path())!);
  expect(file.readUInt32BE(16)).toBe(160);
  expect(file.readUInt32BE(20)).toBe(100);
  // The building is drawn: the image is not one flat colour.
  const pixels = await dialog.getByTestId('view-render-image').evaluate((img: HTMLImageElement) => {
    const c = Object.assign(document.createElement('canvas'), { width: 160, height: 100 });
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, 160, 100).data;
    return new Set(Array.from({ length: 160 * 100 }, (_, i) => d[i * 4] >> 4)).size;
  });
  expect(pixels).toBeGreaterThan(3);
  await page.screenshot({ path: test.info().outputPath('bim-render.png') });
  // A long render is cancelled: nothing kept, the settings back, then the editor.
  await dialog.getByLabel('Samples').fill('4096');
  await dialog.getByRole('button', { name: 'Render again' }).click();
  await expect(dialog.getByTestId('view-render-progress')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByTestId('view-render-progress')).toHaveCount(0);
  await expect(dialog.getByTestId('view-render-done')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const view = page.getByTestId('bim-viewport');
  const box = (await view.boundingBox())!;
  await view.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect.poll(async () => (await state(page)).selection.length).toBe(1);
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

test('gives a type’s surface material a look from the library, and Undo takes it back (#661)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?fixture=box');
  await ready(page);
  await inspector(page).getByRole('tab', { name: 'Types' }).click();
  await inspector(page)
    .getByRole('button', { name: /^RC 180 \+ plaster 20/ })
    .click();
  const material = inspector(page).getByTestId('bim-material');
  await expect(material).toContainText('Surface material: Concrete');
  await expect(material).toContainText('Shared by');
  const look = material.getByLabel('Look');
  await expect(look).toHaveValue('');
  const concrete = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            bimController: {
              state: { content: { materials: { id: string; appearance?: unknown }[] } };
            };
          }
        ).bimController.state.content.materials.find((m) => m.id === 'm-concrete')!.appearance,
    );
  await look.selectOption({ label: 'Brick' });
  await expect
    .poll(concrete)
    .toEqual({ color: '#a4553d', opacity: 1, roughness: 0.85, metalness: 0, preset: 'brick' });
  // A value changed by hand makes it custom.
  const roughness = material.getByLabel('Roughness');
  await roughness.fill('0.4');
  await roughness.press('Enter');
  await expect
    .poll(concrete)
    .toEqual({ color: '#a4553d', opacity: 1, roughness: 0.4, metalness: 0 });
  await expect(look).toHaveValue('custom');
  await (await tool(page, 'Realistic lighting')).click();
  await page.screenshot({ path: test.info().outputPath('bim-material.png') });
  await (await tool(page, 'Undo')).click();
  await (await tool(page, 'Undo')).click();
  await expect.poll(concrete).toBeUndefined();
  await expect(look).toHaveValue('');
});

test('puts a downloaded texture on a type’s surface material, and Undo takes it off (#662)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?fixture=box&assets=1&ifc=1');
  await ready(page);
  await inspector(page).getByRole('tab', { name: 'Types' }).click();
  await inspector(page)
    .getByRole('button', { name: /^RC 180 \+ plaster 20/ })
    .click();
  const material = inspector(page).getByTestId('bim-material');
  const snapshot = () =>
    page.evaluate(() => {
      const c = (
        window as unknown as {
          bimController: {
            state: {
              content: {
                materials: { id: string; appearance?: Record<string, unknown> }[];
                assets?: { id: string; kind: string }[];
              };
            };
          };
        }
      ).bimController.state.content;
      return {
        look: c.materials.find((m) => m.id === 'm-concrete')!.appearance,
        assets: c.assets,
      };
    });
  // Poly Haven's names: diffuse, OpenGL normal and roughness.
  const zip = zipSync({
    'red_brick_diff_1k.png': png(64, (x, y) =>
      (Math.floor(y / 8) % 2 ? x + 4 : x) % 16 < 14 && y % 8 < 7 ? [164, 85, 61] : [220, 214, 200],
    ),
    'red_brick_nor_gl_1k.png': png(16, () => [128, 128, 255]),
    'red_brick_rough_1k.png': png(16, () => [200, 200, 200]),
  });
  await material.getByLabel('Texture files').setInputFiles({
    name: 'red_brick_1k.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip),
  });
  const dialog = page.getByTestId('view-texture-import');
  await expect(dialog.getByLabel('Map of red_brick_diff_1k.png')).toHaveValue('color');
  await expect(dialog.getByLabel('Map of red_brick_nor_gl_1k.png')).toHaveValue('normal');
  await expect(dialog.getByLabel('Map of red_brick_rough_1k.png')).toHaveValue('roughness');
  await dialog.getByLabel('Width (mm)').fill('1200');
  await dialog.getByLabel('Height (mm)').fill('600');
  await dialog.getByLabel('Source URL').fill('https://polyhaven.com/a/red_brick');
  await dialog.getByRole('button', { name: 'Add texture' }).click();
  await expect.poll(async () => (await snapshot()).assets?.length).toBe(3);
  const { look, assets } = await snapshot();
  expect(look).toMatchObject({
    color: '#ffffff',
    roughness: 1,
    textures: {
      maps: { color: assets![0]!.id, normal: assets![1]!.id, roughness: assets![2]!.id },
      sizeMm: [1200, 600],
      rotationDeg: 0,
      normal: 'gl',
      name: 'red_brick',
      source: 'https://polyhaven.com/a/red_brick',
      license: 'CC0',
    },
  });
  await expect(material.getByTestId('bim-texture')).toContainText('red_brick');
  await ready(page);
  const canvas = page.getByTestId('bim-viewport').locator('canvas');
  await (await tool(page, 'Realistic lighting')).click();
  await page.waitForTimeout(500);
  const withTexture = await canvas.screenshot({
    path: test.info().outputPath('bim-texture.png'),
  });
  // IFC keeps the look, not the images, and says so (#663).
  const download = page.waitForEvent('download');
  await (await tool(page, 'Export IFC')).click();
  const ifc = await readFile((await (await download).path())!, 'utf8');
  expect(ifc).toMatch(/IFCMATERIALDEFINITIONREPRESENTATION\(/);
  expect(ifc).toMatch(/IFCSURFACESTYLE\('Concrete',\.BOTH\.,\(#\d+\)\);/);
  await expect(page.getByTestId('bim-ifc-losses')).toHaveText(
    ' · IFC written without texture maps',
  );
  await expect(page.getByTestId('bim-ifc-losses')).toHaveAttribute(
    'title',
    'The texture maps of Concrete are not written: IFC keeps its colour and finish.',
  );
  // The size is edited in the Inspector.
  const width = material.getByLabel('Width (mm)');
  await width.fill('2400');
  await width.press('Enter');
  await expect
    .poll(async () => ((await snapshot()).look?.textures as { sizeMm: number[] }).sizeMm)
    .toEqual([2400, 600]);
  await (await tool(page, 'Undo')).click();
  await (await tool(page, 'Undo')).click();
  await expect.poll(async () => (await snapshot()).look).toBeUndefined();
  expect((await snapshot()).assets).toBeUndefined();
  await page.waitForTimeout(500);
  expect((await canvas.screenshot()).equals(withTexture)).toBe(false);
});

test('gives a wall’s two faces their own layer’s look (#662, 2c)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?fixture=box');
  await ready(page);
  await inspector(page).getByRole('tab', { name: 'Types' }).click();
  await inspector(page)
    .getByRole('button', { name: /^RC 180 \+ plaster 20/ })
    .click();
  const outer = inspector(page).getByTestId('bim-material');
  const inner = inspector(page).getByTestId('bim-material-last');
  await expect(outer).toContainText('Surface material: Concrete');
  await expect(outer).toContainText('right of the drawing direction');
  await expect(inner).toContainText('Other face material: Plaster');
  await outer.getByLabel('Look').selectOption({ label: 'Brick' });
  await inner.getByLabel('Look').selectOption({ label: 'White plaster' });
  const looks = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          bimController: {
            state: { content: { materials: { id: string; appearance?: { preset?: string } }[] } };
          };
        }
      ).bimController.state.content.materials.map((m) => [m.id, m.appearance?.preset ?? null]),
    );
  await expect.poll(looks).toEqual([
    ['m-concrete', 'brick'],
    ['m-finish', 'plaster'],
    ['m-steel', null],
  ]);
  await ready(page);
  await (await tool(page, 'Realistic lighting')).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath('bim-two-faces.png') });
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
