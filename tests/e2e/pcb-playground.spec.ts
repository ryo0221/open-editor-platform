import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { f75Pi5Board, pcbPartsSample, type PcbDocument } from '@editor-platform/pcb-core';
import { strFromU8, unzipSync } from 'fflate';
import { readPcbGlbJson } from '../../packages/pcb/src/glb';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// PB1 (ST-460, TS-1922): the circuit board Surface in the ordinary Playground. No kernel.

const inspector = (page: Page) => page.locator('.pcb-inspector');
const status = (page: Page) => page.getByTestId('pcb-status');
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

test('create, edit, Undo, save a version, reload and round-trip native JSON', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'pcb');
  await expect(status(page)).toContainText('100 × 80 mm');
  const thickness = inspector(page).getByLabel('Thickness (mm)');
  await thickness.fill('1.2');
  await thickness.press('Enter');
  await inspector(page).getByLabel('Copper layers').selectOption('4');
  await expect(status(page)).toContainText('4 copper layers');
  // Host history drives the session.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(status(page)).toContainText('2 copper layers');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(status(page)).toContainText('4 copper layers');
  await save(page, 1);

  await page.reload();
  await expect(status(page)).toContainText('4 copper layers');
  await expect(inspector(page).getByLabel('Thickness (mm)')).toHaveValue('1.2');

  const record = await nativeArtifact(page);
  expect(record.kind).toBe('pcb');
  expect(record.versions).toHaveLength(1);
  expect((record.draft.content as PcbDocument).board.thicknessMm).toBe(1.2);
  expect((record.versions[0]!.content as PcbDocument).board.copperLayers).toBe(4);

  // The Raspberry Pi 5 form-factor board (F75), imported as native JSON.
  await importJson(page, 'f75.json', {
    ...record,
    name: 'Pi 5 form factor',
    draft: { ...record.draft, content: f75Pi5Board() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Pi 5 form factor');
  await expect(status(page)).toContainText('85 × 56 mm');
  await expect(status(page)).toContainText('4 holes');
  const round = await nativeArtifact(page);
  expect(round.draft.content).toEqual(f75Pi5Board());

  // Invalid content is refused on import.
  const before = await page.getByLabel('Artifact name').inputValue();
  await importJson(page, 'bad.json', {
    ...record,
    name: 'Bad board',
    draft: { ...record.draft, content: { ...f75Pi5Board(), units: 'in' } },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(before);
});

// PB2–PB4 (ST-461..463, TS-1927, TS-1930): parts, nets and copper survive a saved version and a reload.
test('places parts, imports nets, routes, saves and reloads', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'pcb');
  const canvas = page.getByTestId('pcb-canvas');
  async function clickBoard(p: [number, number]) {
    const box = (await canvas.boundingBox())!;
    const [vx, vy, vw, vh] = (await canvas.getAttribute('viewBox'))!.split(' ').map(Number);
    await page.mouse.click(
      box.x + ((p[0] - vx) / vw) * box.width,
      box.y + ((-p[1] - vy) / vh) * box.height,
    );
  }
  await page.getByRole('button', { name: 'Place part' }).click();
  await inspector(page).getByLabel('Part').selectOption('pin-header');
  await clickBoard([20, 70]);
  await inspector(page).getByLabel('Part').selectOption('usb-c');
  await clickBoard([15, 1]);
  await inspector(page).getByLabel('Part').selectOption('chip');
  await clickBoard([40, 40]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^R1/ }).click();
  await inspector(page).getByRole('button', { name: 'Board', exact: true }).click();
  await inspector(page)
    .getByLabel('Net list (JSON)')
    .fill('{"nets":[{"name":"GND","pins":["J1.6","R1.2"]},{"name":"5V","pins":["J1.2","R1.1"]}]}');
  await inspector(page).getByRole('button', { name: 'Import nets' }).click();
  await expect(status(page)).toContainText(
    '3 parts · 2 nets · 0 tracks · 0 vias · 0 zones · 2 unrouted',
  );
  // PB4 (TS-1930): a track and a via from R1.2 (0603 at 40, 40: pad 2 at 40.8, 40).
  await page.getByRole('button', { name: 'Route track' }).click();
  await clickBoard([40.8, 40]);
  await clickBoard([45, 40]);
  await page.keyboard.press('v');
  await page.keyboard.press('Enter');
  await expect(status(page)).toContainText('2 nets · 1 tracks · 1 vias · 0 zones · 2 unrouted');
  await save(page, 1);
  await page.reload();
  await expect(status(page)).toContainText(
    '3 parts · 2 nets · 1 tracks · 1 vias · 0 zones · 2 unrouted',
  );
  const record = await nativeArtifact(page);
  const doc = record.versions[0]!.content as PcbDocument;
  expect(doc.components.map((c) => c.ref)).toEqual(['J1', 'J2', 'R1']);
  expect(doc.nets.map((n) => n.name)).toEqual(['GND', '5V']);
  expect(doc.tracks.map((t) => [t.layer, t.from, t.to])).toEqual([['F.Cu', [40.8, 40], [45, 40]]]);
  expect(doc.vias.map((v) => v.at)).toEqual([[45, 40]]);
});

