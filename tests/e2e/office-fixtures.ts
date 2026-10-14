import { readFile } from 'node:fs/promises';
import type { Page, Locator } from '@playwright/test';
import { createArtifact, serializeArtifact } from '@editor-platform/artifact-core';
import type { SlideContent } from '@editor-platform/slide/model';
import type { SlidePptxReport } from '@editor-platform/slide-export';
import { expect } from './fixtures';

export const officeOptions = {
  pageIds: 'all' as const,
  includeHiddenSlides: false,
  includeNotes: false,
  fontProfileId: 'noto-cjk-jp-2.004',
  fallback: 'element-png' as const,
};
export function officeDeck(image?: string): SlideContent {
  return {
    schemaVersion: 2,
    width: 960,
    height: 540,
    slides: [
      {
        id: 'page',
        title: '出力テスト',
        background: '#ffffff',
        notes: '明示的なノート',
        objects: [
          {
            id: 'heading',
            type: 'text',
            text: '日本語の編集可能な資料',
            fill: '#253044',
            bounds: { x: 40, y: 40, width: 700, height: 90 },
            typography: { fontFamily: 'Noto Sans CJK JP', fontSize: 28 },
          },
          {
            id: 'box',
            type: 'shape',
            shape: 'rectangle',
            text: '',
            fill: '#dceafa',
            bounds: { x: 40, y: 200, width: 180, height: 100 },
          },
          ...(image
            ? [
                {
                  id: 'image',
                  type: 'image' as const,
                  text: '',
                  src: image,
                  fill: 'none',
                  bounds: { x: 260, y: 200, width: 180, height: 100 },
                },
              ]
            : []),
        ],
      },
    ],
  };
}
export async function importOfficeDeck(page: Page, deck: SlideContent) {
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'office-source.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeArtifact(createArtifact('slide', 'Office source', deck))),
  });
  await expect(page.getByRole('application', { name: 'Slide canvas', exact: true })).toBeVisible();
}
export async function openPptx(page: Page) {
  if (!(await page.getByRole('button', { name: 'Export visual', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  await page.getByRole('button', { name: 'Export PPTX', exact: true }).click();
  await page.keyboard.press('Escape');
  const dialog = page.getByRole('dialog', { name: 'PPTX export', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
export async function preparePptx(dialog: Locator) {
  await dialog.getByRole('button', { name: /^(Prepare|Refresh) PPTX preview$/ }).click();
  await expect(dialog.getByLabel('PPTX counts')).toBeVisible({ timeout: 30000 });
}
export async function acceptPptx(dialog: Locator) {
  const check = dialog.getByRole('checkbox', { name: /I accept all/ });
  if (await check.count()) await check.check();
}
export async function officeDownload(page: Page, dialog: Locator, name: string) {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name, exact: true }).click(),
  ]);
  return readFile((await file.path())!);
}
export async function reportDownload(page: Page, dialog: Locator) {
  return JSON.parse(
    (await officeDownload(page, dialog, 'Download loss report')).toString(),
  ) as SlidePptxReport;
}
