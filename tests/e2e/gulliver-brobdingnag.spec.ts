// GV4a (docs/cad/gulliver-world.md): the temple tower of Lorbrulgrud (F109) and a chief room of
// the king's palace (F110) open in the ordinary Playground as buildings for 21 m people, and
// their model is made in full. GULLIVER_OUT names a folder for the screenshots.
import { createArtifact } from '@editor-platform/artifact-core';
import type { BimDocument } from '@editor-platform/bim-core';
import type { Page } from '@playwright/test';
import { f109TempleTower, f110PalaceRoom } from '../../scripts/fixtures/gulliver-brobdingnag';
import { expect, nativeArtifact, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground does not offer Building.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const out = process.env.GULLIVER_OUT;
const inspector = (page: Page) => page.locator('.bim-inspector');

async function open(page: Page, name: string, doc: BimDocument) {
  await page.goto('/');
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name: `${name}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('bim', name, doc))),
  });
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 120_000,
  });
  // Up to date also when some elements failed: the kernel must have built every one.
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  if (!(await inspector(page).isVisible()))
    await page.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
  await expect(inspector(page).getByLabel("Inhabitants' height (mm)", { exact: true })).toHaveValue(
    '21000',
  );
  await expect(page.getByTestId('bim-body-limits')).toContainText('For people 21000 mm tall');
  expect(((await nativeArtifact(page)).draft.content as BimDocument).elements).toHaveLength(
    doc.elements.length,
  );
}

test('the temple tower opens: 3,000 ft, walls 100 ft thick, for 21 m people (ST-647, TS-2314)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await open(page, 'Temple tower', f109TempleTower().doc);
  if (out) await page.getByTestId('bim-viewport').screenshot({ path: `${out}/tower.png` });
});

test("the palace's chief room opens: 240 ft high, for 21 m people (ST-647, TS-2314)", async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await open(page, 'Chief room', f110PalaceRoom().doc);
  if (out) await page.getByTestId('bim-viewport').screenshot({ path: `${out}/palace-room.png` });
});
