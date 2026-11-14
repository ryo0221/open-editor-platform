// GV4b (docs/cad/gulliver-world.md): the farmer's table, the bedchamber box with its ceiling on
// two hinges and the travelling box as CAD, at the sizes Part II gives (TS-2315, ST-648).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-boxes-'));
  const file = path.join(dir, 'boxes.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-brobdingnag-cad';\nexport { versionHash } from './scripts/fixtures/gulliver-lilliput-cad';\nexport { validateCad, fixtureKernel } from '@editor-platform/cad-core';\n",
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
/** A box feature's extent: [min, max] per axis. */
const extent = (doc, id) => {
  const { size, origin } = feature(doc, id).args;
  return [0, 1, 2].map((k) => [mmOf(origin[k]), mmOf(origin[k]) + mmOf(size[k])]);
};
const active = (doc) => doc.bodies.filter((b) => b.state === 'active').map((b) => b.id);
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

test('the three pass validation, and the bedchamber places the versions it carries', () => {
  assert.deepEqual(errors(g.f111FarmerTable(kernel)), []);
  assert.deepEqual(errors(g.f113TravellingBox(kernel)), []);
  const { assembly, versions, closure } = g.f112Bedchamber(kernel);
  assert.deepEqual(errors(assembly), []);
  for (const v of versions) {
    assert.deepEqual(errors(v.content), [], v.artifactId);
    assert.equal(g.versionHash(v.content), v.contentHash);
    assert.ok(closure.has(v.contentHash));
  }
});

test("the farmer's table: thirty feet high from the floor (Part II chapter 1)", () => {
  const t = g.tableSizes;
  near(t.height, 30 * foot, 1e-9, 'thirty feet');
  const doc = g.f111FarmerTable(kernel);
  near(extent(doc, 'table-top')[2][1], 30 * foot, 1e-6, 'upper face');
  for (let k = 0; k < 4; k++) assert.equal(extent(doc, `leg-${k}`)[2][0], 0, 'on the floor');
  assert.deepEqual(active(doc), ['table-body']);
});

test('the bedchamber: sixteen feet square, twelve high, the ceiling lifts on two hinges (chapter 3)', () => {
  const s = g.bedchamberSizes;
  near(s.side, 16 * foot, 1e-9, 'sixteen feet');
  near(s.height, 12 * foot, 1e-9, 'twelve high');
  const box = g.bedchamberBox(kernel);
  const [x, y] = extent(box, 'floor');
  assert.deepEqual([x[1] - x[0], y[1] - y[0]], [s.side, s.side]);
  const ceilingDoc = g.bedchamberCeiling(kernel);
  const ceilingBoxes = ceilingDoc.features.filter((f) => f.type === 'box');
  assert.equal(ceilingBoxes.length, 1);
  near(extent(ceilingDoc, ceilingBoxes[0].id)[2][1], s.height, 1e-6, 'ceiling top');
  // Two hinge knuckles on the back top edge, each its own body.
  assert.equal(active(box).filter((b) => b.startsWith('hinge')).length, 2);
  // Shut: the ceiling sits where it was built. Open 70°: its front edge rises, its back stays.
  const shut = g.f112Bedchamber(kernel).assembly;
  assert.deepEqual(
    shut.joints.map((j) => j.type),
    ['revolute'],
  );
  assert.deepEqual(shut.solvedPoses['c-ceiling'].rotation, [0, 0, 0, 1]);
  const open = g.f112Bedchamber(kernel, (70 * Math.PI) / 180).assembly.solvedPoses['c-ceiling'];
  const at = (p) => rotate(open.rotation, p).map((c, k) => c + open.translationMm[k]);
  const front = at([s.side / 2, 0, s.height]);
  const back = at([s.side / 2, s.side - s.board / 2, s.height - s.board]);
  assert.ok(front[2] > s.height + 0.9 * s.side * Math.sin((70 * Math.PI) / 180) - 100, 'front up');
  near(back[2], s.height - s.board, 1, 'hinge line stays');
  near(back[1], s.side - s.board / 2, 1, 'hinge line stays');
});

test('the travelling box: twelve feet square, ten high, three latticed windows, two staples, a ring (chapters 3 and 8)', () => {
  const s = g.travellingSizes;
  near(s.side, 12 * foot, 1e-9, 'twelve feet');
  near(s.height, 10 * foot, 1e-9, 'ten high');
  const doc = g.f113TravellingBox(kernel);
  const [x, y, z] = extent(doc, 'floor');
  assert.deepEqual([x[1] - x[0], y[1] - y[0]], [s.side, s.side]);
  near(extent(doc, 'roof')[2][1], s.height, 1e-6, 'roof top');
  // The closet cuts three windows and the air hole (a foot square) out of the shell.
  assert.deepEqual(feature(doc, 'closet').inputFeatureIds, [
    'shell',
    'win-s',
    'win-n',
    'win-e',
    'air-hole',
  ]);
  const [hx, hy] = extent(doc, 'air-hole');
  near(hx[1] - hx[0], s.hole, 1e-6, 'hole width');
  near(hy[1] - hy[0], s.hole, 1e-6, 'hole depth');
  assert.notEqual((hx[0] + hx[1]) / 2, s.side / 2, 'not directly over the middle');
  near(s.hole, 1 * foot, 1e-9, 'a foot square');
  assert.ok(z[0] === 0);
  const bodies = active(doc);
  for (const b of ['closet-body', 'lattice-s', 'lattice-n', 'lattice-e', 'staple-0', 'staple-1'])
    assert.ok(bodies.includes(b), b);
  // The ring stands on the roof, so the eagle can take the box up by it.
  assert.ok(bodies.includes('ring-body'));
  assert.equal(feature(doc, 'ring-turn').type, 'revolve');
  assert.ok(extent(doc, 'ring-block')[2][0] < s.height, 'the block sits in the roof');
  // The staples stand on the wall without a window (west, x = 0).
  for (const k of [0, 1])
    assert.ok(extent(doc, `staple-${k}-c`)[0][1] < 0, 'outside the west wall');
});
