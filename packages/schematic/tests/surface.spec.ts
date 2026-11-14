import { expect, test, type Page } from '@playwright/test';

// The schematic Surface's test host (SL1, ST-560, TS-2101).

type Doc = {
  parts: { id: string; ref: string; symbol: string; at: [number, number]; rotationDeg: number }[];
  wires: { id: string; points: [number, number][] }[];
  labels: { id: string; name: string; at: [number, number] }[];
  powers: { id: string; name: string }[];
  symbols: { id: string }[];
};

/** The screen point of a sheet point (mm, y down), read from the SVG's viewBox. */
async function screenOf(page: Page, p: [number, number]) {
  const svg = page.getByTestId('sch-canvas');
  const box = (await svg.boundingBox())!;
  const [vx, vy, vw, vh] = (await svg.getAttribute('viewBox'))!.split(' ').map(Number);
  return {
    x: box.x + ((p[0] - vx) / vw) * box.width,
    y: box.y + ((p[1] - vy) / vh) * box.height,
  };
}
async function clickSheet(page: Page, p: [number, number]) {
  const s = await screenOf(page, p);
  await page.mouse.click(s.x, s.y);
}
/** Waits until the view stops changing (the panels settle and the canvas is measured). */
async function steady(page: Page) {
  const svg = page.getByTestId('sch-canvas');
  const read = async () =>
    `${await svg.getAttribute('viewBox')} ${JSON.stringify(await svg.boundingBox())}`;
  let last = await read();
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(50);
    const now = await read();
    if (now === last) return;
    last = now;
  }
}
async function zoomTo(page: Page, p: [number, number], steps = 2) {
  await steady(page);
  const s = await screenOf(page, p);
  await page.mouse.move(s.x, s.y);
  for (let i = 0; i < steps; i++) await page.mouse.wheel(0, -300);
}
const content = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { schematicSession: { content: unknown } }).schematicSession.content,
  ) as Promise<Doc>;
const netText = async (page: Page, name: string) =>
  (await page.getByTestId('sch-nets').locator(`li[data-net="${name}"]`).textContent())?.trim();

