import { test, expect, nativeArtifact } from './fixtures';
import type { StructuredData } from '@editor-platform/structured-data';
import { readFile } from 'node:fs/promises';
async function field(
  page: import('@playwright/test').Page,
  name: string,
  type: string,
  options?: string,
) {
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add field', exact: true });
  await dialog.getByLabel('New field name').fill(name);
  await dialog.getByLabel('New field type').selectOption(type);
  if (options) await dialog.getByLabel('New field options').fill(options);
  await dialog.getByRole('button', { name: 'Create field', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function paste(page: import('@playwright/test').Page, text: string) {
  await page.getByRole('grid', { name: 'Data grid' }).evaluate((el, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
  }, text);
}
async function projection(page: import('@playwright/test').Page, value: string) {
  await page.getByLabel('Data projection', { exact: true }).selectOption(value);
}
test('H3 fifty records stay consistent across grid, form, kanban, timeline, dashboard and CSV', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByRole('button', { name: 'New Structured Data', exact: true }).click();
  for (const [name, type, options] of [
    ['Owner', 'text'],
    ['Category', 'select', 'Platform,Content'],
    ['Start', 'date'],
    ['End', 'date'],
  ])
    await field(page, name, type, options);
  await page.getByRole('button', { name: 'Back to view settings', exact: true }).click();
  const source = Array.from({ length: 50 }, (_, i) =>
    [
      `案件${String(i + 1).padStart(3, '0')}`,
      i % 3 === 0 ? 'Done' : i % 3 === 1 ? 'Active' : 'Planned',
      String(i + 1),
      '10',
      '',
      i % 2 ? '佐藤' : '田中',
      i % 2 ? 'Platform' : 'Content',
      '2026-10-02',
      '2026-10-08',
    ].join('\t'),
  ).join('\n');
  await paste(page, source);
  await expect(page.getByRole('grid', { name: 'Data grid' })).toHaveAttribute(
    'aria-rowcount',
    '51',
  );
  await expect(page.getByRole('gridcell', { name: 'Name · record 1', exact: true })).toHaveText(
    '案件001',
  );
  const data = async () => (await nativeArtifact(page)).draft.content as StructuredData;
  const initial = await data();
  const targetId = initial.rows[49].id;
  const column = (name: string) => initial.columns.find((c) => c.name === name)!.id;
  const expected = structuredClone(initial);
  const target = expected.rows.find((r) => r.id === targetId)!;
  await page.getByRole('button', { name: 'Add sort', exact: true }).click();
  await page.getByLabel('Sort 1 field', { exact: true }).selectOption({ label: 'Name' });
  await page.getByLabel('Sort 1 direction', { exact: true }).selectOption('desc');
  await expect(page.getByRole('gridcell', { name: 'Name · record 1', exact: true })).toHaveText(
    '案件050',
  );
  expect(await data()).toEqual(initial);
  await page.getByRole('gridcell', { name: 'Quantity · record 1', exact: true }).click();
  await paste(page, '7\t11');
  await expect(page.getByRole('gridcell', { name: 'Total · record 1', exact: true })).toHaveText(
    '77',
  );
  target.values[column('Quantity')] = 7;
  target.values[column('Price')] = 11;
  expect(await data()).toEqual(expected);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('gridcell', { name: 'Total · record 1', exact: true })).toHaveText(
    '500',
  );
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('gridcell', { name: 'Total · record 1', exact: true })).toHaveText(
    '77',
  );
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  await page.getByLabel('Filter 1 field', { exact: true }).selectOption({ label: 'Owner' });
  await page.getByLabel('Filter 1 operator', { exact: true }).selectOption('equals');
  await page.getByLabel('Filter 1 value', { exact: true }).fill('佐藤');
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '26');
  await projection(page, 'Form');
  await expect(page.getByLabel('Record Name', { exact: true })).toHaveValue('案件050');
  await page.getByLabel('Record Quantity', { exact: true }).fill('wrong');
  await projection(page, 'Chart');
  await projection(page, 'Form');
  await expect(page.getByLabel('Record Quantity', { exact: true })).toHaveValue('wrong');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(page.getByText('Enter a number', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await expect(page.getByLabel('Record Quantity', { exact: true })).toHaveValue('7');
  expect(await data()).toEqual(expected);
  await page.getByLabel('Record Quantity', { exact: true }).fill('9');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  target.values[column('Quantity')] = 9;
  expect(await data()).toEqual(expected);
  await projection(page, 'Kanban');
  await page.getByLabel('Move 案件050 to', { exact: true }).selectOption('Done');
  await expect(page.getByLabel('Move 案件050 to', { exact: true })).toHaveValue('Done');
  target.values[column('Status')] = 'Done';
  expect(await data()).toEqual(expected);
  await projection(page, 'Timeline');
  await page.getByLabel('Start field', { exact: true }).selectOption({ label: 'Start' });
  await page.getByLabel('End field', { exact: true }).selectOption({ label: 'End' });
  await page.getByRole('button', { name: '案件050', exact: true }).click();
  await page.getByLabel('Timeline start date', { exact: true }).fill('2026-10-04');
  await page.getByLabel('Timeline end date', { exact: true }).fill('2026-10-12');
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Dates for 案件050', exact: true }),
  ).toHaveAttribute('title', '2026-10-04 — 2026-10-12');
  target.values[column('Start')] = '2026-10-04';
  target.values[column('End')] = '2026-10-12';
  expect(await data()).toEqual(expected);
  const bar = page.getByRole('button', { name: 'Dates for 案件050', exact: true });
  const timelineRange = await page.locator('.ep-timeline-heading > span').textContent();
  const [from, to] = timelineRange!.split(' — ').map((value) => Date.parse(`${value}T00:00:00Z`));
  const days = (to - from) / 86400000 + 1;
  const width = await bar.locator('..').evaluate((el) => el.getBoundingClientRect().width);
  for (const mode of ['move', 'start', 'end']) {
    const grip =
      mode === 'move' ? bar : bar.getByRole('button', { name: `Resize ${mode} date`, exact: true });
    await grip.scrollIntoViewIfNeeded();
    const box = (await grip.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + (width / days) * 2, box.y + box.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    const moved = structuredClone(expected),
      row = moved.rows.find((row) => row.id === target.id)!;
    if (mode !== 'end') row.values[column('Start')] = '2026-10-06';
    if (mode !== 'start') row.values[column('End')] = '2026-10-14';
    expect(await data()).toEqual(moved);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await data()).toEqual(expected);
  }
  await page.screenshot({ path: info.outputPath('data-timeline.png') });
  await projection(page, 'Chart');
  await page.getByLabel('Chart type', { exact: true }).selectOption('line');
  expect(await data()).toEqual(expected);
  await page.getByRole('button', { name: 'Clear filters and sort', exact: true }).click();
  await projection(page, 'Dashboard');
  await page.getByRole('button', { name: 'Add metric widget', exact: true }).click();
  await page.getByRole('button', { name: 'Add chart widget', exact: true }).click();
  await page.getByRole('button', { name: 'Add table widget', exact: true }).click();
  await expect(page.locator('.ep-widget')).toHaveCount(3);
  await expect(page.getByLabel('Metric', { exact: true })).toHaveText('12,349');
  await page.getByLabel('View name', { exact: true }).fill('Delivery overview');
  await page.getByLabel('View name', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  const named = await data();
  expect(named.rows).toEqual(expected.rows);
  expect(named.columns).toEqual(expected.columns);
  expect(named).not.toEqual(expected);
  await page.getByRole('button', { name: 'Export data', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'CSV export scope' })
    .getByRole('button', { name: 'Download CSV', exact: true })
    .click();
  const file = await download,
    path = info.outputPath('fifty-records.csv');
  await file.saveAs(path);
  const csv = await readFile(path, 'utf8');
  expect(csv).toContain('案件050,Done,9,11,99,佐藤,Platform,2026-10-04,2026-10-12');
  expect(csv.trim().split('\r\n')).toHaveLength(51);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await expect(page.getByLabel('Data projection', { exact: true })).toHaveValue('Dashboard');
  await expect(page.getByLabel('Metric', { exact: true })).toHaveText('12,349');
  await page.screenshot({ path: info.outputPath('data-dashboard.png') });
  await projection(page, 'Grid');
  await page.getByRole('button', { name: 'Field Quantity', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('数量');
  await page.getByRole('button', { name: 'Apply field settings', exact: true }).click();
  await expect(page.getByRole('gridcell', { name: 'Total · record 1', exact: true })).toHaveText(
    '10',
  );
  await page.screenshot({ path: info.outputPath('data-grid.png') });
});
