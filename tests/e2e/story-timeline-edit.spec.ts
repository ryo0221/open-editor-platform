/**
 * Story Timeline T2-2: editing events, SCs and the composition on the normal Host
 * (playground) and the independent Host (artifact-host production build), desktop and 390px.
 * TL01 a new event stays a back event, TL02/TL03 one occurrence moves alone (form, keyboard,
 * drag), TL04/TL34d citations are removed and retargeted without moving other references,
 * TL17 leaving for a trip confirms or keeps the inputs, TL18a–f Undo follows the active owner
 * only, and TL20 a read-only owner offers no change.
 */
import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const HOSTS = [
  ['通常', 'http://127.0.0.1:5173/story-timeline.html'],
  ['独立', 'http://127.0.0.1:4177/story-timeline.html'],
] as const;
const LEDGER_A = '筋の台帳（世界A）';
const CARDS_A = 'シーンカード（世界A）';
const COMPOSITION = '構成図（作品S・提示位置）';

/** Every stored Artifact and the Story links, canonical. */
async function stored(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('editor-platform', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('artifacts', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const all = await new Promise<{ id: string }[]>((resolve, reject) => {
      const r = db.transaction('artifacts').objectStore('artifacts').getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return JSON.stringify({
      artifacts: all.sort((a, b) => a.id.localeCompare(b.id)),
      links: localStorage.getItem('story-timeline:links'),
    });
  });
}
/** The saved versions of one stored Artifact. */
async function versions(page: Page, id: string): Promise<string[]> {
  const all = JSON.parse(await stored(page)) as {
    artifacts: { id: string; versions: { versionId: string }[] }[];
  };
  return all.artifacts.find((a) => a.id === id)!.versions.map((v) => v.versionId);
}
async function startEditing(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: '見本の作品を作成' }).click();
  await expect(page.locator('.tl-item').first()).toBeVisible();
  await page.getByRole('button', { name: '編集を始める' }).click();
  await expect(page.locator('[data-undo-owner]')).toHaveText(/元に戻す対象：まだありません/);
}
const occurrenceOrder = (page: Page) =>
  page
    .locator('#tl-panel [data-occurrence]')
    .evaluateAll((els) =>
      els.map(
        (e) => `${e.getAttribute('data-occurrence')} ${e.querySelector('.tl-time')?.textContent}`,
      ),
    );
const undoOwner = (page: Page) => page.locator('[data-undo-owner]');
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
}
/** Selects an occurrence and changes its place with the form. */
async function moveWithForm(page: Page, id: string, order: string, part: string) {
  await page.locator(`[data-tl-focus="occurrence:${id}"]`).click();
  await page
    .locator(`[data-edit-occurrence="${id}"]`)
    .getByRole('button', { name: '位置を変更' })
    .click();
  const form = page.getByRole('form', { name: `${id} の位置` });
  await form.getByLabel('提示の並び').fill(order);
  await form.getByLabel('話・章').fill(part);
  await form.getByRole('button', { name: '確定' }).click();
  await expect(form).toHaveCount(0);
}

for (const [host, url] of HOSTS) {
  test.describe(`${host}Host`, () => {
    test('TL01・TL18a: 出来事を加えても場面を作らず、取消は何も変えず、保存までは保存版を変えない', async ({
      page,
    }) => {
      await startEditing(page, url);
      const before = await stored(page);
      // Cancel: nothing changes and no owner becomes the Undo target.
      await page.getByRole('button', { name: '出来事を追加' }).click();
      let form = page.getByRole('form', { name: '出来事を追加' });
      await form.getByLabel('名前').fill('取り消す出来事');
      await form.getByRole('button', { name: '取消' }).click();
      await expect(form).toHaveCount(0);
      await expect(page.getByText('取り消す出来事')).toHaveCount(0);
      await expect(undoOwner(page)).toHaveText(/まだありません/);
      await expect(page.locator('[data-unsaved]')).toHaveCount(0);
      // A value the reader refuses: shown, nothing added.
      await page.getByRole('button', { name: '出来事を追加' }).click();
      form = page.getByRole('form', { name: '出来事を追加' });
      await form.getByLabel('名前').fill('密使が帰路につく');
      await form.getByLabel('日').fill('1.5');
      await form.getByRole('button', { name: '確定' }).click();
      await expect(form.getByRole('alert')).toBeVisible();
      await expect(undoOwner(page)).toHaveText(/まだありません/);
      // Added: a back event of ledger A, one Undo of that ledger, no SC made.
      await form.getByLabel('日').fill('6');
      await form.getByRole('button', { name: '確定' }).click();
      await expect(form).toHaveCount(0);
      const item = page.locator('#tl-panel .tl-item', { hasText: '密使が帰路につく' });
      await expect(item).toContainText('6日目');
      await expect(item).toContainText('裏の出来事');
      await expect(undoOwner(page)).toHaveText(new RegExp(`元に戻す対象：${LEDGER_A}`));
      await expect(page.locator('[data-unsaved="story-ledger-A"]')).toBeVisible();
      expect(await stored(page)).toBe(before);
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await expect(page.locator('#tl-panel [data-occurrence]')).toHaveCount(6);
      // Saving makes a new saved version of the ledger only, and keeps the Undo target.
      await page.getByRole('button', { name: `${LEDGER_A} を保存` }).click();
      await expect(
        page.getByRole('status').filter({ hasText: `${LEDGER_A} を保存しました` }),
      ).toBeVisible();
      expect(await versions(page, 'story-ledger-A')).toHaveLength(2);
      expect(await versions(page, 'scene-cards-A')).toEqual(['fixture-v1']);
      await expect(undoOwner(page)).toHaveText(new RegExp(LEDGER_A));
      await noOverflow(page);
    });

    test('TL02・TL03: 提示位置を一つずつ動かし、出来事の時点・他の提示位置・原稿を変えない', async ({
      page,
    }) => {
      await startEditing(page, url);
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      const regions = await page.locator('#tl-panel .tl-regions').allTextContents();
      // TL02 with the form: SC-003 from episode 8 to episode 6.
      await moveWithForm(page, 'OC-005', '60', '第6話');
      await expect
        .poll(() => occurrenceOrder(page))
        .toEqual([
          'OC-001 10. 第1話',
          'OC-002 20. 第2話',
          'OC-003 30. 第3話',
          'OC-004 50. 第5話',
          'OC-005 60. 第6話',
          'OC-006 85. 第8話',
        ]);
      await expect(
        page.getByRole('status').filter({ hasText: '原稿には反映しません' }),
      ).toBeVisible();
      // TL03 with the keyboard: the second presentation of SC-001 moves alone.
      await page.locator('[data-tl-focus="occurrence:OC-006"]').focus();
      await page.keyboard.press('Alt+ArrowUp');
      await expect
        .poll(() => occurrenceOrder(page))
        .toEqual([
          'OC-001 10. 第1話',
          'OC-002 20. 第2話',
          'OC-003 30. 第3話',
          'OC-004 50. 第5話',
          'OC-006 55. 第8話',
          'OC-005 60. 第6話',
        ]);
      await expect(page.locator('[data-tl-focus="occurrence:OC-006"]')).toBeFocused();
      // Both presentations still lead to SC-001; the manuscript regions are unchanged.
      for (const id of ['OC-001', 'OC-006'])
        await expect(page.locator(`[data-occurrence="${id}"] .tl-scene`)).toHaveText(
          '主人公がS1を使う',
        );
      expect((await page.locator('#tl-panel .tl-regions').allTextContents()).sort()).toEqual(
        regions.sort(),
      );
      // No free order between two neighbours: refused, nothing renumbered.
      await moveWithForm(page, 'OC-002', '11', '第2話');
      await page.locator('[data-tl-focus="occurrence:OC-003"]').focus();
      await page.keyboard.press('Alt+ArrowUp');
      await expect(page.locator('.tl-editbar [role="alert"]')).toHaveText(
        '間に入る提示の並びがありません。位置の欄で番号を指定してください。',
      );
      await expect(page.locator('[data-occurrence="OC-003"] .tl-time')).toHaveText('30. 第3話');
      // Event times are as they were.
      await page.getByRole('tab', { name: '世界時間' }).click();
      await expect(
        page.locator('#tl-panel .tl-item', { hasText: '敵が橋を破壊する' }),
      ).toContainText('2日目');
      await noOverflow(page);
    });

    test('TL18b–c: 構成→出来事→構成のあと、Ctrl+Zは構成だけを戻し、空になっても台帳へ回さない', async ({
      page,
    }) => {
      await startEditing(page, url);
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await moveWithForm(page, 'OC-005', '60', '第6話'); // C0
      await page.getByRole('tab', { name: '世界時間' }).click();
      await page
        .locator('#tl-panel .tl-item', { hasText: '主人公がS1だけにある情報を使う' })
        .click();
      await page.getByRole('button', { name: '名前を変更' }).click();
      const rename = page.getByRole('form', { name: 'EV-104 の名前' });
      await rename.getByLabel('名前').fill('主人公がS1を使って切り抜ける');
      await rename.getByRole('button', { name: '確定' }).click(); // E1
      await expect(undoOwner(page)).toHaveText(new RegExp(LEDGER_A));
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await page.locator('[data-tl-focus="occurrence:OC-002"]').focus();
      await page.keyboard.press('Alt+ArrowDown'); // C1
      await expect(undoOwner(page)).toHaveText(new RegExp(`元に戻す対象：${COMPOSITION}`));
      await expect(page.locator('.tl-editbar')).toContainText(
        'この資料の履歴を順に戻します。全資料の操作時系列順ではありません。',
      );
      await page.locator('.tl-editbar').click({ position: { x: 4, y: 4 } });
      await page.keyboard.press('Control+z');
      await expect(page.locator('[data-occurrence="OC-002"] .tl-time')).toHaveText('20. 第2話');
      await page.keyboard.press('Control+z');
      await expect(page.locator('[data-occurrence="OC-005"] .tl-time')).toHaveText('80. 第8話');
      await expect(undoOwner(page)).toHaveText(new RegExp(COMPOSITION));
      await expect(undoOwner(page)).toContainText('元に戻す操作はありません');
      await expect(page.getByRole('button', { name: '元に戻す' })).toBeDisabled();
      // TL18c: empty composition history; the ledger's E1 stays.
      await page.keyboard.press('Control+z');
      await expect(page.locator('.tl-editbar [role="alert"]')).toHaveText(
        `${COMPOSITION} には元に戻す操作がありません。`,
      );
      await page.getByRole('tab', { name: '世界時間' }).click();
      await expect(page.locator('#tl-panel')).toContainText('主人公がS1を使って切り抜ける');
      // Redo comes back on the composition; an explicit switch moves the target.
      await page.getByRole('button', { name: 'やり直す' }).click();
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await expect(page.locator('[data-occurrence="OC-005"] .tl-time')).toHaveText('60. 第6話');
      await page.getByLabel('対象を切り替える').selectOption({ label: LEDGER_A });
      await expect(undoOwner(page)).toHaveText(new RegExp(LEDGER_A));
      await page.getByRole('button', { name: '元に戻す' }).click();
      await page.getByRole('tab', { name: '世界時間' }).click();
      await expect(page.locator('#tl-panel')).toContainText('主人公がS1だけにある情報を使う');
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await expect(page.locator('[data-occurrence="OC-005"] .tl-time')).toHaveText('60. 第6話');
    });

    test('TL04・TL34d: 引用を外しても他の参照は動かず、保存していない出来事は引用できない', async ({
      page,
    }) => {
      await startEditing(page, url);
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await page.locator('[data-occurrence="OC-003"] .tl-item').click();
      await page.locator('.tl-details').getByRole('button', { name: '即位と暗号' }).click();
      const scene = page.locator('[data-edit-scene="SC-004"]');
      await expect(scene.locator('[data-cite]')).toHaveCount(3);
      await scene.getByRole('button', { name: 'SC-004.cite.ev2 を外す' }).click();
      await expect(scene.locator('[data-cite]')).toHaveCount(2);
      await expect(scene.locator('[data-cite="SC-004.cite.ev1"]')).toContainText('EV-001');
      await expect(undoOwner(page)).toHaveText(new RegExp(CARDS_A));
      // A new event exists only in the draft: there is no saved version to cite yet.
      await page.getByRole('tab', { name: '世界時間' }).click();
      await page.getByRole('button', { name: '出来事を追加' }).click();
      const form = page.getByRole('form', { name: '出来事を追加' });
      await form.getByLabel('名前').fill('密使が帰路につく');
      await form.getByLabel('日').fill('6');
      await form.getByRole('button', { name: '確定' }).click();
      await page.locator('#tl-panel .tl-item', { hasText: '敵が橋を破壊する' }).click();
      await page.locator('.tl-details').getByRole('button', { name: '犯人の視点' }).click();
      const sc005 = page.locator('[data-edit-scene="SC-005"]');
      await sc005.getByLabel('引用する出来事').selectOption({ label: 'EV-105 密使が帰路につく' });
      await sc005.getByRole('button', { name: '引用を追加' }).click();
      await expect(page.locator('.tl-editbar [role="alert"]')).toContainText(
        '先に台帳を保存してください',
      );
      await expect(sc005.locator('[data-cite]')).toHaveCount(2);
      // Saved: now it can be cited. Retargeting keeps the citation's ID and SC.
      await page.getByRole('button', { name: `${LEDGER_A} を保存` }).click();
      await expect(page.getByRole('status').filter({ hasText: '保存しました' })).toBeVisible();
      await sc005
        .getByLabel('SC-005.cite.ev の付け替え先')
        .selectOption({ label: 'EV-105 密使が帰路につく' });
      await expect(sc005.locator('[data-cite="SC-005.cite.ev"]')).toContainText('EV-105');
      await expect(
        page.getByRole('status').filter({ hasText: 'SC-005.cite.ev を付け替えました' }),
      ).toBeVisible();
      // EV-101 is still depicted by SC-003; nothing was moved there.
      await page.getByRole('tab', { name: '世界時間' }).click();
      await page.locator('#tl-panel .tl-item', { hasText: '敵が橋を破壊する' }).click();
      await expect(page.locator('.tl-details')).toContainText('橋が落ちた日（回想）');
      await expect(
        page.locator('.tl-details').getByRole('button', { name: '犯人の視点' }),
      ).toHaveCount(0);
      await noOverflow(page);
    });

    test('TL17: 元資料へ移る前に入力を元の資料で確定し、確定できなければ移らない', async ({
      page,
    }) => {
      await startEditing(page, url);
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await page.locator('[data-occurrence="OC-002"] .tl-item').click();
      await page
        .locator('[data-edit-occurrence="OC-002"]')
        .getByRole('button', { name: '位置を変更' })
        .click();
      const form = page.getByRole('form', { name: 'OC-002 の位置' });
      await form.getByLabel('提示の並び').fill('10');
      // Order 10 belongs to OC-001: the input cannot be confirmed, the author stays.
      await page
        .locator('.tl-details')
        .getByRole('button', { name: /元資料を開く/ })
        .click();
      await expect(page.locator('.tl-editbar [role="alert"]')).toContainText(
        'OC-001 が使っています',
      );
      await expect(page.locator('.tl-trip')).toHaveCount(0);
      await expect(form.getByLabel('提示の並び')).toBeFocused();
      await expect(undoOwner(page)).toHaveText(/まだありません/);
      // A valid input is confirmed into the composition's own history, then the trip opens.
      await form.getByLabel('提示の並び').fill('25');
      await page
        .locator('.tl-details')
        .getByRole('button', { name: /元資料を開く/ })
        .click();
      await expect(page.locator('.tl-trip')).toBeVisible();
      await page.getByRole('button', { name: '戻る' }).click();
      await expect(page.locator('[data-occurrence="OC-002"] .tl-time')).toHaveText('25. 第2話');
      await expect(undoOwner(page)).toHaveText(new RegExp(COMPOSITION));
      await expect(page.locator('[data-tl-focus^="source:"]')).toBeFocused();
    });
  });
}

