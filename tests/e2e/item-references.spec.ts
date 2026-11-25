/**
 * AR2（docs/analysis-references-design.md U4・§3）：FMEA の故障原因から、同じ Library の保存した特性要因図の原因の候補を
 * 「候補から選ぶ」で引用し、Undo/Redo で戻せ、保存した後に引用先が変わると「古い」と出る（Playground の架空の Host）。
 */
import { test, expect, nativeArtifact, save } from './fixtures';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { GraphDocument } from '@editor-platform/structured-graph/model';
import type { Page } from '@playwright/test';
import { activate, causeName, citedFmea, create } from './item-references-fixtures';

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
  const refs = page.getByRole('region', { name: '原因の候補', exact: true });
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
  // 版の書き込みが失敗しても、やり直して書けたときに選んだ版の証跡が届く
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (sessionStorage.getItem('simulateQuota'))
        throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return put.apply(this, args);
    };
    sessionStorage.setItem('simulateQuota', 'yes');
  });
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'この版を保存', exact: true })
    .click();
  await expect(page.getByRole('status').first()).toHaveText('Not saved');
  await page.evaluate(() => sessionStorage.removeItem('simulateQuota'));
  await page.getByRole('button', { name: 'Retry local save', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');

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

/** Opens the DFMEA's record form again (after a reload or another artifact). */
async function fmeaForm(page: Page) {
  await activate(page, /DFMEA/);
  await page.getByLabel('Data projection', { exact: true }).selectOption('Form');
  return page.getByRole('region', { name: '原因の候補', exact: true });
}

test('AR3 保存と再読み込みで引用が残り、残した・権限なし・確かめられない・引けない種類・重複・見つからないの状態を、値を変えずに出す', async ({
  page,
}) => {
  await page.goto('/');
  await citedFmea(page);
  await save(page, 1);
  const refsOf = async () =>
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[0]!.refs;

  // 再読み込みの後も、保存した引用と、その状態が出る
  await page.reload();
  let refs = await fmeaForm(page);
  const item = refs.getByRole('listitem').filter({ hasText: 'CC-01' });
  await expect(item).toContainText('設備温度の変動');
  await expect(item).toHaveAttribute('data-status', 'ok');

  // 本物の Host だけが返す状態は、Playground の差し替えで出し方を確かめる
  const shown: [string, object, string][] = [
    [
      'kept',
      { status: 'kept', title: '設備温度の変動', reason: '前の版のまま残す' },
      '古いまま：設備温度の変動（前の版のまま残す）',
    ],
    [
      'forbidden',
      { status: 'forbidden', reason: '読む権限がありません' },
      '権限なし：読む権限がありません',
    ],
    [
      'offline',
      { status: 'offline', reason: 'Host に届きません' },
      '確かめられない：Host に届きません',
    ],
    [
      'not-citable',
      { status: 'not-citable', reason: '故障原因は原因の候補だけを引けます' },
      '引けない種類：故障原因は原因の候補だけを引けます',
    ],
  ];
  for (const [status, state, text] of shown) {
    await page.evaluate(
      (s) => sessionStorage.setItem('ep-item-ref-states', JSON.stringify({ 'CC-01': s })),
      state,
    );
    await page.reload();
    refs = await fmeaForm(page);
    await expect(item).toHaveAttribute('data-status', status);
    await expect(item).toContainText(text);
    expect(await refsOf()).toEqual({ causeCandidates: ['CC-01'] });
  }
  // 確かめられない引用先は開けず、理由を出す
  await page.evaluate(
    (s) => sessionStorage.setItem('ep-item-ref-states', JSON.stringify({ 'CC-01': s })),
    { status: 'offline', reason: 'Host に届きません' },
  );
  await page.reload();
  refs = await fmeaForm(page);
  await refs.getByRole('button', { name: 'CC-01 を開く', exact: true }).click();
  await expect(refs.getByRole('alert')).toHaveText('開けません：確かめられない：Host に届きません');
  await page.evaluate(() => sessionStorage.removeItem('ep-item-ref-states'));

  // 同じ ID の原因がもう一つ保存されると、どちらとも決めずに「重複」と出す
  await create(page, 'structured-graph', ['Graph template', 'fishbone']);
  await causeName(page, '設備温度の変動', 'CC-01', '別の原因');
  await save(page, 1);
  refs = await fmeaForm(page);
  await expect(item).toHaveAttribute('data-status', 'duplicate');
  await expect(item).toContainText('重複');
  // 重複を外すと、もう一度ひとつに決まる
  await activate(page, /Structured Graph 2/);
  await causeName(page, '別の原因', 'CC-09', '別の原因');
  await save(page, 2);
  refs = await fmeaForm(page);
  await expect(item).toHaveAttribute('data-status', 'ok');

  // 引用先から消えると「見つからない」と出て、値はそのまま残る
  await activate(page, /Structured Graph 1/);
  await causeName(page, '設備温度の変動', 'CC-05', '設備温度の変動');
  await save(page, 2);
  refs = await fmeaForm(page);
  await expect(item).toHaveAttribute('data-status', 'unresolved');
  await expect(item).toContainText('見つからない');
  expect(await refsOf()).toEqual({ causeCandidates: ['CC-01'] });
});
