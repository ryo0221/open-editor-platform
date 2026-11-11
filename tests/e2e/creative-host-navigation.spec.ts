import { build } from 'esbuild';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
let bundle: Promise<{ js: string; css: string }>;
async function boot(page: Page, scene = 'SC-02', returnTo = false, map = false, noWorld = false) {
  bundle ??= build({
    entryPoints: ['tests/fixtures/creative-host/navigation.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/creative-navigation-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((r) => ({
    js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css: r.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
  }));
  const files = await bundle;
  await page.route('**/creative-navigation.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await page.route('**/creative-navigation.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await page.route('**/creative-navigation-host?*', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/creative-navigation.css"><div id="root"></div><script type="module" src="/creative-navigation.js"></script>',
    }),
  );
  await page.goto(
    `/creative-navigation-host?scene=${encodeURIComponent(scene)}${returnTo ? '&return=1' : ''}${map ? '&map=1' : ''}${noWorld ? '&noWorld=1' : ''}`,
  );
}
test('embedding: initial Scene and clean state are explicit and observer writes nothing', async ({
  page,
}) => {
  await boot(page);
  await expect(page.getByRole('heading', { name: '外側Hostの作品', exact: true })).toBeVisible();
  await expect(page.getByLabel('外側Hostの編集状態')).toHaveText('{"dirty":false,"busy":false}');
  await expect(
    page
      .getByRole('navigation', { name: '制作Scene' })
      .getByRole('button', { name: 'SC-02 · 小説', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.production-scene')).toContainText('SC-02');
  expect(
    await page.evaluate(async () =>
      (
        window as unknown as { creativeNavigation: { snapshot(): Promise<unknown> } }
      ).creativeNavigation.snapshot(),
    ),
  ).toMatchObject({ writes: 0, unchanged: true, undo: false });
  await page.getByRole('button', { name: '画面を移動', exact: true }).click();
  await expect(page.getByText('移動先', { exact: true })).toBeVisible();
});
test('embedding: unknown initial Scene is refused without first-Scene fallback', async ({
  page,
}) => {
  await boot(page, 'missing');
  await expect(page.getByRole('status').filter({ hasText: '指定されたScene' })).toBeVisible();
  await expect(page.locator('.production-host')).toHaveCount(0);
  expect(
    await page.evaluate(async () =>
      (
        window as unknown as { creativeNavigation: { snapshot(): Promise<unknown> } }
      ).creativeNavigation.snapshot(),
    ),
  ).toMatchObject({ writes: 0, unchanged: true });
});

test('embedding: explicit Scene overrides a retained return address', async ({ page }) => {
  await boot(page, 'SC-02', true);
  await expect(page.locator('.production-scene')).toContainText('SC-02');
  await expect(page.getByLabel('外側Hostの編集状態')).toHaveText('{"dirty":false,"busy":false}');
});

test('embedding: native edit, Undo and failed pending save keep outer navigation accurate', async ({
  page,
}) => {
  await boot(page, 'SC-01');
  const state = page.getByLabel('外側Hostの編集状態');
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  const paragraph = page.locator('.ProseMirror p[data-block-id="port-text"]');
  await paragraph.click();
  await page.keyboard.press('Home');
  await page.keyboard.insertText('作者が直した原稿。');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await page.getByRole('button', { name: '画面を移動', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未保存の変更' })).toBeVisible();
  await page.getByRole('button', { name: '制作を続ける', exact: true }).click();
  await expect(paragraph).toContainText('作者が直した原稿。');
  await page.getByRole('button', { name: '原稿を元に戻す', exact: true }).click();
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  await page.getByRole('button', { name: '原稿をやり直す', exact: true }).click();
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await page.evaluate(() =>
    (
      window as unknown as {
        creativeNavigation: {
          pauseSave(): void;
          resumeSave(fail?: boolean): void;
          snapshot(): Promise<unknown>;
        };
      }
    ).creativeNavigation.pauseSave(),
  );
  await page.getByRole('button', { name: '原稿を保存・Scene参照版を確認', exact: true }).click();
  await expect(state).toHaveText('{"dirty":true,"busy":true}');
  await page.evaluate(() =>
    (
      window as unknown as {
        creativeNavigation: {
          pauseSave(): void;
          resumeSave(fail?: boolean): void;
          snapshot(): Promise<unknown>;
        };
      }
    ).creativeNavigation.resumeSave(true),
  );
  await expect(page.getByRole('alert')).toContainText('fixture storage failure');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await expect(paragraph).toContainText('作者が直した原稿。');
  await page.evaluate(() =>
    (
      window as unknown as {
        creativeNavigation: {
          pauseSave(): void;
          resumeSave(fail?: boolean): void;
          snapshot(): Promise<unknown>;
        };
      }
    ).creativeNavigation.resumeSave(false),
  );
  await page.getByRole('button', { name: '原稿を保存・Scene参照版を確認', exact: true }).click();
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
});

test('embedding: unfinished child creation is dirty without allocating or saving a native row', async ({
  page,
}) => {
  await boot(page, 'SC-01');
  // Open the existing reference pane through its ordinary accessible workspace toggle.
  const pane = page.getByRole('complementary', { name: '原稿と照合', exact: true });
  if (!(await pane.isVisible()))
    await page.getByRole('button', { name: 'Toggle 原稿と照合', exact: true }).click();
  await page.getByRole('button', { name: 'Character Modeを開く · CH-01', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'キャラクター設計', exact: true })).toBeVisible();
  await page.getByText('人物を追加', { exact: true }).click();
  const form = page.locator('.creative-cards form');
  await form.getByLabel('名前', { exact: true }).fill('まだ確定しない人物');
  await expect(page.getByLabel('外側Hostの編集状態')).toHaveText('{"dirty":true,"busy":false}');
  await page.getByRole('button', { name: '画面を移動', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未保存の変更' })).toBeVisible();
  expect(
    await page.evaluate(async () =>
      (
        window as unknown as {
          creativeNavigation: {
            pauseSave(): void;
            resumeSave(fail?: boolean): void;
            snapshot(): Promise<unknown>;
          };
        }
      ).creativeNavigation.snapshot(),
    ),
  ).toMatchObject({ writes: 0, unchanged: true, undo: false });
  await page.getByRole('button', { name: '制作を続ける', exact: true }).click();
  await expect(form.getByLabel('名前', { exact: true })).toHaveValue('まだ確定しない人物');
  await form.getByLabel('名前', { exact: true }).fill('');
  await expect(page.getByLabel('外側Hostの編集状態')).toHaveText('{"dirty":false,"busy":false}');
});

async function referencePane(page: Page) {
  const pane = page.getByRole('complementary', { name: '原稿と照合', exact: true });
  if (!(await pane.isVisible()))
    await page.getByRole('button', { name: 'Toggle 原稿と照合', exact: true }).click();
  return pane;
}
async function owner(page: Page, kind: 'map' | 'world') {
  return page.evaluate(
    (kind) =>
      (
        window as unknown as {
          creativeNavigation: { owner(kind: 'map' | 'world'): Promise<unknown> };
        }
      ).creativeNavigation.owner(kind),
    kind,
  );
}

test('embedding: pending map inspector blocks outer leave without native commit and cancel restores clean', async ({
  page,
}) => {
  await boot(page, 'SC-01', false, true);
  const pane = await referencePane(page);
  await pane
    .getByRole('article', { name: '固定地図 LO-02 SC-01', exact: true })
    .getByRole('button', { name: '地図を開く · LO-02', exact: true })
    .click();
  const layers = page.getByRole('button', { name: 'Layers and inspector', exact: true });
  if ((await layers.getAttribute('aria-expanded')) !== 'true') await layers.click();
  await page.locator('.fm-features button').filter({ hasText: '潮見の街' }).click();
  const before = await owner(page, 'map'),
    state = page.getByLabel('外側Hostの編集状態');
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  const name = page.getByLabel('Feature name', { exact: true });
  await name.fill('まだ確定しない街');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  expect(await owner(page, 'map')).toEqual(before);
  await page.getByRole('button', { name: '画面を移動', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未保存の変更' })).toBeVisible();
  await page.getByRole('button', { name: '制作を続ける', exact: true }).click();
  await expect(name).toHaveValue('まだ確定しない街');
  expect(await owner(page, 'map')).toEqual(before);
  await page.getByRole('button', { name: 'Cancel edits', exact: true }).click();
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  expect(await owner(page, 'map')).toEqual(before);
});

test('embedding: world-source composition and private fields reach outer leave guard without flushing', async ({
  page,
}) => {
  await boot(page, 'SC-01');
  const pane = await referencePane(page);
  await pane.getByRole('button', { name: '元資料を開く · sample-anime', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '元資料 · 画作りの見本Frame（固定資料）', exact: true }),
  ).toBeVisible();
  const inspector = page.getByRole('complementary', { name: 'Design inspector', exact: true });
  if (!(await inspector.isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  const name = inspector.getByLabel('Layer name', { exact: true }),
    state = page.getByLabel('外側Hostの編集状態');
  await expect(name).toBeVisible();
  const before = await owner(page, 'world'),
    original = await name.inputValue();
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  await name.focus();
  await name.dispatchEvent('compositionstart');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  expect(
    await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }),
  ).toBe(true);
  expect(await owner(page, 'world')).toEqual(before);
  await name.dispatchEvent('compositionend');
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  await name.fill('未確定の見本名');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  // Programmatic router navigation must observe pending input before blur can commit it.
  await page.getByRole('button', { name: '画面を移動', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('dialog', { name: '未保存の変更' })).toBeVisible();
  await page.getByRole('button', { name: '制作を続ける', exact: true }).dispatchEvent('click');
  await expect(name).toHaveValue('未確定の見本名');
  expect(await owner(page, 'world')).toEqual(before);
  await name.press('Escape');
  await expect(name).toHaveValue(original);
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  expect(await owner(page, 'world')).toEqual(before);
});

test('embedding: unfinished World reference choice survives outer cancellation and panel remount without saving', async ({
  page,
}) => {
  await boot(page, 'SC-01');
  const pane = await referencePane(page),
    world = pane.locator('[data-world-context="work"]');
  await world.getByText('既存資料を接続（本文は元Editorで編集）', { exact: true }).click();
  const field = world.getByLabel('参照ID', { exact: true }),
    state = page.getByLabel('外側Hostの編集状態');
  await field.fill('not-confirmed');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await page.getByRole('button', { name: '画面を移動', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未保存の変更' })).toBeVisible();
  await page.getByRole('button', { name: '制作を続ける', exact: true }).click();
  await expect(field).toHaveValue('not-confirmed');
  const toggle = page.getByRole('button', { name: 'Toggle 原稿と照合', exact: true });
  await toggle.click();
  await expect(pane).toBeHidden();
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await toggle.click();
  await expect(pane).toBeVisible();
  const summary = world.getByText('既存資料を接続（本文は元Editorで編集）', { exact: true });
  if (!(await field.isVisible())) await summary.click();
  await expect(field).toHaveValue('not-confirmed');
  await page.getByRole('button', { name: 'SC-03 · 漫画', exact: true }).click();
  await expect(page.locator('.production-scene')).toContainText('SC-03');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await page.getByRole('button', { name: 'SC-01 · 小説', exact: true }).click();
  await expect(page.locator('.production-scene')).toContainText('SC-01');
  await referencePane(page);
  if (!(await field.isVisible())) await summary.click();
  await expect(field).toHaveValue('not-confirmed');
  await world.getByRole('button', { name: '未確定の資料接続を取り消す', exact: true }).click();
  await expect(field).toHaveValue('');
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          creativeNavigation: {
            snapshot(): Promise<{ writes: number; unchanged: boolean; undo: boolean }>;
          };
        }
      ).creativeNavigation.snapshot(),
    ),
  ).toMatchObject({ writes: 0, unchanged: true, undo: false });
});

test('embedding: unfinished World namespace and composition reach the router without native writes', async ({
  page,
}) => {
  await boot(page, 'SC-01', false, false, true);
  const pane = await referencePane(page),
    field = pane.getByLabel('作品namespace', { exact: true }),
    state = page.getByLabel('外側Hostの編集状態');
  await field.focus();
  await field.dispatchEvent('compositionstart');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await field.dispatchEvent('compositionend');
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  await field.fill('not-connected');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await page.getByRole('button', { name: '画面を移動', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未保存の変更' })).toBeVisible();
  await page.getByRole('button', { name: '制作を続ける', exact: true }).click();
  await expect(field).toHaveValue('not-connected');
  await field.fill('');
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          creativeNavigation: {
            snapshot(): Promise<{ writes: number; unchanged: boolean; undo: boolean }>;
          };
        }
      ).creativeNavigation.snapshot(),
    ),
  ).toMatchObject({ writes: 0, unchanged: true, undo: false });
});

test('embedding: staging a World reference clears its entry form and failed save retains one cancellable choice', async ({
  page,
}) => {
  await boot(page, 'SC-01');
  const pane = await referencePane(page),
    world = pane.locator('[data-world-context="work"]');
  await world.getByText('既存資料を接続（本文は元Editorで編集）', { exact: true }).click();
  await world.getByLabel('参照ID', { exact: true }).fill('missing-choice');
  await world.getByLabel('Artifact ID', { exact: true }).fill('missing-owner');
  await world.getByLabel('保存版ID', { exact: true }).fill('missing-version');
  await world.getByLabel('保存版hash', { exact: true }).fill('0'.repeat(64));
  await world.getByLabel('root block IDs（カンマ区切り）', { exact: true }).fill('missing-block');
  const stage = world.getByRole('button', { name: '資料接続を選択', exact: true }),
    state = page.getByLabel('外側Hostの編集状態');
  await stage.click();
  await expect(world.getByLabel('参照ID', { exact: true })).toHaveValue('');
  await expect(stage).toBeDisabled();
  await expect(world.locator('[data-world-reference="missing-choice"]')).toHaveCount(1);
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await world.getByRole('button', { name: '採用版を保存 · work', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('採用資料が欠落・不正・権限不足');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await expect(world.locator('[data-world-reference="missing-choice"]')).toHaveCount(1);
  await world.getByRole('button', { name: '未保存の版選択を取り消す · work', exact: true }).click();
  await expect(world.locator('[data-world-reference="missing-choice"]')).toHaveCount(0);
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          creativeNavigation: {
            snapshot(): Promise<{ writes: number; unchanged: boolean; undo: boolean }>;
          };
        }
      ).creativeNavigation.snapshot(),
    ),
  ).toMatchObject({ writes: 0, unchanged: true, undo: false });
});

test('embedding: pending World save stays busy across Scene changes and failed response preserves its form', async ({
  page,
}) => {
  await boot(page, 'SC-01', false, false, true);
  const pane = await referencePane(page),
    field = pane.getByLabel('作品namespace', { exact: true }),
    state = page.getByLabel('外側Hostの編集状態');
  const before = await page.evaluate(() =>
    (
      window as unknown as { creativeNavigation: { snapshot(): Promise<unknown> } }
    ).creativeNavigation.snapshot(),
  );
  await field.fill('pending-namespace');
  await page.evaluate(() =>
    (
      window as unknown as { creativeNavigation: { pauseSave(): void } }
    ).creativeNavigation.pauseSave(),
  );
  await pane.getByRole('button', { name: '作品設定の参照を接続', exact: true }).click();
  await expect(state).toHaveText('{"dirty":true,"busy":true}');
  await page.getByRole('button', { name: 'SC-03 · 漫画', exact: true }).click();
  await expect(page.locator('.production-scene')).toContainText('SC-03');
  await expect(state).toHaveText('{"dirty":true,"busy":true}');
  await page.evaluate(() =>
    (
      window as unknown as { creativeNavigation: { resumeSave(fail: boolean): void } }
    ).creativeNavigation.resumeSave(true),
  );
  await expect(page.getByRole('alert')).toContainText('fixture storage failure');
  await expect(state).toHaveText('{"dirty":true,"busy":false}');
  await page.getByRole('button', { name: 'SC-01 · 小説', exact: true }).click();
  await expect(page.locator('.production-scene')).toContainText('SC-01');
  await referencePane(page);
  await expect(field).toHaveValue('pending-namespace');
  await field.fill('');
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { creativeNavigation: { snapshot(): Promise<unknown> } }
      ).creativeNavigation.snapshot(),
    ),
  ).toEqual(before);
});

