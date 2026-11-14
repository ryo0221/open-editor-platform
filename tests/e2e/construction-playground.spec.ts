import { f37Office, type BimDocument } from '@editor-platform/bim-core';
import {
  earthworkVolumes,
  f85OfficeSchedule,
  f86OfficeSite,
  f87OfficeCranes,
  f88Building,
  f88OfficeFrame,
  f89OfficeTraffic,
  scheduleConstruction,
  writeConstructionCsv,
  type ConstructionDocument,
} from '@editor-platform/construction-core';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { addDays } from '@editor-platform/time-axis';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// Needs the development kernel (CAD_OCCT_DIST); without it the Playground offers neither Building
// nor the construction schedule.
test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');

const shots = process.env.CS_SHOTS;
const bimReady = (page: Page) =>
  expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', { timeout: 90_000 });
async function library(page: Page) {
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
}
async function importJson(page: Page, name: string, value: unknown) {
  await library(page);
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}
const summary = (page: Page) => page.getByLabel('Schedule summary', { exact: true });
const surface = (page: Page) => page.getByLabel('Construction schedule', { exact: true });

// CS1b (docs/cad/construction-site.md): a saved Building version is scheduled — created from the
// library, its tasks imported from CSV, the calendar set, a day chosen on the slider, a task
// edited through the Host's history, saved, reloaded and exported with the building kept.
test('schedule a saved building, import CSV, play a day, edit, Undo, reload and export (ST-542, TS-2072)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  // Without a saved Building version there is nothing to schedule.
  await library(page);
  await page.getByLabel('Artifact type', { exact: true }).selectOption('construction');
  await expect(page.getByText('Save a version of a Building first.')).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ New artifact' })).toBeDisabled();

  // The F37 office, saved as v1.
  await create(page, 'bim');
  await bimReady(page);
  const empty = await nativeArtifact(page);
  await importJson(page, 'office.json', {
    ...empty,
    name: 'Office',
    draft: { ...empty.draft, content: f37Office() },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Office');
  await bimReady(page);
  await save(page, 1);

  await library(page);
  await page.getByLabel('Artifact type', { exact: true }).selectOption('construction');
  await expect(
    page.getByLabel('Building to schedule', { exact: true }).locator('option'),
  ).toHaveText(['Office · v1']);
  await page.getByRole('button', { name: '＋ New artifact' }).click();
  await expect(surface(page)).toBeVisible();
  await expect(page.getByText('Building: Office · v1')).toBeVisible();
  await expect(summary(page)).toContainText('0 tasks');

  // A CSV with a bad row is refused as a whole, with its line.
  await page.getByLabel('Task CSV', { exact: true }).setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('id,name,duration\na,A,two\n'),
  });
  await expect(surface(page).getByRole('alert')).toContainText(
    'line 2: duration "two" is not whole days',
  );
  await expect(summary(page)).toContainText('0 tasks');

  // The F85 tasks from CSV, then F85's start date and holidays.
  const f85 = f85OfficeSchedule();
  await page.getByLabel('Task CSV', { exact: true }).setInputFiles({
    name: 'office.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(writeConstructionCsv(f85.tasks)),
  });
  await expect(page.getByRole('table', { name: 'Tasks' }).locator('tbody tr')).toHaveCount(28);
  await page.getByText('Calendar', { exact: true }).click();
  await page.getByLabel('Start date', { exact: true }).fill(f85.startDate);
  await page.getByLabel('Holidays', { exact: true }).fill(f85.calendar.holidays.join('\n'));
  await page.getByRole('button', { name: 'Set calendar', exact: true }).click();
  const plan = scheduleConstruction(f85);
  await expect(summary(page)).toContainText(
    `28 tasks · ${plan.projectStart} – ${plan.projectFinish} · ${plan.workingDays} working days`,
  );
  // The same holidays repeated and spaced save nothing new, and leave nothing pending.
  await page.getByText('Calendar', { exact: true }).click();
  await page
    .getByLabel('Holidays', { exact: true })
    .fill(` ${f85.calendar.holidays[0]}\n${f85.calendar.holidays.join('  \n')}`);
  await page.getByRole('button', { name: 'Set calendar', exact: true }).click();
  await expect(page.getByText(/未確定の入力があります/)).toBeHidden();
  await expect(page.getByText('Evaluating the building…')).toBeHidden({ timeout: 120_000 });

  // A day mid-way: the fourth storey's columns are going up.
  const day = plan.byId.get('col-4')!.start;
  await page.getByLabel('Date', { exact: true }).fill(day);
  await expect(page.getByLabel('Running tasks', { exact: true })).toContainText('Columns 4F');
  if (shots) await page.screenshot({ path: `${shots}/cs1b-day.png` });
  await page.getByLabel('Show unbuilt', { exact: true }).check();
  if (shots) await page.screenshot({ path: `${shots}/cs1b-ghost.png` });

  // A critical task made longer moves the finish; Undo brings it back.
  await page.getByRole('row').filter({ hasText: 'Roof' }).getByRole('button').click();
  await page.getByLabel('Days', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  const longer = structuredClone(f85) as ConstructionDocument;
  longer.tasks.find((t) => t.id === 'roof')!.durationDays = 10;
  const later = scheduleConstruction(longer).projectFinish;
  await expect(summary(page)).toContainText(`– ${later} ·`);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(summary(page)).toContainText(`– ${plan.projectFinish} ·`);
  // The same days spelled `05` save nothing new, and leave nothing pending.
  const roofDays = f85.tasks.find((t) => t.id === 'roof')!.durationDays;
  await page.getByLabel('Days', { exact: true }).fill(`0${roofDays}`);
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(page.getByLabel('Days', { exact: true })).toHaveValue(String(roofDays));
  await expect(page.getByText(/未確定の入力があります/)).toBeHidden();
  // A loop is refused and nothing changes.
  await page.getByRole('row').filter({ hasText: 'Site preparation' }).getByRole('button').click();
  await page.getByLabel('Predecessors', { exact: true }).fill('complete');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(surface(page).getByRole('alert').first()).toContainText('loop');
  await expect(summary(page)).toContainText(`– ${plan.projectFinish} ·`);
  // The refused form still holds its change: the Host counts it as pending until discarded.
  await expect(page.getByText(/未確定の入力があります/)).toBeVisible();
  // Another task does not open over it.
  await page.getByRole('row').filter({ hasText: 'Roof' }).getByRole('button').click();
  await expect(surface(page).getByRole('alert').first()).toContainText(
    'Save or discard the task form first.',
  );
  await expect(page.getByLabel('Task name', { exact: true })).toHaveValue('Site preparation');
  // Nor does the Host's Undo replace the schedule under it.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Predecessors', { exact: true })).toHaveValue('complete');
  await expect(summary(page)).toContainText('28 tasks');
  // Nor does a CSV import.
  await page.getByLabel('Task CSV', { exact: true }).setInputFiles({
    name: 'one.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('id,name,duration\nx,X,1\n'),
  });
  await expect(page.getByLabel('Predecessors', { exact: true })).toHaveValue('complete');
  await expect(summary(page)).toContainText('28 tasks');
  // Nor is a CSV exported without it.
  let downloaded = false;
  page.on('download', () => (downloaded = true));
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await expect(surface(page).getByRole('alert').first()).toContainText(
    'Save or discard the task form first.',
  );
  expect(downloaded).toBe(false);
  await page
    .getByRole('form', { name: 'Task' })
    .getByRole('button', { name: 'Discard', exact: true })
    .click();
  await expect(page.getByText(/未確定の入力があります/)).toBeHidden();
  await expect(page.getByLabel('Predecessors', { exact: true })).toHaveValue('');

  await save(page, 1);
  await page.reload();
  await expect(summary(page)).toContainText(
    `28 tasks · ${plan.projectStart} – ${plan.projectFinish}`,
  );
  const record = await nativeArtifact(page);
  expect(record.kind).toBe('construction');
  expect(record.constructionSources).toHaveLength(1);
  expect((record.draft.content as ConstructionDocument).tasks).toEqual(f85.tasks);
  if (shots) await page.screenshot({ path: `${shots}/cs1b-reloaded.png` });
});

