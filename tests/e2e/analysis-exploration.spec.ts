import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { test, expect, nativeArtifact } from './fixtures';
import { createArtifact, commitVersion, updateDraft } from '@editor-platform/artifact-core';
import { calculateRun, retainData, type AnalysisDocument } from '@editor-platform/analysis-core';
import { analysisFixture } from '../../packages/analysis-core/src/fixtures';
async function load(page: Page, document: AnalysisDocument) {
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'analysis.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ ...createArtifact('analysis', '探索の回帰', document), annotations: [] }),
      ),
    });
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue(document.title);
}
const button = (page: Page, name: string) =>
  page
    .getByRole('region', { name: '計算・分析ノート', exact: true })
    .getByRole('button', { name, exact: true });
const kind = (page: Page, path: string) =>
  page.getByRole('group', { name: path, exact: true }).locator(':scope > label select').first();
test('F01/02/09 ordinary Host keeps operands, guards reset, rejects Undo without a render loop, then commits and persists', async ({
  page,
}, info) => {
  const doc = await analysisFixture();
  await load(page, doc);
  await button(page, '式を編集').click();
  await kind(page, '式').selectOption('divide');
  await expect(kind(page, '式 / 左辺')).toHaveValue('multiply');
  await expect(kind(page, '式 / 右辺')).toHaveValue('parameter');
  await button(page, 'Undo').click();
  await expect(page.locator('.ep-analysis [role=alert]')).toContainText('確定');
  await button(page, '未確定の編集を取消').click();
  await button(page, '式を編集').click();
  await button(page, '式を初期化').click();
  await button(page, '実行').click();
  await expect(page.locator('.ep-analysis [role=alert]')).toContainText('確定');
  await button(page, '未確定の編集を取消').click();
  expect((await nativeArtifact(page)).draft.content).toEqual(doc);
  await page.getByRole('combobox', { name: '演算', exact: true }).selectOption('sort');
  await button(page, 'Stepを追加').click();
  await expect(page.locator('.ep-analysis ol > li')).toHaveCount(3);
  await button(page, '実行').click();
  await expect(page.locator('.ep-analysis [role=status]')).toContainText('結果を採用');
  await button(page, 'Undo').click();
  await button(page, 'Redo').click();
  const after = await nativeArtifact(page);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(after.draft.content);
  await page.screenshot({ path: info.outputPath('ordinary-guard.png'), fullPage: true });
});
test('F09 invalid dimensions and output limit reject atomically and leave the Editor usable', async ({
  page,
}) => {
  const doc = await analysisFixture();
  const step = doc.steps[0];
  if (step.op !== 'derive') throw Error('fixture');
  step.expression = {
    op: 'cast',
    value: { op: 'literal', type: { kind: 'decimal', unit: 'mm' }, value: '1000' },
    type: { kind: 'decimal', unit: 'm' },
  };
  step.field.type = { kind: 'decimal', unit: 'm' };
  doc.steps = [step];
  doc.outputs = [
    { id: 'length', stepId: step.id, columns: [step.field.id], presentation: 'table' },
  ];
  await load(page, doc);
  await button(page, '式を編集').click();
  await page
    .getByRole('group', { name: '式', exact: true })
    .locator(':scope > label input')
    .fill('kg');
  await button(page, '式の変更を確定').click();
  await expect(page.locator('.ep-analysis [role=alert]')).toContainText('unit-mismatch');
  await button(page, '未確定の編集を取消').click();
  expect((await nativeArtifact(page)).draft.content).toEqual(doc);
  await button(page, '実行').click();
  await expect(page.getByRole('cell', { name: '1', exact: true })).toHaveCount(2);
  doc.steps = Array.from({ length: 16 }, (_, i) => ({
    id: `sort${i}`,
    op: 'sort',
    input: i ? `sort${i - 1}` : 'input',
    keys: [{ fieldId: 'qty', direction: 'asc' }],
  }));
  doc.outputs = doc.steps.map((s) => ({
    id: `out-${s.id}`,
    stepId: s.id,
    columns: ['qty'],
    presentation: 'table',
  }));
  await load(page, doc);
  await page.getByRole('combobox', { name: '演算', exact: true }).selectOption('sort');
  await button(page, 'Stepを追加').click();
  await expect(page.locator('.ep-analysis [role=alert]')).not.toHaveText('');
  await expect(page.locator('.ep-analysis ol > li')).toHaveCount(16);
  await button(page, '未確定の編集を取消').click();
  expect((await nativeArtifact(page)).draft.content).toEqual(doc);
});
test('F03 successful rerun selects latest while explicit historical viewing remains available', async ({
  page,
}) => {
  const doc = await analysisFixture();
  doc.runs = [await calculateRun(doc, 'old', 'base')];
  await load(page, doc);
  await page.getByRole('combobox', { name: '過去run', exact: true }).selectOption('old');
  await page.getByRole('combobox', { name: '実行条件', exact: true }).selectOption('higher');
  await button(page, '実行').click();
  await expect(page.getByRole('cell', { name: '88', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '過去run', exact: true }).selectOption('old');
  await expect(page.getByText(/過去結果を表示中/)).toBeVisible();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
});
test('F04/06 chart overflow and full CSV scope are explicit after filtering on narrow and desktop layouts', async ({
  page,
}, info) => {
  const doc = await analysisFixture();
  doc.steps = [
    {
      id: 'rows',
      op: 'derive',
      input: 'input',
      field: { id: 'amount', label: 'Amount', type: { kind: 'decimal', unit: 'dimensionless' } },
      expression: {
        op: 'cast',
        value: { op: 'field', id: 'qty' },
        type: { kind: 'decimal', unit: 'dimensionless' },
      },
    },
  ];
  const native = {
    schemaVersion: 2,
    columns: [{ id: 'qty', name: 'Quantity', type: 'text' }],
    rows: Array.from({ length: 101 }, (_, i) => ({
      id: `r${i}`,
      values: { qty: String(9007199254740993n + BigInt(i)) },
    })),
  };
  const { contentHash } = await import('@editor-platform/artifact-core');
  const source = await retainData(
    { ...doc.retainedSources[0].pin, contentHash: await contentHash(native) },
    native,
    ['qty'],
  );
  doc.retainedSources = [source];
  doc.inputs[0].snapshotKey = source.key;
  doc.inputs[0].selectedColumnIds = ['qty'];
  doc.outputs = [{ id: 'chart', stepId: 'rows', columns: ['amount'], presentation: 'chart' }];
  doc.runs = [await calculateRun(doc, 'many')];
  await load(page, doc);
  await expect(page.getByText(/Chartは100件までです/)).toBeVisible();
  await page.getByLabel('結果を検索', { exact: true }).fill('9007199254741093');
  await expect(page.getByText(/1件 \/ 全101件/)).toBeVisible();
  await expect(
    page.getByText('CSV・Dataコピーは検索条件に関係なく全101件を出力します。', { exact: true }),
  ).toBeVisible();
  const pending = page.waitForEvent('download');
  await button(page, 'CSV出力（静的）').click();
  const file = await pending;
  const csv = await readFile((await file.path())!, 'utf8');
  expect(csv.trim().split(/\r?\n/)).toHaveLength(102);
  expect(csv).toContain('9007199254741093');
  await page.screenshot({ path: info.outputPath('chart-scope.png'), fullPage: true });
});
test('F08 sequential source updates isolate mappings by stable input ID', async ({ page }) => {
  const doc = await analysisFixture();
  await page.goto('/');
  for (const index of [0, 1]) {
    const native =
      index === 0
        ? (structuredClone(doc.retainedSources[0].nativeContent) as {
            schemaVersion: number;
            columns: { id: string; name: string; type: string }[];
            rows: { id: string; values: Record<string, number> }[];
          })
        : {
            schemaVersion: 2,
            columns: [{ id: 'cost', name: 'Cost', type: 'number' }],
            rows: [{ id: 'cost1', values: { cost: 10 } }],
          };
    let data = await commitVersion(
      createArtifact('data', `Source ${index}`, native),
      'local',
      'v1',
    );
    const next = structuredClone(native);
    if (index === 0) {
      next.columns[0].id = 'qty_v2';
      for (const r of next.rows) {
        r.values.qty_v2 = r.values.qty + 1;
        delete r.values.qty;
      }
    } else next.rows[0].values.cost = 20;
    data = await commitVersion(updateDraft(data, next), 'local', 'v2');
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: 'data.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ ...data, annotations: [] })),
      });
    const imported = await nativeArtifact(page),
      v = imported.versions[0];
    const source = await retainData(
      {
        domain: 'data',
        artifactId: imported.id,
        versionId: v.versionId,
        contentHash: v.contentHash,
      },
      v.content,
      native.columns.map((c) => c.id),
    );
    if (!index) {
      doc.retainedSources = [source];
      doc.inputs[0].snapshotKey = source.key;
    } else {
      doc.retainedSources.push(source);
      doc.inputs.push({
        id: 'second',
        name: 'Costs',
        snapshotKey: source.key,
        selectedColumnIds: ['cost'],
      });
    }
  }
  doc.runs = [await calculateRun(doc, 'prior')];
  await load(page, doc);
  await page
    .getByRole('combobox', { name: '新版の対応列 qty', exact: true })
    .selectOption('qty_v2');
  for (const index of [0, 1]) {
    await button(page, '新版で試算').nth(index).click();
    await expect(page.getByRole('region', { name: '提案差分', exact: true })).toBeVisible();
    await button(page, '差分を採用').click();
  }
  const out = await nativeArtifact(page);
  const { isAnalysis } = await import('@editor-platform/analysis-core');
  if (!isAnalysis(out.draft.content)) throw Error('not analysis');
  expect(out.draft.content.runs).toHaveLength(3);
  expect(
    out.draft.content.inputs.every((v, i) => v.snapshotKey !== doc.inputs[i].snapshotKey),
  ).toBe(true);
  await button(page, 'Undo').click();
  const undone = await nativeArtifact(page);
  if (!isAnalysis(undone.draft.content)) throw Error('not analysis');
  expect(undone.draft.content.inputs[1].snapshotKey).toBe(doc.inputs[1].snapshotKey);
  await button(page, 'Redo').click();
});
test('F05 diagnostics can reach unmatched keys past 200 findings without adopting a result', async ({
  page,
}, info) => {
  const { joinInspectionFixture } = await import('../../packages/analysis-core/src/fixtures');
  const doc = await joinInspectionFixture();
  await load(page, doc);
  const report = page.getByRole('region', { name: '結合データの診断', exact: true });
  await button(page, '重複・未結合キーを調べる').click();
  await expect(report.getByRole('row')).toHaveCount(201);
  await button(page, '次の診断').click();
  await expect(report.getByRole('cell', { name: '未結合キー', exact: true })).toHaveCount(2);
  await button(page, '前の診断').click();
  await expect(report.getByRole('row')).toHaveCount(201);
  await page
    .getByRole('combobox', { name: '診断の種類', exact: true })
    .selectOption('unmatched-key');
  await button(page, '重複・未結合キーを調べる').click();
  await expect(report.getByRole('row')).toHaveCount(3);
  expect((await nativeArtifact(page)).draft.content).toEqual(doc);
  await report.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('filtered-diagnostics.png') });
});
test('step confirmation preserves text committed by the same Host input flush', async ({
  page,
}) => {
  await page.goto('/analysis-host.html');
  await page.getByLabel('Quantity (number)').check();
  await button(page, '入力を追加').click();
  await page.getByLabel('結果列名', { exact: true }).fill('新しい列');
  await page.getByLabel('タイトル', { exact: true }).fill('同じflushで保持する説明');
  // Dispatch without moving focus: the title remains buffered until confirmation flushes it.
  await button(page, 'Stepを追加').dispatchEvent('click');
  await expect(page.locator('.ep-analysis ol > li')).toHaveCount(1);
  await button(page, '保存').click();
  await expect(page.locator('.ep-analysis [role=status]')).toContainText('保存');
  await page.reload();
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('同じflushで保持する説明');
});
for (const variant of ['text-only', 'wide'] as const) {
  test(`review Chart fallback keeps ordinary form-created ${variant} output usable`, async ({
    page,
  }, info) => {
    const doc = await analysisFixture();
    const count = variant === 'wide' ? 31 : 1;
    const native = {
      schemaVersion: 2,
      columns: Array.from({ length: count }, (_, i) => ({
        id: `field${i}`,
        name: `Column ${i}`,
        type: variant === 'wide' ? 'number' : 'text',
      })),
      rows: [
        {
          id: 'record',
          values: Object.fromEntries(
            Array.from({ length: count }, (_, i) => [
              `field${i}`,
              variant === 'wide' ? i : 'text value',
            ]),
          ),
        },
      ],
    };
    const { contentHash } = await import('@editor-platform/artifact-core');
    const source = await retainData(
      { ...doc.retainedSources[0].pin, contentHash: await contentHash(native) },
      native,
      native.columns.map((c) => c.id),
    );
    doc.retainedSources = [source];
    doc.inputs[0].snapshotKey = source.key;
    doc.inputs[0].selectedColumnIds = native.columns.map((c) => c.id);
    doc.steps = [];
    doc.outputs = [];
    await load(page, doc);
    await page.getByRole('combobox', { name: '演算', exact: true }).selectOption('select');
    for (const column of native.columns)
      await page.getByRole('checkbox', { name: column.name, exact: true }).check();
    await page.getByRole('combobox', { name: '表示形式', exact: true }).selectOption('chart');
    await button(page, 'Stepを追加').click();
    await button(page, '実行').click();
    await expect(page.locator('.ep-analysis [role=status]')).toContainText('結果を採用');
    await expect(page.getByText(/Chartを表示できません/)).toContainText(
      variant === 'wide' ? '30列' : 'decimal列',
    );
    await expect(
      page.getByRole('img', { name: '分析Chart（描画値は近似）', exact: true }),
    ).toHaveCount(0);
    await expect(button(page, 'CSV出力（静的）')).toBeEnabled();
    const exported = await nativeArtifact(page);
    const { isAnalysis } = await import('@editor-platform/analysis-core');
    if (!isAnalysis(exported.draft.content)) throw Error('fixture');
    expect(Object.values(exported.draft.content.runs[0].results)[0].fields).toHaveLength(count);
    await page.getByText(/Chartを表示できません/).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`chart-${variant}.png`) });
  });
}
