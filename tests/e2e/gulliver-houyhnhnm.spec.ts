// GV6a (docs/cad/gulliver-world.md): the master Houyhnhnm's house and the Yahoos' hut (F120)
// open in the ordinary Playground as a building and the model is made in full. GULLIVER_OUT names
// a folder for the screenshots.
import { createArtifact } from '@editor-platform/artifact-core';
import type { BimDocument } from '@editor-platform/bim-core';
import { f120Farmstead } from '../../scripts/fixtures/gulliver-houyhnhnm';
import { expect, nativeArtifact, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground does not offer Building.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const out = process.env.GULLIVER_OUT;

test("the master's house opens: wattle on posts, a straw roof, four rooms in a vista, the hut (ST-653, TS-2325)", async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  const { doc } = f120Farmstead();
  await page.goto('/');
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name: 'Houyhnhnm house.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('bim', "The master's house", doc))),
  });
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 200_000,
  });
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  const content = (await nativeArtifact(page)).draft.content as BimDocument;
  expect(content.elements).toHaveLength(doc.elements.length);
  if (out) await page.getByTestId('bim-viewport').screenshot({ path: `${out}/farmstead.png` });
});
