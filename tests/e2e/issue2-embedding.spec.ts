import { test, expect } from './fixtures';

test('QA-18 independent Host embeds all public surfaces, controls panels and enforces read-only', async ({
  page,
}, info) => {
  const styles: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('.css')) styles.push(response.url());
  });
  await page.goto('/embed.html');
  const content = async () => JSON.parse((await page.locator('.embed-content pre').textContent())!);
  const viewport = page.getByTestId('editor-viewport');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Slide canvas' });
  await expect(canvas.getByRole('button', { name: 'text object 1', exact: true })).toBeVisible();
  expect((await canvas.boundingBox())!.height).toBeGreaterThan(500);
  await expect(page.getByLabel('Host event')).toContainText('Selection:');
  const before = await content();
  await page.getByLabel('Read only', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Insert text', exact: true })).toBeDisabled();
  await canvas.focus();
  await page.keyboard.press('Delete');
  expect(await content()).toEqual(before);
  await page.getByLabel('Read only', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await content()).slides[0].objects).toHaveLength(0);
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  expect((await content()).slides[0].objects).toHaveLength(1);
  await canvas.focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  expect((await content()).slides[0].objects).toHaveLength(2);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await content()).slides[0].objects).toHaveLength(1);
  await page.getByLabel('Narrow container').check();
  await page.getByRole('button', { name: 'Host inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Host inspector', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Slide inspector', exact: true });
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
  await page.getByRole('button', { name: 'Close Slide inspector', exact: true }).click();
  expect((await viewport.boundingBox())!.width).toBe(540);
  await page.screenshot({ path: info.outputPath('independent-host-narrow.png') });
  await page.getByLabel('Narrow container').uncheck();

  for (const kind of ['design', 'whiteboard', 'document', 'data', 'review', 'file']) {
    await page.getByRole('combobox', { name: 'Surface', exact: true }).selectOption(kind);
    await expect(viewport).toBeVisible();
    expect((await viewport.boundingBox())!.height).toBeGreaterThan(500);
    if (kind === 'design' || kind === 'whiteboard') {
      await page.getByRole('button', { name: 'Insert text', exact: true }).click();
      const key = kind === 'design' ? 'elements' : 'nodes';
      expect((await content())[key]).toHaveLength(1);
      const svg = page.getByRole('application');
      expect((await svg.boundingBox())!.height).toBeGreaterThan(500);
    }
    if (kind === 'document') {
      await page.locator('.ProseMirror p').first().click();
      await page.keyboard.type('Standalone Host edit. ');
      expect(JSON.stringify(await content())).toContain('Standalone Host edit.');
      await page.getByLabel('Read only', { exact: true }).check();
      await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
      await page.getByLabel('Read only', { exact: true }).uncheck();
    }
    if (kind === 'data') await expect(page.getByRole('grid')).toBeVisible();
    if (kind === 'review')
      await expect(page.getByLabel('Search diff', { exact: true })).toBeVisible();
    if (kind === 'file')
      await expect(page.getByLabel('Search file', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`independent-host-${kind}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(styles.some((url) => new URL(url).pathname === '/src/styles.css')).toBe(false);
});
