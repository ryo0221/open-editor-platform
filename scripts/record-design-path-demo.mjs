// Records the ordinary production UI. Run npm run build and npm run preview first.
/* global document */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { URL } from 'node:url';

const baseURL = process.env.DESIGN_DEMO_URL || 'http://127.0.0.1:4173';
const output = path.resolve(process.env.DESIGN_DEMO_OUTPUT || 'work/issue-502/demo');
const url = new URL(baseURL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw Error('The rehearsal recorder requires a local preview Host.');
await mkdir(output, { recursive: true });
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ executablePath, headless: true, slowMo: 100 });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: output, size: { width: 1440, height: 900 } },
  acceptDownloads: true,
});
await context.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const cursor = document.createElement('div');
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '-100px',
      top: '-100px',
      width: '16px',
      height: '16px',
      border: '2px solid #ed6549',
      borderRadius: '50%',
      background: '#ed654933',
      zIndex: '100000',
      pointerEvents: 'none',
      transform: 'translate(-50%, -50%)',
    });
    document.body.append(cursor);
    document.addEventListener('pointermove', (e) => {
      cursor.style.left = `${e.clientX}px`;
      cursor.style.top = `${e.clientY}px`;
    });
    document.addEventListener('pointerdown', () => {
      cursor.style.background = '#ed6549aa';
    });
    document.addEventListener('pointerup', () => {
      cursor.style.background = '#ed654933';
    });
  });
});
const page = await context.newPage().catch(async (error) => {
  await browser.close();
  throw error;
});
page.setDefaultTimeout(20_000);
page.setDefaultNavigationTimeout(30_000);
const video = page.video();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const button = (name) => page.getByRole('button', { name, exact: true });
const hold = (ms = 1400) => setTimeout(ms);
const manifest = {
  source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  url: baseURL,
  viewport: '1440x900',
  status: 'FAIL',
  scope: 'Integration-candidate rehearsal; presentation pauses and recording are not a benchmark.',
};
async function chapter(text, persist = false) {
  manifest.step = text;
  await page.evaluate((text) => {
    let box = document.getElementById('design-demo-caption');
    if (!box) {
      box = document.createElement('div');
      box.id = 'design-demo-caption';
      Object.assign(box.style, {
        position: 'fixed',
        bottom: '48px',
        left: '240px',
        maxWidth: '720px',
        padding: '12px 18px',
        borderRadius: '10px',
        color: 'white',
        background: '#193e35ee',
        font: '18px sans-serif',
        zIndex: '99999',
        pointerEvents: 'none',
        transition: 'opacity 0.2s',
      });
      document.body.append(box);
    }
    box.textContent = `統合候補デモ｜${text}`;
    box.style.opacity = '1';
  }, text);
  await hold();
  if (!persist)
    await page.evaluate(() => {
      document.getElementById('design-demo-caption').style.opacity = '0';
    });
}
async function drag(name, dx, dy) {
  const box = await button(name).boundingBox();
  assert(box);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(x + (dx * i) / 16, y + (dy * i) / 16);
    await hold(25);
  }
  await page.mouse.up();
}
async function download(action, name) {
  const pending = page.waitForEvent('download');
  await action();
  const item = await pending;
  const file = path.join(output, name);
  await item.saveAs(file);
  return file;
}
async function native(name = 'design-native.json') {
  await button('Export artifact').click();
  const file = await download(() => button('Export JSON').click(), name);
  await page.keyboard.press('Escape');
  return JSON.parse(await readFile(file, 'utf8'));
}
try {
  await page.goto(baseURL);
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await button('Toggle library').click();
  await expect(page.getByLabel('Artifact type', { exact: true })).toBeVisible();
  await page.getByLabel('Artifact type', { exact: true }).selectOption('design');
  await page.getByRole('button', { name: 'New artifact' }).click();
  await page.getByLabel('Artifact name', { exact: true }).fill('Bézier path demo');
  await page.getByLabel('Artifact name', { exact: true }).press('Enter');
  await chapter('1. 通常Designで三次Bézierパスを追加');
  await button('Add cubic path').click();
  await button('Edit path points').click();
  await chapter('2. ハンドルとアンカーをドラッグ');
  await drag('Handle 1.1.c1', 35, -25);
  await drag('Anchor 1.1', -50, 30);
  await chapter('3. 数値入力とsymmetricで両側のハンドルを連動');
  await page.getByLabel('Path point', { exact: true }).selectOption({ label: 'Anchor 1.2' });
  await page.getByLabel('Anchor mode', { exact: true }).selectOption('symmetric');
  await page.getByLabel('Path point Y', { exact: true }).fill('25');
  await page.getByLabel('Path point Y', { exact: true }).press('Enter');
  await drag('Handle 1.2.c1', 20, -25);
  await button('Fit path points').click();
  await page.screenshot({ path: path.join(output, 'design-points.png') });
  await chapter('4. ひとつの操作をUndo / Redo');
  const stage = page.getByRole('application', { name: 'Design canvas', exact: true });
  const curve = stage.locator('path[fill-rule]').first();
  const edited = await curve.getAttribute('d');
  await button('Undo').click();
  await expect(curve).not.toHaveAttribute('d', edited);
  await hold();
  await button('Redo').click();
  await expect(curve).toHaveAttribute('d', edited);
  await hold();
  await button('Finish point editing').click();
  await chapter('5. Copy / Pasteして、要素全体の位置を変更');
  await stage.focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.getByLabel('Element x', { exact: true }).fill('360');
  await page.getByLabel('Element x', { exact: true }).press('Enter');
  await button('Fit design').click();
  await chapter('6. 通常Hostで版を保存');
  await button('Save version').click();
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'この版を保存', exact: true })
    .click();
  await expect(page.locator('.save-status')).toContainText('Saved locally');
  const saved = await native();
  assert.equal(saved.draft.content.schemaVersion, 3);
  assert.equal(saved.draft.content.elements.filter((e) => e.path).length, 2);
  await chapter('7. 再読込し、native JSONの内容一致を確認');
  await page.reload();
  await button('Fit design').click();
  const reloaded = await native('design-reloaded.json');
  assert.deepEqual(reloaded.draft.content, saved.draft.content);
  await chapter('8. 書き出したnative JSONを通常のImportへ戻す');
  await button('Toggle library').click();
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles(path.join(output, 'design-native.json'));
  await expect(page.locator('nav[aria-label="Artifacts"] button')).toHaveCount(2);
  const imported = await native('design-imported.json');
  assert.notEqual(imported.id, saved.id);
  assert.deepEqual(imported.draft.content, saved.draft.content);
  assert.deepEqual(
    imported.versions.map((v) => v.contentHash),
    saved.versions.map((v) => v.contentHash),
  );
  await button('Fit design').click();
  await chapter('9. SVGとPNGへ出力');
  await button('Export design').click();
  const svg = await download(() => button('Export all SVG').click(), 'design.svg');
  assert.match(await readFile(svg, 'utf8'), /<path[^>]+d="[^"]*C/);
  await page.keyboard.press('Escape');
  await button('Export design').click();
  const png = await download(() => button('Export all PNG').click(), 'design.png');
  assert.equal((await readFile(png)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await page.keyboard.press('Escape');
  await chapter('追加 → 点編集 → 履歴 → 保存・再読込 → native JSON → SVG / PNG', true);
  await page.screenshot({ path: path.join(output, 'design-demo.png') });
  await hold(2500);
  assert.deepEqual(errors, [], 'Browser errors');
  manifest.status = 'PASS';
  manifest.checks = [
    'schema3',
    'two independent paths',
    'saved/reloaded native equality',
    'native import equality with retained version hashes',
    'Undo/Redo restores the edited curve',
    'SVG cubic',
    'PNG signature',
    'zero browser errors',
  ];
} catch (error) {
  manifest.failure = error.message;
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await context.close();
  if (video) await video.saveAs(path.join(output, 'design-demo.webm'));
  await browser.close();
  manifest.browserErrors = errors;
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
process.stdout.write(`${output}\n`);
