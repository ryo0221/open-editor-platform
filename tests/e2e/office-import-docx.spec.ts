import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { test, expect, nativeArtifact, save, setDocumentText } from './fixtures';
import { prepareDocumentImport } from '@editor-platform/document-import';
import { decodeNodeOfficeImage } from '@editor-platform/office-adapters/node';
import { materializeOfficeImport } from '@editor-platform/office-import-core';
import type { DocumentContent } from '@editor-platform/document/model';
import { openDocx, prepareDocx, acceptDocx } from './office-docx-fixtures';
import { officeDownload } from './office-fixtures';
import { openImport } from './office-import-fixtures';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
const file = 'tests/fixtures/office/import/document/external.docx';
export async function openWordImport(page: import('@playwright/test').Page) {
  const dialog = await openImport(page);
  await dialog.getByLabel('Office file', { exact: true }).setInputFiles(file);
  await dialog.getByLabel('Import conversion policy').selectOption('review-conversions');
  return dialog;
}
test('I02/I05/I06 DOCX UI matches headless, retains structures and edits/saves/reloads/exports', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const dialog = await openWordImport(page);
  await expect(dialog.getByLabel('Import pages')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Prepare import preview', exact: true }).click();
  await expect(dialog.getByLabel('Accept import conversions')).toBeEnabled({ timeout: 30000 });
  const preview = dialog.getByLabel('Native import preview');
  await expect(preview.locator('h1')).toHaveText('外部作成の受付改善提案書');
  await expect(preview.locator('ol[start="7"]')).toBeVisible();
  expect(await dialog.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('word-import-preview.png'), fullPage: true });
  await dialog.getByLabel('Accept import conversions').check();
  await dialog.getByRole('button', { name: 'Create imported artifact', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const artifact = await nativeArtifact(page),
    meta = artifact.provenance.officeImport!;
  const plan = await prepareDocumentImport(
    { bytes: new Uint8Array(await readFile(file)), format: 'docx' },
    { unsupported: 'review-conversions', fontProfileId: 'noto-cjk-jp-2.004', name: 'external' },
    meta.requestId,
    { version: 'office-image-validator-1', decodeImage: decodeNodeOfficeImage },
  );
  expect(meta.fingerprint).toBe(plan.report.planHash);
  expect(artifact.draft.content).toEqual(
    materializeOfficeImport(plan, {
      planHash: plan.report.planHash,
      acceptedDiagnosticIds: plan.report.diagnostics
        .filter((d) => d.requiresConsent)
        .map((d) => d.id),
    }).draft.content,
  );
  const body = page.getByRole('textbox', { name: 'Document body', exact: true });
  await expect(body.locator('ol[start="7"]')).toBeVisible();
  await setDocumentText(page, 'h1', '取り込み後に編集した日本語の提案書');
  await setDocumentText(page, 'td p:has-text("本文")', '通常編集したセル');
  await save(page, 1);
  const edited = await nativeArtifact(page);
  await page.reload();
  await expect(body.locator('h1')).toHaveText('取り込み後に編集した日本語の提案書');
  expect((await nativeArtifact(page)).draft.content).toEqual(edited.draft.content);
  const content = edited.draft.content as DocumentContent;
  expect(content.blocks.find((b) => b.type === 'table')?.cellParagraphs?.[1][0]).toHaveLength(2);
  expect(content.blocks.find((b) => b.start === 7)).toBeDefined();
  await page.screenshot({ path: info.outputPath('word-import-edited.png'), fullPage: true });
  const exporter = await openDocx(page);
  await prepareDocx(exporter);
  await acceptDocx(exporter);
  const bytes = await officeDownload(page, exporter, 'Download DOCX');
  await mkdir(info.outputPath('corpus'), { recursive: true });
  await writeFile(info.outputPath('corpus/ui-import-edited.docx'), bytes);
  await writeFile(info.outputPath('corpus/native.json'), JSON.stringify(edited, null, 2));
  await writeFile(
    info.outputPath('corpus/import-report.json'),
    JSON.stringify(plan.report, null, 2),
  );
});
test('I03/I04 Word revisions cannot be waived and changing format discards old consent', async ({
  page,
}) => {
  const dialog = await openWordImport(page);
  const before = await page
    .getByRole('navigation', { name: 'Artifacts' })
    .getByRole('button')
    .count();
  const files = unzipSync(new Uint8Array(await readFile(file)));
  files['word/document.xml'] = strToU8(
    strFromU8(files['word/document.xml']).replace(
      '<w:r>',
      '<w:r><w:delText>unconfirmed revision</w:delText>',
    ),
  );
  await dialog.getByLabel('Office file', { exact: true }).setInputFiles({
    name: 'revision.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(zipSync(files)),
  });
  await dialog.getByRole('button', { name: 'Prepare import preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('tracked changes', { timeout: 30000 });
  expect(
    await page.getByRole('navigation', { name: 'Artifacts' }).getByRole('button').count(),
  ).toBe(before);
  await dialog.getByLabel('Office file', { exact: true }).setInputFiles(file);
  await dialog.getByRole('button', { name: 'Prepare import preview', exact: true }).click();
  await expect(dialog.getByLabel('Accept import conversions')).toBeEnabled({ timeout: 30000 });
  await dialog.getByLabel('Accept import conversions').check();
  await dialog
    .getByLabel('Office file', { exact: true })
    .setInputFiles('tests/fixtures/office/import/external.pptx');
  await expect(dialog.getByLabel('Import pages')).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Create imported artifact', exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByLabel('Accept import conversions')).toHaveCount(0);
});
