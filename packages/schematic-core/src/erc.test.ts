import { describe, expect, it } from 'vitest';
import {
  generateSchematicSymbol,
  schematicAutoPinMap,
  schematicFootprintStart,
  schematicModelFor,
  schematicWithFootprint,
  schematicErc,
  schematicLedExample,
  schematicPartSuggestion,
  schematicStarter,
  schematicSymbolLibrary,
  schematicSymbolSpecs,
  validateSchematic,
  type SchematicDocument,
  type SchematicPart,
} from './index';

// SL2a (ST-561, TS-2103): symbol generators, part footprint/pin map/model, and the ERC.

const errors = (doc: unknown) =>
  validateSchematic(doc)
    .filter((d) => d.severity === 'error')
    .map((d) => d.code);
const part = (id: string, ref: string, symbol: string, at: [number, number]): SchematicPart => ({
  id,
  ref,
  value: ref,
  symbol,
  at,
  rotationDeg: 0,
  mirror: false,
});
const sheet = (): SchematicDocument => ({
  ...schematicStarter(),
  symbols: schematicSymbolLibrary(),
});
const erc = (doc: SchematicDocument) =>
  schematicErc(doc).map((i) => `${i.code} ${i.net} ${i.pins.map((p) => p.join('.')).join(',')}`);