// CS1b on a phone: the 3D view stacks above the task table, with no sideways page scroll.
test('the schedule fits a phone screen (ST-542, TS-2072)', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'mobile layout');
  await page.goto('/');
  await create(page, 'bim');
  await bimReady(page);
  const empty = await nativeArtifact(page);
  await importJson(page, 'office.json', {
    ...empty,
    name: 'Office',
    draft: { ...empty.draft, content: f37Office() },
  });
  await bimReady(page);
  await save(page, 1);
  await create(page, 'construction');
  await expect(surface(page)).toBeVisible();
  const f85 = f85OfficeSchedule();
  await page.getByLabel('Task CSV', { exact: true }).setInputFiles({
    name: 'office.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(writeConstructionCsv(f85.tasks)),
  });
  await expect(page.getByRole('table', { name: 'Tasks' }).locator('tbody tr')).toHaveCount(28);
  await expect(page.getByText('Evaluating the building…')).toBeHidden({ timeout: 120_000 });
  const view = await page.locator('.construction-view').boundingBox();
  const table = await page.getByRole('table', { name: 'Tasks' }).boundingBox();
  expect(view!.height).toBeGreaterThan(200);
  expect(table!.y).toBeGreaterThan(view!.y + view!.height - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
  if (shots) await page.screenshot({ path: `${shots}/cs1b-mobile.png`, fullPage: true });
});

const lines = (points: readonly (readonly [number, number])[]) =>
  points.map(([x, y]) => `${x}, ${y}`).join('\n');
const siteProblems = (page: Page) => page.getByLabel('Site problems', { exact: true });
const dayWorks = (page: Page) => page.getByLabel('Earthworks on the day', { exact: true });

