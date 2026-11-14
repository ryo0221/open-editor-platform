import {
  applyCadOperation,
  f01Empty,
  faceRef,
  f02Plate,
  f22Split,
  f29Biw,
  identityQuaternion,
  mm,
  position,
  sportsCarBody,
  sportsCarBonnet,
  type CadDocument,
  type CadTopologyRef,
} from '@editor-platform/cad-core';
import {
  applySimulationOperation,
  simulationMaterialPresets,
  type SimulationDocument,
} from '@editor-platform/simulation-core';
import { spawnSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground offers neither CAD nor
// structural analysis.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const cadReady = (page: Page) =>
  expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
    timeout: 90_000,
  });
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

// R3e-4a (docs/cad/r3-analysis.md, 代表操作1): a saved version of a 3D CAD part is analysed —
// created from the library, its material and mesh edited through the Host's history, saved,
// reloaded and exported with the analysed version kept beside it.
test('create an analysis of a saved CAD version, edit, Undo, reload and export (FE50, R3e-4a)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  // Without a saved CAD version there is nothing to analyse.
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Artifact type', { exact: true }).selectOption('simulation');
  await expect(
    page.getByText('Save a version of a 3D CAD part with a solid body first.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ New artifact' })).toBeDisabled();

  await create(page, 'cad');
  await cadReady(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'plate.json', {
    ...empty,
    name: 'Plate',
    draft: { ...empty.draft, content: { ...f02Plate(), kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Plate');
  await cadReady(page);
  await save(page, 1);

  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Artifact type', { exact: true }).selectOption('simulation');
  const part = page.getByLabel('Part to analyse', { exact: true });
  // The tool body the hole consumed is not offered.
  await expect(part.locator('option')).toHaveText(['Plate · v1 · plate']);
  await page.getByRole('button', { name: '＋ New artifact' }).click();
  const surface = page.getByRole('region', { name: 'Structural analysis' });
  await expect(surface.getByText('Analyses Plate · v1 · plate')).toBeVisible();
  const modulus = surface.getByLabel("Young's modulus (MPa)", { exact: true });
  await expect(modulus).toHaveValue('210000');

  await surface.getByLabel('Material preset', { exact: true }).selectOption('Aluminium 6061-T6');
  await expect(modulus).toHaveValue('68900');
  // A cleared field goes back to its value: it never becomes 0.
  const poisson = surface.getByLabel("Poisson's ratio", { exact: true });
  const ratio = await poisson.inputValue();
  await poisson.fill('');
  await poisson.press('Enter');
  await expect(poisson).toHaveValue(ratio);
  const size = surface.getByLabel('Element size (mm)', { exact: true });
  await size.fill('4');
  await size.press('Enter');
  await expect(size).toHaveValue('4');
  await expect(
    surface.getByText(/^A study is made once there is a load and a constraint;/),
  ).toBeVisible();
  // The Host's history drives the session.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(size).toHaveValue('5');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(modulus).toHaveValue('210000');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(modulus).toHaveValue('68900');
  await expect(size).toHaveValue('4');
  // A value outside the model is refused with its reason, and nothing changes.
  await size.fill('-1');
  await size.press('Enter');
  await expect(surface.getByRole('alert')).toContainText('Not applied');
  await expect(size).toHaveValue('4');
  // A value still being typed is committed by the save boundary before the version is read.
  await size.fill('3');
  await page.keyboard.press('Control+s');
  await expect
    .poll(async () => {
      const r = await nativeArtifact(page);
      return (r.versions.at(-1)?.content as SimulationDocument | undefined)?.mesh.size;
    })
    .toBe(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(size).toHaveValue('4');

  await page.reload();
  await expect(modulus).toHaveValue('68900');
  await expect(size).toHaveValue('4');
  const record = await nativeArtifact(page);
  expect(record.kind).toBe('simulation');
  const doc = record.draft.content as SimulationDocument;
  expect(doc.source.bodyId).toBe('plate');
  expect(doc.materials.find((m) => m.id === doc.materialId)!.youngsModulus).toBe(68_900);
  expect(record.simulationSources).toHaveLength(1);
  expect(record.simulationSources![0]!.contentHash).toBe(doc.source.contentHash);
});

/** R3i-5: the F02 plate without its hole, an extrude alone (its midsurface is at half its height). */
const slab = (): CadDocument =>
  applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    profiles: [
      {
        id: 'plate-profile',
        name: 'Plate outline',
        plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
        shape: { type: 'rectangle', width: mm(80), height: mm(50) },
      },
    ],
    features: [
      {
        id: 'plate-extrude',
        name: 'Plate',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'plate-profile', distance: mm(5), direction: 1 },
      },
    ],
    bodies: [
      {
        id: 'plate',
        name: 'plate',
        sourceFeatureId: 'plate-extrude',
        placementFeatureId: 'plate-placement',
        appearance: { color: '#9aa4b1', opacity: 1 },
      },
    ],
  });

async function analysePlate(page: Page, content: CadDocument = f02Plate()) {
  await page.goto('/');
  await create(page, 'cad');
  await cadReady(page);
  const empty = await nativeArtifact(page);
  const kernelProfile = (empty.draft.content as CadDocument).kernelProfile;
  await importJson(page, 'plate.json', {
    ...empty,
    name: 'Plate',
    draft: { ...empty.draft, content: { ...content, kernelProfile } },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Plate');
  await cadReady(page);
  await save(page, 1);
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Artifact type', { exact: true }).selectOption('simulation');
  await page.getByRole('button', { name: '＋ New artifact' }).click();
  return page.getByRole('region', { name: 'Structural analysis' });
}

// R3e-4b (docs/cad/r3-analysis.md, 代表操作1): the analysed body is shown; faces picked in the
// view become a fixed support and a force, which make the study; values are edited, an item is
// retargeted and removed through the Host's history.
test('pick faces for a fixed support and a force, which make the study (FE50, R3e-4b)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  const surface = await analysePlate(page);
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const add = (name: string) => surface.getByRole('button', { name, exact: true });
  await expect(add('Add fixed support')).toBeDisabled();
  // A click selects the face under it and a second click on it clears it.
  await at(0.4, 0.45);
  await expect(surface.getByText('1 face selected.')).toBeVisible();
  await at(0.4, 0.45);
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible();
  await at(0.4, 0.45);
  await add('Add fixed support').click();
  await expect(surface.getByRole('listitem', { name: 'Fixed 1' })).toContainText('1 face');
  await expect(
    surface.getByText(/^A study is made once there is a load and a constraint;/),
  ).toBeVisible();
  await at(0.455, 0.63);
  await add('Add force').click();
  const force = surface.getByRole('listitem', { name: 'Force 1' });
  await expect(force).toContainText('1 face');
  await expect(surface.getByText(/Static.*1 load, 1 constraint/)).toBeVisible();
  const fz = surface.getByLabel('Force 1 Fz (N)', { exact: true });
  await fz.fill('-500');
  await fz.press('Enter');
  await expect(fz).toHaveValue('-500');
  // A pressure joins the study; removing it takes it out again.
  await at(0.4, 0.45);
  await add('Add pressure').click();
  await expect(surface.getByText(/Static.*2 loads, 1 constraint/)).toBeVisible();
  await surface
    .getByRole('listitem', { name: 'Pressure 1' })
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await expect(surface.getByText(/Static.*1 load, 1 constraint/)).toBeVisible();
  // Undo brings the pressure back (the Host's history).
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(surface.getByText(/Static.*2 loads, 1 constraint/)).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(surface.getByRole('listitem', { name: 'Pressure 1' })).toHaveCount(0);
  // The fixed support moves to two picked faces.
  await at(0.4, 0.45);
  await at(0.455, 0.63);
  await expect(surface.getByText('2 faces selected.')).toBeVisible();
  await surface
    .getByRole('listitem', { name: 'Fixed 1' })
    .getByRole('button', { name: 'Use selected faces', exact: true })
    .click();
  await expect(surface.getByRole('listitem', { name: 'Fixed 1' })).toContainText('2 faces');

  await page.reload();
  await expect(surface.getByText(/Static.*1 load, 1 constraint/)).toBeVisible();
  await expect(surface.getByLabel('Force 1 Fz (N)', { exact: true })).toHaveValue('-500');
  const doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.constraints).toMatchObject([{ kind: 'fixed', name: 'Fixed 1' }]);
  expect(doc.constraints[0]!.targets).toHaveLength(2);
  for (const t of doc.constraints[0]!.targets)
    expect(t).toMatchObject({ kind: 'face', ref: { kind: 'face', featureId: expect.any(String) } });
  expect(doc.loads).toMatchObject([{ kind: 'force', force: [0, 0, -500] }]);
  expect(doc.studies).toMatchObject([
    { loadIds: [doc.loads[0]!.id], constraintIds: [doc.constraints[0]!.id] },
  ]);
  // The faces the items were given are drawn on the shown body.
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  await canvas.screenshot({ path: test.info().outputPath('marks.png') });
});

