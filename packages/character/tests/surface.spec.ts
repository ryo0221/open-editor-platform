import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import type { Page } from '@playwright/test';
// The shared fixture fails a test on any browser console error or uncaught exception.
import { expect, test } from '../../../tests/e2e/fixtures';
import { testGltf } from '@editor-platform/character-core/gltf-fixtures';
import { importGltf } from '@editor-platform/character-core';
import { inspectVideoFile } from '@editor-platform/video-metadata/file-admission';

// The character Surface's test host (C1c). No kernel; software WebGL draws the view.
type Frame = {
  tick: number;
  playing: boolean;
  bounds?: [[number, number, number], [number, number, number]];
  parts: Record<string, { visible: boolean; positions: number[] }>;
  props: Record<string, { visible: boolean; matrices: number[][] }>;
};
const frame = (page: Page) =>
  page.evaluate(() => (window as unknown as { characterFrame: Frame }).characterFrame);
const viewState = (page: Page) => page.getByTestId('character-view-state');
const time = (page: Page) => page.getByTestId('character-time');
/** A toolbar control, from the overflow menu on a compact toolbar. */
async function tool(page: Page, name: string, role: 'button' | 'slider' | 'combobox' = 'button') {
  const control = page.getByRole(role, { name, exact: true });
  if (!(await control.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  return control;
}
async function panel(page: Page, name: 'Parts' | 'Inspector') {
  const region = page.getByRole('complementary', { name, exact: true });
  if (!(await region.isVisible()))
    await page.getByRole('button', { name: `Toggle ${name}`, exact: true }).click();
  return region;
}
/** The share of canvas pixels in the figure's blue (its body colour), from 0 to 1. */
const bodyShare = (page: Page) =>
  page.evaluate(() => {
    const source = document.querySelector<HTMLCanvasElement>('.character-canvas')!;
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 150;
    const g = c.getContext('2d')!;
    g.drawImage(source, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 120 && d[i + 2] - d[i] > 60) n++;
    return n / (c.width * c.height);
  });
/** The canvas pixels as a data URL, to tell two drawn frames apart. */
const pixels = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLCanvasElement>('.character-canvas')!.toDataURL());

test('shows the figure, plays, pauses, stops and seeks', async ({ page }) => {
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  await expect(time(page)).toHaveText('0.00 s / 1.00 s');
  const rest = await frame(page);
  expect(rest.bounds).toBeDefined();
  const restPixels = await pixels(page);

  await (await tool(page, 'Play')).click();
  await expect(viewState(page)).toHaveText('Playing');
  await expect.poll(async () => (await frame(page)).tick).toBeGreaterThan(24000);
  await (await tool(page, 'Pause')).click();
  const paused = (await frame(page)).tick;
  await page.waitForTimeout(300);
  expect((await frame(page)).tick).toBe(paused);
  await (await tool(page, 'Stop')).click();
  await expect(time(page)).toHaveText(/^0\.00 s/);
  // Space plays and pauses while focus is in the Surface.
  await page.getByRole('region', { name: 'Character view' }).focus();
  await page.keyboard.press('Space');
  await expect(viewState(page)).toHaveText('Playing');
  await page.keyboard.press('Space');
  await expect(viewState(page)).toHaveText('Ready');
  await (await tool(page, 'Stop')).click();

  // Seek to 0.5 s: the right arm is up, so the figure is taller, and the picture changed.
  await (await tool(page, 'Time', 'slider')).fill('120000');
  await expect(time(page)).toHaveText('0.50 s / 1.00 s');
  const up = await frame(page);
  expect(up.tick).toBe(120000);
  expect(up.bounds![1][2]).toBeGreaterThan(rest.bounds![1][2] + 100);
  await expect.poll(() => pixels(page)).not.toBe(restPixels);
});

test('hides a part as an edit and undoes it', async ({ page }) => {
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByRole('checkbox', { name: 'Show Body' }).uncheck();
  expect((await frame(page)).parts.body.visible).toBe(false);
  expect((await frame(page)).bounds).toBeUndefined();
  await page.keyboard.press('Escape');
  await (await tool(page, 'Undo')).click();
  await expect(
    (await panel(page, 'Parts')).getByRole('checkbox', { name: 'Show Body' }),
  ).toBeChecked();
  expect((await frame(page)).parts.body.visible).toBe(true);
});

test('keeps the camera the user moved across a visibility edit and its undo', async ({
  page,
}, info) => {
  // On a phone the Parts panel covers the toolbar, so the layout changes between the two views.
  test.skip(info.project.name === 'mobile', 'desktop layout keeps the panel and toolbar together');
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  const show = parts.getByRole('checkbox', { name: 'Show Body' });
  const fitted = await pixels(page);
  const box = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 20, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => pixels(page)).not.toBe(fitted);
  // Let any orbit damping settle before taking the view to compare with.
  let orbited = await pixels(page);
  await expect
    .poll(async () => {
      const now = await pixels(page);
      const same = now === orbited;
      orbited = now;
      return same;
    })
    .toBe(true);
  await show.uncheck();
  await expect.poll(() => pixels(page)).not.toBe(orbited);
  // Undo from the toolbar with the Parts panel still open: the same layout as the view taken.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(show).toBeChecked();
  // The same view as before the edit: the camera was not fitted again.
  await expect.poll(() => pixels(page)).toBe(orbited);
});

test('frames a model that starts hidden once a part is shown', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'desktop layout keeps the panel beside the view');
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  await panel(page, 'Parts');
  await expect.poll(async () => (await frame(page)).bounds).toBeDefined();
  const fitted = await pixels(page);
  await page.goto('/?hidden=1');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  expect((await frame(page)).bounds).toBeUndefined();
  await parts.getByRole('checkbox', { name: 'Show Body' }).check();
  // The same picture as a model fitted on load: the camera was fitted when the part appeared.
  await expect.poll(() => pixels(page)).toBe(fitted);
});

test('frames a new document that reuses the same assets', async ({ page }) => {
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  await expect.poll(async () => (await frame(page)).bounds).toBeDefined();
  const before = (await frame(page)).bounds!;
  const fitted = await bodyShare(page);
  expect(fitted).toBeGreaterThan(0.02);
  await page.evaluate(() =>
    (window as unknown as { replaceCharacter(x: number): void }).replaceCharacter(1_000_000),
  );
  await expect
    .poll(async () => (await frame(page)).bounds![0][0])
    .toBeCloseTo(before[0][0] + 1_000_000, 0);
  // Framing follows the model 1 km away: about as much of the view shows it as before.
  await expect.poll(() => bodyShare(page)).toBeGreaterThan(fitted * 0.8);
});

test('frames a new document by its own first action, not the old playhead', async ({ page }) => {
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  await expect.poll(async () => (await frame(page)).bounds).toBeDefined();
  const before = (await frame(page)).bounds!;
  const fitted = await bodyShare(page);
  await page.evaluate(() =>
    (
      window as unknown as { replaceCharacter(x: number, inAction: boolean): void }
    ).replaceCharacter(1_000_000, true),
  );
  await expect
    .poll(async () => (await frame(page)).bounds![0][0])
    .toBeGreaterThan(before[0][0] + 900_000);
  // The fit used the new action's pose, 1 km away: the figure is in view.
  await expect.poll(() => bodyShare(page)).toBeGreaterThan(fitted * 0.8);
});

test('imports a glTF with VRM terms, lists what it lost, and refuses a broken file', async ({
  page,
}) => {
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  const vrm = testGltf({
    root: {
      extensionsUsed: ['VRMC_vrm'],
      extensions: {
        VRMC_vrm: {
          specVersion: '1.0',
          meta: { name: 'Bar', authors: ['A'], commercialUsage: 'personalNonProfit' },
        },
      },
    },
  });
  await page
    .getByLabel('glTF or VRM file')
    .setInputFiles({ name: 'bar.vrm', mimeType: 'model/gltf-binary', buffer: Buffer.from(vrm) });
  await expect(page.locator('.character-status')).toContainText('Bar · 1 parts · 2 bones');
  await expect(viewState(page)).toHaveText('Ready');
  const inspector = await panel(page, 'Inspector');
  await expect(inspector.getByText('bar.vrm')).toBeVisible();
  await expect(inspector.getByRole('list', { name: 'Import losses' })).toContainText(
    'vrm-humanoid',
  );
  await expect(inspector.getByLabel('VRM terms')).toContainText('personalNonProfit');
  await (await tool(page, 'Time', 'slider')).fill('240000');
  const bent = await frame(page);
  expect(bent.tick).toBe(240000);
  // The tip, bent 90° at the arm: x −500 mm, z 650 mm (glTF's own pose, converted).
  const tip = Object.values(bent.parts)[0].positions;
  const xs = tip.filter((_, i) => i % 3 === 0);
  expect(Math.min(...xs)).toBeCloseTo(-500, 0);

  await page.getByLabel('glTF or VRM file').setInputFiles({
    name: 'cut.glb',
    mimeType: 'model/gltf-binary',
    buffer: Buffer.from(vrm.slice(0, 40)),
  });
  await expect(page.getByRole('alert')).toContainText('Import refused: container');
  await expect(page.locator('.character-status')).toContainText('Bar · 1 parts');
});

