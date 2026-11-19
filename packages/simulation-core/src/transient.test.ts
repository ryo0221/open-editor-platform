import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  simulationFixture,
  simulationInputHash,
  transientStudy,
  validateSimulation,
  type SimulationDocument,
} from './index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests write malformed shapes
type Loose = any;
const codes = (v: unknown) => validateSimulation(v).map((d) => d.code);

/** The F02 fixture with a transient study: a held end on an amplitude, air and glow on the other. */
const transient = (f: (d: Loose) => void = () => {}) => {
  const { doc } = simulationFixture();
  const d = structuredClone(doc) as Loose;
  const t = d.loads[0].targets;
  d.materials[0].conductivity = 50;
  d.materials[0].specificHeat = 4.6e8;
  d.materials[0].expansion = 1.2e-5;
  d.constraints.push({
    id: 'hot',
    name: 'Hot',
    kind: 'temperature',
    targets: d.constraints[0].targets,
    temperature: 500,
    amplitude: { times: [0, 60], factors: [0.6, 1] },
  });
  d.loads.push(
    {
      id: 'air',
      name: 'Air',
      kind: 'convection',
      targets: t,
      coefficient: 0.02,
      ambient: 293.15,
      amplitude: { times: [0, 100], factors: [1, 0.5] },
    },
    { id: 'glow', name: 'Glow', kind: 'radiation', targets: t, emissivity: 0.8, ambient: 293.15 },
  );
  const s = { ...transientStudy('heat'), loadIds: ['air', 'glow'], constraintIds: ['hot'] };
  d.studies.push(s);
  f(d);
  return codes(d);
};
const study = (d: Loose) => d.studies[1];

