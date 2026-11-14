// GV3b (docs/cad/gulliver-world.md): the emperor's greatest engine and Blefuscu's fleet as CAD
// assemblies of one saved version each, at the sizes Part I gives (TS-2309, ST-645).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-machines-'));
  const file = path.join(dir, 'machines.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-lilliput-cad';\nexport { validateCad, fixtureKernel } from '@editor-platform/cad-core';\n",
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
const errors = (doc) => g.validateCad(doc).filter((d) => d.severity === 'error');
const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );
const feature = (doc, id) => {
  const f = doc.features.find((x) => x.id === id);
  assert.ok(f, `feature ${id}`);
  return f;
};
const mmOf = (l) => l.literalMm ?? l;
/** Every placed copy's translation: each seed, then its pattern's moves along the layout. */
function copies(doc) {
  const out = [];
  for (const c of doc.components) {
    const t = doc.solvedPoses[c.id].translationMm;
    const p = doc.componentPatterns.find((x) => x.seedComponentId === c.id);
    if (!p) {
      out.push({ part: c.partId, at: t });
      continue;
    }
    const { direction, count, spacing } = p.layout;
    for (let i = 0; i < count.literal; i++)
      out.push({
        part: c.partId,
        at: t.map((v, k) => v + direction[k] * mmOf(spacing) * i),
      });
  }
  return out;
}

test('both assemblies and the versions they place pass validation', () => {
  for (const make of [g.engineAssembly, g.blefuscuFleet]) {
    const { assembly, versions, closure } = make(kernel);
    assert.deepEqual(errors(assembly), [], make.name);
    for (const v of versions) {
      assert.deepEqual(errors(v.content), [], v.artifactId);
      assert.equal(g.versionHash(v.content), v.contentHash);
      assert.ok(closure.has(v.contentHash));
    }
    // One version per kind of thing: copies are placements, not new versions.
    assert.equal(assembly.parts.length, versions.length);
  }
});

test('the engine: 7 × 4 ft, 3 in above the ground, on 22 wheels (Part I chapter 1)', () => {
  const s = g.engineSizes;
  near(s.length, 2_133.6, 0.01, 'seven feet');
  near(s.width, 1_219.2, 0.01, 'four feet');
  near(s.clearance, 76.2, 0.01, 'three inches');
  const { assembly, versions } = g.engineAssembly(kernel);
  const frame = versions.find((v) => v.artifactId === 'gv-engine-frame').content;
  const deck = feature(frame, 'deck').args;
  assert.deepEqual(
    deck.size.map((l) => mmOf(l)),
    [s.length, s.width, s.deck],
  );
  near(deck.origin[2].literalMm ?? deck.origin[2], s.clearance, 0.001, 'deck underside');
  const wheels = copies(assembly).filter((c) => c.part === 'part-wheel');
  assert.equal(wheels.length, 22);
  // Each wheel stands on the ground (its axis one radius up) and they fill the frame's length.
  for (const w of wheels) near(w.at[2], s.wheelRadius, 1e-6, 'axle height');
  const xs = [...new Set(wheels.map((w) => Math.round(w.at[0])))];
  assert.equal(xs.length, 11);
  assert.ok(Math.min(...xs) > 0 && Math.max(...xs) < s.length);
  const ys = [...new Set(wheels.map((w) => Math.round(w.at[1])))];
  assert.equal(ys.length, 2);
  assert.ok(Math.min(...ys) < -s.width / 2 && Math.max(...ys) > s.width / 2, 'outside the frame');
});

test('the fleet: fifty men of war of one version, each with a hole at the prow (chapter 5)', () => {
  const s = g.shipSizes;
  assert.ok(s.length <= 9 * 304.8, 'no longer than the largest, nine feet');
  const { assembly, versions } = g.blefuscuFleet(kernel);
  const ships = copies(assembly);
  assert.equal(ships.length, 50);
  assert.equal(new Set(ships.map((c) => c.at.map(Math.round).join())).size, 50, 'no two overlap');
  const ship = versions[0].content;
  assert.equal(feature(ship, 'hull-loft').args.sections.length, 5);
  assert.equal(feature(ship, 'hull-cut').type, 'boolean');
  // The hole tool is spent by the cut; the hull, the rig and the sails remain.
  assert.equal(ship.bodies.find((b) => b.id === 'hole-tool').consumedByFeatureId, 'hull-cut');
  assert.deepEqual(
    ship.bodies.filter((b) => b.state === 'active').map((b) => b.id),
    ['hull', 'rig', 'sail-body'],
  );
});
