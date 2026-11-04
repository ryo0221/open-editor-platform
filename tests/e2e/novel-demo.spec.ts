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
