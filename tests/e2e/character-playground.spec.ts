import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { testGltf } from '@editor-platform/character-core/gltf-fixtures';
import { importGltf, type CharacterDocument } from '@editor-platform/character-core';
import { readFileSync } from 'node:fs';
import { r2bJoints, type CadDocument } from '@editor-platform/cad-core';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// C1d: the character Surface as a Playground Artifact kind. No kernel; software WebGL.
const viewState = (page: Page) => page.getByTestId('character-view-state');
const status = (page: Page) => page.locator('.character-status');
async function panel(page: Page, name: 'Parts' | 'Inspector') {
  const region = page.getByRole('complementary', { name, exact: true });
  if (!(await region.isVisible()))
    await page.getByRole('button', { name: `Toggle ${name}`, exact: true }).click();
  return region;
}
async function importModel(page: Page, name: string, bytes: Uint8Array) {
  await page
    .getByLabel('glTF or VRM file')
    .setInputFiles({ name, mimeType: 'model/gltf-binary', buffer: Buffer.from(bytes) });
}
async function importArtifact(page: Page, name: string, value: unknown) {
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}
const review = (page: Page) => page.getByRole('dialog', { name: 'Review import', exact: true });

test('creates a character, edits with Host Undo, saves a version and reloads', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  await expect(status(page)).toContainText('1 parts');
  const parts = await panel(page, 'Parts');
  await parts.getByRole('checkbox', { name: 'Show Body' }).uncheck();
  await page.keyboard.press('Escape');
  // The Playground's history drives the session; the Surface shows no Undo of its own.
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    (await panel(page, 'Parts')).getByRole('checkbox', { name: 'Show Body' }),
  ).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await save(page, 1);

  await page.reload();
  await expect(viewState(page)).toHaveText('Ready');
  await expect(
    (await panel(page, 'Parts')).getByRole('checkbox', { name: 'Show Body' }),
  ).not.toBeChecked();
});

test('re-imports by ID: reviews the diff, cancels or applies, and round-trips the assets', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');

  // A model with other IDs: everything of the sample is removed, the file's elements are added.
  await importModel(page, 'bar.glb', testGltf({ epIds: true }));
  await expect(review(page)).toContainText('bar.glb');
  await expect(review(page).getByRole('region', { name: /^Removed/ })).toContainText('Body');
  await expect(review(page).getByRole('region', { name: /^Added/ })).toBeVisible();
  // Cancel keeps the document as it was.
  await review(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(review(page)).toHaveCount(0);
  await expect(status(page)).toContainText('1 parts');
  // Playing the sample's action when the import is applied.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(viewState(page)).toHaveText('Playing');
  await importModel(page, 'bar.glb', testGltf({ epIds: true }));
  await review(page).getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(review(page)).toHaveCount(0);
  // The new model starts over on its own first action, ready to play.
  await expect(viewState(page)).toHaveText('Ready');
  await expect(status(page)).toContainText('2 bones');
  const action = page.getByRole('combobox', { name: 'Action', exact: true });
  await expect(action).not.toHaveValue('wave');
  await expect(action).not.toHaveValue('');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(viewState(page)).toHaveText('Playing');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const first = (await nativeArtifact(page)).draft.content as CharacterDocument;

  // The same file with the tip moved and the arm renamed: the IDs are kept, both are changed.
  await importModel(page, 'bar-2.glb', testGltf({ epIds: true, tipZ: 0.2, armName: 'Forearm' }));
  const changed = review(page).getByRole('region', { name: /^Changed/ });
  await expect(changed).toContainText('Forearm');
  await expect(review(page).getByRole('region', { name: /^Removed/ })).toHaveCount(0);
  await expect(review(page).getByRole('region', { name: /^Added/ })).toHaveCount(0);
  await expect(review(page).getByRole('note')).toContainText('not rewritten');
  await review(page).getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(viewState(page)).toHaveText('Ready');

  // The draft names the new mesh; the native file carries its bytes and imports again.
  const record = await nativeArtifact(page);
  const doc = record.draft.content as CharacterDocument;
  expect(doc.parts.map((p) => p.id)).toEqual(first.parts.map((p) => p.id));
  expect(doc.assets[0]!.sha256).not.toBe(first.assets[0]!.sha256);
  const kept = new Set(record.cadResources!.map((r) => r.sha256));
  for (const ref of doc.assets) expect(kept.has(ref.sha256)).toBe(true);
  await importArtifact(page, 'bar.json', { ...record, name: 'Bar copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue(/Bar copy/);
  await expect(viewState(page)).toHaveText('Ready');
  await expect(status(page)).toContainText('2 bones');

  // A native file whose asset bytes were altered is refused.
  const broken = structuredClone(record);
  const r0 = broken.cadResources![0]!;
  r0.bytes = r0.bytes.slice(0, -4) + (r0.bytes.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  await importArtifact(page, 'broken.json', { ...broken, name: 'Broken' });
  await expect(page.getByRole('alert').first()).toContainText(
    'Import failed: CAD resource hash mismatch',
  );
});

test('refuses to apply a reviewed import after the character changed', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByRole('checkbox', { name: 'Show Body' }).uncheck();
  await page.keyboard.press('Escape');
  await importModel(page, 'bar.glb', testGltf({ epIds: true }));
  await expect(review(page)).toBeVisible();
  // Undo from the keyboard while the review is open: the diff no longer describes the document.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(
    (await panel(page, 'Parts')).getByRole('checkbox', { name: 'Show Body', includeHidden: true }),
  ).toBeChecked();
  await review(page).getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed since the review');
  await expect(status(page)).toContainText('1 parts');
});

test('keeps the camera the user moved across a visibility edit and Host Undo', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const show = (await panel(page, 'Parts')).getByRole('checkbox', { name: 'Show Body' });
  const pixels = () =>
    page.evaluate(() =>
      document.querySelector<HTMLCanvasElement>('.character-canvas')!.toDataURL(),
    );
  const fitted = await pixels();
  const box = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 20, { steps: 8 });
  await page.mouse.up();
  await expect.poll(pixels).not.toBe(fitted);
  let orbited = await pixels();
  await expect
    .poll(async () => {
      const now = await pixels();
      const same = now === orbited;
      orbited = now;
      return same;
    })
    .toBe(true);
  await show.uncheck();
  await expect.poll(pixels).not.toBe(orbited);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(show).toBeChecked();
  // The same view as before the edit: the camera was not fitted again.
  await expect.poll(pixels).toBe(orbited);
});

