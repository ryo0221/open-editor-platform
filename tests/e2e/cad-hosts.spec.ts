import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it neither Host offers CAD editing.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const artifactHost = 'http://127.0.0.1:4203/';
const independentHost = 'http://127.0.0.1:4202/cad-host.html';
const state = (page: Page) => page.getByTestId('cad-geometry-state');
const ready = (page: Page) =>
  expect(state(page)).toHaveText('Shape up to date', { timeout: 90_000 });
const bodies = (page: Page) => page.getByRole('list', { name: 'Bodies' }).getByRole('button');
const hostAlert = (page: Page) => page.locator('.cad-host-controls [role=alert]');
const parameters = (page: Page) => page.getByRole('list', { name: 'Parameters' });
async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  return button;
}
async function setWidth(page: Page, value: string) {
  await parameters(page).getByRole('button', { name: /Width/ }).click();
  const field = page.locator('.cad-inspector').getByLabel('Value (mm)');
  await field.fill(value);
  await field.press('Enter');
}

test.describe('reference artifact Host', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop flow');

  test('edit, Host Undo, guarded save, reopen and read-only', async ({ page }) => {
    await page.goto(artifactHost);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole('button', { name: '3D partを開く', exact: true }).click();
    await expect(page.getByLabel('成果物Editor', { exact: true })).toBeVisible();
    await ready(page);
    await setWidth(page, '100');
    // Save flushes Host inputs first: an evaluating edit refuses it instead of saving 80 mm.
    await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
    const refused = page.getByRole('alert').filter({ hasText: '形状を計算中です' });
    const list = page.getByRole('button', { name: '3D partを開く', exact: true });
    await expect(refused.or(list)).toBeVisible();
    if (await refused.isVisible()) {
      await ready(page);
      await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
    }
    await expect(list).toBeVisible();
    await list.click();
    await ready(page);
    await expect(parameters(page)).toContainText('100 mm');

    // Host Undo/Redo drive the Host session; the Surface re-evaluates.
    await setWidth(page, '120');
    await ready(page);
    await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
    await ready(page);
    await expect(parameters(page)).toContainText('100 mm');
    await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
    await ready(page);
    await expect(parameters(page)).toContainText('120 mm');
    // Keyboard history on the Surface goes through the same guarded Host methods.
    await page.keyboard.press('Control+z');
    await ready(page);
    await expect(parameters(page)).toContainText('100 mm');
    await page.keyboard.press('Control+Shift+z');
    await ready(page);
    await expect(parameters(page)).toContainText('120 mm');

    // An invalid field draft blocks save instead of being lost with the unmounted Surface.
    await parameters(page).getByRole('button', { name: /Width/ }).click();
    await page.locator('.cad-inspector').getByLabel('Value (mm)').fill('');
    await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
    await expect(page.locator('.host-error')).toContainText('有効な');
    await expect(list).toHaveCount(0);
    await setWidth(page, '120');
    await ready(page);

    const viewOnly = page.getByLabel('閲覧モード', { exact: true });
    await viewOnly.check();
    await expect(await tool(page, 'Add box')).toBeDisabled();
    await viewOnly.uncheck();
    await expect(await tool(page, 'Add box')).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('cad-artifact-host.png') });
  });
});

test('independent Host: edit, save draft, detach/attach keeps history, read-only', async ({
  page,
  isMobile,
}) => {
  // The narrow layout keeps the Elements panel closed; count bodies only on desktop.
  const expectBodies = async (n: number) => {
    if (!isMobile) await expect(bodies(page)).toHaveCount(n);
  };
  await page.goto(independentHost);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready(page);
  await (await tool(page, 'Add box')).click();
  await ready(page);
  await expect(page.getByLabel('Host event')).toHaveText('Applied revision 1');
  await expectBodies(2);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByLabel('Host event')).toHaveText('Saved revision 1');

  // Detach releases the Surface and its kernel Worker; the session and history stay.
  await page.getByRole('button', { name: 'Detach editor', exact: true }).click();
  await expect(state(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Attach editor', exact: true }).click();
  await ready(page);
  await expectBodies(2);
  await (await tool(page, 'Undo')).click();
  await ready(page);
  await expectBodies(1);
  await expect(await tool(page, 'Redo')).toBeEnabled();
  if (isMobile) await page.keyboard.press('Escape');

  // The saved draft survives a reload, with a fresh history.
  await page.reload();
  await ready(page);
  await expectBodies(2);
  await expect(await tool(page, 'Undo')).toBeDisabled();
  if (isMobile) {
    await page.keyboard.press('Escape');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
  await page.getByLabel('Read only', { exact: true }).check();
  await expect(await tool(page, 'Add box')).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('cad-host.png') });
});

test('independent Host reports invalid input and storage failures', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop flow');
  await page.goto(independentHost);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready(page);
  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  await save.click();
  await expect(page.getByLabel('Host event')).toHaveText('Saved revision 0');

  await parameters(page).getByRole('button', { name: /Width/ }).click();
  await page.locator('.cad-inspector').getByLabel('Value (mm)').fill('');
  await save.click();
  await expect(hostAlert(page)).toContainText('有効な');
  await expect(page.getByLabel('Host event')).toHaveText('');
  await setWidth(page, '90');
  await ready(page);

  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  await save.click();
  await expect(hostAlert(page)).toContainText('quota');
  await expect(page.getByLabel('Host event')).toHaveText('');
});