describe('transient thermal studies (VS11d, TS-2278, ST-637)', () => {
  it('accepts a transient study with amplitudes, radiation, an enclosure and thermal stress', () => {
    expect(transient()).toEqual([]);
    // Neither held nor convecting: the capacity sets the level.
    expect(transient((d) => (study(d).constraintIds = []))).toEqual([]);
    expect(
      transient((d) => {
        d.loads.push({
          id: 'box',
          name: 'Box',
          kind: 'enclosure',
          targets: d.loads[0].targets,
          emissivity: 0.5,
        });
        study(d).loadIds = ['air', 'box'];
        study(d).transient.enclosure = { ambient: 300, raysPerPatch: 64 };
      }),
    ).toEqual([]);
    expect(
      transient((d) => {
        study(d).transient.stress = { reference: 293.15 };
        study(d).constraintIds.push('fix-left');
        study(d).convergence.metrics = ['max-temperature', 'max-von-mises'];
      }),
    ).toEqual([]);
  });

  it('keeps amplitudes, radiation and enclosures out of the steady studies', () => {
    const steady = (d: Loose) => {
      study(d).kind = 'thermal';
      delete study(d).transient;
    };
    expect(transient((d) => (steady(d), (study(d).loadIds = ['glow'])))).toContain('study-kind');
    expect(transient((d) => (steady(d), (study(d).loadIds = ['air'])))).toContain('study-kind');
    expect(
      transient((d) => {
        steady(d);
        study(d).loadIds = [];
        delete d.loads.at(-2).amplitude;
        study(d).loadIds = ['air'];
      }),
    ).toContain('study-kind'); // the held end still has its amplitude
    // A structural constraint only with thermal stress, and an enclosure only with its setup.
    expect(transient((d) => study(d).constraintIds.push('fix-left'))).toContain('study-kind');
    expect(
      transient((d) => {
        d.loads.push({
          id: 'box',
          name: 'Box',
          kind: 'enclosure',
          targets: d.loads[0].targets,
          emissivity: 0.5,
        });
        study(d).loadIds = ['box'];
      }),
    ).toContain('study-kind');
    // Thermal stress needs something holding the body.
    expect(transient((d) => (study(d).transient.stress = { reference: 293.15 }))).toContain(
      'constraints-empty',
    );
    // The stress is a metric only with thermal stress.
    expect(
      transient((d) => (study(d).convergence.metrics = ['max-temperature', 'max-von-mises'])),
    ).toContain('value');
  });

  it('refuses settings, amplitudes and material values out of range', () => {
    const settings = (k: string, v: unknown) => transient((d) => (study(d).transient[k] = v));
    expect(settings('endS', 0)).toContain('value');
    expect(settings('stepS', 0)).toContain('value');
    expect(settings('stepS', 1e-3)).toContain('value'); // more than 20 000 steps
    expect(settings('theta', 0.4)).toContain('value');
    expect(settings('initialTemperature', -1)).toContain('value');
    expect(settings('outputEvery', 0)).toContain('value');
    expect(
      transient((d) => ((study(d).transient.stepS = 0.1), (study(d).transient.outputEvery = 1))),
    ).toContain('value'); // more than 400 kept fields
    expect(settings('enclosure', { ambient: -1, raysPerPatch: 64 })).toContain('value');
    expect(settings('enclosure', { ambient: 300, raysPerPatch: 2000 })).toContain('value');
    expect(settings('stress', { reference: -1 })).toContain('value');
    expect(transient((d) => delete study(d).transient.stress)).toContain('missing-key');
    const hot = (a: unknown) => transient((d) => (d.constraints[1].amplitude = a));
    expect(hot({ times: [0, 60], factors: [1] })).toContain('value');
    expect(hot({ times: [60, 0], factors: [1, 1] })).toContain('value');
    expect(hot({ times: [0], factors: [-1] })).toContain('value');
    expect(transient((d) => (d.loads.at(-1).emissivity = 0))).toContain('value');
    expect(transient((d) => (d.loads.at(-1).emissivity = 1.1))).toContain('value');
    expect(transient((d) => (d.loads.at(-1).ambient = -1))).toContain('value');
    expect(transient((d) => (d.materials[0].specificHeat = 0))).toContain('value');
    expect(transient((d) => (d.materials[0].expansion = -1))).toContain('value');
  });

  it('keeps a recorded stress run when the thermal stress is turned off (Codex on #1264)', () => {
    const { doc } = simulationFixture();
    const d = structuredClone(doc) as SimulationDocument;
    d.materials[0] = {
      ...d.materials[0]!,
      conductivity: 50,
      specificHeat: 4.6e8,
      expansion: 1.2e-5,
    };
    d.constraints.push({
      id: 'hot',
      name: 'Hot',
      kind: 'temperature',
      targets: d.constraints[0]!.targets,
      temperature: 500,
    });
    const study = transientStudy('heat');
    study.constraintIds = ['hot', d.constraints[0]!.id];
    study.transient.stress = { reference: 293.15 };
    study.convergence.metrics = ['max-temperature', 'max-von-mises'];
    d.studies.push(study);
    expect(validateSimulation(d)).toEqual([]);
    const recorded = applySimulationOperation(d, {
      type: 'recordRun',
      run: {
        id: 'run',
        studyId: 'heat',
        inputs: {
          simulationHash: simulationInputHash(d),
          cadContentHash: d.source.contentHash,
          kernelBuild: 'k',
          mesherBuild: 'm',
          solverBuild: 's',
        },
        levels: [
          {
            size: 10,
            nodes: 100,
            elements: 300,
            metrics: { 'max-temperature': 500, 'max-heat-flux': 1, 'max-von-mises': 400 },
          },
        ],
        checks: [{ name: 'mapping', pass: true, detail: 'ok' }],
        status: 'reference',
        reasons: ['one level only'],
      },
    });
    const off = applySimulationOperation(recorded, {
      type: 'updateStudy',
      study: {
        ...study,
        constraintIds: ['hot'],
        convergence: { ...study.convergence, metrics: ['max-temperature'] },
        transient: { ...study.transient, stress: null },
      },
    });
    expect(off.runs).toHaveLength(1);
    expect(validateSimulation(off)).toEqual([]);
  });
});
