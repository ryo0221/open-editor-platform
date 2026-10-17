import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
async function value(page: import('@playwright/test').Page, label: string, text: string) {
  await page.getByLabel(label, { exact: true }).fill(text);
  await page.getByLabel(label, { exact: true }).press('Enter');
}
async function camera(page: import('@playwright/test').Page, x: number, y: number) {
  await page.getByRole('button', { name: 'Board actions', exact: true }).click();
  await value(page, 'Camera center x', String(x));
  await value(page, 'Camera center y', String(y));
  await page.keyboard.press('Escape');
}
async function native(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const file = await download;
  const data = JSON.parse(await readFile((await file.path())!, 'utf8'));
  await page.keyboard.press('Escape');
  return data;
}
test('ID-Q01–03 infinite board Sections preserve membership and distinguish region resize from Group scale', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Whiteboard', exact: true }).click();
  const board = page.getByRole('application', { name: 'Whiteboard canvas' });
  await expect(board.locator('[data-space=infinite]')).toBeVisible();
  for (const [name, x, y] of [
    ['調査', -50000, -50000],
    ['アイデア', 0, 0],
    ['次の行動', 50000, 50000],
  ] as const) {
    await camera(page, x, y);
    await page.getByRole('button', { name: 'Add sticky', exact: true }).click();
    await value(page, 'Text', `${name}の付箋`);
    const px = Number(await page.getByLabel('Element x', { exact: true }).inputValue());
    expect(Math.abs(px - x)).toBeLessThan(200);
    await page.getByRole('button', { name: 'Board actions', exact: true }).click();
    await page
      .getByRole('button', { name: 'Section around selected objects', exact: true })
      .click();
    await page.keyboard.press('Escape');
    await value(page, 'Section title', name);
  }
  const initial = await native(page),
    original = initial.draft.content;
  expect(original.sections).toHaveLength(3);
  expect(original.nodes).toHaveLength(3);
  expect(new Set(original.nodes.map((n: { sectionId: string }) => n.sectionId)).size).toBe(3);
  await page.getByRole('button', { name: 'Go to Section 調査', exact: true }).click();
  await value(page, 'Section width', '800');
  await value(page, 'Section height', '600');
  const resized = (await native(page)).draft.content;
  expect(resized.nodes).toEqual(original.nodes);
  await value(page, 'Section x', '-49000');
  const moved = (await native(page)).draft.content;
  expect(moved.nodes[0].bounds.x - original.nodes[0].bounds.x).toBe(
    -49000 - original.sections[0].bounds.x,
  );
  expect(moved.nodes[1]).toEqual(original.nodes[1]);
  // Move a root object into another Section; endpoint IDs remain stable and Undo restores membership.
  await page.getByRole('button', { name: 'Layer 調査の付箋', exact: true }).click();
  await value(page, 'Element x', String(original.nodes[1].bounds.x));
  await value(page, 'Element y', String(original.nodes[1].bounds.y));
  await expect(page.getByLabel('Object Section')).toHaveValue(original.sections[1].id);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Object Section')).toHaveValue(original.sections[0].id);
  await page
    .getByRole('button', { name: 'Layer アイデアの付箋', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Connect selected', exact: true }).click();
  await page.getByRole('button', { name: 'Go to Section 調査', exact: true }).click();
  await page.getByRole('button', { name: 'Dissolve Section', exact: true }).click();
  expect((await native(page)).draft.content.nodes).toHaveLength(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Go to Section 調査', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fit board', exact: true }).click();
  await page.screenshot({ path: info.outputPath('three-distant-sections.png') });
  await page.getByRole('button', { name: 'Go to Section 次の行動', exact: true }).click();
  const beforeCamera = (await native(page)).draft.content;
  await camera(page, 50300, 50200);
  expect((await native(page)).draft.content).toEqual(beforeCamera);
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Go to Section 次の行動', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to Section 次の行動', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Section SVG', exact: true }).click();
  const file = await download,
    path = info.outputPath('next-actions-section.svg');
  await file.saveAs(path);
  const svg = await readFile(path, 'utf8');
  expect(svg.replace(/<[^>]+>/g, '')).toContain('次の行動の付箋');
  expect(svg).not.toContain('調査の付箋');
  expect(svg).not.toContain(original.sections[2].id);
  await page.screenshot({ path: info.outputPath('section-detail.png') });
});
test('ID-Q03 pointer drag previews Section membership and commits it once with connector identity intact', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Whiteboard', exact: true }).click();
  for (const [title, x] of [
    ['Left', -260],
    ['Right', 260],
  ] as const) {
    await camera(page, x, 0);
    await page.getByRole('button', { name: 'Add sticky', exact: true }).click();
    await value(page, 'Text', `${title} note`);
    await page.getByRole('button', { name: 'Board actions', exact: true }).click();
    await page
      .getByRole('button', { name: 'Section around selected objects', exact: true })
      .click();
    await page.keyboard.press('Escape');
    await value(page, 'Section title', title);
  }
  await page.getByRole('button', { name: 'Layer Left note', exact: true }).click();
  await page
    .getByRole('button', { name: 'Layer Right note', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Connect selected', exact: true }).click();
  const before = (await native(page)).draft.content;
  await page.getByRole('button', { name: 'Fit board', exact: true }).click();
  await page.getByRole('button', { name: 'Layer Left note', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Whiteboard canvas' });
  const from = (await canvas.getByRole('button', { name: 'sticky 1', exact: true }).boundingBox())!;
  const to = (await canvas.getByRole('button', { name: 'sticky 2', exact: true }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await expect(page.getByLabel('Object Section')).toHaveValue(before.sections[0].id);
  await page.mouse.up();
  await expect(page.getByLabel('Object Section')).toHaveValue(before.sections[1].id);
  const after = (await native(page)).draft.content;
  expect(after.connectors).toEqual(before.connectors);
  expect(after.nodes.map((n: { id: string }) => n.id)).toEqual(
    before.nodes.map((n: { id: string }) => n.id),
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(before);
});
