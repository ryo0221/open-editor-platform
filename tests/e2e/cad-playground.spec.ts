import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import {
  applyCadOperation,
  cadBuilder,
  cadToleranceSets,
  f11Bracket,
  f12Fillet,
  f40Car,
  f41Bridge,
  f42Airliner,
  identityQuaternion,
  mm,
  position,
  f14Patterns,
  f15Loft,
  f15Sweep,
  f17Sheets,
  f18Hood,
  f19Network,
  f80Package,
  f80Sample,
  f81TwoView,
  f22Split,
  cr6dGroove,
  lampFixture,
  lampSizes,
  f59Seat,
  f60Wheel,
  f61Mirror,
  f62Steering,
  f63Car,
  f26Panel,
  f27Windows,
  f24Flare,
  f47Flange,
  f48ProfileSweep,
  f49SpotWelds,
  f29Biw,
  f25B1Car,
  fixtureKernel,
  partVersionId,
  r1Housing,
  r2bParts,
  r2bJoints,
  f70GearTrain,
  sk01Watch,
  sk01FinishImages,
  type Sk01Finish,
  gearMeshProblems,
  solveJoints,
  parameterValues,
  connectorRefKey,
  f02Plate,
  fixtureComponent,
  fixturePart,
  fixtureVersion,
  emptyCad,
  type CadDocument,
} from '@editor-platform/cad-core';
import type { Locator, Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground does not offer CAD.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

/** Where the R1 acceptance keeps its STEP files for the independent reader. */
const stepDir = process.env.CAD_R1_STEP_DIR ?? '/tmp/cad-r1-step';
const state = (page: Page) => page.getByTestId('cad-geometry-state');
const ready = (page: Page) =>
  expect(state(page)).toHaveText('Shape up to date', { timeout: 90_000 });
const bodies = (page: Page) => page.getByRole('list', { name: 'Bodies' }).getByRole('button');
async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  return button;
}
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

test('create, edit, Undo, save a version, reload and round-trip native JSON', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add plate')).click();
  await ready(page);
  await (await tool(page, 'Add cylinder')).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  // Host history drives the session; the Surface re-evaluates.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  await page
    .getByRole('list', { name: 'Parameters' })
    .getByRole('button', { name: /Width/ })
    .click();
  const value = page.locator('.cad-inspector').getByLabel('Value (mm)');
  await value.fill('100');
  await value.press('Enter');
  // Ctrl+S right after Enter saves a version even if the edit still evaluates: the version holds
  // the committed content, never the candidate, and the edit applies to the draft afterwards
  // (ST-28 #6). Which of the two widths it holds depends on how fast the kernel is.
  await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'History (1)' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await ready(page);

  await page.reload();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'Parameters' })).toContainText('100 mm');

  const record = await nativeArtifact(page);
  expect(record.kind).toBe('cad');
  expect(record.versions).toHaveLength(1);
  const width = (content: unknown) =>
    (content as { parameters: { name: string; value: number }[] }).parameters.find(
      (p) => p.name === 'Width',
    )?.value;
  expect([80, 100]).toContain(width(record.versions[0].content));
  expect(width(record.draft.content)).toBe(100);
  await importJson(page, 'cad-copy.json', { ...record, name: 'CAD copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('CAD copy');
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);

  const download = page.waitForEvent('download');
  await (await tool(page, 'Export PNG')).click();
  const png = await readFile((await (await download).path())!);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  await page.screenshot({ path: test.info().outputPath('cad-playground.png') });
});

test('Ctrl+S that commits a typed value waits for it instead of saving the old one (ST-28 #6)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add plate')).click();
  await ready(page);
  await page
    .getByRole('list', { name: 'Parameters' })
    .getByRole('button', { name: /Width/ })
    .click();
  const value = page.locator('.cad-inspector').getByLabel('Value (mm)');
  await value.fill('120');
  // No Enter: the save's own flush commits the field and starts its evaluation.
  await value.press('Control+s');
  await expect(page.getByRole('alert')).toContainText('形状を計算中です');
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await ready(page);
  const record = await nativeArtifact(page);
  expect(record.versions).toHaveLength(0);
  const width = (
    record.draft.content as { parameters: { name: string; value: number }[] }
  ).parameters.find((p) => p.name === 'Width')?.value;
  expect(width).toBe(120);
});

test('schema 2: new documents and saved versions are schema 2; expressions survive reload and native JSON (CAD28)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add plate')).click();
  await ready(page);
  await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'History (1)' })).toBeVisible();
  await page.keyboard.press('Escape');
  const saved = (await nativeArtifact(page)).versions[0];
  expect(saved.content.schemaVersion).toBe(2);
  await expect(page.getByRole('button', { name: /Migrate to schema/ })).toHaveCount(0);
  const params = page.getByRole('list', { name: 'Parameters' });
  await page.getByRole('button', { name: 'Add length', exact: true }).click();
  await ready(page);
  const value = page.locator('.cad-inspector').getByLabel(/^Value/);
  await value.fill('Width / 8');
  await value.press('Enter');
  await ready(page);
  await expect(params).toContainText('Length 110 mm');

  await page.reload();
  await ready(page);
  await params.getByRole('button', { name: /Length 1/ }).click();
  await expect(value).toHaveValue('Width / 8');
  const record = await nativeArtifact(page);
  // The saved version keeps its bytes and hash.
  expect(record.versions[0]).toEqual(saved);
  expect(record.draft.content.schemaVersion).toBe(2);
  await importJson(page, 'cad-schema2.json', { ...record, name: 'CAD schema 2' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('CAD schema 2');
  await ready(page);
  await params.getByRole('button', { name: /Length 1/ }).click();
  await expect(value).toHaveValue('Width / 8');

  // A native file whose expressions form a cycle is refused and opens nothing.
  const content = structuredClone(record.draft.content) as {
    parameters: { id: string; name: string; value?: number; expression?: unknown }[];
  };
  const width = content.parameters.find((p) => p.name === 'Width')!;
  const length = content.parameters.find((p) => p.name === 'Length 1')!;
  delete width.value;
  width.expression = { postfix: [{ parameterId: length.id }, { number: 8 }, { operator: 'mul' }] };
  await importJson(page, 'cycle.json', {
    ...record,
    name: 'Cyclic CAD',
    draft: { ...record.draft, content },
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Artifact name')).not.toHaveValue('Cyclic CAD');
});

test('unsupported CAD content and capabilities are refused', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const record = await nativeArtifact(page);
  // Schema 1 development data and an unknown schema are refused, never read as schema 2.
  for (const schemaVersion of [1, 3]) {
    await importJson(page, 'future.json', {
      ...record,
      name: 'Future CAD',
      draft: { ...record.draft, content: { ...record.draft.content, schemaVersion } },
    });
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('Artifact name')).not.toHaveValue('Future CAD');
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  }
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open collaboratively' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Comments \(/ })).toBeDisabled();
  await page.keyboard.press('Escape');
});

test('Read only follows the Host toggle in both directions', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  // The toggle lives in the artifact actions menu.
  const setReadOnly = async (checked: boolean) => {
    const more = page.getByRole('button', { name: 'More artifact actions', exact: true });
    await more.click();
    const toggle = page.getByLabel('Read only', { exact: true });
    await toggle.click();
    await expect(toggle).toBeChecked({ checked });
    await more.click();
  };
  // A saved version to restore, and a draft that differs from it.
  await (await tool(page, 'Add box')).click();
  await ready(page);
  await save(page, 1);
  await (await tool(page, 'Add cylinder')).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  const draft = async () => JSON.stringify((await nativeArtifact(page)).draft.content);
  const before = await draft();

  // Every way in is refused while read only, and the content stays (ST-28#5).
  await setReadOnly(true);
  for (const name of ['Add box', 'Move bodies', 'Save view'])
    await expect(await tool(page, name)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Import STEP', exact: true })).toHaveCount(0);
  await bodies(page).first().click();
  await expect(page.locator('.cad-inspector').getByLabel('Name')).toHaveCount(1);
  await expect(page.locator('.cad-inspector').getByLabel('X (mm)')).toHaveCount(0);
  await expect(
    page.locator('.cad-inspector').getByRole('button', { name: 'Delete body' }),
  ).toHaveCount(0);
  // Shortcuts: history and paste. CAD offers no paste; a pasted CAD JSON changes nothing.
  await page.locator('.cad-canvas').click();
  await page.keyboard.press('Control+z');
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true }),
    );
  }, before);
  // Restoring a version is an edit too.
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await page.getByRole('tab', { name: 'History (1)' }).click();
  await page.getByRole('button', { name: 'Restore to draft', exact: true }).click();
  await expect(bodies(page)).toHaveCount(2);
  expect(await draft()).toBe(before);

  await setReadOnly(false);
  await expect(await tool(page, 'Add box')).toBeEnabled();
  await (await tool(page, 'Add box')).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(3);
});

test('narrow layout: add a body and use Host Undo', async ({ page }) => {
  test.skip(test.info().project.name === 'desktop', 'narrow layout');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add box')).click();
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('cad-playground-narrow.png') });
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(page.getByText('Add a body from the toolbar to start.')).toBeVisible();
});

const corpus = (name: string) =>
  new URL(`../../packages/cad-kernel-occt/fixtures/f07/${name}`, import.meta.url).pathname;
test('STEP import keeps the file with the record through versions, reload and native JSON (CAD11, CAD13)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  // A refused file: the reason, and nothing stored or inserted.
  await page
    .getByLabel('STEP file', { exact: true })
    .setInputFiles(corpus('reject-two-solids.step'));
  await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText('複数のsolid');
  expect((await nativeArtifact(page)).cadResources ?? []).toEqual([]);

  await page
    .getByLabel('STEP file', { exact: true })
    .setInputFiles(corpus('normal-inch-block.step'));
  const report = page.locator('dl[aria-label="Import report"]');
  await expect(report).toContainText('in → mm (× 25.4, applied once)');
  await expect(report).toContainText('AP214');
  await page.getByRole('button', { name: 'Insert body', exact: true }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await expect(page.locator('.cad-status')).not.toContainText('could not');
  // An assembly STEP goes into an empty document only (R2b-5): this one has a body.
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(corpus('reject-assembly.step'));
  await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText('空の文書にだけ');
  await expect(page.getByRole('dialog', { name: 'Import STEP assembly' })).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'History (1)' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The stored BRep evaluates again after a reload.
  await page.reload();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);

  const record = await nativeArtifact(page);
  const draft = record.draft.content as { assets: { kind: string; sha256: string }[] };
  expect(draft.assets.map((a) => a.kind)).toEqual(['source-step', 'normalized-brep']);
  const resources = record.cadResources as { kind: string; sha256: string; bytes: string }[];
  expect(resources.map((r) => [r.kind, r.sha256])).toEqual(
    draft.assets.map((a) => [a.kind, a.sha256]),
  );
  // The original bytes are kept unchanged.
  const original = await readFile(corpus('normal-inch-block.step'));
  expect(Buffer.from(resources[0].bytes, 'base64').equals(original)).toBe(true);

  // A native file without its assets is refused; with them it opens and evaluates.
  await importJson(page, 'no-assets.json', { ...record, name: 'No assets', cadResources: [] });
  await expect(page.getByRole('alert')).toContainText('CAD resource missing');
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await importJson(page, 'step-copy.json', { ...record, name: 'STEP copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('STEP copy');
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('cad-playground-step.png') });
});

const f43 = (name: string) =>
  new URL(`../../packages/cad-kernel-occt/fixtures/f43/${name}`, import.meta.url).pathname;
// PMI-1/PMI-2 (docs/cad/pmi.md, #837): the import keeps the semantic PMI it verified on one part
// as the part's `pmi` asset. A file of which it would keep less is refused with its breakdown;
// Cancel stores nothing, and only "Import with the PMI that is kept" imports it, listing PMI as
// lost. The same for an assembly in an empty document. On desktop and the narrow layout.
test('PMI-1 STEP with PMI: breakdown, cancel, consent, import (ST-192, CAD81, TS-1364; PMI-4b ST-213, TS-1433)', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const dialog = page.getByRole('dialog', { name: 'STEP with PMI' });
  const read = dialog.getByRole('table', { name: 'PMI read' });
  // A reference through an assembly path is listed as not checked; the plate's own items are
  // what would be kept.
  await page
    .getByLabel('STEP file', { exact: true })
    .setInputFiles(f43('loss-component-path.step'));
  await expect(dialog.getByLabel('PMI in the file')).toContainText('Geometric tolerances');
  await expect(read).toContainText('References through an assembly path');
  await expect(read).toContainText('not checked by this kernel');
  await expect(dialog.getByLabel('PMI kept')).toContainText('geometric tolerances: 3');
  await expect(dialog).toContainText('could not be read or checked');
  await expect(dialog).toContainText('does not cover exports');
  await page.screenshot({ path: test.info().outputPath('cad-pmi-dialog.png') });
  // Within the narrow layout too: the dialog does not widen the page.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await nativeArtifact(page)).cadResources ?? []).toEqual([]);
  await expect(page.getByRole('dialog', { name: 'Import STEP' })).toHaveCount(0);

  // An assembly with a dimension across two parts in the empty document: the same consent, then
  // the assembly dialog with what is kept.
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(f43('pmi-assembly.step'));
  await expect(dialog.getByLabel('PMI kept')).toContainText('dimensions: 2');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Import STEP assembly' })).toHaveCount(0);
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(f43('pmi-assembly.step'));
  await dialog
    .getByRole('button', { name: 'Import with the PMI that is kept', exact: true })
    .click();
  const importing = page.getByRole('dialog', { name: 'Import STEP assembly' });
  await expect(importing.getByLabel('Import report')).toContainText(
    'PMI the import could not keep',
  );
  await expect(importing.getByLabel('Import report')).toContainText('dimensions: 2');
  await importing.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(importing).toHaveCount(0);
  expect((await nativeArtifact(page)).cadResources ?? []).toEqual([]);

  // F43 loses nothing: no question; the report lists what is kept, and PMI is not a loss.
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(f43('pmi-plate.step'));
  const report = page.locator('dl[aria-label="Import report"]');
  await expect(report).toContainText('AP242');
  await expect(dialog).toHaveCount(0);
  await expect(report).toContainText('dimensions: 2, geometric tolerances: 3, datums: 2');
  await expect(report).not.toContainText('PMI the import could not keep');
  await page.screenshot({ path: test.info().outputPath('cad-pmi-report.png') });
  await page.getByRole('button', { name: 'Insert body', exact: true }).click();
  await ready(page);
  await expect(page.locator('.cad-status')).not.toContainText('could not');
  // The body list is in the side panel, closed in the narrow layout: the record has the body.
  const record = await nativeArtifact(page);
  const draft = record.draft.content as {
    assets: { kind: string }[];
    features: { type: string; args?: { pmiAssetId?: string } }[];
  };
  expect(draft.features.map((f) => f.type)).toEqual(['imported', 'transform']);
  expect(draft.assets.map((a) => a.kind)).toEqual(['source-step', 'normalized-brep', 'pmi']);
  expect(draft.features[0].args?.pmiAssetId).toBeDefined();
  // The original file, PMI included, is kept unchanged, and the kept PMI is stored beside it.
  const resources = record.cadResources as { kind: string; bytes: string }[];
  const original = await readFile(f43('pmi-plate.step'));
  expect(Buffer.from(resources[0].bytes, 'base64').equals(original)).toBe(true);
  const kept = resources.find((r) => r.kind === 'pmi');
  expect(kept).toBeDefined();
  const asset = JSON.parse(Buffer.from(kept!.bytes, 'base64').toString('utf8')) as {
    items: { kind: string }[];
  };
  expect(asset.items).toHaveLength(7);
  await page.screenshot({ path: test.info().outputPath('cad-pmi-imported.png') });
  // PMI-4b (TS-1433): the STEP export writes the kept PMI as AP242 and says what it wrote.
  await (await tool(page, 'Export STEP, STL or GLB')).click();
  const exporting = page.getByRole('dialog', { name: 'Export 3D file' });
  await exporting.getByLabel(/^STEP/).check();
  await exporting.getByRole('button', { name: 'Prepare file' }).click();
  const exportReport = exporting.getByLabel('Export report');
  await expect(exportReport).toContainText(
    'PMI is written as semantic GD&T (AP242) on the faces, edges and vertices it was imported on: 2 dimensions, 3 geometric tolerances, 2 datums',
  );
  await expect(exportReport).not.toContainText('PMI (dimensions, tolerances, datums');
  await page.screenshot({ path: test.info().outputPath('cad-pmi-export.png') });
  const download = page.waitForEvent('download');
  await exporting.getByRole('button', { name: 'Save STEP' }).click();
  const written = (await readFile((await (await download).path())!)).toString('latin1');
  expect(written).toMatch(/AP242/);
  expect(written.match(/^#\d+ ?= ?DATUM\(/gm)).toHaveLength(2);
  expect(written).toMatch(/POSITION_TOLERANCE|GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE/);
});

// PMI-2 (docs/cad/pmi.md, 表示と操作, CAD83 in part): the selected imported body lists its kept
// PMI by kind; choosing an item highlights its faces. The list survives a save and reload. What a
// Boolean leaves of it is PMI-4a's (TS-1430).
test('PMI-2 list and highlight (ST-194, CAD83, TS-1375)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(f43('pmi-plate.step'));
  await page.getByRole('button', { name: 'Insert body', exact: true }).click();
  await ready(page);
  const plate = bodies(page).filter({ hasText: 'pmi-plate' });
  await plate.click();
  const pmi = page.getByTestId('cad-pmi');
  await expect(pmi.getByRole('list', { name: 'Dimensions' })).toContainText(
    'Diameter ⌀10 ±0.05 mm',
  );
  await expect(pmi.getByRole('list', { name: 'Datums' }).getByRole('button')).toHaveCount(2);
  const position = pmi.getByRole('button', { name: /Position ⌀0\.1 mm \| A \| B/ });
  await position.click();
  await expect(position).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: test.info().outputPath('cad-pmi-highlight.png') });
  await position.click();
  await expect(position).toHaveAttribute('aria-pressed', 'false');

  // Saved and reloaded, the list reads the stored asset again.
  await page.keyboard.press('Control+s');
  await page.reload();
  await ready(page);
  await bodies(page).filter({ hasText: 'pmi-plate' }).click();
  await expect(
    pmi.getByRole('list', { name: 'Geometric tolerances' }).getByRole('button'),
  ).toHaveCount(3);
});

// PMI-4a (docs/cad/pmi.md, 加工と失効, CAD84): a box cut through the plate's corner changes the
// faces it meets. The items on them, and those depending on their datums, are stale and cannot be
// chosen; datum B on the untouched side stays current and is highlighted. Undo makes all current.
test('PMI-4a items kept after a Boolean only where unchanged (ST-212, CAD84, TS-1430)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(f43('pmi-plate.step'));
  await page.getByRole('button', { name: 'Insert body', exact: true }).click();
  await ready(page);
  const pmi = page.getByTestId('cad-pmi');
  await (await tool(page, 'Add box')).click();
  await ready(page);
  // The box is added beside the plate (x = 90): moved into it, so the cut takes material.
  await bodies(page).filter({ hasText: 'Box' }).click();
  const placement = page
    .locator('.cad-inspector details')
    .filter({ has: page.getByText('Placement', { exact: true }) });
  if ((await placement.getAttribute('open')) === null) await placement.locator('summary').click();
  await placement.getByLabel('X (mm)').fill('-80');
  await placement.getByLabel('X (mm)').press('Enter');
  await ready(page);
  await bodies(page).filter({ hasText: 'pmi-plate' }).click();
  const combine = page
    .locator('.cad-inspector details')
    .filter({ has: page.getByText('Combine', { exact: true }) });
  if ((await combine.getAttribute('open')) === null) await combine.locator('summary').click();
  await combine.getByLabel('With body').selectOption({ index: 1 });
  await combine.getByRole('button', { name: 'Cut', exact: true }).click();
  await ready(page);
  await bodies(page).filter({ hasText: 'pmi-plate' }).click();
  await expect(pmi.getByRole('note')).toContainText(
    'changed the shape after the import. 1 of 7 items',
  );
  const positionItem = pmi.getByRole('button', { name: /Position/ });
  await expect(positionItem).toBeDisabled();
  await expect(positionItem).toContainText('stale');
  const datumB = pmi.getByRole('button', { name: /Datum B/ });
  await expect(datumB).toBeEnabled();
  await expect(datumB).not.toContainText('stale');
  await datumB.click();
  await expect(datumB).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: test.info().outputPath('cad-pmi-kept.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await bodies(page).filter({ hasText: 'pmi-plate' }).click();
  await expect(pmi.getByRole('note')).toHaveCount(0);
  await expect(pmi.getByRole('button', { name: /Position/ })).toBeEnabled();
});

/** Pixels of the viewport near a colour (sRGB), from a screenshot of its canvas. */
async function viewportPixels(page: Page, rgb: [number, number, number]) {
  const png = await page.locator('.cad-viewport canvas').first().screenshot();
  return page.evaluate(
    async ({ data, rgb }) => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d')!;
      g.drawImage(bitmap, 0, 0);
      const pixels = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let n = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          Math.abs(pixels[i]! - rgb[0]) < 40 &&
          Math.abs(pixels[i + 1]! - rgb[1]) < 40 &&
          Math.abs(pixels[i + 2]! - rgb[2]) < 40
        )
          n++;
      return n;
    },
    { data: png.toString('base64'), rgb },
  );
}
// PMI-3a (docs/cad/pmi.md): the presentation lines the file links to a kept item are kept with it
// and drawn with the body; the PMI switch hides them, the focused item's are drawn in the
// targets' colour, and they come back after a save and reload.
test('PMI-3a presentation lines, switch and focus (ST-210, CAD83, TS-1421)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  // Everything is kept with PMI-3b (the saved views too): the import does not ask.
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(f43('pmi-presented.step'));
  await page.getByRole('button', { name: 'Insert body', exact: true }).click();
  await ready(page);
  const shown = page.getByTestId('cad-pmi-shown');
  await expect(shown).toBeChecked();
  const green: [number, number, number] = [43, 138, 62];
  await expect.poll(() => viewportPixels(page, green)).toBeGreaterThan(30);
  await page.screenshot({ path: test.info().outputPath('cad-pmi-presentation.png') });
  await shown.uncheck();
  await expect.poll(() => viewportPixels(page, green)).toBeLessThan(5);
  await shown.check();
  await expect.poll(() => viewportPixels(page, green)).toBeGreaterThan(30);

  // The diameter's lines in the targets' colour once it is chosen.
  await bodies(page).filter({ hasText: 'pmi-presented' }).click();
  const pmi = page.getByTestId('cad-pmi');
  const diameter = pmi.getByRole('button', { name: /Diameter ⌀10 mm/ });
  await expect(diameter).toContainText('presented');
  await expect(pmi.getByRole('button', { name: /Flatness/ })).not.toContainText('presented');
  const before = await viewportPixels(page, green);
  await diameter.click();
  await expect.poll(() => viewportPixels(page, green)).toBeLessThan(before);
  await page.screenshot({ path: test.info().outputPath('cad-pmi-presentation-focus.png') });

  // Saved and reloaded: the lines are read from the stored asset again.
  await page.keyboard.press('Control+s');
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('cad-pmi-shown')).toBeChecked();
  await expect.poll(() => viewportPixels(page, green)).toBeGreaterThan(30);
});

