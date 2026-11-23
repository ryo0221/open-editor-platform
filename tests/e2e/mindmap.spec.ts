import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, artifactView, create, save } from './fixtures';

const surface = (page: Page) => page.getByRole('region', { name: 'マインドマップ', exact: true });
const node = (page: Page, text: string) =>
  surface(page).locator('.mindmap-node').filter({ hasText: text });

async function addChild(page: Page, parent: string, name: string) {
  await node(page, parent).first().click();
  await surface(page).getByRole('button', { name: '子を足す', exact: true }).click();
  await expect(surface(page).getByLabel('名前', { exact: true })).toBeFocused();
  await surface(page).getByLabel('名前', { exact: true }).fill(name);
  await surface(page).getByRole('button', { name: '適用', exact: true }).click();
  await expect(node(page, name)).toBeVisible();
}

test('create a Mind Map, grow branches, edit fields, Undo, export and compare versions', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'mindmap');
  await expect(node(page, '中心のテーマ')).toBeVisible();
  await addChild(page, '中心のテーマ', '市場');
  await addChild(page, '中心のテーマ', '顧客');

  // Unapplied input keeps the selection; marks stop at four.
  await node(page, '市場').click();
  await surface(page).getByLabel('メモ', { exact: true }).fill('東南アジア');
  await node(page, '顧客').click();
  await expect(surface(page).getByRole('status')).toContainText('未確定の入力');
  for (const mark of ['疑問', 'アイデア', '決定', 'リスク'])
    await surface(page).getByLabel(mark, { exact: true }).check();
  await expect(surface(page).getByLabel('重要', { exact: true })).toBeDisabled();
  await surface(page).getByRole('button', { name: '適用', exact: true }).click();
  await expect(node(page, '市場')).toContainText('リスク');

  // The Host's Undo takes back the layout change.
  await surface(page).getByLabel('配置', { exact: true }).selectOption('tree');
  await expect(surface(page).getByLabel('配置', { exact: true })).toHaveValue('tree');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(surface(page).getByLabel('配置', { exact: true })).toHaveValue('radial');

  // Undo of an add while its name is unapplied keeps the input and refuses to write it elsewhere.
  await node(page, '中心のテーマ').click();
  await surface(page).getByRole('button', { name: '子を足す', exact: true }).click();
  await surface(page).getByLabel('名前', { exact: true }).fill('消える枝');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await surface(page).getByRole('button', { name: '適用', exact: true }).click();
  await expect(surface(page).getByRole('status')).toContainText('変更または削除');
  await expect(node(page, '消える枝')).toHaveCount(0);
  await expect(node(page, '中心のテーマ')).toBeVisible();
  await surface(page).getByRole('button', { name: '取消', exact: true }).click();

  // Markdown export holds the outline.
  const download = page.waitForEvent('download');
  await surface(page).getByRole('button', { name: 'Markdown', exact: true }).click();
  const markdown = readFileSync((await (await download).path())!, 'utf8');
  expect(markdown).toContain('# 中心のテーマ');
  expect(markdown).toContain('- 市場 [疑問・アイデア・決定・リスク]');
  expect(markdown).toContain('  > 東南アジア');
  await page.screenshot({ path: test.info().outputPath('mindmap.png') });
  const png = page.waitForEvent('download');
  await surface(page).getByRole('button', { name: 'PNG', exact: true }).click();
  const bytes = readFileSync((await (await png).path())!);
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');

  // Two saved versions compare by branch.
  await save(page, 1);
  await addChild(page, '市場', 'タイ');
  // A name typed but not applied is committed by Save version, not dropped.
  await node(page, '顧客').click();
  await surface(page).getByLabel('名前', { exact: true }).fill('利用者');
  await save(page, 2);
  await expect(node(page, '利用者')).toBeVisible();
  await artifactView(page, 'Compare');
  const compare = page.locator('.compare-view');
  await expect(compare.locator('.change.added')).toContainText('タイ');
  await expect(compare.locator('.change.changed').first()).toContainText('利用者');
});

test('open a file written by the external mindmap-editor 0.1.5 and its own JSON export', async ({
  page,
}) => {
  const path = new URL('../../packages/mindmap-core/fixtures/valid-rich.json', import.meta.url);
  const sample = JSON.parse(readFileSync(path, 'utf8'));
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'map.json',
    mimeType: 'application/json',
    buffer: readFileSync(path),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('map');
  for (const n of Object.values(sample.nodes) as { text: string }[])
    if (n.text) await expect(node(page, n.text).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('mindmap-imported.png') });

  // The JSON button writes a bare map that opens again as a Mind Map.
  const download = page.waitForEvent('download');
  await surface(page).getByRole('button', { name: 'JSON', exact: true }).click();
  const exported = readFileSync((await (await download).path())!);
  expect(JSON.parse(exported.toString())).toEqual(sample);
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'again.json',
    mimeType: 'application/json',
    buffer: exported,
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('again');
  await expect(node(page, sample.nodes[sample.rootId].text)).toBeVisible();
});
