import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  simulationFixture,
  validateSimulation,
  type SimulationStaticStudy,
} from '@editor-platform/simulation-core';
import { defaultFatigue, formatHistory, parseHistory, sampleRoadHistory } from './conditions';
import { fatigueLifeCap, fatigueLogLife } from './results';

describe('the fatigue panel (VS13b, TS-2292, ST-639)', () => {
  it('reads and writes a load history, and makes a valid fatigue setting', () => {
    expect(parseHistory('0, 1, -1\n0.5; -0.5 0')).toEqual([0, 1, -1, 0.5, -0.5, 0]);
    for (const bad of ['', '1', '1, x', '1, 1e7', '1,,Infinity'])
      expect(parseHistory(bad), bad).toBeUndefined();
    expect(parseHistory(formatHistory([1, -2.5, 3]))).toEqual([1, -2.5, 3]);
    const road = sampleRoadHistory();
    expect(road).toHaveLength(2000);
    expect(sampleRoadHistory()).toEqual(road);
    expect(Math.max(...road)).toBeGreaterThan(1.5);
    expect(Math.min(...road)).toBeLessThan(-1.5);
    const { doc } = simulationFixture();
    const study = doc.studies[0] as SimulationStaticStudy;
    const next = applySimulationOperation(doc, {
      type: 'updateStudy',
      study: { ...study, fatigue: defaultFatigue() },
    });
    expect(validateSimulation(next)).toEqual([]);
    // Turned off again, the study is as before.
    const { fatigue: _f, ...off } = next.studies[0] as SimulationStaticStudy;
    expect(
      validateSimulation(applySimulationOperation(next, { type: 'updateStudy', study: off })),
    ).toEqual([]);
  });

  it('shows the life as log₁₀ passes, an endless one at the cap', () => {
    const life = fatigueLogLife(new Float64Array([1e3, Infinity, 1e20, 0]));
    expect(Array.from(life)).toEqual([3, fatigueLifeCap, fatigueLifeCap, -fatigueLifeCap]);
  });
});
