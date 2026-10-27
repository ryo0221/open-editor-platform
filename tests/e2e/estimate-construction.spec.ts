import { test, expect, create, nativeArtifact } from './fixtures';
import { createArtifact, commitVersion, updateDraft } from '@editor-platform/artifact-core';
import { calculateEstimate, retainPriceData } from '@editor-platform/estimate-core';
import { constructionFixture } from '../../packages/estimate-core/src/construction-fixture';
import type { Page } from '@playwright/test';
async function load(page: Page, content = constructionFixture(300)) {
  await page.goto('/');
  const artifact = createArtifact('estimate', '大規模建設', content);
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'estimate.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...artifact, annotations: [] })),
    });
  await expect(page.locator('.ep-estimate:visible')).toBeVisible({ timeout: 60000 });
}
const surface = (page: Page) => page.getByRole('region', { name: '見積・積算', exact: true });
test('construction diagnostics open the exact field and paged search finds the last item at desktop/390px', async ({
  page,
}, info) => {
  const doc = constructionFixture(300);
  doc.quantities[299].inclusion = 'pending';
  // IDs are unique within collections, not across quantity/rate/line namespaces.
  doc.rates[0].id = 'q299';
  doc.lines[0].rateId = 'q299';
  await load(page, doc);
  await expect(
    page.getByRole('region', { name: '数量一覧', exact: true }).locator('article'),
  ).toHaveCount(25);
  await page
    .getByRole('region', { name: '現在の見積診断' })
    .getByRole('button', { name: '対象を選択' })
    .first()
    .click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('工区300 数量');
  await expect(page.getByLabel('名称', { exact: true })).toBeInViewport();
  await expect(page.getByLabel('名称', { exact: true })).toBeFocused();
  await surface(page).getByRole('button', { name: '編集を取消', exact: true }).click();
  await page.getByLabel('数量を検索', { exact: true }).fill('q299');
  await expect(
    page.getByRole('region', { name: '数量一覧', exact: true }).locator('article'),
  ).toHaveCount(1);
  await page
    .getByRole('region', { name: '数量一覧', exact: true })
    .getByRole('button', { name: '数量を編集', exact: true })
    .click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('工区300 数量');
  await page.screenshot({ path: info.outputPath('construction-diagnostic.png') });
});
test('construction 1000 lines replace history only on adoption, Undo restores success, mobile shows money', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await load(page, constructionFixture(1000));
  const ui = surface(page),
    result = page.getByRole('region', { name: '見積結果', exact: true });
  await ui.getByRole('button', { name: '計算して採用', exact: true }).click();
  await expect(result).toContainText('11,200,000,000', { timeout: 60000 });
  await ui.getByRole('button', { name: '保存', exact: true }).click();
  await expect(ui.getByRole('status')).toContainText('保存しました', { timeout: 60000 });
  await page.getByLabel('次の計算記録の保持').selectOption('replace');
  await ui.getByRole('button', { name: '試算して比較', exact: true }).click();
  await expect(page.getByRole('region', { name: '見積提案差分' })).toBeVisible({ timeout: 60000 });
  await expect(ui).toContainText('計算記録 1 / 5件');
  await page.getByLabel('金額が変わった費目のみ').check();
  await expect(page.getByRole('table', { name: '見積の増減内訳' }).locator('tbody tr')).toHaveCount(
    0,
  );
  await ui.getByRole('button', { name: '見積差分を採用', exact: true }).click();
  await expect(ui).toContainText('計算記録 1 / 5件');
  await ui.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(result).toContainText('11,200,000,000');
  await ui.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByLabel('結果を検索', { exact: true }).fill('工区1000');
  await expect(result).toContainText('1 / 1000件');
  if (page.viewportSize()!.width < 700) {
    const card = result.locator('.estimate-mobile-results article');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toContainText('11,200,000 JPY');
    await expect(card).toBeInViewport();
  }
  await page.screenshot({ path: info.outputPath('construction-result.png') });
  await ui.getByRole('button', { name: '保存', exact: true }).click();
  await expect(ui.getByRole('status')).toContainText('保存しました', { timeout: 60000 });
  await page.reload();
  await expect(result).toContainText('11,200,000,000', { timeout: 60000 });
});
test('construction 120-line summary and explicit partitions are available through normal Document references', async ({
  page,
}, info) => {
  const doc = constructionFixture(120);
  doc.calculations = [await calculateEstimate(doc, 'large-run')];
  await page.goto('/');
  const artifact = await commitVersion(
    createArtifact('estimate', '建設120費目', doc),
    'local',
    'fixture',
  );
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'estimate.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...artifact, annotations: [] })),
    });
  await expect(page.locator('.ep-estimate')).toBeVisible();
  await surface(page).getByRole('button', { name: '保存', exact: true }).click();
  await expect(surface(page).getByRole('status')).toContainText('保存しました');
  await create(page, 'document');
  const button = page.getByRole('button', { name: '参照を埋め込む', exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await button.click();
  const dialog = page.getByRole('dialog', { name: '参照を埋め込む' }),
    select = dialog.getByLabel('埋め込みの参照元', { exact: true });
  const summary = select
    .locator('option')
    .filter({ hasText: '現在の見積 · 区分別集計・調整・合計 · table' });
  await select.selectOption((await summary.getAttribute('value'))!);
  await expect(select.locator('option').filter({ hasText: '現在の見積 · 分割明細' })).toHaveCount(
    2,
  );
  await dialog.getByRole('button', { name: '参照を配置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '参照を配置', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ProseMirror img')).toBeVisible();
  await page.screenshot({ path: info.outputPath('construction-summary-reference.png') });
});
test('review: adjustment and work diagnostics keep their namespace when line IDs collide', async ({
  page,
}) => {
  const doc = constructionFixture(1);
  doc.rates[0].unitPrice = null;
  doc.adjustments = [
    {
      id: 'l0',
      name: '調整だけの名称',
      kind: 'percent',
      value: '0.1',
      basisLineIds: ['l0'],
      reason: 'fixture',
    },
  ];
  await load(page, doc);
  await page
    .getByRole('region', { name: '現在の見積診断' })
    .locator('p')
    .filter({ hasText: 'incomplete-adjustment-basis' })
    .getByRole('button', { name: '対象を選択' })
    .click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('調整だけの名称');
  await expect(page.getByLabel('調整方法')).toBeVisible();
  await surface(page).getByRole('button', { name: '編集を取消', exact: true }).click();
  const work = constructionFixture(1);
  work.title = '工程ID衝突の見積';
  work.lines[0].id = 'work-plan';
  work.workRules = [
    {
      id: 'crew',
      name: '班',
      setupHours: '0',
      hoursPerUnit: '1',
      perUnit: 'kg',
      crewCount: 1,
      hoursPerDay: '8',
    },
  ];
  work.workPlan = {
    projectStartDate: '2026-10-26',
    calendar: { weekdays: [1, 2, 3, 4, 5], exceptions: [] },
    tasks: [{ id: 'task', name: '工程', lineId: 'work-plan', ruleId: 'crew' }],
    dependencies: [],
  };
  await load(page, work);
  await expect(page.getByRole('heading', { name: work.title, exact: true })).toBeVisible();
  await page
    .getByRole('region', { name: '現在の見積診断' })
    .getByRole('button', { name: '対象を選択' })
    .click();
  await expect(page.getByLabel('計画開始日', { exact: true })).toBeVisible();
});

