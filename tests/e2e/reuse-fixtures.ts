import { expect, type Page } from '@playwright/test';
import { nativeArtifact, create, setDocumentText } from './fixtures';
import type { DocumentContent } from '@editor-platform/document/model';
import type { DesignContent } from '@editor-platform/design/model';
export async function reuseMenu(page: Page, name: string) {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'More artifact actions', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
}
export async function reuseHistory(page: Page, name: 'Undo' | 'Redo') {
  const button = page.getByRole('button', { name, exact: true });
  if (await button.isVisible()) await button.click();
  else await reuseMenu(page, name);
  await page.keyboard.press('Escape');
}
export async function componentFlow(page: Page, domain: 'design' | 'document') {
  await page.goto('/');
  await create(page, domain);
  if (domain === 'document') await setDocumentText(page, 'p', '再利用する注意書き');
  else await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await reuseMenu(page, '再利用部品として保存');
  const author = page.getByRole('dialog', { name: '再利用部品として保存', exact: true });
  await author.getByLabel('部品名', { exact: true }).fill('日本語の部品');
  await author.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  await expect(author.getByRole('button', { name: '部品を公開', exact: true })).toBeVisible();
  await author.getByRole('button', { name: '部品を公開', exact: true }).click();
  await expect(author).toHaveCount(0);
  await reuseMenu(page, '部品ライブラリ');
  const library = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await library.getByRole('button', { name: '日本語の部品 v1', exact: true }).click();
  await library.locator('textarea[data-slot^="text_"]').first().fill('明示した日本語の入力');
  await library.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  await library.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect(library).toHaveCount(0);
  const inserted = (await nativeArtifact(page)).draft.content as DocumentContent | DesignContent;
  expect(inserted.reuse?.instances).toHaveLength(1);
  expect(Object.values(inserted.reuse!.instances[0].inputs)).toContain('明示した日本語の入力');
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
  await reuseMenu(page, '部品の入力・表示');
  let inspector = page.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await inspector.getByRole('button', { name: '日本語の部品 v1', exact: true }).click();
  await expect(inspector.locator('textarea[data-slot^="text_"]').first()).toHaveValue(
    '明示した日本語の入力',
  );
  await inspector.getByRole('button', { name: 'Close 部品の入力・表示', exact: true }).click();
  await reuseMenu(page, '部品の入力・表示');
  inspector = page.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await inspector.getByRole('button', { name: '日本語の部品 v1', exact: true }).click();
  await inspector.locator('input[data-slot^="visible_"]').first().uncheck();
  await inspector.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await reuseHistory(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
  await reuseHistory(page, 'Redo');
  const hidden = (await nativeArtifact(page)).draft.content as DocumentContent | DesignContent;
  expect(JSON.stringify(hidden)).toContain('明示した日本語の入力');
  await reuseMenu(page, '部品の入力・表示');
  inspector = page.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await inspector.getByRole('button', { name: '日本語の部品 v1', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return { inspector, inserted, hidden };
}
