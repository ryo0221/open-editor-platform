// GV3c (docs/cad/gulliver-world.md): Gulliver (1,750 mm) and a Lilliputian (146 mm) as rigged
// figures built at their own heights, with the same body plan (TS-2311, ST-646).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-people-'));
  const file = path.join(dir, 'people.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-people';\nexport { validateCharacter, emptyCharacter, characterLimits } from '@editor-platform/character-core';\nexport { decodeEpm } from '@editor-platform/geometry-mesh';\n",
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
const positions = (f) => g.decodeEpm(f.assets.get('p/mesh')).positions;
const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );

test('Gulliver and a Lilliputian pass validation, each with a walk', () => {
  for (const f of [g.f107Gulliver(), g.f108Lilliputian()]) {
    assert.deepEqual(errors(f.doc), [], f.doc.name);
    assert.deepEqual(
      f.doc.actions.map((a) => a.name),
      ['Walk'],
    );
    assert.equal(f.doc.skeletons[0].bones.length, 15);
  }
});

test('each stands its own height: 1,750 mm and 146 mm', () => {
  for (const [f, h] of [
    [g.f107Gulliver(), 1750],
    [g.f108Lilliputian(), 146],
  ]) {
    const p = positions(f);
    let top = -Infinity,
      bottom = Infinity;
    for (let i = 2; i < p.length; i += 3) {
      top = Math.max(top, p[i]);
      bottom = Math.min(bottom, p[i]);
    }
    near(bottom, 0, 1e-3, `${f.doc.name} feet on the ground`);
    near(top, h, h * 0.002, `${f.doc.name} height`);
  }
});

test('the Lilliputian is built at 146 mm, not scaled: the same body plan at 146 / 1,750', () => {
  const big = g.f107Gulliver(),
    small = g.f108Lilliputian();
  const k = 146 / 1750;
  const a = positions(big),
    b = positions(small);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) near(b[i], a[i] * k, 1e-3, `vertex ${i}`);
  // No part, bone or skin carries a scale.
  for (const part of small.doc.parts) assert.deepEqual(part.transform.scale, [1, 1, 1]);
  for (const bone of small.doc.skeletons[0].bones) assert.deepEqual(bone.rest.scale, [1, 1, 1]);
  // Its hip joint is 146 / 1,750 as high.
  const hip = (f) => f.doc.skeletons[0].bones.find((x) => x.name === 'hip').rest.translation[2];
  near(hip(small), hip(big) * k, 1e-6, 'hip');
});

test('the two-bone leg reaches the point it was given', () => {
  const { thigh: a, shin: b } = g.limbLengths(1750);
  for (const [forward, up] of [
    [0, -700],
    [300, -500],
    [520, -150],
    [-200, -650],
  ]) {
    const { thigh, knee } = g.twoBoneAngles(forward, up, a, b);
    assert.ok(knee <= 0, 'the knee folds back');
    const r = g.twoBoneReach(thigh, knee, a, b);
    near(r.forward, forward, 1e-6, 'forward');
    near(r.up, up, 1e-6, 'up');
  }
});

test('one scene holds Gulliver and fifteen Lilliputians (the skeleton limit)', () => {
  const doc = g.emptyCharacter('Crowd');
  const assets = new Map();
  g.addFigure(doc, assets, {
    prefix: 'gulliver',
    name: 'Gulliver',
    heightMm: 1750,
    look: g.gulliverLook,
  });
  for (let i = 0; i < 15; i++)
    g.addFigure(doc, assets, {
      prefix: `l${i}`,
      name: `Lilliputian ${i + 1}`,
      heightMm: 146,
      at: [400 + 120 * i, 300, 762],
      facingRad: Math.PI,
      look: g.lilliputLooks[i % g.lilliputLooks.length],
    });
  assert.equal(doc.skeletons.length, g.characterLimits.skeletons);
  assert.deepEqual(errors(doc), []);
});

test('the 3D limb reaches its target with the knee toward the pole', () => {
  const { thigh: a, shin: b } = g.limbLengths(1750);
  const root = [100, 0, 900];
  for (const [target, pole] of [
    [
      [100, 300, 200],
      [0, 1, 0],
    ],
    [
      [500, 50, 850],
      [1, 0, 0.3],
    ],
    [
      [100, -200, 400],
      [0, 1, 0],
    ],
  ]) {
    const r = g.limbIk(root, target, pole, a, b);
    for (let k = 0; k < 3; k++) near(r.end[k], target[k], 1e-6, `end ${k}`);
    // The rotations reproduce the joints: the thigh's rest (0, 0, −a) turned lands on the knee.
    const knee = g.rotateVec(r.upper, [0, 0, -a]);
    for (let k = 0; k < 3; k++) near(root[k] + knee[k], r.knee[k], 1e-6, `knee ${k}`);
    const shin = g.rotateVec(r.lowerWorld, [0, 0, -b]);
    for (let k = 0; k < 3; k++) near(r.knee[k] + shin[k], target[k], 1e-6, `shin ${k}`);
    // The knee bends toward the pole.
    const mid = [0, 1, 2].map((k) => (root[k] + target[k]) / 2);
    const side = [0, 1, 2].reduce((n, k) => n + (r.knee[k] - mid[k]) * pole[k], 0);
    assert.ok(side > 0, 'toward the pole');
  }
});
