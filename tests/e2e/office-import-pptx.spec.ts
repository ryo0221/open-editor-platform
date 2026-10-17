import { test } from './office-runtime-fixtures';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { expect, nativeArtifact, save } from './fixtures';
import { prepareSlideImport } from '@editor-platform/slide-import';
import { decodeNodeOfficeImage } from '@editor-platform/office-adapters/node';
import { materializeOfficeImport } from '@editor-platform/office-import-core';
import { openPptx, preparePptx, acceptPptx, officeDownload } from './office-fixtures';
import type { SlideContent } from '@editor-platform/slide/model';
import { openImport, ready } from './office-import-fixtures';
test('I01/I05/I06 ordinary PPTX import matches headless, edits, saves/reloads and exports', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const dialog = await openImport(page);
  await ready(dialog);
  await expect(
    dialog.getByRole('button', { name: 'Create imported artifact', exact: true }),
  ).toBeDisabled();
  expect(await dialog.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('import-preview.png'), fullPage: true });
  await dialog.getByLabel('Accept import conversions').check();
  await dialog.getByRole('button', { name: 'Create imported artifact', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const initial = await nativeArtifact(page),
    meta = initial.provenance.officeImport!;
  const plan = await prepareSlideImport(
    {
      bytes: new Uint8Array(await readFile('tests/fixtures/office/import/external.pptx')),
      format: 'pptx',
    },
    {
      unsupported: 'review-conversions',
      fontProfileId: 'noto-cjk-jp-2.004',
      pages: 'all',
      notes: 'exclude',
      includeHidden: false,
      name: 'external',
      exclude: ['ppt/slides/slide1.xml#/sld[1]/AlternateContent[1]'],
    },
    meta.requestId,
    { version: 'office-image-validator-1', decodeImage: decodeNodeOfficeImage },
  );
  const expected = materializeOfficeImport(plan, {
    planHash: plan.report.planHash,
    acceptedDiagnosticIds: plan.report.diagnostics
      .filter((d) => d.requiresConsent)
      .map((d) => d.id),
  });
  expect(initial.draft.content).toEqual(expected.draft.content);
  expect(meta.fingerprint).toBe(plan.report.planHash);
  expect(JSON.stringify(initial)).not.toContain('PRIVATE_OFFICE_AUTHOR_SENTINEL');
  const canvas = page.getByRole('application', { name: 'Slide canvas', exact: true });
  await canvas.getByRole('button').filter({ hasText: '外部作成の受付改善資料' }).dblclick();
  const input = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await input.press('Control+a');
  await page.keyboard.insertText('取り込み後に通常編集した資料');
  await input.press('Control+Enter');
  await save(page, 1);
  const edited = await nativeArtifact(page);
  await page.reload();
  await expect(canvas).toBeVisible();
  expect((await nativeArtifact(page)).draft.content).toEqual(edited.draft.content);
  const exported = await openPptx(page);
  await preparePptx(exported);
  await acceptPptx(exported);
  const bytes = await officeDownload(page, exported, 'Download PPTX');
  await mkdir(info.outputPath('corpus'), { recursive: true });
  await writeFile(info.outputPath('corpus/ui-import-edited.pptx'), bytes);
  await writeFile(info.outputPath('corpus/native.json'), JSON.stringify(edited, null, 2));
  await writeFile(
    info.outputPath('corpus/import-report.json'),
    JSON.stringify(plan.report, null, 2),
  );
  expect(
    (edited.draft.content as SlideContent).slides[0].objects.find(
      (o) => o.text === '取り込み後に通常編集した資料',
    ),
  ).toBeDefined();
});
test('I03/I04 cancellation, malformed source and stale conversion consent create no artifact', async ({
  page,
}) => {
  test.setTimeout(90000);
  // Hold a real asynchronous prerequisite so cancellation is exercised while
  // preparation is pending, independently of machine/font-cache speed.
  let releaseFonts!: () => void;
  const fontGate = new Promise<void>((resolve) => {
    releaseFonts = resolve;
  });
  await page.route(
    '**/office-fonts/manifest.json',
    async (route) => {
      await fontGate;
      await route.continue();
    },
    { times: 1 },
  );
  const dialog = await openImport(page);
  const before = await page
    .getByRole('navigation', { name: 'Artifacts' })
    .getByRole('button')
    .count();
  await dialog.getByRole('button', { name: 'Prepare import preview', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel import', exact: true }).click();
  releaseFonts();
  await expect(dialog.getByRole('alert')).toContainText('作成されていません');
  expect(
    await page.getByRole('navigation', { name: 'Artifacts' }).getByRole('button').count(),
  ).toBe(before);
  await ready(dialog);
  await dialog.getByLabel('Accept import conversions').check();
  await dialog.getByLabel('Imported artifact name').fill('Different request input');
  await expect(
    dialog.getByRole('button', { name: 'Create imported artifact', exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByLabel('Accept import conversions')).not.toBeChecked();
  await dialog.getByLabel('Office file', { exact: true }).setInputFiles({
    name: 'broken.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: Buffer.from('not a zip'),
  });
  await dialog.getByRole('button', { name: 'Prepare import preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('ZIP');
  expect(
    await page.getByRole('navigation', { name: 'Artifacts' }).getByRole('button').count(),
  ).toBe(before);
});
