import { cosimHatExample } from '@editor-platform/cosim-core';
import { ladderBlinkExample } from '@editor-platform/ladder-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// SL8d (ST-576, TS-2123): the L1 and L3 checks in the ordinary Playground screens, with the
// examples F90 (sensor HAT+ schematic), F91 (self-hold, blink) and F92 (co-simulation).

test.skip(({ viewport }) => (viewport?.width ?? 0) < 800, 'desktop flow');

const tool = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const sch = (page: Page) => page.locator('.sch-inspector');
async function importJson(page: Page, name: string, value: unknown) {
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}
/** Makes an artifact of `kind` holding `content` (made by a builder, SL8 allows it). */
async function imported(page: Page, kind: string, name: string, content: unknown) {
  await create(page, kind);
  const record = await nativeArtifact(page);
  await importJson(page, `${kind}.json`, {
    ...record,
    name,
    draft: { ...record.draft, content },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(name);
}
async function open(page: Page, name: string) {
  if (!(await page.getByRole('navigation', { name: 'Artifacts' }).isVisible()))
    await tool(page, 'Toggle library').click();
  await page
    .getByRole('navigation', { name: 'Artifacts' })
    .getByRole('button', {
      name: new RegExp(`^\\S+ ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `),
    })
    .first()
    .click();
  await expect(page.getByLabel('Artifact name')).toHaveValue(name);
}
/** The screen point of a sheet point (mm, y down), read from the SVG's viewBox. */
async function clickSheet(page: Page, p: [number, number]) {
  const svg = page.getByTestId('sch-canvas');
  const box = (await svg.boundingBox())!;
  const [vx, vy, vw, vh] = (await svg.getAttribute('viewBox'))!.split(' ').map(Number);
  await page.mouse.click(
    box.x + ((p[0] - vx) / vw) * box.width,
    box.y + ((p[1] - vy) / vh) * box.height,
  );
}
const ledCurrent = (page: Page) =>
  page.getByTestId('cosim-current-D1').evaluate((e) => Number(e.getAttribute('data-value')));

test('L1: the HAT schematic (F90) has no ERC findings and matches the F76 board; an added LED shows in the diff', async ({
  page,
}) => {
  await page.goto('/');
  await imported(page, 'schematic', 'Sensor HAT+ schematic', cosimHatExample().schematic);
  await expect(page.getByTestId('sch-erc-clean')).toBeVisible();
  await save(page, 1);

  // A new board from the F76 template.
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await tool(page, 'Toggle library').click();
  await page.getByLabel('Artifact type', { exact: true }).selectOption('pcb');
  await page.getByLabel('Board template').selectOption('hat');
  await page.getByRole('button', { name: 'New artifact' }).click();
  await expect(page.getByLabel('Artifact name')).toHaveValue('Sensor HAT+ 1');
  const board = page.locator('.pcb-inspector');
  await board
    .getByLabel('Schematic version')
    .selectOption({ label: 'Sensor HAT+ schematic v1 — Manual save' });
  await expect(page.getByTestId('pcb-schematic-clean')).toBeVisible();

  // L3 (3): one more LED, its anode on the GND port right of SW1, then send the new version.
  await open(page, 'Sensor HAT+ schematic');
  await page.getByLabel('Symbol to place').selectOption({ label: 'LED (red)' });
  await clickSheet(page, [195.58, 215.9]);
  await tool(page, 'Select').click();
  await expect(
    page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^D2 · / }),
  ).toBeVisible();
  await save(page, 2);
  await open(page, 'Sensor HAT+ 1');
  await board
    .getByLabel('Schematic version')
    .selectOption({ label: 'Sensor HAT+ schematic v2 — Manual save' });
  const changes = page.getByTestId('pcb-schematic-changes').locator('li');
  await expect(changes.filter({ hasText: 'Add part D2' })).toHaveCount(1);
  await expect(changes.filter({ hasText: 'GND' })).toContainText('D2.2');
});

