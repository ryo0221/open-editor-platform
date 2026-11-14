// GV3c / GV4c (docs/cad/gulliver-world.md): Gulliver (F107), a Lilliputian (F108), a
// Brobdingnagian (F114) and Glumdalclitch (F115), each built at its own height, open and walk in
// the ordinary Playground's character editor. GULLIVER_OUT names a folder for the screenshots.
import type { CharacterDocument } from '@editor-platform/character-core';
import type { Page } from '@playwright/test';
import {
  f107Gulliver,
  f108Lilliputian,
  f114Brobdingnagian,
  f115Glumdalclitch,
  type PeopleFixture,
} from '../../scripts/fixtures/gulliver-people';
import { create, expect, nativeArtifact, test } from './fixtures';

const out = process.env.GULLIVER_OUT;
const viewState = (page: Page) => page.getByTestId('character-view-state');
const status = (page: Page) => page.locator('.character-status');

async function open(page: Page, f: PeopleFixture) {
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const starter = await nativeArtifact(page);
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  const resources = f.doc.assets.map((ref) => {
    const bytes = f.assets.get(ref.id)!;
    return {
      kind: ref.kind,
      sha256: ref.sha256,
      byteLength: ref.byteLength,
      mediaType: ref.mediaType,
      encoding: 'base64',
      bytes: Buffer.from(bytes).toString('base64'),
    };
  });
  await input.setInputFiles({
    name: `${f.doc.name}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        ...starter,
        name: f.doc.name,
        draft: { ...starter.draft, content: f.doc },
        cadResources: resources,
      }),
    ),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(f.doc.name);
  await expect(viewState(page)).toHaveText('Ready');
  await expect(status(page)).toContainText('15 bones');
}

for (const [make, height, ids] of [
  [f107Gulliver, 1750, 'ST-646, TS-2312'],
  [f108Lilliputian, 146, 'ST-646, TS-2312'],
  // GV4c: a Brobdingnagian farmer (F114) and Glumdalclitch (F115).
  [f114Brobdingnagian, 21_000, 'ST-649, TS-2318'],
  [f115Glumdalclitch, 12_000, 'ST-649, TS-2318'],
] as const)
  test(`a ${height} mm figure opens and walks (${ids})`, async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop flow');
    const f = make();
    await open(page, f);
    const doc = (await nativeArtifact(page)).draft.content as CharacterDocument;
    expect(doc.skeletons[0]!.bones.find((b) => b.name === 'hip')!.rest.translation[2]).toBeCloseTo(
      0.53 * height,
      6,
    );
    await page
      .getByRole('combobox', { name: 'Action', exact: true })
      .selectOption({ label: 'Walk' });
    const time = page.getByRole('group', { name: 'Playback', exact: true }).getByLabel('Time');
    await time.fill(String(Math.round(0.3 * 240_000)));
    await expect(viewState(page)).toHaveText('Ready');
    if (out)
      await page.locator('.character-canvas').screenshot({ path: `${out}/walk-${height}.png` });
  });
