import { test, expect, create, nativeArtifact, setDocumentText } from './fixtures';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

test('Image crop previews privately, cancels, commits once and matches actual PNG pixels', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'slide');
  const source = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 200;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(200, 0, 200, 200);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page
    .getByLabel('Insert image file')
    .setInputFiles({
      name: 'two-colors.png',
      mimeType: 'image/png',
      buffer: Buffer.from(source, 'base64'),
    });
  for (const [label, value] of [
    ['Element x', '100'],
    ['Element y', '100'],
    ['Element width', '200'],
    ['Element height', '200'],
  ]) {
    await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel(label, { exact: true }).press('Enter');
  }
  const before = (await nativeArtifact(page)).draft.content;
  await page.getByRole('button', { name: 'Crop image', exact: true }).click();
  await page.getByLabel('Crop scale', { exact: true }).fill('2');
  await page.getByLabel('Crop scale', { exact: true }).press('Enter');
  await expect(page.getByRole('img', { name: 'Crop preview' })).toBeVisible();
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await page.getByRole('button', { name: 'Cancel crop', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await page.getByRole('button', { name: 'Crop image', exact: true }).click();
  await page.getByLabel('Crop scale', { exact: true }).fill('2');
  await page.getByLabel('Crop scale', { exact: true }).press('Enter');
  await page.getByLabel('Crop x', { exact: true }).fill('-200');
  await page.getByLabel('Crop x', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Apply crop', exact: true }).click();
  const cropped = (await nativeArtifact(page)).draft.content;
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(cropped);
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const download = await pending;
  await download.saveAs(info.outputPath('image-crop.png'));
  const png = await readFile((await download.path())!);
  const pixels = await page.evaluate(async (base64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return [
      [150, 150],
      [250, 250],
      [50, 50],
    ].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
  }, png.toString('base64'));
  expect(pixels).toEqual([
    [0, 0, 255, 255],
    [0, 0, 255, 255],
    [255, 255, 255, 255],
  ]);
});

test('Document print preview and PDF retain multi-page rich and merged table content', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'document');
  await setDocumentText(page, 'h1', '表の改ページと日本語の確認');
  const text = '段階的に検証し、利用者の声を記録します。'.repeat(100);
  const html = `<p>比較内容を複数ページで読む。</p><table><tr><th>項目</th><th>説明</th></tr><tr><td rowspan="2">結合した項目</td><td><strong>${text}</strong></td></tr><tr><td>最後まで保持する。</td></tr></table><p>検証完了の目印</p>`;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(
    async (html) =>
      navigator.clipboard.write([
        new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }) }),
      ]),
    html,
  );
  await page.getByRole('textbox', { name: 'Document body' }).locator('p').last().click();
  await page.keyboard.press('Control+v');
  await expect(page.locator('.ProseMirror td[rowspan="2"]')).toContainText('結合した項目');
  const before = (await nativeArtifact(page)).draft.content;
  await page.getByRole('button', { name: 'Export document', exact: true }).click();
  await page.getByRole('button', { name: 'Print preview', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Document print preview' });
  await expect(dialog.getByRole('img').first()).toBeVisible();
  const count = await dialog.getByRole('img').count();
  expect(count).toBeGreaterThan(1);
  await dialog.getByRole('img').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('document-print-last-page.png') });
  await page.getByRole('button', { name: 'Close Document print preview', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await page.getByRole('button', { name: 'Export document', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const download = await pending;
  await download.saveAs(info.outputPath('rich-merged-table.pdf'));
  expect((await PDFDocument.load(await readFile((await download.path())!))).getPageCount()).toBe(
    count,
  );
});
