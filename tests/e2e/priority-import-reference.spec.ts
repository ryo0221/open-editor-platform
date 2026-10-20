import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test, expect, create, save, nativeArtifact, editCell } from './fixtures';
import { isStructuredData } from '@editor-platform/structured-data/model';

const csv = '曜日,来客数,売上\n月,80,24000\n火,95,28500\n';
async function library(page: Page) {
  if (!(await page.getByLabel('Import artifact', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
}
async function dataTools(page: Page) {
  if (!(await page.getByLabel('Data projection', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
}
async function history(page: Page, name: 'Undo' | 'Redo') {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await button.click();
  await page.keyboard.press('Escape');
}
test('Unicode CSV filename imports complete data and survives reload', async ({ page }, info) => {
  await page.goto('/');
  await library(page);
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'カフェ売上.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('カフェ売上');
  await expect(page.getByRole('gridcell', { name: '売上 · record 2', exact: true })).toContainText(
    '28500',
  );
  const imported = await nativeArtifact(page);
  expect(imported.kind).toBe('data');
  if (!isStructuredData(imported.draft.content)) throw Error('Expected Data');
  const data = imported.draft.content;
  expect(data.columns.map((column) => [column.name, column.type])).toEqual([
    ['曜日', 'text'],
    ['来客数', 'number'],
    ['売上', 'number'],
  ]);
  expect(data.rows.map((row) => data.columns.map((column) => row.values[column.id]))).toEqual([
    ['月', 80, 24000],
    ['火', 95, 28500],
  ]);
  await expect(page.locator('.save-status')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('カフェ売上');
  expect((await nativeArtifact(page)).draft.content).toEqual(data);
  await page.screenshot({ path: info.outputPath('unicode-csv.png') });
});
test('failed import shows its reason above the closed Library and permits retry', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'data');
  const before = await nativeArtifact(page);
  await library(page);
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: '読み込めない.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{'),
  });
  await expect(page.getByRole('alert')).toContainText('Import failed:');
  await expect(page.locator('.library-backdrop')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dismiss error', exact: true })).toBeInViewport();
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await page.screenshot({ path: info.outputPath('import-error.png') });
  await library(page);
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'カフェ売上.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('カフェ売上');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('Unicode CSV filename works through the browser filesystem upload path', async ({
  page,
}, info) => {
  const path = info.outputPath('カフェ売上.csv');
  await writeFile(path, csv);
  await page.goto('/');
  await library(page);
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles(path);
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('カフェ売上');
  await expect(page.getByRole('gridcell', { name: '曜日 · record 1', exact: true })).toContainText(
    '月',
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
});
for (const mode of ['fixed', 'follow'] as const) {
  test(`edit Data reference opens Grid from Chart and retains source/destination history (${mode})`, async ({
    page,
  }, info) => {
    await page.goto('/');
    await library(page);
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: 'カフェ売上.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('カフェ売上');
    await dataTools(page);
    await page.getByLabel('Data projection', { exact: true }).selectOption('Chart');
    await page.getByRole('button', { name: 'Save named view', exact: true }).click();
    await page.keyboard.press('Escape');
    await save(page, 1);
    const source = await nativeArtifact(page);
    await create(page, 'slide');
    const embed = page.getByRole('button', { name: '参照を埋め込む', exact: true });
    if (!(await embed.isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await embed.click();
    const menu = page.getByRole('dialog', { name: '参照を埋め込む', exact: true });
    await menu.getByRole('button', { name: '参照元を再取得', exact: true }).click();
    const sources = menu.getByLabel('埋め込みの参照元');
    await expect(sources.locator('option')).not.toHaveCount(1);
    const options = await sources.locator('option').allTextContents();
    const index = options.findIndex((text) => text.includes('chart'));
    expect(index).toBeGreaterThan(0);
    await sources.selectOption(String(index - 1));
    await menu.getByLabel('埋め込みの更新方式').selectOption(mode);
    await menu.getByRole('button', { name: '参照を配置', exact: true }).click();
    await expect(menu.getByRole('button', { name: '参照を配置', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.getByLabel('Slide canvas', { exact: true }).press('Control+a');
    const destination = await nativeArtifact(page);
    const edit = page.getByRole('button', { name: '元を編集', exact: true });
    if (!(await edit.isVisible()))
      await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
    await expect(edit).toBeVisible();
    if (info.project.name === 'mobile') await edit.scrollIntoViewIfNeeded();
    await edit.click();
    await dataTools(page);
    await expect(page.getByLabel('Data projection', { exact: true })).toHaveValue('Grid');
    await page.keyboard.press('Escape');
    expect((await nativeArtifact(page)).draft.content).toEqual(source.draft.content);
    await page.screenshot({ path: info.outputPath(`edit-source-${mode}.png`) });
    await editCell(page, '曜日', 1, '水');
    await history(page, 'Undo');
    expect((await nativeArtifact(page)).draft.content).toEqual(source.draft.content);
    await history(page, 'Redo');
    await save(page, 2);
    await page.getByRole('button', { name: '埋め込み先に戻る', exact: true }).click();
    await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(destination.name);
    expect((await nativeArtifact(page)).id).toBe(destination.id);
    await expect
      .poll(async () => {
        const images = await page
          .locator('svg image[href^="data:image/svg+xml"]')
          .evaluateAll((elements) => elements.map((element) => element.getAttribute('href')!));
        return images.some((uri) =>
          Buffer.from(uri.split(',')[1], 'base64').toString('utf8').includes('>水<'),
        );
      })
      .toBe(mode === 'follow');
    // Runtime follow refresh is separate from native destination history.
    await history(page, 'Undo');
    const undone = await nativeArtifact(page);
    if (!('slides' in undone.draft.content)) throw Error('Expected Slide');
    expect(undone.draft.content.slides[0].objects).toHaveLength(0);
  });
}
