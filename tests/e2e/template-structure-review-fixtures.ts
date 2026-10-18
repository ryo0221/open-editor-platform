import { isGraphDocument } from '@editor-platform/structured-graph/model';
import { isReactUiDocument } from '@editor-platform/react-ui-core';
import type { Content } from '../../apps/playground/src/model';
import type { NativeContent } from '@editor-platform/templates';
function nativeContent(content: Content): NativeContent {
  if (isReactUiDocument(content) || isGraphDocument(content) || 'layers' in content)
    throw new Error('Expected native content');
  return content;
}
import { expect, type Page, type TestInfo } from '@playwright/test';
import { create, nativeArtifact, save } from './fixtures';
import { artifactMenu } from './template-fixtures';
import {
  readStructure,
  itemPart,
  createStructureVersion,
  exportTemplatePack,
  reusableParts,
  structureAppearanceAddress,
} from '@editor-platform/templates';
import { reuseHistory } from './reuse-fixtures';

export async function deletedStructureImport(page: Page, historical: boolean, info: TestInfo) {
  await page.goto('/');
  await create(page, 'slide');
  await artifactMenu(page, '部分テンプレートを挿入');
  const gallery = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 可変比較・ページ', exact: true })
    .click();
  await gallery.getByRole('button', { name: 'ページを追加', exact: true }).click();
  const before = nativeContent((await nativeArtifact(page)).draft.content);
  if (!('slides' in before)) throw new Error('slide');
  const id = before.reuse!.instances[0].id,
    current = readStructure(before, id),
    title = current.instance.parts[itemPart(current.items[0].id, 'title')];
  await page
    .getByRole('application', { name: 'Slide canvas', exact: true })
    .getByRole('button')
    .filter({ hasText: '比較対象 1' })
    .first()
    .click();
  await page.keyboard.press('Delete');
  const deleted = nativeContent((await nativeArtifact(page)).draft.content);
  if (!('slides' in deleted)) throw new Error('slide');
  expect(deleted.slides.flatMap((s) => s.objects).some((o) => o.id === title)).toBe(false);
  expect(deleted.reuse).toEqual(before.reuse);
  if (historical) {
    await save(page, 1);
    await artifactMenu(page, '項目数・配置を変更');
    const panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
    await expect(panel.getByRole('alert')).toContainText('要修復');
    await panel.getByRole('button', { name: '構成の管理を解除して自由編集', exact: true }).click();
    await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
  }
  const exported = await nativeArtifact(page);
  if (historical) {
    expect(exported.versions[0].content).toEqual(deleted);
    expect(
      'reuse' in exported.draft.content ? exported.draft.content.reuse?.instances : [],
    ).toEqual([]);
  }
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'deleted-structure.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(async () => (await nativeArtifact(page)).id).not.toBe(exported.id);
  const imported = await nativeArtifact(page);
  expect(imported.draft.content).toEqual(exported.draft.content);
  expect(imported.versions).toEqual(
    exported.versions.map((v) => ({ ...v, artifactId: imported.id })),
  );
  if (!historical) {
    await artifactMenu(page, '項目数・配置を変更');
    const panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
    await expect(panel.getByRole('alert')).toContainText('要修復');
    await page.screenshot({ path: info.outputPath('repairable-native-import.png') });
    await panel.getByRole('button', { name: '構成の管理を解除して自由編集', exact: true }).click();
    await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
  }
  await page.reload();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const pageIndex = deleted.slides.findIndex((s) =>
    s.objects.some((o) => o.id === current.items[1].nativeIds[0]),
  );
  await page.getByLabel('Current page', { exact: true }).fill(String(pageIndex + 1));
  await page.screenshot({ path: info.outputPath('historical-native-import.png') });
}

export async function designComponentAdoption(page: Page, info: TestInfo) {
  await page.goto('/');
  await create(page, 'design');
  await artifactMenu(page, '部分テンプレートを挿入');
  let gallery = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 可変比較・複合部品のフレーム', exact: true })
    .click();
  await gallery.getByRole('button', { name: '複合部品のフレームを追加', exact: true }).click();
  const inserted = nativeContent((await nativeArtifact(page)).draft.content);
  if (!('components' in inserted)) throw new Error('design');
  const id = inserted.reuse!.instances[0].id,
    before = readStructure(inserted, id),
    original = before.items.map((i) =>
      structuredClone(reusableParts(inserted).get(i.nativeIds[0])),
    );
  await artifactMenu(page, '項目数・配置を変更');
  let panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
  await panel.getByLabel('原本との関係', { exact: true }).selectOption('linked');
  await panel.getByRole('button', { name: '構成変更をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
  const source = before.definition,
    definitionContent = structuredClone(source.content!);
  if (!('components' in definitionContent)) throw new Error('design');
  definitionContent.components[0].elements!.find((e) => e.id === 'cardTitle')!.fill = '#cf2358';
  const v2 = await createStructureVersion(source, { content: definitionContent }),
    pack = await exportTemplatePack([v2]);
  await artifactMenu(page, '部分テンプレートを挿入');
  gallery = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await gallery.getByLabel('テンプレートpackを読み込む', { exact: true }).setInputFiles({
    name: 'component-v2.template.json',
    mimeType: 'application/json',
    buffer: Buffer.from(pack),
  });
  await expect(
    gallery.getByRole('button', {
      name: 'テンプレートを選択: 可変比較・複合部品のフレーム',
      exact: true,
    }),
  ).toContainText('v2');
  await page.keyboard.press('Escape');
  await artifactMenu(page, '項目数・配置を変更');
  panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
  await panel.getByRole('button', { name: '原本の新しい版を確認', exact: true }).click();
  await panel.getByRole('button', { name: '原本更新の影響をプレビュー', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
  const adopted = nativeContent((await nativeArtifact(page)).draft.content);
  expect(readStructure(adopted, id).definition.templateVersion).toBe(2);
  await artifactMenu(page, '項目数・配置を変更');
  panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
  await panel.getByRole('button', { name: '項目を追加', exact: true }).click();
  await panel.getByRole('button', { name: '構成変更をプレビュー', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
  const added = nativeContent((await nativeArtifact(page)).draft.content),
    current = readStructure(added, id),
    color = (itemId: string) =>
      reusableParts(added).get(structureAppearanceAddress(current, itemId, 'title/cardTitle'))!
        .fill;
  expect(current.items).toHaveLength(3);
  for (const [index, item] of before.items.entries()) {
    expect(color(item.id)).toBe('#263c48');
    const native = reusableParts(added).get(item.nativeIds[0])!;
    expect({ ...native, bounds: original[index]!.bounds }).toEqual(original[index]);
  }
  expect(color(current.items[2].id)).toBe('#cf2358');
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  await expect(canvas.getByText('新しい項目', { exact: true })).toHaveCSS(
    'fill',
    'rgb(207, 35, 88)',
  );
  await expect(canvas.getByText('比較対象 1', { exact: true })).toHaveCSS(
    'fill',
    'rgb(38, 60, 72)',
  );
  await page.screenshot({ path: info.outputPath('design-adopted-component-colors.png') });
  await reuseHistory(page, 'Undo');
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(adopted);
  await reuseHistory(page, 'Redo');
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(added);
  await page.reload();
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(added);
}
