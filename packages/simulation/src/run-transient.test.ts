import { describe, expect, it } from 'vitest';
import { boxTetMesh, solveTransientThermal } from '@editor-platform/geometry-fem';
import { simulationMaterialPresets, transientStudy } from '@editor-platform/simulation-core';
import { runTransientLevel, type TransientRemote } from './run-transient';

describe('a transient level’s checks (VS11d, Codex on #1264)', () => {
  it('passes the balance of a body that moves no heat: its roundoff only', async () => {
    const mesh = boxTetMesh({ size: [100, 10, 10], divisions: [10, 1, 1], type: 'tet10' });
    const steel = simulationMaterialPresets[0]!;
    const out = await runTransientLevel({
      mesh,
      study: transientStudy('heat'),
      material: { ...steel, id: 'm', name: 'Steel' },
      loads: [],
      constraints: [],
      of: () => [],
      measures: { faceAreas: [], faceVectorAreas: [], edgeLengths: [] },
      areaTolerance: 1e-6,
    });
    if ('failure' in out) throw new Error(out.failure.detail);
    for (const c of out.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    expect(out.metrics['max-temperature']).toBeCloseTo(293.15, 9);
    // Its flux is roundoff only: 0, so finer meshes compare equal (Codex on #1264).
    expect(out.metrics['max-heat-flux']).toBe(0);
  });

  it('passes a Host run whose small change rounds away in the .frd (Codex on #1272)', async () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet10' });
    const steel = simulationMaterialPresets[0]!;
    const base = transientStudy('heat');
    const study = {
      ...base,
      transient: { ...base.transient, endS: 0.1, stepS: 0.1, outputEvery: 1 },
    };
    // A Host that solves on CalculiX's rule and writes 6 significant digits, replayed.
    const remote: TransientRemote = {
      name: 'Test Host',
      residual: 2e-3,
      balance: 1e-4,
      solve: () => Promise.reject(new Error('no stress')),
      solveTransient: async (input) => {
        const solved = solveTransientThermal({ ...input, capacityRule: 'conduction' });
        const rounded = solved.temperatures
          .slice(1)
          .map((T) => Float64Array.from(T, (v) => Number(v.toPrecision(6))));
        return solveTransientThermal({ ...input, replay: rounded });
      },
    };
    const out = await runTransientLevel({
      mesh,
      study,
      material: { ...steel, id: 'm', name: 'Steel' },
      loads: [{ id: 'q', name: 'Heat flux 1', kind: 'heat-flux', targets: [], flux: 0.01 }],
      constraints: [],
      of: () => [0],
      measures: { faceAreas: [100], faceVectorAreas: [], edgeLengths: [] },
      areaTolerance: 1e-6,
      remote,
    });
    if ('failure' in out) throw new Error(out.failure.detail);
    for (const c of out.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
  });
});
