import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  crashStudy,
  simulationFixture,
  studyStatus,
  validateSimulation,
  type SimulationDocument,
  type SimulationRunRecord,
} from './index';

// TS-2222 (ST-618): a crash study and a material's plasticity in the analysis document (VS7b).
const codes = (d: unknown) => validateSimulation(d).map((x) => `${x.code} ${x.path}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests write malformed shapes
type Loose = any;
const withCrash = (f: (d: Loose) => void = () => undefined): string[] => {
  const d = structuredClone(simulationFixture().doc) as Loose;
  d.studies.push(crashStudy('front', [1500, 400, 300]));
  d.studies.push(crashStudy('pole', [1500, 400, 300], { side: 'right', xMm: 1800, zMm: 900 }));
  f(d);
  return codes(d);
};

describe('crash study (VS7b)', () => {
  it('is a study of its own kind: a wall at 56 km/h or a 254 mm pole at 32 km/h and 75°', () => {
    expect(withCrash()).toEqual([]);
    const wall = crashStudy('front', [0, 0, 0]);
    expect(wall.crash).toMatchObject({ barrier: 'wall', speedKmh: 56, pole: null, gravity: true });
    const pole = crashStudy('pole', [0, 0, 0], { side: 'right', xMm: 1800, zMm: 900 });
    expect(pole.crash.speedKmh).toBe(32);
    expect(pole.crash.pole).toEqual({
      diameterMm: 254,
      angleDeg: 75,
      side: 'right',
      xMm: 1800,
      zMm: 900,
    });
  });

  it('refuses barriers, speeds and points out of range, loads, constraints and unknown keys', () => {
    const a = (f: (s: Loose) => void, k = 1) => withCrash((d) => f(d.studies[k]));
    expect(a((s) => (s.crash.speedKmh = 0))).toEqual(['value $.studies[1].crash.speedKmh']);
    expect(a((s) => (s.crash.speedKmh = 121))).toEqual(['value $.studies[1].crash.speedKmh']);
    expect(a((s) => (s.crash.barrier = 'offset'))).toEqual(['value $.studies[1].crash.barrier']);
    expect(a((s) => (s.crash.pole = { diameterMm: 254 }))).toEqual([
      'value $.studies[1].crash.pole',
    ]);
    expect(a((s) => (s.crash.pole.angleDeg = 0), 2)).toEqual([
      'value $.studies[2].crash.pole.angleDeg',
    ]);
    expect(a((s) => (s.crash.pole.side = 'front'), 2)).toEqual([
      'value $.studies[2].crash.pole.side',
    ]);
    expect(a((s) => (s.crash.pole = null), 2)).toEqual(['value $.studies[2].crash.pole']);
    expect(a((s) => (s.crash.endTimeMs = 301))).toEqual(['value $.studies[1].crash.endTimeMs']);
    expect(a((s) => (s.crash.friction = -0.1))).toEqual(['value $.studies[1].crash.friction']);
    expect(a((s) => (s.crash.gravity = 1))).toEqual(['value $.studies[1].crash.gravity']);
    expect(a((s) => (s.crash.accelerometer = [0, 0]))).toEqual([
      'value $.studies[1].crash.accelerometer',
    ]);
    expect(
      a((s) => (s.crash.intrusions = [{ name: 'toe pan', point: [0, 0, 0], reference: [1, 2] }])),
    ).toEqual(['value $.studies[1].crash.intrusions[0].reference']);
    expect(
      a(
        (s) => (s.crash.intrusions = [{ name: 'toe pan', point: [0, 0, 0], reference: [0, 0, 1] }]),
      ),
    ).toEqual([]);
    expect(a((s) => (s.crash.deck = 1))).toEqual(['unknown-key $.studies[1].crash.deck']);
    expect(a((s) => (s.loadIds = ['tip-load']))).toEqual(['value $.studies[1].loadIds']);
    expect(a((s) => (s.constraintIds = ['fix-left']))).toEqual([
      'value $.studies[1].constraintIds',
    ]);
    expect(a((s) => (s.convergence.metrics = ['drag-coefficient']))).toEqual([
      'value $.studies[1].convergence.metrics[0]',
    ]);
    expect(a((s) => delete s.crash)).toEqual(['missing-key $.studies[1].crash']);
  });

  it('takes a material’s plasticity: the flow stress from strain 0, both rising', () => {
    const m = (plasticity: unknown) => withCrash((d) => (d.materials[0].plasticity = plasticity));
    const mild = {
      strain: [0, 0.1, 0.3],
      stress: [250, 330, 400],
      cowperSymonds: { C: 40.4, p: 5 },
      failureStrain: 0.5,
    };
    expect(m(mild)).toEqual([]);
    expect(m({ ...mild, strain: [0.01, 0.1, 0.3] })).toEqual([
      'value $.materials[0].plasticity.strain',
    ]);
    expect(m({ ...mild, strain: [0, 0.3, 0.1] })).toEqual([
      'value $.materials[0].plasticity.strain',
    ]);
    expect(m({ ...mild, stress: [250, 200, 400] })).toEqual([
      'value $.materials[0].plasticity.stress',
    ]);
    expect(m({ ...mild, stress: [250, 330] })).toEqual(['value $.materials[0].plasticity.stress']);
    expect(m({ ...mild, cowperSymonds: { C: 0, p: 5 } })).toEqual([
      'value $.materials[0].plasticity.cowperSymonds',
    ]);
    expect(m({ ...mild, failureStrain: 0 })).toEqual([
      'value $.materials[0].plasticity.failureStrain',
    ]);
    expect(m({ ...mild, damage: 1 })).toEqual(['unknown-key $.materials[0].plasticity.damage']);
  });

  it('records a run as reference only, with the explicit checks and crash measures', () => {
    let doc = structuredClone(simulationFixture().doc) as SimulationDocument;
    doc = applySimulationOperation(doc, {
      type: 'addStudy',
      study: crashStudy('front', [1500, 400, 300]),
    });
    const run: SimulationRunRecord = {
      id: 'run-front',
      studyId: 'front',
      inputs: {
        simulationHash: 'sha256-a',
        cadContentHash: 'sha256-b',
        kernelBuild: 'k',
        mesherBuild: 'shell-midsurface',
        solverBuild: 'explicit-bt',
      },
      levels: [
        {
          size: 20,
          nodes: 30_000,
          elements: 28_000,
          metrics: {
            'peak-deceleration': 38,
            'occupant-load-criterion': 31,
            crush: 520,
            'max-intrusion': 42,
          },
        },
      ],
      checks: [
        { name: 'mapping', pass: true, detail: '12 bodies' },
        { name: 'quality', pass: true, detail: 'min angle 21°' },
        { name: 'energy-balance', pass: true, detail: '0.4 %' },
        { name: 'hourglass-energy', pass: true, detail: '6 %' },
        { name: 'mass-scaling', pass: true, detail: '1.2 %' },
      ],
      status: 'reference',
      reasons: ['crash: crash-test results are for reference'],
    };
    doc = applySimulationOperation(doc, { type: 'recordRun', run });
    expect(codes(doc)).toEqual([]);
    const bad = (f: (r: Loose) => void) => {
      const d = structuredClone(doc) as Loose;
      f(d.runs[0]);
      return codes(d);
    };
    expect(
      bad((r) => {
        r.status = 'verified';
        r.reasons = [];
        r.levels.push(structuredClone(r.levels[0]));
      }),
    ).toContain('run $.runs[0].status');
    expect(bad((r) => (r.checks[0].name = 'equilibrium'))).toEqual([
      'run $.runs[0].checks[0].name',
    ]);
    expect(bad((r) => (r.levels[0].metrics = { 'drag-coefficient': 1 }))).not.toEqual([]);
    const s = studyStatus({
      study: crashStudy('front', [0, 0, 0]),
      checks: run.checks,
      levels: [run.levels[0]!.metrics, run.levels[0]!.metrics],
    });
    expect(s.status).toBe('reference');
    expect(s.reasons).toContain('crash: crash-test results are for reference');
  });
});
