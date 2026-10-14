import { replaceFileSource, test, expect, create, setDocumentText } from './fixtures';
import { PDFDocument } from 'pdf-lib';

for (const width of [390, 768])
  test(`QA-17 all surfaces retain navigation and reachable panels at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    await page.goto('/');
    for (const [kind, name] of [
      ['slide', 'Slide'],
      ['design', 'Design'],
      ['whiteboard', 'Whiteboard'],
      ['document', 'Document'],
      ['data', 'Data'],
      ['review', 'Review'],
      ['file', 'File'],
    ] as const) {
      await create(page, kind);
      const viewport = page.getByTestId('editor-viewport');
      expect((await viewport.boundingBox())!.y).toBeLessThanOrEqual(112);
      expect((await viewport.boundingBox())!.height).toBeGreaterThan(400);
      if (['slide', 'design', 'whiteboard'].includes(kind)) {
        await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
        await page.getByRole('button', { name: 'Insert text', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('application')).toBeVisible();
      }
      if (kind === 'slide') {
        await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
        await page.getByRole('button', { name: 'Add slide layout', exact: true }).click();
        await page.getByRole('button', { name: 'title', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(page.getByLabel('Current page', { exact: true })).toHaveValue('2');
        await page.getByRole('button', { name: 'Previous slide', exact: true }).click();
        await expect(page.getByLabel('Current page', { exact: true })).toHaveValue('1');
      }
      if (kind === 'document') {
        await setDocumentText(page, 'p', '狭い画面でも文章を編集して読み返す。');
        await expect(page.locator('.ProseMirror')).toContainText('狭い画面でも');
      }
      if (kind === 'data') {
        await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
        await page.getByRole('button', { name: 'Add records', exact: true }).click();
        await page.getByRole('button', { name: 'Add 1 record', exact: true }).click();
        await page.keyboard.press('Escape');
        await page.getByRole('gridcell', { name: 'Name · record 1', exact: true }).dblclick();
        await page.getByLabel('Edit Name', { exact: true }).fill('モバイルで確認する案件');
        await page.getByLabel('Edit Name', { exact: true }).press('Enter');
        await expect(
          page.getByRole('gridcell', { name: 'Name · record 1', exact: true }),
        ).toHaveText('モバイルで確認する案件');
      }
      if (kind === 'file') {
        const pdf = await PDFDocument.create();
        pdf.addPage([400, 600]).drawText('Mobile page 1', { x: 30, y: 500 });
        pdf.addPage([400, 600]).drawText('Mobile page 2', { x: 30, y: 500 });
        await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
        await replaceFileSource(page, {
          name: 'mobile.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(await pdf.save()),
        });
        await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
        await page.getByRole('button', { name: 'Next PDF page', exact: true }).click();
        await expect(page.getByLabel('PDF page', { exact: true })).toHaveValue('2');
        await page.keyboard.press('Escape');
        await expect(page.locator('.ep-pdf-page canvas')).toBeVisible();
      }
      const toggles = page.locator('.ep-toolbar').getByRole('button', { name: /^Toggle / });
      for (let i = 0; i < 2; i++) {
        const toggle = toggles.nth(i);
        const label = (await toggle.getAttribute('aria-label'))!.replace('Toggle ', '');
        await toggle.click();
        await expect(page.getByRole('complementary', { name: label, exact: true })).toBeVisible();
        await page.getByRole('button', { name: `Close ${label}`, exact: true }).click();
        await expect(toggle).toBeFocused();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: info.outputPath(`${name.toLowerCase()}-${width}.png`) });
    }
  });
