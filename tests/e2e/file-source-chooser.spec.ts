import { PDFDocument } from 'pdf-lib';
import { originalBytes, type FileContent } from '@editor-platform/review-surfaces/model';
import { create, expect, nativeArtifact, test } from './fixtures';

for (const width of [390, 768, 1440]) {
  test(`File replacement opens the real chooser and preserves PDF/Undo at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await create(page, 'file');
    const original = (await nativeArtifact(page)).draft.content;
    const pdf = await PDFDocument.create();
    pdf.addPage([400, 600]).drawText('Chooser replacement page 1', { x: 30, y: 500 });
    pdf.addPage([400, 600]).drawText('Chooser replacement page 2', { x: 30, y: 500 });
    const bytes = Buffer.from(await pdf.save());
    const replace = page.getByRole('button', { name: 'Replace source', exact: true });
    if (!(await replace.isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await replace.click();
    const dialog = page.getByRole('dialog', { name: 'Replace source', exact: true });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Confirm source replacement', exact: true }),
    ).toBeDisabled();
    // Wait for the actual button's chooser. Direct setInputFiles would bypass a lost input ref.
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Choose replacement file', exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: 'chooser.pdf',
      mimeType: 'application/pdf',
      buffer: bytes,
    });
    await expect(dialog).toContainText('新しい原本: chooser.pdf · application/pdf');
    await dialog.getByRole('button', { name: 'Confirm source replacement', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('Rendered PDF page 1', { exact: true })).toBeVisible();
    const next = page.getByRole('button', { name: 'Next PDF page', exact: true });
    if (!(await next.isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await next.click();
    await expect(page.getByLabel('PDF page', { exact: true })).toHaveValue('2');
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Rendered PDF page 2', { exact: true })).toBeVisible();
    const replaced = (await nativeArtifact(page)).draft.content as FileContent;
    expect(replaced).toMatchObject({
      name: 'chooser.pdf',
      mime: 'application/pdf',
      size: bytes.length,
    });
    expect(Buffer.from(originalBytes(replaced))).toEqual(bytes);
    await page.screenshot({ path: info.outputPath(`replaced-pdf-${width}.png`) });
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    if (!(await undo.isVisible()))
      await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await undo.click();
    expect((await nativeArtifact(page)).draft.content).toEqual(original);
  });
}
