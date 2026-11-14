// GV5b (docs/cad/gulliver-world.md): how the flying island moves, from the text's rules only
// (Part III chapter 3): along the loadstone, still when it is level, within four miles' reach and
// over the dominions; and the text's figure C→D→E→F→G→H (TS-2321, ST-651).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-laputa-motion-'));
  const file = path.join(dir, 'motion.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-laputa-motion';\nexport { f117Laputa } from './scripts/fixtures/gulliver-laputa-cad';\nexport { versionHash } from './scripts/fixtures/gulliver-lilliput-cad';\nexport { validateCad, fixtureKernel } from '@editor-platform/cad-core';\n",
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
const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );
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

const mile = 1_609_344;
const league = 3 * mile;
const rate = 100_000;
/** A square realm 400 km across, centred on the origin. */
const realm = {
  land: [
    [-200e6, -200e6],
    [200e6, -200e6],
    [200e6, 200e6],
    [-200e6, 200e6],
  ],
};
const unit = (v) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

test('erect with the repelling end down it mounts straight up; with the attracting end down it descends', () => {
  const up = g.islandVelocity(0, 0, rate);
  near(up[2], rate, 1e-9, 'up');
  near(Math.hypot(up[0], up[1]), 0, 1e-9, 'straight');
  const down = g.islandVelocity(1.2, Math.PI, rate);
  near(down[2], -rate, 1e-9, 'down');
  near(Math.hypot(down[0], down[1]), 0, 1e-6, 'straight');
});

test('oblique, it moves obliquely, along the stone’s line from the repelling to the attracting end', () => {
  for (const [yaw, tilt] of [
    [0, 0.4],
    [0.8, -0.6],
    [2.1, Math.PI - 0.3],
  ]) {
    const v = unit(g.islandVelocity(yaw, tilt, rate));
    const c = g.attractingEnd(yaw, tilt);
    for (let k = 0; k < 3; k++) near(v[k], c[k], 1e-9, 'parallel to the stone');
    assert.ok(Math.hypot(v[0], v[1]) > 0.1, 'oblique');
  }
});

test('the stone’s line is the one the CAD joints give the loadstone (F117)', () => {
  for (const [yawRad, tiltRad] of [
    [0, 0.5],
    [Math.PI / 2, 0.35],
    [1, Math.PI - 0.2],
  ]) {
    const pose = g.f117Laputa(kernel, { yawRad, tiltRad }).assembly.solvedPoses['c-stone'];
    const c = rotate(pose.rotation, [0, 0, 1]);
    const u = g.attractingEnd(yawRad, tiltRad);
    for (let k = 0; k < 3; k++) near(u[k], c[k], 1e-9, 'same line');
  }
});

test('level, the island stands still', () => {
  const r = g.stepIsland([0, 0, 1e6], { yawRad: 0.3, tiltRad: Math.PI / 2 }, 10, realm, rate);
  assert.deepEqual(r.at, [0, 0, 1e6]);
  assert.deepEqual(r.stopped, ['level']);
  // Nearly level, it barely moves.
  const v = g.islandVelocity(0, Math.PI / 2 - 0.01, rate);
  assert.ok(Math.hypot(...v) < 0.011 * rate);
});

test('it cannot rise beyond four miles, nor sink through the earth', () => {
  const top = 4 * mile - g.stoneAboveUnderside();
  const r = g.stepIsland([0, 0, top - 1000], { yawRad: 0, tiltRad: 0 }, 60, realm, rate);
  near(r.at[2] + g.stoneAboveUnderside(), 4 * mile, 1e-6, 'the stone at four miles');
  assert.deepEqual(r.stopped, ['reach']);
  const s = g.stepIsland([0, 0, 500], { yawRad: 0, tiltRad: Math.PI }, 60, realm, rate);
  assert.equal(s.at[2], 0);
  assert.deepEqual(s.stopped, ['earth']);
});

test('it cannot move beyond the dominions: the land and six leagues of sea', () => {
  near(g.seaReachMm, 6 * league, 1e-9, 'six leagues');
  // Over the sea five leagues out: it may go on; past six leagues it is held.
  const edge = 200e6;
  assert.ok(g.overDominions(realm, [edge + 5 * league, 0]));
  assert.ok(!g.overDominions(realm, [edge + 7 * league, 0]));
  const out = [edge + 6 * league - 1000, 0, 1e6];
  const r = g.stepIsland(out, { yawRad: Math.PI / 2, tiltRad: 0.5 }, 60, realm, rate);
  assert.equal(r.at[0], out[0], 'held at the edge');
  assert.ok(r.at[2] > out[2], 'still free to rise');
  assert.deepEqual(r.stopped, ['border']);
});

test('the figure: from C it rises to D, falls to E, rises to F, falls to G, and mounts straight to H', () => {
  const legs = g.figureLegs(0.35, 20);
  assert.deepEqual(
    legs.map((l) => l.name),
    ['C→D', 'D→E', 'E→F', 'F→G', 'G→H'],
  );
  const C = [0, 0, 1_000_000];
  const { ends } = g.voyage(C, legs, realm, rate);
  const pts = [C, ...ends];
  // Along AB (+x) every oblique leg, alternately up and down; the last straight up.
  for (let i = 0; i < 4; i++) {
    assert.ok(pts[i + 1][0] > pts[i][0], `${legs[i].name} goes on along AB`);
    near(pts[i + 1][1], 0, 1e-6, 'on the line AB');
    assert.ok(i % 2 === 0 ? pts[i + 1][2] > pts[i][2] : pts[i + 1][2] < pts[i][2], legs[i].name);
  }
  near(pts[5][0], pts[4][0], 1e-6, 'G→H straight up');
  assert.ok(pts[5][2] > pts[4][2]);
  // "the obliquity being not considerable": it rises more than it advances.
  assert.ok(pts[1][2] - pts[0][2] > pts[1][0] - pts[0][0]);
});
