import type {
  SchematicFootprintRef,
  SchematicGraphic,
  SchematicPin,
  SchematicPinSide,
  SchematicPinType,
  SchematicSymbol,
  Vec2,
} from './model';
import { schematicPinTypes } from './model';
import { schematicDefaultModel, schematicLedColors, type SchematicModel } from './models';

/**
 * Parametric symbols (docs/cad/circuit-simulation.md, SL2). Each generator turns a few values
 * into pins and a drawing in the usual IEC style, written from the general form of each symbol
 * (not copied from any library). Every pin end is on the 1.27 mm grid; the frame's origin is the
 * symbol's centre and y points down, as on the sheet.
 *
 * A generator also suggests what a new part made from it starts with: a value, a circuit model
 * on its pins, and a footprint (a `pcb-core` generator) with the pin-to-pad map.
 */

export interface SchematicSymbolParam {
  name: string;
  label: string;
  /** An integer in [min, max], one of `options`, a boolean, or free text (`text: true`). */
  min?: number;
  max?: number;
  options?: readonly string[];
  boolean?: boolean;
  text?: boolean;
  default: number | string | boolean;
}
export type SchematicSymbolParams = Record<string, number | string | boolean>;

export interface SchematicPartSuggestion {
  value: string;
  model?: SchematicModel;
  footprint?: SchematicFootprintRef;
  /** Pin number → pad number, every pin; with `footprint` only. */
  pinMap?: Record<string, string>;
}
export interface SchematicSymbolSpec {
  kind: string;
  label: string;
  prefix: string;
  params: readonly SchematicSymbolParam[];
  make(p: Required<SchematicSymbolParams>): {
    name: string;
    pins: SchematicPin[];
    graphics: SchematicGraphic[];
  };
  suggest(p: Required<SchematicSymbolParams>): SchematicPartSuggestion;
}

export class SchematicSymbolError extends Error {
  constructor(readonly param: string) {
    super(`symbol-param:${param}`);
  }
}

const g = 1.27;
const pin = (
  number: string,
  name: string,
  at: Vec2,
  side: SchematicPinSide,
  lengthMm: number,
  type: SchematicPinType = 'passive',
): SchematicPin => ({ number, name, at, side, lengthMm, type });
const line = (...points: Vec2[]): SchematicGraphic => ({ kind: 'line', points });
/** Rounded to 1 µm; never −0, which JSON would turn into 0. */
const r3 = (v: number) => Math.round(v * 1e3) / 1e3 || 0;
const identity = (n: number) =>
  Object.fromEntries([...Array(n).keys()].map((i) => [String(i + 1), String(i + 1)]));
/** Pins 1 and 2 at ±`x` on the axis, their lines reaching the body at ±`body`. */
const twoPins = (x: number, body: number, names: [string, string] = ['~', '~']) => [
  pin('1', names[0], [-x, 0], 'right', r3(x - body)),
  pin('2', names[1], [x, 0], 'left', r3(x - body)),
];
const chip = (size = '0603') => ({ generator: 'chip', params: { size } });

/** A diode's triangle and bar, anode on the left (−x), cathode on the right. */
const diodeBody = (): SchematicGraphic[] => [
  {
    kind: 'polygon',
    points: [
      [-g, -g],
      [-g, g],
      [g, 0],
    ],
    filled: false,
  },
  line([g, -g], [g, g]),
];

