import type { Page, Locator } from '@playwright/test';
import { createArtifact, serializeArtifact } from '@editor-platform/artifact-core';
import type { DocumentContent } from '@editor-platform/document/model';
import type { DocumentDocxReport } from '@editor-platform/document-export';
import { expect } from './fixtures';
import { officeDownload } from './office-fixtures';

export function officeDocument(image?: string): DocumentContent {
  return {
    schemaVersion: 2,
    page: { size: 'A4', margin: 64 },
    blocks: [
      { id: 'heading', type: 'heading', level: 1, text: '日本語の編集可能な文書' },
      { id: 'paragraph', type: 'paragraph', text: '受付担当と文書の内容を確認します。' },
      { id: 'check', type: 'check-list', text: '確認項目' },
      ...(image
        ? [
            {
              id: 'image',
              type: 'image' as const,
              text: '',
              src: image,
              alt: '検証画像',
              width: 240,
            },
          ]
        : []),
    ],
  };
}
export async function importOfficeDocument(page: Page, content: DocumentContent) {
  await page.goto('/');
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles({
      name: 'office-document.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        serializeArtifact(createArtifact('document', 'Office document', content)),
      ),
    });
  await expect(page.getByRole('textbox', { name: 'Document body', exact: true })).toBeVisible();
}
export async function openDocx(page: Page) {
  if (!(await page.getByRole('button', { name: 'Export document', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByRole('button', { name: 'Export document', exact: true }).click();
  await page.getByRole('button', { name: 'Export DOCX', exact: true }).click();
  await page.keyboard.press('Escape');
  const dialog = page.getByRole('dialog', { name: 'DOCX export', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
export async function prepareDocx(dialog: Locator) {
  await dialog.getByRole('button', { name: /^(Prepare|Refresh) DOCX preview$/ }).click();
  await expect(dialog.getByLabel('DOCX counts')).toBeVisible({ timeout: 30000 });
}
export async function acceptDocx(dialog: Locator) {
  const check = dialog.getByRole('checkbox', { name: /I accept all/ });
  if (await check.count()) await check.check();
}
export async function docxReport(page: Page, dialog: Locator) {
  return JSON.parse(
    (await officeDownload(page, dialog, 'Download loss report')).toString(),
  ) as DocumentDocxReport;
}
