import { expect, type Page } from '@playwright/test';
import { create, nativeArtifact, setDocumentText } from './fixtures';
import { reuseMenu } from './reuse-fixtures';
import type { DocumentContent } from '@editor-platform/document/model';
export const componentName = '共有注意書き';
export async function authorAndInsert(page: Page, required = false) {
  page.setDefaultTimeout(12000);
  await page.goto('/');
  await create(page, 'document');
  await setDocumentText(page, 'p', '再利用する本文');
  await reuseMenu(page, '再利用部品として保存');
  const author = page.getByRole('dialog', { name: '再利用部品として保存', exact: true });
  await author.getByLabel('部品名', { exact: true }).fill(componentName);
  await author.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  if (required) {
    const slot = author
      .locator('.tp-component-contract > details')
      .filter({ has: page.locator('summary', { hasText: '（0〜20件）' }) })
      .first();
    await slot.locator('summary').click();
    await slot.getByLabel('最小個数', { exact: true }).fill('1');
    await author.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  }
  await author.getByRole('button', { name: '部品を公開', exact: true }).click();
  await expect(author).toHaveCount(0);
  return insertPublished(page, '入力済みの日本語', required);
}
export async function insertPublished(page: Page, body: string, required = false) {
  await reuseMenu(page, '部品ライブラリ');
  const library = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await library.getByRole('button', { name: componentName + ' v1', exact: true }).click();
  await library.locator('textarea[data-slot^="text_"]').first().fill(body);
  if (required) {
    await library
      .getByRole('button', { name: /の内容を追加$/ })
      .first()
      .click();
    await library.getByLabel('挿入する本文', { exact: true }).fill('必須スロットの日本語');
  }
  await library.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  await library.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect(library).toHaveCount(0);
  return (await nativeArtifact(page)).draft.content as DocumentContent;
}
export async function publishRevision(page: Page) {
  await reuseMenu(page, '部品ライブラリ');
  let library = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await library.getByRole('button', { name: componentName + ' v1', exact: true }).click();
  await library.getByRole('button', { name: '新版の下書きを作成', exact: true }).click();
  let draft = page.getByRole('dialog', { name: '部品の下書き・新版公開', exact: true });
  await draft.getByLabel('文字サイズ (pt)', { exact: true }).fill('22');
  await draft.getByRole('textbox', { name: '文字色', exact: true }).fill('#2255aa');
  await draft.getByRole('button', { name: '下書きを保存', exact: true }).click();
  await expect(draft.getByRole('status')).toContainText('保存済みの下書き: 1');
  await draft.getByRole('button', { name: 'Close 部品の下書き・新版公開', exact: true }).click();
  library = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await library.getByRole('button', { name: componentName + ' — 下書き 1', exact: true }).click();
  draft = page.getByRole('dialog', { name: '部品の下書き・新版公開', exact: true });
  await draft.getByRole('button', { name: '新版をプレビュー', exact: true }).click();
  await draft.getByRole('button', { name: '保存した版を公開', exact: true }).click();
  library = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await expect(
    library.getByRole('button', { name: componentName + ' v2', exact: true }),
  ).toBeVisible();
  await library.getByRole('button', { name: 'Close 部品ライブラリ', exact: true }).click();
}
export async function stageRevision(page: Page) {
  await reuseMenu(page, '部品の入力・表示');
  const inspector = page.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await inspector
    .getByRole('button', { name: componentName + ' v1', exact: true })
    .first()
    .click();
  await inspector.locator('summary', { hasText: '改訂の採用・部品の差し替え' }).click();
  await inspector.getByRole('button', { name: '更新差分をプレビュー', exact: true }).click();
  await expect(inspector.getByRole('status')).toContainText('更新可能');
  return inspector;
}
