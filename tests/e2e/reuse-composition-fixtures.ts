import { expect, type Page, type TestInfo } from '@playwright/test';
import { nativeArtifact } from './fixtures';
import { authorAndInsert, insertPublished, componentName } from './reuse-revision-fixtures';
import { artifactMenu, downloadText } from './template-fixtures';
import type { DocumentContent } from '@editor-platform/document/model';
import { writeFile } from 'node:fs/promises';

const exact = { exact: true };
export async function compositionFlow(page: Page, info: TestInfo) {
  await authorAndInsert(page, true);
  const before = await insertPublished(page, '固定する部品の本文', true);
  await artifactMenu(page, 'テンプレートとして保存');
  const author = page.getByRole('dialog', { name: 'テンプレートとして保存', ...exact });
  await author.getByLabel('テンプレート名', exact).fill('案件の複合テンプレート');
  await author.getByRole('checkbox', { name: '部品の参照と公開入力を含める', ...exact }).check();
  await author
    .getByRole('combobox', { name: `${componentName} 1の再利用方法`, ...exact })
    .selectOption('linked');
  for (const index of [1, 2]) {
    const member = author.getByRole('group', { name: `${componentName} ${index}（v1）`, ...exact });
    await member.locator('summary', { hasText: '公開入力を選ぶ' }).click();
    await member
      .getByRole('checkbox', {
        name: `${componentName} ${index}：再利用する本文を入力にする`,
        ...exact,
      })
      .check();
    await member
      .getByRole('textbox', { name: `Component input label ${index}-1`, ...exact })
      .fill(index === 1 ? '案件の本文' : '独立コピーの本文');
  }
  await author.getByRole('button', { name: '保存内容をプレビュー', ...exact }).click();
  await expect(author).toContainText('リンク 1部品 / コピー 1部品');
  await author
    .getByRole('checkbox', { name: '部品の参照と公開入力を含める', ...exact })
    .scrollIntoViewIfNeeded();
  await author.screenshot({ path: info.outputPath('composition-choices.png') });
  await author
    .getByRole('button', { name: 'テンプレートを保存', ...exact })
    .scrollIntoViewIfNeeded();
  await author.screenshot({ path: info.outputPath('composition-author.png') });
  await author.getByRole('button', { name: 'テンプレートを保存', ...exact }).click();
  await expect(author).toHaveCount(0);
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await page.reload();
  if (!(await page.getByLabel('Artifact type', exact).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', ...exact }).click();
  await page.getByRole('button', { name: 'テンプレートから作成', ...exact }).click();
  const gallery = page.getByRole('dialog', { name: 'テンプレートから作成', ...exact });
  await gallery.getByLabel('テンプレート検索', exact).fill('案件の複合テンプレート');
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 案件の複合テンプレート', ...exact })
    .click();
  await expect(gallery).toContainText('リンク 1部品 / コピー 1部品');
  await gallery.getByLabel('案件の本文', { exact: false }).fill('案件Bの日本語本文');
  await gallery.getByLabel('独立コピーの本文', { exact: false }).fill('独立して編集する本文');
  const pack = await downloadText(page, 'packを書き出す');
  expect(
    JSON.parse(pack).reusable.some((c: { definitions: { kind: string }[] }) =>
      c.definitions.some((d) => d.kind === 'template'),
    ),
  ).toBe(true);
  await gallery.getByRole('button', { name: '入力内容をプレビュー', ...exact }).click();
  await expect(gallery.frameLocator('iframe').locator('body')).toContainText('案件Bの日本語本文');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await gallery.screenshot({ path: info.outputPath('composition-gallery.png') });
  await gallery.getByRole('button', { name: 'この内容で作成', ...exact }).click();
  await expect(gallery).toHaveCount(0);
  const created = (await nativeArtifact(page)).draft.content as DocumentContent;
  expect(created.reuse!.instances).toHaveLength(1);
  expect(created.blocks.map((b) => b.text)).toEqual(
    expect.arrayContaining(['案件Bの日本語本文', '独立して編集する本文']),
  );
  expect(created.blocks.filter((b) => b.text === '必須スロットの日本語')).toHaveLength(2);
  expect(created.blocks.some((b) => before.blocks.some((other) => other.id === b.id))).toBe(false);
  await writeFile(info.outputPath('normal-composition.template.json'), pack);
  await writeFile(
    info.outputPath('normal-composition.native.json'),
    JSON.stringify(created, null, 2),
  );
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(created);
  return { pack, created };
}
