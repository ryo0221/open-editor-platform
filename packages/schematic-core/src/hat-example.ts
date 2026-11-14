import { pcbGpioPins } from '@editor-platform/pcb-core';
import { fromGrid, partGridPoint, toGrid } from './geometry';
import type {
  SchematicDocument,
  SchematicFootprintRef,
  SchematicLabel,
  SchematicPart,
  SchematicPinSide,
  SchematicPower,
  SchematicSymbol,
  SchematicWire,
  Vec2,
} from './model';
import { schematicStarter } from './fixtures';
import type { SchematicModel } from './models';
import { generateSchematicSymbol } from './symbols';

/**
 * F90 (docs/cad/circuit-simulation.md, SL8, L1): the schematic of the project's own sensor HAT+
 * (F76, `f76HatBoard`), written for this project: the 40-pin GPIO header J1, the ID EEPROM U1
 * with its pull-ups R1/R2 and write protect R3/TP1, the I²C sensor U2, decoupling C1/C2, the LED
 * D1 through R4 from GPIO17 and the button SW1 from GPIO27 to ground. Values, footprints and pad
 * numbers follow the board, so sending it to F76 changes nothing. R4, D1 and SW1 carry circuit
 * models (the LED circuit the ladder drives); the rest is left out of the calculation.
 *
 * Every pin ends in a short wire to a net label or a power port; header pins the board does not
 * use are marked not connected.
 */
