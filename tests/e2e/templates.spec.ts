import { test, expect, nativeArtifact, save, artifactView } from './fixtures';
import { mkdir } from 'node:fs/promises';

test('TP-Q02/03 Slide comparison: human form, native preview, edit, save and reload', async ({
  page,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(10000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: 'テンプレートから作成', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'テンプレートから作成', exact: true });
  await gallery.getByLabel('テンプレートのEditor', { exact: true }).selectOption('slide');
  await expect(gallery.locator('.tp-card')).toHaveCount(5);
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 選択肢比較', exact: true })
    .click();
  await gallery.locator('[data-slot="title"]').fill('比較から決める次の一歩');
  await gallery.locator('[data-slot="left.title"]').fill('小さく試す案');
  await gallery.locator('[data-slot="left.items"]').fill('2週間で検証\n費用を抑える');
  await gallery.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await expect(gallery.getByRole('button', { name: 'この内容で作成', exact: true })).toBeVisible();
  await expect(gallery.locator('.tp-preview-column img')).toBeVisible();
  await mkdir('docs/screenshots/issue-4', { recursive: true });
  await page.screenshot({
    path: 'docs/screenshots/issue-4/slide-human-preview.png',
    fullPage: true,
  });
  await gallery.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(gallery).toHaveCount(0);
  const native = await nativeArtifact(page);
  expect(JSON.stringify(native.draft.content)).toContain('比較から決める次の一歩');
  expect(JSON.stringify(native.draft.content)).toContain('小さく試す案');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  const changed = await nativeArtifact(page);
  expect(changed.draft.content).not.toEqual(native.draft.content);
  await save(page, 1);
  await artifactView(page, 'Editor');
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(changed.draft.content);
});
