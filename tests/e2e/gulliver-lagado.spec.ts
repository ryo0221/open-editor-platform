// GV5c (docs/cad/gulliver-world.md): the grand academy of Lagado (F118, 500 rooms on both sides of
// a street) opens in the ordinary Playground as a building and its model is made in full; the
// professor's frame (F119, forty handles on revolute joints) opens in the CAD editor with every
// row placed. GULLIVER_OUT names a folder for the screenshots.
import { createArtifact } from '@editor-platform/artifact-core';
import type { BimDocument } from '@editor-platform/bim-core';
import type { CadDocument } from '@editor-platform/cad-core';
import type { Page } from '@playwright/test';
import { f118Academy } from '../../scripts/fixtures/gulliver-lagado';
import { f119Frame } from '../../scripts/fixtures/gulliver-lagado-cad';
import { create, expect, nativeArtifact, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground does not offer Building.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const out = process.env.GULLIVER_OUT;

async function importFile(page: Page, name: string, artifact: unknown) {
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name: `${name}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
}

test('the academy opens: 500 rooms in twenty houses on both sides of a street (ST-652, TS-2323)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(600_000);
  const { doc } = f118Academy();
  await page.goto('/');
  await importFile(page, 'Academy of Lagado', createArtifact('bim', 'Academy of Lagado', doc));
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 400_000,
  });
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  const content = (await nativeArtifact(page)).draft.content as BimDocument;
  expect(content.elements).toHaveLength(doc.elements.length);
  expect(content.elements.filter((e) => e.kind === 'space')).toHaveLength(500);
  if (out) await page.getByTestId('bim-viewport').screenshot({ path: `${out}/academy.png` });
});

test('the frame opens: twenty feet square, forty rows on their handles, some turned (ST-652, TS-2323)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(600_000);
  const ready = () =>
    expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
      timeout: 180_000,
    });
  await page.goto('/');
  await create(page, 'cad');
  await ready();
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const { assembly, closure } = f119Frame({ id, buildHash }, (k) => (k % 3 === 0 ? Math.PI : 0));
  await importFile(page, 'Frame', {
    ...empty,
    name: 'Frame',
    draft: { ...empty.draft, content: assembly },
    cadParts: [...closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Frame');
  await ready();
  const list = page.getByRole('list', { name: 'Components' });
  await expect(list.getByRole('button').first()).toBeVisible();
  await expect(list).not.toContainText(/計算中|計算できません|参照できません|参考表示/, {
    timeout: 300_000,
  });
  const doc = (await nativeArtifact(page)).draft.content as CadDocument;
  expect(doc.joints).toHaveLength(40);
  expect(doc.components).toHaveLength(41);
  if (out) await page.getByTestId('cad-viewport').screenshot({ path: `${out}/frame.png` });
});
