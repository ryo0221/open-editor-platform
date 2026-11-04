import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { Artifact } from '@editor-platform/artifact-core';
import { designInstanceElements, type DesignContent } from '@editor-platform/design/model';
import type { DocumentContent } from '@editor-platform/document/model';
import { test, expect, tinyPng } from './fixtures';

test.setTimeout(90_000);

async function closePanels(page: Page) {
  for (const name of [
    'Close 場所の部位',
    'Close 部位の編集',
    'Close Document outline',
    'Close Document inspector',
  ]) {
    const close = page.getByRole('button', { name, exact: true });
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
  await page.getByRole('button', { name: 'Toggle 場所の部位', exact: true }).click();
  const left = page.getByRole('complementary', { name: '場所の部位', exact: true });
  await left.getByLabel('変更の範囲', { exact: true }).selectOption(scope);
  await left.getByRole('button', { name, exact: true }).click();
  await left.getByRole('button', { name: 'Close 場所の部位', exact: true }).click();
  return inspector(page);
}

async function openSetting(page: Page) {
  await page.goto('/setting-design.html');
  await expect(page.getByRole('heading', { name: '舞台設計', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '設定画を作る', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Design canvas', exact: true })).toBeVisible();
  await expect(page.locator('.creative-candidates article')).toHaveCount(4);
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
  content.components.find((c) => c.id === 'component-setting')!.elements!.find((e) => e.id === id)!;
const projectedPart = (content: DesignContent, n: number, id: string) =>
  designInstanceElements(content, instance(content, n)).find((e) => e.id === id)!;

async function commit(page: Page, label: string, value: string) {
  const input = (await inspector(page)).getByLabel(label, { exact: true });
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

test('Setting Mode edits only roof geometry/state and distinguishes candidate window overrides from shared parts', async ({
  page,
}, info) => {
  await openSetting(page);
  const before = await design(page);
  const roof = sharedPart(before, 'roof');
  await selectPart(page, '屋根');
  for (const [label, value] of [
    ['X', roof.bounds.x + 9],
    ['Y', roof.bounds.y + 5],
    ['幅', roof.bounds.width + 20],
    ['高さ', roof.bounds.height + 12],
    ['回転', 12],
    ['不透明度', 0.6],
  ] as const)
    await commit(page, label, String(value));
  const transformed = await design(page);
  expect(instance(transformed, 1).overrides?.roof).toEqual({
    bounds: {
      x: roof.bounds.x + 9,
      y: roof.bounds.y + 5,
      width: roof.bounds.width + 20,
      height: roof.bounds.height + 12,
    },
    rotation: 12,
    opacity: 0.6,
  });
  expect(transformed.components).toEqual(before.components);
  for (const n of [2, 3, 4]) expect(instance(transformed, n)).toEqual(instance(before, n));
  expect(Object.keys(instance(transformed, 1).overrides!)).toEqual(['roof']);

  let panel = await inspector(page);
  await panel.getByRole('checkbox', { name: '非表示', exact: true }).check();
  const hidden = await design(page);
  expect(instance(hidden, 1).overrides?.roof?.hidden).toBe(true);
  panel = await inspector(page);
  await panel.getByRole('checkbox', { name: '非表示', exact: true }).uncheck();
  await panel.getByRole('checkbox', { name: 'ロック', exact: true }).check();
  const locked = await design(page);
  expect(instance(locked, 1).overrides?.roof?.locked).toBe(true);
  await commit(page, 'X', String(roof.bounds.x + 40));
  await expect(page.locator('.creative-error[role="alert"]')).toContainText(/unlock|locked/i);
  await (await inspector(page)).getByLabel('X', { exact: true }).press('Escape');
  expect(await design(page)).toEqual(locked);
  panel = await inspector(page);
  await panel.getByRole('checkbox', { name: 'ロック', exact: true }).uncheck();
  const unlocked = await design(page);
  await history(page, '元に戻す');
  expect(await design(page)).toEqual(locked);
  await history(page, 'やり直す');
  expect(await design(page)).toEqual(unlocked);

  await selectPart(page, '窓');
  await commit(page, '塗り', '#538d99');
  const local = await design(page);
  expect(instance(local, 1).overrides?.windows?.fill).toBe('#538d99');
  expect(local.components).toEqual(before.components);
  for (const n of [2, 3, 4]) expect(instance(local, n)).toEqual(instance(before, n));
  await selectPart(page, '窓', 'shared');
  await commit(page, '塗り', '#74a988');
  await commit(page, '不透明度', '0.75');
  const shared = await design(page);
  expect(shared.elements).toEqual(local.elements);
  expect(sharedPart(shared, 'windows')).toMatchObject({ fill: '#74a988', opacity: 0.75 });
  expect(shared.components[0].elements!.filter((e) => e.id !== 'windows')).toEqual(
    before.components[0].elements!.filter((e) => e.id !== 'windows'),
  );
  for (const n of [1, 2, 3, 4]) expect(projectedPart(shared, n, 'windows').opacity).toBe(0.75);
  expect(projectedPart(shared, 1, 'windows').fill).toBe('#538d99');
  expect(projectedPart(shared, 2, 'windows').fill).toBe('#ffe0a0');
  expect(projectedPart(shared, 3, 'windows').hidden).toBe(true);
  expect(projectedPart(shared, 4, 'windows').fill).toBe('#74a988');
  await expect(
    page
      .getByRole('application', { name: 'Design canvas', exact: true })
      .locator('path[fill="#74a988"]'),
  ).toHaveCount(8);
  await page.screenshot({
    path: `/tmp/creative-setting-${info.project.name}-native.png`,
    fullPage: true,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Setting Mode replaces only distant scenery with source/license and restores the chosen night candidate', async ({
  page,
}, info) => {
  await openSetting(page);
  const before = await design(page);
  const panel = await selectPart(page, '遠景');
  await panel
    .getByLabel('差替画像', { exact: true })
    .setInputFiles({ name: 'harbor-background.png', mimeType: 'image/png', buffer: tinyPng });
  await expect(panel.getByRole('img', { name: '差替画像の確認', exact: true })).toBeVisible();
  await panel.getByLabel('新画像の出典', { exact: true }).fill('作者が描いた港の遠景');
  await panel.getByLabel('新画像の利用条件', { exact: true }).fill('作者の許可により使用');
  await panel.getByRole('button', { name: '画像と出典を差し替える', exact: true }).click();
  const replaced = await design(page);
  const scenery = instance(replaced, 1).overrides?.background;
  expect(scenery?.src).toMatch(/^data:image\/png;base64,/);
  expect(scenery?.provenance).toEqual({
    src: scenery!.src,
    source: '作者が描いた港の遠景',
    license: '作者の許可により使用',
    name: 'harbor-background.png',
  });
  expect(replaced.components).toEqual(before.components);
  for (const n of [2, 3, 4]) expect(instance(replaced, n)).toEqual(instance(before, n));
  await history(page, '元に戻す');
  expect(await design(page)).toEqual(before);
  await history(page, 'やり直す');
  expect(await design(page)).toEqual(replaced);
  await page
    .locator('.creative-candidates article')
    .nth(1)
    .getByRole('button', { name: 'この候補を選ぶ', exact: true })
    .click();
  await saveProject(page);
  await page.reload();
  await expect(
    page
      .locator('.creative-candidates article')
      .nth(1)
      .getByRole('button', { name: '保存する候補・選択中', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(await design(page)).toEqual(replaced);
  const mapping = await exported<{ bindings: { chosenFrameId: string }[] }>(
    page,
    '候補と参照の対応表',
  );
  expect(mapping.bindings[0].chosenFrameId).toBe('candidate-2');
  await page.locator('.creative-candidate-preview').nth(0).click();
  const provenance = (await selectPart(page, '遠景')).getByText('現在の出典：作者が描いた港の遠景');
  await expect(provenance).toBeVisible();
  await provenance.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/creative-setting-${info.project.name}-image.png`,
    fullPage: true,
  });
  await closePanels(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Setting Mode previews/rejects/applies roof proposals and refuses outside, stale and locked edits', async ({
  page,
}, info) => {
  await openSetting(page);
  const before = await design(page);
  let panel = await selectPart(page, '屋根');
  await panel.getByLabel('部位の操作', { exact: true }).selectOption('proposal');
  await commit(page, '塗り', '#637f8e');
  await panel.getByRole('button', { name: '変更案をプレビュー', exact: true }).click();
  await expect(panel.getByRole('img', { name: /^変更後の候補/ })).toBeVisible();
  expect(await design(page)).toEqual(before);
  panel = await inspector(page);
  await panel.getByRole('button', { name: '変更案を却下', exact: true }).click();
  expect(await design(page)).toEqual(before);
  await commit(page, '塗り', '#637f8e');
  panel = await inspector(page);
  await panel.getByRole('button', { name: '変更案をプレビュー', exact: true }).click();
  await panel.getByRole('button', { name: '変更案を適用', exact: true }).click();
  const applied = await design(page);
  expect(instance(applied, 1).overrides?.roof?.fill).toBe('#637f8e');
  expect(applied.components).toEqual(before.components);
  for (const n of [2, 3, 4]) expect(instance(applied, n)).toEqual(instance(before, n));
  panel = await inspector(page);
  await panel.locator('summary').filter({ hasText: 'AI・外部ツールの変更案' }).click();
  await panel.getByRole('button', { name: 'JSON入力例を入れる', exact: true }).click();
  const external = panel.getByLabel('外部変更案JSON', { exact: true });
  const outside = JSON.parse(await external.inputValue());
  outside.changes[0].address.elementId = 'windows';
  await external.fill(JSON.stringify(outside));
  await panel.getByRole('button', { name: '外部変更案をプレビュー', exact: true }).click();
  await expect(page.locator('.creative-error[role="alert"]')).toContainText(/required part|scope/i);
  expect(await design(page)).toEqual(applied);
  panel = await inspector(page);
  await panel.getByRole('button', { name: 'JSON入力例を入れる', exact: true }).click();
  const old = await external.inputValue();
  await panel.getByLabel('部位の操作', { exact: true }).selectOption('direct');
  await commit(page, '回転', '8');
  const changed = await design(page);
  panel = await inspector(page);
  await external.fill(old);
  await panel.getByRole('button', { name: '外部変更案をプレビュー', exact: true }).click();
  await expect(page.locator('.creative-error[role="alert"]')).toContainText(/draft changed/i);
  expect(await design(page)).toEqual(changed);
  panel = await inspector(page);
  await panel.getByRole('checkbox', { name: 'ロック', exact: true }).check();
  const locked = await design(page);
  panel = await inspector(page);
  await panel.getByRole('button', { name: 'JSON入力例を入れる', exact: true }).click();
  await panel.getByRole('button', { name: '外部変更案をプレビュー', exact: true }).click();
  await expect(page.locator('.creative-error[role="alert"]')).toContainText(/unlock|locked/i);
  expect(await design(page)).toEqual(locked);
  panel = await inspector(page);
  await panel.getByRole('checkbox', { name: 'ロック', exact: true }).uncheck();
  await panel.getByLabel('部位の操作', { exact: true }).selectOption('proposal');
  await commit(page, '塗り', '#bb7755');
  await panel.getByRole('button', { name: '変更案をプレビュー', exact: true }).click();
  await panel.getByLabel('部位の操作', { exact: true }).selectOption('direct');
  await commit(page, '不透明度', '0.7');
  await expect(panel.getByRole('button', { name: '変更案を適用', exact: true })).toBeDisabled();
  await expect(panel.getByRole('status')).toContainText('古い変更案');
  await panel.getByRole('button', { name: '変更案を適用', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/creative-setting-${info.project.name}-stale.png`,
    fullPage: true,
  });
  await panel.getByRole('button', { name: '変更案を却下', exact: true }).click();
  await closePanels(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Setting Mode keeps Document IDs/focus while editing source notes, adds a location and opens its readonly view', async ({
  page,
}, info) => {
  await openSetting(page);
  const original = await exported<Artifact<DocumentContent>>(page, '正本のnative JSON');
  const ids = original.draft.content.blocks.map((block) => block.id);
  const heading = original.draft.content.blocks.find((block) => block.text.startsWith('LO-01'))!;
  const description = original.draft.content.blocks.find(
    (block) => block.type === 'paragraph' && block.text.includes('丘の上'),
  )!;
  const notes = page.locator('.creative-notes');
  const placeName = notes.getByLabel('場所名', { exact: true });
  await placeName.fill('  港を望む家  ');
  expect(await placeName.evaluate((node) => node === document.activeElement)).toBe(true);
  await placeName.press('ControlOrMeta+s');
  await expect(page.locator('.creative-actions [role="status"]')).toHaveText('保存しました');
  await expect(page.locator('.creative-item-heading h2')).toHaveText('港を望む家');
  // Re-enter the same field and save another normalized name without a blur-to-commit step.
  await placeName.fill('  港を望む家 別名  ');
  expect(await placeName.evaluate((node) => node === document.activeElement)).toBe(true);
  await placeName.press('ControlOrMeta+s');
  await expect(page.locator('.creative-actions [role="status"]')).toHaveText('保存しました');
  await expect(page.locator('.creative-item-heading h2')).toHaveText('港を望む家 別名');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const normalized = await exported<Artifact<DocumentContent>>(page, '正本のnative JSON');
  const retainedNames = normalized.versions.map(
    (version) => version.content.blocks.find((block) => block.id === heading.id)?.text,
  );
  expect(retainedNames).toContain('LO-01 港を望む家');
  expect(retainedNames.at(-1)).toBe('LO-01 港を望む家 別名');
  expect(normalized.draft.content.blocks.map((block) => block.id)).toEqual(ids);
  await notes.getByLabel('説明', { exact: true }).fill('港を望む石造りの家。');
  await notes.getByLabel('説明', { exact: true }).press('Enter');
  await expect(page.locator('.creative-item-heading h2')).toHaveText('港を望む家 別名');
  const edited = await exported<Artifact<DocumentContent>>(page, '正本のnative JSON');
  expect(edited.draft.content.blocks.map((block) => block.id)).toEqual(ids);
  expect(edited.draft.content.blocks.find((block) => block.id === heading.id)?.text).toBe(
    'LO-01 港を望む家 別名',
  );
  expect(edited.draft.content.blocks.find((block) => block.id === description.id)?.text).toBe(
    '港を望む石造りの家。',
  );
  await page.getByRole('button', { name: '世界の覚え書きを開く', exact: true }).click();
  await closePanels(page);
  const paragraph = page.locator(`.ProseMirror p[data-block-id="${description.id}"]`);
  await paragraph.click();
  await page.keyboard.press('End');
  await page.keyboard.type('abcdef', { delay: 25 });
  await expect(paragraph).toHaveText('港を望む石造りの家。abcdef');
  expect(
    await paragraph.evaluate((node) => node.contains(window.getSelection()?.anchorNode ?? null)),
  ).toBe(true);
  await page.keyboard.type('ghijkl', { delay: 25 });
  await expect(paragraph).toHaveText('港を望む石造りの家。abcdefghijkl');
  expect(
    await paragraph.evaluate((node) => node.closest('.ProseMirror') === document.activeElement),
  ).toBe(true);
  const typed = await exported<Artifact<DocumentContent>>(page, '正本のnative JSON');
  expect(typed.draft.content.blocks.map((block) => block.id)).toEqual(ids);
  await page.getByRole('button', { name: '設定とビジュアル', exact: true }).click();
  await expect(notes.getByLabel('説明', { exact: true })).toHaveValue(
    '港を望む石造りの家。abcdefghijkl',
  );
  await page.getByText('場所を追加', { exact: true }).click();
  const form = page.locator('.creative-cards form');
  await expect(form.getByRole('textbox')).toHaveCount(2);
  await form.getByLabel('名前', { exact: true }).fill('港の書庫');
  await form.getByLabel('短い説明', { exact: true }).fill('古い航路の記録が残る書庫。');
  await form.getByRole('button', { name: '追加する', exact: true }).click();
  await expect(page.locator('.creative-item-heading h2')).toHaveText('港の書庫');
  await expect(
    page.locator('.creative-cards nav').getByRole('button', { name: /LO-02 港の書庫/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  const added = await exported<Artifact<DocumentContent>>(page, '正本のnative JSON');
  expect(added.id).toBe(original.id);
  expect(added.draft.content.blocks.slice(0, typed.draft.content.blocks.length)).toEqual(
    typed.draft.content.blocks,
  );
  expect(new Set(added.draft.content.blocks.map((block) => block.id)).size).toBe(
    added.draft.content.blocks.length,
  );
  expect(added.draft.content.blocks.find((block) => block.text === 'LO-02 港の書庫')).toBeDefined();
  await page.getByRole('button', { name: '設定画を作る', exact: true }).click();
  await expect(page.locator('.creative-candidates article')).toHaveCount(4);
  await saveProject(page);
  const source = await exported<Artifact<DocumentContent>>(page, '正本のnative JSON');
  const artwork = await exported<Artifact<DesignContent>>(page, '設定画のnative JSON');
  const mapping = await exported(page, '候補と参照の対応表');
  await page.goto('/setting-design.html?access=viewer');
  await expect(page.locator('.creative-actions [role="status"]')).toContainText('閲覧のみ');
  await page
    .locator('.creative-cards nav')
    .getByRole('button', { name: /LO-02 港の書庫/ })
    .click();
  await expect(
    page.getByRole('button', { name: '設定と設定画を保存', exact: true }),
  ).toBeDisabled();
  await expect(notes.getByLabel('場所名', { exact: true })).toBeDisabled();
  await expect(notes.getByLabel('説明', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '候補を複製', exact: true })).toBeDisabled();
  const panel = await selectPart(page, '屋根');
  await expect(panel.getByLabel('X', { exact: true })).toBeDisabled();
  await expect(panel.getByLabel('塗り', { exact: true })).toBeDisabled();
  await page.screenshot({
    path: `/tmp/creative-setting-${info.project.name}-viewer.png`,
    fullPage: true,
  });
  const viewedSource = await exported<Artifact<DocumentContent>>(page, '正本のnative JSON');
  const viewedArtwork = await exported<Artifact<DesignContent>>(page, '設定画のnative JSON');
  expect(viewedSource.draft.content).toEqual(source.draft.content);
  expect(viewedSource.versions).toEqual(source.versions);
  expect(viewedArtwork.draft.content).toEqual(artwork.draft.content);
  expect(viewedArtwork.versions).toEqual(artwork.versions);
  expect(await exported(page, '候補と参照の対応表')).toEqual(mapping);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Setting Mode preserves mixed bold and linked source text and offers only a readonly description card', async ({
  page,
}, info) => {
  await openSetting(page);
  const original = await exported<Artifact<DocumentContent>>(page, '正本のnative JSON');
  const originalDesign = await design(page);
  const description = original.draft.content.blocks.find(
    (block) => block.type === 'paragraph' && block.text.includes('丘の上'),
  )!;
  await page.getByRole('button', { name: '世界の覚え書きを開く', exact: true }).click();
  await closePanels(page);
  const paragraph = page.locator(`.ProseMirror p[data-block-id="${description.id}"]`);
  await expect(paragraph).toBeVisible();
  await paragraph.evaluate((node) => {
    (node.closest('.ProseMirror') as HTMLElement).focus();
    const range = document.createRange();
    range.setStart(node.firstChild!, 0);
    range.setEnd(node.firstChild!, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    description.text.slice(0, 4),
  );
  await page.keyboard.press('ControlOrMeta+b');
  await expect(paragraph.locator('strong')).toHaveText(description.text.slice(0, 4));
  const formatting = page.getByRole('button', { name: 'More formatting', exact: true });
  if (!(await formatting.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await formatting.click();
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  const link = 'https://example.com/setting-source';
  await page.getByLabel('Link URL', { exact: true }).fill(link);
  await page.getByRole('button', { name: 'Apply link', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit link', exact: true })).toHaveCount(0);
  await expect(paragraph.getByRole('link')).toHaveAttribute('href', link);
  await paragraph.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/tmp/creative-setting-${info.project.name}-formatted-document.png`,
    fullPage: true,
  });
  const formatted = await exported<Artifact<DocumentContent>>(page, '正本のnative JSON');
  const rich = formatted.draft.content.blocks.find((block) => block.id === description.id)!;
  expect(rich.text).toBe(description.text);
  expect(rich.rich?.map((span) => span.text).join('')).toBe(description.text);
  expect(rich.rich?.some((span) => span.bold && span.link === link)).toBe(true);
  expect(rich.rich?.some((span) => !span.bold && !span.link && !!span.text)).toBe(true);
  expect(formatted.draft.content.blocks.map((block) => block.id)).toEqual(
    original.draft.content.blocks.map((block) => block.id),
  );
  expect(formatted.draft.content.blocks.filter((block) => block.id !== description.id)).toEqual(
    original.draft.content.blocks.filter((block) => block.id !== description.id),
  );

  await page.getByRole('button', { name: '設定とビジュアル', exact: true }).click();
  const notes = page.locator('.creative-notes');
  await expect(notes.getByRole('textbox', { name: '説明', exact: true })).toHaveCount(0);
  await expect(notes.locator('.creative-source-notes')).toContainText('説明');
  await expect(notes.locator('.creative-source-notes')).toContainText(description.text);
  expect(
    (await exported<Artifact<DocumentContent>>(page, '正本のnative JSON')).draft.content,
  ).toEqual(formatted.draft.content);
  expect(await design(page)).toEqual(originalDesign);
  await saveProject(page);
  await page.reload();
  await expect(page.locator('.creative-item-heading h2')).toHaveText('風見の家');
  await expect(notes.getByRole('textbox', { name: '説明', exact: true })).toHaveCount(0);
  await expect(notes.locator('.creative-source-notes')).toContainText(description.text);
  const reloaded = await exported<Artifact<DocumentContent>>(page, '正本のnative JSON');
  expect(reloaded.draft.content).toEqual(formatted.draft.content);
  expect(reloaded.versions[0].content).toEqual(original.versions[0].content);
  expect(await design(page)).toEqual(originalDesign);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({
    path: `/tmp/creative-setting-${info.project.name}-formatted-card.png`,
    fullPage: true,
  });
});