// CS2b (docs/cad/construction-site.md): the scheduled office's site laid out in the Playground —
// the survey from CSV, the boundary, the pit and a site office — the ground lowered day by day,
// what does not fit the boundary listed, and the site kept through save and reload.
test('lay out the site, dig the pit day by day, check the boundary, reload (ST-544, TS-2076)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'bim');
  await bimReady(page);
  const empty = await nativeArtifact(page);
  await importJson(page, 'office.json', {
    ...empty,
    name: 'Office',
    draft: { ...empty.draft, content: f37Office() },
  });
  await bimReady(page);
  await save(page, 1);
  await create(page, 'construction');
  await expect(surface(page)).toBeVisible();
  const f86 = f86OfficeSite();
  const site = f86.site!;
  await page.getByLabel('Task CSV', { exact: true }).setInputFiles({
    name: 'office.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(writeConstructionCsv(f86.tasks)),
  });
  await page.getByText('Calendar', { exact: true }).click();
  await page.getByLabel('Start date', { exact: true }).fill(f86.startDate);
  await page.getByLabel('Holidays', { exact: true }).fill(f86.calendar.holidays.join('\n'));
  await page.getByRole('button', { name: 'Set calendar', exact: true }).click();
  await expect(summary(page)).toContainText('28 tasks');
  await expect(page.getByText('Evaluating the building…')).toBeHidden({ timeout: 120_000 });

  // The survey from CSV (a bad one is refused with its line), then the boundary.
  await page.getByLabel('Terrain CSV', { exact: true }).setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('x,y,z\n0,0,high\n'),
  });
  await expect(surface(page).getByRole('alert').first()).toContainText('line 2');
  await page.getByLabel('Terrain CSV', { exact: true }).setInputFiles({
    name: 'survey.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(['x,y,z', ...site.terrain.map((p) => p.join(','))].join('\n')),
  });
  await expect(page.getByText(`${site.terrain.length} survey points`)).toBeVisible();
  await page.getByLabel('Boundary points', { exact: true }).fill(lines(site.boundary));
  await page.getByRole('button', { name: 'Set boundary', exact: true }).click();
  // The same points spelled differently save nothing new, and leave nothing pending.
  await page
    .getByLabel('Boundary points', { exact: true })
    .fill(site.boundary.map(([x, y]) => `${x},${y}`).join('; '));
  await page.getByRole('button', { name: 'Set boundary', exact: true }).click();
  await expect(page.getByLabel('Boundary points', { exact: true })).toHaveValue(
    lines(site.boundary),
  );
  await expect(page.getByText(/未確定の入力があります/)).toBeHidden();

  // The pit, through its form.
  const pit = site.earthworks.find((w) => w.id === 'pit')!;
  await page.getByRole('button', { name: 'Add earthwork', exact: true }).click();
  await page.getByLabel('Site item name', { exact: true }).fill('Pit');
  await page.getByLabel('Outline points', { exact: true }).fill(lines(pit.outline));
  await page.getByLabel('Level', { exact: true }).fill(String(pit.levelZ));
  await page.getByLabel('Slope', { exact: true }).fill(String(pit.slope));
  await page.getByLabel('Earthwork task', { exact: true }).selectOption(pit.taskId);
  await page.getByRole('button', { name: 'Save site item', exact: true }).click();
  const [volume] = earthworkVolumes({ ...site, earthworks: [pit] });
  const total = Math.round(volume!.cut).toLocaleString('en-US');
  await expect(page.getByRole('table', { name: 'Earthworks' })).toContainText(total);

  // Before the site work no ground has moved; the day the pit is done all of it has.
  const plan = scheduleConstruction(f86);
  await page.getByLabel('Date', { exact: true }).fill(addDays(plan.byId.get('site')!.start, -1));
  await expect(dayWorks(page)).toContainText(`cut 0.0 of ${total} m³`);
  await page.getByLabel('Date', { exact: true }).fill(plan.byId.get(pit.taskId)!.finish);
  await expect(dayWorks(page)).toContainText(`cut ${total} of ${total} m³`);

  // A site office put down over the boundary is listed until it is moved inside.
  await page.getByRole('button', { name: 'Add temporary work', exact: true }).click();
  await page.getByLabel('Site item name', { exact: true }).fill('Site office');
  await page.getByLabel('Outline points', { exact: true }).fill(
    lines([
      [55000, 40000],
      [64000, 40000],
      [64000, 46000],
      [55000, 46000],
    ]),
  );
  await page.getByRole('button', { name: 'Save site item', exact: true }).click();
  await expect(siteProblems(page)).toContainText('Site office stands over the site boundary');
  const office = site.temporaries.find((t) => t.id === 'office')!;
  await page.getByLabel('Outline points', { exact: true }).fill(lines(office.outline));
  await page.getByRole('button', { name: 'Save site item', exact: true }).click();
  await expect(siteProblems(page)).toBeHidden();
  await expect(page.getByRole('table', { name: 'Temporary works' })).toContainText('standing');
  if (shots) await page.screenshot({ path: `${shots}/cs2b-pit.png` });
  if (shots) {
    await page.getByLabel('Date', { exact: true }).fill(plan.byId.get('col-4')!.start);
    await page.screenshot({ path: `${shots}/cs2b-building.png` });
  }

  // An unsaved site item holds another one, and the Host's save, until it is saved or discarded.
  await page.getByLabel('Site item name', { exact: true }).fill('Office (moved)');
  await expect(page.getByText(/未確定の入力があります/)).toBeVisible();
  await page
    .getByRole('table', { name: 'Earthworks' })
    .getByRole('button', { name: 'Pit' })
    .click();
  await expect(surface(page).getByRole('alert').first()).toContainText(
    'Save or discard the site item form first.',
  );
  await page
    .getByRole('form', { name: 'Temporary work' })
    .getByRole('button', { name: 'Discard', exact: true })
    .click();
  await expect(page.getByText(/未確定の入力があります/)).toBeHidden();

  // A boundary drawn through the building lists its elements; Undo takes it back.
  await page.getByLabel('Boundary points', { exact: true }).fill(
    lines([
      [-15000, -15000],
      [20000, -15000],
      [20000, 45000],
      [-15000, 45000],
    ]),
  );
  await page.getByRole('button', { name: 'Set boundary', exact: true }).click();
  await expect(siteProblems(page)).toContainText('(building) stands over the site boundary');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(siteProblems(page)).toBeHidden();

  await save(page, 1);
  await page.reload();
  await expect(page.getByRole('table', { name: 'Earthworks' })).toContainText(total);
  const record = await nativeArtifact(page);
  const kept = (record.draft.content as ConstructionDocument).site!;
  expect(kept.boundary).toEqual(site.boundary);
  expect(kept.terrain).toEqual(site.terrain);
  expect(kept.earthworks.map((w) => [w.name, w.levelZ, w.slope, w.taskId])).toEqual([
    ['Pit', pit.levelZ, pit.slope, pit.taskId],
  ]);
  expect(kept.temporaries.map((t) => [t.name, t.outline])).toEqual([
    ['Site office', office.outline],
  ]);
});

