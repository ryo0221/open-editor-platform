// GV2a (docs/cad/gulliver-world.md): pin a building version to a Lilliput map feature and open
// it from the feature, in the ordinary Playground. The pin stays on that version.
import { bimStarter } from '@editor-platform/bim-core';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import type { FictionMapContent } from '@editor-platform/fiction-map/model';
import type { Page } from '@playwright/test';
import { gulliverMapArtifact } from '../../scripts/fixtures/gulliver-maps';
import { expect, nativeArtifact, save, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground does not offer Building.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

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
async function openLibrary(page: Page, name: string) {
  const library = page.getByRole('complementary', { name: 'Artifact library' });
  if (!(await library.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await library.getByRole('button', { name: new RegExp(name) }).click();
}

test('a Lilliput feature pins a building version and opens it (ST-641, TS-2302)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  const temple = await commitVersion(
    createArtifact('bim', 'Old temple', bimStarter()),
    null,
    'GV2a temple',
  );
  await importJson(page, 'temple.json', temple);
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 90_000,
  });
  await importJson(
    page,
    'lilliput.json',
    await commitVersion(gulliverMapArtifact('lilliput'), null, 'GV1'),
  );
  await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
  if (!(await page.getByLabel('Map details').isVisible()))
    await page.getByRole('button', { name: 'Layers and inspector', exact: true }).click();
  await page
    .locator('.fm-features')
    .getByRole('button', { name: '古い神殿（ガリヴァーの宿）', exact: true })
    .click();
  const refs = page.getByRole('region', { name: 'Pinned 3D versions' });
  await expect(refs.getByLabel('Artifact to pin')).toContainText('Old temple · BIM · version 1');
  // A pending feature edit keeps the pin from moving the map under it (Codex).
  const name = page.getByLabel('Feature name', { exact: true });
  await name.fill('Temple (pending)');
  await refs.getByRole('button', { name: 'Pin latest version', exact: true }).click();
  await expect(page.locator('[data-diagnostic-code="input-pending"]')).toBeVisible();
  await expect(refs.locator('[data-artifact-ref]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel edits', exact: true }).click();
  await refs.getByRole('button', { name: 'Pin latest version', exact: true }).click();
  await expect(refs.locator('[data-artifact-ref]')).toHaveAttribute('data-status', 'ready');

  const map = (await nativeArtifact(page)).draft.content as FictionMapContent;
  const pinned = map.features.find((f) => f.id === 'temple')!.artifactRefs;
  expect(pinned).toEqual([
    {
      // Import gives the building a new Artifact ID; the version and its hash are kept.
      artifactId: expect.stringMatching(/^artifact_/),
      domain: 'bim',
      versionId: temple.versions[0].versionId,
      contentHash: temple.versions[0].contentHash,
      label: 'Old temple',
    },
  ]);
  // One undoable command: Undo removes the pin, Redo restores it.
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect(refs.locator('[data-artifact-ref]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).first().click();
  await expect(refs.locator('[data-artifact-ref]')).toHaveCount(1);

  await refs.getByRole('button', { name: 'Open Old temple', exact: true }).click();
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 90_000,
  });
  await expect(page.getByText('Opened Old temple: the map pins version 1 of 1.')).toBeVisible();

  // A newer building version does not move the pin.
  await save(page, 2);
  await openLibrary(page, 'リリパットとブレフスキュ');
  await page
    .locator('.fm-features')
    .getByRole('button', { name: '古い神殿（ガリヴァーの宿）', exact: true })
    .click();
  await expect(refs.locator('[data-artifact-ref]')).toHaveAttribute('data-status', 'ready');
  await refs.getByRole('button', { name: 'Open Old temple', exact: true }).click();
  await expect(page.getByText(/the map pins version 1 of 2\./)).toBeVisible();
});
