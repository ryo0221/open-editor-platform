import { describe, expect, it } from 'vitest';
import { schematicLedExample, type SchematicDocument } from '@editor-platform/schematic-core';
import {
  SchematicSimJobs,
  schematicSimAt,
  schematicSimCsv,
  schematicSimulate,
  type SchematicSimSettings,
} from './simulate';

function led(): SchematicDocument {
  const doc = schematicLedExample();
  const models: Record<string, NonNullable<SchematicDocument['parts'][number]['model']>> = {
    r1: { kind: 'resistor', terminals: { a: '1', b: '2' }, params: { ohms: 330 } },
    d1: { kind: 'led', terminals: { anode: '2', cathode: '1' }, params: { color: 'green' } },
    sw1: {
      kind: 'switch',
      terminals: { a: '1', b: '2' },
      params: { closedOhms: 0.05, openOhms: 1e9 },
    },
  };
  for (const p of doc.parts) p.model = models[p.id];
  return doc;
}
const base: SchematicSimSettings = {
  mode: 'dc',
  stop: 0.01,
  pins: { GPIO17: { kind: 'output', high: true }, GPIO27: { kind: 'input', pull: 'up' } },
  presses: {},
};

// TS-2109: the schematic screen's calculation.
describe('schematic simulation (TS-2109)', () => {
  it('runs DC with GPIO pins and a pressed switch', () => {
    const r = schematicSimulate(led(), base);
    expect(r.times).toEqual([0]);
    expect(r.voltages.GND).toEqual([0]);
    expect(r.voltages.GPIO17[0]).toBeGreaterThan(3.1);
    expect(r.currents.d1[0]).toBeGreaterThan(3e-3);
    // R1's current into `a` is the LED's.
    expect(r.currents.r1[0]).toBeCloseTo(r.currents.d1[0], 7);
    expect(r.inputs).toEqual({ GPIO27: [true] });
    const pressed = schematicSimulate(led(), { ...base, presses: { sw1: { pressed: true } } });
    expect(pressed.inputs).toEqual({ GPIO27: [false] });
    // A pin on a net nothing modelled uses drives nothing.
    const doc = led();
    doc.parts = doc.parts.filter((p) => p.id !== 'sw1');
    expect(schematicSimulate(doc, base).inputs).toEqual({});
  });

  it('runs a transient with a press and an output toggle', () => {
    const r = schematicSimulate(led(), {
      ...base,
      mode: 'tran',
      pins: { ...base.pins, GPIO17: { kind: 'output', high: false, toggleAt: 0.004 } },
      presses: { sw1: { pressed: false, from: 0.002, to: 0.006 } },
    });
    const at = (t: number) => r.times.findIndex((x) => x >= t);
    expect(r.inputs.GPIO27[at(0.001)]).toBe(true);
    expect(r.inputs.GPIO27[at(0.003)]).toBe(false);
    expect(r.inputs.GPIO27[at(0.007)]).toBe(true);
    expect(schematicSimAt(r.times, r.currents.d1, 0.003)).toBeLessThan(1e-9);
    expect(schematicSimAt(r.times, r.currents.d1, 0.005)).toBeGreaterThan(3e-3);
    const csv = schematicSimCsv(r, ['GPIO27'], [{ id: 'd1', ref: 'D1' }]).split('\n');
    expect(csv[0]).toBe('time,V(GPIO27),I(D1)');
    expect(csv).toHaveLength(r.times.length + 2);
  });

  it('refuses a release at or before the press and keeps a net called __proto__', () => {
    for (const [from, to] of [
      [0.006, 0.002],
      [0.003, 0.003],
      [undefined, 0],
    ] as const)
      expect(() =>
        schematicSimulate(led(), {
          ...base,
          mode: 'tran',
          presses: { sw1: { pressed: false, from, to } },
        }),
      ).toThrow('press-interval');
    const doc = led();
    for (const l of doc.labels) if (l.name === 'GPIO17') l.name = '__proto__';
    const r = schematicSimulate(doc, {
      ...base,
      pins: { ['__proto__']: { kind: 'output', high: true } },
    });
    expect(Object.keys(r.voltages)).toContain('__proto__');
    expect(Object.getOwnPropertyDescriptor(r.voltages, '__proto__')?.value[0]).toBeGreaterThan(3.1);
  });

  it('keeps a switch with no times open, and finds ground by port names', () => {
    const tran = { ...base, mode: 'tran' as const, stop: 0.002 };
    const open = schematicSimulate(led(), tran);
    const blank = schematicSimulate(led(), { ...tran, presses: { sw1: { pressed: true } } });
    expect(blank.voltages.GPIO27.at(-1)).toBeCloseTo(open.voltages.GPIO27.at(-1)!, 6);
    expect(open.voltages.GPIO27.at(-1)).toBeGreaterThan(3);
    // A ground port called `GND/analog` does not make a net called `analog` ground.
    const doc = led();
    for (const p of doc.powers) if (p.style === 'ground') p.name = 'GND/analog';
    for (const l of doc.labels) if (l.name === 'GPIO17') l.name = 'analog';
    const r = schematicSimulate(doc, { ...base, pins: { analog: { kind: 'output', high: true } } });
    expect(r.voltages.analog[0]).toBeGreaterThan(3.1);
    expect(r.voltages['GND/analog']).toEqual([0]);
  });

  it('gives an unmodelled net called toString NaN, and the result clones', () => {
    const doc = led();
    doc.parts.find((p) => p.id === 'sw1')!.model = undefined;
    for (const l of doc.labels) if (l.name === 'GPIO27') l.name = 'toString';
    const r = schematicSimulate(doc, { ...base, pins: {} });
    expect(Object.getOwnPropertyDescriptor(r.voltages, 'toString')?.value).toEqual([Number.NaN]);
    expect(() => structuredClone(r)).not.toThrow();
  });

  it('runs here when no Worker starts, and reports refusals by code', async () => {
    const jobs = new SchematicSimJobs(() => {
      throw new Error('no worker');
    });
    const ok = await jobs.run(led(), base);
    expect(ok.status).toBe('done');
    const doc = led();
    doc.powers = [];
    expect(await jobs.run(doc, base)).toEqual({ id: 2, status: 'refused', code: 'no-ground' });
    jobs.dispose();
  });
});
