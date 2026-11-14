import { describe, expect, it } from 'vitest';
import { CircuitError } from '@editor-platform/circuit-sim-core';
import { ladderBlinkExample, ladderSelfHoldExample } from '@editor-platform/ladder-core';
import {
  Cosim,
  CosimError,
  cosimHatExample,
  cosimLedSchematic,
  cosimRun,
  cosimSelfHoldBindings,
  type CosimBinding,
} from './index';

const led = cosimLedSchematic;
const bindings: CosimBinding[] = cosimSelfHoldBindings();
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof CosimError || e instanceof CircuitError) return e.code;
    throw e;
  }
  return 'none';
};

// TS-2116: co-simulation of a ladder program and a schematic.
describe('cosim-core (TS-2116)', () => {
  it('holds the LED on from the button and drops it on STOP, a scan period at a time', () => {
    const frames = cosimRun(led(), ladderSelfHoldExample(), bindings, 40, {
      5: { switches: { sw1: true } },
      8: { switches: { sw1: false } },
      20: { inputs: { STOP: true } },
      22: { inputs: { STOP: false } },
      30: { switches: { sw1: true } },
    });
    const lamp = frames.map((f) => f.ladder.values.LAMP);
    const mA = (k: number) => frames[k].currents.d1 * 1e3;
    // Off before the press; the press is read one period later (the input is sampled first).
    expect(lamp.slice(0, 6)).toEqual([false, false, false, false, false, false]);
    expect(lamp[6]).toBe(true);
    expect(mA(4)).toBeLessThan(0.01);
    // On with the textbook current: (3.3 V − LED drop) / (330 Ω + 40 Ω).
    const on = mA(15);
    expect(on).toBeGreaterThan(2);
    expect(on).toBeLessThan(5);
    expect(frames[15].voltages.GPIO27).toBeGreaterThan(3);
    // Released, still on (self hold); STOP (an unbound input, read in its own scan) drops it and
    // it stays off.
    expect(lamp.slice(9, 20).every(Boolean)).toBe(true);
    expect(lamp.slice(20, 31).some(Boolean)).toBe(false);
    expect(mA(28)).toBeLessThan(0.01);
    expect(lamp[31]).toBe(true);
    // Virtual time: 40 scans of 10 ms.
    expect(frames[39].time).toBeCloseTo(0.4, 9);
    expect(frames[6].power.c1).toBe(true);
  });

  it('a bigger resistor gives less current; a timer preset sets the blink', () => {
    const run = (ohms: number) =>
      cosimRun(led(ohms), ladderSelfHoldExample(), bindings, 12, {
        2: { switches: { sw1: true } },
      })[11].currents.d1;
    expect(run(1000)).toBeLessThan(run(330) * 0.5);
    const blink = (presetMs: number) => {
      const doc = ladderBlinkExample();
      for (const r of doc.rungs)
        if (r.network.kind === 'series')
          for (const n of r.network.items) if (n.kind === 'timer') n.presetMs = presetMs;
      const frames = cosimRun(
        led(),
        doc,
        [{ variable: 'LAMP', net: 'GPIO17', kind: 'output' }],
        120,
        {
          0: { inputs: { ENABLE: true } },
        },
      );
      let changes = 0;
      for (let k = 1; k < frames.length; k++)
        if (frames[k].currents.d1 > 1e-3 !== frames[k - 1].currents.d1 > 1e-3) changes++;
      return changes;
    };
    expect(blink(100)).toBeGreaterThan(blink(300));
  });

  it('refuses bindings that do not fit, and keeps unbound inputs and forcing', () => {
    const hold = ladderSelfHoldExample();
    expect(
      code(() => new Cosim(led(), hold, [{ variable: 'LAMP', net: 'GPIO27', kind: 'input' }])),
    ).toBe('cosim-variable');
    expect(
      code(() => new Cosim(led(), hold, [{ variable: 'NOPE', net: 'GPIO27', kind: 'input' }])),
    ).toBe('cosim-variable');
    expect(
      code(() => new Cosim(led(), hold, [{ variable: 'START', net: 'NOPE', kind: 'input' }])),
    ).toBe('cosim-net');
    expect(
      code(() => new Cosim(led(), hold, [{ variable: 'START', net: 'GND', kind: 'input' }])),
    ).toBe('cosim-net');
    expect(
      code(
        () =>
          new Cosim(led(), hold, [
            { variable: 'START', net: 'GPIO27', kind: 'input' },
            { variable: 'STOP', net: 'GPIO27', kind: 'input' },
          ]),
      ),
    ).toBe('cosim-net');
    expect(code(() => new Cosim(led(), { ...hold, scanMs: 0 }, bindings))).toBe('ladder-invalid');
    const noGround = led();
    noGround.powers = [];
    noGround.labels = noGround.labels.filter((l) => l.name !== 'GND');
    expect(code(() => new Cosim(noGround, hold, bindings))).not.toBe('none');
    // Forcing LAMP drives the LED without the button; released, the program holds it through
    // its own contact until STOP.
    const sim = new Cosim(led(), hold, bindings);
    expect(sim.scan({ forced: { LAMP: true } }).currents.d1).toBeGreaterThan(1e-3);
    expect(
      sim.scan({ forced: { LAMP: undefined as unknown as boolean } }).currents.d1,
    ).toBeGreaterThan(1e-3);
    expect(sim.scan({ inputs: { STOP: true } }).currents.d1).toBeLessThan(1e-5);
    // Names compare without case: a force set as `lamp` is released as `LAMP`, and a typed
    // `start` does not override the START the circuit reads.
    const other = new Cosim(led(), hold, bindings);
    expect(other.scan({ forced: { lamp: true } }).currents.d1).toBeGreaterThan(1e-3);
    other.scan({ forced: { LAMP: undefined as unknown as boolean }, inputs: { stop: true } });
    expect(other.scan().currents.d1).toBeLessThan(1e-5);
    expect(other.scan({ inputs: { stop: false, start: true } }).ladder.values.LAMP).toBe(false);
  });

  it('F92: the HAT schematic (F90) and the self-hold program (F91) latch the LED', () => {
    const { schematic, ladder, bindings: b } = cosimHatExample();
    const frames = cosimRun(schematic, ladder, b, 30, {
      3: { switches: { sw1: true } },
      5: { switches: { sw1: false } },
      20: { inputs: { STOP: true } },
    });
    expect(frames[2].currents.d1).toBeLessThan(1e-5);
    expect(frames[10].ladder.values.LAMP).toBe(true);
    expect(frames[10].currents.d1).toBeGreaterThan(1e-3);
    expect(frames[29].currents.d1).toBeLessThan(1e-5);
  });
});
