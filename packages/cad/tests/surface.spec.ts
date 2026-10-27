import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { Box3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  applyCadOperation,
  cadContentHash,
  f02Volume,
  partVersionId,
  splinePoints,
  type CadBodyEvaluation,
  type CadDocument,
} from '@editor-platform/cad-core';
import type { CadController } from '../src';

/** A solid body's volume (NaN for a sheet or a missing body). */
const vol = (b: CadBodyEvaluation | undefined) => (b?.kind === 'solid' ? b.volumeMm3 : NaN);

// Any page error or console error fails the test.
let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
});
test.afterEach(() => expect(errors).toEqual([]));

const kernel = !!process.env.CAD_OCCT_DIST;
// The test host puts its first Surface's controller on window.cad.
const cadSnapshot = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { cad: { controller: CadController } }).cad.controller.getSnapshot(),
  );
const state = (page: Page) => page.getByTestId('cad-geometry-state');
const ready = (page: Page) => expect(state(page)).toHaveText('Shape up to date');
const bodies = (page: Page) => page.getByRole('list', { name: 'Bodies' }).getByRole('button');
const inspector = (page: Page) => page.locator('.cad-inspector');
// The narrow layout moves the CAD tools into the overflow menu.
async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools' }).click();
  return button;
}

const narrow = () => test.info().project.name !== 'desktop';
/** A side panel, opened first on the narrow layout, where it starts closed. */
async function panel(page: Page, name: 'Elements' | 'Inspector') {
  const region = page.getByRole('complementary', { name });
  if (!(await region.isVisible()))
    await page.getByRole('button', { name: `Toggle ${name}` }).click();
  return region;
}
/** On the narrow layout a side panel covers the view: close it before clicking the shape. */
async function uncover(page: Page) {
  if (!narrow()) return;
  // The tools' overflow menu stays open after a tool in it is used.
  if (await page.getByRole('button', { name: 'Add box', exact: true }).isVisible())
    await page.getByRole('button', { name: 'More editor tools' }).click();
  for (const name of ['Elements', 'Inspector'])
    if (await page.getByRole('complementary', { name }).isVisible())
      await page.getByRole('button', { name: `Close ${name}` }).click();
}

/** Downloads the PNG from the named button and reads its corner alpha and opaque share. */
const pngAlpha = (page: Page) => async (name: string) => {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const file = await download;
  const bytes = (await readFile((await file.path())!)).toString('base64');
  return {
    name: file.suggestedFilename(),
    ...(await page.evaluate(async (data) => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let opaque = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] === 255) opaque++;
      return { corner: pixels[3], opaque: opaque / (pixels.length / 4) };
    }, bytes)),
  };
};

