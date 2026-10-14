import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
import { prototypeImage } from './authored-image';
async function value(page: import('@playwright/test').Page, label: string, text: string) {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(text);
  await field.press('Enter');
  if (label === 'Layer name') await expect(field).toHaveValue(text);
}
async function shape(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: 'Insert shapes', exact: true }).click();
  await page.getByRole('button', { name: `Insert ${name}`, exact: true }).click();
  await page.keyboard.press('Escape');
}
async function save(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
}
async function native(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const file = await pending;
  const data = JSON.parse(await readFile((await file.path())!, 'utf8'));
  await page.keyboard.press('Escape');
  return data.draft.content;
}
test('H2 whiteboard branching connections follow node and group geometry, undo and export', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  await page.goto('/');
  await page.getByRole('button', { name: 'New Whiteboard', exact: true }).click();
  const positions = [
    [0, 220],
    [330, 80],
    [330, 370],
    [660, 440],
    [660, 0],
    [660, 220],
    [990, 340],
    [990, 560],
  ];
  const labels = [
    '課題の整理',
    '利用者調査',
    '試作・検証',
    '改善案',
    'インタビュー',
    '操作テスト',
    '画面を改善',
    '再検証へ',
  ];
  for (let i = 0; i < 8; i++) {
    await shape(page, i % 2 ? 'ellipse' : 'rectangle');
    await page.getByRole('button', { name: `Layer shape ${i + 1}`, exact: true }).press('F2');
    await value(page, 'Rename layer', `shape ${i + 1}`);
    await value(page, 'Element x', String(positions[i][0]));
    await value(page, 'Element y', String(positions[i][1]));
    await value(page, 'Text', labels[i]);
    await page.getByLabel('Text alignment', { exact: true }).selectOption('center');
    await page.getByLabel('Vertical alignment', { exact: true }).selectOption('middle');
  }
  for (const [a, b] of [
    [1, 2],
    [1, 3],
    [3, 4],
    [2, 5],
    [3, 6],
    [4, 7],
    [4, 8],
  ]) {
    await page.getByRole('button', { name: `Layer shape ${a}`, exact: true }).click();
    await page
      .getByRole('button', { name: `Layer shape ${b}`, exact: true })
      .click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Connect selected', exact: true }).click();
  }
  await expect(page.getByTestId('board-connector')).toHaveCount(7);
  await page.getByRole('button', { name: 'Connection 1', exact: true }).click();
  await value(page, 'Connector label', 'Decision branch');
  await page.getByLabel('Connector routing', { exact: true }).selectOption('elbow');
  const edge = page.getByTestId('board-connector').first().locator('path').last(),
    original = await edge.getAttribute('d');
  await page.getByRole('button', { name: 'Layer shape 1', exact: true }).click();
  await value(page, 'Element y', '130');
  expect(await edge.getAttribute('d')).not.toBe(original);
  await page
    .getByRole('button', { name: 'Layer shape 2', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Arrange', exact: true }).click();
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Layer group 1', exact: true }).click();
  await value(page, 'Element width', '650');
  const resized = await edge.getAttribute('d');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await edge.getAttribute('d')).not.toBe(resized);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await edge.getAttribute('d')).toBe(resized);
  // Retain the resize/Undo evidence above, then compose a readable final board.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Layer shape 1', exact: true }).click();
  await value(page, 'Element y', '220');
  await page.getByRole('button', { name: 'Add sticky', exact: true }).click();
  await value(page, 'Text', '次の検討事項');
  await value(page, 'Element x', '990');
  await value(page, 'Element y', '0');
  await page.getByRole('button', { name: 'Fit board', exact: true }).click();
  await save(page);
  await page.reload();
  await expect(page.getByTestId('board-connector')).toHaveCount(7);
  await expect(page.getByText('Decision branch', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Export whiteboard', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all SVG', exact: true }).click();
  const output = await downloaded,
    path = info.outputPath('branching-board.svg');
  await output.saveAs(path);
  const xml = await readFile(path, 'utf8');
  expect(xml).toContain('Decision branch');
  expect(xml).toContain('次の検討事項');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('whiteboard-after.png') });
});
test('H2 design component overrides, shared definition, auto-layout and frame PNG', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.goto('/');
  await page.getByRole('button', { name: 'New Design', exact: true }).click();
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await value(page, 'Element x', '40');
  await value(page, 'Element y', '40');
  await value(page, 'Layer name', 'Screen one');
  await shape(page, 'rounded-rectangle');
  await value(page, 'Element width', '220');
  await value(page, 'Element height', '140');
  await value(page, 'Layer name', 'Card background');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Text', 'Shared card title');
  await value(page, 'Font size (px)', '18');
  await value(page, 'Element x', '80');
  await value(page, 'Element y', '95');
  await value(page, 'Element width', '170');
  await value(page, 'Layer name', 'Card title');
  // Place both parts at the same parent before component creation.
  await page.getByLabel('Parent layer').selectOption({ label: 'Screen one' });
  await page.getByRole('button', { name: 'Layer Card background', exact: true }).click();
  await page
    .getByRole('button', { name: 'Layer Card title', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Make component', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel publication settings', exact: true }).click();
  await page.getByRole('button', { name: 'Components', exact: true }).click();
  await page.getByRole('button', { name: 'Insert Card background', exact: true }).click();
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Layer Card background instance', exact: true }).click();
  await value(page, 'Component text Card title', 'Only this instance');
  await page.getByRole('button', { name: 'Edit shared definition', exact: true }).click();
  await value(page, 'Component text Card title', 'Updated shared title');
  await page.getByRole('button', { name: 'Edit shared definition', exact: true }).click();
  await expect(page.getByLabel('Component text Card title')).toHaveValue('Only this instance');
  await page.getByRole('button', { name: 'Layer Screen one', exact: true }).click();
  await page.getByLabel('Layout direction').selectOption('column');
  await value(page, 'Layout gap (px)', '32');
  await page.getByRole('button', { name: 'Add frame', exact: true }).click();
  await value(page, 'Layer name', 'Screen two');
  await page.getByLabel('Parent layer').selectOption('');
  await value(page, 'Element x', '850');
  await value(page, 'Element y', '40');
  await page.getByLabel('Layout direction').selectOption('column');
  await page.getByRole('button', { name: 'Layer Card background instance', exact: true }).click();
  await page.getByLabel('Parent layer').selectOption({ label: 'Screen two' });
  const beforeResize = await native(page);
  await page.getByRole('button', { name: 'Layer Screen one', exact: true }).click();
  await value(page, 'Element width', '760');
  const afterResize = await native(page);
  expect(afterResize.elements.filter((e: { type: string }) => e.type === 'instance')).toEqual(
    beforeResize.elements.filter((e: { type: string }) => e.type === 'instance'),
  );
  expect(
    new Set(
      afterResize.elements
        .filter((e: { type: string }) => e.type === 'instance')
        .map((e: { parentId: string }) => e.parentId),
    ).size,
  ).toBe(2);
  await page.getByRole('button', { name: 'Layer Card background instance', exact: true }).click();
  await expect(page.getByLabel('Component text Card title')).toHaveValue('Only this instance');
  await page.getByRole('button', { name: 'Layer Card background', exact: true }).click();
  await expect(page.getByLabel('Component text Card title')).toHaveValue('Updated shared title');
  // Build two actual UI compositions through the public controls. Each has a
  // title, imported image, a row of three shared cards and a linked-style CTA.
  const image = await prototypeImage(page);
  const arrange = async (name: string) => {
    await page.getByRole('button', { name: 'Arrange', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await page.keyboard.press('Escape');
  };
  for (const [index, screen] of ['Screen one', 'Screen two'].entries()) {
    const row = `Cards ${index + 1}`;
    const original = index === 0 ? 'Card background' : 'Card background instance';
    await page.getByRole('button', { name: `Layer ${screen}`, exact: true }).click();
    await value(page, 'Element width', '760');
    await value(page, 'Element height', '700');
    await value(page, 'Layout padding (px)', '24');
    await value(page, 'Layout gap (px)', '24');
    await page.getByRole('button', { name: 'Add frame', exact: true }).click();
    await value(page, 'Layer name', row);
    await page.getByLabel('Parent layer').selectOption({ label: screen });
    await value(page, 'Element width', '712');
    await value(page, 'Element height', '140');
    await page.getByLabel('Layout direction').selectOption('row');
    await value(page, 'Layout padding (px)', '0');
    await value(page, 'Layout gap (px)', '20');
    await page.getByRole('button', { name: `Layer ${original}`, exact: true }).click();
    await value(page, 'Layer name', `Card ${index + 1}-1`);
    await page.getByLabel('Parent layer').selectOption({ label: row });
    await value(page, 'Component text Card title', index ? '本日の記録' : '作業を始める');
    for (const [card, label] of ['進捗を確認', '振り返り'].entries()) {
      await page.getByRole('button', { name: 'Components', exact: true }).click();
      await page.getByRole('button', { name: 'Insert Card background', exact: true }).click();
      await page.getByRole('button', { name: 'Layers', exact: true }).click();
      await page
        .getByRole('button', { name: 'Layer Card background instance', exact: true })
        .last()
        .click();
      await value(page, 'Layer name', `Card ${index + 1}-${card + 2}`);
      await page.getByLabel('Parent layer').selectOption({ label: row });
      await value(page, 'Component text Card title', label);
    }
    await page
      .getByLabel('Insert image file')
      .setInputFiles({ name: 'prototype.png', mimeType: 'image/png', buffer: image });
    await value(page, 'Layer name', `Image ${index + 1}`);
    await page.getByLabel('Parent layer').selectOption({ label: screen });
    await value(page, 'Element width', '712');
    await value(page, 'Element height', '254');
    await arrange('Send to back');
    await page.getByRole('button', { name: 'Insert text', exact: true }).click();
    await value(page, 'Layer name', `Title ${index + 1}`);
    await page.getByLabel('Parent layer').selectOption({ label: screen });
    await value(page, 'Text', index ? '今日の作業を記録する' : '毎日の作業を、ひとつに');
    await value(page, 'Font size (px)', '32');
    await value(page, 'Element width', '712');
    await value(page, 'Element height', '64');
    await arrange('Send to back');
    await shape(page, 'rounded-rectangle');
    await value(page, 'Layer name', `CTA ${index + 1}`);
    await page.getByLabel('Parent layer').selectOption({ label: screen });
    await value(page, 'Text', index ? '記録を保存する' : '新しい記録を作成');
    await value(page, 'Font size (px)', '24');
    await value(page, 'Element width', '712');
    await value(page, 'Element height', '58');
    if (!index) {
      await page.getByRole('button', { name: 'Create style from selection', exact: true }).click();
      await value(page, 'Shared style fill', '#bfdbfe');
    } else
      await page.getByLabel('Shared style', { exact: true }).selectOption({ label: 'Style 1' });
  }
  const composition = await native(page);
  expect(composition.elements.filter((e: { type: string }) => e.type === 'instance')).toHaveLength(
    6,
  );
  expect(composition.elements.filter((e: { styleId?: string }) => e.styleId)).toHaveLength(2);
  const layerOrder = await page
    .getByRole('treeitem')
    .locator('button.layer-name')
    .allTextContents();
  const first = layerOrder.findIndex((label) => label.startsWith('Screen one'));
  const second = layerOrder.findIndex((label) => label.startsWith('Screen two'));
  expect(layerOrder.findIndex((label) => label.startsWith('Card 1-1'))).toBeGreaterThan(first);
  expect(layerOrder.findIndex((label) => label.startsWith('Card 1-1'))).toBeLessThan(second);
  expect(layerOrder.findIndex((label) => label.startsWith('Card 2-1'))).toBeGreaterThan(second);
  await page.getByRole('button', { name: 'Fit design', exact: true }).click();
  await save(page);
  await page.getByRole('button', { name: 'Export design', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all PNG', exact: true }).click();
  const output = await downloaded,
    path = info.outputPath('two-screen-design.png');
  await output.saveAs(path);
  expect((await readFile(path)).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('design-after.png') });
});
