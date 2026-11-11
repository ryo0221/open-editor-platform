import { cadContentHash, edgeRef, type CadTopologyTable } from '@editor-platform/cad-core';
import { simulationFixture } from '@editor-platform/simulation-core';
import { describe, expect, it } from 'vitest';
import { convergenceLevelSettings } from '@editor-platform/simulation-core';
import { boxTetMesh, solveThermal } from '@editor-platform/geometry-fem';
import {
  levelFaceSizes,
  runStudy,
  surfaceVolume,
  thermalBalancePasses,
  thermalFluxMetric,
  type RunEnvironment,
} from './run';
import { defaultThermalStudy } from './conditions';
import { modalChecks } from './run-conditions';

const env = (): RunEnvironment & { calls: number } => {
  const e = {
    calls: 0,
    builds: { kernel: 'k', mesher: 'm', solver: 's' },
    surface: async () => {
      e.calls++;
      return { code: 'analysis-body-missing' };
    },
    mesh: () => {
      throw new Error('not reached');
    },
  };
  return e;
};
const table: CadTopologyTable = { faces: [], edges: [], vertices: [] };

describe('study run refusals before any kernel call (R3e-3)', () => {
  const setup = () => {
    const { cad, doc } = simulationFixture();
    doc.source.contentHash = cadContentHash(cad);
    return { cad, doc, hash: cadContentHash(cad) };
  };

  it('refuses an invalid document, a missing study, another version and no material', async () => {
    const { cad, doc, hash } = setup();
    const code = async (d: typeof doc, studyId = 'static', h = hash) => {
      const e = env();
      const run = await runStudy(d, cad, h, studyId, table, e);
      expect(run.status.status).toBe('failed');
      expect(run.fields).toBeUndefined();
      expect(e.calls).toBe(0);
      return run.failure!.code;
    };
    expect(await code({ ...doc, schemaVersion: 3 as 1 })).toBe('simulation-invalid');
    expect(await code(doc, 'nope')).toBe('study-missing');
    expect(await code(doc, 'static', 'sha256:other')).toBe('source');
    expect(await code({ ...doc, source: { ...doc.source, bodyId: 'nope' } })).toBe('source');
    expect(await code({ ...doc, materialId: null })).toBe('material-missing');
    // R3j-2 (TS-1399, ST-208#3); R3j-4b (TS-1452, ST-231#2): another body must be a body of the
    // version, and bodies are solved together only in a structural study in the browser.
    const two = {
      ...doc,
      schemaVersion: 2 as const,
      bodies: [{ bodyId: 'rib', materialId: null }],
    };
    expect(await code(two)).toBe('source');
    const t = doc.loads[0]!.kind === 'force' ? doc.loads[0]!.targets[0]! : undefined;
    const bonded = {
      ...doc,
      schemaVersion: 2 as const,
      bonds: [{ id: 'bond', name: 'Bond', follower: [t!], on: [t!], tolerance: 0.1 }],
      constraints: [
        ...doc.constraints,
        { id: 'hot', name: 'Hot', kind: 'temperature' as const, targets: [t!], temperature: 300 },
      ],
      studies: [
        ...doc.studies,
        { ...defaultThermalStudy(doc), id: 'heat', constraintIds: ['hot'] },
      ],
    };
    expect(await code(bonded, 'heat')).toBe('multi-body');
    const e = env();
    const remote = await runStudy(bonded, cad, hash, 'static', table, {
      ...e,
      remote: {
        name: 'Host',
        limits: { nodes: 1e6, elements: 1e6 },
        solve: async () => {
          throw new Error('no');
        },
      },
    });
    expect(remote.failure?.code).toBe('host');
    expect(e.calls).toBe(0);
    // A shell among bonded bodies goes through `solveBonded`: a Host without `solveShell` takes it.
    const shells = {
      ...bonded,
      studies: bonded.studies.map((s) =>
        s.id === 'static' && s.kind === 'linear-static'
          ? { ...s, idealisation: 'shell' as const }
          : s,
      ),
    };
    const e3 = env();
    const bondedShell = await runStudy(shells, cad, hash, 'static', table, {
      ...e3,
      remote: {
        name: 'Host',
        limits: { nodes: 1e6, elements: 1e6 },
        solve: async () => {
          throw new Error('no');
        },
        solveBonded: async () => {
          throw new Error('no');
        },
      },
    });
    expect(bondedShell.failure?.code).not.toBe('host');
    expect(e3.calls).toBeGreaterThan(0);
    // A removal on another body is refused, not applied to the source body.
    const other = {
      ...doc,
      schemaVersion: 2 as const,
      bodies: [{ bodyId: 'plate-2', materialId: 'steel' }],
      preparation: { ...doc.preparation, removeFaces: [{ ...t!, body: 'plate-2' }] },
    };
    const e2 = env();
    const removal = await runStudy(other, cad, hash, 'static', table, e2);
    expect(removal.failure?.code).toBe('target-unresolved');
    expect(removal.failure?.detail).toContain('$.preparation.removeFaces[0] (body plate-2)');
    expect(e2.calls).toBe(0);
  });

  it('refuses explicit removals and local sizes that do not resolve on the body table', async () => {
    const { cad, doc, hash } = setup();
    const target = doc.loads[0]!.kind === 'force' ? doc.loads[0]!.targets[0]! : undefined;
    const removal = { ...doc, preparation: { ...doc.preparation, removeFaces: [target!] } };
    const run = await runStudy(removal, cad, hash, 'static', table, env());
    expect(run.failure).toMatchObject({ code: 'target-unresolved' });
    expect(run.failure!.detail).toContain('$.preparation.removeFaces[0]');
    const edge = {
      ...doc,
      mesh: {
        ...doc.mesh,
        local: [
          {
            target: {
              kind: 'edge' as const,
              ref: edgeRef(
                target!.ref.featureId,
                ['plate-extrude', 'side:2'],
                ['plate-extrude', 'end'],
                [80, 25, 5],
                50,
              ),
            },
            size: 1,
          },
        ],
      },
    };
    const r2 = await runStudy(edge, cad, hash, 'static', table, env());
    expect(r2.failure).toMatchObject({ code: 'target-unresolved' });
    expect(r2.failure!.detail).toContain('edge sizes are not applied');
  });

  it('reports the kernel refusal of the surface at its level', async () => {
    const { cad, doc, hash } = setup();
    const e = env();
    const run = await runStudy(doc, cad, hash, 'static', table, e);
    expect(run.failure).toEqual({ code: 'surface', detail: 'analysis-body-missing', level: 0 });
    expect(run.status.reasons).toEqual(['surface: analysis-body-missing']);
    expect(e.calls).toBe(1);
  });
});

