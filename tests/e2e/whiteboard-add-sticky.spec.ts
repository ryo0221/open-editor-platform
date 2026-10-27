import { createArtifact } from '@editor-platform/artifact-core';
import type { Page } from '@playwright/test';
import type { WhiteboardContent, WhiteboardNode } from '@editor-platform/whiteboard/model';
import { test, expect, nativeArtifact } from './fixtures';

const sticky = (id: string, x: number, y: number): WhiteboardNode => ({
  id,
  kind: 'sticky',
  bounds: { x, y, width: 170, height: 120 },
  text: `Note ${id}`,
  color: '#f2e3a8',
});
// A 3 × 2 block of notes, so the middle of the fitted board is taken.
const board: WhiteboardContent = {
  schemaVersion: 3,
  sections: [],
  nodes: [0, 1, 2].flatMap((col) =>
    [0, 1].map((row) => sticky(`n${col}${row}`, 100 + col * 190, 100 + row * 140)),
  ),
  connectors: [],
};
const nodes = async (page: Page) =>
  ((await nativeArtifact(page)).draft.content as WhiteboardContent).nodes;
const overlaps = (a: WhiteboardNode['bounds'], b: WhiteboardNode['bounds']) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
/** The world rectangle the canvas shows, from its camera transform. */
async function visibleWorld(page: Page) {
  const canvas = page.getByRole('application', { name: 'Whiteboard canvas', exact: true });
  const box = (await canvas.boundingBox())!;
  const transform = await canvas.locator(':scope > g').first().getAttribute('transform');
  const [x, y, zoom] = transform!.match(/-?[\d.]+/g)!.map(Number);
  return { x: -x / zoom, y: -y / zoom, width: box.width / zoom, height: box.height / zoom };
}

test.use({ viewport: { width: 1440, height: 900 } });
test('Add sticky lands in the visible area clear of other notes and takes typing at once', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'sticky-board.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ ...createArtifact('whiteboard', 'Sticky board', board), annotations: [] }),
    ),
  });
  const add = page.getByRole('button', { name: 'Add sticky', exact: true });
  await page.getByRole('button', { name: 'Fit board', exact: true }).click();
  await add.click();
  // The editor opens with the first text selected; Escape keeps that text.
  const editor = page.locator('.ep-canvas-text-in-place [contenteditable="true"]');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  let after = await nodes(page);
  expect(after).toHaveLength(7);
  const first = after.at(-1)!;
  expect(first.text).toBe('A new idea');
  for (const other of board.nodes) expect(overlaps(first.bounds, other.bounds)).toBe(false);
  const fitted = await visibleWorld(page);
  expect(overlaps(first.bounds, fitted)).toBe(true);
  // One Undo takes the insert back.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await nodes(page)).toHaveLength(6);

  // Move the camera far to the right: the next note follows the view, not a fixed spot.
  await page.getByRole('button', { name: 'Board actions', exact: true }).click();
  const centerX = page.getByLabel('Camera center x', { exact: true });
  await centerX.fill('2400');
  await centerX.press('Enter');
  await page.keyboard.press('Escape');
  const moved = await visibleWorld(page);
  await add.click();
  await expect(editor).toBeFocused();
  // Committed text input (the result of an IME composition) replaces the first text.
  await page.keyboard.insertText('洋上変電所の重量制限');
  await page.getByText(/\d+ nodes · /).click();
  await expect(editor).toHaveCount(0);
  after = await nodes(page);
  const second = after.at(-1)!;
  expect(second.text).toBe('洋上変電所の重量制限');
  const center = (b: { x: number; width: number }) => b.x + b.width / 2;
  expect(Math.abs(center(second.bounds) - center(moved))).toBeLessThan(2);
  expect(second.bounds.x).toBeGreaterThan(2000);
});
