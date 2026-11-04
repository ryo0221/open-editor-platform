import { test, expect, insertDoc, setDocumentText } from './fixtures';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';

test.skip(
  ({ baseURL }) => !/:(?:4177|5177)$/.test(baseURL ?? ''),
  'Independent authoring fixture: E2E_SUITE=host',
);
test.beforeEach(async ({ page }) => {
  await page.goto('/authoring.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Document / Design authoring' })).toBeVisible();
});
const workspace = (page: import('@playwright/test').Page) => page.locator('[data-workspace]');
/** Narrow layouts show panels as drawers over the manuscript; close them before switching. */
async function closePanels(page: import('@playwright/test').Page) {
  const close = page.getByRole('button', { name: 'Close 原稿と照合', exact: true });
  if ((await close.isVisible()) && (await page.viewportSize())!.width <= 800) await close.click();
}
async function inspector(page: import('@playwright/test').Page) {
  const panel = page.getByRole('complementary', { name: '原稿と照合' });
  if (!(await panel.isVisible()))
    await page.getByRole('button', { name: 'Toggle 原稿と照合', exact: true }).click();
  return panel;
}

test('novel workspace edits the same chapter: selection, text and Undo survive switching', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Chapter 2', exact: true }).click();
  await page.getByRole('button', { name: 'Go to scene-night' }).click();
  const selection = await page.getByLabel('Selection', { exact: true }).textContent();
  const text = await page.getByLabel('Current text').textContent();
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  await expect(workspace(page)).toHaveAttribute('data-workspace', 'novel');
  await expect(page.getByRole('button', { name: 'Insert block', exact: true })).toHaveCount(0);
  // Switching is view-only: no content, selection or save-state change.
  await expect(page.getByLabel('Selection', { exact: true })).toHaveText(selection!);
  await expect(page.getByLabel('Current text')).toHaveText(text!);
  await expect(page.getByLabel('Save state')).toHaveText('Saved');
  const panel = await inspector(page);
  await expect(panel.getByLabel('文字数', { exact: true })).toHaveText('34字');
  await expect(panel.getByLabel('原稿用紙換算', { exact: true })).toContainText('約1枚');
  await expect(panel).toContainText('原稿用紙は禁則・ぶら下げを考えた近似です。');
  await expect(panel).toContainText('表記の照合（0件）');

  await setDocumentText(page, '[data-block-id="scene-morning"]', '朝のシーン。');
  await expect(panel).toContainText('表記の照合（1件）');
  const choice = panel.getByRole('checkbox', { name: '「シーン」を「場面」に直す' });
  await choice.check();
  // Editing the manuscript invalidates a choice made on the previous findings.
  await setDocumentText(page, '[data-block-id="scene-night"]', '夜のシーン。');
  await expect(panel).toContainText('表記の照合（2件）');
  await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await setDocumentText(page, '[data-block-id="scene-night"]', '夜の場面。');
  await expect(panel).toContainText('表記の照合（1件）');
  await choice.check();
  await panel.getByRole('button', { name: '選んだ直しを提案', exact: true }).click();
  const review = page.getByRole('article', { name: 'Semantic proposal' });
  await expect(review).toContainText('scene-morning');
  await expect(page.getByLabel('Current text')).toContainText('朝のシーン。');
  await review.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByLabel('Current text')).toContainText('朝の場面。');
  await expect(panel).toContainText('表記の照合（0件）');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Current text')).toContainText('朝のシーン。');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('Current text')).toContainText('朝の場面。');
  const edited = await page.getByLabel('Current text').textContent();
  await page.screenshot({ path: info.outputPath('novel-workspace.png') });

  await closePanels(page);
  await page.getByRole('button', { name: 'Documentで詳細編集', exact: true }).click();
  await expect(workspace(page)).toHaveAttribute('data-workspace', 'document');
  await expect(page.getByLabel('Current text')).toHaveText(edited!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Current text')).toContainText('朝のシーン。');
  // Hosts that do not offer the novel workspace keep EditorLayout as the Surface root.
  await page.getByRole('button', { name: 'Compose saved chapters' }).click();
  await expect(page.locator("[aria-label='Derived chapter output'] > .ep-layout")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('novel workspace waits for IME composition and stays view-only when read only', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const editor = page.locator('.ProseMirror').first();
  await editor.dispatchEvent('compositionstart', { data: '' });
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '入力・ドラッグの完了を待っています' }),
  ).toBeVisible();
  await expect(workspace(page)).toHaveAttribute('data-workspace', 'document');
  await editor.dispatchEvent('compositionend', { data: '' });
  await expect(workspace(page)).toHaveAttribute('data-workspace', 'novel');

  await page.getByLabel('Read only').check();
  await page.getByRole('button', { name: 'Documentで詳細編集', exact: true }).click();
  await expect(workspace(page)).toHaveAttribute('data-workspace', 'document');
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  await expect(workspace(page)).toHaveAttribute('data-workspace', 'novel');
  await expect(page.getByLabel('Current text')).toContainText('朝の場面。第1章の主人公が歩く。');
  await expect(page.getByRole('button', { name: '元に戻す', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('novel read-through shows saved chapters in order, never the unsaved draft', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  await setDocumentText(page, '[data-block-id="scene-morning"]', '未保存の朝。');
  await closePanels(page);
  await page.getByRole('button', { name: '通読', exact: true }).click();
  const reading = page.getByRole('article', { name: '通読' });
  await expect(reading).toBeVisible();
  await expect(reading.getByRole('heading', { name: '第1章' })).toBeVisible();
  await expect(reading.getByRole('heading', { name: '第3章' })).toBeVisible();
  await expect(reading).not.toContainText('未保存の朝。');
  await expect(page.locator('.ProseMirror').first()).toBeHidden();
  // The draft is still there, with its history, after returning to writing.
  await page.getByRole('button', { name: '執筆', exact: true }).click();
  await expect(reading).toHaveCount(0);
  await expect(page.getByLabel('Current text')).toContainText('未保存の朝。');
  await expect(page.getByLabel('Save state')).not.toHaveText('Saved');
  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByRole('button', { name: '通読', exact: true }).click();
  await expect(reading).toContainText('未保存の朝。');
  expect(errors).toEqual([]);
});

test('novel read-through explains why saved chapters cannot be composed', async ({ page }) => {
  // Block insertion lives in the overflow toolbar on phones; the message itself is layout-free.
  test.skip(page.viewportSize()!.width <= 800, 'Inserts a table through the desktop toolbar');
  await page.locator('[data-block-id="scene-night"]').click();
  await insertDoc(page, 'Table');
  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  await expect(page.getByRole('button', { name: '通読', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('status').filter({ hasText: '通読を作れません: Chapter 1' }),
  ).toBeVisible();
});

async function selectText(page: import('@playwright/test').Page, block: string, part: string) {
  await page.locator(block).evaluate((element, part) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(part);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + part.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return;
    }
    throw new Error(`Missing ${part}`);
  }, part);
}

test('novel ruby: set over a selection, undo, warn on a partial edit, read through', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  const panel = await inspector(page);
  await expect(panel.getByLabel('文字数', { exact: true })).toHaveText('34字');
  await closePanels(page);
  const morning = '[data-block-id="scene-morning"]';
  await selectText(page, morning, '主人公');
  await page.getByRole('button', { name: 'ルビ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ルビ' });
  await dialog.getByLabel('ルビの読み').fill('しゅじんこう');
  await dialog.getByRole('button', { name: 'ルビを付ける' }).click();
  const ruby = page.locator(`${morning} .ep-ruby`);
  await expect(ruby).toHaveText('主人公');
  await expect(ruby).toHaveAttribute('data-ruby', 'しゅじんこう');
  await expect(page.getByLabel('Save state')).not.toHaveText('Saved');
  // One Undo removes the reading; the text never changed.
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(ruby).toHaveCount(0);
  await expect(page.getByLabel('Current text')).toContainText('第1章の主人公が歩く。');
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect(ruby).toHaveAttribute('data-ruby', 'しゅじんこう');

  // Deleting part of the base keeps the reading but reports it.
  await selectText(page, morning, '公');
  await page.keyboard.press('Backspace');
  await expect(ruby).toHaveText('主人');
  const check = await inspector(page);
  await expect(check).toContainText('ルビの確認（1件）');
  await expect(check).toContainText('「主人」のルビ「しゅじんこう」は「主人公」に付けた読みです');
  await page.screenshot({ path: info.outputPath('novel-ruby.png') });
  await closePanels(page);
  // Re-setting the reading on the current base clears the warning.
  await selectText(page, morning, '主人');
  await page.getByRole('button', { name: 'ルビ', exact: true }).click();
  await expect(dialog.getByLabel('ルビの読み')).toHaveValue('しゅじんこう');
  await dialog.getByLabel('ルビの読み').fill('しゅじん');
  await dialog.getByRole('button', { name: 'ルビを付ける' }).click();
  await expect(ruby).toHaveAttribute('data-ruby', 'しゅじん');
  await expect(await inspector(page)).not.toContainText('ルビの確認');
  await closePanels(page);
  // 傍点 on a ruby goes to the other side, here and in the read-through.
  await selectText(page, morning, '主人');
  await page.getByRole('button', { name: '傍点', exact: true }).click();
  await expect(ruby.locator('.ep-emphasis')).toHaveCSS('text-emphasis-position', 'under left');

  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByRole('button', { name: '通読', exact: true }).click();
  const reading = page.getByRole('article', { name: '通読' });
  await expect(reading.locator('ruby').first()).toContainText('主人');
  await expect(reading.locator('ruby rt').first()).toHaveText('しゅじん');
  await expect(reading.locator('ruby .ep-emphasis').first()).toHaveCSS(
    'text-emphasis-position',
    'under left',
  );
  expect(errors).toEqual([]);
});

test('a pasted part of a ruby keeps the base it was set on and is reported', async ({ page }) => {
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  const night = '[data-block-id="scene-night"]';
  await selectText(page, night, '物語');
  await page.locator(night).evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      '<span class="ep-ruby" data-ruby="とうきょう" data-ruby-base="東京">東</span>',
    );
    data.setData('text/plain', '東');
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator(`${night} .ep-ruby`)).toHaveAttribute('data-ruby-base', '東京');
  await expect(await inspector(page)).toContainText(
    '「東」のルビ「とうきょう」は「東京」に付けた読みです',
  );
});

