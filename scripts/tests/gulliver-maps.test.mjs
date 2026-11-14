// GV1 (docs/cad/gulliver-world.md): the six Gulliver's Travels maps admit, say where each feature
// comes from, and keep the distances the text states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { TextEncoder } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-maps-'));
  const file = path.join(dir, 'maps.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-maps';\nexport { parseFictionMapArtifact } from '@editor-platform/fiction-map/host';\n",
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
const byId = (content, id) => {
  const f = content.features.find((x) => x.id === id);
  assert.ok(f, `feature ${id}`);
  return f;
};
const at = (content, id) => byId(content, id).geometry.coordinates;
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );

test('the six maps admit through the public validator with room to edit', () => {
  assert.deepEqual(g.gulliverMapIds, [
    'voyages',
    'lilliput',
    'mildendo',
    'brobdingnag',
    'balnibarbi',
    'houyhnhnm',
  ]);
  for (const id of g.gulliverMapIds) {
    const content = g.gulliverMapContent(id);
    assert.ok(Object.isFrozen(content), `${id} is an admitted snapshot`);
    assert.ok(content.features.length <= 150, `${id} leaves room for 50 more features`);
    assert.ok(new TextEncoder().encode(JSON.stringify(content)).length < 60_000, `${id} size`);
    assert.equal(g.gulliverMapArtifact(id).kind, 'fiction-map');
  }
});

test('each map round-trips as an Artifact the normal Host imports', async () => {
  for (const id of g.gulliverMapIds) {
    const artifact = g.gulliverMapArtifact(id);
    const parsed = await g.parseFictionMapArtifact(JSON.stringify(artifact));
    assert.deepEqual(parsed.draft.content, g.gulliverMapContent(id), id);
  }
});

test('every feature says whether it is from the text, derived, invented or a real outline', () => {
  for (const id of g.gulliverMapIds)
    for (const f of g.gulliverMapContent(id).features) {
      assert.ok(g.gulliverBases.includes(f.category), `${id}/${f.id} category ${f.category}`);
      if (f.category !== '参考')
        assert.match(f.description, /第[1-4]篇|本文に無い/, `${id}/${f.id} cites the text`);
    }
});

test('physical units follow the text (metres, feet, miles)', () => {
  const unit = (id) => g.gulliverMapContent(id).coordinateSpace.unit;
  assert.deepEqual(unit('lilliput').distancePerUnit, { value: 1, unit: 'm' });
  assert.deepEqual(unit('mildendo').distancePerUnit, { value: 0.3048, unit: 'm' });
  for (const id of ['brobdingnag', 'balnibarbi', 'houyhnhnm'])
    assert.deepEqual(unit(id).distancePerUnit, { value: 1.609344, unit: 'km' });
  assert.equal(unit('voyages').distancePerUnit, undefined, 'degrees are not a distance');
});

test('Lilliput: 12 miles round, an 800-yard channel, half a mile to the capital', () => {
  const m = g.gulliverMapContent('lilliput');
  near(g.ringLength(byId(m, 'lilliput-island').geometry.outer), 12 * g.unitM.mile, 400, 'coast');
  const [a, b] = byId(m, 'channel').geometry.coordinates;
  near(dist(a, b), 800 * g.unitM.yard, 1, 'channel');
  const lilliputCoast = byId(m, 'lilliput-island').geometry.outer;
  const blefuscuCoast = byId(m, 'blefuscu-island').geometry.outer;
  assert.ok(
    lilliputCoast.some((p) => dist(p, a) === 0),
    "the channel starts on Lilliput's coast",
  );
  assert.ok(
    blefuscuCoast.some((p) => dist(p, b) === 0),
    "the channel ends on Blefuscu's coast",
  );
  for (const id of ['fleet', 'boat'])
    for (const coast of [lilliputCoast, blefuscuCoast])
      assert.ok(!inside(at(m, id), coast), `${id} is at sea`);
  for (const id of ['woke', 'temple', 'hillock', 'blefuscu-city'])
    assert.ok(
      inside(at(m, id), id === 'blefuscu-city' ? blefuscuCoast : lilliputCoast),
      `${id} is on land`,
    );
  const city = byId(m, 'mildendo').geometry.outer;
  const centre = [(city[0][0] + city[2][0]) / 2, (city[0][1] + city[2][1]) / 2];
  near(dist(at(m, 'woke'), centre), 0.5 * g.unitM.mile, 1, 'woke to the capital');
  near(city[1][0] - city[0][0], 500 * g.unitM.foot, 0.01, 'city wall');
  near(centre[0] - 250 * g.unitM.foot - at(m, 'temple')[0], 200 * g.unitM.yard, 1, 'temple');
});

test('Mildendo: a 500-foot square, 5-foot streets, the palace court and the temple', () => {
  const m = g.gulliverMapContent('mildendo');
  const wall = byId(m, 'wall').geometry.outer;
  assert.equal(wall[1][0] - wall[0][0], 500);
  assert.equal(wall[2][1] - wall[1][1], 500);
  const ns = byId(m, 'street-ns').geometry.outer;
  assert.equal(ns[1][0] - ns[0][0], 5);
  const court = byId(m, 'outer-court').geometry.outer;
  assert.equal(court[1][0] - court[0][0], 40);
  const palace = byId(m, 'palace').geometry.outer;
  const enclosure = byId(m, 'palace-wall').geometry.outer;
  assert.equal(palace[0][0] - enclosure[0][0], 20, 'wall 20 feet from the buildings');
  const temple = byId(m, 'temple').geometry.outer;
  assert.equal(wall[0][0] - (temple[0][0] + temple[1][0]) / 2, 600, '200 yards from the gate');
});

