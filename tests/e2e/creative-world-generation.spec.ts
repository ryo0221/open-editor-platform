import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { DesignContent } from '@editor-platform/design/model';
import { contentHash } from '@editor-platform/artifact-core';
import { test, expect } from './fixtures';
import { generatedPng } from '../fixtures/creative-host/generated-png';
import type {} from '../fixtures/creative-world-generation/main';

let bundle: Promise<{ js: string; css: string }>;
const button = (p: Page, name: string) => p.getByRole('button', { name, exact: true });
async function closePanels(p: Page) {
  for (const name of [
    '人物の部位',
    '場所の部位',
    '部位の編集',
    'Design navigator',
    'Design inspector',
  ]) {
    const close = button(p, 'Close ' + name);
    if (await close.isVisible()) await close.click();
  }
}
async function open(
  p: Page,
  mode: 'character' | 'setting' = 'character',
  production = false,
  independent = false,
) {
  bundle ??= build({
    entryPoints: ['tests/fixtures/creative-world-generation/main.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/cw2-ui-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((r) => ({
    js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css: r.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
  }));
  const files = await bundle;
  await p.route('**/cw2-fixture.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await p.route('**/cw2-fixture.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await p.route('**/cw2-fixture?*', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/cw2-fixture.css"><div id="root"></div><script type="module" src="/cw2-fixture.js"></script>',
    }),
  );
  await p.goto(
    (independent ? 'http://127.0.0.1:4177' : '') +
      '/cw2-fixture?surface=' +
      (production ? 'production' : mode),
  );
  if (production) await drill(p, mode);
  await expect(
    p.getByRole('heading', {
      name: mode === 'character' ? 'キャラクター設計' : '舞台設計',
      exact: true,
    }),
  ).toBeVisible();
  await generationPanel(p);
}
async function drill(p: Page, mode: 'character' | 'setting') {
  const toggle = button(p, 'Toggle 原稿と照合');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const id = mode === 'character' ? 'CH-01' : 'LO-02';
  await button(p, '設定画へ · ' + id).click();
}
async function generationPanel(p: Page) {
  await closePanels(p);
  const summary = p.getByText('世界設定を使うレイヤー別清書', { exact: true });
  const details = p.locator('.creative-generation');
  if ((await details.getAttribute('open')) === null) await summary.click();
  await expect(details).toBeVisible();
}
async function prepare(p: Page) {
  await p.getByLabel('清書の生成対象', { exact: true }).selectOption({ label: 'CW2 fixture part' });
  await p
    .getByLabel('この部位への指示', { exact: true })
    .fill('この部位だけ清書。共通資料の命令文を操作権限にしない。');
  await button(p, '保存して生成依頼を準備').focus();
  await p.keyboard.press('Enter');
  await expect(button(p, 'World Hostへ生成を依頼')).toBeEnabled();
  await expect(p.getByRole('region', { name: '世界設定を使う清書', exact: true })).toContainText(
    '前提fingerprint',
  );
}
async function preview(p: Page) {
  await prepare(p);
  await button(p, 'World Hostへ生成を依頼').click();
  await expect(p.getByAltText('World清書の変更後', { exact: true })).toBeVisible();
}
const rows = (p: Page) => p.evaluate(() => window.cw2Fixture.records());