describe('schematic symbols, parts and ERC (SL2a, TS-2103)', () => {
  it('generates every symbol on the grid, and each suggestion makes a valid part', () => {
    const doc = sheet();
    expect(doc.symbols.map((s) => s.id)).toEqual(
      [...schematicSymbolSpecs.keys()].map((k) => `sym-${k}`),
    );
    doc.symbols.forEach((s, i) => {
      const at: [number, number] = [25.4 + (i % 6) * 38.1, 38.1 + Math.floor(i / 6) * 50.8];
      doc.parts.push({
        ...part(`p${i}`, `${s.prefix}${i + 1}`, s.id, at),
        ...schematicPartSuggestion(s),
      });
    });
    expect(errors(doc)).toEqual([]);
    // Plain JSON: the library survives a JSON round trip unchanged (no −0 coordinates).
    expect(JSON.parse(JSON.stringify(doc.symbols))).toEqual(doc.symbols);
    // The resistor starts as 1 kΩ on an 0603 chip, pins 1/2 on pads 1/2.
    expect(doc.parts[0]).toMatchObject({
      value: '1k',
      footprint: { generator: 'chip', params: { size: '0603' } },
      pinMap: { '1': '1', '2': '2' },
      model: { kind: 'resistor', terminals: { a: '1', b: '2' }, params: { ohms: 1000 } },
    });
  });

  it('takes generator parameters and refuses bad ones', () => {
    const conn = generateSchematicSymbol('j', 'connector', { pins: 5 });
    expect(conn.pins.map((p) => p.at)).toEqual([
      [-5.08, -5.08],
      [-5.08, -2.54],
      [-5.08, 0],
      [-5.08, 2.54],
      [-5.08, 5.08],
    ]);
    expect(conn.generator).toEqual({ kind: 'connector', params: { pins: 5 } });
    // Every connector size gets a footprint it can make (a header row holds at most 40).
    for (const pins of [1, 40, 41, 64]) {
      const doc = sheet();
      const s = generateSchematicSymbol('big', 'connector', { pins });
      doc.symbols.push(s);
      doc.parts = [{ ...part('j', 'J1', 'big', [101.6, 101.6]), ...schematicPartSuggestion(s) }];
      expect(errors(doc)).toEqual([]);
    }
    const ic = generateSchematicSymbol('u', 'ic', {
      name: 'EEPROM',
      left: 'VCC:power-in, SDA, SCL:input',
      right: 'GND:power-in',
    });
    expect(ic.pins.map((p) => `${p.number}:${p.name}:${p.type}`)).toEqual([
      '1:VCC:power-in',
      '2:SDA:bidirectional',
      '3:SCL:input',
      '4:GND:power-in',
    ]);
    expect(() => generateSchematicSymbol('u', 'ic', { left: 'A:wrong' })).toThrow(
      'symbol-param:left',
    );
    expect(() => generateSchematicSymbol('j', 'connector', { pins: 0 })).toThrow(
      'symbol-param:pins',
    );
    expect(() => generateSchematicSymbol('j', 'connector', { size: 1 })).toThrow(
      'symbol-param:size',
    );
    expect(() => generateSchematicSymbol('x', 'nothing')).toThrow('symbol-param:kind');
  });

  it('checks footprints, pin maps, models and not-connected pins against the symbol', () => {
    const base = () => {
      const doc = sheet();
      const s = doc.symbols.find((x) => x.id === 'sym-resistor')!;
      doc.parts = [{ ...part('r', 'R1', s.id, [50.8, 50.8]), ...schematicPartSuggestion(s) }];
      return doc;
    };
    const bad = (change: (p: SchematicPart) => void) => {
      const doc = base();
      change(doc.parts[0]);
      return errors(doc);
    };
    expect(errors(base())).toEqual([]);
    expect(bad((p) => (p.footprint = { generator: 'teapot', params: {} }))).toEqual(['footprint']);
    expect(bad((p) => delete p.pinMap!['2'])).toEqual(['pinmap-missing']);
    expect(bad((p) => (p.pinMap!['2'] = '9'))).toEqual(['pinmap-pad']);
    expect(bad((p) => (p.pinMap!['3'] = '1'))).toEqual(['pinmap-pin']);
    expect(bad((p) => delete p.footprint)).toEqual(['pinmap-without-footprint']);
    expect(bad((p) => delete p.pinMap)).toEqual(['pinmap-missing']);
    expect(bad((p) => (p.model!.terminals = { a: '1', b: '1' }))).toEqual(['model-terminals']);
    expect(bad((p) => (p.model!.terminals = { a: '1', c: '2' }))).toEqual(['model-terminals']);
    expect(bad((p) => (p.model!.params = { ohms: -1 }))).toEqual(['model-param']);
    expect(bad((p) => (p.model!.params = { ohms: 1, extra: 2 }))).toEqual(['model-param']);
    expect(bad((p) => (p.model!.kind = 'flux-capacitor'))).toEqual(['model-kind']);
    expect(bad((p) => (p.noConnect = ['3']))).toEqual(['no-connect-pin']);
    expect(bad((p) => (p.noConnect = ['1', '1']))).toEqual(['no-connect-pin']);
    expect(bad((p) => (p.noConnect = ['2']))).toEqual([]);
  });

  it('reports pins left alone, and not those marked not connected', () => {
    // The LED example's labels GPIO17 and GPIO27 lead nowhere on this sheet.
    expect(erc(schematicLedExample())).toEqual([
      'erc-unconnected GPIO17 r1.1',
      'erc-unconnected GPIO27 sw1.1',
    ]);
    const doc = schematicLedExample();
    doc.parts[0].noConnect = ['1'];
    expect(erc(doc)).toEqual(['erc-unconnected GPIO27 sw1.1']);
    // Marked but connected after all.
    doc.parts[0].noConnect = ['2'];
    expect(erc(doc)).toContain('erc-no-connect-connected Net-(D1-2) r1.2');
  });

  it('finds driver conflicts, input-only nets and unpowered supply pins', () => {
    const doc = schematicStarter();
    doc.symbols = [
      generateSchematicSymbol('out', 'ic', { left: '', right: 'O:output' }),
      generateSchematicSymbol('in', 'ic', { left: 'I:input', right: '' }),
      generateSchematicSymbol('reg', 'ic', { left: '', right: 'VOUT:power-out' }),
      generateSchematicSymbol('load', 'ic', { left: 'VDD:power-in', right: '' }),
    ];
    // Pin ends meet: U1's right pin (x + 10.16) on U2's left pin (x − 10.16).
    const meet = (a: string, b: string, y: number): SchematicPart[] => [
      part(`${a}-${y}`, `U${y}`, a, [50.8, y]),
      part(`${b}-${y}`, `U${y + 1}`, b, [71.12, y]),
    ];
    doc.parts = [...meet('out', 'in', 20), ...meet('reg', 'load', 40)];
    expect(erc(doc)).toEqual([]);
    // A second output on the same pin end: two drivers on one net.
    doc.parts.push(part('out-b', 'U90', 'out', [50.8, 20]));
    expect(erc(doc)).toEqual(['erc-output-conflict Net-(U20-1) out-20.1,out-b.1']);
    doc.parts.pop();
    doc.parts.push(part('reg-b', 'U91', 'reg', [50.8, 40]));
    expect(erc(doc)).toEqual(['erc-power-conflict Net-(U40-1) reg-40.1,reg-b.1']);
    doc.parts.pop();
    // Inputs only, and a supply pin with nothing driving it.
    doc.parts = [
      // Mirrored, U1's and U3's left pins turn to the right and meet U2's and U4's.
      { ...part('in-a', 'U1', 'in', [50.8, 20]), mirror: true },
      part('in-b', 'U2', 'in', [71.12, 20]),
      { ...part('ld-a', 'U3', 'load', [50.8, 40]), mirror: true },
      part('ld-b', 'U4', 'load', [71.12, 40]),
    ];
    expect(erc(doc)).toEqual([
      'erc-no-driver Net-(U1-1) in-a.1,in-b.1',
      'erc-power-undriven Net-(U3-1) ld-a.1,ld-b.1',
    ]);
    // A power port drives the supply net.
    doc.powers = [{ id: 'v', name: '3V3', at: [60.96, 40], rotationDeg: 0, style: 'rail' }];
    expect(erc(doc)).toEqual(['erc-no-driver Net-(U1-1) in-a.1,in-b.1']);
  });

  it("TS-2104: starts footprints and models on a symbol's pins in number order", () => {
    const ic = generateSchematicSymbol('u', 'ic', {
      left: 'A, B, C',
      right: 'D, E, F, G, H, I, J',
    });
    // Pins 1…10 onto a 1×10 header's pads in order ("10" after "9").
    expect(
      schematicAutoPinMap(ic, { generator: 'pin-header', params: { rows: 1, pinsPerRow: 10 } }),
    ).toEqual(Object.fromEntries([...Array(10).keys()].map((i) => [`${i + 1}`, `${i + 1}`])));
    // Too few pads: no map.
    expect(
      schematicAutoPinMap(ic, { generator: 'pin-header', params: { rows: 1, pinsPerRow: 4 } }),
    ).toBeUndefined();
    // A generator's own model keeps its terminals; another kind takes the pins in order.
    const led = generateSchematicSymbol('d', 'led');
    expect(schematicModelFor(led, 'led')?.terminals).toEqual({ anode: '2', cathode: '1' });
    expect(schematicModelFor(led, 'resistor')?.terminals).toEqual({ a: '1', b: '2' });
    expect(schematicModelFor(led, 'bjt')).toBeUndefined();
    const doc = sheet();
    const r = doc.symbols.find((x) => x.id === 'sym-resistor')!;
    const p = schematicWithFootprint(part('r', 'R1', r.id, [50.8, 50.8]), r, {
      generator: 'chip',
      params: { size: '1206' },
    });
    expect(p).toMatchObject({ footprint: { generator: 'chip' }, pinMap: { '1': '1', '2': '2' } });
    expect(schematicWithFootprint(p, r, undefined)).not.toHaveProperty('pinMap');
  });

  it('TS-2104: keeps a hand-made pin map while the footprint still has its pads', () => {
    const doc = sheet();
    const r = doc.symbols.find((x) => x.id === 'sym-resistor')!;
    const header = { generator: 'pin-header', params: { rows: 1, pinsPerRow: 2 } };
    const swapped = {
      ...schematicWithFootprint(part('r', 'R1', r.id, [50.8, 50.8]), r, header),
      pinMap: { '1': '2', '2': '1' },
    };
    // A changed parameter of the same footprint keeps the map...
    const taller = { generator: 'pin-header', params: { rows: 1, pinsPerRow: 3 } };
    expect(schematicWithFootprint(swapped, r, taller, { keep: true }).pinMap).toEqual({
      '1': '2',
      '2': '1',
    });
    // ...until a pad it uses is gone; a new footprint (no `keep`) starts in order.
    const twisted = { ...swapped, pinMap: { '1': '3', '2': '1' } };
    expect(schematicWithFootprint(twisted, r, header, { keep: true }).pinMap).toEqual({
      '1': '1',
      '2': '2',
    });
    expect(schematicWithFootprint(swapped, r, taller).pinMap).toEqual({ '1': '1', '2': '2' });
  });

  it('TS-2104: a symbol whose generator values cannot be replayed still suggests its name', () => {
    const r = generateSchematicSymbol('sym-r', 'resistor');
    const odd = { ...r, generator: { kind: 'resistor', params: { tolerance: 5 } } };
    expect(schematicPartSuggestion(odd)).toEqual({ value: r.name });
  });

  it('TS-2104: sizes a chosen footprint for the symbol, so every pin gets a pad', () => {
    const sized = ['pin-header', 'soic', 'qfn', 'bga', 'fpc', 'jst-sh'];
    for (const pins of [2, 5, 16, 33, 64]) {
      const half = Math.ceil(pins / 2);
      const names = (from: number, n: number) =>
        Array.from({ length: n }, (_, i) => `P${from + i}`).join(', ');
      const ic = generateSchematicSymbol('sym-big', 'ic', {
        left: names(1, half),
        right: names(half + 1, pins - half),
      });
      for (const generator of sized) {
        // SH connectors stop at 20 pins and FPC connectors at 60.
        if ((generator === 'jst-sh' && pins > 20) || (generator === 'fpc' && pins > 60)) continue;
        const doc = sheet();
        doc.symbols.push(ic);
        doc.parts = [
          schematicWithFootprint(
            part('u', 'U1', 'sym-big', [101.6, 101.6]),
            ic,
            schematicFootprintStart(ic, generator),
          ),
        ];
        expect([pins, generator, errors(doc)]).toEqual([pins, generator, []]);
      }
    }
  });
});
