// GV6b (docs/cad/gulliver-world.md): a Houyhnhnm as a horse on four legs with IK chains and a
// four-beat walk (F121), and a Yahoo on Gulliver's body plan (F122) (TS-2326, ST-654).
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
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-horse-'));
  const file = path.join(dir, 'horse.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-horse';\nexport { validateCharacter, worldMatrices, poseAt } from '@editor-platform/character-core';\nexport { decodeEpm } from '@editor-platform/geometry-mesh';\n",
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
const errors = (doc) => g.validateCharacter(doc).filter((d) => d.severity === 'error');
const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );
const at = (m) => [m[12], m[13], m[14]];
const horse = g.f121Houyhnhnm();
const hooves = ['hindhoof.L', 'hindhoof.R', 'forehoof.L', 'forehoof.R'];

test('the Houyhnhnm and the Yahoo pass validation, each with a walk', () => {
  const yahoo = g.f122Yahoo();
  for (const f of [horse, yahoo]) {
    assert.deepEqual(errors(f.doc), [], f.doc.name);
    assert.deepEqual(
      f.doc.actions.map((a) => a.name),
      ['Walk'],
    );
  }
  assert.equal(horse.doc.skeletons[0].bones.length, 17);
  assert.equal(yahoo.doc.skeletons[0].bones.length, 15);
  // "a perfect human figure": the Yahoo is a person, on Gulliver's body plan.
  assert.equal(yahoo.figure.heightMm, g.yahooHeightMm);
});

test('a horse on four legs: 1.6 m at the withers, four hooves on the ground, longer than high', () => {
  const p = g.decodeEpm(horse.assets.get('h/mesh')).positions;
  const zs = [],
    ys = [];
  for (let i = 0; i < p.length; i += 3) {
    ys.push(p[i + 1]);
    zs.push(p[i + 2]);
  }
  near(Math.min(...zs), 0, 1e-6, 'feet on the ground');
  assert.ok(Math.max(...ys) - Math.min(...ys) > 1.4 * g.houyhnhnmWithersMm, 'body length');
  const rest = g.worldMatrices(horse.doc, g.poseAt(horse.doc, null, 0)).bones;
  for (const b of hooves) near(at(rest.get(`h/${b}`))[2], 130, 1e-6, `${b} fetlock`);
  // The withers (above the shoulders, y 250–640) at 1.6 m.
  let withers = 0;
  for (let i = 0; i < p.length; i += 3)
    if (p[i + 1] >= 250 && p[i + 1] <= 640) withers = Math.max(withers, p[i + 2]);
  near(withers, g.houyhnhnmWithersMm, 1e-3, 'withers');
});

test('each leg has an IK chain: enabled, it puts its hoof on a target, the hock bending back', () => {
  const sk = horse.doc.skeletons[0];
  assert.deepEqual(
    sk.ik.map((c) => [c.tipBoneId, c.length, c.enabled]),
    [
      ['h/hindhoof.L', 2, false],
      ['h/hindhoof.R', 2, false],
      ['h/forehoof.L', 2, false],
      ['h/forehoof.R', 2, false],
    ],
  );
  for (const [i, lift] of [
    [0, [0, 200, 150]],
    [3, [0, -150, 200]],
  ]) {
    const doc = structuredClone(horse.doc);
    const chain = doc.skeletons[0].ik[i];
    const target = chain.target.map((c, j) => c + lift[j]);
    doc.skeletons[0].ik[i] = { ...chain, target, enabled: true };
    const w = g.worldMatrices(doc, g.poseAt(doc, null, 0)).bones;
    at(w.get(chain.tipBoneId)).forEach((c, j) => near(c, target[j], 0.01, `${chain.name} ${j}`));
    if (i === 0) {
      // The hock lies behind the line from the hip to the hoof.
      const hip = at(w.get('h/hind.L')),
        hock = at(w.get('h/hock.L'));
      const s = (hock[2] - hip[2]) / (target[2] - hip[2]);
      assert.ok(hock[1] < hip[1] + s * (target[1] - hip[1]), 'hock to the rear');
    }
  }
});

test('the walk is four-beat: the hooves lift in turn, left hind, left fore, right hind, right fore', () => {
  const walk = horse.doc.actions[0];
  const seconds = walk.duration / 240_000;
  // A hoof is lifted when its knee or hock is folded most.
  const folded = (bone) => {
    let best = -Infinity,
      when = 0;
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * seconds;
      const q = g.poseAt(horse.doc, walk, Math.round(t * 240_000)).bones.get(`h/${bone}`).rotation;
      const angle = 2 * Math.acos(Math.min(1, Math.abs(q[3])));
      if (angle > best) {
        best = angle;
        when = t / seconds;
      }
    }
    return when;
  };
  const order = ['hock.L', 'knee.L', 'hock.R', 'knee.R'].map(folded);
  // Each lifts a quarter of a stride after the one before.
  for (let i = 1; i < 4; i++) {
    const gap = (order[i] - order[i - 1] + 1) % 1;
    near(gap, 0.25, 0.05, `beat ${i}`);
  }
});
