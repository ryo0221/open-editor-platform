import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { commitVersion } from '@editor-platform/artifact-core';
import { test, expect, editorToolbarAction } from './fixtures';
import { mangaWorkspaceFixture } from '../fixtures/manga-workspace';

test('eight-panel reading order and polygon output retain the same fixed source', async ({
  page,
  baseURL,
}, info) => {
  const independent = /:4177$/.test(baseURL ?? '');
  const seed = mangaWorkspaceFixture();
  const saved = await commitVersion(
    { ...seed, id: independent ? 'comic' : seed.id },
    null,
    'Eight-panel rough',
  );
  await page.goto(independent ? '/authoring.html' : '/');
  if (independent) {
    await page.evaluate(
      (json) => localStorage.setItem('authoring:comic', json),
      JSON.stringify(saved),
    );
    await page.reload();
    await page.getByRole('button', { name: 'Comic pages', exact: true }).click();
  } else {
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: 'eight-panels.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(saved)),
    });
  }
  await editorToolbarAction(page, '漫画ワークスペース');
  const panel = page.getByRole('region', { name: 'Manga pages and panels' });
  const openTools = async () => {
    if (!(await panel.isVisible()))
      await page.getByRole('button', { name: 'Toggle 漫画のページ・コマ', exact: true }).click();
  };
  const closeTools = async () => {
    const close = page.getByRole('button', { name: 'Close 漫画のページ・コマ', exact: true });
    if (await close.isVisible()) await close.click();
  };
  await openTools();
  await panel.getByRole('button', { name: '通読', exact: true }).click();
  await closeTools();
  const reading = page.getByRole('region', { name: '漫画の通読', exact: true });
  await expect(reading.locator('figcaption')).toHaveText(['Page 2 · page-2', 'Page 1 · page-1']);
  await expect(reading.getByRole('listitem')).toHaveCount(8);
  await page.screenshot({ path: info.outputPath('eight-panel-rtl.png'), fullPage: true });
  await reading.getByRole('button', { name: '通読を閉じる', exact: true }).click();
  await openTools();
  await panel.getByLabel('Reading direction', { exact: true }).selectOption('ltr');
  await panel.getByRole('button', { name: '通読', exact: true }).click();
  await closeTools();
  await expect(reading.locator('figcaption')).toHaveText(['Page 1 · page-1', 'Page 2 · page-2']);
  await reading.getByRole('button', { name: '通読を閉じる', exact: true }).click();
  if (independent) {
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.getByLabel('Save state', { exact: true })).toHaveText('Saved');
    await page.getByRole('button', { name: 'Read saved vector pages', exact: true }).click();
    await expect(page.locator('.authoring-pages img')).toHaveCount(2);
    const manifest = JSON.parse((await page.getByLabel('Page manifest').textContent())!);
    expect(manifest.direction).toBe('ltr');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
    const zip = unzipSync(await readFile((await (await download).path())!));
    expect(Object.keys(zip).filter((p) => p.endsWith('.png'))).toHaveLength(2);
    expect(JSON.parse(strFromU8(zip['references.json']))).toEqual(manifest);
    for (const [name, bytes] of Object.entries(zip))
      if (name.endsWith('.png'))
        expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const pdf = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
    const file = await pdf;
    await file.saveAs(info.outputPath('eight-panels.pdf'));
    expect((await PDFDocument.load(await readFile((await file.path())!))).getPageCount()).toBe(2);
  }
});
