import { expect, test, type Page } from '@playwright/test';

// The co-simulation Surface's test host (SL8b, ST-574, TS-2119).

test.skip(({ viewport }) => (viewport?.width ?? 0) < 800, 'the setup needs the desktop layout');

type Doc = {
  schematic?: { versionId: string };
  bindings: { variable: string; net: string; kind: string; activeLow?: boolean }[];
};
const content = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { cosimSession: { content: Doc } }).cosimSession.content,
  );
const current = (page: Page) =>
  page.getByTestId('cosim-current-D1').evaluate((e) => Number(e.getAttribute('data-value')));
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test('the button latches the LED through the ladder program, STOP drops it', async ({ page }) => {
  await page.goto('/?fixture=hold');
  await expect(page.getByTestId('cosim-status')).toContainText('Stopped');
  await expect(page.getByTestId('cosim-sheet').locator('svg').first()).toBeVisible();
  await expect(page.getByTestId('cosim-ladder').locator('[data-rung]')).toHaveCount(1);
  await button(page, 'Run').click();
  await expect(page.getByTestId('cosim-status')).toContainText('Running');
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'false');
  await page.getByRole('button', { name: 'Press SW1' }).click();
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'true');
  await expect.poll(() => current(page)).toBeGreaterThan(1e-3);
  // The LED glows on the sheet; the rung's coil is powered.
  await expect(page.getByTestId('cosim-ladder').locator('.lad-wire[data-on]')).not.toHaveCount(0);
  // Released, it stays on (self-hold) until STOP.
  await page.waitForTimeout(200);
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'true');
  await page.getByRole('button', { name: 'Hold STOP on' }).click();
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'false');
  await expect.poll(() => current(page)).toBeLessThan(1e-5);
  // No edits while running.
  await expect(page.getByRole('button', { name: 'Delete binding 1' })).toBeDisabled();
  await button(page, 'Stop').click();
  await expect(page.getByTestId('cosim-status')).toContainText('Stopped');
});

test('a 1 kΩ resistor version gives less current; bindings are edited and undone', async ({
  page,
}) => {
  await page.goto('/?fixture=hold');
  await expect(page.getByLabel('Schematic', { exact: true })).toBeEnabled();
  const run = async () => {
    await button(page, 'Reset').click();
    await page.getByRole('button', { name: 'Hold SW1 closed' }).click();
    for (let k = 0; k < 5; k++) await button(page, 'One scan').click();
    return current(page);
  };
  const at330 = await run();
  expect(at330).toBeGreaterThan(1e-3);
  await page
    .getByLabel('Schematic', { exact: true })
    .selectOption({ label: 'LED and button · v2 — 1 kΩ' });
  await expect.poll(async () => (await content(page)).schematic?.versionId).toBe('v2');
  await expect(page.getByTestId('cosim-status')).toContainText('scan 0');
  const at1k = await run();
  expect(at1k).toBeGreaterThan(1e-4);
  expect(at1k).toBeLessThan(at330 / 2);

  await page.getByRole('checkbox', { name: 'Active low 1' }).uncheck();
  await expect.poll(async () => (await content(page)).bindings[0].activeLow).toBeUndefined();
  await button(page, 'Undo').click();
  await expect.poll(async () => (await content(page)).bindings[0].activeLow).toBe(true);
  await button(page, 'Delete binding 2').click();
  await expect.poll(async () => (await content(page)).bindings.length).toBe(1);
  await button(page, 'Add output binding').click();
  await expect.poll(async () => (await content(page)).bindings[1]?.variable).toBe('LAMP');
});

test('read only: sources and bindings cannot change, running still works', async ({ page }) => {
  await page.goto('/?fixture=hold&readonly=1');
  await expect(page.getByLabel('Schematic', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add input binding' })).toBeDisabled();
  await expect(button(page, 'Undo')).toBeDisabled();
  await page.getByRole('button', { name: 'Hold SW1 closed' }).click();
  await button(page, 'One scan').click();
  await button(page, 'One scan').click();
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'true');
});

test('an empty co-simulation asks for sources', async ({ page }) => {
  await page.goto('/?fixture=empty');
  await expect(page.getByText('Choose a saved schematic version.')).toBeVisible();
  await expect(button(page, 'Run')).toBeDisabled();
  await page
    .getByLabel('Ladder program', { exact: true })
    .selectOption({ label: 'Programs · v2 — blink' });
  await expect(page.getByTestId('cosim-ladder').locator('[data-rung]')).toHaveCount(3);
});

test('a press settles a name draft first; an unbound input shows its initial value', async ({
  page,
}) => {
  await page.goto('/?fixture=hold');
  await expect(page.getByLabel('Schematic', { exact: true })).toBeEnabled();
  await page.getByLabel('Name', { exact: true }).fill('Renamed');
  await page.getByRole('button', { name: 'Press SW1' }).click();
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            (window as unknown as { cosimSession: { content: { name: string } } }).cosimSession
              .content.name,
        ),
    )
    .toBe('Renamed');
  await button(page, 'One scan').click();
  await button(page, 'One scan').click();
  await button(page, 'One scan').click();
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'true');

  await page
    .getByLabel('Ladder program', { exact: true })
    .selectOption({ label: 'Programs · v3 — STOP held' });
  await expect(page.getByRole('button', { name: 'Hold STOP on' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Hold STOP on' }).click();
  await expect(page.getByRole('button', { name: 'Hold STOP on' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
