import { f31BoxBuilding, f37Office, type BimDocument } from '@editor-platform/bim-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground does not offer Building.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const ready = (page: Page) =>
  expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', { timeout: 90_000 });
const inspector = (page: Page) => page.locator('.bim-inspector');
const elements = (page: Page) => page.getByRole('navigation', { name: 'Elements' });
async function panel(page: Page, name: 'Elements' | 'Inspector') {
  const region = name === 'Elements' ? elements(page) : inspector(page);
  if (!(await region.isVisible()))
    await page.getByRole('button', { name: `Toggle ${name}`, exact: true }).click();
}
async function importFile(page: Page, name: string, mimeType: string, buffer: Buffer) {
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({ name, mimeType, buffer });
}
const importJson = (page: Page, name: string, value: unknown) =>
  importFile(page, name, 'application/json', Buffer.from(JSON.stringify(value)));

test('create, edit, Undo, save a version, reload and round-trip native JSON', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  await expect(page.getByText('This building has no elements yet.')).toBeVisible();
  // With nothing selected the inspector edits the level.
  await panel(page, 'Inspector');
  const level = inspector(page).getByLabel('Level name', { exact: true });
  await expect(level).toHaveValue('1F');
  await level.fill('Ground');
  await level.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Level' })).toContainText('Ground');
  // Host history drives the session.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(level).toHaveValue('1F');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(level).toHaveValue('Ground');
  await save(page, 1);

  await page.reload();
  await ready(page);
  await panel(page, 'Inspector');
  await expect(inspector(page).getByLabel('Level name', { exact: true })).toHaveValue('Ground');

  const record = await nativeArtifact(page);
  expect(record.kind).toBe('bim');
  expect(record.versions).toHaveLength(1);
  expect((record.draft.content as BimDocument).levels[0]!.name).toBe('Ground');
  expect((record.versions[0]!.content as BimDocument).levels[0]!.name).toBe('Ground');

  // A building with elements, imported as native JSON, evaluates in the Playground.
  await importJson(page, 'box.json', {
    ...record,
    name: 'Box building',
    draft: { ...record.draft, content: f31BoxBuilding() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Box building');
  await ready(page);
  await panel(page, 'Elements');
  await elements(page).getByRole('button', { name: 'w-south', exact: true }).click();
  await panel(page, 'Inspector');
  await expect(inspector(page)).toContainText('wall · w-south');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('bim-playground.png') });
});

test('a narrow screen shows the building and its inspector', async ({ page }) => {
  test.skip(test.info().project.name === 'desktop', 'narrow flow');
  await page.goto('/');
  await create(page, 'bim');
  await ready(page);
  await panel(page, 'Inspector');
  await expect(inspector(page).getByLabel('Level name', { exact: true })).toHaveValue('1F');
  await page.screenshot({ path: test.info().outputPath('bim-playground-narrow.png') });
});