test('keys a bone pose at the playhead and edits keys in the dope sheet', async ({ page }) => {
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  const keys = page.getByRole('group', { name: 'Keys' });
  const armKeys = keys.getByRole('button', { name: /^Key arm\.R rotation at / });
  await expect(armKeys).toHaveCount(3);
  // Pose mode: choose the left arm, seek to 0.25 s and key its rotation there.
  await (await tool(page, 'Time', 'slider')).fill('60000');
  await (await panel(page, 'Parts')).getByRole('button', { name: 'arm.L', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  await expect(inspector.getByText('A change keys this bone at 0.25 s.')).toBeVisible();
  const before = (await frame(page)).bounds!;
  const z = inspector.getByLabel('Rotation Y', { exact: true });
  await z.fill('-60');
  await z.press('Enter');
  const leftKeys = keys.getByRole('button', { name: /^Key arm\.L rotation at / });
  await expect(leftKeys).toHaveCount(1);
  await expect(leftKeys).toHaveAccessibleName('Key arm.L rotation at 0.25 s');
  // The pose drawn at the playhead now follows the key.
  await expect
    .poll(async () => JSON.stringify((await frame(page)).bounds))
    .not.toBe(JSON.stringify(before));
  await expect(inspector.getByLabel('Rotation Y', { exact: true })).toHaveValue('-60');
  // Undo removes the key again.
  await page.keyboard.press('Escape');
  await (await tool(page, 'Undo')).click();
  await expect(leftKeys).toHaveCount(0);
  await (await tool(page, 'Redo')).click();
  await expect(leftKeys).toHaveCount(1);

  // Select the middle key of the right arm, move it a frame later, ease it, then delete it.
  await armKeys.nth(1).click();
  await expect(time(page)).toHaveText('0.50 s / 1.00 s');
  await keys.getByRole('button', { name: 'Move keys a frame later', exact: true }).click();
  await expect(armKeys.nth(1)).toHaveAccessibleName(/at 0\.53 s$/);
  await keys.getByLabel('Key easing').selectOption('hold');
  await expect(keys.getByLabel('Key easing')).toHaveValue('hold');
  await keys.getByRole('button', { name: 'Delete keys', exact: true }).click();
  await expect(armKeys).toHaveCount(2);
  // The first key cannot move before the start: refused, nothing changes.
  await armKeys.first().click();
  await keys.getByRole('button', { name: 'Move keys a frame earlier', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('tick');
  await expect(armKeys.first()).toHaveAccessibleName(/at 0\.00 s$/);
});

test('builds a skeleton: adds, moves, renames, re-parents and removes bones, with Undo (C5a)', async ({
  page,
}) => {
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  // The figure's bones are drawn from the first frame and follow the camera.
  const hip = page.getByTestId('bone-joint-hip');
  await expect(hip).toBeVisible();
  const at = async () => [await hip.getAttribute('cx'), await hip.getAttribute('cy')].join(' ');
  const first = await at();
  const view = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(at).not.toBe(first);
  await (await panel(page, 'Parts'))
    .getByRole('button', { name: 'Add skeleton', exact: true })
    .click();
  let inspector = await panel(page, 'Inspector');
  await expect(inspector.getByText('Bone · Root')).toBeVisible();
  const z = inspector.getByLabel('Rest position Z', { exact: true });
  await z.fill('900');
  await z.press('Enter');
  await expect(z).toHaveValue('900');
  await inspector.getByRole('button', { name: 'Add child bone', exact: true }).click();
  await expect(inspector.getByText('Bone · Bone')).toBeVisible();
  await expect(inspector.getByLabel('Parent bone')).toHaveValue('bone');
  await expect(inspector.getByLabel('Rest position Z', { exact: true })).toHaveValue('200');
  const name = inspector.getByLabel('Bone name', { exact: true });
  await name.fill('Spine');
  await name.press('Enter');
  await expect(inspector.getByText('Bone · Spine')).toBeVisible();
  // Hung from the skeleton's root instead, the bone keeps its place: 900 + 200 mm.
  await inspector.getByLabel('Parent bone').selectOption('');
  await expect(inspector.getByLabel('Rest position Z', { exact: true })).toHaveValue('1100');
  // The bones are drawn over the view; a click on one chooses it (the panel closed first).
  const toggle = page.getByRole('button', { name: 'Toggle Inspector', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('button', { name: 'Bone Root', exact: true }).click();
  inspector = await panel(page, 'Inspector');
  await expect(inspector.getByText('Bone · Root')).toBeVisible();
  // A bone the figure's skin weights is not removed, nor its bound skeleton.
  await (await panel(page, 'Parts'))
    .getByRole('button', { name: 'forearm.L', exact: true })
    .click();
  inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Remove bone', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('bone-in-use');
  await inspector.getByRole('button', { name: 'Remove skeleton', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('skeleton-in-use');
  // The new skeleton goes, and Undo brings it back.
  await (await panel(page, 'Parts')).getByRole('button', { name: 'Spine', exact: true }).click();
  inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Remove skeleton', exact: true }).click();
  const parts = await panel(page, 'Parts');
  await expect(parts.getByRole('button', { name: 'Spine', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await (await tool(page, 'Undo')).click();
  await expect(
    (await panel(page, 'Parts')).getByRole('button', { name: 'Spine', exact: true }),
  ).toBeVisible();
});

test('a value typed and not committed is keyed when the Host flushes its inputs', async ({
  page,
}) => {
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  await (await panel(page, 'Parts')).getByRole('button', { name: 'arm.L', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  // Typed, then saved with a shortcut: no Enter, no leaving the field.
  await inspector.getByLabel('Rotation Y', { exact: true }).fill('-60');
  const leftKeys = page
    .getByRole('group', { name: 'Keys' })
    .getByRole('button', { name: /^Key arm\.L rotation at / });
  await expect(leftKeys).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { characterInputs: { flush(): void } }).characterInputs.flush(),
  );
  await expect(leftKeys).toHaveCount(1);
});

type Inputs = { flush(): void; getSnapshot(): { dirty: number } };
const flush = (page: Page) =>
  page.evaluate(() => {
    const inputs = (window as unknown as { characterInputs: Inputs }).characterInputs;
    try {
      inputs.flush();
      return { ok: true, dirty: inputs.getSnapshot().dirty };
    } catch (e) {
      return { ok: false, message: String(e), dirty: inputs.getSnapshot().dirty };
    }
  });
test('a flush accepts another spelling of the same number and refuses a value past the limits', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=1');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'arm.L', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  // `0.0` for 0 is no change: the save goes ahead and nothing is left pending.
  await inspector.getByLabel('Rotation X', { exact: true }).fill('0.0');
  expect(await flush(page)).toEqual({ ok: true, dirty: 0 });
  // A cleared field is not a number, even where the value is 0: the save is refused.
  await inspector.getByLabel('Rotation X', { exact: true }).fill('');
  // The inputs' snapshot is refreshed after the field renders: wait for it, then flush.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { characterInputs: Inputs }).characterInputs.getSnapshot().dirty,
      ),
    )
    .toBe(1);
  expect(await flush(page)).toMatchObject({ ok: false, dirty: 1 });
  await inspector.getByLabel('Rotation X', { exact: true }).fill('0');
  // A key whose value shows the same after rounding leaves nothing pending.
  await inspector.getByLabel('Translation Y', { exact: true }).fill('0.001');
  expect(await flush(page)).toEqual({ ok: true, dirty: 0 });
  // A joint value past the version's limits is refused, and so is the save.
  await parts.getByLabel('Prop version').selectOption({ label: 'Robot arm — v1' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await parts.getByRole('button', { name: 'Robot arm', exact: true }).click();
  await inspector.getByLabel('Turn Angle', { exact: true }).fill('200');
  const refused = await flush(page);
  expect(refused.ok).toBe(false);
  await expect(page.getByRole('alert')).toContainText('joint-limit');
});

test('an edit the Host does not admit is refused and changes nothing', async ({ page }) => {
  await page.goto('/?admit=refuse');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  const show = parts.getByRole('checkbox').first();
  await expect(show).toBeChecked();
  // The click asks to hide the part; the Host refuses, so it stays shown.
  await show.click();
  await expect(page.getByRole('alert').filter({ hasText: 'native-file-full' })).toBeVisible();
  await expect(show).toBeChecked();
});

test('read only shows the keys and pose but edits neither', async ({ page }) => {
  await page.goto('/?readonly=1');
  await expect(viewState(page)).toHaveText('Ready');
  const keys = page.getByRole('group', { name: 'Keys' });
  await keys
    .getByRole('button', { name: /^Key arm\.R rotation at / })
    .first()
    .click();
  await expect(keys.getByRole('button', { name: 'Delete keys', exact: true })).toBeDisabled();
  await (await panel(page, 'Parts')).getByRole('button', { name: 'arm.R', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  await expect(inspector.getByLabel('Rotation Z', { exact: true })).toBeDisabled();
});

test('refuses asset bytes that do not match the document', async ({ page }) => {
  await page.goto('/?broken=1');
  await expect(viewState(page)).toHaveText('Assets do not match');
  await expect(page.getByRole('alert')).toContainText('mesh-body: bytes do not match the document');
});

test('read only keeps the view and playback but no edits or imports', async ({ page }) => {
  await page.goto('/?readonly=1');
  await expect(viewState(page)).toHaveText('Ready');
  await expect(page.locator('.character-status')).toContainText('Read only');
  await expect(await tool(page, 'Undo')).toBeDisabled();
  await expect(await tool(page, 'Import glTF or VRM')).toBeDisabled();
  await (await tool(page, 'Time', 'slider')).fill('120000');
  expect((await frame(page)).tick).toBe(120000);
  const parts = await panel(page, 'Parts');
  await expect(parts.getByRole('checkbox', { name: 'Show Body' })).toBeDisabled();
});

test('fits a phone width without scrolling sideways', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'narrow layout');
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/** The turn of the fake arm's link about z, in degrees, from its drawn matrix. */
const linkTurn = async (page: Page) => {
  const m = (await frame(page)).props['prop-arm']!.matrices[1]!;
  return Math.round((Math.atan2(m[1]!, m[0]!) * 180) / Math.PI);
};
test("props: places a CAD version, keys its joint on the bones' timeline, plays and removes it", async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=1');
  await expect(viewState(page)).toHaveText('Ready');
  const before = await pixels(page);
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Robot arm — v1' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  // Drawn beside the figure at its placement, the link at the saved angle.
  await expect.poll(async () => Object.keys((await frame(page)).props)).toEqual(['prop-arm']);
  expect((await frame(page)).props['prop-arm']!.matrices[0]!.slice(12, 15)).toEqual([800, 0, 0]);
  expect(await linkTurn(page)).toBe(0);
  await expect.poll(() => pixels(page)).not.toBe(before);

  // Key the joint at 0 s and 1 s; halfway it is between them.
  await parts.getByRole('button', { name: 'Robot arm', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  await expect(inspector.getByText('A change keys the joint at 0.00 s.')).toBeVisible();
  const angle = inspector.getByLabel('Turn Angle', { exact: true });
  const keys = page.getByRole('group', { name: 'Keys' });
  const jointKeys = keys.getByRole('button', { name: /^Key Robot arm Turn angle at / });
  // Enter keys the value shown even when unchanged (here the saved 0°); again adds nothing.
  await angle.press('Enter');
  await expect(jointKeys).toHaveCount(1);
  await angle.press('Enter');
  await expect(jointKeys).toHaveCount(1);
  await angle.fill('-30');
  await angle.press('Enter');
  await expect.poll(() => linkTurn(page)).toBe(-30);
  await expect(jointKeys).toHaveCount(1);
  await (await tool(page, 'Time', 'slider')).fill('240000');
  await angle.fill('60');
  await angle.press('Enter');
  await expect(jointKeys).toHaveCount(2);
  // The bones' tracks are in the same dope sheet.
  await expect(keys.getByRole('button', { name: /^Key arm\.R rotation at / })).toHaveCount(3);
  await (await tool(page, 'Time', 'slider')).fill('120000');
  await expect.poll(() => linkTurn(page)).toBe(15);
  await expect(angle).toHaveValue('15');
  // Past the version's limit is refused and keys nothing.
  await angle.fill('200');
  await angle.press('Enter');
  await expect(page.getByRole('alert')).toContainText('joint-limit');
  await expect(jointKeys).toHaveCount(2);

  // Playback moves the link with the figure.
  await (await tool(page, 'Play')).click();
  await expect.poll(() => linkTurn(page)).not.toBe(15);
  await (await tool(page, 'Pause')).click();

  // Moving the prop is an edit of it, not a key.
  await inspector.getByLabel('Prop position Y', { exact: true }).fill('400');
  await inspector.getByLabel('Prop position Y', { exact: true }).press('Enter');
  await expect
    .poll(async () => (await frame(page)).props['prop-arm']!.matrices[0]!.slice(12, 15))
    .toEqual([800, 400, 0]);
  await expect(jointKeys).toHaveCount(2);
  // Hiding it keeps its keys.
  await parts.getByRole('checkbox', { name: 'Show Robot arm' }).uncheck();
  await expect.poll(async () => (await frame(page)).props['prop-arm']!.visible).toBe(false);
  await parts.getByRole('checkbox', { name: 'Show Robot arm' }).check();

  // Removing it removes its joint keys in the same edit; Undo brings both back.
  await inspector.getByRole('button', { name: 'Remove prop', exact: true }).click();
  await expect.poll(async () => Object.keys((await frame(page)).props)).toEqual([]);
  await expect(jointKeys).toHaveCount(0);
  await (await tool(page, 'Undo')).click();
  await expect(jointKeys).toHaveCount(2);
  await expect.poll(async () => Object.keys((await frame(page)).props)).toEqual(['prop-arm']);
});
test('props: makes a transform between two forms, replaces its keys after asking, and keys where the prop is (MR4b, TS-1712)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=1');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Robot arm — v1' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await parts.getByRole('button', { name: 'Robot arm', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  const transform = inspector.getByTestId('character-prop-transform');
  const keys = page.getByRole('group', { name: 'Keys' });
  const jointKeys = keys.getByRole('button', { name: /^Key Robot arm Turn angle at / });
  const seek = async (tick: number) => (await tool(page, 'Time', 'slider')).fill(String(tick));

  // From Folded to Open; a form that no longer fits the joints cannot be chosen.
  await expect(
    transform
      .getByLabel('Transform from')
      .getByRole('option', { name: 'Old (does not fit the joints)' }),
  ).toHaveAttribute('disabled', '');
  await transform.getByLabel('Transform from').selectOption({ label: 'Folded' });
  await transform.getByLabel('Transform to').selectOption({ label: 'Open' });
  await expect(transform.getByTestId('character-transform-joint')).toHaveText(['Turn Group 1']);
  // A group past the action's end is refused and keys nothing.
  await transform.getByLabel('Group 1 length (s)').fill('5');
  await transform.getByRole('button', { name: 'Make transform' }).click();
  await expect(transform.getByRole('alert')).toContainText('transform-time');
  await expect(jointKeys).toHaveCount(0);
  await transform.getByLabel('Group 1 start (s)').fill('0.25');
  await transform.getByLabel('Group 1 length (s)').fill('0.5');
  await transform.getByLabel('Group 1 easing').selectOption({ label: 'Linear' });
  await transform.getByRole('button', { name: 'Make transform' }).click();
  await expect(jointKeys).toHaveCount(2);
  await seek(120000);
  await expect.poll(() => linkTurn(page)).toBe(45);
  await seek(48000);
  await expect.poll(() => linkTurn(page)).toBe(0);

  // Made again over the whole second: the two keys inside it are replaced only after asking.
  await transform.getByLabel('Group 1 start (s)').fill('0');
  await transform.getByLabel('Group 1 length (s)').fill('1');
  await transform.getByRole('button', { name: 'Make transform' }).click();
  const ask = transform.getByRole('alertdialog', { name: 'Replace keys' });
  await expect(ask).toContainText('Replaces 2 keys of these joints between 0.00 s and 1.00 s.');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => linkTurn(page)).toBe(0);
  await transform.getByRole('button', { name: 'Make transform' }).click();
  await ask.getByRole('button', { name: 'Replace keys' }).click();
  await expect(ask).toHaveCount(0);
  await expect(jointKeys).toHaveCount(2);
  await expect.poll(() => linkTurn(page)).toBe(18);
  // One edit: Undo brings back the first transform's keys.
  await (await tool(page, 'Undo')).click();
  await expect.poll(() => linkTurn(page)).toBe(0);
  await (await tool(page, 'Redo')).click();
  await expect.poll(() => linkTurn(page)).toBe(18);

  // Keying the placement: from then on a change of position keys it at the playhead.
  const at = async () => (await frame(page)).props['prop-arm']!.matrices[0]!.slice(12, 15);
  await seek(0);
  await expect(inspector.getByTestId('character-prop-placement-keyed')).toHaveCount(0);
  await inspector.getByRole('button', { name: 'Key placement', exact: true }).click();
  await expect(inspector.getByTestId('character-prop-placement-keyed')).toContainText(
    'a change keys it at 0.00 s',
  );
  await expect(keys.getByRole('button', { name: /^Key Robot arm translation at / })).toHaveCount(1);
  await seek(240000);
  const z = inspector.getByLabel('Prop position Z', { exact: true });
  await z.fill('1000');
  await z.press('Enter');
  await expect(keys.getByRole('button', { name: /^Key Robot arm translation at / })).toHaveCount(2);
  await expect.poll(at).toEqual([800, 0, 1000]);
  // Half-way it is half-way up, and the field shows where it is now.
  await seek(120000);
  await expect.poll(at).toEqual([800, 0, 500]);
  await expect(z).toHaveValue('500');
  // A rotation field keys the rotation only: the climb keeps its two keys.
  const rotationKeys = keys.getByRole('button', { name: /^Key Robot arm rotation at / });
  await expect(rotationKeys).toHaveCount(1);
  const turn = inspector.getByLabel('Prop rotation Z', { exact: true });
  await turn.fill('90');
  await turn.press('Enter');
  await expect(rotationKeys).toHaveCount(2);
  await expect(keys.getByRole('button', { name: /^Key Robot arm translation at / })).toHaveCount(2);
});
test('props: updates to another version, refusing tracks it cannot play until they are removed (MR4c, TS-1713)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=1');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Robot arm — v1' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await parts.getByRole('button', { name: 'Robot arm', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  const version = inspector.getByTestId('character-prop-version');
  const keys = page.getByRole('group', { name: 'Keys' });
  const jointKeys = keys.getByRole('button', { name: /^Key Robot arm Turn angle at / });
  const choose = version.getByLabel('Update to version');
  // Only the Artifact's other versions are offered.
  await expect(choose.getByRole('option')).toHaveText(['—', 'Robot arm — v2']);

  // Within v2's ±90° the keys play: updated at once, keys and placement kept.
  const angle = inspector.getByLabel('Turn Angle', { exact: true });
  await angle.fill('60');
  await angle.press('Enter');
  await expect(jointKeys).toHaveCount(1);
  await choose.selectOption({ label: 'Robot arm — v2' });
  await version.getByRole('button', { name: 'Update version' }).click();
  await expect(choose.getByRole('option')).toHaveText(['—', 'Robot arm — v1']);
  await expect(jointKeys).toHaveCount(1);
  await (await tool(page, 'Undo')).click();
  await expect(choose.getByRole('option')).toHaveText(['—', 'Robot arm — v2']);

  // A key past v2's limits refuses the update and is listed; Cancel changes nothing.
  await angle.fill('120');
  await angle.press('Enter');
  await choose.selectOption({ label: 'Robot arm — v2' });
  await version.getByRole('button', { name: 'Update version' }).click();
  const unfit = version.getByRole('alertdialog', { name: 'Unfit tracks' });
  await expect(unfit.getByRole('alert')).toContainText('prop-source-incompatible: 1 track');
  await expect(unfit.getByRole('listitem')).toHaveText([
    /j-turn angle in .*: the key at 0\.00 s is past the joint's limits/,
  ]);
  await unfit.getByRole('button', { name: 'Cancel' }).click();
  await expect(unfit).toHaveCount(0);
  await expect(jointKeys).toHaveCount(1);
  // Removing the unfit track updates in the same edit; Undo brings back both.
  await version.getByRole('button', { name: 'Update version' }).click();
  await unfit.getByRole('button', { name: 'Remove unfit tracks and update' }).click();
  await expect(jointKeys).toHaveCount(0);
  await expect(choose.getByRole('option')).toHaveText(['—', 'Robot arm — v1']);
  await (await tool(page, 'Undo')).click();
  await expect(jointKeys).toHaveCount(1);
  await expect(choose.getByRole('option')).toHaveText(['—', 'Robot arm — v2']);
});
test('props: checks the parts along the action and marks the times they overlap (MR5, TS-1714)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=1');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Robot arm — v1' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await parts.getByRole('button', { name: 'Robot arm', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  const sweep = inspector.getByTestId('character-prop-sweep');
  const status = sweep.getByTestId('character-prop-sweep-status');
  const angle = inspector.getByLabel('Turn Angle', { exact: true });
  // The link turns from 0° to 150° over the second; past 100° it hits the base.
  await angle.press('Enter');
  await (await tool(page, 'Time', 'slider')).fill('240000');
  await angle.fill('150');
  await angle.press('Enter');
  await sweep.getByRole('button', { name: 'Check along the action' }).click();
  await expect(status).toHaveText('Overlaps at 4 of 11 times; the first at 0.70 s.');
  await expect(sweep.getByTestId('character-prop-overlap')).toHaveText([
    'Base and Link: 0.70 s – 1.00 s (intersect, up to 2.0 mm) Go to 0.70 s',
  ]);
  const marks = page.getByRole('group', { name: 'Keys' }).getByRole('button', {
    name: /^Overlaps at /,
  });
  await expect(marks).toHaveCount(4);
  // A mark or the pair's button moves the playhead there.
  await sweep.getByRole('button', { name: 'Go to 0.70 s' }).click();
  await expect(time(page)).toHaveText('0.70 s / 1.00 s');
  await marks.last().click();
  await expect(time(page)).toHaveText('1.00 s / 1.00 s');
  // An edit of the action asks for a new check, and the marks go.
  await angle.fill('90');
  await angle.press('Enter');
  await expect(status).toContainText('changed since the last check');
  await expect(marks).toHaveCount(0);
  await sweep.getByRole('button', { name: 'Check along the action' }).click();
  await expect(status).toContainText('No overlap at the 11 times checked.');
  // More than 600 times is refused before anything is checked.
  await sweep.getByLabel('Check every (s)').fill('0.001');
  await sweep.getByRole('button', { name: 'Check along the action' }).click();
  await expect(sweep.getByRole('alert')).toContainText('sweep-samples: 1001 times');
});
test('props: a transform switches a part to another mount at a set time, checked for jumps (MR7c, TS-1719)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=1');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Robot arm — v1' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await parts.getByRole('button', { name: 'Robot arm', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  const transform = inspector.getByTestId('character-prop-transform');
  const keys = page.getByRole('group', { name: 'Keys' });
  const mountKeys = keys.getByRole('button', { name: /^Key Robot arm Tool mount at / });
  const seek = async (tick: number) => (await tool(page, 'Time', 'slider')).fill(String(tick));
  const tool3 = async () =>
    (await frame(page)).props['prop-arm']!.matrices[2]!.slice(12, 15).map(Math.round);

  // From Holding (the tool at the tip) to Stowed (on the base): the mount switches too.
  await transform.getByLabel('Transform from').selectOption({ label: 'Holding' });
  await transform.getByLabel('Transform to').selectOption({ label: 'Stowed' });
  await expect(transform.getByTestId('character-transform-mount')).toHaveText(
    'Tool: Tip → Base at (s)',
  );
  await transform.getByLabel('Switch Tool at (s)').fill('2');
  await transform.getByRole('button', { name: 'Make transform' }).click();
  await expect(transform.getByRole('alert')).toContainText('transform-switch-time');
  await transform.getByLabel('Switch Tool at (s)').fill('0.5');
  await transform.getByRole('button', { name: 'Make transform' }).click();
  // Held from the start in the tip, then on the base from 0.5 s.
  await expect(mountKeys).toHaveCount(2);
  await seek(110000);
  await expect.poll(tool3).not.toEqual([800, 0, 200]);
  await seek(120000);
  await expect.poll(tool3).toEqual([800, 0, 200]);

  // Switched half-way through the turn, the tool jumps: listed and marked.
  const sweep = inspector.getByTestId('character-prop-sweep');
  await sweep.getByRole('button', { name: 'Check along the action' }).click();
  await expect(sweep.getByTestId('character-prop-sweep-status')).toContainText(
    '1 mount switch moves the part.',
  );
  await expect(sweep.getByTestId('character-prop-jump')).toContainText(
    'Tool: Tip → Base at 0.50 s moves the part',
  );
  await expect(keys.getByRole('button', { name: 'Overlaps and jumps at 0.50 s' })).toHaveCount(1);

  // At the start (0°, the hand-off pose) it does not: made again with the switch left blank.
  await transform.getByLabel('Switch Tool at (s)').fill('');
  await transform.getByRole('button', { name: 'Make transform' }).click();
  await transform
    .getByRole('alertdialog', { name: 'Replace keys' })
    .getByRole('button', { name: 'Replace keys' })
    .click();
  await expect(mountKeys).toHaveCount(1);
  await sweep.getByRole('button', { name: 'Check along the action' }).click();
  await expect(sweep.getByTestId('character-prop-sweep-status')).toHaveText(
    'No overlap at the 11 times checked. An overlap shorter than the interval can be missed.',
  );
  await expect(sweep.getByTestId('character-prop-jump')).toHaveCount(0);

  // A version without the mount cannot play the track: listed until removed.
  const version = inspector.getByTestId('character-prop-version');
  await version.getByLabel('Update to version').selectOption({ label: 'Robot arm — v2' });
  await version.getByRole('button', { name: 'Update version' }).click();
  const unfit = version.getByRole('alertdialog', { name: 'Unfit tracks' });
  await expect(unfit.getByRole('listitem')).toHaveText([
    /mount m-tool in .*: the mount is not in this version/,
  ]);
  await unfit.getByRole('button', { name: 'Remove unfit tracks and update' }).click();
  await expect(mountKeys).toHaveCount(0);
});
test('props: a version the Host could not evaluate is listed but not drawn', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=failed');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Robot arm — v1' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await expect(parts.getByText('Not shown')).toBeVisible();
  expect((await frame(page)).props).toEqual({});
  await parts.getByRole('button', { name: 'Robot arm', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  await expect(inspector.getByText('Not shown: part-build-mismatch')).toBeVisible();
});

/** The share of canvas pixels in the fake arm's orange and amber, from 0 to 1. */
const armShare = (page: Page) =>
  page.evaluate(() => {
    const source = document.querySelector<HTMLCanvasElement>('.character-canvas')!;
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 150;
    const g = c.getContext('2d')!;
    g.drawImage(source, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i] - d[i + 2] > 90) n++;
    return n / (c.width * c.height);
  });
test('props: one whose shape arrives after the first frame is framed when it does', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=late');
  await expect(viewState(page)).toHaveText('Ready');
  // 4 m to the side: outside the figure's framing until the view refits for it.
  await expect.poll(async () => Object.keys((await frame(page)).props)).toEqual(['prop-arm']);
  // Without the refit the arm stays outside the view (no pixel of it).
  await expect.poll(() => armShare(page)).toBeGreaterThan(0.0005);
});

// C3e: mesh edit mode (TS-1224). The test host keeps new mesh assets in memory (?edit=1).
async function addCube(page: Page) {
  const parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Add cube', exact: true }).click();
  await expect.poll(async () => Object.keys((await frame(page)).parts)).toContain('cube');
  return parts;
}
async function editCube(page: Page) {
  const parts = await addCube(page);
  // Adding a part chooses it; its Inspector offers mesh editing.
  await expect(parts.getByRole('button', { name: 'Cube', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Edit mesh', exact: true }).click();
  return inspector;
}
const bounds = async (page: Page) => (await frame(page)).bounds!;

test('binds the cube to a new skeleton with automatic weights, undoes and unbinds (C5b)', async ({
  page,
}) => {
  await page.goto('/?empty=1&edit=1');
  let parts = await addCube(page);
  let inspector = await panel(page, 'Inspector');
  await expect(inspector.getByText('Add a skeleton to bind this part.')).toBeVisible();
  parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Add skeleton', exact: true }).click();
  inspector = await panel(page, 'Inspector');
  await inspector.getByLabel('Rest position Z', { exact: true }).fill('-100');
  await inspector.getByLabel('Rest position Z', { exact: true }).press('Enter');
  await inspector.getByRole('button', { name: 'Add child bone', exact: true }).click();
  parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Cube', exact: true }).click();
  inspector = await panel(page, 'Inspector');
  const before = await bounds(page);
  await inspector.getByRole('button', { name: 'Bind with automatic weights', exact: true }).click();
  await expect(inspector.getByText('Bound to Skeleton')).toBeVisible();
  // At rest the bound cube stays where it was.
  expect(await bounds(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await (await tool(page, 'Undo')).click();
  inspector = await panel(page, 'Inspector');
  await expect(
    inspector.getByRole('button', { name: 'Bind with automatic weights', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await (await tool(page, 'Redo')).click();
  inspector = await panel(page, 'Inspector');
  await expect(inspector.getByText('Bound to Skeleton')).toBeVisible();
  // A weighted bone is not removed while the cube is bound.
  parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Root', exact: true }).click();
  inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Remove skeleton', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('skeleton-in-use');
  parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Cube', exact: true }).click();
  inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Unbind', exact: true }).click();
  await expect(
    inspector.getByRole('button', { name: 'Bind with automatic weights', exact: true }),
  ).toBeVisible();
  expect(await bounds(page)).toEqual(before);
});

test('poses an arm by dragging its IK handle: one edit keys the chain, Undo takes it back (C5d)', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'mobile', 'drags in the view beside both panels');
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  await (await panel(page, 'Parts'))
    .getByRole('button', { name: 'forearm.L', exact: true })
    .click();
  let inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Add IK chain', exact: true }).click();
  const bones = inspector.getByLabel('Chain bones', { exact: true });
  await bones.fill('1');
  await bones.press('Enter');
  await expect(bones).toHaveValue('1');
  const keys = page.getByRole('group', { name: 'Keys' });
  const armKeys = keys.getByRole('button', { name: /^Key arm\.L rotation at / });
  await expect(armKeys).toHaveCount(0);
  const before = JSON.stringify((await frame(page)).bounds);
  // A free chain's handle sits at its tip; dragging it up keys arm.L at the playhead.
  const handle = page.getByTestId('ik-handle-forearm.L/ik');
  const box = (await handle.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 4 });
  // The drag previews the pose its drop keys, before any key is made.
  await expect.poll(async () => JSON.stringify((await frame(page)).bounds)).not.toBe(before);
  const dragged = JSON.stringify((await frame(page)).bounds);
  await expect(armKeys).toHaveCount(0);
  await page.mouse.up();
  await expect(armKeys).toHaveCount(1);
  expect(JSON.stringify((await frame(page)).bounds)).toBe(dragged);
  await expect.poll(async () => JSON.stringify((await frame(page)).bounds)).not.toBe(before);
  await page.keyboard.press('Escape');
  await (await tool(page, 'Undo')).click();
  await expect(armKeys).toHaveCount(0);
  await expect.poll(async () => JSON.stringify((await frame(page)).bounds)).toBe(before);
  // A solving chain pins its tip to the target: dragging its handle moves the target.
  inspector = await panel(page, 'Inspector');
  await inspector.getByLabel('Solve forearm.L IK', { exact: true }).check();
  const z = Number(await inspector.getByLabel('Target Z', { exact: true }).inputValue());
  const solving = (await handle.boundingBox())!;
  const [sx, sy] = [solving.x + solving.width / 2, solving.y + solving.height / 2];
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, sy - 60, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await inspector.getByLabel('Target Z', { exact: true }).inputValue()))
    .toBeGreaterThan(z + 10);
  await expect(armKeys).toHaveCount(0);
});

test('previews an IK drag on a subdivided body too, and Escape cancels it (C5d)', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'mobile', 'drags in the view beside both panels');
  await page.goto('/?edit=1');
  await expect(viewState(page)).toHaveText('Ready');
  await (await panel(page, 'Parts')).getByRole('button', { name: 'Body', exact: true }).click();
  let inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Edit mesh', exact: true }).click();
  const corners = (await frame(page)).parts;
  const before = Object.values(corners)[0]!.positions.length;
  await inspector
    .getByRole('combobox', { name: 'Subdivision levels', exact: true })
    .selectOption('1');
  await expect
    .poll(async () => Object.values((await frame(page)).parts)[0]!.positions.length)
    .toBeGreaterThan(before);
  await inspector.getByRole('button', { name: 'Done', exact: true }).click();
  await (await panel(page, 'Parts'))
    .getByRole('button', { name: 'forearm.L', exact: true })
    .click();
  inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Add IK chain', exact: true }).click();
  await inspector.getByLabel('Chain bones', { exact: true }).fill('1');
  await inspector.getByLabel('Chain bones', { exact: true }).press('Enter');
  await expect(inspector.getByLabel('Chain bones', { exact: true })).toHaveValue('1');
  const rest = JSON.stringify((await frame(page)).bounds);
  const box = (await page.getByTestId('ik-handle-forearm.L/ik').boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 4 });
  await expect.poll(async () => JSON.stringify((await frame(page)).bounds)).not.toBe(rest);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(async () => JSON.stringify((await frame(page)).bounds)).toBe(rest);
  await expect(
    page
      .getByRole('group', { name: 'Keys' })
      .getByRole('button', { name: /^Key arm\.L rotation at / }),
  ).toHaveCount(0);
});

// C6a: morphs (TS-1263). The figure's body has the "Chest wide" morph; the Wave action keys it.
test('sets and keys a morph weight with its slider, and adds, renames and removes a morph (C6a)', async ({
  page,
}, info) => {
  await page.goto('/?edit=1');
  await expect(viewState(page)).toHaveText('Ready');
  await page.getByLabel('Action', { exact: true }).selectOption('');
  await (await panel(page, 'Parts')).getByRole('button', { name: 'Body', exact: true }).click();
  let inspector = await panel(page, 'Inspector');
  const chest = inspector.getByRole('group', { name: 'Morph Chest wide' });
  await expect(chest).toBeVisible();
  const body = async () => JSON.stringify((await frame(page)).parts.body!.positions);
  const before = await body();
  // Without an action the slider sets the weight used at rest: one edit when let go.
  const slider = chest.getByLabel('Weight of Chest wide', { exact: true });
  await slider.focus();
  await page.keyboard.press('End');
  await expect(chest.getByLabel('Weight value of Chest wide', { exact: true })).toHaveValue('1');
  await expect.poll(body).not.toBe(before);
  await page.keyboard.press('Escape');
  await (await tool(page, 'Undo')).click();
  await expect.poll(body).toBe(before);
  if (info.project.name !== 'mobile') {
    // A pointer drag previews the weight; letting go makes it one edit, which Undo takes back.
    await panel(page, 'Inspector');
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, y, { steps: 4 });
    await expect.poll(body).not.toBe(before);
    await page.mouse.up();
    await expect(chest.getByLabel('Weight value of Chest wide', { exact: true })).not.toHaveValue(
      '0',
    );
    await page.keyboard.press('Escape');
    await (await tool(page, 'Undo')).click();
    await expect.poll(body).toBe(before);
  }
  // With an action chosen, a weight typed is keyed at the playhead.
  await page.getByLabel('Action', { exact: true }).selectOption('wave');
  await (await tool(page, 'Time', 'slider')).fill('30000');
  const keys = page.getByRole('group', { name: 'Keys' });
  const chestKeys = keys.getByRole('button', { name: /^Key Chest wide weight at / });
  const count = await chestKeys.count();
  inspector = await panel(page, 'Inspector');
  const value = inspector.getByLabel('Weight value of Chest wide', { exact: true });
  await value.fill('0.3');
  await value.press('Enter');
  await expect(chestKeys).toHaveCount(count + 1);
  await expect(keys.getByRole('button', { name: 'Key Chest wide weight at 0.13 s' })).toBeVisible();
  // A new morph starts with no shape; it can be renamed and removed, each one edit.
  await inspector.getByRole('button', { name: 'Add morph', exact: true }).click();
  await expect(inspector.getByRole('group', { name: 'Morph Morph 2' })).toBeVisible();
  const name = inspector.getByLabel('Name of Morph 2', { exact: true });
  await name.fill('Smile');
  await name.press('Enter');
  const smile = inspector.getByRole('group', { name: 'Morph Smile' });
  await expect(smile).toBeVisible();
  await smile.getByRole('button', { name: 'Remove morph', exact: true }).click();
  await expect(smile).toHaveCount(0);
  await page.keyboard.press('Escape');
  await (await tool(page, 'Undo')).click();
  inspector = await panel(page, 'Inspector');
  await expect(inspector.getByRole('group', { name: 'Morph Smile' })).toBeVisible();
});

// C6b: a morph's shape (TS-1265). Edited with the mesh tools on the cage as the morph makes it.
test("edits the chest morph's shape by moving vertices, leaving the mesh itself as it was (C6b)", async ({
  page,
}) => {
  await page.goto('/?edit=1');
  await expect(viewState(page)).toHaveText('Ready');
  await page.getByLabel('Action', { exact: true }).selectOption('');
  await (await panel(page, 'Parts')).getByRole('button', { name: 'Body', exact: true }).click();
  const positions = async () => (await frame(page)).parts.body!.positions;
  const maxZ = async () => Math.max(...(await positions()).filter((_, i) => i % 3 === 2));
  const p0 = JSON.stringify(await positions());
  // Where the morph takes the body at weight 1.
  let inspector = await panel(page, 'Inspector');
  const weight = inspector.getByLabel('Weight value of Chest wide', { exact: true });
  await weight.fill('1');
  await weight.press('Enter');
  await expect.poll(async () => JSON.stringify(await positions())).not.toBe(p0);
  const p1 = JSON.stringify(await positions());
  const z1 = await maxZ();
  await page.keyboard.press('Escape');
  await (await tool(page, 'Undo')).click();
  await expect.poll(async () => JSON.stringify(await positions())).toBe(p0);
  // Shape editing shows the morph at weight 1 and offers only moving.
  inspector = await panel(page, 'Inspector');
  await inspector
    .getByRole('group', { name: 'Morph Chest wide' })
    .getByRole('button', { name: 'Edit shape', exact: true })
    .click();
  await expect(inspector.getByText('Edit shape · Chest wide · Body')).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Extrude', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'Knife', exact: true })).toHaveCount(0);
  await expect.poll(async () => JSON.stringify(await positions())).toBe(p1);
  await inspector.getByRole('button', { name: 'Vertex', exact: true }).click();
  await inspector.getByRole('button', { name: 'Select all', exact: true }).click();
  await inspector.getByRole('spinbutton', { name: 'Move Z', exact: true }).fill('20');
  await inspector.getByRole('button', { name: 'Move', exact: true }).click();
  await expect.poll(maxZ).toBeCloseTo(z1 + 20, 3);
  await inspector.getByRole('button', { name: 'Done', exact: true }).click();
  // The mesh itself is as it was: at weight 0 the body has not moved.
  await expect.poll(async () => JSON.stringify(await positions())).toBe(p0);
  inspector = await panel(page, 'Inspector');
  await weight.fill('1');
  await weight.press('Enter');
  await expect.poll(maxZ).toBeCloseTo(z1 + 20, 3);
  // Undo takes back the weight, then the shape.
  await page.keyboard.press('Escape');
  await (await tool(page, 'Undo')).click();
  await (await tool(page, 'Undo')).click();
  inspector = await panel(page, 'Inspector');
  await weight.fill('1');
  await weight.press('Enter');
  await expect.poll(async () => JSON.stringify(await positions())).toBe(p1);
});

test('paints weights on the bound cube: a stroke is one edit, Undo takes it back (C5c)', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'mobile', 'drags in the view beside both panels');
  await page.goto('/?empty=1&edit=1');
  let parts = await addCube(page);
  parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Add skeleton', exact: true }).click();
  let inspector = await panel(page, 'Inspector');
  await inspector.getByLabel('Rest position Z', { exact: true }).fill('-100');
  await inspector.getByLabel('Rest position Z', { exact: true }).press('Enter');
  await inspector.getByRole('button', { name: 'Add child bone', exact: true }).click();
  parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Cube', exact: true }).click();
  inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Bind with automatic weights', exact: true }).click();
  await expect(inspector.getByText('Bound to Skeleton')).toBeVisible();
  const before = await bounds(page);
  await inspector.getByRole('button', { name: 'Paint weights', exact: true }).click();
  await expect(inspector.getByText('Weight paint · Cube')).toBeVisible();
  await inspector.getByLabel('Paint bone').selectOption({ label: 'Root' });
  await inspector.getByRole('button', { name: 'Add', exact: true }).click();
  await inspector.getByLabel('Brush radius').fill('30');
  await inspector.getByLabel('Brush strength').fill('100');
  // The dots show Root's weight on the vertices facing the camera.
  const dots = page.locator('[data-testid^="weight-dot-"]');
  await expect.poll(() => dots.count()).toBeGreaterThan(0);
  const total = async () =>
    (await dots.evaluateAll((all) => all.map((d) => Number(d.getAttribute('data-weight'))))).reduce(
      (a, b) => a + b,
      0,
    );
  const start = await total();
  // A stroke on the vertex where Root weighs least (a top corner).
  const low = await dots.evaluateAll(
    (all) =>
      all
        .map((d) => ({
          w: Number(d.getAttribute('data-weight')),
          box: d.getBoundingClientRect(),
        }))
        .sort((a, b) => a.w - b.w)
        .map((d) => [d.box.x + d.box.width / 2, d.box.y + d.box.height / 2, d.w])[0]!,
  );
  const [x, y] = [low[0]!, low[1]!];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 5, y + 5, { steps: 3 });
  // A second finger off the cube neither replaces the stroke nor ends it.
  const region = page.getByRole('region', { name: 'Character view' });
  await region.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = { pointerId: 7, button: 0, bubbles: true, clientX: r.left + 5, clientY: r.top + 5 };
    el.dispatchEvent(new PointerEvent('pointerdown', at));
    el.dispatchEvent(new PointerEvent('pointerup', at));
  });
  await page.mouse.up();
  await expect.poll(total).toBeGreaterThan(start + 0.2);
  // The stroke painted; it did not turn the view or move the cube at rest.
  expect(await bounds(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await (await tool(page, 'Undo')).click();
  await expect.poll(total).toBeCloseTo(start, 2);
  inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Done painting', exact: true }).click();
  await expect(inspector.getByText('Bound to Skeleton')).toBeVisible();
  await expect(dots).toHaveCount(0);
});