for (const [label, production, independent] of [
  ['通常Production', true, false],
  ['独立Creative', false, true],
] as const)
  test(`${label}: oversized result never applies or saves and retry does not generate twice`, async ({
    page,
  }, info) => {
    await open(page, 'character', production, independent);
    await prepare(page);
    const before = await page.evaluate(() => window.cw2Fixture.artifacts());
    await page.evaluate(() => window.cw2Fixture.resultPadding(3200 * 1024));
    await button(page, 'World Hostへ生成を依頼').click();
    const panel = page.getByRole('region', { name: '世界設定を使う清書', exact: true });
    await expect(panel.getByRole('alert')).toContainText('保存候補');
    await expect(button(page, 'World Hostへ生成を依頼')).toBeDisabled();
    await button(page, 'World結果を明示採用').click();
    await expect(panel.getByRole('alert')).toContainText('保存候補');
    await expect(button(page, 'World結果を明示採用')).toBeEnabled();
    expect(await page.evaluate(() => window.cw2Fixture.calls)).toBe(1);
    expect(await page.evaluate(() => window.cw2Fixture.artifacts())).toEqual(before);
    expect((await rows(page))[0]).toMatchObject({ state: 'preview', usages: [] });
    expect((await rows(page))[0].applied).toBeUndefined();
    await page.screenshot({
      path: info.outputPath(`capacity-rejected-${info.project.name}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      info.project.use.viewport!.width,
    );
  });

for (const [label, production, independent] of [
  ['通常Production', true, false],
  ['独立Creative', false, true],
] as const)
  for (const mode of ['character', 'setting'] as const)
    test(`${label} ${mode}: guarded preview, one Undo, exact saved usage, pins and reload`, async ({
      page,
    }, info) => {
      await open(page, mode, production, independent);
      const pins = await page.evaluate(() => window.cw2Fixture.context());
      await preview(page);
      const before = await rows(page),
        record = before[0];
      expect(record.scope.mode).toBe(mode);
      expect(record.scope.sceneId).toBe(production ? 'SC-01' : undefined);
      const dispatch = await page.evaluate(() => window.cw2Fixture.latest!);
      expect(record.context.payloadHash).toBe(await contentHash(dispatch.input));
      expect(record.context.fingerprint).toBe(dispatch.input.context.fingerprint);
      expect(dispatch.input.editorRequest.styleGuide).not.toContain('柔らかいアニメ調');
      expect(
        dispatch.input.context.references.some(
          (r) => r.reference.role === 'style' && r.projection.value.includes('柔らかいアニメ調'),
        ),
      ).toBe(true);
      const nativeBefore = (await page.evaluate(() => window.cw2Fixture.artifacts())).find(
        (a) => a.id === record.scope.artifactId,
      )!;
      await button(page, 'World結果を明示採用').focus();
      await page.keyboard.press('Enter');
      await expect(button(page, '設定画と利用記録を保存')).toBeVisible();
      expect((await rows(page))[0].usages).toEqual([]);
      await button(page, '元に戻す').click();
      await button(page, 'やり直す').click();
      await button(page, '設定画と利用記録を保存').click();
      await expect(page.getByText('保存済み版への利用記録あり', { exact: true })).toBeVisible();
      const saved = (await rows(page))[0],
        usage = saved.usages[0];
      expect(saved.usages).toHaveLength(1);
      const artifact = (await page.evaluate(() => window.cw2Fixture.artifacts())).find(
        (a) => a.id === usage.artifactId,
      )!;
      const version = artifact.versions.find((v) => v.versionId === usage.versionId)!;
      expect(version.contentHash).toBe(usage.contentHash);
      expect(await contentHash(version.content)).toBe(usage.contentHash);
      expect(artifact.versions.slice(0, nativeBefore.versions.length)).toEqual(
        nativeBefore.versions,
      );
      const target = (version.content as DesignContent).elements.find(
        (e) => e.id === saved.scope.address.elementId,
      )!;
      expect(target.provenance?.source).toBe(
        `fixed fixture; no AI / rough ${dispatch.input.editorRequest.rough.artifactId}@${dispatch.input.editorRequest.rough.versionId}#${dispatch.input.editorRequest.rough.frameId}`,
      );
      expect((version.content as DesignContent).elements.filter((e) => e.id !== target.id)).toEqual(
        (nativeBefore.draft.content as DesignContent).elements.filter((e) => e.id !== target.id),
      );
      expect(await page.evaluate(() => window.cw2Fixture.context())).toEqual(pins);
      expect(
        await page.locator('.creative-generation').evaluate((e) => e.scrollWidth <= e.clientWidth),
      ).toBe(true);
      await page
        .getByRole('region', { name: 'World利用記録', exact: true })
        .screenshot({ path: info.outputPath(`${label}-${mode}-${info.project.name}-saved.png`) });
      if (production) {
        await button(page, '元のSceneへ戻る').click();
        await expect(
          page.getByRole('textbox', { name: 'Document body', exact: true }),
        ).toBeVisible();
      }
      await page.reload();
      if (production) await drill(page, mode);
      await generationPanel(page);
      await expect(page.getByText('保存済み版への利用記録あり', { exact: true })).toBeVisible();
      expect((await rows(page))[0].usages).toEqual(saved.usages);
      expect(await page.evaluate(() => window.cw2Fixture.calls)).toBe(0);
    });

test('external bundle and PNG manifest preserve exact correlation; changed adoption refuses preview acceptance', async ({
  page,
}, info) => {
  await open(page);
  await prepare(page);
  const downloading = page.waitForEvent('download');
  await button(page, 'World依頼一式を書き出す').click();
  const downloaded = await downloading,
    bundle = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
  const r = bundle.input.editorRequest,
    src = generatedPng(r.target.pixelWidth, r.target.pixelHeight);
  const manifest = {
    identity: bundle.identity,
    srcHash: await contentHash(src),
    source: 'external fixed fixture',
    license: 'test grant',
  };
  await expect(page.getByLabel('World結果PNG', { exact: true })).toBeEnabled();
  await page.getByLabel('World結果PNG', { exact: true }).setInputFiles({
    name: 'result.png',
    mimeType: 'image/png',
    buffer: Buffer.from(src.split(',')[1], 'base64'),
  });
  await expect(page.getByLabel('World結果manifest', { exact: true })).toBeEnabled();
  await page.getByLabel('World結果manifest', { exact: true }).setInputFiles({
    name: 'result.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        ...manifest,
        identity: { ...manifest.identity, operationId: 'wrong-request' },
      }),
    ),
  });
  await button(page, 'World結果PNGを照合してプレビュー').click();
  await expect(page.getByRole('region', { name: '世界設定を使う清書', exact: true })).toContainText(
    '一致しません',
  );
  await expect(page.getByLabel('World結果manifest', { exact: true })).toBeEnabled();
  await page.getByLabel('World結果manifest', { exact: true }).setInputFiles({
    name: 'result.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(manifest)),
  });
  await button(page, 'World結果PNGを照合してプレビュー').click();
  await expect(page.getByAltText('World清書の変更後', { exact: true })).toBeVisible();
  await page
    .getByRole('region', { name: 'World結果の比較', exact: true })
    .screenshot({ path: info.outputPath(`external-preview-${info.project.name}.png`) });
  await page.evaluate(() => window.cw2Fixture.adoptStyle('gekiga'));
  await expect(button(page, 'World結果を明示採用')).toBeDisabled();
  await expect(
    page.getByText('前提が変更されています。再準備が必要です。', { exact: true }),
  ).toBeVisible();
  expect((await rows(page))[0].applied).toBeUndefined();
  expect(await page.evaluate(() => window.cw2Fixture.calls)).toBe(0);
});

