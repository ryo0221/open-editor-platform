import { roundedRectLoop } from './geometry';
import type { PcbFootprint, PcbPad, PcbSilk, Vec2 } from './model';

/**
 * Parametric footprints (PB2, PCB-U5): each generator turns a few numbers into pads, silkscreen,
 * a courtyard and a body height. The shapes are generic, written from the general form of each
 * package type, not copied from any maker's drawing. Frames:
 * - pin headers: origin at pin 1, pins along +x, the second row at +y;
 * - chips and ICs: origin at the body's centre, pin 1 at the upper left;
 * - edge connectors: origin at the middle of the mating face, which faces −y (place at a
 *   board edge and turn so −y points off the board).
 */

export interface PcbGeneratorParam {
  name: string;
  label: string;
  /** A number in [min, max] (integers when `step` is 1), or one of `options`. */
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  default: number | string;
}
export interface PcbGeneratorSpec {
  kind: string;
  label: string;
  /** The reference designator's letters for parts made from it ("J", "U", "R"). */
  refPrefix: string;
  params: readonly PcbGeneratorParam[];
  make(params: Record<string, number | string>): Omit<PcbFootprint, 'id'>;
}

export class PcbGeneratorError extends Error {
  constructor(readonly param: string) {
    super(`generator-param:${param}`);
  }
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const pt = (x: number, y: number): Vec2 => [r4(x), r4(y)];
function smd(
  number: string | number,
  at: Vec2,
  size: Vec2,
  shape: PcbPad['shape'] = 'roundrect',
): PcbPad {
  return {
    number: String(number),
    type: 'smd',
    shape,
    at: pt(at[0], at[1]),
    size: pt(size[0], size[1]),
    rotationDeg: 0,
    ...(shape === 'roundrect' ? { roundness: 0.25 } : {}),
  };
}
function thru(
  number: string | number,
  at: Vec2,
  size: number | Vec2,
  drill: number,
  shape: PcbPad['shape'] = 'circle',
  type: 'thru' | 'npth' = 'thru',
): PcbPad {
  const s: Vec2 = typeof size === 'number' ? [size, size] : size;
  return {
    number: String(number),
    type,
    shape,
    at: pt(at[0], at[1]),
    size: pt(s[0], s[1]),
    rotationDeg: 0,
    drillMm: drill,
    ...(shape === 'roundrect' ? { roundness: 0.25 } : {}),
  };
}
const line = (from: Vec2, to: Vec2, widthMm = 0.15): PcbSilk => ({
  kind: 'line',
  from: pt(from[0], from[1]),
  to: pt(to[0], to[1]),
  widthMm,
});
const dot = (center: Vec2, radiusMm = 0.2): PcbSilk => ({
  kind: 'circle',
  center: pt(center[0], center[1]),
  radiusMm,
  widthMm: 0.1,
  filled: true,
});
/** The four sides of an axis-aligned box from (x0, y0) to (x1, y1). */
const box = (x0: number, y0: number, x1: number, y1: number): PcbSilk[] => [
  line([x0, y0], [x1, y0]),
  line([x1, y0], [x1, y1]),
  line([x1, y1], [x0, y1]),
  line([x0, y1], [x0, y0]),
];
/** A rectangular courtyard around the body and every pad, with a margin. */
function courtyard(pads: PcbPad[], body: [number, number, number, number], margin = 0.25) {
  let [x0, y0, x1, y1] = body;
  for (const p of pads) {
    const [w, h] = p.rotationDeg % 180 ? [p.size[1], p.size[0]] : p.size;
    x0 = Math.min(x0, p.at[0] - w / 2);
    x1 = Math.max(x1, p.at[0] + w / 2);
    y0 = Math.min(y0, p.at[1] - h / 2);
    y1 = Math.max(y1, p.at[1] + h / 2);
  }
  return roundedRectLoop(
    pt(x0 - margin, y0 - margin),
    r4(x1 - x0 + 2 * margin),
    r4(y1 - y0 + 2 * margin),
    0,
  );
}

function num(params: Record<string, number | string>, spec: PcbGeneratorParam): number | string {
  const v = params[spec.name] ?? spec.default;
  if (spec.options) {
    if (typeof v !== 'string' || !spec.options.includes(v)) throw new PcbGeneratorError(spec.name);
    return v;
  }
  if (
    typeof v !== 'number' ||
    !Number.isFinite(v) ||
    v < (spec.min ?? -Infinity) ||
    v > (spec.max ?? Infinity) ||
    (spec.step === 1 && !Number.isInteger(v))
  )
    throw new PcbGeneratorError(spec.name);
  return v;
}
function reader(specs: readonly PcbGeneratorParam[], params: Record<string, number | string>) {
  const known = new Set(specs.map((s) => s.name));
  for (const k of Object.keys(params)) if (!known.has(k)) throw new PcbGeneratorError(k);
  const values = Object.fromEntries(specs.map((s) => [s.name, num(params, s)]));
  return {
    n: (k: string) => values[k] as number,
    s: (k: string) => values[k] as string,
    all: values,
  };
}

/** Letters for BGA rows, skipping I, O, Q, S, X and Z. */
const bgaRows = 'ABCDEFGHJKLMNPRTUVWY';
const bgaRow = (i: number) =>
  i < bgaRows.length
    ? bgaRows[i]
    : bgaRows[Math.floor(i / bgaRows.length) - 1] + bgaRows[i % bgaRows.length];

/** Chip sizes (EIA inch codes): body, pad, pad pitch and height, mm. */
export const pcbChipSizes: Record<string, { body: Vec2; pad: Vec2; pitch: number; h: number }> = {
  '0402': { body: [1.0, 0.5], pad: [0.6, 0.6], pitch: 1.0, h: 0.35 },
  '0603': { body: [1.6, 0.8], pad: [0.9, 0.95], pitch: 1.6, h: 0.45 },
  '0805': { body: [2.0, 1.25], pad: [1.0, 1.45], pitch: 1.9, h: 0.5 },
  '1206': { body: [3.2, 1.6], pad: [1.15, 1.8], pitch: 3.0, h: 0.6 },
};

const specs: PcbGeneratorSpec[] = [
  {
    kind: 'pin-header',
    label: 'Pin header (2.54 mm)',
    refPrefix: 'J',
    params: [
      { name: 'rows', label: 'Rows', min: 1, max: 2, step: 1, default: 2 },
      { name: 'pinsPerRow', label: 'Pins per row', min: 1, max: 40, step: 1, default: 20 },
      { name: 'pitch', label: 'Pitch (mm)', min: 1, max: 5.08, default: 2.54 },
      { name: 'drill', label: 'Drill (mm)', min: 0.6, max: 1.5, default: 1.0 },
      { name: 'pad', label: 'Pad (mm)', min: 1, max: 2.5, default: 1.7 },
      { name: 'height', label: 'Height (mm)', min: 2, max: 20, default: 8.5 },
    ],
    make(params) {
      const p = reader(this.params, params);
      const pitch = p.n('pitch');
      const rows = p.n('rows');
      const count = rows * p.n('pinsPerRow');
      if (p.n('pad') >= pitch) throw new PcbGeneratorError('pad');
      if (p.n('drill') >= p.n('pad')) throw new PcbGeneratorError('drill');
      const pads = Array.from({ length: count }, (_, i) => {
        const col = rows === 2 ? Math.floor(i / 2) : i;
        const row = rows === 2 ? i % 2 : 0;
        return thru(
          i + 1,
          [col * pitch, row * pitch],
          p.n('pad'),
          p.n('drill'),
          i === 0 ? 'rect' : 'circle',
        );
      });
      const half = pitch / 2;
      const body: [number, number, number, number] = [
        -half,
        -half,
        (p.n('pinsPerRow') - 1) * pitch + half,
        (rows - 1) * pitch + half,
      ];
      return {
        name: `Pin header ${rows}×${p.n('pinsPerRow')} ${pitch} mm`,
        pads,
        silk: [...box(...body), dot([-half - 0.5, 0])],
        courtyard: courtyard(pads, body),
        heightMm: p.n('height'),
        generator: { kind: 'pin-header', params: p.all },
      };
    },
  },
  {
    kind: 'chip',
    label: 'Chip resistor / capacitor / LED',
    refPrefix: 'R',
    params: [{ name: 'size', label: 'Size', options: Object.keys(pcbChipSizes), default: '0603' }],
    make(params) {
      const p = reader(this.params, params);
      const c = pcbChipSizes[p.s('size')];
      const x = c.pitch / 2;
      const pads = [smd(1, [-x, 0], c.pad), smd(2, [x, 0], c.pad)];
      const body: [number, number, number, number] = [
        -c.body[0] / 2,
        -c.body[1] / 2,
        c.body[0] / 2,
        c.body[1] / 2,
      ];
      const gap = x - c.pad[0] / 2 - 0.15;
      return {
        name: `Chip ${p.s('size')}`,
        pads,
        silk:
          gap > 0.1
            ? [
                line([-gap, c.body[1] / 2 + 0.15], [gap, c.body[1] / 2 + 0.15]),
                line([-gap, -c.body[1] / 2 - 0.15], [gap, -c.body[1] / 2 - 0.15]),
              ]
            : [],
        courtyard: courtyard(pads, body),
        heightMm: c.h,
        generator: { kind: 'chip', params: p.all },
      };
    },
  },
  {
    kind: 'soic',
    label: 'SOIC / SOP',
    refPrefix: 'U',
    params: [
      { name: 'pins', label: 'Pins', min: 4, max: 64, step: 1, default: 8 },
      { name: 'pitch', label: 'Pitch (mm)', min: 0.4, max: 2.54, default: 1.27 },
      { name: 'span', label: 'Pad span (mm)', min: 2, max: 20, default: 5.4 },
      { name: 'bodyWidth', label: 'Body width (mm)', min: 1, max: 15, default: 3.9 },
      { name: 'padLength', label: 'Pad length (mm)', min: 0.3, max: 3, default: 1.55 },
      { name: 'height', label: 'Height (mm)', min: 0.5, max: 5, default: 1.75 },
    ],
    make(params) {
      const p = reader(this.params, params);
      const pins = p.n('pins');
      if (pins % 2) throw new PcbGeneratorError('pins');
      if (p.n('bodyWidth') >= p.n('span')) throw new PcbGeneratorError('bodyWidth');
      if (p.n('padLength') >= p.n('span')) throw new PcbGeneratorError('padLength');
      const side = pins / 2;
      const pitch = p.n('pitch');
      const w = pitch * 0.47;
      const x = p.n('span') / 2;
      const y0 = ((side - 1) * pitch) / 2;
      const pads = Array.from({ length: pins }, (_, i) =>
        i < side
          ? smd(i + 1, [-x, y0 - i * pitch], [p.n('padLength'), w])
          : smd(i + 1, [x, -y0 + (i - side) * pitch], [p.n('padLength'), w]),
      );
      const bx = p.n('bodyWidth') / 2;
      const by = y0 + pitch / 2 + 0.2;
      const body: [number, number, number, number] = [-bx, -by, bx, by];
      return {
        name: `SOIC-${pins} ${pitch} mm`,
        pads,
        silk: [...box(...body), dot([-bx + 0.5, by - 0.5])],
        courtyard: courtyard(pads, body),
        heightMm: p.n('height'),
        generator: { kind: 'soic', params: p.all },
      };
    },
  },
  {
    kind: 'qfn',
    label: 'QFN / QFP',
    refPrefix: 'U',
    params: [
      { name: 'size', label: 'Body (mm)', min: 1.5, max: 30, default: 5 },
      { name: 'pinsPerSide', label: 'Pins per side', min: 2, max: 50, step: 1, default: 8 },
      { name: 'pitch', label: 'Pitch (mm)', min: 0.3, max: 1.27, default: 0.5 },
      { name: 'padLength', label: 'Pad length (mm)', min: 0.2, max: 3, default: 0.8 },
      { name: 'exposedPad', label: 'Exposed pad (mm, 0 = none)', min: 0, max: 25, default: 3.2 },
      { name: 'height', label: 'Height (mm)', min: 0.3, max: 5, default: 0.9 },
    ],
    make(params) {
      const p = reader(this.params, params);
      const n = p.n('pinsPerSide');
      const pitch = p.n('pitch');
      const half = p.n('size') / 2;
      const len = p.n('padLength');
      const w = pitch * 0.5;
      // Pads reach 0.2 mm past the body's edge.
      const c = half - len / 2 + 0.2;
      const first = ((n - 1) * pitch) / 2;
      // The corner pads of two sides must stay apart.
      if (first + w / 2 + 0.02 > c - len / 2) throw new PcbGeneratorError('pinsPerSide');
      if (p.n('exposedPad') / 2 + 0.2 > c - len / 2) throw new PcbGeneratorError('exposedPad');
      const pads: PcbPad[] = [];
      for (let side = 0; side < 4; side++)
        for (let k = 0; k < n; k++) {
          const t = first - k * pitch;
          // Counter-clockwise from the top of the left side.
          const [at, size]: [Vec2, Vec2] =
            side === 0
              ? [
                  [-c, t],
                  [len, w],
                ]
              : side === 1
                ? [
                    [-t, -c],
                    [w, len],
                  ]
                : side === 2
                  ? [
                      [c, -t],
                      [len, w],
                    ]
                  : [
                      [t, c],
                      [w, len],
                    ];
          pads.push(smd(side * n + k + 1, at, size));
        }
      if (p.n('exposedPad') > 0)
        pads.push(smd('EP', [0, 0], [p.n('exposedPad'), p.n('exposedPad')], 'rect'));
      const body: [number, number, number, number] = [-half, -half, half, half];
      return {
        name: `QFN-${4 * n} ${p.n('size')} mm`,
        pads,
        silk: [
          line([-half, half], [-half + 0.6, half]),
          line([half - 0.6, half], [half, half]),
          line([half, half], [half, half - 0.6]),
          line([half, -half + 0.6], [half, -half]),
          line([half, -half], [half - 0.6, -half]),
          line([-half + 0.6, -half], [-half, -half]),
          line([-half, -half], [-half, -half + 0.6]),
          dot([-half - 0.4, half + 0.4]),
        ],
        courtyard: courtyard(pads, body),
        heightMm: p.n('height'),
        generator: { kind: 'qfn', params: p.all },
      };
    },
  },
  {
    kind: 'bga',
    label: 'BGA',
    refPrefix: 'U',
    params: [
      { name: 'rows', label: 'Rows', min: 2, max: 40, step: 1, default: 10 },
      { name: 'cols', label: 'Columns', min: 2, max: 40, step: 1, default: 10 },
      { name: 'pitch', label: 'Pitch (mm)', min: 0.3, max: 1.5, default: 0.8 },
      { name: 'ball', label: 'Pad Ø (mm)', min: 0.15, max: 1, default: 0.4 },
      { name: 'bodyX', label: 'Body x (mm)', min: 2, max: 50, default: 10 },
      { name: 'bodyY', label: 'Body y (mm)', min: 2, max: 50, default: 10 },
      { name: 'height', label: 'Height (mm)', min: 0.3, max: 5, default: 1.2 },
    ],
    make(params) {
      const p = reader(this.params, params);
      const pitch = p.n('pitch');
      if (p.n('ball') >= pitch * 0.9) throw new PcbGeneratorError('ball');
      const sx = ((p.n('cols') - 1) * pitch) / 2;
      const sy = ((p.n('rows') - 1) * pitch) / 2;
      if (sx * 2 + pitch > p.n('bodyX') || sy * 2 + pitch > p.n('bodyY'))
        throw new PcbGeneratorError('pitch');
      const pads: PcbPad[] = [];
      for (let r = 0; r < p.n('rows'); r++)
        for (let k = 0; k < p.n('cols'); k++)
          pads.push(
            smd(
              `${bgaRow(r)}${k + 1}`,
              [-sx + k * pitch, sy - r * pitch],
              [p.n('ball'), p.n('ball')],
              'circle',
            ),
          );
      const bx = p.n('bodyX') / 2;
      const by = p.n('bodyY') / 2;
      const body: [number, number, number, number] = [-bx, -by, bx, by];
      return {
        name: `BGA ${p.n('rows')}×${p.n('cols')} ${pitch} mm`,
        pads,
        silk: [...box(...body), dot([-bx - 0.5, by + 0.5])],
        courtyard: courtyard(pads, body, 0.5),
        heightMm: p.n('height'),
        generator: { kind: 'bga', params: p.all },
      };
    },
  },
  {
    kind: 'fpc',
    label: 'FPC connector',
    refPrefix: 'J',
    params: [
      { name: 'pins', label: 'Pins', min: 4, max: 60, step: 1, default: 22 },
      { name: 'pitch', label: 'Pitch (mm)', min: 0.3, max: 1.0, default: 0.5 },
      { name: 'height', label: 'Height (mm)', min: 0.8, max: 5, default: 1.2 },
    ],
    make(params) {
      const p = reader(this.params, params);
      const n = p.n('pins');
      const pitch = p.n('pitch');
      const span = (n - 1) * pitch;
      const pads = Array.from({ length: n }, (_, i) =>
        smd(i + 1, [-span / 2 + i * pitch, 3.6], [pitch * 0.55, 1.2], 'rect'),
      );
      pads.push(smd('MP1', [-span / 2 - 1.6, 1.2], [1.6, 2.2], 'rect'));
      pads.push(smd('MP2', [span / 2 + 1.6, 1.2], [1.6, 2.2], 'rect'));
      const bx = span / 2 + 1.8;
      const body: [number, number, number, number] = [-bx, 0, bx, 4.2];
      return {
        name: `FPC ${n}-pin ${pitch} mm`,
        pads,
        silk: [line([-bx, 0], [bx, 0]), dot([-span / 2 - 0.6, 4.6])],
        courtyard: courtyard(pads, body),
        heightMm: p.n('height'),
        generator: { kind: 'fpc', params: p.all },
      };
    },
  },
  {
    kind: 'jst-sh',
    label: 'Wire-to-board 1.0 mm (SH style)',
    refPrefix: 'J',
    params: [{ name: 'pins', label: 'Pins', min: 2, max: 20, step: 1, default: 4 }],
    make(params) {
      const p = reader(this.params, params);
      const n = p.n('pins');
      const span = n - 1;
      const pads = Array.from({ length: n }, (_, i) =>
        smd(i + 1, [-span / 2 + i, 3.4], [0.6, 1.55], 'rect'),
      );
      pads.push(smd('MP1', [-span / 2 - 1.8, 0.9], [1.2, 1.8], 'rect'));
      pads.push(smd('MP2', [span / 2 + 1.8, 0.9], [1.2, 1.8], 'rect'));
      const bx = span / 2 + 1.5;
      const body: [number, number, number, number] = [-bx, 0, bx, 4.25];
      return {
        name: `SH ${n}-pin 1.0 mm`,
        pads,
        silk: [...box(...body)],
        courtyard: courtyard(pads, body),
        heightMm: 2.9,
        generator: { kind: 'jst-sh', params: p.all },
      };
    },
  },
  {
    kind: 'usb-c',
    label: 'USB-C receptacle',
    refPrefix: 'J',
    params: [],
    make(params) {
      const p = reader(this.params, params);
      const pads: PcbPad[] = Array.from({ length: 12 }, (_, i) =>
        smd(`A${i + 1}`, [-2.75 + i * 0.5, 7.0], [0.3, 1.1], 'rect'),
      );
      for (const [i, [x, y]] of (
        [
          [-4.32, 6.0],
          [4.32, 6.0],
          [-4.32, 2.0],
          [4.32, 2.0],
        ] as const
      ).entries())
        pads.push(thru(`S${i + 1}`, [x, y], [1.0, 1.8], 0.6, 'oval'));
      const body: [number, number, number, number] = [-4.47, 0, 4.47, 7.35];
      return {
        name: 'USB-C receptacle',
        pads,
        silk: [line([-4.47, 0], [4.47, 0])],
        courtyard: courtyard(pads, body),
        heightMm: 3.2,
        generator: { kind: 'usb-c', params: p.all },
      };
    },
  },
  {
    kind: 'micro-hdmi',
    label: 'Micro HDMI receptacle',
    refPrefix: 'J',
    params: [],
    make(params) {
      const p = reader(this.params, params);
      const pads: PcbPad[] = Array.from({ length: 19 }, (_, i) =>
        smd(i + 1, [-3.6 + i * 0.4, i % 2 ? 5.9 : 6.6], [0.23, 0.8], 'rect'),
      );
      for (const [i, [x, y]] of (
        [
          [-3.6, 1.6],
          [3.6, 1.6],
        ] as const
      ).entries())
        pads.push(thru(`S${i + 1}`, [x, y], [1.2, 1.8], 0.7, 'oval'));
      const body: [number, number, number, number] = [-3.75, 0, 3.75, 6.6];
      return {
        name: 'Micro HDMI receptacle',
        pads,
        silk: [line([-3.75, 0], [3.75, 0])],
        courtyard: courtyard(pads, body),
        heightMm: 3.5,
        generator: { kind: 'micro-hdmi', params: p.all },
      };
    },
  },
  {
    kind: 'usb-a-stack',
    label: 'USB-A receptacle, two stacked',
    refPrefix: 'J',
    params: [],
    make(params) {
      const p = reader(this.params, params);
      const pads: PcbPad[] = [];
      for (let port = 0; port < 2; port++)
        for (let k = 0; k < 4; k++)
          pads.push(
            thru(port * 4 + k + 1, [-3.5 + k * 2.5 - 0.25 * port, 10.2 + port * 2.6], 1.5, 0.9),
          );
      for (const [i, [x, y]] of (
        [
          [-6.57, 6.0],
          [6.57, 6.0],
        ] as const
      ).entries())
        pads.push(thru(`S${i + 1}`, [x, y], 3.0, 2.3));
      const body: [number, number, number, number] = [-7.25, -2, 7.25, 15.5];
      return {
        name: 'USB-A ×2 stacked',
        pads,
        silk: [...box(-7.25, 0, 7.25, 15.5)],
        courtyard: courtyard(pads, body),
        heightMm: 16,
        generator: { kind: 'usb-a-stack', params: p.all },
      };
    },
  },
  {
    kind: 'rj45',
    label: 'RJ45 jack',
    refPrefix: 'J',
    params: [],
    make(params) {
      const p = reader(this.params, params);
      const pads: PcbPad[] = Array.from({ length: 8 }, (_, i) =>
        thru(
          i + 1,
          [-3.57 + i * 1.02, i % 2 ? 16.0 : 17.78],
          1.3,
          0.9,
          i === 0 ? 'rect' : 'circle',
        ),
      );
      pads.push(thru('H1', [-5.71, 8.89], 3.25, 3.25, 'circle', 'npth'));
      pads.push(thru('H2', [5.71, 8.89], 3.25, 3.25, 'circle', 'npth'));
      pads.push(thru('S1', [-7.75, 12.0], 2.3, 1.6));
      pads.push(thru('S2', [7.75, 12.0], 2.3, 1.6));
      const body: [number, number, number, number] = [-8, -2, 8, 19.3];
      return {
        name: 'RJ45 jack',
        pads,
        silk: [...box(-8, 0, 8, 19.3)],
        courtyard: courtyard(pads, body),
        heightMm: 13.5,
        generator: { kind: 'rj45', params: p.all },
      };
    },
  },
  {
    kind: 'body',
    label: 'Body only (no pads)',
    refPrefix: 'M',
    params: [
      { name: 'x', label: 'Size x (mm)', min: 0.5, max: 200, default: 10 },
      { name: 'y', label: 'Size y (mm)', min: 0.5, max: 200, default: 10 },
      { name: 'height', label: 'Height (mm)', min: 0.1, max: 50, default: 1.5 },
    ],
    make(params) {
      const p = reader(this.params, params);
      const x = p.n('x') / 2;
      const y = p.n('y') / 2;
      return {
        name: `Body ${p.n('x')} × ${p.n('y')} mm`,
        pads: [],
        silk: box(-x, -y, x, y),
        courtyard: roundedRectLoop([-x, -y], p.n('x'), p.n('y'), 0),
        heightMm: p.n('height'),
        generator: { kind: 'body', params: p.all },
      };
    },
  },
];

/** The built-in generators by kind. */
export const pcbGenerators: ReadonlyMap<string, PcbGeneratorSpec> = new Map(
  specs.map((s) => [s.kind, s]),
);

/** A footprint from a generator; throws `PcbGeneratorError` naming a bad parameter. */
export function generateFootprint(
  id: string,
  kind: string,
  params: Record<string, number | string> = {},
): PcbFootprint {
  const spec = pcbGenerators.get(kind);
  if (!spec) throw new PcbGeneratorError('kind');
  return { id, ...spec.make(params) };
}