test('adds a cube, extrudes the face clicked in the view, and undoes it', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'mobile', 'clicks the view beside both panels');
  await page.goto('/?empty=1&edit=1');
  const inspector = await editCube(page);
  expect(await bounds(page)).toEqual([
    [-100, -100, -100],
    [100, 100, 100],
  ]);
  await inspector.getByRole('button', { name: 'Face', exact: true }).click();
  // The camera looks at the cube's centre from the front (−y): the centre is on the front face.
  const box = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('mesh-selection')).toHaveText(
    /^1 faces selected · 8 vertices · 6 faces/,
  );
  await inspector.getByRole('button', { name: 'Extrude', exact: true }).click();
  await expect.poll(async () => (await bounds(page))[0][1]).toBeCloseTo(-200);
  // The new cap stays selected: extruding again continues outward.
  await expect(page.getByTestId('mesh-selection')).toHaveText(
    /^1 faces selected · 12 vertices · 10 faces/,
  );
  await inspector.getByRole('button', { name: 'Extrude', exact: true }).click();
  await expect.poll(async () => (await bounds(page))[0][1]).toBeCloseTo(-300);
  await (await tool(page, 'Undo')).click();
  await expect.poll(async () => (await bounds(page))[0][1]).toBeCloseTo(-200);
  // The selection was made on the cage Undo replaced: its indices mean nothing here.
  await expect(page.getByTestId('mesh-selection')).toHaveText(/^0 faces selected · 12 vertices/);
  await (await tool(page, 'Undo')).click();
  await expect.poll(async () => (await bounds(page))[0][1]).toBeCloseTo(-100);
  await (await tool(page, 'Redo')).click();
  await expect.poll(async () => (await bounds(page))[0][1]).toBeCloseTo(-200);
  // A click on empty space clears the selection.
  await page.mouse.click(box.x + 8, box.y + 8);
  await expect(page.getByTestId('mesh-selection')).toHaveText(/^0 faces selected/);
});

