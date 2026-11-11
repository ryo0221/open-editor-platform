import { describe, expect, it } from 'vitest';
import { faceRef } from '@editor-platform/cad-core';
import {
  applySimulationOperation,
  simulationFixture,
  validateSimulation,
  type SimulationDocument,
  type SimulationOperation,
  type SimulationTarget,
} from '@editor-platform/simulation-core';
import { addConditionOps } from './conditions';
import type { StudyRun } from './run';
import { bendingTestOps, stiffnessTestResult, torsionTestOps } from './stiffness-test';

/** TS-1567 (ST-270#3): the tests' studies; TS-1568 (ST-270#4) their summaries. */
const apply = (doc: SimulationDocument, ops: SimulationOperation[]) =>
  ops.reduce((d, op) => applySimulationOperation(d, op), doc);

function plate() {
  const { doc } = simulationFixture();
  const featureId = doc.constraints[0]!.targets[0]!.ref.featureId;
  const face = (name: string): SimulationTarget[] => [
    { kind: 'face', ref: faceRef(featureId, [name], [0, 0, 0], 1) },
  ];
  return {
    doc,
    mounts: {
      frontLeft: face('side:+u'),
      frontRight: face('side:-u'),
      rear: [...face('side:+v'), ...face('side:-v')],
    },
    loaded: face('end'),
  };
}

describe('stiffness test templates (CR5c)', () => {
  it('makes a torsion study of its own three constraints', () => {
    const { doc, mounts } = plate();
    const next = apply(doc, torsionTestOps(doc, mounts, 0.5));
    expect(validateSimulation(next)).toEqual([]);
    const study = next.studies.at(-1)!;
    expect(study).toMatchObject({ kind: 'linear-static', name: 'Torsion test 1', loadIds: [] });
    const made = next.constraints.slice(doc.constraints.length);
    expect(made.map((c) => c.kind)).toEqual(['fixed', 'displacement', 'displacement']);
    expect(study.constraintIds).toEqual(made.map((c) => c.id));
    expect(made[0]!.targets).toEqual(mounts.rear);
    expect(made[1]).toMatchObject({ targets: mounts.frontLeft, displacement: [null, null, 0.5] });
    expect(made[2]).toMatchObject({ targets: mounts.frontRight, displacement: [null, null, -0.5] });
    expect(study.kind === 'linear-static' && study.test).toEqual({
      kind: 'torsion',
      left: made[1]!.id,
      right: made[2]!.id,
    });
    // The existing study does not take the test's items, nor the test the next ones.
    expect(next.studies[0]!.constraintIds).toEqual(doc.studies[0]!.constraintIds);
    const more = apply(next, addConditionOps(next, 'fixed', mounts.rear));
    expect(more.studies.at(-1)!.constraintIds).toEqual(study.constraintIds);
    expect(more.studies[0]!.constraintIds).toHaveLength(doc.studies[0]!.constraintIds.length + 1);
    // Without an ordinary static study, new conditions make one of their own, not the test's
    // (Codex on #982).
    const bare: SimulationDocument = { ...doc, loads: [], constraints: [], studies: [] };
    const alone = apply(bare, torsionTestOps(bare, mounts));
    const fixed = apply(alone, addConditionOps(alone, 'fixed', mounts.rear));
    const pushed = apply(fixed, addConditionOps(fixed, 'force', mounts.frontLeft));
    const ordinary = pushed.studies.at(-1)!;
    expect(pushed.studies).toHaveLength(2);
    expect(ordinary).toMatchObject({
      name: 'Static',
      loadIds: [pushed.loads.at(-1)!.id],
      constraintIds: [fixed.constraints.at(-1)!.id],
    });
    expect(ordinary).not.toHaveProperty('test');
    // A second test is numbered on; a bad displacement is refused.
    expect(apply(next, torsionTestOps(next, mounts)).studies.at(-1)!.name).toBe('Torsion test 2');
    expect(() => torsionTestOps(doc, mounts, 0)).toThrow(RangeError);
  });

  it('makes a bending study held at the rear, propped at the front and pushed on the seats', () => {
    const { doc, mounts, loaded } = plate();
    const next = apply(doc, bendingTestOps(doc, { ...mounts, loaded }, 2000, 1));
    expect(validateSimulation(next)).toEqual([]);
    const study = next.studies.at(-1)!;
    const [held, front] = next.constraints.slice(doc.constraints.length);
    const load = next.loads.at(-1)!;
    expect(held).toMatchObject({ kind: 'fixed', targets: mounts.rear });
    expect(front).toMatchObject({
      kind: 'displacement',
      targets: [...mounts.frontLeft, ...mounts.frontRight],
      displacement: [null, 0, null],
    });
    expect(load).toMatchObject({ kind: 'force', targets: loaded, force: [0, -2000, 0] });
    expect(study).toMatchObject({
      name: 'Bending test 1',
      loadIds: [load.id],
      constraintIds: [held!.id, front!.id],
      test: { kind: 'bending', load: load.id },
    });
  });

  it('refuses a test of other items, and drops it with its items', () => {
    const { doc, mounts, loaded } = plate();
    const torsion = apply(doc, torsionTestOps(doc, mounts));
    const t = torsion.studies.at(-1)!;
    if (t.kind !== 'linear-static' || t.test?.kind !== 'torsion') throw new Error('no test');
    const codes = (study: unknown) =>
      validateSimulation({ ...torsion, studies: [...torsion.studies.slice(0, -1), study] }).map(
        (d) => `${d.code} ${d.path}`,
      );
    const at = `$.studies[${torsion.studies.length - 1}].test`;
    expect(codes({ ...t, test: { ...t.test, right: t.test.left } })).toEqual([
      `stiffness-test ${at}.right`,
    ]);
    // The held one is fixed, not a displacement; one the study does not take.
    expect(codes({ ...t, test: { ...t.test, left: t.constraintIds[0] } })).toEqual([
      `stiffness-test ${at}.left`,
    ]);
    expect(codes({ ...t, test: { ...t.test, left: doc.constraints[0]!.id } })).toEqual([
      `stiffness-test ${at}.left`,
    ]);
    expect(codes({ ...t, test: { kind: 'bending', load: 'x', left: 'y' } })).toEqual([
      `unknown-key ${at}.left`,
    ]);
    expect(codes({ ...t, test: { kind: 'shear' } })).toEqual([`stiffness-test ${at}`]);
    expect(
      validateSimulation({
        ...doc,
        studies: [{ ...doc.studies[0]!, kind: 'modal', modes: 6, loadIds: [], test: t.test }],
      }).map((d) => d.code),
    ).toContain('unknown-key');
    // Removing a driven constraint leaves an ordinary study.
    const left = applySimulationOperation(torsion, { type: 'removeConstraint', id: t.test.left });
    expect(validateSimulation(left)).toEqual([]);
    expect(left.studies.at(-1)).not.toHaveProperty('test');
    const bending = apply(doc, bendingTestOps(doc, { ...mounts, loaded }));
    const b = bending.studies.at(-1)!;
    const unloaded = applySimulationOperation(bending, { type: 'removeLoad', id: b.loadIds[0]! });
    expect(unloaded.studies.at(-1)).not.toHaveProperty('test');
  });
});

