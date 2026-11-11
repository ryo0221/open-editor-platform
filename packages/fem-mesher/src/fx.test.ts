import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { cadContentHash, type CadDocument } from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import {
  curvedJacobianMin,
  equilibriumCheck,
  solveElastic,
  type ElasticInput,
} from '@editor-platform/geometry-fem';
import {
  convergenceLevelSettings,
  studyStatus,
  type RunCheck,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { facesAtRadius, facesOn, fx2, fx3 } from './fx-fixtures';
import { meshSurfaceReport, type FemMesherModule, type SurfaceMeshInput } from './index';

const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
/** Opt-in (`FEM_FX=1`): three tet10 levels each, minutes of solving with the Jacobi PCG. */
const available =
  process.env.FEM_FX === '1' &&
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));
const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };

interface Level {
  metrics: { 'max-von-mises': number; 'max-displacement': number };
  checks: RunCheck[];
  values: Record<string, number>;
  nodes: number;
}

describe.skipIf(!available)('known solutions FX2 and FX3 (R3d-2b, docs/cad/r3-analysis.md)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oc: any;
  let fem: FemMesherModule;
  beforeAll(async () => {
    const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(cadKernelBuild.wasmSha256);
    // The Emscripten loader expects CommonJS globals under Node.
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

  const surface = async (
    doc: CadDocument,
    bodyId: string,
    maxEdgeMm: number,
    local: Map<number, number>,
  ) => {
    const r = await evaluateCad(oc, doc, cadContentHash(doc), {
      analysisSurface: {
        bodyId,
        deflectionMm: 0.05,
        maxEdgeMm,
        faceSizes: [...local].map(([face, size]) => ({ face, maxEdgeMm: size })),
      },
    });
    if (!r.analysisSurface || !('surface' in r.analysisSurface))
      throw new Error(JSON.stringify(r.analysisSurface));
    return r.analysisSurface.surface;
  };
  /** Solves one level and gives its metrics and the design's checks (mapping by fixture geometry). */
  const solve = (
    s: SurfaceMeshInput,
    size: number,
    minSize: number,
    problem: (s: SurfaceMeshInput) => Omit<ElasticInput, 'mesh' | 'material' | 'solver'>,
    probe: (
      mesh: ReturnType<typeof meshSurfaceReport>['mesh'],
      r: ReturnType<typeof solveElastic>,
    ) => Record<string, number>,
    wanted: [number, number, number][],
  ): Level => {
    const m = meshSurfaceReport(fem, s, { type: 'tet10', size, minSize, grading: 1.3 });
    const p = problem(s);
    const r = solveElastic({
      mesh: m.mesh,
      material: steel,
      ...p,
      solver: { tolerance: 1e-8, maxIterations: 400_000 },
    });
    const eq = equilibriumCheck(r);
    const loadOk = r.loadChecks.every((c, i) =>
      c.force.every((f, d) => Math.abs(f - wanted[i]![d]!) <= 5e-3 * Math.hypot(...wanted[i]!)),
    );
    let vm = 0,
      u = 0;
    for (let n = 0; n < m.mesh.nodes.length / 3; n++) {
      vm = Math.max(vm, r.vonMises[n]!);
      u = Math.max(
        u,
        Math.hypot(r.displacement[3 * n]!, r.displacement[3 * n + 1]!, r.displacement[3 * n + 2]!),
      );
    }
    return {
      metrics: { 'max-von-mises': vm, 'max-displacement': u },
      checks: [
        { name: 'mapping', pass: true, detail: 'by fixture geometry' },
        { name: 'load', pass: loadOk, detail: JSON.stringify(r.loadChecks.map((c) => c.force)) },
        {
          name: 'quality',
          pass: m.minJacobian >= curvedJacobianMin,
          detail: `min Jacobian ratio ${m.minJacobian}, ${m.straightened} mid nodes straightened`,
        },
        {
          name: 'solver',
          pass: r.converged,
          detail: `${r.iterations} iterations, residual ${r.residual}`,
        },
        { name: 'equilibrium', pass: eq.pass, detail: `${eq.imbalance} of ${eq.scale}` },
      ],
      values: { ...probe(m.mesh, r), minJacobian: m.minJacobian, straightened: m.straightened },
      nodes: m.mesh.nodes.length / 3,
    };
  };
  const study = {
    convergence: {
      levels: 3,
      metrics: ['max-von-mises', 'max-displacement'] as ('max-von-mises' | 'max-displacement')[],
      tolerance: 0.02,
    },
  };
  const report = (name: string, levels: Level[]) =>
    process.stderr.write(
      `${name} ${JSON.stringify(levels.map((l) => ({ nodes: l.nodes, ...l.values, ...l.metrics })))}\n`,
    );

  it('FX2 plate with a hole: the hole edge peak within 5% of 302 MPa, verified over three levels', async () => {
    const doc = fx2();
    const probe = await surface(doc, 'plate', 1000, new Map());
    const hole = facesAtRadius(probe, 10);
    expect(hole.length).toBe(1);
    const levels: Level[] = [];
    for (const l of convergenceLevelSettings(
      { order: 2, size: 8, minSize: 1, grading: 1.3, local: [] },
      3,
    )) {
      const holeSize = (Math.SQRT2 * l.size) / 8;
      const s = await surface(doc, 'plate', l.size, new Map([[hole[0]!, holeSize]]));
      levels.push(
        solve(
          s,
          l.size,
          holeSize / 2,
          (s) => ({
            constraints: [
              { faces: facesOn(s, 0, 0), edges: [], displacement: [0, null, null] },
              { faces: facesOn(s, 1, 0), edges: [], displacement: [null, 0, null] },
              { faces: facesOn(s, 2, 0), edges: [], displacement: [null, null, 0] },
            ],
            loads: [
              { kind: 'face-force', faces: facesOn(s, 1, 200), force: [0, 100 * 100 * 1, 0] },
            ],
          }),
          (mesh, r) => {
            // The hole edge at θ = 90° (x = r, y = 0), averaged through the thickness.
            let peak = 0,
              edge = 0,
              n = 0;
            for (let q = 0; q < mesh.nodes.length / 3; q++) {
              peak = Math.max(peak, r.stress[6 * q + 1]!);
              if (
                Math.abs(mesh.nodes[3 * q + 1]!) < 1e-9 &&
                Math.abs(mesh.nodes[3 * q]! - 10) < 1e-6
              ) {
                edge += r.stress[6 * q + 1]!;
                n++;
              }
            }
            return { peakSyy: peak, edgeSyy: edge / n };
          },
          [[0, 10_000, 0]],
        ),
      );
    }
    report('FX2', levels);
    for (const l of levels) expect(Math.abs(l.values.peakSyy! / 302 - 1)).toBeLessThan(0.05);
    const st = studyStatus({
      study,
      checks: levels[2]!.checks,
      levels: levels.map((l) => l.metrics),
    });
    expect(st.reasons).toEqual([]);
    expect(st.status).toBe('verified');
  }, 3_600_000);

  it('FX3 thick cylinder: inner hoop stress within 3% of Lamé and radial displacement within 2%, verified', async () => {
    const doc = fx3();
    const E = steel.youngsModulus,
      nu = steel.poissonsRatio,
      a = 50,
      b = 100,
      p = 100;
    const hoop = (p * (b * b + a * a)) / (b * b - a * a);
    const ur = (((1 + nu) * p * a * a) / (E * (b * b - a * a))) * ((1 - 2 * nu) * a + (b * b) / a);
    const levels: Level[] = [];
    for (const l of convergenceLevelSettings(
      { order: 2, size: 10, minSize: 2.5, grading: 1.3, local: [] },
      3,
    )) {
      const s = await surface(doc, 'tube', l.size, new Map());
      const inner = facesAtRadius(s, 50);
      // The inner face's resultant: p × its projected area on y = 0 (a × length), along +y... and x.
      const resultant = p * a * 20;
      levels.push(
        solve(
          s,
          l.size,
          l.minSize,
          (s) => ({
            constraints: [
              { faces: facesOn(s, 0, 0), edges: [], displacement: [0, null, null] },
              { faces: facesOn(s, 1, 0), edges: [], displacement: [null, 0, null] },
              {
                faces: [...facesOn(s, 2, 0), ...facesOn(s, 2, 20)],
                edges: [],
                displacement: [null, null, 0],
              },
            ],
            loads: [{ kind: 'pressure', faces: inner, pressure: p }],
          }),
          (mesh, r) => {
            let st = 0,
              u = 0,
              n = 0;
            for (let q = 0; q < mesh.nodes.length / 3; q++)
              if (
                Math.abs(mesh.nodes[3 * q + 1]!) < 1e-9 &&
                Math.abs(mesh.nodes[3 * q]! - a) < 1e-9
              ) {
                st += r.stress[6 * q + 1]!;
                u += r.displacement[3 * q]!;
                n++;
              }
            return { hoop: st / n, ur: u / n };
          },
          // Pressure on the inner quarter pushes out: −p ∫ n dA = p·a·L along −x and −y... outward.
          [[-resultant, -resultant, 0].map((x) => -x) as [number, number, number]],
        ),
      );
    }
    report('FX3', levels);
    for (const l of levels) {
      expect(Math.abs(l.values.hoop! / hoop - 1)).toBeLessThan(0.03);
      expect(Math.abs(l.values.ur! / ur - 1)).toBeLessThan(0.02);
    }
    const st = studyStatus({
      study,
      checks: levels[2]!.checks,
      levels: levels.map((l) => l.metrics),
    });
    expect(st.reasons).toEqual([]);
    expect(st.status).toBe('verified');
  }, 3_600_000);
});