test('moves every vertex, smooths the cube with subdivision, and refuses a bad extrusion', async ({
  page,
}) => {
  await page.goto('/?empty=1&edit=1');
  const inspector = await editCube(page);
  await inspector.getByRole('button', { name: 'Vertex', exact: true }).click();
  await inspector.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(page.getByTestId('mesh-selection')).toHaveText(/^8 vertices selected/);
  await inspector.getByRole('spinbutton', { name: 'Move Z', exact: true }).fill('50');
  await inspector.getByRole('button', { name: 'Move', exact: true }).click();
  await expect.poll(async () => (await bounds(page))[1][2]).toBeCloseTo(150);
  // Every face of a closed cube has no mean direction: refused, shown, nothing changes.
  await inspector.getByRole('button', { name: 'Face', exact: true }).click();
  await inspector.getByRole('button', { name: 'Select all', exact: true }).click();
  await inspector.getByRole('button', { name: 'Extrude', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'degenerate' })).toBeVisible();
  expect((await bounds(page))[1][2]).toBeCloseTo(150);
  // Two levels of Catmull-Clark: 96 quads drawn (384 corners), pulled in from the cage.
  await inspector
    .getByRole('combobox', { name: 'Subdivision levels', exact: true })
    .selectOption('2');
  await expect.poll(async () => (await frame(page)).parts.cube.positions.length / 3).toBe(384);
  // Smoothed in a worker (C3i, TS-1235), not on the page's thread.
  expect(page.workers().length).toBeGreaterThan(0);
  expect((await bounds(page))[1][2]).toBeLessThan(150);
  expect((await bounds(page))[1][2]).toBeGreaterThan(100);
  await inspector.getByRole('button', { name: 'Done', exact: true }).click();
  const inspector2 = await panel(page, 'Inspector');
  await expect(inspector2.getByRole('button', { name: 'Edit mesh', exact: true })).toBeVisible();
});

