// GV3a (docs/cad/gulliver-world.md): Mildendo and the ancient temple as buildings for 146 mm
// people, at the sizes Part I of the text gives (TS-2307, ST-644).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-lilliput-'));
  const file = path.join(dir, 'lilliput.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-lilliput';\nexport { validateBim, deriveBim, bimBodyLimits, bimLimits } from '@editor-platform/bim-core';\n",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: file,
    logLevel: 'error',
  });
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const g = await load();
const { doc: city, summary } = g.f105Mildendo();
const temple = g.f106Temple();
const byId = (doc, id) => {
  const e = doc.elements.find((x) => x.id === id);
  assert.ok(e, `element ${id}`);
  return e;
};
const type = (doc, id) => doc.types.find((t) => t.id === id);
const length = (w) => Math.hypot(w.end.xy[0] - w.start.xy[0], w.end.xy[1] - w.start.xy[1]);
const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );
const errors = (doc) => g.validateBim(doc).map((d) => `${d.code} ${d.path}`);

test('Mildendo and the temple pass every rule as buildings for 146 mm people', () => {
  for (const doc of [city, temple]) {
    assert.equal(doc.inhabitantHeightMm, 146);
    assert.deepEqual(errors(doc), [], doc.project.name);
    assert.deepEqual(
      g.deriveBim(doc).diagnostics.filter((d) => d.severity === 'error'),
      [],
      doc.project.name,
    );
    assert.ok(doc.elements.length <= g.bimLimits.elements, 'elements');
    assert.ok(doc.joins.length <= g.bimLimits.joins, 'joins');
    assert.ok(JSON.stringify(doc).length < g.bimLimits.contentBytes / 2, 'room to edit');
  }
});

test('the same town is refused for 1,750 mm people: its 250 mm storeys are too low', () => {
  const human = { ...city };
  delete human.inhabitantHeightMm;
  assert.ok(errors(human).includes('level-spacing $.levels'));
  // The temple's walls are 10 ft; only its rooms for people are a matter of the body.
  assert.deepEqual(errors({ ...temple, inhabitantHeightMm: 1750 }), []);
});

test('the wall, towers, streets and palace keep the sizes Part I chapter 4 gives', () => {
  const s = g.mildendoSizes;
  near(s.side, 152_400, 0.01, '500 ft');
  // Each side is two runs with a 5 ft gate between them, together 500 ft.
  for (const side of ['south', 'east', 'north', 'west']) {
    const a = byId(city, `cw-${side}-1`),
      b = byId(city, `cw-${side}-2`);
    near(length(a) + length(b) + s.street, 152_400, 0.5, side);
    assert.deepEqual(a.top, { heightMm: 762 });
  }
  assert.equal(type(city, 't-city-wall').layers[0].thicknessMm, 279.4);
  // A tower every 10 ft: 50 to a side, the one in each gate moved to the gate's two sides.
  assert.equal(summary.towers, 204);
  assert.equal(city.elements.filter((e) => e.kind === 'column').length, 204);
  const street = byId(city, 'st-west').boundary;
  near(Math.abs(street[2][1] - street[0][1]), 1_524, 0.1, 'great street 5 ft');
  assert.deepEqual(byId(city, 'pw-north-1').top, { heightMm: 609.6 });
  // The outward court 40 ft square; the second court 8 ft inside it.
  near(length(byId(city, 'pal-outer-in-s')), 12_192, 0.1, 'outward court');
  near(length(byId(city, 'pal-second-out-s')), 12_192 - 2 * 2_438.4, 0.1, 'second court');
  near(byId(city, 'pal-outer-out-s').top.heightMm, 1_524, 0.1, 'buildings 5 ft');
});

