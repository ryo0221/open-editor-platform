import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  applyCadOperation,
  cadContentHash,
  f22Split,
  identityQuaternion,
  mm,
  position,
  topologyRefOf,
  type CadDocument,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import {
  applySimulationOperation,
  checkSimulationSource,
  emptySimulation,
  simulationMaterialPresets,
  type SimulationDocument,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { defaultThermalStudy } from './conditions';
import { runStudy, type RunEnvironment } from './run';

/**
 * TS-1570 (ST-269#2, CR5e): a CAD sheet analysed as a shell on itself. The F22 panel (100 × 60,
 * z = 0, y −60…0) split at x = 30; its face over x 0…30 bonded onto a solid mount (30 × 60 × 10
 * under it) held at its bottom; the face beyond pushed down. Twice the thickness, an eighth of
 * the deflection (the panel bends; the mount barely moves).
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** The split F22 panel (a sheet) on a solid mount. */
function panelOnMount(): CadDocument {
  return applyCadOperation(f22Split('open'), {
    type: 'insertFeatures',
    profiles: [
      {
        id: 'mount-profile',
        name: 'Mount outline',
        plane: { origin: position(0, -60, -10), orientation: identityQuaternion() },
        shape: { type: 'rectangle', width: mm(30), height: mm(60) },
      },
    ],
    features: [
      {
        id: 'mount-extrude',
        name: 'Mount',
        type: 'extrude',
        inputFeatureIds: [],
        args: { profileId: 'mount-profile', distance: mm(10), direction: 1 },
      },
    ],
    bodies: [
      {
        id: 'mount',
        name: 'Mount',
        sourceFeatureId: 'mount-extrude',
        placementFeatureId: 'mount-placement',
        appearance: { color: '#9aa4b1', opacity: 1 },
      },
    ],
  });
}

describe.skipIf(!available)('a CAD sheet as a shell of a given thickness (CR5e)', () => {
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

  const setup = async (thicknessMm: number | null) => {
    const cad = panelOnMount();
    const evaluated = await evaluateCad(oc, cad, cadContentHash(cad));
    const tables = new Map<string, CadTopologyTable>(
      evaluated.meshes.map((m) => [m.bodyId, m.topology]),
    );
    const feature = (id: string) => cad.bodies.find((b) => b.id === id)!.resultFeatureId;
    const face = (bodyId: string, c: [number, number, number]) => {
      const t = tables.get(bodyId)!;
      let best = 0;
      t.faces.forEach((f, i) => {
        if (dist(f.centroid, c) < dist(t.faces[best]!.centroid, c)) best = i;
      });
      expect(dist(t.faces[best]!.centroid, c)).toBeLessThan(1e-6);
      return {
        kind: 'face' as const,
        ref: topologyRefOf(t, 'face', best, feature(bodyId)),
        ...(bodyId === 'panel-body' ? {} : { body: bodyId }),
      };
    };
    let doc: SimulationDocument = emptySimulation(
      {
        artifactId: 'panel',
        versionId: 'v1',
        contentHash: cadContentHash(cad),
        bodyId: 'panel-body',
      },
      'Panel on a mount',
    );
    doc.materials.push({ id: 'steel', ...simulationMaterialPresets[0]! });
    doc.materialId = 'steel';
    doc = applySimulationOperation(doc, {
      type: 'addBody',
      body: { bodyId: 'mount', materialId: 'steel' },
    });
    if (thicknessMm !== null)
      doc = applySimulationOperation(doc, {
        type: 'setSheetThickness',
        bodyId: 'panel-body',
        thicknessMm,
      });
    doc = applySimulationOperation(doc, {
      type: 'addBond',
      bond: {
        id: 'seat',
        name: 'Seat',
        follower: [face('panel-body', [15, -30, 0])],
        on: [face('mount', [15, -30, 0])],
        tolerance: 0.01,
      },
    });
    doc.constraints.push({
      id: 'base',
      name: 'Base',
      kind: 'fixed',
      targets: [face('mount', [15, -30, -10])],
    });
    doc.loads.push({
      id: 'push',
      name: 'Push',
      kind: 'force',
      targets: [face('panel-body', [65, -30, 0])],
      force: [0, 0, -1],
    });
    doc.mesh = { ...doc.mesh, size: 5, minSize: 2, grading: 1.5 };
    doc.studies.push({
      id: 'static',
      name: 'Static',
      kind: 'linear-static',
      loadIds: ['push'],
      constraintIds: ['base'],
      solver: { tolerance: 1e-10, maxIterations: 200_000 },
      convergence: { levels: 1, metrics: ['max-displacement'], tolerance: 0.05 },
    });
    return { cad, doc, tables };
  };
  const run = (s: Awaited<ReturnType<typeof setup>>, studyId = 'static') =>
    runStudy(
      s.doc,
      s.cad,
      cadContentHash(s.cad),
      studyId,
      s.tables.get('panel-body')!,
      env(),
      s.tables,
    );

  it('bends the sheet as a shell of its thickness, an eighth as far at twice it', async () => {
    const tip = async (t: number) => {
      const r = await run(await setup(t));
      expect(r.failure, JSON.stringify(r.failure)).toBeUndefined();
      for (const c of r.levels[0]!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
      expect(r.levels[0]!.metrics['reaction-force']).toBeCloseTo(1, 6);
      if (r.fields?.kind !== 'bonded-static') throw new Error('not a bonded run');
      const panel = r.fields.bodies.find((b) => b.bodyId === 'panel-body')!;
      expect(panel.fields.kind).toBe('shell-static');
      return r.levels[0]!.metrics['max-displacement']!;
    };
    const thin = await tip(1);
    const thick = await tip(2);
    // A 70 mm cantilever 60 wide carrying 1 N spread along it: w L⁴ / (8 E I) = 0.0408 mm at
    // 1 mm (E 210 GPa); a plate is a little stiffer (1 − ν²) and the mount gives a little. The
    // ratio is t³ but for the mount's own give.
    expect(thin / 0.0408).toBeGreaterThan(0.9);
    expect(thin / 0.0408).toBeLessThan(1.05);
    expect(Math.abs(thin / thick / 8 - 1)).toBeLessThan(0.03);
  }, 900_000);

  it('refuses a sheet without a thickness, and a thermal study of one', async () => {
    // TS-1571 (ST-269#2).
    const bare = await setup(null);
    expect(checkSimulationSource(bare.doc, bare.cad).map((d) => d.code)).toEqual([
      'source-body-kind',
    ]);
    expect((await run(bare)).failure).toMatchObject({ code: 'source' });
    // A sheet thicker than a tenth of its size is no thin shell (Codex on #977): 117 mm across.
    const thick = await evaluateCad(oc, bare.cad, cadContentHash(bare.cad), {
      analysisSurface: {
        bodyId: 'panel-body',
        deflectionMm: 0.05,
        clampDeflection: true,
        idealisation: 'shell',
        sheetThicknessMm: 20,
      },
    });
    expect(thick.analysisSurface).toMatchObject({ code: 'midsurface-unsupported' });
    expect((thick.analysisSurface as { detail: string }).detail).toMatch(/more than a tenth/);
    // The sheet alone (its mount, bond and conditions taken away) in a thermal study.
    const given = await setup(1);
    const alone: SimulationDocument = {
      ...given.doc,
      loads: [],
      constraints: [
        {
          id: 'warm',
          name: 'Warm',
          kind: 'temperature',
          targets: (
            given.doc.loads[0] as { targets: SimulationDocument['constraints'][number]['targets'] }
          ).targets,
          temperature: 50,
        },
      ],
      studies: [],
    };
    alone.studies = [{ ...defaultThermalStudy(alone), id: 'heat' }];
    delete alone.bodies;
    delete alone.bonds;
    const heat = await run({ ...given, doc: alone }, 'heat');
    expect(heat.failure, JSON.stringify(heat.failure)).toMatchObject({ code: 'source' });
    expect(heat.failure!.detail).toMatch(/sheet body is solved as a shell/);
  }, 300_000);
});
