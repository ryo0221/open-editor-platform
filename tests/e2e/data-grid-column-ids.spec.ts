import { createArtifact } from '@editor-platform/artifact-core';
import type { StructuredData } from '@editor-platform/structured-data';
import { defaultView } from '@editor-platform/structured-data/views';
import { test, expect, nativeArtifact, save } from './fixtures';

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`Data arbitrary-ID widths at ${viewport.width}px`, () => {
    test.use({ viewport });
    test('default and own widths resize, save, Undo/Redo and reload without changing IDs or rows', async ({
      page,
    }, info) => {
      const ids = ['constructor', '__proto__', 'toString'];
      const data: StructuredData = {
        schemaVersion: 2,
        columns: ids.map((id) => ({ id, name: id, type: 'text' })),
        rows: [{ id: 'row-1', values: Object.fromEntries(ids.map((id) => [id, `Value ${id}`])) }],
      };
      data.views = [
        { ...defaultView(data), id: 'arbitrary-id-widths', name: 'Arbitrary IDs', frozen: 0 },
      ];
      await page.goto('/');
      await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
        name: 'arbitrary-width-ids.json',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({ ...createArtifact('data', 'Width IDs', data), annotations: [] }),
        ),
      });
      const grid = page.getByRole('grid', { name: 'Data grid', exact: true });
      const header = (id: string) =>
        page
          .getByRole('columnheader')
          .filter({ has: page.getByRole('button', { name: `Field ${id}`, exact: true }) });
      for (const id of ids) {
        await expect(header(id)).toHaveCSS('width', '160px');
        await page
          .getByRole('separator', { name: `Resize ${id}`, exact: true })
          .press('ArrowRight');
        await expect(header(id)).toHaveCSS('width', '170px');
      }
      // Resizing is a private view change until the explicit Save view command.
      expect((await nativeArtifact(page)).draft.content).toEqual(data);
      const saveView = page.getByRole('button', { name: 'Save view', exact: true });
      const openNavigator = !(await saveView.isVisible());
      if (openNavigator)
        await page.getByRole('button', { name: 'Toggle Data navigator', exact: true }).click();
      await saveView.click();
      if (openNavigator)
        await page.getByRole('button', { name: 'Close Data navigator', exact: true }).click();
      const saved = (await nativeArtifact(page)).draft.content as StructuredData;
      expect(saved.columns).toEqual(data.columns);
      expect(saved.rows).toEqual(data.rows);
      expect(saved.views![0].widths).toEqual(Object.fromEntries(ids.map((id) => [id, 170])));
      for (const id of ids) expect(Object.hasOwn(saved.views![0].widths, id)).toBe(true);
      const history = async (name: 'Undo' | 'Redo') => {
        const button = page.getByRole('button', { name, exact: true }).first();
        const openTools = !(await button.isVisible());
        if (openTools)
          await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
        await button.click();
        if (openTools) await page.keyboard.press('Escape');
      };
      await history('Undo');
      expect((await nativeArtifact(page)).draft.content).toEqual(data);
      for (const id of ids) await expect(header(id)).toHaveCSS('width', '160px');
      await history('Redo');
      expect((await nativeArtifact(page)).draft.content).toEqual(saved);
      await save(page, 1);
      await page.reload();
      await expect(grid).toBeVisible();
      for (const id of ids) await expect(header(id)).toHaveCSS('width', '170px');
      const reopened = await nativeArtifact(page);
      expect(reopened.draft.content).toEqual(saved);
      expect(reopened.versions).toHaveLength(1);
      expect(reopened.versions[0].content).toEqual(saved);
      await grid.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await expect(
        page.getByRole('gridcell', { name: 'toString · record 1', exact: true }),
      ).toHaveText('Value toString');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: info.outputPath(`data-widths-${viewport.width}.png`) });
    });
  });
}
