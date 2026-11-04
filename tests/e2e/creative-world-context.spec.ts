import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import type { Artifact } from '@editor-platform/artifact-core';
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import type { CreativeWorkspaceLinks } from '@editor-platform/reference-artifact-host/creative/workspace';
import { test, expect, setDocumentText } from './fixtures';

let fixtureBundle: Promise<{ js: string; css: string }>;
async function authorityFixture(page: Page) {
  fixtureBundle ??= build({
    entryPoints: ['tests/fixtures/creative-world-context/main.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/cw1-authority-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((r) => ({
    js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css: r.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
  }));
  const files = await fixtureBundle;
  await page.route('**/world-fixture.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await page.route('**/world-fixture.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await page.route('**/world-fixture-host', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/world-fixture.css"><div id="root"></div><script type="module" src="/world-fixture.js"></script>',
    }),
  );
  await page.goto('/world-fixture-host');
}
async function links(page: Page): Promise<CreativeWorkspaceLinks> {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem('creative-design:production:harbor')!),
  );
}
async function native(page: Page, id: string): Promise<Artifact<unknown>> {
  return page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('editor-platform');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('artifacts', 'readonly').objectStore('artifacts').get(id);
          get.onsuccess = () => {
            resolve(get.result);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
      }),
    id,
  );
}
async function pane(page: Page) {
  await expect(page.getByRole('textbox', { name: 'Document body', exact: true })).toBeVisible();
  const p = page.getByRole('complementary', { name: '原稿と照合', exact: true });
  const toggle = page.getByRole('button', { name: 'Toggle 原稿と照合', exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(p.locator('[data-world-context="work"]')).toBeVisible();
  return p;
}
async function closePanels(page: Page) {
  for (const name of ['原稿と照合', '章・シーン', 'Document inspector', 'Document outline']) {
    const close = page.getByRole('button', { name: `Close ${name}`, exact: true });
    if (await close.isVisible()) await close.click();
  }
}
for (const [name, url] of [
  ['通常', '/creative-production.html'],
  ['独立', 'http://127.0.0.1:4177/production.html'],
]) {
  test(`${name}Host: manuscript used as world material saves and returns with old pin`, async ({
    page,
  }, info) => {
    await page.goto(url);
    await page.getByRole('button', { name: '港町の制作例を作成' }).click();
    await pane(page);
    const initial = await links(page),
      scene = initial.scenes.find((s) => s.id === 'SC-01')!;
    const old = await native(page, scene.origin.artifactId),
      version = old.versions.find((v) => v.versionId === scene.origin.versionId)!;
    const ref = {
      ...initial.world!.contexts[0].references[0],
      id: 'manuscript',
      artifactId: old.id,
      versionId: version.versionId,
      contentHash: version.contentHash,
      selector: { type: 'document-blocks' as const, blockIds: ['port-text'] },
    };
    await page.evaluate((ref) => {
      const key = 'creative-design:production:harbor',
        links = JSON.parse(localStorage.getItem(key)!);
      links.world.contexts[0].references = [ref];
      localStorage.setItem(key, JSON.stringify(links));
    }, ref);
    await page.reload();
    let p = await pane(page);
    const before = await links(page);
    await p.getByRole('button', { name: '元資料を開く · manuscript', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '元資料を保存', exact: true })).toBeVisible();
    const ticket = (await links(page)).returnTo!;
    await setDocumentText(
      page,
      'p[data-block-id="port-text"]:visible',
      '同じ原稿を資料から編集して保存。',
    );
    await expect(page.locator('.world-source p[data-block-id="port-text"]')).toHaveText(
      '同じ原稿を資料から編集して保存。',
    );
    await expect(
      page.getByRole('status').filter({ hasText: '元資料に未保存の変更' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '元資料を保存', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '元資料は保存済み' })).toBeVisible();
    const saved = await native(page, old.id),
      stored = await links(page);
    expect(saved.id).toBe(old.id);
    expect(canonicalJson(saved.draft.content)).toContain('同じ原稿を資料から編集して保存。');
    expect(saved.versions).toHaveLength(old.versions.length + 1);
    expect(saved.versions.slice(0, old.versions.length)).toEqual(old.versions);
    expect(saved.versions.at(-1)!.contentHash).toBe(
      await contentHash(saved.versions.at(-1)!.content),
    );
    expect(stored.world).toEqual(before.world);
    expect(stored.returnTo!.address.elementId).toBe(ticket.address.elementId);
    expect(stored.returnTo!.versionId).toBe(saved.draft.baseVersionId);
    expect(stored.scenes.find((s) => s.id === 'SC-03')).toEqual(
      before.scenes.find((s) => s.id === 'SC-03'),
    );
    await page.getByRole('button', { name: '元の制作へ戻る', exact: true }).click();
    await expect(page.locator('.production-scene')).toContainText('SC-01');
    p = await pane(page);
    const row = p.locator('[data-world-reference="manuscript"]');
    await expect(row).toContainText('新版があります');
    await expect(row.locator('.world-projection')).not.toContainText('同じ原稿を資料から編集');
    await row.getByRole('button', { name: '新版を選択 · manuscript', exact: true }).click();
    expect((await links(page)).world).toEqual(before.world);
    await p.getByRole('button', { name: '採用版を保存 · work', exact: true }).click();
    await expect
      .poll(async () => (await links(page)).world!.contexts[0].revision)
      .toBe(before.world!.contexts[0].revision + 1);
    const adopted = (await links(page)).world;
    await page.reload();
    p = await pane(page);
    await expect(page.locator('.production-scene')).toContainText('SC-01');
    await expect(p.locator('[data-world-reference="manuscript"] .world-projection')).toContainText(
      '同じ原稿を資料から編集',
    );
    expect((await links(page)).world).toEqual(adopted);
    expect((await native(page, old.id)).versions).toEqual(saved.versions);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `/tmp/cw1-r3-${name}-${info.project.name}.png`, fullPage: true });
  });
  test(`${name}Host: world source round trip, old pin, explicit adoption and reload`, async ({
    page,
  }, info) => {
    await page.goto(url);
    await page.getByRole('button', { name: '港町の制作例を作成' }).click();
    let p = await pane(page);
    await expect(p.getByText('柔らかいアニメ調：', { exact: false })).toBeVisible();
    await expect(p.getByText('1980年代劇画調：', { exact: false })).toBeVisible();
    const before = await links(page);
    const ref = before.world!.contexts[0].references[0];
    const old = await native(page, ref.artifactId);
    await expect(
      p.getByRole('button', { name: '世界設定を使って生成（未接続）' }).first(),
    ).toBeDisabled();
    await p.getByRole('button', { name: '元資料を開く · facts', exact: true }).focus();
    await expect(
      p.getByRole('button', { name: '元資料を開く · facts', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '元資料 · 港町の作品設定' })).toBeVisible();
    await setDocumentText(
      page,
      'p[data-block-id="world-facts"]',
      '港と灯台の資料を手で修正。家族・年齢・地理は同じ。',
    );
    await page.getByRole('button', { name: '元の制作へ戻る', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '元資料を保存してから' })).toBeVisible();
    await page.getByRole('button', { name: '元資料を元に戻す', exact: true }).click();
    await page.getByRole('button', { name: '元資料をやり直す', exact: true }).click();
    await page.getByRole('button', { name: '元資料を保存', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '元資料は保存済み' })).toBeVisible();
    const saved = await native(page, ref.artifactId);
    expect(saved.versions).toHaveLength(old.versions.length + 1);
    expect(saved.versions[0]).toEqual(old.versions[0]);
    expect(saved.versions.at(-1)!.contentHash).toBe(
      await contentHash(saved.versions.at(-1)!.content),
    );
    expect(saved.id).toBe(ref.artifactId);
    expect((await links(page)).world).toEqual(before.world);
    await page.getByRole('button', { name: '元の制作へ戻る', exact: true }).click();
    p = await pane(page);
    const row = p.locator('[data-world-reference="facts"]');
    await expect(row).toContainText('新版があります');
    await expect(row.locator('.world-projection')).toContainText('潮見の街');
    await row.getByRole('button', { name: '新版を選択 · facts', exact: true }).click();
    await expect(p.locator('[data-world-context="work"]')).toContainText('採用版の変更は未保存');
    expect((await links(page)).world).toEqual(before.world);
    await p.getByRole('button', { name: '採用版を保存 · work', exact: true }).click();
    await expect(p.locator('[data-world-context="work"]')).toContainText('採用前提revision 1');
    const adopted = await links(page);
    expect(adopted.world!.contexts[0].references[0].versionId).toBe(saved.draft.baseVersionId);
    expect(adopted.world!.contexts.slice(1)).toEqual(before.world!.contexts.slice(1));
    await page.reload();
    p = await pane(page);
    await expect(p.locator('[data-world-reference="facts"] .world-projection')).toContainText(
      '港と灯台の資料を手で修正',
    );
    expect((await links(page)).world).toEqual(adopted.world);
    expect(canonicalJson((await native(page, ref.artifactId)).versions)).toBe(
      canonicalJson(saved.versions),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `/tmp/cw1-${name}-${info.project.name}.png`, fullPage: true });
    await closePanels(page);
    // Standalone Character Host uses the same workspace and native source, preserving its card session.
    const next = new URL(url, page.url());
    next.pathname = name === '独立' ? '/creative.html' : '/creative-design.html';
    next.search = '?source=d3a:characters';
    await page.goto(next.href);
    await expect(
      page.getByRole('application', { name: 'Design canvas', exact: true }),
    ).toBeVisible();
    const inspector = page.getByRole('complementary', { name: '部位の編集', exact: true });
    if (
      (await page
        .getByRole('button', { name: 'Toggle 部位の編集', exact: true })
        .getAttribute('aria-pressed')) !== 'true'
    )
      await page.getByRole('button', { name: 'Toggle 部位の編集', exact: true }).click();
    await expect(inspector.locator('[data-world-context="work"]')).toBeVisible();
    await inspector.getByRole('button', { name: '元資料を開く · facts', exact: true }).click();
    await expect(page.getByRole('heading', { name: '元資料 · 港町の作品設定' })).toBeVisible();
    await page.getByRole('button', { name: '元の制作へ戻る', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'キャラクター設計', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/cw1-${name}-character-${info.project.name}.png`,
      fullPage: true,
    });
    for (const mode of ['character', 'setting'] as const) {
      if (mode === 'setting') {
        const next = new URL(page.url());
        next.pathname = name === '独立' ? '/setting.html' : '/setting-design.html';
        next.search = '?source=d3a:world-notes';
        await page.goto(next.href);
        await expect(
          page.getByRole('application', { name: 'Design canvas', exact: true }),
        ).toBeVisible();
      }
      const inspector = page.getByRole('complementary', { name: '部位の編集', exact: true });
      if (
        (await page
          .getByRole('button', { name: 'Toggle 部位の編集', exact: true })
          .getAttribute('aria-pressed')) !== 'true'
      )
        await page.getByRole('button', { name: 'Toggle 部位の編集', exact: true }).click();
      const row = inspector.locator('[data-world-reference="facts"]');
      await row.getByRole('button', { name: '元資料を開く · facts', exact: true }).click();
      const previous = (await links(page)).world!;
      await setDocumentText(
        page,
        'p[data-block-id="world-facts"]',
        `${mode}から元資料を編集。世界と人物の同一性は維持。`,
      );
      await page.getByRole('button', { name: '元資料を保存', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: '元資料は保存済み' })).toBeVisible();
      await page.getByRole('button', { name: '元の制作へ戻る', exact: true }).click();
      await expect(
        page.getByRole('heading', {
          name: mode === 'character' ? 'キャラクター設計' : '舞台設計',
          exact: true,
        }),
      ).toBeVisible();
      if (
        (await page
          .getByRole('button', { name: 'Toggle 部位の編集', exact: true })
          .getAttribute('aria-pressed')) !== 'true'
      )
        await page.getByRole('button', { name: 'Toggle 部位の編集', exact: true }).click();
      await expect(row).toContainText('新版があります');
      expect((await links(page)).world).toEqual(previous);
      await row.getByRole('button', { name: '新版を選択 · facts', exact: true }).click();
      await inspector.getByRole('button', { name: '採用版を保存 · work', exact: true }).click();
      await expect(inspector.locator('[data-world-context="work"]')).toContainText(
        `採用前提revision ${previous.contexts[0].revision + 1}`,
      );
      await page.reload();
      await expect(
        page.getByRole('application', { name: 'Design canvas', exact: true }),
      ).toBeVisible();
      if (
        (await page
          .getByRole('button', { name: 'Toggle 部位の編集', exact: true })
          .getAttribute('aria-pressed')) !== 'true'
      )
        await page.getByRole('button', { name: 'Toggle 部位の編集', exact: true }).click();
      await expect(row.locator('.world-projection')).toContainText(`${mode}から元資料を編集`);
      expect((await links(page)).world!.contexts.slice(1)).toEqual(previous.contexts.slice(1));
      await page.screenshot({
        path: `/tmp/cw1-${name}-${mode}-final-${info.project.name}.png`,
        fullPage: true,
      });
    }
  });
}

test('trusted Host: failure retry, delayed save/Scene switch, viewer navigation and revoked delayed cache', async ({
  page,
}, info) => {
  await authorityFixture(page);
  let p = await pane(page);
  const before = await links(page);
  let row = p.locator('[data-world-reference="facts"]');
  await expect(row.locator('.world-projection')).toBeVisible();
  await row.getByLabel('exact保存版 · facts', { exact: true }).fill('pending-choice');
  await row
    .getByLabel('exact保存版 · facts', { exact: true })
    .fill(before.world!.contexts[0].references[0].versionId);
  await page.evaluate(() => window.worldFixture.failNext());
  await p.getByRole('button', { name: '採用版を保存 · work', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'disk full' })).toBeVisible();
  expect((await links(page)).world).toEqual(before.world);
  await expect(p.locator('[data-world-context="work"]')).toContainText('変更は未保存');
  await p.getByRole('button', { name: '採用版を保存 · work', exact: true }).click();
  await expect(p.locator('[data-world-context="work"]')).toContainText('採用前提revision 1');
  await row.getByLabel('exact保存版 · facts', { exact: true }).fill('pending-choice');
  await row
    .getByLabel('exact保存版 · facts', { exact: true })
    .fill(before.world!.contexts[0].references[0].versionId);
  await page.evaluate(() => window.worldFixture.holdWrites(true));
  await p.getByRole('button', { name: '採用版を保存 · work', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.worldFixture.pendingWrites)).toBe(1);
  await closePanels(page);
  await page.getByRole('button', { name: 'SC-02 · 小説', exact: true }).click();
  await expect(page.locator('.production-scene')).toContainText('SC-02');
  await page.evaluate(() => window.worldFixture.releaseWrites());
  await expect.poll(async () => (await links(page)).world!.contexts[0].revision).toBe(2);
  expect((await links(page)).world!.contexts.slice(1)).toEqual(before.world!.contexts.slice(1));
  p = await pane(page);
  row = p.locator('[data-world-reference="facts"]');
  await expect(row.locator('.world-projection')).toBeVisible();
  await page.evaluate(() => window.worldFixture.holdReads(true));
  await p.getByRole('button', { name: '作品設定の状態を再確認', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => window.worldFixture.pendingReads)).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.worldFixture.read(false);
    window.worldFixture.releaseReads();
  });
  await expect(row).toContainText('forbidden');
  await expect(row.locator('.world-projection')).toHaveCount(0);
  await expect(p.locator('img')).toHaveCount(0);
  await page.evaluate(() => {
    window.worldFixture.read(true);
    window.worldFixture.write(false);
  });
  await p.getByRole('button', { name: '作品設定の状態を再確認', exact: true }).first().click();
  await expect(row.getByLabel('exact保存版 · facts', { exact: true })).toBeDisabled();
  await expect(
    row.getByRole('button', { name: '元資料を開く · facts', exact: true }),
  ).toBeEnabled();
  await row.getByRole('button', { name: '元資料を開く · facts', exact: true }).click();
  await expect(page.getByRole('button', { name: '元資料を保存', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Document body', exact: true })).toHaveAttribute(
    'contenteditable',
    'false',
  );
  await page.getByRole('button', { name: '元の制作へ戻る', exact: true }).click();
  p = await pane(page);
  await page.screenshot({ path: `/tmp/cw1-authority-${info.project.name}.png`, fullPage: true });
});
for (const fault of ['artifact', 'version', 'hash'] as const) {
  test(`trusted Host: ${fault} damage hides projection and refuses source navigation`, async ({
    page,
  }) => {
    await authorityFixture(page);
    const p = await pane(page);
    const row = p.locator('[data-world-reference="facts"]');
    await expect(row.locator('.world-projection')).toBeVisible();
    await page.evaluate((fault) => window.worldFixture.corrupt(fault), fault);
    await p.getByRole('button', { name: '作品設定の状態を再確認', exact: true }).first().click();
    await expect(row).toHaveAttribute(
      'data-reference-state',
      fault === 'hash' ? 'invalid' : 'missing',
    );
    await expect(row.locator('.world-projection')).toHaveCount(0);
    await expect(
      row.getByRole('button', { name: '元資料を開く · facts', exact: true }),
    ).toBeDisabled();
  });
}

test('public mount accepts a supplied workspace without creating an unrelated default source', async ({
  page,
}) => {
  const built = await build({
    entryPoints: ['tests/fixtures/creative-world-context/supplied-workspace.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/cw1-supplied-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const js = built.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css = built.outputFiles!.find((f) => f.path.endsWith('.css'))!.text;
  await page.route('**/supplied-world.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: js }),
  );
  await page.route('**/supplied-world.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: css }),
  );
  await page.route('**/supplied-world-host*', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/supplied-world.css"><div id="root"></div><script type="module" src="/supplied-world.js"></script>',
    }),
  );
  for (const setting of [false, true]) {
    await page.goto('/supplied-world-host' + (setting ? '?setting' : '?character'));
    await expect(
      page.getByRole('heading', { name: setting ? '舞台設計' : 'キャラクター設計', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.suppliedWorld?.after.length ?? 0))
      .toBeGreaterThan(0);
    const result = await page.evaluate(() => window.suppliedWorld);
    expect(result.after).toEqual(result.before);
    expect(result.unrelated).toEqual([]);
  }
});

test('trusted Host: viewer to author return switches Scene only after successful capture and retry', async ({
  page,
}, info) => {
  await authorityFixture(page);
  const openSource = async () => {
    const p = await pane(page);
    await p.getByRole('button', { name: '元資料を開く · facts', exact: true }).click();
  };
  const returnSource = async (scene: string) => {
    await expect(page.getByRole('heading', { name: '元資料 · 港町の作品設定' })).toBeVisible();
    await page.getByRole('button', { name: '元の制作へ戻る', exact: true }).click();
    await expect(page.locator('.production-scene')).toContainText(scene);
  };
  const switchScene = async (id: string) => {
    await closePanels(page);
    await page.getByRole('button', { name: `${id} · 小説`, exact: true }).click();
    await expect(page.locator('.production-scene')).toContainText(id);
  };
  await pane(page);
  const before = await links(page);
  await page.evaluate(() => window.worldFixture.write(false));
  await openSource();
  await returnSource('SC-01');
  expect((await links(page)).returnTo).toEqual(before.returnTo);
  expect(await page.evaluate(() => window.worldFixture.currentReturn?.sceneId)).toBe('SC-01');
  await page.evaluate(() => window.worldFixture.write(true));
  await switchScene('SC-02');
  await page.evaluate(() => window.worldFixture.failNext());
  await openSource();
  await expect(page.getByRole('alert').filter({ hasText: 'disk full' })).toBeVisible();
  expect(await page.evaluate(() => window.worldFixture.currentReturn?.sceneId)).toBe('SC-01');
  expect((await links(page)).returnTo).toEqual(before.returnTo);
  await openSource();
  await returnSource('SC-02');
  expect((await links(page)).returnTo?.sceneId).toBe('SC-02');
  expect(await page.evaluate(() => window.worldFixture.currentReturn?.sceneId)).toBe('SC-02');
  await page.evaluate(() => window.worldFixture.write(false));
  await switchScene('SC-01');
  await openSource();
  await returnSource('SC-01');
  expect((await links(page)).returnTo?.sceneId).toBe('SC-02');
  await page.evaluate(() => window.worldFixture.write(true));
  await page.evaluate(() => window.worldFixture.holdWrites(true));
  await openSource();
  await expect.poll(() => page.evaluate(() => window.worldFixture.pendingWrites)).toBe(1);
  await page.evaluate(() => {
    window.worldFixture.write(false);
    window.worldFixture.releaseWrites();
  });
  await expect(page.getByRole('alert').filter({ hasText: 'permission revoked' })).toBeVisible();
  expect(await page.evaluate(() => window.worldFixture.currentReturn?.sceneId)).toBe('SC-01');
  await page.evaluate(() => window.worldFixture.write(true));
  await openSource();
  await returnSource('SC-01');
  expect((await links(page)).returnTo?.sceneId).toBe('SC-01');
  expect((await links(page)).world).toEqual(before.world);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/cw1-r3-authority-${info.project.name}.png`, fullPage: true });
});

