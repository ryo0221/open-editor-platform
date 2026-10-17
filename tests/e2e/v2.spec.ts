import {
  test,
  expect,
  create,
  save,
  tinyPng,
  comments,
  artifactView,
  editCell,
  addRecord,
  addField,
} from './fixtures';
import type { Page } from '@playwright/test';
async function value(page: Page, label: string, text: string) {
  await page.getByLabel(label, { exact: true }).fill(text);
  await page.getByLabel(label, { exact: true }).press('Enter');
}
async function shape(page: Page, name: string) {
  await page.getByRole('button', { name: 'Insert shapes', exact: true }).click();
  await page.getByRole('button', { name: `Insert ${name}`, exact: true }).click();
  await page.keyboard.press('Escape');
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
});
test('whiteboard nodes, connector, pointer move/resize, undo, comments and SVG export', async ({
  page,
}, info) => {
  await create(page, 'whiteboard');
  await shape(page, 'rectangle');
  await value(page, 'Element x', '70');
  await value(page, 'Element y', '100');
  await value(page, 'Text', 'Collect ideas');
  await shape(page, 'ellipse');
  await value(page, 'Element x', '350');
  await value(page, 'Element y', '150');
  await page.getByRole('button', { name: 'Add sticky', exact: true }).click();
  await value(page, 'Element x', '620');
  await value(page, 'Element y', '250');
  await value(page, 'Text', 'Make it tangible');
  await page.getByRole('button', { name: 'Layer Collect ideas', exact: true }).click();
  await page
    .getByRole('button', { name: 'Layer shape 2', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Connect selected', exact: true }).click();
  await expect(page.getByTestId('board-connector')).toHaveCount(1);
  await page.getByRole('button', { name: 'Layer Make it tangible', exact: true }).click();
  const box = (await page.getByRole('button', { name: 'sticky 3', exact: true }).boundingBox())!,
    oldX = await page.getByLabel('Element x', { exact: true }).inputValue();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 100, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByLabel('Element x', { exact: true })).not.toHaveValue(oldX);
  const resize = (await page
      .getByRole('button', { name: 'Resize sticky 3', exact: true })
      .boundingBox())!,
    oldWidth = await page.getByLabel('Element width', { exact: true }).inputValue();
  await page.mouse.move(resize.x + 4, resize.y + 4);
  await page.mouse.down();
  await page.mouse.move(resize.x + 40, resize.y + 30, { steps: 6 });
  await page.mouse.up();
  const width = await page.getByLabel('Element width', { exact: true }).inputValue();
  expect(Number(width)).toBeGreaterThan(Number(oldWidth));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Element width', { exact: true })).toHaveValue(oldWidth);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('Element width', { exact: true })).toHaveValue(width);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByLabel('Canvas zoom')).toHaveValue('1.2');
  await page.getByRole('button', { name: 'Fit board', exact: true }).click();
  await save(page, 1);
  await page.screenshot({ path: info.outputPath('whiteboard-desktop.png') });
  await comments(page);
  await page.getByLabel('Comment', { exact: true }).fill('Discuss this idea');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await page.getByRole('button', { name: 'Export whiteboard', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all SVG', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.svg$/);
  await page.keyboard.press('Escape');
  await value(page, 'Text', 'A revised idea');
  await save(page, 2);
  await artifactView(page, 'Compare');
  await expect(
    page.locator('.change .text-pair pre').filter({ hasText: 'Text: A revised idea' }),
  ).toBeVisible();
});
test('design frames, text, images, layers, resize and reusable components', async ({
  page,
}, info) => {
  await create(page, 'design');
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Text', 'Form & function');
  await value(page, 'Font size (px)', '18');
  await page
    .getByLabel('Insert image file')
    .setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: tinyPng });
  await page.getByRole('button', { name: 'Layer Text 2', exact: true }).click();
  await value(page, 'Element x', '100');
  await value(page, 'Element y', '100');
  await page.getByRole('button', { name: 'Make component', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel publication settings', exact: true }).click();
  await page.getByRole('button', { name: 'Components', exact: true }).click();
  await page.getByRole('button', { name: 'Insert Text 2', exact: true }).click();
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Layer Text 2 instance', exact: true }).click();
  await value(page, 'Element x', '100');
  await value(page, 'Element y', '165');
  await page.getByRole('button', { name: 'Edit shared definition', exact: true }).click();
  await value(page, 'Component text Text 2', 'Thoughtful composition');
  await expect(
    page
      .getByRole('application', { name: 'Design canvas' })
      .getByText('Thoughtful composition', { exact: true }),
  ).toHaveCount(2);
  await page.getByRole('button', { name: 'Layer Image 3', exact: true }).click();
  await value(page, 'Element x', '100');
  await value(page, 'Element y', '250');
  await value(page, 'Element width', '520');
  await value(page, 'Element height', '185');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Element height', { exact: true })).toHaveValue('160');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('Element height', { exact: true })).toHaveValue('185');
  await save(page, 1);
  await page.getByRole('button', { name: 'Fit design', exact: true }).click();
  await page.screenshot({ path: info.outputPath('design-desktop.png') });
  await page.getByRole('button', { name: 'Export design', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all SVG', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.svg$/);
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Layer Text 2 instance', exact: true }),
  ).toBeVisible();
});
test('slide deck editing, reorder, chart snapshot, read-only presentation and image export', async ({
  page,
}, info) => {
  await create(page, 'slide');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Text', 'From idea to artifact');
  await shape(page, 'ellipse');
  await page
    .getByLabel('Insert image file')
    .setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: tinyPng });
  await value(page, 'Element x', '500');
  await value(page, 'Element y', '190');
  await value(page, 'Element width', '340');
  await value(page, 'Element height', '240');
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Add slide layout', exact: true }).click();
    await page.getByRole('button', { name: 'title', exact: true }).click();
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Slide insert options', exact: true }).click();
  await page.getByRole('button', { name: 'Insert chart', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Move slide up', exact: true }).click();
  await expect(page.getByLabel('Current page', { exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'Slide 1: Slide 1', exact: true }).click();
  await save(page, 1);
  await page.screenshot({ path: info.outputPath('slide-desktop.png') });
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Slide presentation' });
  await expect(dialog.getByLabel('Presentation page 1', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Insert text', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Next slide', exact: true }).click();
  await expect(dialog.getByLabel('Presentation page 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Exit presentation', exact: true }).click();
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.(png|zip)$/);
});
test('advanced data projections share edited records and feed slide snapshots', async ({
  page,
}, info) => {
  await create(page, 'data');
  await page.getByLabel('Artifact name').fill('Editorial schedule');
  await addRecord(page);
  await addRecord(page);
  await editCell(page, 'Name', 1, 'Research');
  await editCell(page, 'Name', 2, 'Publish');
  await editCell(page, 'Status', 2, 'Done', true);
  await addField(page, 'Due', 'date');
  await editCell(page, 'Due', 1, '2026-10-04');
  await editCell(page, 'Due', 2, '2026-10-11');
  await page.getByLabel('Data projection').selectOption('Dashboard');
  await page.getByRole('button', { name: 'Add metric widget', exact: true }).click();
  await expect(page.getByLabel('Metric', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('data-dashboard.png') });
  await page.getByLabel('Data projection').selectOption('Timeline');
  await page.getByLabel('Start field', { exact: true }).selectOption({ label: 'Due' });
  await page.getByLabel('End field', { exact: true }).selectOption({ label: 'Due' });
  await expect(page.getByRole('button', { name: 'Dates for Research', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('data-timeline.png') });
  await page.getByLabel('Data projection').selectOption('Roadmap');
  await page.getByLabel('Timeline group', { exact: true }).selectOption({ label: 'Status' });
  await expect(page.getByText('Done', { exact: true }).last()).toBeVisible();
  await page.getByLabel('Data projection').selectOption('Summary');
  await page.getByLabel('Group field', { exact: true }).selectOption({ label: 'Status' });
  await expect(page.locator('table.ep-summary')).toContainText('Planned');
  await page.getByLabel('Data projection').selectOption('Chart');
  await page.getByLabel('Chart type', { exact: true }).selectOption('line');
  await expect(page.getByRole('img', { name: /^Data chart:/ })).toBeVisible();
  await create(page, 'slide');
  await page.getByRole('button', { name: 'Slide insert options', exact: true }).click();
  await page
    .getByRole('button', { name: 'Insert snapshot: Editorial schedule', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('application', { name: 'Slide canvas' })).toContainText(
    'Editorial schedule',
  );
  await save(page, 1);
});