const specs: SchematicSymbolSpec[] = [
  {
    kind: 'resistor',
    label: 'Resistor',
    prefix: 'R',
    params: [],
    make: () => ({
      name: 'Resistor',
      pins: twoPins(5.08, 3.81),
      graphics: [{ kind: 'rect', from: [-3.81, -1.016], to: [3.81, 1.016], filled: false }],
    }),
    suggest: () => ({
      value: '1k',
      model: schematicDefaultModel('resistor', { a: '1', b: '2' }),
      footprint: chip(),
      pinMap: identity(2),
    }),
  },
  {
    kind: 'capacitor',
    label: 'Capacitor',
    prefix: 'C',
    params: [{ name: 'polarized', label: 'Polarized', boolean: true, default: false }],
    make: (p) => ({
      name: p.polarized ? 'Capacitor (polarized)' : 'Capacitor',
      pins: twoPins(3.81, 0.508, p.polarized ? ['+', '-'] : ['~', '~']),
      graphics: [
        line([-0.508, -2.032], [-0.508, 2.032]),
        line([0.508, -2.032], [0.508, 2.032]),
        ...(p.polarized
          ? [{ kind: 'text', at: [-2.032, -1.524], text: '+', sizeMm: 1.27 } as SchematicGraphic]
          : []),
      ],
    }),
    suggest: () => ({
      value: '100n',
      model: schematicDefaultModel('capacitor', { a: '1', b: '2' }),
      footprint: chip(),
      pinMap: identity(2),
    }),
  },
  {
    kind: 'inductor',
    label: 'Inductor',
    prefix: 'L',
    params: [],
    make: () => {
      // Four half-turns from x −3.81 to 3.81, drawn as short polylines.
      const bumps: SchematicGraphic[] = [];
      for (let i = 0; i < 4; i++) {
        const x0 = -3.81 + i * 1.905;
        const pts: Vec2[] = [];
        for (let k = 0; k <= 6; k++) {
          const a = Math.PI - (k / 6) * Math.PI;
          pts.push([r3(x0 + 0.9525 + 0.9525 * Math.cos(a)), r3(-0.9525 * Math.sin(a))]);
        }
        bumps.push({ kind: 'line', points: pts });
      }
      return { name: 'Inductor', pins: twoPins(5.08, 3.81), graphics: bumps };
    },
    suggest: () => ({
      value: '10u',
      model: schematicDefaultModel('inductor', { a: '1', b: '2' }),
      footprint: chip('0805'),
      pinMap: identity(2),
    }),
  },
  {
    kind: 'diode',
    label: 'Diode',
    prefix: 'D',
    params: [],
    // Pin 1 is the cathode (right), pin 2 the anode (left), as the LED of SL1.
    make: () => ({
      name: 'Diode',
      pins: [pin('1', 'K', [5.08, 0], 'left', 3.81), pin('2', 'A', [-5.08, 0], 'right', 3.81)],
      graphics: diodeBody(),
    }),
    suggest: () => ({
      value: 'Diode',
      model: schematicDefaultModel('diode', { anode: '2', cathode: '1' }),
      footprint: chip('1206'),
      pinMap: identity(2),
    }),
  },
  {
    kind: 'led',
    label: 'LED',
    prefix: 'D',
    params: [{ name: 'color', label: 'Colour', options: schematicLedColors, default: 'red' }],
    make: (p) => ({
      name: `LED (${p.color})`,
      pins: [pin('1', 'K', [5.08, 0], 'left', 3.81), pin('2', 'A', [-5.08, 0], 'right', 3.81)],
      graphics: [
        ...diodeBody(),
        line([0, -1.778], [1.016, -2.794]),
        line([0.762, -1.524], [1.778, -2.54]),
      ],
    }),
    suggest: (p) => ({
      value: `LED ${p.color}`,
      model: {
        ...schematicDefaultModel('led', { anode: '2', cathode: '1' }),
        params: { color: String(p.color) },
      },
      footprint: chip(),
      pinMap: identity(2),
    }),
  },
  {
    kind: 'bjt',
    label: 'Bipolar transistor',
    prefix: 'Q',
    params: [{ name: 'polarity', label: 'Polarity', options: ['npn', 'pnp'], default: 'npn' }],
    // Base 1 on the left, collector 2 up, emitter 3 down; the arrow is on the emitter.
    make: (p) => {
      const npn = p.polarity === 'npn';
      const arrow: Vec2[] = npn
        ? [
            [0.635, 1.524],
            [1.27, 2.54],
            [0.127, 2.286],
          ]
        : [
            [-0.635, 0.635],
            [-0.127, 1.651],
            [0.381, 0.889],
          ];
      return {
        name: npn ? 'NPN transistor' : 'PNP transistor',
        pins: [
          pin('1', 'B', [-5.08, 0], 'right', 3.81),
          pin('2', 'C', [1.27, -5.08], 'down', 2.54),
          pin('3', 'E', [1.27, 5.08], 'up', 2.54),
        ],
        graphics: [
          line([-g, -1.905], [-g, 1.905]),
          line([-g, -0.635], [g, -2.54]),
          line([-g, 0.635], [g, 2.54]),
          { kind: 'polygon', points: arrow, filled: true },
          { kind: 'circle', center: [0, 0], radiusMm: 3.175, filled: false },
        ],
      };
    },
    suggest: (p) => ({
      value: p.polarity === 'npn' ? 'NPN' : 'PNP',
      model: {
        ...schematicDefaultModel('bjt', { base: '1', collector: '2', emitter: '3' }),
        params: { polarity: String(p.polarity), beta: 100 },
      },
    }),
  },
  {
    kind: 'mosfet',
    label: 'MOSFET',
    prefix: 'Q',
    params: [{ name: 'channel', label: 'Channel', options: ['n', 'p'], default: 'n' }],
    // Gate 1 on the left, drain 2 up, source 3 down; the arrow on the middle lead shows the channel.
    make: (p) => {
      const n = p.channel === 'n';
      return {
        name: n ? 'N-channel MOSFET' : 'P-channel MOSFET',
        pins: [
          pin('1', 'G', [-5.08, 0], 'right', 3.302),
          pin('2', 'D', [1.27, -5.08], 'down', 2.54),
          pin('3', 'S', [1.27, 5.08], 'up', 2.54),
        ],
        graphics: [
          line([-1.778, -1.905], [-1.778, 1.905]),
          line([-1.016, -2.54], [-1.016, -1.27]),
          line([-1.016, -0.635], [-1.016, 0.635]),
          line([-1.016, 1.27], [-1.016, 2.54]),
          line([-1.016, -1.905], [g, -1.905], [g, -2.54]),
          line([-1.016, 1.905], [g, 1.905], [g, 2.54]),
          line([-1.016, 0], [g, 0], [g, 1.905]),
          {
            kind: 'polygon',
            points: n
              ? [
                  [-1.016, 0],
                  [-0.254, -0.508],
                  [-0.254, 0.508],
                ]
              : [
                  [0.254, 0],
                  [-0.508, -0.508],
                  [-0.508, 0.508],
                ],
            filled: true,
          },
        ],
      };
    },
    suggest: (p) => ({
      value: p.channel === 'n' ? 'N-MOSFET' : 'P-MOSFET',
      model: {
        ...schematicDefaultModel('mosfet', { gate: '1', drain: '2', source: '3' }),
        params: {
          channel: String(p.channel),
          thresholdVolts: p.channel === 'n' ? 1.5 : -1.5,
          k: 0.1,
        },
      },
    }),
  },
  {
    kind: 'switch',
    label: 'Push button',
    prefix: 'SW',
    params: [],
    make: () => ({
      name: 'Push button',
      pins: [pin('1', '1', [-5.08, 0], 'right', 2.54), pin('2', '2', [5.08, 0], 'left', 2.54)],
      graphics: [
        { kind: 'circle', center: [-2.032, 0], radiusMm: 0.508, filled: false },
        { kind: 'circle', center: [2.032, 0], radiusMm: 0.508, filled: false },
        line([-2.54, -1.778], [2.54, -1.778]),
        line([0, -1.778], [0, -3.556]),
      ],
    }),
    suggest: () => ({
      value: 'Button',
      model: schematicDefaultModel('switch', { a: '1', b: '2' }),
      footprint: { generator: 'pin-header', params: { rows: 1, pinsPerRow: 2 } },
      pinMap: identity(2),
    }),
  },
  {
    kind: 'battery',
    label: 'Battery',
    prefix: 'BT',
    params: [],
    // + (pin 1) up, − (pin 2) down; the long plate is +.
    make: () => ({
      name: 'Battery',
      pins: [pin('1', '+', [0, -5.08], 'down', 4.572), pin('2', '-', [0, 5.08], 'up', 4.572)],
      graphics: [
        line([-2.032, -0.508], [2.032, -0.508]),
        line([-1.016, 0.508], [1.016, 0.508]),
        { kind: 'text', at: [1.524, -1.778], text: '+', sizeMm: 1.27 },
      ],
    }),
    suggest: () => ({
      value: '3V',
      model: {
        ...schematicDefaultModel('vsource', { plus: '1', minus: '2' }),
        params: { volts: 3 },
      },
      footprint: { generator: 'pin-header', params: { rows: 1, pinsPerRow: 2 } },
      pinMap: identity(2),
    }),
  },
  {
    kind: 'vsource',
    label: 'Voltage source',
    prefix: 'V',
    params: [],
    make: () => ({
      name: 'Voltage source',
      pins: [pin('1', '+', [0, -5.08], 'down', 2.54), pin('2', '-', [0, 5.08], 'up', 2.54)],
      graphics: [
        { kind: 'circle', center: [0, 0], radiusMm: 2.54, filled: false },
        { kind: 'text', at: [0, -0.889], text: '+', sizeMm: 1.27 },
        { kind: 'text', at: [0, 1.651], text: '-', sizeMm: 1.27 },
      ],
    }),
    suggest: () => ({
      value: '5V',
      model: schematicDefaultModel('vsource', { plus: '1', minus: '2' }),
    }),
  },
  {
    kind: 'isource',
    label: 'Current source',
    prefix: 'I',
    params: [],
    // The arrow points to + (pin 1): the current leaves the source there.
    make: () => ({
      name: 'Current source',
      pins: [pin('1', '+', [0, -5.08], 'down', 2.54), pin('2', '-', [0, 5.08], 'up', 2.54)],
      graphics: [
        { kind: 'circle', center: [0, 0], radiusMm: 2.54, filled: false },
        line([0, 1.524], [0, -1.016]),
        {
          kind: 'polygon',
          points: [
            [0, -1.778],
            [-0.508, -0.762],
            [0.508, -0.762],
          ],
          filled: true,
        },
      ],
    }),
    suggest: () => ({
      value: '1mA',
      model: schematicDefaultModel('isource', { plus: '1', minus: '2' }),
    }),
  },
  {
    kind: 'connector',
    label: 'Connector',
    prefix: 'J',
    params: [{ name: 'pins', label: 'Pins', min: 1, max: 64, default: 2 }],
    // One column of pins on the left, 2.54 mm apart, pin 1 at the top.
    make: (p) => {
      const n = p.pins as number;
      const top = -Math.floor((n - 1) / 2) * 2.54;
      const pins = [...Array(n).keys()].map((i) =>
        pin(String(i + 1), String(i + 1), [-5.08, r3(top + i * 2.54)], 'right', 2.54),
      );
      const y0 = r3(top - g);
      const y1 = r3(top + (n - 1) * 2.54 + g);
      return {
        name: `Connector 1×${n}`,
        pins,
        graphics: [{ kind: 'rect', from: [-2.54, y0], to: [2.54, y1], filled: false }],
      };
    },
    // A header holds at most 40 pins a row: more than 40 go on two rows (pads 1…2k).
    suggest: (p) => {
      const n = p.pins as number;
      const rows = n > 40 ? 2 : 1;
      return {
        value: `Conn 1×${n}`,
        footprint: { generator: 'pin-header', params: { rows, pinsPerRow: Math.ceil(n / rows) } },
        pinMap: identity(n),
      };
    },
  },
  {
    kind: 'ic',
    label: 'IC (box)',
    prefix: 'U',
    params: [
      { name: 'name', label: 'Name', text: true, default: 'IC' },
      { name: 'left', label: 'Left pins', text: true, default: 'IN' },
      { name: 'right', label: 'Right pins', text: true, default: 'OUT:output' },
    ],
    /**
     * `left` and `right` list pin names top to bottom, comma separated, each optionally with its
     * electrical type after a colon ("VCC:power-in, SDA:bidirectional"); the default type is
     * `bidirectional`. Pins are numbered down the left side, then down the right side.
     */
    make: (p) => {
      const side = (key: 'left' | 'right') => {
        const text = String(p[key]).trim();
        if (!text) return [];
        return text.split(',').map((item) => {
          const [name, type = 'bidirectional', extra] = item.split(':').map((s) => s.trim());
          if (!name || extra !== undefined || !schematicPinTypes.includes(type as SchematicPinType))
            throw new SchematicSymbolError(key);
          return { name, type: type as SchematicPinType };
        });
      };
      const left = side('left');
      const right = side('right');
      const rows = Math.max(left.length, right.length, 1);
      if (left.length + right.length === 0) throw new SchematicSymbolError('left');
      if (rows > 64) throw new SchematicSymbolError(left.length > 64 ? 'left' : 'right');
      const top = -Math.floor((rows - 1) / 2) * 2.54;
      const pins: SchematicPin[] = [];
      left.forEach((q, i) =>
        pins.push(
          pin(String(pins.length + 1), q.name, [-10.16, r3(top + i * 2.54)], 'right', 2.54, q.type),
        ),
      );
      right.forEach((q, i) =>
        pins.push(
          pin(String(pins.length + 1), q.name, [10.16, r3(top + i * 2.54)], 'left', 2.54, q.type),
        ),
      );
      const y0 = r3(top - 2.54);
      const y1 = r3(top + (rows - 1) * 2.54 + 2.54);
      return {
        name: String(p.name),
        pins,
        graphics: [
          { kind: 'rect', from: [-7.62, y0], to: [7.62, y1], filled: false },
          { kind: 'text', at: [0, r3(y0 - 1.27)], text: String(p.name), sizeMm: 1.27 },
        ],
      };
    },
    suggest: (p) => ({ value: String(p.name) }),
  },
];

