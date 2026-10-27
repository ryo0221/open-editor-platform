import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  applyCadOperation,
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
  partVersionId,
  r1Housing,
  r2bParts,
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
  await placement.getByLabel('X (mm)').fill('1000001');
  await placement.getByRole('button', { name: 'Apply placement' }).click();
  await expect(page.getByText('値が許容範囲の外です。')).toBeVisible();
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
