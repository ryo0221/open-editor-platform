import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  applyCadOperation,
  cadContentHash,
  f01Empty,
  identityQuaternion,
  mm,
  position,
  topologyRefOf,
  type CadDocument,
  type CadSketch,
  type CadTopologyTable,
  type Quaternion,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import {
  applySimulationOperation,
  emptySimulation,
  simulationMaterialPresets,
  type SimulationDocument,
  type SimulationOperation,
  type SimulationTarget,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { runStudy, type RunEnvironment } from './run';
import { bendingTestOps, stiffnessTestResult, torsionTestOps } from './stiffness-test';

/**
 * CR5c (ST-270): the stiffness tests on a box-section cantilever. A 50 × 50 tube (a CAD sheet,
 * the closed square carried 600 mm along z, a cap sewn on each end) of 1 mm steel, split across at
 * z = 10 and z = 590. Without the caps the driven side walls distort the section instead of
 * turning it, and the tube twists about 7 times as easily as Bredt's formula says.
 * The mounts are the side walls' (y = ±25) end strips: the rear ones held, the front ones driven
 * along x (torsion) or held along x (bending).
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

const b = 50,
  length = 600,
  strip = 10,
  t = 1;
const steel = simulationMaterialPresets[0]!;

/** A line across the tube at height z, on the XZ plane (u = x, v = z, normal −y). */
const cutter = (id: string, z: number): CadSketch => {
  const solved: Record<string, [number, number]> = { a: [-100, z], b: [100, z] };
  return {
    id,
    name: id,
    plane: {
      origin: position(0, 0, 0),
      orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as Quaternion,
    },
    entities: [
      { type: 'point', id: 'a' },
      { type: 'point', id: 'b' },
      { type: 'line', id: 'l', start: 'a', end: 'b' },
    ],
    constraints: [],
    solved,
  };
};

/** An end cap: the square z = `z`, a line on the XZ plane at y = 25 carried 50 mm along −y. */
const capSketch = (id: string, z: number): CadSketch => ({
  id,
  name: id,
  plane: {
    origin: position(0, b / 2, 0),
    orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as Quaternion,
  },
  entities: [
    { type: 'point', id: 'a' },
    { type: 'point', id: 'b' },
    { type: 'line', id: 'l', start: 'a', end: 'b' },
  ],
  constraints: [],
  solved: { a: [-b / 2, z], b: [b / 2, z] },
});

/**
 * The tube, closed by a cap at each end (a car's bulkheads: without them the end sections
 * distort instead of turning) and sewn into one sheet, then split across.
 */
function tube(): CadDocument {
  const h = b / 2;
  const corners: Record<string, [number, number]> = {
    p0: [-h, -h],
    p1: [h, -h],
    p2: [h, h],
    p3: [-h, h],
  };
  const square: CadSketch = {
    id: 'square',
    name: 'Square',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [
      ...Object.keys(corners).map((id) => ({ type: 'point' as const, id })),
      { type: 'line', id: 's0', start: 'p0', end: 'p1' },
      { type: 'line', id: 's1', start: 'p1', end: 'p2' },
      { type: 'line', id: 's2', start: 'p2', end: 'p3' },
      { type: 'line', id: 's3', start: 'p3', end: 'p0' },
    ],
    constraints: [],
    solved: corners,
  };
  const sheetBody = (id: string, feature: string) => ({
    id,
    name: id,
    sourceFeatureId: feature,
    placementFeatureId: `${feature}-placement`,
    appearance: { color: '#9aa4b1', opacity: 1 },
  });
  const cap = (id: string, sketchId: string) => ({
    id,
    name: id,
    type: 'extrudeSurface' as const,
    inputFeatureIds: [] as [],
    args: { path: { sketchId, elements: ['l'] }, distance: mm(b), direction: 1 as const },
  });
  let doc = applyCadOperation(f01Empty(), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [
      square,
      capSketch('rear-cap-line', 0),
      capSketch('front-cap-line', length),
      cutter('rear-cut', strip),
      cutter('front-cut', length - strip),
    ],
    features: [
      {
        id: 'tube',
        name: 'Tube',
        type: 'extrudeSurface',
        inputFeatureIds: [],
        args: {
          path: { sketchId: 'square', elements: ['s0', 's1', 's2', 's3'] },
          distance: mm(length),
          direction: 1,
        },
      },
      cap('rear-cap', 'rear-cap-line'),
      cap('front-cap', 'front-cap-line'),
    ],
    bodies: [
      sheetBody('tube-body', 'tube'),
      sheetBody('rear-cap-body', 'rear-cap'),
      sheetBody('front-cap-body', 'front-cap'),
    ],
  });
  doc = applyCadOperation(doc, {
    type: 'sewBodies',
    targetId: 'tube-body',
    toolIds: ['rear-cap-body', 'front-cap-body'],
    toleranceMm: 0.0001,
    solid: false,
    sewFeatureId: 'sew',
    placementFeatureId: 'sew-placement',
  });
  for (const cut of ['rear-cut', 'front-cut'])
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: 'tube-body',
      placementFeatureId: `${cut}-placement`,
      feature: {
        id: `${cut}-split`,
        name: cut,
        type: 'split',
        inputFeatureIds: [doc.bodies.find((x) => x.id === 'tube-body')!.resultFeatureId],
        args: { tool: { sketchId: cut, elements: ['l'] } },
      },
    });
  return doc;
}