// CS3b: the concrete's density set in the Building, a tower crane from its form, the lifts of
// two tasks, the day's lifts played back, a crane moved out of reach and back, saved and reloaded.
test('put up a crane, plan the lifts, play a day, find a crane out of reach (ST-546, TS-2079)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(240_000);
  await page.goto('/');
  await create(page, 'bim');
  await bimReady(page);
  const empty = await nativeArtifact(page);
  await importJson(page, 'office.json', {
    ...empty,
    name: 'Office',
    draft: { ...empty.draft, content: f37Office() },
  });
  await bimReady(page);
  // The concrete's density, through the column type's material.
  const inspector = page.locator('.bim-inspector');
  if (!(await inspector.isVisible()))
    await page.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
  await inspector.getByRole('tab', { name: 'Types' }).click();
  await inspector.getByRole('button', { name: /^RC column 600/ }).click();
  const density = inspector.getByLabel('Density (kg/m³)', { exact: true });
  await density.fill('2400');
  await density.press('Enter');
  await expect
    .poll(async () => {
      const content = (await nativeArtifact(page)).draft.content as BimDocument;
      return content.materials.find((m) => m.id === 'm-concrete')?.densityKgM3;
    })
    .toBe(2400);
  await save(page, 1);

  await create(page, 'construction');
  await expect(surface(page)).toBeVisible();
  const f87 = f87OfficeCranes();
  await page.getByLabel('Task CSV', { exact: true }).setInputFiles({
    name: 'office.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(writeConstructionCsv(f87.tasks)),
  });
  await page.getByText('Calendar', { exact: true }).click();
  await page.getByLabel('Start date', { exact: true }).fill(f87.startDate);
  await page.getByLabel('Holidays', { exact: true }).fill(f87.calendar.holidays.join('\n'));
  await page.getByRole('button', { name: 'Set calendar', exact: true }).click();
  await expect(summary(page)).toContainText('28 tasks');
  await expect(page.getByText('Evaluating the building…')).toBeHidden({ timeout: 120_000 });

  // The crane through its form.
  const crane = f87.site!.cranes![0]!;
  await page.getByText('Cranes', { exact: true }).click();
  await page.getByRole('button', { name: 'Add crane', exact: true }).click();
  await page.getByLabel('Crane name', { exact: true }).fill(crane.name);
  await page.getByLabel('Crane base', { exact: true }).fill(crane.base.join(', '));
  await page.getByLabel('Crane height', { exact: true }).fill(String(crane.height));
  await page.getByLabel('Jib length', { exact: true }).fill(String(crane.jibLength));
  await page.getByLabel('Smallest radius', { exact: true }).fill(String(crane.minRadius));
  await page
    .getByLabel('Load chart', { exact: true })
    .fill(crane.loadChart.map((r) => `${r.radius}, ${r.capacityKg}`).join('\n'));
  await page.getByLabel('Crane put up by', { exact: true }).selectOption(crane.fromTaskId);
  await page.getByLabel('Crane taken down after', { exact: true }).selectOption(crane.untilTaskId!);
  // A chart whose capacity rises with the radius is refused, and nothing changes.
  await page.getByLabel('Load chart', { exact: true }).fill('20000, 5000\n40000, 9000');
  await page.getByRole('button', { name: 'Save crane', exact: true }).click();
  await expect(surface(page).getByRole('alert').first()).toContainText(
    'capacities do not go up with the radius',
  );
  await page
    .getByLabel('Load chart', { exact: true })
    .fill(crane.loadChart.map((r) => `${r.radius}, ${r.capacityKg}`).join('\n'));
  await page.getByRole('button', { name: 'Save crane', exact: true }).click();
  const cranes = page.getByRole('table', { name: 'Cranes' });
  await expect(cranes).toContainText(`${crane.name}Tower crane50 mGround slabRoof`);
  await expect(page.getByText(/未確定の入力があります/)).toBeHidden();

  // The lifts of the first columns and beams, from the yard.
  await page.getByLabel('Pick point', { exact: true }).fill('52000, 11000, 1000');
  await page.getByLabel('Lift task', { exact: true }).selectOption('col-1');
  await page.getByRole('button', { name: 'Add lifts for task', exact: true }).click();
  await page.getByLabel('Lift task', { exact: true }).selectOption('beam-1');
  await page.getByRole('button', { name: 'Add lifts for task', exact: true }).click();
  await expect(page.getByText('93 lifts planned')).toBeVisible();
  // Every lift is within reach and load, and clears what stands.
  await expect(page.getByText('Checking the lifts…')).toBeHidden({ timeout: 60_000 });
  await expect(page.getByLabel('Crane problems', { exact: true })).toBeHidden();

  // The first column day: its lifts and masses, played back one after another.
  const plan = scheduleConstruction(f87);
  await page.getByLabel('Date', { exact: true }).fill(plan.byId.get('col-1')!.start);
  const today = page.getByRole('table', { name: 'Lifts on the day' });
  await expect(today).toContainText('c-1-1-1Tower crane 13.5 t');
  await page.getByRole('button', { name: 'Play lifts', exact: true }).click();
  const playback = page.getByLabel('Lift playback', { exact: true });
  await expect(playback).toContainText('Lift 1 of');
  if (shots) {
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${shots}/cs3b-lift.png` });
  }
  await expect(playback).toContainText('Lift 2 of', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Stop lifts', exact: true }).click();
  await expect(playback).toContainText('lifts on');

  // Moved east, the crane no longer reaches the far columns; Undo puts it back.
  // (The crane's form is still open from adding it.)
  await page.getByLabel('Crane base', { exact: true }).fill('60000, -6000');
  await page.getByRole('button', { name: 'Save crane', exact: true }).click();
  const problems = page.getByLabel('Crane problems', { exact: true });
  await expect(problems).toContainText(`${crane.name} reaches 3.0–50.0 m`, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(problems).toBeHidden({ timeout: 60_000 });
  // A crane its lifts use is kept.
  await page.getByRole('button', { name: 'Remove crane', exact: true }).click();
  await expect(surface(page).getByRole('alert').first()).toContainText('a lift uses this crane');

  await save(page, 1);
  await page.reload();
  await expect(page.getByText('93 lifts planned')).toBeVisible();
  const record = await nativeArtifact(page);
  const kept = (record.draft.content as ConstructionDocument).site!;
  expect(kept.cranes).toEqual([{ ...crane, id: 'crane-1' }]);
  expect(kept.lifts!.slice(0, 1)).toEqual([
    {
      id: 'lift-c-1-1-1',
      craneId: 'crane-1',
      taskId: 'col-1',
      elementId: 'c-1-1-1',
      pick: [52000, 11000, 1000],
    },
  ]);
});

// CS4b: the frame of the day of the 4F casting is solved on the Reference Host (CalculiX) and
// compared with the completed building; the crane's foundation takes its own mass and the lifts.
test('analyse the frame of a construction day against the completed building (ST-548, TS-2084)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  // The Reference Host solves the frame only where CalculiX runs (SIMULATION_HOST not off).
  test.skip(
    process.env.SIMULATION_HOST === 'off' ||
      !/Version \d/.test(`${spawnSync('ccx', ['-v'], { encoding: 'utf8' }).stdout ?? ''}`),
    'CalculiX (ccx) is not installed, or the Host is off',
  );
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'bim');
  await bimReady(page);
  const empty = await nativeArtifact(page);
  // F88 without the concrete's stiffness: it is given through the material's fields.
  const building = f88Building();
  const concrete = building.materials.find((m) => m.id === 'm-concrete')!;
  delete concrete.youngsModulusMPa;
  delete concrete.poissonsRatio;
  await importJson(page, 'office.json', {
    ...empty,
    name: 'Office',
    draft: { ...empty.draft, content: building },
  });
  await bimReady(page);
  const inspector = page.locator('.bim-inspector');
  if (!(await inspector.isVisible()))
    await page.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
  await inspector.getByRole('tab', { name: 'Types' }).click();
  await inspector.getByRole('button', { name: /^RC column 600/ }).click();
  const young = inspector.getByLabel("Young's modulus (MPa)", { exact: true });
  await young.fill('24000');
  await young.press('Enter');
  const poisson = inspector.getByLabel("Poisson's ratio", { exact: true });
  await poisson.fill('0.2');
  await poisson.press('Enter');
  await expect
    .poll(async () => {
      const content = (await nativeArtifact(page)).draft.content as BimDocument;
      const m = content.materials.find((x) => x.id === 'm-concrete');
      return [m?.youngsModulusMPa, m?.poissonsRatio];
    })
    .toEqual([24000, 0.2]);
  await save(page, 1);

  await create(page, 'construction');
  await expect(surface(page)).toBeVisible();
  const f88 = f88OfficeFrame();
  await page.getByLabel('Task CSV', { exact: true }).setInputFiles({
    name: 'office.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(writeConstructionCsv(f88.tasks)),
  });
  await page.getByText('Calendar', { exact: true }).click();
  await page.getByLabel('Start date', { exact: true }).fill(f88.startDate);
  await page.getByLabel('Holidays', { exact: true }).fill(f88.calendar.holidays.join('\n'));
  await page.getByRole('button', { name: 'Set calendar', exact: true }).click();
  await expect(summary(page)).toContainText('28 tasks');
  await expect(page.getByText('Evaluating the building…')).toBeHidden({ timeout: 120_000 });

  // The crane with its own mass, lifting the first columns.
  const crane = f88.site!.cranes![0]!;
  await page.getByText('Cranes', { exact: true }).click();
  await page.getByRole('button', { name: 'Add crane', exact: true }).click();
  await page.getByLabel('Crane name', { exact: true }).fill(crane.name);
  await page.getByLabel('Crane base', { exact: true }).fill(crane.base.join(', '));
  await page
    .getByLabel('Load chart', { exact: true })
    .fill(crane.loadChart.map((r) => `${r.radius}, ${r.capacityKg}`).join('\n'));
  await page.getByLabel('Crane put up by', { exact: true }).selectOption(crane.fromTaskId);
  await page.getByLabel('Crane mass', { exact: true }).fill('60000');
  await page.getByRole('button', { name: 'Save crane', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Cranes' })).toContainText(crane.name);
  await page.getByLabel('Pick point', { exact: true }).fill('52000, 11000, 1000');
  await page.getByLabel('Lift task', { exact: true }).selectOption('col-1');
  await page.getByRole('button', { name: 'Add lifts for task', exact: true }).click();
  await expect(page.getByText('35 lifts planned')).toBeVisible();

  // The shoring of 4F on the 3F slabs while 4F is cast: the slab-3 task's slabs, selected.
  await page.getByText('Frame analysis', { exact: true }).click();
  await page.getByRole('table', { name: 'Tasks' }).getByText('Slab 3F', { exact: true }).click();
  await page.getByRole('button', { name: 'Add site load on selection', exact: true }).click();
  const loadForm = page.getByRole('form', { name: 'Site load' });
  await loadForm.getByLabel('Load name', { exact: true }).fill('Shoring and rebar for 4F');
  await loadForm.getByLabel('Load task', { exact: true }).selectOption('slab-4');
  await loadForm.getByLabel('Load per area', { exact: true }).fill('6');
  await loadForm.getByRole('button', { name: 'Save site load', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Site loads' })).toContainText(
    'Shoring and rebar for 4FSlab 4F61',
  );
  // Unsaved edits hold the form: closing its own row keeps it open until they are discarded.
  await loadForm.getByLabel('Load per area', { exact: true }).fill('7');
  await page
    .getByRole('table', { name: 'Site loads' })
    .getByText('Shoring and rebar for 4F')
    .click();
  await expect(page.getByText('Save or discard the site load form first.')).toBeVisible();
  await expect(loadForm).toBeVisible();
  await loadForm.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(loadForm.getByLabel('Load per area', { exact: true })).toHaveValue('6');

  // The day the 4F slab is cast: the 3F beams carry it and the shoring, before 5F stands.
  const plan = scheduleConstruction(f88);
  await page.getByLabel('Date', { exact: true }).fill(plan.byId.get('slab-4')!.start);
  await page.getByRole('button', { name: 'Analyse the day', exact: true }).click();
  const results = page.getByLabel('Frame results', { exact: true });
  await expect(results).toBeVisible({ timeout: 120_000 });
  const rows = page.getByRole('table', { name: 'Members against the completed building' });
  const first = rows.locator('tbody tr').first();
  await expect(first.locator('td').first()).toHaveText(/^b-3-/);
  const ratio = Number((await first.locator('td').nth(3).textContent())!.replace('×', ''));
  expect(ratio).toBeGreaterThan(1.5);
  await page.getByLabel('Colour by day ÷ completed').check();
  if (shots) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${shots}/cs4b-frame.png` });
  }
  // The crane's foundation: 60 t and the heaviest column, all plan long.
  const reactions = page.getByRole('table', { name: 'Crane foundation reactions' });
  await expect(reactions).toContainText(`${crane.name}Whole plan623 kN`);
  await expect(reactions).toContainText(`${crane.name}On the day589 kN`);
});

