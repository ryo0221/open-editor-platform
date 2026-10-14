import { test, expect, addField, editCell, nativeArtifact } from './fixtures';
import { openWhole, artifactMenu } from './template-fixtures';
import {
  collaborate,
  confirmed,
  download,
  finish,
  insertFragment,
  screenshot,
  value,
} from './practical-fixtures';
import type { StructuredData } from '@editor-platform/structured-data/model';

test('QL-05 hundred issue records: typed paste, relation, projections, peers, preset, CSV and reusable schema', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(12000);
  await page.goto('/');
  const form = await openWhole(page, 'data', '課題台帳');
  await form.locator('[data-slot="rows.0.label"]').fill('受付課題001');
  await form.locator('[data-slot="rows.1.label"]').fill('受付課題002');
  await form.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await form.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByLabel('Data projection', { exact: true }).selectOption('Grid');
  await addField(page, '担当', 'text');
  await addField(page, '関連課題', 'relation');
  await page.getByRole('button', { name: 'Back to view settings', exact: true }).click();
  await page.getByRole('gridcell', { name: '課題 · record 1', exact: true }).click();
  const lines = Array.from({ length: 100 }, (_, i) =>
    [
      `受付課題${String(i + 1).padStart(3, '0')}`,
      ['未着手', '調査中', '対応済'][i % 3],
      (i % 5) + 1,
      (i % 4) + 1,
      '',
      '2026-10-20',
      i % 2 ? '受付担当' : '企画担当',
      '',
    ].join('\t'),
  ).join('\n');
  await page.getByRole('grid').evaluate((el, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
  }, lines);
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '101');
  const original = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(original.rows).toHaveLength(100);
  await page.getByRole('button', { name: 'Field 課題', exact: true }).click();
  await page.getByLabel('Required field', { exact: true }).check();
  await page.getByRole('button', { name: 'Apply field settings', exact: true }).click();
  await page.getByRole('button', { name: 'Back to view settings', exact: true }).click();
  await editCell(page, '関連課題', 2, original.rows[0].id, true);
  await editCell(page, '影響度', 1, '4');
  await editCell(page, '頻度', 1, '3');
  await expect(
    page.getByRole('gridcell', { name: '優先スコア · record 1', exact: true }),
  ).toHaveText('12');
  const beforeRepeat = (await nativeArtifact(page)).draft.content;
  await editCell(page, '影響度', 1, '2');
  await editCell(page, '影響度', 1, '5');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(beforeRepeat);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const shared = await collaborate(page, browser, baseURL, 'data');
  await page.getByLabel('Data projection', { exact: true }).selectOption('Form');
  await page.getByLabel('Record 影響度', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await confirmed(page);
  await page.getByLabel('Data projection', { exact: true }).selectOption('Kanban');
  await page.getByLabel('Move 受付課題001／確認済み to', { exact: true }).selectOption('対応済');
  await confirmed(page);
  await screenshot(page, 'data-kanban');
  await page.getByLabel('Data projection', { exact: true }).selectOption('Chart');
  await page.getByLabel('X field', { exact: true }).selectOption({ label: '状態' });
  await page.getByLabel('Y field', { exact: true }).selectOption({ label: '優先スコア' });
  await value(page, 'View name', '受付改善の優先度');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await confirmed(page);
  await screenshot(page, 'data-chart');
  await page.getByLabel('Data projection', { exact: true }).selectOption('Grid');
  await page.getByRole('button', { name: 'Field 頻度', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('発生頻度');
  await page.getByRole('button', { name: 'Apply field settings', exact: true }).click();
  await page.getByRole('button', { name: 'Back to view settings', exact: true }).click();
  await confirmed(page);
  await expect(
    page.getByRole('gridcell', { name: '優先スコア · record 1', exact: true }),
  ).toHaveText('12');
  await insertFragment(page, '共通field set');
  await artifactMenu(page, 'スタイル・表示プリセット');
  const preset = page.getByRole('dialog', { name: 'スタイル・表示プリセット', exact: true });
  await preset
    .getByRole('button', { name: 'テンプレートを選択: 落ち着いた色・読みやすい設定', exact: true })
    .click();
  await preset.getByLabel('プリセットの適用範囲', { exact: true }).selectOption('artifact');
  await preset.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await preset.getByRole('button', { name: 'この設定を適用', exact: true }).click();
  await expect(preset).toHaveCount(0);
  await page.getByRole('button', { name: 'Export data', exact: true }).click();
  const csv = await download(page, 'Export CSV', 'issues.csv');
  expect(csv.toString()).toContain('受付課題100');
  expect(csv.toString().trim().split('\r\n')).toHaveLength(101);
  const final = (await nativeArtifact(page)).draft.content as StructuredData;
  expect(final.rows[1].values[original.columns.find((c) => c.name === '関連課題')!.id]).toBe(
    original.rows[0].id,
  );
  await shared.close();
  await finish(page, browser, baseURL, 'data');
  // Open the ordinary CSV through the import UI and verify all 100 rows and formula values.
  await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles({ name: 'issues.csv', mimeType: 'text/csv', buffer: csv });
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '101');
  await expect(
    page.getByRole('gridcell', { name: '優先スコア · record 1', exact: true }),
  ).toHaveText('12');
});
