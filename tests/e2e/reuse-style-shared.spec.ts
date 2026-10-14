import { test, expect, nativeArtifact } from './fixtures';
import { brandStyleFlow } from './reuse-style-fixtures';
import { reuseMenu, reuseHistory } from './reuse-fixtures';
import type { DocumentContent } from '@editor-platform/document/model';

test('R06/R07 an open input form preserves the peer mode and a lost combined receipt is idempotent', async ({
  page: a,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(180000);
  await brandStyleFlow(a, info);
  await reuseMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const peer = await a
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await a.keyboard.press('Escape');
  const context = await browser.newContext({ baseURL });
  const b = await context.newPage(),
    errors: string[] = [];
  b.on('pageerror', (error) => errors.push(error.message));
  b.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await b.goto(peer!);
  await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
  await reuseMenu(a, '部品の入力・表示');
  const editorA = a.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await editorA.getByRole('button', { name: 'ブランド部品 v2', exact: true }).click();
  await expect(
    editorA.getByRole('combobox', { name: '部品のトークンモード', exact: true }),
  ).toHaveValue('light');
  await reuseMenu(b, '部品の入力・表示');
  const editorB = b.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await editorB.getByRole('button', { name: 'ブランド部品 v2', exact: true }).click();
  await editorB
    .getByRole('combobox', { name: '部品のトークンモード', exact: true })
    .selectOption('dark');
  await editorB.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  await editorB.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(b)).draft.content as DocumentContent).reuse!.instances[0].mode,
    )
    .toBe('dark');
  const peerContent = (await nativeArtifact(b)).draft.content as DocumentContent;
  const paragraphId = Object.values(peerContent.reuse!.instances[0].parts)[0];
  await expect(a.locator(`.ProseMirror [data-block-id="${paragraphId}"]`)).toHaveCSS(
    'color',
    'rgb(153, 204, 255)',
  );
  // No mode or variant input is touched in A's already-open form.
  await editorA.locator('textarea[data-slot^="text_"]').first().fill('共同編集中の本文');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await editorA.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  let lost = false;
  await a.route('**/collaboration-api/proposal/apply?*', async (route) => {
    const response = await route.fetch();
    if (!lost) {
      lost = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    } else await route.fulfill({ response });
  });
  await editorA.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect(editorA.getByRole('alert')).toBeVisible();
  await editorA.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect(editorA).toHaveCount(0);
  const current = (await nativeArtifact(a)).draft.content as DocumentContent;
  expect(current.reuse!.instances[0].mode).toBe('dark');
  expect(current.blocks.find((block) => block.text === '共同編集中の本文')!.style!.color).toBe(
    '#99ccff',
  );
  expect(lost).toBe(true);
  await expect.poll(async () => (await nativeArtifact(b)).draft.content).toEqual(current);
  await reuseHistory(a, 'Undo');
  await expect.poll(async () => (await nativeArtifact(a)).draft.content).toEqual(peerContent);
  const undone = (await nativeArtifact(a)).draft.content as DocumentContent;
  expect(undone.reuse!.instances[0].mode).toBe('dark');
  expect(undone.blocks.some((block) => block.text === '案件Aの本文')).toBe(true);
  await reuseHistory(a, 'Redo');
  await expect.poll(async () => (await nativeArtifact(b)).draft.content).toEqual(current);
  await a.screenshot({ path: info.outputPath('shared-token-mode.png'), fullPage: true });
  await a.unroute('**/collaboration-api/proposal/apply?*');
  await context.close();
  expect(errors).toEqual([]);
});
