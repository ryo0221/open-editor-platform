import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { testGltf } from '@editor-platform/character-core/gltf-fixtures';
import { importGltf, seatedFigure, type CharacterDocument } from '@editor-platform/character-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { inspectVideoFile } from '@editor-platform/video-metadata/file-admission';
import {
  f59LowHPoint,
  f63Car,
  f63DriverHPoint,
  r2bJoints,
  sk01Watch,
  type CadDocument,
} from '@editor-platform/cad-core';
import { f31BoxBuilding } from '@editor-platform/bim-core';
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

// TS-1820, ST-292 (CR7d, CR7-U1 A): the whole car (F63) saved in CAD and placed as a prop in the
// character, the figure in the action Sit (F64) with its hip on the driver's seat's H-point; the
// occupant check finds no overlap, the headroom up to the roof, the H-point on the hip and the
// sight line out over the hood.
test('seats the figure in the whole car and checks the occupant (CR7d)', async ({ page }) => {
  test.skip(!process.env.CAD_OCCT_DIST, 'needs the development kernel (CAD_OCCT_DIST)');
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(1_800_000);
  await page.goto('/');
  await create(page, 'cad');
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const car = f63Car({ id, buildHash });
  await importArtifact(page, 'car.json', {
    ...empty,
    name: 'Car',
    draft: { ...empty.draft, content: car.assembly },
    cadParts: [...car.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Car');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 600_000,
  });
  await save(page, 1);

  // The figure with the action Sit (F64): the starter's figure and its mesh, with the action.
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const starter = await nativeArtifact(page);
  await importArtifact(page, 'driver.json', {
    ...starter,
    name: 'Driver',
    draft: { ...starter.draft, content: seatedFigure().doc },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(/Driver/);
  await expect(viewState(page)).toHaveText('Ready');
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption({ label: 'Sit' });

  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Car — v1 (Manual save)' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await parts.getByRole('button', { name: 'Car', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  // The car turned so its front (+x) is the figure's (−y), the H-point on the hip (0, 0, 950).
  const [hx, hy, hz] = f63DriverHPoint;
  const place = async (field: string, v: number) => {
    const f = inspector.getByLabel(field, { exact: true });
    await f.fill(String(v));
    await f.press('Enter');
  };
  await place('Prop rotation Z', -90);
  await place('Prop position X', -hy);
  await place('Prop position Y', hx);
  await place('Prop position Z', 950 - hz);
  const occupant = inspector.getByTestId('character-occupant');
  await expect(occupant).toBeVisible({ timeout: 900_000 });
  const seat = occupant.getByLabel('Seat part', { exact: true });
  await expect(seat.locator('option', { hasText: 'Seat L / Cushion 1' })).toHaveCount(1, {
    timeout: 900_000,
  });
  await seat.selectOption({ label: 'Seat L / Cushion 1' });
  for (const [k, axis] of (['x', 'y', 'z'] as const).entries())
    await occupant
      .getByLabel(`H-point in the seat part (mm) ${axis}`, { exact: true })
      .fill(String(f59LowHPoint[k]));
  // Looking a little down the road.
  await occupant.getByLabel('Eye looks along z', { exact: true }).fill('-0.1');
  const check = occupant.getByRole('button', { name: 'Check the occupant', exact: true });
  const status = occupant.getByTestId('character-occupant-status');
  // Every part's meshes are in before the check counts: none is a stand-in box.
  await expect
    .poll(
      async () => {
        await check.click();
        return (
          (await status.innerText()) +
          ((await occupant.getByText(/^Not checked/).count()) ? ' (boxes)' : '')
        );
      },
      { timeout: 600_000, intervals: [10_000] },
    )
    .toBe('The figure overlaps no part of the prop.');
  const headroom = occupant.getByTestId('character-occupant-headroom');
  await expect(headroom).toHaveText(/^Headroom: (4\d|5\d|6\d)\.\d mm up to Own shape\.$/);
  await expect(occupant.getByTestId('character-occupant-hpoint')).toHaveText(
    'H-point to the hip: 0.0 mm (x 0.0, y 0.0, z 0.0).',
  );
  const sight = occupant.getByTestId('character-occupant-sight');
  await expect(sight).toHaveText(/^Sight line: meets .+ at \d+\.\d mm\.$/);
  test.info().annotations.push({
    type: 'occupant',
    description: `${await headroom.innerText()} ${await sight.innerText()}`,
  });
  await page.screenshot({ path: test.info().outputPath('cr7d-occupant.png') });
  await occupant.screenshot({ path: test.info().outputPath('cr7d-panel.png') });
});

// C8p (TS-1297): a saved building (BIM) placed as a prop through Add prop, drawn beside the
// figure once its kernel evaluated it, kept in the character's record, and back after a reload.
test('places a saved building as a prop, saves and reloads it (C8p, TS-1297)', async ({ page }) => {
  test.skip(!process.env.CAD_OCCT_DIST, 'needs the development kernel (CAD_OCCT_DIST)');
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(240_000);
  await page.goto('/');
  await create(page, 'bim');
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 90_000,
  });
  const empty = await nativeArtifact(page);
  await importArtifact(page, 'box.json', {
    ...empty,
    name: 'Box building',
    draft: { ...empty.draft, content: f31BoxBuilding() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Box building');
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 90_000,
  });
  await save(page, 1);

  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const before = await canvasPixels(page);
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Box building — v1 (Manual save)' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  // The version is measured before the prop is added (#718).
  await expect(parts.getByRole('status')).toContainText('Measuring the version');
  const props = parts.getByRole('list', { name: 'Props' });
  await expect(props.getByRole('button', { name: 'Box building', exact: true })).toBeVisible({
    timeout: 120_000,
  });
  // Drawn once evaluated: no state beside its name, and the view shows more than the figure.
  await expect(props.locator('.character-prop-state')).toHaveCount(0, { timeout: 120_000 });
  await expect.poll(() => canvasPixels(page)).not.toBe(before);
  await page.screenshot({ path: test.info().outputPath('c8p-building-prop.png') });
  await props.getByRole('button', { name: 'Box building', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  await expect(inspector).toContainText('of a building, fixed by its content hash.');
  // A building has no joints to key.
  await expect(inspector).toContainText('This version has no joints to key.');

  await save(page, 1);
  const record = await nativeArtifact(page);
  const doc = record.draft.content as CharacterDocument;
  expect(doc.props.map((p) => p.source.kind)).toEqual(['bim']);
  // #718 (TS-1303): measured, then placed beside the figure on its floor, not at the origin.
  const drawn = await page.evaluate(() => {
    const probe = (
      window as unknown as {
        characterProbe: {
          parts: Record<string, { bounds: number[][] }>;
          props: Record<string, number[][]>;
        };
      }
    ).characterProbe;
    const figure = Object.values(probe.parts).reduce(
      (b, p) => [
        b[0]!.map((x, k) => Math.min(x, p.bounds[0]![k]!)),
        b[1]!.map((x, k) => Math.max(x, p.bounds[1]![k]!)),
      ],
      [
        [Infinity, Infinity, Infinity],
        [-Infinity, -Infinity, -Infinity],
      ],
    );
    return { figure, prop: Object.values(probe.props)[0]! };
  });
  expect(drawn.prop[0]![0]).toBeGreaterThan(drawn.figure[1]![0]!);
  expect(drawn.prop[0]![2]).toBeCloseTo(drawn.figure[0]![2]!, 0);
  const middle = (b: number[][]) => (b[0]![1]! + b[1]![1]!) / 2;
  expect(middle(drawn.prop)).toBeCloseTo(middle(drawn.figure), 0);
  expect(
    (record as { bimParts?: { contentHash: string }[] }).bimParts?.map((p) => p.contentHash),
  ).toEqual([doc.props[0]!.source.contentHash]);
  await page.reload();
  await expect(viewState(page)).toHaveText('Ready');
  const again = (await panel(page, 'Parts')).getByRole('list', { name: 'Props' });
  await expect(again.getByRole('button', { name: 'Box building', exact: true })).toBeVisible();
  await expect(again.locator('.character-prop-state')).toHaveCount(0, { timeout: 120_000 });
  await expect.poll(() => canvasPixels(page), { timeout: 30_000 }).not.toBe(before);
});

// C8c, CH80 (TS-1299): a saved building placed beside the figure through Add prop, and the
// figure's Wave exported at 1280 × 720 and 30 fps: an MP4 that ffprobe and the importer read,
// whose first and last frames match the PNG sequence's; an export cancelled leaves nothing.
/** One frame as RGB bytes (160 × 90 by default), decoded by ffmpeg (`select` picks frame n). */
const rgb = (path: string, n?: number, size = '160:90') =>
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      `${n === undefined ? '' : `select=eq(n\\,${n}),`}scale=${size}`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 64 << 20 },
  );
const meanDiff = (a: Uint8Array, b: Uint8Array) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  return d / a.length;
};
const share = (a: Uint8Array, b: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 3)
    if (
      Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) >
      60
    )
      n++;
  return n / (a.length / 3);
};
test('CH80: a figure and a building animated into a 720p MP4 and a PNG sequence (C8c, TS-1299)', async ({
  page,
}, info) => {
  test.skip(!process.env.CAD_OCCT_DIST, 'needs the development kernel (CAD_OCCT_DIST)');
  test.skip(info.project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'bim');
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 90_000,
  });
  const empty = await nativeArtifact(page);
  await importArtifact(page, 'box.json', {
    ...empty,
    name: 'Box building',
    draft: { ...empty.draft, content: f31BoxBuilding() },
    versions: [],
  });
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 90_000,
  });
  await save(page, 1);

  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Box building — v1 (Manual save)' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  const props = parts.getByRole('list', { name: 'Props' });
  await expect(props.locator('.character-prop-state')).toHaveCount(0, { timeout: 120_000 });
  // Behind the figure, not around it: its walls run from 0 to 10 m.
  await props.getByRole('button', { name: 'Box building', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  for (const [axis, v] of [
    ['X', '-5000'],
    ['Y', '3000'],
  ] as const) {
    await inspector.getByLabel(`Prop position ${axis}`).fill(v);
    await inspector.getByLabel(`Prop position ${axis}`).press('Enter');
  }
  await expect(inspector.getByLabel('Prop position Y')).toHaveValue('3000');
  const video = inspector.getByRole('group', { name: 'Video export' });
  await video.getByLabel('Export action').selectOption({ label: 'Wave' });
  await video.getByLabel('Size').selectOption('720p');
  // Wave is keyed at 30 fps: the action's own rate.
  await video.getByLabel('Frame rate').selectOption('action');
  const exported = async (button: 'Export video' | 'Export frames', name: RegExp) => {
    const download = page.waitForEvent('download', { timeout: 180_000 });
    await video.getByRole('button', { name: button }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(name);
    const path = info.outputPath(file.suggestedFilename());
    await file.saveAs(path);
    return path;
  };

  const mp4 = await exported('Export video', /Wave\.mp4$/);
  await expect(video.getByTestId('video-report')).toContainText(': 30 frames, 1280 × 720, 30 fps.');
  const bytes = readFileSync(mp4);
  const plan = (await inspectVideoFile(new Blob([bytes]), new AbortController().signal)).plan;
  expect(plan.streams.map((s) => s.kind)).toEqual(['video']);
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      mp4,
    ]).toString(),
  ) as {
    streams: Record<string, unknown>[];
    format: { duration: string };
  };
  expect(probe.streams).toHaveLength(1);
  expect(probe.streams[0]).toMatchObject({
    codec_name: 'h264',
    width: 1280,
    height: 720,
    nb_read_frames: '30',
    r_frame_rate: '30/1',
  });
  expect(Number(probe.format.duration)).toBeCloseTo(1, 3);

  const zip = await exported('Export frames', /Wave\.zip$/);
  const frames = unzipSync(readFileSync(zip));
  const names = Object.keys(frames);
  expect(names).toHaveLength(30);
  const still = (name: string) => {
    const path = info.outputPath(name);
    writeFileSync(path, frames[name]!);
    return rgb(path);
  };
  const first = still('frame-00001.png');
  const last = still('frame-00030.png');
  // The video's frames are the sequence's, up to H.264's loss.
  expect(meanDiff(rgb(mp4, 0), first)).toBeLessThan(6);
  expect(meanDiff(rgb(mp4, 29), last)).toBeLessThan(6);
  // The figure waves: its arm is elsewhere half way (compared at full size, the figure is small).
  const full = (name: string) => {
    still(name);
    return rgb(info.outputPath(name), undefined, '1280:720');
  };
  expect(share(full('frame-00001.png'), full('frame-00016.png'))).toBeGreaterThan(0.0001);

  // The building is in the frames: hidden, the first frame loses it.
  await props.getByLabel('Show Box building').uncheck();
  await video.getByLabel('To (s)').fill('0.03');
  const alone = unzipSync(readFileSync(await exported('Export frames', /Wave\.zip$/)));
  writeFileSync(info.outputPath('alone.png'), alone['frame-00001.png']!);
  expect(share(first, rgb(info.outputPath('alone.png')))).toBeGreaterThan(0.02);
  await props.getByLabel('Show Box building').check();

  // Cancelled mid-export: nothing is downloaded.
  await video.getByLabel('To (s)').fill('1');
  let downloads = 0;
  page.on('download', () => downloads++);
  await video.getByLabel('Frame rate').selectOption('60');
  await video.getByRole('button', { name: 'Export video' }).click();
  await expect(video.getByRole('status')).toContainText('Exporting video…');
  await video.getByRole('button', { name: 'Cancel export' }).click();
  await expect(video.getByTestId('video-report')).toHaveText(
    'Export cancelled; nothing was saved.',
  );
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
});

