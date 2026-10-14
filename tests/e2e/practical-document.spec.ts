import {
  replaceFileSource,
  test,
  expect,
  setDocumentText,
  insertDoc,
  comments,
  nativeArtifact,
  artifactView,
} from './fixtures';
import { openWhole } from './template-fixtures';
import { prototypeImage } from './authored-image';
import {
  collaborate,
  confirmed,
  download,
  finish,
  insertFragment,
  monitor,
  screenshot,
  saveShared,
} from './practical-fixtures';
import { PDFDocument } from 'pdf-lib';

test('QL-01 Japanese proposal: author, collaborate, paginate, annotate, compare, export and reuse', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(12000);
  await page.goto('/');
  const form = await openWhole(page, 'document', '企画書');
  for (const [slot, text] of Object.entries({
    title: '受付改善企画書',
    summary: '来訪者の待ち時間を減らすため、受付票と案内方法を改善します。',
    section0: '聞き取りで迷う項目を特定\n利用者の入力時間を測定',
    section1: '試作を二週間で準備\n五人の来訪者と受付担当に確認',
    section2: '入力時間を八分から三分へ\n完了率を八十五パーセントへ',
  }))
    await form.locator(`[data-slot="${slot}"]`).fill(text);
  await form.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await form.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(form).toHaveCount(0);
  const body = page.getByRole('textbox', { name: 'Document body', exact: true });
  await setDocumentText(page, 'li p', '受付担当と利用者が同じ案内文を読み、迷う項目を特定する');
  await insertDoc(page, 'Table');
  await body.locator('th').first().click();
  await page.getByRole('button', { name: 'Add table row', exact: true }).click();
  const cells = [
    ['評価項目', '確認方法'],
    ['入力時間', '受付票の記入開始から保存までを計測'],
    ['完了率', '確認済みの受付票の割合を比較'],
  ];
  for (const [r, row] of cells.entries())
    for (const [c, text] of row.entries())
      await setDocumentText(page, `table tr:nth-child(${r + 1}) > :nth-child(${c + 1}) p`, text);
  await page.getByLabel('Document image file').setInputFiles({
    name: '受付の試作画面.png',
    mimeType: 'image/png',
    buffer: await prototypeImage(page),
  });
  await expect(body.getByRole('img', { name: '受付の試作画面.png' })).toBeVisible();
  await insertDoc(page, 'Mermaid');
  await page
    .getByLabel('Mermaid source', { exact: true })
    .fill('flowchart LR\n A[受付票を入力] --> B[内容を確認]\n B --> C[保存して案内]');
  await page.getByLabel('Mermaid source', { exact: true }).press('Tab');
  await expect(body.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible({ timeout: 20000 });
  const shared = await collaborate(page, browser, baseURL, 'document');
  await saveShared(page, 1);
  const first = (await nativeArtifact(page)).versions[0];
  await body.locator(':scope > p').first().click();
  await page.keyboard.press('Control+End');
  expect(
    await body.evaluate((el) => {
      const s = window.getSelection()!;
      return {
        text: s.anchorNode?.textContent,
        offset: s.anchorOffset,
        last: el.lastElementChild?.textContent,
        active: document.activeElement?.getAttribute('aria-label'),
      };
    }),
    'Control+End places the caret at the document end',
  ).toMatchObject({
    text: '検証結果：受付時間と完了率を継続して測定します。',
    offset: '検証結果：受付時間と完了率を継続して測定します。'.length,
  });
  await page.keyboard.press('Enter');
  // Paste is real document input, not a native artifact/engine fixture.
  const long =
    '案内文は短い文に分け、確認事項と次の手順を明確にします。利用者の迷いを記録して改善に反映します。';
  const html = `<h2>運用と検証の詳細</h2><p>${long.repeat(30)}</p><table><tr><th>検証観点</th><th>記録内容</th></tr>${Array.from({ length: 22 }, (_, i) => `<tr><td>確認 ${i + 1}</td><td>${long.repeat(2)}</td></tr>`).join('')}</table><p>企画書の最終確認まで完了</p>`;
  await body.evaluate((el, html) => {
    const data = new DataTransfer();
    data.setData('text/html', html);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
  }, html);
  await expect(body).toContainText('企画書の最終確認まで完了');
  await confirmed(page);
  await insertFragment(page, '要約・結論section', {
    title: '実施判断',
    summary: '受付担当と合意し、二週間の試行を開始します。',
    section0: '入力時間と完了率を週次確認\n迷う項目を記録して案内文を更新',
  });
  // Replace fragment sample text as part of finishing the proposal.
  await setDocumentText(page, 'h2:last-of-type', '実施判断');
  const fragmentText = body.locator(':scope > p').last();
  await fragmentText.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' 受付担当と合意し、二週間の試行を開始します。');
  await confirmed(page);
  await body.locator('h1').first().click();
  await comments(page);
  await page.getByLabel('Comment', { exact: true }).fill('受付担当の合意を確認する');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await comments(shared.peer);
  await expect(shared.peer.locator('.comment-thread')).toContainText('受付担当の合意を確認する');
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await saveShared(page, 2);
  expect((await nativeArtifact(page)).versions[0]).toEqual(first);
  await artifactView(page, 'Compare');
  await expect(page.locator('.compare-view')).toBeVisible();
  await screenshot(page, 'document-compare');
  await artifactView(page, 'Editor');
  for (const [label, name] of [
    ['Export HTML', 'proposal.html'],
    ['Export Markdown', 'proposal.md'],
    ['Export PDF', 'proposal.pdf'],
  ] as const) {
    await page
      .getByRole('button', {
        name: name.endsWith('.md') ? 'Export artifact' : 'Export document',
        exact: true,
      })
      .click();
    const bytes = await download(page, label, name);
    if (name.endsWith('.html')) {
      const view = await page.context().newPage(),
        errors = monitor(view);
      await view.setContent(bytes.toString());
      await expect(view.locator('body')).toContainText('企画書の最終確認まで完了');
      await expect(view.locator('table tr')).toHaveCount(26);
      await screenshot(view, 'document-html');
      await view.close();
      expect(errors).toEqual([]);
    } else if (name.endsWith('.md')) {
      expect(bytes.toString()).toContain('受付改善企画書：共同確認済み');
      expect(bytes.toString()).toContain('確認 22');
    } else {
      const count = (await PDFDocument.load(bytes)).getPageCount();
      expect(count).toBeGreaterThan(2);
      const view = await page.context().newPage(),
        errors = monitor(view);
      await view.goto('/');
      const { create } = await import('./fixtures');
      await create(view, 'file');
      await replaceFileSource(view, { name, mimeType: 'application/pdf', buffer: bytes });
      for (let n = 1; n <= count; n++) {
        await view.getByLabel('PDF page', { exact: true }).fill(String(n));
        await view.getByLabel('PDF page', { exact: true }).press('Enter');
        await expect(view.getByLabel(`Rendered PDF page ${n}`, { exact: true })).toHaveAttribute(
          'data-rendered',
          'true',
        );
        await screenshot(view, `document-pdf-${n}`);
      }
      await view.close();
      expect(errors).toEqual([]);
    }
  }
  await shared.close();
  // finish saves the next immutable version after the two comparison versions.
  await finish(page, browser, baseURL, 'document', 3);
});
