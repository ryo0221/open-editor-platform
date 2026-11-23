import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const bundled = build({
  entryPoints: [fileURLToPath(new URL('../fixtures/references/live-host.tsx', import.meta.url))],
  bundle: true,
  write: false,
  outdir: '/tmp/live-quote-host',
  format: 'esm',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
});
async function mount(
  page: Page,
  kind: 'document' | 'slide' | 'shared-slide' | 'shared-slide-motion',
) {
  await page.route('**/live-quote-fixture.html*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}#root{height:100dvh}</style><div id="root"></div>',
    }),
  );
  await page.goto(`/live-quote-fixture.html?kind=${kind}`);
  for (const file of (await bundled).outputFiles!) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
    else await page.addScriptTag({ content: file.text, type: 'module' });
  }
  if (kind !== 'shared-slide-motion')
    await expect(
      page.getByRole('button', { name: '引用を挿入', exact: true }).filter({ visible: true }),
    ).toBeVisible();
}
const snapshot = (page: Page) => page.evaluate(() => window.liveQuoteFixture.snapshot());
const remove = (page: Page) => page.getByRole('button', { name: '引用を外す' });
const review = (page: Page) => page.getByRole('button', { name: '古い引用を確認' });
const compare = (page: Page) => page.getByRole('button', { name: '比較', exact: true });
const update = (page: Page) => page.getByRole('button', { name: '更新する' });

