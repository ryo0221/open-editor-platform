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
import {
  replaceFileSource,
  create,
  nativeArtifact,
  setDocumentText,
  editCell,
  addRecord,
  save,
} from './fixtures';
import { artifactMenu } from './template-fixtures';
import { reuseHistory } from './reuse-fixtures';
import { readStructure, type Domain } from '@editor-platform/templates';
export async function structureFlow(page: Page, domain: Domain, steps: boolean, info: TestInfo) {
  page.setDefaultTimeout(15000);
  await page.goto('/');
  await create(page, domain);
  const original = nativeContent((await nativeArtifact(page)).draft.content);
  await artifactMenu(page, '部分テンプレートを挿入');
  const gallery = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  const unit = {
    slide: 'ページ',
    whiteboard: 'セクションと図解',
    design: '複合部品のフレーム',
    document: '見出し付き本文',
    data: '型付き列セット',
    review: '表示設定',
    file: '表示設定',
  }[domain];
  const name = `可変${steps ? '手順' : '比較'}・${unit}`;
  const card = gallery
    .getByRole('button', { name: `テンプレートを選択: ${name}`, exact: true })
    .locator('..');
  // The representative artwork is also a selection target.
  await card.locator('.tp-card-art').click({ force: true });
  await expect(gallery.locator('.tp-form-fields > details > summary')).toContainText('任意');
  await expect(gallery.locator('.tp-form-fields > details')).not.toHaveAttribute('open', '');
  await gallery.getByRole('button', { name: steps ? '4項目' : '3項目', exact: true }).click();
  await expect(
    gallery.getByRole('button', { name: steps ? '3項目' : '2項目', exact: true }),
  ).toBeEnabled();
  await expect(gallery.getByRole('alert')).toHaveCount(0);
  await expect(gallery.locator(`[data-slot="items.${steps ? 3 : 2}.title"]`)).toHaveValue(
    `${steps ? '工程' : '比較対象'} ${steps ? 4 : 3}`,
  );
  await gallery.getByRole('button', { name: steps ? '3項目' : '2項目', exact: true }).click();
  if (domain === 'data' && 'columns' in original)
    for (const column of original.columns.filter((c) =>
      ['Quantity', 'Price', 'Total'].includes(c.name),
    ))
      await gallery.getByLabel(`Map ${column.name}`, { exact: true }).selectOption(column.id);
  if (domain === 'data')
    await gallery.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await expect(gallery.getByRole('button', { name: `${unit}を追加`, exact: true })).toBeVisible();
  const marker = steps ? '工程 1' : '比較対象 1';
  if (['slide', 'whiteboard', 'design'].includes(domain))
    await expect
      .poll(async () =>
        decodeURIComponent(
          (await gallery
            .getByRole('img', { name: 'テンプレートの実描画', exact: true })
            .getAttribute('src')) ?? '',
        ),
      )
      .toContain(marker);
  if (domain === 'document')
    await expect(
      gallery.frameLocator('iframe[title="文書テンプレートの実描画"]').locator('h2').first(),
    ).toContainText(marker);
  await gallery.locator('.tp-preview-column').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: info.outputPath(`${domain}-${steps ? 'steps' : 'comparison'}-gallery.png`),
  });
  await gallery.getByRole('button', { name: `${unit}を追加`, exact: true }).click();
  await expect(gallery).toHaveCount(0);
  const inserted = nativeContent((await nativeArtifact(page)).draft.content);
  const instance =
    'reuse' in inserted
      ? inserted.reuse?.instances.find((i) => i.ref.libraryId === 'native-template-layouts')
      : undefined;
  if (!instance) throw new Error('Missing native structure');
  const before = readStructure(inserted, instance.id),
    edited = `${domain}編集`;
  if (domain === 'document') await setDocumentText(page, 'h2', edited);
  else if (domain === 'data') {
    if (!(await page.getByRole('button', { name: 'Add records', exact: true }).isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await addRecord(page);
    await page.locator('.ep-data-grid').evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    await editCell(page, marker, 1, edited);
  } else {
    const canvas = page.getByRole('application', {
      name: `${domain[0].toUpperCase() + domain.slice(1)} canvas`,
      exact: true,
    });
    if (domain === 'design') await canvas.getByText(marker, { exact: true }).first().dblclick();
    else await canvas.getByRole('button').filter({ hasText: marker }).first().dblclick();
    const text = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    if (domain === 'whiteboard' && !(await text.isVisible()))
      await canvas.getByRole('button').filter({ hasText: marker }).first().dblclick();
    await text.press('Control+a');
    await page.keyboard.insertText(edited);
    await text.press('Control+Enter');
  }
  const editedNative = nativeContent((await nativeArtifact(page)).draft.content);
  expect(JSON.stringify(editedNative)).toContain(edited);
  await artifactMenu(page, '項目数・配置を変更');
  let panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
  if (['slide', 'whiteboard', 'design'].includes(domain)) {
    await panel
      .getByRole('checkbox', { name: `${before.items[0].id}の見出しを強調`, exact: true })
      .check();
    await panel
      .getByRole('checkbox', { name: `${before.items[0].id}の説明を表示`, exact: true })
      .uncheck();
    await panel
      .getByRole('checkbox', { name: `${before.items[0].id}の画像を表示`, exact: true })
      .uncheck();
  }
  await panel.getByRole('button', { name: '項目を追加', exact: true }).click();
  if (domain === 'data')
    await panel.getByRole('button', { name: '項目を追加', exact: true }).click();
  await panel.getByRole('button', { name: '構成変更をプレビュー', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(
    panel.getByRole('button', { name: 'この構成変更を適用', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath(`${domain}-reflow.png`) });
  await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
  const added = nativeContent((await nativeArtifact(page)).draft.content),
    addedShape = readStructure(added, instance.id);
  expect(addedShape.items).toHaveLength(before.items.length + (domain === 'data' ? 2 : 1));
  expect(addedShape.items[0].nativeIds).toEqual(before.items[0].nativeIds);
  expect(JSON.stringify(added)).toContain(edited);
  await reuseHistory(page, 'Undo');
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(editedNative);
  await reuseHistory(page, 'Redo');
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(added);
  await artifactMenu(page, '項目数・配置を変更');
  panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
  await panel.getByRole('button', { name: `${before.items[0].id}を下へ`, exact: true }).click();
  await panel.getByRole('button', { name: '構成変更をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
  const reordered = nativeContent((await nativeArtifact(page)).draft.content);
  expect(readStructure(reordered, instance.id).items[1].id).toBe(before.items[0].id);
  expect(JSON.stringify(reordered)).toContain(edited);
  await artifactMenu(page, '項目数・配置を変更');
  panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
  const addedItem = addedShape.items.at(-1)!;
  for (const item of addedShape.items.filter((i) => !before.items.some((old) => old.id === i.id)))
    await panel.getByRole('button', { name: `${item.id}を削除候補にする`, exact: true }).click();
  await expect(panel).toContainText('削除予定:');
  await panel.getByRole('button', { name: '構成変更をプレビュー', exact: true }).click();
  await expect(panel).toContainText(`削除: ${addedItem.label} (${addedItem.id})`);
  await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
  const removed = nativeContent((await nativeArtifact(page)).draft.content);
  expect(JSON.stringify(removed)).toContain(edited);
  expect(readStructure(removed, instance.id).items).toHaveLength(before.items.length);
  await save(page, 1);
  await page.reload();
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(removed);
  if (domain === 'slide' && 'slides' in removed) {
    const pageIndex = removed.slides.findIndex((s) => JSON.stringify(s).includes(edited));
    await page.getByLabel('Current page', { exact: true }).fill(String(pageIndex + 1));
    await expect(
      page.getByRole('application', { name: 'Slide canvas', exact: true }),
    ).toContainText(edited);
  }
  if (domain === 'data') {
    await page.locator('.ep-data-grid').evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    const cell = page.getByRole('gridcell', { name: `${marker} · record 1`, exact: true });
    await expect(cell).toContainText(edited);
    await cell.scrollIntoViewIfNeeded();
  }
  if (domain === 'whiteboard')
    await page.getByRole('button', { name: 'Fit board', exact: true }).click();
  const menu =
    domain === 'document' || domain === 'data'
      ? 'Export artifact'
      : domain === 'slide'
        ? 'Export visual'
        : domain === 'whiteboard'
          ? 'Export whiteboard'
          : 'Export design';
  const exportMenu = page.getByRole('button', { name: menu, exact: true });
  if (!(await exportMenu.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await exportMenu.click();
  if (domain === 'slide')
    await page.getByLabel('Export scope', { exact: true }).selectOption('all');
  const pending = page.waitForEvent('download');
  await page
    .getByRole('button', {
      name:
        domain === 'document'
          ? 'Export HTML'
          : domain === 'data'
            ? 'Export CSV'
            : domain === 'slide'
              ? 'Export SVG'
              : 'Export all SVG',
      exact: true,
    })
    .click();
  if (domain === 'data')
    await page
      .getByRole('dialog', { name: 'CSV export scope' })
      .getByRole('button', { name: 'Download CSV', exact: true })
      .click();
  const file = await pending,
    { readFile } = await import('node:fs/promises'),
    bytes = await readFile((await file.path())!);
  const { unzipSync } = await import('fflate');
  const exported = file.suggestedFilename().endsWith('.zip')
    ? Object.values(unzipSync(bytes))
        .map((v) => new TextDecoder().decode(v))
        .join('\n')
    : bytes.toString('utf8');
  expect(exported).toContain(edited);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath(`${domain}-native-edited.png`) });
  const native = await nativeArtifact(page);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'native-structure.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(native)),
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const imported = await nativeArtifact(page);
  expect(imported.draft.content).toEqual(removed);
  expect(imported.versions.map((v) => v.contentHash)).toEqual(
    native.versions.map((v) => v.contentHash),
  );
  await artifactMenu(page, '項目数・配置を変更');
  await expect(page.getByRole('dialog', { name: '項目数・配置を変更', exact: true })).toContainText(
    domain === 'data' ? marker : edited,
  );
  await page.keyboard.press('Escape');
}
export async function settingFlow(page: Page, domain: 'review' | 'file', info: TestInfo) {
  page.setDefaultTimeout(15000);
  await page.goto('/');
  await create(page, domain);
  if (domain === 'file') {
    const data = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 200;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#e0edf5';
      ctx.fillRect(0, 0, 400, 200);
      ctx.fillStyle = '#336699';
      ctx.fillRect(60, 40, 160, 100);
      return c.toDataURL('image/png');
    });
    if (!(await page.getByRole('button', { name: 'Replace source', exact: true }).isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await replaceFileSource(page, {
      name: 'source.png',
      mimeType: 'image/png',
      buffer: Buffer.from(data.split(',')[1], 'base64'),
    });
    await page.keyboard.press('Escape');
    if (!(await page.getByRole('button', { name: 'Select file region', exact: true }).isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await page.getByRole('button', { name: 'Select file region', exact: true }).click();
    await page.keyboard.press('Escape');
    const box = (await page.getByLabel('Select image region', { exact: true }).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 });
    await page.mouse.up();
  } else
    await page
      .getByRole('button', { name: /^added new line / })
      .first()
      .click();
  const { comments } = await import('./fixtures');
  await comments(page);
  await page.getByLabel('Comment', { exact: true }).fill('保持する既存注釈');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  const before = await nativeArtifact(page);
  const { saveView, adoptView } = await import('./reuse-view-fixtures');
  await saveView(page, domain);
  await adoptView(page);
  const prefs = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('ep-template-view-settings') ?? '{}'));
  const previous = await prefs();
  await artifactMenu(page, 'スタイル・表示プリセット');
  const gallery = page.getByRole('dialog', { name: 'スタイル・表示プリセット', exact: true });
  await gallery
    .getByRole('button', {
      name: `テンプレートを選択: ${domain === 'review' ? '読みやすい差分表示' : '原本を倍率指定で表示'}`,
      exact: true,
    })
    .click();
  if (domain === 'file') {
    await gallery.locator('[data-slot="zoom"]').fill('2');
    await gallery.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  }
  await gallery.getByRole('button', { name: 'この設定を適用', exact: true }).click();
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(before.draft.content);
  expect((await nativeArtifact(page)).annotations).toEqual(before.annotations);
  const afterPrefs = await prefs();
  expect(afterPrefs[before.id].$annotation).toEqual(previous[before.id].$annotation);
  if (domain === 'review') {
    const { reviewTools } = await import('./reuse-view-fixtures');
    await reviewTools(page);
    await expect(page.getByLabel('Diff layout', { exact: true })).toHaveValue('split');
    await expect(page.getByLabel('Wrap lines', { exact: true })).toBeChecked();
  } else {
    if (!(await page.getByLabel('File zoom', { exact: true }).isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await expect(page.getByLabel('File zoom', { exact: true })).toHaveValue('2');
  }
  await page.keyboard.press('Escape');
  await page.reload();
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(before.draft.content);
  expect((await nativeArtifact(page)).annotations).toEqual(before.annotations);
  if (domain === 'file') {
    if (!(await page.getByLabel('File zoom', { exact: true }).isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await expect(page.getByLabel('File zoom', { exact: true })).toHaveValue('2');
  }
  await page.screenshot({ path: info.outputPath(`${domain}-private-settings.png`) });
}

export async function sourceFlow(page: Page, info: TestInfo) {
  await page.goto('/');
  await create(page, 'document');
  await artifactMenu(page, '部分テンプレートを挿入');
  let gallery = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await gallery
    .getByLabel('テンプレートの再利用単位', { exact: true })
    .selectOption('見出し付き本文');
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 可変比較・見出し付き本文', exact: true })
    .click();
  await gallery.getByRole('button', { name: '見出し付き本文を追加', exact: true }).click();
  await setDocumentText(page, 'h2', '原本保存前');
  let native = nativeContent((await nativeArtifact(page)).draft.content);
  const id =
    'reuse' in native
      ? native.reuse!.instances.find((i) => i.ref.libraryId === 'native-template-layouts')!.id
      : '';
  const originalHash = readStructure(native, id).definition.hash;
  await artifactMenu(page, '項目数・配置を変更');
  let panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
  await panel.getByLabel('原本との関係', { exact: true }).selectOption('linked');
  await panel.getByRole('button', { name: '構成変更をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
  await artifactMenu(page, '項目数・配置を変更');
  panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
  await panel
    .getByRole('button', { name: '編集済みの構成を新しい原本の版として保存', exact: true })
    .click();
  await expect(panel.getByRole('status')).toContainText('原本 v2を公開');
  await page.keyboard.press('Escape');
  await setDocumentText(page, 'h2', '原本二度目の保存');
  await artifactMenu(page, '項目数・配置を変更');
  panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
  await panel
    .getByRole('button', { name: '編集済みの構成を新しい原本の版として保存', exact: true })
    .click();
  await expect(panel.getByRole('status')).toContainText('原本 v3を公開');
  await page.keyboard.press('Escape');
  await setDocumentText(page, 'h2', '配置後の独立編集');
  native = nativeContent((await nativeArtifact(page)).draft.content);
  expect(readStructure(native, id).definition.templateVersion).toBe(1);
  await artifactMenu(page, '項目数・配置を変更');
  panel = page.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
  await panel.getByRole('button', { name: '原本の新しい版を確認', exact: true }).click();
  await panel.getByRole('button', { name: '原本更新の影響をプレビュー', exact: true }).click();
  await expect(panel).toContainText('原本 v1 → v3');
  await page.screenshot({ path: info.outputPath('source-update-preview.png') });
  await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
  const updated = nativeContent((await nativeArtifact(page)).draft.content);
  expect(readStructure(updated, id).definition.templateVersion).toBe(3);
  expect(readStructure(updated, id).items[0].label).toBe('配置後の独立編集');
  await reuseHistory(page, 'Undo');
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(native);
  await reuseHistory(page, 'Redo');
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(updated);
  await page.reload();
  expect(nativeContent((await nativeArtifact(page)).draft.content)).toEqual(updated);
  await artifactMenu(page, '部分テンプレートを挿入');
  gallery = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 可変比較・見出し付き本文', exact: true })
    .click();
  await expect(gallery.locator('[data-slot="items.0.title"]')).toHaveValue('原本二度目の保存');
  await gallery.getByLabel('テンプレートの版', { exact: true }).selectOption('2');
  await expect(gallery.locator('[data-slot="items.0.title"]')).toHaveValue('原本保存前');
  await gallery.getByLabel('テンプレートの版', { exact: true }).selectOption('1');
  await expect(gallery.locator('[data-slot="items.0.title"]')).toHaveValue('比較対象 1');
  expect(readStructure(native, id).definition.hash).toBe(originalHash);
}
