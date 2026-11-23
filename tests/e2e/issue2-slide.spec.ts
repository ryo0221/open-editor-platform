import { test, expect, nativeArtifact, create } from './fixtures';
import { prototypeImage } from './authored-image';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFDict, PDFRawStream, PDFName, decodePDFRawStream } from 'pdf-lib';
import { commitVersion, contentHash, createArtifact } from '@editor-platform/artifact-core';
import { createLiveReference } from '@editor-platform/artifact-references';
import {
  addSlide,
  createDeck,
  insertObject,
  insertSlideCitation,
  slideMotionCommand,
  updateSlide,
  type SlideContent,
} from '@editor-platform/slide/model';
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
  await page.getByRole('dialog').getByRole('button', { name: 'この版を保存', exact: true }).click();
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
  await page
    .getByRole('dialog', { name: 'Slide export' })
    .getByRole('button', { name: 'Export file' })
    .click();
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
test('#589 an arrow runs vertically or diagonally, saved and drawn that way', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Slide Deck', exact: true }).click();
  await insertShape(page, 'arrow');
  await number(page, 'Element width', '120');
  await number(page, 'Element height', '160');
  const direction = page.getByLabel('Line direction', { exact: true });
  await expect(direction).toHaveValue('horizontal');
  await direction.selectOption('down');
  const deck = (await nativeArtifact(page)).draft.content as SlideContent;
  const arrow = deck.slides[0]!.objects.at(-1)!;
  expect(arrow).toMatchObject({ shape: 'arrow', lineDirection: 'down' });
  const canvas = page.getByRole('application', { name: 'Slide canvas' });
  await expect(canvas.locator('path[d="M0 0 L120 160"]')).toHaveCount(1);
  await direction.selectOption('vertical');
  await expect(canvas.locator('path[d="M60 0 L60 160"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(direction).toHaveValue('down');
  await page.screenshot({ path: info.outputPath('slide-589-arrow-direction.png') });
});

test('Slide motion editor commits native steps and rejects duplicate targets and IME activation', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Slide Deck', exact: true }).click();
  await insertShape(page, 'triangle');
  await insertShape(page, 'ellipse');
  const panel = page.getByRole('complementary', { name: 'Slide inspector' });
  await panel.getByText('Motion', { exact: true }).click();
  await panel.getByRole('button', { name: 'Add step', exact: true }).click();
  const add = panel.getByRole('group', { name: 'Add step' });
  await add.getByLabel('Effect type').selectOption('slide-in');
  await add.getByLabel('Direction').selectOption('up');
  const duration = add.getByLabel('Duration (ms)', { exact: true });
  await duration.fill('250');
  await duration.dispatchEvent('compositionstart');
  await add.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Step 1', exact: true })).toHaveCount(0);
  await duration.dispatchEvent('compositionend');
  await add.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Step 1', exact: true })).toBeVisible();
  await expect(
    panel.getByRole('group', { name: 'Edit effect' }).getByLabel('Direction'),
  ).toHaveValue('up');

  await panel.getByRole('button', { name: 'Add effect', exact: true }).click();
  const effect = panel.getByRole('group', { name: 'Add effect' });
  await effect.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('An object can have only one effect per step.');
  await expect(panel.getByRole('alert')).toBeFocused();
  const target = effect.getByLabel('Target');
  const selected = await target.inputValue();
  const other = await target
    .locator('option')
    .evaluateAll(
      (options, current) =>
        options
          .map((option) => (option as HTMLOptionElement).value)
          .find((value) => value !== current),
      selected,
    );
  await target.selectOption(other!);
  await effect.getByLabel('Position').selectOption({ index: 0 });
  await effect.getByLabel('Previous first effect').selectOption('with-previous');
  await effect.getByRole('button', { name: 'Apply', exact: true }).click();
  const edited = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(edited.slides[0].steps![0].effects.map((item) => item.trigger)).toEqual([
    'on-click',
    'with-previous',
  ]);

  await panel.getByRole('button', { name: 'Move effect…', exact: true }).click();
  const move = panel.getByRole('group', { name: 'Move effect…' });
  await move.getByLabel('Destination').selectOption({ label: 'New step' });
  await move.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Step 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Step 2', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Step 2', exact: true })).toBeVisible();

  const transition = panel.getByRole('group', { name: 'Page transition' });
  await transition.getByLabel('Transition type').selectOption('fade');
  await transition.getByLabel('Transition duration (ms)').fill('700');
  await transition.getByRole('button', { name: 'Apply', exact: true }).click();
  await panel.locator('.ep-panel-content').evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({ path: info.outputPath('slide-motion-inspector.png') });
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Read only', { exact: true }).check();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Add step', exact: true })).toBeDisabled();
  await expect(transition.getByLabel('Transition type')).toBeDisabled();
  await expect(transition.getByLabel('Transition type')).toHaveValue('fade');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 844 });
  const toggleInspector = page.getByRole('button', { name: 'Toggle Slide inspector', exact: true });
  if (!(await panel.isVisible())) await toggleInspector.click();
  await expect(transition.getByLabel('Transition type')).toHaveValue('fade');
  await panel.getByRole('button', { name: 'Close Slide inspector', exact: true }).click();
  const overflow = page.getByRole('button', { name: 'More editor tools', exact: true });
  await overflow.click();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const show = page.getByRole('dialog', { name: 'Slide presentation' });
  await expect(show.getByText('Initial / 2 steps')).toBeVisible();
  const advance = show.getByRole('button', { name: 'Next slide' });
  const targetBox = (await advance.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 }],
  });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await expect(show.getByText('Step 1 / 2')).toBeVisible();
  await expect(advance).toBeEnabled();
  await page.screenshot({ path: info.outputPath('slide-motion-narrow.png') });
  await page.keyboard.press('Escape');
  await expect(overflow).toBeFocused();
});