/** The built-in symbol generators by kind. */
export const schematicSymbolSpecs: ReadonlyMap<string, SchematicSymbolSpec> = new Map(
  specs.map((s) => [s.kind, s]),
);

/** `params` checked and completed with the defaults; throws `SchematicSymbolError` naming a bad one. */
export function schematicSymbolParams(
  kind: string,
  params: SchematicSymbolParams = {},
): Required<SchematicSymbolParams> {
  const spec = schematicSymbolSpecs.get(kind);
  if (!spec) throw new SchematicSymbolError('kind');
  for (const k of Object.keys(params))
    if (!spec.params.some((p) => p.name === k)) throw new SchematicSymbolError(k);
  const out: Required<SchematicSymbolParams> = {};
  for (const p of spec.params) {
    const v = Object.hasOwn(params, p.name) ? params[p.name] : p.default;
    const ok = p.boolean
      ? typeof v === 'boolean'
      : p.options
        ? typeof v === 'string' && p.options.includes(v)
        : p.text
          ? typeof v === 'string' && [...v].length <= 256 && !/\p{Cc}/u.test(v)
          : typeof v === 'number' && Number.isInteger(v) && v >= p.min! && v <= p.max!;
    if (!ok) throw new SchematicSymbolError(p.name);
    out[p.name] = v;
  }
  return out;
}

/** A symbol from a generator, with its `generator` kept so it can be made again. */
export function generateSchematicSymbol(
  id: string,
  kind: string,
  params: SchematicSymbolParams = {},
): SchematicSymbol {
  const p = schematicSymbolParams(kind, params);
  const spec = schematicSymbolSpecs.get(kind)!;
  const made = spec.make(p);
  return { id, prefix: spec.prefix, ...made, generator: { kind, params: p } };
}

/** What a new part of a generated symbol starts with (value, model, footprint, pin map). */
export function schematicPartSuggestion(symbol: SchematicSymbol): SchematicPartSuggestion {
  const g = symbol.generator;
  const spec = g && schematicSymbolSpecs.get(g.kind);
  if (!g || !spec) return { value: symbol.name };
  try {
    return spec.suggest(schematicSymbolParams(g.kind, g.params));
  } catch {
    // Generator values this version cannot replay (an imported document): the drawn symbol is
    // still placeable, with only its name.
    return { value: symbol.name };
  }
}

/** One symbol of each generator with its defaults, IDs `sym-<kind>`: a library to place from. */
export function schematicSymbolLibrary(): SchematicSymbol[] {
  return specs.map((s) => generateSchematicSymbol(`sym-${s.kind}`, s.kind));
}