// CR0b (docs/cad/car-design.md, S2a): the body's own weight and a part's weight carried by a
// picked face, as an equivalent static load (a force of m g); both enter the static study only.
// Edited through the Host's history, kept by a reload, and solved with the other checks.
test('add gravity and a part’s weight as an equivalent static load, then run (FE50, CR0b)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  const surface = await analysePlate(page);
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await at(0.4, 0.45);
  await button('Add fixed support').click();
  // Gravity needs no face; it makes the static study with the support.
  await button('Add gravity').click();
  const gravity = surface.getByRole('listitem', { name: 'Gravity 1' });
  await expect(gravity).toContainText('every body, static studies');
  await expect(surface.getByLabel('Gravity 1 gz (mm/s²)', { exact: true })).toHaveValue('-9806.65');
  await expect(button('Add gravity')).toBeDisabled();
  await expect(surface.getByText(/Static.*1 load, 1 constraint/)).toBeVisible();
  // A 50 kg part on the other face: a force of 50 kg × 9.80665 m/s² down.
  await expect(button('Add weight')).toBeDisabled();
  await set('Weight (kg)', '50');
  await at(0.455, 0.63);
  await button('Add weight').click();
  await expect(surface.getByRole('listitem', { name: 'Weight 50 kg' })).toContainText('1 face');
  await expect(surface.getByLabel('Weight 50 kg Fz (N)', { exact: true })).toHaveValue('-490.3325');
  await expect(surface.getByText(/Static.*2 loads, 1 constraint/)).toBeVisible();
  // Undo and Redo through the Host's history.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(surface.getByRole('listitem', { name: 'Weight 50 kg' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(surface.getByRole('listitem', { name: 'Weight 50 kg' })).toBeVisible();
  await page.reload();
  await expect(surface.getByText(/Static.*2 loads, 1 constraint/)).toBeVisible();
  const doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.loads).toMatchObject([
    { kind: 'gravity', name: 'Gravity 1', acceleration: [0, 0, -9806.65] },
    { kind: 'force', name: 'Weight 50 kg', force: [0, 0, -490.3325] },
  ]);
  // The modal study takes neither.
  await button('Add modal study').click();
  expect(
    ((await nativeArtifact(page)).draft.content as SimulationDocument).studies.map((s) => [
      s.kind,
      s.loadIds.length,
    ]),
  ).toEqual([
    ['linear-static', 2],
    ['modal', 0],
  ]);
  await surface.getByLabel('Study', { exact: true }).selectOption({ label: 'Static' });

  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  await set('Element size (mm)', '20');
  await set('Smallest element size (mm)', '4');
  await set('Convergence mesh levels', '2');
  await set('Solver iteration limit', '200000');
  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only|Failed)/, { timeout: 480_000 });
  const run = await surface.getByRole('group', { name: 'Run', exact: true }).innerText();
  expect(run).not.toMatch(/^Failed/m);
  await canvas.screenshot({ path: test.info().outputPath('gravity-weight.png') });
});

// CR5a (docs/cad/car-design.md, S2b): a part's mass carried by a picked face, in every study: it
// takes no place in the study lists, counts in the modal `mass` check and lowers the frequencies.
test('add a part’s mass on a face, edit it, and run the modal study with it (FE50, CR5a)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  const surface = await analysePlate(page);
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await at(0.4, 0.45);
  await button('Add fixed support').click();
  await button('Add modal study').click();
  await expect(button('Add mass')).toBeDisabled();
  await set('Weight (kg)', '0.2');
  await at(0.455, 0.63);
  await button('Add mass').click();
  const item = surface.getByRole('listitem', { name: 'Mass 0.2 kg' });
  await expect(item).toContainText('1 face, every study');
  await set('Mass 0.2 kg mass (kg)', '0.15');
  // Undo the edit and Redo it through the Host's history, then reload.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(surface.getByLabel('Mass 0.2 kg mass (kg)', { exact: true })).toHaveValue('0.2');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(surface.getByLabel('Mass 0.2 kg mass (kg)', { exact: true })).toHaveValue('0.15');
  await page.reload();
  await expect(surface.getByLabel('Mass 0.2 kg mass (kg)', { exact: true })).toHaveValue('0.15');
  const doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.masses).toMatchObject([{ name: 'Mass 0.2 kg', mass: 0.00015 }]);
  expect(doc.masses![0]!.targets).toHaveLength(1);
  // The modal study lists no load: the mass is not one.
  expect(doc.studies.map((s) => [s.kind, s.loadIds.length])).toEqual([['modal', 0]]);

  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  await set('Element size (mm)', '20');
  await set('Smallest element size (mm)', '4');
  await set('Convergence mesh levels', '1');
  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only|Failed)/, { timeout: 480_000 });
  const run = await surface.getByRole('group', { name: 'Run', exact: true }).innerText();
  expect(run).not.toMatch(/^Failed/m);
  await button('Record result').click();
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(page)).draft.content as SimulationDocument).runs?.length ?? 0,
    )
    .toBe(1);
  const record = (await nativeArtifact(page)).draft.content as SimulationDocument;
  const mass = record.runs![0]!.checks.find((c) => c.name === 'mass')!;
  expect(mass.pass).toBe(true);
  expect(mass.detail).toContain('0.00015 t added');
  // Removing it leaves no `masses` behind.
  await surface
    .getByRole('listitem', { name: 'Mass 0.2 kg' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(surface.getByRole('listitem', { name: 'Mass 0.2 kg' })).toHaveCount(0);
  expect(((await nativeArtifact(page)).draft.content as SimulationDocument).masses).toBeUndefined();
});

// R3e-4c (docs/cad/r3-analysis.md, 代表操作3・4): the study runs in a Worker with the kernel and
// Netgen, shows its progress, its state and levels, the colour map on the deformed shape, exports
// a VTU and can be cancelled. Needs the Netgen build (FEM_MESHER_DIST) as well.
test('run the study, look at the colour map and export a VTU (FE50, R3e-4c)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  const surface = await analysePlate(page);
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await at(0.4, 0.45);
  await button('Add fixed support').click();
  await at(0.455, 0.63);
  await button('Add force').click();
  // Two coarse levels (20 and 14.1 mm): a finer F02 level can leave one sliver the shape check
  // refuses (#806). The thin plate needs more PCG iterations.
  await set('Element size (mm)', '20');
  await set('Smallest element size (mm)', '4');
  await set('Convergence mesh levels', '2');
  await set('Solver iteration limit', '200000');

  // A run can be cancelled; nothing is kept.
  await button('Run study').click();
  await button('Cancel run').click();
  await expect(button('Run study')).toBeEnabled();

  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only|Failed)/, { timeout: 480_000 });
  // The reason is on the panel when it failed.
  expect(await surface.getByRole('group', { name: 'Run', exact: true }).innerText()).not.toMatch(
    /^Failed$/m,
  );
  const rows = surface.locator('.simulation-levels tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(surface.getByLabel('Shown view', { exact: true })).toHaveValue('result');
  await expect(surface.getByLabel('von Mises stress legend', { exact: true })).toBeVisible();
  await canvas.screenshot({ path: test.info().outputPath('von-mises.png') });
  await surface.getByLabel('Result field', { exact: true }).selectOption('displacement');
  await expect(surface.getByLabel('Displacement legend', { exact: true })).toBeVisible();
  await canvas.screenshot({ path: test.info().outputPath('displacement.png') });
  // R3e-5d: the principal stresses (FE50 operation 3).
  await surface.getByLabel('Result field', { exact: true }).selectOption('max-principal');
  await expect(surface.getByLabel('Max principal stress legend', { exact: true })).toBeVisible();
  await canvas.screenshot({ path: test.info().outputPath('max-principal.png') });
  await surface.getByLabel('Result field', { exact: true }).selectOption('min-principal');
  await expect(surface.getByLabel('Min principal stress legend', { exact: true })).toBeVisible();
  await surface.getByLabel('Result field', { exact: true }).selectOption('displacement');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    button('Export VTU').click(),
  ]);
  const text = await (await download.createReadStream()).toArray();
  const vtu = Buffer.concat(text).toString('utf8');
  expect(vtu).toContain('<VTKFile type="UnstructuredGrid"');
  expect(vtu).toContain('von Mises (MPa)');
  expect(vtu).toContain('Max principal stress (MPa)');

  // R3e-4d: a section along Z through the middle, and a value read on its cut.
  await surface.getByLabel('Section axis', { exact: true }).selectOption('2');
  await surface.getByLabel('Section place', { exact: true }).fill('0.5');
  await expect(surface.getByText(/Section place\s*2\.5\d* mm/)).toBeVisible();
  await canvas.screenshot({ path: test.info().outputPath('section.png') });
  const value = surface.getByLabel('Point value', { exact: true });
  await expect(value).toHaveText('Click the result to read a value.');
  await at(0.4, 0.45);
  await expect(value).toHaveText(/^Displacement: \S+ mm at \(/);
  await surface.getByLabel('Section axis', { exact: true }).selectOption('none');

  // The exported VTU opens again for display; a malformed one is refused with its reason.
  const open = surface.getByLabel('Open VTU', { exact: true });
  await open.setInputFiles({
    name: 'plate.vtu',
    mimeType: 'application/xml',
    buffer: Buffer.from(vtu),
  });
  await expect(surface.getByText('Opened plate.vtu (display only).')).toBeVisible();
  await expect(surface.getByLabel('Result field', { exact: true }).locator('option')).toHaveText([
    'Displacement (mm)',
    'von Mises (MPa)',
    'Max principal stress (MPa)',
    'Min principal stress (MPa)',
    'Reaction (N)',
  ]);
  await expect(button('Export VTU')).toHaveCount(0);
  await canvas.screenshot({ path: test.info().outputPath('opened-vtu.png') });
  await button('Close VTU').click();
  await expect(surface.getByText('The finest level of the run.')).toBeVisible();
  await open.setInputFiles({
    name: 'bad.vtu',
    mimeType: 'application/xml',
    buffer: Buffer.from('<x/>'),
  });
  await expect(
    surface.getByRole('group', { name: 'Result', exact: true }).getByRole('alert'),
  ).toContainText('Not opened: result-invalid');

  // Editing the analysis marks the shown run as out of date.
  await set('Element size (mm)', '15');
  await expect(state).toContainText('out of date');
  // The setup view comes back for editing.
  await surface.getByLabel('Shown view', { exact: true }).selectOption('setup');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible();
});

