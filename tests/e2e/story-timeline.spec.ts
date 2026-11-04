/**
 * Story Timeline T1b: the read-only reading screen on the normal Host (playground, public
 * entry) and the independent Host (artifact-host production build), desktop and 390px.
 * TL31 three readings, TL32 private operations and trips leave storage unchanged and a
 * delayed old query never replaces the current one, TL33 empty / unset / missing states, and
 * the T1 part of the cross-cutting conditions (TL20 change inputs in every trip, TL26
 * derivation and transfer ends, TL29a no manuscript reflection, TL29b shared refused).
 */
import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

declare global {
  interface Window {
    __timeline: {
      holdNext(id: string, fail?: boolean): void;
      inspect(id: string): string;
      save(id: string): Promise<{ ok: boolean }>;
      history(direction: 'undo' | 'redo'): { ok: boolean };
      flush(): { ok: boolean };
      holdSave(fail?: boolean): void;
      pendingSaves(): number;
      move(order: number, part: string): void;
      holdValidation(): void;
      pendingValidation(): number;
      drafts(): string;
      release(): void;
      reads: string[];
      revoke(id: string): void;
      grant(id: string): void;
      corrupt(id: string): void;
      /** Every stored artifact, canonical, to prove nothing was written. */
      snapshot(): string;
      /** `?edit=1`: whether an owner may be changed from now on. */
      setEditable(id: string, editable: boolean): void;
    };
  }
}
const HOSTS = [
  ['通常', 'http://127.0.0.1:5173/story-timeline.html'],
  ['独立', 'http://127.0.0.1:4177/story-timeline.html'],
] as const;
const LINKS = 'story-timeline:links';

