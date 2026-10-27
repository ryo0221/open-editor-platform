import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { test, expect } from './fixtures';
import type { Page, TestInfo } from '@playwright/test';

// Issue #402: single-user browser boundary. The multi-user case (another person changes a
// reference between review and apply) is the authority unit test; a production
// authority's atomic compare-and-set is NOT RUN here.
const bundled = build({
  entryPoints: [fileURLToPath(new URL('../fixtures/proposal-reads/host.tsx', import.meta.url))],
  bundle: true,
  write: false,
  outdir: '/tmp/proposal-reads-host',
  format: 'esm',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
async function mount(page: Page) {
  await page.route('**/proposal-reads.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>',
    }),
  );
  await page.goto('/proposal-reads.html');
  for (const file of (await bundled).outputFiles!)
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text, type: 'module' });
  await expect(page.getByRole('heading', { name: '提案の鮮度確認' })).toBeVisible();
}
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const plan = (page: Page) => page.getByRole('list', { name: '企画書の内容' }).getByRole('listitem');
const initial = ['新製品の企画書', '発売日：未定', '制作期間：未定', '備考：販路は別紙'];
async function proposeAndPreview(page: Page) {
  await button(page, '提案を作る').click();
  await button(page, 'プレビュー').click();
  await expect(page.getByLabel('提案の状態')).toHaveText('プレビュー中');
  await expect(page.getByRole('list', { name: '提案の結果' }).getByRole('listitem')).toHaveText([
    '新製品の企画書',
    '発売日：2026-12-01',
    '制作期間：11週',
    '備考：販路は別紙',
  ]);
}
async function expectRefused(page: Page, reason: string, info: TestInfo, name: string) {
  await button(page, '採用').click();
  await expect(page.getByLabel('提案の状態')).toHaveText('古い提案');
  await expect(page.getByRole('list', { name: '古い理由' }).getByRole('listitem')).toHaveText([
    reason,
  ]);
  await expect(plan(page)).toHaveText(initial);
  await expect(page.getByLabel('企画書の版')).toHaveText('1');
  await expect(page.getByRole('list', { name: '提案の結果' })).toHaveCount(0);
  // The stale proposal is kept until the person discards or regenerates it.
  await expect(button(page, '破棄')).toBeEnabled();
  await page.screenshot({ path: info.outputPath(name + '.png'), fullPage: true });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('proposal-reads:keep')) localStorage.clear();
    sessionStorage.setItem('proposal-reads:keep', '1');
  });
});

for (const [action, reason, name] of [
  ['Calendarを更新', 'calendar：版が変わった', 'calendar-changed'],
  ['Dataを更新', 'data：版が変わった', 'data-changed'],
  ['Dataを削除', 'data：削除された', 'data-removed'],
  ['Calendarの権限を外す', 'calendar：閲覧権限が無い', 'calendar-forbidden'],
] as const)
  test(`refuses a proposal after the preview when a reference is ${name}`, async ({
    page,
  }, info) => {
    await mount(page);
    await proposeAndPreview(page);
    await button(page, action).click();
    await expectRefused(page, reason, info, name);
    // Preview again refuses too, without showing a stale result.
    await button(page, 'プレビュー').click();
    await expect(page.getByRole('list', { name: '提案の結果' })).toHaveCount(0);
    await button(page, '破棄').click();
    await expect(page.getByLabel('提案の状態')).toHaveText('破棄した');
    await expect(plan(page)).toHaveText(initial);
  });

test('a regenerated proposal on current references is adopted, saved and reloaded', async ({
  page,
}, info) => {
  await mount(page);
  await button(page, '提案を作る').click();
  await button(page, 'Calendarを更新').click();
  await expect(page.getByLabel('Calendarの版')).toHaveText('2');
  await button(page, 'プレビュー').click();
  await expect(page.getByRole('list', { name: '古い理由' }).getByRole('listitem')).toHaveText([
    'calendar：版が変わった',
  ]);
  // Regenerate from the current Calendar, then review and adopt the whole proposal.
  await button(page, '提案を作る').click();
  await button(page, 'プレビュー').click();
  await expect(page.getByLabel('提案の状態')).toHaveText('プレビュー中');
  await button(page, '採用').click();
  await expect(page.getByLabel('提案の状態')).toHaveText('採用した');
  const adopted = ['新製品の企画書', '発売日：2027-01-15', '制作期間：11週', '備考：販路は別紙'];
  await expect(plan(page)).toHaveText(adopted);
  await button(page, '保存').click();
  await expect(page.getByLabel('企画書の版')).toHaveText('2');
  await page.reload();
  for (const file of (await bundled).outputFiles!)
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text, type: 'module' });
  await expect(plan(page)).toHaveText(adopted);
  await expect(page.getByLabel('企画書の版')).toHaveText('2');
  await expect(page.getByLabel('Calendarの版')).toHaveText('2');
  await page.screenshot({ path: info.outputPath('adopted-reloaded.png'), fullPage: true });
});