test('the character view fills the editor height', async ({ page }) => {
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  // The surface takes its slot's height, not its panels' content height.
  const surface = (await page.locator('.character-surface').boundingBox())!;
  const slot = (await page.locator('.character-host').evaluate((el) => {
    const r = el.parentElement!.getBoundingClientRect();
    return { height: r.height };
  }))!;
  expect(surface.height).toBeGreaterThan(slot.height - 2);
});

test('a refused file leaves the character as it was', async ({ page }) => {
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  await importModel(page, 'cut.glb', testGltf().slice(0, 40));
  await expect(page.getByRole('alert')).toContainText('Import refused: container');
  await expect(review(page)).toHaveCount(0);
  await expect(status(page)).toContainText('1 parts');
});

/** The canvas pixels, to tell two drawn frames apart. */
const canvasPixels = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLCanvasElement>('.character-canvas')!.toDataURL());
test('CH20: a character pose and a CAD joint keyed on the same timeline, played, saved and reloaded', async ({
  page,
}) => {
  test.skip(!process.env.CAD_OCCT_DIST, 'needs the development kernel (CAD_OCCT_DIST)');
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(240_000);
  await page.goto('/');
  // A saved CAD assembly with joints (R2b F20): its shaft turns on the base plate (j-turn).
  await create(page, 'cad');
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  const { assembly, closure } = r2bJoints(kernelProfile);
  await importArtifact(page, 'rig.json', {
    ...empty,
    name: 'Rig',
    draft: { ...empty.draft, content: assembly },
    cadParts: [...closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Rig');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  await save(page, 1);

  // The character places that version as a prop.
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const before = await canvasPixels(page);
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Rig — v1 (Manual save)' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await parts.getByRole('button', { name: 'Rig', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  const turn = inspector.getByLabel('j-turn Angle', { exact: true });
  // Ready once the kernel has evaluated it: the saved angle (parameter A, 30°).
  await expect(turn).toHaveValue('30', { timeout: 120_000 });
  await expect.poll(() => canvasPixels(page)).not.toBe(before);

  // The joint at 0 s and 1 s, and the left arm's pose at 1 s: one timeline.
  await turn.fill('0');
  await turn.press('Enter');
  const time = page.getByRole('slider', { name: 'Time', exact: true });
  await time.fill('240000');
  await turn.fill('90');
  await turn.press('Enter');
  await parts.getByRole('button', { name: 'arm.L', exact: true }).click();
  const armY = inspector.getByLabel('Rotation Y', { exact: true });
  await armY.fill('-60');
  await armY.press('Enter');
  const keys = page.getByRole('group', { name: 'Keys' });
  await expect(keys.getByRole('button', { name: /^Key Rig j-turn angle at / })).toHaveCount(2);
  await expect(keys.getByRole('button', { name: /^Key arm\.L rotation at / })).toHaveCount(1);
  // Halfway the shaft is between its keys, and the view differs from either end.
  await time.fill('120000');
  await parts.getByRole('button', { name: 'Rig', exact: true }).click();
  await expect(turn).toHaveValue('45');
  const half = await canvasPixels(page);
  await time.fill('0');
  await expect.poll(() => canvasPixels(page)).not.toBe(half);
  // Playback runs both.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(viewState(page)).toHaveText('Playing');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  // Saved and reloaded: the prop, its kept versions and the keys come back.
  await save(page, 1);
  const record = await nativeArtifact(page);
  const doc = record.draft.content as CharacterDocument;
  expect(doc.props).toHaveLength(1);
  expect(record.cadParts?.map((p) => p.contentHash).sort()).toEqual(
    [doc.props[0]!.source.contentHash, ...closure.keys()].sort(),
  );
  await page.reload();
  await expect(viewState(page)).toHaveText('Ready');
  await (await panel(page, 'Parts')).getByRole('button', { name: 'Rig', exact: true }).click();
  await expect(
    (await panel(page, 'Inspector')).getByLabel('j-turn Angle', { exact: true }),
  ).toHaveValue('0', { timeout: 120_000 });
  await expect(keys.getByRole('button', { name: /^Key Rig j-turn angle at / })).toHaveCount(2);
});

// C3f, CH30 (TS-1225): a humanoid modelled from a cube in the Playground. Cage elements are
// picked where the view projects their known positions (the development build's probe).
type Probe = { parts: Record<string, { corners: number; bounds: [number[], number[]] }> };
const cube = async (page: Page) =>
  page.evaluate(() => (window as unknown as { characterProbe?: Probe }).characterProbe?.parts.cube);
const cubeBounds = async (page: Page) => (await cube(page))?.bounds;
async function clickAt(page: Page, point: [number, number, number]) {
  const [[x, y]] = await page.evaluate(
    (p) =>
      (
        window as unknown as {
          characterProbe: { project(points: number[]): [number, number, number][] };
        }
      ).characterProbe.project(p),
    point,
  );
  const box = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.click(box.x + x, box.y + y);
}

/** CH30's humanoid: a cube with two loop cuts each way, arms, a head and legs (edit mode). */
async function modelHumanoid(page: Page) {
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Add cube', exact: true }).click();
  await expect
    .poll(() => cubeBounds(page))
    .toEqual([
      [-100, -100, -100],
      [100, 100, 100],
    ]);
  // The sample's body stays out of the way: hidden, so only the cube is drawn.
  await parts.getByRole('checkbox', { name: 'Show Body' }).uncheck();
  const inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Edit mesh', exact: true }).click();
  const count = page.getByTestId('mesh-selection');
  const run = (name: string) => inspector.getByRole('button', { name, exact: true }).click();
  const field = (name: string, value: string) =>
    inspector.getByRole('spinbutton', { name, exact: true }).fill(value);

  // Two loops across x (x = ±33) and two around z (z = ±33): a 3 × 3 front.
  await run('Edge');
  await clickAt(page, [50, -100, 100]);
  await expect(count).toHaveText(/^1 edges selected · 8 vertices/);
  await field('Loop cuts', '2');
  await run('Loop cut');
  await expect(count).toHaveText(/· 16 vertices · 14 faces/);
  await clickAt(page, [100, -100, 50]);
  await expect(count).toHaveText(/^1 edges selected/);
  await run('Loop cut');
  await expect(count).toHaveText(/· 32 vertices · 30 faces/);

  // Arms from the upper third of each side (mirrored across X), the head from the top middle.
  await run('Face');
  await inspector.getByRole('checkbox', { name: 'Mirror across X' }).check();
  await clickAt(page, [100, 0, 66.7]);
  await expect(count).toHaveText(/^1 faces selected/);
  await field('Extrude distance', '250');
  await run('Extrude');
  await expect.poll(async () => (await cubeBounds(page))?.[1][0]).toBeCloseTo(350);
  expect((await cubeBounds(page))![0][0]).toBeCloseTo(-350);
  await clickAt(page, [0, 0, 100]);
  await expect(count).toHaveText(/^1 faces selected/);
  await field('Extrude distance', '120');
  await run('Extrude');
  await expect.poll(async () => (await cubeBounds(page))?.[1][2]).toBeCloseTo(220);

  // Legs from the outer thirds of the bottom: the view is orbited to look from below.
  const box = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 200, { steps: 10 });
  await page.mouse.up();
  await clickAt(page, [66.7, 0, -100]);
  await expect(count).toHaveText(/^1 faces selected/);
  await field('Extrude distance', '300');
  await run('Extrude');
  await expect.poll(async () => (await cubeBounds(page))?.[0][2]).toBeCloseTo(-400);
  return { inspector, count, run, field };
}

test('models a humanoid from a cube, undoes and redoes, saves and reloads (CH30)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  // The probe exists only in the development build (Vite's dev client is on the page); the
  // production preview suites skip this test.
  const development = await page.evaluate(
    () => !!document.querySelector('script[src*="@vite/client"]'),
  );
  test.skip(!development, 'needs the development build (window.characterProbe)');
  const { inspector, run } = await modelHumanoid(page);
  const cage = await cube(page);

  // The Playground's history: the legs go and come back.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await cubeBounds(page))?.[0][2]).toBeCloseTo(-100);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await cubeBounds(page))?.[0][2]).toBeCloseTo(-400);

  // Smoothed: two levels drawn, inside the cage.
  await inspector
    .getByRole('combobox', { name: 'Subdivision levels', exact: true })
    .selectOption('2');
  await expect.poll(async () => (await cube(page))?.corners).toBeGreaterThan(cage!.corners * 4);
  const smooth = (await cube(page))!;
  expect(smooth.bounds[0][2]).toBeGreaterThan(-400);
  expect(smooth.bounds[1][0]).toBeLessThan(350);
  await run('Done');
  await save(page, 1);

  await page.reload();
  await expect(viewState(page)).toHaveText('Ready');
  // The same part (by ID), mesh and subdivision after the reload.
  await expect.poll(() => cube(page)).toEqual(smooth);
  await expect(
    (await panel(page, 'Parts')).getByRole('button', { name: 'Cube', exact: true }),
  ).toBeVisible();
  await page.locator('.character-canvas').screenshot({ path: test.info().outputPath('ch30.png') });
});

