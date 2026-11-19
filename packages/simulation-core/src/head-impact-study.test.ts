import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  crashStudy,
  headImpactMetrics,
  headImpactStudy,
  metricsOfStudy,
  simulationFixture,
  validateSimulation,
  type SimulationDocument,
  type SimulationRunRecord,
} from './index';

/**
 * TS-2232 (ST-623, VS8b-2): a head impact in the analysis document: a crash study whose barrier
 * is the pedestrian headform, its settings' checks and its run's metrics.
 */
const codes = (d: unknown) => validateSimulation(d).map((x) => `${x.code} ${x.path}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests write malformed shapes
type Loose = any;
const withHead = (f: (s: Loose) => void = () => undefined): string[] => {
  const d = structuredClone(simulationFixture().doc) as Loose;
  d.studies.push(headImpactStudy('head', [3000, 0, 900], 600));
  f(d.studies.at(-1));
  return codes(d);
};

describe('head impact study (VS8b-2)', () => {
  it('is a crash study with the adult headform at 40 km/h and 65°, still and without gravity', () => {
    const s = headImpactStudy('head', [3000, 0, 900], 600);
    expect(s.crash).toMatchObject({
      barrier: 'head',
      speedKmh: 40,
      pole: null,
      gravity: false,
      endTimeMs: 20,
      intrusions: [],
      head: { headform: 'adult', targetMm: [3000, 0, 900], angleDeg: 65, holdBeyondMm: 600 },
    });
    expect(metricsOfStudy(s)).toEqual(['hic15', 'head-peak-acceleration', 'head-deflection']);
    expect(metricsOfStudy(crashStudy('front', [0, 0, 0]))).toContain('occupant-load-criterion');
    expect(withHead()).toEqual([]);
    // An old crash study without the key is still valid.
    expect(codes({ ...simulationFixture().doc })).toEqual([]);
  });

  it('refuses what a head impact does not take, and a headform on another test', () => {
    expect(withHead((s) => (s.crash.gravity = true))).toEqual(['value $.studies[1].crash.gravity']);
    expect(withHead((s) => (s.crash.pole = { diameterMm: 254 }))).toEqual([
      'value $.studies[1].crash.pole',
    ]);
    expect(
      withHead(
        (s) => (s.crash.intrusions = [{ name: 'hood', point: [0, 0, 0], reference: [0, 0, 1] }]),
      ),
    ).toEqual(['value $.studies[1].crash.intrusions']);
    expect(withHead((s) => (s.crash.head = null))).toEqual(['value $.studies[1].crash.head']);
    expect(withHead((s) => (s.crash.head.headform = 'dummy'))).toEqual([
      'value $.studies[1].crash.head.headform',
    ]);
    expect(withHead((s) => (s.crash.head.angleDeg = 0))).toEqual([
      'value $.studies[1].crash.head.angleDeg',
    ]);
    expect(withHead((s) => (s.crash.head.holdBeyondMm = -1))).toEqual([
      'value $.studies[1].crash.head.holdBeyondMm',
    ]);
    expect(withHead((s) => (s.crash.head.holdBeyondMm = null))).toEqual([]);
    expect(withHead((s) => (s.crash.head.targetMm = [0, 0]))).toEqual([
      'value $.studies[1].crash.head.targetMm',
    ]);
    expect(withHead((s) => (s.crash.head.skin = 1))).toEqual([
      'unknown-key $.studies[1].crash.head.skin',
    ]);
    expect(withHead((s) => (s.convergence.metrics = ['occupant-load-criterion']))).toEqual([
      'value $.studies[1].convergence.metrics[0]',
    ]);
    // A wall test with a headform.
    expect(
      withHead((s) => {
        s.crash.barrier = 'wall';
        s.convergence.metrics = ['peak-deceleration'];
      }),
    ).toEqual(['value $.studies[1].crash.head']);
  });

  it('records a run with the headform’s metrics, not a wall test’s', () => {
    let doc = structuredClone(simulationFixture().doc) as SimulationDocument;
    doc = applySimulationOperation(doc, {
      type: 'addStudy',
      study: headImpactStudy('head', [3000, 0, 900], 600),
    });
    const run: SimulationRunRecord = {
      id: 'run-head',
      studyId: 'head',
      inputs: {
        simulationHash: 'sha256-a',
        cadContentHash: 'sha256-b',
        kernelBuild: 'k',
        mesherBuild: 'shell-midsurface',
        solverBuild: 'explicit-bt',
      },
      levels: [
        {
          size: 10,
          nodes: 3_000,
          elements: 2_800,
          metrics: { hic15: 1200, 'head-peak-acceleration': 180, 'head-deflection': 60 },
        },
      ],
      checks: [{ name: 'energy-balance', pass: true, detail: '0.4 %' }],
      status: 'reference',
      reasons: ['crash: crash-test results are for reference'],
    };
    doc = applySimulationOperation(doc, { type: 'recordRun', run });
    expect(codes(doc)).toEqual([]);
    const d = structuredClone(doc) as Loose;
    d.runs[0].levels[0].metrics = {
      'peak-deceleration': 38,
      'occupant-load-criterion': 31,
      crush: 520,
      'max-intrusion': 42,
    };
    expect(codes(d)).toContain('missing-key $.runs[0].levels[0].metrics.hic15');
    // Made a wall test, the head impact's run goes (it measured other metrics); a change that
    // keeps the metrics keeps the run.
    const study = doc.studies.find((s) => s.id === 'head')!;
    if (study.kind !== 'crash') throw new Error('not a crash study');
    const faster = applySimulationOperation(doc, {
      type: 'updateStudy',
      study: { ...study, crash: { ...study.crash, speedKmh: 35 } },
    });
    expect(faster.runs?.length).toBe(1);
    const { head: _head, ...crash } = study.crash;
    const wall = applySimulationOperation(doc, {
      type: 'updateStudy',
      study: {
        ...study,
        crash: { ...crash, barrier: 'wall' },
        convergence: { ...study.convergence, metrics: ['peak-deceleration'] },
      },
    });
    expect(wall.runs).toBeUndefined();
    expect(codes(wall)).toEqual([]);
    expect(headImpactMetrics.length).toBe(3);
  });
});
