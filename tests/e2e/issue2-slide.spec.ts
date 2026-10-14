import { test, expect, nativeArtifact } from './fixtures';
import { prototypeImage } from './authored-image';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFDict, PDFRawStream, PDFName, decodePDFRawStream } from 'pdf-lib';
import type { SlideContent } from '@editor-platform/slide';
async function insertShape(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: 'Insert shapes', exact: true }).click();
  await page.getByRole('button', { name: `Insert ${name}`, exact: true }).click();
  await page.keyboard.press('Escape');
}
async function number(page: import('@playwright/test').Page, label: string, value: string) {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press('Enter');
}
async function version(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
}
async function replaceCanvasText(page: import('@playwright/test').Page, text: string) {
  const editor = page.getByLabel('Edit canvas text');
  // Use the editor's Select All command so ProseMirror owns the selection.
  // fill() selects only the DOM range, which its delayed focus sync can replace.
  await editor.press('Control+a');
  await page.keyboard.insertText(text);
  await expect(editor).toHaveText(text, { useInnerText: true });
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
}
test('H1 compact shell, panels, geometry and a five-page exported deck', async ({ page }, info) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByRole('button', { name: 'New Slide Deck', exact: true }).click();
  const viewport = page.getByTestId('editor-viewport');
  expect((await viewport.boundingBox())!.y).toBeLessThanOrEqual(112);
  await insertShape(page, 'triangle');
  await number(page, 'Element x', '80');
  await number(page, 'Element y', '160');
  await insertShape(page, 'ellipse');
  await number(page, 'Element x', '390');
  await number(page, 'Element y', '180');
  await insertShape(page, 'star');
  await number(page, 'Element x', '650');
  await number(page, 'Element y', '200');
  await page.getByRole('application', { name: 'Slide canvas' }).focus();
  await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: 'Arrange', exact: true }).click();
  await page.getByRole('button', { name: 'Align top', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Element y', { exact: true })).toHaveValue('160');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Element y', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('Element y', { exact: true })).toHaveValue('160');
  const openWidth = (await viewport.boundingBox())!.width;
  await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  expect((await viewport.boundingBox())!.width).toBeGreaterThan(openWidth + 280);
  await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  await expect(page.getByLabel('Element y', { exact: true })).toHaveValue('160');
  await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Slide navigator', exact: true }),
  ).toBeHidden();
  await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
  await page.screenshot({ path: info.outputPath('slide-geometry-after.png') });
  await number(page, 'Element y', '230');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Slide canvas' });
  await canvas.getByRole('button', { name: 'text object 4', exact: true }).dblclick();
  await replaceCanvasText(page, '日本語で伝える\n課題と次の一歩');
  expect(
    ((await nativeArtifact(page)).draft.content as SlideContent).slides[0].objects.find(
      (object) => object.type === 'text',
    )!.text,
  ).toBe('日本語で伝える\n課題と次の一歩');
  for (const layout of ['title', 'comparison', 'image-caption', 'chart']) {
    await page.getByRole('button', { name: 'Add slide layout', exact: true }).click();
    await page.getByRole('button', { name: layout, exact: true }).click();
    await page.keyboard.press('Escape');
  }
  await expect(page.getByLabel('Current page', { exact: true })).toHaveValue('5');
  const titles = ['課題と次の一歩', '利用者の声', '選択肢の比較', '試作と検証', '次期の目標'];
  const colors = ['#f3f8ff', '#fff3e6', '#eef8ef', '#f6efff', '#fff0f4'];
  const text = [
    '日本語で伝える\n課題と次の一歩',
    '毎日の入力を、もっと簡単に',
    '小さく試して、判断する',
    '二週間で試作し、五人に確認',
    '完了率を 65% から 85% へ',
  ];
  for (let i = 0; i < 5; i++) {
    await number(page, 'Current page', String(i + 1));
    await number(page, 'Slide title', titles[i]);
    await number(page, 'Slide background', colors[i]);
    await canvas
      .getByRole('button', { name: /^text object \d+$/, exact: true })
      .first()
      .dblclick();
    await replaceCanvasText(page, text[i]);
    if (i === 0) {
      for (const [label, value] of [
        ['Element x', '65'],
        ['Element y', '45'],
        ['Element width', '830'],
        ['Element height', '130'],
      ])
        await number(page, label, value);
    }
    if (i === 1) {
      await canvas.getByRole('button', { name: 'text object 2', exact: true }).dblclick();
      await replaceCanvasText(
        page,
        '迷いのない入力欄と、あとから確認できる記録。\nまずは毎日の作業時間を測定する。',
      );
    }
    if (i === 0) {
      for (const [j, label] of ['迷う入力欄', '確認の手間', '記録の分散'].entries()) {
        await canvas.getByRole('button', { name: `shape object ${j + 1}`, exact: true }).click();
        await number(page, 'Text', label);
        await number(page, 'Font size (px)', '24');
        await page.getByLabel('Text alignment', { exact: true }).selectOption('center');
        await page.getByLabel('Vertical alignment', { exact: true }).selectOption('middle');
      }
    }
    if (i === 2) {
      await canvas.getByRole('button', { name: 'table object 2', exact: true }).click();
      const cells = [
        ['評価項目', '現状の入力', '新しい試作'],
        ['入力時間', '8 分', '3 分'],
        ['確認方法', '個別に質問', '履歴で確認'],
        ['導入費用', '追加なし', '小さく試す'],
      ];
      for (const [row, values] of cells.entries())
        for (const [col, value] of values.entries())
          await number(page, `Cell ${row + 1},${col + 1}`, value);
    }
    if (i === 3) {
      await canvas.getByRole('button', { name: 'shape object 2', exact: true }).click();
      await canvas.press('Delete');
      await canvas.getByRole('button', { name: 'text object 2', exact: true }).dblclick();
      await replaceCanvasText(page, '試作画面：入力欄を整理し、保存までの手順を五人に確認する。');
      await page.getByLabel('Insert image file').setInputFiles({
        name: 'prototype.png',
        mimeType: 'image/png',
        buffer: await prototypeImage(page),
      });
      for (const [label, value] of [
        ['Element x', '60'],
        ['Element y', '140'],
        ['Element width', '840'],
        ['Element height', '300'],
      ])
        await number(page, label, value);
    }
    if (i === 4) {
      await canvas.getByRole('button', { name: 'chart object 2', exact: true }).click();
      await number(page, 'Chart title', '完了率（%）');
      await page.getByLabel('Chart data', { exact: true }).fill('現状\t65\n試作\t76\n目標\t85');
      await page.getByRole('button', { name: 'Apply chart data', exact: true }).click();
    }
  }
  await page.getByRole('button', { name: 'Previous slide', exact: true }).click();
  const beforeOrder = (await nativeArtifact(page)).draft.content as SlideContent;
  await page.getByRole('button', { name: 'Move slide up', exact: true }).click();
  await expect(page.getByLabel('Current page', { exact: true })).toHaveValue('3');
  const ordered = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(ordered.slides.map((s) => s.id)).toEqual(
    [0, 1, 3, 2, 4].map((i) => beforeOrder.slides[i].id),
  );
  for (const slide of ordered.slides)
    expect(slide).toEqual(beforeOrder.slides.find((s) => s.id === slide.id));
  // Aspect changes affect only the finite page boundary; preserve all object IDs and coordinates.
  await number(page, 'Current page', '2');
  await number(page, 'Current page', '3');
  await page.getByLabel('Slide size', { exact: true }).selectOption('960x720');
  expect(((await nativeArtifact(page)).draft.content as SlideContent).slides).toEqual(
    ordered.slides,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await version(page);
  await page.reload();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Slide presentation' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Slide presentation' })).toContainText(
    text[0].split('\n')[0],
  );
  await page
    .getByRole('dialog', { name: 'Slide presentation' })
    .getByRole('button', { name: 'Next slide' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Slide presentation' })).toContainText(text[1]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const file = await download;
  const path = info.outputPath('five-slide-deck.pdf');
  await file.saveAs(path);
  const pdf = await PDFDocument.load(await readFile(path));
  expect(pdf.getPageCount()).toBe(5);
  expect(pdf.getPage(0).getSize()).toEqual({ width: 720, height: 405 });
  // Each exported page is rasterized from the same page drawing. Decode actual pixels to verify order.
  for (let i = 0; i < 5; i++) {
    const resources = pdf.getPage(i).node.Resources()!;
    const images = resources.lookup(PDFName.of('XObject'), PDFDict);
    const bitmap = images.lookup(images.keys()[0]);
    if (!(bitmap instanceof PDFRawStream)) throw new Error('Expected an embedded page bitmap');
    const pixels = decodePDFRawStream(bitmap).decode();
    const color = colors[[0, 1, 3, 2, 4][i]];
    expect([...pixels.slice(0, 3)]).toEqual(
      [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16)),
    );
  }
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('slide-deck-after.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
