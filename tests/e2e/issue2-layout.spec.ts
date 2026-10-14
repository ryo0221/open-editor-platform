import { test, expect, create, nativeArtifact } from './fixtures';

for (const width of [1280, 1440])
  test(`QA-01/02 seven surfaces at ${width}px return panel space without changing content`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 900 });
    await page.goto('/');
    for (const kind of ['slide', 'design', 'whiteboard', 'document', 'data', 'review', 'file']) {
      await create(page, kind);
      const viewport = page.getByTestId('editor-viewport');
      expect((await viewport.boundingBox())!.y).toBeLessThanOrEqual(112);
      expect((await viewport.boundingBox())!.height).toBeGreaterThan(600);
      const before = (await nativeArtifact(page)).draft.content;
      const toggles = page.locator('.ep-toolbar').getByRole('button', { name: /^Toggle / });
      for (let i = 0; i < 2; i++) {
        const toggle = toggles.nth(i),
          initial = (await viewport.boundingBox())!.width;
        await toggle.click();
        expect((await viewport.boundingBox())!.width).toBeGreaterThan(initial + 150);
        await toggle.click();
        expect((await viewport.boundingBox())!.width).toBe(initial);
      }
      const grip = page.getByRole('separator', { name: 'Inspector width' });
      const box = (await grip.boundingBox())!;
      const originalWidth = (await viewport.boundingBox())!.width;
      await page.mouse.move(box.x + box.width / 2, box.y + 60);
      await page.mouse.down();
      await page.mouse.move(box.x - 40, box.y + 60);
      await page.mouse.up();
      expect((await viewport.boundingBox())!.width).toBeLessThan(originalWidth - 25);
      await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
      expect((await viewport.boundingBox())!.width).toBe(width);
      await page.reload();
      await expect(viewport).toBeVisible();
      expect((await viewport.boundingBox())!.width).toBe(width);
      expect((await nativeArtifact(page)).draft.content).toEqual(before);
      await page.screenshot({ path: info.outputPath(`${kind}-${width}-focus.png`) });
      await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
