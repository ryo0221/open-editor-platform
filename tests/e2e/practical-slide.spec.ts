import { test, expect, nativeArtifact } from './fixtures';
import { openWhole } from './template-fixtures';
import { prototypeImage } from './authored-image';
import {
  collaborate,
  confirmed,
  download,
  finish,
  insertFragment,
  renderSvg,
  renderImage,
  renderPdf,
  screenshot,
  value,
} from './practical-fixtures';
import type { SlideContent } from '@editor-platform/slide/model';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

test('QL-02 ten-page proposal: page operations, group, picture/table/chart, peers, presentation and deck export', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(12000);
  await page.goto('/');
  const form = await openWhole(page, 'slide', '企画提案');
  for (const [slot, text] of Object.entries({
    title: '受付改善の提案',
    summary: '待ち時間を減らし、安心して手続きを完了できる受付へ。',
    'left.title': '現状の受付',
    'left.items': '記入に八分かかる\n案内が分散している\n確認の往復が多い',
    'right.title': '改善の試行',
    'right.items': '入力を三分へ\n案内を一か所へ\n保存前に確認',
    conclusion: '二週間の試行で受付時間と完了率を比較し、次の改善を決めます。',
  }))
    await form.locator(`[data-slot="${slot}"]`).fill(text);
  await form.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await form.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(form).toHaveCount(0);
  for (const layout of ['title', 'image-caption', 'comparison', 'chart', 'title']) {
    await page.getByRole('button', { name: 'Add slide layout', exact: true }).click();
    await page.getByRole('button', { name: layout, exact: true }).click();
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Duplicate slide', exact: true }).click();
  await insertFragment(page, '左右比較ページ', {
    'left.title': '計測すること',
    'left.items': '受付時間\n完了率',
    'right.title': '継続の条件',
    'right.items': '三分以内\n八十五パーセント以上',
  });
  const titles = [
    '受付改善の提案',
    '現状と試行',
    '合意した次の一歩',
    '利用者の声',
    '試作画面',
    '選択肢の比較',
    '計測結果',
    '実施計画',
    '担当と日程',
    '継続の判断',
  ];
  const canvas = page.getByRole('application', { name: 'Slide canvas', exact: true });
  if (
    !(await page
      .getByRole('button', { name: 'Toggle Slide inspector', exact: true })
      .getAttribute('aria-pressed')) ||
    (await page
      .getByRole('button', { name: 'Toggle Slide inspector', exact: true })
      .getAttribute('aria-pressed')) === 'false'
  )
    await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  for (let n = 0; n < 10; n++) {
    await value(page, 'Current page', String(n + 1));
    await value(page, 'Slide title', titles[n]);
    const deck = (await nativeArtifact(page)).draft.content as SlideContent;
    if (n >= 3 && n < 9) {
      for (const [i, o] of deck.slides[n].objects.entries()) {
        await canvas
          .getByRole('button', { name: `${o.type} object ${i + 1}`, exact: true })
          .click();
        if (o.type === 'text')
          await value(
            page,
            'Text',
            i === 0 ? titles[n] : '受付の手順を整理し、担当者と来訪者の両方で確認します。',
          );
        if (o.type === 'table') {
          const cells = [
            ['評価項目', '現状', '試作'],
            ['入力時間', '八分', '三分'],
            ['完了率', '65%', '85%'],
            ['確認方法', '口頭', '保存前確認'],
          ];
          for (const [r, row] of cells.entries())
            for (const [c, text] of row.entries())
              await value(page, `Cell ${r + 1},${c + 1}`, text);
        }
        if (o.type === 'chart') {
          await value(page, 'Chart title', '完了率（%）');
          await page.getByLabel('Chart data', { exact: true }).fill('現状\t65\n試作\t76\n目標\t85');
          await page.getByRole('button', { name: 'Apply chart data', exact: true }).click();
        }
      }
    }
    if (n === 4) {
      await canvas.getByRole('button', { name: 'shape object 2', exact: true }).click();
      await canvas.press('Delete');
      await page.getByLabel('Insert image file').setInputFiles({
        name: '受付の試作.png',
        mimeType: 'image/png',
        buffer: await prototypeImage(page),
      });
      for (const [label, text] of [
        ['Element x', '60'],
        ['Element y', '140'],
        ['Element width', '840'],
        ['Element height', '300'],
      ])
        await value(page, label, text);
      await page.getByLabel('Image fit', { exact: true }).selectOption('fit');
      await page.getByRole('button', { name: 'Crop image', exact: true }).click();
      await value(page, 'Crop scale', '1.1');
      await page.getByRole('button', { name: 'Apply crop', exact: true }).click();
    }
  }
  await value(page, 'Current page', '1');
  for (const [shape, x] of [
    ['rectangle', '80'],
    ['ellipse', '350'],
  ]) {
    await page.getByRole('button', { name: 'Insert shapes', exact: true }).click();
    await page.getByRole('button', { name: `Insert ${shape}`, exact: true }).click();
    await page.keyboard.press('Escape');
    await value(page, 'Element x', x);
    await value(page, 'Element y', '340');
    await value(page, 'Text', shape === 'rectangle' ? '現在の受付' : '改善の試行');
  }
  await canvas.getByRole('button', { name: 'shape object 3', exact: true }).click();
  await canvas
    .getByRole('button', { name: 'shape object 4', exact: true })
    .click({ modifiers: ['Shift'] });
  const arrange = async (action: string) => {
    await page.getByRole('button', { name: 'Arrange', exact: true }).click();
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.keyboard.press('Escape');
  };
  await arrange('Align top');
  await arrange('Group');
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: /^Select group object \d+$/ }).click();
  await value(page, 'Element width', '620');
  const grouped = ((await nativeArtifact(page)).draft.content as SlideContent).slides[0].objects;
  expect(grouped.find((o) => o.type === 'group')!.bounds.width).toBe(620);
  expect(grouped.filter((o) => o.groupId)).toHaveLength(2);
  const shared = await collaborate(page, browser, baseURL, 'slide');
  await value(page, 'Current page', '9');
  const beforeOrder = ((await nativeArtifact(page)).draft.content as SlideContent).slides.map(
    (s) => s.id,
  );
  await page.getByRole('button', { name: 'Move slide up', exact: true }).click();
  await confirmed(page);
  expect(
    ((await nativeArtifact(page)).draft.content as SlideContent).slides.map((s) => s.id),
  ).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 7, 9].map((i) => beforeOrder[i]));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(page);
  expect(
    ((await nativeArtifact(page)).draft.content as SlideContent).slides.map((s) => s.id),
  ).toEqual(beforeOrder);
  await value(page, 'Current page', '1');
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const show = page.getByRole('dialog', { name: 'Slide presentation', exact: true });
  for (let i = 0; i < 10; i++) {
    await expect(show).toBeVisible();
    await screenshot(page, `slide-present-${i + 1}`);
    if (i < 9) await show.getByRole('button', { name: 'Next slide', exact: true }).click();
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  const pdfBytes = await download(page, 'Export PDF', 'proposal-deck.pdf'),
    pdf = await PDFDocument.load(pdfBytes);
  expect(pdf.getPageCount()).toBe(10);
  for (const p of pdf.getPages()) {
    const images = p.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const bitmap = images.lookup(images.keys()[0]);
    expect(bitmap).toBeInstanceOf(PDFRawStream);
    expect(decodePDFRawStream(bitmap as PDFRawStream).decode().length).toBeGreaterThan(100000);
  }
  await renderPdf(page, pdfBytes, 'slide-pdf', 10);
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  const svg = await download(page, 'Export SVG', 'proposal-slide.svg');
  await renderSvg(page, svg, 'slide-svg');
  await value(page, 'Current page', '5');
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  const png = await download(page, 'Export PNG', 'proposal-slide.png');
  await renderImage(page, png, 'slide-png', 'image/png');
  await shared.close();
  await finish(page, browser, baseURL, 'slide');
});
