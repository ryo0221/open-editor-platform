import { expect, test, type Page } from '@playwright/test';

// Any page error or console error fails the test.
let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
});
test.afterEach(() => expect(errors).toEqual([]));

const kernel = !!process.env.CAD_OCCT_DIST;
const state = (page: Page) => page.getByTestId('cad-geometry-state');
const ready = (page: Page) => expect(state(page)).toHaveText('Shape up to date');
const bodies = (page: Page) => page.getByRole('list', { name: 'Bodies' }).getByRole('button');
const inspector = (page: Page) => page.locator('.cad-inspector');
// The narrow layout moves the CAD tools into the overflow menu.
async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools' }).click();
  return button;
}

test.describe('with the development kernel', () => {
  test.skip(!kernel, 'CAD_OCCT_DIST is not set');

  test('parameter edit re-evaluates and an invalid value is rejected', async ({ page }) => {
    await page.goto('/?fixture=plate');
    await ready(page);
    await expect(page.getByTestId('cad-viewport').locator('canvas')).toBeVisible();
    if (test.info().project.name !== 'desktop') return;
    await bodies(page).filter({ hasText: 'plate' }).click();
    await expect(inspector(page)).toContainText('80 × 50 × 5 mm');
    await page
      .getByRole('list', { name: 'Parameters' })
      .getByRole('button', { name: /Width/ })
      .click();
    const value = inspector(page).getByLabel('Value (mm)');
    await value.fill('100');
    await value.press('Enter');
    await ready(page);
    await expect(page.getByRole('list', { name: 'Parameters' })).toContainText('100 mm');
    // Zero width cannot form a solid: rejected, field restored, history unchanged.
    await value.fill('0');
    await value.press('Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(value).toHaveValue('100');
    await expect(page.getByRole('list', { name: 'Parameters' })).toContainText('100 mm');
    await page.getByRole('button', { name: 'Undo' }).click();
    await ready(page);
    await expect(page.getByRole('list', { name: 'Parameters' })).toContainText('80 mm');
  });

  test('PNG export waits while an edit evaluates', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop layout');
    await page.goto('/?fixture=plate');
    await ready(page);
    const exportPng = await tool(page, 'Export PNG');
    await expect(exportPng).toBeEnabled();
    await page.evaluate(() => {
      const { port } = (window as unknown as { cad: { port: { evaluate: unknown } } }).cad;
      port.evaluate = () => new Promise(() => {});
    });
    await page
      .getByRole('list', { name: 'Parameters' })
      .getByRole('button', { name: /Width/ })
      .click();
    const value = inspector(page).getByLabel('Value (mm)');
    await value.fill('100');
    await value.press('Enter');
    await expect(state(page)).toHaveText('Calculating…');
    await expect(exportPng).toBeDisabled();
  });

  test('add, move, cut and undo bodies', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop flow');
    await page.goto('/?fixture=plate');
    await ready(page);
    await page.getByRole('button', { name: 'Add box' }).click();
    await ready(page);
    await expect(bodies(page)).toHaveCount(2);
    await bodies(page).filter({ hasText: 'Box' }).click();
    const x = inspector(page).getByLabel('X (mm)');
    // New bodies land beside the plate; move the box back over its corner.
    await x.fill('-60');
    await x.press('Enter');
    await ready(page);
    await bodies(page).filter({ hasText: 'plate' }).click();
    await expect(inspector(page)).toContainText('19607.301 mm³');
    await inspector(page).getByLabel('With body').selectOption({ label: 'Box' });
    await inspector(page).getByRole('button', { name: 'Cut' }).click();
    await ready(page);
    await expect(bodies(page)).toHaveCount(1);
    await expect(inspector(page)).not.toContainText('19607.301 mm³');
    await page.screenshot({ path: test.info().outputPath('cut.png') });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await ready(page);
    await expect(bodies(page)).toHaveCount(2);
  });

  test('narrow layout keeps the viewport and toolbar usable', async ({ page }) => {
    test.skip(test.info().project.name === 'desktop', 'narrow layout');
    await page.goto('/');
    await (await tool(page, 'Add cylinder')).click();
    await ready(page);
    await page.keyboard.press('Escape');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath('narrow.png') });
    await page.getByRole('button', { name: 'Toggle Elements' }).click();
    await expect(bodies(page)).toHaveCount(1);
  });
});

test('missing kernel build keeps the document readable', async ({ page }) => {
  await page.goto('/?fixture=plate&kernel=missing');
  await expect(state(page)).toHaveText('Shape could not be calculated');
  if (test.info().project.name !== 'desktop') return;
  await expect(bodies(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Add box' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(bodies(page)).toHaveCount(1);
});

test('read-only host disables editing', async ({ page }) => {
  await page.goto('/?fixture=plate&readonly=1&kernel=missing');
  await expect(await tool(page, 'Add box')).toBeDisabled();
  await expect(page.getByText('Read only')).toBeVisible();
});

test('history shortcuts belong to the Surface last used', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop layout');
  await page.goto('/?fixture=plate&kernel=missing&pair=1');
  const [first, second] = [page.getByTestId('surface-0'), page.getByTestId('surface-1')];
  const plate = (surface: typeof first) =>
    surface.getByRole('list', { name: 'Bodies' }).getByRole('button', { name: /plate/ });
  await plate(first).click();
  await plate(second).click();
  await expect(plate(first)).toHaveAttribute('aria-pressed', 'true');
  // Focus falls back to <body>: Escape goes to the Surface used last, not the first mounted.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(plate(second)).toHaveAttribute('aria-pressed', 'false');
  await expect(plate(first)).toHaveAttribute('aria-pressed', 'true');
});

test('Inspector fields wait while an edit evaluates', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop layout');
  await page.goto('/?fixture=plate&kernel=missing');
  await expect(state(page)).toHaveText('Shape could not be calculated');
  // Stall the kernel so the edit stays pending.
  await page.evaluate(() => {
    const { port } = (window as unknown as { cad: { port: { evaluate: unknown } } }).cad;
    port.evaluate = () => new Promise(() => {});
  });
  await page
    .getByRole('list', { name: 'Parameters' })
    .getByRole('button', { name: /Width/ })
    .click();
  const value = inspector(page).getByLabel('Value (mm)');
  await value.fill('100');
  await value.press('Enter');
  await expect(state(page)).toHaveText('Calculating…');
  await expect(value).toBeDisabled();
  await expect(inspector(page).getByLabel('Name')).toBeDisabled();
});
