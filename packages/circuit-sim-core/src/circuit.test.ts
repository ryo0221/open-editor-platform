import { describe, expect, it } from 'vitest';
import { schematicLedExample } from '@editor-platform/schematic-core';
import {
  CircuitError,
  circuitDcOperatingPoint,
  circuitDcSweep,
  circuitFloatingNodes,
  circuitLedModels,
  circuitRailVolts,
  circuitSpice,
  circuitThermalVolts,
  schematicCircuit,
  type Circuit,
  type CircuitElement,
} from './index';

/** A circuit from nodes (ground first) and elements written as [kind, ref, nodes, params]. */
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

// TS-2107: DC operating point against textbook results.
describe('circuit-sim-core DC (TS-2107)', () => {
  it('a divider, an inductor short, a capacitor open and a current source', () => {
    const c = build(
      ['0', 'in', 'mid', 'x', 'y'],
      [
        ['vsource', 'V1', { plus: 'in', minus: '0' }, { volts: 10 }],
        ['resistor', 'R1', { a: 'in', b: 'mid' }, { ohms: 1000 }],
        ['resistor', 'R2', { a: 'mid', b: '0' }, { ohms: 3000 }],
        ['inductor', 'L1', { a: 'mid', b: 'x' }, { henries: 1e-3 }],
        ['capacitor', 'C1', { a: 'x', b: '0' }, { farads: 1e-6 }],
        ['isource', 'I1', { plus: 'y', minus: '0' }, { amps: 2e-3 }],
        ['resistor', 'R3', { a: 'y', b: '0' }, { ohms: 500 }],
      ],
    );
    const r = circuitDcOperatingPoint(c);
    expect(r.voltages.mid).toBeCloseTo(7.5, 9);
    expect(r.voltages.x).toBeCloseTo(7.5, 9);
    expect(r.voltages.y).toBeCloseTo(1, 9);
    expect(r.currents.r1.a).toBeCloseTo(2.5e-3, 12);
    expect(r.currents.r1.b).toBeCloseTo(-2.5e-3, 12);
    // The source delivers 2.5 mA: into it at `plus` is −2.5 mA.
    expect(r.currents.v1.plus).toBeCloseTo(-2.5e-3, 12);
    expect(r.currents.l1.a).toBeCloseTo(0, 12);
    expect(r.currents.c1.a).toBe(0);
    expect(r.currents.i1.plus).toBeCloseTo(-2e-3, 12);
  });

  it('a diode drop matches the Shockley equation', () => {
    const c = build(
      ['0', 'in', 'a'],
      [
        ['vsource', 'V1', { plus: 'in', minus: '0' }, { volts: 5 }],
        ['resistor', 'R1', { a: 'in', b: 'a' }, { ohms: 1000 }],
        ['diode', 'D1', { anode: 'a', cathode: '0' }, { saturationAmps: 1e-14, emission: 1 }],
      ],
    );
    const r = circuitDcOperatingPoint(c);
    const vd = r.voltages.a;
    const i = r.currents.d1.anode;
    expect(vd).toBeGreaterThan(0.6);
    expect(vd).toBeLessThan(0.75);
    expect(i).toBeCloseTo((5 - vd) / 1000, 7);
    expect(i).toBeCloseTo(1e-14 * Math.expm1(vd / circuitThermalVolts), 8);
  });

  it('LED colours forward-bias at their typical voltages', () => {
    for (const [color, vf] of [
      ['red', 1.8],
      ['green', 2.1],
      ['blue', 3.0],
    ] as const) {
      // 10 mA forced through the LED gives the colour's typical voltage.
      const c = build(
        ['0', 'a'],
        [
          ['isource', 'I1', { plus: 'a', minus: '0' }, { amps: 0.01 }],
          ['led', 'D1', { anode: 'a', cathode: '0' }, { color }],
        ],
      );
      expect(circuitDcOperatingPoint(c).voltages.a).toBeCloseTo(vf, 3);
    }
    expect(Object.keys(circuitLedModels).sort()).toEqual([
      'blue',
      'green',
      'red',
      'white',
      'yellow',
    ]);
  });

  it('a BJT switch saturates and a MOSFET switch turns on', () => {
    const bjt = (vin: number) =>
      build(
        ['0', 'vcc', 'in', 'b', 'c'],
        [
          ['vsource', 'VCC', { plus: 'vcc', minus: '0' }, { volts: 5 }],
          ['vsource', 'VIN', { plus: 'in', minus: '0' }, { volts: vin }],
          ['resistor', 'RB', { a: 'in', b: 'b' }, { ohms: 10_000 }],
          ['resistor', 'RC', { a: 'vcc', b: 'c' }, { ohms: 1000 }],
          [
            'bjt',
            'Q1',
            { base: 'b', collector: 'c', emitter: '0' },
            { polarity: 'npn', beta: 100 },
          ],
        ],
      );
    const on = circuitDcOperatingPoint(bjt(3.3));
    expect(on.voltages.b).toBeGreaterThan(0.6);
    expect(on.voltages.c).toBeLessThan(0.2);
    expect(on.currents.q1.collector + on.currents.q1.base + on.currents.q1.emitter).toBeCloseTo(
      0,
      12,
    );
    const off = circuitDcOperatingPoint(bjt(0));
    expect(off.voltages.c).toBeCloseTo(5, 6);
    // Active region: Ic = β Ib.
    const active = circuitDcOperatingPoint(bjt(1));
    expect(active.currents.q1.collector / active.currents.q1.base).toBeCloseTo(100, 1);

    const mos = (vg: number, channel: 'n' | 'p') =>
      build(
        ['0', 'vdd', 'g', 'd'],
        [
          ['vsource', 'VDD', { plus: 'vdd', minus: '0' }, { volts: 5 }],
          ['vsource', 'VG', { plus: 'g', minus: '0' }, { volts: vg }],
          channel === 'n'
            ? ['resistor', 'RD', { a: 'vdd', b: 'd' }, { ohms: 1000 }]
            : ['resistor', 'RD', { a: 'd', b: '0' }, { ohms: 1000 }],
          [
            'mosfet',
            'M1',
            channel === 'n'
              ? { gate: 'g', drain: 'd', source: '0' }
              : { gate: 'g', drain: 'd', source: 'vdd' },
            { channel, thresholdVolts: channel === 'n' ? 1.5 : -1.5, k: 0.1 },
          ],
        ],
      );
    expect(circuitDcOperatingPoint(mos(5, 'n')).voltages.d).toBeLessThan(0.05);
    expect(circuitDcOperatingPoint(mos(0, 'n')).voltages.d).toBeCloseTo(5, 6);
    // Saturation: Id = k/2 (Vgs − Vt)² = 0.05 × 0.04 = 2 mA → 3 V across RD.
    expect(circuitDcOperatingPoint(mos(1.7, 'n')).currents.m1.drain).toBeCloseTo(2e-3, 6);
    expect(circuitDcOperatingPoint(mos(0, 'p')).voltages.d).toBeGreaterThan(4.95);
    expect(circuitDcOperatingPoint(mos(5, 'p')).voltages.d).toBeCloseTo(0, 6);
  });

  it('converges a diode-connected BJT and keeps KCL at a high-side diode', () => {
    const tied = build(
      ['0', 'in', 'b'],
      [
        ['vsource', 'V1', { plus: 'in', minus: '0' }, { volts: 1 }],
        ['resistor', 'R1', { a: 'in', b: 'b' }, { ohms: 1000 }],
        ['bjt', 'Q1', { base: 'b', collector: 'b', emitter: '0' }, { polarity: 'npn', beta: 100 }],
      ],
    );
    const r = circuitDcOperatingPoint(tied);
    expect(r.voltages.b).toBeGreaterThan(0.55);
    expect(r.voltages.b).toBeLessThan(0.7);
    expect(r.currents.q1.base + r.currents.q1.collector).toBeCloseTo(r.currents.r1.a, 9);
    // A diode on a 48 V supply into 1 MΩ: the diode's current is the resistor's.
    const high = build(
      ['0', 'in', 'k'],
      [
        ['vsource', 'V1', { plus: 'in', minus: '0' }, { volts: 48 }],
        ['diode', 'D1', { anode: 'in', cathode: 'k' }, { saturationAmps: 1e-14, emission: 2 }],
        ['resistor', 'R1', { a: 'k', b: '0' }, { ohms: 1e6 }],
      ],
    );
    const h = circuitDcOperatingPoint(high);
    expect(h.currents.d1.anode / h.currents.r1.a).toBeCloseTo(1, 3);
  });

  it('refuses a floating node, a missing ground and a source loop', () => {
    const floating = build(
      ['0', 'in', 'f'],
      [
        ['vsource', 'V1', { plus: 'in', minus: '0' }, { volts: 1 }],
        ['capacitor', 'C1', { a: 'in', b: 'f' }, { farads: 1e-6 }],
        ['isource', 'I1', { plus: 'f', minus: '0' }, { amps: 1e-3 }],
      ],
    );
    expect(circuitFloatingNodes(floating)).toEqual(['f']);
    expect(fail(() => circuitDcOperatingPoint(floating))).toEqual({
      code: 'floating-node',
      node: 'f',
    });
    const loop = build(
      ['0', 'a'],
      [
        ['vsource', 'V1', { plus: 'a', minus: '0' }, { volts: 1 }],
        ['vsource', 'V2', { plus: 'a', minus: '0' }, { volts: 2 }],
      ],
    );
    expect(fail(() => circuitDcOperatingPoint(loop))).toEqual({ code: 'dc-singular' });
    const doc = schematicLedExample();
    doc.powers = [];
    expect(fail(() => schematicCircuit(doc))).toEqual({ code: 'no-ground' });
    // A gate is no DC path: an undriven gate is a floating node.
    const gate = build(
      ['0', 'vdd', 'd', 'g'],
      [
        ['vsource', 'V1', { plus: 'vdd', minus: '0' }, { volts: 5 }],
        ['resistor', 'R1', { a: 'vdd', b: 'd' }, { ohms: 1000 }],
        [
          'mosfet',
          'M1',
          { gate: 'g', drain: 'd', source: '0' },
          { channel: 'n', thresholdVolts: 1.5, k: 0.1 },
        ],
      ],
    );
    expect(fail(() => circuitDcOperatingPoint(gate))).toEqual({ code: 'floating-node', node: 'g' });
    // A label named like another net's automatic name: two nodes, one name.
    const named = schematicLedExample();
    named.labels.find((l) => l.name === 'GPIO17')!.name = 'Net-(D1-2)';
    const m = (
      id: string,
      kind: string,
      terminals: Record<string, string>,
      params: CircuitElement['params'],
    ) => (named.parts.find((p) => p.id === id)!.model = { kind, terminals, params });
    m('r1', 'resistor', { a: '1', b: '2' }, { ohms: 330 });
    m('d1', 'led', { anode: '2', cathode: '1' }, { color: 'green' });
    expect(fail(() => schematicCircuit(named))).toEqual({
      code: 'net-name-duplicate',
      node: 'Net-(D1-2)',
    });
  });

  it('closes a switch only for an own true, whatever its ID', () => {
    const c = build(
      ['0', 'in', 'x'],
      [
        ['vsource', 'V1', { plus: 'in', minus: '0' }, { volts: 1 }],
        ['switch', 'S1', { a: 'in', b: 'x' }, { closedOhms: 1, openOhms: 1e9 }],
        ['resistor', 'R1', { a: 'x', b: '0' }, { ohms: 1 }],
      ],
    );
    c.elements[1].id = 'toString';
    expect(circuitDcOperatingPoint(c).voltages.x).toBeLessThan(1e-6);
    expect(circuitDcOperatingPoint(c, { switches: { toString: true } }).voltages.x).toBeCloseTo(
      0.5,
      6,
    );
    expect(circuitSpice(c)).toContain('RSWS1 in x 1000000000');
  });

  it('sweeps a source, each point from the one before', () => {
    const c = build(
      ['0', 'in', 'a'],
      [
        ['vsource', 'V1', { plus: 'in', minus: '0' }, { volts: 0 }],
        ['resistor', 'R1', { a: 'in', b: 'a' }, { ohms: 100 }],
        ['diode', 'D1', { anode: 'a', cathode: '0' }, { saturationAmps: 1e-14, emission: 1 }],
      ],
    );
    const r = circuitDcSweep(c, 'v1', [0, 1, 2, 3, 4, 5]);
    const vd = r.map((x) => x.voltages.a);
    expect(vd[0]).toBeCloseTo(0, 9);
    for (let i = 1; i < vd.length; i++) expect(vd[i]).toBeGreaterThan(vd[i - 1]);
    expect(vd[5]).toBeLessThan(0.8);
    expect(fail(() => circuitDcSweep(c, 'r1', [1]))).toEqual({
      code: 'sweep-source',
      element: 'r1',
    });
  });
});