// PB7b (ST-468, TS-1945): the board and every generator's part in 3D, and GLB. Needs the
// development kernel (CAD_OCCT_DIST); the pictures go to PCB_DEMO_DIR when it is set.
test('shows the board in 3D and exports GLB and STEP', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.CAD_OCCT_DIST, 'needs the development kernel');
  await page.goto('/');
  await create(page, 'pcb');
  const record = await nativeArtifact(page);
  await importJson(page, 'parts.json', {
    ...record,
    name: 'Parts sample',
    draft: { ...record.draft, content: pcbPartsSample() },
    versions: [],
  });
  await expect(status(page)).toContainText('12 parts');
  await page.getByRole('button', { name: '3D view' }).click();
  const state = page.getByTestId('pcb-3d-status');
  await expect(state).toContainText('pieces', { timeout: 60_000 });
  // The board and every part's pieces, none failed.
  await expect(state).toHaveText(/^\d+ pieces$/);
  const pieces = Number((await state.textContent())!.split(' ')[0]);
  expect(pieces).toBeGreaterThan(12);
  const view = page.locator('.pcb-3d-view');
  const dir = process.env.PCB_DEMO_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.waitForTimeout(500);
    writeFileSync(`${dir}/parts-3d.png`, await view.screenshot());
    await page.getByRole('button', { name: 'Bottom', exact: true }).click();
    await page.waitForTimeout(300);
    writeFileSync(`${dir}/parts-3d-bottom.png`, await view.screenshot());
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
  }
  // The picture is not blank: the board's green and the parts' colours are drawn.
  const shot = await view.screenshot();
  expect(shot.byteLength).toBeGreaterThan(20_000);
  // A refused inspector input stops the export (its draft and reason stay); a committed one
  // is built first and then exported.
  let downloads = 0;
  page.on('download', () => downloads++);
  const thickness = inspector(page).getByLabel('Thickness (mm)');
  await thickness.fill('0');
  await page.getByRole('button', { name: 'Export GLB' }).click();
  await expect(thickness).toHaveValue('0');
  await expect(inspector(page).getByRole('alert')).toBeVisible();
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
  await thickness.fill('1.6');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export GLB' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Parts_sample.glb');
  const bytes = new Uint8Array(readFileSync((await file.path())!));
  const json = readPcbGlbJson(bytes) as {
    nodes: { name: string }[];
    images?: unknown[];
    materials: { alphaMode?: string }[];
  };
  // Every piece and the two face pictures.
  expect(json.nodes).toHaveLength(pieces + 2);
  expect(json.nodes[0]!.name).toBe('Board');
  expect(json.nodes.map((n) => n.name)).toContain('J8 shell');
  expect(json.images).toHaveLength(2);
  expect(json.materials.filter((m) => m.alphaMode === 'MASK')).toHaveLength(2);
  if (dir) writeFileSync(`${dir}/parts.glb`, bytes);
  // PB7c (ST-469, TS-1950): the same pieces as STEP, one product each under the board's.
  for (const [label, schema] of [
    ['Export STEP (AP214)', /AUTOMOTIVE_DESIGN/],
    ['Export STEP (AP242)', /AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/],
  ] as const) {
    const stepDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: label }).click();
    const stepFile = await stepDownload;
    expect(stepFile.suggestedFilename()).toBe('Parts_sample.step');
    const text = readFileSync((await stepFile.path())!, 'latin1');
    expect(text).toMatch(schema);
    expect(text.match(/PRODUCT\('/g)).toHaveLength(pieces + 1);
    expect(text).toContain("PRODUCT('Parts_sample','Parts_sample'");
    expect(text).toContain("PRODUCT('J8 shell','J8 shell'");
    await expect(page.getByTestId('pcb-step-status')).toContainText('Parts_sample.step written');
    if (dir)
      writeFileSync(
        `${dir}/parts-${label.includes('214') ? 'ap214' : 'ap242'}.step`,
        text,
        'latin1',
      );
  }
  // Back to the 2D board.
  await page.getByRole('button', { name: '3D view' }).click();
  await expect(page.getByTestId('pcb-canvas')).toBeVisible();
});