test('prepare the shape and mesh a picked face finer, then run (FE50 operation 2, R3e-5a)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  const surface = await analysePlate(page);
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await at(0.4, 0.45);
  await button('Add fixed support').click();
  await at(0.455, 0.63);
  await button('Add force').click();
  await set('Element size (mm)', '20');
  await set('Smallest element size (mm)', '4');
  await set('Convergence mesh levels', '1');
  await set('Solver iteration limit', '200000');

  // Small holes and fillets are removed from the analysed shape only.
  await surface.getByLabel(/Remove holes below/).check();
  await expect(surface.getByLabel('Hole diameter (mm)', { exact: true })).toHaveValue('3');
  await surface.getByLabel(/Remove fillets below/).check();
  await set('Fillet radius (mm)', '0.5');

  // The loaded face gets a finer size, starting at half the element size.
  await at(0.455, 0.63);
  await button('Finer size on selected faces').click();
  const sizes = surface.getByRole('list', { name: 'Finer mesh sizes' });
  await expect(sizes.getByRole('listitem')).toHaveCount(1);
  await expect(surface.getByLabel('Finer size 1 (mm)', { exact: true })).toHaveValue('10');
  // The same face again adds nothing, and a size below the smallest is refused with the reason.
  await at(0.455, 0.63);
  await button('Finer size on selected faces').click();
  await expect(surface.getByRole('alert').first()).toContainText('already have a finer size');
  const finer = surface.getByLabel('Finer size 1 (mm)', { exact: true });
  await finer.fill('1');
  await finer.press('Enter');
  await expect(surface.getByRole('alert').first()).toContainText('mesh-size-order');
  await set('Finer size 1 (mm)', '8');
  await canvas.screenshot({ path: test.info().outputPath('finer-face.png') });

  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });
  await expect(surface.locator('.simulation-levels tbody tr')).toHaveCount(1);

  // Removing the finer size is one Undo step.
  await sizes.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(sizes).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(sizes.getByRole('listitem')).toHaveCount(1);
});

// R3e-5b (docs/cad/r3-analysis.md, 代表操作5): a thicker plate saved as v2 replaces the analysed
// version; the loads and constraints are resolved again on it (by name, never by nearness), the
// study runs, and Undo returns to v1.
test('switch the analysis to a newer CAD version and run it again (FE50 operation 5, R3e-5b)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  let surface = await analysePlate(page);
  const shown = () =>
    expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
      timeout: 90_000,
    });
  await shown();
  const canvas = () => surface.locator('.simulation-viewport canvas');
  const box = (await canvas().boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas().click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await at(0.4, 0.45);
  await button('Add fixed support').click();
  await at(0.455, 0.63);
  await button('Add force').click();
  await set('Element size (mm)', '20');
  await set('Smallest element size (mm)', '4');
  await set('Convergence mesh levels', '1');
  await set('Solver iteration limit', '200000');
  // With only v1 saved there is nothing to switch to.
  await expect(surface.getByLabel('CAD version', { exact: true })).toHaveCount(0);

  // The plate gets thicker and is saved as v2.
  const nav = page.getByRole('navigation', { name: 'Artifacts', exact: true });
  if (!(await nav.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await nav.getByRole('button', { name: /Plate/ }).click();
  await cadReady(page);
  await page
    .getByRole('list', { name: 'Parameters' })
    .getByRole('button', { name: /Thickness/ })
    .click();
  const value = page.locator('.cad-inspector').getByLabel('Value (mm)');
  await value.fill('8');
  await value.press('Enter');
  await cadReady(page);
  await save(page, 2);
  if (!(await nav.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await nav.getByRole('button', { name: /Structural analysis/ }).click();
  surface = page.getByRole('region', { name: 'Structural analysis' });
  await shown();

  const version = surface.getByLabel('CAD version', { exact: true });
  await expect(version.locator('option')).toHaveText(['v1', 'v2']);
  await version.selectOption({ label: 'v2' });
  await expect(surface.getByText('Analyses Plate · v2 · plate')).toBeVisible();
  await shown();
  // Both items resolve on v2: no face is missing on the shown shape.
  const items = surface.getByRole('list', { name: 'Loads and constraints' });
  await expect(items.getByRole('listitem')).toHaveCount(2);
  await expect(items).not.toContainText('not found');
  await canvas().screenshot({ path: test.info().outputPath('v2.png') });

  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });

  // The switch is one Undo step.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(surface.getByText('Analyses Plate · v1 · plate')).toBeVisible();
  await expect(state).toContainText('out of date');
});

// R3e-5c (docs/cad/r3-analysis.md, 評価記録 and 代表操作4): the shown run is recorded with the
// analysis as one Undo step and kept through a reload; an edit makes the record out of date.
test('record the run with the analysis and see it go out of date (FE50 operation 4, R3e-5c)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  const surface = await analysePlate(page);
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const canvas = surface.locator('.simulation-viewport canvas');
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await at(0.4, 0.45);
  await button('Add fixed support').click();
  await at(0.455, 0.63);
  await button('Add force').click();
  await set('Element size (mm)', '20');
  await set('Smallest element size (mm)', '4');
  await set('Convergence mesh levels', '1');
  await set('Solver iteration limit', '200000');
  // Nothing to record before a run.
  await expect(surface.getByRole('group', { name: 'Recorded result' })).toHaveCount(0);

  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });
  const note = surface.getByLabel('Recorded run', { exact: true });
  await expect(note).toHaveText('No run is recorded for this study.');
  await button('Record result').click();
  await expect(note).toHaveText(/^(Verified|Reference only), 1 level: max \|u\| /);
  await expect(note).not.toContainText('out of date');
  // Recording leaves the shown run current.
  await expect(state).not.toContainText('out of date');
  await expect
    .poll(async () => {
      const r = await nativeArtifact(page);
      return (r.draft.content as SimulationDocument).runs?.length ?? 0;
    })
    .toBe(1);
  const stored = ((await nativeArtifact(page)).draft.content as SimulationDocument).runs![0]!;
  expect(stored.levels).toHaveLength(1);
  expect(stored.inputs.mesherBuild).toBeTruthy();

  // An edit makes the record out of date; Undo makes it current again.
  await set('Element size (mm)', '18');
  await expect(note).toContainText('out of date');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(note).not.toContainText('out of date');

  await page.reload();
  await expect(surface.getByLabel('Recorded run', { exact: true })).toHaveText(
    /^(Verified|Reference only), 1 level: /,
    { timeout: 90_000 },
  );
});