test.describe('schematic Surface (SL1)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 800, 'editing needs the desktop layout');
  test('TS-2101: shows the drawn circuit and its nets', async ({ page }) => {
    await page.goto('/?fixture=led');
    await expect(page.getByTestId('sch-status')).toContainText('3 parts · 5 wires · 4 nets');
    expect(await netText(page, 'GND')).toBe('GND · D1.1, SW1.2');
    expect(await netText(page, 'GPIO17')).toBe('GPIO17 · R1.1');
    expect(await netText(page, 'Net-(D1-2)')).toBe('Net-(D1-2) · D1.2, R1.2');
  });

  test('TS-2101: places a part, wires it to a label and names the net', async ({ page }) => {
    await page.goto('/?fixture=led');
    await zoomTo(page, [88.9, 63.5]);
    // A resistor at (88.9, 101.6), turned once with R while placing (pins at y 96.52 / 106.68).
    await page.getByLabel('Symbol to place').selectOption({ label: 'Resistor' });
    await page.getByRole('button', { name: 'Place part' }).click();
    await page.keyboard.press('r');
    await clickSheet(page, [88.9, 101.6]);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    let doc = await content(page);
    const r2 = doc.parts.find((p) => p.ref === 'R2')!;
    expect(r2).toMatchObject({ at: [88.9, 101.6], rotationDeg: 90 });
    // A wire from R2's top pin to a free point; a label there names the net.
    await page.getByRole('button', { name: 'Draw wire' }).click();
    await clickSheet(page, [88.9, 96.52]);
    await clickSheet(page, [96.52, 91.44]);
    await page.keyboard.press('Enter');
    doc = await content(page);
    const w = doc.wires.at(-1)!;
    expect(w.points).toEqual([
      [88.9, 96.52],
      [96.52, 96.52],
      [96.52, 91.44],
    ]);
    await page.getByLabel('Label name').fill('SENSE');
    await page.getByLabel('Label name').press('Enter');
    await page.getByRole('button', { name: 'Add net label' }).click();
    await clickSheet(page, [96.52, 91.44]);
    await page.keyboard.press('Escape');
    expect(await netText(page, 'SENSE')).toBe('SENSE · R2.1');
    // A ground port on R2's lower pin.
    await page.getByRole('button', { name: 'Add power port' }).click();
    await clickSheet(page, [88.9, 106.68]);
    await page.keyboard.press('Escape');
    expect(await netText(page, 'GND')).toBe('GND · D1.1, R2.2, SW1.2');
    // Undo the ground port.
    await page.getByRole('button', { name: 'Undo' }).click();
    expect(await netText(page, 'GND')).toBe('GND · D1.1, SW1.2');
  });

  test('TS-2101: dragging a part brings its wires and keeps the nets', async ({ page }) => {
    await page.goto('/?fixture=led');
    await zoomTo(page, [101.6, 50.8]);
    await steady(page);
    const from = await screenOf(page, [101.6, 50.8]);
    const to = await screenOf(page, [101.6, 55.88]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    const doc = await content(page);
    expect(doc.parts.find((p) => p.id === 'd1')!.at).toEqual([101.6, 55.88]);
    expect(doc.wires.find((w) => w.id === 'w2')!.points).toEqual([
      [81.28, 50.8],
      [96.52, 50.8],
      [96.52, 55.88],
    ]);
    expect(await netText(page, 'Net-(D1-2)')).toBe('Net-(D1-2) · D1.2, R1.2');
    expect(await netText(page, 'GND')).toBe('GND · D1.1, SW1.2');
  });

  test('TS-2101: Escape during a drag cancels it and changes nothing', async ({ page }) => {
    await page.goto('/?fixture=led');
    await zoomTo(page, [101.6, 50.8]);
    const before = await content(page);
    const from = await screenOf(page, [101.6, 50.8]);
    const to = await screenOf(page, [101.6, 55.88]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await content(page)).toEqual(before);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { schematicSession: { canUndo: boolean } }).schematicSession
            .canUndo,
      ),
    ).toBe(false);
  });

  test('TS-2101: an Inspector draft is committed to its own part before the canvas selects another', async ({
    page,
  }) => {
    await page.goto('/?fixture=led');
    await zoomTo(page, [88.9, 50.8]);
    await clickSheet(page, [76.2, 50.8]);
    const ref = page.locator('.sch-inspector').getByLabel('Reference');
    await expect(ref).toHaveValue('R1');
    await ref.fill('R9');
    await clickSheet(page, [101.6, 50.8]);
    await expect(ref).toHaveValue('D1');
    const doc = await content(page);
    expect(doc.parts.find((p) => p.id === 'r1')!.ref).toBe('R9');
    expect(doc.parts.find((p) => p.id === 'd1')!.ref).toBe('D1');
  });

  test('TS-2101: a double-click ends a wire, and a typed label name is used without Enter', async ({
    page,
  }) => {
    await page.goto('/?fixture=led');
    await zoomTo(page, [88.9, 63.5]);
    const wires = (await content(page)).wires.length;
    await page.getByRole('button', { name: 'Draw wire' }).click();
    await clickSheet(page, [127, 101.6]);
    const end = await screenOf(page, [139.7, 101.6]);
    await page.mouse.dblclick(end.x, end.y);
    let doc = await content(page);
    expect(doc.wires).toHaveLength(wires + 1);
    expect(doc.wires.at(-1)!.points).toEqual([
      [127, 101.6],
      [139.7, 101.6],
    ]);
    await page.getByRole('button', { name: 'Add net label' }).click();
    await page.getByLabel('Label name').fill('LATE');
    await clickSheet(page, [139.7, 101.6]);
    doc = await content(page);
    expect(doc.labels.at(-1)!.name).toBe('LATE');
  });

  test('TS-2101: a refused Inspector draft stops the Inspector delete', async ({ page }) => {
    await page.goto('/?fixture=led');
    await zoomTo(page, [88.9, 50.8]);
    await clickSheet(page, [76.2, 50.8]);
    const ref = page.locator('.sch-inspector').getByLabel('Reference');
    await ref.fill('D1');
    await page.locator('.sch-inspector').getByRole('button', { name: 'Delete part' }).click();
    const doc = await content(page);
    expect(doc.parts.map((p) => p.ref).sort()).toEqual(['D1', 'R1', 'SW1']);
    await expect(ref).toHaveValue('D1');
  });

  test('TS-2101: a refused Inspector draft stops Undo', async ({ page }) => {
    await page.goto('/?fixture=led');
    await zoomTo(page, [88.9, 50.8]);
    await page.getByRole('button', { name: 'Place part' }).click();
    await clickSheet(page, [88.9, 101.6]);
    const ref = page.locator('.sch-inspector').getByLabel('Reference');
    await ref.fill('D1');
    await page.getByRole('button', { name: 'Undo' }).click();
    expect((await content(page)).parts).toHaveLength(4);
    await expect(ref).toHaveValue('D1');
  });

  test('TS-2101: refuses a net name with a space and keeps the label', async ({ page }) => {
    await page.goto('/?fixture=led');
    await page
      .getByTestId('sch-nets')
      .getByRole('button', { name: /GPIO17 · R1\.1/ })
      .click();
    // Selecting the net selects its items; pick the label alone from the Inspector path.
    await page.evaluate(() =>
      (
        window as unknown as { schematicController: { select(ids: string[]): void } }
      ).schematicController.select(['l1']),
    );
    const name = page.getByLabel('Net name');
    await name.fill('GPIO 17');
    await name.press('Enter');
    await expect(page.getByRole('status')).toContainText('(net-name)');
    expect((await content(page)).labels[0].name).toBe('GPIO17');
  });

  test('TS-2101: power ports and labels draw turned by their rotation', async ({ page }) => {
    await page.goto('/?fixture=led');
    await page.evaluate(() => {
      const c = (
        window as unknown as {
          schematicController: {
            state: { content: { powers: object[]; labels: object[] } };
            updatePower(p: object): void;
            updateLabel(l: object): void;
          };
        }
      ).schematicController;
      c.updatePower({ ...c.state.content.powers[0], rotationDeg: 90 });
      c.updateLabel({ ...c.state.content.labels[0], rotationDeg: 180 });
    });
    await expect(page.getByTestId('sch-power-p1')).toHaveAttribute(
      'transform',
      'rotate(90 114.3 88.9)',
    );
    await expect(page.getByTestId('sch-label-l1')).toHaveAttribute('transform', /^rotate\(180 /);
  });

  test('TS-2104: ERC, not-connected pins, model values and footprints in the Inspector', async ({
    page,
  }) => {
    await page.goto('/?fixture=led');
    const erc = page.getByTestId('sch-erc');
    await expect(erc.locator('li')).toHaveCount(2);
    await expect(erc).toContainText('erc-unconnected · GPIO17 · R1.1');
    await page.getByRole('button', { name: /^R1 · / }).click();
    const inspector = page.locator('.sch-inspector');
    // Pin 1 is meant to lead off the sheet: mark it and the finding goes.
    await inspector.getByLabel('Pin 1 not connected').check();
    await expect(erc.locator('li')).toHaveCount(1);
    await expect(page.getByTestId('sch-nc-r1-1')).toBeVisible();
    // A resistor model, set to 330 Ω.
    await inspector.getByLabel('Model', { exact: true }).selectOption('resistor');
    const ohms = inspector.getByLabel('Resistance (Ω)');
    await expect(ohms).toHaveValue('1k');
    await ohms.fill('330');
    await ohms.press('Enter');
    // A footprint: an 0805 chip, pins 1 and 2 on pads 1 and 2.
    await inspector.getByLabel('Footprint', { exact: true }).selectOption('chip');
    await inspector.getByLabel('Size').selectOption('0805');
    const r1 = (await content(page)).parts.find((p) => p.id === 'r1') as unknown as Record<
      string,
      unknown
    >;
    expect(r1).toMatchObject({
      noConnect: ['1'],
      model: { kind: 'resistor', terminals: { a: '1', b: '2' }, params: { ohms: 330 } },
      footprint: { generator: 'chip', params: { size: '0805' } },
      pinMap: { '1': '1', '2': '2' },
    });
    // Terminal a onto pin 2 swaps b onto pin 1 in one edit (never two terminals on one pin).
    await inspector.getByLabel('Terminal a').selectOption('2');
    const swapped = (await content(page)).parts.find((p) => p.id === 'r1') as unknown as Record<
      string,
      unknown
    >;
    expect(swapped).toMatchObject({ model: { terminals: { a: '2', b: '1' } } });
    // A value that is not a number is refused and the stored one kept.
    await ohms.fill('lots');
    await ohms.press('Enter');
    await expect(page.getByRole('status')).toContainText('(model-param)');
  });

  test('TS-2104: makes an IC symbol from pin lists and places it', async ({ page }) => {
    await page.goto('/?fixture=starter');
    await page.getByLabel('Generator').selectOption('ic');
    await page.getByLabel('Name', { exact: true }).fill('EEPROM');
    await page.getByLabel('Left pins').fill('VCC:power-in, SDA, SCL:input');
    await page.getByLabel('Right pins').fill('GND:power-in');
    await page.getByRole('button', { name: 'Add symbol' }).click();
    await expect(page.getByLabel('Symbol to place')).toHaveValue(/^sym-[0-9a-f]{12}$/);
    await expect(page.getByRole('button', { name: 'Place part' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await clickSheet(page, [101.6, 101.6]);
    const doc = await content(page);
    expect(doc.parts).toHaveLength(1);
    expect(doc.parts[0]).toMatchObject({ ref: 'U1', value: 'EEPROM', at: [101.6, 101.6] });
    // Every pin is alone: four unconnected pins.
    await expect(page.getByTestId('sch-erc').locator('li')).toHaveCount(4);
    // SOIC starts sized for the symbol (4 pins, not the generator's 8), every pin on a pad.
    await page.getByRole('button', { name: /^U1 · / }).click();
    await page
      .locator('.sch-inspector')
      .getByLabel('Footprint', { exact: true })
      .selectOption('soic');
    const u1 = (await content(page)).parts[0] as unknown as Record<string, unknown>;
    expect(u1).toMatchObject({
      footprint: { generator: 'soic', params: { pins: 4 } },
      pinMap: { '1': '1', '2': '2', '3': '3', '4': '4' },
    });
    // A bad pin type is refused with its parameter's name.
    await page.getByLabel('Right pins').fill('GND:sideways');
    await page.getByRole('button', { name: 'Add symbol' }).click();
    await expect(page.getByRole('status')).toContainText('symbol-param:right');
  });

  test('TS-2104: Undo of a new symbol places the first symbol left', async ({ page }) => {
    await page.goto('/?fixture=starter');
    await page.getByLabel('Generator').selectOption('ic');
    await page.getByRole('button', { name: 'Add symbol' }).click();
    await expect(page.getByLabel('Symbol to place')).toHaveValue(/^sym-[0-9a-f]{12}$/);
    await page.getByRole('button', { name: 'Undo' }).click();
    const first = (await content(page)).symbols[0].id;
    await expect(page.getByLabel('Symbol to place')).toHaveValue(first);
    await clickSheet(page, [101.6, 101.6]);
    const doc = await content(page);
    expect(doc.parts).toHaveLength(1);
    expect(doc.parts[0].symbol).toBe(first);
  });

  test('TS-2109: DC operating point on the sheet, a pressed switch, and parts left out', async ({
    page,
  }) => {
    await page.goto('/?fixture=led-sim');
    const sim = page.getByTestId('sch-sim');
    await sim.getByLabel('GPIO17', { exact: true }).selectOption('high');
    await sim.getByLabel('GPIO27', { exact: true }).selectOption('up');
    await sim.getByRole('button', { name: 'Run' }).click();
    const volts = page.getByTestId('sch-sim-voltages');
    await expect(volts.locator('tr[data-net="GPIO17"] td')).toHaveText(/^3\.\d+ V$/);
    // About 3.4 mA through the green LED: (3.3 V − Vf) / (330 Ω + 40 Ω).
    await expect(page.getByTestId('sch-sim-currents').locator('tr[data-part="D1"] td')).toHaveText(
      /^3\.\d+ mA$/,
    );
    await expect(page.getByTestId('sch-sim-inputs')).toHaveText('GPIO27 reads high');
    // The values on the sheet: a tag at the GPIO17 label and the LED lit.
    await expect(page.getByTestId('sch-sim-tag-GPIO17')).toContainText(/^3\.\d+ V$/);
    const glow = Number(await page.getByTestId('sch-sim-glow-d1').getAttribute('data-glow'));
    expect(glow).toBeGreaterThan(0.2);
    // Pressing the button pulls GPIO27 low; the old result is not shown meanwhile.
    await sim.getByLabel('SW1 pressed').check();
    await expect(page.getByTestId('sch-sim-voltages')).toHaveCount(0);
    await expect(sim).toContainText('The drawing or the settings changed since the last run');
    await sim.getByRole('button', { name: 'Run' }).click();
    await expect(page.getByTestId('sch-sim-inputs')).toHaveText('GPIO27 reads low');
    // Editing the drawing makes the result stale.
    await page.getByRole('button', { name: /^R1 · / }).click();
    const ohms = page.locator('.sch-inspector').getByLabel('Resistance (Ω)');
    await ohms.fill('1k');
    await ohms.press('Enter');
    await expect(page.getByTestId('sch-sim-voltages')).toHaveCount(0);
    await expect(sim).toContainText('The drawing or the settings changed since the last run');
    // A drawing without models: every part is listed as left out.
    await page.goto('/?fixture=led');
    await page.getByTestId('sch-sim').getByRole('button', { name: 'Run' }).click();
    await expect(page.getByTestId('sch-sim-left')).toHaveText(
      'Not simulated: D1 (no model), R1 (no model), SW1 (no model).',
    );
  });

  test('TS-2109: transient with a button press, probes, the time cursor and CSV', async ({
    page,
  }) => {
    await page.goto('/?fixture=led-sim');
    const sim = page.getByTestId('sch-sim');
    await sim.getByLabel('Analysis').selectOption('tran');
    const stop = sim.getByLabel('Stop (ms)');
    await expect(stop).toHaveValue('10');
    await sim.getByLabel('GPIO17', { exact: true }).selectOption('low');
    const toggle = sim.getByLabel('GPIO17 toggles at (ms)');
    await toggle.fill('4');
    await toggle.press('Enter');
    await sim.getByLabel('GPIO27', { exact: true }).selectOption('up');
    for (const [label, v] of [
      ['SW1 pressed at (ms)', '2'],
      ['SW1 released at (ms)', '6'],
    ]) {
      await sim.getByLabel(label).fill(v);
      await sim.getByLabel(label).press('Enter');
    }
    await sim.getByRole('button', { name: 'Run' }).click();
    // The cursor starts at the end: released, LED on.
    await expect(page.getByTestId('sch-sim-inputs')).toHaveText('GPIO27 reads high');
    await sim.getByLabel('Probe GPIO27').check();
    await sim.getByLabel('Probe GPIO17').check();
    await expect(page.getByTestId('sch-sim-wave').locator('polyline')).toHaveCount(2);
    // At 3 ms the button is down and GPIO17 still low: the LED is off.
    await sim.getByLabel('Time').fill('0.003');
    await expect(page.getByTestId('sch-sim-inputs')).toHaveText('GPIO27 reads low');
    expect(Number(await page.getByTestId('sch-sim-glow-d1').getAttribute('data-glow'))).toBe(0);
    await sim.getByLabel('Time').fill('0.005');
    expect(
      Number(await page.getByTestId('sch-sim-glow-d1').getAttribute('data-glow')),
    ).toBeGreaterThan(0.2);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      sim.getByRole('button', { name: 'Download CSV' }).click(),
    ]);
    const csv = await (await download.createReadStream()).toArray();
    const lines = Buffer.concat(csv).toString('utf8').trimEnd().split('\n');
    expect(lines[0]).toBe('time,V(GPIO27),V(GPIO17),I(D1),I(R1),I(SW1)');
    expect(lines.length).toBeGreaterThan(20);
    // A stop time of 0 is refused and the old one kept.
    await stop.fill('0');
    await stop.press('Enter');
    await expect(sim.getByRole('alert')).toContainText('Stop (ms)');
    // Run with that refused draft still in the box does not calculate with the old stop time.
    await sim.getByRole('button', { name: 'Run' }).dispatchEvent('click');
    await expect(sim.getByRole('status')).toHaveCount(0);
    await expect(page.getByTestId('sch-sim-voltages')).toBeVisible();
    await expect(stop).toHaveValue('0');
    // Nor does it switch to DC (which would drop the refused draft).
    await sim.getByLabel('Analysis').selectOption('dc');
    await expect(sim.getByLabel('Analysis')).toHaveValue('tran');
    await expect(stop).toHaveValue('0');
    await stop.fill('10');
    await stop.press('Enter');
    await expect(sim.getByRole('alert')).toHaveCount(0);
    // A valid draft is committed by Run itself (no blur first) and used: the result ends at 5 ms.
    await stop.fill('5');
    await sim.getByRole('button', { name: 'Run' }).dispatchEvent('click');
    await expect(sim.getByLabel('Time')).toHaveAttribute('max', '0.005');
  });

  test('TS-2101: read only shows the drawing without tools', async ({ page }) => {
    await page.goto('/?fixture=led&readonly=1');
    await expect(page.getByRole('button', { name: 'Draw wire' })).toBeDisabled();
    await expect(page.getByTestId('sch-status')).toContainText('4 nets');
    // Content fields are read-only text boxes: no drafts that could never be committed.
    await expect(page.locator('.sch-inspector').getByLabel('Title')).toHaveAttribute(
      'readonly',
      '',
    );
    await clickSheet(page, [76.2, 50.8]);
    const ref = page.locator('.sch-inspector').getByLabel('Reference');
    await expect(ref).toHaveValue('R1');
    await expect(ref).toHaveAttribute('readonly', '');
    await clickSheet(page, [101.6, 50.8]);
    await expect(ref).toHaveValue('D1');
  });
});