describe('local face sizes per level (R3e-3)', () => {
  it('refines each local size with its level, the smallest winning on a face named twice', () => {
    const { doc } = simulationFixture();
    const target = doc.loads[0]!.kind === 'force' ? doc.loads[0]!.targets[0]! : undefined;
    const local = [
      { target: target!, size: 4 },
      { target: target!, size: 2 },
      { target: target!, size: 8 },
    ];
    const levels = convergenceLevelSettings({ ...doc.mesh, local }, 3);
    const faces = [5, 5, 7];
    expect(levels.map((l) => levelFaceSizes(faces, l))).toEqual(
      [0, 1, 2]
        .map((k) => Math.SQRT1_2 ** k)
        .map((f) => [
          { face: 5, maxEdgeMm: 2 * f },
          { face: 7, maxEdgeMm: 8 * f },
        ]),
    );
  });
});

describe('the pre-mesh volume (R3e-3)', () => {
  it('is exact for a small cube far from the origin', () => {
    const o = 9_999_000.1;
    const h = 10.1;
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [
      o + (i & 1 ? h : 0),
      o + (i & 2 ? h : 0),
      o + (i & 4 ? h : 0),
    ]);
    // Outward-wound quads of the cube, two triangles each.
    const quads = [
      [0, 2, 3, 1],
      [4, 5, 7, 6],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
    ];
    const triangles = Uint32Array.from(quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]));
    const v = surfaceVolume({ points: Float64Array.from(corners.flat()), triangles });
    expect(Math.abs(v / h ** 3 - 1)).toBeLessThan(1e-6);
  });
});

