// Record real local UI after builds/tests. Raw video/screenshots/manifests stay outside Git.
/* global document */
import { chromium, expect, devices } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const baseURL = process.env.STORY_BOARD_DEMO_URL || 'http://127.0.0.1:4177';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname))
  throw Error('Use a local production preview; this recorder does not publish or deploy.');
const output = path.resolve(process.env.STORY_BOARD_DEMO_OUTPUT || '/tmp/issue-660-demo');
await mkdir(output, { recursive: true });
const manifest = {
  source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  trackedDiff: execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }).trim(),
  url: baseURL,
  status: 'FAIL',
  scope: 'Real UI with assertions and presentation pauses; not a benchmark or OS IME acceptance.',
  chapters: [],
};
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
  headless: true,
  slowMo: 100,
});
const errors = [];
async function record(mobile) {
  const size = mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
  const context = await browser.newContext({
    ...(mobile ? devices['iPhone 13'] : {}),
    viewport: size,
    recordVideo: { dir: output, size },
  });
  const page = await context.newPage();
  const video = page.video();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const pause = (ms = 1600) => setTimeout(ms);
  async function chapter(text) {
    manifest.chapters.push({ viewport: mobile ? 'mobile' : 'desktop', text });
    await page.evaluate((text) => {
      let caption = document.getElementById('story-board-demo-caption');
      if (!caption) {
        caption = document.createElement('div');
        caption.id = 'story-board-demo-caption';
        Object.assign(caption.style, {
          position: 'fixed',
          bottom: '16px',
          left: '16px',
          right: '16px',
          padding: '12px 16px',
          borderRadius: '8px',
          background: '#174b40ed',
          color: 'white',
          font: '16px system-ui,sans-serif',
          zIndex: '99999',
          pointerEvents: 'none',
        });
        document.body.append(caption);
      }
      caption.textContent = text;
    }, text);
    await pause();
  }
  try {
    await page.goto(`${baseURL}/story-board.html`);
    await button('10人の物語ボードを作る').click();
    const cursor = page.getByRole('slider', { name: '共通の時点', exact: true });
    await expect(cursor).toHaveValue('3');
    if (mobile) {
      await chapter('狭い画面では同じ条件の一覧から。人物の所在と出来事を確認できます。');
      await expect(page.locator('[data-board-position]')).toHaveCount(11);
      await cursor.focus();
      await page.keyboard.press('ArrowRight');
      await expect(cursor).toHaveValue('4');
      await pause();
      await page
        .getByRole('combobox', { name: '保存した表示', exact: true })
        .selectOption({ label: '遠征組' });
      await expect(page.locator('[data-board-position]')).toHaveCount(3);
      await chapter('遠征組の3人を選択。表示条件はキャンバスと共通です。');
      await button('キャンバスへ').click();
      await button('Fit board').click();
      await expect(page.locator('[data-board-lane]')).toHaveCount(3);
      await chapter('キャンバスへ切り替えて全体を確認。拡大・パンも既存Whiteboardの操作です。');
    } else {
      await button('Fit board').click();
      await expect(page.locator('[data-board-lane]')).toHaveCount(11);
      await chapter('10人・3地点の同時進行を一枚に。別世界の同名個体は別レーンです。');
      await page.screenshot({ path: path.join(output, 'story-board-desktop.png') });
      const before = await page
        .locator('[data-board-map-marker]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
      await cursor.focus();
      await page.keyboard.press('ArrowRight');
      await expect(cursor).toHaveValue('4');
      assert.notDeepEqual(
        await page
          .locator('[data-board-map-marker]')
          .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label'))),
        before,
      );
      await chapter('共通の時点を3日目から4日目へ。在場の記録に合わせて地図が切り替わります。');
      await page.keyboard.press('ArrowLeft');
      await expect(cursor).toHaveValue('3');
      await page.getByRole('button', { name: 'アリアの3日目を選択', exact: true }).first().focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.sb-sidebar h3')).toHaveText('アリアの3日目');
      await chapter('出来事を選ぶとカードと地図も強調。選択だけでは時点や表示条件は変えません。');
      await page
        .getByRole('combobox', { name: '保存した表示', exact: true })
        .selectOption({ label: '遠征組' });
      await expect(page.locator('[data-board-lane]')).toHaveCount(3);
      await chapter('人物を絞り込み。10人すべてでも、必要な3人だけでも追えます。');
      await page
        .getByRole('combobox', { name: '保存した表示', exact: true })
        .selectOption({ label: '全員・3日目' });
      const places = page.locator('.sb-toolbar details').filter({ hasText: /^場所：/ });
      await places.locator('summary').click();
      await places.getByRole('button', { name: '選択を空にする', exact: true }).click();
      await places.getByLabel('王都', { exact: true }).check();
      await places.getByLabel('港', { exact: true }).check();
      await places.locator('summary').click();
      await expect(page.locator('[data-board-lane]')).toHaveCount(6);
      await chapter('場所を複数選択。王都または港に関係する人物を同じ時点で確認します。');
      await page.getByRole('textbox', { name: '表示名', exact: true }).fill('王都と港・3日目');
      await button('この条件を名前付きで保存').click();
      await expect(page.getByRole('textbox', { name: '表示名', exact: true })).toHaveValue('');
      await chapter('よく使う表示を名前付きで保存。資料の編集履歴とは別に管理します。');
      await page.reload();
      await page
        .getByRole('combobox', { name: '保存した表示', exact: true })
        .selectOption({ label: '王都と港・3日目' });
      await expect(page.locator('[data-board-lane]')).toHaveCount(6);
      await chapter('再読込後も保存した表示を適用できます。地図は固定した保存版のままです。');
      await page
        .getByRole('combobox', { name: '保存した表示', exact: true })
        .selectOption({ label: '全員・3日目' });
      await button('配置を編集').click();
      const frame = page.locator('[data-canvas-target="event-0"]');
      const box = await frame.boundingBox();
      assert(box);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.press('Shift+ArrowRight');
      await expect.poll(async () => (await frame.boundingBox()).x).not.toBe(box.x);
      await chapter('配置だけを編集。ボードのUndoは元資料や表示条件のUndoと独立しています。');
      await button('配置をUndo').click();
      await expect.poll(async () => (await frame.boundingBox()).x).toBe(box.x);
      await button('内容を選択').click();
      await button('一覧で見る').click();
      const row = page.locator('.sb-list article').filter({ has: button('アリアの3日目') });
      await row.getByRole('button', { name: '元資料を開く', exact: true }).click();
      await page
        .locator('[data-edit-event="EV-400"]')
        .getByRole('button', { name: '名前を変更', exact: true })
        .click();
      const form = page.getByRole('form', { name: 'EV-400 の名前', exact: true });
      await form.getByLabel('名前', { exact: true }).fill('アリアが橋へ向かう');
      await form.getByRole('button', { name: '確定', exact: true }).click();
      await chapter('編集は元資料の標準画面で。確定・Undo・保存は資料ごとの履歴を使います。');
      await page
        .locator('.tl-editbar')
        .getByRole('button', { name: '元に戻す', exact: true })
        .click();
      await expect(page.locator('[data-unsaved="sb660-story-ledger-A"]')).toHaveCount(0);
      await page
        .locator('.tl-editbar')
        .getByRole('button', { name: 'やり直す', exact: true })
        .click();
      await page.locator('[data-unsaved="sb660-story-ledger-A"]').getByRole('button').click();
      await expect(page.locator('[data-unsaved="sb660-story-ledger-A"]')).toHaveCount(0);
      await button('ボードへ戻る').click();
      await expect(button('アリアが橋へ向かう')).toBeVisible();
      await button('キャンバスへ').click();
      await button('Fit board').click();
      await chapter(
        '保存した資料をボードへ反映。候補の所在は候補として示し、経路や夕方は推測しません。',
      );
      await page.screenshot({ path: path.join(output, 'story-board-final.png') });
    }
    await pause(2400);
  } finally {
    await context.close();
    await video.saveAs(
      path.join(output, mobile ? 'story-board-mobile.webm' : 'story-board-desktop.webm'),
    );
  }
}
try {
  await record(false);
  await record(true);
  assert.deepEqual(errors, []);
  manifest.status = 'PASS';
} finally {
  manifest.browserErrors = errors;
  await browser.close();
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
console.log(JSON.stringify(manifest, null, 2));
