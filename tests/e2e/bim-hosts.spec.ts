import type { Page } from '@playwright/test';
import { f37Office } from '@editor-platform/bim-core';
import { writeIfc } from '@editor-platform/bim-ifc';
import { expect, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Host does not offer Building.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const artifactHost = 'http://127.0.0.1:4203/';
const ready = (page: Page) =>
  expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', { timeout: 90_000 });
const inspector = (page: Page) => page.locator('.bim-inspector');
const elements = (page: Page) => page.getByRole('navigation', { name: 'Elements' });
const levelName = (page: Page) => inspector(page).getByLabel('Level name', { exact: true });
async function panel(page: Page, name: 'Elements' | 'Inspector') {
  const region = name === 'Elements' ? elements(page) : inspector(page);
  if (!(await region.isVisible()))
    await page.getByRole('button', { name: `Toggle ${name}`, exact: true }).click();
}
async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  return button;
}
async function rename(page: Page, value: string) {
  await panel(page, 'Inspector');
  await levelName(page).fill(value);
  await levelName(page).press('Enter');
  await levelName(page).blur();
}

test.describe('reference artifact Host', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop flow');

  test('edit, Host Undo, save, reopen and read-only', async ({ page }) => {
    await page.goto(artifactHost);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole('button', { name: 'Buildingを開く', exact: true }).click();
    await expect(page.getByLabel('成果物Editor', { exact: true })).toBeVisible();
    await ready(page);
    await expect(page.getByTestId('bim-surface')).toContainText('13 elements');

    // Each edit is one Host command: Host Undo/Redo and the keyboard drive the Host session.
    await rename(page, 'Ground');
    await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Ground');
    await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
    await expect(levelName(page)).toHaveValue('1F');
    await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
    await expect(levelName(page)).toHaveValue('Ground');
    await page.keyboard.press('Control+z');
    await expect(levelName(page)).toHaveValue('1F');
    await page.keyboard.press('Control+Shift+z');
    await expect(levelName(page)).toHaveValue('Ground');

    // An invalid field draft blocks save instead of being lost with the unmounted Surface.
    const elevation = inspector(page).getByLabel('Elevation (mm)', { exact: true });
    await elevation.fill('');
    await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
    await expect(page.locator('.host-error')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Buildingを開く', exact: true })).toHaveCount(0);
    // Nor is it lost by a switch that would unmount it: another element, tab or level.
    await panel(page, 'Elements');
    await elements(page).getByRole('button', { name: 'w-south', exact: true }).click();
    await inspector(page).getByRole('tab', { name: 'Types' }).click();
    await page.getByRole('combobox', { name: 'Level' }).selectOption({ label: '2F' });
    await expect(elevation).toHaveValue('');
    await expect(levelName(page)).toHaveValue('Ground');
    await elevation.fill('0');
    await elevation.press('Enter');

    // A grid axis's draft keeps its axis open.
    await (await tool(page, 'Plan')).click();
    await (await tool(page, 'Grid axis')).click();
    const box = (await page.getByTestId('bim-viewport').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.2);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.2);
    await page.keyboard.press('Escape');
    // Nothing selected: the grid axes are listed.
    await page.getByTestId('bim-viewport').press('Escape');
    const w = elements(page).getByRole('button', { name: 'w-south', exact: true });
    if ((await w.getAttribute('aria-pressed')) === 'true')
      await w.click({ modifiers: ['Control'] });
    await inspector(page).getByRole('tab', { name: 'Element' }).click();
    const axisA = inspector(page).getByRole('button', { name: 'A', exact: true });
    await axisA.click();
    const startX = inspector(page).getByLabel('Start x (mm)', { exact: true });
    const before = await startX.inputValue();
    await startX.fill('');
    await axisA.click();
    await expect(startX).toHaveValue('');
    await startX.fill(before);
    await startX.press('Enter');
    await axisA.click();
    await expect(startX).toHaveCount(0);
    await (await tool(page, '3D view')).click();

    await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
    const list = page.getByRole('button', { name: 'Buildingを開く', exact: true });
    await expect(list).toBeVisible();
    await list.click();
    await ready(page);
    await panel(page, 'Inspector');
    await expect(levelName(page)).toHaveValue('Ground');
    await panel(page, 'Elements');
    await elements(page).getByRole('button', { name: 'w-south', exact: true }).click();
    await expect(inspector(page)).toContainText('wall · w-south');

    // View mode refuses every entry: values, drawing and the keyboard history.
    const viewOnly = page.getByLabel('閲覧モード', { exact: true });
    await viewOnly.check();
    await expect(page.getByTestId('bim-surface')).toContainText('Read only');
    await expect(inspector(page).locator('input:not([type=checkbox])')).toHaveCount(0);
    await (await tool(page, 'Plan')).click();
    await expect(await tool(page, 'Wall')).toBeDisabled();
    // No history in view mode: the rename stays.
    await page.keyboard.press('Control+z');
    await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Ground');
    await viewOnly.uncheck();
    await expect(await tool(page, 'Wall')).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('bim-artifact-host.png') });
  });

  test('imports an IFC file with a loss report as a new building and writes it back', async ({
    page,
  }) => {
    // CAD69 (R2c-6) in the Host: F37 from an IFC file whose part names a CAD version this Host
    // does not have. The part is listed as lost; the rest is imported once the user confirms.
    test.setTimeout(600_000);
    const doc = f37Office();
    doc.types.push({
      id: 'pt-1',
      kind: 'part',
      name: 'Cube',
      source: { artifactId: 'a-cad', versionId: 'v1', contentHash: 'c'.repeat(64) },
      hintBounds: { min: [0, 0, 0], max: [1000, 1000, 1000] },
    });
    doc.elements.push({
      id: 'p-1',
      kind: 'part',
      typeId: 'pt-1',
      at: { xy: [3000, 3000] },
      base: { level: 'l-1f', offsetMm: 0 },
      rotationRad: 0,
    });
    const file = writeIfc(doc, {
      artifactId: 'a-office',
      timeStamp: '2026-10-25T00:00:00.000Z',
      kernelQuantities: new Map(doc.elements.map((e) => [e.id, {}])),
      parts: new Map([
        [
          'p-1',
          {
            kind: 'solid',
            closed: true,
            // prettier-ignore
            positions: [0,0,0, 1000,0,0, 1000,1000,0, 0,1000,0, 0,0,1000, 1000,0,1000, 1000,1000,1000, 0,1000,1000],
            // prettier-ignore
            triangles: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7],
            deflectionMm: 0.5,
          },
        ],
      ]),
    });
    await page.goto(artifactHost);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator('input[type=file]').setInputFiles({
      name: 'office.ifc',
      mimeType: 'application/x-step',
      buffer: Buffer.from(file.bytes),
    });
    const report = page.getByTestId('bim-ifc-report');
    await expect(report).toContainText('Restored with their constraints: 766');
    await expect(report.locator('tbody tr')).toHaveCount(1);
    await expect(report.locator('tbody')).toContainText('IFCBUILDINGELEMENTPROXY');
    // Cancel imports nothing; confirming imports the supported part.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(report).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'officeを開く', exact: true })).toHaveCount(0);
    await page.locator('input[type=file]').setInputFiles({
      name: 'office.ifc',
      mimeType: 'application/x-step',
      buffer: Buffer.from(file.bytes),
    });
    await page.getByRole('button', { name: 'Import supported part', exact: true }).click();
    await page.getByRole('button', { name: 'officeを開く', exact: true }).click();
    await ready(page);
    await expect(page.getByTestId('bim-surface')).toContainText('766 elements');
    await expect(page.getByTestId('bim-surface')).not.toContainText('not built');

    // Export IFC from the Host's building: the same storeys and elements, and no part.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.getByRole('button', { name: 'Export IFC', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('office.ifc');
    const text = (
      await (await import('node:fs/promises')).readFile((await download.path())!)
    ).toString('utf8');
    const count = (entity: string) => text.split(`=${entity}(`).length - 1;
    expect(count('IFCBUILDINGSTOREY')).toBe(6);
    expect(count('IFCWALL')).toBe(25);
    expect(count('IFCWINDOW')).toBe(200);
    expect(count('IFCBUILDINGELEMENTPROXY')).toBe(0);
    // Elements imported from the file keep its GlobalIds.
    const wall = doc.elements.find((e) => e.kind === 'wall')!.id;
    expect(text).toContain(`'${file.globalIds.get(wall)}'`);
    await page.screenshot({ path: test.info().outputPath('bim-host-ifc.png') });
  });
});