test('review: replacement also applies to a newer saved price with five retained calculations', async ({
  page,
}) => {
  const price = {
    schemaVersion: 2 as const,
    columns: [{ id: 'price', name: '単価', type: 'number' as const }],
    rows: [{ id: 'row', values: { price: 32000 } }],
  };
  let source = await commitVersion(createArtifact('data', '更新する単価', price), 'local', 'v1');
  const v1 = source.versions[0];
  const retained = await retainPriceData(
    { domain: 'data', artifactId: source.id, versionId: v1.versionId, contentHash: v1.contentHash },
    v1.content,
  );
  source = await commitVersion(
    updateDraft(source, { ...price, rows: [{ id: 'row', values: { price: 40000 } }] }),
    'local',
    'v2',
  );
  const doc = constructionFixture(1);
  doc.retainedSources = [retained];
  doc.rates[0].source = { snapshotKey: retained.key, rowId: 'row', fieldId: 'price' };

  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'prices.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...source, annotations: [] })),
    });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('更新する単価');
  // Native import assigns a new artifact ID. Bind to that explicit identity, never its name.
  const imported = await nativeArtifact(page);
  const bound = await retainPriceData({ ...retained.pin, artifactId: imported.id }, v1.content);
  doc.retainedSources = [bound];
  doc.rates[0].source!.snapshotKey = bound.key;
  for (let i = 0; i < 5; i++) doc.calculations.push(await calculateEstimate(doc, `run${i}`));
  await load(page, doc);
  await page.getByLabel('次の計算記録の保持').selectOption('replace');
  await surface(page).getByRole('button', { name: '新版単価で試算', exact: true }).click();
  await expect(page.getByRole('region', { name: '見積提案差分' })).toContainText('14,000,000');
  await expect(surface(page)).toContainText('計算記録 5 / 5件');
  await surface(page).getByRole('button', { name: '見積差分を採用', exact: true }).click();
  await expect(surface(page)).toContainText('計算記録 1 / 5件');
  await expect(page.getByRole('region', { name: '見積結果', exact: true })).toContainText(
    '14,000,000',
  );
  await surface(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(surface(page)).toContainText('計算記録 5 / 5件');
});
