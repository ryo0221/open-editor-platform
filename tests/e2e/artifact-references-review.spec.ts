import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { unzipSync, strFromU8 } from 'fflate';
import { test, expect } from './fixtures';
import type { Page, Locator } from '@playwright/test';

test.describe.configure({ timeout: 30000 });

const bundled = build({
  entryPoints: [fileURLToPath(new URL('../fixtures/references/review-host.tsx', import.meta.url))],
  bundle: true,
  write: false,
  outdir: '/tmp/reference-review-host',
  format: 'esm',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
async function mount(page: Page, query: string) {
  await page.route('**/reference-review.html*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>',
    }),
  );
  await page.goto(`/reference-review.html?${query}`);
  for (const file of (await bundled).outputFiles!) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text, type: 'module' });
  }
  await expect.poll(() => page.evaluate(() => !!window.referenceReview)).toBe(true);
  if (!new URLSearchParams(query).has('disconnected'))
    await expect
      .poll(() => page.evaluate(() => window.referenceReview.subscriptions()[0]))
      .toBeGreaterThan(0);
  await expect
    .poll(async () => (await images(page.locator('body'))).some((s) => s.includes('95')))
    .toBe(true);
}
async function images(locator: Locator) {
  const uris = await locator
    .locator('image[href^="data:image/svg+xml"],img[src^="data:image/svg+xml"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? e.getAttribute('src')!));
  return uris.map((u) => Buffer.from(u.split(',')[1], 'base64').toString('utf8'));
}
async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await button.click();
}
async function showInspector(page: Page) {
  if (
    !(await page.getByRole('button', { name: '参照を解除して画像にする', exact: true }).isVisible())
  )
    await page
      .getByRole('button', { name: /^Toggle (Slide|Design|Board|Document) inspector$/ })
      .click();
}
for (const mode of ['fixed', 'follow']) {
  test(`review pending creation: freezes source and mode and ignores an earlier discovery (${mode})`, async ({
    page,
  }, info) => {
    await mount(page, 'kind=slide&choices=1');
    const before = await page.evaluate(() => window.referenceReview.source());
    await tool(page, '参照を埋め込む');
    const menu = page.getByRole('dialog', { name: '参照を埋め込む', exact: true });
    const discover = menu.getByRole('button', { name: '参照元を再取得', exact: true });
    await discover.click();
    const source = menu.getByLabel('埋め込みの参照元', { exact: true });
    const updateMode = menu.getByLabel('埋め込みの更新方式', { exact: true });
    await expect(source.locator('option')).toHaveCount(3);
    await source.selectOption('1');
    await updateMode.selectOption(mode);
    await page.evaluate(() => window.referenceReview.blockList());
    await discover.click();
    await expect.poll(() => page.evaluate(() => window.referenceReview.listPending())).toBe(1);
    await page.evaluate(() => window.referenceReview.block());
    await menu.getByRole('button', { name: '参照を配置', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.referenceReview.reads().length)).toBe(1);
    await expect(source).toBeDisabled();
    await expect(updateMode).toBeDisabled();
    await expect(discover).toBeDisabled();
    await page.evaluate(() => window.referenceReview.releaseList());
    await expect(source).toHaveValue('1');
    await expect(updateMode).toHaveValue(mode);
    await page.screenshot({ path: info.outputPath('reference-choices-frozen.png') });
    await page.evaluate(() => window.referenceReview.release());
    await expect(menu.getByRole('button', { name: '参照を配置', exact: true })).toBeEnabled();
    const after = (await page.evaluate(() => window.referenceReview.source())) as {
      slides: { objects: { reference?: { source: { artifactId: string }; mode: string } }[] }[];
    };
    const added = after.slides[0].objects.at(-1)!.reference!;
    expect(added.source.artifactId).toBe('outside');
    expect(added.mode).toBe(mode);
    await expect(source).toBeEnabled();
    await expect(updateMode).toBeEnabled();
    await page.evaluate(() => window.referenceReview.undo());
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
  });
}
for (const mode of ['fixed', 'follow']) {
  for (const fit of ['contain', 'cover']) {
    test(`review Document fit: width preserves the natural ratio without an unsupported crop control (${mode}/${fit})`, async ({
      page,
    }, info) => {
      await mount(
        page,
        `kind=document${mode === 'fixed' ? '&fixed=1' : ''}${fit === 'cover' ? '&cover=1' : ''}`,
      );
      await page.locator('.ProseMirror img').click();
      await showInspector(page);
      const before = await page.evaluate(() => window.referenceReview.source());
      await expect(page.getByLabel('参照の表示方法', { exact: true })).toHaveCount(0);
      await expect(
        page.getByText('画像は元の縦横比を保って表示します。幅を調整できます。'),
      ).toBeVisible();
      expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
      const width = page.getByLabel('Image width', { exact: true });
      await width.fill('320');
      await width.press('Enter');
      const dimensions = await page.locator('.ProseMirror img').evaluate((img) => {
        const node = img as HTMLImageElement;
        const box = node.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          natural: node.naturalWidth / node.naturalHeight,
        };
      });
      expect(dimensions.width).toBeLessThanOrEqual(320);
      expect(dimensions.height).toBeGreaterThan(0);
      expect(dimensions.width / dimensions.height).toBeCloseTo(dimensions.natural, 2);
      const current = (await page.evaluate(() => window.referenceReview.source())) as {
        blocks: { type: string; width?: number; reference?: { fit: string } }[];
      };
      const image = current.blocks.find((b) => b.type === 'image')!;
      expect(image.width).toBe(320);
      expect(image.reference?.fit).toBe(fit);
      await tool(page, 'Export document');
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export HTML', exact: true }).click();
      const html = await readFile((await (await pending).path())!, 'utf8');
      const exported = await page.evaluate((text) => {
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const image = doc.querySelector('img')!;
        return {
          width: image.getAttribute('width'),
          height: image.getAttribute('height'),
          manifest: doc.querySelector('meta[name="artifact-references"]')?.getAttribute('content'),
        };
      }, html);
      expect(exported.width).toBe('320');
      expect(exported.height).toBeNull();
      expect(exported.manifest).toContain(`"fit":"${fit}"`);
      await page.keyboard.press('Escape');
      await page.screenshot({ path: info.outputPath('document-natural-ratio-width.png') });
      await page.evaluate(() => window.referenceReview.undo());
      expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
    });
  }
}
for (const kind of ['slide', 'design', 'whiteboard', 'document']) {
  for (const mode of ['fixed', 'follow']) {
    test(`review public input: ${kind} revalidates replacement closure bytes before rendering (${mode})`, async ({
      page,
    }, info) => {
      await mount(page, `kind=${kind}${mode === 'fixed' ? '&fixed=1' : ''}`);
      const before = await page.evaluate(() => window.referenceReview.source());
      if (kind !== 'document') {
        await showInspector(page);
        await expect(
          page.getByRole('status').filter({ hasText: '解決済み' }).first(),
        ).toBeVisible();
      }
      await page.evaluate(() => window.referenceReview.tamperClosure());
      const malformed = await page.evaluate(() => window.referenceReview.source());
      await expect(
        page.getByText('参照元contentのhashが一致しません。', { exact: false }).first(),
      ).toBeVisible();
      await expect
        .poll(async () =>
          (await images(page.locator('body'))).some((image) => image.includes('>95<')),
        )
        .toBe(false);
      expect(await page.evaluate(() => window.referenceReview.source())).toEqual(malformed);
      await page.screenshot({
        path: info.outputPath(`${kind}-${mode}-replacement-hash-rejected.png`),
      });
      await page.evaluate(() => window.referenceReview.undo());
      expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
      expect(await page.evaluate(() => window.referenceReview.canUndo())).toBe(false);
      await expect
        .poll(async () =>
          (await images(page.locator('body'))).some((image) => image.includes('>95<')),
        )
        .toBe(true);
    });
  }
}
for (const host of [false, true]) {
  for (const mode of ['fixed', 'follow']) {
    test(`review placement: ${host ? 'public Host' : 'Design Surface'} uses current destination during ${mode} creation`, async ({
      page,
    }, info) => {
      await mount(page, `kind=design&focus=frame${host ? '&host-placement=1' : ''}`);
      const before = await page.evaluate(() => window.referenceReview.source());
      const label = host ? 'Host placement' : '参照を埋め込む';
      if (host) await page.getByRole('button', { name: label, exact: true }).click();
      else await tool(page, label);
      const menu = page.getByRole('dialog', { name: label, exact: true });
      await menu.getByRole('button', { name: '参照元を再取得', exact: true }).click();
      await expect(menu.getByLabel('埋め込みの参照元').locator('option')).toHaveCount(2);
      await menu.getByLabel('埋め込みの更新方式').selectOption(mode);
      await page.evaluate(() => window.referenceReview.block());
      await menu.getByRole('button', { name: '参照を配置', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.referenceReview.reads().includes('included')))
        .toBe(true);
      await page.evaluate(() => window.referenceReview.moveFrame(200, 150));
      const moved = await page.evaluate(() => window.referenceReview.source());
      await page.evaluate(() => window.referenceReview.release());
      await expect(menu.getByRole('button', { name: '参照を配置', exact: true })).toBeEnabled();
      const after = (await page.evaluate(() => window.referenceReview.source())) as {
        elements: {
          id: string;
          parentId?: string;
          bounds: { x: number; y: number };
          reference?: { mode: string };
        }[];
      };
      const oldIds = new Set((before as typeof after).elements.map((element) => element.id));
      const inserted = after.elements.filter((element) => !oldIds.has(element.id));
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        parentId: 'frame',
        reference: { mode },
        bounds: host ? { x: 224, y: 174 } : { x: 80, y: 140 },
      });
      expect(after.elements.filter((element) => oldIds.has(element.id))).toEqual(
        (moved as typeof after).elements,
      );
      await page.keyboard.press('Escape');
      await page.screenshot({
        path: info.outputPath(`${host ? 'host' : 'design'}-${mode}-placement.png`),
      });
      await page.evaluate(() => window.referenceReview.undo());
      expect(await page.evaluate(() => window.referenceReview.source())).toEqual(moved);
      await page.evaluate(() => window.referenceReview.undo());
      expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
      expect(await page.evaluate(() => window.referenceReview.canUndo())).toBe(false);
    });
  }
}
for (const kind of ['slide', 'design', 'whiteboard']) {
  test(`review: ${kind} excludes inherited hidden references from capture and manifests`, async ({
    page,
  }, info) => {
    await mount(page, `kind=${kind}&ancestor-hidden=1`);
    const before = await page.evaluate(() => window.referenceReview.source());
    await page.evaluate(() => window.referenceReview.excludeOutside());
    await tool(page, kind === 'slide' ? 'Export visual' : `Export ${kind}`);
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', {
        name: kind === 'slide' ? 'Export SVG' : 'Export all SVG',
        exact: true,
      })
      .click();
    const files = unzipSync(await readFile((await (await download).path())!));
    const manifest = JSON.parse(strFromU8(files['references.json']));
    expect(
      manifest.sources.map((s: { source: { artifactId: string } }) => s.source.artifactId),
    ).toEqual(['included']);
    expect(await page.evaluate(() => window.referenceReview.reads())).toEqual(['included']);
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: info.outputPath(`${kind}-hidden-closure-excluded.png`) });
    await mount(page, `kind=${kind}&ancestor-hidden=1&visible-plain=1&disconnected=1`);
    await tool(page, kind === 'slide' ? 'Export visual' : `Export ${kind}`);
    const plain = page.waitForEvent('download');
    await page
      .getByRole('button', {
        name: kind === 'slide' ? 'Export SVG' : 'Export all SVG',
        exact: true,
      })
      .click();
    expect(await readFile((await (await plain).path())!, 'utf8')).toContain('<svg');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
