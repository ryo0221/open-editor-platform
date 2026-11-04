import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import type { Artifact } from '@editor-platform/artifact-core';
import type { DesignContent } from '@editor-platform/design/model';
import type { CreativeWorkspaceLinks } from '@editor-platform/reference-artifact-host/creative/workspace';
import { test, expect } from './fixtures';
let bundle: Promise<{ js: string; css: string }>;
async function fixture(page: Page, query = '') {
  bundle ??= build({
    entryPoints: ['tests/fixtures/creative-world-context/review.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/cw1-review-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((r) => ({
    js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css: r.outputFiles!.find((f) => f.path.endsWith('.css'))!.text,
  }));
  const files = await bundle;
  await page.route('**/cw1-review.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await page.route('**/cw1-review.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await page.route('**/cw1-review-host*', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/cw1-review.css"><div id="root"></div><script type="module" src="/cw1-review.js"></script>',
    }),
  );
  await page.goto('/cw1-review-host?' + query);
}
const links = (page: Page): Promise<CreativeWorkspaceLinks> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('creative-design:production:harbor')!));
async function panel(page: Page, name: string) {
  const toggle = page.getByRole('button', { name: `Toggle ${name}`, exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const p = page.getByRole('complementary', { name, exact: true });
  await expect(p).toBeVisible();
  return p;
}
async function close(page: Page) {
  for (const name of [
    '原稿と照合',
    '章・シーン',
    '人物の部位',
    '場所の部位',
    '部位の編集',
    'Design navigator',
    'Design inspector',
  ]) {
    const b = page.getByRole('button', { name: `Close ${name}`, exact: true });
    if (await b.isVisible()) await b.click();
  }
}
async function stage(page: Page, id: string) {
  const input = page.locator(`[data-world-reference="${id}"]:visible input`).first();
  const value = await input.inputValue();
  await input.fill('pending');
  await input.fill(value);
}
for (const host of ['production', 'standalone'] as const)
  for (const mode of ['character', 'setting'] as const) {
    test(`${host} ${mode}: card and candidate contexts stay independent across delayed save and reload`, async ({
      page,
    }, info) => {
      await fixture(page, host === 'production' ? '' : `host=${mode}`);
      if (host === 'production') {
        await expect(
          page.getByRole('textbox', { name: 'Document body', exact: true }),
        ).toBeVisible();
        if (mode === 'setting') {
          await close(page);
          await page.getByRole('button', { name: 'SC-02 · 小説', exact: true }).click();
          await expect(page.locator('.production-scene')).toContainText('SC-02');
        }
        const p = await panel(page, '原稿と照合');
        await p
          .getByRole('button', {
            name:
              mode === 'character' ? 'Character Modeを開く · CH-01' : 'Setting Modeを開く · LO-01',
            exact: true,
          })
          .click();
      }
      await expect(
        page.getByRole('application', { name: 'Design canvas', exact: true }),
      ).toBeVisible();
      await close(page);
      const prefix = mode === 'character' ? 'CH' : 'LO';
      await page
        .locator('.creative-cards nav button')
        .filter({ hasText: `${prefix}-02` })
        .click();
      let p = await panel(page, '部位の編集');
      const itemPane = p.locator('[data-world-context^="item:"]');
      await expect(itemPane).toContainText(`target-${prefix}-02-`);
      const firstKey = await itemPane.getAttribute('data-world-context');
      const before = await links(page),
        ticket = before.returnTo;
      const first = before.world!.contexts.find((c) => c.id === firstKey)!;
      await stage(page, first.references[0].id);
      await itemPane
        .getByRole('button', { name: `採用版を保存 · ${firstKey}`, exact: true })
        .click();
      await expect
        .poll(
          async () => (await links(page)).world!.contexts.find((c) => c.id === firstKey)!.revision,
        )
        .toBe(first.revision + 1);
      await close(page);
      await page
        .locator('.creative-candidates article')
        .nth(1)
        .getByRole('button', { name: 'この候補を選ぶ', exact: true })
        .click();
      p = await panel(page, '部位の編集');
      const secondKey = await p
        .locator('[data-world-context^="item:"]')
        .getAttribute('data-world-context');
      expect(secondKey).not.toBe(firstKey);
      const second = before.world!.contexts.find((c) => c.id === secondKey)!;
      await expect(p.locator('[data-world-context^="item:"]')).toContainText(
        second.references[0].id,
      );
      await stage(page, second.references[0].id);
      // An unsaved reference choice stays with B while the author visits A and returns.
      await close(page);
      await page
        .locator('.creative-candidates article')
        .first()
        .getByRole('button', { name: 'この候補を選ぶ', exact: true })
        .click();
      p = await panel(page, '部位の編集');
      await expect(p.locator('[data-world-context^="item:"]')).toHaveAttribute(
        'data-world-context',
        firstKey!,
      );
      await close(page);
      await page
        .locator('.creative-candidates article')
        .nth(1)
        .getByRole('button', { name: 'この候補を選ぶ', exact: true })
        .click();
      p = await panel(page, '部位の編集');
      await expect(p.locator('[data-world-context^="item:"]')).toHaveAttribute(
        'data-world-context',
        secondKey!,
      );
      await expect(p.locator('[data-world-context^="item:"]')).toContainText(
        '採用版の変更は未保存',
      );
      expect((await links(page)).world!.contexts.find((c) => c.id === secondKey)).toEqual(second);
      await page.evaluate(() => window.worldReview.holdWrites(true));
      await p.getByRole('button', { name: `採用版を保存 · ${secondKey}`, exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.worldReview.pendingWrites)).toBe(1);
      await close(page);
      await page
        .locator('.creative-candidates article')
        .first()
        .getByRole('button', { name: 'この候補を選ぶ', exact: true })
        .click();
      p = await panel(page, '部位の編集');
      await expect(p.locator('[data-world-context^="item:"]')).toHaveAttribute(
        'data-world-context',
        firstKey!,
      );
      await page.evaluate(() => window.worldReview.releaseWrites());
      await expect
        .poll(
          async () => (await links(page)).world!.contexts.find((c) => c.id === secondKey)!.revision,
        )
        .toBe(second.revision + 1);
      const after = await links(page);
      for (const c of before.world!.contexts) {
        expect(after.world!.contexts.find((a) => a.id === c.id)).toEqual(
          c.id === firstKey || c.id === secondKey ? { ...c, revision: c.revision + 1 } : c,
        );
      }
      expect(after.returnTo).toEqual(ticket);
      await page.screenshot({
        path: `/tmp/cw1-review-${host}-${mode}-${info.project.name}.png`,
        fullPage: true,
      });
      await close(page);
      await page.getByRole('button', { name: '設定と設定画を保存', exact: true }).click();
      await expect(page.locator('.creative-actions [role=status]')).toContainText('保存しました');
      if (host === 'production') {
        await page.getByRole('button', { name: '元のSceneへ戻る', exact: true }).click();
        await expect(page.locator('.production-scene')).toContainText(ticket!.sceneId);
      }
      await page.reload();
      await expect
        .poll(async () => JSON.stringify((await links(page)).world))
        .toBe(JSON.stringify(after.world));
    });
  }
for (const count of [64, 256])
  test(`${count} valid Scenes: connect only work, then explicit Scene and candidate contexts`, async ({
    page,
  }) => {
    await fixture(page, `scenes=${count}`);
    await expect(page.getByRole('textbox', { name: 'Document body', exact: true })).toBeVisible();
    const p = await panel(page, '原稿と照合');
    const world = p.locator('[data-world-context="work"]');
    await world.getByLabel('作品namespace', { exact: true }).fill('large-work');
    await world.getByRole('button', { name: '作品設定の参照を接続', exact: true }).click();
    await expect.poll(async () => (await links(page)).world?.contexts.length).toBe(1);
    expect((await links(page)).world!.contexts).toEqual([
      { id: 'work', revision: 0, references: [] },
    ]);
    const scene = p.locator('[data-world-context="SC-0"]');
    await scene.getByRole('button', { name: 'この制作の独立前提を接続', exact: true }).click();
    await expect.poll(async () => (await links(page)).world!.contexts.length).toBe(2);
    await p.getByRole('button', { name: 'Character Modeを開く · CH-01', exact: true }).click();
    await expect(
      page.getByRole('application', { name: 'Design canvas', exact: true }),
    ).toBeVisible();
    const inspector = await panel(page, '部位の編集');
    await inspector
      .locator('[data-world-context^="item:"]')
      .getByRole('button', { name: 'この制作の独立前提を接続', exact: true })
      .click();
    await expect.poll(async () => (await links(page)).world!.contexts.length).toBe(3);
  });
async function native(page: Page, id: string): Promise<Artifact<DesignContent>> {
  return page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('editor-platform');
        open.onsuccess = () => {
          const db = open.result,
            get = db.transaction('artifacts', 'readonly').objectStore('artifacts').get(id);
          get.onsuccess = () => {
            resolve(get.result);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
        open.onerror = () => reject(open.error);
      }),
    id,
  );
}
for (const [host, url] of [
  ['normal', '/creative-production.html'],
  ['independent', 'http://127.0.0.1:4177/production.html'],
])
  test(`${host}: Design sample keeps child selection through edit, Undo/Redo, save and return`, async ({
    page,
  }, info) => {
    await page.goto(url);
    await page.getByRole('button', { name: '港町の制作例を作成', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Document body', exact: true })).toBeVisible();
    const p = await panel(page, '原稿と照合');
    await p.getByRole('button', { name: '元資料を開く · sample-anime', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '元資料 · 画作りの見本Frame（固定資料）', exact: true }),
    ).toBeVisible();
    const before = await native(page, 'cw1:harbor:samples'),
      title = before.draft.content.elements.find((e) => e.id === 'sample-anime-title')!;
    const nav = await panel(page, 'Design navigator');
    await nav.getByLabel('Search layers', { exact: true }).fill(title.name);
    await nav
      .getByRole('button', { name: `Layer ${title.name}`, exact: true })
      .first()
      .click();
    await nav.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
    let inspector = await panel(page, 'Design inspector');
    const x = inspector.getByLabel('Element x', { exact: true });
    await expect(x).toHaveValue(String(title.bounds.x));
    await x.fill(String(title.bounds.x + 9));
    await x.press('Enter');
    await close(page);
    await page.getByRole('button', { name: '元資料を元に戻す', exact: true }).click();
    await page.getByRole('button', { name: '元資料をやり直す', exact: true }).click();
    inspector = await panel(page, 'Design inspector');
    await expect(inspector.getByLabel('Element x', { exact: true })).toHaveValue(
      String(title.bounds.x + 9),
    );
    await page.screenshot({
      path: `/tmp/cw1-review-design-${host}-${info.project.name}.png`,
      fullPage: true,
    });
    await close(page);
    await page.getByRole('button', { name: '元資料を保存', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '元資料は保存済み' })).toBeVisible();
    const saved = await native(page, before.id);
    expect(saved.versions.slice(0, before.versions.length)).toEqual(before.versions);
    expect(saved.versions.length).toBe(before.versions.length + 1);
    expect(saved.draft.content.elements.find((e) => e.id === title.id)!.bounds.x).toBe(
      title.bounds.x + 9,
    );
    expect(saved.draft.content.elements.filter((e) => e.id !== title.id)).toEqual(
      before.draft.content.elements.filter((e) => e.id !== title.id),
    );
    await page.getByRole('button', { name: '元の制作へ戻る', exact: true }).click();
    await expect(page.locator('.production-scene')).toContainText('SC-01');
  });
