import { test, expect, nativeArtifact } from './fixtures';
import { importUsability } from './usability-fixtures';
import { exportCsv, type StructuredData } from '@editor-platform/structured-data/model';

for (const width of [1440, 390]) {
  for (const append of [true, false]) {
    test(`CSV apostrophes and explicit own-export decoding: ${width}px ${append ? 'append' : 'replace'}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const data: StructuredData = {
        schemaVersion: 2,
        columns: [{ id: 'note', name: '-Notes', type: 'text' }],
        rows: [{ id: 'old', values: { note: 'keep' } }],
      };
      await importUsability(page, 'data', data);
      const dialog = page.getByRole('dialog', { name: 'CSV import preview' });
      const option = dialog.getByLabel('Restore formula-like text from this editor’s CSV export');
      const upload = async (source: string) => {
        if (!(await page.getByLabel('Import CSV file', { exact: true }).count()))
          await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
        await page.getByLabel('Import CSV file', { exact: true }).setInputFiles({
          name: 'values.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(source),
        });
        await expect(option).not.toBeChecked();
        await dialog.getByLabel('Append to matching fields').setChecked(append);
      };
      await upload("-Notes\r\n'=pending\r\n");
      await expect(dialog.locator('tbody')).toContainText("'=pending");
      await dialog.getByRole('button', { name: 'Import records', exact: true }).click();
      let current = (await nativeArtifact(page)).draft.content as StructuredData;
      expect(current.rows.at(-1)!.values[current.columns[0].id]).toBe("'=pending");

      const own = {
        ...data,
        rows: [
          { id: 'one', values: { note: '=1+1' } },
          { id: 'two', values: { note: "'=pending" } },
        ],
      };
      await upload(exportCsv(own));
      await option.check();
      await expect(dialog.locator('tbody')).toContainText('=1+1');
      await expect(dialog.locator('tbody')).toContainText("'=pending");
      await page.screenshot({ path: info.outputPath('csv-decoding-preview.png') });
      await dialog.getByRole('button', { name: 'Import records', exact: true }).click();
      current = (await nativeArtifact(page)).draft.content as StructuredData;
      expect(current.columns[0].name).toBe('-Notes');
      expect(current.rows.slice(-2).map((r) => r.values[current.columns[0].id])).toEqual([
        '=1+1',
        "'=pending",
      ]);
      expect(current.rows).toHaveLength(append ? 4 : 2);
      // A new upload always returns to the lossless generic-import default.
      await upload("-Notes\r\n'=pending\r\n");
      await expect(dialog.locator('tbody')).toContainText("'=pending");
    });
  }
}

for (const width of [1440, 390]) {
  test(`CSV decoding retains selected replace types: ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await importUsability(page, 'data', {
      schemaVersion: 2,
      columns: [{ id: 'note', name: 'Note', type: 'text' }],
      rows: [],
    });
    if (!(await page.getByLabel('Import CSV file', { exact: true }).count()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await page.getByLabel('Import CSV file', { exact: true }).setInputFiles({
      name: 'own.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from("Date,Count,Note\n2026-10-21,100,'=1+1\n"),
    });
    const dialog = page.getByRole('dialog', { name: 'CSV import preview' });
    await dialog.getByLabel('Append to matching fields').uncheck();
    await dialog.getByLabel('Import type Date', { exact: true }).selectOption('date');
    await dialog.getByLabel('Import type Count', { exact: true }).selectOption('text');
    const option = dialog.getByLabel('Restore formula-like text from this editor’s CSV export');
    for (const decode of [true, false, true]) {
      await option.setChecked(decode);
      await expect(dialog.getByLabel('Import type Date', { exact: true })).toHaveValue('date');
      await expect(dialog.getByLabel('Import type Count', { exact: true })).toHaveValue('text');
      await expect(dialog.locator('tbody tr').first().locator('td').nth(2)).toHaveText(
        decode ? '=1+1' : "'=1+1",
      );
    }
    await dialog.getByRole('button', { name: 'Import records', exact: true }).click();
    const current = (await nativeArtifact(page)).draft.content as StructuredData;
    expect(current.columns.map((c) => c.type)).toEqual(['date', 'text', 'text']);
    expect(Object.values(current.rows[0].values)).toEqual(['2026-10-21', '100', '=1+1']);
  });
}