// C3g: the move gizmo (TS-1231). A drag along an arrow previews the move and makes it on release.
async function handle(page: Page, axis: 'X' | 'Y' | 'Z') {
  const hit = page.getByRole('button', { name: `Move along ${axis}`, exact: true });
  // Not while the last edit is being kept (the gizmo takes no drag then).
  await expect(hit).toHaveAttribute('aria-disabled', 'false');
  // One read of the arrow and its layer: the gizmo is drawn again after each edit.
  const [x1, y1, x2, y2, left, top] = await hit.evaluate((l) => {
    const r = (l as SVGLineElement).ownerSVGElement!.getBoundingClientRect();
    return [...['x1', 'y1', 'x2', 'y2'].map((a) => Number(l.getAttribute(a))), r.left, r.top];
  });
  const box = { x: left!, y: top! };
  // A point 70% along the arrow, and the arrow's direction on screen.
  const at = [box.x + x1! + 0.7 * (x2! - x1!), box.y + y1! + 0.7 * (y2! - y1!)] as const;
  const l = Math.hypot(x2! - x1!, y2! - y1!);
  return { at, dir: [(x2! - x1!) / l, (y2! - y1!) / l] as const };
}
async function readout(page: Page) {
  const text = page.getByTestId('gizmo-readout');
  await expect(text).toHaveText(/mm$/);
  return Number((await text.textContent())!.match(/[-+][\d.]+/)![0]);
}

test('drags the move gizmo along an axis, cancels with Escape, and undoes the move', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'mobile', 'drags in the view beside both panels');
  await page.goto('/?empty=1&edit=1');
  const inspector = await editCube(page);
  // Nothing selected: no gizmo.
  await expect(page.getByRole('button', { name: 'Move along Z' })).toHaveCount(0);
  await inspector.getByRole('button', { name: 'Face', exact: true }).click();
  const canvas = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await expect(page.getByTestId('mesh-selection')).toHaveText(/^1 faces selected/);
  // The front face (y = −100) moves out along −y: the Y arrow points away from the camera.
  const y = await handle(page, 'Y');
  await page.mouse.move(...y.at);
  await page.mouse.down();
  await page.mouse.move(y.at[0] - 40 * y.dir[0], y.at[1] - 40 * y.dir[1], { steps: 5 });
  const moved = await readout(page);
  expect(moved).toBeLessThan(-5);
  // The document changes only on release.
  expect((await bounds(page))[0][1]).toBeCloseTo(-100);
  await page.mouse.up();
  await expect.poll(async () => (await bounds(page))[0][1]).toBeCloseTo(-100 + moved, 1);
  // The selection is kept, so the gizmo is there for the next drag; Escape drops that one.
  const z = await handle(page, 'Z');
  await page.mouse.move(...z.at);
  await page.mouse.down();
  await page.mouse.move(z.at[0] + 30 * z.dir[0], z.at[1] + 30 * z.dir[1], { steps: 5 });
  expect(await readout(page)).toBeGreaterThan(5);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('gizmo-readout')).toHaveCount(0);
  // Escape only dropped the drag: the Inspector is still open.
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await page.mouse.up();
  expect((await bounds(page))[1][2]).toBeCloseTo(100);
  // A click on an arrow that does not drag is a click on the view: Shift-click on the chosen
  // face (under the X arrow) takes it out of the selection, and the gizmo goes.
  const x = await handle(page, 'X');
  await page.keyboard.down('Shift');
  await page.mouse.click(...x.at);
  await page.keyboard.up('Shift');
  await expect(page.getByTestId('mesh-selection')).toHaveText(/^0 faces selected/);
  await expect(page.getByRole('button', { name: 'Move along X' })).toHaveCount(0);
  expect((await bounds(page))[1][2]).toBeCloseTo(100);
  await (await tool(page, 'Undo')).click();
  await expect.poll(async () => (await bounds(page))[0][1]).toBeCloseTo(-100);
});

test('leaving mesh editing mid-drag drops the move preview', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'drags in the view beside both panels');
  await page.goto('/?empty=1&edit=1');
  const inspector = await editCube(page);
  await inspector.getByRole('button', { name: 'Face', exact: true }).click();
  const canvas = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  const before = await handle(page, 'Y');
  await page.mouse.move(...before.at);
  await page.mouse.down();
  await page.mouse.move(before.at[0] - 40 * before.dir[0], before.at[1] - 40 * before.dir[1], {
    steps: 5,
  });
  expect(await readout(page)).toBeLessThan(-5);
  // Edit mode ends while the button is held (Done, pressed without the mouse).
  await inspector
    .getByRole('button', { name: 'Done', exact: true })
    .evaluate((b) => (b as HTMLButtonElement).click());
  await page.mouse.up();
  await (await panel(page, 'Inspector'))
    .getByRole('button', { name: 'Edit mesh', exact: true })
    .click();
  // Back in: the face is where the document has it, and the arrows start there again.
  const after = await handle(page, 'Y');
  expect(after.at[0]).toBeCloseTo(before.at[0], 0);
  expect(after.at[1]).toBeCloseTo(before.at[1], 0);
  expect((await bounds(page))[0][1]).toBeCloseTo(-100);
});

// C3h: the knife in the view (TS-1233). Points are clicked where the view projects them.
async function clickPoint(page: Page, point: [number, number, number]) {
  const [[x, y]] = await page.evaluate(
    (p) =>
      (
        window as unknown as { characterProject(points: number[]): [number, number, number][] }
      ).characterProject(p),
    point,
  );
  const box = (await page.locator('.character-canvas').boundingBox())!;
  await page.mouse.click(box.x + x!, box.y + y!);
}

test('cuts the front face with the knife, drops a first point with Escape, and undoes the cut', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'mobile', 'clicks the view beside both panels');
  await page.goto('/?empty=1&edit=1');
  const inspector = await editCube(page);
  const count = page.getByTestId('mesh-selection');
  const state = page.getByTestId('knife-state');
  await inspector.getByRole('button', { name: 'Knife', exact: true }).click();
  await expect(state).toHaveText('Pick the first point');
  // The front face (y = −100), from the middle of its top edge to the middle of its bottom one.
  await clickPoint(page, [0, -100, 100]);
  await expect(state).toHaveText('Pick the second point');
  await expect(page.getByTestId('knife-start')).toBeVisible();
  // Escape drops the first point; the knife stays on.
  await page.keyboard.press('Escape');
  await expect(state).toHaveText('Pick the first point');
  await expect(page.getByTestId('knife-start')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  // Escape elsewhere (a field of the Inspector) is that control's: the first point stays.
  await clickPoint(page, [0, -100, 100]);
  await inspector.getByRole('spinbutton', { name: 'Extrude distance', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('knife-start')).toBeVisible();
  await expect(state).toHaveText('Pick the second point');
  // (The shell closes the Inspector on that Escape, as it does for any field: open it again.)
  await panel(page, 'Inspector');
  await clickPoint(page, [0, -100, -100]);
  await expect(count).toHaveText(/· 10 vertices · 7 faces$/);
  await expect(state).toHaveText('Pick the first point');
  // The shape is the same cube: the cut only adds an edge.
  expect(await bounds(page)).toEqual([
    [-100, -100, -100],
    [100, 100, 100],
  ]);
  // Two points with no face in common are refused, and nothing changes.
  await clickPoint(page, [-100, -100, 100]);
  await clickPoint(page, [100, 100, -100]);
  await expect(page.getByRole('alert').filter({ hasText: 'not on one face' })).toBeVisible();
  await expect(count).toHaveText(/· 10 vertices · 7 faces$/);
  await (await tool(page, 'Undo')).click();
  await expect(count).toHaveText(/· 8 vertices · 6 faces$/);
  // Off again: clicks select.
  await inspector.getByRole('button', { name: 'Knife', exact: true }).click();
  await expect(state).toHaveCount(0);
});

