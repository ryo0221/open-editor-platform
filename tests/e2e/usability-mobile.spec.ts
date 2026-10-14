import { test, expect, create, nativeArtifact, save } from './fixtures';
import { dataProjection, importRelationData } from './structured-graph-fixtures';
import { graphSourceAction, importUsability } from './usability-fixtures';
import { makeWhiteboardNode, type WhiteboardContent } from '@editor-platform/whiteboard/model';
test('#43 #44 #49 mobile Data Graph source navigation retains typed Form input through Host Save', async ({
  page,
}, info) => {
  await page.goto('/');
  await importRelationData(page);
  await dataProjection(page, 'Graph');
  await page.getByRole('button', { name: 'Select node Research', exact: true }).click();
  await graphSourceAction(page, '元データを開く');
  await page.getByLabel('Record Name', { exact: true }).fill('Mobile Host save');
  await page.keyboard.press('Control+s');
  await page.reload();
  await dataProjection(page, 'Graph');
  await expect(
    page.getByRole('button', { name: 'Select node Mobile Host save', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-data-source-save.png') });
});
test('#45 mobile Whiteboard keeps the note footprint and offers optional expanded text editing', async ({
  page,
}, info) => {
  const note = {
    ...makeWhiteboardNode('sticky'),
    id: 'mobile-note',
    bounds: { x: 30, y: 50, width: 180, height: 120 },
    text: '直接編集する付箋',
  };
  await page.goto('/');
  await importUsability(page, 'whiteboard', {
    schemaVersion: 3,
    nodes: [note],
    connectors: [],
    sections: [],
  } satisfies WhiteboardContent);
  const canvas = page.getByRole('application', { name: 'Whiteboard canvas', exact: true });
  await canvas.getByRole('button', { name: 'sticky 1', exact: true }).dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await expect(page.locator('.ep-canvas-text-in-place')).toHaveAttribute('width', '180');
  await editor.fill('モバイルの直接編集');
  await page.screenshot({ path: info.outputPath('mobile-in-place-note.png') });
  await page.getByRole('button', { name: 'Expand text editor', exact: true }).click();
  await expect(page.locator('.ep-canvas-text-expanded')).toBeVisible();
  await expect(editor).toContainText('モバイルの直接編集');
  await page.getByRole('button', { name: 'Return to in-place text editing', exact: true }).click();
  await editor.press('Control+s');
  await expect(editor).toHaveCount(0);
  await page.reload();
  expect(JSON.stringify((await nativeArtifact(page)).draft.content)).toContain(
    'モバイルの直接編集',
  );
});
test('#50 #51 mobile slide copy selection and Whiteboard body search use ordinary controls', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'slide');
  await page.getByRole('button', { name: 'Toggle Slide navigator', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate slide', exact: true }).click();
  await page.getByRole('button', { name: 'Close Slide navigator', exact: true }).click();
  await expect(page.getByLabel('Current page', { exact: true })).toHaveValue('2');
  await save(page, 1);
  await create(page, 'whiteboard');
  await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByRole('button', { name: 'Add sticky', exact: true }).click();
  await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle Board navigator', exact: true }).click();
  await page.getByLabel('Search layers', { exact: true }).fill('A new idea');
  await page.getByRole('button', { name: 'Layer A new idea', exact: true }).click();
  await page.getByRole('button', { name: 'Close Board navigator', exact: true }).click();
  await expect(
    page
      .getByRole('application', { name: 'Whiteboard canvas', exact: true })
      .getByRole('button', { name: 'sticky 1', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath('mobile-note-search.png') });
});