// R3f-3 (docs/cad/r3-analysis.md A2, FE60): the dev server's reference Host runs CalculiX. The
// Surface says what is sent where before the run; a run on the Host can be cancelled; a mesh the
// browser refuses as too large is solved there, with the same checks.
test('solve a study on the reference Host, cancel one, and solve one too large for the browser (FE60, R3f-3)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.skip(
    !/Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`),
    'CalculiX (ccx) is not installed on this server',
  );
  test.setTimeout(900_000);
  const surface = await analysePlate(page);
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await at(0.4, 0.45);
  await button('Add fixed support').click();
  await at(0.455, 0.63);
  await button('Add force').click();
  await set('Element size (mm)', '20');
  await set('Smallest element size (mm)', '4');
  await set('Convergence mesh levels', '1');
  await set('Solver iteration limit', '200000');

  const onHost = 'Run on Reference Host (CalculiX)';
  await expect(surface.getByLabel('What a Host run sends', { exact: true })).toHaveText(
    /sends this development server the mesh \(node coordinates and elements\), E and ν, the held nodes and the nodal forces, nothing else: no CAD document, names or sign-in\. It takes up to 200,000 nodes and 140,000 elements\./,
  );
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  // Cancelled while it is on the Host: the Host job stops too (its folder is removed).
  await button(onHost).click();
  await expect(state).toHaveText(/solving on Reference Host \(CalculiX\)/, { timeout: 120_000 });
  await button('Cancel run').click();
  await expect(button(onHost)).toBeEnabled();

  await button(onHost).click();
  await expect(state).toHaveText(/^(Verified|Reference only|Failed)/, { timeout: 300_000 });
  const panel = surface.getByRole('group', { name: 'Run', exact: true });
  expect(await panel.innerText()).not.toMatch(/^Failed$/m);
  await expect(surface.locator('.simulation-levels tbody tr')).toHaveCount(1);
  await expect(surface.getByLabel('von Mises stress legend', { exact: true })).toBeVisible();
  await canvas.screenshot({ path: test.info().outputPath('host-von-mises.png') });

  // Too fine for the browser (30 000 nodes), not for the Host.
  await set('Element size (mm)', '4');
  await set('Smallest element size (mm)', '1.5');
  await button('Run study').click();
  await expect(panel.locator('.simulation-error')).toContainText('mesh-too-large', {
    timeout: 300_000,
  });
  await expect(panel.locator('.simulation-error')).toContainText(
    'Reference Host (CalculiX) takes larger meshes.',
  );
  await button(onHost).click();
  await expect(state).toHaveText(/^(Verified|Reference only|Failed)/, { timeout: 600_000 });
  expect(await panel.innerText()).not.toMatch(/^Failed$/m);
  const nodes = Number(
    (await surface.locator('.simulation-levels tbody tr td').nth(2).innerText()).replace(/,/g, ''),
  );
  expect(nodes).toBeGreaterThan(30_000);
  await canvas.screenshot({ path: test.info().outputPath('host-large.png') });
});

// R3g-2 (docs/cad/r3-analysis.md A2, FE70): a modal study beside the static one, its natural
// frequencies, each mode's shape on the view, and a VTU of the shapes.
test('add a modal study, read its natural frequencies and look at each mode (FE70, R3g-2)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  const surface = await analysePlate(page);
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  // Without a constraint there is nothing to hold the body: no modal study yet.
  await expect(button('Add modal study')).toBeDisabled();
  await at(0.4, 0.45);
  await button('Add fixed support').click();
  await at(0.455, 0.63);
  await button('Add force').click();
  await set('Element size (mm)', '20');
  await set('Smallest element size (mm)', '4');

  await button('Add modal study').click();
  const study = surface.getByLabel('Study', { exact: true });
  await expect(study.locator('option')).toHaveText(['Static', 'Modal 1']);
  await expect(study).toHaveValue(/modal/);
  await expect(surface.getByText(/\(modal\): the 6 lowest natural frequencies/)).toBeVisible();
  await set('Number of modes', '4');
  // R3j-5c: a modal study is offered to the Host too (its Host run is FE60's and TS-1463's).
  await expect(surface.getByRole('button', { name: /^Run on / })).toHaveCount(1);

  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });
  await expect(surface.locator('.simulation-levels').first().locator('th')).toContainText([
    'First frequency Hz',
  ]);
  const modes = surface.getByRole('table', { name: 'Natural frequencies' }).locator('tbody tr');
  await expect(modes).toHaveCount(4);
  // The support is one of the plate's 80 × 50 faces: the first modes shear the 5 mm thickness, a
  // quarter shear wave through it, √(G/ρ) / 4t = 160 kHz (the free edges lower it a little).
  const first = Number(await modes.first().locator('td').nth(1).innerText());
  expect(first).toBeGreaterThan(140_000);
  expect(first).toBeLessThan(170_000);
  const field = surface.getByLabel('Result field', { exact: true });
  await expect(field.locator('option')).toHaveCount(4);
  await expect(field.locator('option').first()).toHaveText(/^Mode 1 at \d/);
  await canvas.screenshot({ path: test.info().outputPath('mode-1.png') });
  await field.selectOption('mode-2');
  await canvas.screenshot({ path: test.info().outputPath('mode-2.png') });
  await set('Deformation scale', '20');
  await canvas.screenshot({ path: test.info().outputPath('mode-2-scale-20.png') });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    button('Export VTU').click(),
  ]);
  const vtu = Buffer.concat(await (await download.createReadStream()).toArray()).toString('utf8');
  expect(vtu).toContain('Name="Mode 1 (');
  expect(vtu).toContain('Name="Mode 4 (');

  // The static study is still there and shows no modal result; the modal study can be removed.
  await study.selectOption({ label: 'Static' });
  await expect(surface.getByRole('table', { name: 'Natural frequencies' })).toHaveCount(0);
  await study.selectOption({ label: 'Modal 1' });
  await button('Remove study').click();
  await expect(study).toHaveCount(0);
  await expect(surface.getByText(/\(linear static\)/)).toBeVisible();
});

// VS4b (docs/cad/vehicle-simulation.md VS4, TS-2211): a wind tunnel past the plate in the
// browser: added without any load or constraint, its wind and cell set, run, and its drag, lift
// and side force read per level as a reference result.
test('add a wind tunnel past the part and read its coefficients (VS4b)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(300_000);
  const surface = await analysePlate(page);
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await button('Add wind tunnel').click();
  await expect(
    surface.getByText(/\(wind tunnel\): the air past the analysed bodies at 30/),
  ).toBeVisible();
  await set('Wind speed', '40');
  await set('Browser cell', '5');
  await set('Solver iteration limit', '400');
  await surface.getByLabel('Ground', { exact: true }).selectOption('fixed');
  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^Reference only/, { timeout: 240_000 });
  const table = surface.locator('.simulation-levels').first();
  await expect(table.locator('th')).toContainText(['Cell mm', 'Cells', 'Cd', 'Cl', 'Cs']);
  const cd = Number(await table.locator('tbody tr').first().locator('td').nth(3).innerText());
  // The plate lies on the ground one cell thick: a drag pushing it downstream, not a value to
  // compare (the tunnel's numbers are checked on the sphere and the Ahmed body).
  expect(cd).toBeGreaterThan(0.3);
  await expect(surface.getByText('aero: wind-tunnel results are for reference')).toBeVisible();
  // VS4c (TS-2212): Cp on the plate, streamlines and the flow speed on a section.
  const field = surface.getByLabel('Result field', { exact: true });
  await expect(field.locator('option')).toHaveText(['Pressure coefficient Cp']);
  await expect(surface.getByLabel('Deformation scale', { exact: true })).toHaveCount(0);
  await expect(surface.getByLabel('Streamlines', { exact: true })).toBeChecked();
  await expect(surface.getByLabel('Flow colours')).toContainText(/\d+ streamlines/);
  await surface.getByLabel('Flow section axis', { exact: true }).selectOption('2');
  await surface.getByLabel('Flow section place', { exact: true }).fill('0.5');
  const canvas = surface.locator('.simulation-viewport canvas');
  await canvas.screenshot({ path: test.info().outputPath('wind-tunnel.png') });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    surface.getByRole('button', { name: 'Export VTU', exact: true }).click(),
  ]);
  const vtu = Buffer.concat(await (await download.createReadStream()).toArray()).toString('utf8');
  expect(vtu).toContain('Name="Cp"');
  // VS4d (TS-2213): a sweep of two yaws, each a run of the study at that yaw; the study keeps 0°.
  const sweep = surface.getByRole('group', { name: 'Yaw sweep' });
  await sweep.getByLabel('Yaw angles', { exact: true }).fill('0, 10');
  await sweep.getByRole('button', { name: 'Run yaw sweep', exact: true }).click();
  const rows = sweep.getByRole('table', { name: 'Yaw sweep coefficients' }).locator('tbody tr');
  await expect(rows).toHaveCount(2, { timeout: 240_000 });
  await expect(sweep.getByRole('button', { name: 'Run yaw sweep', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const cs = await rows.locator('td:nth-child(4)').allInnerTexts();
  // The air from the left at 10° pushes the plate toward +y more than at 0°.
  expect(Number(cs[1])).toBeGreaterThan(Number(cs[0]));
  // Each row keeps its run's status and reasons (every wind tunnel is for reference).
  await expect(rows.locator('td:nth-child(5)')).toHaveText([/^reference/, /^reference/]);
  await expect(surface.getByLabel('Yaw', { exact: true })).toHaveValue('0');
  // An edit during a sweep stops it and clears the table: one table never mixes settings.
  await sweep.getByRole('button', { name: 'Run yaw sweep', exact: true }).click();
  await expect(sweep.getByRole('button', { name: 'Cancel sweep', exact: true })).toBeVisible();
  await set('Wind speed', '41');
  await expect(sweep.getByRole('button', { name: 'Run yaw sweep', exact: true })).toBeVisible();
  await expect(rows).toHaveCount(0);
});

// R3i-5 (docs/cad/r3-analysis.md A3, FE90): the plate without its hole solved as tet10 and then
// as a shell on its midsurface (5 mm thick, a side held, a pressure on the top): the shell's
// deflection is the solid's within tolerance; its top and bottom stresses and its VTU, opened
// again. A pinned support is offered beside the fixed one.
test('solve the plate as a shell on its midsurface beside the solid (FE90, R3i-5)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  const surface = await analysePlate(page, slab());
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await expect(button('Add pinned support')).toBeDisabled();
  // A side of the plate held, a pressure on its 80 × 50 top.
  await at(0.455, 0.63);
  await button('Add fixed support').click();
  await at(0.4, 0.45);
  await button('Add pressure').click();
  await canvas.screenshot({ path: test.info().outputPath('shell-setup.png') });
  await set('Element size (mm)', '10');
  await set('Smallest element size (mm)', '2');
  await set('Convergence mesh levels', '1');
  await set('Solver iteration limit', '200000');
  const idealisation = surface.getByLabel('Idealisation', { exact: true });
  await expect(idealisation).toHaveValue('solid');
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  const largest = async () =>
    Number(await surface.locator('.simulation-levels tbody tr td').nth(3).innerText());

  await button('Run study').click();
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });
  const solid = await largest();
  // A section on the solid result, which the shell's has no inside for.
  await surface.getByLabel('Section axis', { exact: true }).selectOption('0');
  await surface.getByLabel('Section place', { exact: true }).fill('0.2');

  await idealisation.selectOption('shell');
  await expect(surface.getByText(/^A shell is solved on the midsurface/)).toBeVisible();
  await button('Run study').click();
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });
  await expect(surface.getByLabel('Shell midsurface', { exact: true })).toContainText(
    /^Solved as a shell on the midsurface: 5\.0+ mm thick, \d+ triangles\./,
  );
  const shell = await largest();
  expect(Math.abs(shell / solid - 1)).toBeLessThan(0.1);
  // R3j-5a: a shell is solved on the Host too, as 15-node wedges over the wall.
  await expect(surface.getByLabel('What a Host run sends', { exact: true })).toContainText(
    'A shell goes as 15-node wedges over its wall',
  );
  await button('Run on Reference Host (CalculiX)').click();
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });
  const onHost = await largest();
  expect(Math.abs(onHost / shell - 1)).toBeLessThan(0.05);
  const field = surface.getByLabel('Result field', { exact: true });
  await expect(field.locator('option')).toHaveText([
    'von Mises stress (MPa)',
    'von Mises stress, top (MPa)',
    'von Mises stress, bottom (MPa)',
    'Displacement (mm)',
  ]);
  // A midsurface has no inside to cut: the section chosen on the solid is not applied, and the
  // whole midsurface is shown (shell-top.png).
  await expect(surface.getByLabel('Section axis', { exact: true })).toHaveCount(0);
  await expect(surface.getByLabel('Section place', { exact: true })).toHaveCount(0);
  await field.selectOption('von-mises-top');
  await expect(surface.getByLabel('von Mises stress, top legend', { exact: true })).toBeVisible();
  await canvas.screenshot({ path: test.info().outputPath('shell-top.png') });
  await field.selectOption('von-mises-bottom');
  await canvas.screenshot({ path: test.info().outputPath('shell-bottom.png') });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    button('Export VTU').click(),
  ]);
  const vtu = Buffer.concat(await (await download.createReadStream()).toArray()).toString('utf8');
  expect(vtu).toContain('Name="Thickness (mm)"');
  expect(vtu).toContain('Name="von Mises top (MPa)"');
  await surface.getByLabel('Open VTU', { exact: true }).setInputFiles({
    name: 'shell.vtu',
    mimeType: 'application/xml',
    buffer: Buffer.from(vtu),
  });
  await expect(surface.getByText('Opened shell.vtu (display only).')).toBeVisible();
  await expect(field.locator('option')).toContainText(['von Mises top (MPa)']);
  await canvas.screenshot({ path: test.info().outputPath('shell-opened-vtu.png') });
  await button('Close VTU').click();

  // The idealisation is kept with the study.
  const doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.studies[0]).toMatchObject({ kind: 'linear-static', idealisation: 'shell' });
});

// R3j-1 (docs/cad/r3-analysis.md A4, FE100): the bonnet's 1 mm rims cannot be clicked in the view;
// picking its skin offers them, and the hinge-line and latch rims become a pinned support
// (TS-1397, ST-207#2).
test('pick the bonnet skin and pin its long rims from the rim list (FE100, R3j-1)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  const surface = await analysePlate(page, sportsCarBonnet());
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const rims = surface.getByRole('group', { name: 'Rim faces' });
  await expect(rims).toHaveCount(0);
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(surface.getByText('1 face selected.')).toBeVisible();
  const offered = rims.getByRole('button', { name: /^Add rim / });
  await expect(offered).toHaveCount(4);
  // Each rim is 1 mm wide; the hinge line and the latch are the two across the bonnet (1300 mm
  // wide, the longest), the sides run along it.
  const names = await offered.allInnerTexts();
  const sizes = names.map((n) => {
    const m = /^Add rim (\d+) \(([\d.]+) × ([\d.]+) mm\)$/.exec(n);
    expect(m, n).not.toBeNull();
    return { name: n, length: Number(m![2]), width: Number(m![3]) };
  });
  for (const r of sizes) expect(r.width).toBeCloseTo(1, 1);
  const across = [...sizes].sort((a, b) => b.length - a.length).slice(0, 2);
  for (const r of across) expect(r.length).toBeGreaterThan(1290);
  for (const r of across) await rims.getByRole('button', { name: r.name, exact: true }).click();
  await expect(surface.getByText('3 faces selected.')).toBeVisible();
  await canvas.screenshot({ path: test.info().outputPath('bonnet-rims.png') });
  await rims.getByRole('button', { name: 'Keep only rim faces', exact: true }).click();
  await expect(surface.getByText('2 faces selected.')).toBeVisible();
  await surface.getByRole('button', { name: 'Add pinned support', exact: true }).click();
  const doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.constraints).toHaveLength(1);
  expect(doc.constraints[0]).toMatchObject({ kind: 'pinned' });
  expect((doc.constraints[0] as { targets: unknown[] }).targets).toHaveLength(2);
});

/** Two 100 × 20 × 20 mm bars end to end, `left` and `right`, each its own body. */
function twoBars(colors: [string, string] = ['#9aa4b1', '#9aa4b1']): CadDocument {
  const bar = (id: string, x: number, color: string) => ({
    profile: {
      id: `${id}-profile`,
      name: `${id} outline`,
      plane: { origin: position(x, 0, 0), orientation: identityQuaternion() },
      shape: { type: 'rectangle' as const, width: mm(100), height: mm(20) },
    },
    feature: {
      id: `${id}-extrude`,
      name: id,
      type: 'extrude' as const,
      inputFeatureIds: [] as [],
      args: { profileId: `${id}-profile`, distance: mm(20), direction: 1 as const },
    },
    body: {
      id,
      name: id,
      sourceFeatureId: `${id}-extrude`,
      placementFeatureId: `${id}-placement`,
      appearance: { color, opacity: 1 },
    },
  });
  const [l, r] = [bar('left', 0, colors[0]), bar('right', 100, colors[1])];
  return applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    profiles: [l.profile, r.profile],
    features: [l.feature, r.feature],
    bodies: [l.body, r.body],
  });
}

// R3j-6a (docs/cad/r3-analysis.md A4, FE100): the version's other body is listed; ticked, it is
// analysed with its own idealisation and material, and its faces are picked like the source
// body's (TS-1465, ST-236#2).
test('analyse a second body with the first and pick a face on it (FE100, R3j-6a)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  const surface = await analysePlate(page, twoBars());
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const bodies = surface.getByRole('list', { name: 'Bodies' });
  await expect(bodies.getByRole('listitem')).toHaveCount(2);
  const canvas = surface.locator('.simulation-viewport canvas');
  const box = (await canvas.boundingBox())!;
  const right = { x: box.width * 0.6, y: box.height * 0.53 };
  // Not analysed yet: the right bar is drawn faint and its faces are not picked.
  await canvas.click({ position: right });
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible();
  await bodies.getByLabel('Analyse right', { exact: true }).check();
  await bodies.getByLabel('right idealisation', { exact: true }).selectOption('shell');
  await bodies
    .getByLabel('right material', { exact: true })
    .selectOption({ label: 'Aluminium 6061-T6 (preset)' });
  await canvas.click({ position: right });
  await expect(surface.getByText('1 face selected.')).toBeVisible();
  await canvas.screenshot({ path: test.info().outputPath('two-bodies.png') });
  await surface.getByRole('button', { name: 'Add fixed support', exact: true }).click();
  let doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.bodies).toEqual([
    { bodyId: 'right', materialId: expect.any(String), idealisation: 'shell' },
  ]);
  expect(doc.materials.find((m) => m.id === doc.bodies![0]!.materialId)?.name).toMatch(/^Alumin/);
  expect((doc.constraints[0] as { targets: { body?: string }[] }).targets).toEqual([
    expect.objectContaining({ body: 'right' }),
  ]);
  // A body with a support on it is not dropped; once the support goes, it is.
  await bodies.getByLabel('Analyse right', { exact: true }).click();
  await expect(surface.getByRole('alert')).toContainText('is on right: remove it first');
  await expect(bodies.getByLabel('Analyse right', { exact: true })).toBeChecked();
  await surface.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await bodies.getByLabel('Analyse right', { exact: true }).uncheck();
  doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.bodies).toBeUndefined();
});

/** Pixels of the analysis view whose red (0), green (1) or blue (2) channel stands out. */
async function viewHuePixels(page: Page, channel: 0 | 1 | 2) {
  const png = await page.locator('.simulation-viewport canvas').first().screenshot();
  return page.evaluate(
    async ({ data, channel }) => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d')!;
      g.drawImage(bitmap, 0, 0);
      const px = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        const c = [px[i]!, px[i + 1]!, px[i + 2]!];
        const others = c.filter((_, k) => k !== channel);
        if (others.every((o) => c[channel]! > o + 60)) n++;
      }
      return n;
    },
    { data: png.toString('base64'), channel },
  );
}

// CR0c (docs/cad/car-design.md S6/E8): the bodies are drawn in their CAD colours (their paint)
// while the analysis is set up, the body not analysed faint; the analysed body keeps its paint
// until a result's colour map is drawn on it (TS-1474, ST-242).
test('draw the bodies in their CAD paint while setting up the analysis (CR0c)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  const surface = await analysePlate(page, twoBars(['#d01c1c', '#1c3cd0']));
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  // The analysed left bar in red; the right one, not analysed, faint (no full blue).
  await expect.poll(() => viewHuePixels(page, 0)).toBeGreaterThan(500);
  const faint = await viewHuePixels(page, 2);
  // Ticked, it is drawn in its full paint.
  await surface
    .getByRole('list', { name: 'Bodies' })
    .getByLabel('Analyse right', { exact: true })
    .check();
  await expect.poll(() => viewHuePixels(page, 2)).toBeGreaterThan(faint + 500);
  await surface
    .locator('.simulation-viewport canvas')
    .screenshot({ path: test.info().outputPath('cr0c-paint.png') });
});

// R3j-6b (docs/cad/r3-analysis.md A4-U2, FE100): where the two bars touch is offered as a bond;
// it is looked at, taken, its tolerance edited and removed through the Host’s history (TS-1466,
// ST-237#1).
test('find where two bodies touch and take the bond (FE100, R3j-6b)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  const surface = await analysePlate(page, twoBars());
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  await expect(surface.getByRole('group', { name: 'Bonds' })).toHaveCount(0);
  await surface.getByLabel('Analyse right', { exact: true }).check();
  const bonds = surface.getByRole('group', { name: 'Bonds' });
  await bonds.getByRole('button', { name: 'Find bond candidates', exact: true }).click();
  await expect(
    bonds.getByText('1 candidate within 0.5 mm, measured on the exact surfaces.'),
  ).toBeVisible();
  const candidate = bonds.getByRole('list', { name: 'Bond candidates' }).getByRole('listitem');
  await expect(candidate).toHaveCount(1);
  await expect(candidate).toContainText('1 face of left follow 1 of right; gap 0 mm, 400 mm²');
  await candidate.getByRole('button', { name: 'Show', exact: true }).click();
  await surface
    .locator('.simulation-viewport canvas')
    .screenshot({ path: test.info().outputPath('bond-candidate.png') });
  await candidate.getByRole('button', { name: 'Take', exact: true }).click();
  await expect(candidate).toContainText('(taken)');
  let doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.bonds).toHaveLength(1);
  expect(doc.bonds![0]).toMatchObject({ name: 'left to right', tolerance: 0.5 });
  expect(doc.bonds![0]!.follower).toEqual([
    expect.not.objectContaining({ body: expect.anything() }),
  ]);
  expect(doc.bonds![0]!.on).toEqual([expect.objectContaining({ body: 'right' })]);
  // A bonded body is not dropped while the bond is there.
  await surface.getByLabel('Analyse right', { exact: true }).click();
  await expect(surface.getByRole('alert')).toContainText('is on right: remove it first');
  const taken = bonds.getByRole('list', { name: 'Bonds taken' });
  const tol = taken.getByLabel('left to right tolerance (mm)', { exact: true });
  await tol.fill('0.2');
  await tol.press('Enter');
  doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.bonds![0]!.tolerance).toBe(0.2);
  await taken.getByRole('button', { name: 'Remove', exact: true }).click();
  doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.bonds).toBeUndefined();
  await expect(candidate).not.toContainText('(taken)');
});

// R3j-6c (docs/cad/r3-analysis.md A4, FE100): a bonded run of the two bars shows every body
// together and each on its own, exports one VTU per body and says how each was solved (TS-1468,
// ST-238#2).
test('solve two bonded bodies and look at each body’s result (FE100, R3j-6c)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(600_000);
  const surface = await analysePlate(page, twoBars());
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await surface.getByLabel('Analyse right', { exact: true }).check();
  await button('Find bond candidates').click();
  await button('Take').click();
  const canvas = surface.locator('.simulation-viewport canvas');
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  // The left bar's top is held, the right bar's top is pushed.
  await at(0.44, 0.415);
  await expect(surface.getByText('1 face selected.')).toBeVisible();
  await button('Add fixed support').click();
  await at(0.6, 0.53);
  await expect(surface.getByText('1 face selected.')).toBeVisible();
  await button('Add force').click();
  await set('Element size (mm)', '10');
  await set('Smallest element size (mm)', '2');
  await set('Convergence mesh levels', '2');
  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });
  const body = surface.getByLabel('Result body', { exact: true });
  await expect(body).toHaveValue('');
  await expect(body.locator('option')).toHaveText(['All bodies', 'left (solid)', 'right (solid)']);
  await expect(surface.getByRole('list', { name: 'Bodies' })).toContainText('solved as solid');
  const fields = surface.getByLabel('Result field', { exact: true }).locator('option');
  // Both bodies are solids: every solid field is shown over both.
  await expect(fields).toHaveText([
    'von Mises stress (MPa)',
    'Max principal stress (MPa)',
    'Min principal stress (MPa)',
    'Displacement (mm)',
  ]);
  await canvas.screenshot({ path: test.info().outputPath('bonded-all.png') });
  await body.selectOption({ label: 'right (solid)' });
  await expect(fields).toHaveCount(4);
  await canvas.screenshot({ path: test.info().outputPath('bonded-right.png') });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    button('Export VTU').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-right\.vtu$/);
});

// CR5b (docs/cad/car-design.md, CR5の分け方): the CAD version's spot weld row is offered in the
// analysis; taken, its radius edited through the Host's history, it joins the bars in the run,
// whose mapping check counts the welds and the nodes they tie (TS-1564, ST-268#5).
test('take the CAD spot weld row into the analysis and run with it (CR5b)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  // The bars' touching ends (20 × 20 at x = 100): a 20 mm row, 10 apart and 5 from the ends.
  const end = (bar: 'left' | 'right', side: string) =>
    faceRef(`${bar}-placement`, [side], [100, 10, 10], 400);
  const welded = applyCadOperation(twoBars(), {
    type: 'setSpotWeld',
    weld: {
      id: 'bar-welds',
      name: 'Bar welds',
      flanges: [
        { bodyId: 'right', face: end('right', 'side:-u') },
        { bodyId: 'left', face: end('left', 'side:+u') },
      ],
      pitchMm: 10,
      endDistanceMm: 5,
      maxGapMm: 2.1,
    },
  });
  const surface = await analysePlate(page, welded);
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  const welds = surface.getByRole('group', { name: 'Spot welds' });
  const row = welds.getByRole('list', { name: 'Spot weld rows' }).getByRole('listitem');
  // The right bar is not analysed yet: the row is listed, not takeable.
  await expect(row).toContainText('2 points from right to left');
  await expect(row).toContainText('cannot be taken: body right is not analysed');
  await surface.getByLabel('Analyse right', { exact: true }).check();
  await expect(row).not.toContainText('cannot be taken');
  await row.getByRole('button', { name: 'Show', exact: true }).click();
  await row.getByRole('button', { name: 'Take', exact: true }).click();
  await expect(row).toContainText('(taken)');
  let doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.spotWelds).toMatchObject([
    { name: 'Bar welds', weldId: 'bar-welds', radiusMm: 3, tolerance: 2.1 },
  ]);
  expect(doc.spotWelds![0]!.follower).toEqual([expect.objectContaining({ body: 'right' })]);
  await set('Bar welds radius (mm)', '4');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(surface.getByLabel('Bar welds radius (mm)', { exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(surface.getByLabel('Bar welds radius (mm)', { exact: true })).toHaveValue('4');
  // Held at the left bar's top, the right bar's top pushed, as the bonded bars are.
  const canvas = surface.locator('.simulation-viewport canvas');
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  await at(0.44, 0.415);
  await expect(surface.getByText('1 face selected.')).toBeVisible();
  await button('Add fixed support').click();
  await at(0.6, 0.53);
  await expect(surface.getByText('1 face selected.')).toBeVisible();
  await button('Add force').click();
  await set('Element size (mm)', '10');
  await set('Smallest element size (mm)', '2');
  await set('Convergence mesh levels', '1');
  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only|Failed)/, { timeout: 480_000 });
  const run = await surface.getByRole('group', { name: 'Run', exact: true }).innerText();
  expect(run).not.toMatch(/^Failed/m);
  await button('Record result').click();
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(page)).draft.content as SimulationDocument).runs?.length ?? 0,
    )
    .toBe(1);
  doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  const mapping = doc.runs![0]!.checks.find((c) => c.name === 'mapping')!;
  expect(mapping.detail).toMatch(/Bar welds: 2 welds tie \d+ nodes/);
  await canvas.screenshot({ path: test.info().outputPath('cr5b-welds.png') });
  // Removed, the row is offered again.
  await welds
    .getByRole('list', { name: 'Spot welds taken' })
    .getByRole('button', { name: 'Remove', exact: true })
    .click();
  await expect(row).not.toContainText('(taken)');
  doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.spotWelds).toBeUndefined();
});

// CR5e (docs/cad/car-design.md, CR5の分け方): a CAD sheet is analysed as a shell on itself; the
// analysis starts it at 1 mm and its thickness is edited through the Host's history (TS-1574,
// ST-269#4).
test('analyse a CAD sheet as a shell and edit its thickness (CR5e)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  const surface = await analysePlate(page, f22Split('open', false));
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const bodies = surface.getByRole('list', { name: 'Bodies' });
  await expect(bodies).toContainText('Sheet, a shell on itself');
  const field = surface.getByLabel('panel-body thickness (mm)', { exact: true });
  await expect(field).toHaveValue('1');
  await field.fill('0.8');
  await field.press('Enter');
  await expect(field).toHaveValue('0.8');
  let doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.sheets).toEqual([{ bodyId: 'panel-body', thicknessMm: 0.8 }]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('1');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(field).toHaveValue('0.8');
  // A thickness over 100 mm is refused: the field goes back to the stored value.
  await field.fill('120');
  await field.press('Enter');
  await expect(field).toHaveValue('0.8');
  doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.sheets).toEqual([{ bodyId: 'panel-body', thicknessMm: 0.8 }]);
});

// R3j-6d (docs/cad/r3-analysis.md FX9, FE100): the sports car body of five plates and four solid
// mounts. Every body is analysed, the mounts as solids; the ten bonds the shape offers are taken;
// the mounts are held and the roof pressed by 1 kPa; the static study is solved on the reference
// Host and its result read per body (TS-1470, ST-239#2).
test('analyse the sports car body on the reference Host (FE100, R3j-6d)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(
    !/Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`),
    'CalculiX (ccx) is not installed',
  );
  test.setTimeout(900_000);
  const surface = await analysePlate(page, sportsCarBody());
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  const bodies = surface.getByRole('list', { name: 'Bodies' });
  for (const n of ['Bonnet', 'Floor', 'Left fender', 'Right fender'])
    await bodies.getByLabel(`Analyse ${n}`, { exact: true }).check();
  for (const n of [
    'Rear left mount',
    'Rear right mount',
    'Front left mount',
    'Front right mount',
  ]) {
    await bodies.getByLabel(`Analyse ${n}`, { exact: true }).check();
    await bodies.getByLabel(`${n} idealisation`, { exact: true }).selectOption('solid');
  }
  await button('Find bond candidates').click();
  const candidates = surface.getByRole('list', { name: 'Bond candidates' }).getByRole('listitem');
  await expect(candidates).toHaveCount(10);
  for (let i = 0; i < 10; i++)
    await candidates.nth(i).getByRole('button', { name: 'Take' }).click();
  await expect(
    surface.getByRole('list', { name: 'Bonds taken' }).getByRole('listitem'),
  ).toHaveCount(10);
  const canvas = surface.locator('.simulation-viewport canvas');
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  // The four mounts' tops, held; then the roof.
  for (const [fx, fy] of [
    [0.332, 0.428],
    [0.444, 0.297],
    [0.677, 0.458],
    [0.592, 0.686],
  ] as const)
    await at(fx, fy);
  await expect(surface.getByText('4 faces selected.')).toBeVisible();
  await button('Add fixed support').click();
  await at(0.48, 0.47);
  await expect(surface.getByText('1 face selected.')).toBeVisible();
  await button('Add pressure').click();
  await set('Pressure 1 pressure (MPa)', '0.001');
  let doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(
    new Set((doc.constraints[0] as { targets: { body?: string }[] }).targets.map((t) => t.body)),
  ).toEqual(
    new Set(['mount-rear-left', 'mount-rear-right', 'mount-front-left', 'mount-front-right']),
  );
  expect((doc.loads[0] as { targets: { body?: string }[] }).targets[0]!.body).toBeUndefined();
  await surface.getByLabel('Idealisation', { exact: true }).selectOption('shell');
  await set('Element size (mm)', '50');
  await set('Smallest element size (mm)', '10');
  await set('Convergence mesh levels', '1');
  await button('Run on Reference Host (CalculiX)').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed|solving/ });
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 600_000 });
  const body = surface.getByLabel('Result body', { exact: true });
  await expect(body.locator('option')).toHaveCount(10);
  await expect(body.locator('option', { hasText: 'Roof (shell, 1 mm)' })).toHaveCount(1);
  await expect(body.locator('option', { hasText: 'Bonnet (shell, 0.8 mm)' })).toHaveCount(1);
  await expect(body.locator('option', { hasText: 'Rear left mount (solid)' })).toHaveCount(1);
  await canvas.screenshot({ path: test.info().outputPath('fx9-host-all.png') });
  await body.selectOption({ label: 'Roof (shell, 1 mm)' });
  await canvas.screenshot({ path: test.info().outputPath('fx9-host-roof.png') });
  await expect(bodies).toContainText('solved as shell, 1.5 mm');
  doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.bonds).toHaveLength(10);
});

