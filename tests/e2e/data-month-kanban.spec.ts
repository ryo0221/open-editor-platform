import { createArtifact } from '@editor-platform/artifact-core';
import type { StructuredData } from '@editor-platform/structured-data';
import { defaultView } from '@editor-platform/structured-data/views';
import { test, expect, nativeArtifact } from './fixtures';

// A year-long plan where every record already has a status (issue #357).
const statuses = ['Plan', 'Build', 'Verify', 'Done'];
const data: StructuredData = {
  schemaVersion: 2,
  columns: [
    { id: 'name', name: 'Task', type: 'text' },
    { id: 'status', name: 'Status', type: 'select', options: statuses },
    { id: 'start', name: 'Start', type: 'date' },
    { id: 'end', name: 'End', type: 'date' },
  ],
  rows: Array.from({ length: 16 }, (_, i) => {
    // June 2026 to May 2027, then four more in the first months again. The first starts on
    // June 1st and the twelfth ends on May 31st: the month range must not widen past them.
    const months = 5 + (i % 12),
      year = 2026 + Math.floor(months / 12),
      month = String((months % 12) + 1).padStart(2, '0');
    return {
      id: `task-${i + 1}`,
      values: {
        name: `Task ${i + 1}`,
        status: statuses[i % 4],
        start: i === 0 ? `${year}-${month}-01` : `${year}-${month}-10`,
        end: i === 11 ? `${year}-${month}-31` : `${year}-${month}-20`,
      },
    };
  }),
};
const view = defaultView(data);
data.views = [{ ...view, id: 'plan', name: 'Plan', projection: 'Kanban', groupBy: 'status' }];

async function open(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'year-plan.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ ...createArtifact('data', 'Year plan', data), annotations: [] }),
    ),
  });
  await expect(page.locator('.ep-kanban-column')).toHaveCount(5);
}
const column = (page: import('@playwright/test').Page, name: string) =>
  page.locator('.ep-kanban-column').filter({ has: page.getByRole('heading', { name }) });

test.describe('Data month ticks and Kanban width at 1600px', () => {
  test.use({ viewport: { width: 1600, height: 1000 } });
  test('month ticks sit on the 1st, Kanban fits beside both panels and (empty) steps back', async ({
    page,
  }, info) => {
    await open(page);
    const navigator = page.getByRole('complementary', { name: 'Data navigator', exact: true });
    if (!(await navigator.isVisible()))
      await page.getByRole('button', { name: 'Toggle Data navigator', exact: true }).click();
    await expect(navigator).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: 'Data inspector', exact: true }),
    ).toBeVisible();

    const board = page.locator('.ep-kanban');
    const done = column(page, 'Done 4');
    const boardBox = (await board.boundingBox())!,
      doneBox = (await done.boundingBox())!;
    expect(doneBox.x + doneBox.width).toBeLessThanOrEqual(boardBox.x + boardBox.width);
    await expect(page.locator('.ep-kanban-frame')).not.toHaveAttribute('data-more-right');
    // No card has an empty status, so (empty) is narrow and quiet but still a drop target.
    const empty = column(page, '(empty) 0');
    await expect(empty).toHaveClass(/ep-kanban-column-quiet/);
    expect((await empty.boundingBox())!.width).toBeLessThan(doneBox.width);
    await page.screenshot({ path: info.outputPath('kanban-1600.png') });
    await page.getByLabel('Move Task 1 to', { exact: true }).selectOption('(empty)');
    await expect(column(page, '(empty) 1')).not.toHaveClass(/ep-kanban-column-quiet/);
    expect(
      ((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values.status,
    ).toBeNull();

    await page.getByLabel('Data projection', { exact: true }).selectOption('Timeline');
    await page.getByLabel('Time scale', { exact: true }).selectOption('month');
    await expect(page.locator('.ep-timeline-heading > span')).toHaveText('2026-06-01 — 2027-05-31');
    await expect(page.locator('.ep-timeline-axis > span')).toHaveText([
      'Jun 2026',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
      'Jan 2027',
      'Feb',
      'Mar',
      'Apr',
      'May',
    ]);
    await page.screenshot({ path: info.outputPath('timeline-month-1600.png') });
  });
});

test.describe('Data Kanban wider than the board', () => {
  test.use({ viewport: { width: 1000, height: 800 } });
  test('the edge with more columns past it is shaded while scrolling sideways', async ({
    page,
  }) => {
    await open(page);
    const frame = page.locator('.ep-kanban-frame');
    await expect(frame).toHaveAttribute('data-more-right', 'true');
    await expect(frame).not.toHaveAttribute('data-more-left');
    await page.locator('.ep-kanban').evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect(frame).toHaveAttribute('data-more-left', 'true');
    await expect(frame).not.toHaveAttribute('data-more-right');
  });
});
