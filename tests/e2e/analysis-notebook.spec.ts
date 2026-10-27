import { test, expect, create, nativeArtifact, save } from './fixtures';
import { analysisFixture } from '../../packages/analysis-core/src/fixtures';
import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { calculateRun } from '@editor-platform/analysis-core';
test('AN01/06/10 independent Host edits, runs, undoes, saves and reloads', async ({
  page,
}, testInfo) => {
  await page.goto('/analysis-host.html');
  const surface = page.getByRole('region', { name: '計算・分析ノート' });
  await expect(surface).toBeVisible();
  await page.getByLabel('Quantity (number)').check();
  await page.getByLabel('Price (number)').check();
  await page.getByRole('button', { name: '入力を追加', exact: true }).click();
  await page.getByRole('combobox', { name: '式の編集方法', exact: true }).selectOption('json');
  await page.getByLabel('型付き式（JSON AST）').fill(
    JSON.stringify({
      op: 'multiply',
      left: { op: 'field', id: 'qty' },
      right: { op: 'field', id: 'price' },
    }),
  );
  await page.getByLabel('結果列名', { exact: true }).fill('Revenue');
  await page.getByRole('button', { name: 'Stepを追加', exact: true }).click();
  await page.getByRole('combobox', { name: '演算', exact: true }).selectOption('aggregate');
  const revenue = await page
    .getByRole('combobox', { name: '列', exact: true })
    .locator('option')
    .allTextContents();
  const label = revenue.find((v) => v.startsWith('Revenue'))!;
  await page.getByRole('combobox', { name: '列', exact: true }).selectOption({ label });
  await page.getByRole('button', { name: 'Stepを追加', exact: true }).click();
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
  await page
    .getByRole('region', { name: '計算・分析ノート', exact: true })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toHaveCount(0);
  await page
    .getByRole('region', { name: '計算・分析ノート', exact: true })
    .getByRole('button', { name: 'Redo', exact: true })
    .click();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('保存しました。');
  await page.reload();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
  const title = page.getByLabel('タイトル', { exact: true });
  await title.dispatchEvent('compositionstart');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(surface.getByRole('alert')).toContainText('IME');
  await title.dispatchEvent('compositionend');
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Native JSON出力（入力・過去結果を含む）', exact: true })
    .click();
  const download = await downloadPromise,
    nativePath = testInfo.outputPath('analysis-native.json');
  await download.saveAs(nativePath);
  await page.getByLabel('Native JSON読込').setInputFiles(nativePath);
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('analysis-independent.png'), fullPage: true });
});
test('AN06/07 normal Playground imports, edits, runs and exports the native analysis', async ({
  page,
}, testInfo) => {
  const document = await analysisFixture();
  document.outputs[0].presentation = 'chart';
  const artifact = await commitVersion(
    createArtifact('analysis', '売上分析', document),
    'local',
    'Fixture',
  );
  await page.goto('/');
  const input = page.locator('input[type=file]').first();
  await input.setInputFiles({
    name: 'analysis.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...artifact, annotations: [] })),
  });
  await expect(page.locator('.ep-analysis:visible').last()).toBeVisible();
  await expect(page.locator('.ProseMirror')).toHaveCount(0);
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
  await expect(
    page.getByRole('img', { name: '分析Chart（描画値は近似）', exact: true }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: '実行条件', exact: true }).selectOption('higher');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('cell', { name: '88', exact: true })).toBeVisible();
  const firstRun = await page
    .getByRole('combobox', { name: '比較元run', exact: true })
    .locator('option')
    .nth(1)
    .getAttribute('value');
  const firstRunText = await page
    .getByRole('combobox', { name: '比較元run', exact: true })
    .locator('option')
    .nth(1)
    .textContent();
  await page
    .getByRole('combobox', { name: '比較元run', exact: true })
    .selectOption(firstRun ?? firstRunText!);
  await expect(
    page.getByLabel('条件別差分').getByRole('cell', { name: '8', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('条件別差分')).toContainText('Factor:');
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV出力（静的）', exact: true }).click();
  expect((await csvDownload).suggestedFilename()).toBe('analysis.csv');
  await page.getByRole('button', { name: '通常Dataへ静的コピー', exact: true }).click();
  await expect(
    page.getByText('独立したDataへコピーしました。数値は精度を保つtext列です。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('cell', { name: '88', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('analysis-playground.png'), fullPage: true });
  await create(page, 'analysis');
  await expect(page.locator('.ep-analysis:visible').last()).toBeVisible();
  await expect(page.locator('.ProseMirror')).toHaveCount(0);
});
test('AN12 imported forged run is rejected atomically', async ({ page }) => {
  const document = await analysisFixture();
  const run = await calculateRun(document, 'run');
  run.results['total-output'].rows[0].values.total = '999';
  const artifact = createArtifact('analysis', 'Forged', { ...document, runs: [run] });
  await page.goto('/analysis-host.html');
  await page.getByLabel('Native JSON読込').setInputFiles({
    name: 'forged.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await expect(page.getByRole('alert').first()).toContainText('unverified-result');
  await expect(page.getByRole('cell', { name: '999', exact: true })).toHaveCount(0);
});
for (const kind of ['document', 'slide', 'design', 'whiteboard'])
  for (const mode of ['fixed', 'follow']) {
    test(`AN17/18 normal ${kind} places ${mode} verified Analysis and captures native history`, async ({
      page,
    }, info) => {
      const document = await analysisFixture();
      document.runs = [await calculateRun(document, 'saved-run')];
      const artifact = await commitVersion(
        createArtifact('analysis', '参照する分析', document),
        'local',
        'Fixture',
      );
      await page.goto('/');
      await page
        .locator('input[type=file]')
        .first()
        .setInputFiles({
          name: 'source.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ ...artifact, annotations: [] })),
        });
      await expect(page.locator('.ep-analysis:visible')).toBeVisible();
      await save(page, 2);
      await expect(
        page.getByRole('dialog', { name: 'Save immutable version', exact: true }),
      ).toBeHidden();
      await create(page, kind);
      await expect(page.locator('.ep-analysis')).toHaveCount(0);
      const button = page.getByRole('button', { name: '参照を埋め込む', exact: true });
      if (!(await button.isVisible()))
        await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
      await button.click();
      const dialog = page.getByRole('dialog', { name: '参照を埋め込む', exact: true });
      const select = dialog.getByLabel('埋め込みの参照元', { exact: true });
      await expect(select.locator('option')).not.toHaveCount(0);
      const option = await select
        .locator('option')
        .evaluateAll((options) =>
          options
            .find((o) => o.textContent?.includes('現在の結果') && o.textContent.includes('table'))
            ?.getAttribute('value'),
        );
      expect(option).toBeTruthy();
      await select.selectOption(option!);
      await dialog.getByLabel('埋め込みの更新方式', { exact: true }).selectOption(mode);
      await dialog.getByRole('button', { name: '参照を配置', exact: true }).click();
      await expect(dialog.getByRole('button', { name: '参照を配置', exact: true })).toBeEnabled();
      await page.keyboard.press('Escape');
      const exported = await nativeArtifact(page);
      expect(JSON.stringify(exported.draft.content)).toContain('"domain":"analysis"');
      expect(JSON.stringify(exported.draft.content)).toContain('"mode":"' + mode + '"');
      expect(JSON.stringify(exported.draft.content)).toContain('"total":"80"');
      await save(page, 1);
      if (kind === 'document') await page.locator('.ProseMirror img').click();
      if (!(await page.getByRole('button', { name: '元を編集', exact: true }).isVisible()))
        await page
          .getByRole('button', { name: /^Toggle (Slide|Document|Design|Board) inspector$/ })
          .click();
      await page.getByRole('button', { name: '元を編集', exact: true }).click();
      await expect(page.locator('.ProseMirror')).toHaveCount(0);
      await page.getByRole('textbox', { name: 'Factor · factor', exact: true }).fill('1.1');
      await page.getByRole('button', { name: '実行', exact: true }).click();
      await expect(page.getByRole('cell', { name: '88', exact: true })).toBeVisible();
      await save(page, 3);
      await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
      const updated = await nativeArtifact(page);
      expect(JSON.stringify(updated.draft.content)).toContain(
        mode === 'follow' ? '"total":"88"' : '"total":"80"',
      );
      expect(JSON.stringify(updated.versions.at(-1)?.content)).toContain('"total":"80"');
      expect(JSON.stringify(updated.versions.at(-1)?.content)).not.toContain('"total":"88"');

      await page.screenshot({
        path: info.outputPath(`analysis-${kind}-${mode}.png`),
        fullPage: true,
      });
    });
  }
test('AN10 Artifact Host production edits and persists an Analysis through its ordinary lifecycle', async ({
  page,
}, info) => {
  const document = await analysisFixture(),
    artifact = createArtifact('analysis', 'Artifact Host analysis', document);
  await page.goto('http://127.0.0.1:4177');
  await page.locator('input[type=file]').setInputFiles({
    name: 'analysis.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await page.getByRole('button', { name: 'Artifact Host analysisを開く', exact: true }).click();
  await expect(page.getByRole('region', { name: '計算・分析ノート' })).toBeVisible();
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await expect(page.getByRole('region', { name: '成果物一覧' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Artifact Host analysisを開く', exact: true }).click();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
  await page.getByLabel('閲覧モード', { exact: true }).check();
  await expect(page.getByRole('button', { name: '実行', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Factor · factor', { exact: true })).toBeDisabled();
  await page.getByLabel('閲覧モード', { exact: true }).uncheck();
  await page.getByRole('cell', { name: '80', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('analysis-artifact-host.png'), fullPage: true });
});
test('AN15/19 ordinary source-update trial is non-mutating, rejectable and accepted with one Undo', async ({
  page,
}) => {
  const { updateDraft } = await import('@editor-platform/artifact-core');
  const { retainData, isAnalysis } = await import('@editor-platform/analysis-core');
  const document = await analysisFixture();
  const oldNative = document.retainedSources[0].nativeContent as {
    schemaVersion: number;
    columns: { id: string; name: string; type: string }[];
    rows: { id: string; values: { qty: number; price: number } }[];
  };
  let data = await commitVersion(createArtifact('data', '更新する売上', oldNative), 'local', 'v1');
  const newNative = structuredClone(oldNative);
  newNative.rows[0].values.qty = 4;
  newNative.columns.find((c) => c.id === 'qty')!.id = 'qty_v2';
  for (const row of newNative.rows) {
    const values = row.values as unknown as Record<string, number>;
    values.qty_v2 = values.qty;
    delete values.qty;
  }
  data = await commitVersion(updateDraft(data, newNative), 'local', 'v2');
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'data.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...data, annotations: [] })),
    });
  const imported = await nativeArtifact(page),
    first = imported.versions[0];
  const retained = await retainData(
    {
      artifactId: imported.id,
      domain: 'data',
      versionId: first.versionId,
      contentHash: first.contentHash,
    },
    first.content,
    ['qty', 'price'],
  );
  document.retainedSources = [retained];
  document.inputs[0].snapshotKey = retained.key;
  document.runs = [await calculateRun(document, 'old')];
  const artifact = createArtifact('analysis', '新版を試算するノート', document);
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'analysis.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...artifact, annotations: [] })),
    });
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
  await page
    .getByRole('combobox', { name: '新版の対応列 qty', exact: true })
    .selectOption('qty_v2');
  await page.getByRole('button', { name: '新版で試算', exact: true }).click();
  const proposal = page.getByRole('region', { name: '提案差分', exact: true });
  await expect(proposal.getByRole('cell', { name: '20', exact: true })).toBeVisible();
  const before = await nativeArtifact(page);
  expect(isAnalysis(before.draft.content)).toBe(true);
  if (!isAnalysis(before.draft.content)) throw Error('fixture');
  expect(before.draft.content.runs).toHaveLength(1);
  expect(before.draft.content.inputs[0].snapshotKey).toBe(retained.key);
  await page.getByRole('button', { name: '提案を破棄', exact: true }).click();
  await expect(proposal).toHaveCount(0);
  await page.getByRole('button', { name: '新版で試算', exact: true }).click();
  await expect(proposal.getByRole('cell', { name: '20', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '差分を採用', exact: true }).click();
  await expect(page.getByRole('cell', { name: '100', exact: true })).toBeVisible();
  await page
    .getByRole('region', { name: '計算・分析ノート', exact: true })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(page.getByRole('cell', { name: '80', exact: true })).toBeVisible();
  await page
    .getByRole('region', { name: '計算・分析ノート', exact: true })
    .getByRole('button', { name: 'Redo', exact: true })
    .click();
  await expect(page.getByRole('cell', { name: '100', exact: true })).toBeVisible();
});

test('historical scenario output survives condition deletion, CSV and reload', async ({ page }) => {
  const document = await analysisFixture();
  document.runs = [await calculateRun(document, 'saved-higher', 'higher')];
  const savedRuns = structuredClone(document.runs);
  const artifact = createArtifact('analysis', 'Historical scenario', document);
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'historical-analysis.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...artifact, annotations: [] })),
    });
  const result = page.getByRole('region', { name: '計算結果', exact: true });
  await expect(result.getByRole('cell', { name: '88', exact: true })).toBeVisible();
  await page.getByText('条件JSONを編集（複製・並替・mapping・Chart設定）', { exact: true }).click();
  await page.getByRole('button', { name: '現在の条件を読む', exact: true }).click();
  const recipe = page.getByLabel('条件JSON', { exact: true });
  const next = JSON.parse(await recipe.inputValue());
  next.scenarios = [];
  await recipe.fill(JSON.stringify(next));
  await page.getByRole('button', { name: '条件を確定', exact: true }).click();
  await expect(result.getByRole('cell', { name: '88', exact: true })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV出力（静的）', exact: true }).click();
  const download = await pending;
  const { readFile } = await import('node:fs/promises');
  expect(await readFile((await download.path())!, 'utf8')).toContain('88');
  expect((await nativeArtifact(page)).draft.content).toMatchObject({
    scenarios: [],
    runs: savedRuns,
  });
  await page.reload();
  await expect(result.getByRole('cell', { name: '88', exact: true })).toBeVisible();
});
