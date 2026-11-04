import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, setDocumentText } from './fixtures';
import type { CreativeWorkspaceLinks } from '@editor-platform/reference-artifact-host/creative/workspace';

test.setTimeout(90000);
async function boot(page: Page) {
  await page.goto('/creative-production.html');
  await page.getByRole('button', { name: '港町の制作例を作成' }).click();
  await expect(page.getByRole('heading', { name: '港町の物語 · 小説と漫画' })).toBeVisible();
}
async function references(page: Page, comic = false) {
  if (comic)
    await expect(
      page.getByRole('application', { name: 'Design canvas', exact: true }),
    ).toBeVisible();
  const label = comic ? 'Design inspector' : '原稿と照合';
  const pane = page.getByRole('complementary', { name: label, exact: true });
  if (!(await pane.isVisible()))
    await page.getByRole('button', { name: `Toggle ${label}`, exact: true }).click();
  await expect(
    pane.locator('.production-references:not(.world-context) article').first(),
  ).toBeVisible();
  if (!comic)
    await expect(pane.locator('summary').filter({ hasText: '参照：地図・画像' })).toBeVisible();
  return pane;
}
async function close(page: Page) {
  for (const name of [
    '原稿と照合',
    'Design inspector',
    '人物の部位',
    '場所の部位',
    '部位の編集',
    '章・シーン',
  ]) {
    const button = page.getByRole('button', { name: `Close ${name}`, exact: true });
    if (await button.isVisible()) await button.click();
  }
}
async function native<T>(page: Page, label: string): Promise<T> {
  await close(page);
  const details = page.locator(
    label === 'Scene参照JSON' || label === '原稿native JSON'
      ? '.production-export'
      : '.creative-export',
  );
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  const pending = page.waitForEvent('download');
  await details.getByRole('button', { name: label, exact: true }).click();
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}
async function part(page: Page, name: string, setting = false) {
  await close(page);
  const label = setting ? '場所の部位' : '人物の部位';
  await page.getByRole('button', { name: `Toggle ${label}`, exact: true }).click();
  const p = page.getByRole('complementary', { name: label, exact: true });
  await p.getByRole('button', { name, exact: true }).click();
  await p.getByRole('button', { name: `Close ${label}`, exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '部位の編集', exact: true });
  if (!(await inspector.isVisible()))
    await page.getByRole('button', { name: 'Toggle 部位の編集', exact: true }).click();
  return inspector;
}
async function saveAndReturn(page: Page) {
  await close(page);
  await page.getByRole('button', { name: '設定と設定画を保存', exact: true }).click();
  await expect(page.locator('.creative-actions [role=status]')).toHaveText('保存しました');
  await page.getByRole('button', { name: '元のSceneへ戻る', exact: true }).click();
  await expect(page.getByRole('heading', { name: '港町の物語 · 小説と漫画' })).toBeVisible();
}