// TS-1826, ST-295 (CR7e): the action's camera keyed from the view at two times; the view looks
// through it when seeking, and the exported frames are filmed through it (without the keys, the
// last frame keeps the first one's camera).
test('keys the action camera from the view and films the video through it (CR7e)', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop flow');
  test.setTimeout(240_000);
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const transport = page.getByRole('group', { name: 'Playback', exact: true });
  await transport.getByLabel('Action').selectOption({ label: 'Wave' });
  const inspector = await panel(page, 'Inspector');
  const camera = inspector.getByRole('group', { name: 'Action camera' });
  await expect(camera.getByTestId('camera-keyed')).toHaveText(/^No camera keys/);
  await expect(camera.getByLabel('Look through the action’s camera')).toBeDisabled();
  const pixels = () =>
    page.evaluate(() =>
      document.querySelector<HTMLCanvasElement>('.character-canvas')!.toDataURL(),
    );
  const settled = async () => {
    let last = await pixels();
    await expect
      .poll(async () => {
        const now = await pixels();
        const same = now === last;
        last = now;
        return same;
      })
      .toBe(true);
    return last;
  };
  await camera.getByRole('button', { name: 'Key camera', exact: true }).click();
  await expect(camera.getByTestId('camera-keyed')).toHaveText(/filmed through/);
  const time = transport.getByLabel('Time');
  const start = await settled();
  // At the end, from another side: the view orbited, then keyed.
  await time.press('End');
  const box = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await settled();
  await camera.getByRole('button', { name: 'Key camera', exact: true }).click();
  const end = await settled();
  // Back to the start, the view looks through the first key again.
  await time.press('Home');
  await expect.poll(pixels).toBe(start);
  await time.press('End');
  await expect.poll(pixels).toBe(end);
  await time.press('Home');
  await expect.poll(pixels).toBe(start);

  const video = inspector.getByRole('group', { name: 'Video export' });
  await video.getByLabel('Export action').selectOption({ label: 'Wave' });
  await video.getByLabel('Size').selectOption('720p');
  await video.getByLabel('Frame rate').selectOption('action');
  const frames = async (tag: string) => {
    const download = page.waitForEvent('download', { timeout: 180_000 });
    await video.getByRole('button', { name: 'Export frames' }).click();
    const zip = unzipSync(readFileSync(await (await download).path()));
    const names = Object.keys(zip).sort();
    return [names[0]!, names[names.length - 1]!].map((name, i) => {
      const path = info.outputPath(`${tag}-${i ? 'last' : 'first'}.png`);
      writeFileSync(path, zip[name]!);
      return rgb(path);
    });
  };
  const [keyedFirst, keyedLast] = await frames('keyed');
  // The same export without the camera keys (two edits undone): the view's camera throughout.
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(camera.getByTestId('camera-keyed')).toHaveText(/^No camera keys/);
  const [plainFirst, plainLast] = await frames('plain');
  expect(meanDiff(keyedFirst!, plainFirst!)).toBeLessThan(2);
  expect(share(keyedLast!, plainLast!)).toBeGreaterThan(0.02);
});

