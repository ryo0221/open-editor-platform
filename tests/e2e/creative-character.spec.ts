import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import type { Artifact } from '@editor-platform/artifact-core';
import type { DesignContent } from '@editor-platform/design/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { test, expect, tinyPng } from './fixtures';
import type { CreativeConcurrencyFixture } from '../fixtures/creative-host/concurrent-source';

test.setTimeout(90_000);

async function closePanels(page: Page) {
  for (const label of ['Close 人物の部位', 'Close 部位の編集']) {
    const close = page.getByRole('button', { name: label, exact: true });
    if (await close.isVisible()) await close.click();
  }
}

async function inspector(page: Page) {
  const panel = page.getByRole('complementary', { name: '部位の編集', exact: true });
  if (!(await panel.isVisible()))
    await page.getByRole('button', { name: 'Toggle 部位の編集', exact: true }).click();
  await expect(panel).toBeVisible();
  return panel;
}

async function selectPart(page: Page, name: string, scope = 'instance') {
  await closePanels(page);
  await page.getByRole('button', { name: 'Toggle 人物の部位', exact: true }).click();
  const left = page.getByRole('complementary', { name: '人物の部位', exact: true });
  await left.getByLabel('変更の範囲', { exact: true }).selectOption(scope);
  await left.getByRole('button', { name, exact: true }).click();
  await left.getByRole('button', { name: 'Close 人物の部位', exact: true }).click();
  return inspector(page);
}

async function openCharacter(page: Page) {
  await page.goto('/creative-design.html');
  await expect(page.getByRole('heading', { name: 'キャラクター設計', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '設定画を作る', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Design canvas', exact: true })).toBeVisible();
  await expect(page.locator('.creative-candidates article')).toHaveCount(3);
  await closePanels(page);
}

async function exported<T>(page: Page, name: string): Promise<T> {
  await closePanels(page);
  const details = page.locator('details.creative-export');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  const pending = page.waitForEvent('download');
  await details.getByRole('button', { name, exact: true }).click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as T;
}

const design = async (page: Page) =>
  (await exported<Artifact<DesignContent>>(page, '設定画のnative JSON')).draft.content;
const instance = (content: DesignContent, n: number) =>
  content.elements.find((e) => e.id === `instance-candidate-${n}`)!;
const sharedPart = (content: DesignContent, id: string) =>
  content.components
    .find((c) => c.id === 'component-character')!
    .elements!.find((e) => e.id === id)!;

async function commit(page: Page, label: string, value: string) {
  const panel = await inspector(page);
  const input = panel.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press('Enter');
}

async function history(page: Page, direction: '元に戻す' | 'やり直す') {
  await closePanels(page);
  await page.getByRole('button', { name: direction, exact: true }).click();
}

async function saveProject(page: Page) {
  await closePanels(page);
  await page.getByRole('button', { name: '設定と設定画を保存', exact: true }).click();
  await expect(page.locator('.creative-actions [role="status"]')).toHaveText('保存しました');
}

test('capacity: repeated clean saves and reopen keep native source and artwork versions', async ({
  page,
}) => {
  await openCharacter(page);
  await saveProject(page);
  const source = await exported<Artifact<StructuredData>>(page, '正本のnative JSON');
  const artwork = await exported<Artifact<DesignContent>>(page, '設定画のnative JSON');
  await saveProject(page);
  await saveProject(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'キャラクター設計', exact: true })).toBeVisible();
  await saveProject(page);
  const savedSource = await exported<Artifact<StructuredData>>(page, '正本のnative JSON');
  const savedArtwork = await exported<Artifact<DesignContent>>(page, '設定画のnative JSON');
  expect(savedSource.id).toBe(source.id);
  expect(savedArtwork.id).toBe(artwork.id);
  expect(savedSource.versions).toEqual(source.versions);
  expect(savedArtwork.versions).toEqual(artwork.versions);
  expect(savedArtwork.draft.baseVersionId).toBe(artwork.draft.baseVersionId);
});

let concurrentHost: Promise<{ js: string; css: string }>;
async function openConcurrentHost(page: Page) {
  concurrentHost ??= build({
    entryPoints: ['tests/fixtures/creative-host/concurrent-source.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/creative-concurrent-source-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((result) => ({
    js: result.outputFiles!.find((file) => file.path.endsWith('.js'))!.text,
    css: result.outputFiles!.find((file) => file.path.endsWith('.css'))?.text ?? '',
  }));
  const files = await concurrentHost;
  await page.route('**/creative-concurrent-source.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await page.route('**/creative-concurrent-source.css', (route) =>
    route.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await page.route('**/creative-concurrent-source-host', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/creative-concurrent-source.css"><div id="root"></div><script type="module" src="/creative-concurrent-source.js"></script>',
    }),
  );
  await page.goto('/creative-concurrent-source-host');
  await expect(page.getByRole('heading', { name: 'キャラクター設計', exact: true })).toBeVisible();
}

