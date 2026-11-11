import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  applyCadOperation,
  cadContentHash,
  emptyCad,
  identityQuaternion,
  mm,
  position,
  topologyRefOf,
  type CadDocument,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { evaluateCad, type CadAnalysisSurfaceRequest } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import {
  applySimulationOperation,
  emptySimulation,
  simulationMaterialPresets,
  type SimulationDocument,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { runStudy, spotWeldBandMm, spotWeldLocalSizeMm, type RunEnvironment } from './run';

/**
 * TS-1560 (ST-268#3, CR5b): spot welds in a study, run with the kernel and Netgen. A 200 × 40
 * plate (z 0…1) with a 200 × 20 strip on it (y 10…30, z 1…2), each 1 mm thick and analysed as a
 * shell; the CAD version's weld row runs along the strip's underside onto the plate. Clamped at
 * x = 0 and pushed down at x = 200, the welded pair bends as the two bending together (their
 * second moments added), at either pitch, and no less than with the strip bonded over its face.
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** The plate and the strip, each an extrude of 1 mm, its own body. */
function lapPlates(): CadDocument {
  const plate = (id: string, origin: [number, number, number], width: number) => ({
    profile: {
      id: `${id}-profile`,
      name: `${id} outline`,
      plane: { origin: position(...origin), orientation: identityQuaternion() },
      shape: { type: 'rectangle' as const, width: mm(200), height: mm(width) },
    },
    feature: {
      id: `${id}-extrude`,
      name: id,
      type: 'extrude' as const,
      inputFeatureIds: [] as [],
      args: { profileId: `${id}-profile`, distance: mm(1), direction: 1 as const },
    },
    body: {
      id,
      name: id,
      sourceFeatureId: `${id}-extrude`,
      placementFeatureId: `${id}-placement`,
      appearance: { color: '#9aa4b1', opacity: 1 },
    },
  });
  const [a, b] = [plate('plate', [0, 0, 0], 40), plate('strip', [0, 10, 1], 20)];
  return applyCadOperation(
    emptyCad({ id: 'fixture-welds', buildHash: `sha256:${'0'.repeat(64)}` }),
    {
      type: 'insertFeatures',
      profiles: [a.profile, b.profile],
      features: [a.feature, b.feature],
      bodies: [a.body, b.body],
    },
  );
}

describe.skipIf(!available)('spot welds in a study with the kernel and Netgen (CR5b)', () => {
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

  const env = (requests?: CadAnalysisSurfaceRequest[]): RunEnvironment => ({
    builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'fem-mesher', solver: 'geometry-fem' },
    surface: async (cad, request) => {
      requests?.push(request);
      return (await evaluateCad(oc, cad, cadContentHash(cad), { analysisSurface: request }))
        .analysisSurface!;
    },
    mesh: (surface, settings) => meshSurfaceReport(fem, surface, settings),
    spotWelds: async (cad) => {
      const { evaluation: e, meshes } = await evaluateCad(oc, cad, cadContentHash(cad));
      return {
        rows: e.status === 'ok' ? (e.spotWelds ?? []) : [],
        tables: new Map(
          meshes.filter((m) => !m.lod && !m.beforeFailure).map((m) => [m.bodyId, m.topology]),
        ),
      };
    },
  });

  /** The CAD version (with a weld row of `pitchMm`, if given) and the analysis of both plates. */
  const setup = async (pitchMm?: number) => {
    let cad = lapPlates();
    const evaluated = await evaluateCad(oc, cad, cadContentHash(cad));
    const tables = new Map<string, CadTopologyTable>(
      evaluated.meshes.map((m) => [m.bodyId, m.topology]),
    );
    const feature = (id: string) => cad.bodies.find((b) => b.id === id)!.resultFeatureId;
    const pick = (bodyId: string, c: [number, number, number]) => {
      const t = tables.get(bodyId)!;
      let best = 0;
      t.faces.forEach((f, i) => {
        if (dist(f.centroid, c) < dist(t.faces[best]!.centroid, c)) best = i;
      });
      expect(dist(t.faces[best]!.centroid, c)).toBeLessThan(1e-6);
      return topologyRefOf(t, 'face', best, feature(bodyId));
    };
    const face = (bodyId: string, c: [number, number, number]) => ({
      kind: 'face' as const,
      ref: pick(bodyId, c),
      ...(bodyId === 'plate' ? {} : { body: bodyId }),
    });
    const under = [100, 20, 1] as [number, number, number];
    if (pitchMm !== undefined)
      cad = applyCadOperation(cad, {
        type: 'setSpotWeld',
        weld: {
          id: 'row',
          name: 'Strip welds',
          flanges: [
            { bodyId: 'strip', face: pick('strip', under) },
            { bodyId: 'plate', face: pick('plate', under) },
          ],
          pitchMm,
          endDistanceMm: 5,
          maxGapMm: 0.5,
        },
      });
    let doc: SimulationDocument = emptySimulation(
      {
        artifactId: 'lap',
        versionId: 'v1',
        contentHash: cadContentHash(cad),
        bodyId: 'plate',
      },
      'Welded strip',
    );
    doc.materials.push({ id: 'steel', ...simulationMaterialPresets[0]! });
    doc.materialId = 'steel';
    doc = applySimulationOperation(doc, {
      type: 'addBody',
      body: { bodyId: 'strip', materialId: 'steel', idealisation: 'shell' },
    });
    doc.constraints.push({
      id: 'clamp',
      name: 'Clamp',
      kind: 'fixed',
      targets: [face('plate', [0, 20, 0.5]), face('strip', [0, 20, 1.5])],
    });
    doc.loads.push({
      id: 'tip',
      name: 'Tip',
      kind: 'force',
      targets: [face('plate', [200, 20, 0.5])],
      force: [0, 0, -1],
    });
    doc.mesh = { ...doc.mesh, size: 10, minSize: 2, grading: 1.5 };
    doc.studies.push({
      id: 'static',
      name: 'Static',
      kind: 'linear-static',
      idealisation: 'shell',
      loadIds: ['tip'],
      constraintIds: ['clamp'],
      solver: { tolerance: 1e-10, maxIterations: 200_000 },
      convergence: { levels: 1, metrics: ['max-displacement'], tolerance: 0.05 },
    });
    const weld = () =>
      applySimulationOperation(doc, {
        type: 'addSpotWeld',
        weld: {
          id: 'welds',
          name: 'Strip welds',
          weldId: 'row',
          follower: [face('strip', under)],
          on: [face('plate', under)],
          radiusMm: 3,
          tolerance: 0.01,
        },
      });
    const bond = () =>
      applySimulationOperation(doc, {
        type: 'addBond',
        bond: {
          id: 'glue',
          name: 'Glue',
          follower: [face('strip', under)],
          on: [face('plate', under)],
          tolerance: 0.01,
        },
      });
    return { cad, doc, tables, weld, bond };
  };
  const solve = async (
    cad: CadDocument,
    doc: SimulationDocument,
    tables: Map<string, CadTopologyTable>,
  ) => {
    const run = await runStudy(
      doc,
      cad,
      cadContentHash(cad),
      'static',
      tables.get('plate')!,
      env(),
      tables,
    );
    expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
    for (const c of run.levels[0]!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    return run;
  };
  const tip = (r: Awaited<ReturnType<typeof solve>>) => r.levels[0]!.metrics['max-displacement']!;

  it('makes the strip bend with the plate at either pitch, no less than a face bond', async () => {
    // The plate alone: a 200 mm strip 40 wide and 1 thick, 1 N at the tip (Euler–Bernoulli 1.9 mm
    // with E = 210 GPa; a wide plate is a little stiffer).
    const alone = await (async () => {
      const { cad, doc, tables } = await setup();
      const single: SimulationDocument = { ...doc, bodies: [] };
      delete single.bodies;
      single.constraints = [{ ...doc.constraints[0]!, targets: [doc.constraints[0]!.targets[0]!] }];
      return tip(await solve(cad, single, tables));
    })();
    const welded = async (pitch: number) => {
      const s = await setup(pitch);
      const run = await solve(s.cad, s.weld(), s.tables);
      return { run, tip: tip(run) };
    };
    const coarse = await welded(40);
    const fine = await welded(10);
    const glued = await (async () => {
      const s = await setup();
      return tip(await solve(s.cad, s.bond(), s.tables));
    })();
    // 200 mm less 5 at each end: 5 points at 40, 20 at 10; the strip's welded face takes the
    // weld's local size.
    expect(coarse.run.levels[0]!.checks[0]!.detail).toMatch(/Strip welds: 5 welds tie \d+ nodes/);
    expect(fine.run.levels[0]!.checks[0]!.detail).toMatch(/Strip welds: 20 welds tie \d+ nodes/);
    expect(spotWeldLocalSizeMm).toBe(10);
    // The welds make the strip bend with the plate: their second moments add (3.33 + 1.67 mm⁴),
    // so the tip moves 1/1.5 as far. The ties join midsurface to midsurface without the 1 mm
    // offset as a lever arm, so the pair is not one composite section (that would be 5.5 times
    // as stiff); a closed section (FX-CR2) gets its stiffness from its depth, not from this.
    expect(Math.abs((coarse.tip * 1.5) / alone - 1)).toBeLessThan(0.03);
    expect(Math.abs((fine.tip * 1.5) / alone - 1)).toBeLessThan(0.03);
    expect(fine.tip).toBeLessThanOrEqual(coarse.tip);
    expect(glued).toBeLessThanOrEqual(fine.tip);
    const tied = (r: typeof coarse) =>
      Number(/Strip welds: \d+ welds tie (\d+) nodes/.exec(r.run.levels[0]!.checks[0]!.detail)![1]);
    expect(tied(fine)).toBeGreaterThan(tied(coarse));
    if (fine.run.fields?.kind !== 'bonded-static') throw new Error('not a bonded run');
    expect(fine.run.fields.bodies.map((b) => b.bodyId)).toEqual(['plate', 'strip']);
  }, 900_000);

  it('sizes the welded flanges without display tables, finer at each level (Codex on #976)', async () => {
    // TS-1565: no tables given: the evaluation's own find the welded faces; at a global 30 mm the
    // welds' surroundings are meshed at 10 mm, then 7.1 mm at the second level. CR5e-2 (TS-1581, ST-273):
    // around the weld points (5 mm, growing by the distance beyond), not over the whole flanges.
    const s = await setup(40);
    const doc = s.weld();
    doc.mesh = { ...doc.mesh, size: 30, minSize: 2 };
    doc.studies[0]!.convergence = { ...doc.studies[0]!.convergence, levels: 2 };
    const requests: CadAnalysisSurfaceRequest[] = [];
    const given = await runStudy(
      doc,
      s.cad,
      cadContentHash(s.cad),
      'static',
      s.tables.get('plate')!,
      env(requests),
      s.tables,
    );
    const bare = await runStudy(
      doc,
      s.cad,
      cadContentHash(s.cad),
      'static',
      s.tables.get('plate')!,
      env(),
    );
    for (const r of [given, bare]) expect(r.failure, JSON.stringify(r.failure)).toBeUndefined();
    expect(bare.levels.map((l) => l.nodes)).toEqual(given.levels.map((l) => l.nodes));
    expect(given.levels[1]!.nodes).toBeGreaterThan(given.levels[0]!.nodes * 1.5);
    // Both bodies are sized around the row's 5 points, no face as a whole (CR5e-2).
    const first = requests.filter((r) => r.maxEdgeMm === 30);
    expect(first.map((r) => r.bodyId).sort()).toEqual(['plate', 'strip']);
    for (const r of first) {
      expect(r.faceSizes).toEqual([]);
      expect(r.pointSizes).toMatchObject({ radiusMm: spotWeldBandMm, maxEdgeMm: 10 });
      expect(r.pointSizes!.points).toHaveLength(15);
    }
    expect(spotWeldBandMm).toBe(5);
  }, 900_000);

  it('refuses a weld whose CAD row now joins other faces (Codex on #976)', async () => {
    // TS-1566: the version's row keeps its ID but welds the strip's top, not its underside.
    const s = await setup(40);
    const doc = s.weld();
    const cad = structuredClone(s.cad);
    const t = s.tables.get('strip')!;
    const top = t.faces.findIndex((f) => dist(f.centroid, [100, 20, 2]) < 1e-6);
    cad.spotWelds![0]!.flanges[0]!.face = topologyRefOf(t, 'face', top, 'strip-placement');
    doc.source = { ...doc.source, contentHash: cadContentHash(cad) };
    const run = await runStudy(
      doc,
      cad,
      cadContentHash(cad),
      'static',
      s.tables.get('plate')!,
      env(),
      s.tables,
    );
    expect(run.failure).toMatchObject({ code: 'spot-weld' });
    expect(run.failure!.detail).toMatch(/joins other faces than the weld took/);
  }, 300_000);

  it('refuses a weld whose CAD row is gone', async () => {
    // TS-1561: the analysis takes row `row`, the CAD version has no such row.
    const s = await setup();
    const run = await runStudy(
      s.weld(),
      s.cad,
      cadContentHash(s.cad),
      'static',
      s.tables.get('plate')!,
      env(),
      s.tables,
    );
    expect(run.failure).toMatchObject({ code: 'spot-weld' });
    expect(run.failure!.detail).toMatch(/row/);
  }, 300_000);
});
