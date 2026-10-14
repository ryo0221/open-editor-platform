import { test, expect, create, nativeArtifact, setDocumentText } from './fixtures';
import { authorAndInsert, insertPublished, publishRevision } from './reuse-revision-fixtures';
import { openBatch, selectArtifact } from './reuse-batch-fixtures';
import { reuseHistory, reuseMenu } from './reuse-fixtures';
import type { DocumentContent } from '@editor-platform/document/model';

test('R06/R07 mixed local/shared batch retains peer body and retries only the lost authority receipt', async ({
  page: a,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(150000);
  await authorAndInsert(a);
  await a.getByLabel('Artifact name', { exact: true }).fill('案件A');
  await create(a, 'document');
  await a.getByLabel('Artifact name', { exact: true }).fill('案件B');
  const current = await insertPublished(a, '共有前の本文');
  const address = Object.values(current.reuse!.instances[0].parts)[0];
  await publishRevision(a);
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
  b.on('pageerror', (error) => errors.push(error.message));
  b.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await b.goto(peer!);
  await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
  const dialog = await openBatch(a);
  for (const name of ['案件A', '案件B'])
    await dialog
      .getByRole('combobox', { name: `${name}の更新`, exact: true })
      .selectOption('adopt');
  await dialog.getByRole('button', { name: '成果物ごとの差分をプレビュー', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '案件Bの結果', exact: true })).toContainText(
    '更新可能',
  );
  await setDocumentText(b, `[data-block-id="${address}"]`, '他の人が書いた日本語');
  await expect(a.locator(`.ProseMirror [data-block-id="${address}"]`)).toHaveText(
    '他の人が書いた日本語',
  );
  let lost = false;
  await a.route('**/collaboration-api/proposal/apply?*', async (route) => {
    const response = await route.fetch();
    if (!lost) {
      lost = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    } else await route.fulfill({ response });
  });
  await dialog.getByRole('button', { name: 'プレビューした成果物へ適用', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('適用済み 1 / 2成果物');
  await expect(
    dialog.getByRole('region', { name: '案件Bの結果', exact: true }).getByRole('alert'),
  ).toBeVisible();
  await a.screenshot({ path: info.outputPath('batch-lost-shared-receipt.png'), fullPage: true });
  await dialog.getByRole('button', { name: '未完了の成果物を再試行', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('適用済み 2 / 2成果物');
  await dialog.getByRole('button', { name: 'Close 複数の成果物の部品を更新', exact: true }).click();
  const adopted = (await nativeArtifact(a)).draft.content as DocumentContent;
  expect(adopted.reuse!.instances[0].ref.version).toBe(2);
  expect(adopted.blocks.find((block) => block.id === address)!.text).toBe('他の人が書いた日本語');
  expect(lost).toBe(true);
  await expect.poll(async () => (await nativeArtifact(b)).draft.content).toEqual(adopted);
  await reuseHistory(a, 'Undo');
  const undone = (await nativeArtifact(a)).draft.content as DocumentContent;
  expect(undone.reuse!.instances[0].ref.version).toBe(1);
  expect(undone.blocks.find((block) => block.id === address)!.text).toBe('他の人が書いた日本語');
  await reuseHistory(a, 'Redo');
  await expect.poll(async () => (await nativeArtifact(b)).draft.content).toEqual(adopted);
  await a.unroute('**/collaboration-api/proposal/apply?*');
  await reuseMenu(a, 'Leave shared session');
  await selectArtifact(a, '案件A');
  expect(
    ((await nativeArtifact(a)).draft.content as DocumentContent).reuse!.instances[0].ref.version,
  ).toBe(2);
  await context.close();
  expect(errors).toEqual([]);
});