for (const kind of ['slide', 'design', 'whiteboard']) {
  test(`review: ${kind} rejects unchecked reference exports without a resolver`, async ({
    page,
  }, info) => {
    await mount(page, `kind=${kind}&disconnected=1`);
    const before = await page.evaluate(() => window.referenceReview.source());
    const downloads: string[] = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await tool(page, kind === 'slide' ? 'Export visual' : `Export ${kind}`);
    for (const format of kind === 'slide' ? ['SVG', 'PNG', 'PDF'] : ['SVG', 'PNG']) {
      const name = kind === 'slide' ? `Export ${format}` : `Export all ${format}`;
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('参照付きの出力には参照接続が必要です');
    }
    expect(downloads).toEqual([]);
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: info.outputPath(`${kind}-resolver-required.png`) });
    await mount(page, `kind=${kind}&disconnected=1&plain=1`);
    await tool(page, kind === 'slide' ? 'Export visual' : `Export ${kind}`);
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', {
        name: kind === 'slide' ? 'Export SVG' : 'Export all SVG',
        exact: true,
      })
      .click();
    const output = await readFile((await (await download).path())!, 'utf8');
    expect(output).toContain('<svg');
    expect(output).toContain('data:image/svg+xml');
    expect(await page.getByRole('alert').count()).toBe(0);
  });
}
test('review: Document rejects unchecked export and print without a resolver', async ({
  page,
}, info) => {
  await mount(page, 'kind=document&disconnected=1');
  const before = await page.evaluate(() => window.referenceReview.source());
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await tool(page, 'Export document');
  for (const name of ['Export MD', 'Export HTML', 'Export PDF', 'Print preview']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('参照付きの出力には参照接続が必要です');
    await expect(
      page.getByRole('dialog', { name: 'Document print preview', exact: true }),
    ).toHaveCount(0);
  }
  expect(downloads).toEqual([]);
  expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('document-resolver-required.png') });
  await mount(page, 'kind=document&disconnected=1&plain=1');
  await tool(page, 'Export document');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export HTML', exact: true }).click();
  const output = await readFile((await (await download).path())!, 'utf8');
  expect(output).toContain('Editable text');
  expect(output).not.toContain('artifact-references');
  await page.getByRole('button', { name: 'Print preview', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Document print preview', exact: true })
      .getByRole('img', { name: 'Print page 1', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
for (const kind of ['slide', 'whiteboard']) {
  test(`review: ${kind} keeps hidden descendants out of projected canvas targets`, async ({
    page,
  }, info) => {
    await mount(page, `kind=${kind}&grouped=1`);
    const canvas = page.getByRole('application', {
      name: kind === 'slide' ? 'Slide canvas' : 'Whiteboard canvas',
      exact: true,
    });
    const child = canvas.locator('[data-canvas-target="inside"]');
    const plain = canvas.locator('[data-canvas-target="plain"]');
    await expect(child).toHaveCount(1);
    await expect(plain).toHaveCount(1);
    const before = await page.evaluate(() => window.referenceReview.source());
    await page.evaluate(() => window.referenceReview.hideGroup(true));
    await expect(child).toHaveCount(0);
    await expect(plain).toHaveCount(0);
    const hidden = await page.evaluate(() => window.referenceReview.source());
    await page.evaluate(() => window.referenceReview.publish());
    await expect
      .poll(async () => (await images(canvas)).some((s) => s.includes('>80<')))
      .toBe(false);
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(hidden);
    await page.screenshot({ path: info.outputPath(`${kind}-hidden-group.png`) });
    await page.evaluate(() => window.referenceReview.hideGroup(false));
    await expect(child).toHaveCount(1);
    await expect(plain).toHaveCount(1);
    await expect.poll(async () => (await images(child)).some((s) => s.includes('>80<'))).toBe(true);
    await page.evaluate(() => window.referenceReview.undo());
    await expect(child).toHaveCount(0);
    await expect(plain).toHaveCount(0);
    await page.evaluate(() => window.referenceReview.undo());
    await expect(child).toHaveCount(1);
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
    await page.screenshot({ path: info.outputPath(`${kind}-restored-group.png`) });
  });
}
for (const kind of ['slide', 'design', 'whiteboard', 'document']) {
  test(`review: ${kind} hides cached pixels throughout asynchronous access revalidation`, async ({
    page,
  }, info) => {
    await mount(page, `kind=${kind}`);
    const before = await page.evaluate(() => window.referenceReview.source());
    for (const outcome of ['forbidden', 'offline'] as const) {
      await page.evaluate(() => window.referenceReview.expireAccess());
      await expect
        .poll(() => page.evaluate(() => window.referenceReview.accessPending()))
        .toBeGreaterThan(0);
      await expect
        .poll(async () => (await images(page.locator('body'))).some((s) => s.includes('>95<')))
        .toBe(false);
      await page.screenshot({ path: info.outputPath(`${kind}-${outcome}-access-pending.png`) });
      await page.evaluate((value) => window.referenceReview.releaseAccess(value), outcome);
      if (kind === 'document')
        await page
          .getByText(outcome === 'forbidden' ? /参照権限がありません/ : /オフライン/)
          .first()
          .waitFor();
      await expect
        .poll(async () => (await images(page.locator('body'))).some((s) => s.includes('>95<')))
        .toBe(outcome === 'offline');
      await page.evaluate(() => window.referenceReview.releaseAccess('online'));
      await expect
        .poll(async () => (await images(page.locator('body'))).some((s) => s.includes('>95<')))
        .toBe(true);
    }
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
  });
}
for (const [kind, scope, focus] of [
  ['design', 'selection', 'frame'],
  ['design', 'frames', 'frame'],
  ['whiteboard', 'selection', 'section'],
  ['whiteboard', 'section', 'section'],
  ['slide', 'current', 'inside'],
  ['slide', 'selected', 'inside'],
]) {
  test(`review: ${kind} ${scope} exports only visible scoped references`, async ({ page }) => {
    await mount(page, `kind=${kind}&focus=${focus}`);
    const before = await page.evaluate(() => window.referenceReview.source());
    await page.evaluate(() => window.referenceReview.excludeOutside());
    if (kind === 'slide' && scope === 'selected') {
      const thumb = page.getByRole('button', { name: 'Slide 1: First', exact: true });
      if (!(await thumb.isVisible()))
        await page.getByRole('button', { name: 'Toggle Slide navigator', exact: true }).click();
      await thumb.click();
    }
    await tool(page, kind === 'slide' ? 'Export visual' : `Export ${kind}`);
    if (kind === 'slide') await page.getByLabel('Export scope').selectOption(scope);
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', {
        name: kind === 'slide' ? 'Export SVG' : `Export ${scope} SVG`,
        exact: true,
      })
      .click();
    const files = unzipSync(await readFile((await (await download).path())!));
    const manifest = JSON.parse(strFromU8(files['references.json']));
    expect(
      manifest.sources.map((s: { source: { artifactId: string } }) => s.source.artifactId),
    ).toEqual(['included']);
    const graphic = Object.entries(files)
      .filter(([name]) => name.endsWith('.svg'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('');
    expect(graphic).toContain('data:image/svg+xml');
    expect(await page.evaluate(() => window.referenceReview.reads())).toEqual(['included']);
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
  });
}

test('review: Design prototype follows committed source changes without native edits', async ({
  page,
}, info) => {
  await mount(page, 'kind=design');
  const before = await page.evaluate(() => window.referenceReview.source());
  await tool(page, 'Open prototype');
  const prototype = page.getByRole('dialog', { name: 'Design prototype', exact: true });
  await expect.poll(async () => (await images(prototype)).some((s) => s.includes('95'))).toBe(true);
  await page.evaluate(() => window.referenceReview.publish());
  await expect.poll(async () => (await images(prototype)).some((s) => s.includes('80'))).toBe(true);
  expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
  await page.screenshot({ path: info.outputPath('live-prototype.png') });
});

test('review: inactive Slide thumbnails and presentation retain live subscriptions', async ({
  page,
}, info) => {
  await mount(page, 'kind=slide&inactive=1');
  const thumb = page.getByRole('button', { name: 'Slide 2: Second', exact: true });
  if (!(await thumb.isVisible()))
    await page.getByRole('button', { name: 'Toggle Slide navigator', exact: true }).click();
  await expect.poll(async () => (await images(thumb)).some((s) => s.includes('95'))).toBe(true);
  await thumb.click();
  await page.getByRole('button', { name: 'Slide 1: First', exact: true }).click();
  await page.evaluate(() => window.referenceReview.publish());
  await expect.poll(async () => (await images(thumb)).some((s) => s.includes('80'))).toBe(true);
  await tool(page, 'Present');
  await page.getByLabel('Slide presentation', { exact: true }).press('ArrowRight');
  const presentation = page.getByLabel('Presentation page 2', { exact: true });
  await expect
    .poll(async () => (await images(presentation)).some((s) => s.includes('80')))
    .toBe(true);
  await page.screenshot({ path: info.outputPath('inactive-slide-presentation.png') });
});

test('review: Document resolver replacement unsubscribes and removes revoked images without rebuilding text', async ({
  page,
}) => {
  await mount(page, 'kind=document');
  const before = await page.evaluate(() => window.referenceReview.source());
  await page.locator('.ProseMirror').evaluate((el) => {
    el.setAttribute('data-original-view', 'yes');
  });
  await page.evaluate(() => window.referenceReview.replace());
  await expect(page.locator('.ProseMirror').getByText(/参照権限がありません/)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.referenceReview.subscriptions()))
    .toEqual([0, 1]);
  await expect(page.locator('.ProseMirror img[src]')).toHaveCount(0);
  await expect(page.locator('.ProseMirror')).toHaveAttribute('data-original-view', 'yes');
  expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
});

for (const action of ['Export HTML', 'Print preview']) {
  test(`review: Document ${action} rejects newly pending caption input during capture`, async ({
    page,
  }) => {
    await mount(page, 'kind=document');
    await page.locator('.ProseMirror img').click();
    await showInspector(page);
    await expect(page.getByLabel('Caption', { exact: true })).toBeVisible();
    await page.evaluate(() => window.referenceReview.block());
    const downloads: string[] = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await tool(page, 'Export document');
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.referenceReview.reads()))
      .toEqual(['included']);
    if (action === 'Print preview') {
      // Deliver an already queued IME event while the new dialog owns focus.
      await page.getByLabel('Caption', { exact: true }).evaluate((element) => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          element,
          'Pending caption',
        );
        element.dispatchEvent(
          new InputEvent('input', { bubbles: true, data: 'Pending caption', isComposing: true }),
        );
      });
      await expect
        .poll(() => page.evaluate(() => window.referenceReview.pending().composing))
        .toBe(1);
    } else await page.getByLabel('Caption', { exact: true }).fill('Pending caption');
    await expect.poll(() => page.evaluate(() => window.referenceReview.pending().dirty)).toBe(1);
    await page.evaluate(() => window.referenceReview.release());
    await expect(page.getByText(/取得中に入力が変わりました/)).toBeVisible();
    expect(downloads).toEqual([]);
    const native = (await page.evaluate(() => window.referenceReview.source())) as {
      blocks: { id: string; caption?: string }[];
    };
    expect(native.blocks.find((b) => b.id === 'inside')?.caption).toBe('Original caption');
    await expect(page.getByLabel('Caption', { exact: true })).toHaveValue('Pending caption');
  });
}

