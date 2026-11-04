// Ordinary production UI rehearsal. Build, then run npm run preview -- --port 4173.
/* global document, DOMPoint */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { build } from 'esbuild';
import { pathToFileURL, URL } from 'node:url';
import { Buffer } from 'node:buffer';

const baseURL = process.env.FICTION_MAP_DEMO_URL || 'http://127.0.0.1:4173';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname))
  throw Error('Use a local production preview, not an external service.');
const output = path.resolve(process.env.FICTION_MAP_DEMO_OUTPUT || 'work/fiction-map-demo');
await mkdir(output, { recursive: true });
const fixture = path.join(output, 'scenario.mjs');
await build({
  entryPoints: ['scripts/fixtures/fiction-map-demo.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: fixture,
});
const { settingDemoArtifact, settingDemoContent } = await import(pathToFileURL(fixture).href);
const candidate = settingDemoArtifact('rough');
for (const stage of ['terrain', 'detailed'])
  await writeFile(path.join(output, `${stage}.json`), JSON.stringify(settingDemoContent(stage)));
await writeFile(path.join(output, 'candidate.json'), JSON.stringify(candidate));
const browser = await chromium.launch({
  headless: true,
  slowMo: 100,
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: output, size: { width: 1440, height: 900 } },
  acceptDownloads: true,
});
const page = await context.newPage().catch(async (error) => {
  await browser.close();
  throw error;
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const manifest = {
  source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeChanges: execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean),
  url: baseURL,
  status: 'FAIL',
  browser: browser.version(),
  viewport: '1440x900',
  provenance:
    'Authored synthetic geography/history brief; Codex-assisted native candidate, validated by public D1 API. No geographic dataset, built-in AI generator or physical simulation.',
  steps: [],
};
const button = (name) => page.getByRole('button', { name, exact: true });
async function caption(text) {
  manifest.steps.push(text);
  await page.evaluate((text) => {
    let element = document.getElementById('fiction-demo-caption');
    if (!element) {
      element = document.createElement('div');
      element.id = 'fiction-demo-caption';
      Object.assign(element.style, {
        position: 'fixed',
        bottom: '20px',
        left: '240px',
        right: '24px',
        padding: '14px 20px',
        borderRadius: '10px',
        background: '#163b42ed',
        color: 'white',
        font: '18px sans-serif',
        zIndex: '99999',
        pointerEvents: 'none',
        whiteSpace: 'pre-line',
      });
      document.body.append(element);
    }
    element.textContent = text;
  }, text);
  await setTimeout(6000); // Presentation pause only, not an acceptance timeout or benchmark.
}
async function download(name, file) {
  const pending = page.waitForEvent('download');
  await button(name).click();
  const result = await pending;
  await result.saveAs(path.join(output, file));
  return readFile(path.join(output, file));
}
async function native(file) {
  await button('Export artifact').click();
  const result = JSON.parse(await download('Export JSON', file));
  await page.keyboard.press('Escape');
  return result;
}
async function save(count, reason) {
  await button('Save version').click();
  if (reason) await page.getByLabel('Version reason', { exact: true }).fill(reason);
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'この版を保存', exact: true })
    .click();
  await button('History and compare').click();
  await expect(page.getByRole('tab', { name: `History (${count})`, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
}
async function library() {
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await button('Toggle library').click();
}
async function activate(name) {
  await library();
  await page
    .getByRole('navigation', { name: 'Artifacts', exact: true })
    .getByRole('button')
    .filter({ hasText: name })
    .click();
}
async function insertMap(label) {
  if (!(await button('参照を埋め込む').isVisible())) await button('More editor tools').click();
  await button('参照を埋め込む').click();
  await button('参照元を再取得').click();
  const select = page.getByLabel('埋め込みの参照元');
  const options = await select.locator('option').allTextContents();
  const index = options.findIndex((s) => s.includes(candidate.name) && s.includes(label));
  assert(index > 0);
  await select.selectOption(String(index - 1));
  await button('参照を配置').click();
  await page.keyboard.press('Escape');
}
async function selectFeature(name) {
  if (!(await page.getByLabel('Map details').isVisible()))
    await button('Layers and inspector').click();
  await page.locator('.fm-features').getByRole('button', { name, exact: true }).click();
}
async function dragVertex(name, dx, dy) {
  await button('Edit vertices').click();
  const vertex = button(`Vertex 1 of ${name}`);
  await vertex.scrollIntoViewIfNeeded();
  const box = await vertex.boundingBox();
  assert(box);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
  await button('Select').click();
}
async function moveVertexTo(name, index, point) {
  await button('Edit vertices').click();
  const vertex = button(`Vertex ${index} of ${name}`);
  await vertex.scrollIntoViewIfNeeded();
  const start = await vertex.boundingBox();
  assert(start);
  const target = await page.locator('[data-fiction-world]').evaluate((element, p) => {
    const matrix = element.getScreenCTM();
    if (!matrix) throw Error('Map projection is unavailable');
    const mapped = new DOMPoint(p[0], p[1]).matrixTransform(matrix);
    return { x: mapped.x, y: mapped.y };
  }, point);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();
  await button('Select').click();
}
try {
  await page.goto(baseURL);
  await caption(
    '設定 → 地図：西に海、中央に山脈、湿潤な西／乾いた東。\n制作者・Codex支援で配置案を作成。Editor内のAI生成機能ではありません。',
  );
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles(path.join(output, 'candidate.json'));
  await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
  await caption(
    '地理から配置理由へ：海港 → 渡河市場 → 峠 → 盆地市。\n最初は大まかな位置関係だけを置き、段階的に詳細化します。',
  );
  await page.screenshot({ path: path.join(output, 'rough-map.png') });
  await caption('1. ラフ：海・山・川・街の大まかな位置関係を確認。まず配置理由を考えます。');
  await save(1, '位置関係のラフ');
  const roughSaved = await native('kingdom-rough.json');
  const refinement = page.locator('.fm-native-input');
  await refinement.locator('summary').click();
  for (const [stage, explanation] of [
    [
      'terrain',
      '2. 地形を詳細化：海岸の湾・岬、山並み、森林、支流と湖を追加。ラフの地物IDを引き継ぎます。',
    ],
    [
      'detailed',
      '3. 暮らし・歴史：地形に沿う街道、南の道、尾根と川に沿う国境へ。候補をプレビューし、明示適用します。',
    ],
  ]) {
    await refinement
      .getByLabel('Refinement native JSON')
      .setInputFiles(path.join(output, stage + '.json'));
    await expect(refinement.getByAltText('Map refinement preview')).toBeVisible();
    await caption(explanation);
    await refinement.getByRole('button', { name: 'Apply map refinement', exact: true }).click();
    const staged = await native(`kingdom-${stage}.json`);
    assert.equal(staged.id, roughSaved.id);
    assert.deepEqual(staged.versions, roughSaved.versions);
    assert.deepEqual(staged.draft.content, settingDemoContent(stage));
    if (stage === 'terrain') {
      await button('Undo').first().click();
      assert.deepEqual(
        (await native('refinement-undo.json')).draft.content,
        roughSaved.draft.content,
      );
      await caption(
        '詳細化も1回のUndoでラフへ戻せます。元の保存版を保持し、別の履歴を作りません。',
      );
      await button('Redo').first().click();
      assert.deepEqual((await native('refinement-redo.json')).draft.content, staged.draft.content);
      await caption('Redoで地形の詳細化を再適用。次に街道・国境を仕上げます。');
    }

    await button('Fit map').click();
    await page
      .getByRole('application', { name: 'Fiction Map canvas' })
      .screenshot({ path: path.join(output, `${stage}-map.png`) });
    await caption(
      stage === 'terrain'
        ? '山脈の西側に森林、東に乾いた盆地。水系は左右の別流域へ。自動simulationではなく作者の配置案です。'
        : 'ラフ → 地形 → 生活・歴史を同じ地図で詳細化。個々の線・領域は後から手で編集できます。',
    );
  }
  await refinement.locator('summary').click();
  await page.screenshot({ path: path.join(output, 'geography.png') });
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await page.getByLabel('Named document view', { exact: true }).fill('交易圏');
  await page.getByLabel('View minX', { exact: true }).fill('150');
  await page.getByLabel('View maxX', { exact: true }).fill('950');
  await page.getByLabel('View maxY', { exact: true }).fill('620');
  await button('Save bounds as named view').click();
  await caption(
    '範囲とレイヤーを明示して「交易圏」を保存。\n詳細化した王朝末期の地図を確定版2へ。カメラや選択はnativeへ入りません。',
  );
  await save(2, '王朝末期・地形と生活を詳細化');
  const first = await native('kingdom-old-detailed.json');
  assert.equal(first.draft.content.features.length, settingDemoContent('detailed').features.length);
  assert.deepEqual(first.versions[0], roughSaved.versions[0]);
  const view = first.draft.content.namedViews.find((v) => v.name === '交易圏');
  assert(view);
  await page
    .getByLabel('Saved map view', { exact: true })
    .selectOption(JSON.stringify({ kind: 'named', id: view.id }));
  await download('Export map SVG', 'kingdom-old-detailed.svg');
  await download('Export map PNG', 'kingdom-old-detailed.png');
  await caption('確定版2からSVG／PNGを書き出し。\n詳細化した保存版を小説と漫画へ固定参照します。');
  await library();
  await button('小説デモを作成').click();
  await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'novel');
  await insertMap('交易圏');
  const novel = await native('novel-v1.json');
  await save(novel.versions.length + 1, '王朝末期の地図を固定参照');
  const savedNovel = await native('novel-saved.json');
  await expect(button('通読')).toBeEnabled();
  await button('通読').click();
  await expect(
    page.getByRole('article', { name: '通読', exact: true }).locator('img'),
  ).toBeVisible();
  await caption(
    '小説：専用画面の右欄から参照を挿入し、画像入りの保存章を通読。\n人物・場所設定と同じ右ペイン／明示的な保存版固定の操作です。',
  );
  await page
    .getByRole('article', { name: '通読', exact: true })
    .screenshot({ path: path.join(output, 'novel-reading.png') });
  await button('執筆').click();
  await library();
  await page.getByText('漫画を作成', { exact: true }).click();
  await button('漫画を新規作成').click();
  await button('Designで詳細編集').click();
  await page
    .getByRole('region', { name: 'Page reading order', exact: true })
    .getByRole('button', { name: 'Page 1', exact: true })
    .click();
  await insertMap('交易圏');
  for (const [key, value] of [
    ['width', '400'],
    ['height', '280'],
  ]) {
    const field = page.getByLabel(`Element ${key}`, { exact: true });
    await field.fill(value);
    await field.press('Tab');
  }
  const comic = await native('comic-v1.json');
  await save(comic.versions.length + 1, '王朝末期の地図を固定参照');
  await button('漫画ワークスペース').click();
  await caption(
    '漫画：同じ確定版2をページ内へ配置。\n画像の参照と人物・場所の意味的リンクは別の責務です。',
  );
  await page
    .locator('[data-workspace=manga]')
    .screenshot({ path: path.join(output, 'comic-fixed.png') });
  await activate(first.name);
  await caption(
    '歴史を変更：和約で南の渡しが新港へ。旧要塞は資料館へ。\n同じ地物のIDを保ち、現在のdraftだけを編集します。',
  );
  await selectFeature('南の渡し');
  await page.getByLabel('Feature name', { exact: true }).fill('和約港');
  await page.getByLabel('Feature x', { exact: true }).fill('240');
  await page.getByLabel('Feature y', { exact: true }).fill('520');
  await page
    .getByLabel('Feature description', { exact: true })
    .fill('和約後の新港。南の渡しと同じstable ID／World参照。');
  await button('Apply feature').click();
  const changed = await native('port-edited.json');
  await button('Undo').first().click();
  assert.equal(
    (await native('port-undo.json')).draft.content.features.find((f) => f.id === 'new-port').name,
    '南の渡し',
  );
  await button('Redo').first().click();
  assert.deepEqual((await native('port-redo.json')).draft.content, changed.draft.content);
  await selectFeature('王朝の要塞');
  await page.getByLabel('Feature name', { exact: true }).fill('要塞資料館');
  await button('Apply feature').click();
  await selectFeature('南の渡し道');
  await moveVertexTo('南の渡し道', 9, [240, 520]);
  await selectFeature('旧王国の領域');
  await dragVertex('旧王国の領域', 18, 10);
  await selectFeature('峠越え交易路');
  await dragVertex('峠越え交易路', 12, -8);
  await save(3, '和約後・港と国境の改訂');
  const second = await native('kingdom-treaty.json');
  assert.deepEqual(second.versions.slice(0, 2), first.versions);
  assert.notEqual(second.versions[2].contentHash, first.versions[1].contentHash);
  assert.deepEqual(
    second.draft.content.features.map((f) => f.id),
    first.draft.content.features.map((f) => f.id),
  );
  assert.deepEqual(
    second.draft.content.features.find((f) => f.id === 'new-port').worldEntityRef,
    first.draft.content.features.find((f) => f.id === 'new-port').worldEntityRef,
  );
  for (const id of ['old-border', 'trade-road', 'southern-track'])
    assert.notDeepEqual(
      second.draft.content.features.find((f) => f.id === id).geometry,
      first.draft.content.features.find((f) => f.id === id).geometry,
    );
  await page
    .getByLabel('Saved map version', { exact: true })
    .selectOption(second.versions[2].versionId);
  await page
    .getByLabel('Saved map view', { exact: true })
    .selectOption(JSON.stringify({ kind: 'named', id: view.id }));
  await download('Export map SVG', 'kingdom-treaty.svg');
  await download('Export map PNG', 'kingdom-treaty.png');
  await caption(
    '和約後を確定版3へ保存。ラフと王朝末期の版・hashは不変。\n旧要塞・国境・街道を残しながら、別の歴史の地図へ編集しました。',
  );
  await button('Fit map').click();
  await page
    .getByRole('application', { name: 'Fiction Map canvas' })
    .screenshot({ path: path.join(output, 'treaty-map.png') });
  await activate(comic.name);
  const comicImage = page.locator('[data-workspace=manga] image').first();
  await expect(comicImage).toBeVisible();
  const comicSrc = await comicImage.getAttribute('href');
  assert(comicSrc);
  const comicSvg = comicSrc.includes(';base64,')
    ? Buffer.from(comicSrc.slice(comicSrc.indexOf(',') + 1), 'base64').toString()
    : decodeURIComponent(comicSrc.slice(comicSrc.indexOf(',') + 1));
  assert(comicSvg.includes('南の渡し'));
  assert(!comicSvg.includes('和約港'));
  await caption(
    '漫画の固定地図も旧版のまま。小説・漫画のnativeとhistoryを地図の改訂で書き換えません。',
  );
  await activate(novel.name);
  await button('通読').click();
  const image = page.getByRole('article', { name: '通読', exact: true }).locator('img');
  await expect(image).toBeVisible();
  const svg = await image.getAttribute('src');
  assert(svg);
  const decoded = svg.includes(';base64,')
    ? Buffer.from(svg.slice(svg.indexOf(',') + 1), 'base64').toString()
    : decodeURIComponent(svg.slice(svg.indexOf(',') + 1));
  assert(decoded.includes('南の渡し'));
  assert(!decoded.includes('和約港'));
  await caption(
    '小説の地図は王朝末期のまま。新版やdraftへ自動追従しません。\n保存・版参照・画像出力を同じnativeから再現。実OS IMEは今回NOT RUNです。',
  );
  await page.reload();
  await expect(page.locator('[data-workspace=novel]')).toBeVisible();
  const reloaded = await native('novel-reloaded.json');
  assert.deepEqual(reloaded.versions, savedNovel.versions);
  assert.deepEqual(reloaded.draft.content, savedNovel.draft.content);
  assert.deepEqual(errors, []);
  manifest.versions = second.versions.map((v) => ({
    artifactId: v.artifactId,
    versionId: v.versionId,
    contentHash: v.contentHash,
  }));
  manifest.consumers = [
    { artifactId: novel.id, workspace: 'novel' },
    { artifactId: comic.id, workspace: 'manga' },
  ];
  manifest.status = 'PASS';
} catch (error) {
  manifest.error = String(error);
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  manifest.consoleErrors = errors;
  await context.close();
  await page.video().saveAs(path.join(output, 'fiction-map-demo.webm'));
  await browser.close();
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