// R3h-2 (docs/cad/r3-analysis.md A2, FE80): a thermal study from a held temperature and a
// convection on picked faces, its temperature colour map, the heat flux and a VTU.
test('hold a face hot, cool another and look at the temperature (FE80, R3h-2)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  const surface = await analysePlate(page);
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await expect(button('Add thermal study')).toBeDisabled();
  await expect(surface.getByLabel('Thermal conductivity (W/(m·K))', { exact: true })).toHaveValue(
    '50',
  );
  await at(0.4, 0.45);
  await button('Add temperature').click();
  await set('Temperature 1 temperature (K)', '400');
  await at(0.455, 0.63);
  await button('Add convection').click();
  await set('Convection 1 film coefficient (kW/(m²·K))', '0.1');
  await set('Convection 1 ambient temperature (K)', '300');
  // Thermal items alone make no static study.
  await expect(surface.getByText('A study is made once there is a load')).toBeVisible();
  await set('Element size (mm)', '20');
  await set('Smallest element size (mm)', '4');
  await button('Add thermal study').click();
  await expect(
    surface.getByText(/\(steady heat conduction\): 1 temperature, 1 heat/),
  ).toBeVisible();
  await expect(surface.getByRole('button', { name: /^Run on / })).toHaveCount(0);

  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });
  const head = surface.locator('.simulation-levels').first().locator('th');
  await expect(head).toContainText(['Max T K', 'Max |q| kW/m²']);
  const maxT = Number(
    await surface.locator('.simulation-levels tbody tr').last().locator('td').nth(3).innerText(),
  );
  expect(maxT).toBeCloseTo(400, 6);
  await expect(surface.getByLabel('Temperature legend', { exact: true })).toBeVisible();
  await canvas.screenshot({ path: test.info().outputPath('temperature.png') });
  await surface.getByLabel('Result field', { exact: true }).selectOption('heat-flux');
  await expect(surface.getByLabel('Heat flux legend', { exact: true })).toBeVisible();
  await canvas.screenshot({ path: test.info().outputPath('heat-flux.png') });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    button('Export VTU').click(),
  ]);
  const vtu = Buffer.concat(await (await download.createReadStream()).toArray()).toString('utf8');
  expect(vtu).toContain('Name="Temperature (K)"');
  expect(vtu).toContain('Name="Heat flux (kW per m²)"');
});

