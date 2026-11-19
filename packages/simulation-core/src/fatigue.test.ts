import { describe, expect, it } from 'vitest';
import { simulationFixture, validateSimulation, type SimulationStaticStudy } from './index';

describe('a static study’s fatigue (VS13a, TS-2290, ST-639)', () => {
  const withFatigue = () => {
    const { doc } = simulationFixture();
    const study = doc.studies[0] as SimulationStaticStudy;
    study.fatigue = {
      history: [0, 1, -1, 0.5, -0.5, 0],
      sn: { amplitude: 250, cycles: 1e6, slope: 10, endurance: 125, ultimate: 510 },
    };
    return { doc, study };
  };
  it('takes a history and an S-N line on a solid static study', () => {
    const { doc } = withFatigue();
    expect(validateSimulation(doc)).toEqual([]);
  });
  it('refuses a short or non-finite history, a bad S-N line and a shell study', () => {
    const codes = (f: (s: SimulationStaticStudy) => void) => {
      const { doc, study } = withFatigue();
      f(study);
      return validateSimulation(doc).map((d) => d.path);
    };
    expect(codes((s) => (s.fatigue!.history = [1]))).toEqual(['$.studies[0].fatigue.history']);
    // A non-finite number is refused by the document's number check.
    expect(codes((s) => (s.fatigue!.history[2] = Number.NaN))).toEqual([
      '$.studies.0.fatigue.history.2',
    ]);
    expect(codes((s) => (s.fatigue!.history[2] = 1e7))).toEqual([
      '$.studies[0].fatigue.history[2]',
    ]);
    expect(codes((s) => (s.fatigue!.sn.slope = 0))).toEqual(['$.studies[0].fatigue.sn.slope']);
    expect(codes((s) => (s.fatigue!.sn.endurance = -1))).toEqual([
      '$.studies[0].fatigue.sn.endurance',
    ]);
    expect(codes((s) => (s.fatigue!.sn.cycles = 0.5))).toEqual(['$.studies[0].fatigue.sn.cycles']);
    expect(
      codes((s) => {
        delete (s.fatigue!.sn as { ultimate?: number }).ultimate;
      }),
    ).toEqual(['$.studies[0].fatigue.sn.ultimate']);
    expect(codes((s) => (s.idealisation = 'shell'))).toContain('$.studies[0].fatigue');
    expect(
      codes((s) => {
        s.fatigue!.history = Array.from({ length: 100_001 }, () => 0);
      }),
    ).toEqual(['$.studies[0].fatigue.history']);
  });

  it('refuses a prescribed displacement under a fatigue history, takes a zero one (Codex on #1283)', () => {
    const { doc, study } = withFatigue();
    const held = doc.constraints[0]!;
    doc.constraints[0] = {
      id: held.id,
      name: held.name,
      kind: 'displacement',
      targets: held.targets,
      displacement: [0, 0, 0.5],
    };
    expect(validateSimulation(doc).map((d) => d.path)).toEqual([
      `$.studies[0].constraintIds[${study.constraintIds.indexOf(held.id)}]`,
    ]);
    doc.constraints[0] = { ...doc.constraints[0], displacement: [0, null, 0] } as never;
    expect(validateSimulation(doc)).toEqual([]);
  });
});
