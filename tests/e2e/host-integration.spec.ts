import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import type { Artifact } from '@editor-platform/artifact-core';
import type { HostContent } from '../../apps/artifact-host/src/model';
const studio = !!process.env.HOST_STUDIO_URL;
const names = studio
  ? {
      slide: 'SORA企画書',
      whiteboard: 'ビジネスモデルキャンバス',
      design: '製品サイト',
      code: '音声認識ソフト',
      data: '開発タスク',
    }
  : {
      slide: 'Presentation',
      whiteboard: 'Canvas',
      design: 'Product page',
      code: 'React source',
      data: 'Records / Kanban',
    };
async function open(page: Page, kind: keyof typeof names) {
  await page.getByRole('button', { name: names[kind] + 'を開く', exact: true }).click();
  await expect(page.getByLabel('成果物Editor', { exact: true })).toBeVisible();
}
async function tool(page: Page, name: string) {
  const target = page.getByRole('button', { name, exact: true });
  if (!(await target.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await target.click();
  const overflow = page.getByRole('dialog', { name: 'More editor tools', exact: true });
  if (await overflow.isVisible()) await page.keyboard.press('Escape');
}
// Settle the parent/frame scroll before Playwright's normal actionability checks.
// A single pointer click remains required; no forced click, retry or delay.
async function clickAfterScroll(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  await target.click();
}
async function clickInPreview(page: Page, target: Locator) {
  // An offscreen opaque frame can throttle its own rAF-based stability checks.
  // Bring its owner into view before asking Playwright to act inside it.
  await page
    .locator(
      studio ? 'iframe[title="SORA音声認識プレビュー"]' : 'iframe[title="Code隔離プレビュー"]',
    )
    .scrollIntoViewIfNeeded();
  await clickAfterScroll(target);
}
async function native(page: Page): Promise<Artifact<HostContent>> {
  const pending = page.waitForEvent('download');
  await clickAfterScroll(page.getByRole('button', { name: '成果物JSON保存', exact: true }));
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}
async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(name + '.png'), fullPage: true });
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('成果物一覧', { exact: true })).toBeVisible();
});
test('list → native Slide edit/save/back/reopen/reload with retained same-tab Undo', async ({
  page,
}, info) => {
  await expect(page.locator('.host-artifacts article')).toHaveCount(5);
  await open(page, 'slide');
  const before = await native(page);
  if (!('slides' in before.draft.content)) throw Error('Not Slide');
  await tool(page, 'Add slide');
  const edited = await native(page);
  if (!('slides' in edited.draft.content)) throw Error('Not Slide');
  expect(edited.draft.content.slides.length).toBe(before.draft.content.slides.length + 1);
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await expect(page.getByLabel('成果物一覧', { exact: true })).toBeVisible();
  await expect(page.locator(`[data-artifact-id="${before.id}"]`)).toContainText('保存済み');
  await expect(
    page.getByRole('img', { name: '保存した企画書 ' + before.id, exact: true }),
  ).toBeVisible();
  await expect(page.locator(`[data-artifact-id="${before.id}"]`)).toContainText(
    `${edited.draft.content.slides.length} pages`,
  );
  await open(page, 'slide');
  expect((await native(page)).id).toBe(before.id);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(before.draft.content);
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(edited.draft.content);
  await shot(page, info, 'slide');
  await page.reload();
  await open(page, 'slide');
  expect((await native(page)).draft.content).toEqual(edited.draft.content);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
});
test('Undo → surface switch → Redo survives repeated navigation without public revision edits', async ({
  page,
}) => {
  await open(page, 'slide');
  await tool(page, 'Add slide');
  const edited = await native(page);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  for (let i = 0; i < 3; i++) {
    await page
      .getByRole('navigation', { name: '開く成果物を変更' })
      .getByRole('button', { name: names.whiteboard, exact: true })
      .click();
    await page
      .getByRole('navigation', { name: '開く成果物を変更' })
      .getByRole('button', { name: names.slide, exact: true })
      .click();
  }
  await expect(page.getByRole('button', { name: 'Host Redo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(edited.draft.content);
  await expect(page.locator('.host-toolbar')).toContainText('Revision 3');
});
test('two artifacts of the same kind retain independent draft/history and explicit discard resets only one', async ({
  page,
}) => {
  await page
    .locator('.host-artifacts article')
    .filter({ has: page.getByRole('heading', { name: names.slide, exact: true }) })
    .getByRole('button', { name: '複製', exact: true })
    .click();
  await open(page, 'slide');
  await tool(page, 'Add slide');
  const original = await native(page);
  const copy = names.slide + ' (copy)';
  await page
    .getByRole('navigation', { name: '開く成果物を変更' })
    .getByRole('button', { name: copy, exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await tool(page, 'Add slide');
  await tool(page, 'Add slide');
  const copied = await native(page);
  expect(copied.id).not.toBe(original.id);
  await page
    .getByRole('navigation', { name: '開く成果物を変更' })
    .getByRole('button', { name: names.slide, exact: true })
    .click();
  expect((await native(page)).draft.content).toEqual(original.draft.content);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未保存の編集を破棄' })).toBeVisible();
  await page.getByRole('button', { name: '破棄してアプリに戻る', exact: true }).click();
  await open(page, 'slide');
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await page
    .getByRole('navigation', { name: '開く成果物を変更' })
    .getByRole('button', { name: copy, exact: true })
    .click();
  expect((await native(page)).draft.content).toEqual(copied.draft.content);
});
test('native Whiteboard edits/save/reopen use the same public command/history boundary', async ({
  page,
}, info) => {
  await open(page, 'whiteboard');
  const before = await native(page);
  if (!('nodes' in before.draft.content)) throw Error('Not board');
  await tool(page, 'Add sticky');
  const edited = await native(page);
  if (!('nodes' in edited.draft.content)) throw Error('Not board');
  expect(edited.draft.content.nodes.length).toBe(before.draft.content.nodes.length + 1);
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await open(page, 'whiteboard');
  expect((await native(page)).draft.content).toEqual(edited.draft.content);
  await shot(page, info, 'whiteboard');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(before.draft.content);
});
test('native Design edits generate actual standalone TSX, save and reuse in the Host app', async ({
  page,
}, info) => {
  await open(page, 'design');
  await page.getByLabel('ページ見出し', { exact: true }).fill('保存したReactページ');
  await page.getByRole('button', { name: 'React生成を採用・プレビュー', exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="Designから生成したReact"]')
      .getByRole('heading', { name: '保存したReactページ', exact: true }),
  ).toBeVisible();
  const zip = page.waitForEvent('download');
  await page.getByRole('button', { name: 'REACT出力', exact: true }).click();
  await (await zip).saveAs(info.outputPath('react-output.zip'));
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await expect(page.getByLabel('成果物一覧', { exact: true })).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title="アプリで再利用したReact出力"]')
      .getByRole('heading', { name: '保存したReactページ', exact: true }),
  ).toBeVisible();
  const reusedHeading = page
    .frameLocator('iframe[title="アプリで再利用したReact出力"]')
    .getByRole('heading', { name: '保存したReactページ', exact: true });
  await page.locator('iframe[title="アプリで再利用したReact出力"]').scrollIntoViewIfNeeded();
  await expect(reusedHeading).toBeInViewport();
  await shot(page, info, 'react-reuse');
  await page.reload();
  await expect(
    page
      .frameLocator('iframe[title="アプリで再利用したReact出力"]')
      .getByRole('heading', { name: '保存したReactページ', exact: true }),
  ).toBeVisible();
  await open(page, 'design');
  await expect(page.getByLabel('ページ見出し', { exact: true })).toHaveValue('保存したReactページ');
});
test('Code source editing/history/save/reopen and isolated Host execution', async ({
  page,
}, info) => {
  await open(page, 'code');
  const input = page.getByLabel(studio ? '音声認識Reactソース' : 'React TSXソース', {
    exact: true,
  });
  const source =
    "import React from 'react'; export default function Saved(){let isolated=false;try{parent.document.body;}catch{isolated=true;}return <h1>{isolated?'保存した隔離React':'Isolation failed'}</h1>;}";
  await input.fill(source);
  await clickAfterScroll(
    page.getByRole('button', { name: studio ? '▷ 実行' : '隔離プレビューを実行', exact: true }),
  );
  const frame = page.frameLocator(
    studio ? 'iframe[title="SORA音声認識プレビュー"]' : 'iframe[title="Code隔離プレビュー"]',
  );
  await expect(
    frame.getByRole('heading', { name: '保存した隔離React', exact: true }),
  ).toBeVisible();
  await expect(page.locator('iframe').first()).toHaveAttribute('sandbox', 'allow-scripts');
  await shot(page, info, 'code');
  await clickAfterScroll(page.getByRole('button', { name: '保存してアプリに戻る', exact: true }));
  await open(page, 'code');
  await expect(input).toHaveValue(source);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeEnabled();
  await clickAfterScroll(page.getByRole('button', { name: 'Host Undo', exact: true }));
  await expect(input).not.toHaveValue(source);
  await clickAfterScroll(page.getByRole('button', { name: 'Host Redo', exact: true }));
  await expect(input).toHaveValue(source);
});
test('Studio controlled transcript reaches Host text and ZIP downloads without manual typing', async ({
  page,
}) => {
  test.skip(!studio, 'Voice transcript is a Studio Host extension.');
  await open(page, 'code');
  const frame = page.frameLocator('iframe').first();
  await clickInPreview(page, frame.getByRole('button', { name: 'サンプル再生' }));
  const save = page.getByRole('button', { name: '文字起こし保存', exact: true });
  await expect(save).toBeEnabled();
  await expect(
    frame.getByText('サンプル完了。文字起こしを編集できます。', { exact: true }),
  ).toBeVisible();
  const text = await frame.locator('textarea').inputValue();
  const pending = page.waitForEvent('download');
  await clickAfterScroll(save);
  expect(await readFile((await (await pending).path())!, 'utf8')).toBe(text);
  const zipPending = page.waitForEvent('download');
  await clickAfterScroll(page.getByRole('button', { name: 'React ZIP出力', exact: true }));
  const zip = unzipSync(await readFile((await (await zipPending).path())!));
  expect(strFromU8(zip['transcript.txt'])).toBe(text);
  const source =
    "import React,{useState} from 'react'; function App(){const [text,setText]=useState('');return <><textarea value={text} onChange={e=>setText(e.target.value)}/><button onClick={()=>setText('Hostへ届く')}>更新</button><button onClick={()=>setText('')}>消去</button></>;} export {App as default};";
  await page.getByLabel('音声認識Reactソース', { exact: true }).fill(source);
  await clickAfterScroll(page.getByRole('button', { name: '▷ 実行', exact: true }));
  await clickInPreview(page, frame.getByRole('button', { name: '更新', exact: true }));
  await expect(save).toBeEnabled();
  const changed = page.waitForEvent('download');
  await clickAfterScroll(save);
  expect(await readFile((await (await changed).path())!, 'utf8')).toBe('Hostへ届く');
  await clickInPreview(page, frame.getByRole('button', { name: '消去', exact: true }));
  await expect(save).toBeDisabled();
});
test('Data Kanban/Grid preserve the same record IDs/values across status edit/save/reopen', async ({
  page,
}, info) => {
  await open(page, 'data');
  if (!studio) {
    const add = page.getByRole('button', { name: 'Add records', exact: true });
    if (!(await add.isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await add.click();
    await page.getByRole('button', { name: 'Add 1 record', exact: true }).click();
    await page.keyboard.press('Escape');
  }
  if (!(await page.getByLabel('Data projection', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByLabel('Data projection', { exact: true }).selectOption('Kanban');
  await page.keyboard.press('Escape');
  const select = page.getByLabel(/^Move .* to$/).first();
  await expect(select).toBeVisible();
  await select.selectOption(studio ? 'done' : 'Done');
  const changed = await native(page);
  if (!('rows' in changed.draft.content)) throw Error('Not Data');
  if (!(await page.getByLabel('Data projection', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByLabel('Data projection', { exact: true }).selectOption('Grid');
  await page.keyboard.press('Escape');
  expect((await native(page)).draft.content).toEqual(changed.draft.content);
  const column = changed.draft.content.columns[0];
  for (const panel of ['Data navigator', 'Data inspector']) {
    const close = page.getByRole('button', { name: 'Close ' + panel, exact: true });
    if (await close.isVisible()) await close.click();
  }
  await page.getByRole('gridcell', { name: `${column.name} · record 1`, exact: true }).click();
  await page.getByRole('grid', { name: 'Data grid', exact: true }).press('Enter');
  const cell = page.getByLabel(`Edit ${column.name}`, { exact: true });
  await cell.fill('Gridで更新した同じタスク');
  await cell.press('Enter');
  const gridEdited = await native(page);
  if (!('rows' in gridEdited.draft.content)) throw Error('Not Data');
  expect(gridEdited.draft.content.rows.map((r) => r.id)).toEqual(
    changed.draft.content.rows.map((r) => r.id),
  );
  expect(gridEdited.draft.content.rows[0].values[column.id]).toBe('Gridで更新した同じタスク');
  await shot(page, info, 'data-grid');
  if (!(await page.getByLabel('Data projection', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByLabel('Data projection', { exact: true }).selectOption('Kanban');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Move Gridで更新した同じタスク to', { exact: true })).toBeVisible();
  expect((await native(page)).draft.content).toEqual(gridEdited.draft.content);
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await open(page, 'data');
  expect((await native(page)).draft.content).toEqual(gridEdited.draft.content);
});
test('storage failure retains draft/history and retries through the normal save button', async ({
  page,
}) => {
  await open(page, 'slide');
  await tool(page, 'Add slide');
  const edited = await native(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('ep-sora-artifact:') || key.startsWith('ep-artifact-host:')) {
        Storage.prototype.setItem = original;
        throw new DOMException('Quota failure fixture', 'QuotaExceededError');
      }
      original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('save-failed');
  expect((await native(page)).draft.content).toEqual(edited.draft.content);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await expect(page.getByLabel('成果物一覧', { exact: true })).toBeVisible();
});
test('invalid native JSON is rejected and exported native envelope reopens with all retained versions', async ({
  page,
}) => {
  await page.locator('input[type=file]').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"kind":"slide","schemaVersion":99}'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.host-artifacts article')).toHaveCount(5);
  await open(page, 'slide');
  await tool(page, 'Add slide');
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await open(page, 'slide');
  const saved = await native(page);
  expect(saved.versions.length).toBe(1);
  await page.getByRole('button', { name: '編集を保持して戻る', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'native.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await open(page, 'slide');
  expect((await native(page)).versions).toEqual(saved.versions);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
});
test('read-only disables ordinary edit/history/save entrances and preserves exported content', async ({
  page,
}) => {
  await open(page, 'code');
  const before = await native(page);
  await page.getByLabel('閲覧モード', { exact: true }).check();
  await expect(
    page.getByLabel(studio ? '音声認識Reactソース' : 'React TSXソース', { exact: true }),
  ).toHaveAttribute('readonly', '');
  await expect(
    page.getByRole('button', { name: '保存してアプリに戻る', exact: true }),
  ).toBeDisabled();
  expect((await native(page)).draft.content).toEqual(before.draft.content);
});
test('unknown live access stays neutral and browser-local storage never claims owner-only', async ({
  page,
}, info) => {
  await expect(page.getByLabel('共有範囲', { exact: true })).toHaveText('共有設定はHostで確認');
  await expect(page.locator('body')).not.toContainText('Owner-only');
  await expect(page.locator('body')).not.toContainText('非公開');
  await page.getByRole('button', { name: '共有表示を再確認', exact: true }).click();
  await expect(page.getByLabel('共有範囲', { exact: true })).toHaveText('共有設定はHostで確認');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await shot(page, info, 'list');
});
test('ordinary native text commits before switching artifact and remains undoable', async ({
  page,
}) => {
  await open(page, 'slide');
  await tool(page, 'Insert text');
  const inserted = await native(page);
  if (!('slides' in inserted.draft.content)) throw Error('Not Slide');
  const target = inserted.draft.content.slides[0].objects.at(-1)!;
  const closeNavigator = page.getByRole('button', { name: 'Close Slide navigator', exact: true });
  if (await closeNavigator.isVisible()) await closeNavigator.click();
  const mobile = (page.viewportSize()?.width ?? 1440) < 600;
  if (mobile)
    await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  else await page.locator(`[data-canvas-target="${target.id}"]`).dblclick();
  const input = mobile
    ? page.getByLabel('Text', { exact: true })
    : page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await expect(input).toBeVisible();
  await input.fill('切替前に確定した本文');
  await page
    .getByRole('navigation', { name: '開く成果物を変更' })
    .getByRole('button', { name: names.whiteboard, exact: true })
    .click();
  await expect(page.getByLabel('成果物Editor')).toContainText(names.whiteboard);
  await page
    .getByRole('navigation', { name: '開く成果物を変更' })
    .getByRole('button', { name: names.slide, exact: true })
    .click();
  const changed = await native(page);
  expect(JSON.stringify(changed.draft.content)).toContain('切替前に確定した本文');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(JSON.stringify((await native(page)).draft.content)).not.toContain('切替前に確定した本文');
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(changed.draft.content);
});
test('Code syntax and runtime diagnostics retain source and allow recovery', async ({ page }) => {
  await open(page, 'code');
  const input = page.getByLabel(studio ? '音声認識Reactソース' : 'React TSXソース', {
    exact: true,
  });
  const run = page.getByRole('button', {
    name: studio ? '▷ 実行' : '隔離プレビューを実行',
    exact: true,
  });
  await input.fill('export default function Broken( {');
  await clickAfterScroll(run);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(input).toHaveValue('export default function Broken( {');
  await input.fill(
    "import React from 'react'; export default function Broken(){throw new Error('Host runtime fixture');}",
  );
  await clickAfterScroll(run);
  await expect(page.getByRole('alert')).toContainText('Host runtime fixture');
  await input.fill(
    "import React from 'react'; export default function Recovered(){return <h1>復旧したReact</h1>;}",
  );
  await clickAfterScroll(run);
  await expect(
    page
      .frameLocator(
        studio ? 'iframe[title="SORA音声認識プレビュー"]' : 'iframe[title="Code隔離プレビュー"]',
      )
      .getByRole('heading', { name: '復旧したReact' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('trusted access fixture invalidates private label, refetches, expires and handles all scopes', async ({
  page,
}) => {
  test.skip(
    studio,
    'Actual static Site has no live authenticated access adapter; fixture is reference Host only.',
  );
  await page.goto('/access.html');
  const scope = page.getByLabel('Host scope fixture', { exact: true });
  const label = page.getByLabel('共有範囲', { exact: true });
  await scope.selectOption('owner-only');
  await expect(label).toHaveText('非公開 · あなたのみ');
  await scope.selectOption('public');
  await expect(label).toHaveText('共有設定はHostで確認');
  await expect(label).toHaveText('公開');
  await expect(label).toHaveText('共有設定はHostで確認', { timeout: 3000 });
  await page.getByRole('button', { name: '共有表示を再確認' }).click();
  await expect(label).toHaveText('公開');
  await scope.selectOption('link');
  await expect(label).toHaveText('リンクを知っている人');
  await scope.selectOption('restricted');
  await expect(label).toHaveText('Hostが指定した範囲');
  await scope.selectOption('unknown');
  await expect(label).toHaveText('共有設定はHostで確認');
});

test('slow initial storage load gates import and duplication without dropping new artifacts', async ({
  page,
}) => {
  test.skip(studio, 'Injected lifecycle adapters belong to the independent reference Host.');
  await page.goto('/lifecycle.html');
  await expect(page.getByRole('button', { name: '成果物JSONを開く', exact: true })).toBeDisabled();
  for (const button of await page.getByRole('button', { name: '複製', exact: true }).all())
    await expect(button).toBeDisabled();
  // Also guard a file event that bypasses the disabled chooser.
  await page.locator('input[type=file]').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Finish initial load', exact: true }).click();
  await expect(page.getByRole('button', { name: '成果物JSONを開く', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '複製', exact: true }).first().click();
  await expect(page.locator('.host-artifacts article')).toHaveCount(6);
  await open(page, 'code');
  const imported = await native(page);
  imported.id = 'fixture-import';
  imported.name = 'Imported after load';
  await page.getByRole('button', { name: '編集を保持して戻る', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'valid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(page.locator('[data-artifact-id="fixture-import"]')).toBeVisible();
  await expect(page.locator('.host-artifacts article')).toHaveCount(7);
});

test('replaced access adapter cannot be overwritten by an old read ignoring abort', async ({
  page,
}) => {
  test.skip(studio, 'Injected lifecycle adapters belong to the independent reference Host.');
  await page.goto('/lifecycle.html');
  await page.getByRole('button', { name: 'Replace access adapter', exact: true }).click();
  const label = page.getByLabel('共有範囲', { exact: true });
  await expect(label).toHaveText('公開');
  await page.getByRole('button', { name: 'Finish old access reads', exact: true }).click();
  await expect(label).toHaveText('公開');
});

test('clean immutable-version save still prevents unloading until persistence completes', async ({
  page,
}) => {
  test.skip(studio, 'Injected lifecycle adapters belong to the independent reference Host.');
  await page.goto('/lifecycle.html');
  await page.getByRole('button', { name: 'Finish initial load', exact: true }).click();
  await open(page, 'code');
  await expect(page.getByLabel('成果物Editor', { exact: true })).toContainText('保存内容と一致');
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await expect(page.getByLabel('Fixture save state', { exact: true })).toHaveText('Save pending');
  const guarded = () =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await guarded()).toBe(true);
  await page.getByRole('button', { name: 'Finish pending save', exact: true }).click();
  await expect(page.getByLabel('成果物一覧', { exact: true })).toBeVisible();
  expect(await guarded()).toBe(false);
  await expect(page.locator('[data-artifact-id="reference-code"]')).toContainText('1 versions');
});

test('Studio stale recognition callbacks cannot affect a rerun or the new microphone service', async ({
  page,
}) => {
  test.skip(!studio, 'The voice runtime is a Studio Host extension.');
  await page.evaluate(() => {
    const target = window as unknown as { SpeechRecognition: unknown; fixtureServices: unknown[] };
    target.fixtureServices = [];
    target.SpeechRecognition = class {
      onstart?: () => void;
      constructor() {
        target.fixtureServices.push(this);
      }
      start() {
        this.onstart?.();
      }
      abort() {}
    };
  });
  await open(page, 'code');
  const preview = page.frameLocator('iframe[title="SORA音声認識プレビュー"]');
  const start = async () => {
    await clickInPreview(
      page,
      preview.getByRole('button', { name: '● マイクで入力', exact: true }),
    );
    await clickAfterScroll(page.getByRole('button', { name: 'マイク入力を開始', exact: true }));
    await expect(preview.getByRole('button', { name: '■ 入力を停止', exact: true })).toBeVisible();
  };
  await start();
  await clickAfterScroll(page.getByRole('button', { name: '▷ 実行', exact: true }));
  await start();
  await page.evaluate(() => {
    const services = (
      window as unknown as {
        fixtureServices: { onend?: () => void; onresult?: (event: unknown) => void }[];
      }
    ).fixtureServices;
    const result = [{ 0: { transcript: 'stale transcript', confidence: 1 }, isFinal: true }];
    services[0].onresult?.({ results: result });
    services[0].onend?.();
    services[1].onresult?.({
      results: [{ 0: { transcript: 'current transcript', confidence: 1 }, isFinal: true }],
    });
  });
  await expect(preview.getByLabel('文字起こし', { exact: true })).toHaveValue('current transcript');
  await expect(preview.getByRole('button', { name: '■ 入力を停止', exact: true })).toBeVisible();
  await expect(page.getByRole('status').last()).toContainText('マイク入力中');
});

test('Studio malformed sandbox error stays bounded and source remains editable', async ({
  page,
}) => {
  test.skip(!studio, 'The Code runtime is a Studio Host extension.');
  await open(page, 'code');
  const input = page.getByLabel('音声認識Reactソース', { exact: true });
  const source =
    "import React from 'react';window.addEventListener('message',e=>{const d=e.data;if(d?.channel==='ep-code-host'&&d.type==='speech'){window.fixtureEnvelope=d;parent.postMessage({channel:'ep-code-preview',type:'error',token:d.token,generation:d.generation,message:{bad:'payload'}},'*');}});export default function App(){return <><h1>Error fixture</h1><button onClick={()=>new window.SpeechRecognition().start()}>Trigger error</button></>;}";
  await input.fill(source);
  await clickAfterScroll(page.getByRole('button', { name: '▷ 実行', exact: true }));
  await expect(
    page
      .frameLocator('iframe[title="SORA音声認識プレビュー"]')
      .getByRole('heading', { name: 'Error fixture' }),
  ).toBeVisible();
  await clickInPreview(
    page,
    page
      .frameLocator('iframe[title="SORA音声認識プレビュー"]')
      .getByRole('button', { name: 'Trigger error', exact: true }),
  );
  await clickAfterScroll(page.getByRole('button', { name: 'キャンセル', exact: true }));
  await expect(page.getByRole('alert')).toHaveText('[object Object]');
  await expect(input).toHaveValue(source);
  const body = page.frameLocator('iframe[title="SORA音声認識プレビュー"]').locator('body');
  for (const message of ['x'.repeat(10000), { toString: null }]) {
    await body.evaluate((_element, message) => {
      const envelope = (
        window as unknown as { fixtureEnvelope: { token: string; generation: number } }
      ).fixtureEnvelope;
      parent.postMessage(
        {
          channel: 'ep-code-preview',
          type: 'error',
          token: envelope.token,
          generation: envelope.generation,
          message,
        },
        '*',
      );
    }, message);
    await expect(page.getByRole('alert')).toHaveText(
      typeof message === 'string' ? 'x'.repeat(2048) : 'Invalid preview error payload',
    );
    await expect(input).toHaveValue(source);
  }
  await input.fill(
    "import React from 'react';export default function App(){return <h1>Recovered source</h1>;}",
  );
  await expect(input).toHaveValue(/Recovered source/);
});

for (const operation of ['import', 'duplicate'] as const) {
  test(`list-level ${operation} remains unload-protected until successful storage`, async ({
    page,
  }, info) => {
    const guarded = () =>
      page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
    expect(await guarded()).toBe(false);
    await open(page, 'code');
    const original = await native(page);
    await clickAfterScroll(page.getByRole('button', { name: '編集を保持して戻る', exact: true }));
    expect(await guarded()).toBe(false);
    let id: string;
    if (operation === 'import') {
      const imported = { ...original, id: 'unpersisted-code', name: 'Unsaved imported code' };
      await page.locator('input[type=file]').setInputFiles({
        name: 'unpersisted.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(imported)),
      });
      id = imported.id;
    } else {
      await clickAfterScroll(
        page
          .locator(`[data-artifact-id="${original.id}"]`)
          .getByRole('button', { name: '複製', exact: true }),
      );
      id = (await page.locator('.host-artifacts article').last().getAttribute('data-artifact-id'))!;
    }
    const row = page.locator(`[data-artifact-id="${id}"]`);
    expect(await guarded()).toBe(true);
    await expect(row).toContainText('ブラウザー未保存');
    await shot(page, info, operation + '-unpersisted');
    await clickAfterScroll(row.getByRole('button', { name: /を開く$/ }));
    await expect(page.getByLabel('成果物Editor', { exact: true })).toContainText('保存内容と一致');
    expect(await guarded()).toBe(true);
    await clickAfterScroll(page.getByRole('button', { name: '編集を保持して戻る', exact: true }));
    expect(await guarded()).toBe(true);
    await clickAfterScroll(row.getByRole('button', { name: /を開く$/ }));
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('ep-sora-artifact:') || key.startsWith('ep-artifact-host:')) {
          Storage.prototype.setItem = original;
          throw new DOMException('Quota failure fixture', 'QuotaExceededError');
        }
        original.call(this, key, value);
      };
    });
    await clickAfterScroll(page.getByRole('button', { name: '保存してアプリに戻る', exact: true }));
    await expect(page.getByRole('alert')).toContainText('save-failed');
    expect(await guarded()).toBe(true);
    expect((await native(page)).draft.content).toEqual(original.draft.content);
    await clickAfterScroll(page.getByRole('button', { name: '保存してアプリに戻る', exact: true }));
    await expect(row).toContainText('保存済み');
    expect(await guarded()).toBe(false);
    await page.reload();
    await expect(row).toContainText('保存済み');
    await clickAfterScroll(row.getByRole('button', { name: /を開く$/ }));
    expect((await native(page)).draft.content).toEqual(original.draft.content);
    expect(await guarded()).toBe(false);
  });
}

test('Host every execution replaces the sandbox and discards previous globals and listeners', async ({
  page,
}, info) => {
  await open(page, 'code');
  const input = page.getByLabel(studio ? '音声認識Reactソース' : 'React TSXソース', {
    exact: true,
  });
  const preview = page.frameLocator(
    studio ? 'iframe[title="SORA音声認識プレビュー"]' : 'iframe[title="Code隔離プレビュー"]',
  );
  await input.fill(
    "import React from 'react';window.oldExecution=true;window.addEventListener('message',e=>{const d=e.data;if(d?.channel==='ep-code-host'&&d.type==='render'){parent.postMessage({channel:'ep-code-preview',type:'error',token:d.token,generation:d.generation,message:'Old execution survived'},'*');parent.postMessage({channel:'ep-code-preview',type:'request-microphone',token:d.token,generation:d.generation},'*');}});export default function App(){return <h1>Old execution</h1>;}",
  );
  await clickAfterScroll(
    page.getByRole('button', { name: studio ? '▷ 実行' : '隔離プレビューを実行', exact: true }),
  );
  await expect(preview.getByRole('heading', { name: 'Old execution', exact: true })).toBeVisible();
  const oldFrame = await page
    .locator(
      studio ? 'iframe[title="SORA音声認識プレビュー"]' : 'iframe[title="Code隔離プレビュー"]',
    )
    .elementHandle();
  await input.fill(
    "import React from 'react';window.executionCount=(window.executionCount||0)+1;export default function App(){return <><h1>{window.oldExecution?'Leaked old global':'Fresh execution'}</h1><p data-testid='execution-count'>{window.executionCount}</p></>;}",
  );
  await clickAfterScroll(
    page.getByRole('button', { name: studio ? '▷ 実行' : '隔離プレビューを実行', exact: true }),
  );
  await expect(
    preview.getByRole('heading', { name: 'Fresh execution', exact: true }),
  ).toBeVisible();
  expect(await oldFrame!.evaluate((frame) => frame.isConnected)).toBe(false);
  await expect(preview.getByTestId('execution-count')).toHaveText('1');
  if (studio) {
    await page
      .locator(
        studio ? 'iframe[title="SORA音声認識プレビュー"]' : 'iframe[title="Code隔離プレビュー"]',
      )
      .scrollIntoViewIfNeeded();
    await preview.locator('body').evaluate(async () => {
      for (let i = 0; i < 3; i++)
        parent.postMessage({ channel: 'ep-code-preview', type: 'ready' }, '*');
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await expect(preview.getByTestId('execution-count')).toHaveText('1');
  }

  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'マイク入力の開始', exact: true })).toHaveCount(0);
  await shot(page, info, 'fresh-code-execution');
  const currentFrame = await page
    .locator(
      studio ? 'iframe[title="SORA音声認識プレビュー"]' : 'iframe[title="Code隔離プレビュー"]',
    )
    .elementHandle();
  await clickAfterScroll(
    page.getByRole('button', { name: studio ? '▷ 実行' : '隔離プレビューを実行', exact: true }),
  );
  await expect(
    preview.getByRole('heading', { name: 'Fresh execution', exact: true }),
  ).toBeVisible();
  expect(await currentFrame!.evaluate((frame) => frame.isConnected)).toBe(false);
  if (studio)
    await clickAfterScroll(page.getByRole('button', { name: 'サンプルに戻す', exact: true }));
  if (studio)
    await expect(
      preview.getByRole('button', { name: '● マイクで入力', exact: true }),
    ).toBeVisible();
});

test('read-only same-ID native import preserves the original artifact and Session', async ({
  page,
}) => {
  await open(page, 'code');
  const original = await native(page);
  await page.getByLabel('閲覧モード', { exact: true }).check();
  await page.getByRole('button', { name: '編集を保持して戻る', exact: true }).click();
  const changed = structuredClone(original);
  if (!('source' in changed.draft.content)) throw Error('Not Code');
  changed.draft.content.source = 'export default function Replaced(){return null;}';
  await page.locator('input[type=file]').setInputFiles({
    name: 'replace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(changed)),
  });
  await expect(page.getByRole('alert')).toContainText('閲覧');
  await open(page, 'code');
  await expect(page.getByLabel('閲覧モード', { exact: true })).toBeChecked();
  expect((await native(page)).draft.content).toEqual(original.draft.content);
});

test('Code Undo separates caret movement and execution from consecutive typing', async ({
  page,
}) => {
  await open(page, 'code');
  const input = page.getByLabel(studio ? '音声認識Reactソース' : 'React TSXソース', {
    exact: true,
  });
  await input.fill('export default function App(){return null;}');
  await clickAfterScroll(
    page.getByRole('button', { name: studio ? '▷ 実行' : '隔離プレビューを実行', exact: true }),
  );
  await input.focus();
  await input.press('End');
  await input.pressSequentially('// tail');
  const tail = await input.inputValue();
  await input.press('ArrowLeft');
  await expect(input).toBeFocused();
  await input.press('ArrowRight');
  await expect(input).toBeFocused();
  await input.press('Control+Home');
  await expect(input).toBeFocused();
  await input.pressSequentially('// head\n');
  await tool(page, 'Host Undo');
  await expect(input).toHaveValue(tail);
  await tool(page, 'Host Undo');
  await expect(input).toHaveValue('export default function App(){return null;}');
  if (studio) {
    await clickAfterScroll(page.getByRole('button', { name: 'サンプルに戻す', exact: true }));
    await tool(page, 'Host Undo');
    await expect(input).toHaveValue('export default function App(){return null;}');
  }
});

test('Studio denied storage shows a recoverable startup error', async ({ page }) => {
  test.skip(!studio, 'Studio owns its storage startup.');
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Persistent storage denied', 'SecurityError');
      },
    });
  });
  // React reports caught errors to console; pageerror still fails the shared fixture.
  await page.reload();
  await expect(
    page.getByRole('alert').filter({ hasText: 'この画面を開けませんでした。' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '再読み込み', exact: true })).toBeVisible();
});

test('async native import retains versions saved while validation is pending', async ({ page }) => {
  await open(page, 'code');
  const before = await native(page);
  before.name += ' imported';
  await page.getByRole('button', { name: '編集を保持して戻る', exact: true }).click();
  await page.evaluate(() => {
    const state = window as typeof window & { releaseImport?: () => void };
    const original = File.prototype.text;
    File.prototype.text = async function () {
      const value = await original.call(this);
      await new Promise<void>((resolve) => {
        state.releaseImport = resolve;
      });
      return value;
    };
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'pending.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(before)),
  });
  await page.waitForFunction(
    () => !!(window as typeof window & { releaseImport?: () => void }).releaseImport,
  );
  await open(page, 'code');
  await clickAfterScroll(page.getByRole('button', { name: '保存してアプリに戻る', exact: true }));
  await expect(page.getByLabel('成果物一覧', { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as typeof window & { releaseImport?: () => void }).releaseImport!(),
  );
  await expect(page.locator(`[data-artifact-id="${before.id}"]`)).toContainText(before.name);
  await page.getByRole('button', { name: before.name + 'を開く', exact: true }).click();
  expect((await native(page)).versions).toHaveLength(1);
});

test('imported Design uses its declared root symbol for preview and saved reuse', async ({
  page,
}) => {
  await open(page, 'design');
  const imported = await native(page);
  if (!('web' in imported.draft.content) || !imported.draft.content.web) throw Error('Not Design');
  imported.draft.content.web.pages[0].symbol = 'LandingPage';
  imported.name += ' imported';
  await page.getByRole('button', { name: '編集を保持して戻る', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'landing.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await page.getByRole('button', { name: imported.name + 'を開く', exact: true }).click();
  await clickAfterScroll(
    page.getByRole('button', { name: 'React生成を採用・プレビュー', exact: true }),
  );
  await expect(
    page.frameLocator('iframe[title="Designから生成したReact"]').locator('h1'),
  ).toBeVisible();
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await expect(
    page.frameLocator('iframe[title="アプリで再利用したReact出力"]').locator('h1'),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.frameLocator('iframe[title="アプリで再利用したReact出力"]').locator('h1'),
  ).toBeVisible();
});

test('Studio module evaluation normalizes null and undefined throws', async ({ page }) => {
  test.skip(!studio, 'Studio owns this compiler/runtime protocol.');
  await open(page, 'code');
  const input = page.getByLabel('音声認識Reactソース', { exact: true });
  for (const value of ['null', 'undefined']) {
    await input.fill(`throw ${value};export default function App(){return null;}`);
    await clickAfterScroll(page.getByRole('button', { name: '▷ 実行', exact: true }));
    await expect(
      page.frameLocator('iframe[title="SORA音声認識プレビュー"]').getByRole('alert'),
    ).toHaveText(value);
    await expect(input).toHaveValue(`throw ${value};export default function App(){return null;}`);
  }
});

test('Surface export menus allow SVG and CSV while unavailable PPTX stays disabled', async ({
  page,
}) => {
  await open(page, 'slide');
  const menu = page.getByRole('button', { name: 'Export visual', exact: true });
  if (!(await menu.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await menu.click();
  await expect(page.getByRole('button', { name: 'Export PPTX', exact: true })).toBeDisabled();
  let download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export SVG', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.svg$/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '編集を保持して戻る', exact: true }).click();
  await open(page, 'data');
  const dataMenu = page.getByRole('button', { name: 'Export data', exact: true });
  if (!(await dataMenu.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await dataMenu.click();
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'CSV export scope', exact: true })).toBeVisible();
  download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
});