test('Slide presentation plays steps and transitions, restores prior poses, and draws fixed quotes without editing marks', async ({
  page,
}, info) => {
  let deck = addSlide().apply(addSlide().apply(createDeck()));
  const [start, skipped, end] = deck.slides;
  deck = updateSlide(skipped.id, { hidden: true }).apply(deck);
  deck = insertObject(start.id, 'text', { text: 'First effect' }).apply(deck);
  const targetId = deck.slides[0].objects[0].id;
  deck = insertObject(end.id, 'text', { text: 'Final page' }).apply(deck);
  const source = {
    artifactId: 'estimate',
    domain: 'estimate',
    target: { kind: 'value' as const, targetId: 'cost', metricId: 'total' },
  };
  const captured = { amount: 42 };
  const reference = await createLiveReference(
    source,
    {
      artifactId: source.artifactId,
      domain: source.domain,
      versionId: 'version-1',
      revision: 1,
      content: captured,
      contentHash: await contentHash(captured),
      dependencies: [],
    },
    {
      checkAccess() {},
      checkSnapshot() {},
      list: () => [{ ...source.target, label: 'Total' }],
      resolve: () => ({ kind: 'value', value: captured.amount }),
    },
    { style: 'decimal', digits: 0, unit: '円' },
  );
  const quoteId = 'fixed-quote';
  deck = insertSlideCitation(start.id, quoteId, reference).apply(deck);
  deck = slideMotionCommand({
    type: 'slide.step.insert',
    slideId: start.id,
    effects: [
      {
        value: {
          targetId,
          trigger: 'on-click',
          phase: 'enter',
          effect: 'fade',
          delayMs: 0,
          durationMs: 1500,
        },
      },
      {
        value: {
          targetId: quoteId,
          trigger: 'with-previous',
          phase: 'enter',
          effect: 'fade',
          delayMs: 0,
          durationMs: 1500,
        },
      },
    ],
  }).apply(deck);
  deck = slideMotionCommand({
    type: 'slide.step.insert',
    slideId: start.id,
    effects: [
      {
        value: {
          targetId,
          trigger: 'on-click',
          phase: 'exit',
          effect: 'fade',
          delayMs: 0,
          durationMs: 100,
        },
      },
      {
        value: {
          targetId: quoteId,
          trigger: 'with-previous',
          phase: 'exit',
          effect: 'fade',
          delayMs: 0,
          durationMs: 100,
        },
      },
    ],
  }).apply(deck);
  deck = slideMotionCommand({
    type: 'slide.transition.set',
    slideId: end.id,
    transition: { kind: 'push', direction: 'left', durationMs: 1300 },
  }).apply(deck);
  deck = slideMotionCommand({
    type: 'slide.export.mp4.state-hold',
    slideId: start.id,
    stepId: deck.slides[0].steps![0].id,
    holdSeconds: 2.5,
  }).apply(deck);

  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'motion.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('slide', 'Motion example', deck))),
  });
  const thumb = page.getByRole('button', { name: /^Slide 1:/ });
  await expect(thumb.locator('svg')).toContainText('42');
  await expect(thumb.locator('svg')).not.toContainText('引用');
  await expect(page.locator('.ep-slide-live-quote')).toContainText('引用');
  const inspector = page.getByRole('complementary', { name: 'Slide inspector' });
  await inspector.getByText('Motion', { exact: true }).click();
  await inspector.getByRole('button', { name: 'Step 1', exact: true }).click();
  await inspector
    .getByRole('group', { name: 'Step 1' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(inspector.getByRole('status')).toContainText('2.5 s hold');
  await inspector.getByRole('button', { name: 'Confirm deletion' }).click();
  await expect(inspector.getByRole('button', { name: 'Step 2', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(inspector.getByRole('button', { name: 'Step 2', exact: true })).toBeVisible();
  expect(
    ((await nativeArtifact(page)).draft.content as SlideContent).exportSettings?.mp4?.holds?.[0]
      .holdSeconds,
  ).toBe(2.5);

  await test.step('reopen the saved motion and fixed quotation', async () => {
    await version(page);
    const saved = await nativeArtifact(page);
    const [snapshot] = saved.versions;
    expect(saved.draft.baseVersionId).toBe(snapshot.versionId);
    expect(snapshot.content).toEqual(deck);

    await page.reload();
    await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('Motion example');
    await expect(page.locator('.save-status')).toHaveText('Saved locally');
    const reopened = await nativeArtifact(page);
    expect(reopened.draft.baseVersionId).toBe(snapshot.versionId);
    expect(reopened.draft.content).toEqual(deck);
    expect(reopened.versions).toEqual(saved.versions);
    await expect(thumb.locator('svg')).toContainText('42');
    await page.screenshot({ path: info.outputPath('slide-motion-saved-reload.png') });
  });

  await page.getByRole('button', { name: /^Slide 2:/ }).click();
  const open = page.getByRole('button', { name: 'Present', exact: true });
  await open.click();
  const show = page.getByRole('dialog', { name: 'Slide presentation', exact: true });
  const number = show.getByLabel('Presentation page', { exact: true });
  const previous = show.getByRole('button', { name: 'Previous slide', exact: true });
  const next = show.getByRole('button', { name: 'Next slide', exact: true });
  const quote = show.locator('.ep-slide-live-quote-copy');
  const quoteMotion = show.locator('g[opacity]:has(> .ep-slide-live-quote-copy)');
  await expect(number).toHaveValue('2');
  await expect(show.getByText('Final page', { exact: true })).toBeVisible();
  await number.dispatchEvent('compositionstart');
  await number.press('Escape');
  await expect(show).toBeVisible();
  await number.dispatchEvent('compositionend');
  await number.fill('1');
  await number.press('ArrowUp');
  await expect(show.getByText('Final page', { exact: true })).toBeVisible();
  await number.fill('1');
  await number.press('Enter');
  await expect(show.getByText('Initial / 2 steps', { exact: true })).toBeVisible();
  await expect(show.getByText('First effect', { exact: true })).toHaveCount(0);
  await expect(quote).toHaveCount(0);
  await expect(previous).toBeDisabled();

  await page.keyboard.press('Space');
  await expect(quoteMotion).toHaveAttribute('opacity', /^0\.\d*[1-9]\d*$/);
  await expect(next).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(number).toHaveValue('1');
  await page.keyboard.press('ArrowLeft');
  await expect(show.getByText('First effect', { exact: true })).toHaveCount(0);
  await expect(quote).toHaveCount(0);
  await show.getByLabel('Presentation page 1', { exact: true }).click();
  await expect(show.getByText('Step 1 / 2', { exact: true })).toBeVisible();
  await expect(next).toBeEnabled();
  await expect(quote).toHaveText('42円');
  await expect(quoteMotion).toHaveAttribute('opacity', '1');
  await next.click();
  await expect(show.getByText('Step 2 / 2', { exact: true })).toBeVisible();
  await expect(show.getByText('First effect', { exact: true })).toHaveCount(0);
  await expect(quote).toHaveCount(0);
  await expect(next).toBeEnabled();
  await next.click();
  await expect(number).toHaveValue('2');
  await expect(next).toBeDisabled();
  await previous.click();
  await expect(number).toHaveValue('1');
  await expect(show.getByText('Step 2 / 2', { exact: true })).toBeVisible();
  await page.keyboard.press('PageUp');
  await expect(show.getByText('Step 1 / 2', { exact: true })).toBeVisible();
  await expect(show.getByText('First effect', { exact: true })).toBeVisible();
  await expect(quote).toBeVisible();
  await expect(quoteMotion).toHaveAttribute('opacity', '1');
  await page.screenshot({ path: info.outputPath('slide-motion-fixed-quote.png') });
  await page.keyboard.press('PageDown');
  await expect(show.getByText('First effect', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('slide-motion-presentation.png') });
  await page.keyboard.press('PageUp');
  await expect(show.getByText('Step 1 / 2', { exact: true })).toBeVisible();
  await expect(show.getByText('First effect', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(show).toBeHidden();
  await expect(open).toBeFocused();
  await expect(page.getByLabel('Current page', { exact: true })).toHaveValue('2');

  deck = {
    ...deck,
    slides: deck.slides.map((slide) => ({ ...slide, hidden: true })),
  };
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'hidden.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('slide', 'Skipped pages', deck))),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Skipped pages');
  await open.click();
  await expect(show.getByText('No visible slides', { exact: true })).toBeVisible();
  await expect(show.getByRole('button')).toHaveCount(1);
  await show.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(show).toBeHidden();
});

test('Slide PDF export uses completed poses and keeps temporary settings out of history', async ({
  page,
}, info) => {
  let deck = { ...createDeck(), width: 320, height: 180 };
  const [first] = deck.slides;
  deck = insertObject(first.id, 'shape', {
    shape: 'rectangle',
    bounds: { x: 20, y: 20, width: 100, height: 100 },
    fill: '#ff0000',
    stroke: '#ff0000',
  }).apply(deck);
  const targetId = deck.slides[0].objects[0].id;
  for (const phase of ['enter', 'exit'] as const) {
    deck = slideMotionCommand({
      type: 'slide.step.insert',
      slideId: first.id,
      effects: [
        {
          value: {
            targetId,
            phase,
            effect: 'fade',
            trigger: 'on-click',
            delayMs: 0,
            durationMs: 100,
          },
        },
      ],
    }).apply(deck);
  }
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'motion-pdf.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('slide', 'Motion PDF', deck))),
  });
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Slide export' });
  await expect(dialog.getByRole('status').first()).toHaveText('1 PDF page');
  await dialog.getByLabel('PDF pagination').selectOption('steps');
  await expect(dialog.getByRole('status').first()).toHaveText('3 PDF pages');
  await page.screenshot({ path: info.outputPath('slide-pdf-settings.png') });
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export file' }).click();
  const download = await pending;
  const pdf = await PDFDocument.load(await readFile((await download.path())!));
  expect(pdf.getPageCount()).toBe(3);
  const pixel = (index: number) => {
    const images = pdf.getPage(index).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const bitmap = images.lookup(images.keys()[0]);
    if (!(bitmap instanceof PDFRawStream)) throw Error('Expected an embedded page bitmap.');
    const data = decodePDFRawStream(bitmap).decode();
    const offset = (80 * 640 + 80) * 3;
    return Array.from(data.slice(offset, offset + 3));
  };
  expect([pixel(0), pixel(1), pixel(2)]).toEqual([
    [255, 255, 255],
    [255, 0, 0],
    [255, 255, 255],
  ]);
  expect((await nativeArtifact(page)).draft.content).toEqual(deck);
  await page.getByRole('button', { name: 'Export visual', exact: true }).click();
  await page.getByRole('button', { name: 'Export MP4', exact: true }).click();
  await expect(dialog.getByRole('status').first()).toHaveText('3.2 s · 96 frames · 320 × 180 px');
  await dialog.getByLabel('Default hold (seconds)').fill('0.5');
  await dialog.getByText('Slide 1', { exact: true }).click();
  const stepHold = dialog.getByLabel('Step 1 completed hold (seconds)');
  await expect(stepHold).toHaveValue('0.5');
  await stepHold.fill('0.25');
  await expect(dialog.getByRole('status').first()).toHaveText('1.45 s · 44 frames · 320 × 180 px');
  const row = dialog.locator('.slide-export-hold').filter({ hasText: 'Step 1 completed hold' });
  await row.getByRole('button', { name: 'Save to deck' }).click();
  await row.getByRole('button', { name: 'Use default' }).click();
  await expect(stepHold).toHaveValue('0.5');
  await expect(dialog.getByRole('status').first()).toHaveText('1.7 s · 51 frames · 320 × 180 px');
  await dialog.getByRole('tab', { name: 'MP4' }).press('ArrowLeft');
  await expect(dialog.getByRole('tab', { name: 'PDF' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export visual', exact: true })).toBeFocused();
  const savedDeck = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(savedDeck.exportSettings?.mp4).toEqual({
    holds: [{ slideId: first.id, stepId: deck.slides[0].steps![0].id, holdSeconds: 0.25 }],
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(deck);
});

test('Document conversion previews an exact saved version, appends atomically and creates a new deck', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const block = (id: string, type: 'heading' | 'paragraph' | 'table', text: string) => ({
    id,
    type,
    text,
    ...(type === 'table' && { cells: [['A']] }),
  });
  const content = {
    schemaVersion: 2,
    blocks: [
      block('h1', 'heading', '計画'),
      block('p1', 'paragraph', '本文の例'),
      block('h2', 'heading', '次の段階'),
    ],
  };
  const saved = await commitVersion(
    createArtifact('document', '変換する文書', content),
    null,
    '確認済み',
  );
  const source = {
    ...saved,
    draft: {
      ...saved.draft,
      content: {
        ...content,
        blocks: [...content.blocks, block('unsupported', 'table', '')],
      },
    },
  };
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'source.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(source)),
  });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('変換する文書');
  await expect(page.locator('.save-status')).toContainText('Saved locally');
  await create(page, 'slide');
  const destination = await nativeArtifact(page);

  const menu = page.getByRole('button', { name: 'Add slide layout', exact: true });
  const dialog = page.getByRole('dialog', { name: '文書から作る', exact: true });
  const actions = page.getByRole('button', { name: 'More artifact actions', exact: true });
  async function open() {
    await menu.click();
    await page.getByRole('button', { name: '文書から作る…', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '文書から作る' })).toBeFocused();
  }
  await open();
  await expect(dialog.getByLabel('保存版')).toContainText('v1 確認済み');
  await dialog.getByRole('radio', { name: 'このデッキの末尾に追加' }).check();
  await dialog.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await expect(dialog.getByText('生成ページ 2 枚', { exact: true })).toBeVisible();
  await dialog
    .locator('summary')
    .filter({ hasText: /^計画$/ })
    .click();
  await expect(dialog.getByText('本文の例', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('slide-document-preview.png') });
  await dialog.getByRole('button', { name: '末尾に追加', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
  await expect(page.getByLabel('Current page', { exact: true })).toHaveValue('2');
  const appended = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(appended.slides.map((slide) => slide.title).slice(1)).toEqual(['計画', '次の段階']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(((await nativeArtifact(page)).draft.content as SlideContent).slides).toHaveLength(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(appended);

  await test.step('reject append when the destination changes after preview', async () => {
    await open();
    await dialog.getByRole('radio', { name: 'このデッキの末尾に追加' }).check();
    await dialog.getByRole('button', { name: 'プレビュー', exact: true }).click();
    await expect(dialog.getByText('生成ページ 2 枚', { exact: true })).toBeVisible();
    const undo = page.getByRole('button', { name: 'Undo', exact: true, includeHidden: true });
    const redo = page.getByRole('button', { name: 'Redo', exact: true, includeHidden: true });
    // Submit a local history change behind the modal through the Host's Undo handler.
    await undo.evaluate((button: HTMLButtonElement) => button.click());
    await expect(redo).toBeEnabled();
    await expect(page.locator('.save-status')).toHaveText('Saved locally');

    await dialog.getByRole('button', { name: '末尾に追加', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('追加先のデッキが変わりました');
    await expect(dialog.getByRole('alert')).toBeFocused();
    await page.screenshot({ path: info.outputPath('slide-document-stale-destination.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const after = await nativeArtifact(page);
    expect(after.draft.content).toEqual(destination.draft.content);
    expect(after.versions).toEqual(destination.versions);
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();
    await redo.click();
    expect((await nativeArtifact(page)).draft.content).toEqual(appended);
  });

  for (const input of [
    {
      name: 'local JSON content changes',
      initial: content,
      changed: { ...content, blocks: [block('h1', 'heading', '変更後の文書')] },
      error: '文書の内容が変わりました',
    },
    {
      name: 'the selected saved version disappears from the native file',
      initial: source,
      changed: { ...source, draft: { ...source.draft, baseVersionId: null }, versions: [] },
      version: 'v1 確認済み',
      error: '指定された保存版が見つかりません',
    },
  ]) {
    await test.step(`reject append when ${input.name} after preview`, async () => {
      const before = await nativeArtifact(page);
      await open();
      await dialog.getByRole('radio', { name: 'このデッキの末尾に追加' }).check();
      await dialog.getByLabel('文書を選ぶ').selectOption({ label: 'ローカル JSON' });
      const fileInput = dialog.getByLabel('Document JSON', { exact: true });
      await fileInput.setInputFiles({
        name: 'conversion-source.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(input.initial)),
      });
      if (input.version) await dialog.getByLabel('保存版').selectOption({ label: input.version });
      await dialog.getByRole('button', { name: 'プレビュー', exact: true }).click();
      await expect(dialog.getByText('生成ページ 2 枚', { exact: true })).toBeVisible();

      // Keep the selection and preview while simulating changed bytes at the next read.
      await fileInput.evaluate((element: HTMLInputElement, text) => {
        element.files![0].text = async () => text;
      }, JSON.stringify(input.changed));
      await dialog.getByRole('button', { name: '末尾に追加', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText(input.error);
      await expect(dialog.getByRole('alert')).toBeFocused();
      if (input.version)
        await page.screenshot({ path: info.outputPath('slide-document-missing-version.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      expect(await nativeArtifact(page)).toEqual(before);
      await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect(((await nativeArtifact(page)).draft.content as SlideContent).slides).toHaveLength(1);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      expect((await nativeArtifact(page)).draft.content).toEqual(appended);
    });
  }

  await actions.click();
  await page.getByLabel('Read only', { exact: true }).check();
  await actions.click();
  await open();
  await expect(dialog.getByRole('radio', { name: 'このデッキの末尾に追加' })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: '新しいデッキ' })).toBeChecked();
  await dialog.getByLabel('文書を選ぶ').selectOption({ label: 'ローカル JSON' });
  await dialog.getByLabel('Document JSON', { exact: true }).setInputFiles({
    name: 'source.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(source)),
  });
  await dialog.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(/4 件目のブロック（table）.*変換できません/);
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'デッキを作る', exact: true })).toBeDisabled();
  await dialog.getByLabel('保存版').selectOption({ label: 'v1 確認済み' });
  await dialog.getByLabel('デッキ名').fill('変換結果');
  await dialog.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await dialog.getByRole('button', { name: 'デッキを作る', exact: true }).click();
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('変換結果');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const created = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(created.slides.map((slide) => slide.title)).toEqual(['計画', '次の段階']);

  await actions.click();
  await page.getByLabel('Read only', { exact: true }).uncheck();
  await actions.click();
  const review = page.getByRole('dialog', { name: 'External proposal preview', exact: true });
  await actions.click();
  await page.getByRole('button', { name: 'External proposal demo', exact: true }).click();
  await expect(review.getByText('生成ページ 2 枚', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Reject proposal', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(created);
  await actions.click();
  await page.getByRole('button', { name: 'External proposal demo', exact: true }).click();
  await review.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  await expect(review).toBeHidden();
  const proposalApplied = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(proposalApplied.slides).toHaveLength(4);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(created);

  await test.step('reject a proposed append when edit access is revoked after preview', async () => {
    const before = await nativeArtifact(page);
    await actions.click();
    await page.getByRole('button', { name: 'External proposal demo', exact: true }).click();
    await expect(review.getByText('生成ページ 2 枚', { exact: true })).toBeVisible();
    // Change the Host's access state while the proposal dialog keeps the toolbar inert.
    await actions.evaluate((button: HTMLButtonElement) => button.click());
    const readOnly = page.getByLabel('Read only', { exact: true });
    await expect(readOnly).not.toBeChecked();
    await readOnly.evaluate((input: HTMLInputElement) => input.click());
    await expect(readOnly).toBeChecked();

    await review.getByRole('button', { name: 'Apply proposal', exact: true }).click();
    await expect(review.getByRole('alert')).toContainText('編集できるデッキを開き直してください');
    await expect(review.getByRole('alert')).toBeFocused();
    await page.screenshot({ path: info.outputPath('slide-document-revoked-permission.png') });
    await review.getByRole('button', { name: 'Reject proposal', exact: true }).click();
    await expect(review).toBeHidden();
    expect(await nativeArtifact(page)).toEqual(before);

    await actions.click();
    await readOnly.uncheck();
    await actions.click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(proposalApplied);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  });

  await actions.click();
  await page.getByRole('button', { name: '文書から新しいデッキを作る提案', exact: true }).click();
  await expect(review.getByText(/新しいデッキ ／ 変換する文書/)).toBeVisible();
  await review.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('変換する文書');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