// CR5c (docs/cad/car-design.md, S3・S4): the stiffness tests made from four mounts picked in
// order: a torsion test's three constraints and study, then (undone) a bending test with the top
// pushed, which is run and summed up in N/mm (TS-1576, ST-270#5).
test('make torsion and bending tests from picked mounts and run one (CR5c)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  const surface = await analysePlate(page);
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const top = () => canvas.click({ position: { x: box.width * 0.4, y: box.height * 0.45 } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  const rims = surface.getByRole('group', { name: 'Rim faces' });
  /** The plate's 80 mm rims (front left, right), then its 50 mm ones (rear), as the mounts. */
  const pickMounts = async () => {
    await top();
    await expect(surface.getByText('1 face selected.')).toBeVisible();
    const names = await rims.getByRole('button', { name: /^Add rim / }).allInnerTexts();
    const of = (l: number) => names.filter((n) => new RegExp(`\\(${l}(\\.0+)? × `).test(n));
    expect(of(80)).toHaveLength(2);
    expect(of(50)).toHaveLength(2);
    for (const n of [...of(80), ...of(50)])
      await rims.getByRole('button', { name: n, exact: true }).click();
    await rims.getByRole('button', { name: 'Keep only rim faces', exact: true }).click();
    await expect(surface.getByText('4 faces selected.')).toBeVisible();
  };
  await expect(button('Torsion test')).toBeDisabled();
  await pickMounts();
  await expect(button('Bending test')).toBeDisabled();
  await set('Test displacement (mm)', '0.2');
  await button('Torsion test').click();
  let doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.constraints.map((c) => [c.kind, c.targets.length])).toEqual([
    ['fixed', 2],
    ['displacement', 1],
    ['displacement', 1],
  ]);
  expect(doc.constraints.slice(1).map((c) => c.kind === 'displacement' && c.displacement)).toEqual([
    [null, null, 0.2],
    [null, null, -0.2],
  ]);
  expect(doc.studies).toMatchObject([
    {
      name: 'Torsion test 1',
      loadIds: [],
      test: { kind: 'torsion', left: doc.constraints[1]!.id, right: doc.constraints[2]!.id },
    },
  ]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => ((await nativeArtifact(page)).draft.content as SimulationDocument).studies)
    .toEqual([]);

  // Bending: the four mounts and the top after them.
  await pickMounts();
  await top();
  await expect(surface.getByText('5 faces selected.')).toBeVisible();
  await set('Test force (N)', '500');
  await button('Bending test').click();
  doc = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(doc.loads).toMatchObject([{ kind: 'force', force: [0, 0, -500] }]);
  expect(doc.studies).toMatchObject([
    { name: 'Bending test 1', test: { kind: 'bending', load: doc.loads[0]!.id } },
  ]);
  await set('Element size (mm)', '10');
  await set('Smallest element size (mm)', '2');
  await set('Convergence mesh levels', '1');
  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });
  await expect(surface.getByLabel('Stiffness test result', { exact: true })).toHaveText(
    /^Bending stiffness [\d.,e+]+ N\/mm: 500\.0 N for a mean deflection of [\d.e+-]+ mm of the loaded faces\.$/,
  );
  await canvas.screenshot({ path: test.info().outputPath('cr5c-bending.png') });
});

