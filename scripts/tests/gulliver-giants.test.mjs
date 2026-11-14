// GV4c (docs/cad/gulliver-world.md): a Brobdingnagian farmer (21 m) and Glumdalclitch (12 m) as
// rigged figures built at their own heights with Gulliver's body plan (TS-2317, ST-649).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function load() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gulliver-giants-'));
  const file = path.join(dir, 'giants.mjs');
  await build({
    stdin: {
      contents:
        "export * from './scripts/fixtures/gulliver-people';\nexport { validateCharacter, emptyCharacter } from '@editor-platform/character-core';\nexport { decodeEpm } from '@editor-platform/geometry-mesh';\n",
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
const errors = (doc) => g.validateCharacter(doc).filter((d) => d.severity === 'error');
const positions = (f) => g.decodeEpm(f.assets.get('p/mesh')).positions;
const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );

test('the heights: twelve times Gulliver, and Glumdalclitch not above forty feet', () => {
  near(g.brobdingnagianHeightMm, 12 * g.gulliverHeightMm, 1e-9, 'twelve times');
  assert.ok(g.glumdalclitchHeightMm <= 40 * foot, 'not above forty feet');
  assert.ok(g.glumdalclitchHeightMm < g.brobdingnagianHeightMm, 'little for her age');
});

test('the farmer and Glumdalclitch pass validation, each with a walk, and stand their heights', () => {
  for (const [f, h] of [
    [g.f114Brobdingnagian(), 21_000],
    [g.f115Glumdalclitch(), 12_000],
  ]) {
    assert.deepEqual(errors(f.doc), [], f.doc.name);
    assert.deepEqual(
      f.doc.actions.map((a) => a.name),
      ['Walk'],
    );
    assert.equal(f.doc.skeletons[0].bones.length, 15);
    const p = positions(f);
    let top = -Infinity,
      bottom = Infinity;
    for (let i = 2; i < p.length; i += 3) {
      top = Math.max(top, p[i]);
      bottom = Math.min(bottom, p[i]);
    }
    near(bottom, 0, 1e-2, `${f.doc.name} feet on the ground`);
    near(top, h, h * 0.002, `${f.doc.name} height`);
  }
});

test('built at their heights, not scaled: Gulliver’s body plan at 21,000 / 1,750 and 12,000 / 1,750', () => {
  const a = positions(g.f107Gulliver());
  for (const [f, h] of [
    [g.f114Brobdingnagian(), 21_000],
    [g.f115Glumdalclitch(), 12_000],
  ]) {
    const k = h / 1750;
    const b = positions(f);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) near(b[i], a[i] * k, 0.05, `vertex ${i}`);
    for (const part of f.doc.parts) assert.deepEqual(part.transform.scale, [1, 1, 1]);
    for (const bone of f.doc.skeletons[0].bones) assert.deepEqual(bone.rest.scale, [1, 1, 1]);
  }
});

test('one scene holds the farmer, Glumdalclitch and Gulliver at their own heights', () => {
  const doc = g.emptyCharacter('Brobdingnag');
  const assets = new Map();
  const add = (prefix, name, heightMm, at, look) =>
    g.addFigure(doc, assets, { prefix, name, heightMm, at, look });
  add('farmer', 'Farmer', g.brobdingnagianHeightMm, [25_000, 0, 0], g.farmerLook);
  add('glum', 'Glumdalclitch', g.glumdalclitchHeightMm, [0, 0, 0], g.glumdalclitchLook);
  // Gulliver in his travelling box, held at her waist.
  add('gulliver', 'Gulliver', g.gulliverHeightMm, [0, 4_000, 5_750], g.gulliverLook);
  assert.equal(doc.skeletons.length, 3);
  assert.deepEqual(errors(doc), []);
});