// CS5b: the day's people and trucks — the fixture's routes and the rebar zone imported with the
// site, the approaches listed by time (a row moves the clock there), a zone added through its
// form, the gate counted, and time played with the workers walking.
test('walk the workers and drive the trucks through a day, list the approaches (ST-550, TS-2087)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'bim');
  await bimReady(page);
  const emptyBim = await nativeArtifact(page);
  await importJson(page, 'office.json', {
    ...emptyBim,
    name: 'Office',
    draft: { ...emptyBim.draft, content: f88Building() },
  });
  await bimReady(page);
  await save(page, 1);

  await create(page, 'construction');
  await expect(surface(page)).toBeVisible();
  const empty = await nativeArtifact(page);
  const source = (empty.draft.content as ConstructionDocument).source;
  const f89 = f89OfficeTraffic();
  await importJson(page, 'traffic.json', {
    ...empty,
    name: 'Office traffic',
    draft: { ...empty.draft, content: { ...f89, source } },
  });
  await expect(summary(page)).toContainText('28 tasks');
  await expect(page.getByText('Evaluating the building…')).toBeHidden({ timeout: 120_000 });

  const plan = scheduleConstruction(f89);
  await page.getByLabel('Date', { exact: true }).fill(plan.byId.get('col-1')!.start);
  const routes = page.getByRole('table', { name: 'Routes' });
  await expect(routes).toContainText('Steel deliveryTrucks10');
  await expect(page.getByRole('table', { name: 'Danger zones' })).toContainText('Rebar cutting');
  // The day's approaches, by time: the walk at 07:40 past the slewing circle, the pit edge and
  // a load; the trucks past the slewing circle and the rebar area.
  const approaches = page.getByRole('table', { name: 'Approaches to danger' });
  await expect(approaches.locator('tbody tr')).toHaveCount(7, { timeout: 60_000 });
  await expect(approaches.locator('tbody tr').first()).toContainText('07:40:00–07:41:07');
  await expect(page.getByLabel('Gate counts', { exact: true })).toHaveText(
    'Gate: 3 trucks, 2 walking',
  );
  // Unsaved hours hold the save until set or discarded.
  await page.getByLabel('Day ends', { exact: true }).fill('18:00');
  await expect(page.getByText(/未確定の入力があります/)).toBeVisible();
  await page.getByRole('button', { name: 'Discard hours', exact: true }).click();
  await expect(page.getByText(/未確定の入力があります/)).toBeHidden();
  await expect(page.getByLabel('Day ends', { exact: true })).toHaveValue('17:30');
  // A row moves the clock to it: the truck passing the rebar area at 13:30.
  await approaches.getByText('13:30:03–13:30:07').click();
  await expect(page.getByLabel('Clock', { exact: true })).toHaveText('13:30');
  if (shots) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${shots}/cs5b-traffic.png` });
  }

  // A zone through its form: the steel yard while the columns go up, all day.
  await page.getByRole('button', { name: 'Add danger zone', exact: true }).click();
  const zone = page.getByRole('form', { name: 'Danger zone' });
  await zone.getByLabel('Zone name', { exact: true }).fill('Steel yard');
  await zone
    .getByLabel('Zone outline', { exact: true })
    .fill('44000, 6000\n46500, 6000\n46500, 9000\n44000, 9000');
  await zone.getByLabel('Zone task', { exact: true }).selectOption('col-1');
  // Hours must be HH:MM: the edit is refused and nothing changes.
  await zone.getByLabel('Zone hours', { exact: true }).fill('9:00-10:00');
  await zone.getByRole('button', { name: 'Save zone', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Danger zones' })).not.toContainText('Steel yard');
  await zone.getByLabel('Zone hours', { exact: true }).fill('');
  await zone.getByRole('button', { name: 'Save zone', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Danger zones' })).toContainText(
    'Steel yardColumns 1Fall day',
  );
  // The workers' way to the office passes it.
  await expect(approaches).toContainText('Zone: Steel yard');

  // Play: the clock runs on from the first trip while the workers walk.
  await page.getByLabel('Time', { exact: true }).fill('450');
  await page.getByRole('button', { name: 'Play time', exact: true }).click();
  await expect(page.getByLabel('Clock', { exact: true })).not.toHaveText('07:30');
  await page.getByRole('button', { name: 'Stop time', exact: true }).click();
  if (shots) {
    await page.getByLabel('Time', { exact: true }).fill('461');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${shots}/cs5b-walkers.png` });
  }
});

