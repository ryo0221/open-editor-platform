// GV5a (docs/cad/gulliver-world.md): the flying island of Laputa and its loadstone as CAD, at the
// sizes Part III chapter 3 gives (TS-2319, ST-650).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-laputa-'));
  const file = path.join(dir, 'laputa.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-laputa-cad';\nexport { versionHash } from './scripts/fixtures/gulliver-lilliput-cad';\nexport { validateCad, fixtureKernel } from '@editor-platform/cad-core';\n",
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
const kernel = g.fixtureKernel;
const foot = 304.8;
const yard = 914.4;
const inch = 25.4;
const errors = (doc) => g.validateCad(doc).filter((d) => d.severity === 'error');
const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );
const mmOf = (l) => l.literalMm ?? l;
const feature = (doc, id) => {
  const f = doc.features.find((x) => x.id === id);
  assert.ok(f, `feature ${id}`);
  return f;
};
/** Rotate v by the unit quaternion q = [x, y, z, w]. */
function rotate([x, y, z, w], v) {
  const u = [x, y, z];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const t = cross(u, v).map((c) => 2 * c);
  const ut = cross(u, t);
  return v.map((c, k) => c + w * t[k] + ut[k]);
}

const revolveOf = (doc, id) => {
  const f = feature(doc, id);
  assert.equal(f.type, 'revolve');
  return doc.sketches.find((s) => s.id === f.args.sketchId);
};
const corners = (sketch) => Object.values(sketch.solved);
const zOf = (sketch) => corners(sketch).map((p) => p[1]);
const rOf = (sketch) => corners(sketch).map((p) => p[0]);

test('the island and the assembly with its loadstone pass validation', () => {
  assert.deepEqual(errors(g.f116Island(kernel)), []);
  const { assembly, versions, closure } = g.f117Laputa(kernel);
  assert.deepEqual(errors(assembly), []);
  for (const v of versions) {
    assert.deepEqual(errors(v.content), [], v.artifactId);
    assert.equal(g.versionHash(v.content), v.contentHash);
    assert.ok(closure.has(v.contentHash));
  }
});

test('the island: 7,837 yards across, 300 thick, the adamant 200, the mould 10–12 ft (Part III ch. 3)', () => {
  const s = g.islandSizes;
  near(s.diameter, 7_837 * yard, 1e-6, 'diameter');
  near(s.diameter, 7_166_000, 1_000, 'about 7.2 km');
  const doc = g.f116Island(kernel);
  const ad = revolveOf(doc, 'adamant-turn');
  near(Math.max(...rOf(ad)), s.diameter / 2, 1e-6, 'radius');
  near(Math.max(...zOf(ad)), 200 * yard, 1e-6, 'adamant top');
  near(Math.min(...zOf(ad)), 0, 1e-6, 'under surface');
  const top = revolveOf(doc, 'mould-turn');
  near(Math.max(...zOf(top)), 300 * yard, 1e-6, 'thickness at the rim');
  assert.ok(s.mould >= 10 * foot && s.mould <= 12 * foot, 'ten or twelve feet');
  // The upper surface falls toward the centre (the declivity), and the minerals fill the rest.
  assert.ok(g.surfaceZ(0) < g.surfaceZ(s.diameter / 2));
  assert.deepEqual(
    doc.bodies.filter(
      (b) => b.state === 'active' && ['adamant-body', 'minerals-body', 'mould-body'].includes(b.id),
    ).length,
    3,
  );
});

test('the chasm, fifty yards across, reaches the dome 100 yards beneath the adamant top', () => {
  const s = g.islandSizes;
  const doc = g.f116Island(kernel);
  const chasm = feature(doc, 'chasm').args;
  near(mmOf(chasm.radius) * 2, 50 * yard, 1e-6, 'fifty yards');
  near(g.caveFloorZ(), 200 * yard - 100 * yard, 1e-6, 'a hundred yards beneath');
  const cave = revolveOf(doc, 'cave');
  const caveTop = Math.max(...zOf(cave));
  assert.ok(caveTop < s.adamant, 'the dome is inside the adamant');
  // The chasm starts inside the dome and runs out above the surface.
  const bottom = mmOf(chasm.origin[2]);
  assert.ok(bottom < caveTop && bottom >= g.caveFloorZ());
  assert.ok(bottom + mmOf(chasm.height) > s.thickness);
  assert.deepEqual(feature(doc, 'adamant').inputFeatureIds, ['adamant-turn', 'cave', 'chasm']);
});

