import type { PcbDocument } from '@editor-platform/pcb-core';
import {
  schematicLedExample,
  schematicPartSuggestion,
  type SchematicDocument,
} from '@editor-platform/schematic-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// SL1 (ST-560, TS-2102): the schematic Surface in the ordinary Playground.

const inspector = (page: Page) => page.locator('.sch-inspector');
const status = (page: Page) => page.getByTestId('sch-status');
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

test('create, place, Undo, save a version, reload and round-trip native JSON', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'schematic');
  await expect(status(page)).toContainText('A4 landscape · 0 parts');
  await inspector(page).getByLabel('Sheet size').selectOption('A3');
  await expect(status(page)).toContainText('A3 landscape');
  await page.getByRole('button', { name: 'Place part' }).click();
  await clickSheet(page, [101.6, 101.6]);
  await expect(status(page)).toContainText('1 parts');
  // Host history drives the session.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(status(page)).toContainText('0 parts');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(status(page)).toContainText('1 parts');
  await save(page, 1);

  await page.reload();
  await expect(status(page)).toContainText('A3 landscape · 1 parts');
  const record = await nativeArtifact(page);
  expect(record.kind).toBe('schematic');
  expect(record.versions).toHaveLength(1);
  const saved = record.versions[0]!.content as SchematicDocument;
  // A part of a generated symbol starts with its suggestion (SL2): 1 kΩ on an 0603 chip.
  expect(saved.parts).toEqual([
    {
      id: expect.stringMatching(/^part-[0-9a-f]{12}$/),
      ref: 'R1',
      value: '1k',
      symbol: 'sym-resistor',
      at: [101.6, 101.6],
      rotationDeg: 0,
      mirror: false,
      footprint: { generator: 'chip', params: { size: '0603' } },
      pinMap: { '1': '1', '2': '2' },
      model: { kind: 'resistor', terminals: { a: '1', b: '2' }, params: { ohms: 1000 } },
    },
  ]);

  // The LED example, imported as native JSON, keeps its nets and round-trips unchanged.
  await importJson(page, 'led.json', {
    ...record,
    name: 'LED and button',
    draft: { ...record.draft, content: schematicLedExample() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('LED and button');
  await expect(status(page)).toContainText('3 parts · 5 wires · 4 nets');
  await expect(page.getByTestId('sch-nets')).toContainText('GND · D1.1, SW1.2');
  const round = await nativeArtifact(page);
  expect(round.draft.content).toEqual(schematicLedExample());

  // Invalid content is refused on import.
  const before = await page.getByLabel('Artifact name').inputValue();
  const bad = schematicLedExample();
  bad.parts[0].at = [76, 50.8];
  await importJson(page, 'bad.json', {
    ...record,
    name: 'Bad schematic',
    draft: { ...record.draft, content: bad },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(before);
});

test('canvas shortcuts stay out of a Host dialog', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'schematic');
  await page.getByRole('button', { name: 'Place part' }).click();
  await clickSheet(page, [101.6, 101.6]);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await clickSheet(page, [101.6, 101.6]);
  await expect(status(page)).toContainText('1 parts');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save immutable version', exact: true });
  await dialog.getByRole('button', { name: 'この版を保存', exact: true }).focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('r');
  await expect(status(page)).toContainText('1 parts');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(
    ((await nativeArtifact(page)).draft.content as SchematicDocument).parts[0].rotationDeg,
  ).toBe(0);
});

test('Host Undo waits while a schematic draft is refused', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'schematic');
  await page.getByRole('button', { name: 'Place part' }).click();
  await clickSheet(page, [101.6, 101.6]);
  await clickSheet(page, [152.4, 101.6]);
  await expect(status(page)).toContainText('2 parts');
  const ref = inspector(page).getByLabel('Reference');
  await expect(ref).toHaveValue('R2');
  await ref.fill('R1');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.getByText('Schematic の入力を確定またはキャンセルしてから履歴を操作してください。'),
  ).toBeVisible();
  await expect(status(page)).toContainText('2 parts');
  await expect(ref).toHaveValue('R1');
});

// SL3b (ST-564, TS-2106): a board takes the parts and nets of a saved schematic version as one
// edit, which Host Undo takes back; a later schematic version shows only what changed.
test('sends a saved schematic version to a board as one edit', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'schematic');
  const record = await nativeArtifact(page);
  const led = schematicLedExample();
  const symbols = new Map(led.symbols.map((s) => [s.id, s]));
  led.parts = led.parts.map((p) => {
    const { footprint, pinMap } = schematicPartSuggestion(symbols.get(p.symbol)!);
    return { ...p, footprint, pinMap };
  });
  await importJson(page, 'led.json', {
    ...record,
    name: 'LED and button',
    draft: { ...record.draft, content: led },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('LED and button');
  await save(page, 1);

  await create(page, 'pcb');
  const board = page.locator('.pcb-inspector');
  await expect(board.getByLabel('Schematic version')).toContainText('LED and button v1');
  const changes = page.getByTestId('pcb-schematic-changes').locator('li');
  await expect(changes).toHaveCount(7);
  await expect(changes.first()).toContainText('Add part D1 · LED green · Chip 0603');
  // Leave the GPIO27 net out: 6 of 7.
  await board.getByLabel('Add net GPIO27 · +SW1.1').uncheck();
  await board.getByRole('button', { name: 'Apply 6 changes' }).click();
  await expect(changes).toHaveCount(1);
  let doc = (await nativeArtifact(page)).draft.content as PcbDocument;
  expect(doc.components.map((c) => c.ref)).toEqual(['D1', 'R1', 'SW1']);
  expect(doc.nets.map((n) => n.name)).toEqual(['GND', 'GPIO17', 'Net-(D1-2)']);
  await board.getByRole('button', { name: 'Apply 1 change' }).click();
  await expect(page.getByTestId('pcb-schematic-clean')).toBeVisible();
  // One Undo per apply.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(changes).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(changes).toHaveCount(7);
  doc = (await nativeArtifact(page)).draft.content as PcbDocument;
  expect(doc.components).toEqual([]);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByTestId('pcb-schematic-clean')).toBeVisible();
});