// CS6b: the schedule with its building as one IFC4 file (tasks, links, elements and the temporary
// works as proxies), and every check of the day as one CSV.
test('export the schedule as IFC and the checks as CSV (ST-552, TS-2090)', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(300_000);
  await page.goto('/');
  await create(page, 'bim');
  await bimReady(page);
  const emptyBim = await nativeArtifact(page);
  await importJson(page, 'office.json', {
    ...emptyBim,
    name: 'Office',
    draft: { ...emptyBim.draft, content: f88Building() },
  });
  await bimReady(page);
  await save(page, 1);
  await create(page, 'construction');
  await expect(surface(page)).toBeVisible();
  const empty = await nativeArtifact(page);
  const source = (empty.draft.content as ConstructionDocument).source;
  const f89 = f89OfficeTraffic();
  await importJson(page, 'traffic.json', {
    ...empty,
    name: 'Office traffic',
    draft: { ...empty.draft, content: { ...f89, source } },
  });
  await expect(summary(page)).toContainText('28 tasks');
  await expect(page.getByText('Evaluating the building…')).toBeHidden({ timeout: 120_000 });

  const ifcDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export IFC', exact: true }).click();
  const ifcFile = await ifcDownload;
  expect(ifcFile.suggestedFilename()).toBe(`${f89.name}.ifc`);
  const ifc = await readFile((await ifcFile.path())!, 'utf8');
  const count = (type: string) => ifc.split('\n').filter((l) => l.includes(`=${type}(`)).length;
  expect(count('IFCWORKSCHEDULE')).toBe(1);
  expect(count('IFCTASK')).toBe(28);
  expect(count('IFCBUILDINGELEMENTPROXY')).toBe(f89.site!.temporaries.length);
  expect(count('IFCRELSEQUENCE')).toBe(f89.tasks.reduce((n, t) => n + t.predecessors.length, 0));
  await expect(page.getByLabel('Export status', { exact: true })).toHaveText(
    `IFC written: 28 tasks, ${f89.site!.temporaries.length} temporary works.`,
  );
  // IfcOpenShell reads it without a schema error, where it is installed.
  const python = spawnSync('python3', ['-c', 'import ifcopenshell'], { encoding: 'utf8' });
  if (python.status === 0) {
    const check = spawnSync(
      'python3',
      ['docs/verification/construction-site/check-schedule-ifc.py', (await ifcFile.path())!],
      { encoding: 'utf8' },
    );
    expect(check.stdout).toContain('issues 0');
  }

  // The checks of the first column day: its approaches among them.
  const plan = scheduleConstruction(f89);
  await page.getByLabel('Date', { exact: true }).fill(plan.byId.get('col-1')!.start);
  await expect(
    page.getByRole('table', { name: 'Approaches to danger' }).locator('tbody tr'),
  ).toHaveCount(7, { timeout: 60_000 });
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export checks', exact: true }).click();
  const csv = await readFile((await (await csvDownload).path())!, 'utf8');
  const rows = csv.trim().split('\r\n');
  expect(rows[0]).toBe('area,code,where,day,message');
  expect(rows.filter((r) => r.startsWith('traffic,approach-'))).toHaveLength(7);
  await expect(page.getByLabel('Export status', { exact: true })).toHaveText(
    `Checks written: ${rows.length - 1} rows.`,
  );
});

