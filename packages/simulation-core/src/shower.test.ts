import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  f98SealSimulation,
  showerStudy,
  studyStatus,
  validateSimulation,
  type SimulationDocument,
  type SimulationRunRecord,
} from './index';

// TS-2257 (ST-632): the shower study in the analysis document (VS10b).
const codes = (d: unknown) => validateSimulation(d).map((x) => `${x.code} ${x.path}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests write malformed shapes
type Loose = any;
const withShower = (): SimulationDocument => {
  const { doc } = f98SealSimulation();
  doc.studies.push(showerStudy('shower'));
  return doc;
};
const bad = (f: (s: Loose) => void) => {
  const d = structuredClone(withShower()) as Loose;
  f(d.studies[1].shower);
  return codes(d);
};
const nozzle = {
  id: 'front',
  name: 'Front slot',
  origin: [0, -121, 400],
  direction: [0, 0, -1],
  coneDeg: 0,
  speedMmPerS: 3000,
  flowLPerMin: 0.1,
};

describe('the shower study (VS10b)', () => {
  it('takes a shower with rain or nozzles beside the seal study', () => {
    expect(codes(withShower())).toEqual([]);
    const d = withShower() as Loose;
    d.studies[1].shower.rain = null;
    d.studies[1].shower.nozzles = [nozzle];
    expect(codes(d)).toEqual([]);
  });

  it('refuses settings out of range, no water, bad nozzles and unknown keys', () => {
    expect(bad((s) => (s.rain = null))).toEqual(['value $.studies[1].shower.nozzles']);
    expect(bad((s) => (s.rain.rateMmPerH = 0))).toEqual([
      'value $.studies[1].shower.rain.rateMmPerH',
    ]);
    expect(bad((s) => (s.rain.angleDeg = 81))).toEqual(['value $.studies[1].shower.rain.angleDeg']);
    expect(bad((s) => (s.slopeDeg = [31, 0]))).toEqual(['value $.studies[1].shower.slopeDeg']);
    expect(bad((s) => (s.particlesPerS = 50_001))).toEqual([
      'value $.studies[1].shower.particlesPerS',
    ]);
    expect(bad((s) => (s.stepS = 0.0001))).toEqual(['value $.studies[1].shower.stepS']);
    expect(bad((s) => (s.emitUntilS = 5))).toEqual(['value $.studies[1].shower.emitUntilS']);
    expect(bad((s) => (s.seed = -1))).toEqual(['value $.studies[1].shower.seed']);
    expect(bad((s) => (s.nozzles = [{ ...nozzle, direction: [0, 0, 0] }]))).toEqual([
      'value $.studies[1].shower.nozzles[0].direction',
    ]);
    expect(bad((s) => (s.nozzles = [nozzle, nozzle]))).toEqual([
      'duplicate-id $.studies[1].shower.nozzles[1].id',
    ]);
    expect(bad((s) => (s.wind = 1))).toContain('unknown-key $.studies[1].shower.wind');
    // Its seals are checked as a seal study's.
    const d = withShower() as Loose;
    d.studies[1].seal.sealIds = ['nope'];
    expect(codes(d)).toEqual(['reference-missing $.studies[1].seal.sealIds[0]']);
  });

  it('drops a removed seal from the shower, and records its run for reference only', () => {
    let d = withShower() as Loose;
    d.seals.push({ ...d.seals[0], id: 'lid-seal-2', name: 'Lid 2' });
    d.studies[1].seal.sealIds = ['lid-seal', 'lid-seal-2'];
    d = applySimulationOperation(d, { type: 'removeSeal', id: 'lid-seal-2' });
    expect(d.studies[1].seal.sealIds).toEqual(['lid-seal']);
    const study = withShower().studies[1]!;
    const status = studyStatus({
      study,
      checks: [
        { name: 'mapping', pass: true, detail: '' },
        { name: 'seal', pass: true, detail: '' },
        { name: 'shower', pass: true, detail: '' },
      ],
      levels: [{ 'entered-volume': 0 }],
    });
    expect(status.status).toBe('reference');
    expect(status.reasons).toContain('shower: water paths are candidate places, for reference');
    const run: SimulationRunRecord = {
      id: 'run-1',
      studyId: 'shower',
      inputs: {} as Loose,
      levels: [],
      checks: [],
      status: 'verified',
      reasons: [],
    } as Loose;
    const r = withShower() as Loose;
    r.runs = [run];
    expect(codes(r)).toContain('run $.runs[0].status');
  });
});
