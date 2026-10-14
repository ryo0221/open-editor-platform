import { expect, type Page } from '@playwright/test';
import { createArtifact } from '@editor-platform/artifact-core';
import { cellValue, type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { nativeArtifact } from './fixtures';
import { reuseMenu, reuseHistory } from './reuse-fixtures';
export async function dataReuseFlow(page: Page, relation = false) {
  page.setDefaultTimeout(12000);
  await page.goto('/');
  const source: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'amount', name: 'Amount', type: 'text', defaultValue: '12' },
      { id: 'q', name: 'Quantity', type: 'number', defaultValue: 2 },
      { id: 'p', name: 'Price', type: 'number', defaultValue: 3 },
      { id: 'total', name: 'Total', type: 'formula', formula: 'Quantity * Price' },
      { id: 'rel', name: 'Related', type: 'relation', defaultValue: 'record' },
    ],
    rows: [{ id: 'record', values: { amount: '案件の入力', q: 100, p: 2, rel: 'record' } }],
  };
  source.views = [{ ...defaultView(source), id: 'totals', name: 'Totals', projection: 'Grid' }];
  if (!(await page.getByLabel('Import artifact', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'data.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('data', 'レコードを保持する再利用', source))),
  });
  await expect(page.getByRole('grid', { name: 'Data grid', exact: true })).toBeVisible();
  await reuseMenu(page, '再利用部品として保存');
  const author = page.getByRole('dialog', { name: '再利用部品として保存', exact: true });
  await author.getByRole('textbox', { name: '部品名', exact: true }).fill('計算と集計');
  await author.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  if (relation) {
    await author.locator('summary', { hasText: '入力・variant・slotの詳細設定' }).click();
    const input = author.getByRole('textbox', { name: '部品契約', exact: true });
    const contract = JSON.parse(await input.inputValue());
    contract.parts.find((p: { nativeId: string }) => p.nativeId === 'amount').id = 'custom_amount';
    await input.fill(JSON.stringify(contract));
    await input.press('Tab');
    await author.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  }
  await author.getByRole('button', { name: '部品を公開', exact: true }).click();
  await expect(author).toHaveCount(0);
  await reuseMenu(page, '部品ライブラリ');
  const library = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await library.getByRole('button', { name: '計算と集計 v1', exact: true }).click();
  for (const c of source.columns)
    await library
      .getByRole('textbox', { name: '追加する項目名: ' + c.name, exact: true })
      .fill(c.name + ' copy');
  await library
    .getByRole('combobox', { name: '参照レコードの対応先: record', exact: true })
    .selectOption('record');
  await library.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  await library.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  const inserted = (await nativeArtifact(page)).draft.content as StructuredData,
    instance = inserted.reuse!.instances[0],
    ids = instance.nativeIds!;
  expect(inserted.rows).toHaveLength(1);
  expect(inserted.rows[0].id).toBe('record');
  expect(inserted.rows[0].values.amount).toBe('案件の入力');
  expect(inserted.rows[0].values[ids.amount]).toBe('12');
  expect(
    cellValue(inserted, inserted.rows[0], inserted.columns.find((c) => c.id === ids.total)!),
  ).toBe(6);
  expect(inserted.rows[0].values[ids.rel]).toBe('record');
  await reuseMenu(page, '部品ライブラリ');
  await library.getByRole('button', { name: '計算と集計 v1', exact: true }).click();
  await library.getByRole('button', { name: '新版の下書きを作成', exact: true }).click();
  const draft = page.getByRole('dialog', { name: '部品の下書き・新版公開', exact: true });
  const editor = draft.getByRole('region', { name: 'Data部品の項目とビュー', exact: true });
  if (!(await editor.getByRole('button', { name: 'Amount', exact: true }).isVisible()))
    await editor.getByRole('button', { name: 'Toggle Data navigator', exact: true }).click();
  await editor.getByRole('button', { name: 'Amount', exact: true }).click();
  if (!(await editor.getByRole('combobox', { name: 'Field type', exact: true }).isVisible())) {
    await editor.getByRole('button', { name: 'Close Data navigator', exact: true }).click();
    await editor.getByRole('button', { name: 'Toggle Data inspector', exact: true }).click();
  }
  await editor
    .getByRole('combobox', { name: 'Field type', exact: true })
    .selectOption(relation ? 'relation' : 'number');
  if (relation)
    await editor.getByRole('textbox', { name: 'Field default', exact: true }).fill('record');
  await editor.getByRole('button', { name: 'Apply field settings', exact: true }).click();
  await draft
    .getByRole('combobox', { name: '外観の対象', exact: true })
    .selectOption({ label: 'Totals' });
  await draft.getByRole('textbox', { name: 'グラフの色', exact: true }).fill('#336699');
  await draft.getByRole('textbox', { name: 'ビュー名', exact: true }).fill('再利用した集計');
  await draft.getByRole('combobox', { name: '表示形式', exact: true }).selectOption('Chart');
  await draft.getByRole('button', { name: '新版をプレビュー', exact: true }).click();
  await draft.getByRole('button', { name: '下書きを保存', exact: true }).click();
  await draft.getByRole('button', { name: '保存した版を公開', exact: true }).click();
  await expect(draft).toHaveCount(0);
  await page.getByRole('button', { name: 'Close 部品ライブラリ', exact: true }).click();
  await reuseMenu(page, '部品の入力・表示');
  const inspector = page.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await inspector.getByRole('button', { name: '計算と集計 v1', exact: true }).click();
  await inspector.locator('summary', { hasText: '改訂の採用・部品の差し替え' }).click();
  await inspector.getByRole('button', { name: '更新差分をプレビュー', exact: true }).click();
  await expect(inspector.getByRole('alert')).toContainText('競合');
  await expect(
    inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }),
  ).toHaveCount(0);
  await inspector.locator('summary', { hasText: '対応先を明示して再確認' }).click();
  await inspector.getByRole('combobox', { name: '移行: Amount', exact: true }).selectOption('cast');
  await inspector.getByRole('button', { name: '更新差分をプレビュー', exact: true }).click();
  if (relation) {
    await expect(inspector.getByRole('alert')).toContainText('競合');
    await inspector
      .getByRole('combobox', { name: 'レコードへ対応: Amount / 12', exact: true })
      .selectOption('record');
    await inspector.getByRole('button', { name: '更新差分をプレビュー', exact: true }).click();
  }
  await expect(inspector.getByRole('status')).toContainText('更新可能');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  const adopted = (await nativeArtifact(page)).draft.content as StructuredData;
  if (relation) expect(adopted.reuse!.instances[0].parts).toHaveProperty('custom_amount');
  expect(adopted.rows[0].values[ids.amount]).toBe(relation ? 'record' : 12);
  expect(adopted.rows[0].values.amount).toBe('案件の入力');
  expect(adopted.rows[0].values[ids.rel]).toBe('record');
  expect(adopted.rows.map((r) => r.id)).toEqual(['record']);
  expect(adopted.columns.find((c) => c.id === ids.amount)?.name).toBe('Amount copy');
  expect(adopted.views!.find((v) => v.id === ids.totals)).toMatchObject({
    name: '再利用した集計',
    accent: '#336699',
    projection: 'Chart',
  });
  await reuseHistory(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
  await reuseHistory(page, 'Redo');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(adopted);
  const view = page.getByRole('button', { name: '再利用した集計', exact: true });
  if (!(await view.isVisible()))
    await page.getByRole('button', { name: 'Toggle Data navigator', exact: true }).click();
  await view.click();
  const close = page.getByRole('button', { name: 'Close Data navigator', exact: true });
  if (await close.isVisible()) await close.click();
  const closeInspector = page.getByRole('button', { name: 'Close Data inspector', exact: true });
  if (await closeInspector.isVisible()) await closeInspector.click();
  await expect(page.locator('svg rect[fill="#336699"]').first()).toBeVisible();
  return adopted;
}
