import { describe, expect, it } from 'vitest';
import {
  aeroHostBaseMm,
  aeroStudy,
  applySimulationOperation,
  simulationFixture,
  studyStatus,
  validateSimulation,
  type SimulationDocument,
  type SimulationRunRecord,
} from './index';

// TS-2210 (ST-607): a wind-tunnel study in the analysis document (VS4a).
const codes = (d: unknown) => validateSimulation(d).map((x) => `${x.code} ${x.path}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests write malformed shapes
type Loose = any;
const withAero = (f: (d: Loose) => void = () => undefined): string[] => {
  const d = structuredClone(simulationFixture().doc) as Loose;
  d.studies.push(aeroStudy('tunnel'));
  f(d);
  return codes(d);
};

describe('wind-tunnel study (VS4a)', () => {
  it('is a study of its own kind with the air, cells and Host mesh, without loads or material', () => {
    expect(withAero()).toEqual([]);
    // No material needed: a document with only a wind tunnel is whole.
    const d = structuredClone(simulationFixture().doc) as Loose;
    d.studies = [aeroStudy('tunnel')];
    d.loads = [];
    d.constraints = [];
    d.materials = [];
    d.materialId = null;
    expect(codes(d)).toEqual([]);
  });

  it('refuses air and meshes out of range, loads, constraints and unknown keys', () => {
    const a = (f: (s: Loose) => void) => withAero((d) => f(d.studies[1]));
    expect(a((s) => (s.aero.speed = 0))).toEqual(['value $.studies[1].aero.speed']);
    expect(a((s) => (s.aero.speed = 71))).toEqual(['value $.studies[1].aero.speed']);
    expect(a((s) => (s.aero.yawDeg = 25))).toEqual(['value $.studies[1].aero.yawDeg']);
    expect(a((s) => (s.aero.ground = 'rolling'))).toEqual(['value $.studies[1].aero.ground']);
    expect(a((s) => (s.aero.browserCellMm = 0))).toEqual(['value $.studies[1].aero.browserCellMm']);
    expect(a((s) => (s.aero.host.level = 7))).toEqual(['value $.studies[1].aero.host.level']);
    expect(a((s) => (s.aero.host.baseMm = 5))).toEqual(['value $.studies[1].aero.host.baseMm']);
    expect(a((s) => (s.aero.host.iterations = 3001))).toEqual([
      'value $.studies[1].aero.host.iterations',
    ]);
    expect(a((s) => (s.aero.referenceAreaMm2 = -1))).toEqual([
      'value $.studies[1].aero.referenceAreaMm2',
    ]);
    expect(a((s) => (s.aero.dict = '#include'))).toEqual(['unknown-key $.studies[1].aero.dict']);
    expect(a((s) => (s.loadIds = ['tip-load']))).toEqual(['value $.studies[1].loadIds']);
    expect(a((s) => (s.constraintIds = ['fix-left']))).toEqual([
      'value $.studies[1].constraintIds',
    ]);
    expect(a((s) => (s.convergence.metrics = ['max-displacement']))).toEqual([
      'value $.studies[1].convergence.metrics[0]',
    ]);
    expect(a((s) => delete s.aero)).toEqual(['missing-key $.studies[1].aero']);
  });

  it('records a run as reference only, with its own checks and coefficients', () => {
    let doc = structuredClone(simulationFixture().doc) as SimulationDocument;
    doc = applySimulationOperation(doc, { type: 'addStudy', study: aeroStudy('tunnel') });
    const run: SimulationRunRecord = {
      id: 'run-tunnel',
      studyId: 'tunnel',
      inputs: {
        simulationHash: 'sha256-a',
        cadContentHash: 'sha256-b',
        kernelBuild: 'k',
        mesherBuild: 'lbm-voxel',
        solverBuild: 'lbm-d3q27',
      },
      levels: [
        {
          size: 60,
          nodes: 120_000,
          elements: 16_000,
          metrics: {
            'drag-coefficient': 1.19,
            'lift-coefficient': 0.1,
            'side-force-coefficient': 0,
          },
        },
      ],
      checks: [
        { name: 'surface', pass: true, detail: 'closed, 16 000 triangles' },
        { name: 'solver', pass: true, detail: 'stable' },
      ],
      status: 'reference',
      reasons: ['aero: wind-tunnel results are for reference'],
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
    expect(bad((r) => (r.levels[0].metrics = { 'max-displacement': 1 }))).not.toEqual([]);
    // The state of a run: reference, whatever its checks and levels.
    const s = studyStatus({
      study: aeroStudy('tunnel'),
      checks: run.checks,
      levels: [run.levels[0]!.metrics, run.levels[0]!.metrics],
    });
    expect(s.status).toBe('reference');
    expect(s.reasons).toContain('aero: wind-tunnel results are for reference');
  });
});

// Codex on #1185: a new wind tunnel's Host mesh is the Ahmed-checked one scaled to the bodies.
describe('the Host mesh of a new wind tunnel', () => {
  it('scales the checked background cell to the bodies', () => {
    expect(aeroStudy('t').aero.host.baseMm).toBe(160);
    expect(aeroHostBaseMm(1044)).toBe(160);
    expect(aeroStudy('t', 'Wind tunnel', 3970).aero.host.baseMm).toBe(610);
    expect(aeroHostBaseMm(1)).toBe(10);
    expect(aeroHostBaseMm(1e6)).toBe(2000);
  });
});