test('embedding: pending map reference save reaches the Host busy boundary and failure writes nothing', async ({
  page,
}) => {
  await boot(page, 'SC-01', false, true);
  const pane = await referencePane(page),
    card = pane.getByRole('article', { name: '固定地図 LO-02 SC-01', exact: true }),
    state = page.getByLabel('外側Hostの編集状態');
  const before = await page.evaluate(() =>
    (
      window as unknown as { creativeNavigation: { snapshot(): Promise<unknown> } }
    ).creativeNavigation.snapshot(),
  );
  await page.evaluate(() =>
    (
      window as unknown as { creativeNavigation: { pauseSave(): void } }
    ).creativeNavigation.pauseSave(),
  );
  await card.getByRole('button', { name: '地図参照を解除 · LO-02', exact: true }).click();
  await expect(state).toHaveText('{"dirty":false,"busy":true}');
  await page.getByRole('button', { name: '画面を移動', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未保存の変更' })).toBeVisible();
  await page.getByRole('button', { name: '制作を続ける', exact: true }).click();
  await page.evaluate(() =>
    (
      window as unknown as { creativeNavigation: { resumeSave(fail: boolean): void } }
    ).creativeNavigation.resumeSave(true),
  );
  await expect(page.getByRole('alert')).toContainText('fixture storage failure');
  await expect(state).toHaveText('{"dirty":false,"busy":false}');
  await expect(card).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { creativeNavigation: { snapshot(): Promise<unknown> } }
      ).creativeNavigation.snapshot(),
    ),
  ).toEqual(before);
});