test.describe('with the development kernel', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('adds a disc, a prism and a ring, edits a vertex and the angle, and duplicates (CAD15)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop flow');
    await page.goto('/?fixture=plate');
    await ready(page);
    const volume = async (name: string) => {
      const { content, evaluation } = await cadSnapshot(page);
      const body = content.bodies.filter((b) => b.name === name && b.state === 'active');
      return body.map((b) => (evaluation?.status === 'ok' ? vol(evaluation.bodies[b.id]) : NaN));
    };
    const near = (actual: number[], expected: number[]) => {
      expect(actual).toHaveLength(expected.length);
      actual.forEach((v, i) => expect(Math.abs(v / expected[i]! - 1)).toBeLessThan(1e-6));
    };
    for (const name of ['Add disc', 'Add prism', 'Add ring']) {
      await page.getByRole('button', { name, exact: true }).click();
      await ready(page);
    }
    await expect(bodies(page)).toHaveCount(4);
    // Circle r 15 × 10; an L of 600 mm² × 10; radii 10–15 × 20 revolved a full turn.
    near(await volume('Disc'), [2_250 * Math.PI]);
    near(await volume('Prism'), [6_000]);
    near(await volume('Ring'), [2_500 * Math.PI]);
    await page.locator('summary', { hasText: /^History/ }).click();
    const history = page.getByRole('list', { name: 'Feature history' });
    // Moving the second vertex to u = 50 widens the L's foot to 650 mm².
    await history.getByRole('button', { name: /^Prism\s*extrude$/ }).click();
    const u2 = inspector(page).getByLabel('2 U (mm)');
    await u2.fill('50');
    await u2.press('Enter');
    await ready(page);
    near(await volume('Prism'), [6_500]);
    // Half a turn halves the ring.
    await history.getByRole('button', { name: /^Ring\s*revolve$/ }).click();
    const angle = inspector(page).getByLabel('Angle (°)');
    await angle.fill('180');
    await angle.press('Enter');
    await ready(page);
    near(await volume('Ring'), [1_250 * Math.PI]);
    await page.screenshot({ path: test.info().outputPath('profiles.png') });
    // A copy of the ring with its own profile and feature, selected, as one edit.
    await bodies(page).filter({ hasText: 'Ring' }).click();
    await inspector(page).getByRole('button', { name: 'Duplicate body' }).click();
    await ready(page);
    await expect(bodies(page)).toHaveCount(5);
    near(await volume('Ring'), [1_250 * Math.PI, 1_250 * Math.PI]);
    const { content, selection } = await cadSnapshot(page);
    expect(content.bodies.filter((b) => b.name === 'Ring').at(-1)!.id).toBe(selection!.id);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await ready(page);
    await expect(bodies(page)).toHaveCount(4);
  });

  test('measures between two corners exactly and between face points approximately (N08)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    // Read only: measuring changes nothing, so it stays available.
    await page.goto('/?fixture=plate&view=plan&readonly=1');
    await ready(page);
    const start = await cadSnapshot(page);
    await page.getByRole('button', { name: 'Measure distance', exact: true }).click();
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    // Looking down Z with +Y up; the view spans 120 mm high about x = 40, y = 25.
    const scale = box.height / 120;
    const at = (x: number, y: number) =>
      page.mouse.click(
        box.x + box.width / 2 + (x - 40) * scale,
        box.y + box.height / 2 - (y - 25) * scale,
      );
    const panel = page.getByRole('status', { name: 'Distance' });
    await expect(panel).toContainText('Click a point on a body');
    // A few pixels inside two opposite top corners: each snaps to the kernel's vertex.
    await at(1, 49);
    await expect(panel).toContainText('From a corner of plate');
    await at(79, 1);
    await expect(page.getByTestId('cad-distance')).toHaveText(
      String(Number(Math.hypot(80, 50).toFixed(3))),
    );
    await expect(panel).toContainText('ΔX 80 · ΔY -50 · ΔZ 0 mm');
    await expect(panel).toContainText('Exact: both points are corners');
    await expect(panel).toContainText(`Shape ${start.contentHash.slice(0, 15)}…, millimetres.`);
    await page.screenshot({ path: test.info().outputPath('measure.png') });
    // A third click starts again; points away from corners are on the display mesh.
    await at(20, 25);
    await at(60, 25);
    await expect(panel).toContainText('Approximate: both points are on the display mesh');
    const distance = Number(await page.getByTestId('cad-distance').textContent());
    expect(Math.abs(distance - 40)).toBeLessThan(1);
    await panel.getByRole('button', { name: 'Clear' }).click();
    await expect(panel).toContainText('Click a point on a body');
    // Turning the tool off removes the panel; nothing was edited or selected.
    await page.getByRole('button', { name: 'Measure distance', exact: true }).click();
    await expect(panel).toHaveCount(0);
    const end = await cadSnapshot(page);
    expect(end.contentHash).toBe(start.contentHash);
    expect(end.selection).toBeNull();
  });

  test('picks faces and edges and shows their persistent names (R1b, CAD31)', async ({ page }) => {
    const desktop = test.info().project.name === 'desktop';
    // Picking only reads the pick table: read only, and the content does not change.
    await page.goto('/?fixture=plate&view=plan&readonly=1');
    await ready(page);
    const start = await cadSnapshot(page);
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    // Looking down Z with +Y up; the view spans 120 mm high about x = 40, y = 25.
    const scale = box.height / 120;
    const at = (x: number, y: number) =>
      page.mouse.click(
        box.x + box.width / 2 + (x - 40) * scale,
        box.y + box.height / 2 - (y - 25) * scale,
      );
    /** The picked element's name as the Inspector formats it (the narrow layout hides it). */
    const picked = () =>
      expect.poll(async () => {
        const name = (await cadSnapshot(page)).topology?.name;
        return name ? name.map((f) => f.join('/')).join(' | ') : null;
      });
    const name = page.getByTestId('cad-topology-name');
    await (await tool(page, 'Pick faces')).click();
    await at(20, 25);
    // The plate's top is the end face of its extrusion.
    await picked().toBe('end');
    if (desktop) {
      await expect(name).toHaveText('end');
      await expect(page.getByTestId('cad-topology-status')).toHaveText(
        'This name identifies one face.',
      );
      await expect(inspector(page)).toContainText('Face of plate');
    }
    await page.screenshot({ path: test.info().outputPath('pick-face.png') });
    await (await tool(page, 'Pick edges')).click();
    // The top edge on +Y: the edge below it is hidden by the plate and not picked.
    await at(20, 50);
    await picked().toBe('end | side:+v');
    if (desktop) {
      await expect(name).toHaveText('end | side:+v');
      await expect(inspector(page)).toContainText('Edge of plate');
      await expect(inspector(page)).toContainText('80 mm');
    }
    await page.screenshot({ path: test.info().outputPath('pick-edge.png') });
    // The rim of the hole is named by the tool body that cut it.
    await at(45, 25);
    await picked().toBe('end | tool:hole-placement/side');
    // Away from every edge, nothing is picked.
    await at(20, 25);
    await picked().toBe(null);
    expect((await cadSnapshot(page)).selection).toBeNull();
    await at(20, 50);
    await picked().toBe('end | side:+v');
    await page.keyboard.press('Escape');
    await picked().toBe(null);
    const end = await cadSnapshot(page);
    expect(end.contentHash).toBe(start.contentHash);
  });

  test('fillets a picked edge and lists its reference as resolved; Undo takes it back (R1c, CAD31)', async ({
    page,
  }) => {
    await page.goto('/?fixture=plate&view=plan');
    await ready(page);
    const start = await cadSnapshot(page);
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    const scale = box.height / 120;
    await (await tool(page, 'Pick edges')).click();
    // The top edge on +Y (see the pick test above).
    await page.mouse.click(box.x + box.width / 2 - 20 * scale, box.y + box.height / 2 - 25 * scale);
    await expect
      .poll(async () => (await cadSnapshot(page)).topology?.name)
      .toEqual([['end'], ['side:+v']]);
    const inspect = await panel(page, 'Inspector');
    await expect(inspect.getByTestId('cad-topology-name')).toHaveText('end | side:+v');
    await inspect.getByLabel('Size (mm)').fill('2');
    await inspect.getByRole('button', { name: 'Fillet', exact: true }).click();
    await ready(page);
    const after = await cadSnapshot(page);
    expect(after.selection).toMatchObject({ kind: 'feature' });
    // The R2 spandrel (1 − π/4)R² along the 80 mm edge.
    const plate = (s: typeof after) =>
      s.evaluation?.status === 'ok' ? vol(s.evaluation.bodies.plate) : NaN;
    expect(plate(after)).toBeCloseTo(f02Volume(80) - (1 - Math.PI / 4) * 4 * 80, 1);
    const references = page.getByTestId('cad-references');
    await expect(references.getByRole('listitem')).toHaveCount(1);
    await expect(references).toContainText('Edge end | side:+v');
    await expect(references).toContainText('Resolved');
    await page.screenshot({ path: test.info().outputPath('fillet-references.png') });
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(start.contentHash);
  });

  test('shells, drafts and mirrors from a picked face, each one edit (R1c)', async ({ page }) => {
    await page.goto('/?fixture=plate&view=plan');
    await ready(page);
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    const scale = box.height / 120;
    const volume = async () => {
      const s = await cadSnapshot(page);
      return s.evaluation?.status === 'ok' ? vol(s.evaluation.bodies.plate) : NaN;
    };
    const plate = f02Volume(80);
    /** Picks the plate's top (20 mm left of the hole), runs `button`, and returns the volume. */
    await (await tool(page, 'Pick faces')).click();
    const fromTop = async (button: string) => {
      await uncover(page);
      await page.mouse.click(box.x + box.width / 2 - 20 * scale, box.y + box.height / 2);
      await expect.poll(async () => (await cadSnapshot(page)).topology?.name).toEqual([['end']]);
      await (await panel(page, 'Inspector')).getByRole('button', { name: button }).click();
      await ready(page);
      expect((await cadSnapshot(page)).selection).toMatchObject({ kind: 'feature' });
      const v = await volume();
      await (await tool(page, 'Undo')).click();
      await ready(page);
      return v;
    };
    // A 2 mm wall inside, the top open: the pocket is 76 × 46 × 3 less a ring 2 mm round the hole.
    const shell = await fromTop('Shell, this face open');
    expect(shell).toBeCloseTo(plate - (76 * 46 * 3 - Math.PI * 49 * 3), 1);
    // The four sides and the hole wall tilt 3° about the top: a few percent either way.
    const draft = await fromTop('Draft the faces around it');
    expect(Math.abs(draft - plate) / plate).toBeGreaterThan(0.001);
    expect(Math.abs(draft - plate) / plate).toBeLessThan(0.2);
    // Reflected in its top face and joined: twice the plate.
    expect(await fromTop('Mirror and join')).toBeCloseTo(2 * plate, 1);
    expect(await volume()).toBeCloseTo(plate, 3);
  });

  test('the model tree shows each body with its features and the tools a Boolean used (CM-1)', async ({
    page,
  }) => {
    await page.goto('/?fixture=holes');
    await ready(page);
    const elements = await panel(page, 'Elements');
    await elements.getByText(/^Model tree$/).click();
    const tree = elements.getByRole('list', { name: 'Model tree' });
    const part = tree.getByRole('list', { name: 'part features' });
    await expect(part.getByRole('button', { name: /^Block\s*box$/ })).toBeVisible();
    const tools = part.getByRole('list', { name: /tools$/ });
    await expect(tools.getByText('a (tool)')).toBeVisible();
    await expect(tools.getByText('b (tool)')).toBeVisible();
    await expect(tools.getByRole('list', { name: 'a features' }).getByRole('button')).toHaveText([
      /^cyl-a\s*cylinder$/,
      /^a placement\s*transform$/,
    ]);
    // The Bodies list still shows only the active body; an entry selects as the lists do.
    await expect(
      elements.getByRole('list', { name: 'Bodies', exact: true }).getByRole('button'),
    ).toHaveCount(1);
    const rim = part.getByRole('button', { name: /^Rim fillet/ });
    await rim.click();
    await expect(rim).toHaveAttribute('aria-pressed', 'true');
  });

  test('reorders and takes out Boolean tools; the fillet keeps its hole (R1c, CAD30)', async ({
    page,
  }) => {
    await page.goto('/?fixture=holes');
    await ready(page);
    const volume = async () => {
      const s = await cadSnapshot(page);
      return s.evaluation?.status === 'ok' ? vol(s.evaluation.bodies.part) : NaN;
    };
    const start = await volume();
    // A long history starts folded.
    const elements = await panel(page, 'Elements');
    await elements.getByText(/^History \(\d+\)$/).click();
    const history = elements.getByRole('list', { name: 'Feature history' });
    await history.getByRole('button', { name: /cut 2 bodies/ }).click();
    const tools = (await panel(page, 'Inspector')).getByRole('list', { name: 'Boolean tools' });
    await expect(tools.getByRole('listitem')).toHaveText(['a', 'b']);
    await tools.getByRole('button', { name: 'Move b up' }).click();
    await ready(page);
    await expect(tools.getByRole('listitem')).toHaveText(['b', 'a']);
    expect(await volume()).toBeCloseTo(start, 3);
    await tools.getByRole('button', { name: 'Take out b' }).click();
    await ready(page);
    await expect(tools.getByRole('listitem')).toHaveText(['a']);
    // b is a body again; the plate keeps hole a and its rim fillet.
    expect(await volume()).toBeCloseTo(start + Math.PI * 36 * 20, 1);
    await panel(page, 'Elements');
    await expect(bodies(page).filter({ hasText: /^b$/ })).toHaveCount(1);
    await history.getByRole('button', { name: /Rim fillet/ }).click();
    const references = (await panel(page, 'Inspector')).getByTestId('cad-references');
    await expect(references).toContainText('tool:a-placement/side');
    await expect(references).toContainText('Resolved');
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect(await volume()).toBeCloseTo(start, 3);
  });

  test('chooses a split edge again on a preview: one edit, Undo, and the same edge after reload (R1c, CAD30, CAD31)', async ({
    page,
  }) => {
    const desktop = test.info().project.name === 'desktop';
    await page.goto('/?fixture=fillet&persist=1');
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await ready(page);
    const fillet = (s: Awaited<ReturnType<typeof cadSnapshot>>) =>
      s.content.features.find((f) => f.id === 'fillet') as {
        args: { edges: { select?: unknown; hint: { centroid: number[] } }[] };
      };
    const start = await cadSnapshot(page);
    const elements = await panel(page, 'Elements');
    await elements.getByText(/^History \(\d+\)$/).click();
    await elements.getByRole('button', { name: /^Slot/ }).click();
    const inspect = await panel(page, 'Inspector');
    // The slot grows up through the top: the +y top edge the fillet rounds splits in two.
    const height = inspect.getByLabel('Height (mm)');
    await height.fill('30');
    await height.press('Enter');
    // The status line says a choice is pending; on the narrow layout the Inspector covers the
    // view, where the choice and its preview are.
    await expect(page.getByText('Choose references in the view.')).toBeVisible();
    // The field keeps the pending value while the choice is open.
    await expect(height).toHaveValue('30');
    await uncover(page);
    const rebind = page.getByTestId('cad-rebind');
    await expect(rebind).toBeVisible();
    await expect(rebind).toContainText('Top fillet');
    const candidate = rebind.getByTestId('cad-rebind-candidate');
    await expect(candidate).toContainText('Candidate 1 of 2');
    const confirm = rebind.getByRole('button', { name: 'Confirm' });
    await expect(confirm).toBeEnabled();
    // The preview shows the shape with that choice; nothing is stored yet.
    expect((await cadSnapshot(page)).meshes).toMatchObject({ preview: true, current: false });
    expect((await cadSnapshot(page)).contentHash).toBe(start.contentHash);
    const first = await candidate.textContent();
    await rebind.getByRole('button', { name: 'Next candidate' }).click();
    await expect(candidate).toContainText('Candidate 2 of 2');
    await expect(candidate).not.toHaveText(first!);
    await expect(confirm).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('rebind-preview.png') });
    await confirm.click();
    await ready(page);
    await expect(rebind).toHaveCount(0);
    const chosen = await cadSnapshot(page);
    const edge = fillet(chosen).args.edges[2]!;
    expect(edge.select).toBeDefined();
    const volume = (s: typeof chosen) =>
      s.evaluation?.status === 'ok' ? vol(s.evaluation.bodies.part) : NaN;
    // One Undo takes back the slot change and the choice together.
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(start.contentHash);
    await (await tool(page, 'Redo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(chosen.contentHash);
    // Reloaded from the stored content, the reference resolves to the same edge.
    await page.reload();
    await ready(page);
    const reloaded = await cadSnapshot(page);
    expect(reloaded.contentHash).toBe(chosen.contentHash);
    expect(volume(reloaded)).toBeCloseTo(volume(chosen), 6);
    const again = await panel(page, 'Elements');
    await again.getByText(/^History \(\d+\)$/).click();
    await again.getByRole('button', { name: /^Top fillet/ }).click();
    const references = (await panel(page, 'Inspector')).getByTestId('cad-references');
    await expect(references.getByRole('listitem')).toHaveCount(4);
    await expect(references.getByText('Resolved')).toHaveCount(4);
    if (desktop) await expect(references).toContainText('next to');
    await page.screenshot({ path: test.info().outputPath('rebind-references.png') });
  });

  test('moves a body whose face is picked, its highlight with it (R1b)', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'mouse drag');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/?fixture=plate&view=plan');
    await ready(page);
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    // The view is centred on the hole (x = 40, y = 25); 20 mm to its left is the plate's top.
    const [cx, cy] = [box.x + box.width / 2 - 20 * (box.height / 120), box.y + box.height / 2];
    await (await tool(page, 'Pick faces')).click();
    await page.mouse.click(cx, cy);
    await expect.poll(async () => (await cadSnapshot(page)).topology?.name).toEqual([['end']]);
    const start = (await cadSnapshot(page)).contentHash;
    await (await tool(page, 'Move bodies')).click();
    // Escape puts the body and the highlight back; a release makes one edit.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 5 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect((await cadSnapshot(page)).contentHash).toBe(start);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 5 });
    await page.mouse.up();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).not.toBe(start);
    expect(errors).toEqual([]);
  });

  test('snaps to corners whose coordinates Float32 rounds in the display mesh (N08)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate&view=plan');
    await ready(page);
    // 80.1 mm is not a Float32 value: the display mesh's side face sits beside the kernel's x.
    await page
      .getByRole('list', { name: 'Parameters' })
      .getByRole('button', { name: /Width/ })
      .click();
    const value = inspector(page).getByLabel('Value (mm)');
    await value.fill('80.1');
    await value.press('Enter');
    await ready(page);
    await page.getByRole('button', { name: 'Measure distance', exact: true }).click();
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    const scale = box.height / 120;
    const at = (x: number, y: number) =>
      page.mouse.click(
        box.x + box.width / 2 + (x - 40) * scale,
        box.y + box.height / 2 - (y - 25) * scale,
      );
    await at(1, 49);
    await at(79, 1);
    const panel = page.getByRole('status', { name: 'Distance' });
    await expect(panel).toContainText('Exact: both points are corners');
    await expect(page.getByTestId('cad-distance')).toHaveText(
      String(Number(Math.hypot(80.1, 50).toFixed(3))),
    );
  });

  test('parameter edit re-evaluates and an invalid value is rejected', async ({ page }) => {
    await page.goto('/?fixture=plate');
    await ready(page);
    await expect(page.getByTestId('cad-viewport').locator('canvas')).toBeVisible();
    if (test.info().project.name !== 'desktop') return;
    const opened = (await cadSnapshot(page)).content;
    await bodies(page).filter({ hasText: 'plate' }).click();
    await expect(inspector(page)).toContainText('80 × 50 × 5 mm');
    await page
      .getByRole('list', { name: 'Parameters' })
      .getByRole('button', { name: /Width/ })
      .click();
    const value = inspector(page).getByLabel('Value (mm)');
    await value.fill('100');
    await value.press('Enter');
    await ready(page);
    await expect(page.getByRole('list', { name: 'Parameters' })).toContainText('100 mm');
    // The same operation data applied headless gives the same content, IDs and hash (ST-27#6).
    const headless = applyCadOperation(opened, {
      type: 'setParameter',
      parameterId: 'W',
      value: 100,
    });
    const edited = await cadSnapshot(page);
    expect(edited.content).toEqual(headless);
    expect(edited.contentHash).toBe(cadContentHash(headless));
    await bodies(page).filter({ hasText: 'plate' }).click();
    await expect(inspector(page)).toContainText(
      `${Number(f02Volume(100).toFixed(3)).toLocaleString('en-US', { maximumFractionDigits: 3 })} mm³`,
    );
    await page
      .getByRole('list', { name: 'Parameters' })
      .getByRole('button', { name: /Width/ })
      .click();
    // Zero width cannot form a solid: rejected, field restored, history unchanged.
    await value.fill('0');
    await value.press('Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(value).toHaveValue('100');
    await expect(page.getByRole('list', { name: 'Parameters' })).toContainText('100 mm');
    await page.getByRole('button', { name: 'Undo' }).click();
    await ready(page);
    await expect(page.getByRole('list', { name: 'Parameters' })).toContainText('80 mm');
  });

  test('PNG export waits while an edit evaluates', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate');
    await ready(page);
    const exportPng = await tool(page, 'Export PNG');
    await expect(exportPng).toBeEnabled();
    await page.evaluate(() => {
      const { port } = (window as unknown as { cad: { port: { evaluate: unknown } } }).cad;
      port.evaluate = () => new Promise(() => {});
    });
    await page
      .getByRole('list', { name: 'Parameters' })
      .getByRole('button', { name: /Width/ })
      .click();
    const value = inspector(page).getByLabel('Value (mm)');
    await value.fill('100');
    await value.press('Enter');
    await expect(state(page)).toHaveText('Calculating…');
    await expect(exportPng).toBeDisabled();
  });

  test('add, move, cut and undo bodies', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop flow');
    await page.goto('/?fixture=plate');
    await ready(page);
    await page.getByRole('button', { name: 'Add box' }).click();
    await ready(page);
    await expect(bodies(page)).toHaveCount(2);
    await bodies(page).filter({ hasText: 'Box' }).click();
    const x = inspector(page).getByLabel('X (mm)');
    // New bodies land beside the plate; move the box back over its corner.
    await x.fill('-60');
    await x.press('Enter');
    await ready(page);
    await bodies(page).filter({ hasText: 'plate' }).click();
    await expect(inspector(page)).toContainText('19,607.301 mm³');
    await inspector(page).getByLabel('With body').selectOption({ label: 'Box' });
    await inspector(page).getByRole('button', { name: 'Cut' }).click();
    await ready(page);
    await expect(bodies(page)).toHaveCount(1);
    await expect(inspector(page)).not.toContainText('19,607.301 mm³');
    await page.screenshot({ path: test.info().outputPath('cut.png') });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await ready(page);
    await expect(bodies(page)).toHaveCount(2);
  });

  test('opens with the saved view, switches views and saves one (ST-27#9, #11)', async ({
    page,
  }) => {
    await page.goto('/?fixture=plate&view=side');
    await ready(page);
    const views = page.getByLabel('Views');
    await expect(views).toHaveValue('side');
    const hash = async () => (await cadSnapshot(page)).contentHash;
    const before = await hash();
    // Save view records the camera the Surface opened with.
    await (await tool(page, 'Save view')).click();
    await ready(page);
    await expect(views).toHaveValue('view-1');
    const saved = (await cadSnapshot(page)).content.namedViews;
    expect(saved[1]).toMatchObject({
      name: 'View 2',
      bodyIds: ['plate'],
      camera: { position: [40, -300, 2.5], target: [40, 25, 2.5], up: [0, 0, 1] },
      projection: { type: 'orthographic', spanMm: 120 },
    });
    // Choosing views moves only the camera: content and history stay.
    const afterSave = await hash();
    expect(afterSave).not.toBe(before);
    await views.selectOption({ label: 'Whole model' });
    await views.selectOption({ label: 'Side' });
    expect(await hash()).toBe(afterSave);
    await page.screenshot({ path: test.info().outputPath('side-view.png') });
    await page.keyboard.press('Control+z');
    await ready(page);
    await expect(views.getByRole('option')).toHaveCount(2);
    expect(await hash()).toBe(before);
    await page.keyboard.press('Control+Shift+z');
    await ready(page);
    await expect(views.getByRole('option')).toHaveCount(3);
  });

  test('Whole model fits every body after a view that shows fewer (ST-27#9)', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate&view=side');
    await ready(page);
    await page.getByRole('button', { name: 'Add box' }).click();
    await ready(page);
    const views = page.getByLabel('Views');
    await views.selectOption({ label: 'Side' });
    await views.selectOption({ label: 'Whole model' });
    await page.getByRole('button', { name: 'Save view' }).click();
    await ready(page);
    const saved = (await cadSnapshot(page)).content.namedViews.at(-1)!;
    expect(saved.bodyIds).toHaveLength(2);
    // The plate spans x 0–80 and the new box sits beside it: the fit centres past the plate.
    expect(saved.camera.target[0]).toBeGreaterThan(41);
  });

  test('a saved view with Y up still orbits (ST-27#9)', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'mouse drag');
    await page.goto('/?fixture=plate&view=plan');
    await ready(page);
    const box = (await page.getByTestId('cad-viewport').boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 150, y, { steps: 10 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Save view' }).click();
    await ready(page);
    const { position, target } = (await cadSnapshot(page)).content.namedViews.at(-1)!.camera;
    // A horizontal drag swings the camera off the straight-down line.
    expect(Math.abs(position[0] - target[0])).toBeGreaterThan(50);
  });

  test('a saved up of any length orbits around that axis (ST-27#9)', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'mouse drag');
    await page.goto('/?fixture=plate&view=long-up');
    await ready(page);
    const box = (await page.getByTestId('cad-viewport').boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 150, y, { steps: 10 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Save view' }).click();
    await ready(page);
    const { position, target } = (await cadSnapshot(page)).content.namedViews.at(-1)!.camera;
    // A horizontal drag turns around Z: the camera stays level with its target.
    expect(Math.abs(position[0] - target[0])).toBeGreaterThan(50);
    expect(Math.abs(position[2] - target[2])).toBeLessThan(1);
  });

  test('a short drag does not swing below the part (ST-27#10)', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'mouse drag');
    // Hold the kernel back so the waiting note is visible before the first shape.
    await page.route('**/*.wasm', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto('/?fixture=plate');
    await expect(page.getByText('Preparing the 3D shape…')).toBeVisible();
    await ready(page);
    await expect(page.getByText('Preparing the 3D shape…')).toHaveCount(0);
    const box = (await page.getByTestId('cad-viewport').boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 150, y - 120, { steps: 10 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Save view' }).click();
    await ready(page);
    const [view] = (await cadSnapshot(page)).content.namedViews;
    // Still looking down on the plate (camera above its target), not from underneath.
    expect(view.camera.position[2]).toBeGreaterThan(view.camera.target[2]);
  });

  test('PNG without background keeps only the shape (ST-27#12)', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate');
    await ready(page);
    const alpha = pngAlpha(page);
    const normal = await alpha('Export PNG');
    expect(normal).toMatchObject({ name: 'cad.png', corner: 255, opaque: 1 });
    const clear = await alpha('Export PNG without background');
    expect(clear.name).toBe('cad-transparent.png');
    expect(clear.corner).toBe(0);
    expect(clear.opaque).toBeGreaterThan(0.01);
    expect(clear.opaque).toBeLessThan(0.9);
  });

  test('an earlier build is shown read-only until an explicit migration (CAD17)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate&kernel=reference');
    await ready(page);
    const note = page.getByRole('note');
    await expect(note).toContainText('Reference display by a newer kernel build');
    for (const name of ['Add box', 'Save view', 'Export PNG', 'Export STEP, STL or GLB'])
      await expect(await tool(page, name)).toBeDisabled();
    const build = () =>
      page.evaluate(
        () =>
          (window as unknown as { cad: { controller: CadController } }).cad.controller.getSnapshot()
            .content.kernelProfile.buildHash,
      );
    expect(await build()).toBe(`sha256:${'e'.repeat(64)}`);

    // Measurements need the exact build: none on a reference display.
    await bodies(page).first().click();
    await expect(inspector(page)).toContainText('Not available on a reference display');

    // Migration shows the new build's result first; Cancel leaves the document as it was.
    const dialog = page.getByRole('dialog', { name: 'Migrate to current kernel' });
    await (await tool(page, 'Migrate to current kernel')).click();
    await expect(dialog.getByRole('table', { name: 'Migration result' })).toContainText('mm³');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await build()).toBe(`sha256:${'e'.repeat(64)}`);
    await (await tool(page, 'Migrate to current kernel')).click();
    await dialog.getByRole('button', { name: 'Adopt migration' }).click();
    await ready(page);
    await expect(note).toHaveCount(0);
    expect(await build()).not.toBe(`sha256:${'e'.repeat(64)}`);
    await expect(await tool(page, 'Add box')).toBeEnabled();
    await expect(await tool(page, 'Export STEP, STL or GLB')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Migrate to current kernel' })).toHaveCount(0);
    // Undo restores the earlier build: the reference display again, the saved recipe unchanged.
    await (await tool(page, 'Undo')).click();
    await expect(note).toBeVisible();
    expect(await build()).toBe(`sha256:${'e'.repeat(64)}`);
  });

  test('STL, GLB and STEP export the confirmed plate after a report (CAD11, CAD12)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate');
    await ready(page);
    const dialog = page.getByRole('dialog', { name: 'Export 3D file' });
    const save = async (button: string) => {
      const download = page.waitForEvent('download');
      await dialog.getByRole('button', { name: button }).click();
      const file = await download;
      const bytes = await readFile((await file.path())!);
      return { name: file.suggestedFilename(), data: new Uint8Array(bytes).buffer };
    };

    await (await tool(page, 'Export STEP, STL or GLB')).click();
    const prepare = dialog.getByRole('button', { name: 'Prepare file' });
    // STL carries no unit: the millimetre confirmation comes first.
    await expect(prepare).toBeDisabled();
    await dialog.getByLabel('Triangulation').selectOption({ label: 'Fine (0.01 mm)' });
    await dialog.getByRole('checkbox').check();
    await prepare.click();
    const report = dialog.getByRole('definition');
    await expect(dialog.getByLabel('Export report')).toContainText('0.01 mm');
    await expect(report.filter({ hasText: /^mm$/ })).toHaveCount(1);
    const stl = await save('Save STL');
    expect(stl.name).toBe('cad.stl');
    const geometry = new STLLoader().parse(stl.data);
    geometry.computeBoundingBox();
    const close = (a: number[], b: number[], digits: number) =>
      a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
    close(geometry.boundingBox!.min.toArray(), [0, 0, 0], 4);
    close(geometry.boundingBox!.max.toArray(), [80, 50, 5], 4);
    const p = geometry.getAttribute('position').array;
    let volume = 0;
    for (let i = 0; i < p.length; i += 9)
      volume +=
        (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) -
          p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) +
          p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) /
        6;
    const exact = 80 * 50 * 5 - Math.PI * 5 * 5 * 5;
    expect(Math.abs(volume / exact - 1)).toBeLessThan(0.001);
    await expect(dialog).toHaveCount(0);

    await (await tool(page, 'Export STEP, STL or GLB')).click();
    await dialog.getByLabel(/^GLB/).check();
    await prepare.click();
    await expect(dialog.getByLabel('Export report')).toContainText('Y-up');
    const glb = await save('Save GLB');
    expect(glb.name).toBe('cad.glb');
    const gltf = await new GLTFLoader().parseAsync(glb.data, '');
    gltf.scene.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(gltf.scene);
    close(bounds.min.toArray(), [0, 0, -0.05], 6);
    close(bounds.max.toArray(), [0.08, 0.005, 0], 6);

    // STEP carries exact solids and its own unit: no triangulation or confirmation (CAD11).
    await (await tool(page, 'Export STEP, STL or GLB')).click();
    await dialog.getByLabel(/^STEP/).check();
    await expect(dialog.getByLabel('Triangulation')).toHaveCount(0);
    await prepare.click();
    await expect(dialog.getByLabel('Export report')).toContainText('mm');
    const step = await save('Save STEP');
    expect(step.name).toBe('cad.step');
    const text = new TextDecoder().decode(step.data);
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toMatch(/MANIFOLD_SOLID_BREP/);
    expect(text).toMatch(/SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
  });

  test('while an edit evaluates, STL exports the confirmed shape; PNG still waits (CAD21)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate');
    await ready(page);
    const confirmed = (await cadSnapshot(page)).contentHash;
    // The edit's evaluation never finishes; exports use the port's own export requests.
    await page.evaluate(() => {
      const { port } = (window as unknown as { cad: { port: { evaluate: unknown } } }).cad;
      port.evaluate = () => new Promise(() => {});
    });
    await page
      .getByRole('list', { name: 'Parameters' })
      .getByRole('button', { name: /Width/ })
      .click();
    const value = inspector(page).getByLabel('Value (mm)');
    await value.fill('100');
    await value.press('Enter');
    await expect(state(page)).toHaveText('Calculating…');
    await expect(await tool(page, 'Export PNG')).toBeDisabled();
    await (await tool(page, 'Export STEP, STL or GLB')).click();
    const dialog = page.getByRole('dialog', { name: 'Export 3D file' });
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Prepare file' }).click();
    await expect(dialog.getByLabel('Export report')).toBeVisible();
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save STL' }).click();
    const geometry = new STLLoader().parse(
      new Uint8Array(await readFile((await (await download).path())!)).buffer,
    );
    geometry.computeBoundingBox();
    // The confirmed plate is 80 mm wide; the 100 mm candidate never reaches the file.
    expect(geometry.boundingBox!.max.x).toBeCloseTo(80, 4);
    expect((await cadSnapshot(page)).contentHash).toBe(confirmed);
  });

  test('a WebGL context loss releases the display and a restore shows the same shape again (CAD26)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate');
    await ready(page);
    const canvas = page.getByTestId('cad-viewport').locator('canvas');
    const before = await canvas.screenshot();
    const lose = (method: 'loseContext' | 'restoreContext') =>
      page.evaluate((m) => {
        const gl = document
          .querySelector<HTMLCanvasElement>('[data-testid="cad-viewport"] canvas')!
          .getContext('webgl2')!;
        (window as unknown as { lost?: WEBGL_lose_context }).lost ??=
          gl.getExtension('WEBGL_lose_context')!;
        (window as unknown as { lost: WEBGL_lose_context }).lost[m]();
      }, method);
    const hash = (await cadSnapshot(page)).contentHash;
    await lose('loseContext');
    const note = page.getByText('3D表示を利用できません。一覧とInspectorから編集・保存できます。');
    await expect(note).toBeVisible();
    await expect(bodies(page).first()).toBeEnabled();
    await lose('restoreContext');
    await expect(note).toBeHidden();
    await expect.poll(async () => Buffer.compare(await canvas.screenshot(), before)).toBe(0);
    expect((await cadSnapshot(page)).contentHash).toBe(hash);
  });

  test('a shape over the GPU budget is not drawn, and the document stays editable (CAD26)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate&gpuBytes=1000');
    await ready(page);
    await expect(
      page.getByText(/^形状が3D表示に使えるメモリーの上限を超えるため、表示していません/),
    ).toBeVisible();
    // The list, Inspector and edits stay: a dimension change still applies as one edit.
    await page
      .getByRole('list', { name: 'Parameters' })
      .getByRole('button', { name: /Width/ })
      .click();
    const value = inspector(page).getByLabel('Value (mm)');
    await value.fill('100');
    await value.press('Enter');
    await ready(page);
    expect((await cadSnapshot(page)).canUndo).toBe(true);
    // A new budget applies in place: the same viewport draws the shape, and refuses it again.
    const note = page.getByText(/^形状が3D表示に使えるメモリーの上限を超えるため/);
    const drawn = () =>
      page.evaluate(() => {
        const source = document.querySelector<HTMLCanvasElement>('.cad-canvas')!;
        const canvas = new OffscreenCanvas(source.width, source.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(source, 0, 0);
        const pixels = context.getImageData(0, 0, source.width, source.height).data;
        // The plate's grey (#9aa4b1 lit) is darker than the light background and grid.
        let dark = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! < 160) dark++;
        return dark / (pixels.length / 4);
      });
    const setBudget = (bytes: number | undefined) =>
      page.evaluate(
        (b) =>
          (
            window as unknown as { cad: { setGpuBytes(bytes: number | undefined): void } }
          ).cad.setGpuBytes(b ?? undefined),
        bytes ?? null,
      );
    // A PNG would hold only the background: refused until the shape is drawn.
    const png = page.getByRole('button', { name: 'Export PNG', exact: true });
    expect(await drawn()).toBeLessThan(0.01);
    await expect(png).toBeDisabled();
    await setBudget(undefined);
    await expect(note).toHaveCount(0);
    await expect.poll(drawn).toBeGreaterThan(0.02);
    await expect(png).toBeEnabled();
    await setBudget(1000);
    await expect(note).toBeVisible();
    await expect.poll(drawn).toBeLessThan(0.01);
    await expect(png).toBeDisabled();
  });

  test('placed parts follow a changed GPU budget and the native bodies beside them (R2b-1, CAD26)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=r2b');
    await ready(page);
    await expect(page.locator('.cad-part-state')).toHaveCount(0);
    const note = page.getByText(/^部品の形状が3D表示に使えるメモリーの上限を超えるため/);
    await expect(note).toHaveCount(0);
    const setBudget = (bytes: number | undefined) =>
      page.evaluate(
        (b) =>
          (
            window as unknown as { cad: { setGpuBytes(bytes: number | undefined): void } }
          ).cad.setGpuBytes(b ?? undefined),
        bytes ?? null,
      );
    // A smaller budget turns the drawn parts into boxes; the full budget draws them again.
    await setBudget(1000);
    await expect(note).toBeVisible();
    await setBudget(undefined);
    await expect(note).toHaveCount(0);
    // The smallest budget the parts' shapes fit in, found by halving.
    const settled = () =>
      page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r))));
    let [lo, hi] = [1000, 64 * 1024 * 1024];
    while (hi - lo > 1024) {
      const mid = Math.floor((lo + hi) / 2);
      await setBudget(mid);
      await settled();
      if (await note.count()) lo = mid;
      else hi = mid;
    }
    await setBudget(hi);
    await expect(note).toHaveCount(0);
    // A native body drawn beside them takes its share: the parts become boxes.
    await (await tool(page, 'Add box')).click();
    await ready(page);
    await expect(note).toBeVisible();
  });

  test('an orthographic view saved far away still shows the part (ST-27#9)', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate&view=far');
    await ready(page);
    const { opaque } = await pngAlpha(page)('Export PNG without background');
    expect(opaque).toBeGreaterThan(0.01);
  });

  test('a 3.6 m sphere is calculated within the job limit (ST-28#8)', async ({ page }) => {
    await page.goto('/?fixture=hub');
    // The job limit is 30 s; the fixed 0.05 mm deflection never finished (#372).
    await expect(state(page)).toHaveText('Shape up to date', { timeout: 30_000 });
    await expect(page.getByTestId('cad-geometry-failure')).toHaveCount(0);
    const triangles = await page.evaluate(() => {
      const { controller } = (window as unknown as { cad: { controller: CadController } }).cad;
      return controller.getSnapshot().meshes!.meshes[0].indices.length / 3;
    });
    expect(triangles).toBeLessThan(10_000);
    await page.screenshot({ path: test.info().outputPath('hub.png') });
  });

  test('a 20-step drag moves a body as one edit; Escape cancels (ST-27#5, CAD20)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'mouse drag');
    await page.goto('/');
    await page.getByRole('button', { name: 'Add box' }).click();
    await ready(page);
    const placement = async () => {
      const { content } = await cadSnapshot(page);
      const body = content.bodies[0];
      const t = content.features.find((f) => f.id === body.resultFeatureId)!;
      return {
        features: content.features.length,
        at: (t.args as { translation: { literalMm: number }[] }).translation.map(
          (v) => v.literalMm,
        ),
      };
    };
    const before = await placement();
    const hash = async () => (await cadSnapshot(page)).contentHash;
    const start = await hash();
    const move = page.getByRole('button', { name: 'Move bodies', exact: true });
    await move.click();
    await expect(move).toHaveAttribute('aria-pressed', 'true');
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    // Escape during the gesture puts the body back and records nothing.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 5 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await hash()).toBe(start);
    // During the drag only the display moves; the release makes one edit.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 30, { steps: 20 });
    expect(await hash()).toBe(start);
    expect((await cadSnapshot(page)).busy).toBe(false);
    await page.mouse.up();
    await ready(page);
    const after = await placement();
    expect(after.features).toBe(before.features);
    expect(after.at).not.toEqual(before.at);
    expect(after.at[2]).toBe(before.at[2]);
    await page.screenshot({ path: test.info().outputPath('moved.png') });
    await page.keyboard.press('Control+z');
    await ready(page);
    expect((await placement()).at).toEqual(before.at);
    expect(await hash()).toBe(start);
    // Undo during a drag removes the dragged body (its Add box edit): the release cancels the
    // gesture instead of moving a body that is gone.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy, { steps: 5 });
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await cadSnapshot(page)).content.bodies.length).toBe(0);
    await page.mouse.up();
    await expect.poll(async () => (await cadSnapshot(page)).busy).toBe(false);
    expect((await cadSnapshot(page)).content.bodies).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a drag in a side-on view is refused with a reason instead of a huge move', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'mouse drag');
    await page.goto('/?fixture=plate&view=side');
    await ready(page);
    const start = (await cadSnapshot(page)).contentHash;
    await page.getByRole('button', { name: 'Move bodies', exact: true }).click();
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 2, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText('真横');
    expect((await cadSnapshot(page)).contentHash).toBe(start);
  });

  test('with Move on, a click on a body selects it without moving it', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'mouse drag');
    await page.goto('/?fixture=plate&view=plan');
    await ready(page);
    const start = (await cadSnapshot(page)).contentHash;
    await page.getByRole('button', { name: 'Move bodies', exact: true }).click();
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    // The plate has a hole in its centre: click 25 mm to its left (the view spans 120 mm).
    await page.mouse.click(box.x + box.width / 2 - (box.height * 25) / 120, box.y + box.height / 2);
    await expect
      .poll(async () => (await cadSnapshot(page)).selection)
      .toEqual({ kind: 'body', id: 'plate' });
    expect((await cadSnapshot(page)).contentHash).toBe(start);
  });

  test('a second touch during a body drag cancels the move (two-finger navigation)', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    await page.goto('/');
    await (await tool(page, 'Add box')).click();
    await ready(page);
    if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
    const start = (await cadSnapshot(page)).contentHash;
    await (await tool(page, 'Move bodies')).click();
    if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    // Real touches through the DevTools protocol: one finger on the body, then a second.
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map(([x, y], id) => ({ x, y, id })),
      });
    await touch('touchStart', [[cx, cy]]);
    await touch('touchMove', [[cx + 10, cy]]);
    await touch('touchStart', [
      [cx + 10, cy],
      [cx + 60, cy + 40],
    ]);
    await touch('touchMove', [
      [cx + 40, cy],
      [cx + 90, cy + 40],
    ]);
    // The first finger lifts above the canvas, where the cancelled move no longer captures it.
    await touch('touchMove', [
      [cx, box.y - 10],
      [cx + 90, cy + 40],
    ]);
    await touch('touchEnd', []);
    await expect.poll(async () => (await cadSnapshot(page)).busy).toBe(false);
    expect((await cadSnapshot(page)).contentHash).toBe(start);
    // A later one-finger drag still moves the body.
    await touch('touchStart', [[cx, cy]]);
    for (const dx of [10, 20, 30, 40]) await touch('touchMove', [[cx + dx, cy]]);
    await touch('touchEnd', []);
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).not.toBe(start);
  });

  test('PNG export is refused while a body drag is held', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'mouse drag');
    await page.goto('/');
    await page.getByRole('button', { name: 'Add box' }).click();
    await ready(page);
    await page.getByRole('button', { name: 'Move bodies', exact: true }).click();
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 5 });
    let downloads = 0;
    page.on('download', () => downloads++);
    // Keyboard activation while the mouse button is still held.
    await page.getByRole('button', { name: 'Export PNG', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText('移動している途中');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(downloads).toBe(0);
  });

  test('binds dimensions with expressions in a schema 2 document (CAD27, CAD28)', async ({
    page,
  }) => {
    await page.goto('/?fixture=plate');
    await ready(page);
    if (test.info().project.name !== 'desktop') return;
    const opened = (await cadSnapshot(page)).content;
    expect([opened.schemaVersion, opened.kernelProfile.semanticsVersion]).toEqual([2, 2]);
    const params = page.getByRole('list', { name: 'Parameters' });
    const value = inspector(page).getByLabel(/^Value/);
    // Schema 2 is the only format: no migration is offered.
    await expect(page.getByRole('button', { name: /Migrate to schema/ })).toHaveCount(0);

    // T = W / 16: 5 mm at W = 80, and it follows W.
    await params.getByRole('button', { name: /Thickness/ }).click();
    await value.fill('Width / 16');
    await value.press('Enter');
    await ready(page);
    await expect(params).toContainText('Thickness5 mm');
    await expect(value).toHaveValue('Width / 16');
    await params.getByRole('button', { name: /Width/ }).click();
    await value.fill('96');
    await value.press('Enter');
    await ready(page);
    await expect(params).toContainText('Thickness6 mm');

    // A parse error stays in the field with its position; nothing is edited.
    const before = (await cadSnapshot(page)).contentHash;
    await params.getByRole('button', { name: /Depth/ }).click();
    await value.fill('Width +');
    await value.press('Enter');
    await expect(inspector(page).getByRole('alert')).toHaveText('式として読めません（8文字目）。');
    await expect(value).toHaveValue('Width +');
    // Until the IME commits, Enter does not parse the field.
    await value.fill('');
    await value.dispatchEvent('compositionstart', { data: '' });
    await page.keyboard.insertText('Width / 2');
    await value.press('Enter');
    expect((await cadSnapshot(page)).contentHash).toBe(before);
    await value.dispatchEvent('compositionend', { data: 'Width / 2' });
    await value.press('Escape');
    // A cycle is refused by the document's validation; content and history stay.
    await params.getByRole('button', { name: /Width/ }).click();
    await value.fill('Thickness * 16');
    await value.press('Enter');
    await expect(page.getByRole('alert').first()).toContainText('循環');
    expect((await cadSnapshot(page)).contentHash).toBe(before);

    // A count parameter, then Undo back through the edits to the opened content.
    await page.getByRole('button', { name: 'Add count' }).click();
    await ready(page);
    await expect(params).toContainText('Count 1');
    await expect(value).toHaveValue('2');
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Undo' }).click();
      await ready(page);
    }
    expect((await cadSnapshot(page)).content).toEqual(opened);
    await page.screenshot({ path: test.info().outputPath('schema2-expressions.png') });
  });

  test('names a body through an IME composition as one edit (ST-27#8)', async ({ page }) => {
    await page.goto('/?fixture=plate');
    await ready(page);
    if (test.info().project.name !== 'desktop')
      await page.getByRole('button', { name: 'Toggle Elements' }).click();
    await bodies(page).filter({ hasText: 'plate' }).click();
    if (test.info().project.name !== 'desktop')
      await page.getByRole('button', { name: 'Toggle Inspector' }).click();
    const name = inspector(page).getByLabel('Name');
    await name.click();
    await name.fill('');
    // Enter while the IME is composing picks the candidate; it does not commit the field.
    await name.dispatchEvent('compositionstart', { data: '' });
    await page.keyboard.insertText('取付板');
    await name.press('Enter');
    expect((await cadSnapshot(page)).content.bodies.find((b) => b.id === 'plate')!.name).toBe(
      'plate',
    );
    await name.dispatchEvent('compositionend', { data: '取付板' });
    await name.press('Enter');
    await expect
      .poll(
        async () => (await cadSnapshot(page)).content.bodies.find((b) => b.id === 'plate')!.name,
      )
      .toBe('取付板');
    // Escape drops an unconfirmed draft; the name stays.
    await name.fill('別名');
    await name.press('Escape');
    await expect(name).toHaveValue('取付板');
    // One Undo returns the old name.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+z');
    await expect
      .poll(
        async () => (await cadSnapshot(page)).content.bodies.find((b) => b.id === 'plate')!.name,
      )
      .toBe('plate');
    await page.screenshot({ path: test.info().outputPath('ime-name.png') });
  });

  test('narrow layout keeps the viewport and toolbar usable', async ({ page }) => {
    test.skip(test.info().project.name === 'desktop', 'narrow layout');
    await page.goto('/');
    await (await tool(page, 'Add cylinder')).click();
    await ready(page);
    await page.keyboard.press('Escape');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath('narrow.png') });
    await page.getByRole('button', { name: 'Toggle Elements' }).click();
    await expect(bodies(page)).toHaveCount(1);
  });
});