const concurrentSnapshot = (page: Page) =>
  page.evaluate(() => window.creativeConcurrency!.snapshot()) as Promise<
    ReturnType<CreativeConcurrencyFixture['snapshot']>
  >;

test('Character Mode isolates candidate parts, shares vector eye edits, and reloads source and chosen candidate', async ({
  page,
}, info) => {
  await openCharacter(page);
  const before = await design(page);
  await selectPart(page, '前髪');
  const movedX = sharedPart(before, 'hair-front').bounds.x + 12;
  await commit(page, 'X', String(movedX));
  const moved = await design(page);
  expect(instance(moved, 1).overrides?.['hair-front']?.bounds?.x).toBe(movedX);
  expect(moved.components).toEqual(before.components);
  expect(instance(moved, 2)).toEqual(instance(before, 2));
  expect(instance(moved, 3)).toEqual(instance(before, 3));
  await history(page, '元に戻す');
  expect(await design(page)).toEqual(before);
  await history(page, 'やり直す');
  expect(await design(page)).toEqual(moved);

  await selectPart(page, '目', 'shared');
  await commit(page, '塗り', '#367895');
  const shared = await design(page);
  expect(sharedPart(shared, 'eyes').fill).toBe('#367895');
  expect(shared.elements).toEqual(moved.elements);
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  await expect(canvas.locator('path[fill="#367895"]')).toHaveCount(6);
  const comparisons = page.locator('.creative-candidate-preview img');
  for (let index = 0; index < 3; index++)
    expect(decodeURIComponent((await comparisons.nth(index).getAttribute('src'))!)).toContain(
      '#367895',
    );

  const chosen = page.locator('.creative-candidates article').nth(1);
  await chosen.getByRole('button', { name: 'この候補を選ぶ', exact: true }).click();
  await page.locator('.creative-notes').getByLabel('名前', { exact: true }).fill('澪');
  await page.locator('.creative-notes').getByLabel('名前', { exact: true }).press('Enter');
  await expect(page.locator('.creative-item-heading h2')).toHaveText('澪');
  await page.getByRole('button', { name: '人物表を開く', exact: true }).click();
  await expect(page.getByRole('gridcell', { name: '名前 · record 1', exact: true })).toContainText(
    '澪',
  );
  const source = await exported<Artifact<StructuredData>>(page, '正本のnative JSON');
  expect(source.draft.content.rows[0].values['character-name']).toBe('澪');
  await page.getByRole('button', { name: '設定とビジュアル', exact: true }).click();
  await saveProject(page);
  await page.reload();
  await expect(page.locator('.creative-item-heading h2')).toHaveText('澪');
  await expect(
    page
      .locator('.creative-candidates article')
      .nth(1)
      .getByRole('button', { name: '保存する候補・選択中', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(await design(page)).toEqual(shared);
  const mapping = await exported<{ bindings: { chosenFrameId: string }[] }>(
    page,
    '候補と参照の対応表',
  );
  expect(mapping.bindings[0].chosenFrameId).toBe('candidate-2');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `/tmp/creative-character-${info.project.name}-native.png`,
    fullPage: true,
  });
});

test('Character Mode reviews native previews, rejects extra scope and stale proposals without applying them', async ({
  page,
}, info) => {
  await openCharacter(page);
  const before = await design(page);
  let panel = await selectPart(page, '目');
  await panel.getByLabel('部位の操作', { exact: true }).selectOption('proposal');
  await commit(page, '塗り', '#a75663');
  await panel.getByRole('button', { name: '変更案をプレビュー', exact: true }).click();
  await expect(panel.getByRole('img', { name: /^変更後の候補/ })).toBeVisible();
  expect(await design(page)).toEqual(before);
  panel = await inspector(page);
  await panel.getByRole('button', { name: '変更案を却下', exact: true }).click();
  expect(await design(page)).toEqual(before);

  panel = await inspector(page);
  await commit(page, '塗り', '#a75663');
  await panel.getByRole('button', { name: '変更案をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: '変更案を適用', exact: true }).click();
  const applied = await design(page);
  expect(instance(applied, 1).overrides?.eyes?.fill).toBe('#a75663');
  expect(applied.components).toEqual(before.components);
  expect(instance(applied, 2)).toEqual(instance(before, 2));
  expect(instance(applied, 3)).toEqual(instance(before, 3));

  panel = await inspector(page);
  await panel.locator('summary').filter({ hasText: 'AI・外部ツールの変更案' }).click();
  await panel.getByRole('button', { name: 'JSON入力例を入れる', exact: true }).click();
  const external = panel.getByLabel('外部変更案JSON', { exact: true });
  const outside = JSON.parse(await external.inputValue());
  outside.changes[0].address.elementId = 'mouth';
  await external.fill(JSON.stringify(outside));
  await panel.getByRole('button', { name: '外部変更案をプレビュー', exact: true }).click();
  await expect(page.locator('.creative-error[role="alert"]')).toContainText(/required part|scope/i);
  expect(await design(page)).toEqual(applied);
  await page
    .locator('.creative-error')
    .getByRole('button', { name: '閉じる', exact: true })
    .click();

  panel = await inspector(page);
  await panel.getByRole('button', { name: 'JSON入力例を入れる', exact: true }).click();
  const oldRevision = await panel.getByLabel('外部変更案JSON', { exact: true }).inputValue();
  await panel.getByLabel('部位の操作', { exact: true }).selectOption('direct');
  await commit(page, '塗り', '#6688aa');
  const changed = await design(page);
  panel = await inspector(page);
  await panel.getByLabel('外部変更案JSON', { exact: true }).fill(oldRevision);
  await panel.getByRole('button', { name: '外部変更案をプレビュー', exact: true }).click();
  await expect(page.locator('.creative-error[role="alert"]')).toContainText(/draft changed/i);
  expect(await design(page)).toEqual(changed);
  await page
    .locator('.creative-error')
    .getByRole('button', { name: '閉じる', exact: true })
    .click();

  panel = await inspector(page);
  await panel.getByLabel('部位の操作', { exact: true }).selectOption('proposal');
  await commit(page, '塗り', '#bb7744');
  await panel.getByRole('button', { name: '変更案をプレビュー', exact: true }).click();
  await panel.getByLabel('部位の操作', { exact: true }).selectOption('direct');
  await commit(page, '不透明度', '0.7');
  await expect(panel.getByRole('button', { name: '変更案を適用', exact: true })).toBeDisabled();
  await expect(panel.getByRole('status')).toContainText('古い変更案');
  await panel.getByRole('button', { name: '変更案を適用', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/creative-character-${info.project.name}-stale.png`,
    fullPage: true,
  });
  await panel.getByRole('button', { name: '変更案を却下', exact: true }).click();
  await closePanels(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Character Mode replaces a candidate jacket with source and license in one native Undo/Redo', async ({
  page,
}, info) => {
  await openCharacter(page);
  const before = await design(page);
  const panel = await selectPart(page, '上着');
  await panel
    .getByLabel('差替画像', { exact: true })
    .setInputFiles({ name: 'replacement-jacket.png', mimeType: 'image/png', buffer: tinyPng });
  await expect(panel.getByRole('img', { name: '差替画像の確認', exact: true })).toBeVisible();
  await panel.getByLabel('新画像の出典', { exact: true }).fill('作者の衣装ラフ');
  await panel.getByLabel('新画像の利用条件', { exact: true }).fill('作者の許可により使用');
  await panel.getByRole('button', { name: '画像と出典を差し替える', exact: true }).click();
  const replaced = await design(page);
  const jacket = instance(replaced, 1).overrides?.outerwear;
  expect(jacket?.src).toMatch(/^data:image\/png;base64,/);
  expect(jacket?.provenance).toEqual({
    src: jacket!.src,
    source: '作者の衣装ラフ',
    license: '作者の許可により使用',
    name: 'replacement-jacket.png',
  });
  expect(replaced.components).toEqual(before.components);
  expect(instance(replaced, 2)).toEqual(instance(before, 2));
  expect(instance(replaced, 3)).toEqual(instance(before, 3));
  await history(page, '元に戻す');
  expect(await design(page)).toEqual(before);
  await history(page, 'やり直す');
  expect(await design(page)).toEqual(replaced);
  await saveProject(page);
  await page.reload();
  await expect(page.getByRole('application', { name: 'Design canvas', exact: true })).toBeVisible();
  expect(await design(page)).toEqual(replaced);
  await selectPart(page, '上着');
  const provenance = (await inspector(page)).getByText('現在の出典：作者の衣装ラフ');
  await expect(provenance).toBeVisible();
  await provenance.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/creative-character-${info.project.name}-image.png`,
    fullPage: true,
  });
  await closePanels(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Character Mode creates a person from name and description and preserves native sources in the viewer', async ({
  page,
}, info) => {
  await page.goto('/creative-design.html');
  await expect(page.getByRole('heading', { name: 'キャラクター設計', exact: true })).toBeVisible();
  const initial = await exported<Artifact<StructuredData>>(page, '正本のnative JSON');
  await page.getByText('人物を追加', { exact: true }).click();
  const form = page.locator('.creative-cards form');
  await expect(form.getByRole('textbox')).toHaveCount(2);
  await form.getByLabel('名前', { exact: true }).fill('旅人');
  await form.getByLabel('短い説明', { exact: true }).fill('港の広場で美緒に道を尋ねる旅人。');
  await form.getByRole('button', { name: '追加する', exact: true }).click();
  await expect(page.locator('.creative-item-heading h2')).toHaveText('旅人');
  await expect(
    page.locator('.creative-cards nav').getByRole('button', { name: /CH-03 旅人/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  const added = await exported<Artifact<StructuredData>>(page, '正本のnative JSON');
  expect(added.id).toBe(initial.id);
  expect(added.draft.content.rows).toHaveLength(initial.draft.content.rows.length + 1);
  expect(added.draft.content.rows.slice(0, 2)).toEqual(initial.draft.content.rows);
  const rows = added.draft.content.rows.filter((row) => row.values['character-id'] === 'CH-03');
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.values).toMatchObject({
    'character-name': '旅人',
    'character-description': '港の広場で美緒に道を尋ねる旅人。',
  });
  expect(initial.draft.content.rows.some((existing) => existing.id === row.id)).toBe(false);
  expect(Object.keys(added.draft.content).sort()).toEqual(['columns', 'rows', 'schemaVersion']);
  await page.getByRole('button', { name: '設定画を作る', exact: true }).click();
  await expect(page.locator('.creative-candidates article')).toHaveCount(3);
  await saveProject(page);
  const source = await exported<Artifact<StructuredData>>(page, '正本のnative JSON');
  const artwork = await exported<Artifact<DesignContent>>(page, '設定画のnative JSON');
  const references = await exported<{ bindings: { itemId: string; sourceElementId: string }[] }>(
    page,
    '候補と参照の対応表',
  );
  expect(references.bindings.find((binding) => binding.itemId === 'CH-03')?.sourceElementId).toBe(
    row.id,
  );

  await page.goto('/creative-design.html?access=viewer');
  await expect(page.locator('.creative-actions [role="status"]')).toContainText('閲覧のみ');
  await page
    .locator('.creative-cards nav')
    .getByRole('button', { name: /CH-03 旅人/ })
    .click();
  await expect(page.locator('.creative-item-heading h2')).toHaveText('旅人');
  await expect(
    page.getByRole('button', { name: '設定と設定画を保存', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: '元に戻す', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'やり直す', exact: true })).toBeDisabled();
  await expect(page.locator('.creative-notes').getByLabel('名前', { exact: true })).toBeDisabled();
  await page.getByText('人物を追加', { exact: true }).click();
  await expect(form.getByLabel('名前', { exact: true })).toBeDisabled();
  await expect(form.getByLabel('短い説明', { exact: true })).toBeDisabled();
  await expect(form.getByRole('button', { name: '追加する', exact: true })).toBeDisabled();
  const panel = await selectPart(page, '目');
  await expect(panel.getByLabel('X', { exact: true })).toBeDisabled();
  await expect(panel.getByLabel('塗り', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '候補を複製', exact: true })).toBeDisabled();
  await panel.getByLabel('塗り', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/creative-character-${info.project.name}-viewer.png`,
    fullPage: true,
  });
  const viewedSource = await exported<Artifact<StructuredData>>(page, '正本のnative JSON');
  const viewedArtwork = await exported<Artifact<DesignContent>>(page, '設定画のnative JSON');
  expect(viewedSource.id).toBe(source.id);
  expect(viewedSource.draft.content).toEqual(source.draft.content);
  expect(viewedSource.versions).toEqual(source.versions);
  expect(viewedArtwork.id).toBe(artwork.id);
  expect(viewedArtwork.draft.content).toEqual(artwork.draft.content);
  expect(viewedArtwork.versions).toEqual(artwork.versions);
  expect(await exported(page, '候補と参照の対応表')).toEqual(references);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Character Mode gives pending notes dirty status and routes header history to the last edited native source', async ({
  page,
}, info) => {
  await openCharacter(page);
  const originalDesign = await design(page);
  const originalSource = await exported<Artifact<StructuredData>>(page, '正本のnative JSON');
  await selectPart(page, '目');
  await commit(page, '塗り', '#8471a5');
  const changedDesign = await design(page);
  await saveProject(page);
  const name = page.locator('.creative-notes').getByLabel('名前', { exact: true });
  await name.fill('メモから変更した名前');
  // A saved notice must yield to an uncommitted private input buffer.
  await expect(page.locator('.creative-actions [role="status"]')).toHaveText('未保存の変更');
  await expect(page.getByLabel('履歴の対象', { exact: true })).toContainText('人物表');
  await expect(page.locator('.creative-item-heading h2')).toHaveText('美緒');
  await expect(name).toHaveValue('メモから変更した名前');
  await page.screenshot({
    path: `/tmp/creative-character-${info.project.name}-notes-dirty.png`,
    fullPage: true,
  });
  await name.press('Enter');
  await expect(page.locator('.creative-item-heading h2')).toHaveText('メモから変更した名前');
  expect(await design(page)).toEqual(changedDesign);
  await history(page, '元に戻す');
  const undoneSource = await exported<Artifact<StructuredData>>(page, '正本のnative JSON');
  expect(undoneSource.draft.content).toEqual(originalSource.draft.content);
  expect(await design(page)).toEqual(changedDesign);
  await history(page, 'やり直す');
  const redoneSource = await exported<Artifact<StructuredData>>(page, '正本のnative JSON');
  expect(redoneSource.draft.content.rows[0].values['character-name']).toBe('メモから変更した名前');
  expect(await design(page)).toEqual(changedDesign);

  // Return history ownership through the actual part field without making a new edit.
  const panel = await selectPart(page, '目');
  await panel.getByLabel('塗り', { exact: true }).focus();
  await expect(page.getByLabel('履歴の対象', { exact: true })).toContainText('設定画');
  await history(page, '元に戻す');
  expect(await design(page)).toEqual(originalDesign);
  expect(
    (await exported<Artifact<StructuredData>>(page, '正本のnative JSON')).draft.content,
  ).toEqual(redoneSource.draft.content);
  await history(page, 'やり直す');
  expect(await design(page)).toEqual(changedDesign);
  expect(
    (await exported<Artifact<StructuredData>>(page, '正本のnative JSON')).draft.content,
  ).toEqual(redoneSource.draft.content);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({
    path: `/tmp/creative-character-${info.project.name}-history-owner.png`,
    fullPage: true,
  });
});

test('Character Host refuses a stale notes buffer after its source API changes the same field', async ({
  page,
}, info) => {
  await openConcurrentHost(page);
  const baseline = await concurrentSnapshot(page);
  const name = page.locator('.creative-notes').getByLabel('名前', { exact: true });
  await name.fill('保持する未確定の入力');
  await page.evaluate(() => window.creativeConcurrency!.changeSourceName('外部Hostから届いた名前'));
  await expect(page.locator('.creative-item-heading h2')).toHaveText('外部Hostから届いた名前');
  await expect(name).toHaveValue('保持する未確定の入力');
  const arrived = await concurrentSnapshot(page);
  expect(arrived.source.rows[0].values['character-name']).toBe('外部Hostから届いた名前');
  expect(arrived.artwork).toEqual(baseline.artwork);

  await page.locator('.creative-item-heading h2').click();
  await expect(page.locator('.creative-error[role="alert"]')).toContainText(
    /変更|競合|再読込|changed|conflict/i,
  );
  await expect(name).toHaveValue('保持する未確定の入力');
  const afterBlur = await concurrentSnapshot(page);
  expect(afterBlur.source).toEqual(arrived.source);
  expect(afterBlur.sourceRevision).toEqual(arrived.sourceRevision);
  await page.getByRole('button', { name: '設定と設定画を保存', exact: true }).click();
  await expect(page.locator('.creative-error[role="alert"]')).toContainText(
    /変更|競合|再読込|changed|conflict/i,
  );
  await expect(name).toHaveValue('保持する未確定の入力');
  const afterSave = await concurrentSnapshot(page);
  expect(afterSave.source).toEqual(arrived.source);
  expect(afterSave.sourceRevision).toEqual(arrived.sourceRevision);
  expect(afterSave.sourceVersionId).toBe(baseline.sourceVersionId);
  expect(afterSave.sourceVersions).toBe(baseline.sourceVersions);
  expect(afterSave.artwork).toEqual(baseline.artwork);
  await expect(page.locator('.creative-actions [role="status"]')).toHaveText('未保存の変更');
  await page.screenshot({
    path: `/tmp/creative-character-${info.project.name}-source-conflict.png`,
    fullPage: true,
  });
});
