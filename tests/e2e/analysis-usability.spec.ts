import { test, expect, nativeArtifact } from './fixtures';
import { createArtifact, contentHash } from '@editor-platform/artifact-core';
import { calculateRun, retainData } from '@editor-platform/analysis-core';
import { analysisFixture } from '../../packages/analysis-core/src/fixtures';
test('visual expression builder creates and edits nested arithmetic with Undo and persistence', async ({
  page,
}, info) => {
  await page.goto('/analysis-host.html');
  await page.getByLabel('Quantity (number)').check();
  await page.getByLabel('Price (number)').check();
  await page.getByRole('button', { name: '入力を追加', exact: true }).click();
  const root = page.getByRole('group', { name: '式', exact: true });
  await root.getByRole('combobox', { name: '式の種類', exact: true }).selectOption('multiply');
  const left = page.getByRole('group', { name: '式 / 左辺', exact: true }),
    right = page.getByRole('group', { name: '式 / 右辺', exact: true });
  await left.getByRole('combobox', { name: '式の種類', exact: true }).selectOption('field');
  await left.getByRole('combobox', { name: '参照', exact: true }).selectOption('qty');
  await right.getByRole('combobox', { name: '式の種類', exact: true }).selectOption('field');
  await right.getByRole('combobox', { name: '参照', exact: true }).selectOption('price');
  await page.getByLabel('結果列名', { exact: true }).fill('売上');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.locator('.ep-analysis [role=alert]')).toContainText('確定');
  await page.getByRole('button', { name: 'Stepを追加', exact: true }).click();
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('cell', { name: '60', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '式を編集', exact: true }).click();
  await right.getByRole('combobox', { name: '式の種類', exact: true }).selectOption('literal');
  await right.getByRole('textbox', { name: '値', exact: true }).fill('10');
  await page.getByRole('button', { name: '式の変更を確定', exact: true }).click();
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('cell', { name: '30', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('cell', { name: '60', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('cell', { name: '30', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('visual-builder.png'), fullPage: true });
});
test('normal Editor inspects duplicate keys, restores successful input pins and keeps current notes', async ({
  page,
}, info) => {
  const doc = await analysisFixture();
  const native = {
    schemaVersion: 2,
    columns: [{ id: 'key', name: 'Key', type: 'number' }],
    rows: [
      { id: 'm1', values: { key: 2 } },
      { id: 'm2', values: { key: 3 } },
    ],
  };
  const source = await retainData(
    {
      domain: 'data',
      artifactId: 'master',
      versionId: 'good',
      contentHash: await contentHash(native),
    },
    native,
    ['key'],
  );
  doc.retainedSources.push(source);
  doc.inputs.push({
    id: 'master',
    name: 'Master',
    snapshotKey: source.key,
    selectedColumnIds: ['key'],
  });
  doc.steps.push({
    id: 'join',
    op: 'join',
    input: 'input',
    right: 'master',
    leftKey: 'qty',
    rightKey: 'key',
    mode: 'left',
    cardinality: 'many:1',
    columns: [],
  });
  doc.runs = [await calculateRun(doc, 'good-run')];
  native.rows.push({ id: 'duplicate', values: { key: 2 } });
  const bad = await retainData(
    { ...source.pin, versionId: 'bad', contentHash: await contentHash(native) },
    native,
    ['key'],
  );
  doc.retainedSources.push(bad);
  doc.inputs[1].snapshotKey = bad.key;
  const artifact = createArtifact('analysis', '品質確認', doc);
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'analysis.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...artifact, annotations: [] })),
    });
  await page.getByLabel('タイトル', { exact: true }).fill('編集を保持');
  await page.getByLabel('タイトル', { exact: true }).press('Tab');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.locator('.ep-analysis [role=alert]')).toContainText('duplicate-right-key');
  await page.getByRole('button', { name: '重複・未結合キーを調べる', exact: true }).click();
  const report = page.getByRole('region', { name: '結合データの診断', exact: true });
  await expect(report.getByRole('cell', { name: '重複キー', exact: true })).toBeVisible();
  await expect(report).toContainText('m1, duplicate');
  const before = await nativeArtifact(page);
  await page.getByRole('button', { name: 'この成功runの入力版に戻す', exact: true }).click();
  const restored = await nativeArtifact(page);
  expect(JSON.stringify(restored.draft.content)).toContain('編集を保持');
  expect(JSON.stringify(restored.draft.content)).not.toEqual(JSON.stringify(before.draft.content));
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: '過去run', exact: true }).locator('option'),
  ).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('quality-recovery.png'), fullPage: true });
});
test('result browsing paginates and searches precise decimals without changing saved content', async ({
  page,
}, info) => {
  const doc = await analysisFixture();
  const native = {
    schemaVersion: 2,
    columns: [{ id: 'amount', name: '正確な金額', type: 'text' }],
    rows: Array.from({ length: 125 }, (_, i) => ({
      id: `row-${i}`,
      values: { amount: String(9007199254740993n + BigInt(i)) },
    })),
  };
  const source = await retainData(
    {
      domain: 'data',
      artifactId: 'amounts',
      versionId: 'v1',
      contentHash: await contentHash(native),
    },
    native,
    ['amount'],
  );
  doc.inputs = [
    { id: 'input', name: '請求', snapshotKey: source.key, selectedColumnIds: ['amount'] },
  ];
  doc.retainedSources = [source];
  doc.steps = [
    {
      id: 'cast',
      op: 'derive',
      input: 'input',
      field: { id: 'yen', label: '円', type: { kind: 'decimal', unit: 'currency:JPY:0' } },
      expression: {
        op: 'cast',
        value: { op: 'field', id: 'amount' },
        type: { kind: 'decimal', unit: 'currency:JPY:0' },
      },
    },
  ];
  doc.outputs = [{ id: 'result', stepId: 'cast', columns: ['yen'], presentation: 'table' }];
  doc.runs = [await calculateRun(doc, 'precise')];
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'analysis.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ ...createArtifact('analysis', '精密な請求', doc), annotations: [] }),
      ),
    });
  const result = page.getByRole('region', { name: '計算結果', exact: true });
  await expect(result.getByRole('row')).toHaveCount(51);
  await page.getByRole('button', { name: '次の50件', exact: true }).click();
  await expect(result).toContainText('2 / 3ページ');
  await page.getByLabel('結果を検索', { exact: true }).fill('9007199254741117');
  await expect(
    page.getByRole('cell', { name: '9,007,199,254,741,117', exact: true }),
  ).toBeVisible();
  const exported = await nativeArtifact(page);
  expect(exported.draft.content).toEqual(doc);
  await page.screenshot({ path: info.outputPath('precise-search.png'), fullPage: true });
});
test('Host mode changes require cancelling pending steps and readOnly permits local cancellation', async ({
  page,
}) => {
  const document = await analysisFixture();
  await page.goto('http://127.0.0.1:4177');
  await page.locator('input[type=file]').setInputFiles({
    name: 'analysis.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('analysis', '閲覧への切替', document))),
  });
  await page.getByRole('button', { name: '閲覧への切替を開く', exact: true }).click();
  await page.getByLabel('結果列名', { exact: true }).fill('未確定');
  await page.getByLabel('閲覧モード', { exact: true }).click();
  await expect(page.getByLabel('閲覧モード', { exact: true })).not.toBeChecked();
  await expect(page.getByRole('alert').first()).toContainText('処理stepを確定');
  await page.getByRole('button', { name: '未確定の編集を取消', exact: true }).click();
  await page.getByLabel('閲覧モード', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Stepを追加', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '未確定の編集を取消', exact: true }).click();
  await expect(
    page.getByText('未確定の処理stepがあります。確定または取消後に実行・保存できます。', {
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel('閲覧モード', { exact: true }).uncheck();
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
});
