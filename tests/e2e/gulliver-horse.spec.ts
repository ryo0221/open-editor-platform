// GV6b (docs/cad/gulliver-world.md): a Houyhnhnm on four legs with IK chains (F121) and a Yahoo
// (F122) open and walk in the ordinary Playground's character editor. GULLIVER_OUT names a folder
// for the screenshots.
import type { CharacterDocument } from '@editor-platform/character-core';
import type { Page } from '@playwright/test';
import { f121Houyhnhnm, f122Yahoo } from '../../scripts/fixtures/gulliver-horse';
import type { PeopleFixture } from '../../scripts/fixtures/gulliver-people';
import { create, expect, nativeArtifact, test } from './fixtures';

const out = process.env.GULLIVER_OUT;
const viewState = (page: Page) => page.getByTestId('character-view-state');
const status = (page: Page) => page.locator('.character-status');

async function open(page: Page, f: PeopleFixture, bones: number) {
  await page.goto('/');
  await create(page, 'character');
  await expect(viewState(page)).toHaveText('Ready');
  const starter = await nativeArtifact(page);
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  const resources = f.doc.assets.map((ref) => ({
    kind: ref.kind,
    sha256: ref.sha256,
    byteLength: ref.byteLength,
    mediaType: ref.mediaType,
    encoding: 'base64',
    bytes: Buffer.from(f.assets.get(ref.id)!).toString('base64'),
  }));
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
  await expect(status(page)).toContainText(`${bones} bones`);
}

async function walk(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption({ label: 'Walk' });
  const time = page.getByRole('group', { name: 'Playback', exact: true }).getByLabel('Time');
  await time.fill(String(Math.round(0.4 * 240_000)));
  await expect(viewState(page)).toHaveText('Ready');
  if (out) await page.locator('.character-canvas').screenshot({ path: `${out}/${name}.png` });
}

test('a Houyhnhnm opens on four legs with four IK chains, and walks (ST-654, TS-2327)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await open(page, f121Houyhnhnm(), 17);
  const doc = (await nativeArtifact(page)).draft.content as CharacterDocument;
  expect(doc.skeletons[0]!.ik).toHaveLength(4);
  await walk(page, 'houyhnhnm-walk');
});

test('a Yahoo opens and walks (ST-654, TS-2327)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await open(page, f122Yahoo(), 15);
  await walk(page, 'yahoo-walk');
});