test('missing kernel build keeps the document readable', async ({ page }) => {
  await page.goto('/?fixture=plate&kernel=missing');
  await expect(state(page)).toHaveText('Shape could not be calculated');
  // The reason is shown next to the state (ST-28#9).
  // The Host's kernel list has no such build (CAD17), so the reason names the missing kernel.
  await expect(page.getByTestId('cad-geometry-failure')).toHaveText(
    'この文書の計算に必要なkernelがありません。',
  );
  await page.screenshot({ path: test.info().outputPath('failure.png') });
  if (test.info().project.name !== 'desktop') return;
  await expect(page.getByRole('button', { name: 'Recalculate' })).toBeVisible();
  await expect(bodies(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Add box' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(bodies(page)).toHaveCount(1);
});

test('read-only host disables editing', async ({ page }) => {
  await page.goto('/?fixture=plate&readonly=1&kernel=missing');
  await expect(await tool(page, 'Add box')).toBeDisabled();
  await expect(await tool(page, 'Save view')).toBeDisabled();
  await expect(await tool(page, 'Move bodies')).toBeDisabled();
  await expect(page.getByText('Read only')).toBeVisible();
});

test('history shortcuts belong to the Surface last used', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop layout');
  await page.goto('/?fixture=plate&kernel=missing&pair=1');
  const [first, second] = [page.getByTestId('surface-0'), page.getByTestId('surface-1')];
  const plate = (surface: typeof first) =>
    surface.getByRole('list', { name: 'Bodies' }).getByRole('button', { name: /plate/ });
  await plate(first).click();
  await plate(second).click();
  await expect(plate(first)).toHaveAttribute('aria-pressed', 'true');
  // Focus falls back to <body>: Escape goes to the Surface used last, not the first mounted.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(plate(second)).toHaveAttribute('aria-pressed', 'false');
  await expect(plate(first)).toHaveAttribute('aria-pressed', 'true');
});

test('measuring waits while an edit evaluates (N08)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop layout');
  await page.goto('/?fixture=plate');
  await ready(page);
  const measure = page.getByRole('button', { name: 'Measure distance', exact: true });
  await expect(measure).toBeEnabled();
  // Stall the kernel so the edit stays pending: the view may show an uncommitted placement.
  await page.evaluate(() => {
    const { port } = (window as unknown as { cad: { port: { evaluate: unknown } } }).cad;
    port.evaluate = () => new Promise(() => {});
  });
  await page
    .getByRole('list', { name: 'Parameters' })
    .getByRole('button', { name: /Width/ })
    .click();
  const value = inspector(page).getByLabel('Value (mm)');
  await value.fill('100');
  await value.press('Enter');
  await expect(measure).toBeDisabled();
});

