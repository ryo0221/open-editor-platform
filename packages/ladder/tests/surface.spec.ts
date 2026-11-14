import { expect, test, type Locator, type Page } from '@playwright/test';

// The ladder Surface's test host (SL7b, ST-571, TS-2114).

type Node = { id: string; kind: string; variable?: string; items?: Node[]; branches?: Node[] };
type Doc = {
  scanMs: number;
  variables: { name: string; type: string; role: string }[];
  rungs: {
    id: string;
    comment?: string;
    network: Node;
    coils: { id: string; variable: string }[];
  }[];
};
const content = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { ladderSession: { content: Doc } }).ladderSession.content,
  );
/** The network as text: contacts by variable, `(a b)` series, `[a | b]` parallel, boxes by kind. */
const text = (n: Node): string =>
  n.kind === 'contact'
    ? n.variable!
    : n.kind === 'series'
      ? `(${n.items!.map(text).join(' ')})`
      : n.kind === 'parallel'
        ? `[${n.branches!.map(text).join(' | ')}]`
        : n.kind;
const cell = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });
const value = (page: Page, name: string) => page.getByTestId(`lad-value-${name}`);
async function drag(page: Page, from: Locator, to: Locator, side: 'left' | 'right') {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2, { steps: 4 });
  const x = side === 'left' ? b.x + b.width * 0.25 : b.x + b.width * 0.75;
  await page.mouse.move(x, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.skip(({ viewport }) => (viewport?.width ?? 0) < 800, 'editing needs the desktop layout');

test('edits a rung on the grid: add, branch, move, delete, undo', async ({ page }) => {
  await page.goto('/?fixture=hold');
  await expect(cell(page, 'NO contact START')).toBeVisible();
  // A new rung with its own output coil, then a contact, a timer and a branch.
  await page.getByRole('button', { name: 'Add rung', exact: true }).click();
  let doc = await content(page);
  expect(doc.rungs).toHaveLength(2);
  expect(doc.rungs[1].coils[0].variable).toBe('Y1');
  await page.getByRole('button', { name: 'Add after', exact: true }).click();
  await page.getByLabel('Element to add').selectOption('timer');
  await page.getByRole('button', { name: 'Add after', exact: true }).click();
  await page.getByLabel('Element to add').selectOption('nc');
  await page.getByRole('button', { name: 'Add branch', exact: true }).click();
  doc = await content(page);
  expect(text(doc.rungs[1].network)).toBe('(START [timer | START])');
  expect(doc.variables.map((v) => v.name)).toContain('T1');
  await expect(cell(page, 'Timer T1')).toBeVisible();
  await expect(cell(page, 'NC contact START')).toBeVisible();
  // The inspector edits the selected contact: STOP instead of START.
  await page.getByLabel('Variable', { exact: true }).selectOption('STOP');
  doc = await content(page);
  expect(text(doc.rungs[1].network)).toBe('(START [timer | STOP])');
  // Drag the timer before the first contact of the same rung.
  const rung2 = page.locator('[data-rung]').nth(1);
  await drag(
    page,
    rung2.getByRole('button', { name: 'Timer T1' }),
    rung2.getByRole('button', { name: 'NO contact START' }),
    'left',
  );
  doc = await content(page);
  expect(text(doc.rungs[1].network)).toBe('(timer START STOP)');
  // Drag the NC STOP contact into rung 1, after STOP there.
  await drag(
    page,
    rung2.getByRole('button', { name: 'NC contact STOP' }),
    page.locator('[data-rung]').first().getByRole('button', { name: 'NC contact STOP' }),
    'right',
  );
  doc = await content(page);
  expect(text(doc.rungs[0].network)).toBe('([START | LAMP] STOP STOP)');
  expect(text(doc.rungs[1].network)).toBe('(timer START)');
  // Undo puts it back; Delete removes the selected element.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  doc = await content(page);
  expect(text(doc.rungs[1].network)).toBe('(timer START STOP)');
  await rung2.getByRole('button', { name: 'Timer T1' }).click();
  await page.keyboard.press('Delete');
  doc = await content(page);
  expect(text(doc.rungs[1].network)).toBe('(START STOP)');
  // A refused draft in a panel keeps the element: the Delete key settles the inputs first.
  await page
    .locator('[data-rung]')
    .nth(1)
    .getByRole('button', { name: 'NO contact START', exact: true })
    .click();
  await page.getByLabel('Element to add').selectOption('timer');
  await page.getByRole('button', { name: 'Add after', exact: true }).click();
  await page.getByLabel('Preset (ms)').fill('soon');
  await page.getByLabel('Preset (ms)').press('Enter');
  await expect(page.getByTestId('lad-notice')).toContainText('preset');
  await page.getByTestId('lad-status').click();
  await page.keyboard.press('Delete');
  doc = await content(page);
  expect(text(doc.rungs[1].network)).toBe('(START timer STOP)');
  await page.getByLabel('Preset (ms)').fill('500');
  await page.getByLabel('Preset (ms)').press('Enter');
  await page.getByTestId('lad-status').click();
  await page.keyboard.press('Delete');
  doc = await content(page);
  expect(text(doc.rungs[1].network)).toBe('(START STOP)');
  // A rung's only coil cannot go: the notice says why and nothing changes.
  await rung2.getByRole('button', { name: 'Coil Y1' }).click();
  await page.getByRole('button', { name: 'Delete selection', exact: true }).click();
  await expect(page.getByTestId('lad-notice')).toContainText('rung-no-coil');
  expect((await content(page)).rungs[1].coils).toHaveLength(1);
});

test('edits variables and the rung comment; refuses a variable still in use', async ({ page }) => {
  await page.goto('/?fixture=hold');
  const lamp = page.locator('tr[data-variable="LAMP"]');
  await lamp.getByLabel('Name of LAMP').fill('LIGHT');
  await lamp.getByLabel('Name of LAMP').press('Enter');
  await expect(cell(page, 'Coil LIGHT')).toBeVisible();
  await expect(cell(page, 'NO contact LIGHT')).toBeVisible();
  await page
    .locator('tr[data-variable="STOP"]')
    .getByRole('button', { name: 'Delete STOP' })
    .click();
  await expect(page.getByTestId('lad-notice')).toContainText('variable-missing');
  await page.getByRole('button', { name: 'Add variable', exact: true }).click();
  await expect(page.locator('tr[data-variable="M1"]')).toBeVisible();
  // Select the rung by its number and comment it.
  await page.locator('[data-rung]').first().locator('.lad-rung-no').click();
  await page.getByLabel('Comment').fill('Hold the light');
  await page.getByLabel('Comment').press('Enter');
  expect((await content(page)).rungs[0].comment).toBe('Hold the light');
  await expect(page.locator('.lad-comment')).toHaveText('Hold the light');
  // Scan period.
  await page.getByLabel('Scan period (ms)').fill('20');
  await page.getByLabel('Scan period (ms)').press('Enter');
  expect((await content(page)).scanMs).toBe(20);
  await expect(page.getByTestId('lad-status')).toContainText('20 ms per scan');
});

test('runs: press START, the lamp holds; STOP drops it; power is coloured; edits wait', async ({
  page,
}) => {
  await page.goto('/?fixture=hold');
  const start = page.getByRole('button', { name: 'Press START', exact: true });
  // One scan while START is held.
  const box = (await start.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.getByRole('button', { name: 'One scan', exact: true }).dispatchEvent('click');
  await page.mouse.up();
  await expect(value(page, 'LAMP')).toHaveAttribute('data-value', 'TRUE');
  await expect(cell(page, 'Coil LAMP')).toHaveAttribute('data-on', 'true');
  await expect(cell(page, 'NO contact START')).toHaveAttribute('data-on', 'true');
  // Run: released, the lamp holds through its own contact.
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('lad-status')).toContainText('Running');
  await expect
    .poll(async () =>
      Number(/scan (\d+)/.exec((await page.getByTestId('lad-status').textContent())!)![1]),
    )
    .toBeGreaterThan(5);
  await expect(value(page, 'LAMP')).toHaveAttribute('data-value', 'TRUE');
  await expect(cell(page, 'NO contact START')).not.toHaveAttribute('data-on', 'true');
  await expect(cell(page, 'NO contact LAMP')).toHaveAttribute('data-on', 'true');
  // Editing waits until it stops.
  await expect(page.getByRole('button', { name: 'Add rung', exact: true })).toBeDisabled();
  // STOP held on drops the lamp, and it stays off when released.
  await page.getByRole('button', { name: 'Hold STOP on', exact: true }).click();
  await expect(value(page, 'LAMP')).toHaveAttribute('data-value', 'FALSE');
  await page.getByRole('button', { name: 'Hold STOP on', exact: true }).click();
  await page.waitForTimeout(100);
  await expect(value(page, 'LAMP')).toHaveAttribute('data-value', 'FALSE');
  await expect(cell(page, 'Coil LAMP')).not.toHaveAttribute('data-on', 'true');
  // Forcing the lamp on.
  await page.getByLabel('Force LAMP').selectOption('TRUE');
  await expect(value(page, 'LAMP')).toHaveAttribute('data-value', 'TRUE');
  await expect(value(page, 'LAMP')).toHaveAttribute('data-forced', 'true');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add rung', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByTestId('lad-status')).toContainText('scan 0');
  await expect(value(page, 'LAMP')).toHaveAttribute('data-value', 'FALSE');
});

test('shows timer and counter current values; a timer preset changes the blink', async ({
  page,
}) => {
  await page.goto('/?fixture=blink');
  await page.getByRole('button', { name: 'Hold ENABLE on', exact: true }).click();
  for (let i = 0; i < 30; i++)
    await page.getByRole('button', { name: 'One scan', exact: true }).click();
  const t = cell(page, 'Timer T_ON');
  await expect(t.locator('[data-line="1"]')).toHaveText(/ET \d+ ms/);
  await expect(value(page, 'T_ON')).toContainText('ET');
  // A shorter on-time: the lamp goes off sooner (virtual time, so the count of scans is exact).
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await t.click();
  await page.getByLabel('Preset (ms)').fill('100');
  await page.getByLabel('Preset (ms)').press('Enter');
  await expect(t.locator('[data-line="0"]')).toHaveText('PT 100 ms');
  await page.getByRole('button', { name: 'Hold ENABLE on', exact: true }).click();
  let scans = 0;
  await page.getByRole('button', { name: 'One scan', exact: true }).click();
  await expect(value(page, 'LAMP')).toHaveAttribute('data-value', 'TRUE');
  while ((await value(page, 'LAMP').getAttribute('data-value')) === 'TRUE' && scans < 60) {
    await page.getByRole('button', { name: 'One scan', exact: true }).click();
    scans++;
  }
  expect(scans).toBeGreaterThan(5);
  expect(scans).toBeLessThan(20);

  await page.goto('/?fixture=counter');
  const counter = cell(page, 'Counter COUNT');
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Hold PULSE on', exact: true }).click();
    await page.getByRole('button', { name: 'One scan', exact: true }).click();
    await page.getByRole('button', { name: 'Hold PULSE on', exact: true }).click();
    await page.getByRole('button', { name: 'One scan', exact: true }).click();
  }
  await expect(counter.locator('[data-line="1"]')).toHaveText('CV 2');
  await expect(value(page, 'COUNT')).toContainText('CV 2');
  await expect(value(page, 'HALF')).toHaveAttribute('data-value', 'TRUE');
  await expect(page.locator('[data-kind="compare"]')).toHaveAttribute('data-on', 'true');
});

test('read-only: runs, but every edit is disabled', async ({ page }) => {
  await page.goto('/?fixture=hold&readonly=1');
  await expect(page.getByRole('button', { name: 'Add rung', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add after', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Hold START on', exact: true }).click();
  await page.getByRole('button', { name: 'One scan', exact: true }).click();
  await expect(value(page, 'LAMP')).toHaveAttribute('data-value', 'TRUE');
});
