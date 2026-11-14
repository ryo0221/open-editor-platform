// GV4a (docs/cad/gulliver-world.md): the temple tower of Lorbrulgrud and a chief room of the
// king's palace as buildings for 21 m people, at the sizes Part II of the text gives
// (TS-2313, ST-647).
/* global structuredClone */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-brobdingnag-'));
  const file = path.join(dir, 'brobdingnag.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-brobdingnag';\nexport { validateBim, deriveBim, bimBodyLimits } from '@editor-platform/bim-core';\n",
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
const { doc: tower, summary } = g.f109TempleTower();
const { doc: room } = g.f110PalaceRoom();
const byId = (doc, id) => {
  const e = doc.elements.find((x) => x.id === id);
  assert.ok(e, `element ${id}`);
  return e;
};
const type = (doc, id) => doc.types.find((t) => t.id === id);
const thickness = (doc, typeId) => type(doc, typeId).layers.reduce((n, l) => n + l.thicknessMm, 0);
const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );
const errors = (doc) => g.validateBim(doc).map((d) => `${d.code} ${d.path}`);

test('the tower and the room pass every rule as buildings for 21 m people', () => {
  for (const doc of [tower, room]) {
    assert.equal(doc.inhabitantHeightMm, 21_000);
    assert.deepEqual(errors(doc), [], doc.project.name);
    assert.deepEqual(
      g.deriveBim(doc).diagnostics.filter((d) => d.severity === 'error'),
      [],
      doc.project.name,
    );
  }
});

test('for 1,750 mm people the 100 ft walls are refused (sections grow with the people)', () => {
  const ours = structuredClone(tower);
  delete ours.inhabitantHeightMm;
  const e = errors(ours);
  assert.ok(e.includes('dimension $.types[0].layers[0].thicknessMm'), e.join('\n'));
  assert.equal(g.bimBodyLimits(tower).maxSectionMm, 120_000);
});

test('the tower is 3,000 ft to the pinnacle top, its walls 100 ft thick at the foot', () => {
  near(summary.topMm, 3_000 * foot, 0.5, 'pinnacle top');
  // The outside of the apex: the eaves level, the roof's half width at 60°, and the slab's
  // thickness measured upright (the roof's top surface stands thickness ÷ cos(slope) above its
  // underside, as bimRoofPlanes builds it).
  const roof = byId(tower, 'tower-roof');
  const eaves = tower.levels.find((l) => l.id === roof.base.level).elevationMm;
  const half = Math.max(...roof.boundary.map((p) => p[0]));
  const thick = tower.types
    .find((t) => t.id === roof.typeId)
    .layers.reduce((n, l) => n + l.thicknessMm, 0);
  const rise = thick / Math.cos(roof.shape.slopeRad);
  near(eaves + half * Math.tan(roof.shape.slopeRad) + rise, 3_000 * foot, 1, 'apex');
  assert.ok(roof.shape.slopeRad <= Math.PI / 3 + 1e-12, 'within the BIM roof pitch');
  near(thickness(tower, 't-tower-wall-0'), 100 * foot, 0.1, 'wall at the foot');
  // Each stage stands on the one below: its wall lies within the lower wall's thickness.
  const span = (w, t) => {
    const a = Math.abs(w.start.xy[1]);
    return [a - t / 2, a + t / 2];
  };
  for (const [lo, hi] of [
    [0, 1],
    [1, 2],
  ]) {
    const [l0, l1] = span(byId(tower, `tower-${lo}-s`), thickness(tower, `t-tower-wall-${lo}`));
    const [h0, h1] = span(byId(tower, `tower-${hi}-s`), thickness(tower, `t-tower-wall-${hi}`));
    assert.ok(h0 >= l0 - 0.5 && h1 <= l1 + 0.5, `stage ${hi} on stage ${lo}`);
  }
  // The top stage's walls are cut by the pinnacle (no gap under its eaves).
  for (const side of ['s', 'e', 'n', 'w'])
    assert.equal(byId(tower, `tower-2-${side}`).clipBy, 'tower-roof');
  // Statues in niches on every side; a door 12 times ours at the foot.
  const niches = tower.elements.filter((e) => e.typeId === 't-niche');
  assert.equal(niches.length, 14);
  assert.deepEqual(
    [type(tower, 't-giant-door').widthMm, type(tower, 't-giant-door').heightMm],
    [10_800, 25_200],
  );
});

test("the palace's chief room is 240 ft high, broad and long in proportion", () => {
  const eaves = room.levels.find((l) => l.id === 'l-1').elevationMm;
  near(eaves, 240 * foot, 0.1, 'room height');
  const s = byId(room, 'room-s');
  near(Math.abs(s.end.xy[0] - s.start.xy[0]), 480 * foot, 0.1, 'length');
  const e = byId(room, 'room-e');
  near(Math.abs(e.end.xy[1] - e.start.xy[1]), 360 * foot, 0.1, 'width');
  for (const side of ['s', 'e', 'n', 'w'])
    assert.equal(byId(room, `room-${side}`).clipBy, 'room-roof');
  assert.equal(room.elements.filter((x) => x.kind === 'window').length, 12);
  assert.equal(room.elements.filter((x) => x.kind === 'door').length, 2);
});

test("every element says whether its size is from the text, derived or the author's", () => {
  for (const doc of [tower, room])
    for (const e of doc.elements) {
      const p = e.properties?.['ps-gulliver'];
      assert.ok(p, `${e.id} has a source`);
      assert.ok(['本文', '推定', '創作'].includes(p.Source), e.id);
      assert.equal(p.Chapter, '第2篇第4章', e.id);
    }
  assert.equal(byId(tower, 'tower-0-s').properties['ps-gulliver'].Source, '本文');
  assert.equal(byId(tower, 'tower-1-s').properties['ps-gulliver'].Source, '創作');
});
