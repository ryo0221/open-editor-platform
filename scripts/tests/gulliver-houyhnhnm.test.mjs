// GV6a (docs/cad/gulliver-world.md): the master Houyhnhnm's house and the Yahoos' hut (Part IV
// chapter 2) as BIM (TS-2324, ST-653).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-houyhnhnm-'));
  const file = path.join(dir, 'houyhnhnm.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-houyhnhnm';\nexport { validateBim, deriveBim } from '@editor-platform/bim-core';\n",
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
const { doc } = g.f120Farmstead();
const f = g.farmSizes;
const byId = (id) => {
  const e = doc.elements.find((x) => x.id === id);
  assert.ok(e, `element ${id}`);
  return e;
};
const of = (kind) => doc.elements.filter((e) => e.kind === kind);
const material = (typeId) => doc.types.find((t) => t.id === typeId);

test('the farmstead passes every rule and the model derives with no errors', () => {
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
});

test('“timber stuck in the ground, and wattled across; the roof was low and covered with straw”', () => {
  const outer = of('wall').filter((w) => w.typeId === 't-wattle');
  assert.equal(outer.length, 8);
  assert.ok(material('t-wattle').layers.every((l) => l.materialId === 'm-wattle'));
  for (const w of outer) assert.match(w.clipBy, /^(house|hut)-roof$/, w.id);
  const posts = of('column').filter((c) => /-post-/.test(c.id));
  assert.ok(posts.length >= 30, `${posts.length} posts`);
  for (const p of posts) assert.equal(p.top.level, 'l-eaves', p.id);
  for (const id of ['house-roof', 'hut-roof']) {
    const r = byId(id);
    assert.equal(r.typeId, 't-thatch');
    assert.equal(material(r.typeId).layers[0].materialId, 'm-straw');
    assert.equal(r.shape.form, 'gable');
  }
  // Low: the eaves stand at 2.6 m.
  assert.equal(doc.levels.find((l) => l.id === 'l-eaves').elevationMm, 2_600);
});

test('a large room and “three others, reaching the length of the house”, with a clay floor', () => {
  const rooms = of('space').filter((s) => s.id.startsWith('room-'));
  assert.equal(rooms.length, 4);
  const lengths = rooms.map(
    (r) => Math.max(...r.boundary.map((p) => p[0])) - Math.min(...r.boundary.map((p) => p[0])),
  );
  assert.ok(lengths[0] > lengths[1] && lengths[1] === lengths[2] && lengths[2] === lengths[3]);
  assert.equal(material(byId('house-floor').typeId).layers[0].materialId, 'm-clay');
  // "a rack and manger, extending the whole length on one side" of the large room.
  const manger = byId('manger').boundary.map((p) => p[0]);
  assert.ok(Math.max(...manger) - Math.min(...manger) > 0.9 * f.rooms[0]);
  assert.equal(byId('rack').kind, 'beam');
});

test('“three doors, opposite to each other, in the manner of a vista”', () => {
  const doors = ['house-entrance', 'partition-1-door', 'partition-2-door', 'partition-3-door'].map(
    byId,
  );
  // Every door's middle is on the centre line y = 0: the west wall runs north → south from
  // y = +w/2, the partitions south → north from y = −w/2.
  const w2 = f.houseWidth / 2;
  for (const d of doors) {
    const host = byId(d.hostId);
    const y0 = host.start.xy[1],
      dir = Math.sign(host.end.xy[1] - y0);
    assert.equal(y0 + dir * (d.alongMm + f.door[0] / 2), 0, d.id);
  }
  // Wide and high enough for a horse.
  assert.ok(f.door[0] >= 1_500 && f.door[1] >= 2_400);
  assert.ok(Math.abs(byId('house-w').start.xy[1]) === w2);
});

test('the third room: mangers in a ring about a rack, and mats of straw', () => {
  const ring = byId('dining-manger');
  assert.equal(ring.boundary.length, f.ring.sides);
  assert.equal(ring.holes.length, 1);
  const cx = f.rooms[0] + f.rooms[1] + f.rooms[2] / 2;
  assert.deepEqual(byId('dining-rack').at.xy, [cx, 0]);
  assert.equal(of('slab').filter((s) => s.typeId === 't-straw-mat').length, f.ring.partitions);
});

test('“another building, at some distance from the house”, with the beam the Yahoos are tied to', () => {
  const hut = byId('hut-space');
  const house = byId('house-n');
  const gap = Math.min(...hut.boundary.map((p) => p[1])) - house.start.xy[1];
  assert.ok(gap > 10_000, `${gap}`);
  const beam = byId('tether-beam');
  assert.equal(beam.top.offsetMm, f.hut.beamTop);
  assert.ok(doc.elements.some((e) => e.id === 'court'));
});
