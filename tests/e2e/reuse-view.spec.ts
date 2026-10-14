import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { replaceFileSource, test, expect, create, comments, nativeArtifact } from './fixtures';
import { reuseHistory, reuseMenu } from './reuse-fixtures';
import {
  adoptView,
  annotationFromView,
  reviewTools,
  reviewViewFlow,
  saveView,
  viewLibrary,
  viewName,
} from './reuse-view-fixtures';
import { originalBytes, type FileContent } from '@editor-platform/review-surfaces/model';

test('R12 Review private draft/revision/archive/reset and new annotation keep original comparison and existing comments', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await reviewViewFlow(page);
  await page.screenshot({ path: info.outputPath('review-view-preset.png'), fullPage: true });
  await reuseMenu(page, '表示設定ライブラリ');
  await viewLibrary(page)
    .getByRole('button', { name: `採用中: ${viewName} v2`, exact: true })
    .click();
  await viewLibrary(page)
    .getByRole('button', { name: '適用内容をプレビュー', exact: true })
    .click();
  await expect(viewLibrary(page).getByLabel('表示設定の適用プレビュー')).toBeVisible();
  await page.screenshot({ path: info.outputPath('review-preset-library.png'), fullPage: true });
});

test('R12/R14 Viewer preset pack imports into an empty peer catalog while source and shared annotation history stay native', async ({
  page: a,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(90000);
  await a.goto('/');
  await create(a, 'file');
  await saveView(a, 'file');
  await adoptView(a);
  const before = (await nativeArtifact(a)).draft.content as FileContent;
  await reuseMenu(a, '表示設定ライブラリ');
  const library = viewLibrary(a);
  await library.getByRole('button', { name: `採用中: ${viewName} v1`, exact: true }).click();
  const pending = a.waitForEvent('download');
  await library.getByRole('button', { name: '表示設定packを書き出す', exact: true }).click();
  const pack = await readFile((await (await pending).path())!);
  expect(pack.toString()).not.toContain(before.data);
  await library.getByRole('button', { name: 'Close 表示設定ライブラリ', exact: true }).click();
  await reuseMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const peer = await a
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await a.keyboard.press('Escape');
  const context = await browser.newContext({ baseURL }),
    b = await context.newPage(),
    errors: string[] = [];
  b.on('pageerror', (e) => errors.push(e.message));
  b.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await b.goto(peer!);
  await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
  await reuseMenu(b, '表示設定ライブラリ');
  await expect(
    viewLibrary(b).getByText('「表示設定を保存」から作成できます。', { exact: true }),
  ).toBeVisible();
  await viewLibrary(b)
    .getByLabel('表示設定packを読み込む', { exact: true })
    .setInputFiles({ name: 'view.template.json', mimeType: 'application/json', buffer: pack });
  await expect(
    viewLibrary(b).getByRole('button', { name: `${viewName} v1`, exact: true }),
  ).toBeVisible();
  await viewLibrary(b)
    .getByRole('button', { name: 'Close 表示設定ライブラリ', exact: true })
    .click();
  await adoptView(b, 1, true);
  await b.getByRole('button', { name: 'File line 2', exact: true }).click();
  const dialog = await annotationFromView(b);
  await b.screenshot({
    path: info.outputPath('viewer-shared-annotation-preview.png'),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'この範囲に注釈を作成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await nativeArtifact(a)).annotations.length).toBe(1);
  const current = await nativeArtifact(b);
  expect(current.draft.content).toEqual(before);
  expect(current.annotations[0]).toMatchObject({
    color: '#336699',
    anchor: { addresses: [{ region: { type: 'lines', start: 2, end: 2 } }] },
  });
  await reuseHistory(b, 'Undo');
  await expect.poll(async () => (await nativeArtifact(a)).annotations.length).toBe(0);
  await reuseHistory(b, 'Redo');
  await expect.poll(async () => (await nativeArtifact(a)).annotations).toEqual(current.annotations);
  expect(
    Buffer.from(originalBytes((await nativeArtifact(a)).draft.content as FileContent)),
  ).toEqual(Buffer.from(originalBytes(before)));
  await context.close();
  expect(errors).toEqual([]);
});

for (const kind of ['text', 'image', 'pdf'] as const)
  test(`R12 Viewer ${kind} preset and fresh region annotation preserve downloaded source bytes/hash through reload`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    await page.goto('/');
    await create(page, 'file');
    const document = await PDFDocument.create();
    const pdfPage = document.addPage([612, 792]);
    pdfPage.drawText('Original review source', { x: 60, y: 600 });
    const bytes =
      kind === 'text'
        ? Buffer.from('\ufeff原本の確認\r\n第二行\r\n')
        : kind === 'image'
          ? Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#ddeeff"/><text x="60" y="120" font-size="36">元の確認画像</text></svg>',
            )
          : Buffer.from(await document.save());
    const name = kind === 'text' ? 'source.txt' : kind === 'image' ? 'source.svg' : 'source.pdf';
    const mime =
      kind === 'text' ? 'text/plain' : kind === 'image' ? 'image/svg+xml' : 'application/pdf';
    await replaceFileSource(page, { name, mimeType: mime, buffer: bytes });
    if (kind === 'text')
      await expect(page.getByRole('button', { name: 'File line 1', exact: true })).toContainText(
        '原本の確認',
      );
    if (kind === 'image')
      await expect(page.getByText('640 × 320 pixels', { exact: true })).toBeVisible();
    if (kind === 'pdf')
      await expect(page.getByLabel('Rendered PDF page 1', { exact: true })).toHaveAttribute(
        'data-rendered',
        'true',
      );
    const before = await nativeArtifact(page);
    await saveView(page, 'file');
    await adoptView(page, 1, kind === 'text');
    if (kind === 'text')
      await page.getByRole('button', { name: 'File line 2', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Select file region', exact: true }).click();
      const overlay = page.getByLabel(
        kind === 'pdf' ? 'Select PDF region on page 1' : 'Select image region',
        { exact: true },
      );
      const box = (await overlay.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.2, { steps: 6 });
      await page.mouse.up();
    }
    const dialog = await annotationFromView(page);
    await dialog.getByText('原本の照合情報', { exact: true }).click();
    await expect(dialog).toContainText(createHash('sha256').update(bytes).digest('hex'));
    await dialog.getByRole('button', { name: 'この範囲に注釈を作成', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Close comments', exact: true }).click();
    const after = await nativeArtifact(page);
    expect(after.draft.content).toEqual(before.draft.content);
    expect(after.annotations).toHaveLength(1);
    expect(after.annotations[0]).toMatchObject({
      color: '#336699',
      comments: [{ author: 'local-user', body: '設定からの確認' }],
    });
    expect(Buffer.from(originalBytes(after.draft.content as FileContent))).toEqual(bytes);
    await page.reload();
    if (kind === 'pdf')
      await expect(page.getByLabel('Rendered PDF page 1', { exact: true })).toHaveAttribute(
        'data-rendered',
        'true',
      );
    expect((await nativeArtifact(page)).annotations).toEqual(after.annotations);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download original file', exact: true }).click();
    expect(await readFile((await (await pending).path())!)).toEqual(bytes);
    await page.screenshot({ path: info.outputPath(`viewer-${kind}-preset.png`), fullPage: true });
  });

test('R12 shared Review keeps private preferences separate, peer comment intact and annotation retry/Undo on the existing authority', async ({
  page: a,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(120000);
  await a.goto('/');
  await create(a, 'review');
  await saveView(a, 'review');
  await adoptView(a);
  await reviewTools(a);
  await a.getByRole('combobox', { name: 'Diff layout', exact: true }).selectOption('unified');
  const before = (await nativeArtifact(a)).draft.content;
  await reuseMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const peer = await a
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await a.keyboard.press('Escape');
  const context = await browser.newContext({ baseURL }),
    b = await context.newPage(),
    errors: string[] = [];
  b.on('pageerror', (e) => errors.push(e.message));
  b.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await b.goto(peer!);
  await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
  await expect(b.getByRole('combobox', { name: 'Diff layout', exact: true })).toHaveValue('split');
  await expect(b.getByLabel('Wrap lines', { exact: true })).not.toBeChecked();
  expect(await b.evaluate(() => localStorage.getItem('ep-template-view-settings'))).toBeNull();
  await a
    .getByRole('button', { name: /^added new line / })
    .first()
    .click();
  const dialog = await annotationFromView(a);
  await b
    .getByRole('button', { name: /^added new line / })
    .first()
    .click();
  await comments(b);
  await b.getByLabel('Comment', { exact: true }).fill('別の人の確認');
  await b.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
  let lost = false;
  await a.route('**/collaboration-api/proposal/apply?*', async (route) => {
    const response = await route.fetch();
    if (!lost) {
      lost = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    } else await route.fulfill({ response });
  });
  await dialog.getByRole('button', { name: 'この範囲に注釈を作成', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'この範囲に注釈を作成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const current = await nativeArtifact(a);
  expect(current.draft.content).toEqual(before);
  expect(current.annotations).toHaveLength(2);
  const own = current.annotations.find((n) => n.color === '#336699')!;
  expect(own.comments[0].body).toBe('設定からの確認');
  await expect.poll(async () => (await nativeArtifact(b)).annotations).toEqual(current.annotations);
  await reuseHistory(a, 'Undo');
  await expect
    .poll(async () => (await nativeArtifact(b)).annotations.map((n) => n.comments[0].body))
    .toEqual(['別の人の確認']);
  await reuseHistory(a, 'Redo');
  await expect.poll(async () => (await nativeArtifact(b)).annotations).toEqual(current.annotations);
  await expect(a.getByRole('combobox', { name: 'Diff layout', exact: true })).toHaveValue(
    'unified',
  );
  await expect(b.getByRole('combobox', { name: 'Diff layout', exact: true })).toHaveValue('split');
  await a.screenshot({ path: info.outputPath('shared-review-preset.png'), fullPage: true });
  await a.unroute('**/collaboration-api/proposal/apply?*');
  await context.close();
  expect(errors).toEqual([]);
});