test('TL02: 提示位置をドラッグで置いた先の前へ移す（デスクトップ）', async ({ page, isMobile }) => {
  test.skip(!!isMobile, 'ドラッグは390pxの試験ではキー操作とフォームで確かめる');
  await startEditing(page, HOSTS[0][1]);
  await page.getByRole('tab', { name: '構成の提示順' }).click();
  await page
    .locator('[data-occurrence="OC-005"]')
    .dragTo(page.locator('[data-occurrence="OC-002"]'));
  await expect
    .poll(() => occurrenceOrder(page))
    .toEqual([
      'OC-001 10. 第1話',
      'OC-005 15. 第8話',
      'OC-002 20. 第2話',
      'OC-003 30. 第3話',
      'OC-004 50. 第5話',
      'OC-006 85. 第8話',
    ]);
  await expect(undoOwner(page)).toHaveText(new RegExp(COMPOSITION));
});

const fixtureBundles = new Map<string, Promise<{ js: string; css: string }>>();
async function editingFixture(page: Page, query: string) {
  const mode = query.includes('strict=1') ? 'development' : 'production';
  if (!fixtureBundles.has(mode))
    fixtureBundles.set(
      mode,
      build({
        entryPoints: ['tests/fixtures/story-timeline/main.tsx'],
        bundle: true,
        write: false,
        outdir: '/tmp/story-timeline-edit-bundle',
        format: 'esm',
        define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
      }).then((r) => ({
        js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
        css: r.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
      })),
    );
  const files = await fixtureBundles.get(mode)!;
  await page.route('**/timeline-fixture.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await page.route('**/timeline-fixture.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await page.route('**/timeline-fixture-host*', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/timeline-fixture.css"><div id="root"></div><script type="module" src="/timeline-fixture.js"></script>',
    }),
  );
  await page.goto('/timeline-fixture-host' + query);
  await expect(page.locator('.tl-item').first()).toBeVisible();
}

test.describe('公開entryの編集fixture', () => {
  test('TL20・TL18e: 編集できない資料は変更の入口を出さず、Undoの対象でも別の資料へ回さない', async ({
    page,
  }) => {
    await editingFixture(page, '?edit=1&readonly=scene-cards-A&readonly=scene-cards-B');
    // The read-only SC owner offers no change; its events' ledger does.
    await page.getByRole('tab', { name: '構成の提示順' }).click();
    await page.locator('[data-occurrence="OC-004"] .tl-item').click();
    await page.locator('.tl-details').getByRole('button', { name: '犯人の視点' }).click();
    await expect(page.locator('.tl-details')).toContainText(
      'この場面のシーンカードは編集できません。',
    );
    await expect(
      page.locator('.tl-details').getByRole('button', { name: /外す|削除|引用を追加/ }),
    ).toHaveCount(0);
    await page.getByRole('tab', { name: '構成の提示順' }).click();
    await page.getByRole('button', { name: '場面を追加' }).click();
    await expect(page.locator('.tl-add')).toContainText(
      '場面を加えられるシーンカードがありません。',
    );
    // Make the composition the Undo target, then take its edit permission away.
    await moveWithForm(page, 'OC-005', '60', '第6話');
    await page.getByRole('tab', { name: '世界時間' }).click();
    await page.locator('#tl-panel .tl-item', { hasText: '主人公がS1だけにある情報を使う' }).click();
    await page.getByRole('button', { name: '名前を変更' }).click();
    const rename = page.getByRole('form', { name: 'EV-104 の名前' });
    await rename.getByLabel('名前').fill('改名');
    await rename.getByRole('button', { name: '確定' }).click();
    await page.getByLabel('対象を切り替える').selectOption({ label: COMPOSITION });
    const before = await page.evaluate(() => window.__timeline.snapshot());
    await page.evaluate(() => window.__timeline.setEditable('composition-S', false));
    await expect(undoOwner(page)).toContainText(`${COMPOSITION} は編集できません。`);
    await expect(page.getByRole('button', { name: '元に戻す' })).toBeDisabled();
    await page.locator('.tl-editbar').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('Control+z');
    await expect(page.locator('.tl-editbar [role="alert"]')).toHaveText(
      `${COMPOSITION} は編集できないため元に戻すことはできません。`,
    );
    // Nothing reached the ledger, and nothing was stored.
    await expect(page.locator('#tl-panel')).toContainText('改名');
    expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(before);
    await page.getByRole('tab', { name: '構成の提示順' }).click();
    await expect(page.locator('[data-occurrence="OC-005"] .tl-time')).toHaveText('60. 第6話');
    await expect(page.locator('[data-edit-occurrence]')).toHaveCount(0);
    await page.locator('[data-occurrence="OC-005"] .tl-item').click();
    await expect(page.locator('.tl-details')).toContainText('作品構成は編集できません。');
  });
});

