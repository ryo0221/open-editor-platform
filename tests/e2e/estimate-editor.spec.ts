import type { Page } from '@playwright/test';
import { test, expect, create, nativeArtifact } from './fixtures';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { createArtifact } from '@editor-platform/artifact-core';
import { estimateFixture } from '../../packages/estimate-core/src/fixtures';
const button = (page: Page, name: string) =>
  page
    .getByRole('region', { name: '見積・積算', exact: true })
    .getByRole('button', { name, exact: true });
test('ES01/05/08 normal Editor creates manual estimate, guards pending inputs, calculates, Undo/Redo and reloads', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'estimate');
  await button(page, '数量を追加').click();
  await page.getByLabel('名称', { exact: true }).fill('パネル');
  await page.getByLabel('数量（空欄は未入力）').fill('3');
  await page.getByLabel('数量の根拠・出典').fill('図面を確認した手入力');
  await button(page, '計算して採用').click();
  await expect(page.locator('.ep-estimate [role=alert]')).toContainText('確定');
  await button(page, '項目を確定').click();
  await button(page, '単価を追加').click();
  await page.getByLabel('名称', { exact: true }).fill('パネル単価');
  await page.getByLabel('単価（空欄は未入力）').fill('1200');
  await button(page, '項目を確定').click();
  await button(page, '費目を追加').click();
  await page.getByLabel('名称', { exact: true }).fill('パネル材料費');
  await button(page, '項目を確定').click();
  await button(page, '計算して採用').click();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '見積合計 3,600 JPY',
  );
  await button(page, 'Undo').click();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).not.toContainText(
    '見積合計 3,600 JPY',
  );
  await button(page, 'Redo').click();
  await button(page, '保存').click();
  await expect(page.locator('.ep-estimate [role=status]')).toContainText('保存しました');
  const saved = await nativeArtifact(page);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(saved.draft.content);
  await page.screenshot({ path: info.outputPath('manual-estimate.png'), fullPage: true });
});
test('ES01/08 independent production Host previews without mutation and adopts once', async ({
  page,
}, info) => {
  await page.goto('/estimate-host.html');
  await page.getByLabel('Native JSON読込').setInputFiles({
    name: 'estimate.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('estimate', 'Fixture', estimateFixture()))),
  });
  await expect(page.getByRole('heading', { name: '架空の部品見積', exact: true })).toBeVisible();
  await button(page, '試算して比較').click();
  await expect(page.getByRole('region', { name: '見積提案差分' })).toContainText('1,350');
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).not.toContainText(
    '見積合計',
  );
  await button(page, '見積差分を採用').click();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '見積合計 1,350 JPY',
  );
  await button(page, '保存').click();
  await page.reload();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '見積合計 1,350 JPY',
  );
  await page.screenshot({ path: info.outputPath('independent-estimate.png'), fullPage: true });
});
test('ES05/07/08 Artifact Host saves, reopens and enforces read-only', async ({ page }, info) => {
  await page.goto('http://127.0.0.1:4177');
  await page.locator('input[type=file]').setInputFiles({
    name: 'estimate.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify(createArtifact('estimate', 'Artifact Host estimate', estimateFixture())),
    ),
  });
  await page.getByRole('button', { name: 'Artifact Host estimateを開く', exact: true }).click();
  await button(page, '計算して採用').click();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '見積合計 1,350 JPY',
  );
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await expect(page.getByRole('region', { name: '成果物一覧' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Artifact Host estimateを開く', exact: true }).click();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '見積合計 1,350 JPY',
  );
  await page.getByLabel('閲覧モード', { exact: true }).check();
  await expect(button(page, '計算して採用')).toBeDisabled();
  await expect(button(page, '数量を追加')).toBeDisabled();
  await page.screenshot({ path: info.outputPath('artifact-estimate.png'), fullPage: true });
});
test('ES22/23 ordinary Editor edits work calendar and calculates an exclusive weekend boundary', async ({
  page,
}, info) => {
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'estimate.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          ...createArtifact('estimate', 'Work fixture', estimateFixture()),
          annotations: [],
        }),
      ),
    });
  await button(page, '工程条件を編集').click();
  await page.getByLabel('計画開始日', { exact: true }).fill('2026-10-30');
  await button(page, '工程を追加').click();
  await page.getByRole('combobox', { name: '工程の費目', exact: true }).selectOption('line-bolt');
  await page.getByLabel('単位あたり工数（hour）', { exact: true }).fill('2');
  await page.getByLabel('一人あたり日稼働時間', { exact: true }).fill('8');
  await button(page, '項目を確定').click();
  await button(page, '計算して採用').click();
  const result = page.getByRole('region', { name: '計算した工程案', exact: true });
  await expect(result).toContainText('2026-10-30');
  await expect(result).toContainText('1人 × 8h/日');
  await expect(result.getByRole('columnheader', { name: '先行工程（FS）' })).toBeVisible();
  await expect(result).toContainText('2026-11-02');
  await expect(result.getByRole('cell', { name: '12', exact: true })).toBeVisible();
  await button(page, '保存').click();
  await page.reload();
  await expect(result).toContainText('2026-11-02');
  await page.screenshot({ path: info.outputPath('work-calendar.png'), fullPage: true });
});
test('ES24/25 ordinary Editor publishes exact work rows once and opens them as a Schedule lane', async ({
  page,
}, info) => {
  const doc = estimateFixture();
  doc.workRules = [
    {
      id: 'work-rule',
      name: '組立',
      setupHours: '0',
      hoursPerUnit: '2',
      perUnit: 'count',
      crewCount: 1,
      hoursPerDay: '8',
    },
  ];
  doc.workPlan = {
    projectStartDate: '2026-10-30',
    calendar: { weekdays: [1, 2, 3, 4, 5], exceptions: [] },
    tasks: [{ id: 'assemble', name: '組立工程', lineId: 'line-bolt', ruleId: 'work-rule' }],
    dependencies: [],
  };
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'estimate.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ ...createArtifact('estimate', '工程公開の見積', doc), annotations: [] }),
      ),
    });
  await button(page, '計算して採用').click();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '見積合計 1,350 JPY',
  );
  await button(page, '工程Dataの更新を確認').click();
  await expect(page.getByRole('region', { name: '工程の公開' })).toContainText('新規工程Data: 1行');
  await button(page, '工程Dataへ採用・保存').click();
  await expect(page.locator('.ep-estimate [role=status]')).toContainText(
    '工程Dataへの公開を保存しました',
  );
  await button(page, '工程Dataの更新を確認').click();
  await expect(page.getByRole('region', { name: '工程の公開' })).toContainText(
    'unchanged: assemble',
  );
  await button(page, '工程公開を取消').click();
  await button(page, '公開先Dataを開く').click();
  const data = await nativeArtifact(page);
  expect(data.kind).toBe('data');
  if (!isStructuredData(data.draft.content)) throw Error('Expected Data');
  expect(data.draft.content.rows).toHaveLength(1);
  expect(data.draft.content.rows[0].values).toMatchObject({
    start: '2026-10-30',
    end: '2026-11-02',
    hours: '12',
    days: 2,
    assignee: '',
    notes: '',
  });
  await create(page, 'schedule');
  await page.getByRole('button', { name: 'Add lane', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add lane', exact: true });
  await dialog
    .getByLabel('Data view', { exact: true })
    .selectOption({ label: '見積から公開した工程 · 工程 · Timeline' });
  await dialog.getByRole('button', { name: 'Add lane', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Work lanes' })).toContainText('組立工程');
  await page.screenshot({ path: info.outputPath('published-work-schedule.png'), fullPage: true });
});
test('ES11 normal Editor explicitly adopts saved CAD body quantities then prices them', async ({
  page,
}, info) => {
  const { f02Plate } = await import('@editor-platform/cad-core');
  const { commitVersion } = await import('@editor-platform/artifact-core');
  const cad = f02Plate();
  const saved = await commitVersion(
    createArtifact('cad', 'CAD数量テスト', cad),
    'fixture',
    'Saved CAD input',
  );
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'cad.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...saved, annotations: [] })),
    });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('CAD数量テスト');
  await create(page, 'estimate');
  await button(page, 'CAD数量を確認').click();
  await expect(page.getByRole('region', { name: 'CAD数量の取得' })).toContainText(
    '追加前の見積は変更していません',
  );
  await button(page, 'CAD数量を追加').click();
  await button(page, '単価を追加').click();
  await page.getByLabel('名称', { exact: true }).fill('試験単価');
  await page.getByLabel('単価（空欄は未入力）').fill('1200');
  await button(page, '項目を確定').click();
  await button(page, '費目を追加').click();
  await page.getByLabel('名称', { exact: true }).fill('CAD材料');
  await button(page, '項目を確定').click();
  await button(page, '計算して採用').click();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '見積合計 1,200 JPY',
  );
  await button(page, '保存').click();
  await page.reload();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '見積合計 1,200 JPY',
  );
  await page.screenshot({ path: info.outputPath('cad-estimate.png'), fullPage: true });
});
test('ES16 normal Editor acquires saved BIM net volume and preserves exact unit conversion', async ({
  page,
}, info) => {
  const { bimStarter } = await import('@editor-platform/bim-core');
  const { commitVersion } = await import('@editor-platform/artifact-core');
  const bim = bimStarter();
  const wall = bim.types.find((t) => t.id === 't-wall-200')!;
  if (wall.kind !== 'wall') throw Error('fixture');
  wall.layers = [{ materialId: 'm-concrete', thicknessMm: 100 }];
  bim.elements = [
    {
      id: 'wall',
      kind: 'wall',
      typeId: wall.id,
      start: { xy: [0, 0] },
      end: { xy: [3000, 0] },
      location: 'center',
      base: { level: 'l-1f', offsetMm: 0 },
      top: { heightMm: 2000 },
    },
    {
      id: 'opening',
      kind: 'opening',
      hostId: 'wall',
      wall: { alongMm: 1000, sillMm: 500, widthMm: 1000, heightMm: 500 },
    },
  ];
  const saved = await commitVersion(
    createArtifact('bim', 'BIM数量テスト', bim),
    'fixture',
    'Saved BIM input',
  );
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'bim.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...saved, annotations: [] })),
    });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('BIM数量テスト');
  await create(page, 'estimate');
  await page.getByRole('combobox', { name: 'BIM要素', exact: true }).selectOption('wall');
  await page.getByRole('combobox', { name: '数量metric', exact: true }).selectOption('netVolume');
  await button(page, 'BIM数量を取得・追加').click();
  await expect(page.getByRole('region', { name: '数量一覧', exact: true })).toContainText('0.55');
  await button(page, '単価を追加').click();
  await page.getByLabel('名称', { exact: true }).fill('コンクリート単価');
  await page.getByLabel('単価（空欄は未入力）').fill('20000');
  await page.getByRole('combobox', { name: '単価あたりの単位', exact: true }).selectOption('m3');
  await button(page, '項目を確定').click();
  await button(page, '費目を追加').click();
  await page.getByLabel('名称', { exact: true }).fill('壁のnet体積');
  await button(page, '項目を確定').click();
  await button(page, '計算して採用').click();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '見積合計 11,000 JPY',
  );
  await button(page, '保存').click();
  await page.reload();
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '見積合計 11,000 JPY',
  );
  await page.screenshot({ path: info.outputPath('bim-estimate.png'), fullPage: true });
});