export function schematicHatExample(): SchematicDocument {
  const doc = schematicStarter();
  doc.sheet = { size: 'A3', orientation: 'landscape', title: 'Sensor HAT+ (F76)' };
  const symbols: SchematicSymbol[] = [
    generateSchematicSymbol('sym-j40', 'connector', { pins: 40 }),
    generateSchematicSymbol('sym-24c32', 'ic', {
      name: '24C32',
      left: 'A0:passive, A1:passive, A2:passive, VSS:power-in',
      right: 'SDA:bidirectional, SCL:input, WP:input, VCC:power-in',
    }),
    generateSchematicSymbol('sym-sensor', 'ic', {
      name: 'T/RH sensor',
      left: 'SCL:input, GND:power-in, SDA:bidirectional',
      right: 'NC:passive, VDD:power-in, NC:passive',
    }),
    generateSchematicSymbol('sym-led-green', 'led', { color: 'green' }),
    generateSchematicSymbol('sym-tp', 'connector', { pins: 1 }),
  ];
  doc.symbols.push(...symbols);
  const chip: SchematicFootprintRef = { generator: 'chip', params: { size: '0603' } };
  const identity = (n: number) =>
    Object.fromEntries([...Array(n).keys()].map((i) => [String(i + 1), String(i + 1)]));
  const part = (
    id: string,
    ref: string,
    value: string,
    symbol: string,
    at: Vec2,
    footprint: SchematicFootprintRef,
    pins: number,
    extra: Partial<SchematicPart> = {},
  ): SchematicPart => ({
    id,
    ref,
    value,
    symbol,
    at,
    rotationDeg: 0,
    mirror: false,
    footprint,
    pinMap: identity(pins),
    ...extra,
  });
  const used = new Set<number>([
    ...pcbGpioPins.power3v3,
    ...pcbGpioPins.ground,
    pcbGpioPins.idSd,
    pcbGpioPins.idSc,
    3,
    5,
    11,
    13,
  ]);
  const model = (m: SchematicModel) => ({ model: m });
  doc.parts = [
    part(
      'j1',
      'J1',
      '2×20 socket',
      'sym-j40',
      [63.5, 114.3],
      { generator: 'pin-header', params: { rows: 2, pinsPerRow: 20 } },
      40,
      {
        noConnect: [...Array(40).keys()]
          .map((i) => i + 1)
          .filter((n) => !used.has(n))
          .map(String),
      },
    ),
    part(
      'u1',
      'U1',
      '24C32 EEPROM (ID, 0x50)',
      'sym-24c32',
      [190.5, 76.2],
      { generator: 'soic', params: { pins: 8, bodyWidth: 3.6 } },
      8,
    ),
    part(
      'u2',
      'U2',
      'T/RH sensor, I²C 0x44',
      'sym-sensor',
      [190.5, 139.7],
      {
        generator: 'soic',
        params: { pins: 6, pitch: 0.95, span: 2.6, bodyWidth: 1.5, padLength: 0.9, height: 1.1 },
      },
      6,
      { noConnect: ['4', '6'] },
    ),
    part('c1', 'C1', '100 nF', 'sym-capacitor', [266.7, 63.5], chip, 2),
    part('c2', 'C2', '100 nF', 'sym-capacitor', [266.7, 139.7], chip, 2),
    part('r1', 'R1', '3.9 kΩ', 'sym-resistor', [266.7, 82.55], chip, 2),
    part('r2', 'R2', '3.9 kΩ', 'sym-resistor', [266.7, 95.25], chip, 2),
    part('r3', 'R3', '1 kΩ', 'sym-resistor', [266.7, 107.95], chip, 2),
    part(
      'r4',
      'R4',
      '330 Ω',
      'sym-resistor',
      [180.34, 190.5],
      chip,
      2,
      model({ kind: 'resistor', terminals: { a: '1', b: '2' }, params: { ohms: 330 } }),
    ),
    part('d1', 'D1', 'LED green', 'sym-led-green', [165.1, 190.5], chip, 2, {
      // Mirrored: the anode faces R4, so GPIO17 → R4 → D1 → GND reads as one line.
      mirror: true,
      model: {
        kind: 'led',
        terminals: { anode: '2', cathode: '1' },
        params: { color: 'green' },
      },
    }),
    part(
      'sw1',
      'SW1',
      'Button',
      'sym-switch',
      [180.34, 215.9],
      { generator: 'pin-header', params: { rows: 1, pinsPerRow: 2 } },
      2,
      model({
        kind: 'switch',
        terminals: { a: '1', b: '2' },
        params: { closedOhms: 0.05, openOhms: 1e9 },
      }),
    ),
    part(
      'tp1',
      'TP1',
      'WP',
      'sym-tp',
      [325.12, 107.95],
      { generator: 'pin-header', params: { rows: 1, pinsPerRow: 1 } },
      1,
    ),
  ];

  // Pin → net, as the board's net list (F76) has it.
  const nets: Record<string, Record<string, string>> = {
    j1: {
      ...Object.fromEntries(pcbGpioPins.power3v3.map((n) => [String(n), '3V3'])),
      ...Object.fromEntries(pcbGpioPins.ground.map((n) => [String(n), 'GND'])),
      [String(pcbGpioPins.idSd)]: 'ID_SD',
      [String(pcbGpioPins.idSc)]: 'ID_SC',
      3: 'SDA1',
      5: 'SCL1',
      11: 'GPIO17',
      13: 'GPIO27',
    },
    u1: {
      1: 'GND',
      2: 'GND',
      3: 'GND',
      4: 'GND',
      5: 'ID_SD',
      6: 'ID_SC',
      7: 'EEPROM_WP',
      8: '3V3',
    },
    u2: { 1: 'SCL1', 2: 'GND', 3: 'SDA1', 5: '3V3' },
    c1: { 1: '3V3', 2: 'GND' },
    c2: { 1: '3V3', 2: 'GND' },
    r1: { 1: '3V3', 2: 'ID_SD' },
    r2: { 1: '3V3', 2: 'ID_SC' },
    r3: { 1: 'EEPROM_WP', 2: '3V3' },
    r4: { 1: 'LED_A', 2: 'GPIO17' },
    d1: { 1: 'GND', 2: 'LED_A' },
    sw1: { 1: 'GPIO27', 2: 'GND' },
    tp1: { 1: 'EEPROM_WP' },
  };
  const out: Record<SchematicPinSide, [number, number]> = {
    left: [1, 0],
    right: [-1, 0],
    up: [0, 1],
    down: [0, -1],
  };
  const bySymbol = new Map(doc.symbols.map((s) => [s.id, s]));
  const wires: SchematicWire[] = [];
  const labels: SchematicLabel[] = [];
  const powers: SchematicPower[] = [];
  const pinEnd = (id: string, number: string) => {
    const p = doc.parts.find((x) => x.id === id)!;
    return partGridPoint(
      p,
      toGrid(bySymbol.get(p.symbol)!.pins.find((q) => q.number === number)!.at),
    );
  };
  // D1's anode straight to R4, with the LED_A label on a short branch up from the middle.
  const anode = pinEnd('d1', '2');
  const r4a = pinEnd('r4', '1');
  const mid: [number, number] = [(anode[0] + r4a[0]) / 2, anode[1]];
  const up: [number, number] = [mid[0], mid[1] - 4];
  wires.push(
    { id: 'w-led-a1', points: [fromGrid(anode), fromGrid(mid)] },
    { id: 'w-led-a2', points: [fromGrid(mid), fromGrid(r4a)] },
    { id: 'w-led-a3', points: [fromGrid(mid), fromGrid(up)] },
  );
  doc.junctions = [{ id: 'jn-led-a', at: fromGrid(mid) }];
  labels.push({ id: 'l-led-a', name: 'LED_A', at: fromGrid(up), rotationDeg: 0 });
  const direct = new Set(['d1-2', 'r4-1']);
  for (const p of doc.parts) {
    const symbol = bySymbol.get(p.symbol)!;
    for (const pin of symbol.pins) {
      const net = nets[p.id]?.[pin.number];
      if (!net || direct.has(`${p.id}-${pin.number}`)) continue;
      const end = partGridPoint(p, toGrid(pin.at));
      const [sx, dy] = out[pin.side];
      const dx = p.mirror ? -sx : sx;
      // Two grid steps out; a power port's symbol needs room beyond the wire.
      const steps = net === 'GND' || net === '3V3' ? 4 : 2;
      const tip = fromGrid([end[0] + dx * steps, end[1] + dy * steps]);
      const at = fromGrid(end);
      const id = `${p.id}-${pin.number}`;
      wires.push({ id: `w-${id}`, points: [at, tip] });
      if (net === 'GND')
        powers.push({ id: `p-${id}`, name: 'GND', at: tip, rotationDeg: 0, style: 'ground' });
      else if (net === '3V3')
        powers.push({ id: `p-${id}`, name: '3V3', at: tip, rotationDeg: 180, style: 'rail' });
      else labels.push({ id: `l-${id}`, name: net, at: tip, rotationDeg: 0 });
    }
  }
  doc.wires = wires;
  doc.labels = labels;
  doc.powers = powers;
  return doc;
}
