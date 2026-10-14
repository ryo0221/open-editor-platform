import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import type { SlideContent } from '@editor-platform/slide/model';
import { test, expect, nativeArtifact } from './fixtures';
import { openWhole } from './template-fixtures';
import {
  officeOptions,
  officeDeck,
  importOfficeDeck,
  openPptx,
  preparePptx,
  acceptPptx,
  officeDownload,
  reportDownload,
} from './office-fixtures';
import { nodePptx } from '../fixtures/office/node';

test('G12 ordinary template edit and PPTX output equal the Host API without changing artifact/history', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));
  await page.goto('/');
  const form = await openWhole(page, 'slide', '選択肢比較');
  await form.locator('[data-slot="title"]').fill('資料を比較して決める');
  await form.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await form.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Slide canvas', exact: true });
  await canvas.getByRole('button').filter({ hasText: '資料を比較して決める' }).first().dblclick();
  const input = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await input.press('Control+a');
  await page.keyboard.insertText('通常編集した日本語');
  await input.press('Control+Enter');
  const before = await nativeArtifact(page);
  const undo = await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled();
  expect(requested.some((u) => /pptx-worker|pptxgen|office-fonts|index_bg.*wasm/.test(u))).toBe(
    false,
  );
  const dialog = await openPptx(page);
  await preparePptx(dialog);
  await expect(dialog.getByRole('button', { name: 'Download PPTX', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('pptx-preflight.png'), fullPage: true });
  await acceptPptx(dialog);
  const bytes = await officeDownload(page, dialog, 'Download PPTX'),
    report = await reportDownload(page, dialog);
  expect(report.diagnostics.some((d) => d.severity === 'error')).toBe(false);
  const expected = await nodePptx(
    before.draft.content as SlideContent,
    report.basis,
    officeOptions,
  );
  const xml = unzipSync(bytes),
    nodeXml = unzipSync(expected.bytes);
  for (const name of Object.keys(xml).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)))
    expect(strFromU8(xml[name])).toBe(strFromU8(nodeXml[name]));
  expect({ ...report, planHash: '' }).toEqual({ ...expected.report, planHash: '' });
  await dialog.getByRole('button', { name: 'Close PPTX export', exact: true }).click();
  expect(await nativeArtifact(page)).toEqual(before);
  expect(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(undo);
  await mkdir(info.outputPath('export'), { recursive: true });
  await writeFile(info.outputPath('export/ui.pptx'), bytes);
  await writeFile(info.outputPath('export/report.json'), JSON.stringify(report, null, 2));
});