describe.skipIf(!available)('stiffness tests on a box-section cantilever (CR5c)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oc: any;
  let fem: FemMesherModule;
  beforeAll(async () => {
    const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(cadKernelBuild.wasmSha256);
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(
      pathToFileURL(path.join(kernel, cadKernelBuild.js)).href
    );
    oc = await factory({ wasmBinary: wasm });
    const create = (await import(pathToFileURL(path.join(mesher, 'fem-mesher.mjs')).href)) as {
      default: () => Promise<FemMesherModule>;
    };
    fem = await create.default();
  }, 300_000);

  const env = (): RunEnvironment => ({
    builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'fem-mesher', solver: 'geometry-fem' },
    surface: async (cad, request) =>
      (await evaluateCad(oc, cad, cadContentHash(cad), { analysisSurface: request }))
        .analysisSurface!,
    mesh: (surface, settings) => meshSurfaceReport(fem, surface, settings),
  });

  const setup = async (made: (doc: SimulationDocument, face: Face) => SimulationOperation[]) => {
    const cad = tube();
    const evaluated = await evaluateCad(oc, cad, cadContentHash(cad));
    const table: CadTopologyTable = evaluated.meshes.find(
      (m) => m.bodyId === 'tube-body',
    )!.topology;
    const featureId = cad.bodies.find((x) => x.id === 'tube-body')!.resultFeatureId;
    const face: Face = (c) => {
      let best = 0;
      table.faces.forEach((f, i) => {
        if (dist(f.centroid, c) < dist(table.faces[best]!.centroid, c)) best = i;
      });
      expect(dist(table.faces[best]!.centroid, c), JSON.stringify(c)).toBeLessThan(1e-6);
      return [{ kind: 'face', ref: topologyRefOf(table, 'face', best, featureId) }];
    };
    let doc: SimulationDocument = emptySimulation(
      {
        artifactId: 'tube',
        versionId: 'v1',
        contentHash: cadContentHash(cad),
        bodyId: 'tube-body',
      },
      'Tube',
    );
    doc.materials.push({ id: 'steel', ...steel });
    doc.materialId = 'steel';
    doc = applySimulationOperation(doc, {
      type: 'setSheetThickness',
      bodyId: 'tube-body',
      thicknessMm: t,
    });
    doc.mesh = { ...doc.mesh, size: 10, minSize: 4, grading: 1.5 };
    for (const op of made(doc, face)) doc = applySimulationOperation(doc, op);
    const study = doc.studies.at(-1)!;
    // One level here: the template's two levels are the user's check, not this fixture's.
    doc.studies[doc.studies.length - 1] = {
      ...study,
      solver: { tolerance: 1e-10, maxIterations: 200_000 },
      convergence: { levels: 1, metrics: ['max-displacement'], tolerance: 0.05 },
    };
    const run = await runStudy(doc, cad, cadContentHash(cad), study.id, table, env());
    expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
    for (const c of run.levels[0]!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    return { doc, run };
  };
  const h = b / 2;
  const mounts = (face: Face) => ({
    frontLeft: face([0, h, length - strip / 2]),
    frontRight: face([0, -h, length - strip / 2]),
    rear: [...face([0, h, strip / 2]), ...face([0, -h, strip / 2])],
  });

  it('twists the tube as stiff as Bredt’s formula gives', async () => {
    // TS-1569 (ST-270#1). The side walls' front strips moved ±0.1 mm along x: a turn about z.
    const d = 0.1;
    const { doc, run } = await setup((doc, face) => torsionTestOps(doc, mounts(face), d, 0));
    const result = stiffnessTestResult(doc, run);
    if (result?.kind !== 'torsion') throw new Error(JSON.stringify(result));
    // The run measures it on the level too (the test's convergence metric).
    expect(run.levels[0]!.metrics.stiffness).toBe(result.stiffness);
    expect(result.trackMm).toBeCloseTo(b, 3);
    expect(result.angleDeg).toBeCloseTo((Math.atan2(2 * d, b) * 180) / Math.PI, 6);
    // Bredt: J = 4 A² t / ∮ds = 4 (b²)² t / 4b = b³ t, and T/θ = G J / L over the length between
    // the strips' middles.
    const G = steel.youngsModulus / (2 * (1 + steel.poissonsRatio));
    const bredt = (G * b ** 3 * t) / (length - strip) / 1000 / (180 / Math.PI);
    // 293.1 for 298.7 N·m/deg (−1.9 %): the mesh (10 mm) and the strips' ends.
    expect(Math.abs(result.stiffness / bredt - 1)).toBeLessThan(0.03);
  }, 900_000);

  it('bends the tube and gives the force over the mean deflection', async () => {
    // TS-1575 (ST-270#2). 1000 N along −x on the side walls between the strips.
    const { doc, run } = await setup((doc, face) =>
      bendingTestOps(
        doc,
        { ...mounts(face), loaded: [...face([0, h, length / 2]), ...face([0, -h, length / 2])] },
        1000,
        0,
      ),
    );
    const result = stiffnessTestResult(doc, run);
    if (result?.kind !== 'bending') throw new Error(JSON.stringify(result));
    expect(run.levels[0]!.metrics.stiffness).toBe(result.stiffness);
    expect(result.forceN).toBeCloseTo(1000, 9);
    expect(result.stiffness).toBeCloseTo(1000 / result.deflectionMm, 9);
    // A beam held at one end and propped at the other under an even load w over L: the mean
    // deflection is w L⁴ / (320 E I); the strips hold neither end fully and the walls shear, so the tube gives a little more.
    const I = 2 * ((t * b ** 3) / 12) + 2 * b * t * h ** 2;
    const span = length - strip;
    const beam = ((1000 / span) * span ** 4) / (320 * steel.youngsModulus * I);
    // 0.0373 for 0.0367 mm (+1.7 %).
    expect(result.deflectionMm / beam).toBeGreaterThan(1);
    expect(result.deflectionMm / beam).toBeLessThan(1.1);
  }, 900_000);
});

type Face = (centroid: [number, number, number]) => SimulationTarget[];