// CR5d (docs/cad/car-design.md, 86A2・86A5・86A8・86T1): the rim pointed at in the rim list is
// outlined in the view; the smallest size says it sets the tessellation; the result's colours
// take a given range, and a range turned over is not applied (TS-1577, ST-271).
test('outline the pointed rim and give the result’s colour range (CR5d)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.setTimeout(600_000);
  const surface = await analysePlate(page);
  const canvas = surface.locator('.simulation-viewport canvas');
  await expect(surface.getByText('Click faces in the view to select them.')).toBeVisible({
    timeout: 90_000,
  });
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) =>
    canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const set = async (label: string, value: string) => {
    const input = surface.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  };
  await expect(surface.getByLabel('Smallest size note', { exact: true })).toContainText(
    'also sets how finely the shape is tessellated',
  );
  await at(0.4, 0.45);
  await expect(surface.getByText('1 face selected.')).toBeVisible();
  const rims = surface.getByRole('group', { name: 'Rim faces' });
  const rim = rims.getByRole('button', { name: /^Add rim / }).first();
  // Nothing red before; the pointed rim's outline after, gone when the pointer leaves.
  await expect.poll(() => viewHuePixels(page, 0)).toBeLessThan(20);
  await rim.hover();
  await expect.poll(() => viewHuePixels(page, 0)).toBeGreaterThan(50);
  await canvas.screenshot({ path: test.info().outputPath('cr5d-rim.png') });
  await surface.getByText('1 face selected.').hover();
  await expect.poll(() => viewHuePixels(page, 0)).toBeLessThan(20);
  // Added, the rim leaves the list (its button with it) and is no longer outlined.
  await rim.hover();
  await expect.poll(() => viewHuePixels(page, 0)).toBeGreaterThan(50);
  await rim.click();
  await expect(surface.getByText('2 faces selected.')).toBeVisible();
  await surface.getByText('2 faces selected.').hover();
  await expect.poll(() => viewHuePixels(page, 0)).toBeLessThan(20);

  // A study: the top held, a side pushed.
  await button('Add fixed support').click();
  await at(0.455, 0.63);
  await button('Add force').click();
  await set('Element size (mm)', '10');
  await set('Smallest element size (mm)', '2');
  await set('Convergence mesh levels', '1');
  await button('Run study').click();
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed/ });
  await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 480_000 });
  const legend = surface.getByLabel(/ legend$/);
  const ends = async () =>
    (await legend.locator('.simulation-range > span').allInnerTexts()).filter((_, i) => i !== 1);
  const auto = await ends();
  await set('Colour range low', '0');
  await set('Colour range high', '5');
  await expect.poll(ends).toEqual(['0.000', '5.000']);
  await canvas.screenshot({ path: test.info().outputPath('cr5d-range.png') });
  // Turned over: the whole result's range again, with the reason.
  await set('Colour range low', '10');
  await expect(surface.getByText(/^The low end must be below the high end/)).toBeVisible();
  await expect.poll(ends).toEqual(auto);
  await set('Colour range low', 'auto');
  await set('Colour range high', 'auto');
  await expect.poll(ends).toEqual(auto);
});

