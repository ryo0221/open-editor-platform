// GV5c (docs/cad/gulliver-world.md): the grand academy of Lagado as a building of 500 rooms on
// both sides of a street (F118), and the professor's frame of forty handles in CAD (F119), from
// Part III chapter 5 (TS-2322, ST-652).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-lagado-'));
  const file = path.join(dir, 'lagado.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-lagado';\nexport * from './scripts/fixtures/gulliver-lagado-cad';\nexport { validateBim, deriveBim } from '@editor-platform/bim-core';\nexport { validateCad, fixtureKernel } from '@editor-platform/cad-core';\n",
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
const foot = 304.8;
const { doc } = g.f118Academy();
const of = (kind) => doc.elements.filter((e) => e.kind === kind);
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
  const c = cross(u, t);
  return v.map((vi, i) => vi + w * t[i] + c[i]);
}

test('the academy passes every rule and the model derives with no errors', () => {
  assert.equal(doc.inhabitantHeightMm, 1_750);
  assert.deepEqual(
    g
      .validateBim(doc)
      .filter((d) => d.severity === 'error')
      .map((d) => `${d.code} ${d.path}`),
    [],
  );
  assert.deepEqual(
    g.deriveBim(doc).diagnostics.filter((d) => d.severity === 'error'),
    [],
  );
  assert.ok(doc.elements.length < 10_000, `${doc.elements.length} elements`);
});

test('“I could not be in fewer than five hundred rooms”: 500 rooms, each numbered once', () => {
  assert.equal(g.academyRooms(), 500);
  const rooms = of('space');
  assert.equal(rooms.length, 500);
  assert.equal(new Set(rooms.map((r) => r.number)).size, 500);
});

test('“a continuation of several houses on both sides of a street”', () => {
  const a = g.academySizes;
  const roofs = of('roof');
  assert.equal(roofs.length, 2 * a.housesPerSide);
  // Each house lies wholly on one side of the street, ten on each.
  const sides = roofs.map((r) => {
    const ys = r.boundary.map((p) => p[1]);
    // Even with the eaves' overhang, the street between them is open: 8 m between the roofs.
    assert.ok(Math.max(...ys) <= -4_000 || Math.min(...ys) >= 4_000, r.id);
    return Math.sign(ys[0]);
  });
  assert.equal(sides.filter((s) => s < 0).length, a.housesPerSide);
  assert.equal(sides.filter((s) => s > 0).length, a.housesPerSide);
  // Every house has its street door in the wall facing the street.
  const doors = of('door').filter((d) => d.typeId === 't-street-door');
  assert.equal(doors.length, 2 * a.housesPerSide);
  // The street between them is paved.
  assert.ok(doc.elements.some((e) => e.id === 'street'));
});

test('the outer walls rise into the roof and are cut by it; the houses step out of line', () => {
  const outer = of('wall').filter((w) => w.typeId === 't-brick-wall');
  assert.equal(outer.length, 4 * 20);
  for (const w of outer) assert.match(w.clipBy ?? '', /^h[01]-\d+-roof$/, w.id);
  const front = (n) =>
    Math.min(...doc.elements.find((e) => e.id === `h1-${n}-roof`).boundary.map((p) => p[1]));
  assert.notEqual(front(0), front(1), 'the rows are not straight ("out of repair")');
});

test('the frame is twenty feet square, with forty iron handles round its edges', () => {
  const k = g.fixtureKernel;
  const f = g.frameSizes;
  near(f.side, 20 * foot, 0.01, 'side');
  const { assembly, versions } = g.f119Frame(k);
  assert.deepEqual(
    g.validateCad(assembly).filter((d) => d.severity === 'error'),
    [],
  );
  for (const v of versions)
    assert.deepEqual(
      g.validateCad(v.content).filter((d) => d.severity === 'error'),
      [],
      v.partId,
    );
  assert.equal(assembly.joints.length, 40);
  assert.ok(assembly.joints.every((j) => j.type === 'revolute'));
  // The handles stand on the east and west edges, twenty a side.
  const east = assembly.joints.filter((j) => j.child.connector.offset.rotation[1] > 0).length;
  assert.equal(east, 20);
  // Bits of wood of different sizes ("some larger than others"), about a die's bigness, on wires.
  const lengths = new Set([0, 1, 2, 3].flatMap((p) => g.rowBits(p).map(([, l]) => l)));
  assert.ok(lengths.size > 10);
  for (const l of lengths) assert.ok(l >= 20 && l <= f.bitLengths[1], `${l}`);
  // The rows fill the inside of the frame.
  const first = g.rowAt(0)[1],
    last = g.rowAt(39)[1];
  assert.ok(first > -f.side / 2 + f.rail && last < f.side / 2 - f.rail);
});

test('“giving them a sudden turn”: a half turn sets a row’s bits upside down', () => {
  const k = g.fixtureKernel;
  const still = g.f119Frame(k).assembly.solvedPoses;
  const turned = g.f119Frame(k, (n) => (n === 0 ? Math.PI : 0)).assembly.solvedPoses;
  const up = (pose) => rotate(pose.rotation, [0, 0, 1]);
  near(up(still['c-row-0'])[2], 1, 1e-9, 'row 1 at rest');
  near(up(turned['c-row-0'])[2], -1, 1e-9, 'row 1 turned');
  // The other rows stay as they were, and the row stays on its wire.
  assert.deepEqual(turned['c-row-1'], still['c-row-1']);
  for (let i = 0; i < 3; i++)
    near(turned['c-row-0'].translationMm[i], still['c-row-0'].translationMm[i], 1e-6, 'axis');
});
