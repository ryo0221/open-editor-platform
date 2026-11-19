import { f02Plate, type CadDocument } from '@editor-platform/cad-core';
import { copyFileSync, readFileSync } from 'node:fs';
import { f31BoxBuilding } from '@editor-platform/bim-core';
import {
  f170SmallLine,
  f174PlcLine,
  f175PlcLineBug,
  newFactory,
  type FactoryDocument,
} from '@editor-platform/factory-core';
import { ladderToPlcopen } from '@editor-platform/ladder-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// FT2 (ST-833, ST-834, TS-2655): the factory Surface in the ordinary Playground.

const shots = process.env.FT_SHOTS;
const status = (page: Page) => page.getByTestId('fac-status');
const tool = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const object = (page: Page, label: string) =>
  page.getByTestId('fac-plan').getByRole('button', { name: label, exact: true });
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
const draft = async (page: Page) => (await nativeArtifact(page)).draft.content as FactoryDocument;

test('build a line on the plan, run it, move, Undo, save, reload', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'factory');
  await expect(page.getByTestId('fac-plan')).toContainText('Add a source');
  expect(await draft(page)).toEqual(newFactory('Factory'));
  await expect(status(page)).toHaveText('Not run');
  // Source → Station → Drain, linked by "Link to…" then a click on the target.
  await tool(page, 'Add source').click();
  await tool(page, 'Add station').click();
  await tool(page, 'Add drain').click();
  await object(page, 'Source Source').click();
  await tool(page, 'Link to…').click();
  await object(page, 'Station Station').click();
  await object(page, 'Station Station').click();
  await tool(page, 'Link to…').click();
  await object(page, 'Drain Drain').click();
  let doc = await draft(page);
  expect(doc.objects.map((o) => o.kind)).toEqual(['source', 'station', 'drain']);
  expect(doc.links.map((l) => `${l.from}>${l.to}`)).toEqual(['source>station', 'station>drain']);
  await expect(page.getByTestId('fac-warnings')).toBeHidden();
  // The station's processing time from the inspector: 70 s against a 60 s interval.
  await object(page, 'Station Station').click();
  await page.getByLabel('Processing time value (s)', { exact: true }).fill('70');
  await page.getByLabel('Processing time value (s)', { exact: true }).press('Enter');
  doc = await draft(page);
  expect(doc.objects[1]).toMatchObject({ processTime: { type: 'const', value: 70_000 } });
  // Run in the Worker: 8 h of a 70 s station gives 411 parts, the station is the bottleneck.
  await tool(page, 'Run').click();
  await expect(status(page)).toContainText('Result: 411 produced');
  await expect(page.getByTestId('fac-bottleneck-mark')).toBeVisible();
  await expect(page.getByTestId('fac-bottlenecks').locator('tbody tr').first()).toContainText(
    'Station',
  );
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByTestId('fac-gantt').locator('rect').first()).toBeVisible();
  // The (now stale) timeline keeps the run's rows when the model gains an object; Undo.
  await tool(page, 'Add station').click();
  await expect(page.getByTestId('fac-gantt').locator('rect').first()).toBeVisible();
  await tool(page, 'Undo').click();
  await expect.poll(async () => (await draft(page)).objects.length).toBe(3);
  await page.getByRole('tab', { name: 'Lead time' }).click();
  await expect(page.getByTestId('fac-lead')).toContainText('Mean 79.976 s');
  // Drag the drain down; every object gets a placement, the drain lands on 100 mm.
  const box = (await object(page, 'Drain Drain').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  doc = await draft(page);
  const drain = doc.objects.find((o) => o.kind === 'drain')!;
  expect(drain.at!.y).toBeLessThan(0);
  expect(Math.abs(drain.at!.y % 100)).toBe(0);
  // An edit makes the result stale; Host Undo takes the move back.
  await expect(status(page)).toContainText('Result of an earlier model');
  await tool(page, 'Undo').click();
  expect((await draft(page)).objects.find((o) => o.kind === 'drain')!.at).toEqual({
    x: 8000,
    y: 0,
  });
  // A refused inspector draft holds back Host Undo instead of being lost.
  await object(page, 'Station Station').click();
  const time = page.getByLabel('Processing time value (s)', { exact: true });
  await time.fill('-1');
  await time.press('Enter');
  await tool(page, 'Undo').click();
  await expect(
    page.getByText('Factory の入力を確定またはキャンセルしてから履歴を操作してください。'),
  ).toBeVisible();
  await expect(time).toHaveValue('-1');
  await time.fill('70');
  await time.press('Enter');
  expect((await draft(page)).objects).toHaveLength(3);
  await save(page, 1);
  await page.reload();
  await expect(object(page, 'Drain Drain')).toBeVisible();
  const record = await nativeArtifact(page);
  expect(record.kind).toBe('factory');
  expect(record.versions).toHaveLength(1);
  expect(record.versions[0]!.content).toEqual(await draft(page));
});

