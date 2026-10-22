import { createArtifact } from '@editor-platform/artifact-core';
import type { StructuredData } from '@editor-platform/structured-data';
import { defaultView } from '@editor-platform/structured-data/views';
import { test, expect, nativeArtifact } from './fixtures';

const data: StructuredData = {
  schemaVersion: 2,
  columns: [
    { id: 'name', name: 'Task', type: 'text' },
    { id: 'start', name: 'Start', type: 'date' },
    { id: 'end', name: 'End', type: 'date' },
    { id: 'due', name: 'Due', type: 'date' },
  ],
  rows: [
    // Thursday to the next Wednesday: one bar in each of two week rows.
    { id: 'long', values: { name: 'Body design', start: '2026-10-08', end: '2026-10-14' } },
    { id: 'short', values: { name: 'Crash test', start: '2026-10-21', end: '2026-10-21' } },
    { id: 'later', values: { name: 'Launch', start: '2026-11-16', end: '2026-11-18' } },
    { id: 'undated', values: { name: 'Pricing', start: null, end: null } },
  ],
};
data.views = [{ ...defaultView(data), id: 'plan', name: 'Plan', projection: 'Calendar' }];

const content = async (page: import('@playwright/test').Page) =>
  (await nativeArtifact(page)).draft.content as StructuredData;

test.use({ viewport: { width: 1440, height: 900 } });
test('Calendar shows records across week rows, moves months as view state and changes dates with one Undo', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'calendar-plan.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ ...createArtifact('data', 'Calendar plan', data), annotations: [] }),
    ),
  });
  const heading = page.locator('.ep-calendar-heading strong');
  await expect(heading).toHaveText('Oct 2026');
  await expect(page.locator('.ep-calendar-week')).toHaveCount(5);
  const long = page.getByRole('button', { name: 'Dates for Body design', exact: true });
  await expect(long).toHaveCount(2);
  await expect(long.first()).toHaveClass(/after/);
  await expect(long.last()).toHaveClass(/before/);
  await expect(long.first()).toHaveAttribute('title', '2026-10-08 — 2026-10-14');
  await expect(page.getByText('1 record without valid dates', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dates for Launch', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('calendar-october.png') });

  // Moving between months is private view state.
  const before = await nativeArtifact(page);
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(heading).toHaveText('Nov 2026');
  await expect(page.getByRole('button', { name: 'Dates for Launch', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await expect(heading).toHaveText('Sep 2026');
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  expect(await nativeArtifact(page)).toEqual(before);
  const undo = page.getByRole('button', { name: 'Undo', exact: true }).first();
  await expect(undo).toBeDisabled();

  // An end before the start is refused and nothing changes.
  await page.getByRole('button', { name: 'Dates for Crash test', exact: true }).click();
  await page.getByLabel('Calendar start date', { exact: true }).fill('2026-10-22');
  await page.getByLabel('Calendar end date', { exact: true }).fill('2026-10-20');
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Choose valid dates with end on or after start');
  expect(await content(page)).toEqual(data);

  await page.getByLabel('Calendar end date', { exact: true }).fill('2026-10-27');
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await expect(page.getByLabel('Calendar start date', { exact: true })).toBeHidden();
  const moved = page.getByRole('button', { name: 'Dates for Crash test', exact: true });
  await expect(moved).toHaveCount(2);
  expect((await content(page)).rows[1].values).toEqual({
    name: 'Crash test',
    start: '2026-10-22',
    end: '2026-10-27',
  });
  await undo.click();
  await expect(moved).toHaveCount(1);
  expect(await content(page)).toEqual(data);

  // An open edit keeps the fields it was opened with when the inspector changes them.
  await page.getByRole('button', { name: 'Dates for Crash test', exact: true }).click();
  const startField = page.getByLabel('Start field', { exact: true });
  await startField.selectOption({ label: 'Due' });
  await page.getByLabel('Calendar end date', { exact: true }).fill('2026-10-23');
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  expect((await content(page)).rows[1].values).toEqual({
    name: 'Crash test',
    start: '2026-10-21',
    end: '2026-10-23',
  });
  await undo.click();
  await startField.selectOption({ label: 'Start' });
  expect(await content(page)).toEqual(data);

  // Read only keeps the month view but not the date change.
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Read only', { exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Dates for Crash test', exact: true }).click();
  await expect(page.getByLabel('Calendar start date', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apply dates', exact: true })).toBeDisabled();
});