test('PMI-3b saved views: camera and only their PMI (ST-211, CAD83, TS-1425)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(f43('pmi-presented.step'));
  await page.getByRole('button', { name: 'Insert body', exact: true }).click();
  await ready(page);
  await bodies(page).filter({ hasText: 'pmi-presented' }).click();
  const views = page.getByTestId('cad-pmi').getByRole('list', { name: 'Saved views' });
  await expect(views.getByRole('button')).toHaveCount(3);
  const all = views.getByRole('button', { name: 'All PMI' });
  const hole = views.getByRole('button', { name: /^Hole/ });
  const datumA = views.getByRole('button', { name: /^Datum A/ });
  await expect(hole).toContainText('2 items');
  await expect(datumA).toContainText('1 item');
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  const green: [number, number, number] = [43, 138, 62];
  const everything = await viewportPixels(page, green);
  // From above, the diameter and position only.
  await hole.click();
  await expect(hole).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => viewportPixels(page, green)).toBeGreaterThan(30);
  await page.screenshot({ path: test.info().outputPath('cad-pmi-view-hole.png') });
  // From the front, datum A only.
  await datumA.click();
  await expect.poll(() => viewportPixels(page, green)).toBeGreaterThan(10);
  await page.screenshot({ path: test.info().outputPath('cad-pmi-view-datum-a.png') });
  await all.click();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  expect(everything).toBeGreaterThan(30);

  // Saved and reloaded: the views are read from the stored asset again.
  await page.keyboard.press('Control+s');
  await page.reload();
  await ready(page);
  await bodies(page).filter({ hasText: 'pmi-presented' }).click();
  await expect(
    page.getByTestId('cad-pmi').getByRole('list', { name: 'Saved views' }).getByRole('button'),
  ).toHaveCount(3);
});

// R1 acceptance (docs/cad/r1-modeling.md, CAD37): each representative part of R1 in the
// ordinary Playground — a change that the history follows, a saved version, a reload, a native
// round trip and its STEP. The STEP files are kept for the independent reader.
const r1Parts: [string, () => CadDocument, [string, string, string]?][] = [
  ['bracket', () => f11Bracket(), ['Width', '120', '120 mm']],
  ['housing', () => r1Housing(), ['Width', '120', '120 mm']],
  ['pattern', () => f14Patterns('linear'), ['Holes', '4', '4']],
  ['mirror', () => f14Patterns('mirror')],
  ['loft', () => f15Loft()],
  ['sweep', () => f15Sweep()],
];
for (const [name, part, change] of r1Parts)
  test(`R1 part ${name}: change, save, reload, native round trip and STEP (CAD37)`, async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop flow');
    await page.goto('/');
    await create(page, 'cad');
    await ready(page);
    const empty = await nativeArtifact(page);
    const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
    const content = { ...part(), kernelProfile };
    await importJson(page, `${name}.json`, {
      ...empty,
      name: `R1 ${name}`,
      draft: { ...empty.draft, content },
    });
    await expect(page.getByLabel('Artifact name')).toHaveValue(`R1 ${name}`);
    await ready(page);
    await expect(bodies(page)).toHaveCount(1);
    const params = page.getByRole('list', { name: 'Parameters' });
    if (change) {
      const [parameter, value, shown] = change;
      await params.getByRole('button', { name: new RegExp(`^${parameter}`) }).click();
      const field = page.locator('.cad-inspector').getByLabel(/^Value/);
      await field.fill(value);
      await field.press('Enter');
      await ready(page);
      await expect(params).toContainText(new RegExp(`${parameter}\\s*${shown}`));
    }
    await page.keyboard.press('Control+s');
    await page.getByRole('button', { name: 'History and compare', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'History (1)' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.reload();
    await ready(page);
    await expect(bodies(page)).toHaveCount(1);
    const record = await nativeArtifact(page);
    expect(record.versions).toHaveLength(1);
    expect(record.versions[0].content).toEqual(record.draft.content);
    await importJson(page, `${name}-copy.json`, { ...record, name: `R1 ${name} copy` });
    await expect(page.getByLabel('Artifact name')).toHaveValue(`R1 ${name} copy`);
    await ready(page);
    await expect(bodies(page)).toHaveCount(1);
    expect((await nativeArtifact(page)).draft.content).toEqual(record.draft.content);

    await (await tool(page, 'Export STEP, STL or GLB')).click();
    const dialog = page.getByRole('dialog', { name: 'Export 3D file' });
    await dialog.getByLabel(/^STEP/).check();
    await dialog.getByRole('button', { name: 'Prepare file' }).click();
    await expect(dialog.getByLabel('Export report')).toContainText('mm');
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save STEP' }).click();
    const step = await readFile((await (await download).path())!);
    expect(step.toString('latin1')).toMatch(/MANIFOLD_SOLID_BREP/);
    await mkdir(stepDir, { recursive: true });
    await writeFile(`${stepDir}/${name}.step`, step);
  });

// CR1b (docs/cad/car-design.md, CR1の分け方): a fill side next to a panel is set to G2 in the
// inspector; the fill is rebuilt with the panel's curvature and Undo takes it back to G1
// (TS-1476, ST-243).
test('set a fill side to G2 in the inspector and undo it (CR1b)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'hood.json', {
    ...empty,
    name: 'Hood',
    draft: { ...empty.draft, content: { ...f18Hood('sheets'), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Hood');
  await ready(page);
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: 'crown fill', exact: true })
    .click();
  const sides = page.getByTestId('cad-fill-boundary').getByRole('combobox');
  await expect(sides).toHaveCount(4);
  await expect(sides.nth(1)).toHaveValue('G1');
  await sides.nth(1).selectOption('G2');
  await ready(page);
  const continuity = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    const crown = doc.features.find((f) => f.id === 'crown-fill')!;
    return crown.type === 'fill' ? crown.args.boundary.map((b) => b.continuity) : [];
  };
  expect(await continuity()).toEqual(['G0', 'G2', 'G0', 'G1']);
  await expect(bodies(page)).toHaveCount(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  expect(await continuity()).toEqual(['G0', 'G1', 'G0', 'G1']);
});

// CR1d (docs/cad/car-design.md, CR1の分け方): three u arcs and three v arcs of a roof make one
// Gordon surface from the Boundary dialog, and Undo takes it away (TS-1480, ST-246).
test('span a curve network from the Boundary dialog and undo it (CR1d)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  const arcs = f19Network();
  await importJson(page, 'roof.json', {
    ...empty,
    name: 'Roof arcs',
    draft: {
      ...empty.draft,
      content: { ...arcs, features: [], bodies: [], kernelProfile },
    },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Roof arcs');
  await ready(page);
  await page.getByRole('button', { name: 'Boundary…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Boundary' });
  await dialog.getByLabel('Result').selectOption('curveNetwork');
  for (const id of ['u0', 'u1', 'u2', 'v0', 'v1', 'v2'])
    await dialog.getByRole('checkbox', { name: `${id} arc`, exact: true }).check();
  for (const n of [0, 1, 2])
    await dialog
      .getByRole('checkbox', { name: 'Across (v)' })
      .nth(3 + n)
      .check();
  await dialog.getByRole('button', { name: 'Create curve network' }).click();
  await ready(page);
  const network = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    const f = doc.features.find((x) => x.type === 'curveNetwork');
    return f?.type === 'curveNetwork'
      ? [f.args.u, f.args.v].map((w) => w.map((c) => ('sketchId' in c ? c.sketchId : '?')))
      : undefined;
  };
  expect(await network()).toEqual([
    ['u0', 'u1', 'u2'],
    ['v0', 'v1', 'v2'],
  ]);
  await expect(bodies(page)).toHaveCount(1);
  await expect(page.getByTestId('cad-network-v')).toContainText('v0');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  expect(await network()).toBeUndefined();
});