test('four basins, half a mile round, two hundred yards from the centre, apart from each other and the chasm', () => {
  const b = g.basins();
  assert.equal(b.length, 4);
  for (const x of b) {
    near(2 * Math.PI * x.radius, 0.5 * 1_609_344, 1e-6, 'circuit');
    near(Math.hypot(...x.at), 200 * yard, 1e-6, 'from the centre');
    assert.ok(Math.hypot(...x.at) - x.radius > (50 * yard) / 2, 'clear of the chasm');
  }
  // Six metres deep, through the mould into the minerals: both layers are cut.
  const s = g.islandSizes;
  assert.ok(s.basinDepth > s.mould);
  const doc = g.f116Island(kernel);
  for (const [layer, tool] of [
    ['mould', (k) => `basin-${k}`],
    ['minerals', (k) => `basin-${k}-minerals`],
  ])
    for (let k = 0; k < 4; k++)
      assert.ok(feature(doc, layer).inputFeatureIds.includes(tool(k)), layer);
  for (let i = 0; i < 4; i++) {
    const [p, q] = [b[i], b[(i + 1) % 4]];
    assert.ok(Math.hypot(p.at[0] - q.at[0], p.at[1] - q.at[1]) > p.radius + q.radius, 'apart');
  }
});

test('galleries round the side, and stairs from each down to the next', () => {
  const s = g.islandSizes;
  const doc = g.f116Island(kernel);
  for (let k = 0; k < s.galleries; k++) {
    const ring = revolveOf(doc, `gallery-${k}`);
    assert.ok(Math.max(...rOf(ring)) > s.diameter / 2, 'outside the side');
    assert.ok(
      Math.min(...zOf(ring)) > 0 && Math.max(...zOf(ring)) < s.thickness,
      'within the side',
    );
  }
  const stairs = doc.features.filter((f) => f.type === 'box' && f.id.startsWith('stair-'));
  assert.equal(stairs.length, (s.galleries - 1) * s.stairs);
  // A flight climbs one gallery pitch: its length times sin(slope).
  const f = stairs[0].args;
  near(mmOf(f.size[0]) * Math.sin(s.stairSlope), s.galleryPitch, 1, 'one pitch');
});

test('the loadstone: a shuttle six yards long and three over, in a hoop twelve yards across on eight feet six yards high', () => {
  const l = g.loadstoneSizes;
  near(l.length, 6 * yard, 1e-9, 'six yards');
  near(l.thickest, 3 * yard, 1e-9, 'three yards');
  const stone = g.loadstone(kernel);
  const zs = [...zOf(stone.sketches[0]), ...zOf(stone.sketches[1])];
  near(Math.max(...zs) - Math.min(...zs), l.length, 1e-6, 'length');
  near(Math.max(...rOf(stone.sketches[0])) * 2, l.thickest, 1e-6, 'thickest');
  near(l.hoopDiameter, 12 * yard, 1e-9, 'twelve yards');
  near(l.hoopDepth, 4 * foot, 1e-9, 'four feet deep');
  near(l.hoopThick, 4 * foot, 1e-9, 'as many thick');
  near(l.groove, 12 * inch, 1e-9, 'groove twelve inches');
  const hoop = g.hoopAndFeet(kernel);
  assert.equal(
    hoop.features.filter((f) => f.type === 'cylinder' && f.id.startsWith('foot-')).length,
    8,
  );
  near(mmOf(feature(hoop, 'foot-0').args.height), 6 * yard + 1, 1e-6, 'six yards high');
  // The axle's ends sit in the groove: past the concave side, short of the groove's bottom.
  const ax = feature(g.axle(kernel), 'axle').args;
  const half = mmOf(ax.height) / 2;
  const inner = l.hoopDiameter / 2 - l.hoopThick;
  assert.ok(half > inner && half < inner + l.groove);
  // The stone turns clear of the hoop and of the cave floor.
  assert.ok(l.length / 2 < inner && l.length / 2 < g.axleZ());
});

test('the joints: the axle turns about the vertical, the stone on the axle; erect, oblique and level', () => {
  const up = (pose) =>
    rotate(g.f117Laputa(kernel, pose).assembly.solvedPoses['c-stone'].rotation, [0, 0, 1]);
  // Tilt 0: erect, the attracting end (c, +z) up, so the repelling end points down.
  const erect = up({ tiltRad: 0 });
  near(erect[2], 1, 1e-9, 'erect');
  // Tilt π/2: parallel to the horizon.
  near(up({ tiltRad: Math.PI / 2 })[2], 0, 1e-9, 'level');
  // Tilt π: the attracting end down.
  near(up({ tiltRad: Math.PI })[2], -1, 1e-9, 'attracting end down');
  // Oblique, and the axle's yaw turns the plane the stone leans in.
  const a = up({ yawRad: 0, tiltRad: 0.5 });
  const b = up({ yawRad: Math.PI / 2, tiltRad: 0.5 });
  near(a[2], Math.cos(0.5), 1e-9, 'oblique');
  near(Math.hypot(a[0], a[1]), Math.sin(0.5), 1e-9, 'leans');
  near(a[0] * b[0] + a[1] * b[1], 0, 1e-9, 'the lean turns with the axle');
  // The stone stays on the axle, in the cave above the hoop's feet.
  const poses = g.f117Laputa(kernel, { yawRad: 1, tiltRad: 2 }).assembly.solvedPoses;
  near(poses['c-stone'].translationMm[2], g.caveFloorZ() + g.axleZ(), 1e-6, 'on the axle');
});
