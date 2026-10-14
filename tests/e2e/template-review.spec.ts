import {
  test,
  expect,
  create,
  addRecord,
  addField,
  editCell,
  nativeArtifact,
  save,
} from './fixtures';
import { artifactMenu, downloadText } from './template-fixtures';
import { saveAsTemplate, exportTemplatePack } from '@editor-platform/templates';
import {
  createData,
  cellValue,
  validateData,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import { designDrawings, type DesignContent } from '@editor-platform/design/model';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

async function author(page: Page, name: string, kind = 'whole') {
  await artifactMenu(page, 'テンプレートとして保存');
  const dialog = page.getByRole('dialog', { name: 'テンプレートとして保存', exact: true });
  await dialog.getByLabel('テンプレート名', { exact: true }).fill(name);
  await dialog.getByRole('combobox', { name: '保存範囲', exact: true }).selectOption(kind);
  await dialog.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function reuse(page: Page, name: string) {
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: 'テンプレートから作成', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'テンプレートから作成', exact: true });
  await gallery.getByRole('button', { name: `テンプレートを選択: ${name}`, exact: true }).click();
  await gallery.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await gallery.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(gallery).toHaveCount(0);
}
async function value(page: Page, label: string, text: string) {
  await page.getByLabel(label, { exact: true }).fill(text);
  await page.getByLabel(label, { exact: true }).press('Enter');
}
test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(12000);
  await page.goto('/');
  await mkdir('docs/screenshots/issue-4/review', { recursive: true });
  await mkdir('docs/exports/issue-4/review', { recursive: true });
});
test('R4-1: Data fragment mapping cannot silently retarget a formula to an existing same-named column', async ({
  page,
}) => {
  const source = createData();
  source.columns = [
    { id: 'amount', name: 'Amount', type: 'number', defaultValue: 3 },
    { id: 'total', name: 'Result', type: 'formula', formula: '[Amount] * 2' },
  ];
  source.rows = [{ id: 'row', values: { amount: 3 } }];
  const definition = await saveAsTemplate({
    domain: 'data',
    content: source,
    name: '数式付き部分テンプレート',
    purpose: 'Column identity review',
    category: 'test',
    kind: 'fragment',
    slots: [],
  });
  const pack = await exportTemplatePack([definition]);
  await create(page, 'data');
  await addField(page, 'Amount', 'number');
  await addRecord(page);
  await editCell(page, 'Amount', 1, '100');
  const before = (await nativeArtifact(page)).draft.content;
  await artifactMenu(page, '部分テンプレートを挿入');
  const dialog = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await dialog.getByLabel('テンプレートpackを読み込む', { exact: true }).setInputFiles({
    name: 'formula.template.json',
    mimeType: 'application/json',
    buffer: Buffer.from(pack),
  });
  await dialog
    .getByRole('button', { name: 'テンプレートを選択: 数式付き部分テンプレート', exact: true })
    .click();
  await dialog.getByLabel('New field name Amount', { exact: true }).fill('Inserted Amount');
  await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const after = (await nativeArtifact(page)).draft.content as StructuredData;
  const result = after.columns.find((c) => c.name === 'Result')!;
  expect(after.rows.map((r) => cellValue(after, r, result))).toEqual([6, 6]);
  await expect(page.getByRole('gridcell', { name: 'Result · record 2', exact: true })).toHaveText(
    '6',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(after);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(after);
  for (const panel of ['navigator', 'inspector']) {
    const toggle = page.getByRole('button', { name: `Toggle Data ${panel}`, exact: true });
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  }
  await page
    .getByRole('gridcell', { name: 'Result · record 2', exact: true })
    .scrollIntoViewIfNeeded();
  await writeFile(
    'docs/exports/issue-4/review/formula-data.json',
    JSON.stringify(await nativeArtifact(page), null, 2),
  );
  await page.screenshot({
    path: 'docs/screenshots/issue-4/review/formula-mapping.png',
    fullPage: true,
  });
});
test('R4-2: normal Data relation editing survives template save, creation and reload', async ({
  page,
}) => {
  await create(page, 'data');
  await addField(page, 'Link', 'relation');
  await addRecord(page);
  await addRecord(page);
  await editCell(page, 'Name', 1, 'Parent');
  await editCell(page, 'Name', 2, 'Child');
  const source = (await nativeArtifact(page)).draft.content as StructuredData;
  await editCell(page, 'Link', 2, source.rows[0].id, true);
  await author(page, '関連レコード付き台帳');
  await reuse(page, '関連レコード付き台帳');
  const record = await nativeArtifact(page),
    content = record.draft.content as StructuredData;
  expect(validateData(content)).toEqual([]);
  expect(content.rows[0].id).not.toBe(source.rows[0].id);
  expect(content.rows[1].values[content.columns.find((c) => c.name === 'Link')!.id]).toBe(
    content.rows[0].id,
  );
  await save(page, 1);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(content);
  await writeFile('docs/exports/issue-4/review/related-data.json', JSON.stringify(record, null, 2));
  await page.screenshot({
    path: 'docs/screenshots/issue-4/review/related-data.png',
    fullPage: true,
  });
});
test('R4-3/4: normally authored composite templates preserve overrides and translate rendered parts once', async ({
  page,
}) => {
  test.setTimeout(120000);
  await create(page, 'design');
  await page.getByRole('button', { name: 'Insert shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Insert rectangle', exact: true }).click();
  await page.keyboard.press('Escape');
  await value(page, 'Layer name', 'Card');
  await value(page, 'Element x', '60');
  await value(page, 'Element y', '60');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Layer name', 'Title');
  await value(page, 'Text', 'Reusable card');
  await value(page, 'Font size (px)', '18');
  await value(page, 'Element x', '80');
  await value(page, 'Element y', '85');
  await value(page, 'Element width', '180');
  await value(page, 'Element height', '80');
  await page.getByRole('button', { name: 'Layer Card', exact: true }).click();
  await page
    .getByRole('button', { name: 'Layer Title', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Make component', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel publication settings', exact: true }).click();
  await page.getByRole('button', { name: 'Layer Card', exact: true }).click();
  await value(page, 'Component text Title', 'Instance override');
  const source = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(source.components[0].elements).toHaveLength(2);
  expect(source.components[0].elements![1].bounds).toEqual({
    x: 20,
    y: 25,
    width: 180,
    height: 80,
  });
  await author(page, '複合カード全体');
  await page.getByRole('button', { name: 'Layer Card', exact: true }).click();
  await author(page, '複合カード部品', 'fragment');
  await reuse(page, '複合カード全体');
  const before = (await nativeArtifact(page)).draft.content as DesignContent;
  const drawings = (d: DesignContent, index: number) =>
    designDrawings(d, d.elements[index]).map(({ bounds, text }) => ({ bounds, text }));
  expect(drawings(before, 0)).toEqual(drawings(source, 0));
  await artifactMenu(page, '部分テンプレートを挿入');
  const dialog = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await dialog
    .getByRole('button', { name: 'テンプレートを選択: 複合カード部品', exact: true })
    .click();
  await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const after = (await nativeArtifact(page)).draft.content as DesignContent;
  const dx = Math.max(...before.elements.map((e) => e.bounds.x + e.bounds.width)) + 80;
  expect(drawings(after, 1)).toEqual(
    drawings(source, 0).map((e) => ({ ...e, bounds: { ...e.bounds, x: e.bounds.x + dx } })),
  );
  expect(after.components[1].elements!.map((e) => e.bounds)).toEqual(
    source.components[0].elements!.map((e) => e.bounds),
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(after);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(after);
  await page.getByRole('button', { name: 'Fit design', exact: true }).click();
  await page.screenshot({
    path: 'docs/screenshots/issue-4/review/composite-insertion.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Export design', exact: true }).click();
  const svg = await downloadText(page, 'Export all SVG');
  await writeFile('docs/exports/issue-4/review/composite.svg', svg);
  await writeFile(
    'docs/exports/issue-4/review/composite.json',
    JSON.stringify(await nativeArtifact(page), null, 2),
  );
  const rendered = await page.context().newPage();
  const errors: string[] = [];
  rendered.on('pageerror', (error) => errors.push(error.message));
  rendered.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await rendered.setContent('<img alt="Exported component">');
  await rendered.getByRole('img').evaluate(async (img, xml) => {
    const image = img as HTMLImageElement;
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    await image.decode();
  }, svg);
  await rendered.screenshot({
    path: 'docs/screenshots/issue-4/review/composite-export.png',
    fullPage: true,
  });
  await rendered.close();
  expect(errors).toEqual([]);
});
