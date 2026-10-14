import { expect, type Page } from '@playwright/test';
import { comments, create, nativeArtifact } from './fixtures';
import { reuseMenu } from './reuse-fixtures';

export const viewName = '原本を保つ確認設定';
export const viewLibrary = (page: Page) =>
  page.getByRole('dialog', { name: '表示設定ライブラリ', exact: true });
export async function saveView(page: Page, domain: 'review' | 'file', resume = false) {
  page.setDefaultTimeout(12000);
  await reuseMenu(page, '表示設定を保存');
  let editor = page.getByRole('dialog', { name: '表示設定の下書き・公開', exact: true });
  await editor.getByRole('textbox', { name: '設定名', exact: true }).fill(viewName);
  if (domain === 'review') {
    await editor.getByLabel('左右に分けて表示', { exact: true }).check();
    await editor.getByLabel('長い行を折り返す', { exact: true }).check();
  } else
    await editor
      .getByRole('combobox', { name: '原本の表示サイズ', exact: true })
      .selectOption('width');
  await editor
    .getByRole('textbox', { name: '新しい注釈の本文', exact: true })
    .fill('設定からの確認');
  await editor.getByLabel('新しい注釈の色', { exact: true }).fill('#336699');
  await editor.getByRole('button', { name: '表示設定をプレビュー', exact: true }).click();
  await expect(editor.getByLabel('表示設定のプレビュー', { exact: true })).toContainText(
    '設定からの確認',
  );
  await editor.getByRole('button', { name: '下書きを保存', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('保存済みの下書き: 1');
  if (resume) {
    await editor.getByRole('button', { name: 'Close 表示設定の下書き・公開', exact: true }).click();
    await reuseMenu(page, '表示設定ライブラリ');
    await viewLibrary(page)
      .getByRole('button', { name: `${viewName} — 下書き 1`, exact: true })
      .click();
    editor = page.getByRole('dialog', { name: '表示設定の下書き・公開', exact: true });
  }
  await editor.getByRole('button', { name: '保存した版を公開', exact: true }).click();
  await expect(editor).toHaveCount(0);
  if (await viewLibrary(page).isVisible())
    await viewLibrary(page)
      .getByRole('button', { name: 'Close 表示設定ライブラリ', exact: true })
      .click();
}
export async function adoptView(page: Page, version = 1, copy = false) {
  await reuseMenu(page, '表示設定ライブラリ');
  const library = viewLibrary(page);
  await library.getByRole('button', { name: `${viewName} v${version}`, exact: true }).click();
  if (copy)
    await library
      .getByRole('combobox', { name: '表示設定の使い方', exact: true })
      .selectOption('copy');
  await library.getByRole('button', { name: '適用内容をプレビュー', exact: true }).click();
  await expect(library.getByLabel('表示設定の適用プレビュー', { exact: true })).toBeVisible();
  await library.getByRole('button', { name: 'この表示設定を適用', exact: true }).click();
  await expect(library).toHaveCount(0);
}
export async function annotationFromView(page: Page, expected = '設定からの確認') {
  await comments(page);
  await page.getByRole('button', { name: '設定から注釈を作成', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '設定から注釈を作成', exact: true });
  await expect(dialog.getByRole('textbox', { name: '注釈の本文', exact: true })).toHaveValue(
    expected,
  );
  await dialog.getByRole('button', { name: '注釈をプレビュー', exact: true }).click();
  await expect(dialog.getByLabel('注釈の適用プレビュー', { exact: true })).toContainText(
    '原本の版',
  );
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  return dialog;
}
export async function confirmAnnotation(page: Page, expected = '設定からの確認') {
  const dialog = await annotationFromView(page, expected);
  await dialog.getByRole('button', { name: 'この範囲に注釈を作成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.comment-thread').last()).toContainText(expected);
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
}
export async function reviewTools(page: Page) {
  await expect(page.getByRole('region', { name: 'Code diff', exact: true })).toBeVisible();
  if (!(await page.getByRole('combobox', { name: 'Diff layout', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
}
export async function reviewViewFlow(page: Page) {
  await page.goto('/');
  await create(page, 'review');
  await expect(page.getByRole('region', { name: 'Code diff', exact: true })).toBeVisible();
  const before = await nativeArtifact(page);
  await saveView(page, 'review', true);
  await adoptView(page);
  await reviewTools(page);
  await page.getByRole('combobox', { name: 'Diff layout', exact: true }).selectOption('split');
  await expect(page.getByLabel('Wrap lines', { exact: true })).toBeChecked();
  await page
    .getByRole('button', { name: /^added new line / })
    .first()
    .click();
  await confirmAnnotation(page);
  const annotation = (await nativeArtifact(page)).annotations[0];
  expect(annotation.color).toBe('#336699');
  await reuseMenu(page, '表示設定ライブラリ');
  let library = viewLibrary(page);
  await library.getByRole('button', { name: `${viewName} v1`, exact: true }).click();
  await library.getByRole('button', { name: '表示設定の新版を作成', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '表示設定の下書き・公開', exact: true });
  await editor.getByLabel('左右に分けて表示', { exact: true }).uncheck();
  await editor.getByLabel('長い行を折り返す', { exact: true }).uncheck();
  await editor.getByRole('textbox', { name: '新しい注釈の本文', exact: true }).fill('改訂後の確認');
  await editor.getByLabel('新しい注釈の色', { exact: true }).fill('#cc3300');
  await editor.getByRole('button', { name: '下書きを保存', exact: true }).click();
  await editor.getByRole('button', { name: '保存した版を公開', exact: true }).click();
  library = viewLibrary(page);
  await expect(
    library.getByRole('button', { name: `採用中: ${viewName} v1`, exact: true }),
  ).toBeVisible();
  await library.getByRole('button', { name: `${viewName} v2`, exact: true }).click();
  await library.getByRole('button', { name: '適用内容をプレビュー', exact: true }).click();
  await expect(library.getByLabel('表示設定の適用プレビュー', { exact: true })).toContainText(
    '自分の設定を保持',
  );
  await library.getByRole('button', { name: 'この表示設定を適用', exact: true }).click();
  await reviewTools(page);
  await expect(page.getByRole('combobox', { name: 'Diff layout', exact: true })).toHaveValue(
    'split',
  );
  await expect(page.getByLabel('Wrap lines', { exact: true })).not.toBeChecked();
  await page.reload();
  await reviewTools(page);
  await expect(page.getByRole('combobox', { name: 'Diff layout', exact: true })).toHaveValue(
    'split',
  );
  await expect(page.getByLabel('Wrap lines', { exact: true })).not.toBeChecked();
  await reuseMenu(page, '表示設定ライブラリ');
  library = viewLibrary(page);
  await library.getByRole('button', { name: `${viewName} v2`, exact: true }).click();
  await library.getByRole('button', { name: '表示設定をアーカイブ', exact: true }).click();
  await expect(library.getByRole('button', { name: `${viewName} v2`, exact: true })).toHaveCount(0);
  await expect(
    library.getByRole('button', { name: `採用中: ${viewName} v2`, exact: true }),
  ).toBeVisible();
  await library.getByRole('button', { name: 'Close 表示設定ライブラリ', exact: true }).click();
  await page
    .getByRole('button', { name: /^added new line / })
    .first()
    .click();
  await confirmAnnotation(page, '改訂後の確認');
  const after = await nativeArtifact(page);
  expect(after.draft.content).toEqual(before.draft.content);
  expect(after.annotations).toHaveLength(2);
  expect(after.annotations[0]).toEqual(annotation);
  expect(after.annotations[1].color).toBe('#cc3300');
  expect(after.annotations[1].comments[0].author).toBe('local-user');
  await reuseMenu(page, '表示設定ライブラリ');
  library = viewLibrary(page);
  await library.getByLabel('アーカイブ済みも表示', { exact: true }).check();
  await library
    .getByRole('button', { name: `${viewName} v2（アーカイブ済み）`, exact: true })
    .click();
  await library.getByRole('button', { name: 'アーカイブから戻す', exact: true }).click();
  await library.getByRole('button', { name: `採用中: ${viewName} v2`, exact: true }).click();
  await library.getByLabel('左右に分けて表示を部品の既定値に戻す', { exact: true }).check();
  await library.getByRole('button', { name: '適用内容をプレビュー', exact: true }).click();
  await library.getByRole('button', { name: 'この表示設定を適用', exact: true }).click();
  await reviewTools(page);
  await expect(page.getByRole('combobox', { name: 'Diff layout', exact: true })).toHaveValue(
    'unified',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return after;
}
