import { describe, expect, it } from 'vitest';
import { schematicLedExample } from '@editor-platform/schematic-core';
import {
  CircuitError,
  circuitTranCsv,
  circuitTransient,
  circuitTransientStepper,
  schematicCircuit,
  type Circuit,
  type CircuitDrive,
  type CircuitElement,
} from './index';

function build(
  nodes: string[],
  parts: [CircuitElement['kind'], string, Record<string, string>, CircuitElement['params']][],
): Circuit {
  return {
    nodes,
    left: [],
    elements: parts.map(([kind, ref, terms, params]) => ({
      id: ref.toLowerCase(),
      ref,
      kind,
      nodes: Object.fromEntries(Object.entries(terms).map(([t, n]) => [t, nodes.indexOf(n)])),
      params,
    })),
  };
}
const fail = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof CircuitError) return { code: e.code, ...e.detail };
    throw e;
  }
  throw new Error('no error');
};
/** The largest |f(t) − v| over the result's points. */
const worst = (times: number[], values: number[], f: (t: number) => number) =>
  Math.max(...times.map((t, i) => Math.abs(f(t) - values[i])));

// TS-2108: transient analysis against textbook responses.
describe('circuit-sim-core transient (TS-2108)', () => {
  const rc = build(
    ['0', 'out', 'c'],
    [
      ['resistor', 'R1', { a: 'out', b: 'c' }, { ohms: 1000 }],
      ['capacitor', 'C1', { a: 'c', b: '0' }, { farads: 1e-6 }],
    ],
  );
  const pin: CircuitDrive = { id: 'gpio', node: 1, kind: 'output', volts: 0, ohms: 1 };
  const tau = 1001e-6;
  const charge = (t: number) => (t <= 5e-4 ? 0 : 3.3 * (1 - Math.exp(-(t - 5e-4) / tau)));

  for (const method of ['trapezoid', 'euler'] as const)
    it(`an RC charge follows 1 − e^(−t/RC) (${method})`, () => {
      const r = circuitTransient(rc, {
        stop: 5e-3,
        method,
        drives: [pin],
        events: [{ time: 5e-4, outputs: { gpio: 3.3 } }],
      });
      // The event time is a point of its own.
      expect(r.times).toContain(5e-4);
      expect(r.times.at(-1)).toBe(5e-3);
      expect(worst(r.times, r.voltages.c, charge)).toBeLessThan(method === 'euler' ? 0.03 : 0.002);
      // The capacitor's current is C dv/dt: (3.3 − Vc) / R once charging.
      const i = r.times.findIndex((t) => t > 2e-3);
      expect(r.currents.c1.a[i]).toBeCloseTo((3.3 - r.voltages.c[i]) / 1001, 4);
    });

  it('an RL current rises as 1 − e^(−tR/L) after a switch closes', () => {
    const c = build(
      ['0', 'in', 's', 'l'],
      [
        ['vsource', 'V1', { plus: 'in', minus: '0' }, { volts: 1 }],
        ['switch', 'S1', { a: 'in', b: 's' }, { closedOhms: 1e-6, openOhms: 1e12 }],
        ['resistor', 'R1', { a: 's', b: 'l' }, { ohms: 10 }],
        ['inductor', 'L1', { a: 'l', b: '0' }, { henries: 0.01 }],
      ],
    );
    const r = circuitTransient(c, { stop: 4e-3, events: [{ time: 1e-4, switches: { s1: true } }] });
    const expected = (t: number) => (t <= 1e-4 ? 0 : 0.1 * (1 - Math.exp(-(t - 1e-4) / 1e-3)));
    expect(worst(r.times, r.currents.l1.a, expected)).toBeLessThan(1e-3);
  });

  it('a node only capacitors hold starts from the capacitive divider', () => {
    const c = build(
      ['0', 'out', 'mid'],
      [
        ['capacitor', 'C1', { a: 'out', b: 'mid' }, { farads: 1e-6 }],
        ['capacitor', 'C2', { a: 'mid', b: '0' }, { farads: 3e-6 }],
      ],
    );
    const r = circuitTransient(c, {
      stop: 1e-3,
      drives: [pin],
      events: [{ time: 2e-4, outputs: { gpio: 1 } }],
    });
    expect(r.voltages.mid[0]).toBeCloseTo(0, 9);
    expect(r.voltages.mid.at(-1)).toBeCloseTo(0.25, 3);
  });

  it('the LED example reads the button press on GPIO27 and lights the LED from GPIO17', () => {
    const doc = schematicLedExample();
    const model = (
      id: string,
      kind: string,
      t: Record<string, string>,
      p: CircuitElement['params'],
    ) => (doc.parts.find((x) => x.id === id)!.model = { kind, terminals: t, params: p });
    model('r1', 'resistor', { a: '1', b: '2' }, { ohms: 330 });
    model('d1', 'led', { anode: '2', cathode: '1' }, { color: 'green' });
    model('sw1', 'switch', { a: '1', b: '2' }, { closedOhms: 0.05, openOhms: 1e9 });
    const c = schematicCircuit(doc);
    const r = circuitTransient(c, {
      stop: 0.01,
      drives: [
        { id: 'gpio17', node: c.nodes.indexOf('GPIO17'), kind: 'output', volts: 0, ohms: 40 },
        {
          id: 'gpio27',
          node: c.nodes.indexOf('GPIO27'),
          kind: 'input',
          pull: 'up',
          pullOhms: 50_000,
          supplyVolts: 3.3,
          thresholdVolts: 1.65,
        },
      ],
      events: [
        { time: 0.002, switches: { sw1: true } },
        { time: 0.004, outputs: { gpio17: 3.3 } },
        { time: 0.006, switches: { sw1: false } },
      ],
    });
    const at = (t: number) => r.times.findIndex((x) => x > t);
    expect(r.inputs.gpio27[at(0.001)]).toBe(true);
    expect(r.inputs.gpio27[at(0.003)]).toBe(false);
    expect(r.inputs.gpio27[at(0.007)]).toBe(true);
    expect(r.currents.d1.anode[at(0.003)]).toBeLessThan(1e-9);
    expect(r.currents.d1.anode[at(0.005)]).toBeGreaterThan(3e-3);
  });

  it('controls the first step after an event even when it is long against RC', () => {
    // maxStep 10 ms against RC ≈ 1 ms: the restart step is checked by step doubling.
    const r = circuitTransient(rc, {
      stop: 0.5,
      drives: [pin],
      events: [{ time: 0.05, outputs: { gpio: 3.3 } }],
    });
    const late = (t: number) => (t <= 0.05 ? 0 : 3.3 * (1 - Math.exp(-(t - 0.05) / tau)));
    expect(worst(r.times, r.voltages.c, late)).toBeLessThan(0.02);
  });

  it('keeps IDs such as toString as ordinary keys', () => {
    const c = build(
      ['0', 'out', 'c'],
      [
        ['resistor', 'toString', { a: 'out', b: 'c' }, { ohms: 1000 }],
        ['capacitor', '__proto__', { a: 'c', b: '0' }, { farads: 1e-6 }],
      ],
    );
    c.elements[0].id = 'toString';
    const r = circuitTransient(c, {
      stop: 1e-3,
      drives: [
        { ...pin, id: 'constructor' },
        {
          id: 'valueOf',
          node: 2,
          kind: 'input',
          pull: 'none',
          pullOhms: 1e6,
          supplyVolts: 3.3,
          thresholdVolts: 1.65,
        },
      ],
      events: [{ time: 1e-4, outputs: { constructor: 1 } }],
    });
    expect(Object.hasOwn(r.currents, 'toString')).toBe(true);
    expect(Object.hasOwn(r.currents, '__proto__')).toBe(true);
    expect(r.currents['toString'].a).toHaveLength(r.times.length);
    expect(r.inputs.valueOf).toHaveLength(r.times.length);
  });

  it('refuses bad times, unknown events and floating nodes', () => {
    expect(fail(() => circuitTransient(rc, { stop: 0, drives: [pin] }))).toEqual({
      code: 'tran-stop',
    });
    expect(
      fail(() =>
        circuitTransient(rc, {
          stop: 1,
          drives: [pin],
          events: [{ time: 0.1, switches: { x: true } }],
        }),
      ),
    ).toEqual({ code: 'tran-event', element: 'x' });
    for (const bad of [{ vntol: 0 }, { reltol: 0 }, { reltol: Number.NaN }])
      expect(fail(() => circuitTransient(rc, { stop: 1e-3, drives: [pin], ...bad }))).toEqual({
        code: 'tran-tolerance',
      });
    const floating = build(
      ['0', 'f'],
      [['isource', 'I1', { plus: 'f', minus: '0' }, { amps: 1e-3 }]],
    );
    expect(fail(() => circuitTransient(floating, { stop: 1 }))).toEqual({
      code: 'floating-node',
      node: 'f',
    });
  });

  it('writes the chosen waveforms as CSV', () => {
    const r = circuitTransient(rc, {
      stop: 1e-3,
      maxStep: 2.5e-4,
      drives: [pin],
      events: [{ time: 5e-4, outputs: { gpio: 1 } }],
    });
    const csv = circuitTranCsv(r, { nodes: ['c'], currents: [['c1', 'a']] })
      .trimEnd()
      .split('\n');
    expect(csv[0]).toBe('time,V(c),I(c1.a)');
    expect(csv).toHaveLength(r.times.length + 1);
    expect(csv[1]).toBe('0,0,0');
    expect(fail(() => circuitTranCsv(r, { nodes: ['nope'] }))).toEqual({
      code: 'csv-column',
      node: 'nope',
    });
  });

  it('a stepper changed between pieces follows the same RC charge (SL8)', () => {
    const s = circuitTransientStepper(rc, { stop: 6e-3, maxStep: 5e-5, drives: [pin] });
    s.advanceTo(5e-4);
    expect(s.time).toBeCloseTo(5e-4, 12);
    s.change({ outputs: { gpio: 3.3 } });
    // Advance in scan-sized pieces.
    for (let k = 1; k <= 10; k++) s.advanceTo(5e-4 + k * 5e-4);
    const r = s.result;
    expect(worst(r.times, r.voltages.c, charge)).toBeLessThan(5e-3);
    expect(s.time).toBeCloseTo(5.5e-3, 12);
    expect(fail(() => s.change({ outputs: { nope: 1 } }))).toEqual({
      code: 'tran-event',
      element: 'nope',
    });
    expect(fail(() => s.advanceTo(1))).toEqual({ code: 'tran-stop' });
  });
});