test('N3/N4: save consumes a dirty new-event form once and its source trip reads the unsaved draft', async ({
  page,
}) => {
  await editingFixture(page, '?edit=1');
  await page.locator('#tl-panel .tl-item', { hasText: '主人公がS1だけにある情報を使う' }).click();
  await page.getByRole('button', { name: '名前を変更', exact: true }).click();
  let form = page.getByRole('form', { name: 'EV-104 の名前' });
  await form.getByLabel('名前').fill('未保存の改名');
  await form.getByRole('button', { name: '確定' }).click();
  await page.getByRole('button', { name: /元資料を開く/ }).click();
  await expect(page.locator('body')).toContainText('未保存の改名');
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await page.getByRole('button', { name: '出来事を追加', exact: true }).click();
  form = page.getByRole('form', { name: '出来事を追加' });
  await form.getByLabel('名前').fill('一回だけ作成');
  await form.getByLabel('日').fill('9');
  await page.getByRole('button', { name: `${LEDGER_A} を保存`, exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator('#tl-panel .tl-item', { hasText: '一回だけ作成' })).toHaveCount(1);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(page.locator('#tl-panel .tl-item', { hasText: '一回だけ作成' })).toHaveCount(0);
});

test('N5: read revocation removes owner metadata from editing controls and open forms', async ({
  page,
}) => {
  await editingFixture(page, '?edit=1');
  await page.getByLabel('対象を切り替える').selectOption('story-ledger-A');
  await page.getByRole('button', { name: '出来事を追加', exact: true }).click();
  await page.getByRole('form', { name: '出来事を追加' }).getByLabel('名前').fill('非公開の入力');
  await page.evaluate(() => window.__timeline.revoke('story-ledger-A'));
  await expect(page.locator('.tl-editbar')).not.toContainText(LEDGER_A);
  await expect(page.locator('[data-undo-owner="story-ledger-A"]')).toHaveCount(0);
  await expect(page.locator('[data-closed-owners]')).toHaveCount(0);
  await expect(page.locator('input').filter({ visible: true })).toHaveCount(0);
  expect(await page.locator('.tl-editbar').innerHTML()).not.toContain('story-ledger-A');
});

test('N2: pending exact validation refuses save/trip; cancel discards the late result', async ({
  page,
}, testInfo) => {
  await editingFixture(page, '?edit=1');
  await page.getByRole('tab', { name: '構成の提示順' }).click();
  await moveWithForm(page, 'OC-005', '60', '第6話');
  await page
    .getByRole('navigation', { name: '場面一覧' })
    .getByRole('button', { name: /^SC-001 / })
    .click();
  await page.getByRole('button', { name: '構成に配置', exact: true }).click();
  const form = page.getByRole('form', { name: 'SC-001 を構成に配置' });
  await form.getByLabel('話・章').fill('検証中');
  const before = await page.evaluate(() => window.__timeline.drafts());
  await page.evaluate(() => window.__timeline.holdValidation());
  await form.getByRole('button', { name: '確定' }).click();
  await expect(form.getByRole('button', { name: '確定' })).toBeDisabled();
  await page.getByRole('button', { name: `${COMPOSITION} を保存`, exact: true }).click();
  await expect(page.locator('.tl-editbar [role="alert"]')).toContainText('確認しています');
  await page.getByRole('button', { name: /元資料を開く/ }).click();
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: '取消' }).click();
  await page.evaluate(() => window.__timeline.release());
  await expect(form).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(0);
  expect(await page.evaluate(() => window.__timeline.drafts())).toBe(before);
  await page.screenshot({ path: testInfo.outputPath('cancelled-validation.png'), fullPage: true });
});

test('N7: StrictMode effect replay leaves new reference requests active', async ({ page }) => {
  await editingFixture(page, '?edit=1&strict=1');
  await page
    .getByRole('navigation', { name: '場面一覧' })
    .getByRole('button', { name: /^SC-005 / })
    .click();
  const scene = page.locator('[data-edit-scene="SC-005"]');
  await expect(scene.locator('[data-cite="SC-005.cite.ev"]')).toContainText('fixture-v1 · EV-101');
  const select = scene.getByLabel('SC-005.cite.ev の付け替え先');
  const option = select.locator('option').filter({ hasText: /^EV-102 / });
  await select.selectOption((await option.getAttribute('value')) ?? '');
  await expect(scene.locator('[data-cite="SC-005.cite.ev"]')).toContainText('fixture-v1 · EV-102');
});

const scenePicker = (page: Page, id: string) =>
  page
    .getByRole('navigation', { name: '場面一覧' })
    .getByRole('button', { name: new RegExp('^' + id + ' ') });
async function openReviewScene(page: Page, query = '') {
  await editingFixture(page, '?edit=1' + query);
  await scenePicker(page, 'SC-005').click();
  return page.locator('[data-edit-scene="SC-005"]');
}

test('R657 transitions commit valid input and refuse invalid tab/selection changes', async ({
  page,
}) => {
  const scene = await openReviewScene(page);
  await scene.getByRole('button', { name: '名前を変更' }).click();
  const form = page.getByRole('form', { name: 'SC-005 の名前' });
  await form.getByLabel('名前').fill('選択前に確定');
  await scenePicker(page, 'SC-001').click();
  expect(await page.evaluate(() => window.__timeline.inspect('scene-cards-A'))).toContain(
    '選択前に確定',
  );
  await page.getByRole('button', { name: '出来事を追加', exact: true }).click();
  const create = page.getByRole('form', { name: '出来事を追加' });
  await create.getByLabel('名前').fill('未確定');
  await create.getByLabel('日', { exact: true }).fill('not-a-number');
  await page.getByRole('tab', { name: '世界線', exact: true }).click();
  await expect(create).toBeVisible();
  await expect(create.getByLabel('名前')).toHaveValue('未確定');
  await scenePicker(page, 'SC-002').click();
  await expect(create).toBeVisible();
});

test('R657 placement order alone blocks navigation', async ({ page }) => {
  const scene = await openReviewScene(page);
  await scene.getByRole('button', { name: '構成に配置', exact: true }).click();
  const form = page.getByRole('form', { name: 'SC-005 を構成に配置' });
  await form.getByLabel('提示の並び').fill('777');
  await page.getByRole('button', { name: /元資料を開く/ }).click();
  await expect(form).toBeVisible();
  await expect(form.getByLabel('提示の並び')).toHaveValue('777');
});

test('R657 IME composition refuses flush/save/explicit confirmation without consuming input', async ({
  page,
}, testInfo) => {
  const scene = await openReviewScene(page);
  await scene.getByRole('button', { name: '名前を変更' }).click();
  const form = page.getByRole('form', { name: 'SC-005 の名前' });
  const name = form.getByLabel('名前');
  const before = await page.evaluate(() => window.__timeline.inspect('scene-cards-A'));
  await name.dispatchEvent('compositionstart');
  await name.fill('へんかんちゅう');
  expect(await page.evaluate(() => window.__timeline.flush())).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.__timeline.save('scene-cards-A'))).toMatchObject({
    ok: false,
  });
  await form.dispatchEvent('submit');
  await expect(form).toBeVisible();
  expect(await page.evaluate(() => window.__timeline.inspect('scene-cards-A'))).toBe(before);
  await page.screenshot({ path: testInfo.outputPath('ime-guard.png'), fullPage: true });
  await name.dispatchEvent('compositionend');
  await name.fill('変換完了');
  await form.getByRole('button', { name: '確定', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__timeline.inspect('scene-cards-A'))).toContain(
    '変換完了',
  );
});

for (const action of ['add', 'retarget'] as const)
  test(`R657 pending citation ${action} guards save/navigation and cancellation discards result`, async ({
    page,
  }) => {
    const scene = await openReviewScene(page);
    await scene.getByRole('button', { name: '名前を変更' }).click();
    const rename = page.getByRole('form', { name: 'SC-005 の名前' });
    await rename.getByLabel('名前').fill('保存前');
    await rename.getByRole('button', { name: '確定' }).click();
    const before = await page.evaluate(() => window.__timeline.inspect('scene-cards-A'));
    const saved = await page.evaluate(() => window.__timeline.snapshot());
    await page.evaluate(() => window.__timeline.holdValidation());
    const select = scene.getByLabel(
      action === 'add' ? '引用する出来事' : 'SC-005.cite.ev の付け替え先',
    );
    const value = await select
      .locator('option')
      .filter({ hasText: /^EV-102 / })
      .getAttribute('value');
    await select.selectOption(value!);
    if (action === 'add')
      await scene.getByRole('button', { name: '引用を追加', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(1);
    try {
      await page.getByRole('button', { name: `${CARDS_A} を保存`, exact: true }).click();
      await expect(page.locator('.tl-editbar [role="alert"]')).toContainText('確認');
      expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(saved);
      await page.getByRole('tab', { name: '世界線', exact: true }).click();
      await expect(scene).toBeVisible();
      await page.getByRole('button', { name: '引用の確認を取り消す', exact: true }).click();
    } finally {
      await page.evaluate(() => window.__timeline.release());
    }
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(0);
    expect(await page.evaluate(() => window.__timeline.inspect('scene-cards-A'))).toBe(before);
  });

test('R657 retarget preserves the facet and information selector', async ({ page }) => {
  const scene = await openReviewScene(page, '&facet=info');
  const select = scene.getByLabel('SC-005.cite.ev の付け替え先');
  await select.selectOption(
    (await select
      .locator('option')
      .filter({ hasText: /^EV-102 / })
      .getAttribute('value'))!,
  );
  await expect(scene.locator('[data-cite="SC-005.cite.ev"]')).toContainText('fixture-v1 · EV-102');
  const state = JSON.parse(await page.evaluate(() => window.__timeline.inspect('scene-cards-A')));
  const cite = state.content.rows.find((r: { id: string }) => r.id === 'SC-005.cite.ev');
  expect(cite.values['tl1.ref.facet']).toBe('info');
  expect(cite.values['tl1.info']).toBe('S1');
});

for (const fail of [false, true])
  test(`R657 save result after read revocation reveals no owner metadata (${fail})`, async ({
    page,
  }) => {
    const scene = await openReviewScene(page);
    await scene.getByRole('button', { name: '名前を変更' }).click();
    const form = page.getByRole('form', { name: 'SC-005 の名前' });
    await form.getByLabel('名前').fill('private rename');
    await form.getByRole('button', { name: '確定' }).click();
    await page.evaluate((f) => window.__timeline.holdSave(f), fail);
    await page.getByRole('button', { name: `${CARDS_A} を保存`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingSaves())).toBe(1);
    await page.evaluate(() => window.__timeline.revoke('scene-cards-A'));
    await expect(page.locator('.tl-editbar')).not.toContainText(CARDS_A);
    await page.evaluate(() => window.__timeline.release());
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingSaves())).toBe(0);
    await expect(page.locator('.tl-editbar')).not.toContainText(CARDS_A);
    await expect(page.locator('.tl-editbar')).not.toContainText('private save error');
  });

