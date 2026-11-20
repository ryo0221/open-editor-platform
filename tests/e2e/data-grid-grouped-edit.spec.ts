import { createArtifact } from '@editor-platform/artifact-core';
import type { StructuredData } from '@editor-platform/structured-data';
import { defaultView } from '@editor-platform/structured-data/views';
import { test, expect, nativeArtifact } from './fixtures';

// #23: in a grid grouped by a field, double-clicking a cell must edit that cell (group headers
// sit between the rows, so row positions and entry positions differ).
test('double-click edits the clicked cell in a grouped grid, also after scrolling', async ({
  page,
}) => {
  const status = ['Open', 'Done', 'Waiting'];
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'title', name: 'Title', type: 'text' },
      { id: 'status', name: 'Status', type: 'text' },
    ],
    // An empty text ('') and a missing value both show as "(empty)" but are separate groups,
    // so the grid shows two "(empty)" headers apart from each other.
    rows: Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      values: (i % 4 === 0
        ? { title: `Task ${i}`, status: '' }
        : i % 4 === 3
          ? { title: `Task ${i}` }
          : { title: `Task ${i}`, status: status[i % 3] }) as Record<string, string>,
    })),
  };
  data.views = [{ ...defaultView(data), id: 'grouped', name: 'Grouped', groupBy: 'status' }];
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'grouped.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ ...createArtifact('data', 'Grouped', data), annotations: [] }),
    ),
  });
  const grid = page.getByRole('grid', { name: 'Data grid', exact: true });
  await expect(grid).toBeVisible();
  // The lowest visible row: choosing it scrolls the grid so the row is not under the bottom edge.
  // A double-click must still edit that row, not the row that moved under the pointer.
  const box = (await grid.boundingBox())!;
  const cells = grid.getByRole('gridcell').filter({ hasText: /^Task \d+$/ });
  let target = '';
  for (let i = (await cells.count()) - 1; i >= 0; i--) {
    const b = await cells.nth(i).boundingBox();
    if (b && b.y + b.height <= box.y + box.height - 2) {
      target = (await cells.nth(i).textContent())!;
      break;
    }
  }
  expect(target).toMatch(/^Task \d+$/);
  await grid
    .getByRole('gridcell')
    .filter({ hasText: new RegExp(`^${target}$`) })
    .dblclick();
  const input = page.getByLabel('Edit Title', { exact: true });
  await expect(input).toHaveValue(target);
  await input.fill(`${target} edited`);
  await input.press('Enter');
  // While one cell is being edited, double-clicking another cell edits the one that was double-clicked.
  await grid
    .getByRole('gridcell')
    .filter({ hasText: /^Task 0$/ })
    .dblclick();
  await expect(input).toHaveValue('Task 0');
  await grid
    .getByRole('gridcell')
    .filter({ hasText: /^Task 3$/ })
    .dblclick();
  await expect(input).toHaveValue('Task 3');
  await input.press('Escape');
  const want = [`r${target.split(' ')[1]}`];
  const saved = (await nativeArtifact(page)).draft.content as StructuredData;
  const edited = saved.rows
    .filter((r) => String(r.values.title).endsWith('edited'))
    .map((r) => r.id)
    .sort();
  expect(edited).toEqual(want);
});