test('Brobdingnag: about 6,000 miles long, a 54 × 45 mile capital, Flanflasnic near the sea', () => {
  const m = g.gulliverMapContent('brobdingnag');
  const land = byId(m, 'brobdingnag').geometry.outer;
  let longest = 0;
  for (const p of land) for (const q of land) longest = Math.max(longest, dist(p, q));
  assert.ok(longest >= 5_500 && longest <= 7_000, `length ${longest}`);
  const city = byId(m, 'lorbrulgrud').geometry.outer;
  assert.equal(city[1][0] - city[0][0], 54);
  assert.equal(city[2][1] - city[1][1], 45);
  const flan = at(m, 'flanflasnic');
  const shore = Math.min(...land.map((p, i) => segment(flan, p, land[(i + 1) % land.length])));
  assert.ok(shore <= 18, `Flanflasnic is ${shore} miles from the sea`);
  near(dist(at(m, 'farm'), city[0]), 3_000, 250, 'farm to the capital');
});

test('Balnibarbi: Laputa flies 90 leagues north-east by east to Lagado', () => {
  const m = g.gulliverMapContent('balnibarbi');
  const flight = byId(m, 'laputa-flight').geometry.coordinates;
  const [start, end] = [flight[0], flight.at(-1)];
  near(dist(start, end), 270, 0.5, '90 leagues');
  const bearing = (Math.atan2(end[0] - start[0], end[1] - start[1]) * 180) / Math.PI;
  near(bearing, 56.25, 0.5, 'north-east by east');
  assert.deepEqual(end, at(m, 'lagado'));
  near(
    dist(at(m, 'maldonada'), ringCentre(byId(m, 'glubbdubdrib').geometry.outer)),
    15,
    0.5,
    'Glubbdubdrib',
  );
  near(dist(at(m, 'lagado'), at(m, 'munodi')), 20, 0.5, 'Munodi');
  near(dist(at(m, 'munodi'), at(m, 'ruined-mill')), 3, 0.05, 'the ruined mill');
});

test('towns and houses stand on land in each country map', () => {
  for (const [id, land, places] of [
    ['brobdingnag', 'brobdingnag', ['farm', 'palace', 'temple-tower', 'flanflasnic']],
    ['balnibarbi', 'balnibarbi', ['lagado', 'academy', 'munodi', 'ruined-mill', 'pacific-port']],
    ['houyhnhnm', 'land', ['yahoo-field', 'grey', 'house', 'kennel']],
    ['mildendo', 'wall', ['gate-west']],
  ]) {
    const m = g.gulliverMapContent(id);
    const ring = byId(m, land).geometry.outer;
    for (const p of places)
      assert.ok(inside(at(m, p), ring) || segmentMin(at(m, p), ring) < 1e-6, `${id}/${p} on land`);
  }
  const b = g.gulliverMapContent('balnibarbi');
  assert.ok(
    !inside(at(b, 'laputa-start'), byId(b, 'balnibarbi').geometry.outer),
    'the rocky island is off the coast',
  );
});

test('Houyhnhnm land: about three miles to the house', () => {
  const m = g.gulliverMapContent('houyhnhnm');
  near(dist(at(m, 'grey'), at(m, 'house')), 3, 0.05, 'to the house');
});

test('the voyage diagram keeps the latitudes and longitudes the text gives', () => {
  const m = g.gulliverMapContent('voyages');
  assert.equal(at(m, 'wreck-1')[1], -30.03);
  assert.deepEqual(at(m, 'rescue-2'), [143, 44]);
  assert.deepEqual(at(m, 'pirates'), [183, 46]);
  assert.deepEqual(at(m, 'luggnagg'), [140, 29]);
  assert.equal(at(m, 'houyhnhnm-at')[1], -45);
  assert.equal(at(m, 'rescue-1')[1], -30);
  // Laputa carried Gulliver north-east by east from the rocky island to Lagado (第3篇第2章).
  const island = byId(m, 'rock-island').geometry.outer;
  const from = ringCentre(island.slice(0, -1));
  const to = at(m, 'lagado');
  const east = (to[0] - from[0]) * Math.cos((((from[1] + to[1]) / 2) * Math.PI) / 180);
  const bearing = (Math.atan2(east, to[1] - from[1]) * 180) / Math.PI;
  near(bearing, 56.25, 11.25, 'the overview flight, within one point of NE by E');
  const route = byId(m, 'voyage-3').geometry.coordinates;
  near(dist(route[1], from), 0, 1e-9, 'the route starts from the island');
  assert.deepEqual(route[2], to);
});

function segment(p, a, b) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function ringCentre(ring) {
  return [
    ring.reduce((s, p) => s + p[0], 0) / ring.length,
    ring.reduce((s, p) => s + p[1], 0) / ring.length,
  ];
}
function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function segmentMin(p, ring) {
  return Math.min(...ring.slice(0, -1).map((a, i) => segment(p, a, ring[i + 1])));
}