/** A solid-colour PNG of `size` × `size` pixels (RGB, no filter). */
function solidPng(size: number, [r, g, b]: [number, number, number]) {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill([r, g, b]).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** The share of canvas pixels that are clearly red, from 0 to 1. */
const redShare = (page: Page) =>
  page.evaluate(() => {
    const source = document.querySelector<HTMLCanvasElement>('.character-canvas')!;
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 150;
    const g = c.getContext('2d')!;
    g.drawImage(source, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i] - d[i + 1] > 60) n++;
    return n / (c.width * c.height);
  });

// C4c: a colour image on a part's material (TS-1240).
test('puts a PNG on the material of the cube, refuses a file that is not an image, removes and undoes', async ({
  page,
}) => {
  await page.goto('/?empty=1&edit=1');
  await addCube(page);
  const inspector = await panel(page, 'Inspector');
  const state = inspector.locator('[data-testid^="material-image-"]');
  await expect(state).toHaveText('No image');
  expect(await redShare(page)).toBeLessThan(0.01);
  const file = inspector.getByLabel(/^Color image for /);
  await file.setInputFiles({
    name: 'red.png',
    mimeType: 'image/png',
    buffer: solidPng(16, [230, 20, 20]),
  });
  await expect(state).toHaveText(/^PNG image · \d+ B$/);
  await expect.poll(() => redShare(page)).toBeGreaterThan(0.05);
  // Not PNG or JPEG (whatever its name says): refused, the image stays.
  await file.setInputFiles({
    name: 'fake.png',
    mimeType: 'image/png',
    buffer: Buffer.from('GIF89a'),
  });
  await expect(page.getByRole('alert')).toHaveText('Choose a PNG or JPEG image.');
  await expect(state).toHaveText(/^PNG image/);
  await inspector.getByRole('button', { name: 'Remove image', exact: true }).click();
  await expect(state).toHaveText('No image');
  await expect.poll(() => redShare(page)).toBeLessThan(0.01);
  await (await tool(page, 'Undo')).click();
  await expect(state).toHaveText(/^PNG image/);
  await expect.poll(() => redShare(page)).toBeGreaterThan(0.05);
});

// C4b: seams and unwrapping in edit mode (TS-1238).
test('marks every edge of the cube as a seam, unwraps it into six islands, and undoes it', async ({
  page,
}) => {
  await page.goto('/?empty=1&edit=1');
  const inspector = await editCube(page);
  const summary = page.getByTestId('uv-summary');
  await expect(summary).toHaveText(/No UVs yet/);
  // A closed cube with no seam cannot lie flat: refused, nothing changes.
  await inspector.getByRole('button', { name: 'Unwrap', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'no seam' })).toBeVisible();
  await expect(summary).toHaveText(/No UVs yet/);
  await inspector.getByRole('button', { name: 'Edge', exact: true }).click();
  await inspector.getByRole('button', { name: 'Select all', exact: true }).click();
  await inspector.getByRole('button', { name: 'Mark seam', exact: true }).click();
  await expect(summary).toHaveText('6 islands · angle distortion 1.00');
  await expect(inspector.getByRole('img', { name: 'UV layout' })).toBeVisible();
  // The selection is kept: the same edges can stop being seams (refused: it would close up).
  await expect(page.getByTestId('mesh-selection')).toHaveText(/^12 edges selected/);
  await inspector.getByRole('button', { name: 'Clear seam', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'no seam' })).toBeVisible();
  await expect(summary).toHaveText('6 islands · angle distortion 1.00');
  await (await tool(page, 'Undo')).click();
  await expect(summary).toHaveText(/No UVs yet/);
});

test('a mesh asset the Host does not keep changes nothing', async ({ page }) => {
  await page.goto('/?empty=1&edit=refuse');
  const parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Add cube', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'asset-store-full' })).toBeVisible();
  expect(Object.keys((await frame(page)).parts)).toEqual([]);
});

test('permission withdrawn while the Host keeps the bytes refuses the edit', async ({ page }) => {
  await page.goto('/?empty=1&edit=revoke');
  const parts = await panel(page, 'Parts');
  await parts.getByRole('button', { name: 'Add cube', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'permission' })).toBeVisible();
  expect(Object.keys((await frame(page)).parts)).not.toContain('cube');
});

test('read only offers no mesh editing', async ({ page }) => {
  await page.goto('/?edit=1&readonly=1');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await expect(parts.getByRole('button', { name: 'Add cube' })).toHaveCount(0);
  await parts.getByRole('button', { name: 'Body', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  await expect(inspector.getByText('Read only.').first()).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Edit mesh' })).toHaveCount(0);
  // Nor morph edits (C6a): the weight shows but does not change.
  await expect(inspector.getByRole('button', { name: 'Add morph' })).toHaveCount(0);
  await expect(inspector.getByLabel('Weight of Chest wide', { exact: true })).toBeDisabled();
});

// C6d (CH60, TS-1271): Export GLB writes the shown document; read only exports too, and the file
// reads back with the same IDs, here and through the Surface's own import.
test('exports the figure as GLB and reads it back with the same IDs (C6d)', async ({ page }) => {
  await page.goto('/?readonly=1');
  await expect(viewState(page)).toHaveText('Ready');
  await (await tool(page, 'Export GLB')).click();
  const file = await page.waitForFunction(
    () =>
      (
        window as unknown as {
          characterExport?: { name: string; bytes: number[]; losses: string[] };
        }
      ).characterExport,
  );
  const exported = (await file.jsonValue())!;
  expect(exported.name).toBe('Blocky figure.glb');
  expect(exported.losses).toEqual(['polygons-triangulated ×66']);
  const inspector = await panel(page, 'Inspector');
  await expect(inspector.getByRole('list', { name: 'Export losses' })).toContainText(
    'polygons-triangulated ×66',
  );
  const bytes = Uint8Array.from(exported.bytes);
  const r = importGltf(bytes);
  expect(r.doc.parts.map((p) => p.id)).toEqual(['body']);
  expect(r.doc.morphs.map((m) => m.id)).toEqual(['chest-wide']);
  expect(r.doc.actions.map((a) => a.id)).toEqual(['wave', 'walk']);

  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  await page.getByLabel('glTF or VRM file').setInputFiles({
    name: exported.name,
    mimeType: 'model/gltf-binary',
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator('.character-status')).toContainText(
    'Blocky figure · 1 parts · 11 bones',
  );
  await expect(viewState(page)).toHaveText('Ready');
  const back = await panel(page, 'Inspector');
  // The boxes' quads were split into triangles: the importer rebuilds normals from triangles,
  // which weigh a corner's faces a little differently, and says so (the shape is the same).
  await expect(back.getByRole('list', { name: 'Import losses' })).toHaveText(
    'authored-normals ×50',
  );
});

test('adds a multires to the cube and sculpts it: a stroke is one edit, Undo takes it back (C7b)', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'mobile', 'drags in the view beside both panels');
  await page.goto('/?empty=1&edit=1');
  await addCube(page);
  let inspector = await panel(page, 'Inspector');
  await inspector.getByLabel('Multires levels').selectOption('4');
  await inspector.getByRole('button', { name: 'Add multires', exact: true }).click();
  await expect(inspector.getByText('Multires level 4')).toBeVisible();
  // A face edit of the cage is refused now; the cage keeps its faces.
  await inspector.getByRole('button', { name: 'Sculpt', exact: true }).click();
  await expect(inspector.getByText('Sculpt · Cube')).toBeVisible();
  // Level 4 of a cube: 6 · 4 · 64 quads, 1,538 vertices.
  await expect(inspector.getByText(/Level 4 · 1,538 vertices/)).toBeVisible();
  await inspector.getByRole('button', { name: 'Inflate', exact: true }).click();
  await inspector.getByLabel('Sculpt radius').fill('60');
  await inspector.getByLabel('Sculpt strength').fill('100');
  const before = await pixels(page);
  const [cx, cy] = await page.evaluate(() => {
    const project = (window as unknown as { characterProject(p: number[]): number[][] })
      .characterProject;
    return project([0, -100, 0])[0]!;
  });
  const region = page.getByRole('region', { name: 'Character view' });
  const box = (await region.boundingBox())!;
  const [x, y] = [box.x + cx!, box.y + cy!];
  await page.mouse.move(x - 20, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => pixels(page)).not.toBe(before);
  const sculpted = await pixels(page);
  // One edit: Undo shows the cube as it was, Redo the stroke again.
  await (await tool(page, 'Undo')).click();
  await expect.poll(() => pixels(page)).toBe(before);
  await (await tool(page, 'Redo')).click();
  await expect.poll(() => pixels(page)).toBe(sculpted);
  // Hiding the part while sculpting hides the sculpted surface too.
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Show Cube').uncheck();
  await expect.poll(() => pixels(page)).not.toBe(sculpted);
  const hidden = await pixels(page);
  await parts.getByLabel('Show Cube').check();
  await expect.poll(() => pixels(page)).toBe(sculpted);
  expect(hidden).not.toBe(before);
  // Hidden, a drag sculpts nothing.
  const chunks = () =>
    page.evaluate(() =>
      JSON.stringify(
        (
          window as unknown as {
            characterSession: { content: { parts: { multires?: { chunks: string[] } }[] } };
          }
        ).characterSession.content.parts[0]!.multires!.chunks,
      ),
    );
  const saved = await chunks();
  await parts.getByLabel('Show Cube').uncheck();
  await page.mouse.move(x - 20, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y, { steps: 6 });
  await page.mouse.up();
  expect(await chunks()).toBe(saved);
  await parts.getByLabel('Show Cube').check();
  inspector = await panel(page, 'Inspector');
  await inspector.getByRole('button', { name: 'Done sculpting', exact: true }).click();
  await expect(inspector.getByText('Multires level 4')).toBeVisible();
  // Raised and removed, each one edit.
  await inspector.getByRole('button', { name: 'Raise level', exact: true }).click();
  await expect(inspector.getByText('Multires level 5')).toBeVisible();
  await inspector.getByRole('button', { name: 'Remove multires', exact: true }).click();
  await expect(inspector.getByRole('button', { name: 'Add multires', exact: true })).toBeVisible();
  await (await tool(page, 'Undo')).click();
  await expect(inspector.getByText('Multires level 5')).toBeVisible();
});

test('sculpt mask, Grab, display level and matcap: the mask and the view are no edit (C7c)', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'mobile', 'drags in the view beside both panels');
  await page.goto('/?empty=1&edit=1');
  await addCube(page);
  const inspector = await panel(page, 'Inspector');
  await inspector.getByLabel('Multires levels').selectOption('3');
  await inspector.getByRole('button', { name: 'Add multires', exact: true }).click();
  await inspector.getByRole('button', { name: 'Sculpt', exact: true }).click();
  await expect(inspector.getByText('Sculpt · Cube')).toBeVisible();
  const chunks = () =>
    page.evaluate(() =>
      JSON.stringify(
        (
          window as unknown as {
            characterSession: { content: { parts: { multires?: { chunks: string[] } }[] } };
          }
        ).characterSession.content.parts[0]!.multires!.chunks,
      ),
    );
  const saved = await chunks();
  const [cx, cy] = await page.evaluate(() => {
    const project = (window as unknown as { characterProject(p: number[]): number[][] })
      .characterProject;
    return project([0, -100, 0])[0]!;
  });
  const box = (await page.getByRole('region', { name: 'Character view' }).boundingBox())!;
  const [x, y] = [box.x + cx!, box.y + cy!];
  const drag = async (dx: number, dy: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
  };
  await inspector.getByLabel('Sculpt radius').fill('60');
  await inspector.getByLabel('Sculpt strength').fill('100');
  const before = await pixels(page);
  // The mask is drawn on the surface, and is not an edit.
  await inspector.getByRole('button', { name: 'Mask', exact: true }).click();
  await drag(20, 0);
  await expect.poll(() => pixels(page)).not.toBe(before);
  expect(await chunks()).toBe(saved);
  await inspector.getByRole('button', { name: 'Clear mask', exact: true }).click();
  await expect.poll(() => pixels(page)).toBe(before);
  // Matcap off: the lit material instead, still no edit.
  await inspector.getByLabel('Matcap shading').uncheck();
  await expect.poll(() => pixels(page)).not.toBe(before);
  await inspector.getByLabel('Matcap shading').check();
  await expect.poll(() => pixels(page)).toBe(before);
  // Grab pulls the surface: one edit, one Undo.
  await inspector.getByRole('button', { name: 'Grab', exact: true }).click();
  await drag(0, -40);
  await expect.poll(chunks).not.toBe(saved);
  await expect.poll(() => pixels(page)).not.toBe(before);
  await (await tool(page, 'Undo')).click();
  await expect.poll(chunks).toBe(saved);
  await expect.poll(() => pixels(page)).toBe(before);
  // A lower display level is a view: the brushes are off and a drag turns the view only.
  await inspector.getByLabel('Display level').selectOption('1');
  await expect(inspector.getByText('Showing level 1. Sculpting works on level 3')).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Grab', exact: true })).toBeDisabled();
  await expect.poll(() => pixels(page)).not.toBe(before);
  await drag(0, -40);
  expect(await chunks()).toBe(saved);
  await inspector.getByLabel('Display level').selectOption('3');
  await expect(inspector.getByRole('button', { name: 'Grab', exact: true })).toBeEnabled();
});