describe('schematic → circuit (TS-2107)', () => {
  it('reads models, nets, rails and GPIO drives from a schematic', () => {
    const doc = schematicLedExample();
    const model = (
      id: string,
      kind: string,
      terminals: Record<string, string>,
      params: CircuitElement['params'],
    ) => {
      doc.parts.find((p) => p.id === id)!.model = { kind, terminals, params };
    };
    model('r1', 'resistor', { a: '1', b: '2' }, { ohms: 330 });
    model('d1', 'led', { anode: '2', cathode: '1' }, { color: 'green' });
    model('sw1', 'switch', { a: '1', b: '2' }, { closedOhms: 0.05, openOhms: 1e9 });
    const c = schematicCircuit(doc);
    expect(c.nodes[0]).toBe('GND');
    expect(c.nodes.slice(1).sort()).toEqual(['GPIO17', 'GPIO27', 'Net-(D1-2)']);
    expect(c.left).toEqual([]);
    const at = (name: string) => c.nodes.indexOf(name);
    const drives = [
      { id: 'out17', node: at('GPIO17'), kind: 'output' as const, volts: 3.3, ohms: 40 },
      {
        id: 'in27',
        node: at('GPIO27'),
        kind: 'input' as const,
        pull: 'up' as const,
        pullOhms: 50_000,
        supplyVolts: 3.3,
        thresholdVolts: 1.65,
      },
    ];
    const open = circuitDcOperatingPoint(c, { drives });
    expect(open.inputs.in27).toBe(true);
    // About 3.4 mA through the LED: (3.3 − Vf) / (330 + 40).
    const i = open.currents.d1.anode;
    expect(i).toBeGreaterThan(1e-3);
    expect(i).toBeLessThan(5e-3);
    expect(i).toBeCloseTo((3.3 - open.voltages['Net-(D1-2)']) / 370, 7);
    const pressed = circuitDcOperatingPoint(c, { drives, switches: { sw1: true } });
    expect(pressed.inputs.in27).toBe(false);

    // A part without a model leaves its own nets out: GPIO27 only reaches SW1.
    const noSwitch = schematicLedExample();
    for (const p of noSwitch.parts)
      if (p.id !== 'sw1') p.model = doc.parts.find((q) => q.id === p.id)!.model;
    const partial = schematicCircuit(noSwitch);
    expect(partial.nodes).not.toContain('GPIO27');
    expect(partial.left).toEqual([{ ref: 'SW1', reason: 'no-model' }]);
    expect(
      circuitDcOperatingPoint(partial, {
        drives: [drives[0]].map((d) => ({ ...d, node: partial.nodes.indexOf('GPIO17') })),
      }).currents.d1.anode,
    ).toBeGreaterThan(1e-3);

    const without = schematicLedExample();
    expect(schematicCircuit(without).left).toEqual([
      { ref: 'D1', reason: 'no-model' },
      { ref: 'R1', reason: 'no-model' },
      { ref: 'SW1', reason: 'no-model' },
    ]);
  });

  it('turns rail power ports into sources', () => {
    expect([circuitRailVolts('3V3'), circuitRailVolts('5V'), circuitRailVolts('1V8')]).toEqual([
      3.3, 5, 1.8,
    ]);
    expect([circuitRailVolts('+12V'), circuitRailVolts('-5V'), circuitRailVolts('VCC')]).toEqual([
      12,
      -5,
      undefined,
    ]);
    const doc = schematicLedExample();
    doc.labels = doc.labels.filter((l) => l.name !== 'GPIO17');
    doc.powers.push({ id: 'p2', name: '3V3', at: [60.96, 50.8], rotationDeg: 0, style: 'rail' });
    doc.parts.find((p) => p.id === 'r1')!.model = {
      kind: 'resistor',
      terminals: { a: '1', b: '2' },
      params: { ohms: 330 },
    };
    doc.parts.find((p) => p.id === 'd1')!.model = {
      kind: 'led',
      terminals: { anode: '2', cathode: '1' },
      params: { color: 'red' },
    };
    const c = schematicCircuit(doc);
    const rail = c.elements.find((e) => e.id === 'rail:3V3')!;
    expect(rail).toMatchObject({ kind: 'vsource', params: { volts: 3.3 } });
    // GPIO27 only reaches SW1 (no model): it is left out of the calculation.
    expect(c.left).toEqual([{ ref: 'SW1', reason: 'no-model' }]);
    const r = circuitDcOperatingPoint(
      { ...c, nodes: c.nodes, elements: c.elements },
      { drives: [{ id: 'g', node: c.nodes.indexOf('GPIO27'), kind: 'output', volts: 0, ohms: 1 }] },
    );
    expect(r.voltages['3V3']).toBeCloseTo(3.3, 9);
    expect(r.currents.d1.anode).toBeGreaterThan(3e-3);
  });

  it('writes a SPICE netlist', () => {
    const c = build(
      ['0', 'in', 'out net', 'b'],
      [
        ['vsource', 'V1', { plus: 'in', minus: '0' }, { volts: 5 }],
        ['resistor', 'R1', { a: 'in', b: 'out net' }, { ohms: 330 }],
        ['led', 'D1', { anode: 'out net', cathode: '0' }, { color: 'red' }],
        ['switch', 'SW1', { a: 'in', b: 'b' }, { closedOhms: 0.05, openOhms: 1e9 }],
        ['bjt', 'Q1', { base: 'b', collector: 'in', emitter: '0' }, { polarity: 'npn', beta: 100 }],
        ['isource', 'I1', { plus: 'b', minus: '0' }, { amps: 1e-3 }],
      ],
    );
    const text = circuitSpice(c, { title: 'LED test', switches: { sw1: true } });
    expect(text.split('\n')).toEqual([
      '* LED test',
      'VV1 in 0 DC 5',
      'RR1 in out_net 330',
      'DD1 out_net 0 LED_RED',
      'RSWSW1 in b 0.05',
      'QQ1 in b 0 Q_NPN_100',
      'II1 0 b DC 0.001',
      `.model LED_RED D(IS=${circuitLedModels.red.saturationAmps.toExponential(6)} N=2)`,
      '.model Q_NPN_100 NPN(IS=1e-14 BF=100 BR=1)',
      '.op',
      '.end',
      '',
    ]);
  });

  it('gives every SPICE card its own name and MOSFETs no body diode', () => {
    const c = build(
      ['0', 'p', 'n', 'd'],
      [
        ['vsource', '+5V', { plus: 'p', minus: '0' }, { volts: 5 }],
        ['vsource', '-5V', { plus: 'n', minus: '0' }, { volts: -5 }],
        ['resistor', 'R1', { a: 'p', b: 'd' }, { ohms: 1000 }],
        [
          'mosfet',
          'M1',
          { gate: 'p', drain: 'd', source: 'n' },
          { channel: 'n', thresholdVolts: 1.5, k: 0.1 },
        ],
      ],
    );
    const lines = circuitSpice(c).split('\n');
    expect(lines.slice(1, 3)).toEqual(['V_5V p 0 DC 5', 'V_5V_2 n 0 DC -5']);
    expect(lines).toContain('.model M_NMOS_1_5_0_1 NMOS(LEVEL=1 VTO=1.5 KP=0.1 IS=0)');
  });

  it('gives each SPICE model parameter set its own name', () => {
    const c = build(
      ['0', 'p', 'd1', 'd2'],
      [
        ['vsource', 'V1', { plus: 'p', minus: '0' }, { volts: 5 }],
        ['resistor', 'R1', { a: 'p', b: 'd1' }, { ohms: 1000 }],
        ['resistor', 'R2', { a: 'p', b: 'd2' }, { ohms: 1000 }],
        [
          'mosfet',
          'M1',
          { gate: 'p', drain: 'd1', source: '0' },
          { channel: 'n', thresholdVolts: 1.5, k: 2 },
        ],
        [
          'mosfet',
          'M2',
          { gate: 'p', drain: 'd2', source: '0' },
          { channel: 'n', thresholdVolts: 1, k: 5.2 },
        ],
      ],
    );
    const lines = circuitSpice(c).split('\n');
    expect(lines).toContain('MM1 d1 p 0 0 M_NMOS_1_5_2 L=1 W=1');
    expect(lines).toContain('MM2 d2 p 0 0 M_NMOS_1_5_2_2 L=1 W=1');
    expect(lines).toContain('.model M_NMOS_1_5_2 NMOS(LEVEL=1 VTO=1.5 KP=2 IS=0)');
    expect(lines).toContain('.model M_NMOS_1_5_2_2 NMOS(LEVEL=1 VTO=1 KP=5.2 IS=0)');
  });

  it('writes GPIO drives into the SPICE netlist as the solver stamps them', () => {
    const c = build(
      ['0', 'out', 'in', 'dn'],
      [
        ['resistor', 'R1', { a: 'out', b: '0' }, { ohms: 1000 }],
        ['resistor', 'R2', { a: 'in', b: '0' }, { ohms: 1e6 }],
        ['resistor', 'R3', { a: 'dn', b: 'out' }, { ohms: 1e6 }],
      ],
    );
    const drives = [
      { id: 'GPIO17', node: 1, kind: 'output' as const, volts: 3.3, ohms: 40 },
      {
        id: 'GPIO27',
        node: 2,
        kind: 'input' as const,
        pull: 'up' as const,
        pullOhms: 50000,
        supplyVolts: 3.3,
        thresholdVolts: 1.65,
      },
      {
        id: 'GPIO22',
        node: 3,
        kind: 'input' as const,
        pull: 'down' as const,
        pullOhms: 50000,
        supplyVolts: 3.3,
        thresholdVolts: 1.65,
      },
    ];
    expect(circuitDcOperatingPoint(c, { drives }).voltages.out).toBeCloseTo((3.3 * 1000) / 1040, 2);
    const lines = circuitSpice(c, { drives }).split('\n');
    expect(lines).toContain('VDRV_GPIO17 drv_GPIO17 0 DC 3.3');
    expect(lines).toContain('RDRV_GPIO17 drv_GPIO17 out 40');
    expect(lines).toContain('VPULL_GPIO27 pull_GPIO27 0 DC 3.3');
    expect(lines).toContain('RPULL_GPIO27 pull_GPIO27 in 50000');
    expect(lines).toContain('RPULL_GPIO22 dn 0 50000');
  });

  it('finds rails by net membership, refuses conflicting rails and keeps rail IDs apart', () => {
    const base = () => {
      const doc = schematicLedExample();
      doc.labels = doc.labels.filter((l) => l.name !== 'GPIO17');
      doc.powers.push({ id: 'p2', name: '3V3', at: [60.96, 50.8], rotationDeg: 0, style: 'rail' });
      doc.parts.find((p) => p.id === 'r1')!.model = {
        kind: 'resistor',
        terminals: { a: '1', b: '2' },
        params: { ohms: 330 },
      };
      doc.parts.find((p) => p.id === 'd1')!.model = {
        kind: 'led',
        terminals: { anode: '2', cathode: '1' },
        params: { color: 'red' },
      };
      return doc;
    };
    // A second rail, 5V, on the same net: the 3V3 name wins the display, but both are seen.
    const two = base();
    two.powers.push({ id: 'p3', name: '5V', at: [60.96, 50.8], rotationDeg: 0, style: 'rail' });
    expect(fail(() => schematicCircuit(two))).toMatchObject({ code: 'rail-conflict' });
    // A part whose ID is `rail:3V3` does not share its ID with the rail source.
    const clash = base();
    clash.parts.find((p) => p.id === 'r1')!.id = 'rail:3V3';
    const c = schematicCircuit(clash);
    const ids = c.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('rail:3V3#2');
    const r = circuitDcOperatingPoint(c, {
      drives: [{ id: 'g', node: c.nodes.indexOf('GPIO27'), kind: 'output', volts: 0, ohms: 1 }],
    });
    expect(r.voltages['3V3']).toBeCloseTo(3.3, 9);
    // A 0V rail on the ground net: still ground (its display name is 0V), no source.
    const zero = base();
    const gnd = zero.powers.find((p) => p.style === 'ground')!;
    zero.powers.push({ id: 'p4', name: '0V', at: gnd.at, rotationDeg: 0, style: 'rail' });
    const z = schematicCircuit(zero);
    expect(z.nodes[0]).toBe('0V');
    expect(z.elements.filter((e) => e.kind === 'vsource').map((e) => e.ref)).toEqual(['3V3']);
  });
});