describe('the thermal heat balance check (R3h-2)', () => {
  it('passes a body that moves no heat on roundoff alone (balance and flux), and fails a real imbalance', () => {
    const mesh = boxTetMesh({ size: [100, 10, 10], divisions: [10, 1, 1], type: 'tet10' });
    const solver = { tolerance: 1e-8, maxIterations: 2000 };
    const roundoff = (t: Float64Array) => ({
      conductivity: 50,
      diagonal: Math.hypot(100, 10, 10),
      maxAbsTemperature: t.reduce((m, v) => Math.max(m, Math.abs(v)), 0),
    });
    for (const conditions of [
      [{ kind: 'temperature' as const, faces: [0], edges: [], temperature: 293.15 }],
      [{ kind: 'convection' as const, faces: [0], coefficient: 0.01, ambient: 293.15 }],
    ]) {
      const t = solveThermal({ mesh, material: { conductivity: 50 }, conditions, solver });
      expect(t.converged).toBe(true);
      expect(thermalBalancePasses(t.balance, t.heatScale, roundoff(t.temperature))).toBe(true);
    }
    // The flux of a uniform body is roundoff, different on each mesh: both levels report 0.
    for (const divisions of [
      [2, 1, 1],
      [3, 1, 1],
    ] as [number, number, number][]) {
      const box = boxTetMesh({ size: [100, 10, 10], divisions, type: 'tet10' });
      const t = solveThermal({
        mesh: box,
        material: { conductivity: 50 },
        conditions: [{ kind: 'temperature', faces: [0], edges: [], temperature: 293.15 }],
        solver,
      });
      const max = t.fluxMagnitude.reduce((m, v) => Math.max(m, v), 0);
      expect(thermalFluxMetric(max, roundoff(t.temperature))).toBe(0);
    }
    // A real flux, 1e-5 mW/mm² (10 mW/m²), is kept.
    expect(thermalFluxMetric(1e-5, roundoff(new Float64Array([293.15])))).toBe(1e-5);
    // 1 mW lost of 5 W moved, or 1 mW in a body that moves none, fails.
    const scale = roundoff(new Float64Array([293.15]));
    expect(thermalBalancePasses(1, 5000, scale)).toBe(false);
    expect(thermalBalancePasses(1, 0, scale)).toBe(false);
    expect(thermalBalancePasses(1e-3, 5000, scale)).toBe(true);
  });
});

// TS-1477 (ST-244, CR0a #895): the Host's modal checks take the frequency from φᵀ K φ, allow
// CalculiX's printed eigenvalue 1e-3 off it, and keep the K-orthogonality at the Host's tolerance.
describe('Host modal checks (CR0a)', () => {
  const host = { name: 'Reference Host (CalculiX)', orthogonality: 1e-4 };
  const run = (residual: number, orthogonality: number) =>
    modalChecks({ converged: true, iterations: 0, orthogonality, modes: [{ residual }] }, host).map(
      (c) => c.pass,
    );
  it('passes the #895 car body and refuses a disagreement or coupled shapes', () => {
    expect(run(2.85e-4, 2e-5)).toEqual([true, true]);
    expect(run(2e-3, 2e-5)).toEqual([false, true]);
    expect(run(2.85e-4, 2e-4)).toEqual([true, false]);
  });
});
