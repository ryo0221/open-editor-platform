import { expect, type Page, type TestInfo } from '@playwright/test';
import { create, nativeArtifact } from './fixtures';
import {
  authorAndInsert,
  componentName,
  insertPublished,
  publishRevision,
} from './reuse-revision-fixtures';
import { reuseHistory, reuseMenu } from './reuse-fixtures';
import type { DocumentContent } from '@editor-platform/document/model';

export async function selectArtifact(page: Page, name: string) {
  const navigation = page.getByRole('navigation', { name: 'Artifacts', exact: true });
  if (!(await navigation.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await navigation.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(name);
  await page.keyboard.press('Escape');
}
export async function openBatch(page: Page) {
  await reuseMenu(page, '複数の成果物の部品を更新');
  const dialog = page.getByRole('dialog', { name: '複数の成果物の部品を更新', exact: true });
  await dialog
    .getByRole('combobox', { name: '採用する部品の版', exact: true })
    .selectOption({ label: `${componentName} v2（document）` });
  return dialog;
}
export async function componentBatchFlow(page: Page, info: TestInfo) {
  await authorAndInsert(page);
  await page.getByLabel('Artifact name', { exact: true }).fill('案件A');
  const beforeA = (await nativeArtifact(page)).draft.content as DocumentContent;
  await create(page, 'document');
  await page.getByLabel('Artifact name', { exact: true }).fill('案件B');
  const beforeB = await insertPublished(page, '案件Bの入力済み本文');
  await publishRevision(page);
  let dialog = await openBatch(page);
  await dialog.getByRole('combobox', { name: '案件Aの更新', exact: true }).selectOption('adopt');
  await dialog.getByRole('combobox', { name: '案件Bの更新', exact: true }).selectOption('pin');
  await dialog.getByRole('button', { name: '成果物ごとの差分をプレビュー', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '案件Aの結果', exact: true })).toContainText(
    '更新可能',
  );
  await expect(dialog.getByRole('region', { name: '案件Bの結果', exact: true })).toContainText(
    '変更なし',
  );
  await dialog.getByRole('button', { name: '外観を確認：案件A', exact: true }).click();
  await expect(dialog.frameLocator('iframe').locator('body')).toContainText(
    '入力済みの日本語',
  );
  await dialog.getByRole('button', { name: 'プレビューした成果物へ適用', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('適用済み 1 / 2成果物');
  await page.screenshot({ path: info.outputPath('batch-selected-adoption.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Close 複数の成果物の部品を更新', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(beforeB);
  await selectArtifact(page, '案件A');
  const adoptedA = (await nativeArtifact(page)).draft.content as DocumentContent;
  expect(adoptedA.reuse!.instances[0].ref.version).toBe(2);
  expect(adoptedA.blocks.map((b) => b.text)).toEqual(beforeA.blocks.map((b) => b.text));
  await reuseHistory(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(beforeA);
  await reuseHistory(page, 'Redo');
  expect((await nativeArtifact(page)).draft.content).toEqual(adoptedA);
  await selectArtifact(page, '案件B');
  await expect(page.locator('.save-status')).toContainText('Saved locally');
  // Fail one actual IndexedDB write after native application, then retry persistence.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (
        this.name === 'artifacts' &&
        value?.name === '案件B' &&
        value?.draft?.content?.reuse?.instances?.[0]?.ref?.version === 2
      ) {
        IDBObjectStore.prototype.put = original;
        throw new DOMException('Batch storage failure', 'QuotaExceededError');
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  dialog = await openBatch(page);
  await dialog.getByRole('combobox', { name: '案件Aの更新', exact: true }).selectOption('adopt');
  await dialog.getByRole('combobox', { name: '案件Bの更新', exact: true }).selectOption('adopt');
  await dialog.getByRole('button', { name: '成果物ごとの差分をプレビュー', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '案件Aの結果', exact: true })).toContainText(
    '変更なし',
  );
  await dialog.getByRole('button', { name: 'プレビューした成果物へ適用', exact: true }).click();
  await expect(
    dialog.getByRole('region', { name: '案件Bの結果', exact: true }).getByRole('alert'),
  ).toContainText('保存に失敗');
  await page.screenshot({ path: info.outputPath('batch-save-failure.png'), fullPage: true });
  await dialog.getByRole('button', { name: '未完了の成果物を再試行', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '案件Bの結果', exact: true })).toContainText(
    '適用済み',
  );
  await dialog.getByRole('button', { name: 'Close 複数の成果物の部品を更新', exact: true }).click();
  const adoptedB = (await nativeArtifact(page)).draft.content as DocumentContent;
  expect(adoptedB.reuse!.instances[0].ref.version).toBe(2);
  expect(adoptedB.blocks.map((b) => b.text)).toEqual(beforeB.blocks.map((b) => b.text));
  await reuseHistory(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(beforeB);
  await reuseHistory(page, 'Redo');
  expect((await nativeArtifact(page)).draft.content).toEqual(adoptedB);
  await page.reload();
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('案件B');
  expect((await nativeArtifact(page)).draft.content).toEqual(adoptedB);
  await selectArtifact(page, '案件A');
  expect((await nativeArtifact(page)).draft.content).toEqual(adoptedA);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