test('R657 unchanged rename closes without adding Undo', async ({ page }) => {
  const scene = await openReviewScene(page);
  const before = await page.evaluate(() => window.__timeline.inspect('scene-cards-A'));
  await scene.getByRole('button', { name: '名前を変更' }).click();
  const form = page.getByRole('form', { name: 'SC-005 の名前' });
  await form.getByRole('button', { name: '確定' }).click();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__timeline.inspect('scene-cards-A'))).toBe(before);
});

for (const conflict of [false, true])
  test(`R657 placement checks current order conflict=${conflict} after validation`, async ({
    page,
  }) => {
    const scene = await openReviewScene(page);
    await scene.getByRole('button', { name: '構成に配置', exact: true }).click();
    const form = page.getByRole('form', { name: 'SC-005 を構成に配置' });
    const order = Number(await form.getByLabel('提示の並び').inputValue());
    await form.getByLabel('話・章').fill('第9話');
    await page.evaluate(() => window.__timeline.holdValidation());
    await form.getByRole('button', { name: '確定' }).click();
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(1);
    const changed = await page.evaluate(
      (o) => {
        window.__timeline.move(o, '独立の章変更');
        return window.__timeline.inspect('composition-S');
      },
      conflict ? order : 80,
    );
    await page.evaluate(() => window.__timeline.release());
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(0);
    if (conflict) {
      await expect(form).toBeVisible();
      await expect(form.getByRole('button', { name: '確定', exact: true })).toBeEnabled();
      expect(await page.evaluate(() => window.__timeline.inspect('composition-S'))).toBe(changed);
    } else {
      await expect(form).toHaveCount(0);
      expect(await page.evaluate(() => window.__timeline.inspect('composition-S'))).toContain(
        '第9話',
      );
    }
  });

for (const kind of ['retime', 'occurrence'] as const)
  test(`R657b unchanged ${kind} closes without native edit or Undo`, async ({ page }, testInfo) => {
    await editingFixture(page, '?edit=1');
    const owner = kind === 'retime' ? 'story-ledger-A' : 'composition-S';
    const before = await page.evaluate((id) => window.__timeline.inspect(id), owner);
    const saved = await page.evaluate(() => window.__timeline.snapshot());
    if (kind === 'retime') {
      await page.locator('[data-tl-focus="event:story-ledger-A#EV-101"]').click();
      await page
        .locator('[data-edit-event="EV-101"]')
        .getByRole('button', { name: '時点を変更' })
        .click();
    } else {
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await page.locator('[data-tl-focus="occurrence:OC-005"]').click();
      await page
        .locator('[data-edit-occurrence="OC-005"]')
        .getByRole('button', { name: '位置を変更' })
        .click();
    }
    const form = page.getByRole('form', {
      name: kind === 'retime' ? 'EV-101 の時点' : 'OC-005 の位置',
    });
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(await page.evaluate((id) => window.__timeline.inspect(id), owner)).toBe(before);
    expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(saved);
    await page.screenshot({ path: testInfo.outputPath('unchanged.png'), fullPage: true });
  });

for (const [host, url] of HOSTS) {
  test(`T2-3a ${host}: 導出と通常時点の切替・取消・Undo・保存再読込`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    const saved = await stored(page);
    const openTime = async () => {
      await page.locator('[data-tl-focus="event:story-ledger-A#EV-104"]').click();
      await page
        .locator('[data-edit-event="EV-104"]')
        .getByRole('button', { name: '時点を変更' })
        .click();
      return page.getByRole('form', { name: 'EV-104 の時点' });
    };
    let form = await openTime();
    await form.getByLabel('時点の種類').selectOption('derived');
    await form.getByLabel('導出元（同じ台帳）').selectOption('EV-101');
    await form.getByLabel('最小日差').fill('2');
    await form.getByLabel('最大日差').fill('2');
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('[data-calculated-time="resolved"]')).toHaveText('導出：4日目');
    expect(await stored(page)).toBe(saved);
    form = await openTime();
    await form.getByLabel('時点の種類').selectOption('day');
    await form.getByLabel('日', { exact: true }).fill('9');
    await form.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('[data-calculated-time="resolved"]')).toHaveText('導出：4日目');
    form = await openTime();
    await form.getByLabel('時点の種類').selectOption('day');
    await form.getByLabel('日', { exact: true }).fill('9');
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('[data-derivation]')).toHaveCount(0);
    await page
      .locator('.tl-editbar')
      .getByRole('button', { name: '元に戻す', exact: true })
      .click();
    await expect(page.locator('[data-calculated-time="resolved"]')).toHaveText('導出：4日目');
    await page.getByRole('button', { name: `${LEDGER_A} を保存`, exact: true }).click();
    await expect(page.locator('[data-unsaved]')).toHaveCount(0);
    await page.reload();
    await page.locator('[data-tl-focus="event:story-ledger-A#EV-104"]').click();
    await expect(page.locator('[data-calculated-time="resolved"]')).toHaveText('導出：4日目');
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('derived-reloaded.png'), fullPage: true });
  });

  test(`T2-3a ${host}: 循環する導出は拒否し未確定入力を保持`, async ({ page }) => {
    await startEditing(page, url);
    const saved = await stored(page);
    const change = async (id: string, base: string) => {
      await page.locator(`[data-tl-focus="event:story-ledger-A#${id}"]`).click();
      await page
        .locator(`[data-edit-event="${id}"]`)
        .getByRole('button', { name: '時点を変更' })
        .click();
      const form = page.getByRole('form', { name: `${id} の時点` });
      await form.getByLabel('時点の種類').selectOption('derived');
      await form.getByLabel('導出元（同じ台帳）').selectOption(base);
      await form.getByRole('button', { name: '確定', exact: true }).click();
      return form;
    };
    await expect(await change('EV-104', 'EV-101')).toHaveCount(0);
    const form = await change('EV-101', 'EV-104');
    await expect(form.getByRole('alert')).toContainText('循環');
    await expect(form.getByLabel('導出元（同じ台帳）')).toHaveValue('EV-104');
    expect(await stored(page)).toBe(saved);
    await form.getByRole('button', { name: '取消', exact: true }).click();
    await page
      .locator('.tl-editbar')
      .getByRole('button', { name: '元に戻す', exact: true })
      .click();
    await expect(page.locator('[data-unsaved]')).toHaveCount(0);
    await noOverflow(page);
  });
}

async function openEventTime(page: Page, owner: string, id: string) {
  await page.locator(`[data-tl-focus="event:${owner}#${id}"]`).click();
  await page
    .locator(`[data-edit-event="${id}"]`)
    .getByRole('button', { name: '時点を変更' })
    .click();
  return page.getByRole('form', { name: `${id} の時点` });
}
async function chooseExactTime(page: Page, event = 'EV-202') {
  const form = await openEventTime(page, 'story-ledger-A', 'EV-104');
  await form.getByLabel('時点の種類').selectOption('derived');
  await form.getByLabel('導出元の種類').selectOption('saved');
  const select = form.getByLabel('導出元（保存版）');
  const value = await select
    .locator('option')
    .filter({ hasText: ` · ${event} · ` })
    .first()
    .getAttribute('value');
  await select.selectOption(value!);
  await form.getByLabel('最小日差').fill('2');
  await form.getByLabel('最大日差').fill('2');
  return form;
}
for (const [host, url] of HOSTS) {
  test(`T2-3b ${host}: 外部導出は保存版に固定し付け替え・取消・Undo・再読込する`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    const saved = await stored(page);
    // Unsaved source time is deliberately different from its saved version.
    await page.getByLabel('世界', { exact: true }).selectOption('WL-B');
    let form = await openEventTime(page, 'story-ledger-B', 'EV-202');
    await form.getByLabel('日', { exact: true }).fill('10');
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await page.getByLabel('世界', { exact: true }).selectOption('WL-A');
    form = await chooseExactTime(page);
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('[data-calculated-time="resolved"]')).toHaveText('導出：5日目');
    expect(await stored(page)).toBe(saved);
    form = await chooseExactTime(page, 'EV-201');
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('[data-calculated-time="resolved"]')).toHaveText('導出：4日目');
    await page
      .locator('.tl-editbar')
      .getByRole('button', { name: '元に戻す', exact: true })
      .click();
    await expect(page.locator('[data-calculated-time="resolved"]')).toHaveText('導出：5日目');
    form = await openEventTime(page, 'story-ledger-A', 'EV-104');
    await form.getByLabel('最小日差').fill('9');
    await form.getByLabel('最大日差').fill('9');
    await form.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('[data-calculated-time="resolved"]')).toHaveText('導出：5日目');
    // An unrelated time edit retains normal automatic flush even beside an exact derivation.
    form = await openEventTime(page, 'story-ledger-A', 'EV-101');
    await form.getByLabel('日', { exact: true }).fill('3');
    await page.getByRole('tab', { name: '構成の提示順', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '構成の提示順', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab', { name: '世界時間', exact: true }).click();
    await page.locator('[data-tl-focus="event:story-ledger-A#EV-104"]').click();
    await expect(page.locator('[data-calculated-time="resolved"]')).toHaveText('導出：5日目');
    await page.getByRole('button', { name: `${LEDGER_A} を保存`, exact: true }).click();
    await expect(page.locator('[data-unsaved="story-ledger-A"]')).toHaveCount(0);
    const after = JSON.parse(await stored(page));
    const before = JSON.parse(saved);
    expect(after.artifacts.filter((a: { id: string }) => a.id !== 'story-ledger-A')).toEqual(
      before.artifacts.filter((a: { id: string }) => a.id !== 'story-ledger-A'),
    );
    await page.reload();
    await page.locator('[data-tl-focus="event:story-ledger-A#EV-104"]').click();
    await expect(page.locator('[data-calculated-time="resolved"]')).toHaveText('導出：5日目');
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath('exact-derived-reloaded.png'),
      fullPage: true,
    });
  });
}
for (const action of ['cancel', 'revoke'] as const) {
  test(`T2-3b ${action}: 導出検証中の保存・移動を拒否し遅延結果を破棄する`, async ({ page }) => {
    await editingFixture(page, '?edit=1&readonly=story-ledger-B&strict=1');
    const before = await page.evaluate(() => window.__timeline.inspect('story-ledger-A'));
    const saved = await page.evaluate(() => window.__timeline.snapshot());
    const form = await chooseExactTime(page);
    await page.evaluate(() => window.__timeline.holdValidation());
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(1);
    try {
      expect(await page.evaluate(() => window.__timeline.save('story-ledger-A'))).toMatchObject({
        ok: false,
      });
      await page.getByRole('tab', { name: '世界線', exact: true }).click();
      await expect(form).toBeVisible();
      if (action === 'cancel')
        await form.getByRole('button', { name: '取消', exact: true }).click();
      else {
        await page.evaluate(() => window.__timeline.revoke('story-ledger-B'));
        // The Host invalidates the old reading and unmounts its forms on permission changes.
        await expect(form).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText('筋の台帳（世界B）');
        await expect.poll(() => page.locator('body').innerHTML()).not.toContain('story-ledger-B');
      }
    } finally {
      await page.evaluate(() => window.__timeline.release());
    }
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(0);
    await expect(form).toHaveCount(0);
    expect(await page.evaluate(() => window.__timeline.inspect('story-ledger-A'))).toBe(before);
    expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(saved);
  });
}