test('Scene → character editing → original selection, explicit version update and shared identity after reload', async ({
  page,
}, info) => {
  await boot(page);
  await setDocumentText(
    page,
    'p[data-block-id="port-text"]',
    '港へ。美緒は潮見の街を歩き、灯台守の手紙を握りしめた。',
  );
  await expect(page.locator('.ProseMirror p[data-block-id="port-text"]')).toContainText('港へ。');
  await close(page);
  await page.getByRole('button', { name: 'Documentで詳細編集', exact: true }).click();
  await expect(page.getByRole('button', { name: '小説ワークスペース', exact: true })).toBeVisible();
  await expect(page.locator('.ProseMirror p[data-block-id="port-text"]')).toContainText('港へ。');
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Documentで詳細編集', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '原稿を元に戻す', exact: true }).click();
  await expect(page.locator('.ProseMirror p[data-block-id="port-text"]')).not.toContainText(
    '港へ。',
  );
  await page.getByRole('button', { name: '原稿をやり直す', exact: true }).click();
  await expect(page.locator('.ProseMirror p[data-block-id="port-text"]')).toContainText('港へ。');
  await page.getByRole('button', { name: '原稿を保存・Scene参照版を確認', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '原稿は保存済み' })).toBeVisible();
  const before = await native<CreativeWorkspaceLinks>(page, 'Scene参照JSON');
  const paragraph = page.locator('.ProseMirror p[data-block-id="port-text"]');
  await paragraph.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  const refs = await references(page);
  await refs.getByRole('button', { name: 'Character Modeを開く · CH-01', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'キャラクター設計', exact: true })).toBeVisible();
  const inspector = await part(page, '前髪');
  const x = inspector.getByLabel('X', { exact: true });
  const old = await x.inputValue();
  await x.fill(String(Number(old) + 9));
  await x.press('Enter');
  await close(page);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await saveAndReturn(page);
  const returned = await native<CreativeWorkspaceLinks>(page, 'Scene参照JSON');
  expect(returned.returnTo?.address.elementId).toBe('port-text');
  expect(returned.returnTo?.address.region?.type).toBe('text');
  expect(returned.scenes[0].items).toEqual(before.scenes[0].items);
  const pane = await references(page);
  const hero = pane.locator('article').filter({ hasText: 'CH-01 ·' });
  await expect(hero).toHaveAttribute('data-reference-state', 'stale');
  await hero.getByRole('button', { name: 'このSceneの参照版を更新 · CH-01', exact: true }).click();
  await expect(hero).toHaveAttribute('data-reference-state', 'current');
  await close(page);
  await setDocumentText(
    page,
    'p[data-block-id="port-text"]',
    '港へ。美緒は灯台守の手紙を読み返した。',
  );
  await page.getByRole('button', { name: '原稿を保存・Scene参照版を確認', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '原稿は保存済み' })).toBeVisible();
  const updated = await native<CreativeWorkspaceLinks>(page, 'Scene参照JSON');
  expect(updated.returnTo!.versionId).toBe(updated.scenes[0].origin.versionId);
  expect(updated.scenes[0].items[0].artwork.versionId).not.toBe(
    before.scenes[0].items[0].artwork.versionId,
  );
  expect(updated.scenes[1].items[0]).toEqual(before.scenes[1].items[0]);
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const node = window.getSelection()?.anchorNode;
        const element = node instanceof Element ? node : node?.parentElement;
        return element?.closest('[data-block-id]')?.getAttribute('data-block-id');
      }),
    )
    .toBe('port-text');
  await references(page);
  await expect(
    page.locator('.production-references:not(.world-context) article').first(),
  ).toHaveAttribute('data-reference-state', 'current');
  await close(page);
  await page.getByRole('button', { name: 'SC-02 · 小説', exact: true }).click();
  const other = await references(page);
  await expect(
    other.locator('.production-references:not(.world-context) article').first(),
  ).toHaveAttribute('data-reference-state', 'stale');
  await other.getByRole('button', { name: 'Character Modeを開く · CH-01', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'キャラクター設計', exact: true })).toBeVisible();
  expect(await (await part(page, '前髪')).getByLabel('X', { exact: true }).inputValue()).toBe(
    String(Number(old) + 9),
  );
  await close(page);
  await page.getByRole('button', { name: '元のSceneへ戻る', exact: true }).click();
  await expect(page.locator('.production-scene')).toContainText('SC-02');
  await page.screenshot({ path: `/tmp/d3-${info.project.name}-character.png`, fullPage: true });
});
test('Comic → setting proposal preview/reject/apply → same page; no automatic version retarget or duplicate source', async ({
  page,
}, info) => {
  await boot(page);
  await close(page);
  await page.getByRole('button', { name: 'SC-03 · 漫画', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Design canvas', exact: true })).toBeVisible();
  await close(page);
  await page.getByRole('button', { name: 'Designで詳細編集', exact: true }).click();
  await expect(page.getByRole('button', { name: '漫画ワークスペース', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '漫画ワークスペース', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Designで詳細編集', exact: true })).toBeVisible();
  const before = await native<CreativeWorkspaceLinks>(page, 'Scene参照JSON');
  const refs = await references(page, true);
  await refs.getByRole('button', { name: 'Setting Modeを開く · LO-02', exact: true }).click();
  await expect(page.getByRole('heading', { name: '舞台設計', exact: true })).toBeVisible();
  const p = await part(page, '屋根', true);
  await p.getByLabel('部位の操作', { exact: true }).selectOption('proposal');
  await p.getByLabel('塗り', { exact: true }).fill('#7755aa');
  await p.getByLabel('塗り', { exact: true }).press('Enter');
  await p.getByRole('button', { name: '変更案をプレビュー', exact: true }).click();
  await p.getByRole('button', { name: '変更案を却下', exact: true }).click();
  await p.getByLabel('塗り', { exact: true }).fill('#557788');
  await p.getByLabel('塗り', { exact: true }).press('Enter');
  await p.getByRole('button', { name: '変更案をプレビュー', exact: true }).click();
  await p.getByRole('button', { name: '変更案を適用', exact: true }).click();
  await saveAndReturn(page);
  await expect(page.locator('.production-scene')).toContainText('SC-03');
  const after = await native<CreativeWorkspaceLinks>(page, 'Scene参照JSON');
  expect(after.scenes).toEqual(before.scenes);
  expect(after.returnTo?.address.elementId).toBe('page-port');
  const pane = await references(page, true);
  const town = pane.locator('article[data-reference-state]').filter({ hasText: 'LO-02 ·' });
  await expect(town).toHaveAttribute('data-reference-state', 'stale');
  await town.getByRole('button', { name: 'このSceneの参照版を更新 · LO-02', exact: true }).click();
  await expect(town).toHaveAttribute('data-reference-state', 'current');
  await page.reload();
  await references(page, true);
  await expect(page.locator('.production-scene')).toContainText('SC-03');
  await page.screenshot({ path: `/tmp/d3-${info.project.name}-comic.png`, fullPage: true });
  const records = await page.evaluate(
    () =>
      new Promise<{ id: string; kind: string }[]>((resolve, reject) => {
        const r = indexedDB.open('editor-platform', 1);
        r.onsuccess = () => {
          const db = r.result;
          const q = db.transaction('artifacts').objectStore('artifacts').getAll();
          q.onsuccess = () => {
            resolve(
              q.result.map((a: { id: string; kind: string }) => ({ id: a.id, kind: a.kind })),
            );
            db.close();
          };
          q.onerror = () => reject(q.error);
        };
      }),
  );
  expect(records.filter((a) => a.kind === 'data')).toHaveLength(1);
  expect(records.filter((a) => a.id === 'd3a:world-notes')).toHaveLength(1);
});
test('missing exact references stay explicit; viewer can return but cannot mutate settings', async ({
  page,
}) => {
  await boot(page);
  const pins = await native<CreativeWorkspaceLinks>(page, 'Scene参照JSON');
  const ref = pins.scenes[0].items[0];
  await page.evaluate(async (id) => {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open('editor-platform', 1);
      r.onsuccess = () => {
        const db = r.result,
          tx = db.transaction('artifacts', 'readwrite');
        tx.objectStore('artifacts').delete(id);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, ref.artwork.artifactId);
  const pane = await references(page);
  await pane.getByRole('button', { name: '参照状態を再確認', exact: true }).click();
  const missing = pane.locator('article').filter({ hasText: 'CH-01 ·' });
  await expect(missing).toHaveAttribute('data-reference-state', 'missing');
  await expect(
    missing.getByRole('button', { name: 'Character Modeを開く · CH-01', exact: true }),
  ).toBeDisabled();
  expect((await native<CreativeWorkspaceLinks>(page, 'Scene参照JSON')).scenes).toEqual(pins.scenes);
  await page.goto('/creative-production.html?access=viewer');
  const viewer = await references(page);
  await viewer.getByRole('button', { name: 'Setting Modeを開く · LO-02', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '設定と設定画を保存', exact: true }),
  ).toBeDisabled();
  await close(page);
  await page.getByRole('button', { name: '元のSceneへ戻る', exact: true }).click();
  await expect(page.locator('.production-scene')).toContainText('SC-01');
  expect((await native<CreativeWorkspaceLinks>(page, 'Scene参照JSON')).scenes).toEqual(pins.scenes);
  await page.getByRole('button', { name: 'SC-03 · 漫画', exact: true }).click();
  const comic = await references(page, true);
  await comic.getByRole('button', { name: 'Setting Modeを開く · LO-02', exact: true }).click();
  await expect(page.getByRole('heading', { name: '舞台設計', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '設定と設定画を保存', exact: true }),
  ).toBeDisabled();
  await close(page);
  await page.getByRole('button', { name: '元のSceneへ戻る', exact: true }).click();
  await expect(page.getByRole('heading', { name: '港町の物語 · 小説と漫画' })).toBeVisible();
  await expect(page.locator('.production-scene')).toContainText('SC-03');
});