test('bakes the sculpted cube into a normal map on its material: one edit, Undo takes it off (C7d)', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'mobile', 'drags in the view beside both panels');
  test.setTimeout(90_000);
  await page.goto('/?empty=1&edit=1');
  let inspector = await editCube(page);
  await inspector.getByRole('button', { name: 'Done', exact: true }).click();
  inspector = await panel(page, 'Inspector');
  await inspector.getByLabel('Multires levels').selectOption('3');
  await inspector.getByRole('button', { name: 'Add multires', exact: true }).click();
  // No UVs yet: refused, with what to do.
  await inspector.getByLabel('Bake size').selectOption('512');
  await inspector.getByRole('button', { name: 'Bake normal map', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Unwrap the part first' })).toBeVisible();
  // Seams on every edge: the cage unwraps into six islands (the multires keeps its faces).
  await inspector.getByRole('button', { name: 'Edit mesh', exact: true }).click();
  await inspector.getByRole('button', { name: 'Edge', exact: true }).click();
  await inspector.getByRole('button', { name: 'Select all', exact: true }).click();
  await inspector.getByRole('button', { name: 'Mark seam', exact: true }).click();
  await expect(page.getByTestId('uv-summary')).toHaveText(/6 islands/);
  await inspector.getByRole('button', { name: 'Done', exact: true }).click();
  // Sculpt a bump on the front.
  await inspector.getByRole('button', { name: 'Sculpt', exact: true }).click();
  await inspector.getByRole('button', { name: 'Inflate', exact: true }).click();
  await inspector.getByLabel('Sculpt radius').fill('60');
  await inspector.getByLabel('Sculpt strength').fill('100');
  const [cx, cy] = await page.evaluate(() => {
    const project = (window as unknown as { characterProject(p: number[]): number[][] })
      .characterProject;
    return project([0, -100, 0])[0]!;
  });
  const box = (await page.getByRole('region', { name: 'Character view' }).boundingBox())!;
  const [x, y] = [box.x + cx!, box.y + cy!];
  for (const dy of [-15, 0, 15]) {
    await page.mouse.move(x - 30, y + dy);
    await page.mouse.down();
    await page.mouse.move(x + 30, y + dy, { steps: 8 });
    await page.mouse.up();
  }
  await inspector.getByRole('button', { name: 'Done sculpting', exact: true }).click();
  // The sculpt view (matcap) gives way to the part's own material: wait for the frame to settle.
  await expect(inspector.getByRole('button', { name: 'Done sculpting', exact: true })).toHaveCount(
    0,
  );
  let before = await pixels(page);
  await expect
    .poll(async () => {
      const now = await pixels(page);
      const same = now === before;
      before = now;
      return same;
    })
    .toBe(true);
  const maps = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          characterSession: { content: { materials: { maps: Record<string, string> }[] } };
        }
      ).characterSession.content.materials.map((m) => m.maps.normal ?? null),
    );
  expect(await maps()).toEqual([null]);
  await inspector.getByLabel('Bake size').selectOption('512');
  await inspector.getByRole('button', { name: 'Bake normal map', exact: true }).click();
  await expect(page.getByTestId('bake-report')).toHaveText(/^Baked 512 × 512/, {
    timeout: 60_000,
  });
  expect((await maps())[0]).toMatch(/normal/);
  // The cage drawn with the map shows the bump.
  await expect.poll(() => pixels(page)).not.toBe(before);
  await (await tool(page, 'Undo')).click();
  await expect.poll(maps).toEqual([null]);
  await expect.poll(() => pixels(page)).toBe(before);
});

/** The share of a PNG's pixels in the figure's blue (its body colour), decoded by the browser. */
const pngBodyShare = (page: Page, png: Uint8Array) =>
  page.evaluate(
    async (bytes) => {
      const image = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const c = new OffscreenCanvas(image.width, image.height);
      const g = c.getContext('2d')!;
      g.drawImage(image, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 120 && d[i + 2] - d[i] > 60) n++;
      return { width: image.width, height: image.height, share: n / (c.width * c.height) };
    },
    [...png],
  );
const media = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { characterMedia?: { name: string; type: string; bytes: number[] } })
        .characterMedia,
  );

// C8a (ST-157#2): Video exports Wave's frames as PNGs in a ZIP at the chosen size and rate (read
// only too: nothing is edited), the view comes back as it was, and a cancel saves nothing.
test('exports an action as a PNG sequence and cancels an export (C8a, TS-1292)', async ({
  page,
}) => {
  await page.goto('/?readonly=1');
  await expect(viewState(page)).toHaveText('Ready');
  const inspector = await panel(page, 'Inspector');
  // The view as it is with the Inspector open (on a phone it lays the view out again).
  await expect
    .poll(async () => {
      const a = await pixels(page);
      await page.waitForTimeout(200);
      return a === (await pixels(page));
    })
    .toBe(true);
  const before = await pixels(page);
  const video = inspector.getByRole('group', { name: 'Video export' });
  await expect(video.getByLabel('Export action')).toHaveValue('wave');
  await expect(video.getByLabel('To (s)')).toHaveValue('1');
  await video.getByLabel('Size').selectOption('custom');
  await video.getByLabel('Width').fill('321');
  await expect(video.getByRole('list', { name: 'Video settings problems' })).toContainText(
    'Width must be an even number of pixels from 16 to 4096.',
  );
  await expect(video.getByRole('button', { name: 'Export frames' })).toBeDisabled();
  await video.getByLabel('Width').fill('320');
  await video.getByLabel('Height').fill('180');
  await video.getByLabel('To (s)').fill('0.5');
  await expect(video).toContainText('15 frames');
  await video.getByRole('button', { name: 'Export frames' }).click();
  await expect(video.getByTestId('video-report')).toHaveText(
    'Blocky figure Wave.zip: 15 frames, 320 × 180, 30 fps.',
  );
  const file = (await media(page))!;
  expect(file).toMatchObject({ name: 'Blocky figure Wave.zip', type: 'application/zip' });
  const files = unzipSync(Uint8Array.from(file.bytes));
  const names = Object.keys(files);
  expect(names).toHaveLength(15);
  expect(names[0]).toBe('frame-00001.png');
  expect(names.at(-1)).toBe('frame-00015.png');
  const first = await pngBodyShare(page, files['frame-00001.png']!);
  const last = await pngBodyShare(page, files['frame-00015.png']!);
  expect(first).toMatchObject({ width: 320, height: 180 });
  expect(first.share).toBeGreaterThan(0.01);
  expect(last.share).toBeGreaterThan(0.01);
  // Wave raises the arm: the frames are of different poses.
  expect(
    Buffer.from(files['frame-00001.png']!).equals(Buffer.from(files['frame-00015.png']!)),
  ).toBe(false);
  // The view draws its own playhead at its own size again.
  await expect(page.locator('.character-canvas-capturing')).toHaveCount(0);
  await expect.poll(() => pixels(page)).toBe(before);

  // A long export at 1080p, cancelled while it runs: nothing reaches the Host.
  await page.evaluate(
    () => delete (window as unknown as { characterMedia?: unknown }).characterMedia,
  );
  await video.getByLabel('Size').selectOption('1080p');
  await video.getByLabel('To (s)').fill('1');
  await video.getByLabel('Frame rate').selectOption('60');
  await video.getByRole('button', { name: 'Export frames' }).click();
  await expect(video.getByRole('status')).toContainText('Exporting frames…');
  await video.getByRole('button', { name: 'Cancel export' }).click();
  await expect(video.getByTestId('video-report')).toHaveText(
    'Export cancelled; nothing was saved.',
  );
  expect(await media(page)).toBeUndefined();
  await expect.poll(() => pixels(page)).toBe(before);

  // While an export runs nothing edits the document: Undo is off and an edit is refused.
  await page.goto('/');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Show Body').uncheck();
  await parts.getByLabel('Show Body').check();
  const editable = (await panel(page, 'Inspector')).getByRole('group', { name: 'Video export' });
  await editable.getByLabel('Size').selectOption('1080p');
  await editable.getByLabel('Frame rate').selectOption('60');
  await editable.getByRole('button', { name: 'Export frames' }).click();
  await expect(editable.getByRole('status')).toContainText('Exporting frames…');
  await expect(await tool(page, 'Undo')).toBeDisabled();
  await (await panel(page, 'Parts')).getByLabel('Show Body').click();
  await expect(page.getByRole('alert')).toContainText('video-export-running');
  await expect((await panel(page, 'Parts')).getByLabel('Show Body')).toBeChecked();
  await (await panel(page, 'Inspector'))
    .getByRole('group', { name: 'Video export' })
    .getByRole('button', { name: 'Cancel export' })
    .click();
  await expect(editable.getByTestId('video-report')).toHaveText(
    'Export cancelled; nothing was saved.',
  );
  await expect(await tool(page, 'Undo')).toBeEnabled();

  // The graphics context lost mid-export: the frames already drawn are dropped, not saved blank.
  await page.evaluate(
    () => delete (window as unknown as { characterMedia?: unknown }).characterMedia,
  );
  await editable.getByRole('button', { name: 'Export frames' }).click();
  await expect(editable.getByRole('status')).toContainText('Exporting frames…');
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.character-canvas')!;
    canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect(editable.getByTestId('video-report')).toContainText(
    'The graphics context was lost during the export',
  );
  expect(await media(page)).toBeUndefined();
});

// C8b (ST-158#2): Export video encodes Wave with H.264 (WebCodecs) into an MP4 that ffprobe and
// the video importer read: 30 frames at 30 fps over one second, the figure in the first frame.
test('exports an action as an H.264 MP4 that ffprobe and the importer read (C8b, TS-1294)', async ({
  page,
}, info) => {
  await page.goto('/?readonly=1');
  await expect(viewState(page)).toHaveText('Ready');
  const inspector = await panel(page, 'Inspector');
  const video = inspector.getByRole('group', { name: 'Video export' });
  await video.getByLabel('Size').selectOption('custom');
  await video.getByLabel('Width').fill('320');
  await video.getByLabel('Height').fill('180');
  await video.getByRole('button', { name: 'Export video' }).click();
  await expect(video.getByTestId('video-report')).toHaveText(
    'Blocky figure Wave.mp4: 30 frames, 320 × 180, 30 fps.',
  );
  const file = (await media(page))!;
  expect(file).toMatchObject({ name: 'Blocky figure Wave.mp4', type: 'video/mp4' });
  const bytes = Uint8Array.from(file.bytes);
  const set = (await inspectVideoFile(new Blob([bytes]), new AbortController().signal)).plan;
  expect(set.streams.map((s) => s.kind)).toEqual(['video']);
  const path = info.outputPath('wave.mp4');
  writeFileSync(path, bytes);
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      path,
    ]).toString(),
  ) as {
    streams: {
      codec_name: string;
      width: number;
      height: number;
      nb_read_frames: string;
      r_frame_rate: string;
    }[];
    format: { duration: string };
  };
  expect(probe.streams).toHaveLength(1);
  expect(probe.streams[0]).toMatchObject({
    codec_name: 'h264',
    width: 320,
    height: 180,
    nb_read_frames: '30',
    r_frame_rate: '30/1',
  });
  expect(Number(probe.format.duration)).toBeCloseTo(1, 3);
  const still = info.outputPath('first.png');
  execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-y', still]);
  const first = await pngBodyShare(page, readFileSync(still));
  expect(first).toMatchObject({ width: 320, height: 180 });
  expect(first.share).toBeGreaterThan(0.01);

  // A lost graphics context mid-encode drops the video instead of encoding blank frames.
  await page.evaluate(
    () => delete (window as unknown as { characterMedia?: unknown }).characterMedia,
  );
  await video.getByLabel('Size').selectOption('1080p');
  await video.getByLabel('Frame rate').selectOption('60');
  await video.getByRole('button', { name: 'Export video' }).click();
  await expect(video.getByRole('status')).toContainText('Exporting video…');
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.character-canvas')!;
    canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect(video.getByTestId('video-report')).toContainText(
    'The graphics context was lost during the export',
  );
  expect(await media(page)).toBeUndefined();
});

