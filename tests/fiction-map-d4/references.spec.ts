import { test, expect, nativeArtifact, save } from '../e2e/fixtures';
import type { Page, Locator } from '@playwright/test';
import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import type { EmbeddedReference, ReferenceItem } from '@editor-platform/artifact-references';
import { mapFixture } from '../fiction-map-d3/native-fixture';
import type { DesignContent } from '@editor-platform/design/model';

type Workspace = 'novel' | 'manga';
async function closePanels(page: Page) {
  if (page.viewportSize()!.width > 800) return;
  for (const button of await page
    .getByRole('button', {
      name: /^Close (原稿と照合|Document inspector|Design inspector|Design navigator|漫画のページ・コマ)$/,
    })
    .all())
    if (await button.isVisible()) await button.click();
}
async function library(page: Page) {
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
}
async function activate(page: Page, name: string) {
  await closePanels(page);
  await library(page);
  await page
    .getByRole('navigation', { name: 'Artifacts', exact: true })
    .getByRole('button')
    .filter({ hasText: name })
    .click();
}
async function history(page: Page, name: 'Undo' | 'Redo') {
  const action = page.getByRole('button', { name, exact: true }).first();
  if (!(await action.isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await action.click();
  await page.keyboard.press('Escape');
}
function referenceOf(content: unknown): EmbeddedReference {
  const c = content as { blocks?: ReferenceItem[]; elements?: ReferenceItem[] };
  const refs = (c.blocks ?? c.elements ?? []).flatMap((i) => (i.reference ? [i.reference] : []));
  expect(refs).toHaveLength(1);
  return refs[0];
}
async function images(scope: Locator) {
  const sources = await scope
    .locator('img, image')
    .evaluateAll((nodes) =>
      nodes
        .map((n) => n.getAttribute('src') ?? n.getAttribute('href') ?? '')
        .filter((src) => src.startsWith('data:image/svg+xml')),
    );
  return sources.map((src) =>
    src.startsWith('data:image/svg+xml;base64,')
      ? Buffer.from(src.slice(src.indexOf(',') + 1), 'base64').toString('utf8')
      : decodeURIComponent(src.slice(src.indexOf(',') + 1)),
  );
}
async function work(page: Page, workspace: Workspace) {
  await closePanels(page);
  await page
    .getByRole('button', {
      name: workspace === 'novel' ? '小説ワークスペース' : '漫画ワークスペース',
      exact: true,
    })
    .click();
  await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', workspace);
}
for (const workspace of ['novel', 'manga'] as const) {
  test(`D4 ${workspace}: ordinary workspace pins named map version through save, source change and reload`, async ({
    page,
  }, info) => {
    await page.goto('/');
    const original = await commitVersion(
      createArtifact('fiction-map', 'D4 pinned map', mapFixture()),
      null,
      'original',
    );
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: 'map.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(original)),
    });
    await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
    const map = await nativeArtifact(page);
    await library(page);
    if (workspace === 'novel') {
      await page.getByRole('button', { name: '小説デモを作成', exact: true }).click();
    } else {
      await page.getByText('漫画を作成', { exact: true }).click();
      await page.getByRole('button', { name: '漫画を新規作成', exact: true }).click();
    }
    await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', workspace);
    await closePanels(page);
    if (workspace === 'manga') {
      await page.getByRole('button', { name: 'Designで詳細編集', exact: true }).click();
    } else {
      const inspector = page.getByRole('complementary', { name: '原稿と照合', exact: true });
      if (!(await inspector.isVisible()))
        await page.getByRole('button', { name: 'Toggle 原稿と照合', exact: true }).click();
      await expect(
        inspector.locator('summary').filter({ hasText: '参照：地図・画像' }),
      ).toBeVisible();
    }
    const before = await nativeArtifact(page);
    if (workspace === 'manga') {
      const navigator = page.getByRole('complementary', { name: 'Design navigator', exact: true });
      if (!(await navigator.isVisible()))
        await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
      await navigator
        .getByRole('region', { name: 'Page reading order', exact: true })
        .getByRole('button', { name: 'Page 1', exact: true })
        .click();
      await closePanels(page);
    }
    const menu = page.getByRole('button', { name: '参照を埋め込む', exact: true });
    if (!(await menu.isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await menu.click();
    await page.getByRole('button', { name: '参照元を再取得', exact: true }).click();
    const source = page.getByLabel('埋め込みの参照元');
    const options = await source.locator('option').allTextContents();
    const index = options.findIndex(
      (s) => s.includes('D4 pinned map') && s.includes('Northern view'),
    );
    expect(index).toBeGreaterThan(0);
    await source.selectOption(String(index - 1));
    await expect(
      page.getByLabel('埋め込みの更新方式').locator('option[value=follow]'),
    ).toHaveAttribute('disabled', '');
    await page.getByRole('button', { name: '参照を配置', exact: true }).click();
    await page.keyboard.press('Escape');
    let inserted = await nativeArtifact(page);
    const ref = referenceOf(inserted.draft.content);
    expect(ref.mode).toBe('fixed');
    expect(ref.source).toEqual({
      artifactId: map.id,
      domain: 'fiction-map',
      target: { kind: 'fiction-map-view', viewId: 'default' },
    });
    expect(ref.snapshot.versionId).toBe(map.versions[0].versionId);
    expect(ref.snapshot.contentHash).toBe(map.versions[0].contentHash);
    expect(ref.snapshot.content).toEqual(map.versions[0].content);
    await history(page, 'Undo');
    expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
    await history(page, 'Redo');
    expect((await nativeArtifact(page)).draft.content).toEqual(inserted.draft.content);
    if (workspace === 'manga') {
      const d = inserted.draft.content as DesignContent;
      expect(d.elements.find((e) => e.reference)?.parentId).toBe(d.pagination!.pages[0].frameId);
      const inspector = page.getByRole('complementary', { name: 'Design inspector', exact: true });
      if (!(await inspector.isVisible()))
        await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
      for (const [key, value] of [
        ['width', '400'],
        ['height', '280'],
      ] as const) {
        await inspector.getByLabel(`Element ${key}`, { exact: true }).fill(value);
        await inspector.getByLabel(`Element ${key}`, { exact: true }).press('Tab');
      }
      await closePanels(page);
      inserted = await nativeArtifact(page);
      expect(referenceOf(inserted.draft.content)).toEqual(ref);
      const placed = (inserted.draft.content as DesignContent).elements.find((e) => e.reference)!;
      const parent = d.elements.find((e) => e.id === placed.parentId)!;
      expect(placed.bounds.width).toBe(400);
      expect(placed.bounds.height).toBe(280);
      expect(placed.bounds.x + placed.bounds.width).toBeLessThanOrEqual(
        parent.bounds.x + parent.bounds.width,
      );
      expect(placed.bounds.y + placed.bounds.height).toBeLessThanOrEqual(
        parent.bounds.y + parent.bounds.height,
      );
    }
    if (workspace === 'manga') await work(page, workspace);
    else await closePanels(page);
    const surface = page.locator(`[data-workspace=${workspace}]`);
    await expect.poll(() => images(surface)).toContainEqual(expect.stringContaining('Place 0'));
    expect((await nativeArtifact(page)).draft.content).toEqual(inserted.draft.content);
    await save(page, before.versions.length + 1);
    const savedConsumer = await nativeArtifact(page);
    if (workspace === 'novel') {
      await expect(page.getByRole('button', { name: '通読', exact: true })).toBeEnabled();
      await closePanels(page);
      await page.getByRole('button', { name: '通読', exact: true }).click();
      const reading = page.getByRole('article', { name: '通読', exact: true });
      await expect.poll(() => images(reading)).toContainEqual(expect.stringContaining('Place 0'));
      await expect(reading).toHaveAttribute('data-writing-mode', 'vertical-rl');
      await reading.locator('img').scrollIntoViewIfNeeded();
      await expect(reading.locator('img')).toBeInViewport();
      expect((await nativeArtifact(page)).draft.content).toEqual(inserted.draft.content);
      await reading.screenshot({
        path: `/tmp/fiction-map-d4/novel-reading-${info.project.name}.png`,
      });
      await page.getByRole('button', { name: '執筆', exact: true }).click();
    }
    await activate(page, map.name);
    if (!(await page.getByLabel('Map details').isVisible()))
      await page.getByRole('button', { name: 'Layers and inspector', exact: true }).click();
    await page
      .locator('.fm-features')
      .getByRole('button', { name: 'Place 0', exact: true })
      .click();
    await page.getByLabel('Feature name', { exact: true }).fill('Later saved place');
    await page.getByLabel('Feature x', { exact: true }).fill('180');
    await page.getByLabel('Feature y', { exact: true }).fill('90');
    await page.getByRole('button', { name: 'Apply feature', exact: true }).click();
    await save(page, 2);
    const newer = await nativeArtifact(page);
    expect(newer.versions[0]).toEqual(map.versions[0]);
    expect(newer.versions[1].contentHash).not.toBe(ref.snapshot.contentHash);
    await activate(page, inserted.name);
    await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', workspace);
    await expect.poll(() => images(surface)).toContainEqual(expect.stringContaining('Place 0'));
    expect((await images(surface)).join()).not.toContain('Later saved place');
    const retained = await nativeArtifact(page);
    expect(retained.draft.content).toEqual(inserted.draft.content);
    expect(retained.versions).toEqual(savedConsumer.versions);
    await page.reload();
    await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', workspace);
    await expect.poll(() => images(surface)).toContainEqual(expect.stringContaining('Place 0'));
    const reloaded = await nativeArtifact(page);
    expect(reloaded.draft.content).toEqual(inserted.draft.content);
    expect(reloaded.versions).toEqual(savedConsumer.versions);
    await surface.screenshot({
      path: `/tmp/fiction-map-d4/${workspace}-ordinary-${info.project.name}.png`,
    });
  });

  test(`D4 ${workspace}: actual public Surface keeps exact feature subset and clears denied or stale pixels`, async ({
    page,
  }, info) => {
    await page.goto(`http://127.0.0.1:4192/d3.html?workspace=${workspace}`);
    await page.getByRole('button', { name: 'Create fixed reference', exact: true }).click();
    const consumer = page.getByRole('region', {
      name: 'Workspace reference consumer',
      exact: true,
    });
    const surface = consumer.locator(`[data-workspace=${workspace}]`);
    await expect(surface).toBeVisible();
    if (workspace === 'novel') {
      await page.getByRole('button', { name: '通読', exact: true }).click();
      await expect(consumer.getByRole('article', { name: '通読', exact: true })).toBeVisible();
    }
    await expect.poll(() => images(surface)).toContainEqual(expect.stringContaining('Place 0'));
    expect((await images(surface)).join()).not.toContain('Place 1');
    const native = JSON.parse((await page.getByTestId('consumer-native').textContent())!);
    const ref = referenceOf(native);
    expect(ref.source.target).toEqual({
      kind: 'fiction-map-view',
      viewId: 'default',
      featureIds: ['place-0'],
    });
    await page.getByRole('button', { name: 'External rename', exact: true }).click();
    await page.getByRole('button', { name: 'Create version', exact: true }).click();
    await expect(page.getByTestId('versions')).toContainText('Newer draft 1');
    const unchanged = await Promise.all(
      [
        'native',
        'versions',
        'revision',
        'source-history',
        'consumer-native',
        'consumer-history',
      ].map((id) => page.getByTestId(id).textContent()),
    );
    async function invariant() {
      expect(
        await Promise.all(
          [
            'native',
            'versions',
            'revision',
            'source-history',
            'consumer-native',
            'consumer-history',
          ].map((id) => page.getByTestId(id).textContent()),
        ),
      ).toEqual(unchanged);
    }
    async function diagnostic(text: string) {
      if (
        workspace === 'manga' &&
        !(await consumer
          .getByRole('complementary', { name: 'Design inspector', exact: true })
          .isVisible())
      )
        await consumer
          .getByRole('button', { name: 'Toggle Design inspector', exact: true })
          .click();
      await expect(consumer.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
      await closePanels(page);
    }
    for (const [fault, label] of [
      ['missing-source', '参照元が見つかりません'],
      ['missing-target', 'view／列／nodeが削除されました'],
      ['stale', '古い応答／キャッシュ'],
    ] as const) {
      await page.getByRole('button', { name: `Reference ${fault}`, exact: true }).click();
      await expect.poll(() => images(surface)).toEqual([]);
      await diagnostic(label);
      await invariant();
      await page.getByRole('button', { name: 'Reset reference fault', exact: true }).click();
      await expect.poll(() => images(surface)).toContainEqual(expect.stringContaining('Place 0'));
    }
    await page.getByRole('button', { name: 'Reference offline', exact: true }).click();
    await expect.poll(() => images(surface)).toContainEqual(expect.stringContaining('Place 0'));
    await diagnostic('オフライン：保持した固定表示');
    await invariant();
    await page.getByRole('button', { name: 'Reference ready', exact: true }).click();
    await page.getByRole('button', { name: 'Delay reference check', exact: true }).click();
    await page.getByRole('button', { name: 'Reset reference fault', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.fictionMapReferencePending)).toBe(true);
    await page.getByRole('button', { name: 'Reference forbidden', exact: true }).click();
    await expect.poll(() => images(surface)).toEqual([]);
    await diagnostic('参照権限がありません');
    await page.getByRole('button', { name: 'Release reference check', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.fictionMapReferencePending)).toBe(false);
    await expect.poll(() => images(surface)).toEqual([]);
    await invariant();
    await consumer.screenshot({
      path: `/tmp/fiction-map-d4/${workspace}-forbidden-${info.project.name}.png`,
    });
    await page.getByRole('button', { name: 'Reference ready', exact: true }).click();
    await expect.poll(() => images(surface)).toContainEqual(expect.stringContaining('Place 0'));
    expect((await images(surface)).join()).not.toContain('Newer draft 1');
    expect(JSON.parse((await page.getByTestId('consumer-native').textContent())!)).toEqual(native);
    await consumer.screenshot({
      path: `/tmp/fiction-map-d4/${workspace}-fixed-${info.project.name}.png`,
    });
  });
}
