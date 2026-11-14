import { test, expect } from './fixtures';

test.skip(({ baseURL }) => /:4177$/.test(baseURL ?? ''), 'Playground only');

/** Narrow layouts show panels as drawers over the manuscript; open or close them explicitly. */
async function inspector(page: import('@playwright/test').Page) {
  const panel = page.getByRole('complementary', { name: '原稿と照合' });
  if (!(await panel.isVisible()))
    await page.getByRole('button', { name: 'Toggle 原稿と照合', exact: true }).click();
  return panel;
}
async function closeInspector(page: import('@playwright/test').Page) {
  const close = page.getByRole('button', { name: 'Close 原稿と照合', exact: true });
  if ((await close.isVisible()) && (await page.viewportSize())!.width <= 800) await close.click();
}

test('novel demo: sample chapters open in the novel workspace with ruby, notation and 通読', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: '小説デモを作成', exact: true }).click();
  const workspace = page.locator('[data-workspace]');
  await expect(workspace).toHaveAttribute('data-workspace', 'novel');
  // The Host keeps the three chapters' order; each chapter starts with a saved version.
  const order = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('editor-platform.novel-chapters.'))
      .map((k) => JSON.parse(localStorage.getItem(k)!) as string[]),
  );
  expect(order).toHaveLength(3);
  expect(new Set(order.map((ids) => ids.join()))).toHaveProperty('size', 1);
  await expect(page.getByRole('textbox', { name: 'Artifact name' })).toHaveValue(
    /灯台守の手紙\s第一章/,
  );
  // The sample manuscript is vertical and carries ruby and 傍点.
  await expect(page.getByRole('button', { name: '縦書き', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const editor = page.locator('.ProseMirror').first();
  await expect(editor.locator('.ep-ruby[data-ruby="とうだい"]')).toBeVisible();
  await expect(editor).toContainText('灯台');
  await page.screenshot({ path: info.outputPath('novel-demo.png') });

  // Notation findings become a proposal; the manuscript changes only after Apply.
  const panel = await inspector(page);
  await expect(panel).toContainText('表記の照合（2件）');
  await panel.getByRole('checkbox', { name: '「不図」を「ふと」に直す' }).check();
  await panel.getByRole('button', { name: '選んだ直しを提案', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'External proposal preview' });
  await expect(review).toContainText('表記の直し（1件）');
  await expect(editor).toContainText('不図、');
  await review.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  await expect(editor).toContainText('ふと、祖母の言葉');
  await expect(panel).toContainText('表記の照合（1件）');

  // 通読 joins the saved chapters, not the unsaved draft.
  await closeInspector(page);
  await page.getByRole('button', { name: '通読', exact: true }).click();
  const reading = page.getByRole('article', { name: '通読' });
  await expect(reading).toContainText('第一章');
  await expect(reading).toContainText('第三章');
  await expect(reading).toContainText('不図、');
  await page.screenshot({ path: info.outputPath('novel-demo-reading.png') });
  await page.getByRole('button', { name: '執筆', exact: true }).click();

  // The workspace choice survives a reload.
  await page.reload();
  await expect(workspace).toHaveAttribute('data-workspace', 'novel');
});

test('new novel: chooses horizontal and the number of chapters, keeps a character goal and lists range notes', async ({
  page,
}, info) => {
  await page.goto('/');
  const library = page.getByRole('complementary', { name: 'Artifact library' });
  if (!(await library.isVisible()))
    await page
      .getByRole('button', { name: /library/i })
      .first()
      .click();
  await library.getByText('小説を作成', { exact: true }).click();
  await library.getByLabel('小説の題名').fill('港の話');
  await library.getByLabel('小説の組み方').selectOption('horizontal-tb');
  await library.getByLabel('小説の章の数').fill('2');
  await library.getByRole('button', { name: '小説を新規作成', exact: true }).click();
  const workspace = page.locator('[data-workspace]');
  await expect(workspace).toHaveAttribute('data-workspace', 'novel');
  await expect(page.getByRole('textbox', { name: 'Artifact name' })).toHaveValue(/港の話\s第一章/);
  await expect(page.getByRole('button', { name: '縦書き', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const order = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('editor-platform.novel-chapters.'))
      .map((k) => JSON.parse(localStorage.getItem(k)!) as string[]),
  );
  expect(order).toHaveLength(2);

  const editor = page.locator('.ProseMirror').first();
  await editor.locator('p').first().click();
  await page.keyboard.type('坂の上に灯台がある。');
  const panel = await inspector(page);
  const goal = panel.getByLabel('文字数の目標');
  await goal.fill('20');
  await goal.press('Enter');
  await expect(panel.getByLabel('目標までの進み具合')).toContainText('残り');
  await page.screenshot({ path: info.outputPath('novel-new-goal.png') });

  // A range note from the Host's comments shows in the novel screen and jumps to its paragraph.
  await closeInspector(page);
  const paragraph = editor.locator('p').first();
  await paragraph.click({ clickCount: 3 });
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /^Comments \(/ }).click();
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Leave a note on this selection…').fill('灯台の位置を確認');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  const notes = (await inspector(page)).getByRole('list', { name: '範囲の指摘' });
  await expect(notes).toContainText('灯台の位置を確認');
  await expect(await inspector(page)).toContainText('範囲の指摘（未解決1件）');
  await expect(notes.getByRole('button')).toContainText('灯台の位置を確認');
  // Once the noted sentence is gone, the note no longer points at the paragraph's new text.
  await closeInspector(page);
  await paragraph.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('別の文。');
  await expect((await inspector(page)).getByRole('list', { name: '範囲の指摘' })).toContainText(
    '元の範囲がこの章にありません',
  );
  await expect(notes.getByRole('button')).toHaveCount(0);

  await page.reload();
  await expect(workspace).toHaveAttribute('data-workspace', 'novel');
  await expect(page.locator('.ProseMirror').first()).toContainText('別の文');
  await expect((await inspector(page)).getByLabel('文字数の目標')).toHaveValue('20');
});