// TS-1837, ST-299 (CR7g-3): the realistic lighting chosen for the view draws the view and the
// exported frames under the environment light, the sun's shadows and tone mapping; Standard
// draws exactly the view as before.
test('draws the view and the exported frames under the realistic lighting (CR7g-3)', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop flow');
  test.setTimeout(240_000);
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const canvas = page.locator('.character-canvas');
  await expect(canvas).toHaveAttribute('data-lighting', 'standard');
  const pixels = () =>
    page.evaluate(() =>
      document.querySelector<HTMLCanvasElement>('.character-canvas')!.toDataURL(),
    );
  const settled = async () => {
    let last = await pixels();
    await expect
      .poll(async () => {
        const now = await pixels();
        const same = now === last;
        last = now;
        return same;
      })
      .toBe(true);
    return last;
  };
  const inspector = await panel(page, 'Inspector');
  const lighting = inspector.getByLabel('Lighting', { exact: true });
  await expect(lighting).toHaveValue('standard');
  const standard = await settled();
  const video = inspector.getByRole('group', { name: 'Video export' });
  const transport = page.getByRole('group', { name: 'Playback', exact: true });
  await transport.getByLabel('Action').selectOption({ label: 'Wave' });
  await video.getByLabel('Export action').selectOption({ label: 'Wave' });
  await video.getByLabel('Size').selectOption('720p');
  await video.getByLabel('Frame rate').selectOption('action');
  const first = async (tag: string) => {
    const download = page.waitForEvent('download', { timeout: 180_000 });
    await video.getByRole('button', { name: 'Export frames' }).click();
    const zip = unzipSync(readFileSync(await (await download).path()));
    const name = Object.keys(zip).sort()[0]!;
    const path = info.outputPath(`${tag}.png`);
    writeFileSync(path, zip[name]!);
    return rgb(path);
  };
  const plain = await first('standard');
  await lighting.selectOption('realistic');
  await expect(canvas).toHaveAttribute('data-lighting', 'realistic');
  const realistic = await settled();
  expect(realistic).not.toBe(standard);
  const lit = await first('realistic');
  // The exported frame is drawn under the same lighting as the view.
  expect(meanDiff(lit!, plain!)).toBeGreaterThan(2);
  await page.screenshot({ path: info.outputPath('cr7g3-realistic.png') });
  await lighting.selectOption('standard');
  await expect(canvas).toHaveAttribute('data-lighting', 'standard');
  await transport.getByLabel('Time').press('Home');
  await expect.poll(pixels).toBe(standard);
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

// C7e (CH70, TS-1284): the figure's head sculpted into a face on a multires, baked into a normal
// map on the cage, played, saved and reloaded, and exported as a GLB carrying the map and
// tangents (three.js and Blender render it: docs/verification/character-c7/README.md).
test('sculpts a face on the figure, bakes it to a normal map, plays, saves, reloads and exports (CH70, TS-1288)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(240_000);
  await page.goto('/');
  const development = await page.evaluate(
    () => !!document.querySelector('script[src*="@vite/client"]'),
  );
  test.skip(!development, 'needs the development build (window.characterProbe)');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const project = (p: number[]) =>
    page.evaluate(
      (q) =>
        (
          window as unknown as {
            characterProbe: { project(points: number[]): [number, number, number][] };
          }
        ).characterProbe.project(q),
      p,
    );
  const canvas = page.locator('.character-canvas');
  const at = async (p: [number, number, number]) => {
    const [[x, y]] = await project(p);
    const box = (await canvas.boundingBox())!;
    return [box.x + x!, box.y + y!] as const;
  };
  let parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Body', exact: true }).click();
  let inspector = await panel(page, 'Inspector');
  // UVs: every edge a seam, one island per face.
  await inspector.getByRole('button', { name: 'Edit mesh', exact: true }).click();
  await inspector.getByRole('button', { name: 'Edge', exact: true }).click();
  await inspector.getByRole('button', { name: 'Select all', exact: true }).click();
  await inspector.getByRole('button', { name: 'Mark seam', exact: true }).click();
  await expect(page.getByTestId('uv-summary')).toHaveText(/^66 islands/);
  await inspector.getByRole('button', { name: 'Done', exact: true }).click();
  // The view brought to the face: panned (right button) to the head, then zoomed in.
  const head: [number, number, number] = [0, -110, 1560];
  const view = (await canvas.boundingBox())!;
  const [hx, hy] = await at(head);
  await page.mouse.move(hx, hy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  const headWidth = async () => {
    const [[a], [b]] = [await project([-100, -110, 1560]), await project([100, -110, 1560])];
    return Math.abs(b![0]! - a![0]!);
  };
  // Zoomed in until the head is about 300 px wide.
  for (let i = 0; i < 20 && (await headWidth()) < 300; i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(50);
  }
  expect(await headWidth()).toBeGreaterThan(250);
  // A multires of five levels (about 68,000 vertices).
  inspector = await panel(page, 'Inspector');
  await inspector.getByLabel('Multires levels').selectOption('5');
  await inspector.getByRole('button', { name: 'Add multires', exact: true }).click();
  await expect(inspector.getByText('Multires level 5')).toBeVisible();
  await inspector.getByRole('button', { name: 'Sculpt', exact: true }).click();
  await expect(inspector.getByText('Sculpt · Body')).toBeVisible();
  const [[l], [r]] = [await project([-100, -110, 1560]), await project([100, -110, 1560])];
  const pxPerMm = Math.abs(r![0]! - l![0]!) / 200;
  const brush = async (kind: string, radiusMm: number, strength: number) => {
    await inspector.getByRole('button', { name: kind, exact: true }).click();
    await inspector.getByLabel('Sculpt radius').fill(String(Math.round(radiusMm * pxPerMm)));
    await inspector.getByLabel('Sculpt strength').fill(String(strength));
  };
  const stroke = async (points: [number, number, number][], invert = false) => {
    if (invert) await page.keyboard.down('Shift');
    const [x0, y0] = await at(points[0]!);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (const p of points.slice(1)) {
      const [x, y] = await at(p);
      await page.mouse.move(x, y, { steps: 6 });
    }
    await page.mouse.up();
    if (invert) await page.keyboard.up('Shift');
  };
  const sculptBefore = await canvasRgba(page);
  // Eye sockets (Draw reversed, mirrored to the other eye), a nose, a mouth.
  await brush('Draw', 22, 100);
  await stroke(
    [
      [45, -110, 1610],
      [50, -110, 1612],
    ],
    true,
  );
  await stroke(
    [
      [45, -110, 1610],
      [40, -110, 1608],
    ],
    true,
  );
  await brush('Draw', 16, 100);
  await stroke([
    [0, -110, 1600],
    [0, -110, 1560],
  ]);
  await stroke([
    [0, -110, 1580],
    [0, -110, 1555],
  ]);
  await brush('Draw', 10, 80);
  await stroke(
    [
      [-40, -110, 1515],
      [0, -110, 1508],
      [40, -110, 1515],
    ],
    true,
  );
  await expect
    .poll(async () => changed(sculptBefore, await canvasRgba(page)))
    .toBeGreaterThan(0.01);
  await canvas.screenshot({ path: test.info().outputPath('ch70-sculpt.png') });
  await inspector.getByRole('button', { name: 'Done sculpting', exact: true }).click();

  // Baked at 2048: the Body and Face materials get the map (the figure is the only part).
  const plain = await canvasRgba(page);
  await inspector.getByLabel('Bake size').selectOption('2048');
  await inspector.getByRole('button', { name: 'Bake normal map', exact: true }).click();
  await expect(inspector.getByTestId('bake-report')).toHaveText(/^Baked 2048 × 2048/, {
    timeout: 120_000,
  });
  await expect.poll(async () => changed(plain, await canvasRgba(page))).toBeGreaterThan(0.002);
  await canvas.screenshot({ path: test.info().outputPath('ch70-baked.png') });

  // Played: the Wave moves the arm with the map on.
  const transport = page.getByRole('group', { name: 'Playback', exact: true });
  await transport.getByLabel('Action').selectOption({ label: 'Wave' });
  const still = await canvasRgba(page);
  await transport.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => changed(still, await canvasRgba(page))).toBeGreaterThan(0.002);
  await transport.getByRole('button', { name: 'Pause', exact: true }).click();
  await canvas.screenshot({ path: test.info().outputPath('ch70-wave.png') });
  await transport.getByRole('button', { name: 'Stop', exact: true }).click();
  await save(page, 1);

  await page.reload();
  await expect(viewState(page)).toHaveText('Ready');
  parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Body', exact: true }).click();
  inspector = await panel(page, 'Inspector');
  await expect(inspector.getByText('Multires level 5')).toBeVisible();

  // Exported: the GLB names the normal texture on both materials and gives the mesh tangents.
  const control = page.getByRole('button', { name: 'Export GLB', exact: true });
  if (!(await control.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), control.click()]);
  const bytes = new Uint8Array(readFileSync((await download.path())!));
  const view32 = new DataView(bytes.buffer, bytes.byteOffset);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + view32.getUint32(12, true))),
  ) as {
    materials: { name: string; normalTexture?: { index: number } }[];
    meshes: { primitives: { attributes: Record<string, number> }[] }[];
  };
  expect(json.materials.map((m) => [m.name, !!m.normalTexture])).toEqual([
    ['Body', true],
    ['Face', true],
  ]);
  expect(json.meshes[0]!.primitives.every((p) => 'TANGENT' in p.attributes)).toBe(true);
  const back = importGltf(bytes);
  expect(back.doc.materials.every((m) => !!m.maps.normal)).toBe(true);
  writeFileSync(test.info().outputPath('ch70.glb'), bytes);
});