async function picker(page: Page, kind: 'value' | 'figure', version = 'v1') {
  await page.getByRole('button', { name: '引用を挿入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '引用の挿入' });
  await dialog.getByLabel('引用の種類').selectOption(kind);
  await dialog.getByLabel('元の成果物').selectOption('budget');
  await dialog.getByLabel('保存済み版').selectOption(version);
  if (kind === 'value') {
    await dialog.getByLabel('シナリオ').selectOption('base');
    await dialog.getByLabel('指標').selectOption('npv');
    await dialog.getByLabel('書式').selectOption('percent');
    await dialog.getByLabel('桁数').selectOption('1');
    await dialog.getByLabel('単位').fill(' / 年');
  } else await dialog.getByRole('combobox', { name: '図', exact: true }).selectOption('map');
  await dialog.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await expect(dialog.getByLabel('引用のプレビュー')).toBeVisible();
  return dialog;
}
async function fit(page: Page, selector: string) {
  expect(
    await page.locator(selector).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        bounds.left >= 0 &&
        bounds.right <= innerWidth + 1 &&
        element.scrollWidth <= element.clientWidth + 1
      );
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('slide draws a fixed figure in thumbnails and the presentation', async ({ page }) => {
  await mount(page, 'slide');
  const dialog = await picker(page, 'figure');
  await dialog.getByRole('button', { name: '挿入する' }).click();
  await expect(dialog).toBeHidden();
  const figure = (scope: ReturnType<Page['locator']>) =>
    scope.locator('.ep-slide-live-quote-copy image');
  await expect(figure(page.locator('.slide-thumb')).first()).toHaveAttribute(
    'href',
    /^data:image\//,
  );
  await page.getByRole('button', { name: 'Present' }).click();
  const presentation = page.getByRole('dialog', { name: 'Slide presentation' });
  await expect(figure(presentation)).toHaveAttribute('href', /^data:image\//);
});

for (const viewport of ['desktop', 'narrow'] as const)
  test(`shared Slide surfaces adopt and detach fixed citations at the same revision (${viewport})`, async ({
    page,
  }, info) => {
    if (viewport === 'narrow') await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, 'shared-slide');
    const dialog = await picker(page, 'value');
    await dialog.getByRole('button', { name: '挿入する' }).click();
    const revision = page.getByLabel('Shared revision');
    const quote = () => page.locator('.ep-slide-live-quote:visible');
    await expect(revision).toHaveText('1');
    await expect(quote()).toContainText('25.0%');
    await page.getByRole('button', { name: 'Editor B', exact: true }).click();
    await expect(quote()).toContainText('25.0%');
    await page.getByRole('button', { name: '古い引用を確認' }).click();
    await compare(page).click();
    await expect(revision).toHaveText('1');
    await update(page).click();
    await expect(revision).toHaveText('2');
    await expect(quote()).toContainText('50.0%');
    await page.getByRole('button', { name: 'Editor A', exact: true }).click();
    await expect(quote()).toContainText('50.0%');
    await page.getByRole('button', { name: 'Editor B', exact: true }).click();
    await quote().click();
    await page.getByRole('button', { name: '値を残して引用を解除' }).click();
    await expect(revision).toHaveText('3');
    await expect(quote()).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo B', exact: true }).click();
    await expect(revision).toHaveText('4');
    await expect(quote()).toContainText('50.0%');
    await page.screenshot({ path: info.outputPath('shared-slide-reference.png') });
  });

test('shared Slide refuses to start with an animated deck and explains why', async ({
  page,
}, info) => {
  await mount(page, 'shared-slide-motion');
  const rejection = page.getByRole('alert');
  await expect(rejection).toBeVisible();
  await expect(rejection).toHaveText(
    '段・効果、ページの切り替え、書き出し設定を含むスライドの共同編集は未対応です。ローカルで編集してください。',
  );
  await expect(page.getByLabel('Shared revision')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Editor A', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('shared-slide-motion-rejected.png') });
});

for (const kind of ['document', 'slide'] as const) {
  async function insertValue(page: Page, version = 'v1') {
    await mount(page, kind);
    if (kind === 'document') await page.locator('.ProseMirror p').click();
    const dialog = await picker(page, 'value', version);
    await dialog.getByRole('button', { name: '挿入する' }).click();
    await expect(dialog).toBeHidden();
    return page.locator(
      kind === 'document' ? '.ProseMirror [data-live-quote]' : '.ep-slide-live-quote',
    );
  }

  test(`${kind} shows the selected quote source, version, scenario and metric`, async ({
    page,
  }) => {
    const quote = await insertValue(page);
    await quote.click();
    await expect(page.locator('.ep-live-tools .ep-live-details')).toHaveText(
      'budget · v1 · base · npv',
    );
  });

  test(`${kind} shows the no-update status for the same version`, async ({ page }, info) => {
    await insertValue(page, 'v2');
    const original = await snapshot(page);
    await review(page).click();
    const region = page.getByRole('region', { name: '古い引用' });
    await expect(region.getByRole('heading')).toHaveText('古い引用 0件');
    await expect(compare(page)).toHaveCount(0);
    const status = region
      .getByRole('status')
      .filter({ hasNotText: '保存済み版を確認しています。' });
    await expect(status).toHaveText('更新なし');
    expect(await snapshot(page)).toEqual(original);
    await page.screenshot({ path: info.outputPath(`${kind}-no-update.png`) });
  });

  test(`${kind} refuses an update and requests recheck when the target disappears after comparison`, async ({
    page,
  }, info) => {
    await insertValue(page);
    const original = await snapshot(page);
    await review(page).click();
    await compare(page).click();
    await expect(update(page)).toBeEnabled();
    await page.evaluate(() => window.liveQuoteFixture.removeLatestValue());
    await update(page).click();
    const status = page.getByRole('status').filter({ hasText: 'もう一度確認してください。' });
    await expect(status).toBeVisible();
    await expect(status).toContainText('新しい版にこの値がありません。現在の引用はそのままです。');
    await expect(update(page)).toHaveCount(0);
    expect(await snapshot(page)).toEqual(original);
    await page.screenshot({ path: info.outputPath(`${kind}-recheck.png`) });
    await review(page).click();
    await compare(page).click();
    await expect(update(page)).toBeDisabled();
    expect(await snapshot(page)).toEqual(original);
  });

  test(`${kind} rejects Delete, Undo and clipboard paste in read-only mode`, async ({
    page,
    context,
  }) => {
    const quote = await insertValue(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('pasted text'));
    await quote.click();
    await page.evaluate(() => window.liveQuoteFixture.setReadOnly(true));
    await expect(remove(page)).toBeDisabled();
    await expect(
      page.getByText('読み取り専用では挿入・更新・削除は利用できません。'),
    ).toBeVisible();
    const original = await snapshot(page);
    for (const key of ['Delete', 'Control+z', 'Control+v']) {
      await page.keyboard.press(key);
      expect(await snapshot(page), key).toEqual(original);
    }
    await expect(quote).toContainText('25.0% / 年');
    await expect(page.getByText('pasted text', { exact: true })).toHaveCount(0);
  });

  for (const quoteKind of ['value', 'figure'] as const) {
    test(`${kind} undoes and redoes a fixed ${quoteKind} insertion`, async ({ page }) => {
      await mount(page, kind);
      if (kind === 'document') await page.locator('.ProseMirror p').click();
      const initial = await snapshot(page);
      const dialog = await picker(page, quoteKind);
      await dialog.getByRole('button', { name: '挿入する' }).click();
      await expect(dialog).toBeHidden();
      const inserted = await snapshot(page);
      expect(inserted.sequence).toBe(initial.sequence + 1);
      expect(inserted.content).not.toEqual(initial.content);
      await page.evaluate(() => window.liveQuoteFixture.undo());
      const undone = await snapshot(page);
      expect(undone.content).toEqual(initial.content);
      expect(undone.canUndo).toBe(initial.canUndo);
      expect(undone.canRedo).toBe(true);
      await page.evaluate(() => window.liveQuoteFixture.redo());
      expect((await snapshot(page)).content).toEqual(inserted.content);
    });
  }

  test(`${kind} inserts a value, defers without history, updates and removes it with native Undo`, async ({
    page,
  }, info) => {
    await mount(page, kind);
    if (kind === 'document') {
      await page.locator('.ProseMirror p').evaluate((paragraph) => {
        (paragraph.closest('.ProseMirror') as HTMLElement).focus();
        const selection = window.getSelection()!;
        selection.collapse(paragraph.firstChild!, 'Before '.length);
        document.dispatchEvent(new Event('selectionchange'));
      });
    }
    const initial = await snapshot(page);
    const dialog = await picker(page, 'value');
    await expect(dialog.getByLabel('引用のプレビュー')).toHaveText('引用 25.0% / 年');
    await dialog.getByRole('button', { name: '挿入する' }).click();
    await expect(dialog).toBeHidden();
    const quote = page.locator(
      kind === 'document' ? '.ProseMirror [data-live-quote]' : '.ep-slide-live-quote',
    );
    await expect(quote).toContainText('引用 25.0% / 年');
    if (kind === 'document') {
      await expect(page.locator('.ProseMirror p')).toHaveText(/Before 引用 25.0% \/ 年.*after/);
      expect(JSON.stringify((await snapshot(page)).content)).toContain('Before 25.0% / 年after');
    }
    await expect(page.getByText('新しい版があります', { exact: true })).toBeVisible();
    const inserted = await snapshot(page);
    expect(inserted.sequence).toBe(initial.sequence + 1);
    await review(page).click();
    await compare(page).click();
    await expect(page.locator('.ep-live-compare')).toContainText('50.0% / 年');
    await page.screenshot({ path: info.outputPath(`${kind}-value-comparison.png`) });
    await page.getByRole('button', { name: '見送る' }).last().click();
    expect(await snapshot(page)).toEqual(inserted);
    await expect(compare(page)).toHaveCount(0);
    await review(page).click();
    await compare(page).click();
    await update(page).click();
    await expect(quote).toContainText('引用 50.0% / 年');
    const updated = await snapshot(page);
    expect(updated.sequence).toBe(inserted.sequence + 1);
    await page.evaluate(() => window.liveQuoteFixture.undo());
    await expect(quote).toContainText('引用 25.0% / 年');
    expect((await snapshot(page)).content).toEqual(inserted.content);
    await page.evaluate(() => window.liveQuoteFixture.redo());
    await expect(quote).toContainText('引用 50.0% / 年');
    if (kind === 'document') await quote.click();
    await remove(page).click();
    await expect(quote).toHaveCount(0);
    await page.evaluate(() => window.liveQuoteFixture.undo());
    await expect(quote).toContainText('引用 50.0% / 年');
    expect((await snapshot(page)).content).toEqual(updated.content);
    await page.evaluate(() => window.liveQuoteFixture.redo());
    await expect(quote).toHaveCount(0);
  });

  test(`${kind} previews and compares both saved figures on a narrow screen`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, kind);
    const initial = await snapshot(page);
    let dialog = await picker(page, 'figure');
    await fit(page, '.ep-live-picker');
    await dialog.getByRole('button', { name: '取り消す' }).click();
    expect(await snapshot(page)).toEqual(initial);
    dialog = await picker(page, 'figure');
    await dialog.getByRole('button', { name: '挿入する' }).click();
    await expect(dialog).toBeHidden();
    const quote = page.locator(
      kind === 'document' ? '.ep-live-document-figure img' : '.ep-slide-live-quote image',
    );
    await expect(quote).toHaveCount(1);
    await review(page).click();
    await compare(page).click();
    const images = page.locator('.ep-live-compare img');
    await expect(images).toHaveCount(2);
    await expect
      .poll(() =>
        images.evaluateAll((els) =>
          els.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toBe(true);
    const before = await images.first().getAttribute('src');
    const after = await images.last().getAttribute('src');
    expect(before).not.toBe(after);
    await fit(page, '.ep-live-tools');
    await page.screenshot({ path: info.outputPath(`${kind}-figure-mobile.png`) });
    const inserted = await snapshot(page);
    await page.evaluate(() => window.liveQuoteFixture.setReadOnly(true));
    await expect(update(page)).toBeDisabled();
    await expect(remove(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: '引用を挿入', exact: true })).toBeDisabled();
    await page.evaluate(() => window.liveQuoteFixture.setReadOnly(false));
    await update(page).click();
    await expect(quote).toHaveAttribute(kind === 'document' ? 'src' : 'href', after!);
    await page.evaluate(() => window.liveQuoteFixture.undo());
    await expect(quote).toHaveAttribute(kind === 'document' ? 'src' : 'href', before!);
    expect((await snapshot(page)).content).toEqual(inserted.content);
  });
}

test('an unavailable new target and revoked source access leave the fixed value unchanged', async ({
  page,
}) => {
  await mount(page, 'document');
  await page.locator('.ProseMirror p').click();
  const dialog = await picker(page, 'value');
  await dialog.getByRole('button', { name: '挿入する' }).click();
  await expect(dialog).toBeHidden();
  const inserted = await snapshot(page);
  await page.evaluate(() => window.liveQuoteFixture.removeLatestValue());
  await review(page).click();
  await compare(page).click();
  await expect(
    page.getByText('新しい版にこの値がありません。現在の引用はそのままです。'),
  ).toBeVisible();
  await expect(update(page)).toBeDisabled();
  await page.evaluate(() => window.liveQuoteFixture.forbid());
  await review(page).click();
  await expect(page.getByText(/この引用元を閲覧する権限がありません/)).toBeVisible();
  expect(await snapshot(page)).toEqual(inserted);
});

test('Slide PDF and MP4 export bake the fixed figure and embed its source version', async ({
  page,
}, info) => {
  await mount(page, 'slide');
  const pickerDialog = await picker(page, 'figure');
  await pickerDialog.getByRole('button', { name: '挿入する' }).click();
  await expect(pickerDialog).toBeHidden();
  const inserted = await snapshot(page);
  await page.evaluate(() => window.liveQuoteFixture.setReadOnly(true));

  async function open(format: 'PDF' | 'MP4') {
    await page.getByRole('button', { name: 'Export visual', exact: true }).click();
    await page.getByRole('button', { name: `Export ${format}`, exact: true }).click();
    return page.getByRole('dialog', { name: 'Slide export' });
  }
  async function exportBytes(dialog: ReturnType<Page['getByRole']>, fileName: string) {
    const pending = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export file' }).click();
    const file = await pending;
    const path = info.outputPath(fileName);
    await file.saveAs(path);
    const { readFile } = await import('node:fs/promises');
    return readFile(path);
  }

  const { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } =
    await import('pdf-lib');
  const document = await PDFDocument.load(await exportBytes(await open('PDF'), 'fixed-figure.pdf'));
  const fileEntry = document.catalog
    .lookup(PDFName.of('Names'), PDFDict)
    .lookup(PDFName.of('EmbeddedFiles'), PDFDict)
    .lookup(PDFName.of('Names'), PDFArray)
    .lookup(1, PDFDict)
    .lookup(PDFName.of('EF'), PDFDict)
    .lookup(PDFName.of('F'));
  if (!(fileEntry instanceof PDFRawStream)) throw Error('Expected an embedded reference manifest.');
  expect(JSON.parse(Buffer.from(decodePDFRawStream(fileEntry).decode()).toString())).toMatchObject({
    sources: [{ source: { artifactId: 'budget', target: { figureId: 'map' } }, versionId: 'v1' }],
  });
  const images = document.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  const bitmap = images.lookup(images.keys()[0]);
  if (!(bitmap instanceof PDFRawStream)) throw Error('Expected an embedded page bitmap.');
  const pixels = Buffer.from(decodePDFRawStream(bitmap).decode());
  expect(pixels.indexOf(Buffer.from([0x26, 0x74, 0x53]))).toBeGreaterThanOrEqual(0);

  const video = await open('MP4');
  const hold = video.getByLabel('Default hold (seconds)');
  await hold.fill('-1');
  await expect(video.getByRole('button', { name: 'Export file' })).toBeDisabled();
  await hold.fill('0.2');
  await hold.press('Enter');
  await expect(video.getByRole('status').first()).toHaveText('0.2 s · 6 frames · 960 × 540 px');
  await expect(video.getByRole('button', { name: 'Save to deck' })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('slide-mp4-settings.png') });

  const supportsH264 = await page.evaluate(async () => {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return false;
    const candidates = await Promise.all(
      ['avc1.64001f', 'avc1.4d001f', 'avc1.42e01f'].map((codec) =>
        VideoEncoder.isConfigSupported({
          codec,
          width: 960,
          height: 540,
          bitrate: 1555200,
          framerate: 30,
          avc: { format: 'avc' },
          latencyMode: 'quality',
        }),
      ),
    );
    return candidates.some((candidate) => candidate.supported);
  });
  if (supportsH264) {
    const mp4 = await exportBytes(video, 'fixed-figure.mp4');
    expect(mp4.subarray(4, 8).toString()).toBe('ftyp');
    expect(mp4.toString()).toContain('"versionId":"v1"');
    expect(mp4.toString()).toContain('"artifactId":"budget"');
  } else {
    await video.getByRole('button', { name: 'Export file' }).click();
    await expect(video.getByRole('alert')).toContainText('H.264');
    await video.getByRole('button', { name: 'Close', exact: true }).click();
  }

  const downloads: string[] = [];
  page.on('download', (file) => downloads.push(file.suggestedFilename()));
  await page.evaluate(() => {
    if (typeof VideoEncoder !== 'undefined') {
      VideoEncoder.isConfigSupported = async (config) => ({ config, supported: false });
    }
  });
  const unsupported = await open('MP4');
  await unsupported.getByRole('button', { name: 'Export file' }).click();
  await expect(unsupported.getByRole('alert')).toContainText('H.264');
  await unsupported.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => window.liveQuoteFixture.forbid());
  for (const format of ['PDF', 'MP4'] as const) {
    const dialog = await open(format);
    await dialog.getByRole('button', { name: 'Export file' }).click();
    await expect(dialog.getByRole('alert')).toContainText('budget / v1');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }
  expect(downloads).toEqual([]);
  expect(await snapshot(page)).toEqual(inserted);
});
