// GV2b (docs/cad/gulliver-world.md): a building for 146 mm people in the ordinary Playground.
// The Level panel sets the people's height; the body-based rules follow it.
import { bimStarter, type BimDocument } from '@editor-platform/bim-core';
import { createArtifact } from '@editor-platform/artifact-core';
import type { Page } from '@playwright/test';
import { expect, nativeArtifact, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground does not offer Building.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const inspector = (page: Page) => page.locator('.bim-inspector');
function lilliputHouse(): BimDocument {
  const doc = bimStarter();
  doc.project.name = 'Lilliput house';
  doc.inhabitantHeightMm = 146;
  doc.levels = [
    { id: 'l-1', name: '1F', elevationMm: 0 },
    { id: 'l-2', name: '2F', elevationMm: 250 },
    { id: 'l-r', name: 'RF', elevationMm: 500 },
  ];
  doc.types = doc.types.filter((t) => t.kind !== 'door' && t.kind !== 'window');
  return doc;
}

test("a Lilliput house keeps its 250 mm storeys until the people's height goes back to 1,750 mm (ST-642, TS-2304)", async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name: 'house.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('bim', 'Lilliput house', lilliputHouse()))),
  });
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 90_000,
  });
  if (!(await inspector(page).isVisible()))
    await page.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
  const height = inspector(page).getByLabel("Inhabitants' height (mm)", { exact: true });
  await expect(height).toHaveValue('146');
  await expect(page.getByTestId('bim-body-limits')).toContainText(
    'For people 146 mm tall: storeys at least 83.43 mm, risers 4.17–20.86 mm',
  );
  // Back to 1,750 mm people: the 250 mm storeys break the rule and the edit is refused.
  await inspector(page).getByRole('button', { name: 'Back to 1750 mm people' }).click();
  await expect(page.locator('.bim-notice')).toContainText('Refused: level-spacing');
  expect(((await nativeArtifact(page)).draft.content as BimDocument).inhabitantHeightMm).toBe(146);
  // A Brobdingnag height is refused too (a 250 mm storey is far below 12 m).
  await height.fill('21000');
  await height.press('Enter');
  await expect(page.locator('.bim-notice')).toContainText('Refused: level-spacing');
  // 160 mm people are allowed and the limits follow; Undo restores 146 mm.
  await height.fill('160');
  await height.press('Enter');
  await expect(page.getByTestId('bim-body-limits')).toContainText('For people 160 mm tall');
  expect(((await nativeArtifact(page)).draft.content as BimDocument).inhabitantHeightMm).toBe(160);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(height).toHaveValue('146');
});