// CLF2 (docs/cad/car-look-process.md, CLF1〜CLF3の分け方): each u curve of the roof is made
// from a side arc and a plan line in the Boundary dialog, and spans the network with the v arcs
// (TS-2003, ST-500).
test('span a curve network through two-view curves (CLF2)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'views.json', {
    ...empty,
    name: 'Roof views',
    draft: {
      ...empty.draft,
      content: {
        ...f81TwoView(),
        // Sketch IDs may hold `/` (#1111 review): the side views and the plan share a prefix.
        sketches: f81TwoView().sketches.map((x) =>
          x.id.startsWith('v') ? x : { ...x, id: `roof/${x.id}` },
        ),
        features: [],
        bodies: [],
        kernelProfile,
      },
    },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Roof views');
  await ready(page);
  await page.getByRole('button', { name: 'Boundary…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Boundary' });
  await dialog.getByLabel('Result').selectOption('curveNetwork');
  for (const id of ['v0', 'v1', 'v2']) {
    await dialog.getByRole('checkbox', { name: `${id} arc`, exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'Across (v)' }).last().check();
  }
  for (const n of [0, 1, 2]) {
    await dialog.getByLabel('Side view').selectOption({ label: `u${n} arc` });
    await dialog.getByLabel('Plan view').selectOption({ label: `plan l${n}` });
    await dialog.getByRole('button', { name: 'Add two-view curve' }).click();
  }
  // The same pair twice, or both views from one sketch, cannot be added.
  await expect(dialog.getByRole('button', { name: 'Add two-view curve' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Create curve network' }).click();
  await ready(page);
  const doc = (await nativeArtifact(page)).draft.content as CadDocument;
  const f = doc.features.find((x) => x.type === 'curveNetwork');
  expect(f?.type === 'curveNetwork' && f.args.u).toEqual(
    [0, 1, 2].map((n) => ({
      twoView: {
        side: { sketchId: `roof/u${n}`, element: 'arc' },
        plan: { sketchId: 'roof/plan', element: `l${n}` },
      },
    })),
  );
  await expect(bodies(page)).toHaveCount(1);
  await expect(page.getByText('Shape could not be calculated')).toHaveCount(0);
});

// CLF1a (docs/cad/car-look-process.md, CLF1〜CLF3の分け方): a sketch is drawn over the shown
// bodies' silhouette and the other sketches' lines, which can be turned off (TS-2004, ST-501).
test('draw a sketch over the bodies and the other sketches (CLF1a)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'roof.json', {
    ...empty,
    name: 'Roof',
    draft: { ...empty.draft, content: { ...f81TwoView(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Roof');
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit sketch u1' }).click();
  const drawing = page.getByRole('application', { name: 'Drawing of u1' });
  const under = drawing.getByTestId('cad-sketch-underlay');
  // The roof seen from the side, and the 8 elements of the other 7 sketches.
  await expect(under.getByTestId('cad-sketch-shadow')).toHaveCount(1);
  await expect(under.locator('polyline')).toHaveCount(8);
  // The shadow spans the roof's 80 mm along X (u of a sketch parallel to XZ).
  const shadow = under.getByTestId('cad-sketch-shadow');
  expect(Number(await shadow.getAttribute('width'))).toBeCloseTo(80, 0);
  await page.screenshot({ path: test.info().outputPath('clf1a-underlay.png') });
  await page.getByRole('checkbox', { name: 'Underlay' }).uncheck();
  await expect(drawing.getByTestId('cad-sketch-underlay')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Underlay' }).check();
  await expect(drawing.getByTestId('cad-sketch-underlay')).toHaveCount(1);
});

// CR2b (docs/cad/car-design.md, CR2の分け方): a sheet is offset 2 mm to its back from the body's
// inspector into a second sheet body; its side is changed on the feature and Undo takes it away
// (TS-1488, ST-248).
test('offset a sheet into a new sheet body and undo it (CR2b)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'wall.json', {
    ...empty,
    name: 'Wall',
    draft: { ...empty.draft, content: { ...f17Sheets('extrude'), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Wall');
  await ready(page);
  await bodies(page).first().click();
  await page.locator('summary', { hasText: /^Offset surface$/ }).click();
  await page.getByRole('button', { name: 'Offset into a new sheet' }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  const offset = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    return doc.features.find((f) => f.type === 'offsetSurface');
  };
  expect(await offset()).toMatchObject({ args: { distance: mm(2), side: 'back' } });
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: 'surface offset offsetSurface', exact: true })
    .click();
  await page.getByTestId('cad-offset-side').selectOption('front');
  await ready(page);
  expect(await offset()).toMatchObject({ args: { side: 'front' } });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  expect(await offset()).toBeUndefined();
});

// CR2a (docs/cad/car-design.md, CR2の分け方): a flat panel is split along a sketch's line from
// its inspector; both pieces stay in the one body, and Undo takes the split away (TS-1491, ST-249).
test('split a sheet along a sketch line, keeping both pieces, and undo it (CR2a)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'panel.json', {
    ...empty,
    name: 'Panel',
    draft: { ...empty.draft, content: { ...f22Split('open', false), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Panel');
  await ready(page);
  await bodies(page).first().click();
  await page.locator('summary', { hasText: /^Split$/ }).click();
  await page.getByTestId('cad-split-sketch').selectOption('cutter');
  await page.getByRole('button', { name: 'Split, keeping every piece' }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await expect(page.getByTestId('cad-split-along')).toContainText('Cutter (1 elements)');
  const split = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    return doc.features.find((f) => f.type === 'split');
  };
  expect(await split()).toMatchObject({ args: { tool: { sketchId: 'cutter', elements: ['s0'] } } });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  expect(await split()).toBeUndefined();
});

// CR3c (docs/cad/car-design.md, CR3の分け方): a row of windows is cut with one trim from the
// panel's Trim section. A fourth window off the sheet is refused by name; leaving out the lines
// that miss cuts the three, and Undo takes the trim away (TS-1510, ST-255).
test('cut a row of windows in one trim, leaving out the one that misses (CR3c)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  const base = f22Split('closed', false);
  const windows = f27Windows('missed').sketches.find((s) => s.id === 'windows')!;
  await importJson(page, 'windows.json', {
    ...empty,
    name: 'Windows',
    draft: {
      ...empty.draft,
      content: { ...base, sketches: [...base.sketches, windows], kernelProfile },
    },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Windows');
  await ready(page);
  await bodies(page).first().click();
  await page.locator('summary', { hasText: /^Trim$/ }).click();
  await page.getByLabel('Cut with').selectOption('sketch:windows');
  await page.getByRole('button', { name: 'Trim', exact: true }).click();
  await ready(page);
  await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText(
    '該当する閉じた線：4番目（w3s0、w3s1、w3s2、w3s3）',
  );
  const trim = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    return doc.features.find((f) => f.type === 'trim');
  };
  expect(await trim()).toBeUndefined();
  // The refused edit draws the body's panel again, its sections closed.
  if (!(await page.getByLabel('Cut with').isVisible()))
    await page.locator('summary', { hasText: /^Trim$/ }).click();
  await page.getByLabel('Cut with').selectOption('sketch:windows');
  await page.getByLabel('Leave out lines that miss the surface').check();
  await page.getByRole('button', { name: 'Trim', exact: true }).click();
  await ready(page);
  expect(await trim()).toMatchObject({
    args: {
      tool: { sketchId: 'windows', elements: ['w0s0', 'w0s1', 'w0s2', 'w0s3'] },
      keep: 'outside',
      chains: [
        ['w1s0', 'w1s1', 'w1s2', 'w1s3'],
        ['w2s0', 'w2s1', 'w2s2', 'w2s3'],
        ['w3s0', 'w3s1', 'w3s2', 'w3s3'],
      ],
      ifMissed: 'skip',
    },
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  expect(await trim()).toBeUndefined();
});

// CR3b (docs/cad/car-design.md, CR3の分け方): a door is cut out of a flat panel along a sketch's
// square in one edit, a 3.5 mm gap between them; its gap is widened later in the door's
// inspector, and Undo takes the change and then the door away (TS-1506, ST-254).
test('cut a door out of a panel with a gap, widen it, and undo it (CR3b)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'panel.json', {
    ...empty,
    name: 'Panel',
    draft: { ...empty.draft, content: { ...f22Split('closed', false), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Panel');
  await ready(page);
  await bodies(page).first().click();
  await page.locator('summary', { hasText: /^Panel$/ }).click();
  await page.getByTestId('cad-panel-sketch').selectOption('cutter');
  await page.getByRole('button', { name: 'Cut out a panel' }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  const features = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    return {
      trim: doc.features.find((f) => f.type === 'trim'),
      panel: doc.features.find((f) => f.type === 'panel'),
    };
  };
  const tool = { sketchId: 'cutter', elements: ['s0', 's1', 's2', 's3'] };
  expect(await features()).toMatchObject({
    trim: { args: { tool, keep: 'outside', gap: { literalMm: 3.5 } } },
    panel: { args: { tool, keep: 'inside', gap: { literalMm: 3.5 } } },
  });
  // The door's gap is its own: widened in its inspector, the panel's trim stays.
  const gap = page.getByLabel('Gap (mm)', { exact: true });
  await gap.fill('6');
  await gap.press('Enter');
  await ready(page);
  expect((await features()).panel).toMatchObject({ args: { gap: { literalMm: 6 } } });
  expect((await features()).trim).toMatchObject({ args: { gap: { literalMm: 3.5 } } });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  expect((await features()).panel).toMatchObject({ args: { gap: { literalMm: 3.5 } } });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  expect(await features()).toEqual({ trim: undefined, panel: undefined });
});

// CR3e (docs/cad/car-design.md, CR3の分け方): the door cut out of a panel is made a part: a new
// CAD Artifact with one saved version holds the door's closure, and in the panel's document the
// door body is replaced by a component at the origin, in one edit that Undo takes back
// (TS-1519, ST-257).
test('make the door a part of its own Artifact and undo it (CR3e)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'panel.json', {
    ...empty,
    name: 'Panel',
    draft: { ...empty.draft, content: { ...f26Panel(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Panel');
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  await bodies(page).nth(1).click();
  await page.getByRole('button', { name: 'Make part', exact: true }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await expect(components(page)).toHaveText(['door-body 1']);
  await expect(page.getByTestId('cad-component')).not.toContainText('参照できません');
  const placed = await nativeArtifact(page);
  const doc = placed.draft.content as CadDocument;
  expect(doc.bodies.map((b) => b.id)).toEqual(['panel-body']);
  expect(doc.features.some((f) => f.id === 'door')).toBe(false);
  expect(doc.parts).toHaveLength(1);
  expect(placed.cadParts?.map((p) => p.contentHash)).toEqual([doc.parts[0]!.source.contentHash]);
  // The new Artifact is offered as a part with its saved version.
  await page.getByRole('button', { name: 'Insert part…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Insert part' });
  await expect(dialog.getByLabel('Version of door-body')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  await expect(components(page)).toHaveCount(0);
});

// CR2c (docs/cad/car-design.md, CR2の分け方): a press line is made on a flat panel from its
// panel, its depth changed later in the feature's inspector, and Undo takes the change and then
// the press line away (TS-1494, ST-250).
test('press a line into a sheet, deepen it later, and undo it (CR2c)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'panel.json', {
    ...empty,
    name: 'Panel',
    draft: { ...empty.draft, content: { ...f22Split('open', false), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Panel');
  await ready(page);
  await bodies(page).first().click();
  await page.locator('summary', { hasText: /^Press line$/ }).click();
  await page.getByTestId('cad-press-sketch').selectOption('cutter');
  await page.getByRole('button', { name: 'Press the line' }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  const press = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    return doc.features.find((f) => f.type === 'pressLine');
  };
  expect(await press()).toMatchObject({
    args: {
      tool: { sketchId: 'cutter', elements: ['s0'] },
      side: 'left',
      depth: { literalMm: 2 },
      toward: 'front',
      radius: { literalMm: 0.5 },
    },
  });
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: 'Press line pressLine', exact: true })
    .click();
  await expect(page.getByTestId('cad-press-along')).toContainText('Cutter (1 elements');
  const depth = page.locator('.cad-inspector').getByLabel('Depth (mm)');
  await depth.fill('4');
  await depth.press('Enter');
  await ready(page);
  await expect.poll(async () => (await press())?.args).toMatchObject({ depth: { literalMm: 4 } });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect.poll(async () => (await press())?.args).toMatchObject({ depth: { literalMm: 2 } });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  expect(await press()).toBeUndefined();
});

// TS-1497, ST-251 (CR2d): a flared wheel arch, raised and joined G2 in the inspector, undone.
test('flare a wheel arch, raise it and join it G2 later, and undo it (CR2d)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'fender.json', {
    ...empty,
    name: 'Fender',
    draft: { ...empty.draft, content: { ...f24Flare(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Fender');
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const flare = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    return doc.features.find((f) => f.type === 'flare');
  };
  await bodies(page).first().click();
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: 'Flare flare', exact: true })
    .click();
  await expect(page.getByTestId('cad-flare-along')).toContainText('Flare line (1 elements)');
  const height = page.locator('.cad-inspector').getByLabel('Height (mm)');
  await height.fill('20');
  await height.press('Enter');
  await ready(page);
  await expect.poll(async () => (await flare())?.args).toMatchObject({ height: { literalMm: 20 } });
  await page.locator('.cad-inspector').getByLabel('Joining the sheet').selectOption('G2');
  await ready(page);
  await expect.poll(async () => (await flare())?.args).toMatchObject({ continuity: 'G2' });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect.poll(async () => (await flare())?.args).toMatchObject({ continuity: 'G1' });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect.poll(async () => (await flare())?.args).toMatchObject({ height: { literalMm: 10 } });
});

// TS-1538, ST-263 (CR4c): a tray of four flanges on a flat panel, made wider, leaned out and turned
// to the back in the inspector, then undone.
test('flange a panel’s four borders into a tray, change its width, angle and side, and undo (CR4c)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'tray.json', {
    ...empty,
    name: 'Tray',
    draft: { ...empty.draft, content: { ...f47Flange('tray'), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Tray');
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const flange = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    return doc.features.find((f) => f.type === 'flange');
  };
  await bodies(page).first().click();
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: 'Flange flange', exact: true })
    .click();
  const inspector = page.locator('.cad-inspector');
  await expect(page.getByTestId('cad-flange-along')).toContainText('4 edges');
  const width = inspector.getByLabel('Width (mm)');
  await width.fill('25');
  await width.press('Enter');
  await ready(page);
  await expect.poll(async () => (await flange())?.args).toMatchObject({ width: { literalMm: 25 } });
  const angle = inspector.getByLabel('Angle from the sheet (°)');
  await angle.fill('60');
  await angle.press('Enter');
  await ready(page);
  await expect
    .poll(
      async () => ((await flange())?.args as { angle: { literalRad: number } }).angle.literalRad,
    )
    .toBeCloseTo(Math.PI / 3, 9);
  await inspector.getByLabel('Towards').selectOption('back');
  await ready(page);
  await expect.poll(async () => (await flange())?.args).toMatchObject({ toward: 'back' });
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Leaning in over the panel, the walls run into each other at the corners: refused, named.
  await angle.fill('135');
  await angle.press('Enter');
  await expect(page.getByRole('alert')).toContainText('フランジが自分や他のフランジ');
  // The refused edit is not kept: still 60°, and three edits to undo.
  await ready(page);
  expect(
    ((await flange())?.args as { angle: { literalRad: number } }).angle.literalRad,
  ).toBeCloseTo(Math.PI / 3, 9);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await ready(page);
  }
  await expect
    .poll(async () => (await flange())?.args)
    .toMatchObject({
      width: { literalMm: 10 },
      toward: 'front',
    });
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

// TS-1543, ST-264 (CR4d): a hat member made from a path sketch in the Member dialog, its flange
// and side changed in the inspector, a bend that does not fit refused, then undone.
test('sweep a hat member along a path, change its flange and side, and undo (CR4d)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  const path = f48ProfileSweep({ path: 'bend' });
  await importJson(page, 'member.json', {
    ...empty,
    name: 'Member',
    draft: {
      ...empty.draft,
      content: { ...path, features: [], bodies: [], kernelProfile },
    },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Member');
  await ready(page);
  await expect(bodies(page)).toHaveCount(0);
  const member = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    return doc.features.find((f) => f.type === 'profileSweep');
  };
  await page.getByRole('button', { name: 'Member…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Member' });
  await dialog.getByLabel('Flange width (mm)').fill('20');
  await dialog.getByRole('button', { name: 'Create member' }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(async () => (await member())?.args)
    .toMatchObject({
      path: { sketchId: 'member-path', elements: ['l0', 'a0'] },
      profile: { kind: 'hat', flange: { literalMm: 20 } },
      up: 'normal',
      flip: false,
    });
  const inspector = page.locator('.cad-inspector');
  await expect(page.getByTestId('cad-member-path')).toContainText('Member path (2 elements)');
  const flange = inspector.getByLabel('Flange width (mm)');
  await flange.fill('25');
  await flange.press('Enter');
  await ready(page);
  await expect
    .poll(async () => (await member())?.args)
    .toMatchObject({ profile: { flange: { literalMm: 25 } } });
  await inspector.getByLabel('Flip (the other way)').click();
  await ready(page);
  await expect.poll(async () => (await member())?.args).toMatchObject({ flip: true });
  await expect(page.getByRole('alert')).toHaveCount(0);
  // A bend R larger than the flange does not fit: refused, the member unchanged.
  const bend = inspector.getByLabel('Bend R (mm)');
  await bend.fill('40');
  await bend.press('Enter');
  await expect(page.getByRole('alert')).toContainText('角のRが断面の辺に収まりません');
  await ready(page);
  expect((await member())?.args).toMatchObject({ profile: { radius: { literalMm: 3 } } });
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await ready(page);
  }
  await expect
    .poll(async () => (await member())?.args)
    .toMatchObject({
      profile: { flange: { literalMm: 20 } },
      flip: false,
    });
});

// TS-1500, ST-252 (CR2e): the B1 sample, a hatchback's left skin; its wheelbase and roof height
// changed in the parameter list, undone and redone, saved and reloaded. Not a performance
// measurement.
test('the B1 car skin follows its wheelbase and roof height, undo, redo, save and reload (CR2e)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(900_000);
  const settled = () => expect(state(page)).toHaveText('Shape up to date', { timeout: 300_000 });
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = {
    ...(empty.draft.content as CadDocument).kernelProfile,
    ...cadToleranceSets.large,
  };
  await importJson(page, 'b1.json', {
    ...empty,
    name: 'B1 car',
    draft: { ...empty.draft, content: { ...f25B1Car(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('B1 car');
  await settled();
  await expect(bodies(page)).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const value = async (id: string) =>
    ((await nativeArtifact(page)).draft.content as CadDocument).parameters.find((p) => p.id === id)
      ?.value;
  const params = page.getByRole('list', { name: 'Parameters' });
  const set = async (name: string, to: string) => {
    await params.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    const field = page.locator('.cad-inspector').getByLabel(/^Value/);
    await field.fill(to);
    await field.press('Enter');
    await settled();
    await expect(page.getByRole('alert')).toHaveCount(0);
  };
  await set('Wheelbase', '2500');
  await expect(params).toContainText(/Wheelbase\s*2,?500 mm/);
  await set('Roof height', '1400');
  await expect(params).toContainText(/Roof height\s*1,?400 mm/);
  await expect(bodies(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled();
  await expect.poll(() => value('roof')).toBe(1335);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await settled();
  await expect.poll(() => value('roof')).toBe(1400);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'History (1)' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await settled();
  await expect(bodies(page)).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const record = await nativeArtifact(page);
  expect(record.versions[0].content).toEqual(record.draft.content);
  expect(await value('wheelbase')).toBe(2500);
  expect(await value('roof')).toBe(1400);
});

// CM-2 (docs/cad/complex-models.md, U4): a document whose fillet fails still shows the body
// outside the failure, measured as usual, and the filleted part before the fillet, faint and
// never picked, measured or exported.
test('a failed document shows the other bodies and the failed body before the failure (CM-2)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  let doc = f12Fillet();
  const fillet = doc.features.find((f) => f.id === 'fillet')!;
  doc = applyCadOperation(doc, {
    type: 'updateFeature',
    featureId: 'fillet',
    args: { ...(fillet.args as object), radius: mm(40) } as never,
  });
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    features: [
      {
        id: 'ball',
        name: 'Ball',
        type: 'sphere',
        inputFeatureIds: [],
        args: { radius: mm(10), origin: position(300, 0, 0), orientation: identityQuaternion() },
      },
    ],
    bodies: [
      {
        id: 'ball-body',
        name: 'Ball',
        sourceFeatureId: 'ball',
        placementFeatureId: 'ball-placement',
        appearance: { color: '#2e86c1', opacity: 1 },
      },
    ],
  });
  await importJson(page, 'partial.json', {
    ...empty,
    name: 'Partial',
    draft: { ...empty.draft, content: { ...doc, kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Partial');
  await expect(state(page)).toHaveText('Shape could not be calculated', { timeout: 90_000 });
  const note = page.getByTestId('cad-geometry-failure');
  await expect(note).toContainText('計算できたbody（1個）はそのまま表示し、計測できます。');
  await expect(note).toContainText('「part」はfeature「Top fillet」の手前の形を薄く表示しています');
  // The body outside the failure is measured; the failed one is not.
  await bodies(page).filter({ hasText: 'Ball' }).click();
  await expect(page.locator('.cad-metrics')).toContainText('Volume');
  await bodies(page).filter({ hasText: 'part' }).click();
  await expect(page.locator('.cad-inspector')).not.toContainText('Volume');
  // Nothing of a failed document is exported.
  // The tools that pick and measure the shown bodies stay available; export does not.
  await expect(await tool(page, 'Measure distance')).toBeEnabled();
  await expect(await tool(page, 'Pick faces')).toBeEnabled();
  await expect(await tool(page, 'Export STEP, STL or GLB')).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('cad-playground-partial.png') });
});

// CM-8 (docs/cad/complex-models.md, O1): the demo's car, bridge and airliner, generated by the
// builder, open through the ordinary native JSON import and evaluate. In the bridge, the deck
// height is a parameter the hangers follow (ST-91). Not a performance measurement.
const builderModels: [string, () => CadDocument, number][] = [
  ['car', () => f40Car(), 9],
  ['bridge', () => f41Bridge(), 5],
  ['airliner', () => f42Airliner(), 8],
  // K1 (CM-5): the half wing mirrored is one body of two solids, the Inspector says so.
  ['airliner mirrored', () => f42Airliner(undefined, { mirrored: true }), 8],
];
for (const [name, build, count] of builderModels)
  test(`builder model ${name} opens through the native JSON import (CM-8, ST-91)`, async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop flow');
    await page.goto('/');
    await create(page, 'cad');
    await ready(page);
    const empty = await nativeArtifact(page);
    const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
    await importJson(page, `${name}.json`, {
      ...empty,
      name: `Builder ${name}`,
      draft: { ...empty.draft, content: { ...build(), kernelProfile } },
    });
    await expect(page.getByLabel('Artifact name')).toHaveValue(`Builder ${name}`);
    await ready(page);
    await expect(bodies(page)).toHaveCount(count);
    if (name === 'airliner mirrored') {
      await bodies(page).filter({ hasText: 'Wing' }).click();
      await expect(page.getByTestId('cad-body-solids')).toHaveText(
        '2 disjoint solids (totals over all)',
      );
    }
    if (name !== 'bridge') return;
    const params = page.getByRole('list', { name: 'Parameters' });
    await params.getByRole('button', { name: /^Deck height/ }).click();
    const field = page.locator('.cad-inspector').getByLabel(/^Value/);
    await field.fill('18000');
    await field.press('Enter');
    await ready(page);
    await expect(params).toContainText(/Deck height\s*18,?000 mm/);
    const hangers = (await nativeArtifact(page)).draft.content as CadDocument;
    expect(hangers.parameters.find((p) => p.id === 'deck-height')).toMatchObject({ value: 18000 });
  });

// K2 (CM-6): the airliner with its wings joined to the fuselage fails with the standard
// tolerances; the large set is chosen explicitly, previewed and adopted as one edit (ST-97).
test('tolerance set: the joined airliner needs the large set, chosen and adopted explicitly (CM-6, ST-97)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'joined.json', {
    ...empty,
    name: 'Joined airliner',
    draft: {
      ...empty.draft,
      content: { ...f42Airliner(undefined, { mirrored: true, joined: true }), kernelProfile },
    },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Joined airliner');
  await expect(state(page)).toHaveText('Shape could not be calculated', { timeout: 90_000 });
  await expect(page.getByTestId('cad-tolerance-set')).toHaveText('standard');
  await page.getByRole('button', { name: 'Use large tolerances…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change tolerance set' });
  await expect(dialog).toBeVisible({ timeout: 90_000 });
  await expect(dialog).toContainText('result-tolerance');
  await expect(dialog.getByRole('table', { name: 'Tolerance set result' })).toContainText(
    'Airframe',
  );
  await dialog.getByRole('button', { name: 'Adopt large tolerances' }).click();
  await ready(page);
  await expect(page.getByTestId('cad-tolerance-set')).toHaveText('large');
  const adopted = (await nativeArtifact(page)).draft.content as CadDocument;
  expect(adopted.kernelProfile).toMatchObject({ maxResultLinearToleranceMm: 0.01 });
  // One edit: Undo goes back to the standard set and its failure.
  await page.keyboard.press('Control+z');
  await expect(state(page)).toHaveText('Shape could not be calculated', { timeout: 90_000 });
  await expect(page.getByTestId('cad-tolerance-set')).toHaveText('standard');
});

test('R1 scope: later capabilities in a native file are refused and open nothing (CAD38)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  const bracket = { ...f11Bracket(), kernelProfile };
  // A spline without control points (R2a-2 stores them, docs/cad/r2a-freeform.md).
  const spline = structuredClone(bracket);
  spline.sketches[0]!.entities.push({ type: 'spline', id: 's1' } as never);
  const sheet = structuredClone(bracket);
  Object.assign(sheet.bodies[0]!, { kind: 'sheet' });
  for (const [label, content] of [
    ['Spline', spline],
    ['Sheet', sheet],
  ] as const) {
    await importJson(page, `${label}.json`, {
      ...empty,
      name: label,
      draft: { ...empty.draft, content },
    });
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('Artifact name')).not.toHaveValue(label);
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  }
  // The Surface offers none of them outside Sketch mode (a surface body is R2a-1, below; the
  // spline tool R2a-2, in Sketch mode only).
  await expect(page.getByRole('button', { name: /spline|guide|variable/i })).toHaveCount(0);
});

// R2a-1 (docs/cad/r2a-freeform.md, CAD39): a surface body (sheet) in the ordinary Playground —
// measured without volume, changed by its parameter, made from the Navigator, saved, reloaded,
// round-tripped as native JSON and written as STEP; STL refuses it with the reason.
test('R2a sheet: measure, change, create, save, reload, native round trip, STEP and no STL (CAD39)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'sheet.json', {
    ...empty,
    name: 'R2a sheet',
    draft: { ...empty.draft, content: { ...f17Sheets('extrude'), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('R2a sheet');
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await bodies(page).first().click();
  const metrics = page.locator('.cad-metrics');
  await expect(metrics).toContainText('Surface (no volume)');
  await expect(metrics).toContainText(/Open edges\s*6,/);
  await expect(metrics).not.toContainText('mm³');
  // H = 40: the wall grows, still a sheet.
  const params = page.getByRole('list', { name: 'Parameters' });
  await params.getByRole('button', { name: /^Height/ }).click();
  const field = page.locator('.cad-inspector').getByLabel(/^Value/);
  await field.fill('40');
  await field.press('Enter');
  await ready(page);
  await expect(params).toContainText(/Height\s*40 mm/);
  // A second sheet from the same sketch, from the Navigator.
  await page.getByRole('button', { name: 'Surface…', exact: true }).click();
  const make = page.getByRole('dialog', { name: 'Surface' });
  await make.getByLabel('Shape').selectOption('revolve');
  await make.getByLabel(/^Angle/).fill('90');
  await make.getByRole('button', { name: 'Create surface' }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  const made = await nativeArtifact(page);
  const content = made.draft.content as CadDocument;
  expect(content.bodies.map((b) => b.kind)).toEqual(['sheet', 'sheet']);
  expect(content.features.map((f) => f.type)).toContain('revolveSurface');
  // STEP takes one body: the revolved one goes again (Undo) before the export.
  await page.keyboard.press('Control+z');
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);

  // The Undo is in the stored draft before the version is saved and the page reloads.
  await expect
    .poll(async () => ((await nativeArtifact(page)).draft.content as CadDocument).bodies.length)
    .toBe(1);
  await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'History (1)' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  const record = await nativeArtifact(page);
  expect(record.versions).toHaveLength(1);
  expect(record.versions[0].content).toEqual(record.draft.content);
  expect((record.draft.content as CadDocument).bodies[0]!.kind).toBe('sheet');
  await importJson(page, 'sheet-copy.json', { ...record, name: 'R2a sheet copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('R2a sheet copy');
  await ready(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(record.draft.content);

  await (await tool(page, 'Export STEP, STL or GLB')).click();
  const dialog = page.getByRole('dialog', { name: 'Export 3D file' });
  await dialog.getByLabel(/^STEP/).check();
  await dialog.getByRole('button', { name: 'Prepare file' }).click();
  await expect(dialog.getByLabel('Export report')).toContainText('mm');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save STEP' }).click();
  const step = (await readFile((await (await download).path())!)).toString('latin1');
  expect(step).toMatch(/SHELL_BASED_SURFACE_MODEL/);
  expect(step).not.toMatch(/MANIFOLD_SOLID_BREP/);
  const r2aDir = process.env.CAD_R2A_STEP_DIR ?? '/tmp/cad-r2a-step';
  await mkdir(r2aDir, { recursive: true });
  await writeFile(`${r2aDir}/playground-wall.step`, step);
  // STL needs a volume: refused with the reason, nothing written.
  await (await tool(page, 'Export STEP, STL or GLB')).click();
  await dialog.getByLabel(/^STL \(binary/).check();
  await dialog.getByLabel(/STL has no unit field/).check();
  await dialog.getByRole('button', { name: 'Prepare file' }).click();
  await expect(dialog.getByRole('alert')).toContainText('体積がない');
  await expect(dialog.getByRole('button', { name: 'Save STL' })).toHaveCount(0);
});

const components = (page: Page) =>
  page.getByRole('list', { name: 'Components' }).getByRole('button');
test('R2b-1 assembly: insert a saved part twice, place it, save, reload and round-trip native JSON (CAD49–CAD54)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  // The part: a plate with one saved version.
  await create(page, 'cad');
  await page.getByLabel('Artifact name').fill('Plate part');
  await page.getByLabel('Artifact name').press('Enter');
  await ready(page);
  await (await tool(page, 'Add plate')).click();
  await ready(page);
  await save(page, 1);
  const part = await nativeArtifact(page);

  // The assembly places that version twice: one definition, two components.
  await create(page, 'cad');
  await page.getByLabel('Artifact name').fill('Rig');
  await page.getByLabel('Artifact name').press('Enter');
  await ready(page);
  const insert = async () => {
    await page.getByRole('button', { name: 'Insert part…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Insert part' });
    await dialog.getByLabel('Version of Plate part').selectOption({ index: 1 });
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await ready(page);
  };
  await insert();
  await insert();
  await expect(components(page)).toHaveText(['Plate part 1', 'Plate part 2']);
  // The second is selected after its insert; move it 120 mm along X.
  const placement = page.getByRole('form', { name: 'Placement' });
  await placement.getByLabel('X (mm)').fill('120');
  await placement.getByRole('button', { name: 'Apply placement' }).click();
  await ready(page);
  await expect(page.getByTestId('cad-component')).not.toContainText('参照できません');
  const placed = await nativeArtifact(page);
  const doc = placed.draft.content as CadDocument;
  expect(doc.parts).toHaveLength(1);
  expect(doc.parts[0]!.source).toEqual({
    kind: 'version',
    artifactId: part.id,
    versionId: part.versions[0]!.versionId,
    contentHash: part.versions[0]!.contentHash,
  });
  expect(doc.solvedPoses[doc.components[1]!.id]!.translationMm).toEqual([120, 0, 0]);
  expect(placed.cadParts?.map((p) => p.contentHash)).toEqual([part.versions[0]!.contentHash]);
  // An assembly exports STEP AP242 only (R2b-5): the plate once and the root placing it twice.
  await (await tool(page, 'Export STEP, STL or GLB')).click();
  const exporting = page.getByRole('dialog', { name: 'Export 3D file' });
  await expect(exporting.getByLabel(/^STL/)).toBeDisabled();
  await expect(exporting.getByLabel(/^STEP \(AP242 assembly/)).toBeChecked();
  await exporting.getByRole('button', { name: 'Prepare file' }).click();
  const report = exporting.getByLabel('Export report');
  await expect(report.locator('dt:has-text("Products") + dd')).toHaveText('2');
  await expect(report.locator('dt:has-text("Instances") + dd')).toHaveText('2');
  await page.keyboard.press('Escape');

  // A placement typed but not applied is held by the input boundary: the save starts applying it
  // and refuses until it is in the content.
  await placement.getByLabel('Y (mm)').fill('30');
  // An unrelated edit keeps the entry pending.
  await (await tool(page, 'Add box')).click();
  await ready(page);
  await expect(placement.getByLabel('Y (mm)')).toHaveValue('30');
  // So does selecting another component and coming back.
  await components(page).filter({ hasText: 'Plate part 1' }).click();
  await expect(placement.getByLabel('Y (mm)')).toHaveValue('0');
  await components(page).filter({ hasText: 'Plate part 2' }).click();
  await expect(placement.getByLabel('Y (mm)')).toHaveValue('30');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'この版を保存', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('配置を適用しています');
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await ready(page);
  await save(page, 1);
  expect(
    ((await nativeArtifact(page)).versions[0]!.content as CadDocument).solvedPoses[
      doc.components[1]!.id
    ]!.translationMm,
  ).toEqual([120, 30, 0]);
  // A placement the document refuses (past the coordinate limit) is reported and the fields
  // return to the stored placement, as the Inspector does: nothing is left pending.
  await placement.getByLabel('X (mm)').fill('10000001');
  await placement.getByRole('button', { name: 'Apply placement' }).click();
  // #589: the refusal names the limit.
  await expect(page.getByText('±10,000,000 mm (10 km)')).toBeVisible();
  await expect(placement.getByLabel('X (mm)')).toHaveValue('120');
  expect(
    ((await nativeArtifact(page)).draft.content as CadDocument).solvedPoses[doc.components[1]!.id]!
      .translationMm,
  ).toEqual([120, 30, 0]);
  // Switching to another Artifact with a placement typed: the switch starts applying it and
  // stays on this Artifact until it is in the content.
  await placement.getByLabel('Z (mm)').fill('7');
  if (!(await page.getByRole('navigation', { name: 'Artifacts', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Artifacts', exact: true })
    .getByRole('button')
    .filter({ hasText: 'Plate part' })
    .click();
  await expect(page.getByRole('alert').first()).toContainText('配置を適用しています');
  await expect(page.getByLabel('Artifact name')).toHaveValue('Rig');
  await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await ready(page);
  expect(
    ((await nativeArtifact(page)).draft.content as CadDocument).solvedPoses[doc.components[1]!.id]!
      .translationMm,
  ).toEqual([120, 30, 7]);
  // Back to the saved version's content.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  // The undone placement is in the content and stored before the reload.
  await expect(placement.getByLabel('Z (mm)')).toHaveValue('0');
  await expect(page.locator('.save-status')).toHaveText('Saved locally');
  await page.reload();
  await ready(page);
  await expect(components(page)).toHaveText(['Plate part 1', 'Plate part 2']);
  await expect(page.locator('.cad-part-state')).toHaveCount(0);
  const record = await nativeArtifact(page);
  expect(record.versions[0]!.content).toEqual(record.draft.content);
  // The native file carries the closure: the copy opens with the part's geometry.
  await importJson(page, 'rig-copy.json', { ...record, name: 'Rig copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Rig copy');
  await ready(page);
  await expect(components(page)).toHaveCount(2);
  await expect(page.locator('.cad-part-state')).toHaveCount(0);
  expect((await nativeArtifact(page)).cadParts).toEqual(record.cadParts);
  // Without its closure the file is refused and opens nothing.
  await importJson(page, 'rig-broken.json', { ...record, name: 'Rig broken', cadParts: [] });
  await expect(page.getByRole('alert')).toContainText('CAD part missing');
  await page.screenshot({ path: test.info().outputPath('cad-r2b-assembly.png') });
});

test('placing parts: beside the model, at an expression that follows a parameter, and a mirrored copy (ST-86)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await page.getByLabel('Artifact name').fill('Wheel part');
  await page.getByLabel('Artifact name').press('Enter');
  await ready(page);
  await (await tool(page, 'Add plate')).click();
  await ready(page);
  await save(page, 1);

  // The assembly has its own plate (and its Width parameter).
  await create(page, 'cad');
  await page.getByLabel('Artifact name').fill('Car');
  await page.getByLabel('Artifact name').press('Enter');
  await ready(page);
  await (await tool(page, 'Add plate')).click();
  await ready(page);
  const content = async () => (await nativeArtifact(page)).draft.content as CadDocument;
  const own = (await content()).parameters.find((p) => p.name === 'Width')!;
  const insert = async (fill?: (dialog: Locator) => Promise<void>) => {
    await page.getByRole('button', { name: 'Insert part…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Insert part' });
    await dialog.getByLabel('Version of Wheel part').selectOption({ index: 1 });
    await expect(dialog.getByLabel('Position')).toHaveValue('beside');
    await fill?.(dialog);
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await ready(page);
  };
  // Beside the model: past its +X side, never inside it.
  await insert();
  let doc = await content();
  expect(doc.solvedPoses[doc.components[0]!.id]!.translationMm[0]).toBeGreaterThan(own.value!);
  // At typed values: X reads the parameter.
  await insert(async (dialog) => {
    await dialog.getByLabel('Position').selectOption('values');
    const group = dialog.getByRole('group', { name: 'Insert placement' });
    await group.getByLabel('X (mm)').fill('Width * 2');
    await group.getByLabel('Y (mm)').fill('Nope');
    await expect(dialog.getByRole('button', { name: 'Insert', exact: true })).toBeDisabled();
    await group.getByLabel('Y (mm)').fill('500');
  });
  doc = await content();
  const second = doc.components[1]!.id;
  expect(doc.solvedPoses[second]!.translationMm).toEqual([own.value! * 2, 500, 0]);
  const placement = page.getByRole('form', { name: 'Placement' });
  await expect(placement.getByLabel('X (mm)')).toHaveValue('Width * 2');
  // A mirrored copy across XZ: Y negated, half a turn about Z, one edit.
  await page.getByRole('button', { name: 'Mirror copy', exact: true }).click();
  await ready(page);
  await expect(components(page)).toHaveText(['Wheel part 1', 'Wheel part 2', 'Wheel part 3']);
  doc = await content();
  const third = doc.components[2]!.id;
  expect(doc.solvedPoses[third]!.translationMm).toEqual([own.value! * 2, -500, 0]);
  expect(doc.solvedPoses[third]!.rotation.map((v) => Math.abs(Math.round(v)))).toEqual([
    0, 0, 1, 0,
  ]);
  // Both follow the parameter.
  await page
    .getByRole('list', { name: 'Parameters' })
    .getByRole('button', { name: /Width/ })
    .click();
  const value = page.locator('.cad-inspector').getByLabel(/^Value/);
  await value.fill('150');
  await value.press('Enter');
  await ready(page);
  doc = await content();
  expect(doc.solvedPoses[second]!.translationMm[0]).toBe(300);
  expect(doc.solvedPoses[third]!.translationMm[0]).toBe(300);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(components(page)).toHaveCount(2);
});

test('R2b-5 STEP assembly import: an empty document becomes the assembly, saved, reloaded and round-tripped (CAD49, CAD50)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await page.getByLabel('Artifact name').fill('Imported rig');
  await page.getByLabel('Artifact name').press('Enter');
  await ready(page);
  // Two usages of one solid product (AP214): one imported part, two fixed components.
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(corpus('reject-assembly.step'));
  const dialog = page.getByRole('dialog', { name: 'Import STEP assembly' });
  const report = dialog.getByLabel('Import report');
  await expect(report.locator('dt:has-text("Format") + dd')).toContainText('AP214');
  await expect(report.locator('dt:has-text("Parts") + dd')).toHaveText('1');
  await expect(report.locator('dt:has-text("Components") + dd')).toHaveText('2');
  await expect(report.locator('dt:has-text("Depth") + dd')).toHaveText('1');
  // Cancel stores nothing.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await nativeArtifact(page)).cadResources ?? []).toEqual([]);
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(corpus('reject-assembly.step'));
  await dialog.getByRole('button', { name: 'Import assembly', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await ready(page);
  await expect(components(page)).toHaveCount(2);
  await expect(page.locator('.cad-part-state')).toHaveCount(0);
  const record = await nativeArtifact(page);
  const doc = record.draft.content as CadDocument;
  expect(doc.features).toEqual([]);
  expect(doc.parts).toHaveLength(1);
  expect(doc.parts[0]!.source).toMatchObject({ kind: 'imported', stepProduct: { name: 'SOLID' } });
  expect(record.cadParts?.map((p) => p.contentHash)).toEqual([doc.parts[0]!.source.contentHash]);
  const resources = record.cadResources as { kind: string; bytes: string }[];
  expect(resources.map((r) => r.kind).sort()).toEqual(['normalized-brep', 'source-step']);
  // The original file is kept unchanged.
  const original = await readFile(corpus('reject-assembly.step'));
  const kept = resources.find((r) => r.kind === 'source-step')!;
  expect(Buffer.from(kept.bytes, 'base64').equals(original)).toBe(true);
  // A second assembly import is refused: the document is no longer empty.
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(corpus('reject-assembly.step'));
  await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText('空の文書にだけ');
  // It exports again as AP242: the imported part once and the root placing it twice.
  await (await tool(page, 'Export STEP, STL or GLB')).click();
  const exporting = page.getByRole('dialog', { name: 'Export 3D file' });
  await exporting.getByRole('button', { name: 'Prepare file' }).click();
  const exported = exporting.getByLabel('Export report');
  await expect(exported.locator('dt:has-text("Products") + dd')).toHaveText('2');
  await expect(exported.locator('dt:has-text("Instances") + dd')).toHaveText('2');
  const download = page.waitForEvent('download');
  await exporting.getByRole('button', { name: 'Save STEP' }).click();
  const ap242 = await readFile((await (await download).path())!);
  await save(page, 1);
  await page.reload();
  await ready(page);
  await expect(components(page)).toHaveCount(2);
  await expect(page.locator('.cad-part-state')).toHaveCount(0);
  // The native file carries the imported part and its assets: the copy opens with its geometry.
  const saved = await nativeArtifact(page);
  await importJson(page, 'imported-rig-copy.json', { ...saved, name: 'Imported rig copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Imported rig copy');
  await ready(page);
  await expect(components(page)).toHaveCount(2);
  await expect(page.locator('.cad-part-state')).toHaveCount(0);
  // The AP242 file this editor wrote imports again into a new empty document.
  await create(page, 'cad');
  await ready(page);
  await page
    .getByLabel('STEP file', { exact: true })
    .setInputFiles({ name: 'rig.step', mimeType: 'model/step', buffer: ap242 });
  await expect(report.locator('dt:has-text("Format") + dd')).toContainText('AP242');
  await expect(report.locator('dt:has-text("Components") + dd')).toHaveText('2');
  await dialog.getByRole('button', { name: 'Import assembly', exact: true }).click();
  await ready(page);
  await expect(components(page)).toHaveCount(2);
  await expect(page.locator('.cad-part-state')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('cad-r2b-step-import.png') });
});

/** PMI-5b: pixels in the highlight's orange (well redder than blue), over grey parts. */
async function warmPixels(page: Page) {
  const png = await page.locator('.cad-viewport canvas').first().screenshot();
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${data}`)).blob(),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext('2d')!;
    g.drawImage(bitmap, 0, 0);
    const p = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let n = 0;
    for (let i = 0; i < p.length; i += 4) if (p[i]! - p[i + 2]! > 70 && p[i]! - p[i + 1]! > 30) n++;
    return n;
  }, png.toString('base64'));
}
// PMI-5b (docs/cad/pmi.md, 一覧・表示, 検証と失効): F46's items of particular instances are listed
// on the assembly, apart from each part's own PMI; choosing one highlights its faces on the
// instance it names. Deleting that component makes its items stale (Undo brings them back); the
// list is the same after a save, a reload and the native file.
test('PMI-5b assembly PMI: instances and parts, highlight, stale, saved and reloaded (ST-215, CAD86, TS-1440)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await page.getByLabel('Artifact name').fill('Path rig');
  await page.getByLabel('Artifact name').press('Enter');
  await ready(page);
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(f43('pmi-path.step'));
  // F43's distance across two parts names no path: kept only with consent, as before.
  await page
    .getByRole('dialog', { name: 'STEP with PMI' })
    .getByRole('button', { name: 'Import with the PMI that is kept', exact: true })
    .click();
  const importing = page.getByRole('dialog', { name: 'Import STEP assembly' });
  await importing.getByRole('button', { name: 'Import assembly', exact: true }).click();
  await expect(importing).toHaveCount(0);
  await ready(page);
  await expect(components(page)).toHaveCount(3);
  const own = page.getByTestId('cad-instance-pmi');
  await expect(own).toContainText('Of particular instances (7)');
  const flatness = own.getByRole('button', { name: /Flatness 0\.04 mm/ });
  await expect(flatness).toBeEnabled();
  const plate2 = await components(page).nth(1).innerText();
  await expect(flatness).toContainText(`on ${plate2.split('\n')[0]}`);
  await expect.poll(() => warmPixels(page)).toBeLessThan(5);
  await flatness.click();
  await expect(flatness).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => warmPixels(page)).toBeGreaterThan(30);
  await page.screenshot({ path: test.info().outputPath('cad-pmi5b-instance.png') });
  await flatness.click();
  await expect.poll(() => warmPixels(page)).toBeLessThan(5);

  // The first plate's own PMI is the part's: the same on each plate, shown on the one chosen.
  await components(page).nth(0).click();
  const common = page.getByTestId('cad-part-pmi');
  await expect(common).toContainText('Every instance of');
  const datum = common.getByRole('button', { name: /^Datum A/ });
  await datum.click();
  await expect(datum).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => warmPixels(page)).toBeGreaterThan(30);
  await page.screenshot({ path: test.info().outputPath('cad-pmi5b-part.png') });

  // Removing the second plate makes the items on it stale, never the document invalid.
  await components(page).nth(1).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await ready(page);
  await expect(components(page)).toHaveCount(2);
  await expect(flatness).toBeDisabled();
  await expect(flatness).toContainText('stale (a component it names was deleted)');
  await expect(own).toContainText('are stale');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(components(page)).toHaveCount(3);
  await expect(flatness).toBeEnabled();
  await expect(own).not.toContainText('are stale');

  // Saved and reloaded, and the native file opened as a copy: the same items, current.
  await save(page, 1);
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('cad-instance-pmi')).toContainText('Of particular instances (7)');
  await expect(
    page.getByTestId('cad-instance-pmi').getByRole('button', { name: /Flatness 0\.04 mm/ }),
  ).toBeEnabled();
  const saved = await nativeArtifact(page);
  const resources = saved.cadResources as { kind: string }[];
  expect(resources.filter((r) => r.kind === 'assembly-pmi')).toHaveLength(1);
  await importJson(page, 'path-rig-copy.json', { ...saved, name: 'Path rig copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Path rig copy');
  await ready(page);
  await expect(page.getByTestId('cad-instance-pmi')).toContainText('Of particular instances (7)');
  await page
    .getByTestId('cad-instance-pmi')
    .getByRole('button', { name: /Flatness 0\.04 mm/ })
    .click();
  await expect.poll(() => warmPixels(page)).toBeGreaterThan(30);
});

test('R2b-2b assembly: a newer saved version of a part is shown, previewed and taken as one edit (CAD48)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  const switchTo = async (name: string) => {
    const nav = page.getByRole('navigation', { name: 'Artifacts', exact: true });
    if (!(await nav.isVisible()))
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await nav.getByRole('button').filter({ hasText: name }).click();
    await expect(page.getByLabel('Artifact name')).toHaveValue(name);
    // The library covers the tools while it is open.
    if (await nav.isVisible())
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await expect(nav).toBeHidden();
    await ready(page);
  };
  await create(page, 'cad');
  await page.getByLabel('Artifact name').fill('Plate part');
  await page.getByLabel('Artifact name').press('Enter');
  await ready(page);
  await (await tool(page, 'Add plate')).click();
  await ready(page);
  await save(page, 1);
  await create(page, 'cad');
  await page.getByLabel('Artifact name').fill('Rig');
  await page.getByLabel('Artifact name').press('Enter');
  await ready(page);
  await page.getByRole('button', { name: 'Insert part…', exact: true }).click();
  const inserting = page.getByRole('dialog', { name: 'Insert part' });
  await inserting.getByLabel('Version of Plate part').selectOption({ index: 1 });
  await inserting.getByRole('button', { name: 'Insert', exact: true }).click();
  await ready(page);
  await expect(page.locator('.cad-part-newer')).toHaveCount(0);
  // The part gets a second saved version.
  await switchTo('Plate part');
  await (await tool(page, 'Add box')).click();
  await ready(page);
  await save(page, 2);
  const part = await nativeArtifact(page);
  await switchTo('Rig');
  const before = await nativeArtifact(page);
  // Shown, never taken in by itself.
  await expect(components(page).first()).toContainText('新しい版あり');
  expect(partVersionId((before.draft.content as CadDocument).parts[0]!.source)).toBe(
    part.versions[0]!.versionId,
  );
  await components(page).first().click();
  await page.getByTestId('cad-component').getByRole('button', { name: 'Change version…' }).click();
  const dialog = page.getByTestId('cad-update-parts');
  await expect(dialog.getByLabel('New version of Plate part')).toHaveValue(
    part.versions[1]!.versionId,
  );
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByRole('table', { name: 'Changes' })).toContainText('→ v2');
  await expect(dialog.getByTestId('cad-update-moved')).toContainText(
    '配置の変わる部品はありません',
  );
  await dialog.getByRole('button', { name: 'Apply update' }).click();
  await ready(page);
  await expect(page.locator('.cad-part-newer')).toHaveCount(0);
  const after = await nativeArtifact(page);
  expect((after.draft.content as CadDocument).parts[0]!.source).toEqual({
    kind: 'version',
    artifactId: part.id,
    versionId: part.versions[1]!.versionId,
    contentHash: part.versions[1]!.contentHash,
  });
  // The new version was kept before the edit named it; the closure stays exact.
  expect(after.cadParts?.map((p) => p.contentHash)).toContain(part.versions[1]!.contentHash);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await expect(components(page).first()).toContainText('新しい版あり');
});

/** The r2b fixture on this kernel, as a native record with its closure. */
async function r2bRecord(page: Page) {
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const f = r2bParts({ id, buildHash });
  return {
    ...empty,
    name: 'R2b rig',
    draft: { ...empty.draft, content: f.assembly },
    cadParts: [...f.closure].map(([contentHash, content]) => ({ contentHash, content })),
  };
}
test('R2b-1 assembly read only and narrow: components listed, nothing inserted or moved (CAD49)', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await importJson(page, 'r2b.json', await r2bRecord(page));
  await expect(page.getByLabel('Artifact name')).toHaveValue('R2b rig');
  await ready(page);
  if (test.info().project.name !== 'desktop') {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath('cad-r2b-narrow.png') });
    // The element list is a panel on narrow screens: it lists the components, inserting is off.
    await page.getByRole('button', { name: 'Toggle Elements', exact: true }).click();
    await expect(components(page)).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Insert part…', exact: true })).toBeDisabled();
    return;
  }
  await expect(components(page)).toHaveText(['c-plate-1', 'c-plate-2', 'c-shaft', 'c-pair']);
  await expect(page.locator('.cad-part-state')).toHaveCount(0);
  const more = page.getByRole('button', { name: 'More artifact actions', exact: true });
  await more.click();
  await page.getByLabel('Read only', { exact: true }).click();
  await more.click();
  await expect(page.getByRole('button', { name: 'Insert part…', exact: true })).toHaveCount(0);
  await components(page).nth(2).click();
  await expect(page.getByRole('form', { name: 'Placement' }).getByLabel('X (mm)')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
});

/**
 * #538: an equipment route 1,200 mm wide (a parameter) beside 1,600 mm equipment, and 4 columns
 * joined into one body named for the set.
 */
function routeModel() {
  const b = cadBuilder(fixtureKernel);
  b.parameter('Route width', 'length', 1200);
  b.box('Route', { size: ['{Route width}', 20000, 2500] }, { color: '#3b82f6', opacity: 0.4 });
  b.box('Equipment', { origin: [-200, 2000, 0], size: [1600, 2000, 1800] }, { color: '#dc2626' });
  const columns = [0, 1, 2, 3].map((i) =>
    b.box(`Column grid 1 ${i + 1}`, { origin: [4000, i * 5000, 0], size: [1000, 1000, 4500] }),
  );
  b.boolean(columns[0]!, columns.slice(1), 'union', 'Join columns');
  b.rename(columns[0]!, 'Columns (4)');
  return b.build().document;
}
test('compare a route with the equipment through edit, Undo, Redo, save and reload; a joined body counts its solids (#538)', async ({
  page,
}) => {
  const narrow = test.info().project.name !== 'desktop';
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'route.json', {
    ...empty,
    name: 'Equipment route',
    draft: { ...empty.draft, content: { ...routeModel(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Equipment route');
  await ready(page);
  const elements = async () => {
    if (narrow && !(await bodies(page).first().isVisible()))
      await page.getByRole('button', { name: 'Toggle Elements', exact: true }).click();
  };
  await elements();
  await expect(bodies(page)).toHaveCount(3);
  // The joined columns: one body, named for the set, that says it holds 4 solids.
  await expect(bodies(page).filter({ hasText: 'Columns (4)' })).toHaveText('Columns (4)4 solids');
  await expect(page.getByText('Bodies (3)', { exact: true })).toBeVisible();

  const compare = async (expected: string) => {
    await elements();
    await bodies(page).filter({ hasText: 'Route' }).click();
    const section = page
      .locator('.cad-inspector details')
      .filter({ has: page.getByText('Compare size', { exact: true }) });
    if (narrow && !(await section.isVisible()))
      await page.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
    if ((await section.getAttribute('open')) === null) await section.locator('summary').click();
    await section.getByLabel('With body').selectOption({ label: 'Equipment' });
    await expect(page.getByTestId('cad-compare-X')).toHaveText(expected);
    await expect(page.getByTestId('cad-compare-size')).toContainText('1,600');
  };
  await compare('400 smaller');
  await expect(page.locator('.cad-inspector')).toContainText('not per side');
  await page.screenshot({
    path: test.info().outputPath(`cad-538-compare-${narrow ? 'narrow' : 'desktop'}.png`),
  });

  // A standard view moves the camera only: the draft is unchanged.
  const before = (await nativeArtifact(page)).draft.content;
  if (!narrow) {
    await page.getByTestId('cad-standard-view').selectOption('plan');
    await page.screenshot({ path: test.info().outputPath('cad-538-plan.png') });
    await page.getByTestId('cad-standard-view').selectOption('front');
    expect((await nativeArtifact(page)).draft.content).toEqual(before);
  }

  // Widen the route to 2,000 mm: 400 mm to spare in total.
  await elements();
  await page
    .getByRole('list', { name: 'Parameters' })
    .getByRole('button', { name: /Route width/ })
    .click();
  const value = page.locator('.cad-inspector').getByLabel(/^Value/);
  if (narrow && !(await value.isVisible()))
    await page.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
  await value.fill('2000');
  await value.press('Enter');
  await ready(page);
  await compare('400 larger');
  const history = async (name: 'Undo' | 'Redo') => {
    if (narrow)
      await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await ready(page);
  };
  await history('Undo');
  await compare('400 smaller');
  await history('Redo');
  await compare('400 larger');
  if (narrow)
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await save(page, 1);
  await page.reload();
  await ready(page);
  await compare('400 larger');
  const record = await nativeArtifact(page);
  const content = record.versions[0].content as CadDocument;
  expect(content.parameters.find((p) => p.name === 'Route width')).toMatchObject({ value: 2000 });
  expect(content.bodies.find((b) => b.state === 'active' && b.name === 'Columns (4)')?.id).toBe(
    'column-grid-1-1',
  );
  if (narrow) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

// TS-1548, ST-265 (CR4e): a spot weld row between a hat's flange and its closure plate: its
// points listed, its pitch and end distance changed, a pitch out of range refused, removed and
// undone.
test('list a spot weld row’s points, change its pitch, remove it and undo (CR4e)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'welds.json', {
    ...empty,
    name: 'Welds',
    draft: { ...empty.draft, content: { ...f49SpotWelds(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Welds');
  await ready(page);
  await expect(bodies(page)).toHaveCount(2);
  const row = page.getByTestId('cad-weld-welds-l');
  await expect(row.getByTestId('cad-weld-points')).toContainText(
    '5 points along 200 mm, 0 too far',
  );
  const welds = async () =>
    ((await nativeArtifact(page)).draft.content as CadDocument).spotWelds ?? [];
  await row.getByLabel('Pitch (mm)').fill('60');
  await row.getByLabel('From the ends (mm)').fill('30');
  await row.getByRole('button', { name: 'Apply' }).click();
  await ready(page);
  await expect
    .poll(async () => (await welds())[0])
    .toMatchObject({ pitchMm: 60, endDistanceMm: 30 });
  await expect(row.getByTestId('cad-weld-points')).toContainText('3 points along 200 mm');
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Below 10 mm: refused, the row unchanged.
  await row.getByLabel('Pitch (mm)').fill('5');
  await row.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('alert')).toContainText('ピッチは10〜200 mm');
  await ready(page);
  expect((await welds())[0]).toMatchObject({ pitchMm: 60 });
  await row.getByRole('button', { name: 'Remove' }).click();
  await ready(page);
  await expect.poll(async () => (await welds()).length).toBe(0);
  await expect(page.getByTestId('cad-weld-welds-l')).toHaveCount(0);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await ready(page);
  }
  await expect
    .poll(async () => (await welds())[0])
    .toMatchObject({ pitchMm: 40, endDistanceMm: 10 });
  await expect(page.getByTestId('cad-weld-points')).toContainText('5 points');
});

// TS-1552, ST-266 (CR4g): the simplified BIW (F29, 42 bodies): the side outer's roof flange made
// wider in the history, a sill row's pitch changed in the spot weld list, undone and redone,
// saved and reloaded. Not a performance measurement.
test('the simplified BIW follows its roof flange width and a weld pitch, undo, redo, save and reload (CR4g)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(900_000);
  const settled = () => expect(state(page)).toHaveText('Shape up to date', { timeout: 300_000 });
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'biw.json', {
    ...empty,
    name: 'BIW',
    draft: { ...empty.draft, content: { ...f29Biw(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('BIW');
  await settled();
  await expect(bodies(page)).toHaveCount(42);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const doc = async () => (await nativeArtifact(page)).draft.content as CadDocument;
  const width = async () =>
    (
      (await doc()).features.find((f) => f.id === 'side-roof-flange')?.args as {
        width: { literalMm: number };
      }
    ).width.literalMm;
  const pitch = async () => (await doc()).spotWelds?.find((w) => w.id === 'weld-l-sill-l')?.pitchMm;
  const roof = page.getByTestId('cad-weld-weld-roof-l').getByTestId('cad-weld-points');
  const sill = page.getByTestId('cad-weld-weld-l-sill-l');
  await expect(roof).toContainText(/28 points along 1,?100 mm, 0 too far/);
  await expect(sill.getByTestId('cad-weld-points')).toContainText(/50 points along 2,?000 mm/);
  // The roof flange: 80 → 40 mm, ending short of the roof's edge strip (every point too far),
  // then 100 mm.
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: /^Side outer roof flange/ })
    .click();
  const field = page.locator('.cad-inspector').getByLabel('Width (mm)');
  await field.fill('40');
  await field.press('Enter');
  await settled();
  await expect.poll(width).toBe(40);
  await expect(roof).toContainText('28 too far');
  await field.fill('100');
  await field.press('Enter');
  await settled();
  await expect.poll(width).toBe(100);
  await expect(roof).toContainText('0 too far');
  // The left sill's lower row: 40 → 50 mm.
  await sill.getByLabel('Pitch (mm)').fill('50');
  await sill.getByRole('button', { name: 'Apply' }).click();
  await settled();
  await expect.poll(pitch).toBe(50);
  await expect(sill.getByTestId('cad-weld-points')).toContainText(/40 points along 2,?000 mm/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled();
  await expect.poll(pitch).toBe(40);
  await expect(sill.getByTestId('cad-weld-points')).toContainText('50 points');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled();
  await expect.poll(width).toBe(40);
  await expect(roof).toContainText('28 too far');
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await settled();
  }
  await expect.poll(width).toBe(100);
  await expect.poll(pitch).toBe(50);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'History (1)' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await settled();
  await expect(bodies(page)).toHaveCount(42);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const record = await nativeArtifact(page);
  expect(record.versions[0].content).toEqual(record.draft.content);
  expect(await width()).toBe(100);
  expect(await pitch()).toBe(50);
  await expect(roof).toContainText('0 too far');
  await expect(sill.getByTestId('cad-weld-points')).toContainText(/40 points along 2,?000 mm/);
});

// TS-1593, ST-281 (CR6a): a body's look given a lamp's light (a preset) and a lens's transmission
// (by hand) in the inspector, undone and redone, saved and reloaded.
test('give a body a lamp’s light and a lens’s transmission, undo, redo, save and reload (CR6a)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add box')).click();
  await ready(page);
  await bodies(page).last().click();
  const inspector = page.locator('.cad-inspector');
  const look = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    return doc.bodies[doc.bodies.length - 1]!.appearance;
  };
  await inspector.getByLabel('Material').selectOption('lamp-red');
  await ready(page);
  await expect
    .poll(look)
    .toMatchObject({ material: 'lamp-red', emission: { color: '#ff2a1f', strength: 6 } });
  await expect(inspector.getByLabel('Emission strength')).toHaveValue('6');
  // A value by hand: the look is no longer the preset's.
  const transmission = inspector.getByLabel('Transmission');
  await transmission.fill('0.8');
  await transmission.press('Enter');
  await ready(page);
  await expect.poll(look).toMatchObject({ transmission: 0.8, emission: { strength: 6 } });
  expect((await look()).material).toBeUndefined();
  const ior = inspector.getByLabel('Index of refraction');
  // Above 2.5: refused, the look unchanged.
  await ior.fill('3');
  await ior.press('Enter');
  await expect(inspector.getByRole('alert')).toContainText('Index of refraction');
  await ior.press('Escape');
  await expect(ior).toHaveValue('1.5');
  expect((await look()).ior).toBeUndefined();
  await ior.fill('1.49');
  await ior.press('Enter');
  await ready(page);
  await expect.poll(async () => (await look()).ior).toBe(1.49);
  // Strength 0 is no light.
  const strength = inspector.getByLabel('Emission strength');
  await strength.fill('0');
  await strength.press('Enter');
  await ready(page);
  await expect.poll(async () => (await look()).emission).toBeUndefined();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect.poll(async () => (await look()).emission?.strength).toBe(6);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await ready(page);
  await expect.poll(async () => (await look()).emission).toBeUndefined();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await save(page, 1);
  await page.reload();
  await ready(page);
  await bodies(page).last().click();
  await expect(page.locator('.cad-inspector').getByLabel('Transmission')).toHaveValue('0.8');
  await expect(page.locator('.cad-inspector').getByLabel('Emission strength')).toHaveValue('6');
  expect((await nativeArtifact(page)).versions[0]!.content).toMatchObject({
    bodies: expect.arrayContaining([
      expect.objectContaining({
        appearance: expect.objectContaining({ transmission: 0.8, ior: 1.49 }),
      }),
    ]),
  });
  await page.screenshot({ path: test.info().outputPath('cr6a-light.png') });
});

// TS-1595, ST-282 (CR6b): a box's wall thickness and draft angle shown on the display mesh,
// with the range, the pull direction and the mould halves changed. Display only: the content
// is unchanged.
test('check a part’s wall thickness and draft angle on the display mesh (CR6b)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add box')).click();
  await ready(page);
  const before = JSON.stringify((await nativeArtifact(page)).draft.content);
  const shading = page.getByTestId('cad-shading');
  await shading.selectOption('thickness');
  const thickness = page.getByTestId('cad-thickness');
  await expect(thickness).toContainText('display mesh');
  const results = page.getByTestId('cad-thickness-results');
  await expect(results).toContainText(/min [\d.]+ mm at \(/);
  console.log('CR6b thickness', await results.innerText());
  // A thinnest wall over the thickest is refused.
  await page.getByLabel('Thinnest wall (mm)').fill('20');
  await page.getByLabel('Thinnest wall (mm)').press('Enter');
  await expect(thickness.getByRole('alert')).toHaveCount(1);
  await page.getByLabel('Thinnest wall (mm)').press('Escape');
  await page.getByLabel('Thickest wall (mm)').fill('25');
  await page.getByLabel('Thickest wall (mm)').press('Enter');
  await page.getByLabel('Thinnest wall (mm)').fill('20');
  await page.getByLabel('Thinnest wall (mm)').press('Enter');
  await expect(thickness).toContainText('under 20 mm');
  await expect(thickness).toContainText('over 25 mm');
  await page.screenshot({ path: test.info().outputPath('cr6b-thickness.png') });
  await shading.selectOption('draft');
  const draft = page.getByTestId('cad-draft-results');
  await expect(draft).toContainText(/under 1° [\d.]+%/);
  console.log('CR6b draft', await draft.innerText());
  await page
    .getByLabel('Two mould halves (faces against the pull release into the other half)')
    .uncheck();
  await expect(draft).toContainText(/undercut [\d.]+%/);
  console.log('CR6b draft one half', await draft.innerText());
  await page.getByLabel('Pull direction').selectOption('+x');
  console.log('CR6b draft +x', await draft.innerText());
  await page.screenshot({ path: test.info().outputPath('cr6b-draft.png') });
  await shading.selectOption('shaded');
  await expect(page.getByTestId('cad-draft-check')).toHaveCount(0);
  expect(JSON.stringify((await nativeArtifact(page)).draft.content)).toBe(before);
});

// TS-1597, ST-283 (CR6c): a ray diagram over a box made a mirror, a clear lens and a matte
// plastic in turn: one ray reflected, refracted in and out, and stopped. Display only.
test('trace a ray diagram through a mirror, a lens and an opaque body (CR6c)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add box')).click();
  await ready(page);
  const before = JSON.stringify((await nativeArtifact(page)).draft.content);
  await page.getByTestId('cad-rays-shown').check();
  const panel = page.getByTestId('cad-rays');
  await expect(panel).toContainText('no light distribution');
  const set = async (label: string, value: string) => {
    await panel.getByLabel(label).fill(value);
    await panel.getByLabel(label).press('Enter');
  };
  await set('Focus X (mm)', '-200');
  await set('Focus Y (mm)', '2');
  await set('Focus Z (mm)', '2');
  await panel.getByLabel('Direction').selectOption('+x');
  await set('Spread (°)', '0');
  await set('Rays', '1');
  const result = page.getByTestId('cad-rays-result');
  // A plain box stops the ray.
  await expect(result).toContainText('1 rays: 0 leave the model (orange), 1 stopped');
  await bodies(page).last().click();
  const material = page.locator('.cad-inspector').getByLabel('Material');
  await material.selectOption('chrome');
  await ready(page);
  await expect(result).toContainText('1 leave the model');
  await expect(result).toContainText('Hits: 1 reflections, 0 refractions');
  await expect(result).toContainText('1 mirror');
  await material.selectOption('lamp-lens');
  await ready(page);
  await expect(result).toContainText('Hits: 0 reflections, 2 refractions');
  await expect(result).toContainText('1 transmitting');
  await set('Rays', '9');
  await set('Spread (°)', '10');
  await page.screenshot({ path: test.info().outputPath('cr6c-rays.png') });
  // The fan plane cannot be normal to the direction.
  await expect(panel.getByLabel('Fan plane normal').locator('option[value="x"]')).toHaveAttribute(
    'disabled',
    '',
  );
  await page.getByTestId('cad-rays-shown').uncheck();
  await expect(panel).toHaveCount(0);
  const after = (await nativeArtifact(page)).draft.content as CadDocument;
  // Only the look changed: the rays are not part of the content.
  expect(JSON.stringify({ ...after, bodies: [] })).toBe(
    JSON.stringify({ ...JSON.parse(before), bodies: [] }),
  );
});

// TS-1599, ST-284 (CR6d): a seat cushion's stitch groove cut from the Groove section (out of
// range refused first), its radius changed in the inspector, both undone; a lens's 3 × 2 grid of
// cuts, its rows raised to 3 in the pattern's inspector.
test('cut a groove along a line, and edit a grid pattern’s rows (CR6d)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'cushion.json', {
    ...empty,
    name: 'Cushion',
    draft: {
      ...empty.draft,
      content: { ...cr6dGroove('open', 1, { groove: false }), kernelProfile },
    },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Cushion');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const grooves = async () =>
    ((await nativeArtifact(page)).draft.content as CadDocument).features.filter(
      (f) => f.type === 'groove',
    );
  await bodies(page).first().click();
  await page.locator('summary', { hasText: /^Groove$/ }).click();
  await page.getByTestId('cad-groove-sketch').selectOption('stitch');
  const r = page.getByLabel('Groove R (mm)');
  await r.fill('20');
  await r.press('Enter');
  await expect(page.getByRole('button', { name: 'Cut the groove' })).toBeDisabled();
  await r.fill('1');
  await r.press('Enter');
  await page.getByRole('button', { name: 'Cut the groove' }).click();
  await ready(page);
  await expect.poll(async () => (await grooves()).length).toBe(1);
  expect((await grooves())[0]).toMatchObject({
    args: { tool: { sketchId: 'stitch', elements: ['s0'] }, radius: { literalMm: 1 } },
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: /^Groove groove$/ })
    .click();
  await expect(page.getByTestId('cad-groove-along')).toContainText('Stitch line (1 elements');
  const radius = page.locator('.cad-inspector').getByLabel('Radius (mm)');
  await radius.fill('2');
  await radius.press('Enter');
  await ready(page);
  await expect
    .poll(async () => (await grooves())[0]?.args)
    .toMatchObject({ radius: { literalMm: 2 } });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect
    .poll(async () => (await grooves())[0]?.args)
    .toMatchObject({ radius: { literalMm: 1 } });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect.poll(async () => (await grooves()).length).toBe(0);

  // The lens: rows of the pattern's row.
  const lens = await nativeArtifact(page);
  await importJson(page, 'lens.json', {
    ...lens,
    name: 'Lens',
    draft: { ...lens.draft, content: { ...cr6dGroove('grid'), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Lens');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: 'pattern cut pattern', exact: true })
    .click();
  await expect(page.getByTestId('cad-pattern-rows')).toContainText('In rows along (0, 1, 0)');
  const rows = page.locator('.cad-inspector').getByLabel('Rows');
  await rows.fill('3');
  await rows.press('Enter');
  await ready(page);
  await expect
    .poll(async () => {
      const doc = (await nativeArtifact(page)).draft.content as CadDocument;
      const f = doc.features.find((x) => x.id === 'cuts');
      return f?.type === 'pattern' && f.args.layout.type === 'linear'
        ? f.args.layout.rows?.count
        : undefined;
    })
    .toEqual({ literal: 3 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

// TS-1801, ST-285 (CR6e): the headlamp sample (F57) opened in the CAD screen: its five bodies,
// the housing's wall and draft checks, a ray fan from the bulb reflected by the reflector and
// refracted by the lenses, and the lens thickness changed from its parameter and undone; the
// tail lamp (F58) opened with its red lenses lit.
test('open the headlamp and tail lamp samples, check them and change the lens (CR6e)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'headlamp.json', {
    ...empty,
    name: 'Headlamp',
    draft: { ...empty.draft, content: { ...lampFixture('headlamp'), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Headlamp');
  await ready(page);
  await expect(bodies(page)).toHaveCount(5);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const before = JSON.stringify((await nativeArtifact(page)).draft.content);
  await page.screenshot({ path: test.info().outputPath('cr6e-headlamp.png') });

  // The housing's wall: 2.5 mm at its thinnest.
  const shading = page.getByTestId('cad-shading');
  await shading.selectOption('thickness');
  const thickness = page.getByTestId('cad-thickness-results');
  await expect(thickness).toContainText(/Housing: min 2\.5\d* mm/);
  console.log('CR6e thickness', await thickness.innerText());
  await page.screenshot({ path: test.info().outputPath('cr6e-thickness.png') });
  await shading.selectOption('draft');
  await page.getByLabel('Pull direction').selectOption('+x');
  const draft = page.getByTestId('cad-draft-results');
  await expect(draft).toContainText('Housing');
  console.log('CR6e draft', await draft.innerText());
  await page.screenshot({ path: test.info().outputPath('cr6e-draft.png') });
  await shading.selectOption('shaded');

  // Rays from the bulb at the focus: the reflector sends them forward through both lenses.
  await page.getByTestId('cad-rays-shown').check();
  const panel = page.getByTestId('cad-rays');
  const set = async (label: string, value: string) => {
    await panel.getByLabel(label).fill(value);
    await panel.getByLabel(label).press('Enter');
  };
  await set('Focus X (mm)', String(lampSizes.headlamp.focusX));
  await set('Focus Y (mm)', '0');
  await set('Focus Z (mm)', '0');
  await panel.getByLabel('Direction').selectOption('-x');
  await set('Spread (°)', '120');
  await set('Rays', '15');
  await set('Bounces', '8');
  const result = page.getByTestId('cad-rays-result');
  await expect(result).toContainText(/Hits: [1-9]\d* reflections, [1-9]\d* refractions/);
  await expect(result).toContainText('1 mirror');
  console.log('CR6e rays', await result.innerText());
  await page.screenshot({ path: test.info().outputPath('cr6e-rays.png') });
  await page.getByTestId('cad-rays-shown').uncheck();
  expect(JSON.stringify((await nativeArtifact(page)).draft.content)).toBe(before);

  // The outer lens's thickness from its parameter, and undone.
  const params = page.getByRole('list', { name: 'Parameters' });
  await params.getByRole('button', { name: /^Lens thickness/ }).click();
  const field = page.locator('.cad-inspector').getByLabel(/^Value/);
  await field.fill('4');
  await field.press('Enter');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(params).toContainText(/Lens thickness\s*4 mm/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(params).toContainText(/Lens thickness\s*3 mm/);

  // The tail lamp: its inner and outer lenses lit red.
  const lamp = await nativeArtifact(page);
  await importJson(page, 'tail-lamp.json', {
    ...lamp,
    name: 'Tail lamp',
    draft: { ...lamp.draft, content: { ...lampFixture('tail'), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Tail lamp');
  await ready(page);
  await expect(bodies(page)).toHaveCount(5);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const tail = (await nativeArtifact(page)).draft.content as CadDocument;
  expect(
    tail.bodies.filter((b) => b.appearance.material === 'lamp-red').map((b) => b.name),
  ).toEqual(['Inner lens', 'Outer lens']);
  await page.screenshot({ path: test.info().outputPath('cr6e-tail.png') });
});

// TS-1804, ST-286 (CR6f): the seat assembly (F59) opened with its parts' closure: five parts on
// the rails, the slide moved 120 mm and the back reclined 25° from the joint values, a slide
// past its range refused, and both undone.
test('open the seat assembly, slide it and recline its back (CR6f)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const seat = f59Seat({ id, buildHash });
  await importJson(page, 'seat.json', {
    ...empty,
    name: 'Seat',
    draft: { ...empty.draft, content: seat.assembly },
    cadParts: [...seat.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Seat');
  await ready(page);
  await expect(components(page)).toHaveCount(5);
  await expect(bodies(page)).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('cr6f-seat.png') });
  // The ray diagram does not trace placed components: refused instead of rays through them.
  await page.getByTestId('cad-rays-shown').check();
  await expect(page.getByTestId('cad-rays').getByRole('alert')).toContainText(
    "traces only this document's bodies",
  );
  await page.getByTestId('cad-rays-shown').uncheck();
  const poses = async () => ((await nativeArtifact(page)).draft.content as CadDocument).solvedPoses;
  const joints = page.getByRole('list', { name: 'Joints' });
  const values = page.getByRole('form', { name: 'Joint values' });
  // Slide 120 mm forward: the frame, pan and cushion move together.
  await joints.getByRole('button', { name: /^Seat slide/ }).click();
  await values.getByLabel('Distance (mm)').fill('120');
  await values.getByRole('button', { name: 'Apply values' }).click();
  await ready(page);
  await expect
    .poll(async () => (await poses())['c-cushion']?.translationMm.map((v) => Math.round(v)))
    .toEqual([120, 0, 0]);
  // Past the range (0–240 mm) is refused.
  await values.getByLabel('Distance (mm)').fill('300');
  await values.getByRole('button', { name: 'Apply values' }).click();
  await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText('範囲の外');
  await values.getByLabel('Distance (mm)').press('Escape');
  // Recline 25°: the back turns about its hinge, which moved with the frame.
  await joints.getByRole('button', { name: /^Recline/ }).click();
  await values.getByLabel('Angle (°)').fill('25');
  await values.getByRole('button', { name: 'Apply values' }).click();
  await ready(page);
  await expect
    .poll(async () => {
      const q = (await poses())['c-back']?.rotation;
      return q ? Math.round((2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI) : 0;
    })
    .toBe(25);
  expect((await poses())['c-back-shell']).toEqual((await poses())['c-back']);
  await page.screenshot({ path: test.info().outputPath('cr6f-reclined.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect
    .poll(async () => (await poses())['c-cushion']?.translationMm.map((v) => Math.round(v)))
    .toEqual([0, 0, 0]);
});

// TS-1806, ST-287 (CR6g): the wheel and tyre (F60), door mirror (F61) and steering wheel (F62)
// opened one after another in the CAD screen, each evaluated without an error.
test('open the wheel and tyre, door mirror and steering wheel samples (CR6g)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const samples = [
    { name: 'Wheel', file: 'wheel.json', make: f60Wheel, bodies: 2 },
    { name: 'Door mirror', file: 'mirror.json', make: f61Mirror, bodies: 3 },
    { name: 'Steering wheel', file: 'steering.json', make: f62Steering, bodies: 2 },
  ];
  for (const s of samples) {
    const record = await nativeArtifact(page);
    const { id, buildHash } = (record.draft.content as CadDocument).kernelProfile;
    await importJson(page, s.file, {
      ...record,
      name: s.name,
      draft: { ...record.draft, content: s.make({ id, buildHash }) },
    });
    await expect(page.getByLabel('Artifact name')).toHaveValue(s.name);
    await ready(page);
    await expect(bodies(page)).toHaveCount(s.bodies);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`cr6g-${s.file.replace('.json', '')}.png`),
    });
  }
});

// WM1a (docs/cad/watch-design.md): ST-440, TS-1882.
test('add an involute gear, change its teeth, add spoke windows, refuse an undercut', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add gear')).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: /^Gear spurGear$/ })
    .click();
  const inspector = page.locator('.cad-inspector');
  const teeth = inspector.getByLabel('Teeth', { exact: true });
  await teeth.fill('40');
  await teeth.press('Enter');
  await ready(page);
  await inspector.getByRole('button', { name: 'Add spokes', exact: true }).click();
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const gear = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    const f = doc.features.find((x) => x.type === 'spurGear');
    if (f?.type !== 'spurGear') throw new Error('no gear');
    return f.args;
  };
  expect((await gear()).teeth).toEqual({ literal: 40 });
  expect((await gear()).spokes?.count).toEqual({ literal: 5 });
  await page.screenshot({ path: test.info().outputPath('gear.png') });
  // Ten teeth undercut with a standard rack: refused with its code, the gear stays.
  await teeth.fill('10');
  await teeth.press('Enter');
  await expect(page.getByText(/gear-undercut/)).toBeVisible();
  expect((await gear()).teeth).toEqual({ literal: 40 });
  // A profile shift makes ten teeth possible.
  const shift = inspector.getByLabel('Profile shift', { exact: true });
  await shift.fill('0.5');
  await shift.press('Enter');
  await ready(page);
  // The windows no longer fit inside ten teeth: refused until the spokes go.
  await teeth.fill('10');
  await teeth.press('Enter');
  await expect(page.getByText(/gear-spokes-too-wide/)).toBeVisible();
  await inspector.getByRole('button', { name: 'Remove spokes', exact: true }).click();
  await ready(page);
  await teeth.fill('10');
  await teeth.press('Enter');
  await ready(page);
  expect((await gear()).teeth).toEqual({ literal: 10 });
  expect((await gear()).spokes).toBeUndefined();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

// WM1b (docs/cad/watch-design.md): ST-441, TS-1885.
test('switch a gear to the cycloidal watch tooth and back', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add gear')).click();
  await ready(page);
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: /^Gear spurGear$/ })
    .click();
  const inspector = page.locator('.cad-inspector');
  const gear = async () => {
    const doc = (await nativeArtifact(page)).draft.content as CadDocument;
    const f = doc.features.find((x) => x.type === 'spurGear');
    if (f?.type !== 'spurGear') throw new Error('no gear');
    return f.args;
  };
  await inspector.getByRole('combobox', { name: 'Tooth profile' }).selectOption('cycloidal');
  await ready(page);
  expect(await gear()).toMatchObject({
    profile: 'cycloidal',
    matingTeeth: { literal: 24 },
    toothThickness: 0.5,
    addendum: 1.3,
    dedendum: 1.6,
  });
  expect((await gear()).pressureAngle).toBeUndefined();
  await expect(inspector.getByLabel('Pressure angle (°)')).toHaveCount(0);
  // A wheel of 24 driving an 8-leaf pinion.
  const mating = inspector.getByLabel('Mating teeth', { exact: true });
  await mating.fill('8');
  await mating.press('Enter');
  await ready(page);
  expect((await gear()).matingTeeth).toEqual({ literal: 8 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('cycloidal.png') });
  // Too thick a tooth closes the gap at the root.
  const thickness = inspector.getByLabel('Tooth thickness', { exact: true });
  await thickness.fill('0.9');
  await thickness.press('Enter');
  await expect(page.getByText(/gear-tooth-thickness/)).toBeVisible();
  expect((await gear()).toothThickness).toBe(0.5);
  await inspector.getByRole('combobox', { name: 'Tooth profile' }).selectOption('involute');
  await ready(page);
  expect(await gear()).toMatchObject({ profile: 'involute', profileShift: 0, addendum: 1 });
  expect((await gear()).matingTeeth).toBeUndefined();
});

// TS-1887, ST-442 (WM2a): a revolute joint and the wheel that follows it at −3 × set to turn
// continuously in the joints panel, driven 10¼ turns: the values keep the turns, the follower
// lies where its fractional turn puts it, turning it back to one turn is refused, and undone.
test('turn a wheel ten turns with continuous joints (WM2a)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(180_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const r2b = r2bJoints({ id, buildHash });
  const doc = structuredClone(r2b.assembly);
  const driver = doc.joints.find((j) => j.id === 'j-turn')!;
  driver.limits = [];
  driver.values = { angle: { literalRad: 0 } };
  const wheel = doc.joints.find((j) => j.id === 'j-plane')!;
  wheel.type = 'revolute';
  wheel.values = {};
  wheel.couplings = [{ of: 'angle', from: { joint: 'j-turn', of: 'angle' }, ratio: -3, offset: 0 }];
  doc.solvedPoses = solveJoints(
    doc,
    parameterValues(doc),
    (h) => r2b.closure.get(h),
    (at, ref) => r2b.frames.get(`${at} ${connectorRefKey(ref)}`),
    () => true,
  ).poses;
  await importJson(page, 'wheels.json', {
    ...empty,
    name: 'Wheels',
    draft: { ...empty.draft, content: doc },
    cadParts: [...r2b.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Wheels');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const content = async () => (await nativeArtifact(page)).draft.content as CadDocument;
  const joints = page.getByRole('list', { name: 'Joints' });
  const panel = page.getByTestId('cad-joint');
  const continuous = panel.getByLabel('Turns continuously');
  for (const name of [/^j-turn/, /^j-plane/]) {
    await joints.getByRole('button', { name }).click();
    await continuous.check();
    await ready(page);
  }
  expect((await content()).joints.filter((j) => j.continuous).map((j) => j.id)).toEqual([
    'j-turn',
    'j-plane',
  ]);
  // A continuous joint has no range.
  await expect(page.getByRole('form', { name: 'Joint range' })).toHaveCount(0);
  await joints.getByRole('button', { name: /^j-turn/ }).click();
  const values = page.getByRole('form', { name: 'Joint values' });
  await values.getByLabel('Angle (°)').fill('3690');
  await values.getByRole('button', { name: 'Apply values' }).click();
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const turned = await content();
  expect(turned.joints.find((j) => j.id === 'j-turn')!.values.angle).toEqual({
    literalRad: (3690 * Math.PI) / 180,
  });
  // −30¾ turns: the wheel stands a quarter turn from where it started.
  const angleOf = (q: readonly number[]) =>
    Math.round((2 * Math.atan2(q[2]!, q[3]!) * 180) / Math.PI + 720) % 360;
  const start = doc.solvedPoses['c-plate-1']!.rotation;
  await expect
    .poll(
      async () =>
        (angleOf((await content()).solvedPoses['c-plate-1']!.rotation) - angleOf(start) + 360) %
        360,
    )
    .toBe(90);
  await page.screenshot({ path: test.info().outputPath('wm2a-turned.png') });
  // Back to one turn while past one turn is refused.
  await continuous.click();
  await expect(page.locator('.cad-diagnostic[role=alert]')).toBeVisible();
  expect((await content()).joints.find((j) => j.id === 'j-turn')!.continuous).toBe(true);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await ready(page);
  }
  expect((await content()).joints.some((j) => j.continuous)).toBe(false);
});

// TS-1890, ST-444 (WM2c): the F70 train opened without meshes; the centre wheel meshed with the
// third pinion and the third wheel with the fourth pinion in the Gear meshes section, a pair at
// leaves cut for another wheel refused, the gear train listing ×−8 and ×60
// (60 s a turn), the centre wheel driven 10¼ turns, a mesh removed, and undone.
test('mesh a watch gear train and list its ratios (WM2c)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(240_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const f70 = f70GearTrain({ id, buildHash });
  const doc = structuredClone(f70.assembly);
  delete doc.gearMeshes;
  for (const j of doc.joints) {
    delete j.couplings;
    j.values = { angle: { literalRad: 0 } };
  }
  doc.solvedPoses = f70.solve(doc).poses;
  await importJson(page, 'train.json', {
    ...empty,
    name: 'Train',
    draft: { ...empty.draft, content: doc },
    cadParts: [...f70.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Train');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const content = async () => (await nativeArtifact(page)).draft.content as CadDocument;
  const section = page.getByTestId('cad-gear-meshes');
  const add = section.getByRole('form', { name: 'Add gear mesh' });
  const mesh = async (driver: string, a: string, driven: string, b: string) => {
    await add.getByLabel('Driver joint').selectOption({ label: driver });
    await add.getByLabel('Driver gear').selectOption({ label: a });
    await add.getByLabel('Driven joint').selectOption({ label: driven });
    await add.getByLabel('Driven gear').selectOption({ label: b });
    await add.getByRole('button', { name: 'Mesh gears' }).click();
  };
  // The centre wheel cannot drive the fourth pinion: its leaves were cut for the third wheel.
  await mesh('j-centre', 'Centre wheel', 'j-fourth', 'Fourth pinion');
  await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText(
    'サイクロイドの歯車が相手の歯数で作られていません',
  );
  expect((await content()).gearMeshes).toBeUndefined();
  await mesh('j-centre', 'Centre wheel', 'j-third', 'Third pinion');
  await ready(page);
  await mesh('j-third', 'Third wheel', 'j-fourth', 'Fourth pinion');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const meshed = await content();
  expect(meshed.gearMeshes!.map((m) => [m.driver.joint, m.driven.joint])).toEqual([
    ['j-centre', 'j-third'],
    ['j-third', 'j-fourth'],
  ]);
  // The same couplings the fixture's own registration gives.
  for (const id of ['j-third', 'j-fourth']) {
    const c = meshed.joints.find((j) => j.id === id)!.couplings![0]!;
    const want = f70.assembly.joints.find((j) => j.id === id)!.couplings![0]!;
    expect(c.ratio).toBeCloseTo(want.ratio, 9);
    expect(c.offset).toBeCloseTo(want.offset, 6);
  }
  await expect(section.getByRole('note')).toHaveCount(0);
  const train = page.getByTestId('cad-gear-train');
  await expect(train.getByTestId('cad-gear-train-row')).toHaveText([
    /j-third：×-8（1回転 450 秒、逆回り）/,
    /j-fourth：×60（1回転 60 秒、同じ向き）/,
  ]);
  await page.screenshot({ path: test.info().outputPath('wm2c-meshes.png') });
  // 10¼ turns of the centre wheel: the fourth wheel turns 615 times.
  await page
    .getByRole('list', { name: 'Joints' })
    .getByRole('button', { name: /^j-centre/ })
    .click();
  const values = page.getByRole('form', { name: 'Joint values' });
  await values.getByLabel('Angle (°)').fill('3690');
  await values.getByRole('button', { name: 'Apply values' }).click();
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(section.getByRole('note')).toHaveCount(0);
  // The driven joints show their mesh in place of a coupling form.
  await page
    .getByRole('list', { name: 'Joints' })
    .getByRole('button', { name: /^j-fourth/ })
    .click();
  await expect(page.getByTestId('cad-joint-mesh-coupling')).toContainText('j-third → j-fourth');
  await section
    .getByTestId('cad-gear-mesh')
    .filter({ hasText: 'j-third → j-fourth' })
    .getByRole('button', { name: 'Remove mesh' })
    .click();
  await ready(page);
  const removed = await content();
  expect(removed.gearMeshes!.length).toBe(1);
  const fourth = removed.joints.find((j) => j.id === 'j-fourth')!;
  expect(fourth.couplings).toBeUndefined();
  expect(fourth.values.angle).toBeDefined();
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await ready(page);
  }
  expect((await content()).gearMeshes).toBeUndefined();
  // A picked joint that is deleted gives way to a remaining one.
  await add.getByLabel('Driver joint').selectOption({ label: 'j-centre' });
  await add.getByLabel('Driven joint').selectOption({ label: 'j-fourth' });
  // j-fourth is still the selected joint from the mesh note above.
  await expect(page.getByRole('form', { name: 'Joint values' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete joint' }).click();
  await ready(page);
  await expect(add.getByLabel('Driven joint')).toHaveValue('j-third');
  await expect(add.getByLabel('Driven gear')).toHaveValue(/.+/);
  await expect(add.getByRole('button', { name: 'Mesh gears' })).toBeEnabled();
});

// TS-1892, ST-445 (WM3): watch-sized parts on a 30 mm plate — a 0.05 mm cube and an 8-leaf pinion
// of module 0.05 — read with their own digits (0.000125 mm³, not 0), framed by Zoom to selection
// though a pixel across in the whole view, measured corner to corner exactly (0.05 mm), and the
// pinion framed in perspective and zoomed in further toward the cursor without clipping.
test('edit watch-sized parts (WM3)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(240_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  const b = cadBuilder(kernelProfile);
  b.box('Plate', { size: [30, 30, 0.5], origin: [-15, -15, 0] });
  b.box('Tiny', { size: [0.05, 0.05, 0.05], origin: [12, 8, 0.5] });
  b.spurGear('Pinion', {
    profile: 'cycloidal',
    module: 0.05,
    teeth: 8,
    matingTeeth: 60,
    faceWidth: 0.2,
    bore: 0,
    origin: [-10, -5, 0.5],
  });
  await importJson(page, 'small.json', {
    ...empty,
    name: 'Small',
    draft: { ...empty.draft, content: { ...b.build().document, kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Small');
  await ready(page);
  await expect(state(page)).toHaveText('Shape up to date', { timeout: 90_000 });
  await page.getByTestId('cad-standard-view').selectOption('plan');
  await bodies(page).filter({ hasText: 'Tiny' }).click();
  const metrics = page.locator('.cad-metrics');
  await expect(metrics).toContainText('0.000125 mm³');
  await expect(metrics).toContainText('0.05 × 0.05 × 0.05 mm');
  // A pixel across in the whole view: framed, it fills the view, and its corners snap.
  await page.getByRole('button', { name: 'Zoom to selection' }).click();
  const canvas = (await page.locator('canvas').first().boundingBox())!;
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await (await tool(page, 'Measure distance')).click();
  await page.mouse.click(cx - 200, cy - 200);
  await page.mouse.click(cx + 200, cy - 200);
  const measured = page.locator('.cad-measure');
  await expect(page.getByTestId('cad-distance')).toHaveText('0.05');
  await expect(measured).toContainText('Exact: both points are corners');
  await page.screenshot({ path: test.info().outputPath('wm3-tiny.png') });
  await measured.getByRole('button', { name: 'Clear' }).click();
  await (await tool(page, 'Measure distance')).click();
  // The pinion in perspective, then closer toward the cursor: its leaves stay whole.
  await page.getByTestId('cad-standard-view').selectOption('three-quarter');
  await bodies(page).filter({ hasText: 'Pinion' }).click();
  await page.getByRole('button', { name: 'Zoom to selection' }).click();
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -200);
  await page.screenshot({ path: test.info().outputPath('wm3-pinion.png') });
  await page.mouse.click(cx, cy);
  await expect(page.locator('.cad-inspector').getByLabel('Name')).toHaveValue('Pinion');
});

// W1 acceptance (docs/cad/watch-design.md, 受け入れの区切り W1; WM1–WM3): the F70 train opened
// without meshes and meshed in the normal screen; the centre wheel turned to 0°, 1234.5° and
// 3690° (10¼ turns, the fourth wheel 615 turns), at each of which the gear mesh checks (phase
// and centre distance) find nothing and the MR3 interference check on the display meshes finds
// no overlapping parts; then saved, reloaded and copied through native JSON with the same
// meshes and couplings. A train with its fourth arbor 0.05 mm off is refused at that pair.
test('W1 acceptance: mesh a watch train, turn it ten turns without interference, and keep it', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(420_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const f70 = f70GearTrain({ id, buildHash });
  const unmeshed = (shift = 0) => {
    const doc = structuredClone(f70.assembly);
    delete doc.gearMeshes;
    for (const j of doc.joints) {
      delete j.couplings;
      j.values = { angle: { literalRad: 0 } };
      if (j.id === 'j-fourth')
        j.parent.offset!.translation[0] = mm(
          (j.parent.offset!.translation[0] as { literalMm: number }).literalMm + shift,
        );
    }
    doc.solvedPoses = f70.solve(doc).poses;
    return doc;
  };
  const cadParts = [...f70.closure].map(([contentHash, content]) => ({ contentHash, content }));
  await importJson(page, 'train.json', {
    ...empty,
    name: 'Train',
    draft: { ...empty.draft, content: unmeshed() },
    cadParts,
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Train');
  await ready(page);
  const content = async () => (await nativeArtifact(page)).draft.content as CadDocument;
  const section = page.getByTestId('cad-gear-meshes');
  const add = section.getByRole('form', { name: 'Add gear mesh' });
  const mesh = async (driver: string, a: string, driven: string, b: string) => {
    await add.getByLabel('Driver joint').selectOption({ label: driver });
    await add.getByLabel('Driver gear').selectOption({ label: a });
    await add.getByLabel('Driven joint').selectOption({ label: driven });
    await add.getByLabel('Driven gear').selectOption({ label: b });
    await add.getByRole('button', { name: 'Mesh gears' }).click();
    await ready(page);
  };
  await mesh('j-centre', 'Centre wheel', 'j-third', 'Third pinion');
  await mesh('j-third', 'Third wheel', 'j-fourth', 'Fourth pinion');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await content()).gearMeshes).toHaveLength(2);
  const interference = page.getByTestId('cad-interference');
  const status = page.getByTestId('cad-interference-status');
  const values = page.getByRole('form', { name: 'Joint values' });
  for (const degrees of ['0', '1234.5', '3690']) {
    // 0° is where the train was meshed: nothing to apply.
    if (degrees !== '0') {
      // A click on the selected joint clears it: click until its values show.
      const centre = page.getByRole('list', { name: 'Joints' }).getByRole('button', {
        name: /^j-centre/,
      });
      await centre.click();
      if (!(await values.isVisible())) await centre.click();
      await values.getByLabel('Angle (°)').fill(degrees);
      await values.getByRole('button', { name: 'Apply values' }).click();
      await ready(page);
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(section.getByRole('note')).toHaveCount(0);
    const doc = await content();
    expect(gearMeshProblems(doc, f70.solve(doc), f70.lookup).size, degrees).toBe(0);
    await interference.getByRole('button', { name: 'Check interference' }).click();
    await expect(status).toHaveText('今の姿勢：干渉はありません。', { timeout: 120_000 });
    await page.screenshot({ path: test.info().outputPath(`w1-${degrees}.png`) });
  }
  // 3690° on the centre wheel: −8 × and 60 × on the others, kept whole (not wrapped).
  const turned = await content();
  const solved = f70.solve(turned);
  expect(Object.keys(solved.joints).sort()).toEqual(['j-centre', 'j-fourth', 'j-third']);
  // Saved, reloaded, and copied through native JSON: the same meshes and couplings.
  await save(page, 1);
  await page.reload();
  await ready(page);
  const reloaded = await content();
  expect(reloaded.gearMeshes).toEqual(turned.gearMeshes);
  expect(reloaded.joints).toEqual(turned.joints);
  const record = await nativeArtifact(page);
  expect(record.versions[0]!.content).toEqual(reloaded);
  await importJson(page, 'train-copy.json', { ...record, name: 'Train copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Train copy');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const copied = await content();
  expect(copied.gearMeshes).toEqual(turned.gearMeshes);
  expect(copied.joints).toEqual(turned.joints);
  await expect(section.getByRole('note')).toHaveCount(0);
  // The fourth arbor 0.05 mm off: that pair is refused with both distances.
  await importJson(page, 'train-off.json', {
    ...empty,
    name: 'Train off',
    draft: { ...empty.draft, content: unmeshed(0.05) },
    cadParts,
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Train off');
  await ready(page);
  await mesh('j-centre', 'Centre wheel', 'j-third', 'Third pinion');
  await mesh('j-third', 'Third wheel', 'j-fourth', 'Fourth pinion');
  await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText('この組は 4.25 mm');
  expect((await content()).gearMeshes!.map((m) => m.id)).toHaveLength(1);
});

// WM5b (docs/cad/watch-design.md, WM5): the SK-01 sample watch opened in the Playground through
// native JSON with its part versions (cadParts): the movement in its case with the hands, clear
// of interference at rest; the form 分解 recalled as one edit lifts the bridges, the back and the
// bezel and is clear too, and 組立 puts them back.
test('WM5b: open the SK-01 watch, recall 分解 and 組立, clear of interference', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(900_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const watch = sk01Watch({ id, buildHash });
  await importJson(page, 'sk01.json', {
    ...empty,
    name: 'SK-01',
    draft: { ...empty.draft, content: watch.assembly },
    cadParts: [...watch.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('SK-01');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const content = async () => (await nativeArtifact(page)).draft.content as CadDocument;
  const form = (name: string) => page.locator(`[data-testid=cad-form][data-form=${name}]`);
  await expect(form('form-assembled').locator('[data-state=current]')).toBeVisible();
  const interference = page.getByTestId('cad-interference');
  const status = page.getByTestId('cad-interference-status');
  const clear = async (shot: string) => {
    // The parts are evaluated in the background, gears about 10 s each: until every one is in,
    // the check lists the rest unchecked.
    await expect(page.getByTestId('cad-parts-progress')).toHaveCount(0, { timeout: 600_000 });
    await interference.getByRole('button', { name: 'Check interference' }).click();
    await expect(status).toHaveText('今の姿勢：干渉はありません。', { timeout: 600_000 });
    await page.screenshot({ path: test.info().outputPath(`${shot}.png`) });
  };
  await clear('wm5b-assembled');
  await page
    .getByRole('group', { name: 'Form 分解' })
    .getByRole('button', { name: 'Recall' })
    .click();
  await ready(page);
  await expect(form('form-exploded').locator('[data-state=current]')).toBeVisible();
  const lifted = (await content()).joints.filter((j) => j.id.startsWith('j-lift-'));
  expect(
    Object.fromEntries(
      lifted.map((j) => [j.id, (j.values.distance as { literalMm: number }).literalMm]),
    ),
  ).toEqual({
    'j-lift-case-back': 14,
    'j-lift-balance-cock': 8,
    'j-lift-train-bridge': 6,
    'j-lift-barrel-bridge': 6,
    'j-lift-bezel': -8,
  });
  await clear('wm5b-exploded');
  await page
    .getByRole('group', { name: 'Form 組立' })
    .getByRole('button', { name: 'Recall' })
    .click();
  await ready(page);
  await expect(form('form-assembled').locator('[data-state=current]')).toBeVisible();
  expect((await content()).joints).toEqual(watch.assembly.joints);
});

// WM5c (docs/cad/watch-design.md, WM5): the SK-01 watch written from the Playground's export as
// STEP AP242 (each of its 17 part versions once as a product, placed once each under the root)
// and as GLB (each placed part's display mesh at its pose). The files go to CAD_WATCH_DEMO_DIR
// when it is set (the demo, never committed).
test('WM5c: export the SK-01 watch as STEP AP242 and GLB', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(900_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const watch = sk01Watch({ id, buildHash });
  await importJson(page, 'sk01.json', {
    ...empty,
    name: 'SK-01',
    draft: { ...empty.draft, content: watch.assembly },
    cadParts: [...watch.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('SK-01');
  await ready(page);
  await expect(page.getByTestId('cad-parts-progress')).toHaveCount(0, { timeout: 600_000 });
  const dir = process.env.CAD_WATCH_DEMO_DIR;
  const exporting = page.getByRole('dialog', { name: 'Export 3D file' });
  const report = exporting.getByLabel('Export report');
  const keep = async (name: string, bytes: Buffer) => {
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/${name}`, bytes);
  };

  await (await tool(page, 'Export STEP, STL or GLB')).click();
  await expect(exporting.getByLabel(/^STEP \(AP242 assembly/)).toBeChecked();
  await exporting.getByRole('button', { name: 'Prepare file' }).click();
  await expect(report.locator('dt:has-text("Products") + dd')).toHaveText('18', {
    timeout: 300_000,
  });
  await expect(report.locator('dt:has-text("Instances") + dd')).toHaveText('17');
  // About 16.5 MiB with the gears: within the 64 MiB STEP limit both ways (CR7g-4), so no note.
  await expect(exporting.getByText(/cannot import it back/)).toHaveCount(0);
  let download = page.waitForEvent('download');
  await exporting.getByRole('button', { name: 'Save STEP' }).click();
  const step = await readFile((await (await download).path())!);
  expect(step.toString('latin1')).toMatch(/AP242/);
  for (const name of ['Main plate', 'Escape wheel', 'Balance', 'Case middle', 'Chapter ring'])
    expect(step.toString('latin1'), name).toContain(`'${name}'`);
  await keep('sk01.step', step);
  await page.keyboard.press('Escape');

  await (await tool(page, 'Export STEP, STL or GLB')).click();
  await exporting.getByLabel(/^GLB \(each placed part/).check();
  await exporting.getByRole('button', { name: 'Prepare file' }).click();
  await expect(report).toContainText('m', { timeout: 300_000 });
  download = page.waitForEvent('download');
  await exporting.getByRole('button', { name: 'Save GLB' }).click();
  const glb = await readFile((await (await download).path())!);
  expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF');
  await keep('sk01.glb', glb);
});

// WM5c-2 (docs/cad/watch-design.md, 通常の画面での編集; W2): the SK-01 watch edited by hand in the
// normal screen. Its third wheel and train bridge are saved parts of their own. (1) The third
// wheel's teeth changed and the new version taken into the watch: its meshes report the centre
// distance; Undo and Redo bring it back and forth. (2) A window of the train bridge made smaller
// with a radius dimension in its sketch and taken in: no interference. Saved, reloaded and
// copied through native JSON in the same state.
test('WM5c-2: change the third wheel’s teeth and a bridge window by hand in the SK-01 watch', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(1_200_000);
  await page.goto('/');
  const switchTo = async (name: string) => {
    const nav = page.getByRole('navigation', { name: 'Artifacts', exact: true });
    if (!(await nav.isVisible()))
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await nav.getByRole('button').filter({ hasText: name }).first().click();
    await expect(page.getByLabel('Artifact name')).toHaveValue(name);
    if (await nav.isVisible())
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await expect(nav).toBeHidden();
    await ready(page);
  };
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const watch = sk01Watch({ id, buildHash });
  // The two parts edited by hand, each saved once as it is in the watch.
  const saved: Record<string, { id: string; versionId: string; contentHash: string }> = {};
  for (const [key, name] of [
    ['third', 'Third wheel part'],
    ['train-bridge', 'Train bridge part'],
  ] as const) {
    await importJson(page, `${key}.json`, {
      ...empty,
      name,
      draft: { ...empty.draft, content: watch.versions.get(key)!.content },
      versions: [],
    });
    await expect(page.getByLabel('Artifact name')).toHaveValue(name);
    await ready(page);
    await save(page, 1);
    const record = await nativeArtifact(page);
    expect(record.versions[0]!.contentHash).toBe(watch.versions.get(key)!.contentHash);
    saved[key] = { id: record.id, ...record.versions[0]! };
  }
  const assembly = structuredClone(watch.assembly);
  for (const [key, v] of Object.entries(saved))
    assembly.parts.find((p) => p.id === `part-${key}`)!.source = {
      kind: 'version',
      artifactId: v.id,
      versionId: v.versionId,
      contentHash: v.contentHash,
    };
  await importJson(page, 'sk01.json', {
    ...empty,
    name: 'SK-01',
    draft: { ...empty.draft, content: assembly },
    versions: [],
    cadParts: [...watch.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('SK-01');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const meshes = page.getByTestId('cad-gear-meshes');
  await expect(meshes.getByRole('note')).toHaveCount(0);

  // (1) 75 → 76 teeth on the third wheel, saved as v2.
  await switchTo('Third wheel part');
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: /^Third wheel spurGear$/ })
    .click();
  const teeth = page.locator('.cad-inspector').getByLabel('Teeth', { exact: true });
  await teeth.fill('76');
  await teeth.press('Enter');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await save(page, 2);
  await switchTo('SK-01');
  const third = components(page).filter({ hasText: 'Third wheel' });
  await expect(third).toContainText('新しい版あり');
  const update = async (row: typeof third) => {
    await row.click();
    await page
      .getByTestId('cad-component')
      .getByRole('button', { name: 'Change version…' })
      .click();
    const dialog = page.getByTestId('cad-update-parts');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await dialog.getByRole('button', { name: 'Apply update' }).click();
    await ready(page);
  };
  await update(third);
  // The third wheel's pitch circle grew: both of its meshes are off their centre distance.
  await expect(meshes.getByRole('note').filter({ hasText: '中心距離' }).first()).toBeVisible();
  const changed = (await nativeArtifact(page)).draft.content as CadDocument;
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(meshes.getByRole('note')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await ready(page);
  await expect(meshes.getByRole('note').filter({ hasText: '中心距離' }).first()).toBeVisible();
  expect((await nativeArtifact(page)).draft.content).toEqual(changed);
  await page.screenshot({ path: test.info().outputPath('wm5c2-teeth.png') });
  // Back to v1 (Undo), as the watch goes on.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);

  // (2) The train bridge's first window from its radius to 0.1 mm smaller, saved as v2.
  await switchTo('Train bridge part');
  await page.getByRole('button', { name: 'Edit sketch Train bridge outline' }).click();
  const drawing = page.getByRole('application', { name: 'Drawing of Train bridge outline' });
  await page.getByRole('button', { name: 'Fit sketch', exact: true }).click();
  // On its rim: the centre point's marker covers the middle.
  const window = drawing.locator('[data-id="o1"]');
  const box = (await window.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 1);
  await page
    .getByRole('group', { name: 'Add constraint' })
    .getByRole('button', { name: 'Radius', exact: true })
    .click();
  const constraints = page.getByRole('list', { name: 'Constraints' });
  const radius = constraints.getByRole('textbox', { name: 'Radius (mm)' });
  const before = Number(await radius.inputValue());
  await radius.fill(String(Math.round((before - 0.1) * 1000) / 1000));
  await radius.press('Enter');
  await page.getByTestId('cad-sketch-panel').getByRole('button', { name: 'Finish' }).click();
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await save(page, 2);
  await switchTo('SK-01');
  await update(components(page).filter({ hasText: 'Train bridge' }));
  await expect(page.getByTestId('cad-parts-progress')).toHaveCount(0, { timeout: 600_000 });
  await page
    .getByTestId('cad-interference')
    .getByRole('button', { name: 'Check interference' })
    .click();
  await expect(page.getByTestId('cad-interference-status')).toHaveText(
    '今の姿勢：干渉はありません。',
    { timeout: 600_000 },
  );
  await page.screenshot({ path: test.info().outputPath('wm5c2-window.png') });

  // Saved, reloaded, copied: the same parts and meshes.
  const edited = (await nativeArtifact(page)).draft.content as CadDocument;
  expect(edited.parts.find((p) => p.id === 'part-train-bridge')!.source).toMatchObject({
    artifactId: saved['train-bridge']!.id,
  });
  expect(partVersionId(edited.parts.find((p) => p.id === 'part-third')!.source)).toBe(
    saved.third!.versionId,
  );
  await save(page, 1);
  await page.reload();
  await ready(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(edited);
  const record = await nativeArtifact(page);
  await importJson(page, 'sk01-copy.json', { ...record, name: 'SK-01 copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('SK-01 copy');
  await ready(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(edited);
  await expect(meshes.getByRole('note')).toHaveCount(0);
});

/** An 8-bit RGB PNG (filter none per row). */
function rgbPng(width: number, height: number, rgb: Uint8Array): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++)
    rows.push(
      Buffer.concat([Buffer.of(0), Buffer.from(rgb.subarray(y * width * 3, (y + 1) * width * 3))]),
    );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * WM6: SK-01 with its finishes (`sk01FinishImages` as PNG assets in the native file), opened in
 * the Playground with every part evaluated. Returns the resources it carried.
 */
async function openFinishedSk01(page: Page) {
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const images = sk01FinishImages(256);
  const resources: Record<string, unknown>[] = [];
  const asset = (name: string, img: { width: number; height: number; rgb: Uint8Array }) => {
    const bytes = rgbPng(img.width, img.height, img.rgb);
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    resources.push({
      kind: 'texture-png',
      sha256,
      byteLength: bytes.length,
      mediaType: 'image/png',
      encoding: 'base64',
      bytes: bytes.toString('base64'),
    });
    return {
      id: name,
      kind: 'texture-png' as const,
      sha256,
      byteLength: bytes.length,
      mediaType: 'image/png',
    };
  };
  const finish: Sk01Finish = {
    perlage: {
      color: asset('tex-perlage-color', images.perlage.color),
      normal: asset('tex-perlage-normal', images.perlage.normal),
    },
    cotes: {
      color: asset('tex-cotes-color', images.cotes.color),
      normal: asset('tex-cotes-normal', images.cotes.normal),
    },
  };
  const watch = sk01Watch({ id, buildHash }, finish);
  await importJson(page, 'sk01.json', {
    ...empty,
    name: 'SK-01',
    draft: { ...empty.draft, content: watch.assembly },
    cadParts: [...watch.closure].map(([contentHash, content]) => ({ contentHash, content })),
    cadResources: resources,
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('SK-01');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('cad-parts-progress')).toHaveCount(0, { timeout: 900_000 });
  return resources;
}

// WM6a (ST-452, TS-1908): SK-01 with its finishes: the anglage on the plate and bridges, perlage
// and Côtes de Genève as image maps (drawn by `sk01FinishImages`, carried in the native file),
// clear rubies. It opens with its maps, stays clear of interference, and renders path-traced.
test('WM6a: open the finished SK-01 with its decoration and render it path-traced', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(1_500_000);
  const resources = await openFinishedSk01(page);
  const interference = page.getByTestId('cad-interference');
  await interference.getByRole('button', { name: 'Check interference' }).click();
  await expect(page.getByTestId('cad-interference-status')).toHaveText(
    '今の姿勢：干渉はありません。',
    { timeout: 600_000 },
  );
  const dir = process.env.CAD_WATCH_DEMO_DIR;
  if (dir) await mkdir(dir, { recursive: true });
  const shot = async (name: string) => {
    await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
    if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
  };
  // The back (the bridges, under the case-back crystal) and three-quarter.
  await page.getByTestId('cad-standard-view').selectOption('plan');
  await shot('wm6a-back');
  await page.getByTestId('cad-standard-view').selectOption('three-quarter');
  await shot('wm6a-three-quarter');
  // A path-traced still of the back.
  await page.getByTestId('cad-standard-view').selectOption('plan');
  await (await tool(page, 'Render image')).click();
  const dialog = page.getByRole('dialog', { name: 'Render image' });
  await dialog.getByLabel('Width (px)').fill('960');
  await dialog.getByLabel('Height (px)').fill('720');
  await dialog.getByLabel('Samples').fill('64');
  await dialog.getByLabel('Time limit (s, 0 = none)').fill('240');
  await dialog.getByLabel('Floor under the model').uncheck();
  await dialog.getByRole('button', { name: 'Render', exact: true }).click();
  await expect(dialog.getByTestId('view-render-done')).toHaveText(/^960 × 720 px, \d+ samples?/, {
    timeout: 900_000,
  });
  await expect(dialog.getByTestId('view-render-invalid')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save PNG' }).click();
  const file = await readFile((await (await download).path())!);
  expect([file.readUInt32BE(16), file.readUInt32BE(20)]).toEqual([960, 720]);
  if (dir) await writeFile(`${dir}/wm6a-back-path-traced.png`, file);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  // The maps travel with the parts: a native round trip keeps the resources.
  const saved = await nativeArtifact(page);
  expect(saved.cadResources?.map((r: { sha256: string }) => r.sha256).sort()).toEqual(
    resources.map((r) => r.sha256).sort(),
  );
});

// WM6b (ST-453, TS-1910): path-traced stills of the finished SK-01: the dial (the camera turned
// under the watch from Front), three-quarter from the back, and a close view of the movement.
test('WM6b: path-traced stills of the finished SK-01 from the dial, three-quarter and close', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(2_400_000);
  await openFinishedSk01(page);
  const dir = process.env.CAD_WATCH_DEMO_DIR;
  if (dir) await mkdir(dir, { recursive: true });
  const look = page.getByTestId('cad-standard-view');
  const canvas = page.locator('.cad-canvas');
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  /** Orbits by dragging: a drag of half the view's height turns the camera 90°. */
  const drag = async (dx: number, dy: number) => {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + dx, centre.y + dy, { steps: 20 });
    await page.mouse.up();
  };
  const render = async (name: string) => {
    await page.screenshot({ path: test.info().outputPath(`${name}-view.png`) });
    await (await tool(page, 'Render image')).click();
    const dialog = page.getByRole('dialog', { name: 'Render image' });
    await dialog.getByLabel('Width (px)').fill('960');
    await dialog.getByLabel('Height (px)').fill('720');
    await dialog.getByLabel('Samples').fill('64');
    await dialog.getByLabel('Time limit (s, 0 = none)').fill('240');
    await dialog.getByLabel('Floor under the model').uncheck();
    await dialog.getByRole('button', { name: 'Render', exact: true }).click();
    await expect(dialog.getByTestId('view-render-done')).toHaveText(/^960 × 720 px, \d+ samples?/, {
      timeout: 900_000,
    });
    await expect(dialog.getByTestId('view-render-invalid')).toHaveCount(0);
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save PNG' }).click();
    const file = await readFile((await (await download).path())!);
    expect([file.readUInt32BE(16), file.readUInt32BE(20)]).toEqual([960, 720]);
    if (dir) await writeFile(`${dir}/${name}.png`, file);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };
  // The dial: from Front (along +y), turned 90° down under the watch.
  await look.selectOption('front');
  await drag(0, -box.height / 2);
  await render('wm6b-dial');
  // Three-quarter from the back, over the bridges.
  await look.selectOption('three-quarter');
  await render('wm6b-three-quarter');
  // Close: the same view, zoomed in toward the middle of the movement.
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -200);
  await render('wm6b-close');
});

// TS-1809, ST-288 (CR7a): a box given steel's density in the inspector weighs its volume times
// 7,850 kg/m³, undone; an assembly of two weighed plates and a bare one: the total, the bare one
// left out, and the front/rear split between the two plates' axles.
test('weigh a body and an assembly with its front/rear split (CR7a)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  await (await tool(page, 'Add box')).click();
  await ready(page);
  await bodies(page).last().click();
  const mass = page.getByTestId('cad-mass');
  await expect(page.getByTestId('cad-body-mass')).toContainText('No density');
  await mass.getByLabel('Density preset').selectOption('steel');
  await ready(page);
  const doc = (await nativeArtifact(page)).draft.content as CadDocument;
  expect(doc.bodies.at(-1)!.mass).toEqual({ densityKgM3: 7850, material: 'steel' });
  await expect(page.getByTestId('cad-body-mass')).toContainText(' kg');
  // A solid takes no thickness.
  await expect(mass.getByLabel('Sheet thickness (mm)')).toHaveCount(0);
  await mass.getByLabel('Density (kg/m³)').fill('5');
  await mass.getByLabel('Density (kg/m³)').press('Enter');
  // Out of range: not taken (an invalid field blocks the export, so it is cancelled first).
  await mass.getByLabel('Density (kg/m³)').press('Escape');
  expect(((await nativeArtifact(page)).draft.content as CadDocument).bodies.at(-1)!.mass).toEqual({
    densityKgM3: 7850,
    material: 'steel',
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect(page.getByTestId('cad-body-mass')).toContainText('No density');

  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  const kernel = { id: kernelProfile.id, buildHash: kernelProfile.buildHash };
  const plateDoc = { ...f02Plate(), kernelProfile };
  const weighed = applyCadOperation(plateDoc, {
    type: 'setBodyMass',
    bodyId: plateDoc.bodies[0]!.id,
    mass: { densityKgM3: 7850, material: 'steel' },
  });
  const plate = fixtureVersion('cr7a-plate', 'v1', weighed);
  const bare = fixtureVersion('cr7a-bare', 'v1', plateDoc);
  let car = { ...emptyCad(kernel), kernelProfile };
  car = applyCadOperation(car, {
    type: 'insertComponents',
    parts: [fixturePart('p-plate', 'Plate', plate), fixturePart('p-bare', 'Bare', bare)],
    components: [
      { ...fixtureComponent('front', 'p-plate', [0, 0, 0]), name: 'Front' },
      { ...fixtureComponent('rear', 'p-plate', [3000, 0, 0]), name: 'Rear' },
      { ...fixtureComponent('trim', 'p-bare', [1000, 0, 0]), name: 'Trim' },
    ],
  });
  await importJson(page, 'weighed.json', {
    ...empty,
    name: 'Weighed',
    versions: [],
    cadParts: [plate, bare].map((v) => ({ contentHash: v.contentHash, content: v.content })),
    draft: { ...empty.draft, content: car },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Weighed');
  await ready(page);
  await expect(components(page)).toHaveCount(3);
  const total = page.getByTestId('cad-mass-total');
  // 80 × 50 × 5 mm less a hole: two of them, each about 0.15 kg.
  await expect(page.getByTestId('cad-mass-left-out')).toContainText('Left out: 1');
  await expect
    .poll(async () => parseFloat(await page.getByTestId('cad-mass-kg').innerText()))
    .toBeGreaterThan(0.25);
  const kg = parseFloat(await page.getByTestId('cad-mass-kg').innerText());
  expect(kg).toBeLessThan(2 * 0.157);
  await total.getByLabel('Front axle').selectOption(['front']);
  await total.getByLabel('Rear axle').selectOption(['rear']);
  await expect(page.getByTestId('cad-mass-split')).toContainText('Front 50 % · rear 50 %');
  await expect(page.getByTestId('cad-mass-split')).toContainText('3,000 mm apart');
  await page.screenshot({ path: test.info().outputPath('cr7a-mass.png') });
});

// TS-1812, ST-289 (CR7b): the whole car (F63) opened with its parts' closure: 18 components on
// the body in white's faces and the hinges, every joint solved with no alert, its mass with a
// front/rear split between the wheels, and the left door opened 45° from its joint, undone.
test('open the whole car, weigh it and open a door (CR7b)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(900_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const car = f63Car({ id, buildHash });
  await importJson(page, 'car.json', {
    ...empty,
    name: 'Car',
    draft: { ...empty.draft, content: car.assembly },
    cadParts: [...car.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Car');
  await expect(state(page)).toHaveText('Shape up to date', { timeout: 600_000 });
  await expect(components(page)).toHaveCount(18);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('cr7b-car.png') });
  const total = page.getByTestId('cad-mass-total');
  const kg = async () =>
    parseFloat((await page.getByTestId('cad-mass-kg').innerText()).replace(/,/g, ''));
  await expect.poll(kg, { timeout: 300_000 }).toBeGreaterThan(100);
  await expect(page.getByTestId('cad-mass-left-out')).toHaveCount(0);
  await total.getByLabel('Front axle').selectOption(['c-wheel-front-l', 'c-wheel-front-r']);
  await total.getByLabel('Rear axle').selectOption(['c-wheel-rear-l', 'c-wheel-rear-r']);
  await expect(page.getByTestId('cad-mass-split')).toContainText('2,400 mm apart');
  test.info().annotations.push({
    type: 'mass',
    description: `${await kg()} kg; ${await page.getByTestId('cad-mass-split').innerText()}; centre ${await page.getByTestId('cad-mass-centre').innerText()}`,
  });
  await total.screenshot({ path: test.info().outputPath('cr7b-mass.png') });
  const poses = async () => ((await nativeArtifact(page)).draft.content as CadDocument).solvedPoses;
  const joints = page.getByRole('list', { name: 'Joints' });
  const values = page.getByRole('form', { name: 'Joint values' });
  await joints.getByRole('button', { name: /^Door L hinge/ }).click();
  await values.getByLabel('Angle (°)').fill('45');
  await values.getByRole('button', { name: 'Apply values' }).click();
  await ready(page);
  // The mirror on the door turns with it (from −90° about z to −45°).
  await expect
    .poll(async () => {
      const q = (await poses())['c-mirror-l']?.rotation;
      return q ? Math.round((2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI) : 0;
    })
    .toBe(45);
  await page.screenshot({ path: test.info().outputPath('cr7b-door.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect
    .poll(async () => (await poses())['c-door']?.rotation.map((v) => Math.round(v * 1000)))
    .toEqual([0, 0, 0, 1000]);
});

// F63's parts evaluate one after another after the assembly itself is up to date: about 6 min
// in a 4-core container (2026-11-13; the CR7g shape and details made them heavier than the
// 5 min these waits had).
const f63PartsMs = 900_000;

// TS-1815, ST-290 (CR7c): the whole car (F63): the left door's hinge stepped through 0–70° in
// 8 steps and checked for interference at each (none since the fit-up, ST-291), and the
// clearance between the front left wheel and the skin now and at full steering lock.
test('check a door through its range and the front wheel’s clearance (CR7c)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(2_400_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const car = f63Car({ id, buildHash });
  await importJson(page, 'car.json', {
    ...empty,
    name: 'Car',
    draft: { ...empty.draft, content: car.assembly },
    cadParts: [...car.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(state(page)).toHaveText('Shape up to date', { timeout: 600_000 });
  // Every part evaluated (all weigh, none left out) before checking.
  await expect
    .poll(
      async () => parseFloat((await page.getByTestId('cad-mass-kg').innerText()).replace(/,/g, '')),
      { timeout: f63PartsMs },
    )
    .toBeGreaterThan(370);
  await expect(page.getByTestId('cad-mass-left-out')).toHaveCount(0);
  const range = page.getByTestId('cad-range');
  await range
    .getByRole('combobox', { name: 'Joint', exact: true })
    .selectOption({ label: 'Door L hinge' });
  await range.getByLabel('Steps').fill('8');
  await range.getByRole('button', { name: 'Check through the range' }).click();
  const status = page.getByTestId('cad-range-status');
  await expect(status).toContainText('Door L hinge（0°〜70°、8刻み）', { timeout: 300_000 });
  test.info().annotations.push({ type: 'range', description: await status.innerText() });
  // F63 fitted (CR7 fit-up): the door opens clear of the skin and the body in white.
  await expect(status).toContainText('干渉はありません。');
  await range.getByLabel('Clearance from').selectOption({ label: 'Wheel front L' });
  await range.getByLabel('Clearance to').selectOption({ label: 'このassemblyの形状' });
  await range.getByRole('button', { name: 'Measure clearance' }).click();
  const clear = page.getByTestId('cad-clearance-status');
  // The tyre clears the skin's arch by about 39 mm (the meshes' precision).
  await expect(clear).toContainText(/の最短距離 (3[5-9]|4[0-4])\.\d mm。/, { timeout: 300_000 });
  test.info().annotations.push({ type: 'clearance', description: await clear.innerText() });
  await page.screenshot({ path: test.info().outputPath('cr7c-clearance.png') });
  await range.getByLabel('At joint').selectOption({ label: 'Wheel front L mount' });
  await range.getByLabel('At angle (°)').fill('35');
  await range.getByRole('button', { name: 'Measure clearance' }).click();
  await expect(clear).toContainText('Wheel front L mount 35°で', { timeout: 300_000 });
  // At full lock the tyre turns away from the arch (F63 widened, CR7g-1: about 48 mm).
  await expect(clear).toContainText(/の最短距離 (4[0-9]|5[0-5])(\.\d)? mm。/);
  test.info().annotations.push({ type: 'clearance-lock', description: await clear.innerText() });
  await page.screenshot({ path: test.info().outputPath('cr7c-lock.png') });
});

// TS-2056, ST-530: a render of a sheet and a placed part in the studio light, their shapes
// calculated again with finer meshes first; the sky light is still offered and lighter.
test('render a sheet and a part with finer surfaces in the studio and the sky light', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(1_200_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'panel.json', {
    ...empty,
    name: 'Panel',
    draft: { ...empty.draft, content: { ...f26Panel(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Panel');
  await ready(page);
  // The door becomes a placed part: the panel is the document's own sheet, the door a part's.
  await bodies(page).nth(1).click();
  await page.getByRole('button', { name: 'Make part', exact: true }).click();
  await ready(page);
  await expect(components(page)).toHaveText(['door-body 1']);
  await page.getByRole('button', { name: 'Render image' }).click();
  const render = page.getByTestId('view-render');
  await render.getByLabel('Width (px)').fill('240');
  await render.getByLabel('Height (px)').fill('150');
  await render.getByLabel('Samples').fill('4');
  await render.getByLabel('Time limit (s, 0 = none)').fill('300');
  // The studio light and finer surfaces are the CAD defaults.
  await expect(render.getByRole('combobox', { name: 'Light', exact: true })).toHaveValue('studio');
  await expect(render.getByLabel(/Finer surfaces/)).toBeChecked();
  const corner = async () =>
    render.getByTestId('view-render-image').evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.naturalWidth, img.naturalHeight];
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      // The top corners: the room or the sky behind the model.
      const d = [
        ...g.getImageData(0, 0, 12, 12).data,
        ...g.getImageData(c.width - 12, 0, 12, 12).data,
      ];
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
      return sum / (d.length / 4) / 255;
    });
  const progress = render.getByTestId('view-render-progress');
  await render.getByRole('button', { name: 'Render', exact: true }).click();
  // Both shapes, the panel and the door's version, are calculated again first.
  await expect(progress).toHaveText(/Calculating finer surfaces|Preparing|Rendering/);
  await expect(render.getByTestId('view-render-done')).toHaveText(/^240 × 150 px, 4 samples/, {
    timeout: 900_000,
  });
  await expect(render.getByTestId('view-render-invalid')).toHaveCount(0);
  const studio = await corner();
  expect(studio).toBeLessThan(0.3);
  await render.getByLabel(/Finer surfaces/).uncheck();
  await render.getByRole('combobox', { name: 'Light', exact: true }).selectOption('sky');
  await render.getByRole('button', { name: 'Render again', exact: true }).click();
  await expect(render.getByTestId('view-render-done')).toHaveText(/^240 × 150 px, 4 samples/, {
    timeout: 900_000,
  });
  expect(await corner()).toBeGreaterThan(studio + 0.15);
});

// TS-1822, ST-293 (CR7e): the whole car (F63) finished, its panels painted and its side windows
// glazed, drawn by the path tracer with the lamps lit and the lenses and glass clear.
test('render the whole car with paint, glass and lit lamps (CR7e)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(2_700_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const car = f63Car({ id, buildHash });
  await importJson(page, 'car.json', {
    ...empty,
    name: 'Car',
    draft: { ...empty.draft, content: car.assembly },
    cadParts: [...car.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(state(page)).toHaveText('Shape up to date', { timeout: 600_000 });
  await expect
    .poll(
      async () => parseFloat((await page.getByTestId('cad-mass-kg').innerText()).replace(/,/g, '')),
      { timeout: f63PartsMs },
    )
    .toBeGreaterThan(370);
  await expect(page.getByTestId('cad-mass-left-out')).toHaveCount(0);
  await page.getByRole('button', { name: 'Render image' }).click();
  const render = page.getByTestId('view-render');
  await render.getByLabel('Width (px)').fill('480');
  await render.getByLabel('Height (px)').fill('270');
  await render.getByLabel('Samples').fill('8');
  await render.getByLabel('Time limit (s, 0 = none)').fill('300');
  await render.getByRole('button', { name: 'Render', exact: true }).click();
  await expect(render.getByTestId('view-render-done')).toHaveText(/^480 × 270 px, \d+ samples? /, {
    timeout: 900_000,
  });
  await expect(render.getByTestId('view-render-invalid')).toHaveCount(0);
  // The paint is in the image: a good share of pixels are its blue (the hue, any brightness).
  const shares = await render
    .getByTestId('view-render-image')
    .evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.naturalWidth, img.naturalHeight];
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let blue = 0;
      for (let i = 0; i < d.length; i += 4) {
        const [r, gr, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
        if (b > r + 25 && b > gr + 5 && b > 40) blue++;
      }
      return { blue: blue / (d.length / 4) };
    });
  test.info().annotations.push({
    type: 'render',
    description: `${await render.getByTestId('view-render-done').innerText()}; paint ${(shares.blue * 100).toFixed(1)} %`,
  });
  expect(shares.blue).toBeGreaterThan(0.02);
  await render
    .getByTestId('view-render-image')
    .screenshot({ path: test.info().outputPath('cr7e-render.png') });
});

// TS-1824, ST-294 (CR7f): the whole car (F63) written as one STEP AP242 assembly and read back
// into an empty document: the same parts, components and placements, the skin as sheets.
test('write the whole car as STEP AP242 and read it back (CR7f)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(3_000_000);
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const car = f63Car({ id, buildHash });
  await importJson(page, 'car.json', {
    ...empty,
    name: 'Car',
    draft: { ...empty.draft, content: car.assembly },
    cadParts: [...car.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(state(page)).toHaveText('Shape up to date', { timeout: 600_000 });
  await expect
    .poll(
      async () => parseFloat((await page.getByTestId('cad-mass-kg').innerText()).replace(/,/g, '')),
      { timeout: f63PartsMs },
    )
    .toBeGreaterThan(370);
  await expect(page.getByTestId('cad-mass-left-out')).toHaveCount(0);
  test.info().annotations.push({
    type: 'before-export',
    description: (await page.locator('.cad-diagnostic').allInnerTexts()).join(' | '),
  });
  await page.screenshot({ path: test.info().outputPath('cr7f-before.png') });
  await (await tool(page, 'Export STEP, STL or GLB')).click();
  const exporting = page.getByRole('dialog', { name: 'Export 3D file' });
  await exporting.getByLabel(/^STEP/).check();
  const started = Date.now();
  await exporting.getByRole('button', { name: 'Prepare file' }).click();
  const exported = exporting.getByLabel('Export report');
  await expect(exported.or(page.locator('.cad-diagnostic[role=alert]')).first()).toBeVisible({
    timeout: 900_000,
  });
  test.info().annotations.push({
    type: 'export',
    description: `${Math.round((Date.now() - started) / 1000)} s; ${await exported
      .or(page.locator('.cad-diagnostic[role=alert]'))
      .first()
      .innerText()}`,
  });
  await page.screenshot({ path: test.info().outputPath('cr7f-exported.png') });
  test.info().annotations.push({
    type: 'after-export',
    description: (await page.locator('.cad-diagnostic').allInnerTexts()).join(' | '),
  });
  await expect(exported).toBeVisible();
  const download = page.waitForEvent('download');
  await exporting.getByRole('button', { name: 'Save STEP' }).click();
  const ap242 = await readFile((await (await download).path())!);
  // Playwright refuses buffers over 50 MB, so the file goes in by its path.
  const stepPath = test.info().outputPath('f63.step');
  await writeFile(stepPath, ap242);

  await create(page, 'cad');
  await ready(page);
  await page.getByLabel('STEP file', { exact: true }).setInputFiles(stepPath);
  const dialog = page.getByRole('dialog', { name: 'Import STEP assembly' });
  const report = dialog.getByLabel('Import report');
  await expect(report.or(page.locator('.cad-diagnostic[role=alert]')).first()).toBeVisible({
    timeout: 900_000,
  });
  test.info().annotations.push({
    type: 'import',
    description: await report.or(page.locator('.cad-diagnostic[role=alert]')).first().innerText(),
  });
  await expect(page.locator('.cad-diagnostic[role=alert]')).toHaveCount(0);
  // Every body comes back as a part, every placed occurrence as a component. CR7g-2 adds 9: the
  // windscreen and rear window (both sides), the doors' handles, the exhaust and two plates.
  await expect(report).toContainText(/Parts\s*83(?!\d)/);
  await expect(report).toContainText(/Components\s*96(?!\d)/);
  await expect(report).toContainText(/Units\s*mm \(no conversion\)/);
  // The Playground keeps native files up to 256 MB (CR7f): the document with the file and its
  // parts' BReps is stored and every part evaluates again.
  await dialog.getByRole('button', { name: 'Import assembly', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 900_000 });
  await ready(page);
  await expect(page.locator('.cad-part-state')).toHaveCount(0, { timeout: 900_000 });
  // The insertion ends after the assembly's evaluation; until then other edits are refused.
  const inserted = Date.now();
  await expect(page.getByRole('button', { name: 'Insert part…', exact: true })).toBeEnabled({
    timeout: 900_000,
  });
  test.info().annotations.push({
    type: 'inserted',
    description: `${Math.round((Date.now() - inserted) / 1000)} s after the parts were shown`,
  });
  await expect(page.locator('.cad-diagnostic[role=alert]')).toHaveCount(0);
  const record = await nativeArtifact(page);
  const doc = record.draft.content as CadDocument;
  expect(doc.parts).toHaveLength(83);
  expect(doc.components).toHaveLength(96);
  test.info().annotations.push({
    type: 'stored',
    description: `${(new Blob([JSON.stringify(record)]).size / 1e6).toFixed(1)} MB native record`,
  });
  await page.screenshot({ path: test.info().outputPath('cr7f-read.png') });
});

// TS-1839, CR7g-4 (E14 in B4): the whole car (F63) edited by hand in the normal screen. (1) The
// driver's seat slid 100 mm forward from its mount's joint value; Undo and Redo go between the
// two. (2) Both headlamps' parts saved, their lens made 4 mm thick (from 3) and saved as v2, and
// the car's headlamps changed to that version. The car saved, reloaded: the same seat, the same
// versions, the same mass.
test('slide a seat and change the headlamps to the 4 mm lens in the whole car (CR7g-4, E14)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(2_700_000);
  await page.goto('/');
  const switchTo = async (name: string) => {
    const nav = page.getByRole('navigation', { name: 'Artifacts', exact: true });
    if (!(await nav.isVisible()))
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await nav.getByRole('button').filter({ hasText: name }).first().click();
    await expect(page.getByLabel('Artifact name')).toHaveValue(name);
    if (await nav.isVisible())
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await expect(nav).toBeHidden();
    // The car evaluates again on opening (its 114 features take minutes).
    await expect(state(page)).toHaveText('Shape up to date', { timeout: 600_000 });
  };
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const car = f63Car({ id, buildHash });
  const assembly = structuredClone(car.assembly);
  // The headlamps' parts, each saved once as it is in the car.
  const lamps = [
    ['part-headlamp-l', 'Headlamp L part'],
    ['part-headlamp-r', 'Headlamp R part'],
  ] as const;
  for (const [partId, name] of lamps) {
    const part = assembly.parts.find((p) => p.id === partId)!;
    const content = car.closure.get(part.source.contentHash)!;
    await importJson(page, `${partId}.json`, {
      ...empty,
      name,
      draft: { ...empty.draft, content },
      versions: [],
    });
    await expect(page.getByLabel('Artifact name')).toHaveValue(name);
    await ready(page);
    await save(page, 1);
    const record = await nativeArtifact(page);
    expect(record.versions[0]!.contentHash).toBe(part.source.contentHash);
    part.source = {
      kind: 'version',
      artifactId: record.id,
      versionId: record.versions[0]!.versionId,
      contentHash: record.versions[0]!.contentHash,
    };
  }
  await importJson(page, 'car.json', {
    ...empty,
    name: 'Car',
    draft: { ...empty.draft, content: assembly },
    versions: [],
    cadParts: [...car.closure].map(([contentHash, content]) => ({ contentHash, content })),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Car');
  await expect(state(page)).toHaveText('Shape up to date', { timeout: 600_000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  const kg = async () =>
    parseFloat((await page.getByTestId('cad-mass-kg').innerText()).replace(/,/g, ''));
  await expect.poll(kg, { timeout: f63PartsMs }).toBeGreaterThan(370);
  const before = await kg();
  const doc = async () => (await nativeArtifact(page)).draft.content as CadDocument;
  const seatX = async () => Math.round((await doc()).solvedPoses['c-seat-l']!.translationMm[0]);
  const x0 = await seatX();

  // (1) The driver's seat 100 mm forward; past its travel (0–240 mm) is refused.
  const joints = page.getByRole('list', { name: 'Joints' });
  const values = page.getByRole('form', { name: 'Joint values' });
  await joints.getByRole('button', { name: /^Seat L mount/ }).click();
  await values.getByLabel('Distance (mm)').fill('300');
  await values.getByRole('button', { name: 'Apply values' }).click();
  await expect(page.locator('.cad-diagnostic[role=alert]')).toContainText('範囲の外');
  await values.getByLabel('Distance (mm)').fill('100');
  await values.getByRole('button', { name: 'Apply values' }).click();
  await ready(page);
  await expect.poll(seatX).toBe(x0 + 100);
  const slid = await doc();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await ready(page);
  await expect.poll(seatX).toBe(x0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await ready(page);
  await expect.poll(seatX).toBe(x0 + 100);
  expect(await doc()).toEqual(slid);
  await page.screenshot({ path: test.info().outputPath('cr7g4-seat.png') });

  // (2) Each headlamp's lens 3 → 4 mm, saved as v2, and the car's headlamp changed to it.
  for (const [, name] of lamps) {
    await switchTo(name);
    const params = page.getByRole('list', { name: 'Parameters' });
    await params.getByRole('button', { name: /^Lens thickness/ }).click();
    const field = page.locator('.cad-inspector').getByLabel(/^Value/);
    await field.fill('4');
    await field.press('Enter');
    await ready(page);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(params).toContainText(/Lens thickness\s*4 mm/);
    await save(page, 2);
  }
  await switchTo('Car');
  for (const [, name] of lamps) {
    const row = components(page).filter({ hasText: name.replace(' part', '') });
    await expect(row).toContainText('新しい版あり');
    await row.click();
    await page
      .getByTestId('cad-component')
      .getByRole('button', { name: 'Change version…' })
      .click();
    const dialog = page.getByTestId('cad-update-parts');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.getByRole('table', { name: 'Changes' })).toContainText('→ v2');
    await dialog.getByRole('button', { name: 'Apply update' }).click();
    await ready(page);
  }
  await expect(state(page)).toHaveText('Shape up to date', { timeout: 600_000 });
  await expect(page.locator('.cad-part-newer')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The thicker lenses weigh a little more (PMMA; it may not show at the shown precision).
  await expect.poll(kg, { timeout: 300_000 }).toBeGreaterThanOrEqual(before);
  const after = await kg();
  test.info().annotations.push({ type: 'mass', description: `${before} → ${after} kg` });
  await page.screenshot({ path: test.info().outputPath('cr7g4-lamps.png') });

  // Saved and reloaded: the same seat, the same versions, the same mass.
  await save(page, 1);
  const saved = await nativeArtifact(page);
  await page.reload();
  await expect(page.getByLabel('Artifact name')).toHaveValue('Car');
  await expect(state(page)).toHaveText('Shape up to date', { timeout: 600_000 });
  const reloaded = await nativeArtifact(page);
  expect(reloaded.draft.content).toEqual(saved.draft.content);
  expect(reloaded.versions.map((v) => v.contentHash)).toEqual(
    saved.versions.map((v) => v.contentHash),
  );
  await expect.poll(seatX).toBe(x0 + 100);
  const parts = (reloaded.draft.content as CadDocument).parts;
  for (const id of ['part-headlamp-l', 'part-headlamp-r']) {
    const source = parts.find((p) => p.id === id)!.source;
    expect(source.kind === 'version' && source.versionId).toBeTruthy();
  }
  await expect.poll(kg, { timeout: 300_000 }).toBe(after);
});

// CLF1b (docs/cad/car-look-process.md, CLF1〜CLF3の分け方): the drawing board's three panes at
// one scale, and the silhouette shading. View state only. ST-502, TS-2007.
test('draw the side, front and plan at one scale, in silhouette (CLF1b)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const content = {
    ...f11Bracket(),
    kernelProfile: (empty.draft.content as CadDocument).kernelProfile,
  };
  await importJson(page, 'board.json', {
    ...empty,
    name: 'Board',
    draft: { ...empty.draft, content },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Board');
  await ready(page);
  await expect(bodies(page)).toHaveCount(1);
  const before = JSON.stringify((await nativeArtifact(page)).draft.content);
  // Black pixels in each quarter of the canvas (top left, top right, bottom left, bottom right).
  const quarters = async () => {
    const png = await page.locator('.cad-viewport canvas').first().screenshot();
    return page.evaluate(async (data) => {
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${data}`)).blob(),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d')!;
      g.drawImage(bitmap, 0, 0);
      const { width: w, height: h } = bitmap;
      const px = g.getImageData(0, 0, w, h).data;
      const n = [0, 0, 0, 0];
      let white = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = 4 * (y * w + x);
          const sum = px[i]! + px[i + 1]! + px[i + 2]!;
          if (sum < 60) n[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)]!++;
          if (sum > 750) white++;
        }
      return { n, white: white / (w * h) };
    }, png.toString('base64'));
  };
  await page.getByTestId('cad-shading').selectOption('silhouette');
  await expect.poll(async () => (await quarters()).white).toBeGreaterThan(0.5);
  const single = await quarters();
  expect(single.n.reduce((a, b) => a + b)).toBeGreaterThan(500);

  await page.getByTestId('cad-three-view-shown').check();
  const board = page.getByTestId('cad-three-view');
  await expect(board).toContainText('Side (XZ)');
  await expect(board).toContainText('Front (YZ)');
  await expect(board).toContainText('Plan (XY)');
  // A body in each of the three panes, none in the empty fourth.
  await expect.poll(async () => (await quarters()).n.slice(0, 3).every((v) => v > 200)).toBe(true);
  expect((await quarters()).n[3]).toBe(0);
  // A click on a pane picks nothing: the panes are not the camera picks go through.
  const canvas = page.locator('.cad-viewport canvas').first();
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 4, y: box.height / 4 } });
  await expect(bodies(page).first()).toHaveAttribute('aria-pressed', 'false');

  await page.getByTestId('cad-three-view-shown').uncheck();
  await expect(board).toHaveCount(0);
  await page.getByTestId('cad-shading').selectOption('shaded');
  await expect.poll(async () => (await quarters()).white).toBeLessThan(0.1);
  // View state only: the document is as it was.
  expect(JSON.stringify((await nativeArtifact(page)).draft.content)).toBe(before);
});

// CLF3 (docs/cad/car-look-process.md, 比率の指標, CLF1〜CLF3の分け方): the proportion indicators
// of F80 (the CL1 package) from its meshes, a band edited, undone, the setup removed and made
// again. ST-503, TS-2009.
test('read the car’s proportions against their bands, edit a band and undo it (CLF3)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'f80.json', {
    ...empty,
    name: 'F80',
    draft: { ...empty.draft, content: f80Package({ id, buildHash }) },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F80');
  await ready(page);
  await expect(bodies(page)).toHaveCount(6);
  const panel = page.getByTestId('cad-proportions');
  const row = (metric: string) => panel.locator(`li[data-metric="${metric}"]`);
  const value = (metric: string) => page.getByTestId(`cad-proportion-${metric}`);
  // The tyre's outer diameter over the height, from the tessellated wheel: 716 / 1130.
  await expect(value('wheelToHeight')).toHaveText(/^0\.6[23]$/);
  await expect(value('wheelbaseToLength')).toHaveText('0.61');
  await expect(value('frontOverhangToWheelbase')).toHaveText('0.36');
  await expect(value('glassToBody')).toHaveText('0.41');
  await expect(value('widthToHeight')).toHaveText('1.73');
  await expect(value('wheelToFender')).toHaveText('12.5 mm');
  for (const m of [
    'wheelToHeight',
    'wheelbaseToLength',
    'glassToBody',
    'widthToHeight',
    'wheelToFender',
  ])
    await expect(row(m)).toHaveAttribute('data-status', 'ok');
  await expect(row('frontOverhangToWheelbase')).toHaveAttribute('data-status', 'none');
  await panel.screenshot({ path: test.info().outputPath('clf3-proportions.png') });

  // A wider target: the car is now too tall for it.
  const min = panel.getByLabel('Width / height min');
  await min.fill('1.8');
  await min.press('Enter');
  await expect(row('widthToHeight')).toHaveAttribute('data-status', 'outside');
  await expect(row('widthToHeight')).toContainText('outside');
  const stored = async () =>
    ((await nativeArtifact(page)).draft.content as CadDocument).proportions;
  expect((await stored())?.targets.find((t) => t.metric === 'widthToHeight')).toEqual({
    metric: 'widthToHeight',
    min: 1.8,
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row('widthToHeight')).toHaveAttribute('data-status', 'ok');
  // A band upside down (min above max) is refused at the field; the stored band stays.
  const upside = panel.getByLabel('Wheelbase / length min');
  await upside.fill('0.7');
  await upside.press('Enter');
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(row('wheelbaseToLength')).toHaveAttribute('data-status', 'ok');
  // Another band edited meanwhile: the refused text stays in its field (#1114 review).
  const wide = panel.getByLabel('Width / height max');
  await wide.fill('3');
  await wide.press('Enter');
  // (An export waits while a field holds a refused value: the stored band is read below.)
  await expect(wide).toBeEnabled();
  await expect(upside).toBeEnabled();
  await expect(upside).toHaveValue('0.7');
  // Back to the stored value (an export waits for a field that holds a refused value).
  await upside.fill('0.58');
  await upside.press('Enter');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  // A ground past the model's ±10,000,000 mm is refused at the field too.
  const ground = panel.getByLabel('Ground (mm)');
  await ground.fill('10000001');
  await ground.press('Enter');
  await expect(panel.getByRole('alert')).toBeVisible();
  await ground.fill('0');
  await ground.press('Enter');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect((await stored())?.groundMm).toBe(0);
  expect((await stored())?.targets.find((t) => t.metric === 'wheelbaseToLength')).toEqual({
    metric: 'wheelbaseToLength',
    min: 0.58,
    max: 0.62,
  });
  expect((await stored())?.targets.find((t) => t.metric === 'widthToHeight')).toEqual({
    metric: 'widthToHeight',
    min: 1.6,
    max: 3,
  });

  // Removed, then made again with empty roles: nothing to measure until roles are chosen.
  await panel.getByRole('button', { name: 'Remove proportions' }).click();
  await expect(panel).toHaveCount(0);
  expect(await stored()).toBeUndefined();
  // Closed while there is no setup, to keep the list short.
  await page.locator('summary', { hasText: /^Proportions$/ }).click();
  await page.getByRole('button', { name: 'Set up proportions' }).click();
  await expect(value('wheelbaseToLength')).toHaveText('—');
  await panel.getByLabel('Front wheels').selectOption(['front-left-body', 'front-right-body']);
  // Each choice is its own edit: the next one starts from it.
  await expect.poll(async () => (await stored())?.frontWheels.length).toBe(2);
  await panel.getByLabel('Rear wheels').selectOption(['rear-left-body', 'rear-right-body']);
  // The wheels alone are the car's length now: 2650 over 3348.
  await expect(value('wheelbaseToLength')).toHaveText('0.79 outside');
  expect((await stored())?.rearWheels).toEqual(['rear-left-body', 'rear-right-body']);
});

// CLF-s (docs/cad/car-look-process.md, CLF1〜CLF3の分け方): the sample F80 through the whole
// toolset: the roof spanned from two-view curves, a side sketch drawn over the car's silhouette,
// the three-view board in silhouette and the proportion indicators. ST-504, TS-2010.
test('take the F80 package through the roof, the underlay, the board and the proportions (CLF-s)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'cad');
  await ready(page);
  const empty = await nativeArtifact(page);
  const kernel = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'f80-sample.json', {
    ...empty,
    name: 'F80 sample',
    draft: { ...empty.draft, content: f80Sample(kernel) },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F80 sample');
  await ready(page);
  await expect(bodies(page)).toHaveCount(6);

  // The roof: each u curve from its side arc and its plan line, across the v arcs.
  await page.getByRole('button', { name: 'Boundary…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Boundary' });
  await dialog.getByLabel('Result').selectOption('curveNetwork');
  for (const n of [0, 1, 2]) {
    await dialog.getByRole('checkbox', { name: `Roof v${n} arc`, exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'Across (v)' }).last().check();
  }
  for (const n of [0, 1, 2]) {
    await dialog.getByLabel('Side view').selectOption({ label: `Roof u${n} arc` });
    await dialog.getByLabel('Plan view').selectOption({ label: `Roof plan l${n}` });
    await dialog.getByRole('button', { name: 'Add two-view curve' }).click();
  }
  await dialog.getByRole('button', { name: 'Create curve network' }).click();
  await ready(page);
  await expect(bodies(page)).toHaveCount(7);
  await expect(page.getByText('Shape could not be calculated')).toHaveCount(0);
  const doc = (await nativeArtifact(page)).draft.content as CadDocument;
  const made = doc.features.find((f) => f.type === 'curveNetwork');
  const sample = f80Sample(kernel, true).features.find((f) => f.type === 'curveNetwork');
  expect(made?.args).toEqual(sample?.args);

  // A side sketch over the car's silhouette and the other roof sketches' lines.
  await page.getByRole('button', { name: 'Edit sketch Roof u1' }).click();
  const drawing = page.getByRole('application', { name: 'Drawing of Roof u1' });
  const under = drawing.getByTestId('cad-sketch-underlay');
  // One shadow of the shown bodies, the car's 4350 mm along X (u of a sketch parallel to XZ).
  const shadow = under.getByTestId('cad-sketch-shadow');
  await expect(shadow).toHaveCount(1);
  expect(Number(await shadow.getAttribute('width'))).toBeCloseTo(4350, 0);
  // The open sketch refuses document edits: the proportions are held (#1114 review).
  await expect(page.getByTestId('cad-proportions').getByLabel('Ground (mm)')).toBeDisabled();
  await page.getByRole('button', { name: 'Fit sketch', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('clf-s-underlay.png') });
  await page.getByTestId('cad-sketch-panel').getByRole('button', { name: 'Finish' }).click();
  await ready(page);

  // The board: side, front and plan at one scale, in silhouette.
  await page.getByTestId('cad-shading').selectOption('silhouette');
  await page.getByTestId('cad-three-view-shown').check();
  await expect(page.getByTestId('cad-three-view')).toContainText('Plan (XY)');
  await page
    .locator('.cad-viewport')
    .screenshot({ path: test.info().outputPath('clf-s-board.png') });
  await page.getByTestId('cad-three-view-shown').uncheck();
  await page.getByTestId('cad-shading').selectOption('shaded');

  // The proportions: the roof is in no role, so they read as F80's.
  const panel = page.getByTestId('cad-proportions');
  const value = (metric: string) => page.getByTestId(`cad-proportion-${metric}`);
  await expect(value('wheelbaseToLength')).toHaveText('0.61');
  await expect(value('glassToBody')).toHaveText('0.41');
  await expect(value('widthToHeight')).toHaveText('1.73');
  await expect(value('wheelToFender')).toHaveText('12.5 mm');
  await expect(panel.locator('li[data-status="outside"]')).toHaveCount(0);
  await panel.screenshot({ path: test.info().outputPath('clf-s-proportions.png') });
  await page.screenshot({ path: test.info().outputPath('clf-s-shaded.png') });
});
