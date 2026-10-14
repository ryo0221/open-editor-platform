import { expect, type Page } from '@playwright/test';
import { createArtifact } from '@editor-platform/artifact-core';
import type { SlideContent } from '@editor-platform/slide/model';
import type { WhiteboardContent } from '@editor-platform/whiteboard/model';
import { whiteboardDrawing } from '@editor-platform/whiteboard/model';
import { create, nativeArtifact } from './fixtures';
import { reuseMenu, reuseHistory } from './reuse-fixtures';

async function canvasTool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await button.click();
  await page.keyboard.press('Escape');
}

async function publish(page: Page, name: string, pages = false) {
  await reuseMenu(page, '再利用部品として保存');
  const author = page.getByRole('dialog', { name: '再利用部品として保存', exact: true });
  await author.getByRole('textbox', { name: '部品名', exact: true }).fill(name);
  if (pages)
    await author
      .getByRole('combobox', { name: 'Slideの再利用範囲', exact: true })
      .selectOption('pages');
  await author.getByRole('button', { name: '部品をプレビュー', exact: true }).click();
  await author.getByRole('button', { name: '部品を公開', exact: true }).click();
  await expect(author).toHaveCount(0);
}
async function library(page: Page, name: string) {
  await reuseMenu(page, '部品ライブラリ');
  const dialog = page.getByRole('dialog', { name: '部品ライブラリ', exact: true });
  await dialog.getByRole('button', { name, exact: true }).click();
  return dialog;
}
async function apply(page: Page, dialogName: string) {
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
  await dialog.getByRole('button', { name: '変更をプレビュー', exact: true }).click();
  await dialog.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function publishDraft(page: Page) {
  const draft = page.getByRole('dialog', { name: '部品の下書き・新版公開', exact: true });
  await draft.getByRole('button', { name: '新版をプレビュー', exact: true }).click();
  await draft.getByRole('button', { name: '下書きを保存', exact: true }).click();
  await draft.getByRole('button', { name: '保存した版を公開', exact: true }).click();
  await expect(draft).toHaveCount(0);
  await page.getByRole('button', { name: 'Close 部品ライブラリ', exact: true }).click();
}
export async function slideComponentFlow(page: Page) {
  page.setDefaultTimeout(12000);
  await page.goto('/');
  const source: SlideContent = {
    schemaVersion: 2,
    width: 960,
    height: 540,
    slides: [
      {
        id: 'page',
        title: '案件ページ',
        background: '#ffffff',
        notes: '案件のノート\n段落を保持',
        objects: [
          {
            id: 'title',
            type: 'text',
            bounds: { x: 60, y: 60, width: 800, height: 100 },
            text: '共通の注意書き',
            fill: '#112233',
          },
        ],
      },
    ],
  };
  if (!(await page.getByLabel('Import artifact', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'deck.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('slide', '部品の検証', source))),
  });
  await expect(page.getByRole('application', { name: 'Slide canvas' })).toBeVisible();
  await publish(page, '共通ヘッダー');
  const dialog = await library(page, '共通ヘッダー v1');
  await expect(dialog.getByRole('combobox', { name: '挿入先ページ', exact: true })).toHaveValue(
    'page',
  );
  await dialog.locator('textarea[data-slot^="text_"]').first().fill('案件ごとの見出し');
  await apply(page, '部品ライブラリ');
  await page
    .getByRole('application', { name: 'Slide canvas', exact: true })
    .getByRole('button', { name: 'text object 2', exact: true })
    .click();
  if (!(await page.getByLabel('Element y', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  await page.getByLabel('Element y', { exact: true }).fill('220');
  await page.getByLabel('Element y', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Close Slide inspector', exact: true }).click();
  const inserted = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(inserted.slides).toHaveLength(1);
  expect(inserted.slides[0].notes).toBe(source.slides[0].notes);
  expect(inserted.slides[0].objects[1].text).toBe('案件ごとの見出し');
  const lib = await library(page, '共通ヘッダー v1');
  await lib.getByRole('button', { name: '新版の下書きを作成', exact: true }).click();
  const draft = page.getByRole('dialog', { name: '部品の下書き・新版公開', exact: true });
  await draft.getByRole('textbox', { name: '塗り色', exact: true }).fill('#336699');
  await draft.getByRole('spinbutton', { name: '文字サイズ (px)', exact: true }).fill('36');
  await publishDraft(page);
  await reuseMenu(page, '部品の入力・表示');
  const inspector = page.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await inspector.getByRole('button', { name: '共通ヘッダー v1', exact: true }).click();
  await inspector.locator('summary', { hasText: '改訂の採用・部品の差し替え' }).click();
  await inspector.getByRole('button', { name: '更新差分をプレビュー', exact: true }).click();
  await expect(inspector.getByRole('status')).toContainText('更新可能');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  const adopted = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(adopted.slides[0].objects[1]).toMatchObject({
    text: '案件ごとの見出し',
    fill: '#336699',
    typography: { fontSize: 36 },
  });
  expect(adopted.slides[0].notes).toBe(source.slides[0].notes);
  expect(adopted.slides[0].objects[1].bounds.y).toBe(220);
  await reuseHistory(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
  await reuseHistory(page, 'Redo');
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(adopted);
  // The same dialog explicitly authorizes whole-page insertion as another capability.
  await publish(page, '案件レイアウト', true);
  await library(page, '案件レイアウト v1');
  await apply(page, '部品ライブラリ');
  const pages = (await nativeArtifact(page)).draft.content as SlideContent;
  expect(pages.slides).toHaveLength(2);
  expect(pages.slides[0]).toEqual(adopted.slides[0]);
  expect(pages.slides[1].notes).toBe(source.slides[0].notes);
  await page.getByRole('application', { name: 'Slide canvas', exact: true }).focus();
  return pages;
}

export async function boardComponentFlow(page: Page) {
  page.setDefaultTimeout(12000);
  await page.goto('/');
  await create(page, 'whiteboard');
  await canvasTool(page, 'Insert text');
  const addPort = page.getByRole('button', { name: '接続portを追加', exact: true });
  if (!(await addPort.isVisible()))
    await page.getByRole('button', { name: 'Toggle Board inspector', exact: true }).click();
  await addPort.click();
  const original = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  const port = original.nodes[0].ports![0].key;
  await publish(page, '接続付きノード');
  await library(page, '接続付きノード v1');
  await apply(page, '部品ライブラリ');
  const inserted = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  if (!(await page.getByRole('button', { name: 'Layer text 2', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle Board navigator', exact: true }).click();
  await page.getByRole('button', { name: 'Layer text 2', exact: true }).click();
  await page
    .getByRole('button', { name: 'Layer text 1', exact: true })
    .click({ modifiers: ['Shift'] });
  await canvasTool(page, 'Connect selected');
  await page.getByRole('button', { name: 'Connection 1', exact: true }).click();
  if (!(await page.getByRole('combobox', { name: 'from port', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle Board inspector', exact: true }).click();
  const connected = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  const side = connected.connectors[0].from === inserted.nodes[1].id ? 'from' : 'to';
  await page.getByRole('combobox', { name: `${side} port`, exact: true }).selectOption(port);
  const before = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  const lib = await library(page, '接続付きノード v1');
  await lib.getByRole('button', { name: '新版の下書きを作成', exact: true }).click();
  const draft = page.getByRole('dialog', { name: '部品の下書き・新版公開', exact: true });
  await draft.getByRole('button', { name: 'portを削除: 新しいport', exact: true }).click();
  await draft.getByRole('textbox', { name: '塗り色', exact: true }).fill('#336699');
  await publishDraft(page);
  await reuseMenu(page, '部品の入力・表示');
  const inspector = page.getByRole('dialog', { name: '部品の入力・表示', exact: true });
  await inspector.getByRole('button', { name: '接続付きノード v1', exact: true }).click();
  await inspector.locator('summary', { hasText: '改訂の採用・部品の差し替え' }).click();
  await inspector.getByRole('button', { name: '更新差分をプレビュー', exact: true }).click();
  await expect(inspector.getByRole('alert')).toContainText('競合');
  await expect(
    inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }),
  ).toHaveCount(0);
  await inspector.locator('summary', { hasText: '対応先を明示して再確認' }).click();
  await inspector
    .getByRole('combobox', { name: '削除portの対応先: 新しいport', exact: true })
    .selectOption('bottom');
  await inspector.getByRole('button', { name: '更新差分をプレビュー', exact: true }).click();
  await expect(inspector.getByRole('status')).toContainText('更新可能');
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  const adopted = (await nativeArtifact(page)).draft.content as WhiteboardContent;
  expect(adopted.connectors[0][`${side}Port`]).toBe('bottom');
  expect(adopted.connectors[0].from).toBe(before.connectors[0].from);
  expect(adopted.connectors[0].to).toBe(before.connectors[0].to);
  expect(adopted.nodes[0]).toEqual(before.nodes[0]);
  expect(adopted.nodes[1].color).toBe('#336699');
  expect(whiteboardDrawing(adopted.nodes[1]).typography!.fontSize).toBe(
    whiteboardDrawing(before.nodes[1]).typography!.fontSize,
  );
  await reuseHistory(page, 'Undo');
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await reuseHistory(page, 'Redo');
  expect((await nativeArtifact(page)).draft.content).toEqual(adopted);
  await expect(page.locator('.save-status')).toHaveText('Saved locally');
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(adopted);
  const close = page.getByRole('button', { name: 'Close Board inspector', exact: true });
  if (await close.isVisible()) await close.click();
  await page.getByRole('application', { name: 'Whiteboard canvas', exact: true }).focus();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