/** A `size` × `size` PNG of two-colour checks, `cells` per side (RGB, no filter). */
function checkerPng(size: number, cells: number) {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const odd = (Math.floor((x * cells) / size) + Math.floor((y * cells) / size)) % 2;
      row.push(...(odd ? [220, 40, 40] : [245, 245, 245]));
    }
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** The canvas, scaled to 200 × 150, as RGBA bytes. */
const canvasRgba = (page: Page) =>
  page.evaluate(() => {
    const source = document.querySelector<HTMLCanvasElement>('.character-canvas')!;
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 150;
    const g = c.getContext('2d')!;
    g.drawImage(source, 0, 0, c.width, c.height);
    return [...g.getImageData(0, 0, c.width, c.height).data];
  });
/** The share of pixels that differ clearly between two captures, from 0 to 1. */
const changed = (a: number[], b: number[]) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4)
    if (
      Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) >
      60
    )
      n++;
  return n / (a.length / 4);
};

// C4d, CH40 (TS-1241): the CH30 humanoid unwrapped along its seams and given a checker image.
test('unwraps the humanoid, puts a checker image on it, saves and reloads (CH40)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  const development = await page.evaluate(
    () => !!document.querySelector('script[src*="@vite/client"]'),
  );
  test.skip(!development, 'needs the development build (window.characterProbe)');
  const { inspector, run, count } = await modelHumanoid(page);
  const summary = page.getByTestId('uv-summary');
  // A closed body with no seam: Unwrap is refused and changes nothing.
  await run('Unwrap');
  await expect(page.getByRole('alert').filter({ hasText: 'no seam' })).toBeVisible();
  await expect(summary).toHaveText(/No UVs yet/);
  // Every edge a seam, then the front's twelve inner edges stop being seams: the 3 × 3 front
  // lies flat as one island (eight islands fewer than one per face).
  await run('Edge');
  await run('Select all');
  await run('Mark seam');
  const faces = Number(/· (\d+) faces/.exec((await count.textContent())!)![1]);
  await expect(summary).toHaveText(`${faces} islands · angle distortion 1.00`);
  await run('Select none');
  const inner: [number, number, number][] = [];
  for (const x of [-33.3, 33.3]) for (const z of [-66.7, 0, 66.7]) inner.push([x, -100, z]);
  for (const z of [-33.3, 33.3]) for (const x of [-66.7, 0, 66.7]) inner.push([x, -100, z]);
  await page.keyboard.down('Shift');
  for (const p of inner) await clickAt(page, p);
  await page.keyboard.up('Shift');
  await expect(count).toHaveText(/^12 edges selected/);
  await run('Clear seam');
  await expect(summary).toHaveText(`${faces - 8} islands · angle distortion 1.00`);
  await run('Done');
  const state = inspector.locator('[data-testid^="material-image-"]');
  await expect(state).toHaveText('No image');
  const plain = await canvasRgba(page);
  await inspector
    .getByLabel(/^Color image for /)
    .setInputFiles({ name: 'checker.png', mimeType: 'image/png', buffer: checkerPng(512, 32) });
  await expect(state).toHaveText(/^PNG image/);
  // The checks are drawn on the body (same camera, only the image changed).
  await expect.poll(async () => changed(plain, await canvasRgba(page))).toBeGreaterThan(0.005);
  await save(page, 1);

  await page.reload();
  await expect(viewState(page)).toHaveText('Ready');
  await (await panel(page, 'Parts')).getByRole('button', { name: 'Cube', exact: true }).click();
  const after = (await panel(page, 'Inspector')).locator('[data-testid^="material-image-"]');
  await expect(after).toHaveText(/^PNG image/);
  await page.locator('.character-canvas').screenshot({ path: test.info().outputPath('ch40.png') });
  // Still drawn after the reload: taking the image off changes the view.
  const textured = await canvasRgba(page);
  await (await panel(page, 'Inspector'))
    .getByRole('button', { name: 'Remove image', exact: true })
    .click();
  await expect(after).toHaveText('No image');
  await expect.poll(async () => changed(textured, await canvasRgba(page))).toBeGreaterThan(0.005);
});