// WM5c-2b (docs/cad/watch-design.md, 通常の画面での編集 (3); W2): the saved SK-01 watch placed as a
// prop, its escapement made as keys (WM4) and checked along the action (MR5); the rate then changed
// from 28,800 to 21,600 beats an hour and the motion made again (replacing the keys, after
// asking) and checked again. Undo and Redo go between the two, and the keys come back after a
// save and reload.
test('WM5c-2b: remake the SK-01 escapement at another rate and check it again', async ({
  page,
}) => {
  test.skip(!process.env.CAD_OCCT_DIST, 'needs the development kernel (CAD_OCCT_DIST)');
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(1_200_000);
  await page.goto('/');
  await create(page, 'cad');
  const empty = await nativeArtifact(page);
  const watch = sk01Watch((empty.draft.content as CadDocument).kernelProfile);
  await importArtifact(page, 'sk01.json', {
    ...empty,
    name: 'SK-01',
    draft: { ...empty.draft, content: watch.assembly },
    cadParts: [...watch.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('SK-01');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  await save(page, 1);

  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'SK-01 — v1 (Manual save)' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  const props = parts.getByRole('list', { name: 'Props' });
  await props.getByRole('button', { name: 'SK-01', exact: true }).click({ timeout: 120_000 });
  const inspector = await panel(page, 'Inspector');
  // Ready once the kernel has evaluated all 17 parts.
  const escapement = inspector.getByTestId('character-prop-escapement');
  await expect(escapement).toBeVisible({ timeout: 600_000 });
  await escapement.getByLabel('Balance', { exact: true }).selectOption({ label: 'Balance' });
  await escapement
    .getByLabel('Pallet fork', { exact: true })
    .selectOption({ label: 'Pallet fork' });
  await escapement
    .getByLabel('Escape wheel', { exact: true })
    .selectOption({ label: 'Escape wheel' });
  await escapement.getByLabel('Escapement length (s)').fill('1');
  await escapement.getByRole('button', { name: 'Make escapement' }).click();
  await expect(escapement.getByRole('status')).toContainText('Made 8 beats');
  const sweep = inspector.getByTestId('character-prop-sweep');
  const checked = async () => {
    await sweep.getByLabel('Check every (s)').fill('0.0125');
    await sweep.getByRole('button', { name: 'Check along the action' }).click();
    await expect(page.getByTestId('character-prop-sweep-status')).toContainText(
      'No overlap at the',
      { timeout: 600_000 },
    );
  };
  await checked();
  const keysOf = async () =>
    ((await nativeArtifact(page)).draft.content as CharacterDocument).actions[0]!.tracks.filter(
      (t) => t.target.kind === 'prop-joint',
    ).map((t) => [(t.target as { joint: string }).joint, t.keys.length] as const);
  const at28800 = await keysOf();
  expect(Object.fromEntries(at28800)).toMatchObject({
    'j-balance': 17,
    'j-pallet': 17,
    'j-escape': 17,
  });

  // 21,600 an hour: 6 beats in the same second, after asking to replace the keys.
  await escapement.getByLabel('Beats per hour').fill('21600');
  await escapement.getByRole('button', { name: 'Make escapement' }).click();
  await escapement
    .getByRole('alertdialog', { name: 'Replace keys' })
    .getByRole('button', {
      name: 'Replace keys',
    })
    .click();
  await expect(escapement.getByRole('status')).toContainText('Made 6 beats');
  await checked();
  const at21600 = await keysOf();
  expect(Object.fromEntries(at21600)).toMatchObject({
    'j-balance': 13,
    'j-pallet': 13,
    'j-escape': 13,
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(keysOf).toEqual(at28800);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(keysOf).toEqual(at21600);
  await page.screenshot({ path: test.info().outputPath('wm5c2b-escapement.png') });

  await save(page, 1);
  await page.reload();
  await expect(viewState(page)).toHaveText('Ready');
  expect(await keysOf()).toEqual(at21600);
});

// WM6b (ST-453, TS-1909): SK-01 running as a prop, filmed. A character with no figure and one
// action of `WM6_VIDEO_SECONDS` (2 by default; the W2 demo makes 62) is read from a native file
// (the Playground makes new characters with a 1 s action); SK-01 is added through Add prop,
// turned to face the camera, its escapement made over the whole action (8 beats a second, the
// seconds hand once a minute), and the action exported as an MP4 the length of the action.
test('WM6b: film SK-01 running for the length of an action as an MP4', async ({ page }, info) => {
  test.skip(!process.env.CAD_OCCT_DIST, 'needs the development kernel (CAD_OCCT_DIST)');
  test.skip(info.project.name !== 'desktop', 'desktop flow');
  const seconds = Number(process.env.WM6_VIDEO_SECONDS ?? 2);
  test.setTimeout(1_200_000 + seconds * 60_000);
  await page.goto('/');
  await create(page, 'cad');
  const emptyCad = await nativeArtifact(page);
  const watch = sk01Watch((emptyCad.draft.content as CadDocument).kernelProfile);
  await importArtifact(page, 'sk01.json', {
    ...emptyCad,
    name: 'SK-01',
    draft: { ...emptyCad.draft, content: watch.assembly },
    cadParts: [...watch.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('SK-01');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  await save(page, 1);

  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const empty = await nativeArtifact(page);
  const base = empty.draft.content as CharacterDocument;
  const stage: CharacterDocument = {
    ...base,
    name: 'Watch stage',
    assets: [],
    parts: [],
    skeletons: [],
    skins: [],
    morphs: [],
    props: [],
    actions: [
      {
        id: 'watch-run',
        name: 'Watch running',
        duration: seconds * 240_000,
        frameRate: { numerator: 30, denominator: 1 },
        tracks: [],
      },
    ],
  };
  const { cadResources: _, ...record } = empty as typeof empty & { cadResources?: unknown };
  await importArtifact(page, 'stage.json', {
    ...record,
    name: 'Watch stage',
    draft: { ...empty.draft, content: stage },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Watch stage');
  await expect(viewState(page)).toHaveText('Nothing to show');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'SK-01 — v1 (Manual save)' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  const props = parts.getByRole('list', { name: 'Props' });
  await props.getByRole('button', { name: 'SK-01', exact: true }).click({ timeout: 120_000 });
  const inspector = await panel(page, 'Inspector');
  // The dial (−z) to the camera, which looks along +y.
  await inspector.getByLabel('Prop rotation X').fill('-90');
  await inspector.getByLabel('Prop rotation X').press('Enter');
  const escapement = inspector.getByTestId('character-prop-escapement');
  await expect(escapement).toBeVisible({ timeout: 600_000 });
  await escapement.getByLabel('Balance', { exact: true }).selectOption({ label: 'Balance' });
  await escapement
    .getByLabel('Pallet fork', { exact: true })
    .selectOption({ label: 'Pallet fork' });
  await escapement
    .getByLabel('Escape wheel', { exact: true })
    .selectOption({ label: 'Escape wheel' });
  await escapement.getByRole('button', { name: 'Make escapement' }).click();
  await expect(escapement.getByRole('status')).toContainText(`Made ${seconds * 8} beats`);
  await page.screenshot({ path: info.outputPath('wm6b-stage.png') });

  const video = inspector.getByRole('group', { name: 'Video export' });
  await video.getByLabel('Export action').selectOption({ label: 'Watch running' });
  await video.getByLabel('Size').selectOption('720p');
  await video.getByLabel('Frame rate').selectOption('action');
  const download = page.waitForEvent('download', { timeout: 300_000 + seconds * 60_000 });
  await video.getByRole('button', { name: 'Export video' }).click();
  const file = await download;
  const mp4 = info.outputPath('sk01-running.mp4');
  await file.saveAs(mp4);
  await expect(video.getByTestId('video-report')).toContainText(
    `: ${seconds * 30} frames, 1280 × 720, 30 fps.`,
  );
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4], {
      maxBuffer: 64 * 1024 * 1024,
    }).toString(),
  ) as { streams: Record<string, unknown>[]; format: { duration: string } };
  expect(probe.streams[0]).toMatchObject({ codec_name: 'h264', width: 1280, height: 720 });
  expect(Number(probe.format.duration)).toBeCloseTo(seconds, 2);
  // The movement runs: the first and last frames differ (the wheels and the balance turned).
  expect(meanDiff(rgb(mp4, 0, '640:360'), rgb(mp4, seconds * 30 - 1, '640:360'))).toBeGreaterThan(
    0.2,
  );
  const dir = process.env.CAD_WATCH_DEMO_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/sk01-running-${seconds}s.mp4`, readFileSync(mp4));
  }
});
