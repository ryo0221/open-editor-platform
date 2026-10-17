import { test } from './office-runtime-fixtures';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { expect, nativeArtifact, setDocumentText } from './fixtures';
import { officeDownload } from './office-fixtures';
import {
  officeDocument,
  importOfficeDocument,
  openDocx,
  prepareDocx,
  acceptDocx,
  docxReport,
} from './office-docx-fixtures';
import { docxStructure } from '../fixtures/office/docx-structure';
import { nodeDocx, docxOptions } from '../fixtures/office/docx-node';
import { openWhole } from './template-fixtures';
import type { DocumentContent } from '@editor-platform/document/model';

test('D11 ordinary template edit and DOCX output equal the Host API without changing history', async ({
  page,
}, info) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/');
  const form = await openWhole(page, 'document', '企画書');
  await form.locator('[data-slot="title"]').fill('文書の再利用と確認');
  await form.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await form.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(form).toHaveCount(0);
  await setDocumentText(page, 'h1', '担当者が通常の操作で編集した提案書');
  const before = await nativeArtifact(page);
  const undo = await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled();
  expect(
    requests.some((url) => /docx-worker|pptx-worker|docx-adapter|pptxgen|office-fonts/.test(url)),
  ).toBe(false);
  const dialog = await openDocx(page);
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  const actual = await officeDownload(page, dialog, 'Download DOCX'),
    report = await docxReport(page, dialog);
  const basis =
    report.basis.kind === 'local-draft'
      ? { kind: 'local-draft' as const, artifactId: report.basis.artifactId }
      : report.basis;
  const expected = await nodeDocx(before.draft.content as DocumentContent, basis, {
    ...docxOptions,
    mermaid: 'reject',
    previewBlocks: 'reject',
  });
  expect(docxStructure(actual)).toEqual(docxStructure(expected.bytes));
  expect(report).toEqual(expected.report);
  expect(await nativeArtifact(page)).toEqual(before);
  expect(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(undo);
  expect(requests.some((url) => /pptx-worker|pptxgen/.test(url))).toBe(false);
  await page.screenshot({ path: info.outputPath('docx-preflight.png'), fullPage: true });
  await writeFile(info.outputPath('ordinary.docx'), actual);
  await writeFile(info.outputPath('report.json'), JSON.stringify(report, null, 2));
});

test('D08 Mermaid images use fixed glyphs, native text stays editable, and previews require source consent', async ({
  page,
}, info) => {
  const source = officeDocument();
  source.blocks.push(
    {
      id: 'diagram',
      type: 'mermaid',
      text: 'flowchart LR\n A[受付] --> B[確認]\n B --> C[完了]',
      caption: '日本語の流れ',
    },
    {
      id: 'preview',
      type: 'react-preview',
      text: '<script>globalThis.OFFICE_EXECUTED=true</script>',
    },
  );
  await importOfficeDocument(page, source);
  const before = await nativeArtifact(page),
    dialog = await openDocx(page);
  await prepareDocx(dialog);
  await expect(dialog.getByLabel('DOCX counts')).toContainText('Errors: 2');
  await acceptDocx(dialog);
  await expect(dialog.getByRole('button', { name: 'Download DOCX', exact: true })).toBeDisabled();
  await dialog.getByLabel('DOCX Mermaid', { exact: true }).selectOption('image');
  await dialog.getByLabel('DOCX preview blocks', { exact: true }).selectOption('source');
  await prepareDocx(dialog);
  await expect(dialog.getByLabel('DOCX counts')).toContainText('Errors: 0');
  await expect(dialog.getByRole('button', { name: 'Download DOCX', exact: true })).toBeDisabled();
  await acceptDocx(dialog);
  const bytes = await officeDownload(page, dialog, 'Download DOCX'),
    report = await docxReport(page, dialog);
  const files = unzipSync(bytes),
    xml = strFromU8(files['word/document.xml']);
  expect(report.diagnostics.some((d) => d.code === 'MERMAID_RASTERIZED')).toBe(true);
  expect(report.counts.rasterized).toBe(1);
  expect(xml).toContain('日本語の編集可能な文書');
  expect(xml).toContain('&lt;script&gt;globalThis.OFFICE_EXECUTED=true&lt;/script&gt;');
  expect(
    Object.keys(files).filter((p) => p.startsWith('word/media/') && p.endsWith('.png')),
  ).toHaveLength(1);
  expect(
    await page.evaluate(
      () => (window as typeof window & { OFFICE_EXECUTED?: boolean }).OFFICE_EXECUTED,
    ),
  ).toBeUndefined();
  expect(await nativeArtifact(page)).toEqual(before);
  const root = process.env.DOCX_MERMAID_EVIDENCE ?? info.outputPath('mermaid');
  await mkdir(root, { recursive: true });
  await writeFile(`${root}/diagram.docx`, bytes);
  await writeFile(`${root}/diagram.report.json`, JSON.stringify(report, null, 2));
  await writeFile(`${root}/diagram.native.json`, JSON.stringify(source, null, 2));
  await page.screenshot({ path: `${root}/preview.png`, fullPage: true });
});