test('Inspector fields wait while an edit evaluates', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop layout');
  await page.goto('/?fixture=plate&kernel=missing');
  await expect(state(page)).toHaveText('Shape could not be calculated');
  // Stall the kernel so the edit stays pending.
  await page.evaluate(() => {
    const { port } = (window as unknown as { cad: { port: { evaluate: unknown } } }).cad;
    port.evaluate = () => new Promise(() => {});
  });
  await page
    .getByRole('list', { name: 'Parameters' })
    .getByRole('button', { name: /Width/ })
    .click();
  const value = inspector(page).getByLabel('Value (mm)');
  await value.fill('100');
  await value.press('Enter');
  await expect(state(page)).toHaveText('Calculating…');
  await expect(value).toBeDisabled();
  await expect(inspector(page).getByLabel('Name')).toBeDisabled();
});

test.describe('Sketch mode (R1d-3, CAD34)', () => {
  /** Screen coordinates of sketch point (u, v) on the sketch canvas. */
  const at = (page: Page, u: number, v: number) =>
    page.locator('.cad-sketch-canvas').evaluate(
      (svg, [u, v]) => {
        const p = new DOMPoint(u, -v).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
        return { x: p.x, y: p.y };
      },
      [u, v] as const,
    );
  const click = async (page: Page, u: number, v: number, shift = false) => {
    const p = await at(page, u, v);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(p.x, p.y);
    if (shift) await page.keyboard.up('Shift');
  };
  const dof = (page: Page) => page.getByTestId('cad-sketch-dof');
  const constrain = (page: Page, name: string) =>
    page.getByRole('group', { name: 'Add constraint' }).getByRole('button', { name, exact: true });
  /** A 40×20 rectangle from the origin, drawn as one stroke closed on its first point. */
  async function rectangle(page: Page) {
    for (const [u, v] of [
      [0, 0],
      [40, 0],
      [40, 20],
      [0, 20],
      [0, 0],
    ])
      await click(page, u!, v!);
    await expect(dof(page)).toHaveText('8 degrees of freedom');
  }
  /** Constrains the rectangle fully from the panel: dof 0. */
  async function constrainAll(page: Page) {
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    for (const [u, v, rule] of [
      [20, 0, 'Horizontal'],
      [20, 20, 'Horizontal'],
      [40, 10, 'Vertical'],
      [0, 10, 'Vertical'],
      [0, 0, 'Fix'],
    ] as const) {
      await click(page, u, v);
      await constrain(page, rule).click();
    }
    await click(page, 20, 0);
    await constrain(page, 'Horizontal distance').click();
    await click(page, 40, 10);
    await constrain(page, 'Vertical distance').click();
    await expect(dof(page)).toHaveText('Fully constrained');
  }

  test('draws, constrains, refuses a redundant constraint, edits a dimension and finishes and extrudes as one edit', async ({
    page,
  }) => {
    test.skip(!kernel, 'CAD_OCCT_DIST is not set');
    test.skip(narrow(), 'sketching is desktop only');
    await page.goto('/');
    const before = await cadSnapshot(page);
    const elements = await panel(page, 'Elements');
    await elements.getByRole('button', { name: 'Sketch on XY' }).click();
    await expect(page.getByTestId('cad-sketch')).toBeVisible();
    await expect(page.getByRole('application', { name: 'Drawing of Sketch 1' })).toBeFocused();
    await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
    await rectangle(page);
    await expect(page.getByTestId('cad-sketch-region')).toHaveText(
      'Closed region: 4 edges, 0 holes',
    );
    await constrainAll(page);
    // Nothing is an edit while drawing; history shortcuts do nothing.
    await page.keyboard.press('Control+z');
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
    // Already fixed by the others: refused, named and highlighted, the drawing unchanged.
    await click(page, 40, 0);
    await click(page, 40, 20, true);
    await constrain(page, 'Vertical distance').click();
    await expect(page.getByTestId('cad-sketch-problem')).toContainText('重複');
    await expect(page.locator('.cad-sketch-canvas .is-problem')).not.toHaveCount(0);
    // A dimension takes an expression.
    const width = page.getByTestId('cad-sketch-panel').getByLabel('Horizontal distance (mm)');
    await width.fill('2 * 25mm');
    await width.press('Enter');
    await expect(page.getByTestId('cad-sketch-problem')).toHaveCount(0);
    await expect(dof(page)).toHaveText('Fully constrained');
    await page.screenshot({ path: test.info().outputPath('sketch-mode.png') });
    await page.getByLabel('Extrude distance (mm)').fill('10');
    await page.getByRole('button', { name: 'Finish and extrude' }).click();
    await ready(page);
    await expect(page.getByTestId('cad-sketch')).toHaveCount(0);
    const after = await cadSnapshot(page);
    expect(after.content.sketches).toHaveLength(1);
    const body = after.content.bodies.find((b) => b.state === 'active')!;
    expect(after.evaluation?.status === 'ok' && vol(after.evaluation.bodies[body.id])).toBeCloseTo(
      50 * 20 * 10,
      3,
    );
    await expect(elements.getByRole('list', { name: 'Sketches' })).toContainText('Sketch 1');
    // One Undo takes back the sketch, the extrude and the body.
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });

  test('draws an open spline with Enter and a closed one on its first point, and extrudes the closed one (R2a-2, CAD40)', async ({
    page,
  }) => {
    test.skip(!kernel, 'CAD_OCCT_DIST is not set');
    test.skip(narrow(), 'sketching is desktop only');
    await page.goto('/');
    const before = await cadSnapshot(page);
    const elements = await panel(page, 'Elements');
    await elements.getByRole('button', { name: 'Sketch on XY' }).click();
    await page.getByRole('button', { name: 'Draw spline', exact: true }).click();
    // Four control points and Enter: an open spline, no region.
    for (const [u, v] of [
      [-90, -60],
      [-70, -40],
      [-50, -60],
      [-30, -40],
    ])
      await click(page, u!, v!);
    await page.keyboard.press('Enter');
    await expect(page.locator('.cad-sketch-canvas path[data-id="sp1"]')).toHaveCount(1);
    await expect(dof(page)).toHaveText('8 degrees of freedom');
    // Four more and a click on the first: a closed spline, a region alone.
    const square = [
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
    ] as const;
    for (const [u, v] of square) await click(page, u, v);
    await click(page, 0, 0);
    await expect(page.locator('.cad-sketch-canvas path[data-id="sp2"]')).toHaveCount(1);
    await expect(page.getByTestId('cad-sketch-region')).toHaveText(
      'Closed region: 1 edges, 0 holes',
    );
    await page.screenshot({ path: test.info().outputPath('sketch-spline.png') });
    await page.getByLabel('Extrude distance (mm)').fill('10');
    await page.getByRole('button', { name: 'Finish and extrude' }).click();
    await ready(page);
    const after = await cadSnapshot(page);
    const sketch = after.content.sketches[0]!;
    expect(sketch.entities.filter((e) => e.type === 'spline')).toHaveLength(2);
    // The curve's area by Green on a fine sampling (the kernel's volume is exact, src/metrics.ts).
    const pts = splinePoints(
      square.map(([u, v]) => [u, v] as [number, number]),
      3,
      true,
      4096,
    );
    const area = Math.abs(
      pts.slice(1).reduce((a, q, i) => a + pts[i]![0] * q[1] - q[0] * pts[i]![1], 0) / 2,
    );
    const body = after.content.bodies.find((b) => b.state === 'active')!;
    expect(
      after.evaluation?.status === 'ok' && vol(after.evaluation.bodies[body.id]) / (area * 10),
    ).toBeCloseTo(1, 6);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });

  test('draws a spline’s curvature comb in Sketch mode, scaled from the panel (R2a-4, CAD43)', async ({
    page,
  }) => {
    test.skip(narrow(), 'sketching is desktop only');
    await page.goto('/');
    const before = await cadSnapshot(page);
    const elements = await panel(page, 'Elements');
    await elements.getByRole('button', { name: 'Sketch on XY' }).click();
    await page.getByRole('button', { name: 'Draw spline', exact: true }).click();
    for (const [u, v] of [
      [-90, -60],
      [-70, -40],
      [-50, -60],
      [-30, -40],
    ])
      await click(page, u!, v!);
    await page.keyboard.press('Enter');
    const group = page.getByRole('group', { name: 'Curvature comb' });
    await group.getByLabel('Curvature comb').check();
    const comb = page.getByTestId('cad-sketch-comb-sp1');
    // One knot span (4 poles, degree 3): 16 samples and its end, a tooth each.
    const teeth = async () =>
      ((await comb.locator('path').getAttribute('d')) ?? '').split('M').length - 1;
    await expect.poll(teeth).toBe(17);
    const d = await comb.locator('path').getAttribute('d');
    await page.screenshot({ path: test.info().outputPath('sketch-comb.png') });
    await group.getByLabel('Scale').fill('1');
    await expect(group.locator('output')).toHaveText('×2');
    await expect.poll(() => comb.locator('path').getAttribute('d')).not.toBe(d);
    await group.getByLabel('Curvature comb').uncheck();
    await expect(comb).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(async () => (await cadSnapshot(page)).sketch).toBeUndefined();
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });

  test('Escape drops the stroke, then leaves without an edit and gives focus back', async ({
    page,
  }) => {
    test.skip(narrow(), 'sketching is desktop only');
    await page.goto('/?kernel=missing');
    const before = await cadSnapshot(page);
    const entry = (await panel(page, 'Elements')).getByRole('button', { name: 'Sketch on XZ' });
    await entry.click();
    await click(page, 0, 0);
    await click(page, 30, 10);
    await expect(dof(page)).toHaveText('4 degrees of freedom');
    // The stroke goes on from the line's end: the first Escape drops it, the second leaves.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('cad-sketch')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('cad-sketch')).toHaveCount(0);
    await expect(entry).toBeFocused();
    const after = await cadSnapshot(page);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.canUndo).toBe(false);
  });

  test('edits an existing sketch: a dimension, Finish as one edit', async ({ page }) => {
    test.skip(!kernel, 'CAD_OCCT_DIST is not set');
    test.skip(narrow(), 'sketching is desktop only');
    await page.goto('/?fixture=bracket');
    await ready(page);
    const before = await cadSnapshot(page);
    const volume = (s: typeof before) =>
      s.evaluation?.status === 'ok' ? vol(s.evaluation.bodies.bracket) : NaN;
    await (await panel(page, 'Elements'))
      .getByRole('button', { name: 'Edit sketch Bracket' })
      .click();
    await expect(dof(page)).toHaveText('Fully constrained');
    const radius = page.getByTestId('cad-constraint-blend-r').getByLabel('Radius (mm)');
    // A field that does not read is never dropped by Finish: the sketch stays open with it.
    await radius.fill('15 apples');
    await radius.press('Enter');
    await expect(page.getByTestId('cad-constraint-blend-r').getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(page.getByTestId('cad-sketch-field-error')).toBeVisible();
    await expect(page.getByTestId('cad-sketch-panel')).toBeVisible();
    await expect(radius).toHaveValue('15 apples');
    await radius.fill('15');
    await radius.press('Enter');
    await expect(dof(page)).toHaveText('Fully constrained');
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await ready(page);
    const after = await cadSnapshot(page);
    // A larger inner blend adds material: (1 − π/4)(15² − 10²) mm² over 10 mm.
    expect(volume(after) - volume(before)).toBeCloseTo((1 - Math.PI / 4) * (225 - 100) * 10, 3);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });

  test('a narrow window shows the entries off with the reason', async ({ page }) => {
    test.skip(!narrow(), 'narrow layout');
    await page.goto('/?fixture=bracket&kernel=missing');
    const elements = await panel(page, 'Elements');
    for (const name of ['Sketch on XY', 'Sketch on XZ', 'Sketch on YZ', 'Edit sketch Bracket'])
      await expect(elements.getByRole('button', { name })).toBeDisabled();
    await expect(elements.getByTestId('cad-sketch-narrow')).toContainText('wider window');
    await page.screenshot({ path: test.info().outputPath('sketch-narrow.png') });
  });

  test('an Inspector field that does not read keeps Sketch mode closed', async ({ page }) => {
    test.skip(!kernel, 'CAD_OCCT_DIST is not set');
    test.skip(narrow(), 'sketching is desktop only');
    await page.goto('/?fixture=plate');
    await ready(page);
    await page
      .getByRole('list', { name: 'Parameters' })
      .getByRole('button', { name: /Width/ })
      .click();
    const value = inspector(page).getByLabel('Value (mm)');
    await value.fill('80 apples');
    await value.press('Enter');
    await (await panel(page, 'Elements')).getByRole('button', { name: 'Sketch on XY' }).click();
    await expect(page.getByTestId('cad-sketch-panel')).toHaveCount(0);
    await expect(value).toHaveValue('80 apples');
  });

  test('read-only offers no entry and refuses one from the API', async ({ page }) => {
    await page.goto('/?fixture=bracket&readonly=1&kernel=missing');
    const elements = await panel(page, 'Elements');
    await expect(elements.getByRole('list', { name: 'Sketches' })).toContainText('Bracket');
    await expect(elements.getByRole('button', { name: /^(Sketch on|Edit sketch)/ })).toHaveCount(0);
    const refused = await page.evaluate(() => {
      const { controller } = (window as unknown as { cad: { controller: CadController } }).cad;
      return [controller.startSketch('xy'), controller.editSketch('bracket-sketch')];
    });
    expect(refused).toEqual([undefined, undefined]);
    expect((await cadSnapshot(page)).sketch).toBeUndefined();
  });
});

