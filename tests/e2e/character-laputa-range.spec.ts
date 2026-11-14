// GV2c (docs/cad/gulliver-world.md): a building-sized prop raised four miles (6.4 km, Laputa's
// greatest height, Part III ch. 3) on its translation track and filmed from a camera keyed
// 10 km out, with the tracks that already exist. Pictures to look at, not a measurement.
import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { bimStarter, type BimDocument } from '@editor-platform/bim-core';
import type { CharacterDocument } from '@editor-platform/character-core';
import { create, expect, nativeArtifact, save, test } from './fixtures';

const viewState = (page: Page) => page.getByTestId('character-view-state');
async function panel(page: Page, name: 'Parts' | 'Inspector') {
  const region = page.getByRole('complementary', { name, exact: true });
  if (!(await region.isVisible()))
    await page.getByRole('button', { name: `Toggle ${name}`, exact: true }).click();
  return region;
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
/** A stand-in for the island: one slab 1.8 km square (BIM keeps within ±1 km). */
function plate(): BimDocument {
  const doc = bimStarter();
  doc.project.name = 'Island stand-in';
  doc.elements = [
    {
      id: 's-plate',
      kind: 'slab',
      typeId: 't-slab-200',
      top: { level: 'l-1f', offsetMm: 0 },
      boundary: [
        [-900_000, -900_000],
        [900_000, -900_000],
        [900_000, 900_000],
        [-900_000, 900_000],
      ],
      holes: [],
    },
  ];
  return doc;
}
const fourMilesMm = 4 * 1_609_344;

test('a 1.8 km prop rises four miles, filmed from 10 km out (ST-643, TS-2306)', async ({
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
  await importArtifact(page, 'plate.json', {
    ...empty,
    name: 'Island stand-in',
    draft: { ...empty.draft, content: plate() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Island stand-in');
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 90_000,
  });
  await save(page, 1);

  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const parts = await panel(page, 'Parts');
  await parts
    .getByLabel('Prop version')
    .selectOption({ label: 'Island stand-in — v1 (Manual save)' });
  await parts.getByRole('button', { name: 'Add prop', exact: true }).click();
  const props = parts.getByRole('list', { name: 'Props' });
  await expect(props.getByRole('button', { name: 'Island stand-in', exact: true })).toBeVisible({
    timeout: 120_000,
  });
  await expect(props.locator('.character-prop-state')).toHaveCount(0, { timeout: 120_000 });

  // The rise and the camera, written as keys on the Wave action and imported back.
  const record = await nativeArtifact(page);
  const doc = structuredClone(record.draft.content as CharacterDocument);
  const wave = doc.actions.find((a) => a.name === 'Wave')!;
  const lin = { type: 'linear' as const };
  const id = doc.props[0]!.id;
  doc.props[0]!.placement.translation = [0, 0, 0];
  wave.tracks.push(
    {
      id: 'gv2c/rise',
      target: { kind: 'prop', id, property: 'translation' },
      keys: [
        { id: 'gv2c/rise#0', tick: 0, value: [0, 0, 0], easing: lin },
        { id: 'gv2c/rise#1', tick: wave.duration, value: [0, 0, fourMilesMm], easing: lin },
      ],
    },
    {
      id: 'gv2c/camera',
      target: { kind: 'camera', property: 'position' },
      keys: [{ id: 'gv2c/camera#0', tick: 0, value: [0, -10_000_000, 3_200_000], easing: lin }],
    },
    {
      id: 'gv2c/look',
      target: { kind: 'camera', property: 'target' },
      keys: [{ id: 'gv2c/look#0', tick: 0, value: [0, 0, 3_200_000], easing: lin }],
    },
  );
  await importArtifact(page, 'laputa.json', {
    ...record,
    name: 'Laputa rise',
    draft: { ...record.draft, content: doc },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Laputa rise');
  await expect(viewState(page)).toHaveText('Ready');
  await expect(
    (await panel(page, 'Parts'))
      .getByRole('list', { name: 'Props' })
      .locator('.character-prop-state'),
  ).toHaveCount(0, { timeout: 120_000 });
  const transport = page.getByRole('group', { name: 'Playback', exact: true });
  await transport.getByLabel('Action').selectOption({ label: 'Wave' });
  const inspector = await panel(page, 'Inspector');
  await expect(
    inspector.getByRole('group', { name: 'Action camera' }).getByTestId('camera-keyed'),
  ).toHaveText(/filmed through/);
  const out = process.env.GULLIVER_OUT ?? info.outputPath('gv2c');
  mkdirSync(out, { recursive: true });
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
  const time = transport.getByLabel('Time');
  await time.press('Home');
  const ground = await settled();
  await page.locator('.character-canvas').screenshot({ path: `${out}/far-ground.png` });
  await time.press('End');
  const risen = await settled();
  await page.locator('.character-canvas').screenshot({ path: `${out}/far-risen.png` });
  // Seen from 10 km, the island has moved between the first and the last frame.
  expect(risen).not.toBe(ground);
  const probe = await page.evaluate(
    () =>
      (window as unknown as { characterProbe: { props: Record<string, number[][]> } })
        .characterProbe.props,
  );
  const bounds = Object.values(probe)[0]!;
  expect(bounds[0]![2]).toBeGreaterThan(fourMilesMm - 1_000);
});