// C8c (ST-160#1): Render image path traces the figure at the playhead (the dialog of CAD and the
// building) and hands the PNG to the Host; a long render is cancelled and nothing is kept.
test('renders a path-traced still of the figure at the playhead (C8c, TS-1298)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  // Software WebGL (no GPU) compiles the path-tracing shader for about a minute.
  test.setTimeout(480_000);
  await page.goto('/?readonly=1');
  await expect(viewState(page)).toHaveText('Ready');
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
  await dialog.getByRole('button', { name: 'Save PNG' }).click();
  await expect.poll(() => media(page)).toBeDefined();
  const file = (await media(page))!;
  expect(file).toMatchObject({ name: 'Blocky figure Wave-render.png', type: 'image/png' });
  const png = Buffer.from(file.bytes);
  expect(png.readUInt32BE(16)).toBe(160);
  expect(png.readUInt32BE(20)).toBe(100);
  expect((await pngBodyShare(page, Uint8Array.from(file.bytes))).share).toBeGreaterThan(0.01);
  await page.evaluate(
    () => delete (window as unknown as { characterMedia?: unknown }).characterMedia,
  );
  await dialog.getByLabel('Samples').fill('4096');
  await dialog.getByRole('button', { name: 'Render again' }).click();
  await expect(dialog.getByTestId('view-render-progress')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByTestId('view-render-progress')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await media(page)).toBeUndefined();
  await expect(viewState(page)).toHaveText('Ready');
});
test('props: makes a watch escapement as joint keys, replaced after asking (WM4, TS-1895)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=1');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Watch movement — v1' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await parts.getByRole('button', { name: 'Watch movement', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  const escapement = inspector.getByTestId('character-prop-escapement');
  const keys = page.getByRole('group', { name: 'Keys' });
  const balanceKeys = keys.getByRole('button', { name: /^Key Watch movement Balance angle at / });
  const seek = async (tick: number) => (await tool(page, 'Time', 'slider')).fill(String(tick));
  // The drawn turn of the balance (0), fork (1), escape wheel (2) and seconds hand (3), in degrees.
  const turn = async (i: number) => {
    const m = (await frame(page)).props['prop-watch']!.matrices[i]!;
    return Math.round((Math.atan2(m[1]!, m[0]!) * 180) / Math.PI);
  };
  await expect(escapement.getByLabel('Balance')).toHaveValue('j-balance');
  await expect(escapement.getByLabel('Pallet fork')).toHaveValue('j-fork');
  await expect(escapement.getByLabel('Escape wheel')).toHaveValue('j-escape');

  // A lift angle past twice the amplitude is refused and keys nothing.
  await escapement.getByLabel('Lift angle (°)').fill('600');
  await escapement.getByRole('button', { name: 'Make escapement' }).click();
  await expect(escapement.getByRole('alert')).toContainText('escapement-lift');
  await expect(balanceKeys).toHaveCount(0);
  // A wheel started at 2,150° drives the seconds hand past its ±180° on the way: refused.
  await escapement.getByLabel('Lift angle (°)').fill('52');
  await escapement.getByLabel('Escape start (°)').fill('2150');
  await escapement.getByRole('button', { name: 'Make escapement' }).click();
  await expect(escapement.getByRole('alert')).toContainText(
    'escapement-follower-limit: j-hand angle follows these joints and would pass its limits at 0.',
  );
  await expect(balanceKeys).toHaveCount(0);
  // The defaults over the one-second action: 8 beats at 28,800 an hour.
  await escapement.getByLabel('Escape start (°)').fill('');
  await escapement.getByRole('button', { name: 'Make escapement' }).click();
  await expect(escapement.getByRole('status')).toHaveText('Made 8 beats from 0.00 s to 1.00 s.');
  await expect(balanceKeys).toHaveCount(17);
  // At the start the balance is at its −280° extreme, the fork on its −10° side.
  await seek(0);
  await expect.poll(() => turn(0)).toBe(80);
  await expect.poll(() => turn(1)).toBe(-10);
  // After the first beat (1/8 s) the balance is at its other extreme, the fork has switched and
  // the escape wheel has advanced half a tooth of 20 (9°); the hand follows at 1/12.
  await seek(30000);
  await expect.poll(() => turn(0)).toBe(-80);
  await expect.poll(() => turn(1)).toBe(10);
  await expect.poll(() => turn(2)).toBe(9);
  // At the end: 8 half teeth (72°), the hand 6° back.
  await seek(240000);
  await expect.poll(() => turn(2)).toBe(72);
  await expect.poll(() => turn(3)).toBe(-6);

  // Made again at 21,600 an hour: its 51 keys are replaced only after asking; one edit.
  await escapement.getByLabel('Beats per hour').fill('21600');
  await escapement.getByRole('button', { name: 'Make escapement' }).click();
  const ask = escapement.getByRole('alertdialog', { name: 'Replace keys' });
  await expect(ask).toContainText('Replaces 51 keys of these joints between 0.00 s and 1.00 s.');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(balanceKeys).toHaveCount(17);
  await escapement.getByRole('button', { name: 'Make escapement' }).click();
  await ask.getByRole('button', { name: 'Replace keys' }).click();
  await expect(escapement.getByRole('status')).toHaveText('Made 6 beats from 0.00 s to 1.00 s.');
  await expect(balanceKeys).toHaveCount(13);
  // 6 half teeth: 54°.
  await expect.poll(() => turn(2)).toBe(54);
  await (await tool(page, 'Undo')).click();
  await expect(balanceKeys).toHaveCount(17);
  await expect.poll(() => turn(2)).toBe(72);
  await (await tool(page, 'Redo')).click();
  await expect.poll(() => turn(2)).toBe(54);

  // A transform that drives the hand past its limits on the way is refused too (MR4), and keys
  // nothing.
  const transform = inspector.getByTestId('character-prop-transform');
  const escapeKeys = keys.getByRole('button', {
    name: /^Key Watch movement Escape wheel angle at /,
  });
  const before = await escapeKeys.count();
  await transform.getByLabel('Transform from').selectOption({ label: 'At rest' });
  await transform.getByLabel('Transform to').selectOption({ label: 'Turned far' });
  await transform.getByRole('button', { name: 'Make transform' }).click();
  const replace = transform.getByRole('alertdialog', { name: 'Replace keys' });
  if (await replace.isVisible())
    await replace.getByRole('button', { name: 'Replace keys' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'joint-limit: j-hand angle' }),
  ).toBeVisible();
  await expect(escapeKeys).toHaveCount(before);
});

test('props: checks the figure as an occupant of a prop, and draws the check’s lines (CR7d, TS-1818)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=1');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Robot arm — v1' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await parts.getByRole('button', { name: 'Robot arm', exact: true }).click();
  const inspector = await panel(page, 'Inspector');
  // The arm's base (300 mm square, 200 tall) 100 mm over the head's top (z 1690).
  const place = async (axis: 'X' | 'Y' | 'Z', v: number) => {
    const f = inspector.getByLabel(`Prop position ${axis}`, { exact: true });
    await f.fill(String(v));
    await f.press('Enter');
  };
  await place('X', 0);
  await place('Y', 0);
  await place('Z', 1790);
  const occupant = inspector.getByTestId('character-occupant');
  await expect(occupant.getByLabel('Head bone', { exact: true })).toHaveValue('head');
  await expect(occupant.getByLabel('Hip bone', { exact: true })).toHaveValue('hip');
  await occupant.getByLabel('Seat part', { exact: true }).selectOption({ label: 'Base' });
  // The hip (z 950) in the base's own coordinates.
  await occupant.getByLabel('H-point in the seat part (mm) z', { exact: true }).fill('-830');
  const before = await pixels(page);
  await occupant.getByRole('button', { name: 'Check the occupant', exact: true }).click();
  const status = occupant.getByTestId('character-occupant-status');
  await expect(status).toHaveText('The figure overlaps no part of the prop.');
  await expect(occupant.getByTestId('character-occupant-headroom')).toHaveText(
    'Headroom: 100.0 mm up to Base.',
  );
  await expect(occupant.getByTestId('character-occupant-hpoint')).toHaveText(
    'H-point to the hip: 10.0 mm (x 0.0, y 0.0, z -10.0).',
  );
  await expect(occupant.getByTestId('character-occupant-sight')).toHaveText(
    'Sight line: meets nothing within 5000.0 mm.',
  );
  // The lines are drawn over the view.
  await expect.poll(() => pixels(page)).not.toBe(before);
  // Another part selected and the arm again: the panel shows the inputs of the result it keeps.
  await parts.getByRole('button', { name: 'Body', exact: true }).click();
  await parts.getByRole('button', { name: 'Robot arm', exact: true }).click();
  await expect(occupant.getByLabel('Seat part', { exact: true })).toHaveValue(/.+/);
  await expect(occupant.getByLabel('H-point in the seat part (mm) z', { exact: true })).toHaveValue(
    '-830',
  );
  await expect(occupant.getByTestId('character-occupant-hpoint')).toHaveText(
    'H-point to the hip: 10.0 mm (x 0.0, y 0.0, z -10.0).',
  );
  // Changing an input drops the result (and its lines): the report answers the inputs shown.
  await occupant.getByLabel('Seat part', { exact: true }).selectOption({ label: 'No H-point' });
  await expect(occupant.getByTestId('character-occupant-measures')).toHaveCount(0);
  await expect(status).toHaveText(
    'Checks the figure as posed now against the prop’s parts, on their display meshes.',
  );
  await occupant.getByLabel('Seat part', { exact: true }).selectOption({ label: 'Base' });
  await occupant.getByRole('button', { name: 'Check the occupant', exact: true }).click();
  await expect(occupant.getByTestId('character-occupant-hpoint')).toHaveText(
    'H-point to the hip: 10.0 mm (x 0.0, y 0.0, z -10.0).',
  );
  // Lowered onto the head, the base overlaps it; the old result is stale until checked again.
  await place('Z', 1600);
  await expect(status).toHaveText(
    'The pose, the time or the document changed since the last check: check again.',
  );
  await occupant.getByRole('button', { name: 'Check the occupant', exact: true }).click();
  await expect(status).toHaveText('The figure overlaps 1 part of the prop.');
  await expect(occupant.getByTestId('character-occupant-overlap')).toHaveText(
    /^Base \(intersect, about \d+\.\d mm\)$/,
  );
  // A bad coordinate is refused.
  await occupant.getByLabel('Eye looks along y', { exact: true }).fill('a');
  await occupant.getByRole('button', { name: 'Check the occupant', exact: true }).click();
  await expect(occupant.getByRole('alert')).toHaveText(
    'occupant-input: every coordinate must be a number (mm).',
  );
});

test('props: refuses the occupant check when the figure’s assets do not read (CR7d, TS-1818)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/?props=1&broken=1');
  const parts = await panel(page, 'Parts');
  await parts.getByLabel('Prop version').selectOption({ label: 'Robot arm — v1' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  await parts.getByRole('button', { name: 'Robot arm', exact: true }).click();
  const occupant = (await panel(page, 'Inspector')).getByTestId('character-occupant');
  await expect(occupant.getByTestId('character-occupant-status')).toHaveText(
    'The figure’s assets could not be read: it cannot be checked.',
  );
  await expect(
    occupant.getByRole('button', { name: 'Check the occupant', exact: true }),
  ).toBeDisabled();
});
