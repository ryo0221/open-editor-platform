import { test, expect } from './fixtures';
import { reviewViewFlow, viewLibrary, viewName } from './reuse-view-fixtures';
import { reuseMenu } from './reuse-fixtures';
test('R12/R16 mobile Review preset revision preserves private override, source and annotation', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  await reviewViewFlow(page);
  await page.screenshot({ path: info.outputPath('review-preset-mobile.png'), fullPage: true });
  await reuseMenu(page, '表示設定ライブラリ');
  await viewLibrary(page)
    .getByRole('button', { name: `採用中: ${viewName} v2`, exact: true })
    .click();
  await viewLibrary(page)
    .getByRole('button', { name: '適用内容をプレビュー', exact: true })
    .click();
  await expect(viewLibrary(page).getByLabel('表示設定の適用プレビュー')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: info.outputPath('review-preset-library-mobile.png'),
    fullPage: true,
  });
});