test.describe('loft and sweep (R1e, CAD35)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('lofts a sketch to a section derived from it and edits its scale in the Inspector (K6, CM-7a)', async ({
    page,
  }) => {
    await page.goto('/?fixture=sections');
    const before = await cadSnapshot(page);
    const volume = async () => {
      const s = await cadSnapshot(page);
      const body = s.content.bodies.find((b) => b.name === 'Loft' && b.state === 'active');
      return body && s.evaluation?.status === 'ok' ? vol(s.evaluation.bodies[body.id]) : NaN;
    };
    await (await panel(page, 'Elements')).getByRole('button', { name: 'Loft…' }).click();
    const loft = page.getByRole('dialog', { name: 'Loft' });
    await loft.getByLabel('loft-base').check();
    await expect(loft.getByRole('button', { name: 'Create loft' })).toBeDisabled();
    await loft.getByRole('button', { name: 'Add derived section' }).click();
    const derived = loft.getByRole('list', { name: 'Derived sections' });
    await derived.getByLabel('Offset (mm)').fill('50');
    await derived.getByLabel('Scale').fill('0.5');
    await loft.getByLabel(/^Ruled/).check();
    await loft.getByRole('button', { name: 'Create loft' }).click();
    await ready(page);
    await expect(loft).toHaveCount(0);
    // The 40 mm square to its 20 mm copy 50 mm up: a frustum.
    expect(await volume()).toBeCloseTo((50 / 3) * (1600 + 400 + 800), 1);
    const inspect = await panel(page, 'Inspector');
    await expect(inspect.getByTestId('cad-loft-sections')).toHaveText('loft-base → derived from 1');
    const scale = inspect.getByRole('group', { name: 'Section 2' }).getByLabel('Scale');
    await scale.fill('1');
    await scale.press('Enter');
    await ready(page);
    // At full size the loft is the square's prism.
    await expect.poll(volume).toBeCloseTo(1600 * 50, 1);
    await page.screenshot({ path: test.info().outputPath('loft-derived.png') });
    await (await tool(page, 'Undo')).click();
    await ready(page);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });

  test('lofts two sketches and sweeps a circle along a path from the Sketches section, each one edit', async ({
    page,
  }) => {
    await page.goto('/?fixture=sections');
    const before = await cadSnapshot(page);
    const volume = (s: typeof before, name: string) => {
      const body = s.content.bodies.find((b) => b.name === name && b.state === 'active');
      return body && s.evaluation?.status === 'ok' ? vol(s.evaluation.bodies[body.id]) : NaN;
    };
    const elements = await panel(page, 'Elements');
    await elements.getByRole('button', { name: 'Loft…' }).click();
    const loft = page.getByRole('dialog', { name: 'Loft' });
    await loft.getByLabel('loft-base').check();
    await loft.getByLabel('loft-top').check();
    await expect(loft).toContainText('section 2');
    await loft.getByRole('button', { name: 'Create loft' }).click();
    await ready(page);
    await expect(loft).toHaveCount(0);
    const lofted = await cadSnapshot(page);
    // Between the circle's and the square's prisms, 50 mm high.
    expect(volume(lofted, 'Loft')).toBeGreaterThan(Math.PI * 225 * 50);
    expect(volume(lofted, 'Loft')).toBeLessThan(1600 * 50);
    await expect((await panel(page, 'Inspector')).getByTestId('cad-loft-sections')).toHaveText(
      'loft-base → loft-top',
    );
    const again = await panel(page, 'Elements');
    await again.getByRole('button', { name: 'Sweep…' }).click();
    const sweep = page.getByRole('dialog', { name: 'Sweep' });
    await sweep
      .getByRole('combobox', { name: 'Profile', exact: true })
      .selectOption({ label: 'Profile' });
    await sweep
      .getByRole('combobox', { name: 'Path', exact: true })
      .selectOption({ label: 'Path' });
    await sweep.getByRole('button', { name: 'Create sweep' }).click();
    await ready(page);
    const swept = await cadSnapshot(page);
    expect(volume(swept, 'Sweep')).toBeCloseTo(25 * Math.PI * (50 + 15 * Math.PI), 2);
    await page.screenshot({ path: test.info().outputPath('loft-sweep.png') });
    // Each was one edit.
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(lofted.contentHash);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });
});

test.describe('joints (R2b-2, CAD47)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');
  const pose = async (page: Page, id: string) =>
    (await cadSnapshot(page)).content.solvedPoses[id]!.translationMm.map((v) => +v.toFixed(6));
  // On the narrow layout the Assembly section is in the Elements panel, closed at first.
  const joints = async (page: Page) =>
    (await panel(page, 'Elements')).getByRole('list', { name: 'Joints' }).getByRole('button');

  test('a joint value moves its subtree in one edit, Undo returns it, a limit refuses', async ({
    page,
  }) => {
    await page.goto('/?fixture=r2b-joints');
    await ready(page);
    await expect(await joints(page)).toHaveCount(5);
    // Every joint solves on the real kernel to the stored poses: nothing is flagged.
    await expect(page.getByTestId('cad-pose-mismatch')).toHaveCount(0);
    await expect(page.locator('.cad-joints .cad-part-state')).toHaveCount(0);
    await (await joints(page)).filter({ hasText: 'j-slide' }).click();
    const distance = page.getByRole('textbox', { name: 'Distance (mm)' });
    await expect(distance).toHaveValue('12');
    await distance.fill('15');
    await page.getByRole('button', { name: 'Apply values' }).click();
    await ready(page);
    await expect.poll(() => pose(page, 'c-plate-2')).toEqual([40, 25, 20]);
    // The plate fastened to it follows in the same edit.
    expect(await pose(page, 'c-plate-3')).toEqual([40, 25, 25]);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect(await pose(page, 'c-plate-2')).toEqual([40, 25, 17]);
    expect(await pose(page, 'c-plate-3')).toEqual([40, 25, 22]);
    await expect(distance).toHaveValue('12');
    // Past its limit (0–20 mm) the value is refused and nothing moves.
    await distance.fill('25');
    await page.getByRole('button', { name: 'Apply values' }).click();
    await expect(page.getByRole('alert').first()).toContainText('範囲の外');
    expect(await pose(page, 'c-plate-2')).toEqual([40, 25, 17]);
  });

  test('a joint on this document body follows a change of its height (CAD47)', async ({ page }) => {
    await page.goto('/?fixture=r2b-joints');
    await ready(page);
    const applied = await page.evaluate(() =>
      (window as unknown as { cad: { controller: CadController } }).cad.controller.run({
        type: 'setParameter',
        parameterId: 'T',
        value: 8,
      }),
    );
    expect(applied).toBe(true);
    await ready(page);
    // The shaft stands on the plate's top face, and everything above it moves up with it.
    expect(await pose(page, 'c-shaft')).toEqual([40, 25, 8]);
    expect(await pose(page, 'c-plate-3')).toEqual([40, 25, 25]);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect(await pose(page, 'c-shaft')).toEqual([40, 25, 5]);
  });

  test('stored poses that do not match their joints hold edits until solved again (R2b-U5)', async ({
    page,
  }) => {
    await page.goto('/?fixture=r2b-joints&tamper=1');
    await ready(page);
    await panel(page, 'Elements');
    const alert = page.getByTestId('cad-pose-mismatch');
    await expect(alert).toContainText('j-turn');
    expect(await pose(page, 'c-shaft')).toEqual([40, 25, 6]);
    // A reference display is not exported, a PNG neither.
    const png = page.getByRole('button', { name: 'Export PNG', exact: true });
    if (!narrow()) await expect(png).toBeDisabled();
    await (await joints(page)).filter({ hasText: 'j-slide' }).click();
    await page.getByRole('textbox', { name: 'Distance (mm)' }).fill('15');
    await page.getByRole('button', { name: 'Apply values' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '一致しません' }).first()).toBeVisible();
    expect(await pose(page, 'c-plate-2')).toEqual([40, 25, 17]);
    await alert.getByRole('button', { name: 'Solve poses again' }).click();
    await ready(page);
    await expect(alert).toHaveCount(0);
    expect(await pose(page, 'c-shaft')).toEqual([40, 25, 5]);
    if (!narrow()) await expect(png).toBeEnabled();
    expect(await pose(page, 'c-plate-2')).toEqual([40, 25, 17]);
    // One edit: Undo brings the mismatch back.
    await (await tool(page, 'Undo')).click();
    await ready(page);
    await expect(alert).toBeVisible();
  });
});