// PB8b (ST-471, TS-1960): the two example boards from the library's templates, the HAT+ stacked
// on the Pi 5 board in 3D, and both in GLB and STEP. Needs the development kernel.
test('stacks the HAT+ on the Pi 5 board in 3D and exports both', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.CAD_OCCT_DIST, 'needs the development kernel');
  test.setTimeout(240_000);
  await page.goto('/');
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Artifact type', { exact: true }).selectOption('pcb');
  await page.getByLabel('Board template').selectOption('hat');
  await page.getByRole('button', { name: 'New artifact' }).click();
  await expect(page.getByLabel('Artifact name')).toHaveValue('Sensor HAT+ 1');
  await expect(status(page)).toContainText('65 × 56 mm');
  await expect(status(page)).toContainText('0 unrouted');
  await expect(status(page)).toContainText('0 DRC errors');
  await save(page, 1);
  if (!(await page.getByLabel('Board template').isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Board template').selectOption('pi5');
  await page.getByRole('button', { name: 'New artifact' }).click();
  await expect(page.getByLabel('Artifact name')).toHaveValue('Pi 5 form factor 2');
  await expect(status(page)).toContainText('85 × 56 mm');

  await page.getByRole('button', { name: '3D view' }).click();
  const state = page.getByTestId('pcb-3d-status');
  await expect(state).toHaveText(/^\d+ pieces$/, { timeout: 90_000 });
  const alone = Number((await state.textContent())!.split(' ')[0]);
  // The board inspector offers the saved HAT version; added at the header spacing.
  await expect(inspector(page).getByLabel('Board version to stack')).toContainText('Sensor HAT+ 1');
  await inspector(page).getByRole('button', { name: 'Add board above' }).click();
  await expect(inspector(page).getByLabel('Sensor HAT+ 1 gap (mm)')).toHaveValue('11');
  await expect(state).toHaveText(/^\d+ pieces$/, { timeout: 90_000 });
  await expect
    .poll(async () => Number((await state.textContent())!.split(' ')[0]), { timeout: 90_000 })
    .toBeGreaterThan(alone);
  const pieces = Number((await state.textContent())!.split(' ')[0]);
  const view = page.locator('.pcb-3d-view');
  const dir = process.env.PCB_DEMO_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.waitForTimeout(500);
    writeFileSync(`${dir}/stack-3d.png`, await view.screenshot());
  }
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export GLB' }).click();
  const bytes = new Uint8Array(readFileSync((await (await download).path())!));
  const json = readPcbGlbJson(bytes) as { nodes: { name: string }[]; images?: unknown[] };
  // Every piece of both boards, and both boards' two face pictures.
  expect(json.nodes).toHaveLength(pieces + 4);
  const names = json.nodes.map((n) => n.name);
  expect(names).toContain('Sensor HAT+ 1 · Board');
  expect(names).toContain('Sensor HAT+ 1 · top face');
  expect(json.images).toHaveLength(4);
  if (dir) writeFileSync(`${dir}/stack.glb`, bytes);
  const stepDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export STEP (AP242)' }).click();
  const text = readFileSync((await (await stepDownload).path())!, 'latin1');
  expect(text.match(/PRODUCT\('/g)).toHaveLength(pieces + 1);
  // Names outside ASCII are written as STEP's \X2\ hex escapes (· is U+00B7).
  expect(text).toContain("PRODUCT('Sensor HAT+ 1 \\X2\\00B7\\X0\\ Board'");
  if (dir) writeFileSync(`${dir}/stack.step`, text, 'latin1');

  // Removed again: back to the Pi board alone; the stack is an ordinary edit (Undo brings it).
  await inspector(page).getByRole('button', { name: 'Remove Sensor HAT+ 1' }).click();
  await expect(state).toHaveText(`${alone} pieces`, { timeout: 90_000 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(inspector(page).getByLabel('Sensor HAT+ 1 gap (mm)')).toHaveValue('11');
  await expect(state).toHaveText(`${pieces} pieces`, { timeout: 90_000 });
});

// PB8c (ST-472, TS-1961): the examples edited in the ordinary editor: the LED moved and
// rerouted back to DRC clean, a class's width breaking the rules, a Pi connector deleted from
// the 3D view, Undo/Redo, a saved version and a reload.
test('edits the example boards in the ordinary editor', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(240_000);
  await page.goto('/');
  const library = async () => {
    if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  };
  await library();
  await page.getByLabel('Artifact type', { exact: true }).selectOption('pcb');
  await page.getByLabel('Board template').selectOption('hat');
  await page.getByRole('button', { name: 'New artifact' }).click();
  await expect(status(page)).toContainText('0 unrouted · 0 DRC errors');
  const canvas = page.getByTestId('pcb-canvas');
  async function clickBoard(p: [number, number]) {
    const box = (await canvas.boundingBox())!;
    const [vx, vy, vw, vh] = (await canvas.getAttribute('viewBox'))!.split(' ').map(Number);
    await page.mouse.click(
      box.x + ((p[0] - vx) / vw) * box.width,
      box.y + ((-p[1] - vy) / vh) * box.height,
    );
  }
  // D1 moved 1.5 mm right: its two tracks no longer reach its pads.
  await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^D1/ }).click();
  const x = inspector(page).getByLabel('X (mm)');
  await x.fill('22.57');
  await x.press('Enter');
  await expect(status(page)).toContainText('2 unrouted');
  // Rerouted from each pad to its old track's end (pad 2 LED_A at y 42.4, pad 1 GND at 40.8).
  await page.keyboard.press('Escape');
  for (const y of [42.4, 40.8]) {
    await page.getByRole('button', { name: 'Route track' }).click();
    await clickBoard([22.57, y]);
    await clickBoard([21.07, y]);
    await page.keyboard.press('Enter');
  }
  await expect(status(page)).toContainText('0 unrouted · 0 DRC errors');
  // The power class made wider than its tracks: DRC says so; Undo takes it back.
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^D1/ }).click();
  await inspector(page).getByRole('button', { name: 'Board', exact: true }).click();
  const power = inspector(page).getByRole('group', { name: 'Net class Power' });
  const width = power.getByLabel('Track width (mm)');
  await width.fill('0.5');
  await width.press('Enter');
  await expect(status(page)).not.toContainText(' 0 DRC errors');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(status(page)).toContainText('0 unrouted · 0 DRC errors');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(status(page)).not.toContainText(' 0 DRC errors');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(status(page)).toContainText('0 DRC errors');
  await save(page, 1);
  await page.reload();
  await expect(status(page)).toContainText('0 unrouted · 0 DRC errors');
  const record = await nativeArtifact(page);
  const saved = record.versions[0]!.content as PcbDocument;
  expect(saved.components.find((c) => c.ref === 'D1')!.at).toEqual([22.57, 41.6]);
  expect(saved.tracks.length).toBe((record.draft.content as PcbDocument).tracks.length);

  // A Pi connector deleted in 3D is gone from the model; Undo brings it back.
  if (!process.env.CAD_OCCT_DIST) return;
  await library();
  await page.getByLabel('Artifact type', { exact: true }).selectOption('pcb');
  await page.getByLabel('Board template').selectOption('pi5');
  await page.getByRole('button', { name: 'New artifact' }).click();
  await page.getByRole('button', { name: '3D view' }).click();
  const state = page.getByTestId('pcb-3d-status');
  await expect(state).toHaveText(/^\d+ pieces$/, { timeout: 90_000 });
  const all = (await state.textContent())!;
  await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^J4/ }).click();
  await inspector(page).getByRole('button', { name: 'Delete part' }).click();
  await expect(status(page)).toContainText('14 parts');
  await expect(state).toHaveText(/^\d+ pieces$/, { timeout: 90_000 });
  await expect(state).not.toHaveText(all, { timeout: 90_000 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(status(page)).toContainText('15 parts');
  await expect(state).toHaveText(all, { timeout: 90_000 });
});