// C5e, CH50 (TS-1259): the CH30 humanoid given bones, bound with automatic weights, touched up
// with the weight brush and posed by IK, saved and reloaded.
test('rigs the humanoid, binds, paints, poses by IK, saves and reloads (CH50)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(180_000);
  await page.goto('/');
  const development = await page.evaluate(
    () => !!document.querySelector('script[src*="@vite/client"]'),
  );
  test.skip(!development, 'needs the development build (window.characterProbe)');
  const { run, field, count } = await modelHumanoid(page);
  // Three loop cuts along each arm, so it has vertices to bend at the elbow (the view orbited
  // back from below first).
  const view = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2 - 200);
  await page.mouse.down();
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2, { steps: 10 });
  await page.mouse.up();
  await run('Edge');
  await clickAt(page, [225, -33.3, 100]);
  await expect(count).toHaveText(/^1 edges selected/);
  const before = Number(/· (\d+) vertices/.exec((await count.textContent())!)![1]);
  await field('Loop cuts', '3');
  await run('Loop cut');
  await expect
    .poll(async () => Number(/· (\d+) vertices/.exec((await count.textContent())!)![1]))
    .toBeGreaterThan(before);
  await run('Done');
  const rest = (await cube(page))!.bounds;

  // A root, and a right arm along +x: shoulder at x = 100, elbow at 225, hand at 350.
  let parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Add skeleton', exact: true }).click();
  const place = async (x: number, z: number) => {
    const inspector = await panel(page, 'Inspector');
    for (const [axis, v] of [
      ['X', x],
      ['Z', z],
    ] as const) {
      const f = inspector.getByLabel(`Rest position ${axis}`, { exact: true });
      await f.fill(String(v));
      await f.press('Enter');
      await expect(f).toHaveValue(String(v));
    }
  };
  const child = async () =>
    (await panel(page, 'Inspector'))
      .getByRole('button', { name: 'Add child bone', exact: true })
      .click();
  await child();
  await place(100, 66.7);
  await child();
  await place(125, 0);
  await child();
  await place(125, 0);
  // Bound with automatic weights: the shape at rest does not change.
  parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Cube', exact: true }).click();
  let inspector = await panel(page, 'Inspector');
  await inspector.getByLabel('Skeleton to bind').selectOption({ label: 'Skeleton' });
  await inspector.getByRole('button', { name: 'Bind with automatic weights', exact: true }).click();
  await expect(inspector.getByText('Bound to Skeleton')).toBeVisible({ timeout: 60_000 });
  const bound = (await cube(page))!.bounds;
  bound.forEach((corner, i) => corner.forEach((v, k) => expect(v).toBeCloseTo(rest[i]![k]!, 3)));

  // Touched up: one gentle Add stroke for the elbow bone where it shares the arm about evenly.
  await inspector.getByRole('button', { name: 'Paint weights', exact: true }).click();
  await inspector.getByLabel('Paint bone').selectOption({ label: 'Bone 2' });
  await inspector.getByLabel('Brush radius').fill('15');
  await inspector.getByLabel('Brush strength').fill('50');
  const dots = page.locator('[data-testid^="weight-dot-"]');
  await expect.poll(() => dots.count()).toBeGreaterThan(0);
  const total = async () =>
    (await dots.evaluateAll((all) => all.map((d) => Number(d.getAttribute('data-weight'))))).reduce(
      (a, b) => a + b,
      0,
    );
  const start = await total();
  const low = await dots.evaluateAll(
    (all) =>
      all
        .map((d) => ({ w: Number(d.getAttribute('data-weight')), box: d.getBoundingClientRect() }))
        .sort((a, b) => Math.abs(a.w - 0.5) - Math.abs(b.w - 0.5))
        .map((d) => [d.box.x + d.box.width / 2, d.box.y + d.box.height / 2])[0]!,
  );
  await page.mouse.move(low[0]!, low[1]!);
  await page.mouse.down();
  await page.mouse.move(low[0]! + 5, low[1]! + 5, { steps: 3 });
  await page.mouse.up();
  await expect.poll(total).toBeGreaterThan(start + 0.05);
  inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Done painting', exact: true }).click();
  await expect(inspector.getByText('Bound to Skeleton')).toBeVisible();

  // Posed by IK: a chain of two bones ending at the hand, its handle dragged down. One drag
  // keys the shoulder and elbow at the playhead, and the arm bends.
  parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Bone 3', exact: true }).click();
  inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Add IK chain', exact: true }).click();
  await expect(inspector.getByLabel('Chain bones', { exact: true })).toHaveValue('2');
  const handle = page.getByTestId(/^ik-handle-/);
  const box = (await handle.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 40, y + 80, { steps: 6 });
  await page.mouse.up();
  const keys = page.getByRole('group', { name: 'Keys' });
  await expect(keys.getByRole('button', { name: /^Key Bone rotation at / })).toHaveCount(1);
  await expect(keys.getByRole('button', { name: /^Key Bone 2 rotation at / })).toHaveCount(1);
  await expect.poll(async () => (await cube(page))!.bounds[1][0]).toBeLessThan(rest[1]![0]! - 10);
  const posed = (await cube(page))!.bounds;
  await save(page, 1);

  await page.reload();
  await expect(viewState(page)).toHaveText('Ready');
  // The same rig, weights, chain and keys after the reload: the arm is drawn bent the same way.
  await expect.poll(async () => (await cube(page))?.bounds).toEqual(posed);
  await expect(keys.getByRole('button', { name: /^Key Bone 2 rotation at / })).toHaveCount(1);
  parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Bone 3', exact: true }).click();
  await expect(
    (await panel(page, 'Inspector')).getByLabel('Chain bones', { exact: true }),
  ).toHaveValue('2');
  await page.locator('.character-canvas').screenshot({ path: test.info().outputPath('ch50.png') });
});

// C6d (CH60, TS-1272): the Playground saves the exported GLB as a download; it reads back with
// the character's IDs.
test('exports the character as a GLB download that reads back with its IDs (CH60)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const control = page.getByRole('button', { name: 'Export GLB', exact: true });
  if (!(await control.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), control.click()]);
  expect(download.suggestedFilename()).toMatch(/\.glb$/);
  const bytes = new Uint8Array(readFileSync((await download.path())!));
  const r = importGltf(bytes);
  await expect(status(page)).toContainText(`${r.doc.parts.length} parts`);
  expect(r.doc.parts.map((p) => p.name)).toEqual(['Body']);
  const inspector = await panel(page, 'Inspector');
  await expect(inspector.getByRole('list', { name: 'Export losses' })).toContainText(
    'polygons-triangulated',
  );
});
