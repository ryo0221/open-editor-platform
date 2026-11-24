/**
 * AR2（docs/analysis-references-design.md U4・§3）：FMEA の故障原因から、同じ Library の保存した特性要因図の原因の候補を
 * 「候補から選ぶ」で引用し、Undo/Redo で戻せ、保存した後に引用先が変わると「古い」と出る（Playground の架空の Host）。
 */
import { test, expect, nativeArtifact, save } from './fixtures';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { GraphDocument } from '@editor-platform/structured-graph/model';
import type { Page } from '@playwright/test';

async function create(page: Page, type: string, template: [string, string]) {
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Artifact type', { exact: true }).selectOption(type);
  await page.getByLabel(template[0], { exact: true }).selectOption(template[1]);
  await page.getByRole('button', { name: 'New artifact' }).click();
  await expect(page.getByLabel('Artifact name')).toBeVisible();
}
async function causeName(page: Page, from: string, id: string, name: string) {
  await page.getByRole('button', { name: `Select node ${from}`, exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Graph Inspector' });
  await inspector.getByLabel('業務 ID', { exact: true }).fill(id);
  await inspector.getByLabel('原因', { exact: true }).fill(name);
  await inspector.getByRole('button', { name: '属性を適用', exact: true }).click();
}
async function activate(page: Page, name: RegExp) {
  if (!(await page.getByRole('navigation', { name: 'Artifacts' }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('navigation', { name: 'Artifacts' }).getByRole('button', { name }).click();
}

test('AR2 FMEA の故障原因が特性要因図の原因の候補を選んで引用し、Undo/Redo でき、引用先が変わると古いと出る', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'structured-graph', ['Graph template', 'fishbone']);
  await causeName(page, '設備温度の変動', 'CC-01', '設備温度の変動');
  await save(page, 1);

  await create(page, 'data', ['Data template', 'dfmea']);
  await page.getByLabel('Data projection', { exact: true }).selectOption('Form');
  await page.getByLabel('Record 故障原因の ID', { exact: true }).fill('FC-01');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  // 記録の欄に打ちかけのまま引用を選ぶと、打った値を先に確定してから引用を足す
  await page.getByLabel('Record 故障原因', { exact: true }).fill('接点の溶着');
  const refs = page.getByRole('region', { name: 'refs.causeCandidates', exact: true });
  await refs.getByRole('button', { name: '候補から選ぶ', exact: true }).click();
  await refs.getByRole('button', { name: /CC-01/ }).click();
  await expect(refs.getByRole('listitem').filter({ hasText: 'CC-01' })).toContainText(
    '設備温度の変動',
  );
  const row = async () => ((await nativeArtifact(page)).draft.content as StructuredData).rows[0]!;
  const rowRefs = async () => (await row()).refs;
  expect(await rowRefs()).toEqual({ causeCandidates: ['CC-01'] });
  expect(Object.values((await row()).values)).toContain('接点の溶着');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect(await rowRefs()).toBeUndefined();
  await page.getByRole('button', { name: 'Redo', exact: true }).first().click();
  expect(await rowRefs()).toEqual({ causeCandidates: ['CC-01'] });
  // 外してから Undo で戻した引用も、選んだ版の証跡を保存へ持っていく
  await refs.getByRole('button', { name: 'CC-01 を外す', exact: true }).click();
  expect(await rowRefs()).toBeUndefined();
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect(await rowRefs()).toEqual({ causeCandidates: ['CC-01'] });
  await save(page, 1);

  // 開くと引用先の原因の候補が選ばれ、戻ると引用した故障原因へ戻る
  await refs.getByRole('button', { name: 'CC-01 を開く', exact: true }).click();
  await expect(
    page
      .getByRole('complementary', { name: 'Graph Inspector' })
      .getByLabel('業務 ID', { exact: true }),
  ).toHaveValue('CC-01');
  await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
  await expect(page.getByLabel('Record 故障原因の ID', { exact: true })).toHaveValue('FC-01');

  // 引用先の原因の候補を変えて保存し直すと、選んだ版から変わったので「古い」
  await activate(page, /Structured Graph 1/);
  await causeName(page, '設備温度の変動', 'CC-01', '設備温度の変動（改）');
  await save(page, 2);
  await activate(page, /DFMEA/);
  await page.getByLabel('Data projection', { exact: true }).selectOption('Form');
  await expect(refs.getByRole('listitem').filter({ hasText: 'CC-01' })).toContainText('古い');
});

test('AR2 FTA の基本事象で、適用していない属性の入力があっても引用を選べ、入力も引用も残る', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'data', ['Data template', 'dfmea']);
  await page.getByLabel('Data projection', { exact: true }).selectOption('Form');
  await page.getByLabel('Record 故障原因の ID', { exact: true }).fill('FC-01');
  await page.getByLabel('Record 故障原因', { exact: true }).fill('接点の溶着');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByLabel('Data projection', { exact: true }).selectOption('Summary');
  await save(page, 1);

  await create(page, 'structured-graph', ['Graph template', 'fta']);
  await page.getByRole('button', { name: 'Select node 電源故障', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Graph Inspector' });
  await inspector.getByLabel('根拠', { exact: true }).fill('点検記録');
  const refs = inspector.getByRole('region', { name: '故障原因の業務 ID', exact: true });
  await refs.getByRole('button', { name: '候補から選ぶ', exact: true }).click();
  await refs.getByRole('button', { name: /FC-01/ }).click();
  await expect(refs.getByRole('listitem').filter({ hasText: 'FC-01' })).toContainText('接点の溶着');
  const node = async () =>
    ((await nativeArtifact(page)).draft.content as GraphDocument).nodes.find(
      (n) => n.id === 'power',
    )!;
  expect((await node()).attributes).toMatchObject({
    evidence: '点検記録',
    failureCauseRefs: ['FC-01'],
  });
  await expect(inspector.getByRole('alert')).toHaveCount(0);

  // 開くと、集計の表示のままの FMEA で記録の詳細に引用先の行が出る（保存した表示は変えない）
  await refs.getByRole('button', { name: 'FC-01 を開く', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Record details' });
  await expect(details).toBeVisible();
  await expect(details.getByLabel('Record 故障原因の ID', { exact: true })).toHaveValue('FC-01');
  await expect(page.getByLabel('Data projection', { exact: true })).toHaveValue('Summary');
});
