import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

// The circuit board Surface's test host (PB1, ST-460, TS-1921). No kernel.

/** The screen point of a board point (mm), read from the SVG's viewBox. */
async function screenOf(page: Page, p: [number, number]) {
  const svg = page.getByTestId('pcb-canvas');
  const box = (await svg.boundingBox())!;
  const [vx, vy, vw, vh] = (await svg.getAttribute('viewBox'))!.split(' ').map(Number);
  return {
    x: box.x + ((p[0] - vx) / vw) * box.width,
    y: box.y + ((-p[1] - vy) / vh) * box.height,
  };
}
async function clickBoard(page: Page, p: [number, number]) {
  const s = await screenOf(page, p);
  await page.mouse.click(s.x, s.y);
}
const status = (page: Page) => page.getByTestId('pcb-status');
const content = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { pcbSession: { content: unknown } }).pcbSession.content as {
        board: { outline: number[][]; thicknessMm: number; copperLayers: number };
        holes: { id: string; at: [number, number]; drillMm: number }[];
        footprints: {
          id: string;
          name: string;
          pads: { number: string; at: [number, number] }[];
        }[];
        components: {
          id: string;
          ref: string;
          footprint: string;
          at: [number, number];
          rotationDeg: number;
          side: string;
          locked: boolean;
        }[];
        nets: { id: string; name: string; class: string; pins: [string, string][] }[];
        netClasses: { id: string; name: string; trackWidthMm: number }[];
        tracks: {
          id: string;
          net: string;
          layer: string;
          widthMm: number;
          from: [number, number];
          to: [number, number];
        }[];
        vias: { id: string; net: string; at: [number, number] }[];
      },
  );

test('opens the Raspberry Pi 5 form-factor board (F75)', async ({ page }) => {
  await page.goto('/?fixture=f75');
  await expect(status(page)).toContainText('85 × 56 mm');
  await expect(status(page)).toContainText('4 copper layers · 4 holes');
  await expect(page.getByTestId('pcb-board')).toBeVisible();
  for (const id of ['mh-1', 'mh-2', 'mh-3', 'mh-4'])
    await expect(page.getByTestId(`pcb-hole-${id}`)).toHaveCount(1);
});

