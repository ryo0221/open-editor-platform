import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { generatedPng } from '../fixtures/creative-host/generated-png';
import type {} from '../fixtures/creative-host/layer-generation';

let bundle: Promise<{ js: string; css: string }>;
async function open(page: Page, setting = false) {
  bundle ??= build({
    entryPoints: ['tests/fixtures/creative-host/layer-generation.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/layer-fixture-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((r) => ({
    js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css: r.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
  }));
  const files = await bundle;
  await page.route('**/layer-fixture.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await page.route('**/layer-fixture.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await page.route('**/layer-fixture-host*', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/layer-fixture.css"><div id="root"></div><script type="module" src="/layer-fixture.js"></script>',
    }),
  );
  await page.goto('/layer-fixture-host' + (setting ? '?setting=1' : ''));
  await expect(
    page.getByRole('heading', { name: setting ? '舞台設計' : 'キャラクター設計', exact: true }),
  ).toBeVisible();
  await closePanels(page);
  await page.getByText('ラフからレイヤー別に清書', { exact: true }).click();
}
async function closePanels(page: Page) {
  for (const label of [
    'Close 人物の部位',
    'Close 場所の部位',
    'Close 部位の編集',
    'Close Design navigator',
    'Close Design inspector',
  ]) {
    const close = page.getByRole('button', { name: label, exact: true });
    if (await close.isVisible()) await close.click();
  }
}
const button = (p: Page, n: string) => p.getByRole('button', { name: n, exact: true });
const snapshot = (p: Page) => p.evaluate(() => window.layerGenerationFixture.snapshot());
async function importRough(p: Page) {
  const src = generatedPng(128, 128, true);
  await p.getByLabel('ラフPNG', { exact: true }).setInputFiles({
    name: 'rough.png',
    mimeType: 'image/png',
    buffer: Buffer.from(src.split(',')[1], 'base64'),
  });
  await expect(p.getByAltText('取り込むPNGの確認')).toBeVisible();
  await p.getByLabel('清書画像の出典').fill('AI rough / fixture');
  await p.getByLabel('清書画像の利用条件').fill('Test author');
  await button(p, 'ラフをこのFrameへ配置').click();
  await expect(p.getByAltText('取り込むPNGの確認')).toHaveCount(0);
}
async function prepare(p: Page, setting = false) {
  for (const [key, value] of Object.entries({ x: 10, y: 12, width: 64, height: 64 }))
    await p.getByLabel(`清書範囲 ${key}`, { exact: true }).fill(String(value));
  await button(p, '清書レイヤーを追加').click();
  await p
    .getByLabel('この部位への指示')
    .fill(setting ? '屋根だけを共通ラフに合わせて清書' : '前髪だけを共通ラフに合わせて清書');
  await button(p, '保存して生成依頼を準備').click();
  await expect(p.getByAltText('生成に使う共通ラフ')).toBeVisible();
  expect(
    await p.locator('.creative-generation').evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
}
for (const setting of [false, true])
  test(`${setting ? 'Setting' : 'Character'} rough correction, Host generation, native preview/reject/apply/history and exact reload`, async ({
    page,
  }, info) => {
    await open(page, setting);
    await importRough(page);
    const rough = (await snapshot(page)).content.elements.find((e) => e.name === 'ラフ画像')!;
    // Reuse native owned-PNG editing to correct the generated rough by hand.
    await button(page, '標準ツールでラフを修正').click();
    if (!(await page.getByLabel('Search layers').isVisible()))
      await button(page, 'Toggle Design navigator').click();
    await page.getByLabel('Search layers').fill('ラフ画像');
    await button(page, 'Layer ラフ画像').click();
    await button(page, 'Close Design navigator').click();
    if (
      !(await page
        .getByRole('complementary', { name: 'Design inspector', exact: true })
        .isVisible())
    )
      await button(page, 'Toggle Design inspector').click();
    await button(page, '画像を直接描き直す').click();
    const dialog = page.getByRole('dialog', { name: '画像レイヤーを直接編集', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'ブラシ', exact: true })).toBeEnabled();
    const canvas = dialog.getByRole('application', { name: '画像ピクセル編集', exact: true }),
      box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.3, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await closePanels(page);
    await expect
      .poll(async () => (await snapshot(page)).content.elements.find((e) => e.id === rough.id)?.src)
      .not.toBe(rough.src);
    const paintedRough = (await snapshot(page)).content.elements.find((e) => e.id === rough.id)!;
    expect(paintedRough.provenance?.lineage).toContainEqual(
      expect.objectContaining({
        source: 'AI rough / fixture',
        license: 'Test author',
        src: rough.src,
      }),
    );
    await button(page, 'このFrameをラフの基準版に保存').click();
    await expect(page.getByText('ラフの基準版を保存しました', { exact: true })).toBeVisible();
    const pinned = (await snapshot(page)).mapping;
    await button(page, '基準ラフを隠す').click();
    await prepare(page, setting);
    const before = (await snapshot(page)).content;
    await button(page, 'Hostへ生成を依頼').click();
    await expect(page.getByRole('region', { name: '清書結果の比較' })).toBeVisible();
    expect((await snapshot(page)).content).toEqual(before);
    await button(page, '清書結果を却下').click();
    expect((await snapshot(page)).content).toEqual(before);
    await button(page, 'Hostへ生成を依頼').click();
    await page
      .locator('.creative-generation')
      .screenshot({ path: info.outputPath(`layer-preview-${info.project.name}.png`) });
    await button(page, '清書結果を適用').click();
    const after = (await snapshot(page)).content,
      clean = after.elements.find((e) => e.name === (setting ? '屋根の清書' : '前髪の清書'))!;
    expect(clean.provenance?.source).toContain('Deterministic E2E fixture');
    expect(clean.provenance?.source).not.toContain('AI rough');
    expect(clean.provenance?.lineage).toContainEqual(
      expect.objectContaining({
        source: 'AI rough / fixture',
        license: 'Test author',
        src: rough.src,
      }),
    );
    expect(after.elements.filter((e) => e.id !== clean.id)).toEqual(
      before.elements.filter((e) => e.id !== clean.id),
    );
    await button(page, '元に戻す').click();
    expect((await snapshot(page)).content).toEqual(before);
    await button(page, 'やり直す').click();
    expect((await snapshot(page)).content).toEqual(after);
    await button(page, '設定と設定画を保存').click();
    await expect(page.locator('.creative-actions [role="status"]')).toHaveText('保存しました');
    const saved = await snapshot(page);
    expect(JSON.stringify(saved.mapping)).toContain(
      JSON.stringify((pinned as { bindings: { rough: unknown }[] }).bindings[0].rough),
    );
    await page.screenshot({
      path: info.outputPath(`layer-${setting ? 'setting' : 'character'}-${info.project.name}.png`),
      fullPage: true,
    });
    await page.reload();
    await expect(
      page.getByRole('heading', { name: setting ? '舞台設計' : 'キャラクター設計', exact: true }),
    ).toBeVisible();
    expect((await snapshot(page)).content).toEqual(saved.content);
    expect(
      (await snapshot(page)).content.elements.find((e) => e.id === clean.id)?.provenance?.lineage,
    ).toContainEqual(
      expect.objectContaining({ source: 'AI rough / fixture', license: 'Test author' }),
    );
    expect((await snapshot(page)).mapping).toEqual(saved.mapping);
  });

