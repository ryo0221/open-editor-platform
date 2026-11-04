import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { contentHash } from '@editor-platform/artifact-core';
import type {} from '../fixtures/creative-map/main';
import { test, expect } from './fixtures';

let bundle: Promise<{ js: string; css: string }>;
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function open(page: Page, independent = false, surface = 'production', viewer = false) {
  bundle ??= build({
    entryPoints: ['tests/fixtures/creative-map/main.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/cw3-fixture',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((r) => ({
    js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css: r.outputFiles!.find((f) => f.path.endsWith('.css'))!.text,
  }));
  const files = await bundle;
  await page.route('**/cw3-fixture.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await page.route('**/cw3-fixture.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await page.route('**/cw3-fixture?*', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/cw3-fixture.css"><div id="root"></div><script type="module" src="/cw3-fixture.js"></script>',
    }),
  );
  await page.goto(
    (independent ? 'http://127.0.0.1:4177' : '') +
      '/cw3-fixture?surface=' +
      surface +
      '&viewer=' +
      viewer,
  );
  await expect.poll(() => page.evaluate(() => !!window.cw3Fixture)).toBe(true);
  if (surface !== 'production') {
    if (surface === 'setting')
      await page.locator('.creative-cards button').filter({ hasText: 'LO-02' }).click();
    await mapPane(page, surface === 'character' ? '人物の部位' : '場所の部位');
  } else await mapPane(page);
}
async function mapPane(page: Page, name = '原稿と照合') {
  const target = name === '原稿と照合' ? name : '部位の編集';
  for (const other of [
    'Design navigator',
    'Design inspector',
    ...(target === '部位の編集' ? [name] : ['部位の編集']),
  ]) {
    const close = button(page, 'Close ' + other);
    if (await close.isVisible()) await close.click();
  }
  const toggle = button(page, 'Toggle ' + target);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(page.locator('.map-locations:visible')).toBeVisible();
}
function reference(page: Page, scene = 'SC-01') {
  return page.getByRole('article', { name: '固定地図 LO-02 ' + scene, exact: true });
}
async function editTown(page: Page, name: string) {
  const toggle = button(page, 'Layers and inspector');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('.fm-features button').filter({ hasText: '潮見の街' }).click();
  await page.getByLabel('Feature name', { exact: true }).fill(name);
}

for (const independent of [false, true])
  test(`R3 exact-version and hash typing retain focus and composition across parent renders, independent=${independent}`, async ({
    page,
  }) => {
    await open(page, independent, independent ? 'setting' : 'production');
    if (!independent) {
      await button(page, '設定画へ · LO-02').click();
      await mapPane(page, '場所の部位');
    }
    const before = await page.evaluate(() => window.cw3Fixture.links());
    const pane = page.locator('[data-world-context="work"]:visible');
    const version = pane.getByLabel('exact保存版 · facts', { exact: true });
    const previous = await version.inputValue();
    await version.focus();
    await page.keyboard.press('End');
    await page.keyboard.type('-keyboard-input');
    await expect(version).toHaveValue(previous + '-keyboard-input');
    await expect(version).toBeFocused();
    const hash = pane.getByLabel('contentHash · facts', { exact: true });
    await hash.focus();
    await hash.dispatchEvent('compositionstart');
    const value = await hash.inputValue();
    await page.keyboard.press('End');
    await page.keyboard.type('abcdef');
    await expect(hash).toHaveValue(value + 'abcdef');
    await expect(hash).toBeFocused();
    await hash.dispatchEvent('compositionend');
    expect((await page.evaluate(() => window.cw3Fixture.links())).world).toEqual(before.world);
  });

for (const independent of [false, true])
  for (const lost of [false, true])
    test(`R2 reference form and exact save retry survive LO revocation, independent=${independent}, lost=${lost}`, async ({
      page,
    }) => {
      await open(page, independent, independent ? 'setting' : 'production');
      if (!independent) {
        await button(page, '設定画へ · LO-02').click();
        await mapPane(page, '場所の部位');
      }
      const links = await page.evaluate(() => window.cw3Fixture.links());
      const before = (await page.evaluate(() => window.cw3Fixture.native('cw3:harbor:map')))!;
      await reference(page, independent ? '作品共通' : 'SC-01')
        .getByRole('button', { name: '地図の採用版を選び直す · LO-02', exact: true })
        .click();
      const form = page.getByRole('form', { name: '固定地図の選択', exact: true });
      await form.getByLabel('地物 town', { exact: true }).uncheck();
      await form.getByLabel('地物 port-area', { exact: true }).uncheck();
      await form.getByLabel('地物 unassigned', { exact: true }).check();
      if (lost) {
        await page.evaluate(() => window.cw3Fixture.faults({ native: 'lost' }));
        await button(page, '参照なしの選択地物へ場所を明示付与して地図を保存').click();
        await expect(page.getByRole('alert')).toContainText('lost ack');
      }
      await page.evaluate(() => window.cw3Fixture.permission('d3a:world-notes', false));
      await expect(form).toHaveCount(0);
      await expect(page.locator('.map-locations:visible')).toHaveCount(0);
      expect(
        await page.evaluate(() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBe(true);
      if (!independent) {
        await button(page, '元のSceneへ戻る').click();
        await expect(page.getByRole('alert')).toContainText([
          '正本または設定画の参照権限',
          '地図参照の選択',
        ]);
        await expect(page.getByRole('heading', { name: '舞台設計', exact: true })).toHaveCount(0);
      }
      await page.evaluate(() => window.cw3Fixture.permission('d3a:world-notes', true));
      await mapPane(page, '場所の部位');
      await expect(form).toBeVisible();
      await expect(form.getByLabel('地物 unassigned', { exact: true })).toBeChecked();
      await expect(form.getByLabel('地物 town', { exact: true })).not.toBeChecked();
      if (lost) {
        await button(page, '参照なしの選択地物へ場所を明示付与して地図を保存').click();
        await expect(form.getByLabel('地図保存版', { exact: true })).toHaveValue(
          (await page.evaluate(() => window.cw3Fixture.native('cw3:harbor:map')))!.draft
            .baseVersionId!,
        );
        const saved = (await page.evaluate(() => window.cw3Fixture.native('cw3:harbor:map')))!;
        expect(saved.versions).toHaveLength(before.versions.length + 1);
        expect(saved.versions.at(-1)!.contentHash).toBe(
          await contentHash(saved.versions.at(-1)!.content),
        );
      }
      await button(page, '地図の選択を取消').click();
      await expect(form).toHaveCount(0);
      expect((await page.evaluate(() => window.cw3Fixture.links())).mapLocations).toEqual(
        links.mapLocations,
      );
    });

for (const grant of ['map', 'location'] as const)
  for (const restore of [false, true])
    test(`R2 viewer PNG export is invalidated by ${grant} loss during rasterization, restore=${restore}`, async ({
      page,
    }) => {
      await open(page, true, 'setting', true);
      await reference(page, '作品共通')
        .getByRole('button', { name: '地図を開く · LO-02', exact: true })
        .click();
      await page.evaluate(() => {
        const gate = { pending: false, release: () => {} };
        Object.assign(window, { cw3PngGate: gate });
        const original = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
          HTMLCanvasElement.prototype.toBlob = original;
          return original.call(
            this,
            (blob) => {
              gate.pending = true;
              gate.release = () => callback(blob);
            },
            type,
            quality,
          );
        };
      });
      const downloads: string[] = [];
      page.on('download', (d) => downloads.push(d.suggestedFilename()));
      await button(page, 'Export map PNG').click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'cw3PngGate').pending))
        .toBe(true);
      const denied = grant === 'map' ? 'cw3:harbor:map' : 'd3a:world-notes';
      await page.evaluate((id) => window.cw3Fixture.permission(id, false), denied);
      await expect(page.locator('.fm-artifact')).toHaveCount(0);
      if (restore) {
        await page.evaluate((id) => window.cw3Fixture.permission(id, true), denied);
        await expect(page.locator('.fm-artifact')).toBeVisible();
      }
      await page.evaluate(() => Reflect.get(window, 'cw3PngGate').release());
      await expect(page.locator('.map-location-editor')).toContainText('stale-output');
      expect(downloads).toEqual([]);
      if (restore) {
        await expect(button(page, 'Export map PNG')).toBeEnabled();
        const downloading = page.waitForEvent('download');
        await button(page, 'Export map PNG').click();
        const png = await readFile((await (await downloading).path())!);
        expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1000, 700]);
        expect(downloads).toHaveLength(1);
      }
    });

