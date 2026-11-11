import { describe, expect, it } from 'vitest';
import { simulationFixture } from './fixtures';
import { convergenceLevelSettings, studyStatus, type RunCheck } from './status';

const hole = () => {
  const load = simulationFixture().doc.loads.find((l) => l.kind !== 'gravity');
  if (load?.kind !== 'force' && load?.kind !== 'pressure')
    throw new Error('fixture has no targeted load');
  return load.targets[0]!;
};
const study = { convergence: { levels: 3, metrics: ['max-von-mises' as const], tolerance: 0.02 } };
const ok: RunCheck[] = (['mapping', 'load', 'quality', 'solver', 'equilibrium'] as const).map(
  (name) => ({ name, pass: true, detail: '' }),
);

describe('study status (R3d-2b)', () => {
  it('refines every size by 1/√2 per level', () => {
    const base = simulationFixture().doc.mesh;
    const mesh = {
      ...base,
      size: 8,
      minSize: 1,
      local: [{ target: base.local[0]?.target ?? hole(), size: 2 }],
    };
    const levels = convergenceLevelSettings(mesh, 3);
    expect(levels.map((l) => l.size)).toEqual([8, 8 * Math.SQRT1_2, 4.000000000000001]);
    expect(levels[2]!.minSize).toBeCloseTo(0.5, 12);
    expect(levels[2]!.local[0]!.size).toBeCloseTo(1, 12);
    expect(levels[0]).toEqual(mesh);
    for (const bad of [0, 1.5, 5, Number.NaN])
      expect(() => convergenceLevelSettings(mesh, bad)).toThrow(RangeError);
  });

  it('is verified when all checks pass and the metrics settle within the tolerance', () => {
    const r = studyStatus({
      study,
      checks: ok,
      levels: [{ 'max-von-mises': 300 }, { 'max-von-mises': 305 }, { 'max-von-mises': 306 }],
    });
    expect(r.status).toBe('verified');
    expect(r.changes['max-von-mises']).toBeCloseTo(1 / 306, 12);
  });

  it('is a reference result when a check fails, a level is missing or a metric still moves', () => {
    const moving = studyStatus({
      study,
      checks: ok,
      levels: [{ 'max-von-mises': 200 }, { 'max-von-mises': 250 }, { 'max-von-mises': 300 }],
    });
    expect(moving.status).toBe('reference');
    expect(moving.reasons[0]).toMatch(/max-von-mises changed 16\.67%/);
    const short = studyStatus({ study, checks: ok, levels: [{ 'max-von-mises': 1 }] });
    expect(short.status).toBe('reference');
    expect(short.reasons).toEqual([
      'convergence: 1 of 3 levels solved',
      'convergence: not confirmed with fewer than 2 levels',
    ]);
    // A one-level study is allowed, but cannot be verified.
    const single = studyStatus({
      study: { convergence: { ...study.convergence, levels: 1 } },
      checks: ok,
      levels: [{ 'max-von-mises': 1 }],
    });
    expect(single).toMatchObject({
      status: 'reference',
      reasons: ['convergence: not confirmed with fewer than 2 levels'],
    });
    // Every check must be there: none, or one left out, is not evidence.
    const settled = [{ 'max-von-mises': 1 }, { 'max-von-mises': 1 }, { 'max-von-mises': 1 }];
    expect(studyStatus({ study, checks: [], levels: settled }).reasons).toEqual(
      ['mapping', 'load', 'quality', 'solver', 'equilibrium'].map((n) => `${n}: not checked`),
    );
    expect(
      studyStatus({ study, checks: ok.filter((c) => c.name !== 'equilibrium'), levels: settled }),
    ).toMatchObject({ status: 'reference', reasons: ['equilibrium: not checked'] });
    const unsolved = studyStatus({
      study,
      checks: ok.map((c) =>
        c.name === 'solver' ? { ...c, pass: false, detail: 'not converged' } : c,
      ),
      levels: [{ 'max-von-mises': 1 }, { 'max-von-mises': 1 }, { 'max-von-mises': 1 }],
    });
    expect(unsolved).toMatchObject({ status: 'reference', reasons: ['solver: not converged'] });
    const unmeasured = studyStatus({ study, checks: ok, levels: [{}, {}, {}] });
    expect(unmeasured.reasons).toEqual([
      'convergence: max-von-mises not measured on the last two levels',
    ]);
  });

  it('fails without a result', () => {
    expect(
      studyStatus({ study, failure: 'mapping: load L1 is ambiguous', checks: [], levels: [] }),
    ).toEqual({
      status: 'failed',
      reasons: ['mapping: load L1 is ambiguous'],
      changes: {},
    });
  });
});
