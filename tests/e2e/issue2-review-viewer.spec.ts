import { replaceFileSource, test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { Page } from '@playwright/test';
async function native(page: Page) {
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const file = await download;
  const result = JSON.parse(await readFile((await file.path())!, 'utf8'));
  await page.keyboard.press('Escape');
  return result;
}
async function comment(page: Page, body: string) {
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /^Comments \(/ }).click();
  await page.keyboard.press('Escape');
  await page.getByLabel('Comment', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
}
async function sources(page: Page, old: string, newer: string) {
  await page.getByRole('button', { name: 'Comparison sources', exact: true }).click();
  await page.getByLabel('Old text', { exact: true }).fill(old);
  await page.getByLabel('New text', { exact: true }).fill(newer);
  await page.getByRole('button', { name: 'Apply comparison sources', exact: true }).click();
}
test('QA-13 / ID-Q09 split and unified review anchors retain source side and mark replaced sources outdated', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Code Review', exact: true }).click();
  const old = 'const 前提 = 1;\nconst 削除 = 2;\nconst 終わり = 3;',
    newer = 'const 前提 = 1;\nconst 追加 = 4;\nconst 続き = 5;\nconst 終わり = 3;';
  await sources(page, old, newer);
  await page.getByRole('button', { name: 'removed old line 2', exact: true }).click();
  await comment(page, '削除した理由を確認');
  const thread = page.locator('.comment-thread').first();
  await expect(thread).toContainText('old · lines 2–2');
  await thread.getByText('Reply', { exact: true }).click();
  await thread.getByLabel('Reply text').fill('旧仕様を置き換えました');
  await thread.getByRole('button', { name: 'Post reply' }).click();
  await thread.getByRole('button', { name: 'Resolve', exact: true }).click();
  await thread.getByRole('button', { name: 'Reopen', exact: true }).click();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await page.getByRole('button', { name: 'added new line 2', exact: true }).click();
  await page
    .getByRole('button', { name: 'added new line 3', exact: true })
    .click({ modifiers: ['Shift'] });
  await comment(page, '新しい範囲の確認');
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  const before = await native(page);
  expect(before.annotations[0].anchor.addresses[0].region.side).toBe('old');
  expect(before.annotations[1].anchor.addresses[0].region).toMatchObject({
    side: 'new',
    start: 2,
    end: 3,
  });
  await page.getByLabel('Diff layout').selectOption('unified');
  await page.getByRole('button', { name: 'Next change', exact: true }).click();
  await expect(page.getByRole('button', { name: 'removed old line 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add comparison file', exact: true }).click();
  await page.getByLabel('Comparison file name').fill('large.ts');
  const large = Array.from({ length: 3300 }, (_, i) => `const value${i} = ${i};`);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((text) => navigator.clipboard.writeText(text), large.join('\n'));
  await page.getByLabel('Old text', { exact: true }).press('Control+v');
  large[1600] = 'const 検索対象 = 42;';
  await page.evaluate((text) => navigator.clipboard.writeText(text), large.join('\n'));
  await page.getByLabel('New text', { exact: true }).press('Control+v');
  await page.getByRole('button', { name: 'Apply comparison sources', exact: true }).click();
  await page.getByLabel('Search diff').fill('検索対象');
  await page.getByRole('button', { name: 'Next search match', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'added new line 1601', exact: true }),
  ).toBeVisible();
  expect(await page.locator('[data-vrow]').count()).toBeLessThan(150);
  await page.getByRole('button', { name: 'example.ts', exact: true }).click();
  await page.getByLabel('Search diff').fill('');
  await sources(page, 'const 前提 = 1;\nconst 別の根拠 = 10;', newer);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /^Comments \(/ }).click();
  await page.keyboard.press('Escape');
  await expect(thread).toContainText('Outdated');
  await expect(thread.getByRole('button', { name: 'Jump to annotation' })).toBeDisabled();
  expect((await native(page)).annotations).toEqual(before.annotations);
  await page.screenshot({ path: info.outputPath('review-outdated.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(thread).toContainText('Current');
  await thread.getByRole('button', { name: 'Jump to annotation' }).click();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await page.getByLabel('Diff layout').selectOption('split');
  await page.screenshot({ path: info.outputPath('review-split.png') });
});
test('Review long-line horizontal scroll stays aligned across both sides and virtual rows', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Code Review', exact: true }).click();
  const old = Array.from(
    { length: 100 },
    (_, i) => `const 行${i} = "${'長い値 '.repeat(60)}";`,
  ).join('\n');
  await sources(page, old, old.replaceAll('const ', 'let '));
  await page.getByLabel('Diff layout').selectOption('split');
  await page.getByLabel('Wrap lines', { exact: true }).uncheck();
  const before = (await native(page)).draft.content;
  const scrollbar = page.getByRole('region', { name: 'Scroll code horizontally' });
  await scrollbar.hover();
  await page.mouse.wheel(300, 0);
  await expect.poll(() => scrollbar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(200);
  const shifts = () =>
    page
      .locator('.ep-code-text')
      .evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).transform))]);
  const initial = await shifts();
  expect(initial).toHaveLength(1);
  expect(initial[0]).not.toBe('matrix(1, 0, 0, 1, 0, 0)');
  await page.getByRole('region', { name: 'Code diff' }).hover();
  await page.mouse.wheel(0, 1800);
  await expect.poll(() => shifts()).toEqual(initial);
  await page.getByLabel('Wrap lines', { exact: true }).check();
  await expect(scrollbar).toBeHidden();
  expect((await native(page)).draft.content).toEqual(before);
});
test('QA-14 / ID-Q10 renders real PDF page 3, restores a page-coordinate region and downloads identical bytes', async ({
  page,
}, info) => {
  await page.goto('/');
  const images = await page.evaluate(() =>
    Array.from({ length: 5 }, (_, i) => {
      const canvas = document.createElement('canvas');
      canvas.width = 612;
      canvas.height = 792;
      const c = canvas.getContext('2d')!;
      c.fillStyle = 'white';
      c.fillRect(0, 0, 612, 792);
      c.fillStyle = ['#d9e8fa', '#dbecd5', '#f2e3a8', '#eadcf5', '#f8d9ce'][i];
      c.fillRect(35, 160, 542, 420);
      c.fillStyle = '#253044';
      c.font = 'bold 28px sans-serif';
      c.fillText(`提案資料 · ${i + 1} ページ`, 40, 90);
      c.font = '20px sans-serif';
      c.fillText(['現状の課題', '調査の結果', '比較と判断', '実施計画', '次の行動'][i], 55, 210);
      return canvas.toDataURL('image/png');
    }),
  );
  const pdf = await PDFDocument.create();
  for (const source of images) {
    const img = await pdf.embedPng(source);
    pdf.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  }
  const bytes = Buffer.from(await pdf.save());
  await page.getByRole('button', { name: 'New File Viewer', exact: true }).click();
  await replaceFileSource(page, {
    name: '日本語の提案.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await expect(page.getByLabel('Rendered PDF page 1', { exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await page.getByLabel('PDF page', { exact: true }).fill('3');
  await page.getByLabel('PDF page', { exact: true }).press('Enter');
  await expect(page.getByLabel('Rendered PDF page 3', { exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await page.getByRole('button', { name: 'Select file region', exact: true }).click();
  const overlay = page.getByLabel('Select PDF region on page 3', { exact: true }),
    box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.22);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.35, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('selected-file-region')).toBeVisible();
  await comment(page, '比較結果を再確認');
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  const before = await native(page),
    anchor = before.annotations[0].anchor.addresses[0].region;
  expect(anchor).toMatchObject({ type: 'page', page: 3, units: 'pdf-points' });
  expect(anchor.bounds.width).toBeCloseTo(612 * 0.55, 0);
  await page.getByLabel('File zoom', { exact: true }).selectOption('1.5');
  await expect(page.getByLabel('Rendered PDF page 3', { exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  expect((await native(page)).draft.content).toEqual(before.draft.content);
  await page.getByRole('button', { name: 'Next PDF page', exact: true }).click();
  await expect(page.getByLabel('Rendered PDF page 4', { exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await page.getByRole('button', { name: 'Previous PDF page', exact: true }).click();
  await expect(page.locator('.ep-file-region').first()).toBeVisible();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'この版を保存', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await expect(page.getByLabel('Rendered PDF page 1', { exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await page.getByRole('button', { name: '比較結果を再確認 · Open', exact: true }).click();
  await expect(page.getByLabel('Rendered PDF page 3', { exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  expect((await native(page)).annotations[0].anchor.addresses[0].region).toEqual(anchor);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original file', exact: true }).click();
  const file = await download,
    path = info.outputPath('original-five-page.pdf');
  await file.saveAs(path);
  expect(await readFile(path)).toEqual(bytes);
  await page.screenshot({ path: info.outputPath('pdf-page-three-region.png') });
  const raster = await page
    .getByLabel('Rendered PDF page 3', { exact: true })
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL('image/png'));
  expect(raster.length).toBeGreaterThan(10000);
});

test('ID-Q10 image pixel anchors survive view rotation and text original retains BOM and CRLF', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New File Viewer', exact: true }).click();
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#f5e1bb';
    c.fillRect(0, 0, 400, 200);
    c.fillStyle = '#294a78';
    c.fillRect(80, 40, 120, 60);
    c.font = '20px sans-serif';
    c.fillText('元画像の領域', 30, 155);
    return canvas.toDataURL('image/png');
  });
  const bytes = Buffer.from(source.split(',')[1], 'base64');
  await replaceFileSource(page, { name: '原本.png', mimeType: 'image/png', buffer: bytes });
  await expect(page.getByText('400 × 200 pixels', { exact: true })).toBeVisible();
  await page.getByLabel('File zoom', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Select file region', exact: true }).click();
  const box = (await page.getByLabel('Select image region', { exact: true }).boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 100, { steps: 8 });
  await page.mouse.up();
  await comment(page, '画像の領域');
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  const before = await native(page);
  expect(before.annotations[0].anchor.addresses[0].region).toMatchObject({
    units: 'image-pixels',
    x: 80,
    y: 40,
    width: 120,
    height: 60,
  });
  await page.getByRole('button', { name: 'Rotate view clockwise', exact: true }).click();
  await page.getByLabel('File zoom', { exact: true }).selectOption('2');
  const rect = await page.getByTestId('selected-file-region').evaluate((element) => {
    const shape = element as SVGGraphicsElement,
      box = shape.getBBox(),
      matrix = shape.getScreenCTM()!;
    const a = new DOMPoint(box.x, box.y).matrixTransform(matrix),
      b = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
    return { width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  });
  expect(rect.width).toBeCloseTo(120, 0);
  expect(rect.height).toBeCloseTo(240, 0);
  expect((await native(page)).draft.content).toEqual(before.draft.content);
  await page.screenshot({ path: info.outputPath('image-rotated-region.png') });
  let pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original file', exact: true }).click();
  let file = await pending;
  expect(await readFile((await file.path())!)).toEqual(bytes);
  const text = Buffer.from('\ufeff日本語のログ\r\nsecond line\r\n');
  await replaceFileSource(page, { name: 'BOM-log.txt', mimeType: 'text/plain', buffer: text });
  await expect(page.getByRole('button', { name: 'File line 1', exact: true })).toContainText(
    '日本語のログ',
  );
  await page.getByLabel('Search file', { exact: true }).fill('second');
  await page.getByRole('button', { name: 'Next file match', exact: true }).click();
  await page.getByRole('button', { name: 'File line 2', exact: true }).click();
  pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original file', exact: true }).click();
  file = await pending;
  expect(await readFile((await file.path())!)).toEqual(text);
  await expect(
    page.getByRole('button', { name: '画像の領域 · Orphan', exact: true }),
  ).toBeVisible();
});