test('vertical manuscript keeps addresses, sets 1–2 digits upright and undoes as a setting', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  await closePanels(page);
  const morning = '[data-block-id="scene-morning"]';
  const pageBox = page.locator('.ep-document-page');
  await selectText(page, morning, '主人公');
  await expect(page.getByLabel('Selection', { exact: true })).toContainText('scene-morning');
  const horizontal = await page.getByLabel('Selection', { exact: true }).textContent();

  const toggle = page.getByRole('button', { name: '縦書き', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(pageBox).toHaveAttribute('data-writing-mode', 'vertical-rl');
  await expect(pageBox).toHaveCSS('writing-mode', 'vertical-rl');
  // Strict kinsoku on screen; the paper estimate states that it lays out kinsoku too.
  await expect(pageBox.locator('.ProseMirror')).toHaveCSS('line-break', 'strict');
  await expect(page.getByLabel('Current text')).toContainText('第1章の主人公が歩く。');
  // The same text range has the same address in vertical writing.
  await selectText(page, morning, '主人公');
  await expect(page.getByLabel('Selection', { exact: true })).toHaveText(horizontal!);
  const upright = page.locator(`${morning} .ep-tcy`);
  await expect(upright).toHaveText('1');
  await expect(upright).toHaveCSS('text-combine-upright', 'all');
  // Lines run top to bottom: the next character sits below, not to the right.
  const [a, b] = await page.locator(morning).evaluate((element) => {
    const text =
      element.firstChild!.nodeType === 3
        ? element.firstChild!
        : element.querySelector('*')!.firstChild!;
    const box = (i: number) => {
      const range = document.createRange();
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const r = range.getBoundingClientRect();
      return { x: r.x, y: r.y };
    };
    return [box(0), box(1)];
  });
  expect(Math.abs(a.x - b.x)).toBeLessThan(2);
  expect(b.y).toBeGreaterThan(a.y);

  // Typing and ruby work in vertical writing.
  await selectText(page, morning, '主人公');
  await page.getByRole('button', { name: 'ルビ', exact: true }).click();
  await page.getByRole('dialog', { name: 'ルビ' }).getByLabel('ルビの読み').fill('しゅじんこう');
  await page
    .getByRole('dialog', { name: 'ルビ' })
    .getByRole('button', { name: 'ルビを付ける' })
    .click();
  await expect(page.locator(`${morning} .ep-ruby`)).toHaveAttribute('data-ruby', 'しゅじんこう');
  await setDocumentText(page, '[data-block-id="scene-night"]', '夜の場面。12時を過ぎた。');
  await expect(page.locator('[data-block-id="scene-night"] .ep-tcy')).toHaveText('12');
  await page.screenshot({ path: info.outputPath('novel-vertical.png') });

  // The writing mode is a manuscript setting: Undo walks back through it.
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(pageBox).not.toHaveAttribute('data-writing-mode', 'vertical-rl');
  await expect(page.locator('.ep-tcy')).toHaveCount(0);
  await page.getByLabel('Read only').check();
  await expect(toggle).toBeDisabled();
  expect(errors).toEqual([]);
});

/** Narrow toolbars keep the export menu behind More editor tools. */
async function exportMenu(page: import('@playwright/test').Page) {
  const menu = page.getByRole('button', { name: 'Export document', exact: true });
  const more = page.getByRole('button', { name: 'More editor tools', exact: true });
  // A workspace switch commits before the responsive toolbar has measured its width.
  await expect.poll(async () => (await menu.isVisible()) || (await more.isVisible())).toBe(true);
  if (!(await menu.isVisible())) await more.click();
  await menu.click();
}
test('vertical manuscript prints and exports a vertical PDF with a searchable text layer', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  await closePanels(page);
  await setDocumentText(
    page,
    '[data-block-id="scene-night"]',
    '夜の場面。12時を過ぎた「静かな」町。',
  );
  await selectText(page, '[data-block-id="scene-morning"]', '主人公');
  await page.getByRole('button', { name: 'ルビ', exact: true }).click();
  await page.getByRole('dialog', { name: 'ルビ' }).getByLabel('ルビの読み').fill('しゅじんこう');
  await page
    .getByRole('dialog', { name: 'ルビ' })
    .getByRole('button', { name: 'ルビを付ける' })
    .click();
  // 傍点 toggles on the selection and shows beside the text in the editor and in the output.
  await selectText(page, '[data-block-id="scene-night"]', '静かな');
  const dots = page.getByRole('button', { name: '傍点', exact: true });
  await dots.click();
  await expect(page.locator('[data-block-id="scene-night"] .ep-emphasis')).toHaveText('静かな');
  await expect(dots).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '縦書き', exact: true }).click();
  await expect(page.locator('[data-block-id="scene-night"] .ep-emphasis')).toHaveCSS(
    'text-emphasis-style',
    // Chromium leaves out the default "filled".
    'sesame',
  );
  await page.screenshot({ path: info.outputPath('vertical-emphasis-editor.png') });
  // Output lives in the detailed Document view; the writing mode is the manuscript's own setting.
  await page.getByRole('button', { name: 'Documentで詳細編集', exact: true }).click();
  await expect(page.locator('.ep-document-page')).toHaveAttribute(
    'data-writing-mode',
    'vertical-rl',
  );
  await exportMenu(page);
  await page.getByRole('button', { name: 'Print preview', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Document print preview' });
  await expect(dialog.getByRole('img').first()).toBeVisible();
  // Keep the whole first page as rendered, independent of the dialog's scroll position.
  const png = await dialog
    .getByRole('img')
    .first()
    .evaluate((img: HTMLImageElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    });
  await writeFile(info.outputPath('vertical-print.png'), Buffer.from(png, 'base64'));
  const count = await dialog.getByRole('img').count();
  await page.getByRole('button', { name: 'Close Document print preview', exact: true }).click();
  await exportMenu(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const bytes = await readFile((await (await pending).path())!);
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(count);
  // The invisible text layer is rotated a quarter turn: text matrix 0 -k 1 0.
  const raw = bytes.toString('latin1');
  const streams = [...raw.matchAll(/stream\r?\n/g)].map((m) => {
    const start = m.index + m[0].length;
    const body = Buffer.from(raw.slice(start, raw.indexOf('endstream', start)), 'latin1');
    try {
      return inflateSync(body).toString('latin1');
    } catch {
      return body.toString('latin1');
    }
  });
  expect(streams.join('\n')).toMatch(/0 -[\d.]+ 1 0 [\d.]+ [\d.]+ Tm/);
  expect(errors).toEqual([]);
});

test('horizontal print preview draws ruby and 傍点', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '小説ワークスペース', exact: true }).click();
  await closePanels(page);
  await selectText(page, '[data-block-id="scene-morning"]', '主人公');
  await page.getByRole('button', { name: 'ルビ', exact: true }).click();
  await page.getByRole('dialog', { name: 'ルビ' }).getByLabel('ルビの読み').fill('しゅじんこう');
  await page
    .getByRole('dialog', { name: 'ルビ' })
    .getByRole('button', { name: 'ルビを付ける' })
    .click();
  await selectText(page, '[data-block-id="scene-morning"]', '歩く');
  await page.getByRole('button', { name: '傍点', exact: true }).click();
  await page.getByRole('button', { name: 'Documentで詳細編集', exact: true }).click();
  await exportMenu(page);
  await page.getByRole('button', { name: 'Print preview', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Document print preview' });
  await expect(dialog.getByRole('img').first()).toBeVisible();
  const png = await dialog
    .getByRole('img')
    .first()
    .evaluate((img: HTMLImageElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    });
  await writeFile(info.outputPath('horizontal-print.png'), Buffer.from(png, 'base64'));
  expect(errors).toEqual([]);
});