// Fabrication export settles the inspector first (TS-1962): a refused input stops it, and a
// pending one is in the files.
test('exports fabrication files from the board as committed', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Artifact type', { exact: true }).selectOption('pcb');
  await page.getByLabel('Board template').selectOption('hat');
  await page.getByRole('button', { name: 'New artifact' }).click();
  await expect(status(page)).toContainText('0 DRC errors');
  await page.getByRole('list', { name: 'Holes' }).getByRole('button').first().click();
  const drill = inspector(page).getByLabel('Drill (mm)');
  let downloads = 0;
  page.on('download', () => downloads++);
  const exportButton = page.getByRole('button', { name: 'Export Gerber, drill and CSV (zip)' });
  await drill.fill('0');
  await exportButton.click();
  await expect(inspector(page).getByRole('alert')).toBeVisible();
  await expect(drill).toHaveValue('0');
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
  await drill.fill('2.75');
  // Typed but not yet committed: the export commits it and writes it.
  await inspector(page).getByLabel('X (mm)').fill('3.6');
  const download = page.waitForEvent('download');
  await exportButton.click();
  const zip = unzipSync(new Uint8Array(readFileSync((await (await download).path())!)));
  const npth = strFromU8(zip['board-NPTH.drl']!);
  expect(npth).toContain('X3.600Y3.500');
  expect(npth).not.toContain('X3.500Y3.500');
});

// Apply rectangle settles the inspector first (TS-1963): a refused size keeps the outline, and
// a typed but uncommitted size is the one applied.
test('applies the rectangle from committed sizes only', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'pcb');
  await expect(status(page)).toContainText('100 × 80 mm');
  const rect = inspector(page).getByRole('group', { name: 'Rectangle from the origin' });
  const apply = rect.getByRole('button', { name: 'Apply rectangle' });
  // Width 60 committed (not yet applied), then Height emptied: Apply must not use 60 × 80.
  await rect.getByLabel('Width (mm)').fill('60');
  await rect.getByLabel('Width (mm)').press('Enter');
  await rect.getByLabel('Height (mm)').fill('');
  // Leave the field first (its error shows), then press Apply.
  await rect.getByLabel('Corner radius (mm)').click();
  await apply.click();
  await expect(inspector(page).getByRole('alert')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(status(page)).toContainText('100 × 80 mm');
  // Typed but not yet committed: Apply commits it and uses it.
  await rect.getByLabel('Height (mm)').fill('50');
  await apply.click();
  await expect(status(page)).toContainText('60 × 50 mm');
});