test('G11 worker preparation cancels while assets wait, retains edits, then retry owns fresh assets', async ({
  page,
  context,
  baseURL,
}, info) => {
  test.setTimeout(90000);
  let release: (() => void) | undefined,
    seen = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const image = await readFile('tests/fixtures/office/images/quadrants.png');
  await context.route('**/office-held.png', async (route) => {
    seen++;
    await held;
    await route.fulfill({ status: 200, contentType: 'image/png', body: image }).catch(() => {});
  });
  await importOfficeDeck(page, officeDeck(new URL('/office-held.png', baseURL).href));
  const dialog = await openPptx(page);
  await dialog.getByRole('button', { name: 'Prepare PPTX preview', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel export', exact: true })).toBeVisible();
  // A real ordinary edit is still possible while the modeless export panel is open.
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  const inserted = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(inserted.slides[0].objects).toHaveLength(4);
  const files: string[] = [];
  page.on('download', (d) => files.push(d.suggestedFilename()));
  const started = Date.now();
  await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Export cancelled');
  expect(Date.now() - started).toBeLessThan(1000);
  release!();
  expect(seen).toBeGreaterThan(0);
  await preparePptx(dialog);
  await acceptPptx(dialog);
  const bytes = await officeDownload(page, dialog, 'Download PPTX');
  expect(bytes.length).toBeGreaterThan(1000);
  expect(files.filter((f) => f.endsWith('.pptx'))).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close PPTX export', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(
    ((await nativeArtifact(page)).draft.content as SlideContent).slides[0].objects,
  ).toHaveLength(3);
  await page.screenshot({ path: info.outputPath('after-worker-cancel.png'), fullPage: true });
});

test('G09/G11 errors cannot be consented and changing options invalidates prior approval', async ({
  page,
}) => {
  test.setTimeout(60000);
  const deck = officeDeck();
  deck.slides[0].objects.push({
    id: 'star',
    type: 'shape',
    shape: 'star',
    text: '',
    fill: '#123456',
    bounds: { x: 400, y: 200, width: 160, height: 100 },
  });
  await importOfficeDeck(page, deck);
  const dialog = await openPptx(page);
  await dialog.getByLabel('PPTX fallback').selectOption('reject');
  await preparePptx(dialog);
  await acceptPptx(dialog);
  await expect(dialog.getByRole('button', { name: 'Download PPTX', exact: true })).toBeDisabled();
  await dialog.getByLabel('PPTX fallback').selectOption('element-png');
  await preparePptx(dialog);
  await expect(dialog.getByRole('checkbox', { name: /I accept all/ })).not.toBeChecked();
  await acceptPptx(dialog);
  await dialog.getByRole('checkbox', { name: 'Include speaker notes', exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'Download PPTX', exact: true })).toHaveCount(0);
  await preparePptx(dialog);
  await acceptPptx(dialog);
  const bytes = await officeDownload(page, dialog, 'Download PPTX'),
    files = unzipSync(bytes);
  expect(strFromU8(files['ppt/notesSlides/notesSlide1.xml'])).toContain('明示的なノート');
});

test('G11 the worker owns previewed image bytes; refresh refetches and invalidates consent', async ({
  page,
  context,
  baseURL,
}) => {
  const png = await readFile('tests/fixtures/office/images/quadrants.png');
  const jpeg = await readFile('tests/fixtures/office/images/quadrants.jpeg');
  let current = png,
    requests = 0;
  await context.route('**/office-changing-image', async (route) => {
    requests++;
    await route.fulfill({
      contentType: 'application/octet-stream',
      headers: { 'Cache-Control': 'no-store' },
      body: current,
    });
  });
  await importOfficeDeck(page, officeDeck(new URL('/office-changing-image', baseURL).href));
  const dialog = await openPptx(page);
  await preparePptx(dialog);
  await acceptPptx(dialog);
  const original = await reportDownload(page, dialog),
    preparedRequests = requests;
  current = jpeg;
  const old = unzipSync(await officeDownload(page, dialog, 'Download PPTX'));
  expect(
    Object.entries(old).some(
      ([name, bytes]) => name.startsWith('ppt/media/') && Buffer.from(bytes).equals(png),
    ),
  ).toBe(true);
  expect(requests).toBe(preparedRequests);
  await preparePptx(dialog);
  expect((await reportDownload(page, dialog)).planHash).not.toBe(original.planHash);
  await expect(dialog.getByRole('checkbox', { name: /I accept all/ })).not.toBeChecked();
  await acceptPptx(dialog);
  const updated = unzipSync(await officeDownload(page, dialog, 'Download PPTX'));
  expect(
    Object.entries(updated).some(
      ([name, bytes]) => name.startsWith('ppt/media/') && Buffer.from(bytes).equals(jpeg),
    ),
  ).toBe(true);
  current = png.subarray(0, 26);
  await preparePptx(dialog);
  await acceptPptx(dialog);
  await expect(dialog.getByRole('button', { name: 'Download PPTX', exact: true })).toBeDisabled();
  const failed = await reportDownload(page, dialog);
  expect(
    failed.diagnostics.some((d) => d.severity === 'error' && d.address?.elementId === 'image'),
  ).toBe(true);
});
