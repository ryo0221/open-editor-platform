import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { test, expect, nativeArtifact, save } from './fixtures';
import { openImport } from './office-import-fixtures';
import { openPptx, preparePptx, acceptPptx, officeDownload } from './office-fixtures';
import { makeReviewPptx } from '../fixtures/office/import/review';
import { exportSlideSvg, type SlideContent } from '@editor-platform/slide/model';
for (const width of [1440, 390]) {
  test(`#14 review: hidden group, font color, theme effects and text breaks at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    const input = makeReviewPptx(
      new Uint8Array(await readFile('tests/fixtures/office/import/external.pptx')),
    );
    const dialog = await openImport(page);
    await dialog.getByLabel('Office file', { exact: true }).setInputFiles({
      name: 'review.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: Buffer.from(input),
    });
    await dialog.getByLabel('Import conversion policy').selectOption('review-conversions');
    await dialog.getByLabel('Import notes').selectOption('include');
    const prepare = dialog.getByRole('button', { name: 'Prepare import preview', exact: true });
    await prepare.click();
    await expect(dialog.getByRole('status')).toHaveText(/停止 3 /, { timeout: 30000 });
    await expect(dialog.getByLabel('Accept import conversions')).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Create imported artifact', exact: true }),
    ).toBeDisabled();
    // Diagnostics are paginated in source order. Review every page through the UI.
    let excluded = 0,
      sawShadow = false;
    for (;;) {
      if (await dialog.getByText('blocked: SHAPE_EFFECT', { exact: true }).count()) {
        sawShadow = true;
        await page.screenshot({
          path: info.outputPath(`review-blocked-${width}.png`),
          fullPage: true,
        });
      }
      const exclusions = dialog.getByRole('checkbox', { name: /^Exclude / });
      for (let i = 0; i < (await exclusions.count()); i++) {
        await exclusions.nth(i).check();
        excluded++;
      }
      const next = dialog.getByRole('button', { name: '次の診断', exact: true });
      if (!(await next.count()) || !(await next.isEnabled())) break;
      await next.click();
    }
    expect(sawShadow).toBe(true);
    expect(excluded).toBe(3);
    await prepare.click();
    await expect(dialog.getByLabel('Accept import conversions')).toBeEnabled({ timeout: 30000 });
    while (!(await dialog.getByText('excluded: SHAPE_EFFECT', { exact: true }).count()))
      await dialog.getByRole('button', { name: '次の診断', exact: true }).click();
    await expect(dialog.getByText('excluded: SHAPE_EFFECT', { exact: true })).toBeVisible();
    const preview = dialog.getByLabel('Native import preview');
    await expect(preview).not.toContainText('非表示の');
    await expect(
      preview.locator('tspan[fill="#ff0000"]').filter({ hasText: '継承された赤い文字' }),
    ).toHaveCount(1);
    await expect(
      preview.locator('tspan[fill="#0000ff"]').filter({ hasText: '個別の青い文字' }),
    ).toHaveCount(1);
    const cellLines = await preview
      .locator('tspan')
      .evaluateAll((nodes) =>
        nodes
          .filter((n) => ['氏名', '部署'].includes(n.textContent ?? '') && n.hasAttribute('y'))
          .map((n) => ({ text: n.textContent, y: Number(n.getAttribute('y')) })),
      );
    expect(cellLines.map((n) => n.text)).toEqual(['氏名', '部署']);
    expect(cellLines[1].y).toBeGreaterThan(cellLines[0].y);
    expect(await dialog.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`review-preview-${width}.png`), fullPage: true });
    const report = await officeDownload(page, dialog, 'Download import report');
    await dialog.getByLabel('Accept import conversions').check();
    await dialog.getByRole('button', { name: 'Create imported artifact', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const artifact = await nativeArtifact(page),
      deck = artifact.draft.content as SlideContent,
      slide = deck.slides[0];
    expect(slide.objects.find((o) => o.type === 'group')?.hidden).toBe(true);
    expect(slide.objects.find((o) => o.text === '非表示の受付')).toBeDefined();
    expect(slide.objects.find((o) => o.type === 'table')?.table?.rows[0][0]).toBe('氏名\n部署');
    expect(slide.notes).toBe('第一段落\n続き\n\n次の段落');
    const svg = exportSlideSvg(deck, slide);
    expect(svg).not.toContain('非表示の');
    await save(page, 1);
    await page.reload();
    await expect(
      page.getByRole('application', { name: 'Slide canvas', exact: true }),
    ).toBeVisible();
    expect((await nativeArtifact(page)).draft.content).toEqual(deck);
    const output = await openPptx(page);
    await output.getByRole('checkbox', { name: 'Include speaker notes', exact: true }).check();
    await preparePptx(output);
    await expect(output.getByLabel('PPTX counts')).toContainText('Errors: 0');
    await acceptPptx(output);
    const bytes = await officeDownload(page, output, 'Download PPTX');
    const archive = unzipSync(bytes),
      xml = strFromU8(archive['ppt/slides/slide1.xml']);
    expect(xml).not.toContain('非表示の');
    expect(xml.toLowerCase()).toContain('val="ff0000"');
    expect(xml).toContain('氏名');
    expect(xml).toContain('部署');
    expect(strFromU8(archive['ppt/notesSlides/notesSlide1.xml'])).toContain('次の段落');
    await mkdir(info.outputPath('corpus'), { recursive: true });
    await writeFile(info.outputPath('corpus/review-source.pptx'), input);
    await writeFile(info.outputPath('corpus/review-export.pptx'), bytes);
    await writeFile(
      info.outputPath('corpus/review-native.json'),
      JSON.stringify(artifact, null, 2),
    );
    await writeFile(info.outputPath('corpus/review-report.json'), report);
    await writeFile(info.outputPath('corpus/review.svg'), svg);
  });
}
