import type { DrawingDocument } from '@editor-platform/drawing-core';
import { create, expect, nativeArtifact, test } from './fixtures';

test('two Drawing editors share adding a sheet and the author can undo it', async ({
  page: a,
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  try {
    await a.goto('/');
    await create(a, 'drawing');
    const menu = a.getByRole('button', { name: 'More artifact actions', exact: true });
    await menu.click();
    await a.getByRole('button', { name: 'Open collaboratively', exact: true }).click();
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    await menu.click();
    const link = await a.getByRole('link', { name: 'Open peer editor', exact: true }).getAttribute('href');
    expect(link).toBeTruthy();
    await a.keyboard.press('Escape');
    const b = await context.newPage();
    const errors: string[] = [];
    b.on('pageerror', (error) => errors.push(error.message));
    await b.goto(link!);
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    const sheetCount = async () => ((await nativeArtifact(b)).draft.content as DrawingDocument).sheets.length;
    await expect.poll(sheetCount).toBe(1);
    await expect(b.getByRole('list', { name: 'Sheets', exact: true }).getByRole('listitem')).toHaveCount(1);
    const frames = await b.evaluateHandle(() => {
      const status = document.querySelector('.save-status')!;
      const samples = new Map<number, number>();
      function readFrame() {
        const match = status.textContent?.match(/Shared · confirmed r(\d+)/);
        if (match) {
          const revision = Number(match[1]);
          if (!samples.has(revision)) {
            samples.set(revision, document.querySelectorAll('ul[aria-label="Sheets"] > li').length);
          }
        }
        if (!samples.has(2)) requestAnimationFrame(readFrame);
      }
      requestAnimationFrame(readFrame);
      return samples;
    });
    await a.getByRole('button', { name: 'Add sheet', exact: true }).click();
    await expect.poll(sheetCount).toBe(2);
    await expect.poll(() => frames.evaluate(samples => samples.get(1))).toBe(2);
    await a.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(sheetCount).toBe(1);
    await expect.poll(() => frames.evaluate(samples => samples.get(2))).toBe(1);
    await frames.dispose();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