/** Every stored Artifact and the Story links, canonical, to prove nothing was written. */
async function stored(page: Page): Promise<string> {
  return page.evaluate(async (key) => {
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
      links: localStorage.getItem(key),
    });
  }, LINKS);
}
type Seed = 'unset' | 'changed-draft' | 'missing-manuscript' | 'empty';
/** Changes stored data the way another editor would, before the reading page loads. */
async function seed(page: Page, kind: Seed) {
  await page.evaluate(
    async ({ kind, key }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('editor-platform', 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const tx = db.transaction('artifacts', 'readwrite');
      const store = tx.objectStore('artifacts');
      const get = (id: string) =>
        new Promise<{
          draft: { content: { rows: { id: string; values: Record<string, unknown> }[] } };
        }>((resolve) => {
          const r = store.get(id);
          r.onsuccess = () => resolve(r.result);
        });
      if (kind === 'unset') {
        const a = await get('story-ledger-A');
        const ev = a.draft.content.rows.find((r) => r.id === 'EV-101')!;
        Object.assign(ev.values, { 'tl1.time.kind': 'unset', 'tl1.time.start': null });
        store.put(a);
      } else if (kind === 'changed-draft') {
        const a = await get('story-ledger-A');
        const ev = a.draft.content.rows.find((r) => r.id === 'EV-104')!;
        ev.values['tl1.label'] = '主人公がS1を使わずに切り抜ける';
        store.put(a);
      } else if (kind === 'missing-manuscript') {
        store.delete('manuscript-ch08');
      } else {
        for (const id of [
          'story-ledger-A',
          'story-ledger-B',
          'scene-cards-A',
          'scene-cards-B',
          'world-S',
          'composition-S',
        ]) {
          const a = await get(id);
          a.draft.content.rows = [];
          store.put(a);
        }
        const links = JSON.parse(localStorage.getItem(key)!);
        localStorage.setItem(key, JSON.stringify({ ...links, occurrenceLinks: [] }));
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { kind, key: LINKS },
  );
}
async function createSample(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: '見本の作品を作成' }).click();
  await expect(page.getByRole('tab', { name: '世界時間' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.tl-item').first()).toBeVisible();
}
/** Keystrokes, IME-less text, undo/redo and a paste on whatever is focused in a trip (TL20). */
async function tryToChange(page: Page) {
  const surface = page.locator('.tl-trip-surface');
  await expect(surface).toBeVisible();
  const targets = surface.locator('[tabindex], [role="gridcell"], p, canvas, svg');
  const n = Math.min(await targets.count(), 3);
  for (let i = 0; i < Math.max(n, 1); i++) {
    if (n) await targets.nth(i).click({ force: true, position: { x: 4, y: 4 } });
    await page.keyboard.type('改変');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+y');
    await page.keyboard.press('Control+x');
    await page.keyboard.press('Control+v');
    await page.evaluate(() => {
      const t = document.activeElement ?? document.body;
      const data = new DataTransfer();
      data.setData('text/plain', '貼り付けた文');
      t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    });
  }
  await expect(surface.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByText('改変')).toHaveCount(0);
  await expect(page.getByText('貼り付けた文')).toHaveCount(0);
}
const items = (page: Page) => page.locator('#tl-panel .tl-item');
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
}

for (const [host, url] of HOSTS) {
  test.describe(`${host}Host`, () => {
    test('TL31: F0を世界時間・構成の提示順・世界線で読む', async ({ page }) => {
      await createSample(page, url);
      await expect(page.getByRole('note').first()).toContainText(
        '導出時点は参照から計算した表示です。明示された時間制約を個別に確認します。編集・認識等の意味診断は行わず',
      );
      // World A: six events by day; EV-103 is cited by no scene.
      await expect(items(page).locator('.tl-label')).toHaveText([
        '王の即位',
        '暗号文S1が作られる',
        '敵が橋を破壊する',
        '密使が壊れた橋を見つけて迂回する',
        '主人公がS1だけにある情報を使う',
        '密使が主人公へS1を届ける',
      ]);
      await expect(items(page).filter({ hasText: '密使が主人公へS1を届ける' })).toContainText(
        '裏の出来事',
      );
      // World B: inherits EV-001/002 from A at the exact version, then its own three.
      await page.getByLabel('世界', { exact: true }).selectOption('WL-B');
      await expect(items(page).locator('.tl-label')).toHaveText([
        '王の即位',
        '暗号文S1が作られる',
        '橋の破壊計画が阻止される',
        '密使が橋を渡りS1を届ける',
        '主人公がS1の情報を使う',
      ]);
      await expect(items(page).filter({ hasText: '継承 fixture-v1' })).toHaveCount(2);
      // Presentation order: a flashback and SC-001 presented twice.
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await expect(items(page).locator('.tl-label')).toHaveText([
        '第1話 SC-001（受入のoccurrence-sc001-first）',
        '第2話 SC-002',
        '第3話 SC-004',
        '第5話 SC-005',
        '第8話 SC-003（回想）',
        '第8話 SC-001 再提示（受入のoccurrence-sc001-reprise）',
      ]);
      await expect(page.locator('#tl-panel .tl-regions', { hasText: '原稿未接続' })).toHaveCount(3);
      await expect(page.getByRole('button', { name: /^原稿を開く/ })).toHaveCount(4);
      // World lines: B branches from A at 2.
      await page.getByRole('tab', { name: '世界線' }).click();
      await expect(page.locator('.tl-tree .tl-tree .tl-item')).toContainText('世界B');
      await expect(page.locator('.tl-tree .tl-tree .tl-item')).toContainText('分岐 2');
      await noOverflow(page);
    });

    test('TL32: 表示・選択・原稿/元資料への往復は保存を変えず、戻り先を保つ', async ({ page }) => {
      await createSample(page, url);
      const before = await stored(page);
      await page.getByLabel('世界', { exact: true }).selectOption('WL-B');
      await items(page).filter({ hasText: '橋の破壊計画が阻止される' }).click();
      const details = page.getByRole('complementary', { name: '詳細' });
      await expect(details).toContainText('世界B');
      // Source owner, read-only, with the row named.
      await details.getByRole('button', { name: /元資料を開く/ }).click();
      await expect(page.getByRole('button', { name: '戻る' })).toBeFocused();
      await expect(page.locator('.tl-row-cue')).toContainText('EV-201');
      await expect(page.getByRole('note')).toHaveText(
        '読み取り専用で開いています。変更はできません。',
      );
      await expect(page.locator('.tl-trip-surface [contenteditable="true"]')).toHaveCount(0);
      await page.getByRole('button', { name: '戻る' }).click();
      await expect(details.getByRole('button', { name: /元資料を開く/ })).toBeFocused();
      await expect(page.getByLabel('世界', { exact: true })).toHaveValue('WL-B');
      await expect(items(page).filter({ hasText: '橋の破壊計画が阻止される' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      // Manuscript at the exact version, focused on the region, then back.
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await items(page).filter({ hasText: '再提示' }).click();
      const open = page.getByRole('button', {
        name: '原稿を開く（manuscript-ch08 · region-ch08-sc001）',
      });
      await open.first().click();
      await expect(page.getByRole('heading', { name: '第8話 · fixture-v1' })).toBeVisible();
      await expect(page.getByRole('note')).toHaveText(
        '読み取り専用で開いています。変更はできません。',
      );
      await expect(page.locator('.tl-trip-surface [contenteditable="true"]')).toHaveCount(0);
      await page.keyboard.press('Enter'); // focus is on 戻る
      await expect(page.getByRole('tab', { name: '構成の提示順' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(open.first()).toBeFocused();
      await expect(items(page).filter({ hasText: '再提示' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      // Keyboard: arrows move between the three readings.
      await page.getByRole('tab', { name: '構成の提示順' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('tab', { name: '世界線' })).toBeFocused();
      await expect(page.getByRole('tab', { name: '世界線' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await page.reload();
      await expect(page.locator('.tl-item').first()).toBeVisible();
      expect(await stored(page)).toBe(before);
    });

    test('TL20: 元資料（Data）と原稿（Document）の中でキー入力・取り消し・貼り付けをしても保存を変えない', async ({
      page,
    }) => {
      await createSample(page, url);
      const before = await stored(page);
      await items(page).filter({ hasText: '敵が橋を破壊する' }).click();
      await page
        .getByRole('complementary', { name: '詳細' })
        .getByRole('button', { name: /元資料を開く/ })
        .click();
      await tryToChange(page);
      await page.getByRole('button', { name: '戻る' }).click();
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await items(page).filter({ hasText: '再提示' }).click();
      await page
        .getByRole('button', { name: '原稿を開く（manuscript-ch08 · region-ch08-sc001）' })
        .first()
        .click();
      await expect(page.getByRole('heading', { name: '第8話 · fixture-v1' })).toBeVisible();
      await tryToChange(page);
      await page.getByRole('button', { name: '戻る' }).click();
      await page.reload();
      await expect(page.locator('.tl-item').first()).toBeVisible();
      expect(await stored(page)).toBe(before);
    });

    test('TL29a: 原稿への反映の入口は無く、構成の提示順を原稿反映済みとは示さない', async ({
      page,
    }) => {
      await createSample(page, url);
      for (const tab of ['世界時間', '構成の提示順', '世界線']) {
        await page.getByRole('tab', { name: tab }).click();
        await items(page).first().click();
        await expect(page.getByRole('button', { name: /反映/ })).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText('反映済み');
      }
    });

    test('TL33: 未定時点・欠落参照・空状態を推定補完せずに表示する', async ({ page }) => {
      await createSample(page, url);
      // Unset time: not placed at day 0, shown as unplaced.
      await seed(page, 'unset');
      await page.reload();
      await expect(page.locator('[data-unplaced] .tl-item')).toHaveText(/敵が橋を破壊する/);
      await expect(page.locator('[data-unplaced] .tl-item')).toContainText('時点未定');
      await expect(items(page).filter({ hasText: '敵が橋を破壊する' })).toHaveCount(1);
      await noOverflow(page);
      // A changed draft: the SC cites the saved version, so it is not shown as depicting the draft.
      await seed(page, 'changed-draft');
      await page.reload();
      await items(page).filter({ hasText: '主人公がS1を使わずに切り抜ける' }).click();
      const details = page.getByRole('complementary', { name: '詳細' });
      await expect(details).toContainText('今の内容を描いた場面はありません');
      await expect(details.locator('[data-fixed-scenes]')).toContainText(
        'fixture-v1を引用・再確認',
      );
      await expect(items(page).filter({ hasText: '裏の出来事' })).toHaveCount(1);
      // Missing manuscript: partial, stated, not reconnected elsewhere.
      await seed(page, 'missing-manuscript');
      let before = await stored(page);
      await page.reload();
      await expect(page.locator('[data-scope="partial"]')).toContainText('欠落または不一致');
      await page.getByRole('tab', { name: '構成の提示順' }).click();
      await expect(page.locator('[data-region-state="missing"]')).toHaveText('原稿の位置が欠落');
      await expect(page.getByRole('button', { name: /manuscript-ch08/ })).toHaveCount(0);
      await noOverflow(page);
      expect(await stored(page)).toBe(before);
      // Empty Story: an empty state, not an error.
      await seed(page, 'empty');
      before = await stored(page);
      await page.reload();
      await expect(page.locator('[data-empty]')).toContainText(
        'まだ出来事・場面・提示位置がありません',
      );
      await expect(page.getByRole('alert')).toHaveCount(0);
      for (const tab of ['世界時間', '構成の提示順', '世界線']) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.locator('#tl-panel')).toContainText('まだありません');
      }
      await noOverflow(page);
      expect(await stored(page)).toBe(before);
    });
  });
}

let fixtureBundle: Promise<{ js: string; css: string }>;
async function readingFixture(page: Page, query = '', ready = '.tl-item') {
  fixtureBundle ??= build({
    entryPoints: ['tests/fixtures/story-timeline/main.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/story-timeline-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((r) => ({
    js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css: r.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
  }));
  const files = await fixtureBundle;
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
  await expect(page.locator(ready).first()).toBeVisible();
}

test.describe('公開entryの読取fixture', () => {
  test('TL32: 世界Aの遅延読込が世界Bへの切替後に返っても、現在の表示を上書きしない', async ({
    page,
  }) => {
    await readingFixture(page);
    const world = page.getByLabel('世界', { exact: true });
    await world.selectOption('WL-B');
    await expect(items(page)).toHaveCount(5);
    // Hold the read of world A's query, then switch to B before it returns.
    await page.evaluate(() => window.__timeline.holdNext('composition-S'));
    await world.selectOption('WL-A');
    await expect(page.getByRole('status').filter({ hasText: '読み込んでいます' })).toBeVisible();
    await world.selectOption('WL-B');
    await expect(items(page)).toHaveCount(5);
    const n = await page.evaluate(() => window.__timeline.reads.length);
    await page.evaluate(() => window.__timeline.release());
    // Let the stale query read every remaining owner; the B reading stays.
    await page.waitForFunction((n) => window.__timeline.reads.length >= n + 6, n);
    await page.waitForTimeout(300);
    await expect(world).toHaveValue('WL-B');
    await expect(items(page)).toHaveCount(5);
    await expect(items(page).filter({ hasText: '橋の破壊計画が阻止される' })).toHaveCount(1);
    await expect(items(page).filter({ hasText: '敵が橋を破壊する' })).toHaveCount(0);
  });

  test('TL32: 切替前の古い読込が失敗しても、現在の表示に誤りを出さない', async ({ page }) => {
    await readingFixture(page);
    const world = page.getByLabel('世界', { exact: true });
    await world.selectOption('WL-B');
    await expect(items(page)).toHaveCount(5);
    await page.evaluate(() => window.__timeline.holdNext('composition-S', true));
    await world.selectOption('WL-A');
    await world.selectOption('WL-B');
    await expect(items(page)).toHaveCount(5);
    await page.evaluate(() => window.__timeline.release());
    await page.waitForTimeout(300);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(world).toHaveValue('WL-B');
    await expect(items(page)).toHaveCount(5);
  });

  test('継承した出来事は継承した版で詳しく読み、元資料では保存した表示に隠れた行も示す', async ({
    page,
  }) => {
    await readingFixture(page, '?variant=review');
    await page.getByLabel('世界', { exact: true }).selectOption('WL-B');
    const inherited = items(page).filter({ hasText: '暗号文S1が作られる' });
    await expect(inherited).toHaveCount(1);
    // The source ledger's default clock CL-1 converted to world B's CL-2 (+100).
    await expect(inherited).toContainText('1日目');
    await expect(inherited).toContainText('世界の時計で101日目');
    await inherited.click();
    const details = page.getByRole('complementary', { name: '詳細' });
    await expect(details.getByRole('heading')).toHaveText(['詳細', '暗号文S1が作られる']);
    await expect(details).toContainText('世界B（story-ledger-A の fixture-v1 から継承）');
    await expect(details).toContainText('CH-002@WL-B');
    await expect(details).not.toContainText('CH-002@WL-A');
    await expect(details).not.toContainText('改稿');
    await expect(details).toContainText('世界の時計で101日目');
    await details.getByRole('button', { name: /元資料を開く/ }).click();
    const cue = page.locator('.tl-row-cue');
    await expect(cue).toContainText('行 EV-002「暗号文S1が作られる」を表示しています。');
    // The ledger's saved first view filters EV-002 out; the record is shown regardless.
    await expect(cue.locator('[data-tl-record]')).toContainText('暗号文S1が作られる（改稿）');
    await expect(page.locator('.tl-trip-surface [data-row-id="EV-002"]').first()).toBeVisible();
    await page.getByRole('button', { name: '戻る' }).click();
    await noOverflow(page);
  });

  test('§6.4: 権限を外すと、読み直しの完了を待たずに以前の名前と内容を消す（Ryo #648）', async ({
    page,
  }) => {
    await readingFixture(page);
    await page.getByLabel('世界', { exact: true }).selectOption('WL-B');
    await items(page).filter({ hasText: '橋の破壊計画が阻止される' }).click();
    const details = page.getByRole('complementary', { name: '詳細' });
    await expect(details).toContainText('橋の破壊計画が阻止される');
    // The next reading is held, so only the immediate invalidation can hide the old one.
    await page.evaluate(() => window.__timeline.holdNext('composition-S'));
    await page.evaluate(() => window.__timeline.revoke('story-ledger-B'));
    await expect(page.getByRole('status').filter({ hasText: '読み込んでいます' })).toBeVisible();
    for (const hidden of ['橋の破壊計画が阻止される', 'EV-201', 'story-ledger-B'])
      expect(await page.locator('body').innerText()).not.toContain(hidden);
    await page.evaluate(() => window.__timeline.release());
    await expect(page.locator('[data-scope="partial"]')).toContainText('読めない資料があるため');
    for (const hidden of ['橋の破壊計画が阻止される', 'EV-201', 'story-ledger-B'])
      expect(await page.locator('body').innerText()).not.toContain(hidden);
  });

  test('§6.4: 開いていた元資料も、権限を外すとすぐに閉じる（Ryo #648）', async ({ page }) => {
    await readingFixture(page);
    await page.getByLabel('世界', { exact: true }).selectOption('WL-B');
    await items(page).filter({ hasText: '橋の破壊計画が阻止される' }).click();
    await page
      .getByRole('complementary', { name: '詳細' })
      .getByRole('button', { name: /元資料を開く/ })
      .click();
    await expect(page.locator('.tl-row-cue')).toContainText('EV-201');
    await page.evaluate(() => window.__timeline.holdNext('composition-S'));
    await page.evaluate(() => window.__timeline.revoke('story-ledger-B'));
    await expect(page.locator('.tl-trip')).toHaveCount(0);
    for (const hidden of ['橋の破壊計画が阻止される', 'EV-201', '密使が橋を渡りS1を届ける'])
      expect(await page.locator('body').innerText()).not.toContain(hidden);
    await page.evaluate(() => window.__timeline.release());
    await expect(page.locator('[data-scope="partial"]')).toContainText('読めない資料があるため');
  });

  test('原稿の保存版が読取の後に壊れていたら、開かずに理由を出す（Ryo #648）', async ({ page }) => {
    await readingFixture(page);
    await page.getByRole('tab', { name: '構成の提示順' }).click();
    await items(page).filter({ hasText: '再提示' }).click();
    await page.evaluate(() => window.__timeline.corrupt('manuscript-ch08'));
    await page
      .getByRole('button', { name: '原稿を開く（manuscript-ch08 · region-ch08-sc001）' })
      .first()
      .click();
    await expect(page.getByRole('alert')).toHaveText('原稿の保存版の内容がhashと一致しません。');
    await expect(page.locator('.tl-trip-surface')).toHaveCount(0);
  });

  test('§6.4: 読めない資料は部分表示とだけ伝え、名前や件数を出さない', async ({ page }) => {
    await readingFixture(page, '?unreadable=story-ledger-B&unreadable=manuscript-ch08');
    await expect(page.locator('[data-scope="partial"]')).toContainText('読めない資料があるため');
    await page.getByRole('tab', { name: '構成の提示順' }).click();
    await expect(page.getByText('原稿を読めません')).toBeVisible();
    for (const tab of ['世界時間', '構成の提示順', '世界線']) {
      await page.getByRole('tab', { name: tab }).click();
      const text = await page.locator('body').innerText();
      for (const hidden of ['story-ledger-B', 'EV-20', 'manuscript-ch08', 'p-sc001-reprise'])
        expect(text).not.toContain(hidden);
    }
    await noOverflow(page);
  });

  test('TL20: 原稿（Design）のコマの中でキー入力・取り消し・貼り付けをしても保存を変えない', async ({
    page,
  }) => {
    await readingFixture(page, '?variant=design');
    const before = await page.evaluate(() => window.__timeline.snapshot());
    await page.getByRole('tab', { name: '構成の提示順' }).click();
    await items(page).filter({ hasText: '第1話 SC-001' }).click();
    await page
      .getByRole('button', { name: '原稿を開く（comic-ch01 · region-ch01-sc001）' })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: '第1話の絵 · fixture-v1' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await tryToChange(page);
    await page.getByRole('button', { name: '戻る' }).click();
    expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(before);
  });

  test('TL29b: 共有での表示を求めると拒否し、ローカルにも切り替えず何も読まない', async ({
    page,
  }) => {
    await readingFixture(page, '?shared=1', '[data-shared-refused]');
    await expect(page.getByRole('alert')).toHaveText(
      '共有（shared）での表示にはこの画面は対応していません。ローカルの表示に切り替えることもしません。',
    );
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__timeline.reads)).toEqual([]);
    await expect(page.locator('.tl-item')).toHaveCount(0);
  });

  test('F2の形: 導出の根拠と計算を示し、世界間の移送は両端の版を示す', async ({ page }) => {
    await readingFixture(page, '?variant=transfer');
    await items(page).filter({ hasText: '密使が壊れた橋を見つけて迂回する' }).click();
    const details = page.getByRole('complementary', { name: '詳細' });
    await expect(details.locator('[data-derivation="internal"]')).toHaveText(
      '同じ台帳の EV-101 の始まりから 1日',
    );
    await page.getByLabel('世界', { exact: true }).selectOption('WL-B');
    await items(page).filter({ hasText: '密使が橋を渡りS1を届ける' }).click();
    await expect(details.locator('[data-derivation="resolved"]')).toHaveText(
      'story-ledger-A fixture-v1 · EV-103（time） の始まりから 1日',
    );
    await page.getByRole('tab', { name: '世界線' }).click();
    const transfer = page.locator('[data-transfer="TR-001"]');
    await expect(transfer).toContainText('密使がS1をBへ運ぶ');
    await expect(transfer).toContainText('出発 story-ledger-A fixture-v1 · EV-103');
    await expect(transfer).toContainText('到着 story-ledger-B fixture-v1 · EV-202');
    await expect(transfer).toContainText('運ぶ情報 S1');
    await expect(page.getByRole('region', { name: '世界間の移送' })).toContainText(
      '到着側が情報を得たかどうかは、この段階では判定しません',
    );
    await noOverflow(page);
  });

  for (const [hidden, names] of [
    ['story-ledger-A', ['story-ledger-A', 'EV-103', '密使が主人公へS1を届ける']],
    ['story-ledger-B', ['story-ledger-B', 'EV-202', '密使が橋を渡りS1を届ける']],
  ] as const)
    test(`TL26: ${hidden} を読めないとき、移送の端と導出元は名前を出さず読めないとだけ示す`, async ({
      page,
    }) => {
      await readingFixture(
        page,
        `?variant=transfer&unreadable=${hidden}`,
        '[data-scope="partial"]',
      );
      await page.getByRole('tab', { name: '世界線' }).click();
      const transfer = page.locator('[data-transfer="TR-001"]');
      await expect(transfer).toContainText('読めない参照');
      await expect(transfer.locator('.tl-badge')).toHaveText(['読めません']);
      if (hidden === 'story-ledger-A') {
        await page.getByRole('tab', { name: '世界時間' }).click();
        await page.getByLabel('世界', { exact: true }).selectOption('WL-B');
        await items(page).filter({ hasText: '密使が橋を渡りS1を届ける' }).click();
        await expect(
          page.getByRole('complementary', { name: '詳細' }).locator('[data-derivation]'),
        ).toHaveAttribute('data-derivation', 'unreadable');
      }
      for (const tab of ['世界時間', '構成の提示順', '世界線']) {
        await page.getByRole('tab', { name: tab }).click();
        const text = await page.locator('body').innerText();
        for (const n of names) expect(text).not.toContain(n);
      }
    });

  test('TL23・TL29c: 後の版の列と幅のある時計の換算は、未対応と名前を挙げて読まず、保存を変えない', async ({
    page,
  }) => {
    await readingFixture(page, '?variant=later', '[data-owner-state]');
    const before = await page.evaluate(() => window.__timeline.snapshot());
    await expect(page.locator('[data-owner-state="invalid"]')).toHaveText([
      'world-S：表の形式が契約と合わないため読めません。（幅のある時計の換算（最小日数と最大日数が違う換算）には対応していません。同じ値の換算だけを読みます。）',
      'story-ledger-B：表の形式が契約と合わないため読めません。（tl2 の表にはこの画面は対応していません（tl1 だけを読みます）。表は変えずに保持しています。）',
    ]);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__timeline.snapshot())).toBe(before);
  });

  test('TL30a: 表ごとには上限内でも投影の上限を超えると、理由を出して表示しない', async ({
    page,
  }) => {
    await readingFixture(page, '?variant=limit', '[role="alert"]');
    await expect(page.getByRole('alert')).toHaveText(
      'タイムラインの投影は events が 1000 までです（1200）。台帳やシーンカードを世界・巻で分けた作品は、範囲を絞って開いてください。',
    );
    await expect(page.locator('.tl-item')).toHaveCount(0);
    await noOverflow(page);
  });

  test('継承した導出の出来事は、継承した保存版の導出元を詳細に示す（Ryo #651 P2）', async ({
    page,
  }) => {
    await readingFixture(page, '?variant=transfer');
    const world = page.getByLabel('世界', { exact: true });
    const details = page.getByRole('complementary', { name: '詳細' });
    await world.selectOption('WL-B');
    await items(page).filter({ hasText: '密使が壊れた橋を見つけて迂回する' }).click();
    await expect(details.locator('[data-inherited-detail]')).toContainText(
      'story-ledger-A の fixture-v2 から継承',
    );
    await expect(details.locator('[data-derivation="internal"]')).toHaveText(
      '同じ台帳の EV-101 の始まりから 1日',
    );
    await world.selectOption('WL-C');
    await items(page).filter({ hasText: '密使が橋を渡りS1を届ける' }).click();
    await expect(details.locator('[data-inherited-detail]')).toContainText(
      'story-ledger-B の fixture-v2 から継承',
    );
    await expect(details.locator('[data-derivation="resolved"]')).toHaveText(
      'story-ledger-A fixture-v1 · EV-103（time） の始まりから 1日',
    );
  });

  test('継承した導出の元を読めないときは、読めないとだけ示す（Ryo #651 P2）', async ({ page }) => {
    await readingFixture(
      page,
      '?variant=transfer&unreadable=story-ledger-A',
      '[data-scope="partial"]',
    );
    await page.getByLabel('世界', { exact: true }).selectOption('WL-C');
    await items(page).filter({ hasText: '密使が橋を渡りS1を届ける' }).click();
    const details = page.getByRole('complementary', { name: '詳細' });
    await expect(details.locator('[data-derivation="unreadable"]')).toContainText('読めない参照');
    const text = await page.locator('body').innerText();
    for (const hidden of ['story-ledger-A', 'EV-103', '密使が主人公へS1を届ける'])
      expect(text).not.toContain(hidden);
  });

  test('世界線が無い世界設定でも、書かれた移送は示す（Ryo #651 P3）', async ({ page }) => {
    await readingFixture(page, '?variant=transfer&noworlds=1', '[role="tab"]');
    await page.getByRole('tab', { name: '世界線' }).click();
    await expect(page.locator('#tl-panel')).toContainText('世界線がまだありません。');
    await expect(page.locator('[data-transfer="TR-001"]')).toContainText('密使がS1をBへ運ぶ');
    await noOverflow(page);
  });
});