test('L3: the button latches the LED through the program; 1 kΩ gives less current', async ({
  page,
}) => {
  const f92 = cosimHatExample();
  await page.goto('/');
  await imported(page, 'schematic', 'HAT', f92.schematic);
  await save(page, 1);
  await imported(page, 'ladder', 'Self-hold', f92.ladder);
  await save(page, 1);
  await create(page, 'cosim');
  await page
    .getByLabel('Schematic', { exact: true })
    .selectOption({ label: 'HAT · v1 — Manual save' });
  await page
    .getByLabel('Ladder program', { exact: true })
    .selectOption({ label: 'Self-hold · v1 — Manual save' });
  await tool(page, 'Add input binding').click();
  await page.getByLabel('Net 1', { exact: true }).selectOption('GPIO27');
  await page.getByRole('checkbox', { name: 'Active low 1' }).check();
  await tool(page, 'Add output binding').click();
  await page.getByLabel('Net 2', { exact: true }).selectOption('GPIO17');
  await expect
    .poll(
      async () => ((await nativeArtifact(page)).draft.content as { bindings: unknown }).bindings,
    )
    .toEqual(f92.bindings);

  await tool(page, 'Run').click();
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'false');
  await tool(page, 'Press SW1').click();
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'true');
  await expect.poll(() => ledCurrent(page)).toBeGreaterThan(1e-3);
  // Pressed again: still on (self-hold). STOP turns it off.
  await tool(page, 'Press SW1').click();
  await page.waitForTimeout(100);
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'true');
  await tool(page, 'Hold STOP on').click();
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'false');
  await tool(page, 'Stop').click();
  const at330 = await (async () => {
    await tool(page, 'Reset').click();
    await tool(page, 'Hold SW1 closed').click();
    for (let k = 0; k < 4; k++) await tool(page, 'One scan').click();
    return ledCurrent(page);
  })();
  expect(at330).toBeGreaterThan(1e-3);

  // L3 (1): R4 330 Ω → 1 kΩ in the schematic screen, a new version, chosen in the co-simulation.
  await open(page, 'HAT');
  await page
    .getByRole('list', { name: 'Parts' })
    .getByRole('button', { name: /^R4 · / })
    .click();
  const ohms = sch(page).getByLabel('Resistance (Ω)');
  await ohms.fill('1k');
  await ohms.press('Enter');
  await save(page, 2);
  await open(page, 'Co-simulation 1');
  await page
    .getByLabel('Schematic', { exact: true })
    .selectOption({ label: 'HAT · v2 — Manual save' });
  await expect(page.getByTestId('cosim-status')).toContainText('scan 0');
  await tool(page, 'Hold SW1 closed').click();
  for (let k = 0; k < 4; k++) await tool(page, 'One scan').click();
  const at1k = await ledCurrent(page);
  expect(at1k).toBeGreaterThan(1e-4);
  expect(at1k).toBeLessThan(at330 / 2);
});

test('L3 (2): a shorter timer preset makes the blink faster', async ({ page }) => {
  await page.goto('/');
  await imported(page, 'ladder', 'Blink', ladderBlinkExample());
  const lamp = page.getByTestId('lad-value-LAMP');
  const scans = async (n: number) => {
    for (let k = 0; k < n; k++) await tool(page, 'One scan').click();
  };
  await tool(page, 'Hold ENABLE on').click();
  await scans(30);
  // 500 ms on at 10 ms a scan: still on after 300 ms.
  await expect(lamp).toHaveAttribute('data-value', 'TRUE');
  await tool(page, 'Reset').click();
  await tool(page, 'Timer T_ON').click();
  const preset = page.getByLabel('Preset (ms)');
  await preset.fill('200');
  await preset.press('Enter');
  await tool(page, 'Hold ENABLE on').click();
  await scans(30);
  await expect(lamp).toHaveAttribute('data-value', 'FALSE');
});
