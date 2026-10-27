import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { test, expect, setDocumentText } from './fixtures';
import type { Artifact } from '@editor-platform/artifact-core';
import type { DesignContent } from '@editor-platform/design/model';
import type { DocumentContent } from '@editor-platform/document/model';

test.skip(
  ({ baseURL }) => !/:(?:4177|5177)$/.test(baseURL ?? ''),
  'Independent authoring fixture: E2E_SUITE=host',
);
test.beforeEach(async ({ page }) => {
  await page.goto('/authoring.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Document / Design authoring' })).toBeVisible();
});

test('three chapters: native edit, navigation, semantic review, immutable save, reload and derived DOCX', async ({
  page,
}, info) => {
  const before = await page.evaluate(() =>
    [1, 2, 3].map((n) => JSON.parse(localStorage.getItem(`authoring:chapter-${n}`)!)),
  );
  for (const n of [1, 2, 3]) {
    await page.getByRole('button', { name: `Chapter ${n}`, exact: true }).click();
    await setDocumentText(page, '[data-block-id="scene-morning"]', `改稿した朝、第${n}章。`);
    await page.getByRole('button', { name: 'Go to scene-night' }).click();
    await expect(page.getByLabel('Selection', { exact: true })).toContainText('scene-night');
    await page.getByRole('button', { name: 'Preview proposal' }).click();
    const review = page.getByRole('article', { name: 'Semantic proposal' });
    await expect(review).toContainText('scene-night');
    await expect(review).toContainText('夕暮れ');
    await expect(page.getByLabel('Current text')).toContainText('夜の場面');
    await review.getByRole('button', { name: 'Reject' }).click();
    await page.getByRole('button', { name: 'Preview proposal' }).click();
    await review.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(page.getByLabel('Current text')).toContainText('夕暮れの場面');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByLabel('Current text')).toContainText('夜の場面');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.getByLabel('Save state')).toHaveText('Saved');
    await expect(page.getByLabel('Version count')).toHaveText('2');
  }
  await page.getByRole('button', { name: 'Reverse chapter order' }).click();
  await page.reload();
  const after = (await page.evaluate(() =>
    [1, 2, 3].map((n) => JSON.parse(localStorage.getItem(`authoring:chapter-${n}`)!)),
  )) as Artifact<DocumentContent>[];
  after.forEach((a, i) => expect(a.versions[0]).toEqual(before[i].versions[0]));
  await page.getByRole('button', { name: 'Compose saved chapters' }).click();
  const manifest = JSON.parse((await page.getByLabel('Chapter manifest').textContent())!);
  expect(manifest.sources.map((s: { artifactId: string }) => s.artifactId)).toEqual([
    'chapter-3',
    'chapter-2',
    'chapter-1',
  ]);
  expect(manifest.sources.map((s: { versionId: string }) => s.versionId)).toEqual(
    [...after].reverse().map((a) => a.versions[1].versionId),
  );
  await page.getByRole('button', { name: 'Export chapter DOCX' }).click();
  const dialog = page.getByRole('dialog', { name: 'DOCX export', exact: true });
  await dialog.getByRole('button', { name: 'Prepare DOCX preview', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Refresh DOCX preview', exact: true }),
  ).toBeEnabled({ timeout: 60_000 });
  const accept = dialog.getByRole('checkbox');
  if (await accept.count()) await accept.check();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download DOCX', exact: true }).click();
  const file = await download;
  const bytes = await readFile((await file.path())!);
  const xml = strFromU8(unzipSync(bytes)['word/document.xml']);
  expect(xml.indexOf('第3章')).toBeLessThan(xml.indexOf('第2章'));
  expect(xml.indexOf('第2章')).toBeLessThan(xml.indexOf('第1章'));
  expect(xml).toContain('改稿した朝');
  expect(xml).toContain('夕暮れ');
  await dialog.getByRole('button', { name: 'Close DOCX export', exact: true }).click();
  await page.screenshot({ path: info.outputPath('chapter-authoring.png'), fullPage: true });
});