for (const [host, url] of HOSTS) {
  test(`T2-3c ${host}: 世界線作成・分岐表示と明示継承を独立して保存する`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    await page.getByRole('tab', { name: '世界線', exact: true }).click();
    await page.getByRole('button', { name: '世界線を追加', exact: true }).click();
    let form = page.getByRole('form', { name: '世界線を追加', exact: true });
    await form.getByLabel('世界線の名前').fill('世界C');
    await expect(page.getByRole('button', { name: '移送を追加', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '経験順を追加', exact: true })).toBeDisabled();
    await form.getByLabel('時計', { exact: true }).selectOption('CL-1');
    await form.getByLabel('親世界').selectOption('WL-B');
    await form.getByLabel('分岐の表示時点（日境界）').fill('50');
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    const worldButton = page.locator('[data-tl-focus^="world:"]').filter({ hasText: '世界C' });
    await expect(worldButton).toBeVisible();
    await worldButton.click();
    await expect(undoOwner(page)).toHaveAttribute('data-undo-owner', 'world-S');
    await page.getByRole('button', { name: '継承を追加', exact: true }).click();
    form = page.getByRole('form', { name: '継承を追加', exact: true });
    const choice = await form
      .getByLabel('継承する出来事')
      .locator('option')
      .evaluateAll((options) =>
        options.find((o) => o.textContent?.includes('EV-001'))?.getAttribute('value'),
      );
    expect(choice).toBeTruthy();
    await form.getByLabel('継承する出来事').selectOption(choice!);
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'EV-001 の継承を解除', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '分岐を変更', exact: true }).click();
    form = page.getByRole('form').filter({ has: page.getByLabel('分岐の表示時点（日境界）') });
    await form.getByLabel('分岐の表示時点（日境界）').fill('60');
    await expect(page.getByRole('button', { name: '継承を追加', exact: true })).toBeDisabled();
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'EV-001 の継承を解除', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'EV-001 の継承を解除', exact: true }),
    ).toBeVisible();
    await page.locator('[data-unsaved="world-S"]').getByRole('button').click();
    await expect(page.locator('[data-unsaved="world-S"]')).toHaveCount(0);
    const storedWorld = JSON.parse(await stored(page)).artifacts.find(
      (a: { id: string }) => a.id === 'world-S',
    );
    const newWorld = storedWorld.draft.content.rows.find(
      (r: { values: Record<string, unknown> }) => r.values['tl1.label'] === '世界C',
    );
    expect(newWorld.values['tl1.time.start']).toBe(50);
    expect(
      storedWorld.draft.content.rows.filter(
        (r: { values: Record<string, unknown> }) => r.values['tl1.subject'] === newWorld.id,
      ),
    ).toHaveLength(1);
    await page.reload();
    await page.getByRole('tab', { name: '世界線', exact: true }).click();
    await expect(
      page.locator('[data-tl-focus^="world:"]').filter({ hasText: '世界C' }),
    ).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('story-structure.png'), fullPage: true });
  });
  test(`T2-3c ${host}: 移送と情報・経験順を別ownerへ保存し一回ずつUndoする`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    const before = JSON.parse(await stored(page));
    await page.getByRole('tab', { name: '世界線', exact: true }).click();
    for (const kind of ['移送', '経験順']) {
      await page.getByRole('button', { name: kind + 'を追加', exact: true }).click();
      const form = page.getByRole('form');
      await form.getByLabel('関係の名前').fill(kind + '新規');
      await form.getByLabel('人物のID').fill('CH-002');
      await form.getByLabel('出身世界').selectOption('WL-B');
      for (const [label, item] of [
        [kind === '移送' ? '出発の出来事' : '先に経験する出来事', 'EV-103'],
        [kind === '移送' ? '到着の出来事' : '次に経験する出来事', 'EV-202'],
      ]) {
        const select = form.getByLabel(label);
        const choice = await select
          .locator('option')
          .evaluateAll(
            (options, item) =>
              options.find((o) => o.textContent?.includes(item))?.getAttribute('value'),
            item,
          );
        expect(choice).toBeTruthy();
        await select.selectOption(choice!);
      }
      if (kind === '移送') await form.getByLabel('運ぶ情報のID（カンマ区切り）').fill('S1,S2');
      await form.getByRole('button', { name: '確定', exact: true }).click();
      await expect(form).toHaveCount(0);
      const owner = kind === '移送' ? 'world-S' : 'composition-S';
      await expect(undoOwner(page)).toHaveAttribute('data-undo-owner', owner);
      await page.getByRole('button', { name: '元に戻す', exact: true }).click();
      await expect(
        page
          .locator(kind === '移送' ? '[data-transfer]' : '[data-experience]')
          .filter({ hasText: kind + '新規' }),
      ).toHaveCount(0);
      await page.getByRole('button', { name: 'やり直す', exact: true }).click();
      await page.locator(`[data-unsaved="${owner}"]`).getByRole('button').click();
      await expect(page.locator(`[data-unsaved="${owner}"]`)).toHaveCount(0);
    }
    const after = JSON.parse(await stored(page));
    for (const a of before.artifacts.filter(
      (a: { id: string }) => !['world-S', 'composition-S'].includes(a.id),
    ))
      expect(after.artifacts.find((b: { id: string }) => a.id === b.id)).toEqual(a);
    await page.reload();
    await page.getByRole('tab', { name: '世界線', exact: true }).click();
    await expect(page.locator('[data-experience]').filter({ hasText: '経験順新規' })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('story-relations.png'), fullPage: true });
  });
}

for (const action of ['cancel', 'revoke'] as const) {
  test(`T2-3c ${action}: 移送検証中は保存と遷移を止め失効後の結果を捨てる`, async ({ page }) => {
    await editingFixture(
      page,
      '?edit=1&variant=transfer&readonly=story-ledger-A&readonly=story-ledger-B&strict=1',
    );
    const before = await page.evaluate(() => window.__timeline.inspect('world-S'));
    const saved = await page.evaluate(() => window.__timeline.snapshot());
    await page.getByRole('tab', { name: '世界線', exact: true }).click();
    await page.getByRole('button', { name: 'TR-001 を編集', exact: true }).click();
    const form = page.getByRole('form');
    await form.getByLabel('関係の名前').fill('取り消す移送');
    await page.evaluate(() => window.__timeline.holdValidation());
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(1);
    try {
      expect(await page.evaluate(() => window.__timeline.save('world-S'))).toMatchObject({
        ok: false,
      });
      await page.getByRole('tab', { name: '世界時間', exact: true }).click();
      await expect(form).toBeVisible();
      if (action === 'cancel')
        await form.getByRole('button', { name: '取消', exact: true }).click();
      else {
        await page.evaluate(() => window.__timeline.revoke('story-ledger-B'));
        await expect(form).toHaveCount(0);
        await expect.poll(() => page.locator('body').innerHTML()).not.toContain('story-ledger-B');
      }
    } finally {
      await page.evaluate(() => window.__timeline.release());
    }
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(0);
    await expect(form).toHaveCount(0);
    expect(await page.evaluate(() => window.__timeline.inspect('world-S'))).toBe(before);
    expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(saved);
  });
}