test('the houses are 3 to 5 storeys in back-to-back terraces with 18 in lanes', () => {
  assert.equal(summary.houses, 2_128);
  assert.equal(summary.storeys[3] + summary.storeys[4] + summary.storeys[5], summary.houses);
  for (const n of [3, 4, 5]) assert.ok(summary.storeys[n] > 0, `${n} storeys`);
  const levels = city.levels.map((l) => l.elevationMm);
  assert.deepEqual(levels, [0, 250, 500, 750, 1000, 1250]);
  const tops = new Set(
    city.elements
      .filter((e) => e.kind === 'wall' && e.typeId === 't-house-wall')
      .map((e) => e.top.level),
  );
  assert.deepEqual([...tops].sort(), ['l-4', 'l-5', 'l-6']);
  // The walls rise past the ridge (40° over half the 20 ft depth) and their roof cuts them,
  // so the gable ends are closed.
  for (const e of city.elements.filter((x) => x.kind === 'wall' && x.typeId === 't-house-wall')) {
    const block = e.id.slice(0, e.id.lastIndexOf('-'));
    assert.equal(e.clipBy, `${block}-roof`, e.id);
    assert.ok(e.top.offsetMm > (3_048 + 40) * Math.tan((40 * Math.PI) / 180), e.id);
  }
  // Two neighbouring blocks in a row are a lane apart.
  // (Row 0's first two blocks would stand by the palace and are left out.)
  const a = byId(city, 'h-ne-0-2-s'),
    b = byId(city, 'h-ne-0-3-s');
  near(b.start.xy[0] - a.end.xy[0], 457.2, 0.2, 'lane 18 in');
  // Doors and windows at 146 / 1,750 of 900 × 2,100 and 1,200 × 1,200.
  assert.deepEqual(
    [type(city, 't-house-door').widthMm, type(city, 't-house-door').heightMm],
    [75, 175],
  );
});

test('the temple gate and windows are as chapter 1 says', () => {
  const gate = type(temple, 't-temple-gate');
  near(gate.heightMm, 1_219.2, 0.1, 'four feet high');
  assert.ok(gate.widthMm < 609.6, 'almost two feet wide');
  const north = byId(temple, 'temple-n');
  assert.equal(byId(temple, 'temple-gate').hostId, north.id);
  // North-facing: the wall's outside (left of east → west) is +y.
  assert.ok(north.start.xy[0] > north.end.xy[0] && north.start.xy[1] === 0);
  for (const id of ['temple-window-east', 'temple-window-west'])
    assert.ok(byId(temple, id).sillMm <= 152.4, `${id}: not above six inches`);
  // Gulliver (1,750 mm) can lie at full length inside.
  const space = byId(temple, 'temple-space').boundary;
  assert.ok(Math.abs(space[1][0] - space[0][0]) > 1_750);
  // The turret 20 ft across the highway, at least 5 ft high.
  assert.ok(byId(temple, 'turret-s').start.xy[1] >= 6_096);
  assert.ok(byId(temple, 'turret-s').top.heightMm >= 1_524);
  // The gate is taller than 1,750 mm people's doors scaled to Lilliput would allow at 10 m;
  // the 20 m opening limit admits it (GV3a).
  assert.ok(gate.heightMm <= g.bimBodyLimits(temple).openingMm);
  assert.ok(gate.heightMm > (10_000 * 146) / 1_750);
});

test("every element says whether its size is from the text, derived or the author's", () => {
  for (const doc of [city, temple])
    for (const e of doc.elements) {
      const p = e.properties?.['ps-gulliver'];
      assert.ok(p, `${doc.project.name}/${e.id} has no source`);
      assert.ok(['本文', '推定', '創作'].includes(p.Source), `${e.id}: ${p.Source}`);
      assert.match(p.Chapter, /^第1篇第[14]章$/);
    }
  assert.equal(byId(city, 'cw-west-1').properties['ps-gulliver'].Source, '本文');
  assert.equal(byId(city, 'pal-outer-roof-0').properties['ps-gulliver'].Source, '創作');
  assert.equal(byId(temple, 'temple-gate').properties['ps-gulliver'].Source, '本文');
  assert.equal(byId(temple, 'temple-n').properties['ps-gulliver'].Source, '創作');
});

test('every wall under a pitched roof meets it: the roof cuts the wall, no gap under the eaves', () => {
  for (const doc of [city, temple]) {
    for (const roof of doc.elements.filter((e) => e.kind === 'roof' && e.shape.form !== 'flat')) {
      const xs = roof.boundary.map((p) => p[0]),
        ys = roof.boundary.map((p) => p[1]);
      const inside = ([x, y]) =>
        x >= Math.min(...xs) &&
        x <= Math.max(...xs) &&
        y >= Math.min(...ys) &&
        y <= Math.max(...ys);
      const walls = doc.elements.filter(
        (e) => e.kind === 'wall' && inside(e.start.xy) && inside(e.end.xy),
      );
      assert.ok(walls.length >= 4, roof.id);
      for (const w of walls) assert.equal(w.clipBy, roof.id, `${w.id} under ${roof.id}`);
    }
  }
});