test.describe('joint authoring (R2b-2c, CAD47)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');
  type Window = {
    cad: {
      controller: CadController;
      assembly: { getSnapshot(): { creating?: { preview?: { content: CadDocument } } } };
    };
  };
  const pose = async (page: Page, id: string) =>
    (await cadSnapshot(page)).content.solvedPoses[id]!.translationMm.map((v) => +v.toFixed(6));
  const previewPose = (page: Page, id: string) =>
    page.evaluate(
      (id) =>
        (window as unknown as Window).cad.assembly
          .getSnapshot()
          .creating?.preview?.content.solvedPoses[id]?.translationMm.map((v) => +v.toFixed(6)),
      id,
    );
  /** The canvas point of a world point (x, y) in the fixture's plan view (160 mm high, at 70, 25). */
  const screen = async (page: Page) => {
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    const scale = box.height / 160;
    return (x: number, y: number) =>
      [
        box.x + box.width / 2 + (x - 70) * scale,
        box.y + box.height / 2 - (y - 25) * scale,
      ] as const;
  };

  test('picks a vertex or a face and an origin, previews each type, and applies one edit', async ({
    page,
  }) => {
    test.skip(narrow(), 'desktop flow');
    await page.goto('/?fixture=r2b-authoring&view=plan');
    await ready(page);
    const before = await cadSnapshot(page);
    const at = await screen(page);
    const elements = await panel(page, 'Elements');
    await elements.getByRole('button', { name: 'Add joint…' }).click();
    const card = page.getByTestId('cad-joint-create');
    await expect(card).toContainText('親の接続点');
    // The plate's corner on top: a vertex, named by its three faces.
    await page.mouse.click(...at(80, 50));
    await expect(card).toContainText('This document · Vertex');
    await card.getByRole('button', { name: 'Use origin' }).click();
    await expect(card).toContainText('c-shaft · Origin');
    const preview = page.getByTestId('cad-joint-preview');
    await expect(preview).toHaveAttribute('data-status', 'ready');
    // The shaft stands at the corner; nothing is stored yet.
    expect(await previewPose(page, 'c-shaft')).toEqual([80, 50, 5]);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
    // The previewed poses are not content: PNG export waits for Apply or Cancel.
    await (await tool(page, 'Export PNG')).click();
    await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText(
      'jointを作っている途中',
    );
    // The parent again: the top face, its centroid over the hole's centre.
    await card.getByRole('button', { name: 'Pick again' }).first().click();
    await page.mouse.click(...at(15, 10));
    await expect(card).toContainText('This document · Face end');
    await card.getByRole('button', { name: 'Use origin' }).click();
    await expect(preview).toHaveAttribute('data-status', 'ready');
    expect(await previewPose(page, 'c-shaft')).toEqual([40, 25, 5]);
    // Each type is previewed again; flipped, the shaft hangs below the face.
    await card.getByLabel('Joint type').selectOption('slider');
    await expect(preview).toHaveAttribute('data-status', 'ready');
    await card.getByLabel('Flip child (face to face)').check();
    await expect(preview).toHaveAttribute('data-status', 'ready');
    await expect.poll(() => previewPose(page, 'c-shaft')).toEqual([40, 25, 5]);
    await card.getByLabel('Flip child (face to face)').uncheck();
    await card.getByLabel('Joint type').selectOption('revolute');
    await expect(preview).toHaveAttribute('data-status', 'ready');
    await page.screenshot({ path: test.info().outputPath('joint-preview.png') });
    await card.getByRole('button', { name: 'Apply joint' }).click();
    await ready(page);
    const after = await cadSnapshot(page);
    expect(after.content.joints).toEqual([
      expect.objectContaining({
        name: 'Joint 1',
        type: 'revolute',
        parent: expect.objectContaining({
          componentPath: [],
          ref: expect.objectContaining({ kind: 'face', name: [['end']] }),
        }),
        child: expect.objectContaining({ componentId: 'c-shaft' }),
        values: { angle: { literalRad: 0 } },
      }),
    ]);
    expect(await pose(page, 'c-shaft')).toEqual([40, 25, 5]);
    // The new joint is selected; one Undo takes it back.
    await expect(page.getByTestId('cad-joint')).toContainText('Joint 1');
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });

  test('drags a revolute joint about its axis with a preview only, one edit on release', async ({
    page,
  }) => {
    test.skip(narrow(), 'mouse drag');
    await page.goto('/?fixture=r2b-authoring&view=plan');
    await ready(page);
    const at = await screen(page);
    const elements = await panel(page, 'Elements');
    await elements.getByRole('button', { name: 'Add joint…' }).click();
    const card = page.getByTestId('cad-joint-create');
    await page.mouse.click(...at(15, 10));
    await card.getByRole('button', { name: 'Use origin' }).click();
    await expect(page.getByTestId('cad-joint-preview')).toHaveAttribute('data-status', 'ready');
    await card.getByRole('button', { name: 'Apply joint' }).click();
    await ready(page);
    const placed = await cadSnapshot(page);
    // Grab the ring on +x and turn it a quarter about the face's z.
    await page.mouse.move(...at(52.5, 25));
    await page.mouse.down();
    await page.mouse.move(...at(50, 33), { steps: 5 });
    await page.mouse.move(...at(40, 37.5), { steps: 5 });
    // The field follows the drag; nothing is stored until release.
    await expect(page.getByRole('textbox', { name: 'Angle (°)' })).toHaveValue('90');
    expect((await cadSnapshot(page)).contentHash).toBe(placed.contentHash);
    await page.mouse.up();
    await ready(page);
    const turned = await cadSnapshot(page);
    expect(turned.content.joints[0]!.values).toEqual({ angle: { literalRad: Math.PI / 2 } });
    expect(await pose(page, 'c-shaft')).toEqual([40, 25, 5]);
    const q = turned.content.solvedPoses['c-shaft']!.rotation.map((v) => +v.toFixed(9) + 0);
    expect(q).toEqual([0, 0, +Math.SQRT1_2.toFixed(9), +Math.SQRT1_2.toFixed(9)]);
    // One edit: Undo returns the angle.
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).content.joints[0]!.values).toEqual({
      angle: { literalRad: 0 },
    });
    // Escape cancels a drag: the value and the content stay.
    await page.mouse.move(...at(52.5, 25));
    await page.mouse.down();
    await page.mouse.move(...at(40, 37.5), { steps: 5 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.getByRole('textbox', { name: 'Angle (°)' })).toHaveValue('0');
    expect((await cadSnapshot(page)).contentHash).toBe(placed.contentHash);
  });

  test('narrow and read only: no joint is made', async ({ page }) => {
    await page.goto(`/?fixture=r2b-authoring${narrow() ? '' : '&readonly=1'}`);
    await ready(page);
    const elements = await panel(page, 'Elements');
    if (narrow()) {
      await expect(elements.getByRole('button', { name: 'Add joint…' })).toBeDisabled();
      await expect(elements).toContainText('Making joints needs a wider window');
    } else await expect(elements.getByRole('button', { name: 'Add joint…' })).toHaveCount(0);
  });
});

test.describe('bill of materials (R2b-3, CAD49)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');
  const rows = (page: Page) =>
    page
      .getByRole('table', { name: 'Bill of materials' })
      .locator('tbody tr')
      .evaluateAll((trs) =>
        trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '')),
      );

  test('shows the flat and hierarchical tables, exports CSV and counts the jig as one edit', async ({
    page,
  }) => {
    await page.goto('/?fixture=r2b-bom');
    await ready(page);
    const before = await cadSnapshot(page);
    const elements = await panel(page, 'Elements');
    await elements.getByRole('button', { name: 'Bill of materials…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Bill of materials' });
    // Flat: each version once; the wheels' hub and bolts counted four times, the jig left out,
    // the ring's 8 and the row's 6 bolts with their seeds.
    expect((await rows(page)).map((r) => [r[0], r[2], r[4]])).toEqual([
      ['1', 'plate (this document)', '1'],
      ['2', 'Plate', '5'],
      ['3', 'Plate', '1'],
      ['4', 'Bolt "M8", long', '24'],
    ]);
    await dialog.getByLabel('Hierarchical').check();
    expect((await rows(page)).map((r) => [r[0], r[1], r[4]])).toEqual([
      ['1', '', '1'],
      ['2', 'PL-100', '1'],
      ['3', 'PL-100', '1'],
      ['4', 'W-1', '4'],
      ['4.1', 'PL-100', '1'],
      ['4.2', '=B-M8', '2'],
      ['5', '=B-M8', '16'],
    ]);
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('cad-bom-hierarchical.csv');
    const csv = await readFile((await file.path())!, 'utf8');
    expect(csv.split('\r\n')[0]).toBe(
      'Item,Part number,Name,Description,Quantity,Artifact,Version',
    );
    expect(csv).toContain(`4.2,'=B-M8,"Bolt ""M8"", long",'-M8 x 40,2,bolt,v1\r\n`);
    // Exporting changes nothing.
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
    await dialog.getByRole('button', { name: 'Close' }).click();
    // The jig counts again once it is included: one edit, one Undo.
    await elements
      .getByRole('list', { name: 'Components' })
      .getByRole('button', { name: 'c-jig' })
      .click();
    const count = elements.getByLabel('Count in BOM');
    await expect(count).not.toBeChecked();
    // The box follows the content: it is checked once the edit applies.
    await count.click();
    await expect(count).toBeChecked();
    await ready(page);
    expect((await cadSnapshot(page)).content.components.find((c) => c.id === 'c-jig')?.bom).toBe(
      'include',
    );
    await elements.getByRole('button', { name: 'Bill of materials…' }).click();
    expect((await rows(page))[1]![4]).toBe('6');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });

  test('sets this document’s part number and description, and shows the BOM read only', async ({
    page,
  }) => {
    await page.goto(`/?fixture=r2b-bom${narrow() ? '' : '&readonly=1'}`);
    await ready(page);
    const elements = await panel(page, 'Elements');
    if (narrow()) {
      await elements.getByText('Part properties', { exact: true }).click();
      const number = elements.getByRole('textbox', { name: 'Part number' });
      await expect(number).toHaveValue('CART-1');
      await number.fill('CART-2');
      await number.press('Enter');
      await ready(page);
      expect((await cadSnapshot(page)).content.partProperties).toEqual({
        partNumber: 'CART-2',
        description: 'Cart',
      });
    } else {
      // Read only: the BOM still shows; nothing in it can change.
      await elements.getByRole('button', { name: 'Bill of materials…' }).click();
      expect(await rows(page)).toHaveLength(4);
      await page
        .getByRole('dialog', { name: 'Bill of materials' })
        .getByRole('button', { name: 'Close' })
        .click();
      await elements
        .getByRole('list', { name: 'Components' })
        .getByRole('button', { name: 'c-jig' })
        .click();
      await expect(elements.getByLabel('Count in BOM')).toBeDisabled();
      await elements.getByText('Part properties', { exact: true }).click();
      await expect(elements.getByRole('textbox', { name: 'Part number' })).toBeDisabled();
    }
  });
});

test.describe('STEP AP242 export of an assembly (R2b-5, CAD52)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('writes F22 as products and instances once every part is evaluated', async ({ page }) => {
    test.skip(narrow(), 'one export of F22 is enough');
    test.setTimeout(240_000);
    await page.goto('/?fixture=r2b-bom');
    await ready(page);
    await expect(page.getByTestId('cad-parts-progress')).toBeHidden({ timeout: 180_000 });
    const before = await cadSnapshot(page);
    await (await tool(page, 'Export STEP, STL or GLB')).click();
    const dialog = page.getByRole('dialog', { name: 'Export 3D file' });
    // An assembly is STEP only.
    await expect(dialog.getByRole('radio', { name: /^STL/ })).toBeDisabled();
    await expect(dialog.getByRole('radio', { name: /^GLB/ })).toBeDisabled();
    await expect(dialog.getByRole('radio', { name: /^STEP \(AP242 assembly/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'Prepare file' }).click();
    const report = dialog.getByLabel('Export report');
    await expect(report).toBeVisible({ timeout: 120_000 });
    // The root's plate, two plates, the bolt, the wheel and the root; the wheel's 3 and the
    // root's 24 instances.
    await expect(report.locator('dt:has-text("Products") + dd')).toHaveText('6');
    await expect(report.locator('dt:has-text("Instances") + dd')).toHaveText('27');
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save STEP' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.step$/);
    const text = await readFile((await file.path())!, 'latin1');
    expect(text).toMatch(/^ISO-10303-21;/);
    expect(text).toMatch(/FILE_SCHEMA\(\(\s*'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/);
    expect(text.match(/=\s*PRODUCT\(/g)).toHaveLength(6);
    expect(text).toContain("PRODUCT('W-1','Wheel'");
    expect(text).toContain("PRODUCT('=B-M8','Bolt \"M8\", long'");
    expect(text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g)).toHaveLength(27);
    // Exporting changes nothing.
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });
});

test.describe('parts evaluated after the result (R2b-4, CAD50)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('shows F23 as boxes at once, edits while its parts evaluate, then holds no measurement', async ({
    page,
  }) => {
    test.skip(narrow(), 'one run of F23 is enough');
    test.setTimeout(600_000);
    await page.goto('/?fixture=r2b-scale');
    await ready(page);
    const progress = page.getByTestId('cad-parts-progress');
    // 300 brackets, 30 modules and 5 bays, each evaluated once after the result.
    await expect(progress).toHaveText(/^部品 \d+ \/ 335 を計算中$/);
    const measure = page.getByRole('button', { name: 'Measure distance', exact: true });
    await expect(measure).toBeDisabled();
    const elements = await panel(page, 'Elements');
    const components = elements.getByRole('list', { name: 'Components' });
    await expect(components.getByRole('listitem')).toHaveCount(410);
    // A placement edit applies while the parts still evaluate: it waits for none of them.
    await components.getByRole('button', { name: /^c-bracket-399/ }).click();
    const placement = elements.getByRole('form', { name: 'Placement' });
    await placement.getByLabel('Z (mm)').fill('50');
    await placement.getByRole('button', { name: 'Apply placement' }).click();
    await ready(page);
    await expect(progress).toBeVisible();
    const moved = (await cadSnapshot(page)).content.solvedPoses['c-bracket-399']!;
    expect(moved.translationMm[2]).toBe(50);
    await expect(progress).toBeHidden({ timeout: 540_000 });
    await expect(components.locator('[data-state="pending"]')).toHaveCount(0);
    await expect(measure).toBeEnabled();
  });
});

