import { test, expect, create, nativeArtifact } from './fixtures';
import { mkdir } from 'node:fs/promises';
for (const kind of ['document', 'slide', 'whiteboard', 'design', 'data', 'review', 'file']) {
  test(`EI-Q01/Q13 ${kind}: solo and shared desktop/mobile preserve the normal editor`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    const localApiCalls: string[] = [];
    let sharing = false;
    page.on('request', (request) => {
      if (!sharing && request.url().includes('/collaboration-api/'))
        localApiCalls.push(request.url());
    });
    await page.goto('/');
    await create(page, kind);
    if (['slide', 'design', 'whiteboard'].includes(kind)) {
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
      await page.getByRole('button', { name: 'Insert shapes', exact: true }).click();
      await page.getByRole('button', { name: 'Insert rectangle', exact: true }).click();
      await page.keyboard.press('Escape');
    }
    await mkdir('docs/screenshots/issue-5', { recursive: true });
    const shot = (name: string) =>
      page.screenshot({ path: `docs/screenshots/issue-5/${kind}-${name}.png`, fullPage: true });
    await shot('solo-mobile');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const initial = (await nativeArtifact(page)).draft.content;
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot('solo-desktop');
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    expect(localApiCalls).toEqual([]);
    sharing = true;
    await page.getByRole('button', { name: 'Open collaboratively', exact: true }).click();
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    expect((await nativeArtifact(page)).draft.content).toEqual(initial);
    await shot('shared-overview-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('shared-panels-mobile');
    for (const side of ['inspector', 'navigator', 'outline']) {
      const close = page.getByRole('button', { name: new RegExp(`^Close .* ${side}$`) });
      if (await close.isVisible()) await close.click();
    }
    await shot('shared-mobile');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    if (['slide', 'design', 'whiteboard'].includes(kind)) {
      await page.getByRole('button', { name: 'Insert shapes', exact: true }).click();
      await page.getByRole('button', { name: 'Insert ellipse', exact: true }).click();
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    await page.reload();
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    await page.screenshot({ path: info.outputPath(`${kind}-shared-mobile.png`) });
  });
}
