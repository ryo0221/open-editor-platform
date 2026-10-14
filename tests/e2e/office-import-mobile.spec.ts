import { test, expect } from './fixtures';
import { openImport, ready } from './office-import-fixtures';
for (const width of [390, 768])
  test(`I06 ${width}px PPTX import preview and creation`, async ({ page }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 844 });
    const dialog = await openImport(page);
    await ready(dialog);
    await expect(dialog.getByLabel('Native import preview')).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(await dialog.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`import-${width}.png`), fullPage: true });
    await dialog.getByLabel('Accept import conversions').check();
    await dialog.getByRole('button', { name: 'Create imported artifact', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('application', { name: 'Slide canvas', exact: true }),
    ).toBeVisible();
  });
for (const width of [390, 768])
  test(`I06 ${width}px DOCX import preview and creation`, async ({ page }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 844 });
    const dialog = await openImport(page);
    await dialog
      .getByLabel('Office file', { exact: true })
      .setInputFiles('tests/fixtures/office/import/document/external.docx');
    await dialog.getByLabel('Import conversion policy').selectOption('review-conversions');
    await dialog.getByRole('button', { name: 'Prepare import preview', exact: true }).click();
    await expect(dialog.getByLabel('Accept import conversions')).toBeEnabled({ timeout: 30000 });
    await expect(dialog.getByLabel('Native import preview').locator('h1')).toHaveText(
      '外部作成の受付改善提案書',
    );
    expect(await dialog.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`word-import-${width}.png`), fullPage: true });
    await dialog.getByLabel('Accept import conversions').check();
    await dialog.getByRole('button', { name: 'Create imported artifact', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('textbox', { name: 'Document body', exact: true }).locator('ol[start="7"]'),
    ).toBeVisible();
  });