test.describe('levels of detail and the part mesh budget (R2b-4, CAD50)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('draws small parts coarse or as boxes, finer when zoomed in, and simplifies within the budget', async ({
    page,
  }) => {
    test.skip(narrow(), 'one run of F23 is enough');
    test.setTimeout(600_000);
    // A 3 MB budget for part meshes: F23's standard meshes do not all fit.
    await page.goto('/?fixture=r2b-scale&mainBytes=3000000');
    await ready(page);
    const before = await cadSnapshot(page);
    await expect(page.getByTestId('cad-parts-progress')).toBeHidden({ timeout: 540_000 });
    const levels = async () => {
      const text = (await page.locator('.cad-canvas').getAttribute('data-part-levels')) ?? '';
      const [, standard, , coarse, , box] = text.split(' ').map(Number);
      return { standard: standard!, coarse: coarse!, box: box! };
    };
    const assembly = () =>
      page.evaluate(() => {
        const a = (
          window as unknown as {
            cad: {
              assembly: {
                getSnapshot(): { simplified: ReadonlySet<string> };
                meshes(h: string): unknown;
                coarseMeshes(h: string): unknown;
              };
            };
          }
        ).cad.assembly;
        const simplified = [...a.getSnapshot().simplified];
        return {
          simplified: simplified.length,
          coarse: simplified.filter((h) => a.coarseMeshes(h)).length,
          standard: simplified.filter((h) => a.meshes(h)).length,
        };
      });
    // Fitted to the whole assembly, a bracket is small on screen: none is drawn standard.
    const far = await levels();
    expect(far.coarse + far.box).toBeGreaterThan(0);
    // The budget kept some versions whole and simplified others, with their coarse meshes kept.
    const kept = await assembly();
    expect(kept.simplified).toBeGreaterThan(0);
    expect(kept.coarse).toBeGreaterThan(0);
    expect(kept.standard).toBe(0);
    const elements = await panel(page, 'Elements');
    await expect(
      elements
        .getByRole('list', { name: 'Components' })
        .locator('[data-state="simplified"]')
        .first(),
    ).toHaveText('簡略表示');
    // Zoomed in, the parts near the centre grow on screen and are drawn finer.
    const canvas = page.locator('.cad-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400);
    await expect.poll(async () => (await levels()).standard).toBeGreaterThan(far.standard);
    // A smaller viewport makes them smaller on screen without a camera move.
    const near = (await levels()).standard;
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: Math.round(size.height / 2.5) });
    await expect.poll(async () => (await levels()).standard).toBeLessThan(near);
    await page.setViewportSize(size);
    // The levels and the budget are display only: the content and its result do not change.
    const after = await cadSnapshot(page);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.canUndo).toBe(false);
  });
});

test.describe('component patterns (R2b-3, CAD49)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('lists a pattern as one row, edits its count as one edit and counts it in the BOM', async ({
    page,
  }) => {
    await page.goto('/?fixture=r2b-bom');
    await ready(page);
    const before = await cadSnapshot(page);
    const elements = await panel(page, 'Elements');
    const components = elements.getByRole('list', { name: 'Components' });
    // Each pattern is one row under its seed; its copies are not listed.
    await expect(
      components.getByRole('list', { name: 'Patterns of c-bolt-ring' }).getByRole('button'),
    ).toHaveText(['Bolt ring ×8']);
    await expect(components.getByRole('button', { name: 'Bolt row ×6' })).toBeVisible();
    await expect(components.getByRole('button', { name: /copy:/ })).toHaveCount(0);
    await components.getByRole('button', { name: 'Bolt ring ×8' }).click();
    const inspector = elements.getByTestId('cad-pattern');
    await expect(inspector).toContainText('8 × c-bolt-ring · circle about Z');
    const count = inspector.getByRole('textbox', { name: 'Count' });
    await count.fill('10');
    await count.press('Enter');
    await ready(page);
    await expect(components.getByRole('button', { name: 'Bolt ring ×10' })).toBeVisible();
    const layout = (await cadSnapshot(page)).content.componentPatterns[0]!.layout;
    expect(layout.count).toEqual({ literal: 10 });
    await elements.getByRole('button', { name: 'Bill of materials…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Bill of materials' });
    await expect(dialog.getByRole('table').locator('tbody tr').nth(3)).toContainText('26');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });

  test('makes copies of a component, picks a copy back to its pattern and removes it', async ({
    page,
  }) => {
    test.skip(narrow(), 'the pick needs the desktop plan view');
    await page.goto('/?fixture=r2b-authoring&view=plan');
    await ready(page);
    const before = await cadSnapshot(page);
    const elements = await panel(page, 'Elements');
    const components = elements.getByRole('list', { name: 'Components' });
    await components.getByRole('button', { name: 'c-shaft', exact: true }).click();
    await elements.getByRole('button', { name: 'Pattern…' }).click();
    const dialog = page.getByTestId('cad-pattern-dialog');
    await dialog.getByLabel('Layout').selectOption('y');
    await dialog.getByLabel('Count').fill('2');
    await dialog.getByLabel('Spacing (mm)').fill('40');
    await dialog.getByRole('button', { name: 'Create pattern' }).click();
    await ready(page);
    await expect(dialog).toHaveCount(0);
    const content = (await cadSnapshot(page)).content;
    expect(content.componentPatterns).toHaveLength(1);
    // The copy is not stored: only the seed has a pose.
    expect(Object.keys(content.solvedPoses)).toEqual(['c-shaft']);
    await expect(elements.getByTestId('cad-pattern')).toContainText('2 × c-shaft · row along Y');
    await elements.getByTestId('cad-pattern').getByRole('button', { name: 'Show seed' }).click();
    await expect(elements.getByTestId('cad-pattern')).toHaveCount(0);
    // A click on the copy's ring (x = 120 + 12.5, y = 25 + 40) selects its pattern.
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    const scale = box.height / 160;
    await page.mouse.click(
      box.x + box.width / 2 + (132.5 - 70) * scale,
      box.y + box.height / 2 - (65 - 25) * scale,
    );
    await expect(elements.getByTestId('cad-pattern')).toContainText('2 × c-shaft');
    await elements.getByRole('button', { name: 'Remove pattern' }).click();
    await ready(page);
    expect((await cadSnapshot(page)).content.componentPatterns).toEqual([]);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });
});

test.describe('part version updates (R2b-2b, CAD48)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');
  const pose = async (page: Page, id: string) =>
    (await cadSnapshot(page)).content.solvedPoses[id]!.translationMm.map((v) => +v.toFixed(3));
  const component = async (page: Page, name: string) =>
    (await panel(page, 'Elements'))
      .getByRole('list', { name: 'Components' })
      .getByRole('button')
      .filter({ hasText: name });
  const update = async (page: Page, version: string) => {
    await (await component(page, 'c-base')).click();
    const card = page.getByTestId('cad-component');
    await expect(card).toContainText('新しい版 v4があります');
    await card.getByRole('button', { name: 'Change version…' }).click();
    const dialog = page.getByTestId('cad-update-parts');
    await dialog.getByRole('combobox', { name: 'New version of Base' }).selectOption(version);
    await dialog.getByRole('button', { name: 'Preview' }).click();
    return dialog;
  };

  test('a newer version is shown, previewed and taken as one edit; Undo returns it', async ({
    page,
  }) => {
    await page.goto('/?fixture=r2b-versions');
    await ready(page);
    const before = await cadSnapshot(page);
    expect(await pose(page, 'c-shaft')).toEqual([40, 25, 5]);
    await expect(await component(page, 'c-base')).toContainText('新しい版あり');
    const dialog = await update(page, 'v2');
    await expect(dialog.getByRole('table', { name: 'Changes' })).toContainText('v1 → v2');
    await expect(dialog.getByTestId('cad-update-moved')).toContainText('c-shaft');
    // Previewing stores nothing.
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
    await dialog.getByRole('button', { name: 'Apply update' }).click();
    await ready(page);
    expect(await pose(page, 'c-shaft')).toEqual([50, 25, 5]);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });

  test('a version that splits the joint face is taken only with a new choice, in one edit', async ({
    page,
  }) => {
    await page.goto('/?fixture=r2b-versions');
    await ready(page);
    const before = await cadSnapshot(page);
    const dialog = await update(page, 'v3');
    const broken = dialog.getByTestId('cad-update-broken');
    await expect(broken).toContainText('j-axle');
    await dialog.getByRole('button', { name: 'Choose connectors again…' }).click();
    // The choice is made over the view, which the narrow layout's panel covers.
    await uncover(page);
    const rebind = page.getByTestId('cad-rebind');
    await expect(rebind).toContainText('j-axle');
    await expect(rebind.getByTestId('cad-rebind-candidate')).toContainText('Candidate 1 of 2');
    await rebind.getByRole('button', { name: 'Next candidate' }).click();
    await expect(rebind.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    await rebind.getByRole('button', { name: 'Confirm' }).click();
    await ready(page);
    const [x] = await pose(page, 'c-shaft');
    // On a half of the top beside the groove, not where the whole face was.
    expect(Math.abs(x! - 40)).toBeGreaterThan(20);
    expect(partVersionId((await cadSnapshot(page)).content.parts[0]!.source)).toBe('v3');
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });

  test('a version whose content does not match its hash is refused', async ({ page }) => {
    await page.goto('/?fixture=r2b-versions&tamper=hash');
    await ready(page);
    const before = await cadSnapshot(page);
    await update(page, 'v2');
    await expect(page.getByRole('alert').filter({ hasText: '一致しない' }).first()).toBeVisible();
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });
});

test.describe('surface loft and sweep (R2a-2b, CAD41)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('lofts two closed chains and sweeps an open chain into surfaces, each one edit', async ({
    page,
  }) => {
    await page.goto('/?fixture=chains');
    const before = await cadSnapshot(page);
    const area = (s: typeof before, name: string) => {
      const body = s.content.bodies.find((b) => b.name === name && b.state === 'active');
      const e = body && s.evaluation?.status === 'ok' ? s.evaluation.bodies[body.id] : undefined;
      return e?.kind === 'sheet' ? e.areaMm2 : NaN;
    };
    const elements = await panel(page, 'Elements');
    await elements.getByRole('button', { name: 'Loft…' }).click();
    const loft = page.getByRole('dialog', { name: 'Loft' });
    await loft.getByRole('combobox', { name: 'Result' }).selectOption('surface');
    await loft.getByLabel('a', { exact: true }).check();
    await loft.getByLabel('b', { exact: true }).check();
    await loft.getByLabel(/^Ruled/).check();
    await loft.getByRole('button', { name: 'Create loft' }).click();
    await ready(page);
    await expect(loft).toHaveCount(0);
    const lofted = await cadSnapshot(page);
    // Four trapezoids between the squares, without volume.
    expect(area(lofted, 'Surface')).toBeCloseTo(120 * Math.sqrt(1000), 4);
    expect(lofted.content.features.map((f) => f.type)).toEqual(['surfaceLoft', 'transform']);
    await (await panel(page, 'Elements')).getByRole('button', { name: 'Sweep…' }).click();
    const sweep = page.getByRole('dialog', { name: 'Sweep' });
    await sweep.getByRole('combobox', { name: 'Result' }).selectOption('surface');
    await sweep
      .getByRole('combobox', { name: 'Profile', exact: true })
      .selectOption({ label: 'profile' });
    await sweep
      .getByRole('combobox', { name: 'Path', exact: true })
      .selectOption({ label: 'rail' });
    await sweep.getByRole('button', { name: 'Create sweep' }).click();
    await ready(page);
    const swept = await cadSnapshot(page);
    const sheets = swept.content.bodies.filter((b) => b.kind === 'sheet');
    expect(sheets).toHaveLength(2);
    const gutter =
      swept.evaluation?.status === 'ok' ? swept.evaluation.bodies[sheets[1]!.id] : undefined;
    expect(gutter?.kind === 'sheet' && gutter.areaMm2).toBeCloseTo(775 * Math.PI, 4);
    await page.screenshot({ path: test.info().outputPath('surface-loft-sweep.png') });
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(lofted.contentHash);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });
});

test.describe('boundary surfaces and fills (R2a-2c, CAD41)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('collects the tube’s top edges and fills its opening, one edit', async ({ page }) => {
    await page.goto('/?fixture=tube&view=plan');
    await ready(page);
    const before = await cadSnapshot(page);
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    // Looking down Z with +Y up; the view spans 120 mm high about x = 20, y = 20.
    const scale = box.height / 120;
    const at = (x: number, y: number) =>
      page.mouse.click(
        box.x + box.width / 2 + (x - 20) * scale,
        box.y + box.height / 2 - (y - 20) * scale,
      );
    await (await tool(page, 'Pick edges')).click();
    const tops: [number, number, string][] = [
      [20, 0, 'l0'],
      [40, 20, 'l1'],
      [20, 40, 'l2'],
      [0, 20, 'l3'],
    ];
    for (const [x, y, element] of tops) {
      await uncover(page);
      await at(x, y);
      await expect
        .poll(async () => (await cadSnapshot(page)).topology?.name)
        .toEqual([['end'], [`side:e:${element}`]]);
      await (await panel(page, 'Inspector')).getByRole('button', { name: 'Collect edge' }).click();
    }
    expect((await cadSnapshot(page)).collectedEdges).toHaveLength(4);
    await page.keyboard.press('Escape');
    await (await panel(page, 'Elements')).getByRole('button', { name: 'Boundary…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Boundary' });
    await dialog.getByRole('combobox', { name: 'Result' }).selectOption('fill');
    for (const [, , element] of tops)
      await dialog.getByLabel(`end | side:e:${element} (surface)`, { exact: true }).check();
    await dialog.getByRole('button', { name: 'Create fill' }).click();
    await ready(page);
    await expect(dialog).toHaveCount(0);
    const filled = await cadSnapshot(page);
    const cap = filled.content.bodies.at(-1)!;
    const body = filled.evaluation?.status === 'ok' ? filled.evaluation.bodies[cap.id] : undefined;
    // A flat 40 mm square at the top, a sheet without volume.
    expect(cap.kind).toBe('sheet');
    expect(body?.kind === 'sheet' && body.areaMm2).toBeCloseTo(1600, 6);
    expect(body?.bounds[0][2]).toBeCloseTo(20, 5);
    expect(filled.collectedEdges).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('surface-fill.png') });
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });
});