test('trusted Host: adopted projection and native source show rich spans over fallback text', async ({
  page,
}) => {
  await authorityFixture(page);
  await pane(page);
  await page.evaluate(() => window.worldFixture.richFacts());
  let p = await pane(page);
  await expect(p.locator('[data-world-reference="facts"] .world-projection')).toHaveText(
    'rich spansの採用事実',
  );
  const before = await links(page),
    ref = before.world!.contexts[0].references[0];
  const saved = await native(page, ref.artifactId),
    version = saved.versions.find((v) => v.versionId === ref.versionId)!;
  expect(ref.contentHash).toBe(await contentHash(version.content));
  const block = (
    version.content as { blocks: { id: string; text: string; rich?: { text: string }[] }[] }
  ).blocks.find((b) => b.id === 'world-facts')!;
  expect(block.text).not.toBe('rich spansの採用事実');
  expect(block.rich!.map((s) => s.text).join('')).toBe('rich spansの採用事実');
  await p.getByRole('button', { name: '元資料を開く · facts', exact: true }).click();
  await expect(page.locator('.world-source p[data-block-id="world-facts"]')).toHaveText(
    'rich spansの採用事実',
  );
  await page.getByRole('button', { name: '元の制作へ戻る', exact: true }).click();
  await page.reload();
  p = await pane(page);
  await expect(p.locator('[data-world-reference="facts"] .world-projection')).toHaveText(
    'rich spansの採用事実',
  );
  expect((await links(page)).world).toEqual(before.world);
  expect((await native(page, ref.artifactId)).versions).toEqual(saved.versions);
});