test('record the days played as an MP4 and render a path-traced still of the day (ST-553, TS-2092)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.setTimeout(600_000);
  await page.goto('/');
  await create(page, 'bim');
  await bimReady(page);
  const emptyBim = await nativeArtifact(page);
  await importJson(page, 'office.json', {
    ...emptyBim,
    name: 'Office',
    draft: { ...emptyBim.draft, content: f88Building() },
  });
  await bimReady(page);
  await save(page, 1);
  await create(page, 'construction');
  await expect(surface(page)).toBeVisible();
  const empty = await nativeArtifact(page);
  const source = (empty.draft.content as ConstructionDocument).source;
  const f89 = f89OfficeTraffic();
  await importJson(page, 'traffic.json', {
    ...empty,
    name: 'Office traffic',
    draft: { ...empty.draft, content: { ...f89, source } },
  });
  await expect(summary(page)).toContainText('28 tasks');
  await expect(page.getByText('Evaluating the building…')).toBeHidden({ timeout: 120_000 });
  const plan = scheduleConstruction(f89);
  const shown = plan.byId.get('col-1')!.start;
  await page.getByLabel('Date', { exact: true }).fill(shown);

  // Six days from the first columns, six days a second: one second, 30 frames.
  await page.getByRole('button', { name: 'Record video', exact: true }).click();
  const form = page.getByRole('group', { name: 'Video' });
  await form.getByLabel('Video from').fill(shown);
  await form.getByLabel('Video to').fill(addDays(shown, 5));
  await form.getByLabel('Days a second').selectOption('6');
  await expect(form.getByLabel('Video size')).toHaveValue('1280x720');
  // A reversed range is refused before anything is drawn.
  await form.getByLabel('Video to').fill(addDays(shown, -1));
  await expect(form).toContainText('From must not come after To.');
  await expect(form.getByRole('button', { name: 'Record', exact: true })).toBeDisabled();
  await form.getByLabel('Video to').fill(addDays(shown, 5));
  const download = page.waitForEvent('download', { timeout: 300_000 });
  await form.getByRole('button', { name: 'Record', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(
    `${f89.name.replace(/ /g, '-')}-${shown}-${addDays(shown, 5)}.mp4`,
  );
  const path = test.info().outputPath(file.suggestedFilename());
  await file.saveAs(path);
  await expect(page.getByLabel('Export status', { exact: true })).toContainText('Video recorded: ');
  // The view is back on the day it showed.
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue(shown);
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path],
    { encoding: 'utf8' },
  );
  if (probe.status === 0) {
    const info = JSON.parse(probe.stdout) as {
      streams: Record<string, unknown>[];
      format: { duration: string };
    };
    expect(info.streams[0]).toMatchObject({
      codec_name: 'h264',
      width: 1280,
      height: 720,
      nb_read_frames: '30',
      r_frame_rate: '30/1',
    });
    expect(Number(info.format.duration)).toBeCloseTo(1, 3);
  }

  // A small path-traced still of the day.
  await page.getByRole('button', { name: 'Render image', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Render image' });
  await dialog.getByLabel('Width (px)').fill('320');
  await dialog.getByLabel('Height (px)').fill('180');
  await dialog.getByLabel('Samples').fill('4');
  await dialog.getByRole('button', { name: 'Render', exact: true }).click();
  await expect(dialog.getByTestId('view-render-done')).toHaveText(/^320 × 180 px, \d+ samples?/, {
    timeout: 300_000,
  });
  const png = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save PNG' }).click();
  const still = await readFile((await (await png).path())!);
  expect([still.readUInt32BE(16), still.readUInt32BE(20)]).toEqual([320, 180]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});
