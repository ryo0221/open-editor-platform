import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  f98SealSimulation,
  nagiWaterSimulation,
  sealStudy,
  simulationFixture,
  studyStatus,
  validateSimulation,
  checkSimulationSource,
  type SimulationDocument,
  type SimulationRunRecord,
} from './index';

// TS-2251 (ST-628): seals and the seal study in the analysis document (VS9a).
const codes = (d: unknown) => validateSimulation(d).map((x) => `${x.code} ${x.path}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests write malformed shapes
type Loose = any;
const f98 = () => f98SealSimulation();
const bad = (f: (d: Loose) => void) => {
  const d = structuredClone(f98().doc) as Loose;
  f(d);
  return codes(d);
};

describe('seals and the seal study (VS9a)', () => {
  it('takes F98 and 凪 as whole documents whose targets name their bodies', () => {
    for (const { cad, doc } of [f98(), nagiWaterSimulation()]) {
      expect(codes(doc)).toEqual([]);
      expect(checkSimulationSource(doc, cad)).toEqual([]);
    }
    const nagi = nagiWaterSimulation().doc;
    expect(nagi.seals!.map((s) => s.id)).toEqual([
      'door-l-seal',
      'door-r-seal',
      'hood-seal',
      'lid-seal',
    ]);
    expect(nagi.seals![0]!.line).toHaveLength(8);
  }, 60_000);

  it('refuses seals out of range, on the wrong bodies or kinds, and unknown keys', () => {
    const s = (f: (x: Loose) => void) => bad((d) => f(d.seals[0]));
    expect(s((x) => (x.section.diameterMm = 0))).toEqual(['value $.seals[0].section.diameterMm']);
    expect(s((x) => (x.section.compression = [0.5, 0.3]))).toEqual([
      'value $.seals[0].section.compression',
    ]);
    expect(s((x) => (x.section.compression = [0, 0.3]))).toEqual([
      'value $.seals[0].section.compression',
    ]);
    expect(s((x) => (x.section.compression = [0.3, 1]))).toEqual([
      'value $.seals[0].section.compression',
    ]);
    expect(s((x) => (x.insetMm = -1))).toEqual(['value $.seals[0].insetMm']);
    expect(s((x) => (x.hinge.angleDeg = 91))).toEqual(['value $.seals[0].hinge.angleDeg']);
    expect(s((x) => (x.hinge.axis = [0, 0, 0]))).toEqual(['value $.seals[0].hinge.axis']);
    expect(s((x) => (x.line = []))).toEqual(['targets-empty $.seals[0].line']);
    expect(s((x) => (x.line[0].kind = 'face'))).toContain('target-kind $.seals[0].line[0].kind');
    // The closure on the line's own body, or the line split over two bodies.
    expect(s((x) => delete x.mating[0].body)).toEqual(['seal-bodies $.seals[0].mating']);
    expect(s((x) => (x.base[0].body = 'lid'))).toContain('seal-bodies $.seals[0].base');
    expect(s((x) => (x.colour = 'black'))).toEqual(['unknown-key $.seals[0].colour']);
    expect(bad((d) => (d.seals = []))).toContain('seals-empty $.seals');
    // Schema 1 has no seals.
    expect(bad((d) => (d.schemaVersion = 1))).toContain('unknown-key $.seals');
  });

  it('refuses a seal study without seals, of several levels, with loads or a bad spacing', () => {
    const st = (f: (x: Loose) => void) => bad((d) => f(d.studies[0]));
    expect(st((x) => (x.seal.sealIds = ['nope']))).toEqual([
      'reference-missing $.studies[0].seal.sealIds[0]',
    ]);
    expect(st((x) => (x.seal.stepMm = 0.1))).toEqual(['value $.studies[0].seal.stepMm']);
    expect(st((x) => (x.seal.gapThresholdMm = 11))).toEqual([
      'value $.studies[0].seal.gapThresholdMm',
    ]);
    expect(st((x) => (x.convergence.levels = 2))).toContain(
      'value $.studies[0].convergence.levels',
    );
    expect(st((x) => (x.convergence.metrics = ['max-displacement']))).toEqual([
      'value $.studies[0].convergence.metrics[0]',
    ]);
    const plain = structuredClone(simulationFixture().doc) as Loose;
    plain.studies.push(sealStudy('seals'));
    expect(codes(plain)).toEqual(['seals-empty $.studies[1].seal.sealIds']);
    plain.studies[1].loadIds = ['tip-load'];
    expect(codes(plain)).toContain('value $.studies[1].loadIds');
  });

  it('adds, edits and removes a seal, taking it out of the studies', () => {
    const { doc } = f98();
    const seal = structuredClone(doc.seals![0]!);
    let d: SimulationDocument = applySimulationOperation(
      { ...doc, seals: undefined } as SimulationDocument,
      { type: 'addSeal', seal },
    );
    d = applySimulationOperation(d, {
      type: 'updateStudy',
      study: {
        ...sealStudy('seals'),
        seal: { sealIds: ['lid-seal'], stepMm: 5, gapThresholdMm: 0.5 },
      },
    });
    d = applySimulationOperation(d, {
      type: 'updateSeal',
      seal: { ...seal, section: { ...seal.section, diameterMm: 12 } },
    });
    expect(d.seals![0]!.section.diameterMm).toBe(12);
    expect(() =>
      applySimulationOperation(d, {
        type: 'updateSeal',
        seal: { ...seal, section: { ...seal.section, diameterMm: -1 } },
      }),
    ).toThrow();
    // The last seal goes: the study then has none to measure, so the removal is refused whole.
    expect(() => applySimulationOperation(d, { type: 'removeSeal', id: 'lid-seal' })).toThrow(
      /seals-empty/,
    );
    const two = applySimulationOperation(d, {
      type: 'addSeal',
      seal: { ...seal, id: 'lid-seal-2' },
    });
    const one = applySimulationOperation(two, { type: 'removeSeal', id: 'lid-seal' });
    expect(one.seals!.map((s) => s.id)).toEqual(['lid-seal-2']);
    expect((one.studies[0] as Loose).seal.sealIds).toEqual([]);
    expect(one.retiredIds).toContain('lid-seal');
  });

  it('records a seal run for reference with its checks and metrics', () => {
    const run: SimulationRunRecord = {
      id: 'run-seals',
      studyId: 'seals',
      inputs: {
        simulationHash: 'sha256-a',
        cadContentHash: 'sha256-b',
        kernelBuild: 'k',
        mesherBuild: 'none',
        solverBuild: 'seal-measure',
      },
      levels: [
        {
          size: 5,
          nodes: 250,
          elements: 1,
          metrics: { 'min-compression': 0.375, 'max-compression': 0.375, 'leak-length': 0 },
        },
      ],
      checks: [
        { name: 'mapping', pass: true, detail: '10 targets resolved' },
        { name: 'seal', pass: true, detail: '1 seal measured' },
      ],
      status: 'reference',
      reasons: ['seal: leaks are candidate places, for reference'],
    };
    const d = applySimulationOperation(f98().doc, { type: 'recordRun', run });
    expect(codes(d)).toEqual([]);
    const r = (f: (x: Loose) => void) =>
      bad((x) => {
        x.runs = [structuredClone(run)];
        f(x.runs[0]);
      });
    expect(r((x) => (x.status = 'verified'))).toContain('run $.runs[0].status');
    expect(r((x) => (x.checks[1].name = 'solver'))).toEqual(['run $.runs[0].checks[1].name']);
    const s = studyStatus({
      study: sealStudy('s'),
      checks: run.checks,
      levels: [run.levels[0]!.metrics],
    });
    expect(s.status).toBe('reference');
    expect(s.reasons).toContain('seal: leaks are candidate places, for reference');
  });
});