for (const kind of ['design', 'whiteboard', 'slide']) {
  test(`review: ${kind} retains cover when unlinking a reference`, async ({ page }) => {
    await mount(page, `kind=${kind}`);
    await showInspector(page);
    await page.getByLabel('参照の表示方法', { exact: true }).selectOption('cover');
    await page.getByRole('button', { name: '参照を解除して画像にする', exact: true }).click();
    const content = (await page.evaluate(() => window.referenceReview.source())) as {
      elements?: { id: string; imageFit: string; reference?: unknown }[];
      nodes?: { id: string; imageFit: string; reference?: unknown }[];
      slides?: { objects: { id: string; imageFit: string; reference?: unknown }[] }[];
    };
    const item = (
      content.elements ??
      content.nodes ??
      content.slides!.flatMap((s) => s.objects)
    ).find((i) => i.id === 'inside')!;
    expect(item.reference).toBeUndefined();
    expect(item.imageFit).toBe('fill');
  });
}

test('review: duplicate object IDs across slides keep page geometry and export sources separate', async ({
  page,
}, info) => {
  await mount(page, 'kind=slide&duplicate=1');
  const canvas = page.getByLabel('Slide canvas', { exact: true });
  await expect.poll(async () => (await images(canvas)).some((s) => s.includes('>95<'))).toBe(true);
  expect((await images(canvas)).some((s) => s.includes('>700<'))).toBe(false);
  const before = await page.evaluate(() => window.referenceReview.source());
  await tool(page, 'Export visual');
  await page.getByLabel('Export scope').selectOption('all');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export SVG', exact: true }).click();
  const files = unzipSync(await readFile((await (await download).path())!));
  const graphics = Object.entries(files)
    .filter(([name]) => name.endsWith('.svg'))
    .map(([, bytes]) => strFromU8(bytes));
  const decode = (svg: string) =>
    [...svg.matchAll(/data:image\/svg\+xml;base64,([^"\s]+)/g)]
      .map((m) => Buffer.from(m[1], 'base64').toString('utf8'))
      .join('');
  expect(graphics).toHaveLength(2);
  expect(decode(graphics[0])).toContain('>95<');
  expect(decode(graphics[0])).not.toContain('>700<');
  expect(decode(graphics[1])).toContain('>700<');
  expect(graphics[1]).toContain('width="300"');
  expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('page-scoped-references.png') });
});

test('review: resolver replacement clears discovered labels and rejects old pending discovery', async ({
  page,
}) => {
  await mount(page, 'kind=slide');
  await tool(page, '参照を埋め込む');
  await page.getByRole('button', { name: '参照元を再取得', exact: true }).click();
  const choices = page.getByLabel('埋め込みの参照元', { exact: true });
  await expect(choices).toContainText('Scope 0 source');
  await page.evaluate(() => window.referenceReview.blockList());
  await page.getByRole('button', { name: '参照元を再取得', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.referenceReview.listPending())).toBe(1);
  await page.evaluate(() => window.referenceReview.replace());
  await expect(choices).not.toContainText('Scope 0 source');
  await expect(choices).toHaveValue('');
  await page.evaluate(() => window.referenceReview.releaseList());
  await page.getByRole('button', { name: '参照元を再取得', exact: true }).click();
  await expect(choices).toContainText('Scope 1 source');
  await expect(choices).not.toContainText('Scope 0 source');
});

for (const kind of ['slide', 'design', 'whiteboard']) {
  test(`review: ${kind} image replacement atomically detaches references with one Undo`, async ({
    page,
  }) => {
    await mount(page, `kind=${kind}`);
    await showInspector(page);
    const before = await page.evaluate(() => window.referenceReview.source());
    await page.getByLabel('Replace image file', { exact: true }).setInputFiles({
      name: 'replacement.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    const read = () =>
      page.evaluate(() => {
        const content = window.referenceReview.source() as {
          elements?: { id: string; src?: string; reference?: unknown }[];
          nodes?: { id: string; src?: string; reference?: unknown }[];
          slides?: { objects: { id: string; src?: string; reference?: unknown }[] }[];
        };
        return (content.elements ?? content.nodes ?? content.slides![0].objects).find(
          (i) => i.id === 'inside',
        )!;
      });
    await expect.poll(async () => (await read()).src?.startsWith('data:image/png')).toBe(true);
    expect((await read()).reference).toBeUndefined();
    await expect(page.locator('image[href^="data:image/png"]')).not.toHaveCount(0);
    await page.evaluate(() => window.referenceReview.publish());
    expect((await read()).src).toMatch(/^data:image\/png/);
    await page.evaluate(() => window.referenceReview.undo());
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
  });
}

for (const kind of ['document', 'slide', 'design', 'whiteboard']) {
  test(`review: ${kind} read-only viewers can open refresh and discover references without mutations`, async ({
    page,
  }) => {
    await mount(page, `kind=${kind}&readonly=1`);
    if (kind === 'document') await page.locator('.ProseMirror img').click();
    await showInspector(page);
    const before = await page.evaluate(() => window.referenceReview.source());
    const open = page.getByRole('button', { name: '元を編集', exact: true });
    await expect(open).toBeEnabled();
    await open.click();
    expect(await page.evaluate(() => window.referenceReview.opened())).toEqual(['included']);
    const refresh = page.getByRole('button', { name: '参照を再取得', exact: true });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.getByLabel('参照の更新方式', { exact: true })).toBeDisabled();
    if (kind === 'document')
      await expect(page.getByLabel('参照の表示方法', { exact: true })).toHaveCount(0);
    else await expect(page.getByLabel('参照の表示方法', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '現在の版を固定', exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '参照を解除して画像にする', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: '参照先を変更', exact: true }).click();
    await page.getByRole('button', { name: '参照元を再取得', exact: true }).click();
    await expect(page.getByLabel('埋め込みの参照元', { exact: true })).toContainText(
      'Scope 0 source',
    );
    await expect(page.getByRole('button', { name: '参照を配置', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
  });
}

for (const kind of ['slide', 'design', 'whiteboard']) {
  test(`review: ${kind} generic image fit controls canvas export and Undo for a reference`, async ({
    page,
  }, info) => {
    await mount(page, `kind=${kind}`);
    await showInspector(page);
    const before = await page.evaluate(() => window.referenceReview.source());
    const canvas = page.getByRole('application', {
      name: `${kind === 'whiteboard' ? 'Whiteboard' : kind === 'slide' ? 'Slide' : 'Design'} canvas`,
      exact: true,
    });
    const image = canvas.locator('image').first();
    const contained = await image.screenshot();
    await page.getByLabel('Image fit', { exact: true }).selectOption('fill');
    expect(await image.screenshot()).not.toEqual(contained);
    await expect(canvas.locator('image[preserveAspectRatio="xMidYMid slice"]')).not.toHaveCount(0);
    await tool(page, kind === 'slide' ? 'Export visual' : `Export ${kind}`);
    const downloaded = page.waitForEvent('download');
    await page
      .getByRole('button', {
        name: kind === 'slide' ? 'Export SVG' : 'Export selection SVG',
        exact: true,
      })
      .click();
    const files = unzipSync(await readFile((await (await downloaded).path())!));
    const manifest = JSON.parse(strFromU8(files['references.json']));
    expect(
      manifest.sources.find(
        (s: { source: { artifactId: string } }) => s.source.artifactId === 'included',
      ).fit,
    ).toBe('cover');
    expect(
      Object.entries(files)
        .filter(([name]) => name.endsWith('.svg'))
        .some(([, bytes]) => strFromU8(bytes).includes('preserveAspectRatio="xMidYMid slice"')),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await showInspector(page);
    await page.getByLabel('Image fit', { exact: true }).selectOption('fit');
    await expect(canvas.locator('image[preserveAspectRatio="xMidYMid slice"]')).toHaveCount(0);
    await page.evaluate(() => window.referenceReview.undo());
    await expect(canvas.locator('image[preserveAspectRatio="xMidYMid slice"]')).not.toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${kind}-generic-reference-fit.png`) });
    await page.evaluate(() => window.referenceReview.undo());
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
  });
}

for (const [kind, action] of [
  ['slide', 'Export SVG'],
  ['design', 'Export selection SVG'],
  ['whiteboard', 'Export selection SVG'],
  ['document', 'Export HTML'],
  ['document', 'Print preview'],
]) {
  test(`review: ${kind} ${action} rejects a capture from a replaced resolver`, async ({ page }) => {
    await mount(page, `kind=${kind}`);
    const before = await page.evaluate(() => window.referenceReview.source());
    const downloads: string[] = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await page.evaluate(() => window.referenceReview.block());
    await tool(
      page,
      kind === 'slide'
        ? 'Export visual'
        : kind === 'document'
          ? 'Export document'
          : `Export ${kind}`,
    );
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.referenceReview.reads()))
      .toEqual(['included']);
    await page.evaluate(() => window.referenceReview.replace());
    await expect
      .poll(() => page.evaluate(() => window.referenceReview.subscriptions()))
      .toEqual([0, 1]);
    await page.evaluate(() => window.referenceReview.release());
    await expect(page.getByText(/取得中に参照接続が変わりました/)).toBeVisible();
    expect(downloads).toEqual([]);
    expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
    if (action === 'Print preview')
      await expect(page.getByRole('dialog', { name: /Print preview/ })).toHaveCount(0);
  });
}

for (const kind of ['slide', 'design', 'whiteboard', 'document']) {
  for (const limit of ['count', 'bytes']) {
    test(`review boundaries: ${kind} rejects reference insertion over ${limit} budget before committing`, async ({
      page,
    }, info) => {
      await mount(page, `kind=${kind}&limit=${limit}`);
      const before = await page.evaluate(() => JSON.stringify(window.referenceReview.source()));
      await tool(page, '参照を埋め込む');
      await page.getByRole('button', { name: '参照元を再取得', exact: true }).click();
      await expect(page.getByLabel('埋め込みの参照元', { exact: true })).toContainText(
        'Scope 0 source',
      );
      await page.getByRole('button', { name: '参照を配置', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('上限');
      expect(await page.evaluate(() => JSON.stringify(window.referenceReview.source()))).toBe(
        before,
      );
      expect(await page.evaluate(() => window.referenceReview.canUndo())).toBe(false);
      if (kind === 'document')
        await expect(page.locator('.ProseMirror img')).toHaveCount(limit === 'count' ? 64 : 3);
      if (limit === 'count') {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.screenshot({ path: info.outputPath(`${kind}-limit-refused.png`) });
      }
    });
  }
}
for (const kind of ['slide', 'design', 'whiteboard']) {
  test(`review boundaries: ${kind} refuses duplication without changing content or Undo`, async ({
    page,
  }) => {
    await mount(page, `kind=${kind}&limit=count`);
    const before = await page.evaluate(() => JSON.stringify(window.referenceReview.source()));
    await tool(page, 'Edit selection');
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('上限');
    expect(await page.evaluate(() => JSON.stringify(window.referenceReview.source()))).toBe(before);
    expect(await page.evaluate(() => window.referenceReview.canUndo())).toBe(false);
  });
}
test('review boundaries: Document captures visible HTML PDF and print references only', async ({
  page,
}, info) => {
  await mount(page, 'kind=document&hidden-document=1');
  const before = await page.evaluate(() => window.referenceReview.source());
  await page.evaluate(() => window.referenceReview.excludeOutside());
  await tool(page, 'Export document');
  for (const format of ['HTML', 'PDF']) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: `Export ${format}`, exact: true }).click();
    const file = await readFile((await (await download).path())!);
    if (format === 'HTML') {
      expect(file.toString()).toContain('artifact-references');
      expect(file.toString()).toContain('included');
      expect(file.toString()).not.toContain('outside');
    } else {
      const { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } =
        await import('pdf-lib');
      const doc = await PDFDocument.load(file);
      const names = doc.catalog
        .lookup(PDFName.of('Names'), PDFDict)
        .lookup(PDFName.of('EmbeddedFiles'), PDFDict)
        .lookup(PDFName.of('Names'), PDFArray);
      const attachment = names
        .lookup(1, PDFDict)
        .lookup(PDFName.of('EF'), PDFDict)
        .lookup(PDFName.of('F'));
      if (!(attachment instanceof PDFRawStream))
        throw new Error('Expected embedded reference manifest');
      const manifest = JSON.parse(Buffer.from(decodePDFRawStream(attachment).decode()).toString());
      expect(
        manifest.sources.map((s: { source: { artifactId: string } }) => s.source.artifactId),
      ).toEqual(['included']);
    }
  }
  await page.getByRole('button', { name: 'Print preview', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Document print preview', exact: true });
  await expect(dialog.getByRole('img', { name: 'Print page 1', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('visible-document-print.png') });
  expect(await page.evaluate(() => window.referenceReview.reads())).toEqual([
    'included',
    'included',
    'included',
  ]);
  expect(await page.evaluate(() => window.referenceReview.source())).toEqual(before);
  await page.keyboard.press('Escape');
  await tool(page, 'Export document');
  await page.getByRole('button', { name: 'Export MD', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('outside unavailable');
});
test('review boundaries: hidden-only Document references do not require a resolver for visible output', async ({
  page,
}) => {
  await mount(page, 'kind=document&hidden-document=1&hidden-only=1&disconnected=1');
  await tool(page, 'Export document');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export HTML', exact: true }).click();
  expect(await readFile((await (await download).path())!, 'utf8')).not.toContain(
    'artifact-references',
  );
  await page.getByRole('button', { name: 'Print preview', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Print page 1', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