test('places a saved CAD version as a part, keeps it with the building and reads it back', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  // A 3D CAD part with one saved version.
  await create(page, 'cad');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const addPlate = page.getByRole('button', { name: 'Add plate', exact: true });
  if (!(await addPlate.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await addPlate.click();
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const cadName = await page.getByLabel('Artifact name').inputValue();
  await save(page, 1);

  await create(page, 'bim');
  await ready(page);
  await panel(page, 'Inspector');
  await inspector(page).getByRole('tab', { name: 'Types' }).click();
  await inspector(page).getByRole('button', { name: 'Add part from CAD…' }).click();
  await inspector(page)
    .getByRole('button', { name: `Add ${cadName}`, exact: true })
    .click();
  await expect(
    inspector(page).getByRole('button', { name: new RegExp(`^${cadName} v1`) }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Part', exact: true }).click();
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('1 elements');
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  await save(page, 1);

  const record = await nativeArtifact(page);
  const content = record.draft.content as BimDocument;
  const type = content.types.find((t) => t.kind === 'part')!;
  expect(type).toMatchObject({ kind: 'part', source: { versionId: expect.any(String) } });
  expect(record.cadParts?.map((p) => p.contentHash)).toEqual([
    type.kind === 'part' && type.source.contentHash,
  ]);
  expect(content.elements).toMatchObject([{ kind: 'part', typeId: type.id }]);

  // After a reload the shape is read again from the version the building keeps.
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('1 elements');
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  await page.getByRole('button', { name: 'Fit view', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('bim-part.png') });
});

/** F37 as the file holds it: elements by ID, without the GlobalIds an IFC import keeps. */
function comparable(doc: BimDocument) {
  const d = structuredClone(doc);
  d.levels.sort((a, b) => a.elevationMm - b.elevationMm);
  d.elements.sort((a, b) => a.id.localeCompare(b.id));
  for (const e of d.elements) delete e.ifcGlobalId;
  return d;
}
const count = (text: string, entity: string) => text.split(`=${entity}(`).length - 1;

test('F37: an office building is placed, saved, reloaded, round-tripped, written as IFC and drawn', async ({
  page,
}) => {
  // CAD69 (R2c-6): the representative building through the whole Playground flow.
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(900_000);
  const fs = await import('node:fs/promises');
  const read = async (d: { path(): Promise<string | null> }) => fs.readFile((await d.path())!);
  await page.goto('/');
  // A 3D CAD part with one saved version, to place in the building.
  await create(page, 'cad');
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const addPlate = page.getByRole('button', { name: 'Add plate', exact: true });
  if (!(await addPlate.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await addPlate.click();
  await expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
  const cadName = await page.getByLabel('Artifact name').inputValue();
  await save(page, 1);

  // F37 (six levels, 766 elements) and its X3 section, as a native building file.
  await create(page, 'bim');
  await ready(page);
  const template = await nativeArtifact(page);
  const office = f37Office();
  office.views = [
    {
      id: 'v-x3',
      kind: 'section',
      name: 'X3 section',
      line: [
        [14400, -2000],
        [14400, 30800],
      ],
      direction: 'left',
      depthMm: 20000,
      scale: 100,
    },
  ];
  await importJson(page, 'office.json', {
    ...template,
    name: 'Office',
    draft: { ...template.draft, content: office },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Office');
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('766 elements');

  // On 2F: the CAD version as a part type, one part placed, and the 2F plan.
  await page.getByRole('combobox', { name: 'Level' }).selectOption({ label: '2F' });
  await panel(page, 'Inspector');
  await inspector(page).getByRole('tab', { name: 'Types' }).click();
  await inspector(page).getByRole('button', { name: 'Add part from CAD…' }).click();
  await inspector(page)
    .getByRole('button', { name: `Add ${cadName}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Part', exact: true }).click();
  const box = (await page.getByTestId('bim-viewport').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('767 elements');
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  await page.getByRole('button', { name: '3D view', exact: true }).click();
  await inspector(page).getByRole('tab', { name: 'Drawings' }).click();
  await inspector(page).getByRole('button', { name: 'Add plan of 2F' }).click();
  await save(page, 1);

  // Reload, then the native file round trip: the same content and the part version with it.
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('767 elements');
  const saved = await nativeArtifact(page);
  const content = saved.draft.content as BimDocument;
  expect(content.views.map((v) => v.name).sort()).toEqual(['2F plan', 'X3 section']);
  expect(saved.versions).toHaveLength(1);
  expect(saved.cadParts).toHaveLength(1);
  await importJson(page, 'office-copy.json', { ...saved, name: 'Office copy' });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Office copy');
  await ready(page);
  const copy = await nativeArtifact(page);
  expect(copy.draft.content).toEqual(content);
  expect(copy.versions.map((v) => v.contentHash)).toEqual(saved.versions.map((v) => v.contentHash));
  expect(copy.cadParts).toEqual(saved.cadParts);

  // IFC4 of the whole building: levels, elements, types and the part with its version.
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  const [ifcFile] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByRole('button', { name: 'Export IFC', exact: true }).click(),
  ]);
  expect(ifcFile.suggestedFilename()).toBe('Office copy.ifc');
  const ifc = (await read(ifcFile)).toString('utf8');
  expect(ifc).toContain("FILE_SCHEMA(('IFC4'))");
  expect(count(ifc, 'IFCBUILDINGSTOREY')).toBe(6);
  expect(count(ifc, 'IFCWALL')).toBe(25);
  expect(count(ifc, 'IFCCOLUMN')).toBe(175);
  expect(count(ifc, 'IFCBEAM')).toBe(290);
  expect(count(ifc, 'IFCDOOR')).toBe(60);
  expect(count(ifc, 'IFCWINDOW')).toBe(200);
  expect(count(ifc, 'IFCWALLTYPE')).toBeGreaterThan(0);
  expect(ifc).toContain("'EP_PartReference'");
  expect(ifc).toContain('IFCFACETEDBREP');

  // That IFC imported is the same building, its part read from the same CAD version.
  await importFile(page, 'office-ifc.ifc', 'application/x-step', Buffer.from(ifc));
  await expect(page.getByLabel('Artifact name')).toHaveValue('office-ifc');
  await expect(page.getByTestId('bim-ifc-report')).toHaveCount(0);
  await ready(page);
  await expect(page.getByTestId('bim-surface')).toContainText('767 elements');
  await expect(page.getByTestId('bim-surface')).not.toContainText('not built');
  const imported = await nativeArtifact(page);
  expect(comparable(imported.draft.content as BimDocument)).toEqual(comparable(content));
  expect(imported.cadParts).toEqual(saved.cadParts);

  // The 2F plan and the X3 section of the imported building, as SVG and PNG.
  await panel(page, 'Inspector');
  await inspector(page).getByRole('tab', { name: 'Drawings' }).click();
  const state = page.getByTestId('bim-drawing-state');
  const svgs: Record<string, string> = {};
  for (const [view, file] of [
    ['2F plan', 'office-ifc - 2F plan'],
    ['X3 section', 'office-ifc - X3 section'],
  ] as const) {
    await inspector(page)
      .getByRole('button', { name: new RegExp(`^${view}`) })
      .click();
    await inspector(page).getByRole('button', { name: 'Open drawing' }).click();
    await expect(state).toHaveText('Drawing up to date', { timeout: 300_000 });
    await expect(page.locator('.bim-drawing [role="status"]')).toHaveCount(0);
    const [svg] = await Promise.all([
      page.waitForEvent('download', { timeout: 300_000 }),
      page.getByRole('button', { name: 'Export SVG' }).click(),
    ]);
    expect(svg.suggestedFilename()).toBe(`${file}.svg`);
    svgs[view] = (await read(svg)).toString('utf8');
    const [png] = await Promise.all([
      page.waitForEvent('download', { timeout: 300_000 }),
      page.getByRole('button', { name: 'Export PNG' }).click(),
    ]);
    expect(png.suggestedFilename()).toBe(`${file}.png`);
    expect((await read(png)).subarray(1, 4).toString()).toBe('PNG');
    await page.screenshot({ path: test.info().outputPath(`f37-${view.replace(' ', '-')}.png`) });
    await page.getByRole('button', { name: 'Close drawing', exact: true }).first().click();
  }
  // The plan cuts the 2F walls and columns; the section cuts the slabs and beams on X3.
  expect(svgs['2F plan']).toContain('class="cut cut-wall');
  expect(svgs['2F plan']).toContain('class="cut cut-column');
  expect(svgs['X3 section']).toContain('class="cut cut-slab');
  expect(svgs['X3 section']).toContain('class="cut cut-beam');
  await fs.writeFile(test.info().outputPath('f37-2F-plan.svg'), svgs['2F plan']!);
  await fs.writeFile(test.info().outputPath('f37-X3-section.svg'), svgs['X3 section']!);
});