test('R1 work-wide LO outside the Scene supports both location routes and preserves the Scene return selection', async ({
  page,
}) => {
  await open(page);
  const before = await page.evaluate(() => window.cw3Fixture.links());
  const selection = await page.evaluate(() => window.cw3Fixture.sceneSelection());
  expect(before.scenes.find((s) => s.id === 'SC-01')!.items.some((i) => i.itemId === 'LO-01')).toBe(
    false,
  );
  for (const viaMap of [false, true]) {
    const r = page.getByRole('article', { name: '固定地図 LO-01 作品共通', exact: true });
    if (viaMap) {
      await r.getByRole('button', { name: '地図を開く · LO-01', exact: true }).click();
      await button(page, 'この場所の設定画へ').click();
    } else {
      await r.getByRole('button', { name: '場所設定・設定画を開く · LO-01', exact: true }).focus();
      await page.keyboard.press('Enter');
    }
    await expect(page.getByRole('heading', { name: '舞台設計', exact: true })).toBeVisible();
    await expect(page.locator('.creative-item-heading')).toContainText('風見の家');
    await button(page, '元のSceneへ戻る').click();
    await expect(page.getByRole('textbox', { name: 'Document body', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.cw3Fixture.sceneSelection())).toEqual(selection);
    const after = await page.evaluate(() => window.cw3Fixture.links());
    expect(after.scenes).toEqual(before.scenes);
    expect(after.mapLocations).toEqual(before.mapLocations);
    await mapPane(page);
  }
});

for (const independent of [false, true])
  for (const grant of ['map', 'location'] as const)
    test(`R1 pending feature input survives ${grant} revocation, independent=${independent}`, async ({
      page,
    }, info) => {
      await open(page, independent, independent ? 'setting' : 'production');
      const r = reference(page, independent ? '作品共通' : 'SC-01');
      const old = await page.evaluate(() => window.cw3Fixture.links());
      const ref = old.mapLocations!.locations.find(
        (r) => r.itemId === 'LO-02' && (independent ? !r.sceneId : r.sceneId === 'SC-01'),
      )!;
      await r.getByRole('button', { name: '地図を開く · LO-02', exact: true }).click();
      await editTown(page, 'private pending town');
      const denied = grant === 'map' ? ref.map.artifactId : ref.source.artifactId;
      await page.evaluate((id) => window.cw3Fixture.permission(id, false), denied);
      await expect(page.locator('.fm-artifact')).toHaveCount(0);
      await expect(page.getByLabel('Feature name', { exact: true })).toHaveCount(0);
      await expect(page.locator('.map-location-editor')).toContainText('forbidden');
      expect(
        await page.evaluate(() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBe(true);
      await button(page, '地図から元の制作へ戻る').click();
      await expect(page.locator('.map-location-editor')).toContainText(
        'Apply or cancel the feature input',
      );
      await page.screenshot({
        path: info.outputPath(`pending-input-masked-${info.project.name}.png`),
        fullPage: true,
      });
      await page.evaluate((id) => window.cw3Fixture.permission(id, true), denied);
      await expect(page.getByLabel('Feature name', { exact: true })).toHaveValue(
        'private pending town',
      );
      await page.evaluate(() => window.cw3Fixture.write(false));
      await expect(page.getByLabel('Feature name', { exact: true })).toBeDisabled();
      await page.evaluate(() => window.cw3Fixture.write(true));
      await expect(page.getByLabel('Feature name', { exact: true })).toHaveValue(
        'private pending town',
      );
      await button(page, 'Apply feature').click();
      await button(page, '地図nativeを保存').click();
      await button(page, '地図から元の制作へ戻る').click();
      const saved = (await page.evaluate(
        (id) => window.cw3Fixture.native(id),
        ref.map.artifactId,
      ))!;
      const version = saved.versions.find((v) => v.versionId === saved.draft.baseVersionId)!;
      expect(version.contentHash).toBe(await contentHash(version.content));
      expect(JSON.stringify(version.content)).toContain('private pending town');
      expect((await page.evaluate(() => window.cw3Fixture.links())).mapLocations).toEqual(
        old.mapLocations,
      );
    });

for (const kind of ['drawing', 'refinement'] as const)
  test(`R1 pending ${kind} remains private across permission loss and blocks leaving`, async ({
    page,
  }) => {
    await open(page, true, 'setting');
    await reference(page, '作品共通')
      .getByRole('button', { name: '地図を開く · LO-02', exact: true })
      .click();
    const original = (await page.evaluate(() => window.cw3Fixture.native('cw3:harbor:map')))!;
    if (kind === 'drawing') {
      await button(page, 'Draw path').click();
      const world = page.locator('[data-fiction-world]');
      await world.scrollIntoViewIfNeeded();
      for (const [x, y] of [
        [10, 10],
        [20, 15],
      ]) {
        const point = await world.evaluate(
          (el, [x, y]) => {
            const p = new DOMPoint(x, y).matrixTransform((el as SVGGElement).getScreenCTM()!);
            return { x: p.x, y: p.y };
          },
          [x, y],
        );
        await page.mouse.click(point.x, point.y);
      }
      await expect(page.getByText('2 draft vertices', { exact: true })).toBeVisible();
    } else {
      const details = page.locator('.fm-native-input');
      await details.locator('summary').click();
      await details.getByLabel('Refinement native JSON').setInputFiles({
        name: 'retained-candidate.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(original.draft.content)),
      });
      await expect(page.getByAltText('Map refinement preview')).toBeVisible();
    }
    await page.evaluate(() => window.cw3Fixture.permission('cw3:harbor:map', false));
    await expect(page.locator('.fm-artifact')).toHaveCount(0);
    await button(page, '地図から元の制作へ戻る').click();
    await expect(page.locator('.map-location-editor')).toContainText(
      kind === 'drawing'
        ? 'Finish or cancel drawing'
        : 'Apply or cancel the map refinement candidate',
    );
    await page.evaluate(() => window.cw3Fixture.permission('cw3:harbor:map', true));
    if (kind === 'drawing') {
      await expect(page.getByText('2 draft vertices', { exact: true })).toBeVisible();
      await page.evaluate(() => window.cw3Fixture.write(false));
      await expect(button(page, 'Finish shape')).toBeDisabled();
      await expect(page.getByText('2 draft vertices', { exact: true })).toBeVisible();
      await page.evaluate(() => window.cw3Fixture.write(true));
      await expect(button(page, 'Finish shape')).toBeEnabled();
      await button(page, 'Cancel drawing').click();
    } else {
      await expect(page.getByAltText('Map refinement preview')).toBeVisible();
      await button(page, 'Cancel map refinement').click();
    }
    await button(page, '地図から元の制作へ戻る').click();
    expect(await page.evaluate(() => window.cw3Fixture.native('cw3:harbor:map'))).toEqual(original);
  });

for (const fault of ['fail', 'lost'] as const)
  test(`R1 semantic assignment retries its retained native editor after ${fault}`, async ({
    page,
  }) => {
    await open(page, true, 'setting');
    const links = await page.evaluate(() => window.cw3Fixture.links());
    const before = (await page.evaluate(() => window.cw3Fixture.native('cw3:harbor:map')))!;
    await reference(page, '作品共通')
      .getByRole('button', { name: '地図の採用版を選び直す · LO-02', exact: true })
      .click();
    const form = page.getByRole('form', { name: '固定地図の選択', exact: true });
    await form.getByLabel('地物 town', { exact: true }).uncheck();
    await form.getByLabel('地物 port-area', { exact: true }).uncheck();
    await form.getByLabel('地物 unassigned', { exact: true }).check();
    await page.evaluate((native) => window.cw3Fixture.faults({ native }), fault);
    const save = button(page, '参照なしの選択地物へ場所を明示付与して地図を保存');
    await save.click();
    await expect(page.getByRole('alert')).toContainText(
      fault === 'lost' ? 'lost ack' : 'disk full',
    );
    await button(page, '地図の選択を取消').click();
    await expect(page.getByRole('alert')).toContainText('前回の地図native保存を再試行');
    await expect(form).toBeVisible();
    await save.click();
    await expect(form.getByLabel('地図保存版', { exact: true })).not.toHaveValue(
      links.mapLocations!.locations[0].map.versionId,
    );
    const saved = (await page.evaluate(() => window.cw3Fixture.native('cw3:harbor:map')))!;
    expect(saved.versions).toHaveLength(before.versions.length + 1);
    expect(saved.versions.find((v) => v.versionId === saved.draft.baseVersionId)!.contentHash).toBe(
      await contentHash(saved.draft.content),
    );
    expect((await page.evaluate(() => window.cw3Fixture.links())).mapLocations).toEqual(
      links.mapLocations,
    );
    await button(page, 'この地図版を明示採用して参照を保存').click();
    await expect(form).toHaveCount(0);
    expect((await page.evaluate(() => window.cw3Fixture.links())).mapLocations!.revision).toBe(
      links.mapLocations!.revision + 1,
    );
  });
for (const independent of [false, true])
  test(
    (independent ? 'independent' : 'normal') +
      ' saved map → native edit/Undo/save → original host → old pin → explicit adoption → reload',
    async ({ page }, info) => {
      await open(page, independent, independent ? 'setting' : 'production');
      const scope = independent ? '作品共通' : 'SC-01';
      const r = reference(page, scope);
      const before = await page.evaluate(() => window.cw3Fixture.links());
      const old = before.mapLocations!.locations.find(
        (r) => r.itemId === 'LO-02' && (independent ? !r.sceneId : r.sceneId === 'SC-01'),
      )!;
      const nativeBefore = (await page.evaluate(
        (id) => window.cw3Fixture.native(id),
        old.map.artifactId,
      ))!;
      await expect(r.getByAltText('LO-02の採用地図', { exact: true })).toBeVisible();
      if (!independent) {
        await button(page, 'Close 原稿と照合').click();
        await page.locator('p[data-block-id="port-text"]').click();
        await mapPane(page);
      }
      const selection = !independent
        ? await page.evaluate(() => window.cw3Fixture.sceneSelection())
        : undefined;
      await r.getByRole('button', { name: '地図を開く · LO-02', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('heading', { name: '地図 · 港町の固定地図', exact: true }),
      ).toBeVisible();
      await editTown(page, '手で修正した街');
      await button(page, '地図から元の制作へ戻る').click();
      await expect(page.getByRole('alert')).toContainText('Apply or cancel');
      await button(page, 'Apply feature').click();
      await button(page, 'Undo').click();
      await expect(page.getByLabel('Feature name', { exact: true })).toHaveValue('潮見の街');
      await button(page, 'Redo').click();
      await expect(page.getByLabel('Feature name', { exact: true })).toHaveValue('手で修正した街');
      await page.evaluate(() => window.cw3Fixture.faults({ native: 'lost' }));
      await button(page, '地図nativeを保存').click();
      await expect(page.getByRole('alert')).toContainText('lost ack');
      await expect(
        page.getByRole('status').filter({ hasText: '地図nativeに未保存' }),
      ).toBeVisible();
      await button(page, '地図nativeを保存').click();
      await expect(
        page.getByRole('status').filter({ hasText: '地図nativeは保存済み' }),
      ).toBeVisible();
      const saved = (await page.evaluate(
        (id) => window.cw3Fixture.native(id),
        old.map.artifactId,
      ))!;
      expect(saved.versions).toHaveLength(nativeBefore.versions.length + 1);
      expect(saved.versions.slice(0, nativeBefore.versions.length)).toEqual(nativeBefore.versions);
      const latest = saved.versions.at(-1)!;
      expect(latest.contentHash).toBe(await contentHash(latest.content));
      await button(page, '地図から元の制作へ戻る').click();
      await mapPane(page, independent ? '場所の部位' : '原稿と照合');
      expect((await page.evaluate(() => window.cw3Fixture.links())).mapLocations).toEqual(
        before.mapLocations,
      );
      if (!independent)
        expect(await page.evaluate(() => window.cw3Fixture.sceneSelection())).toEqual(selection);
      await expect(r).toHaveAttribute('data-map-state', 'stale');
      await expect(r).not.toContainText('手で修正した街');
      await r.getByRole('button', { name: '地図の採用版を選び直す · LO-02', exact: true }).click();
      const form = page.getByRole('form', { name: '固定地図の選択', exact: true });
      await form.getByLabel('地図保存版', { exact: true }).selectOption(latest.versionId);
      await form.getByLabel('地図ビュー', { exact: true }).selectOption('port');
      await form.getByLabel('地物 town', { exact: true }).check();
      await form.getByLabel('地物 port-area', { exact: true }).check();
      await page.evaluate(() => window.cw3Fixture.faults({ links: 'lost' }));
      await button(page, 'この地図版を明示採用して参照を保存').click();
      await expect(page.getByRole('alert')).toContainText('links lost ack');
      expect((await page.evaluate(() => window.cw3Fixture.links())).mapLocations).toEqual(
        before.mapLocations,
      );
      await button(page, 'この地図版を明示採用して参照を保存').click();
      await expect(form).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(r).toContainText('手で修正した街');
      const adopted = (await page.evaluate(() => window.cw3Fixture.links())).mapLocations!;
      expect(adopted.revision).toBe(before.mapLocations!.revision + 1);
      expect(adopted.locations.find((r) => r.id === old.id)?.map.versionId).toBe(latest.versionId);
      expect(adopted.locations.filter((r) => r.id !== old.id)).toEqual(
        before.mapLocations!.locations.filter((r) => r.id !== old.id),
      );
      await r.screenshot({ path: info.outputPath('adopted-' + info.project.name + '.png') });
      await page.reload();
      if (independent) {
        await page.locator('.creative-cards button').filter({ hasText: 'LO-02' }).click();
        await mapPane(page, '場所の部位');
      } else await mapPane(page);
      expect((await page.evaluate(() => window.cw3Fixture.links())).mapLocations).toEqual(adopted);
      await expect(r).toContainText('手で修正した街');
      await r.getByRole('button', { name: '地図を開く · LO-02', exact: true }).click();
      await button(page, 'この場所の設定画へ').click();
      await expect(page.getByRole('heading', { name: '舞台設計', exact: true })).toBeVisible();
      await page
        .getByRole('textbox', { name: '説明', exact: true })
        .fill('地図を見ながら場所の説明を手で編集。');
      await button(page, '設定と設定画を保存').click();
      expect((await page.evaluate(() => window.cw3Fixture.links())).mapLocations).toEqual(adopted);
      await button(page, independent ? '地図から来た制作へ戻る' : '元のSceneへ戻る').click();
      await expect(
        page.getByRole('heading', {
          name: independent ? '舞台設計' : '港町の物語 · 小説と漫画',
          exact: true,
        }),
      ).toBeVisible();
    },
  );

for (const independent of [false, true])
  test(
    (independent ? 'independent' : 'normal') +
      ' viewer can navigate map and location while native/save/adoption reject',
    async ({ page }) => {
      await open(page, independent, independent ? 'setting' : 'production', true);
      const r = reference(page, independent ? '作品共通' : 'SC-01');
      await expect(
        r.getByRole('button', { name: '地図の採用版を選び直す · LO-02', exact: true }),
      ).toBeDisabled();
      await r.getByRole('button', { name: '地図を開く · LO-02', exact: true }).click();
      await expect(button(page, '地図nativeを保存')).toBeDisabled();
      await expect(button(page, 'Add place')).toBeDisabled();
      await button(page, 'この場所の設定画へ').click();
      await expect(button(page, '設定と設定画を保存')).toBeDisabled();
      await button(page, independent ? '地図から来た制作へ戻る' : '元のSceneへ戻る').click();
    },
  );

for (const independent of [false, true])
  for (const kind of ['map', 'source'] as const)
    test(
      (independent ? 'independent' : 'normal') +
        ' individual ' +
        kind +
        ' read revocation masks live map and cached projection, recovery remains possible',
      async ({ page }, info) => {
        await open(page, independent, independent ? 'setting' : 'production');
        const r = reference(page, independent ? '作品共通' : 'SC-01');
        await r.getByRole('button', { name: '地図を開く · LO-02', exact: true }).click();
        await expect(page.locator('.fm-surface')).toBeVisible();
        const id = kind === 'map' ? 'cw3:harbor:map' : 'd3a:world-notes';
        await page.evaluate((id) => window.cw3Fixture.permission(id, false), id);
        await expect(page.locator('.fm-surface')).toHaveCount(0);
        await expect(page.locator('.map-location-editor')).toContainText('forbidden');
        await page.locator('.map-location-editor').screenshot({
          path: info.outputPath('masked-' + kind + '-' + info.project.name + '.png'),
        });
        await page.evaluate((id) => window.cw3Fixture.permission(id, true), id);
        await expect(page.locator('.fm-surface')).toBeVisible();
        await button(page, '地図から元の制作へ戻る').click();
        await mapPane(page, independent ? '場所の部位' : '原稿と照合');
        await expect(r.getByAltText('LO-02の採用地図', { exact: true })).toBeVisible();
      },
    );
for (const kind of ['artifact', 'hash', 'feature', 'ref'] as const)
  test(
    'diagnostic ' + kind + ' refuses map navigation without a fallback image',
    async ({ page }) => {
      await open(page);
      await page.evaluate((kind) => window.cw3Fixture.damage(kind), kind);
      await page.reload();
      await mapPane(page);
      const r = reference(page);
      await expect(
        r.getByRole('button', { name: '地図を開く · LO-02', exact: true }),
      ).toBeDisabled();
      await expect(r.getByAltText('LO-02の採用地図', { exact: true })).toHaveCount(0);
      await expect(r).toHaveAttribute(
        'data-map-state',
        kind === 'artifact' || kind === 'feature' ? 'missing' : 'invalid',
      );
    },
  );
test('delayed map open cannot replace a newer independent card selection', async ({ page }) => {
  await open(page, true, 'setting');
  await page.evaluate(() => window.cw3Fixture.faults({ holdRead: true }));
  await reference(page, '作品共通')
    .getByRole('button', { name: '地図を開く · LO-02', exact: true })
    .click();
  await expect.poll(() => page.evaluate(() => window.cw3Fixture.holding())).toBe(true);
  await button(page, 'Close 部位の編集').click();
  await page.locator('.creative-cards button').filter({ hasText: 'LO-01' }).click();
  await page.evaluate(() => window.cw3Fixture.release());
  await expect(
    page.getByRole('heading', { name: '地図 · 港町の固定地図', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.creative-item-heading')).toContainText('風見の家');
  await expect(page.getByRole('alert')).toContainText('遅い地図読取');
});

test('independent Character → map → Setting → original Character keeps the same native artifacts', async ({
  page,
}) => {
  await open(page, true, 'character');
  const before = await page.evaluate(() => window.cw3Fixture.artifacts());
  await reference(page, '作品共通')
    .getByRole('button', { name: '地図を開く · LO-02', exact: true })
    .click();
  await button(page, 'この場所の設定画へ').click();
  await expect(page.getByRole('heading', { name: '舞台設計', exact: true })).toBeVisible();
  await button(page, '地図から来た制作へ戻る').click();
  await expect(page.getByRole('heading', { name: 'キャラクター設計', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.cw3Fixture.artifacts())).toEqual(before);
});

test('manual saved-map connection uses the existing LO and writes only the explicit references', async ({
  page,
}) => {
  await open(page, true, 'setting');
  const before = await page.evaluate(() => window.cw3Fixture.artifacts());
  const old = await page.evaluate(() => window.cw3Fixture.links());
  await reference(page, '作品共通')
    .getByRole('button', { name: '地図参照を解除 · LO-02', exact: true })
    .click();
  await expect(reference(page, '作品共通')).toHaveCount(0);
  await button(page, '地図を接続').click();
  const form = page.getByRole('form', { name: '固定地図の選択', exact: true });
  await form.getByLabel('地図Artifact', { exact: true }).selectOption('cw3:harbor:map');
  const version = before.find((a) => a.id === 'cw3:harbor:map')!.versions[0];
  await form.getByLabel('地図保存版', { exact: true }).selectOption(version.versionId);
  await form.getByLabel('地図ビュー', { exact: true }).selectOption('port');
  await form.getByLabel('地物 town', { exact: true }).check();
  await form.getByLabel('地物 port-area', { exact: true }).check();
  await button(page, 'この地図版を明示採用して参照を保存').click();
  await expect(form).toHaveCount(0);
  await expect(
    reference(page, '作品共通').getByAltText('LO-02の採用地図', { exact: true }),
  ).toBeVisible();
  const after = await page.evaluate(() => window.cw3Fixture.links());
  expect(after.mapLocations!.locations).toHaveLength(old.mapLocations!.locations.length);
  expect(after.mapLocations!.revision).toBe(old.mapLocations!.revision + 2);
  expect(after.world).toEqual(old.world);
  expect(after.scenes).toEqual(old.scenes);
  expect(await page.evaluate(() => window.cw3Fixture.artifacts())).toEqual(before);
});

for (const conflict of [false, true])
  test(
    'explicit native semantic-ref assignment and separate adoption, conflict=' + conflict,
    async ({ page }) => {
      await open(page, true, 'setting');
      const before = await page.evaluate(() => window.cw3Fixture.links());
      const nativeBefore = (await page.evaluate(() => window.cw3Fixture.native('cw3:harbor:map')))!;
      await reference(page, '作品共通')
        .getByRole('button', { name: '地図の採用版を選び直す · LO-02', exact: true })
        .click();
      const form = page.getByRole('form', { name: '固定地図の選択', exact: true });
      await form.getByLabel('地物 town', { exact: true }).uncheck();
      await form.getByLabel('地物 port-area', { exact: true }).uncheck();
      await form.getByLabel('地物 ' + (conflict ? 'house' : 'unassigned'), { exact: true }).check();
      await button(page, '参照なしの選択地物へ場所を明示付与して地図を保存').click();
      if (conflict) {
        await expect(page.getByRole('alert')).toContainText('衝突');
        expect(await page.evaluate(() => window.cw3Fixture.native('cw3:harbor:map'))).toEqual(
          nativeBefore,
        );
        await button(page, '地図の選択を取消').click();
      } else {
        await expect(form.getByLabel('地図保存版', { exact: true })).not.toHaveValue(
          before.mapLocations!.locations[0].map.versionId,
        );
        const nativeAfter = (await page.evaluate(() =>
          window.cw3Fixture.native('cw3:harbor:map'),
        ))!;
        expect(nativeAfter.versions).toHaveLength(nativeBefore.versions.length + 1);
        const content = nativeAfter.draft
          .content as import('@editor-platform/fiction-map/model').FictionMapContent;
        expect(content.features.find((f) => f.id === 'unassigned')?.worldEntityRef).toEqual({
          namespace: 'harbor',
          entityId: 'LO-02',
        });
        expect((await page.evaluate(() => window.cw3Fixture.links())).mapLocations).toEqual(
          before.mapLocations,
        );
        await button(page, 'この地図版を明示採用して参照を保存').click();
        await expect(form).toHaveCount(0);
        await expect(reference(page, '作品共通')).toContainText('倉庫（参照なし）');
      }
    },
  );

for (const independent of [false, true])
  test(
    (independent ? 'independent' : 'normal') +
      ' public mount provisions a fixed map only after explicit harbor creation',
    async ({ page }) => {
      await page.goto(
        independent ? 'http://127.0.0.1:4177/production.html' : '/creative-production.html',
      );
      await button(page, '港町の制作例を作成').click();
      await mapPane(page);
      const r = reference(page);
      await expect(r.getByAltText('LO-02の採用地図', { exact: true })).toBeVisible();
      await r.getByRole('button', { name: '地図を開く · LO-02', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: '地図 · 港町の固定地図', exact: true }),
      ).toBeVisible();
      await button(page, '地図から元の制作へ戻る').click();
      await expect(
        page.getByRole('heading', { name: '港町の物語 · 小説と漫画', exact: true }),
      ).toBeVisible();
    },
  );
