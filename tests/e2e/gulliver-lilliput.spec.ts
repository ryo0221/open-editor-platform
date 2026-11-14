// GV3a (docs/cad/gulliver-world.md): Mildendo (F105) and the ancient temple (F106) open in the
// ordinary Playground as buildings for 146 mm people, and their model is made in full.
// GULLIVER_OUT names a folder for the screenshots.
import { createArtifact } from '@editor-platform/artifact-core';
import type { BimDocument } from '@editor-platform/bim-core';
import type { Page } from '@playwright/test';
import { f105Mildendo, f106Temple } from '../../scripts/fixtures/gulliver-lilliput';
import { expect, nativeArtifact, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground does not offer Building.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const out = process.env.GULLIVER_OUT;
const inspector = (page: Page) => page.locator('.bim-inspector');

async function open(page: Page, name: string, doc: BimDocument, timeout: number) {
  await page.goto('/');
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name: `${name}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('bim', name, doc))),
  });
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', { timeout });
  // Up to date also when some elements failed: the kernel must have built every one (Codex).
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  if (!(await inspector(page).isVisible()))
    await page.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
  await expect(inspector(page).getByLabel("Inhabitants' height (mm)", { exact: true })).toHaveValue(
    '146',
  );
  expect(((await nativeArtifact(page)).draft.content as BimDocument).elements).toHaveLength(
    doc.elements.length,
  );
}

test('the ancient temple opens with its 4 ft gate for 146 mm people (ST-644, TS-2308)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  const temple = f106Temple();
  await open(page, 'Ancient temple', temple, 90_000);
  await expect(page.getByTestId('bim-body-limits')).toContainText('For people 146 mm tall');
  if (out) await page.getByTestId('bim-viewport').screenshot({ path: `${out}/temple.png` });
});

test('Mildendo opens whole: wall, 204 towers, palace and 2,128 houses (ST-644, TS-2308)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  // About 5,400 elements: the kernel makes every wall with its doors and windows (minutes).
  test.setTimeout(900_000);
  const { doc } = f105Mildendo();
  await open(page, 'Mildendo', doc, 840_000);
  if (out) await page.getByTestId('bim-viewport').screenshot({ path: `${out}/mildendo.png` });
});
