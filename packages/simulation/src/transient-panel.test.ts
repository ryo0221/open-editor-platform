import { describe, expect, it } from 'vitest';
import type { FemMesh } from '@editor-platform/geometry-fem';
import {
  applySimulationOperation,
  simulationFixture,
  validateSimulation,
  type SimulationDocument,
  type SimulationOperation,
} from '@editor-platform/simulation-core';
import {
  addConditionOps,
  amplitudeOps,
  defaultStudy,
  defaultThermalStudy,
  defaultTransientStudy,
  formatAmplitude,
  hasStressSupport,
  parseAmplitude,
  transientSettingsStudy,
  transientStudyReady,
} from './conditions';
import { resultDisplay, runResult, vtuResult, resultVtu } from './results';
import type { TransientRunFields } from './run-transient';

const apply = (doc: SimulationDocument, ops: SimulationOperation[]) =>
  ops.reduce((d, op) => applySimulationOperation(d, op), doc);

function bare() {
  const { doc } = simulationFixture();
  const fixed = doc.constraints[0]!.targets;
  const loaded = (doc.loads[0] as { targets: typeof fixed }).targets;
  const empty: SimulationDocument = {
    ...doc,
    materials: [{ ...doc.materials[0]!, conductivity: 50, specificHeat: 4.6e8 }],
    loads: [],
    constraints: [],
    studies: [],
  };
  return { empty, fixed, loaded };
}