// TS-1590, ST-280. CR5f-11 (docs/cad/car-design.md, E14 for B2): the simplified BIW F29 is edited in the ordinary
// CAD screens (the side outer's roof flange 80 → 100 mm, the left sill's lower weld row 40 → 50
// mm), saved as v2, and its analysis is switched to v2 and solved again on the reference Host;
// the switch is undone and redone, the analysis saved and reloaded. The analysis is the cabin (18
// bodies: floor, roof, bows, cross members, side outers, sills, pillars and roof rails; the two
// rows changed are among its rows), set up
// as a builder would (bodies, thicknesses, the CAD rows taken, the floor held, the roof pressed),
// since F29 whole needs more memory than this container has with a browser and the dev server
// (README CR5f-6〜9). Not a performance measurement.
test('edit F29 in the CAD screens, switch its analysis to the new version and solve it again on the Host (CR5f-11, E14)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.FEM_MESHER_DIST, 'FEM_MESHER_DIST is not set');
  test.skip(
    !/Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`),
    'CalculiX (ccx) is not installed',
  );
  test.setTimeout(3_000_000);
  const cad = f29Biw();
  let surface = await analysePlate(page, cad);
  await expect(surface.getByText('Analyses Plate · v1 · floor')).toBeVisible({ timeout: 300_000 });
  // The analysis, as a builder sets it up.
  const analysed = [
    'floor',
    'roof',
    'bow-front',
    'bow-rear',
    'cross-front',
    'cross-middle',
    'cross-rear',
    ...['side', 'sill', 'pillar-a', 'pillar-b', 'pillar-c', 'rail'].flatMap((b) => [b, `${b}-r`]),
  ];
  const thickness: Record<string, number> = {
    floor: 0.8,
    roof: 0.8,
    'bow-front': 1.0,
    'bow-rear': 1.0,
    'cross-front': 1.2,
    'cross-middle': 1.2,
    'cross-rear': 1.2,
    side: 0.8,
    sill: 1.4,
    'pillar-a': 1.4,
    'pillar-b': 1.4,
    'pillar-c': 1.2,
    rail: 1.2,
  };
  const empty = await nativeArtifact(page);
  let doc = empty.draft.content as SimulationDocument;
  expect(doc.source.bodyId).toBe('floor');
  doc = {
    ...doc,
    materials: [{ id: 'steel', ...simulationMaterialPresets[0]! }],
    materialId: 'steel',
    mesh: { ...doc.mesh, size: 30, minSize: 10, grading: 1.5 },
  };
  for (const id of analysed) {
    if (id !== 'floor')
      doc = applySimulationOperation(doc, {
        type: 'addBody',
        body: { bodyId: id, materialId: 'steel' },
      });
    doc = applySimulationOperation(doc, {
      type: 'setSheetThickness',
      bodyId: id,
      thicknessMm: thickness[id.replace(/-r$/, '')]!,
    });
  }
  const target = (bodyId: string, ref: CadTopologyRef) => ({
    kind: 'face' as const,
    ref,
    ...(bodyId === 'floor' ? {} : { body: bodyId }),
  });
  // Faces as the CAD weld rows name them (the kernel's own names for these sheets).
  const flangeFace = (weldId: string, bodyId: string): CadTopologyRef =>
    (cad.spotWelds ?? []).find((w) => w.id === weldId)!.flanges.find((f) => f.bodyId === bodyId)!
      .face;
  const rows = (cad.spotWelds ?? []).filter((w) =>
    w.flanges.every((f) => analysed.includes(f.bodyId)),
  );
  expect(rows.map((w) => w.id)).toContain('weld-l-sill-l');
  expect(rows.map((w) => w.id)).toContain('weld-roof-l');
  for (const w of rows)
    doc = applySimulationOperation(doc, {
      type: 'addSpotWeld',
      weld: {
        id: `weld-${w.id}`,
        name: w.name,
        weldId: w.id,
        follower: [target(w.flanges[0].bodyId, w.flanges[0].face)],
        on: [target(w.flanges[1].bodyId, w.flanges[1].face)],
        radiusMm: 3,
        tolerance: w.maxGapMm,
      },
    });
  doc = applySimulationOperation(doc, {
    type: 'addConstraint',
    constraint: {
      id: 'floor-held',
      name: 'Floor held',
      kind: 'fixed',
      targets: [target('floor', flangeFace('weld-l-rear-member-floor', 'floor'))],
    },
  });
  doc = applySimulationOperation(doc, {
    type: 'addLoad',
    load: {
      id: 'roof-pressed',
      name: 'Roof pressed',
      kind: 'pressure',
      // The roof's crown: the weld row's roof face is its side strip (s0); the crown is s2.
      targets: [
        target('roof', {
          ...flangeFace('weld-roof-l', 'roof'),
          name: [['side:e:s2']],
          hint: { centroid: [1750, 0, 1300], size: 1200 },
        }),
      ],
      pressure: 0.001,
    },
  });
  doc = applySimulationOperation(doc, {
    type: 'addStudy',
    study: {
      id: 'roof-study',
      name: 'Roof pressed, floor held',
      kind: 'linear-static',
      idealisation: 'shell',
      loadIds: ['roof-pressed'],
      constraintIds: ['floor-held'],
      solver: { tolerance: 1e-8, maxIterations: 10_000 },
      convergence: { levels: 1, metrics: ['max-displacement'], tolerance: 0.05 },
    },
  });
  await importJson(page, 'analysis.json', { ...empty, draft: { ...empty.draft, content: doc } });
  surface = page.getByRole('region', { name: 'Structural analysis' });
  const items = surface.getByRole('list', { name: 'Loads and constraints' });
  await expect(items.getByRole('listitem')).toHaveCount(2, { timeout: 300_000 });
  // Each analysed body's faces come once its analysis surface is evaluated (minutes for F29).
  await expect(items).not.toContainText('not found', { timeout: 600_000 });
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const state = surface
    .getByRole('status')
    .filter({ hasText: /Level|Starting|Verified|Reference|Failed|solving/ });
  const solve = async (shot: string) => {
    await button('Run on Reference Host (CalculiX)').click();
    await expect(state).toHaveText(/^(Verified|Reference only)/, { timeout: 2_400_000 });
    await surface
      .locator('.simulation-viewport canvas')
      .screenshot({ path: test.info().outputPath(shot) });
    // The run's row (level, size, nodes, largest displacement and stress), for the record.
    const row = (await surface.getByRole('table').first().textContent()) ?? '';
    return `${(await state.textContent()) ?? ''} ${row}`;
  };
  const v1 = await solve('e14-v1.png');

  // The CAD edits, in the ordinary CAD screens, saved as v2.
  const nav = page.getByRole('navigation', { name: 'Artifacts', exact: true });
  if (!(await nav.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await nav.getByRole('button', { name: /Plate/ }).click();
  const settled = () =>
    expect(page.getByTestId('cad-geometry-state')).toHaveText('Shape up to date', {
      timeout: 300_000,
    });
  await settled();
  await page.locator('summary', { hasText: /^History \(/ }).click();
  await page
    .getByRole('list', { name: 'Feature history' })
    .getByRole('button', { name: /^Side outer roof flange/ })
    .click();
  const field = page.locator('.cad-inspector').getByLabel('Width (mm)');
  await field.fill('100');
  await field.press('Enter');
  await settled();
  const sill = page.getByTestId('cad-weld-weld-l-sill-l');
  await sill.getByLabel('Pitch (mm)').fill('50');
  await sill.getByRole('button', { name: 'Apply' }).click();
  await settled();
  await expect(sill.getByTestId('cad-weld-points')).toContainText(/40 points along 2,?000 mm/);
  await save(page, 2);

  // The analysis, switched to v2 and solved again.
  if (!(await nav.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  // The library holds the empty analysis the picker made and the imported one (opened last).
  await nav
    .getByRole('button', { name: /Structural analysis/ })
    .last()
    .click();
  surface = page.getByRole('region', { name: 'Structural analysis' });
  const version = surface.getByLabel('CAD version', { exact: true });
  await expect(version.locator('option')).toHaveText(['v1', 'v2'], { timeout: 300_000 });
  await version.selectOption({ label: 'v2' });
  await expect(surface.getByText('Analyses Plate · v2 · floor')).toBeVisible();
  await expect(items.getByRole('listitem')).toHaveCount(2, { timeout: 300_000 });
  await expect(items).not.toContainText('not found', { timeout: 600_000 });
  const welds = surface.getByRole('group', { name: 'Spot welds' });
  await expect(welds).not.toContainText('not found');
  const v2 = await solve('e14-v2.png');
  test.info().annotations.push({ type: 'results', description: `v1: ${v1} | v2: ${v2}` });
  console.log(`E14 v1: ${v1} | v2: ${v2}`);

  // The switch is one Undo step; Redo takes it again; saved and reloaded it stays on v2.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(surface.getByText('Analyses Plate · v1 · floor')).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(surface.getByText('Analyses Plate · v2 · floor')).toBeVisible();
  await save(page, 1);
  await page.reload();
  if (!(await nav.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  // The saved one (the empty analysis the picker made has no version).
  await nav.getByRole('button', { name: /Structural analysis · 1 versions/ }).click();
  surface = page.getByRole('region', { name: 'Structural analysis' });
  await expect(surface.getByText('Analyses Plate · v2 · floor')).toBeVisible({ timeout: 300_000 });
  const saved = (await nativeArtifact(page)).draft.content as SimulationDocument;
  expect(saved.spotWelds).toHaveLength(rows.length);
  expect(saved.studies.map((s) => s.id)).toEqual(['roof-study']);
});
