import { test, expect, setDocumentText } from './fixtures';
import { prototypeImage } from './authored-image';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
async function selectText(
  page: import('@playwright/test').Page,
  selector: string,
  start: number,
  end: number,
) {
  await page.locator(selector).evaluate(
    (element, { start, end }) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null,
        total = 0,
        from: Node | null = null,
        to: Node | null = null,
        fo = 0,
        eo = 0;
      while ((node = walker.nextNode())) {
        const size = node.textContent?.length ?? 0;
        if (!from && start <= total + size) {
          from = node;
          fo = start - total;
        }
        if (end <= total + size) {
          to = node;
          eo = end - total;
          break;
        }
        total += size;
      }
      const selection = window.getSelection()!,
        range = document.createRange();
      range.setStart(from ?? element, fo);
      range.setEnd(to ?? element, eo);
      selection.removeAllRanges();
      selection.addRange(range);
      (element.closest('[contenteditable]') as HTMLElement).focus();
      document.dispatchEvent(new Event('selectionchange'));
    },
    { start, end },
  );
  await page.waitForTimeout(80);
}
async function insert(page: import('@playwright/test').Page, label: string) {
  await page.getByRole('button', { name: 'Insert block', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Insert document block' })
    .getByRole('button', { name: label, exact: true })
    .click();
}
test('H3 document rich editing, IME events, stable IDs, table edits and ordinary exports', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Document', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'Document body' });
  await expect(body).toBeVisible();
  expect((await page.getByTestId('editor-viewport').boundingBox())!.y).toBeLessThanOrEqual(112);
  await body.locator('h1').click();
  await selectText(page, '.ProseMirror > h1', 0, 'Untitled document'.length);
  await page.keyboard.insertText('共同編集に備える提案書');
  await expect(body.locator('h1')).toHaveText('共同編集に備える提案書');
  const id = await body.locator('h1').getAttribute('data-block-id');
  await page.getByLabel('Text style', { exact: true }).selectOption('heading-2');
  await expect(body.locator('h2')).toHaveAttribute('data-block-id', id!);
  await body.locator('p').last().click();
  await page.keyboard.insertText(
    'We preserve stable identifiers and readable exports. 日本語で考える。',
  );
  await selectText(page, '.ProseMirror > p', 12, 30);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(body.locator('strong')).toHaveText('stable identifiers');
  await page.getByRole('button', { name: 'Underline', exact: true }).click();
  await expect(body.locator('u')).toHaveText('stable identifiers');
  await body.locator('p').last().click();
  await page.keyboard.press('End');
  await body.dispatchEvent('compositionstart', { data: '' });
  await page.keyboard.insertText('入力確定');
  await body.dispatchEvent('compositionend', { data: '入力確定' });
  await expect(body).toContainText('入力確定');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(body).not.toContainText('入力確定');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(body).toContainText('入力確定');
  await selectText(page, '.ProseMirror > p', 12, 30);
  await page.getByRole('button', { name: 'More formatting', exact: true }).click();
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByLabel('Link URL', { exact: true }).fill('https://example.com/editor-principles');
  await page.getByRole('button', { name: 'Apply link', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/editor-principles');
  await insert(page, 'Table');
  await body.locator('th').first().click();
  await page.getByRole('button', { name: 'Add table row', exact: true }).click();
  await page.getByRole('button', { name: 'Add table column', exact: true }).click();
  await expect(body.locator('tr')).toHaveCount(3);
  await expect(body.locator('tr').first().locator('th,td')).toHaveCount(3);
  const cells = [
    ['段階', '作業内容', '判断の目安'],
    ['試作', '入力画面を二週間で作る', '五人の利用者に確認'],
    ['検証', '入力時間と完了率を測る', '完了率 85% を目標にする'],
  ];
  for (const [r, row] of cells.entries())
    for (const [c, value] of row.entries())
      await setDocumentText(page, `table tr:nth-child(${r + 1}) > :nth-child(${c + 1}) p`, value);
  await insert(page, 'Checklist');
  await setDocumentText(page, 'li p', '利用者に確認し、次の改善を記録する');
  await body.locator('input[type=checkbox]').last().check();
  await expect(body.locator('input[type=checkbox]').last()).toBeChecked();
  await page.getByLabel('Document image file').setInputFiles({
    name: 'reference.png',
    mimeType: 'image/png',
    buffer: await prototypeImage(page),
  });
  await expect(body.getByRole('img', { name: 'reference.png' })).toBeVisible();
  await insert(page, 'Mermaid');
  await expect(body.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await expect(body.locator('h2')).toHaveAttribute('data-block-id', id!);
  await expect(body.locator('strong')).toHaveText('stable identifiers');
  await expect(body.locator('input[type=checkbox]').last()).toBeChecked();
  await expect(body.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Export document', exact: true }).click();
  let download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export HTML', exact: true }).click();
  const htmlFile = await download,
    path = info.outputPath('proposal.html');
  await htmlFile.saveAs(path);
  const html = await readFile(path, 'utf8');
  expect(html).toContain('<strong>');
  expect(html).toContain('共同編集に備える提案書');
  expect(html).not.toContain(id!);
  download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const pdfFile = await download,
    pdfPath = info.outputPath('proposal.pdf');
  await pdfFile.saveAs(pdfPath);
  const pdf = await PDFDocument.load(await readFile(pdfPath));
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  expect(pdf.getPage(0).getWidth()).toBe(595.5);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('document-after.png') });
});

test('ID-Q06 text reflow preserves block identity and quoted comments follow edits, deletion and Undo', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Document', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'Document body' }),
    p = body.locator(':scope > p').first();
  const original =
    '前提。比較対象。' + '日本語の文章は本文の幅に応じて自然に折り返します。'.repeat(12);
  await p.click();
  await selectText(page, '.ProseMirror > p', 0, (await p.textContent())!.length);
  await page.keyboard.insertText(original);
  const id = await p.getAttribute('data-block-id');
  await selectText(page, '.ProseMirror > p', 3, 7);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /^Comments \(/ }).click();
  await page.keyboard.press('Escape');
  await page.getByLabel('Comment', { exact: true }).fill('比較対象の根拠');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(body.locator('.ep-comment-range')).toHaveText('比較対象');
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await selectText(page, '.ProseMirror > p', 0, 0);
  await page.keyboard.insertText('前方への追加です。');
  await expect(body.locator('.ep-comment-range')).toHaveText('比較対象');
  await expect(p).toHaveAttribute('data-block-id', id!);
  const height = (await p.boundingBox())!.height;
  await page.getByLabel('Page margin', { exact: true }).fill('130');
  await page.getByLabel('Page margin', { exact: true }).press('Enter');
  expect((await p.boundingBox())!.height).toBeGreaterThan(height);
  await expect(body.locator('.ep-comment-range')).toHaveText('比較対象');
  const start = '前方への追加です。'.length + 3;
  await selectText(page, '.ProseMirror > p', start, start + 4);
  await page.keyboard.press('Backspace');
  await expect(body.locator('.ep-comment-range')).toHaveCount(0);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /^Comments \(/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.comment-thread')).toContainText('Orphan');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.comment-thread')).toContainText('Current');
  await page.getByRole('button', { name: 'Jump to annotation', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('比較対象');
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await page.screenshot({ path: info.outputPath('document-reflow-comment.png') });
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await expect(body.locator('.ep-comment-range')).toHaveText('比較対象');
  await expect(p).toHaveAttribute('data-block-id', id!);
});