test('four pages: native page/panel order, proposal, save/reload, read-through PNG/PDF and source manifest', async ({
  page,
}, info) => {
  await page.getByRole('button', { name: 'Comic pages', exact: true }).click();
  const initial = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('authoring:comic')!),
  )) as Artifact<DesignContent>;
  const panel = page.getByRole('region', { name: 'Page reading order' });
  if (!(await panel.isVisible()))
    await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
  await panel.getByRole('button', { name: 'Move page 4 earlier', exact: true }).click();
  await panel.getByRole('button', { name: 'Move panel 1.2 earlier', exact: true }).click();
  await panel.getByLabel('Reading direction').selectOption('ltr');
  await panel.getByRole('button', { name: 'Panel 1.1', exact: true }).click();
  if (await page.getByRole('button', { name: 'Close Design navigator', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  if (!(await page.getByLabel('Element x', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await page.getByLabel('Element x', { exact: true }).fill('30');
  await page.getByLabel('Element x', { exact: true }).press('Enter');
  await page.getByLabel('Element width', { exact: true }).fill('500');
  await page.getByLabel('Element width', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Close Design inspector', exact: true }).click();
  await page.getByLabel('Replacement', { exact: true }).fill('Revised dialogue');
  await page.getByRole('button', { name: 'Preview proposal' }).click();
  await expect(page.getByLabel('Current text')).toContainText('Page 1, panel 1');
  await page
    .getByRole('article', { name: 'Semantic proposal' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Save state')).toHaveText('Saved');
  await page.reload();
  await page.getByRole('button', { name: 'Comic pages', exact: true }).click();
  const saved = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('authoring:comic')!),
  )) as Artifact<DesignContent>;
  expect(saved.versions[0]).toEqual(initial.versions[0]);
  expect(saved.draft.content.elements.find((e) => e.id === 'panel-1-2')!.bounds).toMatchObject({
    x: 30,
    width: 500,
  });
  expect(saved.draft.content.pagination!.pages.map((p) => p.frameId)).toEqual([
    'page-1',
    'page-2',
    'page-4',
    'page-3',
  ]);
  expect(saved.draft.content.pagination!.pages[0].panelIds).toEqual(['panel-1-2', 'panel-1-1']);
  await page.getByRole('button', { name: 'Read saved pages', exact: true }).click();
  await expect(page.locator('.authoring-pages img')).toHaveCount(4);
  const manifest = JSON.parse((await page.getByLabel('Page manifest').textContent())!);
  expect(manifest.source.versionId).toBe(saved.versions[1].versionId);
  expect(manifest.direction).toBe('ltr');
  const pngPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const png = await pngPending;
  const files = unzipSync(await readFile((await png.path())!));
  expect(Object.keys(files).filter((p) => p.endsWith('.png'))).toHaveLength(4);
  expect(JSON.parse(strFromU8(files['references.json']))).toEqual(manifest);
  for (const [name, bytes] of Object.entries(files))
    if (name.endsWith('.png'))
      expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const pdfPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const pdf = await pdfPending;
  expect((await PDFDocument.load(await readFile((await pdf.path())!))).getPageCount()).toBe(4);
  await page.screenshot({ path: info.outputPath('comic-readthrough.png'), fullPage: true });
});

test('stale, revoked permissions, composition and save failure preserve draft/version', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Preview proposal' }).click();
  await setDocumentText(page, '[data-block-id="scene-morning"]', 'New draft after preview.');
  await page
    .getByRole('article', { name: 'Semantic proposal' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('changed after the preview');
  await page.getByRole('button', { name: 'Preview proposal' }).click();
  await page.getByLabel('Read only', { exact: true }).check();
  await page
    .getByRole('article', { name: 'Semantic proposal' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('read-only');
  await page.getByLabel('Read only', { exact: true }).uncheck();
  await page.getByLabel('Hold composition').check();
  await page
    .getByRole('article', { name: 'Semantic proposal' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('composition');
  await page.getByRole('button', { name: 'Chapter 2', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('composition');
  await page.getByLabel('Hold composition').uncheck();
  await page
    .getByRole('article', { name: 'Semantic proposal' })
    .getByRole('button', { name: 'Reject' })
    .click();
  await page.getByLabel('Fail next save').check();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('save failed');
  await expect(page.getByLabel('Version count')).toHaveText('1');
  await expect(page.getByLabel('Current text')).toContainText('New draft after preview.');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Save state')).toHaveText('Saved');
});

test('native Duplicate retains page/panel/image metadata and element clipboard refuses without changes', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Comic pages', exact: true }).click();
  const order = page.getByRole('region', { name: 'Page reading order' });
  if (!(await order.isVisible()))
    await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
  await order.getByRole('button', { name: 'Page 1', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  async function edit(action: string) {
    const menu = page.getByRole('button', { name: 'Edit selection', exact: true });
    if (!(await menu.isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await menu.click();
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  for (const action of ['Copy', 'Cut', 'Paste']) {
    await edit(action);
    await expect(page.getByRole('alert')).toContainText('copy/cut/paste is not supported');
    await expect(page.getByLabel('Save state')).toHaveText('Saved');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  }
  const initial = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('authoring:comic')!),
  )) as Artifact<DesignContent>;
  await edit('Duplicate');
  await expect(page.getByLabel('Save state')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Save state')).toHaveText('Saved');
  const saved = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('authoring:comic')!),
  )) as Artifact<DesignContent>;
  expect(saved.versions[0]).toEqual(initial.versions[0]);
  expect(saved.draft.content.pagination!.pages).toHaveLength(5);
  const duplicate = saved.draft.content.pagination!.pages[1];
  expect(duplicate.frameId).not.toBe('page-1');
  expect(duplicate.panelIds).toHaveLength(2);
  expect(
    duplicate.panelIds.every((id) => !initial.draft.content.elements.some((e) => e.id === id)),
  ).toBe(true);
  expect(saved.draft.content.pagination!.images).toHaveLength(2);
  expect(saved.draft.content.pagination!.images[1]).toMatchObject({
    source: initial.draft.content.pagination!.images[0].source,
    license: 'CC0-1.0',
  });
  await page.getByRole('button', { name: 'Read saved pages', exact: true }).click();
  await expect(page.locator('.authoring-pages img')).toHaveCount(5);
  expect(JSON.parse((await page.getByLabel('Page manifest').textContent())!).pages).toEqual(
    saved.draft.content.pagination!.pages,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Save state')).toHaveText('Saved');
  const redone = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('authoring:comic')!),
  )) as Artifact<DesignContent>;
  expect(redone.draft.content).toEqual(saved.draft.content);
});

test('native image replacement invalidates attribution until the source is registered again', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Comic pages', exact: true }).click();
  const initial = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('authoring:comic')!),
  )) as Artifact<DesignContent>;
  const order = page.getByRole('region', { name: 'Page reading order' });
  if (!(await order.isVisible()))
    await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
  await page.getByLabel('Search layers', { exact: true }).fill('image');
  await page.getByRole('button', { name: /^Layer Image/ }).click();
  await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  const input = page.getByLabel('Replace image file', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 2, 2);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await input.setInputFiles({
    name: 'replacement.png',
    mimeType: 'image/png',
    buffer: Buffer.from(encoded, 'base64'),
  });
  await expect(page.getByLabel('Save state')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Close Design inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Save state')).toHaveText('Saved');
  const saved = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('authoring:comic')!),
  )) as Artifact<DesignContent>;
  expect(saved.draft.content.pagination!.images).toEqual([]);
  expect(saved.versions[0]).toEqual(initial.versions[0]);
  expect(saved.draft.content.elements.find((e) => e.id === 'material')!.src).not.toBe(
    initial.draft.content.elements.find((e) => e.id === 'material')!.src,
  );
  await page.getByRole('button', { name: 'Read saved pages', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('source/license');
  await expect(page.locator('.authoring-pages img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Save state')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Read saved pages', exact: true }).click();
  await expect(page.locator('.authoring-pages img')).toHaveCount(4);
  const restored = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('authoring:comic')!),
  )) as Artifact<DesignContent>;
  expect(restored.draft.content).toEqual(initial.draft.content);
});

test('M1 vector linework and native balloon survive point edits, versions and explicit page capture', async ({
  page,
}, info) => {
  await page.getByRole('button', { name: 'Comic pages', exact: true }).click();
  const order = page.getByRole('region', { name: 'Page reading order' });
  const openOrder = async () => {
    if (!(await order.isVisible()))
      await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
  };
  await openOrder();
  await order.getByRole('button', { name: 'Add cubic to panel 1.1', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  const edit = page.getByRole('button', { name: 'Edit path points', exact: true });
  if (!(await edit.isVisible()))
    await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
  await edit.click();
  await page.getByLabel('Path point X', { exact: true }).fill('10');
  await page.getByLabel('Path point X', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Finish point editing', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design inspector', exact: true }).click();
  await openOrder();
  await order.getByRole('button', { name: 'Add balloon to panel 1.1', exact: true }).click();
  for (let p = 2; p <= 4; p++)
    await order.getByRole('button', { name: `Add line to panel ${p}.1`, exact: true }).click();
  await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Save state')).toHaveText('Saved');
  const stored = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem('authoring:comic')!),
  )) as Artifact<DesignContent>;
  expect(stored.draft.content.schemaVersion).toBe(3);
  expect(stored.versions[0].content.schemaVersion).toBe(2);
  const paths = stored.draft.content.elements.filter((e) => e.path);
  expect(paths).toHaveLength(5);
  expect(paths[0].path!.subpaths[0].anchors[0].x).toBe(10);
  expect(
    stored.draft.content.elements.some((e) => e.name === 'Speech balloon' && e.type === 'group'),
  ).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Comic pages', exact: true }).click();
  await page.getByRole('button', { name: 'Read saved pages', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('opt-in');
  await expect(page.locator('.authoring-pages img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Read saved vector pages', exact: true }).click();
  await expect(page.locator('.authoring-pages img')).toHaveCount(4);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const manifest = JSON.parse((await page.getByLabel('Page manifest').textContent())!);
  expect(manifest.capability).toBe('vector');
  expect(manifest.artwork).toHaveLength(5);
  expect(manifest.source.versionId).toBe(stored.versions[1].versionId);
  const png = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const files = unzipSync(await readFile((await (await png).path())!));
  expect(JSON.parse(strFromU8(files['references.json']))).toEqual(manifest);
  await page.screenshot({ path: info.outputPath('m1-vector-pages.png'), fullPage: true });
});

test('N2 horizontal EPUB reviews exact saved chapters and refuses stale or invalid metadata', async ({
  page,
}, info) => {
  const original = await page.evaluate(() =>
    [1, 2, 3].map((n) => JSON.parse(localStorage.getItem(`authoring:chapter-${n}`)!)),
  );
  await page.getByRole('button', { name: 'Reverse chapter order', exact: true }).click();
  await page.getByRole('button', { name: 'Compose saved chapters', exact: true }).click();
  const review = page.getByRole('region', { name: 'EPUB export review' });
  await review.getByLabel('EPUB title', { exact: true }).fill('三章 EPUB');
  await review.getByLabel('EPUB language', { exact: true }).fill('invalid language');
  await review.getByRole('button', { name: 'Prepare EPUB preview', exact: true }).click();
  await expect(review.getByLabel('EPUB report')).toContainText('INVALID_METADATA');
  await expect(review.getByRole('button', { name: 'Download EPUB', exact: true })).toBeDisabled();
  await review.getByLabel('EPUB language', { exact: true }).fill('ja');
  await page.getByLabel('Hold composition', { exact: true }).check();
  await review.getByRole('button', { name: 'Prepare EPUB preview', exact: true }).click();
  await expect(review.getByRole('alert')).toContainText('composition');
  await page.getByLabel('Hold composition', { exact: true }).uncheck();
  await review.getByRole('button', { name: 'Prepare EPUB preview', exact: true }).click();
  await expect(review.getByLabel('EPUB state')).toHaveText('Prepared');
  await expect(review.getByRole('button', { name: 'Download EPUB', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Save state')).toHaveText('Saved');
  await expect(review.getByLabel('EPUB state')).toHaveText('Stale');
  await expect(review.getByRole('button', { name: 'Download EPUB', exact: true })).toBeDisabled();
  await review.getByRole('button', { name: 'Prepare EPUB preview', exact: true }).click();
  await expect(review.getByLabel('EPUB state')).toHaveText('Prepared');
  const report = JSON.parse((await review.getByLabel('EPUB report').textContent())!);
  expect(report.sources.sources.map((s: { artifactId: string }) => s.artifactId)).toEqual([
    'chapter-3',
    'chapter-2',
    'chapter-1',
  ]);
  expect(report.diagnostics.some((d: { severity: string }) => d.severity === 'error')).toBe(false);
  await review
    .getByRole('checkbox', { name: 'I accept the EPUB reflow and omission report', exact: true })
    .check();
  const pending = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Download EPUB', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('chapters.epub');
  const files = unzipSync(await readFile((await download.path())!));
  expect(strFromU8(files['EPUB/chapter-001.xhtml'])).toContain('第3章');
  expect(strFromU8(files['EPUB/chapter-003.xhtml'])).toContain('第1章');
  expect(JSON.parse(strFromU8(files['EPUB/export-report.json']))).toEqual(report);
  const after = await page.evaluate(() =>
    [1, 2, 3].map((n) => JSON.parse(localStorage.getItem(`authoring:chapter-${n}`)!)),
  );
  after.forEach((a, i) => {
    expect(a.draft.content).toEqual(original[i].draft.content);
    expect(a.versions[0]).toEqual(original[i].versions[0]);
  });
  await page.screenshot({ path: info.outputPath('epub-review.png'), fullPage: true });
});

test('N2 EPUB rechecks composition at download and keeps the accepted saved-version plan', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Compose saved chapters', exact: true }).click();
  const review = page.getByRole('region', { name: 'EPUB export review' });
  await review.getByRole('button', { name: 'Prepare EPUB preview', exact: true }).click();
  await expect(review.getByLabel('EPUB state')).toHaveText('Prepared');
  const report = await review.getByLabel('EPUB report').textContent();
  const accepted = review.getByRole('checkbox', {
    name: 'I accept the EPUB reflow and omission report',
    exact: true,
  });
  await accepted.check();
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.getByLabel('Hold composition', { exact: true }).check();
  await review.getByRole('button', { name: 'Download EPUB', exact: true }).click();
  await expect(review.getByRole('alert')).toContainText('composition');
  await expect(review.getByLabel('EPUB state')).toHaveText('Prepared');
  expect(await review.getByLabel('EPUB report').textContent()).toBe(report);
  await expect(accepted).toBeChecked();
  expect(downloads).toEqual([]);
  await page.getByLabel('Hold composition', { exact: true }).uncheck();
  const input = page.locator('[data-block-id="scene-morning"]').first();
  await input.dispatchEvent('compositionstart', { data: '入力' });
  await review.getByRole('button', { name: 'Download EPUB', exact: true }).click();
  await expect(review.getByRole('alert')).toContainText('composition');
  expect(downloads).toEqual([]);
  expect(await review.getByLabel('EPUB report').textContent()).toBe(report);
  await input.dispatchEvent('compositionend', { data: '' });
  const pending = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Download EPUB', exact: true }).click();
  const download = await pending;
  const files = unzipSync(await readFile((await download.path())!));
  expect(JSON.parse(strFromU8(files['EPUB/export-report.json']))).toEqual(JSON.parse(report!));
  await expect(review.getByRole('alert')).toHaveCount(0);
});

test('N2 generated EPUB opens in independent epub.js reader with ordered navigation', async ({
  page,
}, info) => {
  test.skip(
    !process.env.EPUB_READER_ROOT,
    'Set EPUB_READER_ROOT to a test-only epubjs 0.3.93 install (see verification record).',
  );
  const readerRoot = process.env.EPUB_READER_ROOT!;
  await page.getByRole('button', { name: 'Compose saved chapters', exact: true }).click();
  const review = page.getByRole('region', { name: 'EPUB export review' });
  await review.getByRole('button', { name: 'Prepare EPUB preview', exact: true }).click();
  await expect(review.getByLabel('EPUB state')).toHaveText('Prepared');
  await review
    .getByRole('checkbox', { name: 'I accept the EPUB reflow and omission report', exact: true })
    .check();
  const pending = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Download EPUB', exact: true }).click();
  const epub = await readFile((await (await pending).path())!);
  await page.route('**/epub-test/book.epub', (route) =>
    route.fulfill({ contentType: 'application/epub+zip', body: epub }),
  );
  await page.route('**/epub-test/jszip.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      path: readerRoot + '/node_modules/jszip/dist/jszip.min.js',
    }),
  );
  await page.route('**/epub-test/reader.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      path: readerRoot + '/node_modules/epubjs/dist/epub.min.js',
    }),
  );
  await page.route('**/epub-test/reader.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Independent EPUB reader</title></head><body><h1>Independent EPUB reader</h1><nav id="toc"></nav><div id="book" style="height:650px"></div><output id="state"></output><script src="jszip.js"></script><script src="reader.js"></script><script>const book=ePub('book.epub');const rendition=book.renderTo('book',{width:'100%',height:650,flow:'scrolled-doc'});book.loaded.navigation.then(nav=>{for(const item of nav.toc){const button=document.createElement('button');button.textContent=item.label;button.onclick=()=>rendition.display(item.href);document.getElementById('toc').appendChild(button);}});rendition.display().then(()=>document.getElementById('state').textContent='Ready').catch(e=>document.getElementById('state').textContent=String(e));</script></body></html>`,
    }),
  );
  await page.goto('/epub-test/reader.html');
  await expect(page.locator('#state')).toHaveText('Ready');
  await expect(page.locator('#toc button')).toHaveText(['chapter-1', 'chapter-2', 'chapter-3']);
  await expect(page.frameLocator('#book iframe').locator('body')).toContainText('第1章');
  await page.getByRole('button', { name: 'chapter-3', exact: true }).click();
  await expect(page.frameLocator('#book iframe').locator('body')).toContainText('第3章');
  await page.screenshot({ path: info.outputPath('epub-independent-reader.png'), fullPage: true });
});