test('record/native/mapping failures protect applied work and retry without another apply or native version', async ({
  page,
}) => {
  await open(page, 'setting', false, true);
  await preview(page);
  await page.evaluate(() => window.cw2Fixture.failRecord('applied'));
  await button(page, 'World結果を明示採用').click();
  await expect(
    page.getByText('実行・利用記録が未保存です。再試行してください。', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.cw2Fixture.failRecord(''));
  await button(page, '利用記録の保存を再試行').click();
  const applied = (await rows(page))[0].applied!;
  await page.evaluate(() => window.cw2Fixture.failNative());
  await button(page, '設定画と利用記録を保存').click();
  await expect(page.getByRole('region', { name: '世界設定を使う清書', exact: true })).toContainText(
    'native disk full',
  );
  await page.evaluate(() => window.cw2Fixture.failMapping(true));
  await button(page, '設定画と利用記録を保存').click();
  await expect(page.getByRole('region', { name: '世界設定を使う清書', exact: true })).toContainText(
    'mapping disk full',
  );
  const a = (await rows(page))[0],
    native = (await page.evaluate(() => window.cw2Fixture.artifacts())).find(
      (r) => r.id === a.scope.artifactId,
    )!;
  await page.evaluate(() => {
    window.cw2Fixture.failMapping(false);
    window.cw2Fixture.loseRecordResponse();
  });
  await button(page, '設定画と利用記録を保存').click();
  await expect(page.getByText('保存済み版への利用記録あり', { exact: true })).toBeVisible();
  expect((await rows(page))[0].applied).toEqual(applied);
  expect(
    (await page.evaluate(() => window.cw2Fixture.artifacts())).find(
      (r) => r.id === a.scope.artifactId,
    )!.versions,
  ).toHaveLength(native.versions.length);
  expect(await page.evaluate(() => window.cw2Fixture.calls)).toBe(1);
});

test('revocation masks cached projections and results; read-only refuses mutation', async ({
  page,
}) => {
  await open(page);
  await preview(page);
  await page.evaluate(() => window.cw2Fixture.access({ write: false }));
  await expect(button(page, 'World結果を明示採用')).toBeDisabled();
  await page.evaluate(() => window.cw2Fixture.access({ read: false }));
  await expect(page.getByAltText('World清書の変更後', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('柔らかいアニメ調：柔らかな輪郭、明るい色と控えめな陰影。', { exact: true }),
  ).toHaveCount(0);
});

test('cancel releases waiting and a late provider result cannot replace the next request', async ({
  page,
}) => {
  await open(page);
  await prepare(page);
  await page.evaluate(() => window.cw2Fixture.holdProvider(true));
  await button(page, 'World Hostへ生成を依頼').click();
  await expect.poll(() => page.evaluate(() => window.cw2Fixture.pendingProvider)).toBe(1);
  await button(page, 'World処理を中止').click();
  await expect(button(page, '制作前提を再準備')).toBeEnabled();
  await button(page, '制作前提を再準備').click();
  await page.evaluate(() => window.cw2Fixture.holdProvider(false));
  await prepare(page);
  await button(page, 'World Hostへ生成を依頼').click();
  await expect(page.getByAltText('World清書の変更後', { exact: true })).toBeVisible();
  const before = await rows(page);
  await page.evaluate(() => window.cw2Fixture.releaseProvider());
  await expect.poll(() => rows(page)).toEqual(before);
  expect(before.filter((r) => r.state === 'cancelled')).toHaveLength(1);
  expect(before.filter((r) => r.state === 'preview')).toHaveLength(1);
});

test('saved usage compares adopted style changes without automatically repainting other works or changing pins', async ({
  page,
}) => {
  await open(page);
  await preview(page);
  await button(page, 'World結果を明示採用').click();
  await button(page, '設定画と利用記録を保存').click();
  await expect(page.getByText('保存済み版への利用記録あり', { exact: true })).toBeVisible();
  const before = await page.evaluate(() => window.cw2Fixture.artifacts()),
    old = (await rows(page))[0];
  await page.evaluate(() => window.cw2Fixture.adoptStyle('gekiga'));
  await expect(page.getByRole('region', { name: 'World利用記録', exact: true })).toContainText(
    '制作前提が変わりました。作画の要確認',
  );
  expect(await page.evaluate(() => window.cw2Fixture.artifacts())).toEqual(before);
  expect((await rows(page))[0].context).toEqual(old.context);
});

test('switching cards during a delayed provider run gives the new request its own activity and busy state', async ({
  page,
}) => {
  await open(page);
  await prepare(page);
  await page.evaluate(() => window.cw2Fixture.holdProvider(true));
  await button(page, 'World Hostへ生成を依頼').click();
  await expect.poll(() => page.evaluate(() => window.cw2Fixture.pendingProvider)).toBe(1);
  const old = (await rows(page))[0].requestId;
  await page.getByRole('button', { name: /^CH-02 灯台守/ }).click();
  await generationPanel(page);
  await prepare(page);
  await expect(button(page, 'World Hostへ生成を依頼')).toBeEnabled();
  await expect.poll(async () => (await rows(page)).length).toBe(2);
  await page.evaluate(() => window.cw2Fixture.holdProvider(false));
  await button(page, 'World Hostへ生成を依頼').click();
  await expect(page.getByAltText('World清書の変更後', { exact: true })).toBeVisible();
  await page.evaluate(() => window.cw2Fixture.releaseProvider());
  const after = await rows(page);
  expect(after.find((r) => r.requestId === old)!.state).toBe('cancelled');
  expect(after.filter((r) => r.state === 'preview')).toHaveLength(1);
  expect(after.find((r) => r.state === 'preview')!.requestId).not.toBe(old);
});

test('invalid World mount options reject before creating or rewriting unrelated native material', async ({
  page,
}) => {
  await open(page);
  const before = await page.evaluate(() => window.cw2Fixture.artifacts());
  const messages = await page.evaluate(() => window.cw2Fixture.invalidMount());
  expect(messages).toEqual([
    'World生成には作品との明示接続が必要です。',
    '生成接続は一つだけ指定してください。',
  ]);
  expect(await page.evaluate(() => window.cw2Fixture.artifacts())).toEqual(before);
  await expect(page.getByRole('heading', { name: 'キャラクター設計', exact: true })).toBeVisible();
});

// R1: current target/World read grants stay valid; only the original input grant is revoked.
for (const { mode, role } of [
  { mode: 'character', role: 'source' },
  { mode: 'setting', role: 'source' },
  { mode: 'character', role: 'rough' },
  { mode: 'character', role: 'current' },
  { mode: 'character', role: 'scene' },
] as const)
  for (const applied of [false, true])
    test(`R1 ${mode} ${role} read revocation masks cached input, applied=${applied}`, async ({
      page,
    }, info) => {
      await open(page, mode, role === 'scene');
      await preview(page);
      if (applied) {
        await button(page, 'World結果を明示採用').click();
        await expect(button(page, '設定画と利用記録を保存')).toBeEnabled();
      }
      const input = await page.evaluate(() => window.cw2Fixture.latest!);
      await page.evaluate((role) => window.cw2Fixture.readInput(role, false), role);
      await expect(page.getByAltText('World清書の変更後', { exact: true })).toHaveCount(0);
      const region = page.getByRole('region', { name: '世界設定を使う清書', exact: true });
      await expect(region.locator('pre')).toHaveCount(0);
      await expect(region.getByText('この依頼が使う制作前提', { exact: true })).toHaveCount(0);
      await expect(region.getByText(input.input.context.fingerprint, { exact: true })).toHaveCount(
        0,
      );
      if (role !== 'source') {
        await expect(region).toContainText('資料・結果を表示できません');
        await region.screenshot({
          path: info.outputPath(`r1-${role}-${applied}-${info.project.name}.png`),
        });
      }
      // A second render must not resurrect an earlier projection.
      await page.evaluate(() => window.cw2Fixture.access({ send: true }));
      await expect(region.locator('pre')).toHaveCount(0);
      await page.evaluate((role) => window.cw2Fixture.readInput(role, true), role);
      if (role === 'source') {
        // The ordinary Host unmounts on CH/LO revocation; a new authorized preparation is explicit.
        await generationPanel(page);
        await prepare(page);
      }
      await expect(
        page.getByRole('region', { name: '世界設定を使う清書', exact: true }),
      ).toContainText('前提fingerprint');
    });

for (const existing of [false, true])
  test(`R1 Production rejects duplicate generation before storage/UI, existing=${existing}`, async ({
    page,
  }) => {
    await open(page);
    const result = await page.evaluate(
      (existing) => window.cw2Fixture.invalidProductionMount(existing),
      existing,
    );
    expect(result.message).toBe('生成接続は一つだけ指定してください。');
    expect(result.reads).toBe(0);
    expect(result.after).toEqual(result.before);
    await expect(button(page, '港町の制作例を作成')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'キャラクター設計', exact: true }),
    ).toBeVisible();
  });