test('unconnected Host exports a request and admits an external PNG through the same proposal contract', async ({
  page,
}) => {
  await page.goto('/creative-design.html');
  await button(page, '設定画を作る').click();
  await closePanels(page);
  await page.getByText('ラフからレイヤー別に清書', { exact: true }).click();
  await button(page, 'このFrameをラフの基準版に保存').click();
  await expect(page.getByText('ラフの基準版を保存しました', { exact: true })).toBeVisible();
  await prepare(page);
  await expect(page.getByText('生成Hostは未接続です。', { exact: false })).toBeVisible();
  const pending = page.waitForEvent('download');
  await button(page, '生成依頼JSONを書き出す').click();
  const download = await pending;
  const request = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(request.target.pixelWidth).toBe(64);
  expect(request.rough.versionId).toBeTruthy();
  await page.getByLabel('清書結果PNG').setInputFiles({
    name: 'clean.png',
    mimeType: 'image/png',
    buffer: Buffer.from(generatedPng(64, 64).split(',')[1], 'base64'),
  });
  await expect(page.getByAltText('取り込むPNGの確認')).toBeVisible();
  await page.getByLabel('清書画像の出典').fill('External service / run-2');
  await page.getByLabel('清書画像の利用条件').fill('Author');
  await button(page, '清書結果をプレビュー').click();
  await expect(page.getByAltText('清書の変更後')).toBeVisible();
  await button(page, '清書結果を適用').click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const outcome of ['resolve', 'reject'] as const)
  test(`abort-ignoring Host: retry before old ${outcome} settles, keep new busy and native history`, async ({
    page,
  }, info) => {
    await open(page);
    await importRough(page);
    await button(page, 'このFrameをラフの基準版に保存').click();
    await expect(page.getByText('ラフの基準版を保存しました', { exact: true })).toBeVisible();
    await prepare(page);
    const before = await snapshot(page);
    await page.evaluate(() => window.layerGenerationFixture.holdProvider(true));
    await button(page, 'Hostへ生成を依頼').click();
    await expect
      .poll(() => page.evaluate(() => window.layerGenerationFixture.requests.length))
      .toBe(1);
    await button(page, '処理を中止').click();
    await expect(button(page, 'Hostへ生成を依頼')).toBeEnabled();
    await expect(page.getByLabel('清書結果PNG')).toBeEnabled();
    expect(await snapshot(page)).toEqual(before);
    // No release of the first provider has occurred at this point.
    await button(page, 'Hostへ生成を依頼').click();
    await expect
      .poll(() => page.evaluate(() => window.layerGenerationFixture.requests.length))
      .toBe(2);
    await page.evaluate(
      (outcome) => window.layerGenerationFixture.releaseProvider(0, outcome),
      outcome,
    );
    await expect.poll(() => page.evaluate(() => window.layerGenerationFixture.settled)).toBe(1);
    await expect(button(page, 'Hostへ生成を依頼')).toBeDisabled();
    await expect(button(page, '処理を中止')).toBeVisible();
    expect(await snapshot(page)).toEqual(before);
    await expect(page.getByRole('region', { name: '清書結果の比較' })).toHaveCount(0);
    await page
      .locator('.creative-generation')
      .screenshot({ path: info.outputPath(`canceled-${outcome}-${info.project.name}.png`) });
    await page.evaluate(() => window.layerGenerationFixture.releaseProvider(1, 'resolve'));
    await expect(page.getByRole('region', { name: '清書結果の比較' })).toBeVisible();
    const preview = await snapshot(page);
    expect(preview.proposalCount).toBe(1);
    expect(preview.content).toEqual(before.content);
    expect(preview.revision).toEqual(before.revision);
    await button(page, '清書結果を適用').click();
    const after = await snapshot(page);
    expect(after.content.elements.some((e) => e.provenance?.source.includes('run-2'))).toBe(true);
    expect(after.content.elements.some((e) => e.provenance?.source.includes('run-1'))).toBe(false);
    await button(page, '元に戻す').click();
    expect((await snapshot(page)).content).toEqual(before.content);
    await button(page, 'やり直す').click();
    expect((await snapshot(page)).content).toEqual(after.content);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
