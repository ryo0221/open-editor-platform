import { test, expect, create } from './fixtures';
import type { Page } from '@playwright/test';

async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await button.click();
  if (await page.getByRole('dialog', { name: 'More editor tools', exact: true }).isVisible())
    await page.keyboard.press('Escape');
}

for (const width of [390, 768])
  test(`compact Design retains ink owner, proposal and workspace controls at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    await page.goto('/');
    await create(page, 'design');
    const viewport = page.getByTestId('editor-viewport');
    expect((await viewport.boundingBox())!.y).toBeLessThanOrEqual(112);
    expect((await viewport.boundingBox())!.height).toBeGreaterThan(400);
    const owner = await page.evaluate(() => window.playgroundInk!.read().artifactId);
    // The opener lives in the compact menu; the stateful tools owner does not.
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await page.getByRole('button', { name: '作画ツールを開く', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '作画ツール', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '白紙の作画ページを用意', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '作画ツール', exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'More editor tools', exact: true }),
    ).toBeFocused();
    expect(await page.evaluate(() => window.playgroundInk!.read().artifactId)).toBe(owner);
    await tool(page, 'Draw ink stroke');
    const canvas = (await page
      .getByRole('application', { name: 'Design canvas', exact: true })
      .boundingBox())!;
    await page.mouse.move(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * 0.55, canvas.y + canvas.height * 0.55, {
      steps: 8,
    });
    await page.mouse.up();
    await tool(page, 'Finish drawing strokes');
    const before = await page.evaluate(() => window.playgroundInk!.read());
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await page.getByRole('button', { name: '作画ツールを開く', exact: true }).click();
    await page.evaluate(() => {
      const input = window.playgroundInk!.read();
      const element = input.content.elements.find((element) => element.path)!;
      const path = structuredClone(element.path!);
      path.subpaths[0].anchors[0].y += 8;
      window.playgroundInk!.propose({
        id: 'compact-proposal',
        summary: '線の確認',
        artifactId: input.artifactId,
        baseRevision: input.revision,
        operations: [{ type: 'replace', id: element.id, path }],
      });
    });
    await expect(page.getByRole('dialog', { name: '作画ツール', exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '作画案を確認', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '作画案を却下', exact: true }).click();
    expect((await page.evaluate(() => window.playgroundInk!.read())).content).toEqual(
      before.content,
    );
    await tool(page, '漫画ワークスペース');
    await expect(page.locator('.manga-workspace[data-workspace="manga"]')).toBeVisible();
    await tool(page, 'Designで詳細編集');
    await expect(page.locator('.manga-workspace[data-workspace="design"]')).toBeVisible();
    expect((await page.evaluate(() => window.playgroundInk!.read())).content).toEqual(
      before.content,
    );
    expect((await viewport.boundingBox())!.y).toBeLessThanOrEqual(112);
    await page.screenshot({ path: info.outputPath(`compact-design-${width}.png`) });
  });
