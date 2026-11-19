import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import type { DrawingDocument } from '@editor-platform/drawing-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, test } from './fixtures';

// DW1 (docs/cad/drawing-editor.md; ST-700, TS-2401): the drawing Surface in the ordinary
// Playground: sheets, the title block, revisions and notes, saved as the draft.

const draft = async (page: Page) => (await nativeArtifact(page)).draft.content as DrawingDocument;
const tool = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test('make a sheet set: title block, revision, a note placed and moved, a second sheet', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await create(page, 'drawing');
  const sheet = page.getByTestId('drawing-sheet');
  await expect(sheet.locator('img')).toBeVisible();
  await expect(page.getByTestId('drawing-status')).toContainText('Sheet 1 · A3 横');

  // Title block fields commit on Enter and show on the sheet.
  for (const [label, value] of [
    ['図名 Title', '地板（部品図）'],
    ['図番 Drawing number', 'SK01-101'],
    ['材料 Material', 'C3604'],
    ['日付 Date', '2026-11-14'],
  ] as const) {
    const field = page.getByLabel(label, { exact: true });
    await field.fill(value);
    await field.press('Enter');
  }
  const date = page.getByLabel('日付 Date', { exact: true });
  await date.fill('2026-02-30');
  await date.press('Enter');
  await expect(page.getByTestId('drawing-notice')).toContainText('YYYY-MM-DD');
  // Codex on #1203: the export settles the inputs first; a refused value blocks it.
  const download = page.waitForEvent('download', { timeout: 2_000 }).catch(() => null);
  await tool(page, 'Export SVG').click();
  expect(await download).toBeNull();
  await date.press('Escape');

  await page.getByLabel('Revision description', { exact: true }).fill('初版');
  await page.getByRole('button', { name: 'Add revision', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Revisions' })).toContainText('A');

  // A note: the tool, then a click on the sheet; then dragged 20 mm right.
  await tool(page, 'Add note').click();
  const box = (await sheet.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.3);
  const note = page.getByRole('button', { name: 'Note 注記', exact: true });
  await expect(note).toBeVisible();
  await page.getByLabel('Note text', { exact: true }).fill('注記\n1. 指示なき角はC0.2');
  await page.getByLabel('Text height (mm)', { exact: true }).focus();
  await expect
    .poll(async () => ((await draft(page)).annotations[0] as { text?: string } | undefined)?.text)
    .toBe('注記\n1. 指示なき角はC0.2');
  const before = (await draft(page)).annotations[0]!.at;
  const nb = (await note.boundingBox())!;
  const mmPx = box.width / 420;
  await page.mouse.move(nb.x + 5, nb.y + 5);
  await page.mouse.down();
  await page.mouse.move(nb.x + 5 + 10 * mmPx, nb.y + 5, { steps: 4 });
  await page.mouse.move(nb.x + 5 + 20 * mmPx, nb.y + 5, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await draft(page)).annotations[0]!.at[0] - before[0])
    .toBeGreaterThan(18);

  // Codex on #1203: text still being typed is committed by the save's own flush.
  const text = page.getByLabel('Note text', { exact: true });
  await text.fill('注記\n1. 指示なき角はC0.5');
  await text.press('Control+s');
  await expect
    .poll(async () => ((await draft(page)).annotations[0] as { text?: string } | undefined)?.text)
    .toBe('注記\n1. 指示なき角はC0.5');
  const dialog = page.getByRole('dialog', { name: 'Save immutable version', exact: true });
  if (await dialog.isVisible()) await page.keyboard.press('Escape');

  // A second sheet, A4 portrait.
  await page.getByLabel('New sheet size', { exact: true }).selectOption('A4');
  await page.getByLabel('Orientation', { exact: true }).selectOption('portrait');
  await tool(page, 'Add sheet').click();
  await expect(page.getByTestId('drawing-status')).toContainText('Sheet 2 · A4 縦');

  const doc = await draft(page);
  expect(doc.sheets.map((s) => [s.size, s.orientation])).toEqual([
    ['A3', 'landscape'],
    ['A4', 'portrait'],
  ]);
  expect(doc.sheets[0]!.title).toMatchObject({
    title: '地板（部品図）',
    drawingNumber: 'SK01-101',
    material: 'C3604',
    date: '2026-11-14',
  });
  expect(doc.sheets[0]!.revisions.map((r) => [r.mark, r.description])).toEqual([['A', '初版']]);

  // Delete the second sheet; Undo brings it back.
  await tool(page, 'Delete sheet').click();
  await expect(page.getByTestId('drawing-status')).toContainText('Sheet 1 · A3 横');
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect.poll(async () => (await draft(page)).sheets.length).toBe(2);

  // DW6 (ST-713, TS-2447): both sheets as one PDF, its text in the Host's fixed font.
  const pdfDownload = page.waitForEvent('download');
  await tool(page, 'Export PDF (all sheets)').click();
  const pdf = await PDFDocument.load(readFileSync(await (await pdfDownload).path()));
  expect(pdf.getPageCount()).toBe(2);

  // DW6b (ST-714, TS-2449): both sheets issued: a saved version, the PDF kept with it, both
  // sheets' next revision; exported with the record, and still there after a reload.
  await page.getByLabel('Sheets to issue', { exact: true }).selectOption('all');
  await page.getByLabel('Issue description', { exact: true }).fill('施工用 For construction');
  await page.getByRole('button', { name: '発行する Issue', exact: true }).click();
  await expect(page.getByTestId('drawing-issue')).toHaveCount(1);
  await expect(page.getByTestId('drawing-issue')).toContainText('Sheet 1 B, Sheet 2 A');
  const record = await nativeArtifact(page);
  // After the version Ctrl+S saved above.
  expect(record.versions).toHaveLength(2);
  expect(record.versions[1]!.reason).toBe('発行 Issue Sheet 1 B, Sheet 2 A');
  expect(record.drawingIssues).toMatchObject([
    { versionId: record.versions[1]!.versionId, pdf: { mediaType: 'application/pdf' } },
  ]);
  expect((record.draft.content as DrawingDocument).sheets.map((s) => s.revisions.length)).toEqual([
    2, 1,
  ]);
  await page.reload();
  await expect(page.getByTestId('drawing-issue')).toHaveCount(1);
  const issued = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download issued PDF Sheet 1 B, Sheet 2 A', exact: true })
    .click();
  const kept = await PDFDocument.load(readFileSync(await (await issued).path()));
  expect(kept.getPageCount()).toBe(2);
  expect(errors).toEqual([]);
});
