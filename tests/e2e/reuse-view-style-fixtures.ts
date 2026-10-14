import { expect, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { create, nativeArtifact } from './fixtures';
import { reuseMenu } from './reuse-fixtures';
import { confirmAnnotation, viewLibrary, viewName } from './reuse-view-fixtures';

export async function viewStyleFlow(page: Page, info: TestInfo, domain: 'review' | 'file') {
  page.setDefaultTimeout(12000);
  await page.goto('/');
  await create(page, domain);
  const before = await nativeArtifact(page);
  await reuseMenu(page, 'トークン・スタイル');
  const library = page.getByRole('dialog', { name: 'トークン・スタイル', exact: true });
  const styleEditor = page.getByRole('dialog', { name: 'トークン・スタイルの下書き', exact: true });
  const publishStyle = async () => {
    await styleEditor.getByRole('button', { name: '定義をプレビュー', exact: true }).click();
    await expect(styleEditor.getByRole('region', { name: '定義のプレビュー' })).toBeVisible();
    await styleEditor.getByRole('button', { name: '下書きを保存', exact: true }).click();
    await styleEditor.getByRole('button', { name: '保存した版を公開', exact: true }).click();
  };
  await library.getByRole('button', { name: 'トークンセットを作成', exact: true }).click();
  await styleEditor.getByRole('textbox', { name: '定義名', exact: true }).fill('確認色');
  await styleEditor.getByRole('combobox', { name: '編集する値', exact: true }).selectOption('dark');
  await styleEditor.getByLabel('brand.primaryをdarkで上書き', { exact: true }).check();
  await styleEditor.getByLabel('brand.primaryの色', { exact: true }).fill('#99ccff');
  await publishStyle();
  await library.getByRole('button', { name: 'スタイルを作成', exact: true }).click();
  await styleEditor.getByRole('textbox', { name: '定義名', exact: true }).fill('注釈ブランド');
  await styleEditor
    .getByRole('combobox', { name: '参照するトークンの版', exact: true })
    .selectOption({ label: '確認色 v1' });
  await styleEditor
    .getByRole('combobox', { name: 'スタイル属性: annotation.color', exact: true })
    .selectOption('brand.primary');
  await publishStyle();
  await library.getByRole('button', { name: 'Close トークン・スタイル', exact: true }).click();
  await reuseMenu(page, '表示設定を保存');
  let draft = page.getByRole('dialog', { name: '表示設定の下書き・公開', exact: true });
  await draft.getByRole('textbox', { name: '設定名', exact: true }).fill(viewName);
  await draft
    .getByRole('textbox', { name: '新しい注釈の本文', exact: true })
    .fill('設定からの確認');
  await draft
    .getByRole('combobox', { name: '新しい注釈に採用するスタイルの版', exact: true })
    .selectOption({ label: '注釈ブランド v1' });
  await expect(draft.getByLabel('新しい注釈の色', { exact: true })).toBeDisabled();
  await draft.getByRole('button', { name: '下書きを保存', exact: true }).click();
  await expect(draft.getByRole('status')).toContainText('保存済みの下書き: 1');
  await page.reload();
  await reuseMenu(page, '表示設定ライブラリ');
  await viewLibrary(page)
    .getByRole('button', { name: `${viewName} — 下書き 1`, exact: true })
    .click();
  draft = page.getByRole('dialog', { name: '表示設定の下書き・公開', exact: true });
  await expect(
    draft
      .getByRole('combobox', { name: '新しい注釈に採用するスタイルの版', exact: true })
      .locator('option:checked'),
  ).toHaveText('注釈ブランド v1');
  await draft.getByRole('button', { name: '保存した版を公開', exact: true }).click();
  await viewLibrary(page)
    .getByRole('button', { name: `${viewName} v1`, exact: true })
    .click();
  await viewLibrary(page)
    .getByRole('combobox', { name: '注釈スタイルのモード', exact: true })
    .selectOption('dark');
  const adopt = async () => {
    await viewLibrary(page)
      .getByRole('button', { name: '適用内容をプレビュー', exact: true })
      .click();
    await viewLibrary(page)
      .getByRole('button', { name: 'この表示設定を適用', exact: true })
      .click();
  };
  const selectRange = async () => {
    if (domain === 'review')
      await page
        .getByRole('button', { name: /^added new line / })
        .first()
        .click();
    else await page.getByRole('button', { name: 'File line 2', exact: true }).click();
  };
  await adopt();
  await selectRange();
  await confirmAnnotation(page);
  const first = await nativeArtifact(page);
  expect(first.annotations[0].color).toBe('#99ccff');
  await reuseMenu(page, '表示設定ライブラリ');
  await viewLibrary(page)
    .getByRole('button', { name: `${viewName} v1`, exact: true })
    .click();
  await viewLibrary(page)
    .getByRole('button', { name: '表示設定の新版を作成', exact: true })
    .click();
  draft = page.getByRole('dialog', { name: '表示設定の下書き・公開', exact: true });
  await draft
    .getByRole('combobox', { name: '新しい注釈に採用するスタイルの版', exact: true })
    .selectOption('');
  await draft.getByLabel('新しい注釈の色', { exact: true }).fill('#cc3300');
  await draft.getByRole('button', { name: '下書きを保存', exact: true }).click();
  await draft.getByRole('button', { name: '保存した版を公開', exact: true }).click();
  await viewLibrary(page)
    .getByRole('button', { name: `${viewName} v2`, exact: true })
    .click();
  await adopt();
  await page.reload();
  await selectRange();
  await confirmAnnotation(page);
  const after = await nativeArtifact(page);
  expect(after.draft.content).toEqual(before.draft.content);
  expect(after.annotations[0]).toEqual(first.annotations[0]);
  expect(after.annotations[1].color).toBe('#cc3300');
  await writeFile(info.outputPath(`${domain}-style.artifact.json`), JSON.stringify(after, null, 2));
  await reuseMenu(page, '表示設定ライブラリ');
  await viewLibrary(page)
    .getByRole('button', { name: `採用中: ${viewName} v2`, exact: true })
    .click();
  await viewLibrary(page)
    .getByRole('button', { name: '適用内容をプレビュー', exact: true })
    .click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${domain}-style-library.png`), fullPage: true });
}