describe('stiffness test results (CR5c)', () => {
  /**
   * A shell run of two strips side by side: shape face 0 at y = 25 (the front left mount), 1 at
   * y = −25 (front right), each two triangles on 4 nodes at z 0…10, x ±5.
   */
  function run(doc: SimulationDocument, owners: [string, string], reaction: number) {
    const nodes: number[] = [];
    for (const y of [25, -25])
      for (const [x, z] of [
        [-5, 0],
        [5, 0],
        [5, 10],
        [-5, 10],
      ])
        nodes.push(x!, y, z!);
    const displacement = new Float64Array(8 * 6);
    const r = new Float64Array(8 * 6);
    for (let n = 0; n < 8; n++) {
      displacement[6 * n] = n < 4 ? 0.5 : -0.5;
      r[6 * n] = n < 4 ? -reaction : reaction;
    }
    return {
      studyId: doc.studies.at(-1)!.id,
      status: { status: 'reference', reasons: [], changes: {} },
      levels: [],
      mapping: owners.map((owner, tag) => ({
        path: `$.constraints[${tag}].targets[0]`,
        owner,
        kind: 'face',
        status: 'resolved',
        stage: 'mesh',
        analysis: [tag],
      })),
      fields: {
        kind: 'shell-static',
        mesh: {
          nodes: new Float64Array(nodes),
          triangles: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
          thickness: new Float64Array(4).fill(1),
          faces: new Int32Array([0, 0, 1, 1]),
          shapeFaces: 2,
          shapeEdges: 0,
          edges: { offsets: new Uint32Array([0]), nodes: new Uint32Array() },
        },
        displacement,
        stress: undefined,
        vonMises: undefined,
        reaction: r,
      },
      builds: { kernel: 'k', mesher: 'm', solver: 's' },
    } as unknown as StudyRun;
  }

  it('gives the torsion moment, twist and N·m/deg from the driven mounts', () => {
    const { doc, mounts } = plate();
    const next = apply(doc, torsionTestOps(doc, mounts, 0.5, 0));
    const t = next.studies.at(-1)!;
    if (t.kind !== 'linear-static' || t.test?.kind !== 'torsion') throw new Error('no test');
    // 1 N on each of 8 nodes, 25 mm off the axis: 200 N·mm about z; a twist of atan(1 / 50).
    const result = stiffnessTestResult(next, run(next, [t.test.left, t.test.right], 1));
    const angle = (Math.atan2(1, 50) * 180) / Math.PI;
    if (result?.kind !== 'torsion') throw new Error('no torsion');
    expect(result.trackMm).toBeCloseTo(50, 12);
    expect(result.momentNm).toBeCloseTo(0.2, 12);
    expect(result.angleDeg).toBeCloseTo(angle, 12);
    expect(result.stiffness).toBeCloseTo(0.2 / angle, 12);
    // Not a test; a mount holding no node.
    expect(
      stiffnessTestResult(doc, { ...run(next, ['a', 'b'], 1), studyId: doc.studies[0]!.id }),
    ).toBeUndefined();
    expect(stiffnessTestResult(next, run(next, [t.test.left, 'other'], 1))).toMatchObject({
      kind: 'refused',
    });
  });

  it('gives the bending force over the loaded faces’ mean deflection', () => {
    const { doc, mounts, loaded } = plate();
    const next = apply(doc, bendingTestOps(doc, { ...mounts, loaded }, 100, 0));
    const b = next.studies.at(-1)!;
    // Both strips loaded: four nodes moved −0.5 x (along the force), four +0.5: mean 0.
    const both = run(next, [b.loadIds[0]!, b.loadIds[0]!], 0);
    expect(stiffnessTestResult(next, both)).toMatchObject({ kind: 'refused' });
    const one = run(next, [b.loadIds[0]!, 'none'], 0);
    // Only the right strip (−0.5 along x, the force's way) is the load's.
    one.mapping = [{ ...one.mapping[0]!, analysis: [1] }];
    expect(stiffnessTestResult(next, one)).toEqual({
      kind: 'bending',
      forceN: 100,
      deflectionMm: 0.5,
      stiffness: 200,
    });
    // The mean is over the area (Codex on #982): node 4 is a corner of both triangles (4 5 6 and
    // 4 6 7), so it carries two thirds of one triangle's area of the strip's two; moved alone by
    // 0.6, the strip's mean is 0.6 / 3 = 0.2 (a node average would give 0.15).
    const fields = one.fields as { displacement: Float64Array };
    fields.displacement.fill(0);
    fields.displacement[6 * 4] = -0.6;
    const r = stiffnessTestResult(next, one);
    if (r?.kind !== 'bending') throw new Error('no bending');
    expect(r.deflectionMm).toBeCloseTo(0.2, 12);
  });

  it('measures a test’s stiffness as a metric of each level, and records it', () => {
    const { doc, mounts } = plate();
    const next = apply(doc, torsionTestOps(doc, mounts));
    const t = next.studies.at(-1)!;
    expect(t.convergence.metrics).toEqual(['stiffness']);
    // Only a test measures it.
    const plain = {
      ...doc.studies[0]!,
      convergence: { ...doc.studies[0]!.convergence, metrics: ['stiffness'] },
    };
    expect(validateSimulation({ ...doc, studies: [plain] }).map((d) => d.path)).toEqual([
      '$.studies[0].convergence.metrics[0]',
    ]);
    const level = (metrics: Record<string, number>) => ({
      size: 5,
      nodes: 10,
      elements: 4,
      metrics,
    });
    const base = { 'max-displacement': 1, 'max-von-mises': 2, 'reaction-force': 0 };
    const record = (studyId: string, metrics: Record<string, number>) => ({
      id: 'run-1',
      studyId,
      inputs: {
        simulationHash: 'h',
        cadContentHash: 'c',
        kernelBuild: 'k',
        mesherBuild: 'm',
        solverBuild: 's',
      },
      levels: [level(metrics)],
      checks: [],
      status: 'reference',
      reasons: ['convergence: not confirmed with fewer than 2 levels'],
    });
    expect(
      validateSimulation({ ...next, runs: [record(t.id, { ...base, stiffness: 3 })] }),
    ).toEqual([]);
    // Removing a driven constraint leaves the record without its stiffness (Codex on #982).
    const recorded = { ...next, runs: [record(t.id, { ...base, stiffness: 3 })] };
    if (t.kind !== 'linear-static' || t.test?.kind !== 'torsion') throw new Error('no test');
    const untested = applySimulationOperation(recorded as SimulationDocument, {
      type: 'removeConstraint',
      id: t.test.right,
    });
    expect(untested.runs![0]!.levels[0]!.metrics).toEqual(base);
    expect(untested.studies.at(-1)!.convergence.metrics).toEqual(['max-displacement']);
    expect(
      validateSimulation({
        ...next,
        runs: [record(doc.studies[0]!.id, { ...base, stiffness: 3 })],
      }).map((d) => d.code),
    ).toEqual(['unknown-key']);
  });
});