test('import the F170 line, run it, import times from CSV, refuse bad content', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'factory');
  const record = await nativeArtifact(page);
  await importJson(page, 'f170.json', {
    ...record,
    name: 'F170 line',
    draft: { ...record.draft, content: f170SmallLine() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F170 line');
  expect(await draft(page)).toEqual(f170SmallLine());
  await tool(page, 'Run').click();
  await expect(status(page)).toContainText('Result: 477 produced, 59.6/h');
  await expect(page.getByTestId('fac-bottlenecks').locator('tbody tr').first()).toContainText(
    'End-of-line test',
  );
  await page.getByLabel('Show flows').check();
  await object(page, 'Station End-of-line test').click();
  await expect(page.getByTestId('fac-object-result')).toContainText('out 477');
  // A times CSV (the test station 40 s) as one edit; the assembly becomes the bottleneck.
  await page.getByLabel('Times CSV file').setInputFiles({
    name: 'times.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('object,type,value\ntest,const,40\n'),
  });
  await expect
    .poll(async () => (await draft(page)).objects.find((o) => o.id === 'test'))
    .toMatchObject({ processTime: { type: 'const', value: 40_000 } });
  await tool(page, 'Run').click();
  await expect(page.getByTestId('fac-bottlenecks').locator('tbody tr').first()).not.toContainText(
    'End-of-line test',
  );
  // A bad CSV is refused whole, with its line.
  await page.getByLabel('Times CSV file').setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('object,type,value\nnope,const,1\n'),
  });
  await expect(page.getByTestId('fac-notice')).toContainText('line 2');
  // Invalid content (a link to a missing object) is refused on import.
  const bad = f170SmallLine();
  bad.links.push({ id: 'x', from: 'test', to: 'missing' });
  await importJson(page, 'bad.json', {
    ...record,
    name: 'Bad factory',
    draft: { ...record.draft, content: bad },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F170 line');
});

test('FT3a: a shift calendar and breakdowns from the inspector', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'factory');
  const record = await nativeArtifact(page);
  await importJson(page, 'f170.json', {
    ...record,
    name: 'F170 line',
    draft: { ...record.draft, content: f170SmallLine() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F170 line');
  await page.getByRole('button', { name: 'Add calendar', exact: true }).click();
  await expect(page.getByLabel('Shifts of calendar (h, start-end)')).toHaveValue('6-14, 14-22');
  await object(page, 'Station End-of-line test').click();
  await page.getByLabel('Calendar', { exact: true }).selectOption('calendar');
  await page.getByLabel('Breakdowns').check();
  const station = (await draft(page)).objects.find((o) => o.id === 'test')!;
  expect(station).toMatchObject({
    calendarId: 'calendar',
    failures: { uptime: { type: 'exponential', mean: 3_600_000 } },
  });
  await tool(page, 'Run').click();
  await expect(status(page)).toContainText('Result:');
  // From 1 h to 9 h the test station is off shift until 6 h: 5 of the 8 hours.
  const row = page.getByTestId('fac-states').getByRole('row', { name: /^End-of-line test/ });
  await expect(row).toContainText('62.5%');
  await expect(page.getByTestId('fac-states').locator('thead')).toContainText('failed');
  // A calendar in use cannot be removed.
  await page.getByRole('button', { name: 'Remove calendar calendar', exact: true }).click();
  await expect(page.getByTestId('fac-notice')).toContainText('An object still works');
});

test('FT3b: a worker pool staffs a station', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'factory');
  const record = await nativeArtifact(page);
  await importJson(page, 'f170.json', {
    ...record,
    name: 'F170 line',
    draft: { ...record.draft, content: f170SmallLine() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F170 line');
  await page.getByRole('button', { name: 'Add worker pool', exact: true }).click();
  await page.getByLabel('Workers in workers', { exact: true }).fill('1');
  await page.getByLabel('Workers in workers', { exact: true }).press('Enter');
  await object(page, 'Station End-of-line test').click();
  await page.getByLabel('Workers needed (0 = none)').fill('1');
  await page.getByLabel('Workers needed (0 = none)').press('Enter');
  expect((await draft(page)).objects.find((o) => o.id === 'test')).toMatchObject({
    workers: { count: 1 },
  });
  await tool(page, 'Run').click();
  await expect(status(page)).toContainText('Result:');
  // Unplaced objects stand at 0,0: the worker never walks and is busy while the station works.
  const row = page.getByTestId('fac-workers').getByRole('row', { name: /^Workers/ });
  await expect(row).toContainText('92.6%');
  await expect(row).toContainText('0.0%');
});

test('FT3c: a path network and an AGV fleet carry a link', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'factory');
  await tool(page, 'Add source').click();
  await tool(page, 'Add station').click();
  await tool(page, 'Add drain').click();
  await object(page, 'Source Source').click();
  await tool(page, 'Link to…').click();
  await object(page, 'Station Station').click();
  await object(page, 'Station Station').click();
  await tool(page, 'Link to…').click();
  await object(page, 'Drain Drain').click();
  // A two-way aisle of 30 m between the station and the drain.
  const points = page.getByLabel('Path points (id x y in m; …)', { exact: true });
  await points.fill('p-a 0 0; p-b 30 0');
  await points.press('Enter');
  const segs = page.getByLabel('Path segments (a > b, a <> b)', { exact: true });
  await segs.fill('p-a <> p-b');
  await segs.press('Enter');
  await segs.fill('p-a <> nowhere ?');
  await segs.press('Enter');
  await expect(page.getByTestId('fac-notice')).toContainText('(paths)');
  await segs.fill('p-a <> p-b');
  await segs.press('Enter');
  await page.getByRole('button', { name: 'Add fleet', exact: true }).click();
  let doc = await draft(page);
  expect(doc.paths).toEqual({
    nodes: [
      { id: 'p-a', x: 0, y: 0 },
      { id: 'p-b', x: 30_000, y: 0 },
    ],
    segments: [{ id: 'seg-1', from: 'p-a', to: 'p-b', twoWay: true }],
  });
  expect(doc.fleets).toMatchObject([{ id: 'agv', count: 2, homeNodeId: 'p-a' }]);
  await object(page, 'Station Station').click();
  await page.getByLabel('Path node', { exact: true }).selectOption('p-a');
  await object(page, 'Drain Drain').click();
  await page.getByLabel('Path node', { exact: true }).selectOption('p-b');
  await page
    .getByTestId('fac-plan')
    .getByRole('button', { name: 'Link station to drain', exact: true })
    .dispatchEvent('pointerdown');
  await page.getByLabel('Carried by', { exact: true }).selectOption('agv');
  doc = await draft(page);
  expect(doc.links[1]).toMatchObject({ transport: { fleetId: 'agv' } });
  await tool(page, 'Run').click();
  await expect(status(page)).toContainText('Result:');
  const row = page.getByTestId('fac-fleet-stats').getByRole('row', { name: /^AGVs/ });
  await expect(row).toBeVisible();
  await expect(page.getByTestId('fac-deadlock')).toBeHidden();
});

// FT4a (ST-838, TS-2660): the factory stands in a saved Building version; objects and lanes
// that run into its walls are listed, the version is kept with the factory and survives reload.
test('FT4a: a factory in a saved building lists clashes with its walls', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  // The F31 box (10 × 8 m, door in the south wall), saved as v1.
  await create(page, 'bim');
  await expect(page.getByTestId('bim-model-state')).toHaveText('Model up to date', {
    timeout: 90_000,
  });
  const empty = await nativeArtifact(page);
  await importJson(page, 'hall.json', {
    ...empty,
    name: 'Hall',
    draft: { ...empty.draft, content: f31BoxBuilding() },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Hall');
  await save(page, 1);

  // A station inside, and one straddling the south wall.
  await create(page, 'factory');
  const blank = await nativeArtifact(page);
  const doc = newFactory('Cell');
  doc.objects = [
    {
      id: 'in',
      name: 'Inside',
      kind: 'station',
      processTime: { type: 'const', value: 10_000 },
      at: { x: 5000, y: 4000 },
    },
    {
      id: 'out',
      name: 'Straddle',
      kind: 'station',
      processTime: { type: 'const', value: 10_000 },
      at: { x: 5000, y: 0 },
    },
  ];
  await importJson(page, 'cell.json', {
    ...blank,
    name: 'Cell',
    draft: { ...blank.draft, content: doc },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Cell');
  await expect(page.getByTestId('fac-building')).toHaveCount(0);
  const version = page.getByLabel('Building version', { exact: true });
  await expect(version.locator('option')).toHaveText(['(none)', 'Hall · v1']);
  await version.selectOption({ label: 'Hall · v1' });
  await expect(page.getByTestId('fac-building')).toBeVisible();
  await expect(page.getByTestId('fac-clashes')).toHaveText('Straddle runs into wall w-south');
  // FT4b: the 3D view draws the building with the kernel (no status once evaluated).
  await page.getByRole('tab', { name: '3D', exact: true }).click();
  await expect(page.getByTestId('fac-3d').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('fac-3d-status')).toBeHidden({ timeout: 90_000 });
  if (shots) await page.screenshot({ path: `${shots}/ft4b-building.png` });
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  await expect(page.getByTestId('fac-footprints').locator('[data-clash="true"]')).toHaveCount(1);
  let record = await nativeArtifact(page);
  expect((record.draft.content as FactoryDocument).building).toMatchObject({
    versionId: expect.any(String),
  });
  expect(record.factorySources).toHaveLength(1);
  // The building and its check stay after a save and a reload.
  await save(page, 1);
  await page.reload();
  await expect(page.getByTestId('fac-clashes')).toHaveText('Straddle runs into wall w-south');
  record = await nativeArtifact(page);
  expect(record.factorySources).toHaveLength(1);
  // Unset: no building, no footprints check.
  await page.getByLabel('Building version', { exact: true }).selectOption('');
  await expect(page.getByTestId('fac-building')).toHaveCount(0);
  expect((await draft(page)).building).toBeUndefined();
});

// FT4b (ST-839, TS-2663): the 3D view replays a run: the time slider moves through the run,
// parts and objects are drawn at that time, and a click on an object selects it.
test('FT4b: without WebGL the 3D tab says so and the plan still works', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.addInitScript(() => {
    // three.js reports the refused context itself: that report is what this test provokes.
    const error = console.error.bind(console);
    console.error = (...a: unknown[]) => {
      if (!String(a[0]).includes('Error creating WebGL context')) error(...a);
    };
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      return /webgl/.test(kind)
        ? null
        : (get as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof get;
  });
  await page.goto('/');
  await create(page, 'factory');
  await page.getByRole('tab', { name: '3D', exact: true }).click();
  await expect(page.getByTestId('fac-3d-status')).toContainText('could not start here');
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  await expect(page.getByTestId('fac-plan')).toBeVisible();
});

test('FT4b: the 3D view replays the F170 run', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'factory');
  const record = await nativeArtifact(page);
  await importJson(page, 'f170.json', {
    ...record,
    name: 'F170 line',
    draft: { ...record.draft, content: f170SmallLine() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F170 line');
  await page.getByRole('tab', { name: '3D', exact: true }).click();
  await expect(page.getByTestId('fac-3d').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('fac-replay-time')).toHaveText('Run to replay');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await tool(page, 'Run').click();
  await expect(status(page)).toContainText('Result: 477 produced');
  const slider = page.getByLabel('Replay time (s)', { exact: true });
  await expect(slider).toHaveAttribute('max', '32400');
  await slider.fill('14400');
  await expect(page.getByTestId('fac-replay-time')).toHaveText('04:00:00');
  await expect(page.getByTestId('fac-replay-counts')).toContainText(/^[1-9]\d* parts/);
  if (shots) await page.screenshot({ path: `${shots}/ft4b-replay.png` });
  // Play at ×600 moves the time on.
  await page.getByLabel('Replay speed', { exact: true }).selectOption('600');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByTestId('fac-replay-time')).not.toHaveText('04:00:00');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  // Back on the plan, the model is as it was.
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  await expect(page.getByTestId('fac-plan')).toBeVisible();
  expect(await draft(page)).toEqual(f170SmallLine());
});

// FT4c (ST-840, TS-2666): a still (1080p PNG) and a video (MP4) of the replay, back at the time shown.
test('FT4c: a still and a video of the replay', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'factory');
  const record = await nativeArtifact(page);
  await importJson(page, 'f170.json', {
    ...record,
    name: 'F170 line',
    draft: { ...record.draft, content: f170SmallLine() },
    versions: [],
  });
  await page.getByRole('tab', { name: '3D', exact: true }).click();
  await tool(page, 'Run').click();
  await expect(status(page)).toContainText('Result: 477 produced');
  await page.getByLabel('Replay time (s)', { exact: true }).fill('14400');
  await expect(page.getByTestId('fac-replay-time')).toHaveText('04:00:00');
  const note = page.getByLabel('Export status', { exact: true });

  // A still at 1080p, named by the replay time.
  const still = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save still', exact: true }).click();
  const png = await still;
  expect(png.suggestedFilename()).toBe('Small-e-Axle-line-040000.png');
  const pngPath = test.info().outputPath(png.suggestedFilename());
  await png.saveAs(pngPath);
  const head = readFileSync(pngPath);
  expect(head.subarray(1, 4).toString()).toBe('PNG');
  expect([head.readUInt32BE(16), head.readUInt32BE(20)]).toEqual([1920, 1080]);
  await expect(note).toHaveText('Still saved: Small-e-Axle-line-040000.png.');
  if (shots) copyFileSync(pngPath, `${shots}/ft4c-still.png`);

  // One minute of the run at ×60: one video second, 31 frames.
  await page.getByRole('button', { name: 'Record video', exact: true }).click();
  const form = page.getByRole('group', { name: 'Video' });
  await expect(form.getByLabel('Video from (s)')).toHaveValue('14400');
  await form.getByLabel('Video to (s)').fill('14300');
  await expect(form).toContainText('From must come before To.');
  await expect(form.getByRole('button', { name: 'Record', exact: true })).toBeDisabled();
  await form.getByLabel('Video to (s)').fill('14460');
  await form.getByLabel('Video speed').selectOption('60');
  const video = page.waitForEvent('download', { timeout: 300_000 });
  await form.getByRole('button', { name: 'Record', exact: true }).click();
  const mp4 = await video;
  expect(mp4.suggestedFilename()).toBe('Small-e-Axle-line-040000-040100.mp4');
  const mp4Path = test.info().outputPath(mp4.suggestedFilename());
  await mp4.saveAs(mp4Path);
  await expect(note).toHaveText('Video recorded: Small-e-Axle-line-040000-040100.mp4, 31 frames.');
  expect(readFileSync(mp4Path).subarray(4, 8).toString()).toBe('ftyp');
  // The view is back at the time it showed.
  await expect(page.getByTestId('fac-replay-time')).toHaveText('04:00:00');
  // A new run while recording stops the recording (its replay is gone), with a note.
  await page.getByRole('button', { name: 'Record video', exact: true }).click();
  await form.getByLabel('Video to (s)').fill('15000');
  await form.getByLabel('Video speed').selectOption('1');
  await form.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByTestId('fac-video-progress')).toBeVisible();
  await tool(page, 'Run').click();
  await expect(note).toHaveText('The recording stopped: the model or its run changed.');
  await expect(page.getByTestId('fac-video-progress')).toHaveCount(0);
  expect(await draft(page)).toEqual(f170SmallLine());
});

// FT4c-2 (ST-841, TS-2669): a saved CAD part version is a machine's look in 3D; the version is
// kept with the factory, survives reload, and (box) brings the box back.
test('FT4c: a machine drawn by a saved CAD version', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  test.skip(!process.env.CAD_OCCT_DIST, 'CAD_OCCT_DIST is not set');
  test.setTimeout(240_000);
  await page.goto('/');
  // The F02 plate, saved as v1 of "Press".
  await create(page, 'cad');
  const empty = await nativeArtifact(page);
  const { id, buildHash } = (empty.draft.content as CadDocument).kernelProfile;
  const plate = f02Plate();
  await importJson(page, 'press.json', {
    ...empty,
    name: 'Press',
    draft: {
      ...empty.draft,
      content: { ...plate, kernelProfile: { ...plate.kernelProfile, id, buildHash } },
    },
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Press');
  await save(page, 1);

  await create(page, 'factory');
  const record = await nativeArtifact(page);
  await importJson(page, 'f170.json', {
    ...record,
    name: 'F170 line',
    draft: { ...record.draft, content: f170SmallLine() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F170 line');
  await object(page, 'Parallel station Machining cell').click();
  const look = page.getByLabel('Look (CAD version)', { exact: true });
  await expect(look.locator('option')).toHaveText(['(box)', /^Press — v1/]);
  // A refused draft in the inspector holds the choice back and keeps the focus.
  const width = page.getByLabel('Width (mm)', { exact: true });
  await width.fill('wide');
  await look.selectOption({ index: 1 });
  await expect(width).toBeFocused();
  await expect(look).toHaveValue('');
  await width.fill('2400');
  await width.press('Enter');
  expect((await draft(page)).objects[1]!.look).toBeUndefined();
  await look.selectOption({ index: 1 });
  await expect(look.locator('option').nth(1)).toHaveText(/^Press — v1/);
  await expect(look).toHaveValue('current');
  let saved = await nativeArtifact(page);
  expect((saved.draft.content as FactoryDocument).objects[1]!.look).toMatchObject({
    versionId: expect.any(String),
  });
  expect(saved.factoryLooks).toHaveLength(1);
  // The 3D view draws it once the kernel has made it.
  await page.getByRole('tab', { name: '3D', exact: true }).click();
  await expect(page.getByTestId('fac-3d')).toHaveAttribute('data-looks', '1', { timeout: 120_000 });
  await expect(page.getByTestId('fac-look-status')).toBeHidden();
  if (shots) await page.screenshot({ path: `${shots}/ft4c-look.png` });
  // Kept with the factory after a save and a reload.
  await save(page, 1);
  await page.reload();
  saved = await nativeArtifact(page);
  expect(saved.factoryLooks).toHaveLength(1);
  await page.getByRole('tab', { name: '3D', exact: true }).click();
  await expect(page.getByTestId('fac-3d')).toHaveAttribute('data-looks', '1', { timeout: 120_000 });
  // (box): the box again.
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  await object(page, 'Parallel station Machining cell').click();
  await page.getByLabel('Look (CAD version)', { exact: true }).selectOption('');
  expect((await draft(page)).objects[1]!.look).toBeUndefined();
});

test('FT6: a ladder program runs the conveyor; its bug stops the flow (TS-2688)', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'factory');
  const record = await nativeArtifact(page);
  await importJson(page, 'f175.json', {
    ...record,
    name: 'F175 line',
    draft: { ...record.draft, content: f175PlcLineBug() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F175 line');
  await expect(page.getByTestId('fac-program')).toContainText(
    'Transfer conveyor (no reset): 5 variables, 3 rungs, scan 100 ms',
  );
  await expect(page.getByTestId('fac-sensors').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('fac-actuators').locator('li')).toHaveCount(2);
  // The hold is never reset: the flow stops after two parts and the run reports it.
  await tool(page, 'Run').click();
  await expect(status(page)).toContainText('Result: 2 produced');
  await expect(page.getByTestId('fac-stall')).toContainText(
    'Transfer conveyor held by motor run off since 130 s',
  );
  await expect(page.getByTestId('fac-plc-summary')).toContainText('288001 scans');
  await expect(page.getByTestId('fac-ladder')).toBeVisible();
  await expect(page.getByTestId('fac-states')).toContainText('held');
  // The corrected program (PLCopen XML) keeps the wiring; the line runs as without a PLC.
  await page.getByLabel('Ladder program file').setInputFiles({
    name: 'transfer.xml',
    mimeType: 'application/xml',
    buffer: Buffer.from(ladderToPlcopen(f174PlcLine().control!.program)),
  });
  await expect(page.getByTestId('fac-program')).toContainText('4 rungs');
  // The diagram of the earlier run is not drawn over the new program.
  await expect(page.getByTestId('fac-ladder')).toBeHidden();
  await tool(page, 'Run').click();
  await expect(status(page)).toContainText('Result: 718 produced');
  await expect(page.getByTestId('fac-stall')).toBeHidden();
  await expect(page.getByTestId('fac-plc-summary')).toContainText('no stall');
  // A file that is no program is refused; the model does not change.
  const before = await draft(page);
  await page.getByLabel('Ladder program file').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"schemaVersion":1}'),
  });
  await expect(page.getByTestId('fac-notice')).toContainText('program-invalid');
  expect(await draft(page)).toEqual(before);
  // Two sensors on one input are refused by the model.
  await page.getByLabel('Variable of sn-inspect-busy', { exact: true }).selectOption('C1_AT_END');
  await expect(page.getByTestId('fac-notice')).toContainText('duplicate-variable');
  expect(await draft(page)).toEqual(before);
  // Remove a sensor, then the PLC (one Undo step each).
  await page.getByRole('button', { name: 'Remove sn-inspect-busy', exact: true }).click();
  await expect.poll(async () => (await draft(page)).control!.sensors.length).toBe(1);
  await page.getByRole('button', { name: 'Remove PLC', exact: true }).click();
  await expect.poll(async () => (await draft(page)).control).toBeUndefined();
  await tool(page, 'Undo').click();
  await expect.poll(async () => (await draft(page)).control?.sensors.length).toBe(1);
});