test.describe('pattern along a sketch path (K5a, CM-7b)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('patterns a bar along the path a sketch draws, turned with it, as one edit', async ({
    page,
  }) => {
    await page.goto('/?fixture=bars');
    await ready(page);
    const before = await cadSnapshot(page);
    await (await panel(page, 'Elements'))
      .getByRole('list', { name: 'Bodies' })
      .getByRole('button', { name: 'Plate' })
      .click();
    let inspector = await panel(page, 'Inspector');
    await inspector.locator('summary', { hasText: /^Pattern$/ }).click();
    await inspector.getByRole('combobox', { name: 'Copies of' }).selectOption({ label: 'Bar' });
    await inspector.getByRole('combobox', { name: 'Layout' }).selectOption({ label: 'Along Path' });
    await expect(inspector.getByLabel('Spacing (mm)')).toHaveCount(0);
    await expect(inspector.getByLabel('Turn each copy with the path')).toBeChecked();
    await inspector.getByRole('button', { name: 'Pattern union' }).click();
    await ready(page);
    const plate = async () => {
      const s = await cadSnapshot(page);
      return s.evaluation?.status === 'ok' ? s.evaluation.bodies.plate : undefined;
    };
    // Three bars on the plate; the last, at the end of the arc, turned to +y.
    expect(vol(await plate())).toBeCloseTo(160 * 70 * 4 + 3 * 160, 1);
    expect((await plate())!.bounds[1]).toEqual([
      expect.closeTo(152, 3),
      expect.closeTo(55, 3),
      expect.closeTo(4, 3),
    ]);
    inspector = await panel(page, 'Inspector');
    await expect(inspector).toContainText('copies along the path of Path, start to end');
    await inspector.getByLabel('Turn each copy with the path').click();
    await ready(page);
    await expect.poll(async () => (await plate())?.bounds[1][0]).toBeCloseTo(155, 3);
    await uncover(page);
    await page.screenshot({ path: test.info().outputPath('curve-pattern.png') });
    await (await tool(page, 'Undo')).click();
    await ready(page);
    await (await tool(page, 'Undo')).click();
    await ready(page);
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });
});

test.describe('trim, sew and thicken (R2a-3, CAD42)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('sews the hood’s three sheets, trims its window and thickens it, one edit each', async ({
    page,
  }) => {
    await page.goto('/?fixture=hood');
    await ready(page);
    const before = await cadSnapshot(page);
    const left = async () => {
      await (await panel(page, 'Elements'))
        .getByRole('list', { name: 'Bodies' })
        .getByRole('button', { name: 'left' })
        .click();
      return panel(page, 'Inspector');
    };
    const measured = async () => {
      const snapshot = await cadSnapshot(page);
      return snapshot.evaluation?.status === 'ok' ? snapshot.evaluation.bodies.left : undefined;
    };
    // Sew the crown and the right panel into the left: one sheet, the strip r × π/3 × 80 mm².
    let inspector = await left();
    await inspector.locator('summary', { hasText: /^Sew$/ }).click();
    await inspector.getByLabel('crown', { exact: true }).check();
    await inspector.getByLabel('right', { exact: true }).check();
    await inspector.getByRole('button', { name: 'Sew', exact: true }).click();
    await ready(page);
    const sewn = await measured();
    expect(sewn?.kind).toBe('sheet');
    expect(sewn!.areaMm2 / ((100 * Math.PI * 80) / 3)).toBeCloseTo(1, 4);
    // Trim by the window sketch along its normal, keeping the outside.
    inspector = await left();
    await inspector.locator('summary', { hasText: /^Trim$/ }).click();
    await inspector.getByRole('combobox', { name: 'Cut with' }).selectOption('sketch:window');
    await inspector.getByRole('combobox', { name: 'Keep' }).selectOption('outside');
    await inspector.getByRole('button', { name: 'Trim', exact: true }).click();
    await ready(page);
    const trimmed = await measured();
    const window = 2 * 100 * Math.asin(0.15) * 30;
    expect(trimmed!.areaMm2 / ((100 * Math.PI * 80) / 3 - window)).toBeCloseTo(1, 4);
    // A 1.5 mm skin towards the normal: a solid.
    inspector = await left();
    await inspector.locator('summary', { hasText: /^Thicken$/ }).click();
    const thickness = inspector.getByLabel('Thickness (mm)');
    await thickness.fill('1.5');
    await thickness.press('Enter');
    await inspector.getByRole('button', { name: 'Thicken', exact: true }).click();
    await ready(page);
    const skin = await measured();
    const wall = ((100 ** 2 - 98.5 ** 2) / 2) * ((Math.PI / 3) * 80 - 2 * Math.asin(0.15) * 30);
    expect(vol(skin) / wall).toBeCloseTo(1, 4);
    await uncover(page);
    await page.screenshot({ path: test.info().outputPath('surface-hood.png') });
    // Each was one edit: three Undos give the sheets back.
    for (let i = 0; i < 3; i++) {
      await (await tool(page, 'Undo')).click();
      await ready(page);
    }
    expect((await cadSnapshot(page)).contentHash).toBe(before.contentHash);
  });
});

test.describe('continuity (R2a-4, CAD43)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('checks the picked seam at 65 samples and shows each level, the content unchanged', async ({
    page,
  }) => {
    await page.goto('/?fixture=seam&view=side');
    await ready(page);
    const before = await cadSnapshot(page);
    // Seen from -Y: the seam where the plane turns into the cylinder stands upright mid-view.
    const box = (await page.getByTestId('cad-viewport').locator('canvas').boundingBox())!;
    await (await tool(page, 'Pick edges')).click();
    await uncover(page);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect
      .poll(async () => (await cadSnapshot(page)).topology?.name)
      .toEqual([['side:e:a1'], ['side:e:l0']]);
    const inspector = await panel(page, 'Inspector');
    await inspector.getByRole('button', { name: 'Check continuity' }).click();
    const result = inspector.getByTestId('cad-continuity');
    await expect(result).toContainText('G1 within tolerance at all 65 samples.');
    // Tangent, but the curvature jumps from the plane's 0 to the cylinder's 1/20 mm.
    await expect(result).toContainText(
      'G2 curvature100% (5.00e-2 /mm) at (40, 0, 0) — over tolerance',
    );
    const after = await cadSnapshot(page);
    expect(after.continuity).toMatchObject({
      status: 'done',
      report: { level: 'G1', samples: 65 },
    });
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.canUndo).toBe(false);
    await page.screenshot({ path: test.info().outputPath('surface-continuity.png') });
    // Another pick hides the report: it belongs to the edge it was made for.
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await cadSnapshot(page)).continuity).toBeUndefined();
  });
});

test.describe('zebra, curvature colours and combs (R2a-4, CAD43)', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  /** Shares of the view's pixels that are near black, strongly red and strongly blue. */
  const pixels = (page: Page) =>
    page
      .getByTestId('cad-viewport')
      .locator('canvas')
      .evaluate((canvas: HTMLCanvasElement) => {
        const copy = document.createElement('canvas');
        [copy.width, copy.height] = [canvas.width, canvas.height];
        const g = copy.getContext('2d')!;
        g.drawImage(canvas, 0, 0);
        const { data } = g.getImageData(0, 0, copy.width, copy.height);
        let [dark, red, blue] = [0, 0, 0];
        for (let i = 0; i < data.length; i += 4) {
          const [r, gr, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
          if (a < 200) continue;
          if (r < 40 && gr < 40 && b < 40) dark++;
          if (r > gr + 60 && r > b + 60) red++;
          if (b > r + 60 && b > gr + 30) blue++;
        }
        const n = data.length / 4;
        return { dark: dark / n, red: red / n, blue: blue / n };
      });

  test('shades the seam with zebra stripes and the kernel’s curvature, the content unchanged', async ({
    page,
  }) => {
    await page.goto('/?fixture=seam&view=side');
    await ready(page);
    const before = await cadSnapshot(page);
    expect((await pixels(page)).dark).toBe(0);
    const shading = page.getByTestId('cad-shading');
    await shading.selectOption('zebra');
    await expect(page.getByTestId('cad-zebra')).toContainText('world Z axis');
    // Around X: the cylinder's normals turn about Z, so its reflections cross the stripes.
    await page.getByTestId('cad-zebra').getByLabel('Direction').selectOption('x');
    await expect(page.getByTestId('cad-zebra')).toContainText('world X axis');
    await expect.poll(async () => (await pixels(page)).dark).toBeGreaterThan(0.01);
    await page.screenshot({ path: test.info().outputPath('surface-zebra.png') });
    // A first request that brings nothing (refused or superseded in the export slot) leaves a
    // way to ask again.
    await page.evaluate(() => {
      const { controller } = (window as unknown as { cad: { controller: CadController } }).cad;
      const original = controller.showCurvature.bind(controller);
      controller.showCurvature = async () => {
        controller.showCurvature = original;
        return undefined;
      };
    });
    // Mean curvature from the exact build: 0 on the plane, 1/40 on the cylinder of r = 20.
    await shading.selectOption('mean');
    const legend = page.getByTestId('cad-curvature');
    await legend.getByRole('button', { name: 'Compute curvature' }).click();
    await expect(legend.getByTestId('cad-curvature-range')).toHaveText('+2.50e-2 /mm');
    await expect(legend).toContainText('Full colour at radius 40 mm or less.');
    await expect.poll(async () => (await cadSnapshot(page)).curvature?.status).toBe('done');
    const coloured = async () => {
      const p = await pixels(page);
      return p.red + p.blue;
    };
    await expect.poll(coloured).toBeGreaterThan(0.01);
    await page.screenshot({ path: test.info().outputPath('surface-curvature.png') });
    await legend.getByLabel('Range').fill('1');
    await expect(legend.getByTestId('cad-curvature-range')).toHaveText('+5.00e-2 /mm');
    // Gauss: zero on both (a cylinder is developable).
    await shading.selectOption('gauss');
    await expect(legend.getByTestId('cad-curvature-range')).toHaveText('+2.00e-4 /mm²');
    await shading.selectOption('shaded');
    await expect(page.getByTestId('cad-curvature')).toHaveCount(0);
    const after = await cadSnapshot(page);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.canUndo).toBe(false);
  });

  test('zebra on the selected body only, the help folded, and the grid hidden (ST-87)', async ({
    page,
  }) => {
    await page.goto('/?fixture=seam&view=side');
    await ready(page);
    const before = await cadSnapshot(page);
    await page.getByTestId('cad-shading').selectOption('zebra');
    const zebra = page.getByTestId('cad-zebra');
    await expect(zebra.getByText(/A kink in the stripes/)).toBeHidden();
    await zebra.getByText('Around the world Z axis', { exact: true }).click();
    await expect(zebra.getByText(/A kink in the stripes/)).toBeVisible();
    await zebra.getByLabel('Direction').selectOption('x');
    await expect.poll(async () => (await pixels(page)).dark).toBeGreaterThan(0.01);
    // Only the selected body: none selected, nothing striped; then the selected one.
    await zebra.getByLabel('Selected body only').check();
    await expect(zebra).toContainText('bodyを選ぶと');
    await expect.poll(async () => (await pixels(page)).dark).toBe(0);
    // Through the controller: the narrow layout folds the Bodies list away.
    await page.evaluate(() => {
      const { controller } = (window as unknown as { cad: { controller: CadController } }).cad;
      const id = controller.getSnapshot().content.bodies[0]!.id;
      controller.select({ kind: 'body', id });
    });
    await expect(zebra).not.toContainText('bodyを選ぶと');
    await expect.poll(async () => (await pixels(page)).dark).toBeGreaterThan(0.01);
    await page.getByTestId('cad-shading').selectOption('shaded');
    // The selected body keeps its colour, outlined in blue.
    await page.screenshot({ path: test.info().outputPath('surface-selected-outline.png') });
    // The ground grid: its lines go with it.
    const gridLines = () =>
      page
        .getByTestId('cad-viewport')
        .locator('canvas')
        .evaluate((canvas: HTMLCanvasElement) => {
          const copy = document.createElement('canvas');
          [copy.width, copy.height] = [canvas.width, canvas.height];
          const g = copy.getContext('2d')!;
          g.drawImage(canvas, 0, 0);
          const { data } = g.getImageData(0, 0, copy.width, copy.height);
          // Pixels other than the most common colour (the background).
          const counts = new Map<number, number>();
          for (let i = 0; i < data.length; i += 4) {
            const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          return data.length / 4 - Math.max(...counts.values());
        });
    const shown = await gridLines();
    await page.getByTestId('cad-grid').uncheck();
    await expect.poll(gridLines).toBeLessThan(shown);
    if (test.info().project.name === 'desktop') {
      // A PNG export leaves the grid hidden: a resize redraws the viewport after it.
      const size = page.viewportSize()!;
      const redraw = async (width: number) => {
        await page.setViewportSize({ ...size, width });
        await page.waitForTimeout(200);
      };
      await redraw(size.width - 20);
      const hidden = await gridLines();
      await redraw(size.width);
      await pngAlpha(page)('Export PNG');
      await redraw(size.width - 20);
      await expect.poll(gridLines).toBe(hidden);
      await redraw(size.width);
    }
    await page.getByTestId('cad-grid').check();
    await expect.poll(gridLines).toBe(shown);
    const after = await cadSnapshot(page);
    expect(after.contentHash).toBe(before.contentHash);
  });

  test('draws the picked arc edge’s curvature comb from the exact curve', async ({ page }) => {
    await page.goto('/?fixture=seam&view=plan');
    await ready(page);
    // The arc's lower edge, picked through the controller (from above it lies under the upper).
    await page.evaluate(() => {
      const { controller } = (window as unknown as { cad: { controller: CadController } }).cad;
      const { meshes, contentHash } = controller.getSnapshot();
      const mesh = meshes!.meshes[0]!;
      const names: string[] = [];
      for (let i = 0; i < mesh.topology.edges.length; i++) {
        controller.select({
          kind: 'edge',
          id: mesh.bodyId,
          pick: mesh.edgeBase + 1 + i,
          contentHash,
        });
        const name = JSON.stringify(controller.getSnapshot().topology?.name);
        names.push(name);
        if (name.includes('side:e:a1') && name.includes('start') && !name.includes('l0')) return;
      }
      throw new Error(`no arc edge in ${names.join(' ')}`);
    });
    const inspector = await panel(page, 'Inspector');
    await inspector.getByRole('button', { name: 'Show curvature comb' }).click();
    const comb = page.getByTestId('cad-comb');
    await expect(comb).toContainText('129 samples');
    await expect(comb).toContainText('at radius 20 mm.');
    const snapshot = await cadSnapshot(page);
    expect(snapshot.comb).toMatchObject({ status: 'done' });
    if (snapshot.comb?.status === 'done')
      for (const s of snapshot.comb.samples) expect(s.curvature).toBeCloseTo(0.05, 9);
    await uncover(page);
    await page.screenshot({ path: test.info().outputPath('surface-comb.png') });
    await comb.getByRole('button', { name: 'Hide' }).click();
    await expect(page.getByTestId('cad-comb')).toHaveCount(0);
  });
});