describe('the transient heat panel (VS11d-2, TS-2280, ST-637)', () => {
  it('adds radiation and an enclosure to transient studies only, with their setup', () => {
    const { empty, fixed, loaded } = bare();
    const step = (d: SimulationDocument, kind: Parameters<typeof addConditionOps>[1], t = loaded) =>
      apply(d, addConditionOps(d, kind, t));
    expect(transientStudyReady(empty)).toBe(false);
    const a = step(step(empty, 'temperature', fixed), 'convection');
    expect(transientStudyReady(a)).toBe(true);
    const b = apply(a, [
      { type: 'addStudy', study: defaultThermalStudy(a) },
      { type: 'addStudy', study: defaultTransientStudy(a) },
    ]);
    const c = step(b, 'radiation');
    expect(c.loads.at(-1)).toMatchObject({
      name: 'Radiation to the surroundings 1',
      kind: 'radiation',
      emissivity: 0.8,
      ambient: 293.15,
    });
    // The steady study keeps its two items; the transient one takes the radiation.
    expect(c.studies.map((s) => s.loadIds.length)).toEqual([1, 2]);
    const d = step(c, 'enclosure');
    expect(d.loads.at(-1)).toMatchObject({ kind: 'enclosure', emissivity: 0.8 });
    const transient = d.studies[1]!;
    if (transient.kind !== 'transient-thermal') throw new Error('not transient');
    expect(transient.loadIds).toHaveLength(3);
    expect(transient.transient.enclosure).toEqual({ ambient: 293.15, raysPerPatch: 64 });
    expect(validateSimulation(d)).toEqual([]);
    // A new transient study takes every heat item and the enclosure's setup.
    const e = defaultTransientStudy(d);
    expect(e.loadIds).toHaveLength(3);
    expect(e.kind === 'transient-thermal' && e.transient.enclosure).toBeTruthy();
  });

  it('reads and writes amplitudes, and takes an item with one out of the steady studies', () => {
    expect(parseAmplitude('')).toBeNull();
    expect(parseAmplitude(' 0:0.5, 60:1 ')).toEqual({ times: [0, 60], factors: [0.5, 1] });
    expect(parseAmplitude('0:1; 10:0')).toEqual({ times: [0, 10], factors: [1, 0] });
    for (const bad of ['0', '0:1, 0:2', '10:1, 5:1', '0:-1', 'a:b', '0:1:2'])
      expect(parseAmplitude(bad)).toBeUndefined();
    expect(formatAmplitude({ times: [0, 60], factors: [0.5, 1] })).toBe('0:0.5, 60:1');
    expect(formatAmplitude(undefined)).toBe('');

    const { empty, fixed, loaded } = bare();
    const a = apply(empty, [...addConditionOps(empty, 'temperature', fixed)]);
    const b = apply(a, addConditionOps(a, 'convection', loaded));
    const c = apply(b, [
      { type: 'addStudy', study: defaultThermalStudy(b) },
      { type: 'addStudy', study: defaultTransientStudy(b) },
    ]);
    const hot = c.constraints[0]!;
    const ramp = parseAmplitude('0:0.5, 60:1')!;
    const d = apply(c, amplitudeOps(c, hot, ramp));
    expect(d.constraints[0]).toMatchObject({ amplitude: ramp });
    expect(d.studies.map((s) => s.constraintIds)).toEqual([[], [hot.id]]);
    expect(validateSimulation(d)).toEqual([]);
    // Clearing it leaves the studies as they are.
    const e = apply(d, amplitudeOps(d, d.constraints[0]!, null));
    expect(e.constraints[0]).not.toHaveProperty('amplitude');
    expect(e.studies.map((s) => s.constraintIds)).toEqual([[], [hot.id]]);
    // The new steady study does not take an item with an amplitude.
    expect(defaultThermalStudy(d).constraintIds).toEqual([]);
    // A steady study left unheld by it is removed: the convection's amplitude takes its last hold.
    const f = apply(d, amplitudeOps(d, d.loads[0]!, parseAmplitude('0:1, 100:0.5')!));
    expect(f.studies.map((s) => s.kind)).toEqual(['transient-thermal']);
    expect(validateSimulation(f)).toEqual([]);
  });

  it('shows the kept times on one colour range with the history, and writes them to a VTU', () => {
    const mesh: FemMesh = {
      type: 'tet4',
      nodes: new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
      elements: new Uint32Array([0, 1, 2, 3]),
      shapeFaces: 4,
      shapeEdges: 0,
      boundary: {
        elements: new Uint32Array([0, 0, 0, 0]),
        localFaces: new Uint8Array([0, 1, 2, 3]),
        tags: new Uint32Array([0, 1, 2, 3]),
      },
      edges: { offsets: new Uint32Array([0]), nodes: new Uint32Array(0) },
    };
    const fields: TransientRunFields = {
      kind: 'transient-thermal',
      mesh,
      times: [0, 30, 60],
      temperatures: [
        new Float64Array([300, 300, 300, 300]),
        new Float64Array([300, 320, 310, 350]),
        new Float64Array([300, 340, 330, 400]),
      ],
      history: {
        time: new Float64Array([0, 30, 60]),
        maxTemperature: new Float64Array([300, 350, 400]),
        minTemperature: new Float64Array([300, 300, 300]),
        stored: new Float64Array(3),
        heatIn: new Float64Array(3),
        probes: [],
      },
      fluxMagnitude: new Float64Array([0, 1, 2, 3]),
    };
    const r = runResult(fields);
    expect(r.transient).toEqual({
      times: [0, 30, 60],
      fields: ['temperature-0', 'temperature-1', 'temperature-2'],
      history: {
        time: fields.history.time,
        max: fields.history.maxTemperature,
        min: fields.history.minTemperature,
      },
    });
    const temps = r.scalars.filter((s) => s.id.startsWith('temperature-'));
    expect(temps.map((s) => s.id)).toEqual(['temperature-2', 'temperature-0', 'temperature-1']);
    for (const s of temps) expect(s.range).toEqual([300, 400]);
    // The start (all 300 K) shows at the low end of the shared range, not as a flat middle.
    const start = resultDisplay(r, 'temperature-0', 0, temps[1]!.range!);
    expect(Math.max(...start.values)).toBe(300);
    expect(r.scalars.find((s) => s.id === 'heat-flux')!.range).toBeUndefined();
    const back = vtuResult(resultVtu(fields), 'heat.vtu');
    expect(back.scalars.map((s) => s.label).slice(0, 3)).toEqual([
      'Temperature at 0 s',
      'Temperature at 30 s',
      'Temperature at 60 s',
    ]);
  });

  it('takes the supports in and out with thermal stress, and signed heat-flux factors (Codex on #1268)', () => {
    const { empty, fixed, loaded } = bare();
    const step = (d: SimulationDocument, kind: Parameters<typeof addConditionOps>[1], t = loaded) =>
      apply(d, addConditionOps(d, kind, t));
    const a = step(step(empty, 'temperature', fixed), 'convection');
    const b = apply(a, [{ type: 'addStudy', study: defaultTransientStudy(a) }]);
    expect(hasStressSupport(b)).toBe(false);
    // A support added later stays out of the study while it has no thermal stress …
    const c = step(b, 'fixed', fixed);
    expect(hasStressSupport(c)).toBe(true);
    const support = c.constraints.find((x) => x.kind === 'fixed')!.id;
    const t0 = c.studies.find((s) => s.kind === 'transient-thermal')!;
    if (t0.kind !== 'transient-thermal') throw new Error('no transient study');
    expect(t0.constraintIds).not.toContain(support);
    // A stiffness test's support is not one: its imposed twist would load the body.
    const twist = {
      ...defaultStudy(c),
      id: 'twist',
      constraintIds: [support],
      test: { kind: 'bending', load: 'x' },
    } as unknown as SimulationDocument['studies'][number];
    const tested = { ...c, studies: [...c.studies, twist] };
    expect(hasStressSupport(tested)).toBe(false);
    expect(
      transientSettingsStudy(tested, t0, { ...t0.transient, stress: { reference: 293.15 } })
        .constraintIds,
    ).not.toContain(support);
    // … turning it on takes the support in, and the document stays valid.
    const on = transientSettingsStudy(c, t0, { ...t0.transient, stress: { reference: 293.15 } });
    expect(on.constraintIds).toContain(support);
    const d = apply(c, [{ type: 'updateStudy', study: on }]);
    expect(validateSimulation(d)).toEqual([]);
    // A support added with thermal stress on joins the study.
    const e = step(d, 'fixed', loaded);
    const second = e.constraints.filter((x) => x.kind === 'fixed').at(-1)!.id;
    expect(e.studies.find((s) => s.id === on.id)!.constraintIds).toContain(second);
    // Turning it off takes the supports out again.
    const t1 = e.studies.find((s) => s.id === on.id)!;
    if (t1.kind !== 'transient-thermal') throw new Error('no transient study');
    const off = transientSettingsStudy(e, t1, { ...t1.transient, stress: null });
    expect(off.constraintIds).not.toContain(support);
    expect(off.constraintIds).not.toContain(second);
    expect(validateSimulation(apply(e, [{ type: 'updateStudy', study: off }]))).toEqual([]);
    // A stressed study measuring von Mises loses that metric with the stress (Codex on #1268).
    const measured = {
      ...t1,
      convergence: { ...t1.convergence, metrics: ['max-von-mises' as const] },
    };
    const f = apply(e, [{ type: 'updateStudy', study: measured }]);
    const offToo = transientSettingsStudy(f, measured, { ...measured.transient, stress: null });
    expect(offToo.convergence.metrics).toEqual(['max-temperature']);
    expect(validateSimulation(apply(f, [{ type: 'updateStudy', study: offToo }]))).toEqual([]);
    // A heat flux may turn to cooling; a temperature or film may not.
    expect(parseAmplitude('0:1, 60:-1', true)).toEqual({ times: [0, 60], factors: [1, -1] });
    expect(parseAmplitude('0:1, 60:-1')).toBeUndefined();
  });
});
