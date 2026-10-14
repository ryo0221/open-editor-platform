import { test, expect, nativeArtifact } from './fixtures';
import {
  importOfficeDeck,
  officeDeck,
  openPptx,
  preparePptx,
  acceptPptx,
  officeDownload,
} from './office-fixtures';

for (const width of [390, 768])
  test(`PPTX dialog, consent and retained preview remain reachable at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    await importOfficeDeck(page, officeDeck());
    const before = await nativeArtifact(page),
      dialog = await openPptx(page);
    await preparePptx(dialog);
    await acceptPptx(dialog);
    await page.screenshot({ path: info.outputPath(`pptx-${width}.png`), fullPage: true });
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog.getByRole('button', { name: 'Minimize PPTX export', exact: true }).click();
    await expect(dialog.getByLabel('PPTX counts')).toBeHidden();
    await dialog.getByRole('button', { name: 'Expand PPTX export', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: /I accept all/ })).toBeChecked();
    const bytes = await officeDownload(page, dialog, 'Download PPTX');
    expect(bytes.length).toBeGreaterThan(1000);
    await dialog.getByRole('button', { name: 'Close PPTX export', exact: true }).click();
    expect(await nativeArtifact(page)).toEqual(before);
  });

test('Independent Host exports PPTX with its own styling at 390px', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/embed.html');
  await page.getByRole('combobox', { name: 'Surface', exact: true }).selectOption('slide');
  const source = await page.locator('.embed-content pre').textContent();
  const dialog = await openPptx(page);
  await preparePptx(dialog);
  await acceptPptx(dialog);
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect((await officeDownload(page, dialog, 'Download PPTX')).length).toBeGreaterThan(1000);
  await page.screenshot({ path: info.outputPath('pptx-independent-host-390.png'), fullPage: true });
  expect(await page.locator('.embed-content pre').textContent()).toBe(source);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
});