for (const [host, url] of HOSTS) {
  test(`T2-3d ${host}: キー移動はフォームと同じ時点・owner Undo・保存再読込になる`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    const before = JSON.parse(await stored(page));
    const event = page.locator('[data-tl-focus="event:story-ledger-A#EV-101"]');
    await event.focus();
    await event.press('Alt+ArrowRight');
    await expect(event.locator('.tl-time')).toHaveText('3日目');
    await expect(undoOwner(page)).toHaveAttribute('data-undo-owner', 'story-ledger-A');
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(event.locator('.tl-time')).toHaveText('2日目');
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await expect(event.locator('.tl-time')).toHaveText('3日目');
    await event.click();
    await page.getByRole('button', { name: '時点を変更', exact: true }).click();
    const form = page.getByRole('form', { name: 'EV-101 の時点' });
    await expect(form.getByLabel('日', { exact: true })).toHaveValue('3');
    await form.getByLabel('日', { exact: true }).fill('8');
    await event.press('Alt+ArrowRight');
    await expect(event.locator('.tl-time')).toHaveText('3日目');
    await expect(form.getByLabel('日', { exact: true })).toHaveValue('8');
    await form.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('[data-unsaved="story-ledger-A"]').getByRole('button').click();
    await expect(page.locator('[data-unsaved="story-ledger-A"]')).toHaveCount(0);
    const after = JSON.parse(await stored(page));
    expect(after.artifacts.filter((a: { id: string }) => a.id !== 'story-ledger-A')).toEqual(
      before.artifacts.filter((a: { id: string }) => a.id !== 'story-ledger-A'),
    );
    await page.reload();
    await expect(event.locator('.tl-time')).toHaveText('3日目');
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('event-time-keyboard.png'), fullPage: true });
  });
  test(`T2-3d ${host}: ドラッグの確定とEscape取消が一つのownerだけに作用する`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === 'mobile',
      'HTML drag is desktop-only; mobile uses the tested keyboard/form controls.',
    );
    await startEditing(page, url);
    const before = await stored(page);
    const event = page.locator('[data-tl-focus="event:story-ledger-A#EV-101"]');
    const target = page.locator('[data-tl-focus="event:story-ledger-A#EV-103"]');
    await event.press('Alt+ArrowRight');
    await expect(event.locator('.tl-time')).toHaveText('3日目');
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(event.locator('.tl-time')).toHaveText('2日目');
    await event.locator('..').dragTo(target.locator('..'));
    await expect(event.locator('.tl-time')).toHaveText('5日目');
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(event.locator('.tl-time')).toHaveText('2日目');
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await event.locator('..').dispatchEvent('dragstart', { dataTransfer: transfer });
    await page.keyboard.press('Escape');
    await expect(event.locator('.tl-time')).toHaveText('2日目');
    expect(await stored(page)).toBe(before);
    await expect(page.locator('[data-unsaved]')).toHaveCount(0);
  });
}
for (const action of ['cancel', 'revoke'] as const)
  test(`T2-3d ${action}: 非同期キー移動の保存・遷移を止め遅延結果を捨てる`, async ({ page }) => {
    await editingFixture(page, '?edit=1&strict=1');
    const before = await page.evaluate(() => window.__timeline.inspect('story-ledger-A'));
    const saved = await page.evaluate(() => window.__timeline.snapshot());
    await page.evaluate(() => window.__timeline.holdValidation());
    await page.locator('[data-tl-focus="event:story-ledger-A#EV-101"]').press('Alt+ArrowRight');
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(1);
    try {
      expect(await page.evaluate(() => window.__timeline.save('story-ledger-A'))).toMatchObject({
        ok: false,
      });
      await page.getByRole('tab', { name: '世界線', exact: true }).click();
      await expect(page.getByRole('tab', { name: '世界時間', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      if (action === 'cancel') await page.keyboard.press('Escape');
      else await page.evaluate(() => window.__timeline.revoke('story-ledger-A'));
    } finally {
      await page.evaluate(() => window.__timeline.release());
    }
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(0);
    if (action === 'revoke') {
      await expect.poll(() => page.locator('body').innerHTML()).not.toContain('story-ledger-A');
      await page.evaluate(() => window.__timeline.grant('story-ledger-A'));
    }
    expect(await page.evaluate(() => window.__timeline.inspect('story-ledger-A'))).toBe(before);
    expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(saved);
  });
test('T2-3d: 時間制約の違反・精度不足を区別し時点を勝手に直さない', async ({ page }, testInfo) => {
  await editingFixture(page, '?edit=1&variant=time-constraints&strict=1');
  const event = page.locator('[data-tl-focus="event:story-ledger-A#EV-104"]');
  await event.click();
  await expect(page.locator('[data-time-constraint="after-sample"]')).toHaveAttribute(
    'data-result',
    'satisfied',
  );
  await expect(page.locator('[data-time-constraint="travel-sample"]')).toHaveAttribute(
    'data-result',
    'violated',
  );
  await event.press('Alt+ArrowRight');
  await expect(event.locator('.tl-time')).toHaveText('5日目');
  await expect(page.locator('[data-time-constraint="travel-sample"]')).toHaveAttribute(
    'data-result',
    'undetermined',
  );
  await expect(page.locator('[data-time-constraint="travel-sample"]')).toContainText('精度');
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('time-constraint-precision.png'),
    fullPage: true,
  });
});
test('T2-3d: readonly・導出・継承した固定版には移動入口を出さない', async ({ page }) => {
  await editingFixture(page, '?edit=1&variant=transfer&readonly=story-ledger-A');
  const before = await page.evaluate(() => window.__timeline.snapshot());
  const event = page.locator('[data-tl-focus="event:story-ledger-A#EV-101"]');
  await expect(event.locator('..')).toHaveAttribute('draggable', 'false');
  await event.press('Alt+ArrowRight');
  await expect(event.locator('.tl-time')).toHaveText('2日目');
  await expect(
    page.locator('[data-tl-focus="event:story-ledger-A#EV-102"]').locator('..'),
  ).toHaveAttribute('draggable', 'false');
  await page.getByLabel('世界', { exact: true }).selectOption('WL-B');
  await expect(
    page.locator('[data-tl-focus="event:story-ledger-A#EV-001"]').locator('..'),
  ).toHaveAttribute('draggable', 'false');
  expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(before);
});

async function repinForm(page: Page) {
  await page.getByLabel('再固定する資料', { exact: true }).selectOption('scene-cards-A');
  await page.getByRole('button', { name: '保存版を選び直す', exact: true }).click();
  const form = page.getByRole('form', { name: '参照版を一括再固定', exact: true });
  await expect(form).toBeVisible();
  return form;
}
for (const [host, url] of HOSTS) {
  test(`T2-4 repin ${host}: 旧版と選択版を確認し一括確定・Undo・保存再読込する`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    const event = page.locator('[data-tl-focus="event:story-ledger-A#EV-101"]');
    await event.press('Alt+ArrowRight');
    await expect(event.locator('.tl-time')).toHaveText('3日目');
    await page.locator('[data-unsaved="story-ledger-A"]').getByRole('button').click();
    await expect(page.locator('[data-unsaved="story-ledger-A"]')).toHaveCount(0);
    const saved = await stored(page);
    const newVersion = (await versions(page, 'story-ledger-A')).at(-1)!;
    let form = await repinForm(page);
    const first = form.getByLabel(/^SC-001.cite.ev ref /);
    const second = form.getByLabel(/^SC-002.cite.ev ref /);
    await expect(first).toHaveValue(''); // no latest-version auto selection
    await first.selectOption({ index: 1 });
    await second.selectOption({ index: 1 });
    await expect(form).toContainText(newVersion);
    await expect(form).toContainText('旧版 fixture-v1');
    expect(await stored(page)).toBe(saved);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('repin-preview.png'), fullPage: true });
    await form.getByRole('button', { name: '取消', exact: true }).click();
    expect(await stored(page)).toBe(saved);
    form = await repinForm(page);
    await form.getByLabel(/^SC-001.cite.ev ref /).selectOption({ index: 1 });
    await form.getByLabel(/^SC-002.cite.ev ref /).selectOption({ index: 1 });
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(undoOwner(page)).toHaveAttribute('data-undo-owner', 'scene-cards-A');
    await page.locator('.tl-item').first().click();
    await page
      .getByRole('button', { name: /元資料を開く/ })
      .first()
      .click();
    await page.getByRole('button', { name: '戻る', exact: true }).click();
    await expect(page.locator('[data-repin-owner="scene-cards-A"]')).toHaveAttribute(
      'data-repin-state',
      'applied-unsaved',
    );
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.locator('[data-unsaved="scene-cards-A"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await page.locator('[data-unsaved="scene-cards-A"]').getByRole('button').click();
    await expect(page.locator('[data-unsaved="scene-cards-A"]')).toHaveCount(0);
    await expect(page.locator('[data-repin-owner="scene-cards-A"]')).toHaveAttribute(
      'data-repin-state',
      'saved',
    );
    const after = JSON.parse(await stored(page)),
      before = JSON.parse(saved);
    expect(after.artifacts.filter((a: { id: string }) => a.id !== 'scene-cards-A')).toEqual(
      before.artifacts.filter((a: { id: string }) => a.id !== 'scene-cards-A'),
    );
    const rows = after.artifacts.find((a: { id: string }) => a.id === 'scene-cards-A').draft.content
      .rows;
    expect(
      rows
        .filter((r: { id: string }) => ['SC-001.cite.ev', 'SC-002.cite.ev'].includes(r.id))
        .map((r: { values: Record<string, string> }) => r.values['tl1.ref.version']),
    ).toEqual([newVersion, newVersion]);
    await page.reload();
    await page.getByRole('button', { name: '編集を始める', exact: true }).click();
    form = await repinForm(page);
    await expect(
      form.getByLabel(new RegExp(`^SC-001.cite.ev ref .*旧版 ${newVersion}`)),
    ).toHaveValue('');
    // Reverting to historical bytes is a new unsaved operation, not proof of a new save.
    await form.getByLabel(/^SC-001.cite.ev ref /).selectOption({ index: 1 });
    await form.getByLabel(/^SC-002.cite.ev ref /).selectOption({ index: 1 });
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    const result = page.locator('[data-repin-owner="scene-cards-A"]');
    await expect(result).toHaveAttribute('data-repin-state', 'applied-unsaved');
    await result.getByRole('button', { name: /の再固定結果を保存/ }).click();
    await expect(result).toHaveAttribute('data-repin-state', 'saved');
    await page.reload();
    await page.getByRole('button', { name: '編集を始める', exact: true }).click();
    form = await repinForm(page);
    await expect(form.getByLabel(/^SC-001.cite.ev ref .*旧版 fixture-v1/)).toHaveValue('');
  });
}
for (const action of ['cancel', 'revoke', 'stale'] as const) {
  test(`T2-4 repin ${action}: 検証中の保存・離脱を止め失効した一括選択を適用しない`, async ({
    page,
  }) => {
    await editingFixture(page, '?edit=1&strict=1');
    await page.locator('[data-tl-focus="event:story-ledger-A#EV-101"]').press('Alt+ArrowRight');
    await expect(page.locator('[data-unsaved="story-ledger-A"]')).toHaveCount(1);
    expect((await page.evaluate(() => window.__timeline.save('story-ledger-A'))).ok).toBe(true);
    const before = await page.evaluate(() => window.__timeline.inspect('scene-cards-A'));
    const saved = await page.evaluate(() => window.__timeline.snapshot());
    const form = await repinForm(page);
    await form.getByLabel(/^SC-001.cite.ev ref /).selectOption({ index: 1 });
    await page.evaluate(() => window.__timeline.holdValidation());
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(1);
    try {
      expect((await page.evaluate(() => window.__timeline.save('scene-cards-A'))).ok).toBe(false);
      await page.getByRole('tab', { name: '世界線', exact: true }).click();
      await expect(page.getByRole('tab', { name: '世界時間', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      if (action === 'cancel')
        await form.getByRole('button', { name: '取消', exact: true }).click();
      else if (action === 'revoke')
        await page.evaluate(() => window.__timeline.revoke('story-ledger-A'));
      else
        await page.evaluate(() => {
          window.__timeline.setEditable('scene-cards-A', false);
          window.__timeline.setEditable('scene-cards-A', true);
        });
    } finally {
      await page.evaluate(() => window.__timeline.release());
    }
    await expect.poll(() => page.evaluate(() => window.__timeline.pendingValidation())).toBe(0);
    expect(await page.evaluate(() => window.__timeline.inspect('scene-cards-A'))).toBe(before);
    expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(saved);
    if (action === 'revoke')
      await expect.poll(() => page.locator('body').innerHTML()).not.toContain('story-ledger-A');
    await noOverflow(page);
  });
}
test('T2-4 repin: unreadable endpoint hides the whole relation from the saved-version picker', async ({
  page,
}) => {
  await editingFixture(page, '?edit=1&variant=transfer&strict=1');
  await page.evaluate(() => window.__timeline.revoke('story-ledger-B'));
  await page.getByLabel('再固定する資料', { exact: true }).selectOption('world-S');
  await page.getByRole('button', { name: '保存版を選び直す', exact: true }).click();
  const form = page.getByRole('form', { name: '参照版を一括再固定', exact: true });
  await expect(form).toBeVisible();
  await expect(form.getByRole('combobox')).toHaveCount(3); // EV-001/002 plus fixture-v2 EV-102 inheritance remain readable
  await expect(form).not.toContainText('TR-001');
  await expect(form).not.toContainText('story-ledger-B');
});

for (const [host, url] of HOSTS) {
  test(`T2-4b ${host}: 部分保存を示し再起動後は対応表だけ復旧する`, async ({ page }, testInfo) => {
    await startEditing(page, url);
    await page.getByRole('tab', { name: '構成の提示順', exact: true }).click();
    await moveWithForm(page, 'OC-005', '65', '第6.5話');
    const before = await stored(page);
    const panel = page.getByRole('region', { name: '保存と原稿対応の復旧', exact: true });
    await panel.getByRole('button', { name: '構成を保存して原稿対応を更新', exact: true }).click();
    await expect(panel.getByRole('group', { name: '保存対象の確認', exact: true })).toBeVisible();
    expect(await stored(page)).toBe(before); // preview is not a save
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    expect(await stored(page)).toBe(before);
    await panel.getByRole('button', { name: '構成を保存して原稿対応を更新', exact: true }).click();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'story-timeline:links') throw Error('injected correspondence failure');
        return original.call(this, key, value);
      };
    });
    await panel.getByRole('button', { name: 'この内容で保存・接続', exact: true }).click();
    await expect(panel.locator('[data-save-state="source-saved-links-pending"]')).toHaveCount(1);
    await expect(panel).toContainText('本体は保存済み・原稿対応の更新待ち');
    const partial = await stored(page),
      savedVersions = await versions(page, 'composition-S');
    expect(JSON.parse(partial).links).toBe(JSON.parse(before).links);
    await page.reload();
    await page.getByRole('button', { name: '編集を始める', exact: true }).click();
    await expect(panel.locator('[data-save-state="source-saved-links-pending"]')).toHaveCount(1);
    await panel.getByRole('button', { name: '対応表だけ再試行', exact: true }).click();
    await expect(panel.locator('[data-save-state="complete"]')).toHaveCount(1);
    expect(await versions(page, 'composition-S')).toEqual(savedVersions);
    const after = JSON.parse(await stored(page));
    expect(after.artifacts).toEqual(JSON.parse(partial).artifacts);
    const links = JSON.parse(after.links);
    expect(
      links.occurrenceLinks.every(
        (l: { occurrence: { versionId: string } }) =>
          l.occurrence.versionId === savedVersions.at(-1),
      ),
    ).toBe(true);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('save-recovery.png'), fullPage: true });
  });
}
for (const [host, url] of HOSTS)
  for (const kind of ['event', 'scene'] as const) {
    test(`T2-4b two-step ${host} ${kind}: 作成保存後の取消で元を保持し第二段階だけ再開する`, async ({
      page,
    }, testInfo) => {
      await startEditing(page, url);
      if (kind === 'scene')
        await page.getByRole('tab', { name: '構成の提示順', exact: true }).click();
      const title = kind === 'event' ? '出来事を追加' : '場面を追加';
      await page.getByRole('button', { name: title, exact: true }).click();
      const creation = page.getByRole('form', { name: title, exact: true });
      await creation.getByLabel('名前', { exact: true }).fill('二段階の新規項目');
      if (kind === 'event') await creation.getByLabel('日', { exact: true }).fill('9');
      await creation.getByRole('button', { name: '確定', exact: true }).click();
      await expect(creation).toHaveCount(0);
      const owner = kind === 'event' ? 'story-ledger-A' : 'scene-cards-A',
        item = kind === 'event' ? 'EV-105' : 'SC-006';
      const panel = page.getByRole('region', { name: '保存して引用・配置', exact: true });
      await panel
        .getByLabel('保存する出来事・場面', { exact: true })
        .selectOption(JSON.stringify([owner, item]));
      await panel.getByRole('button', { name: 'この項目で進める', exact: true }).click();
      await expect(panel).toContainText('第一段階・元の資料は未保存');
      await expect(panel.getByRole('button', { name: '接続先を確認', exact: true })).toHaveCount(0);
      await panel.getByRole('button', { name: '元の資料を保存', exact: true }).click();
      await expect(panel.locator('[data-two-step-state="source-saved-unlinked"]')).toBeVisible();
      const saved = await stored(page),
        sourceVersions = await versions(page, owner);
      await page.locator('.tl-item').first().click();
      // A source trip unmounts the operation panel; receipts belong to the session.
      await page
        .getByRole('button', { name: /元資料を開く/ })
        .first()
        .click();
      await page.getByRole('button', { name: '戻る', exact: true }).click();
      await panel.getByRole('button', { name: 'この操作を再開', exact: true }).click();
      await expect(panel.locator('[data-two-step-state="source-saved-unlinked"]')).toBeVisible();

      if (kind === 'event')
        await panel
          .getByLabel('引用する場面', { exact: true })
          .selectOption(JSON.stringify(['scene-cards-A', 'SC-002']));
      else {
        await panel.getByLabel('新しい提示順', { exact: true }).fill('65');
        await panel.getByLabel('新しい話・章', { exact: true }).fill('第6.5話');
      }
      await page
        .getByRole('button', { name: /元資料を開く/ })
        .first()
        .click();
      await expect(page.getByRole('button', { name: '戻る', exact: true })).toHaveCount(0);
      await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: '接続先を確認', exact: true }).click();
      await expect(panel.getByRole('group', { name: '第二段階の確認', exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '接続確認を取消', exact: true }).click();
      expect(await stored(page)).toBe(saved);
      await expect(panel.locator('[data-two-step-state="source-saved-unlinked"]')).toBeVisible();
      await panel.getByRole('button', { name: '接続先を確認', exact: true }).click();
      await panel.getByRole('button', { name: '関連付けを確定', exact: true }).click();
      await expect(panel).toContainText('第二段階・関連付けは未保存');
      expect(await stored(page)).toBe(saved);
      await page
        .getByRole('button', { name: /元資料を開く/ })
        .first()
        .click();
      await page.getByRole('button', { name: '戻る', exact: true }).click();
      await panel.getByRole('button', { name: 'この操作を再開', exact: true }).click();
      await panel.getByRole('button', { name: '関連付けの保存だけ再試行', exact: true }).click();
      await expect(panel.locator('[data-two-step-state="complete"]')).toBeVisible();
      expect(await versions(page, owner)).toEqual(sourceVersions);
      await noOverflow(page);
      await page.screenshot({ path: testInfo.outputPath('two-step.png'), fullPage: true });
    });
  }