test('D10 waiting image preparation cancels without download, keeps edits and retries fresh assets', async ({
  page,
  context,
}, info) => {
  const png = await readFile('tests/fixtures/office/images/quadrants.png');
  let hold = true,
    seen = 0;
  await context.route('**/docx-delay.png', async (route) => {
    seen++;
    if (hold) await new Promise((resolve) => setTimeout(resolve, 1400));
    await route.fulfill({ contentType: 'image/png', body: png }).catch(() => {});
  });
  await importOfficeDocument(page, officeDocument('http://127.0.0.1:4173/docx-delay.png'));
  const dialog = await openDocx(page),
    downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await dialog.getByRole('button', { name: 'Prepare DOCX preview', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel export', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Minimize DOCX export', exact: true }).click();
  await setDocumentText(page, 'h1', '取消中にも保持された編集');
  await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await dialog.getByRole('button', { name: 'Expand DOCX export', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Export cancelled');
  await page.waitForTimeout(1500);
  expect(downloads).toEqual([]);
  hold = false;
  const before = await nativeArtifact(page);
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  const bytes = await officeDownload(page, dialog, 'Download DOCX');
  expect(docxStructure(bytes).document).toContain('取消中にも保持された編集');
  expect(seen).toBeGreaterThan(1);
  expect(await nativeArtifact(page)).toEqual(before);
  await page.screenshot({ path: info.outputPath('docx-cancel-retry.png'), fullPage: true });
});

test('D10 the worker owns previewed image bytes; refresh refetches and invalidates consent', async ({
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
  await importOfficeDocument(page, officeDocument(new URL('/office-changing-image', baseURL).href));
  const dialog = await openDocx(page);
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  const original = await docxReport(page, dialog),
    preparedRequests = requests;
  current = jpeg;
  const old = unzipSync(await officeDownload(page, dialog, 'Download DOCX'));
  expect(
    Object.entries(old).some(
      ([name, bytes]) => name.startsWith('word/media/') && Buffer.from(bytes).equals(png),
    ),
  ).toBe(true);
  expect(requests).toBe(preparedRequests);
  await prepareDocx(dialog);
  expect((await docxReport(page, dialog)).planHash).not.toBe(original.planHash);
  await expect(dialog.getByRole('checkbox', { name: /I accept all/ })).not.toBeChecked();
  await acceptDocx(dialog);
  const updated = unzipSync(await officeDownload(page, dialog, 'Download DOCX'));
  expect(
    Object.entries(updated).some(
      ([name, bytes]) => name.startsWith('word/media/') && Buffer.from(bytes).equals(jpeg),
    ),
  ).toBe(true);
  current = png.subarray(0, 26);
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  await expect(dialog.getByRole('button', { name: 'Download DOCX', exact: true })).toBeDisabled();
  const failed = await docxReport(page, dialog);
  expect(
    failed.diagnostics.some((d) => d.severity === 'error' && d.address?.blockId === 'image'),
  ).toBe(true);
});
