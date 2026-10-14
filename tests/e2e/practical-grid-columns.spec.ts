import { createArtifact } from '@editor-platform/artifact-core';
import type { StructuredData } from '@editor-platform/structured-data';
import { test, expect, nativeArtifact } from './fixtures';

test('R6-06 wide Data keeps frozen columns, distant keyboard edits, formulas and history after reload', async ({
  page,
}) => {
  const content: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'name', name: 'Name', type: 'text' },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `metric-${i + 1}`,
        name: `Metric ${i + 1}`,
        type: 'number' as const,
      })),
      { id: 'total', name: 'Total', type: 'formula', formula: '[Metric 30] * 2' },
    ],
    rows: [1, 2].map((n) => ({
      id: `record-${n}`,
      values: {
        name: `案件${n}`,
        ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`metric-${i + 1}`, i + 1])),
      },
    })),
  };
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'wide-grid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ ...createArtifact('data', 'Wide grid', content), annotations: [] }),
    ),
  });
  const grid = page.getByRole('grid', { name: 'Data grid', exact: true });
  await expect(grid).toHaveAttribute('aria-colcount', '33');
  const frozen = page.getByLabel('Frozen columns', { exact: true });
  await frozen.fill('1');
  await frozen.press('Enter');
  const first = page.getByRole('gridcell', { name: 'Name · record 1', exact: true });
  await first.click();
  for (let i = 0; i < 30; i++) await page.keyboard.press('Tab');
  const last = page.getByRole('gridcell', { name: 'Metric 30 · record 1', exact: true });
  await expect(last).toHaveClass(/active/);
  const edge = await grid.boundingBox(),
    fixed = await first.boundingBox();
  expect(fixed!.x).toBeGreaterThanOrEqual(edge!.x);
  expect(fixed!.x + fixed!.width).toBeLessThan(edge!.x + edge!.width);
  await expect(
    page
      .getByRole('columnheader')
      .filter({ has: page.getByRole('button', { name: 'Field Metric 30', exact: true }) }),
  ).toHaveAttribute('aria-colindex', '32');
  await page.keyboard.press('Enter');
  await page.getByLabel('Edit Metric 30', { exact: true }).fill('123');
  await page.getByLabel('Edit Metric 30', { exact: true }).press('Enter');
  const total = page.getByRole('gridcell', { name: 'Total · record 1', exact: true });
  await expect(last).toHaveText('123');
  await expect(total).toHaveText('246');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(last).toHaveText('30');
  await expect(total).toHaveText('60');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(total).toHaveText('246');
  expect(
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[0].values['metric-30'],
  ).toBe(123);
  await expect(page.locator('.save-status')).toContainText('Saved locally');
  await page.reload();
  await grid.hover();
  await page.mouse.wheel(6000, 0);
  await expect(last).toHaveText('123');
  await expect(total).toHaveText('246');
  await page.screenshot({ path: 'docs/screenshots/issue-6/data-wide-columns.png' });
});