test.describe('editing', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 800, 'drawing needs the desktop layout');

  test('shapes the board, places and moves holes, with undo', async ({ page }) => {
    await page.goto('/?fixture=starter');
    await expect(status(page)).toContainText('100 × 80 mm');
    // A Pi 5 sized rectangle from the inspector.
    const inspector = page.locator('.pcb-inspector');
    await inspector.getByLabel('Width (mm)', { exact: true }).fill('85');
    await inspector.getByLabel('Width (mm)', { exact: true }).press('Enter');
    await inspector.getByLabel('Height (mm)', { exact: true }).fill('56');
    await inspector.getByLabel('Height (mm)', { exact: true }).press('Enter');
    await inspector.getByLabel('Corner radius (mm)').fill('3');
    await inspector.getByLabel('Corner radius (mm)').press('Enter');
    await inspector.getByRole('button', { name: 'Apply rectangle' }).click();
    await expect(page.getByTestId('pcb-board-size')).toHaveText('85 × 56 mm');
    await page.getByRole('button', { name: 'Fit board' }).click();

    // A hole by clicking, snapped to the 0.5 mm grid.
    await page.getByRole('button', { name: 'Add mounting hole' }).click();
    await clickBoard(page, [3.5, 3.5]);
    await expect(status(page)).toContainText('1 holes');
    expect((await content(page)).holes[0]).toMatchObject({ at: [3.5, 3.5], drillMm: 3.2 });
    // Outside the board: refused by code, nothing added.
    await clickBoard(page, [84.5, 28]);
    await expect(page.getByRole('status')).toContainText('hole-outside');
    await expect(status(page)).toContainText('1 holes');
    await page.keyboard.press('Escape');

    // Typed values in the hole's inspector.
    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByRole('list', { name: 'Holes' }).getByRole('button').first().click();
    await inspector.getByLabel('Drill (mm)', { exact: true }).fill('2.7');
    await inspector.getByLabel('Drill (mm)', { exact: true }).press('Enter');
    await expect.poll(async () => (await content(page)).holes[0].drillMm).toBe(2.7);

    // Drag the hole to (61.5, 3.5).
    const from = await screenOf(page, [3.5, 3.5]);
    const to = await screenOf(page, [61.5, 3.5]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await content(page)).holes[0].at).toEqual([61.5, 3.5]);

    // Undo the move, then the drill.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await content(page)).holes[0].at).toEqual([3.5, 3.5]);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await content(page)).holes[0].drillMm).toBe(3.2);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect.poll(async () => (await content(page)).holes[0].drillMm).toBe(2.7);

    // A refused value stays with its hole: clicking away does not drop it.
    await inspector.getByLabel('X (mm)').fill('200');
    await inspector.getByLabel('X (mm)').press('Enter');
    await expect(page.getByRole('status')).toContainText('hole-outside');
    await clickBoard(page, [40, 30]);
    await expect(inspector.getByLabel('X (mm)')).toHaveValue('200');
    await inspector.getByLabel('X (mm)').fill('3.5');
    await inspector.getByLabel('X (mm)').press('Enter');
    await clickBoard(page, [40, 30]);
    await expect(inspector.getByLabel('Drill (mm)', { exact: true })).toHaveCount(0);

    // Delete it from the keyboard.
    await page.getByRole('list', { name: 'Holes' }).getByRole('button').first().click();
    await page.getByTestId('pcb-canvas').hover();
    await page.keyboard.press('Delete');
    await expect(status(page)).toContainText('0 holes');
  });

  test('draws an outline by clicking corners', async ({ page }) => {
    await page.goto('/?fixture=starter');
    await page.getByRole('button', { name: 'Draw board outline' }).click();
    for (const p of [
      [0, 0],
      [60, 0],
      [60, 40],
      [20, 40],
    ] as [number, number][])
      await clickBoard(page, p);
    await expect(page.getByTestId('pcb-outline-preview')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pcb-board-size')).toHaveText('60 × 40 mm');
    expect((await content(page)).board.outline).toEqual([
      [0, 0],
      [60, 0],
      [60, 40],
      [20, 40],
    ]);
    // A crossing outline is refused and the board stays.
    await page.getByRole('button', { name: 'Draw board outline' }).click();
    for (const p of [
      [0, 0],
      [30, 30],
      [30, 0],
      [0, 30],
    ] as [number, number][])
      await clickBoard(page, p);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('loop-not-simple');
    await expect(page.getByTestId('pcb-board-size')).toHaveText('60 × 40 mm');
  });

  test('places, turns, flips, moves and deletes parts (PB2, TS-1924)', async ({ page }) => {
    await page.goto('/?fixture=f75');
    const inspector = page.locator('.pcb-inspector');
    await page.getByRole('button', { name: 'Place part' }).click();
    // The 40-pin header on its Pi 5 position.
    await inspector.getByLabel('Part').selectOption('pin-header');
    await expect(page.getByTestId('pcb-place-summary')).toContainText('40 pads');
    await clickBoard(page, [8.5, 51]);
    await expect(status(page)).toContainText('1 parts');
    let doc = await content(page);
    expect(doc.components[0]).toMatchObject({ ref: 'J1', at: [8.5, 51], side: 'top' });
    expect(doc.footprints[0].pads).toHaveLength(40);
    // Two 0603 resistors share one footprint; the second overlaps the first.
    await inspector.getByLabel('Part').selectOption('chip');
    await clickBoard(page, [30, 30]);
    await clickBoard(page, [31, 30]);
    doc = await content(page);
    expect(doc.components.map((c) => c.ref)).toEqual(['J1', 'R1', 'R2']);
    expect(doc.footprints).toHaveLength(2);
    await expect(page.getByRole('list', { name: 'Placement problems' })).toContainText(
      'Parts overlap: R1, R2',
    );
    await expect(page.getByTestId('pcb-part-ghost')).toHaveCount(1);
    await page.keyboard.press('Escape');
    // Typed coordinates put the header on its exact Pi 5 position.
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^J1/ }).click();
    await inspector.getByLabel('X (mm)').fill('8.37');
    await inspector.getByLabel('X (mm)').press('Enter');
    await inspector.getByLabel('Y (mm)').fill('51.23');
    await inspector.getByLabel('Y (mm)').press('Enter');
    await expect.poll(async () => (await content(page)).components[0].at).toEqual([8.37, 51.23]);
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^R2/ }).click();

    // R turns, F flips the selected part .
    await page.getByTestId('pcb-canvas').hover();
    await page.keyboard.press('r');
    await expect.poll(async () => (await content(page)).components[2].rotationDeg).toBe(90);
    await page.keyboard.press('f');
    await expect.poll(async () => (await content(page)).components[2].side).toBe('bottom');
    // Other sides do not collide.
    await expect(page.getByRole('list', { name: 'Placement problems' })).toHaveCount(0);

    // Drag R1 by its body.
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^R1/ }).click();
    const from = await screenOf(page, [30, 30]);
    const to = await screenOf(page, [40, 20]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await content(page)).components[1].at).toEqual([40, 20]);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await content(page)).components[1].at).toEqual([30, 30]);

    // A duplicate reference is refused by code.
    await inspector.getByLabel('Reference').fill('J1');
    await inspector.getByLabel('Reference').press('Enter');
    await expect(page.getByRole('status')).toContainText('ref-duplicate');
    await inspector.getByLabel('Reference').fill('R10');
    await inspector.getByLabel('Reference').press('Enter');
    await expect.poll(async () => (await content(page)).components[1].ref).toBe('R10');

    // A locked part does not move or delete.
    await inspector.getByLabel('Locked').check();
    await inspector.getByLabel('X (mm)').fill('50');
    await inspector.getByLabel('X (mm)').press('Enter');
    await expect(page.getByRole('status')).toContainText('locked');
    await inspector.getByLabel('X (mm)').fill('30');
    await inspector.getByLabel('X (mm)').press('Enter');
    await page.getByTestId('pcb-canvas').hover();
    await page.keyboard.press('Delete');
    await page.keyboard.press('r');
    doc = await content(page);
    expect(doc.components).toHaveLength(3);

    // A part setting typed but not committed still reaches the next placement.
    await page.getByRole('button', { name: 'Place part' }).click();
    await inspector.getByLabel('Part').selectOption('pin-header');
    await inspector.getByLabel('Pins per row').fill('10');
    await clickBoard(page, [40, 40]);
    doc = await content(page);
    expect(doc.footprints.at(-1)!.pads).toHaveLength(20);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^R10/ }).click();
    expect(doc.components[1]).toMatchObject({ rotationDeg: 0, locked: true });
    await inspector.getByLabel('Locked').uncheck();
    await inspector.getByRole('button', { name: 'Delete part' }).click();
    await expect(status(page)).toContainText('3 parts');
  });

  test('connects pads by nets and draws the ratsnest (PB3, TS-1926)', async ({ page }) => {
    await page.goto('/?fixture=f75');
    const inspector = page.locator('.pcb-inspector');
    await page.getByRole('button', { name: 'Place part' }).click();
    await inspector.getByLabel('Part').selectOption('pin-header');
    await clickBoard(page, [8.5, 51]);
    await inspector.getByLabel('Part').selectOption('chip');
    await clickBoard(page, [20, 20]);
    await clickBoard(page, [40, 20]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^R1/ }).click();
    await page.getByRole('button', { name: 'Board', exact: true }).click();

    // A net list by references; GND joins three pads with two lines.
    await inspector
      .getByLabel('Net list (JSON)')
      .fill(
        '{"nets":[{"name":"GND","pins":["J1.6","R1.2","R2.2"]},{"name":"3V3","pins":["J1.1","R1.1"]}]}',
      );
    await inspector.getByRole('button', { name: 'Import nets' }).click();
    await expect(status(page)).toContainText('2 nets · 0 tracks · 0 vias · 0 zones · 3 unrouted');
    await expect(page.getByTestId('pcb-ratsnest').locator('line')).toHaveCount(3);
    // A bad pin is refused by code.
    await inspector.getByLabel('Net list (JSON)').fill('{"nets":[{"name":"X","pins":["J9.1"]}]}');
    await inspector.getByRole('button', { name: 'Import nets' }).click();
    await expect(page.getByRole('status')).toContainText('net-pin-missing');
    await expect(status(page)).toContainText('2 nets');

    // Pick GND: its lines are lit; edit its pins as text.
    await page.getByRole('list', { name: 'Nets' }).getByRole('button', { name: /^GND/ }).click();
    await expect(page.locator('.pcb-ratsnest line[stroke="#ffffff"]')).toHaveCount(2);
    await inspector.getByLabel('Pins (REF.PAD, comma separated)').fill('J1.6, R2.2');
    await inspector.getByLabel('Pins (REF.PAD, comma separated)').press('Enter');
    await expect(page.getByTestId('pcb-net-pins')).toHaveText('2');
    await expect(status(page)).toContainText('2 unrouted');

    // The part's pin table moves R1.2 back into GND, out of nothing.
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^R1/ }).click();
    await inspector.getByLabel('Net of pad 2').selectOption({ label: 'GND' });
    await expect(status(page)).toContainText('3 unrouted');
    // A pad in 3V3 moved to GND leaves 3V3.
    await inspector.getByLabel('Net of pad 1').selectOption({ label: 'GND' });
    let doc = await content(page);
    expect(doc.nets.find((n) => n.name === '3V3')!.pins).toEqual([['part-1', '1']]);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect
      .poll(async () => (await content(page)).nets.find((n) => n.name === '3V3')!.pins.length)
      .toBe(2);

    // Deleting R2 takes it out of GND; a new net class is edited in the board inspector.
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^R2/ }).click();
    await inspector.getByRole('button', { name: 'Delete part' }).click();
    doc = await content(page);
    expect(doc.nets.find((n) => n.name === 'GND')!.pins).toEqual([
      ['part-1', '6'],
      ['part-2', '2'],
    ]);
    await inspector.getByRole('button', { name: 'Add net class' }).click();
    const power = inspector.getByRole('group', { name: 'Net class Class 1' });
    await power.getByLabel('Track width (mm)').fill('0.5');
    await power.getByLabel('Track width (mm)').press('Enter');
    await expect
      .poll(async () => (await content(page)).netClasses.map((k) => k.trackWidthMm))
      .toEqual([0.15, 0.5]);
  });

  test('routes tracks through vias between pads of a net (PB4, TS-1929)', async ({ page }) => {
    await page.goto('/?fixture=f75');
    const inspector = page.locator('.pcb-inspector');
    await page.getByRole('button', { name: 'Place part' }).click();
    await inspector.getByLabel('Part').selectOption('chip');
    await clickBoard(page, [20, 20]);
    await clickBoard(page, [40, 20]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^R1/ }).click();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await inspector
      .getByLabel('Net list (JSON)')
      .fill('{"nets":[{"name":"SIG","pins":["R1.2","R2.1"]},{"name":"GND","pins":["R1.1"]}]}');
    await inspector.getByRole('button', { name: 'Import nets' }).click();
    await expect(status(page)).toContainText('2 nets · 0 tracks · 0 vias · 0 zones · 1 unrouted');

    // Pad centres on the board (both parts unturned, on top).
    let doc = await content(page);
    const padAt = (ref: string, pad: string): [number, number] => {
      const c = doc.components.find((x) => x.ref === ref)!;
      const fp = doc.footprints.find((f) => f.id === c.footprint)!;
      const at = fp.pads.find((x) => x.number === pad)!.at;
      return [c.at[0] + at[0], c.at[1] + at[1]];
    };
    const r1p2 = padAt('R1', '2');
    const r1p1 = padAt('R1', '1');
    const r2p1 = padAt('R2', '1');

    await page.getByRole('button', { name: 'Route track' }).click();
    // Bare board is not copper of a net.
    await clickBoard(page, [30, 30]);
    await expect(page.getByRole('status')).toContainText('route-no-net');
    // R1.2 → a corner held to 45° → via to B.Cu → down → via back to F.Cu → R2.1.
    await clickBoard(page, r1p2);
    await clickBoard(page, [30, 20.4]);
    await page.keyboard.press('v');
    await expect(page.getByLabel('Active layer')).toHaveValue('B.Cu');
    await clickBoard(page, [30, 25]);
    // Another net's pad is refused (and R1.1 is not on B.Cu anyway, so switch back first).
    await page.keyboard.press('v');
    await clickBoard(page, r1p1);
    await expect(page.getByRole('status')).toContainText('route-other-net');
    await expect(page.getByTestId('pcb-route-preview')).toHaveCount(1);
    await clickBoard(page, r2p1);
    await expect(page.getByTestId('pcb-route-preview')).toHaveCount(0);
    await expect(status(page)).toContainText('3 tracks · 2 vias · 0 zones · 0 unrouted');
    doc = await content(page);
    expect(doc.tracks.map((t) => [t.layer, t.from, t.to])).toEqual([
      ['F.Cu', r1p2, [30, 20]],
      ['B.Cu', [30, 20], [30, 25]],
      ['F.Cu', [30, 25], r2p1],
    ]);
    expect(doc.tracks.every((t) => t.net === doc.nets[0].id && t.widthMm === 0.15)).toBe(true);
    expect(doc.vias.map((v) => v.at)).toEqual([
      [30, 20],
      [30, 25],
    ]);

    // The whole run is one edit.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(status(page)).toContainText('0 tracks · 0 vias · 0 zones · 1 unrouted');
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(status(page)).toContainText('3 tracks · 2 vias · 0 zones · 0 unrouted');

    // Escape drops a run that is not finished. Changing the layer during a run drops a via.
    await clickBoard(page, r1p2);
    await expect(page.getByTestId('pcb-route-preview')).toHaveCount(1);
    await page.getByLabel('Active layer').selectOption('B.Cu');
    await expect(page.getByTestId('pcb-route-preview').locator('circle')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pcb-route-preview')).toHaveCount(0);

    // Pick the B.Cu track and delete it: the net is open again.
    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByLabel('Active layer').selectOption('B.Cu');
    await clickBoard(page, [30, 22.5]);
    await expect(inspector.locator('summary', { hasText: /^Track$/ })).toBeVisible();
    await inspector.getByRole('button', { name: 'Delete track' }).click();
    await expect(status(page)).toContainText('2 tracks · 2 vias · 0 zones · 1 unrouted');
    // A via's hole cannot be bigger than the via.
    await clickBoard(page, [30, 25]);
    await expect(inspector.locator('summary', { hasText: /^Via$/ })).toBeVisible();
    await inspector.getByLabel('Hole (mm)').fill('0.8');
    await inspector.getByLabel('Hole (mm)').press('Enter');
    await expect(page.getByRole('status')).toContainText('via-drill');
  });

  test('pours a zone clear of holes and the edge, refilled on change (PB4b, TS-1932)', async ({
    page,
  }) => {
    await page.goto('/?fixture=f75');
    const inspector = page.locator('.pcb-inspector');
    await page.getByRole('button', { name: 'Place part' }).click();
    await inspector.getByLabel('Part').selectOption('pin-header');
    await clickBoard(page, [10, 30]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^J1/ }).click();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await inspector
      .getByLabel('Net list (JSON)')
      .fill(
        '{"nets":[{"name":"GND","pins":["J1.6","J1.9","J1.14"]},{"name":"5V","pins":["J1.2","J1.4"]}]}',
      );
    await inspector.getByRole('button', { name: 'Import nets' }).click();
    await expect(status(page)).toContainText('0 zones · 3 unrouted');

    // Draw a GND zone on B.Cu around the whole board.
    await page.getByLabel('Active layer').selectOption('B.Cu');
    await page.getByRole('button', { name: 'Draw zone' }).click();
    await expect(inspector.getByLabel('Zone net')).toHaveValue(/./);
    await expect(inspector.getByLabel('Zone net').locator('option:checked')).toHaveText('GND');
    for (const p of [
      [-2, -2],
      [87, -2],
      [87, 58],
      [-2, 58],
    ] as [number, number][])
      await clickBoard(page, p);
    await page.keyboard.press('Enter');
    await expect(status(page)).toContainText('1 zones · 1 unrouted');
    const fill = page.getByTestId('pcb-zone-fill-zone-1');
    await expect(fill).toHaveAttribute('d', /^M/);
    const area = async () => Number(await fill.getAttribute('data-area'));
    // The board inset by the edge clearance, less four Ø6.2 keep-outs and the 5V pads' gaps.
    const first = await area();
    expect(first).toBeGreaterThan(4400);
    expect(first).toBeLessThan(84.4 * 55.4 - 4 * Math.PI * 3.1 ** 2);
    await expect(inspector.getByTestId('pcb-zone-area')).toHaveText(/mm²/);

    // A wider edge clearance refills the zone smaller; Undo brings the old fill back.
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await inspector.getByLabel('Edge clearance (mm)').fill('1');
    await inspector.getByLabel('Edge clearance (mm)').press('Enter');
    await expect.poll(area).toBeLessThan(first - 150);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(area).toBe(first);

    // Pick the zone by clicking inside it; solid pads fill more.
    await clickBoard(page, [70, 10]);
    await expect(inspector.locator('summary', { hasText: /^Zone$/ })).toBeVisible();
    await inspector.getByLabel('Pad connection').selectOption('solid');
    await expect.poll(area).toBeGreaterThan(first);
    await inspector.getByRole('button', { name: 'Delete zone' }).click();
    await expect(status(page)).toContainText('0 zones · 3 unrouted');
    await expect(fill).toHaveCount(0);
  });

  test('checks design rules live and jumps to a finding (PB5, TS-1934)', async ({ page }) => {
    await page.goto('/?fixture=f75');
    const inspector = page.locator('.pcb-inspector');
    await page.getByRole('button', { name: 'Place part' }).click();
    await inspector.getByLabel('Part').selectOption('chip');
    await clickBoard(page, [40, 30]);
    await clickBoard(page, [50, 30]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^R1/ }).click();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await inspector
      .getByLabel('Net list (JSON)')
      .fill(
        '{"nets":[{"name":"GND","pins":["R1.1","R2.2"]},{"name":"SIG","pins":["R1.2","R2.1"]}]}',
      );
    await inspector.getByRole('button', { name: 'Import nets' }).click();
    const summary = page.getByTestId('pcb-drc-summary');
    await expect(summary).toHaveText('2 errors · 0 warnings');
    await expect(page.getByRole('list', { name: 'DRC' })).toContainText('Not connected: R1, R2');

    // Route SIG, pour GND: no findings, the pour included.
    await page.getByRole('button', { name: 'Route track' }).click();
    await clickBoard(page, [40.8, 30]);
    await clickBoard(page, [49.2, 30]);
    await page.getByRole('button', { name: 'Draw zone' }).click();
    for (const p of [
      [-2, -2],
      [87, -2],
      [87, 58],
      [-2, 58],
    ] as [number, number][])
      await clickBoard(page, p);
    await page.keyboard.press('Enter');
    await expect(summary).toHaveText('0 errors · 0 warnings');
    await expect(page.getByTestId('pcb-drc-marker')).toHaveCount(0);
    await expect(status(page)).toContainText('0 DRC errors');

    // A stricter rule makes the track a finding; picking it selects the track and centres it.
    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await inspector.getByLabel('Min track width (mm)').fill('0.2');
    await inspector.getByLabel('Min track width (mm)').press('Enter');
    await expect(summary).toHaveText('1 errors · 0 warnings');
    await expect(page.getByTestId('pcb-drc-marker')).toHaveCount(1);
    await page
      .getByRole('list', { name: 'DRC' })
      .getByRole('button', { name: /^Track too narrow/ })
      .click();
    await expect(inspector.locator('summary', { hasText: /^Track$/ })).toBeVisible();
    await expect
      .poll(async () => Number(await page.getByTestId('pcb-canvas').getAttribute('data-px-per-mm')))
      .toBeGreaterThanOrEqual(40);
    // Widen it: the pour refills around it and the board is clean again.
    await inspector.getByLabel('Width (mm)', { exact: true }).fill('0.2');
    await inspector.getByLabel('Width (mm)', { exact: true }).press('Enter');
    await expect(summary).toHaveText('0 errors · 0 warnings');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(summary).toHaveText('1 errors · 0 warnings');
  });

  test('exports Gerber, drill and CSV files as one zip (PB6, TS-1938)', async ({ page }) => {
    await page.goto('/?fixture=f75');
    const inspector = page.locator('.pcb-inspector');
    await page.getByRole('button', { name: 'Place part' }).click();
    await inspector.getByLabel('Part').selectOption('chip');
    await clickBoard(page, [40, 30]);
    await clickBoard(page, [50, 30]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByRole('list', { name: 'Parts' }).getByRole('button', { name: /^R1/ }).click();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await inspector
      .getByLabel('Net list (JSON)')
      .fill('{"nets":[{"name":"SIG","pins":["R1.2","R2.1"]}]}');
    await inspector.getByRole('button', { name: 'Import nets' }).click();
    await page.getByRole('button', { name: 'Route track' }).click();
    await clickBoard(page, [40.8, 30]);
    await clickBoard(page, [49.2, 30]);
    await expect(page.getByTestId('pcb-drc-summary')).toHaveText('0 errors · 0 warnings');

    const tree = page.locator('.pcb-tree');
    await tree.getByLabel('File name').fill('my hat');
    await tree.getByLabel('File name').press('Enter');
    await expect(tree.getByLabel('File name')).toHaveValue('my_hat');
    const download = page.waitForEvent('download');
    await tree.getByRole('button', { name: 'Export Gerber, drill and CSV (zip)' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('my_hat-fabrication.zip');
    const bytes = readFileSync((await file.path())!);
    const zip = unzipSync(new Uint8Array(bytes));
    expect(Object.keys(zip)).toContain('my_hat-F_Cu.gbr');
    expect(Object.keys(zip)).toContain('my_hat-PTH.drl');
    const top = strFromU8(zip['my_hat-F_Cu.gbr']);
    expect(top).toContain('%TF.FileFunction,Copper,L1,Top*%');
    expect(top).toContain('%TO.N,SIG*%');
    expect(top).toContain('X40800000Y30000000D02*');
    expect(strFromU8(zip['my_hat-pos.csv'])).toContain('R1,,');
    await expect(page.getByRole('list', { name: 'Fabrication files' })).toContainText(
      'my_hat-Edge_Cuts.gbr · Profile,NP',
    );
  });

  test('changes the stack-up', async ({ page }) => {
    await page.goto('/?fixture=starter');
    const inspector = page.locator('.pcb-inspector');
    await inspector.getByLabel('Copper layers').selectOption('6');
    await expect(page.getByRole('list', { name: 'Layers' })).toContainText('In4.Cu');
    await inspector.getByLabel('Thickness (mm)').fill('1.2');
    await inspector.getByLabel('Thickness (mm)').press('Enter');
    await expect.poll(async () => (await content(page)).board.thicknessMm).toBe(1.2);
    await inspector.getByLabel('Thickness (mm)').fill('9');
    await inspector.getByLabel('Thickness (mm)').press('Enter');
    await expect.poll(async () => (await content(page)).board.thicknessMm).toBe(1.2);
  });
});

test('read-only boards offer no drawing tools', async ({ page, viewport }) => {
  await page.goto('/?fixture=f75&readonly=1');
  await expect(status(page)).toContainText('85 × 56 mm');
  // The narrow layout moves the tools into the toolbar's overflow menu.
  if ((viewport?.width ?? 0) >= 800)
    await expect(page.getByRole('button', { name: 'Add mounting hole' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apply rectangle' })).toHaveCount(0);
});

// PB7b (ST-468, TS-1946): a host without the geometry kernel says so in the 3D view.
test('the 3D view names the missing kernel and returns to the board', async ({
  page,
  viewport,
}) => {
  test.skip((viewport?.width ?? 0) < 800, 'toolbar overflow on narrow screens');
  await page.goto('/?fixture=f75');
  await page.getByRole('button', { name: '3D view' }).click();
  await expect(page.getByTestId('pcb-3d-status')).toHaveText(
    '3D needs the geometry kernel, which this host does not provide.',
  );
  await expect(page.getByRole('button', { name: 'Export GLB' })).toBeDisabled();
  await page.getByRole('button', { name: '3D view' }).click();
  await expect(page.getByTestId('pcb-canvas')).toBeVisible();
});

// PB7b (TS-1946): without WebGL the 3D view says so instead of taking the editor down.
test('the 3D view names missing WebGL and returns to the board', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 800, 'toolbar overflow on narrow screens');
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      if (kind.startsWith('webgl')) return null;
      return (get as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof get;
  });
  await page.goto('/?fixture=f75');
  await page.getByRole('button', { name: '3D view' }).click();
  await expect(page.getByTestId('pcb-3d-status')).toHaveText(
    '3D needs WebGL, which this browser does not provide.',
  );
  await expect(page.getByRole('button', { name: 'Export GLB' })).toBeDisabled();
  await page.getByRole('button', { name: '3D view' }).click();
  await expect(page.getByTestId('pcb-canvas')).toBeVisible();
});