for (const [host, url] of HOSTS) {
  test(`T2-final clock ${host}: 換算を作成・取消・保存し世界設定だけUndoする`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    await page.getByRole('tab', { name: '世界線', exact: true }).click();
    const panel = page.getByRole('region', { name: '時計の換算', exact: true });
    await panel.getByRole('button', { name: '時計を追加', exact: true }).click();
    let form = panel.getByRole('form', { name: '時計を追加', exact: true });
    await form.getByLabel('時計の名前').fill('別の時計');
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    const saved = await stored(page);
    await panel.getByRole('button', { name: '換算を追加', exact: true }).click();
    form = panel.getByRole('form', { name: '時計の換算を編集', exact: true });
    await form.getByLabel('換算元の時計').selectOption('CL-1');
    await form.getByLabel('換算先の時計').selectOption({ label: 'CL-002 別の時計' });
    await form.getByLabel('換算先から元を引いた日数差').fill('3');
    await form.getByRole('button', { name: '取消', exact: true }).click();
    expect(await stored(page)).toBe(saved);
    await expect(panel.locator('[data-clock-offset]')).toHaveCount(0);
    await panel.getByRole('button', { name: '換算を追加', exact: true }).click();
    form = panel.getByRole('form', { name: '時計の換算を編集', exact: true });
    await form.getByLabel('換算元の時計').selectOption('CL-1');
    await form.getByLabel('換算先の時計').selectOption({ label: 'CL-002 別の時計' });
    await form.getByLabel('換算先から元を引いた日数差').fill('3');
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(panel.locator('[data-clock-offset]')).toHaveCount(1);
    await expect(undoOwner(page)).toContainText('世界の覚え書き');
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(panel.locator('[data-clock-offset]')).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await page.locator('[data-unsaved="world-S"]').getByRole('button').click();
    await expect.poll(() => versions(page, 'world-S')).toHaveLength(2);
    await expect(page.locator('[data-unsaved="world-S"]')).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: '編集を始める', exact: true }).click();
    await page.getByRole('tab', { name: '世界線', exact: true }).click();
    await expect(panel.locator('[data-clock-offset]')).toContainText('3日');
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('clock.png'), fullPage: true });
  });
}
for (const [host, url] of HOSTS) {
  test(`T3 ${host}: 保存版・下書き案・確認済み差替えを分けて試算し保存と履歴を変更しない`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    const saved = await stored(page),
      event = page.locator('[data-tl-focus="event:story-ledger-A#EV-103"]');
    await event.press('Alt+ArrowLeft');
    await expect(event.locator('.tl-time')).toHaveText('4日目');
    await event.press('Alt+ArrowLeft');
    await expect(event.locator('.tl-time')).toHaveText('3日目');
    const panel = page.locator('[data-timeline-analysis]');
    await panel.locator('summary').first().click();
    await panel.getByLabel('診断する下書きの資料', { exact: true }).selectOption('story-ledger-A');
    await panel.getByRole('button', { name: 'この下書き案を診断', exact: true }).click();
    await expect(panel.locator('[data-analysis-scope]')).toHaveAttribute(
      'data-analysis-scope',
      'complete',
    );
    const adopted = panel.getByRole('region', { name: '現採用の診断', exact: true }),
      candidate = panel.getByRole('region', { name: '下書き案だけの診断', exact: true });
    await expect(
      adopted.locator('[data-diagnostic-site="story-ledger-A#EV-104.use.S1"]'),
    ).toHaveAttribute('data-diagnostic-state', 'contradiction');
    await expect(
      candidate.locator('[data-diagnostic-site="story-ledger-A#EV-104.use.S1"]'),
    ).toHaveAttribute('data-diagnostic-state', 'satisfied');
    await panel
      .getByRole('group', { name: '情報利用を試算する場面' })
      .getByLabel('scene-cards-A#SC-001')
      .check();
    await panel.getByRole('button', { name: '差替表の案を作る', exact: true }).click();
    const table = panel.getByRole('region', { name: '確認する差替表', exact: true });
    await expect(table.getByRole('checkbox')).toHaveCount(1);
    await expect(
      panel.getByRole('region', { name: '確認した差替表の仮定診断', exact: true }),
    ).toHaveCount(0);
    await table.getByRole('button', { name: 'この表で試算', exact: true }).click();
    const hypothesis = panel.getByRole('region', { name: '確認した差替表の仮定診断', exact: true });
    await expect(hypothesis).toBeVisible();
    await hypothesis.getByText('時点・場面の読取文脈', { exact: true }).click();
    await expect(hypothesis).toContainText('scene-cards-A#SC-001：成立 · 候補参照で試算');
    expect(await stored(page)).toBe(saved);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('hypothesis.png'), fullPage: true });
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(event.locator('.tl-time')).toHaveText('4日目');
    await expect(hypothesis).toHaveCount(0);
    await expect(panel).toContainText('前提が変わったため旧結果を表示しません');
  });
}
for (const [host, url] of HOSTS) {
  test(`T3 exception ${host}: 理由の取消と確定は対象ownerだけの一回Undoで保存は別`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    const before = await stored(page),
      panel = page.locator('[data-timeline-analysis]');
    await panel.getByText('診断と試算', { exact: true }).click();
    await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
    const diagnostic = panel
      .getByRole('region', { name: '現採用の診断', exact: true })
      .locator('[data-diagnostic-site="story-ledger-A#EV-104.use.S1"]');
    await expect(diagnostic).toHaveAttribute('data-diagnostic-state', 'contradiction');
    await diagnostic.getByRole('button', { name: 'この診断に例外を記録' }).click();
    const form = page.getByRole('form', { name: '例外を記録', exact: true });
    await form.getByLabel('この診断を例外とする理由').fill('取消する理由');
    await form.getByRole('button', { name: '取消', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(await stored(page)).toBe(before);
    await diagnostic.getByRole('button', { name: 'この診断に例外を記録' }).click();
    await form.getByLabel('この診断を例外とする理由').fill('作者が意図した認識のずれ');
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(panel.locator('[data-exception]')).toHaveCount(1);
    await expect(undoOwner(page)).toContainText(LEDGER_A);
    expect(await stored(page)).toBe(before);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('exception.png'), fullPage: true });
    await page
      .locator('.tl-editbar')
      .getByRole('button', { name: '元に戻す', exact: true })
      .click();
    await expect(panel.locator('[data-exception]')).toHaveCount(0);
    expect(await stored(page)).toBe(before);
  });
}
test('T3 unavailable and permission: 未宣言T3bと旧診断を画面に残さず拒否する', async ({ page }) => {
  await editingFixture(page, '?edit=1&t3b=0');
  const panel = page.locator('[data-timeline-analysis]');
  await panel.getByText('診断と試算', { exact: true }).click();
  await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
  await expect(
    panel.getByText('このHostはT3bの案生成・作者確認・仮定診断に対応していません。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: '差替表の案を作る', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__timeline.revoke('story-ledger-A'));
  await expect(panel.locator('[data-diagnostic-site]')).toHaveCount(0);
  await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
  await expect(panel.locator('[data-analysis-scope]')).toHaveAttribute(
    'data-analysis-scope',
    'partial',
  );
  await expect(panel.locator('[data-diagnostic-site]')).toHaveCount(0);
});
test('T3 stale async: 遅延診断中の権限失効で結果を破棄し保存とUndoを増やさない', async ({
  page,
}) => {
  await editingFixture(page, '?edit=1');
  const panel = page.locator('[data-timeline-analysis]');
  await panel.getByText('診断と試算', { exact: true }).click();
  const before = await page.evaluate(() => window.__timeline.snapshot());
  const reads = await page.evaluate(
    () => window.__timeline.reads.filter((id) => id === 'world-S').length,
  );
  await page.evaluate(() => window.__timeline.holdNext('world-S'));
  await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__timeline.reads.filter((id) => id === 'world-S').length),
    )
    .toBeGreaterThan(reads);
  await page.evaluate(() => window.__timeline.revoke('story-ledger-A'));
  await page.evaluate(() => window.__timeline.release());
  await expect(panel.getByRole('button', { name: '保存版を診断', exact: true })).toBeEnabled();
  await expect(panel.locator('[data-diagnostic-site]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(before);
  await expect(undoOwner(page)).toHaveText(/まだありません/);
});
for (const [host, url] of HOSTS)
  test(`review P2 stale exception ${host}: 世界設定変更後も理由と取消を保持する`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    await page.getByRole('tab', { name: '世界線', exact: true }).click();
    const panel = page.locator('[data-timeline-analysis]');
    await panel.getByText('診断と試算', { exact: true }).click();
    await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
    await panel
      .getByRole('region', { name: '現採用の診断', exact: true })
      .locator('[data-diagnostic-site="story-ledger-A#EV-104.use.S1"]')
      .getByRole('button', { name: 'この診断に例外を記録' })
      .click();
    const form = page.getByRole('form', { name: '例外を記録', exact: true }),
      reason = '入力を保って取消する';
    await form.getByLabel('この診断を例外とする理由').fill(reason);
    await page.getByRole('button', { name: '時計を追加', exact: true }).click();
    const clock = page.getByRole('form', { name: '時計を追加', exact: true });
    await clock.getByLabel('時計の名前').fill('診断の前提変更');
    await clock.getByRole('button', { name: '確定', exact: true }).click();
    await expect(clock).toHaveCount(0);
    await expect(form.getByLabel('この診断を例外とする理由')).toHaveValue(reason);
    const before = await stored(page);
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toContainText('前提');
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('stale-exception.png'), fullPage: true });
    expect(await stored(page)).toBe(before);
    await form.getByRole('button', { name: '取消', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '保存版を診断', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
    await expect(panel.getByRole('region', { name: '現採用の診断', exact: true })).toBeVisible();
  });
test('review 291 persisted exception: 自分の保存では適用可能、時計規則変更は再確認', async ({
  page,
}, testInfo) => {
  await editingFixture(page, '?edit=1&variant=clock-exception');
  await page.evaluate(async () => {
    await window.__timeline.save('world-S');
    await window.__timeline.save('story-ledger-A');
  });
  const panel = page.locator('[data-timeline-analysis]');
  await panel.getByText('診断と試算', { exact: true }).click();
  await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
  const diagnostic = panel
    .getByRole('region', { name: '現採用の診断', exact: true })
    .locator('[data-diagnostic-site="story-ledger-A#clock-constraint"]');
  await expect(diagnostic).toHaveAttribute('data-diagnostic-state', 'undetermined');
  await diagnostic.getByRole('button', { name: 'この診断に例外を記録' }).click();
  const form = page.getByRole('form', { name: '例外を記録', exact: true });
  await form.getByLabel('この診断を例外とする理由').fill('時計は作者の意図');
  await form.getByRole('button', { name: '確定', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(panel.locator('[data-exception]')).toHaveCount(1);
  // A native commit invalidates the old diagnostic; save and diagnose again before matching.
  await page.evaluate(() => window.__timeline.save('world-S'));
  await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
  await expect(panel.locator('[data-exception]')).toHaveAttribute(
    'data-exception-state',
    'applies',
  );
  await page.getByRole('tab', { name: '世界線', exact: true }).click();
  await page.getByRole('button', { name: '換算を追加', exact: true }).click();
  const clock = page.getByRole('form', { name: '時計の換算を編集', exact: true });
  await clock.getByLabel('換算元の時計').selectOption('CL-other');
  await clock.getByLabel('換算先の時計').selectOption('CL-1');
  await clock.getByLabel('換算先から元を引いた日数差').fill('0');
  await clock.getByRole('button', { name: '確定', exact: true }).click();
  await expect(clock).toHaveCount(0);
  await page.evaluate(() => window.__timeline.save('world-S'));
  await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
  await expect(diagnostic).toHaveAttribute('data-diagnostic-state', 'contradiction');
  await expect(panel.locator('[data-exception]')).toHaveAttribute(
    'data-exception-state',
    'recheck',
  );
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('exception-clock-recheck.png'),
    fullPage: true,
  });
});

for (const [host, url] of HOSTS)
  test(`EG11 ${host}: 保存した例外はreload後も適用可能、実前提の保存後は再確認`, async ({
    page,
  }, testInfo) => {
    await startEditing(page, url);
    const panel = page.locator('[data-timeline-analysis]');
    await panel.getByText('診断と試算', { exact: true }).click();
    await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
    const diagnostic = panel
      .getByRole('region', { name: '現採用の診断', exact: true })
      .locator('[data-diagnostic-site="story-ledger-A#EV-104.use.S1"]');
    await expect(diagnostic).toHaveAttribute('data-diagnostic-state', 'contradiction');
    await diagnostic.getByRole('button', { name: 'この診断に例外を記録' }).click();
    const form = page.getByRole('form', { name: '例外を記録', exact: true });
    await form.getByLabel('この診断を例外とする理由').fill('作者が保存した意図');
    await form.getByRole('button', { name: '確定', exact: true }).click();
    await expect(form).toHaveCount(0);
    await page.getByRole('button', { name: `${LEDGER_A} を保存`, exact: true }).click();
    await expect(page.locator('[data-unsaved]')).toHaveCount(0);
    const persisted = await stored(page);
    await page.reload();
    await page.getByRole('button', { name: '編集を始める', exact: true }).click();
    await panel.getByText('診断と試算', { exact: true }).click();
    await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
    await expect(panel.locator('[data-exception]')).toHaveAttribute(
      'data-exception-state',
      'applies',
    );
    expect(await stored(page)).toBe(persisted);
    await page.locator('[data-tl-focus="event:story-ledger-A#EV-103"]').click();
    await page
      .locator('[data-edit-event="EV-103"]')
      .getByRole('button', { name: '時点を変更', exact: true })
      .click();
    const time = page.getByRole('form', { name: 'EV-103 の時点', exact: true });
    await time.getByLabel('時点の種類').selectOption('day');
    await time.getByLabel('日', { exact: true }).fill('2');
    await time.getByRole('button', { name: '確定', exact: true }).click();
    await expect(time).toHaveCount(0);
    await page.getByRole('button', { name: `${LEDGER_A} を保存`, exact: true }).click();
    await expect(page.locator('[data-unsaved]')).toHaveCount(0);
    const changed = await stored(page);
    await panel.getByRole('button', { name: '保存版を診断', exact: true }).click();
    await expect(diagnostic).toHaveAttribute('data-diagnostic-state', 'satisfied');
    await expect(panel.locator('[data-exception]')).toHaveAttribute(
      'data-exception-state',
      'recheck',
    );
    expect(await stored(page)).toBe(changed);
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath('eg11-saved-exception.png'),
      fullPage: true,
    });
  });
