/**
 * PD4 (docs/cad/product-design.md): standard parts made from their designation. Each generator
 * builds an ordinary part document (revolve, cylinder, extrude, Boolean and pattern features,
 * about +Z from the origin) and gives it a part number and description, so the part is an
 * ordinary part version that may be edited afterwards. The tables hold dimensions only (no text
 * of the standards), and only the sizes the watch and car examples need (PD-U4). Threads are not
 * modelled (the shank is the nominal diameter), as in WM.
 *
 * - Screws: ISO 4762 (hexagon socket head cap), ISO 1207 (slotted cheese head), ISO 7045 (pan
 *   head, cross recess H; the recess is an indicative cross, not the gauge shape), and slotted
 *   watch screws below M1.6 (not ISO: cheese heads in the proportions of ISO 1207 M1.6).
 * - O-rings: ISO 3601-1 inner diameter × cross-section, or a custom size (watch gaskets are below
 *   the ISO sections); the groove (`oRingGroove`) is sized from squeeze and fill and cut from a
 *   body with ordinary features.
 * - Parallel pins: ISO 8734 (hardened), both ends chamfered (the rounded end is not modelled).
 * - Deep-groove ball bearings of the 60, 62 and 68 series: boundary dimensions only, no maker's
 *   design (ball count and size are derived, not catalogue values).
 * - Watch parts (not ISO): hole jewels with an oil sink, cap jewels, spring bars.
 */
import { cadBuilder, type CadBuilder } from './builder';
import { multiplyQuaternions } from './assembly';
import { chamferedRing, revolveOutline, xzPlane } from './machine-elements';
import {
  identityQuaternion,
  type CadAppearance,
  type CadDocument,
  type CadKernelProfile,
  type Quaternion,
} from './model';
import { applyCadOperation, type CadOperation } from './operations';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
type V3 = [number, number, number];

const fail = (code: string): never => {
  throw new Error(code);
};

/** Screw sizes: thread pitch (coarse) and head sizes, mm. */
interface ScrewRow {
  pitch: number;
  /** Head diameter (max), head height (max). */
  dk: number;
  k: number;
  /** Socket across flats, or slot width, or cross recess number. */
  drive: number;
  /** Socket or slot depth (min). */
  t: number;
  /** Shortest and longest nominal lengths. */
  lengths: [number, number];
}
const row = (
  pitch: number,
  dk: number,
  k: number,
  drive: number,
  t: number,
  lengths: [number, number],
): ScrewRow => Object.freeze({ pitch, dk, k, drive, t, lengths });

/** ISO 4762 hexagon socket head cap screws: dk, k, s, t. */
export const iso4762: Readonly<Record<string, ScrewRow>> = Object.freeze({
  'M1.6': row(0.35, 3, 1.6, 1.5, 0.7, [2.5, 16]),
  M2: row(0.4, 3.8, 2, 1.5, 1, [3, 20]),
  'M2.5': row(0.45, 4.5, 2.5, 2, 1.1, [4, 25]),
  M3: row(0.5, 5.5, 3, 2.5, 1.3, [5, 30]),
  M4: row(0.7, 7, 4, 3, 2, [6, 40]),
  M5: row(0.8, 8.5, 5, 4, 2.5, [8, 50]),
  M6: row(1, 10, 6, 5, 3, [10, 60]),
  M8: row(1.25, 13, 8, 6, 4, [12, 80]),
  M10: row(1.5, 16, 10, 8, 5, [16, 100]),
  M12: row(1.75, 18, 12, 10, 6, [20, 120]),
});
/** ISO 1207 slotted cheese head screws: dk, k, n (slot width), t. */
export const iso1207: Readonly<Record<string, ScrewRow>> = Object.freeze({
  'M1.6': row(0.35, 3, 1.1, 0.4, 0.45, [2, 16]),
  M2: row(0.4, 3.8, 1.4, 0.5, 0.6, [3, 20]),
  'M2.5': row(0.45, 4.5, 1.8, 0.6, 0.7, [3, 25]),
  M3: row(0.5, 5.5, 2, 0.8, 0.85, [4, 30]),
  M4: row(0.7, 7, 2.6, 1.2, 1.1, [5, 40]),
  M5: row(0.8, 8.5, 3.3, 1.2, 1.3, [6, 50]),
  M6: row(1, 10, 3.9, 1.6, 1.6, [8, 60]),
  M8: row(1.25, 13, 5, 2, 2, [10, 80]),
  M10: row(1.5, 16, 6, 2.5, 2.4, [12, 80]),
});
/** ISO 7045 pan head screws with cross recess H: dk, k, recess number, recess depth (indicative). */
export const iso7045: Readonly<Record<string, ScrewRow>> = Object.freeze({
  'M1.6': row(0.35, 3.2, 1.3, 0, 0.7, [3, 16]),
  M2: row(0.4, 4, 1.6, 0, 0.9, [3, 20]),
  'M2.5': row(0.45, 5, 2.1, 1, 1.1, [3, 25]),
  M3: row(0.5, 5.6, 2.4, 1, 1.4, [4, 30]),
  M4: row(0.7, 8, 3.1, 2, 1.9, [5, 40]),
  M5: row(0.8, 9.5, 3.7, 2, 2.2, [6, 45]),
  M6: row(1, 12, 4.6, 3, 2.7, [8, 60]),
  M8: row(1.25, 16, 6, 4, 3.4, [10, 60]),
  M10: row(1.5, 20, 7.5, 4, 4.2, [12, 60]),
});
/**
 * Slotted watch screws (not ISO): cheese heads in the proportions of ISO 1207 M1.6
 * (dk 1.875 d, k 0.69 d, slot 0.25 d, depth 0.28 d).
 */
export const watchScrews: Readonly<Record<string, ScrewRow>> = Object.freeze(
  Object.fromEntries(
    (
      [
        ['M0.8', 0.2],
        ['M1', 0.25],
        ['M1.2', 0.25],
        ['M1.4', 0.3],
      ] as const
    ).map(([size, pitch]) => {
      const d = screwDiameter(size);
      const r = (x: number) => Math.round(x * 100) / 100;
      return [size, row(pitch, r(1.875 * d), r(0.69 * d), r(0.25 * d), r(0.28 * d), [0.8, 6])];
    }),
  ),
);
/** Nominal screw lengths (ISO 888 preferred values, and short watch lengths). */
export const screwLengths: readonly number[] = Object.freeze([
  0.8, 1, 1.2, 1.4, 1.6, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60,
  65, 70, 80, 90, 100, 110, 120,
]);

function screwDiameter(size: string): number {
  const m = /^M(\d+(?:\.\d+)?)$/.exec(size);
  return m ? Number(m[1]) : fail(`standard-size:${size}`);
}

/** ISO 8734 parallel pins: diameter → chamfer a, shortest and longest length. */
export const iso8734: Readonly<Record<string, { a: number; lengths: [number, number] }>> =
  Object.freeze({
    '1': { a: 0.12, lengths: [3, 10] },
    '1.5': { a: 0.2, lengths: [4, 16] },
    '2': { a: 0.25, lengths: [5, 20] },
    '2.5': { a: 0.3, lengths: [6, 24] },
    '3': { a: 0.4, lengths: [8, 30] },
    '4': { a: 0.5, lengths: [10, 40] },
    '5': { a: 0.63, lengths: [12, 50] },
    '6': { a: 0.8, lengths: [14, 60] },
    '8': { a: 1, lengths: [18, 80] },
    '10': { a: 1.2, lengths: [22, 100] },
    '12': { a: 1.6, lengths: [26, 100] },
  });
/** Nominal pin lengths. */
export const pinLengths: readonly number[] = Object.freeze([
  3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 35, 40, 45, 50, 55, 60, 65, 70, 75,
  80, 85, 90, 95, 100,
]);

/** Deep-groove ball bearings of the 68, 60 and 62 series: code → d, D, B (mm). */
export const ballBearings: Readonly<Record<string, readonly [number, number, number]>> =
  Object.freeze({
    // 68 (dimension series 18; the miniatures 681–689 are its small sizes)
    '681': [1, 3, 1],
    '682': [2, 5, 1.5],
    '683': [3, 7, 2],
    '684': [4, 9, 2.5],
    '685': [5, 11, 3],
    '686': [6, 13, 3.5],
    '687': [7, 14, 3.5],
    '688': [8, 16, 4],
    '689': [9, 17, 4],
    '6800': [10, 19, 5],
    '6801': [12, 21, 5],
    '6802': [15, 24, 5],
    '6803': [17, 26, 5],
    '6804': [20, 32, 7],
    '6805': [25, 37, 7],
    '6806': [30, 42, 7],
    // 60 (dimension series 10)
    '604': [4, 12, 4],
    '605': [5, 14, 5],
    '606': [6, 17, 6],
    '607': [7, 19, 6],
    '608': [8, 22, 7],
    '609': [9, 24, 7],
    '6000': [10, 26, 8],
    '6001': [12, 28, 8],
    '6002': [15, 32, 9],
    '6003': [17, 35, 10],
    '6004': [20, 42, 12],
    '6005': [25, 47, 12],
    '6006': [30, 55, 13],
    '6007': [35, 62, 14],
    '6008': [40, 68, 15],
    '6009': [45, 75, 16],
    '6010': [50, 80, 16],
    // 62 (dimension series 02)
    '623': [3, 10, 4],
    '624': [4, 13, 5],
    '625': [5, 16, 5],
    '626': [6, 19, 6],
    '627': [7, 22, 7],
    '628': [8, 24, 8],
    '629': [9, 26, 8],
    '6200': [10, 30, 9],
    '6201': [12, 32, 10],
    '6202': [15, 35, 11],
    '6203': [17, 40, 12],
    '6204': [20, 47, 14],
    '6205': [25, 52, 15],
    '6206': [30, 62, 16],
    '6207': [35, 72, 17],
    '6208': [40, 80, 18],
    '6209': [45, 85, 19],
    '6210': [50, 90, 20],
    '6211': [55, 100, 21],
    '6212': [60, 110, 22],
  });

/** ISO 3601-1 cross-sections (series G) → the smallest and largest inner diameter kept here. */
export const iso3601Sections: Readonly<Record<string, [number, number]>> = Object.freeze({
  '1.8': [1.8, 50],
  '2.65': [10.6, 100],
  '3.55': [18, 100],
  '5.3': [40, 100],
});
/** ISO 3601-1 inner diameters (R40-based values) up to 100 mm. */
export const iso3601InnerDiameters: readonly number[] = Object.freeze([
  1.8, 2, 2.24, 2.5, 2.8, 3.15, 3.55, 3.75, 4, 4.5, 4.87, 5, 5.15, 5.3, 5.6, 6, 6.3, 6.7, 6.9, 7.1,
  7.5, 8, 8.5, 8.75, 9, 9.5, 10, 10.6, 11.2, 11.8, 12.5, 13.2, 14, 15, 16, 17, 18, 19, 20, 21.2,
  22.4, 23.6, 25, 25.8, 26.5, 28, 30, 31.5, 32.5, 33.5, 34.5, 35.5, 36.5, 37.5, 38.7, 40, 41.2,
  42.5, 43.7, 45, 46.2, 47.5, 48.7, 50, 51.5, 53, 54.5, 56, 58, 60, 61.5, 63, 65, 67, 69, 71, 73,
  75, 77.5, 80, 82.5, 85, 87.5, 90, 92.5, 95, 97.5, 100,
]);

/** Spring bar body diameters (not ISO) → tip diameter and tip length. */
export const springBars: Readonly<Record<string, { tip: number; tipLength: number }>> =
  Object.freeze({
    '1.5': { tip: 0.8, tipLength: 0.8 },
    '1.8': { tip: 0.9, tipLength: 0.9 },
    '2': { tip: 1, tipLength: 1 },
    '2.5': { tip: 1.1, tipLength: 1 },
  });

export type CadScrewStandard = 'ISO 4762' | 'ISO 1207' | 'ISO 7045' | 'watch';
export type CadStandardPartSpec =
  | { family: 'screw'; standard: CadScrewStandard; size: string; length: number }
  /** `custom`: a size outside ISO 3601-1 (watch gaskets). */
  | { family: 'o-ring'; innerDiameter: number; section: number; custom?: boolean }
  | { family: 'parallel-pin'; diameter: number; length: number }
  | { family: 'ball-bearing'; code: string }
  /** A pierced jewel: hole, outer diameter and height (mm). */
  | { family: 'hole-jewel'; hole: number; diameter: number; height: number }
  | { family: 'cap-jewel'; diameter: number; height: number }
  /** `length` is the nominal (lug width), `diameter` the body. */
  | { family: 'spring-bar'; length: number; diameter: number };

export interface CadStandardPart {
  spec: CadStandardPartSpec;
  /** The designation as written (e.g. `ISO 4762 M3×8`), and the part number derived from it. */
  designation: string;
  partNumber: string;
  description: string;
  /** PD2's part kind: a standard part. */
  kind: 'standard';
  /** Whether the size is from an ISO table (false: watch parts and custom O-rings). */
  iso: boolean;
  /** The sizes the shape was built from, mm. */
  dimensions: Record<string, number>;
  content: CadDocument;
  operations: CadOperation[];
}

const steel: Partial<CadAppearance> = { color: '#9aa3ab', metalness: 0.9, roughness: 0.3 };
const blued: Partial<CadAppearance> = { color: '#3a4a8a', metalness: 0.9, roughness: 0.25 };
const rubber: Partial<CadAppearance> = { color: '#202020', metalness: 0, roughness: 0.85 };
const ruby: Partial<CadAppearance> = { color: '#c0143c', opacity: 0.85, roughness: 0.05 };

const fmt = (x: number) => String(Math.round(x * 1000) / 1000);
const on = (list: readonly number[], x: number) => list.some((v) => Math.abs(v - x) < 1e-9);

function screwTable(standard: CadScrewStandard) {
  return {
    'ISO 4762': iso4762,
    'ISO 1207': iso1207,
    'ISO 7045': iso7045,
    watch: watchScrews,
  }[standard];
}

/** The table row of a screw, refused when the size or the length is not kept. */
export function screwRow(standard: CadScrewStandard, size: string, length: number): ScrewRow {
  const r = screwTable(standard)?.[size] ?? fail(`standard-size:${standard} ${size}`);
  if (!on(screwLengths, length) || length < r.lengths[0] || length > r.lengths[1])
    fail(`standard-length:${standard} ${size}×${fmt(length)}`);
  return r;
}

/** A screw: the head's bearing face at z 0, the head up +Z, the shank down to −length. */
function buildScrew(
  b: CadBuilder,
  name: string,
  standard: CadScrewStandard,
  size: string,
  l: number,
) {
  const r = screwRow(standard, size, l);
  const d = screwDiameter(size);
  const R = r.dk / 2;
  const tipC = Math.min(r.pitch, d / 4);
  const look = standard === 'watch' ? blued : steel;
  const shank: [number, number][] = [
    [0, -l],
    [d / 2 - tipC, -l],
    [d / 2, -l + tipC],
    [d / 2, 0],
  ];
  let head: [number, number][];
  if (standard === 'ISO 7045') {
    // A pan head: straight side to 0.55 k, then a quarter ellipse to the crown.
    const side = 0.55 * r.k;
    const arc = Array.from({ length: 6 }, (_, i) => {
      const a = ((i + 1) / 7) * (Math.PI / 2);
      return [R * Math.cos(a), side + (r.k - side) * Math.sin(a)] as [number, number];
    });
    head = [[R, 0], [R, side], ...arc, [0, r.k]];
  } else {
    const c = standard === 'ISO 4762' ? Math.min(0.1 * r.k, 0.6) : Math.min(0.08 * r.k, 0.3);
    head = [
      [R, 0],
      [R, r.k - c],
      [R - c, r.k],
      [0, r.k],
    ];
  }
  const screw = revolveOutline(b, name, [...shank, ...head], [0, 0, 0], look);
  if (standard === 'ISO 4762') {
    // The hexagon socket, s across flats, t deep (the cone at its bottom is not modelled).
    const ro = r.drive / Math.sqrt(3);
    const hex = Array.from({ length: 6 }, (_, i) => {
      const a = (i * Math.PI) / 3;
      return [ro * Math.cos(a), ro * Math.sin(a)] as [number, number];
    });
    const sec = b.polygon(`${name} socket outline`, { origin: [0, 0, r.k] }, hex);
    const socket = b.extrude(`${name} socket`, sec, r.t, undefined, -1);
    b.boolean(screw, [socket], 'cut', `${name} socket cut`);
  } else if (standard === 'ISO 7045') {
    // An indicative cross: two slots 0.14 dk wide, 0.55 dk long, t deep at the axis.
    const w = Math.max(0.14 * r.dk, 0.3);
    const len = 0.55 * r.dk;
    const top = r.k + 0.5;
    const a = b.box(`${name} recess a`, {
      size: [len, w, r.t + 0.5],
      origin: [-len / 2, -w / 2, top - r.t - 0.5],
    });
    const c = b.box(`${name} recess b`, {
      size: [w, len, r.t + 0.5],
      origin: [-w / 2, -len / 2, top - r.t - 0.5],
    });
    b.boolean(screw, [a, c], 'cut', `${name} recess cut`);
  } else {
    // A slot across the head, n wide and t deep.
    const slot = b.box(`${name} slot`, {
      size: [r.dk + 1, r.drive, r.t + 0.5],
      origin: [-R - 0.5, -r.drive / 2, r.k - r.t],
    });
    b.boolean(screw, [slot], 'cut', `${name} slot cut`);
  }
  return { d, dk: r.dk, k: r.k, drive: r.drive, t: r.t, pitch: r.pitch, length: l };
}

/** A torus: the O-ring, its inner diameter at z 0 to section, centred on z = section / 2. */
function buildORing(b: CadBuilder, name: string, d1: number, d2: number) {
  const id = b.sketch(
    `${name} section`,
    { orientation: xzPlane },
    { c: [d1 / 2 + d2 / 2, d2 / 2] },
    [{ type: 'circle', id: 'o', center: 'c' }],
    { solved: { o: [d2 / 2, 0] } },
  );
  b.revolve(
    name,
    { sketchId: id, region: { outer: ['o'], holes: [] } },
    { axisDirection: [0, 1] },
    rubber,
  );
}

/** The O-ring sizes, refused outside the kept ISO 3601-1 table unless `custom`. */
export function oRingSize(spec: { innerDiameter: number; section: number; custom?: boolean }) {
  const { innerDiameter: d1, section: d2 } = spec;
  if (!(d2 > 0 && d1 > 0)) fail('standard-size:o-ring');
  if (spec.custom) {
    if (d2 < 0.3 || d2 > 10 || d1 < 0.5 || d1 > 500)
      fail(`standard-size:o-ring ${fmt(d1)}×${fmt(d2)}`);
    return;
  }
  const range = iso3601Sections[fmt(d2)] ?? fail(`standard-size:ISO 3601 section ${fmt(d2)}`);
  if (!on(iso3601InnerDiameters, d1) || d1 < range[0] || d1 > range[1])
    fail(`standard-size:ISO 3601 ${fmt(d1)}×${fmt(d2)}`);
}

/** The ball count and size of a deep-groove bearing (derived, not a maker's). */
export function bearingBalls(d: number, D: number) {
  const h = (D - d) / 2;
  const innerOuter = d / 2 + h * 0.3;
  const outerInner = D / 2 - h * 0.3;
  const pitch = (innerOuter + outerInner) / 2;
  // Balls sink a little into both races so the rings and balls are one solid.
  const sink = Math.min(0.2, h * 0.04);
  const ball = (outerInner - innerOuter) / 2 + sink;
  // Neighbours stay apart: chord 2 p sin(π/n) ≥ 2.3 ball.
  const most = Math.floor(Math.PI / Math.asin(Math.min(1, (1.15 * ball) / pitch)));
  const count = Math.max(3, Math.min(most, Math.floor((2 * Math.PI * pitch) / (2 * ball * 1.35))));
  return { innerOuter, outerInner, pitch, ball, count };
}

function buildBearing(b: CadBuilder, name: string, code: string) {
  const [d, D, B] = ballBearings[code] ?? fail(`standard-size:bearing ${code}`);
  const { innerOuter, outerInner, pitch, ball, count } = bearingBalls(d, D);
  const c = Math.min(0.6, B / 20);
  const outer = chamferedRing(
    b,
    `${name} outer ring`,
    { inner: outerInner, outer: D / 2, z0: 0, z1: B, c },
    steel,
  );
  const inner = chamferedRing(
    b,
    `${name} inner ring`,
    { inner: d / 2, outer: innerOuter, z0: 0, z1: B, c },
    steel,
  );
  const one = b.sphere(`${name} ball`, { radius: ball, origin: [pitch, 0, B / 2] }, steel);
  b.pattern(
    outer,
    one,
    { type: 'circular', axisDirection: [0, 0, 1], count, angle: (2 * Math.PI) / count },
    'union',
  );
  b.boolean(outer, [inner], 'union', name);
  return { d, D, B, balls: count, ballDiameter: 2 * ball, pitchDiameter: 2 * pitch };
}

function buildPin(b: CadBuilder, name: string, dia: number, l: number) {
  const r = iso8734[fmt(dia)] ?? fail(`standard-size:ISO 8734 ${fmt(dia)}`);
  if (!on(pinLengths, l) || l < r.lengths[0] || l > r.lengths[1])
    fail(`standard-length:ISO 8734 ${fmt(dia)}×${fmt(l)}`);
  const R = dia / 2;
  revolveOutline(
    b,
    name,
    [
      [0, 0],
      [R - r.a, 0],
      [R, r.a],
      [R, l - r.a],
      [R - r.a, l],
      [0, l],
    ],
    [0, 0, 0],
    steel,
  );
  return { d: dia, length: l, chamfer: r.a };
}

/** Watch jewels: the hole at least 0.05, the wall at least 0.15, the height 0.1–2 mm. */
function jewelSize(diameter: number, height: number, hole?: number) {
  if (!(height >= 0.1 && height <= 2) || !(diameter >= 0.4 && diameter <= 5))
    fail('standard-size:jewel');
  // A hole jewel always names its hole (0 too); only a cap jewel has none.
  if (hole !== undefined && !(hole >= 0.05 && diameter - hole >= 0.3))
    fail('standard-size:jewel hole');
}

function buildHoleJewel(b: CadBuilder, name: string, hole: number, D: number, H: number) {
  jewelSize(D, H, hole);
  const rh = hole / 2;
  const R = D / 2;
  // The oil sink: a cone from the hole at 0.4 H below the top out to 0.6 of the radius.
  const rc = Math.max(rh + 0.05, Math.min(0.6 * R, rh + 0.5 * H));
  revolveOutline(
    b,
    name,
    [
      [rh, 0],
      [R, 0],
      [R, H],
      [rc, H],
      [rh, 0.6 * H],
    ],
    [0, 0, 0],
    ruby,
  );
  return { hole, diameter: D, height: H, sink: 2 * rc };
}

function buildCapJewel(b: CadBuilder, name: string, D: number, H: number) {
  jewelSize(D, H);
  b.cylinder(name, { radius: D / 2, height: H }, ruby);
  return { diameter: D, height: H };
}

/** A spring bar along +Z: the tube 0.5 shorter than the nominal, tips out at both ends. */
function buildSpringBar(b: CadBuilder, name: string, L: number, D: number) {
  const s = springBars[fmt(D)] ?? fail(`standard-size:spring bar ${fmt(D)}`);
  if (!(L >= 8 && L <= 30)) fail(`standard-length:spring bar ${fmt(L)}`);
  const tube = L - 0.5;
  const r = D / 2;
  const c = Math.min(0.15, r / 4);
  revolveOutline(
    b,
    name,
    [
      [0, 0],
      [s.tip / 2, 0],
      [s.tip / 2, s.tipLength],
      [r - c, s.tipLength],
      [r, s.tipLength + c],
      [r, s.tipLength + tube - c],
      [r - c, s.tipLength + tube],
      [s.tip / 2, s.tipLength + tube],
      [s.tip / 2, 2 * s.tipLength + tube],
      [0, 2 * s.tipLength + tube],
    ],
    [0, 0, 0],
    steel,
  );
  return {
    length: L,
    diameter: D,
    tip: s.tip,
    tube,
    extended: tube + 2 * s.tipLength,
  };
}

/** The designation, part number and description of a spec. */
export function standardPartNames(spec: CadStandardPartSpec) {
  switch (spec.family) {
    case 'screw': {
      const l = fmt(spec.length);
      if (spec.standard === 'watch')
        return {
          designation: `Watch screw ${spec.size}×${l}`,
          partNumber: `WS-${spec.size}x${l}`,
          description: `Slotted watch screw ${spec.size}×${l}`,
        };
      const what = {
        'ISO 4762': 'Hexagon socket head cap screw',
        'ISO 1207': 'Slotted cheese head screw',
        'ISO 7045': 'Pan head screw, cross recess H',
      }[spec.standard];
      return {
        designation: `${spec.standard} ${spec.size}×${l}`,
        partNumber: `${spec.standard.replace(' ', '')}-${spec.size}x${l}`,
        description: `${what} ${spec.standard} ${spec.size}×${l}`,
      };
    }
    case 'o-ring': {
      const s = `${fmt(spec.innerDiameter)}×${fmt(spec.section)}`;
      const n = s.replace('×', 'x');
      return spec.custom
        ? {
            designation: `O-ring ${s}`,
            partNumber: `OR-${n}`,
            description: `O-ring ${s} (custom size)`,
          }
        : {
            designation: `ISO 3601-1 ${s}`,
            partNumber: `ISO3601-${n}`,
            description: `O-ring ISO 3601-1 ${s}`,
          };
    }
    case 'parallel-pin': {
      const s = `${fmt(spec.diameter)}×${fmt(spec.length)}`;
      return {
        designation: `ISO 8734 ${s}`,
        partNumber: `ISO8734-${s.replace('×', 'x')}`,
        description: `Parallel pin, hardened, ISO 8734 ${s}`,
      };
    }
    case 'ball-bearing':
      return {
        designation: spec.code,
        partNumber: `BRG-${spec.code}`,
        description: `Deep-groove ball bearing ${spec.code}`,
      };
    case 'hole-jewel': {
      const s = `${fmt(spec.hole)}/${fmt(spec.diameter)}×${fmt(spec.height)}`;
      return {
        designation: `Hole jewel ${s}`,
        partNumber: `JWL-H-${fmt(spec.hole)}-${fmt(spec.diameter)}-${fmt(spec.height)}`,
        description: `Hole jewel with oil sink, hole ${fmt(spec.hole)}, ${fmt(spec.diameter)}×${fmt(spec.height)}`,
      };
    }
    case 'cap-jewel': {
      const s = `${fmt(spec.diameter)}×${fmt(spec.height)}`;
      return {
        designation: `Cap jewel ${s}`,
        partNumber: `JWL-C-${fmt(spec.diameter)}-${fmt(spec.height)}`,
        description: `Cap jewel ${s}`,
      };
    }
    case 'spring-bar': {
      const s = `${fmt(spec.length)}×${fmt(spec.diameter)}`;
      return {
        designation: `Spring bar ${s}`,
        partNumber: `SB-${s.replace('×', 'x')}`,
        description: `Spring bar for ${fmt(spec.length)} mm lugs, body ${fmt(spec.diameter)}`,
      };
    }
  }
}

/**
 * The part version of a standard part: refused with `standard-size:…` or `standard-length:…`
 * when the size is not kept here.
 */
export function standardPart(spec: CadStandardPartSpec, kernel: Kernel): CadStandardPart {
  const names = standardPartNames(spec);
  const b = cadBuilder(kernel);
  const name = names.description;
  let dimensions: Record<string, number>;
  let iso = true;
  switch (spec.family) {
    case 'screw':
      dimensions = buildScrew(b, name, spec.standard, spec.size, spec.length);
      iso = spec.standard !== 'watch';
      break;
    case 'o-ring': {
      oRingSize(spec);
      buildORing(b, name, spec.innerDiameter, spec.section);
      dimensions = { d1: spec.innerDiameter, d2: spec.section };
      iso = !spec.custom;
      break;
    }
    case 'parallel-pin':
      dimensions = buildPin(b, name, spec.diameter, spec.length);
      break;
    case 'ball-bearing':
      dimensions = buildBearing(b, name, spec.code);
      break;
    case 'hole-jewel':
      dimensions = buildHoleJewel(b, name, spec.hole, spec.diameter, spec.height);
      iso = false;
      break;
    case 'cap-jewel':
      dimensions = buildCapJewel(b, name, spec.diameter, spec.height);
      iso = false;
      break;
    case 'spring-bar':
      dimensions = buildSpringBar(b, name, spec.length, spec.diameter);
      iso = false;
      break;
  }
  const { document, operations } = b.build();
  const props: CadOperation = {
    type: 'setPartProperties',
    partNumber: names.partNumber,
    description: names.description,
  };
  // PD2: a standard part's sourcing class.
  const sourcing: CadOperation = { type: 'setPartBomProperties', sourcing: 'standard' };
  return {
    spec,
    ...names,
    kind: 'standard',
    iso,
    dimensions,
    content: applyCadOperation(applyCadOperation(document, props), sourcing),
    operations: [...operations, props, sourcing],
  };
}

/**
 * The spec of a designation as `standardPartNames` writes it (`ISO 4762 M3×8`, `ISO 3601-1
 * 20×2.65`, `ISO 8734 3×10`, `608`, `Watch screw M1×1.6`, `O-ring 28×0.6`, `Hole jewel
 * 0.1/1×0.2`, `Cap jewel 1.2×0.15`, `Spring bar 16×1.8`); `x` may stand for `×`. Undefined when
 * the text is not one; the sizes are checked when the part is made.
 */
export function parseStandardDesignation(text: string): CadStandardPartSpec | undefined {
  const t = text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(\d)\s*[xX×]\s*(\d)/g, '$1×$2');
  const n = '(\\d+(?:\\.\\d+)?)';
  let m = new RegExp(`^(ISO 4762|ISO 1207|ISO 7045) (M${n})×${n}$`).exec(t);
  if (m)
    return {
      family: 'screw',
      standard: m[1] as CadScrewStandard,
      size: m[2]!,
      length: Number(m[4]),
    };
  m = new RegExp(`^Watch screw (M${n})×${n}$`, 'i').exec(t);
  if (m) return { family: 'screw', standard: 'watch', size: m[1]!, length: Number(m[3]) };
  m = new RegExp(`^ISO 3601(?:-1)? ${n}×${n}$`).exec(t);
  if (m) return { family: 'o-ring', innerDiameter: Number(m[1]), section: Number(m[2]) };
  m = new RegExp(`^O-ring ${n}×${n}$`, 'i').exec(t);
  if (m)
    return { family: 'o-ring', innerDiameter: Number(m[1]), section: Number(m[2]), custom: true };
  m = new RegExp(`^ISO 8734 ${n}×${n}$`).exec(t);
  if (m) return { family: 'parallel-pin', diameter: Number(m[1]), length: Number(m[2]) };
  m = /^(6\d{2,3})$/.exec(t);
  if (m) return { family: 'ball-bearing', code: m[1]! };
  m = new RegExp(`^Hole jewel ${n}/${n}×${n}$`, 'i').exec(t);
  if (m)
    return {
      family: 'hole-jewel',
      hole: Number(m[1]),
      diameter: Number(m[2]),
      height: Number(m[3]),
    };
  m = new RegExp(`^Cap jewel ${n}×${n}$`, 'i').exec(t);
  if (m) return { family: 'cap-jewel', diameter: Number(m[1]), height: Number(m[2]) };
  m = new RegExp(`^Spring bar ${n}×${n}$`, 'i').exec(t);
  if (m) return { family: 'spring-bar', length: Number(m[1]), diameter: Number(m[2]) };
  return undefined;
}

/** Where an O-ring groove is cut. */
export type CadORingGrooveKind =
  /** In a shaft or piston (outer surface), sealing against a bore of `diameter`. */
  | 'radial-outer'
  /** In a bore (housing), sealing against a shaft or rod of `diameter`. */
  | 'radial-inner'
  /** In a face, the ring pressed axially; `diameter` is the groove's outer diameter. */
  | 'axial';

export interface CadORingGland {
  kind: CadORingGrooveKind;
  /** Groove depth (radial for radial grooves, axial for a face groove) and width. */
  depth: number;
  width: number;
  /** The groove's inner and outer diameters. */
  inner: number;
  outer: number;
  /** Squeeze of the section, fill of the groove, stretch of the ring's inner diameter (ratios). */
  squeeze: number;
  fill: number;
  stretch: number;
  /** Rules of thumb broken: `squeeze` outside 0.1–0.35, `fill` above 0.9, `stretch` above 0.06 or below −0.03. */
  warnings: ('squeeze' | 'fill' | 'stretch')[];
}

/**
 * The gland of an O-ring `d1 × d2`: depth from the squeeze (0.2 radial, 0.25 axial by
 * default), width so the ring fills `fill` (0.8) of the groove's section. For an axial groove
 * the outer wall carries the ring's outer diameter (internal pressure).
 */
export function oRingGland(a: {
  kind: CadORingGrooveKind;
  ring: { innerDiameter: number; section: number };
  diameter: number;
  squeeze?: number;
  fill?: number;
}): CadORingGland {
  const { innerDiameter: d1, section: d2 } = a.ring;
  const q = a.squeeze ?? (a.kind === 'axial' ? 0.25 : 0.2);
  const f = a.fill ?? 0.8;
  if (!(q > 0 && q < 0.5) || !(f > 0 && f < 1) || !(a.diameter > 0) || !(d1 > 0 && d2 > 0))
    fail('o-ring-gland');
  const depth = d2 * (1 - q);
  const width = (Math.PI * d2 * d2) / 4 / (depth * f);
  let inner: number;
  let outer: number;
  let stretch: number;
  if (a.kind === 'radial-outer') {
    outer = a.diameter;
    inner = a.diameter - 2 * depth;
    stretch = inner / d1 - 1;
  } else if (a.kind === 'radial-inner') {
    inner = a.diameter;
    outer = a.diameter + 2 * depth;
    stretch = a.diameter / d1 - 1;
  } else {
    outer = a.diameter;
    inner = a.diameter - 2 * width;
    // Pressed to the outer wall: the inner diameter stretched to outer − 2 d2.
    stretch = (outer - 2 * d2) / d1 - 1;
  }
  if (inner <= 0) fail('o-ring-gland');
  const warnings: CadORingGland['warnings'] = [];
  if (q < 0.1 || q > 0.35) warnings.push('squeeze');
  if (f > 0.9) warnings.push('fill');
  if (stretch > 0.06 || stretch < -0.03) warnings.push('stretch');
  return { kind: a.kind, depth, width, inner, outer, squeeze: q, fill: f, stretch, warnings };
}

/**
 * Cuts an O-ring groove from `target` with ordinary features (a ring revolved about the axis,
 * then a cut), so the groove stays editable. The axis is +Z through `origin`, turned by
 * `orientation`; `z` is the groove's middle for a radial groove, the face's height for an axial
 * one (the groove goes down −Z from it). Returns the gland and the cut's feature ID.
 */
export function oRingGroove(
  b: CadBuilder,
  target: string,
  a: Parameters<typeof oRingGland>[0] & {
    z: number;
    origin?: V3;
    orientation?: Quaternion;
    name?: string;
  },
): CadORingGland & { featureId: string } {
  const g = oRingGland(a);
  const name = a.name ?? 'O-ring groove';
  // Past the surfaces it opens on, so the cut leaves no skin.
  const over = Math.max(0.2, g.depth);
  const [r0, r1, z0, z1] =
    a.kind === 'radial-outer'
      ? [g.inner / 2, g.outer / 2 + over, a.z - g.width / 2, a.z + g.width / 2]
      : a.kind === 'radial-inner'
        ? [g.inner / 2 - over, g.outer / 2, a.z - g.width / 2, a.z + g.width / 2]
        : [g.inner / 2, g.outer / 2, a.z - g.depth, a.z + over];
  const section = b.polygon(
    `${name} outline`,
    {
      origin: a.origin ?? [0, 0, 0],
      orientation: multiplyQuaternions(a.orientation ?? identityQuaternion(), xzPlane),
    },
    [
      [Math.max(0, r0), z0],
      [r1, z0],
      [r1, z1],
      [Math.max(0, r0), z1],
    ],
  );
  const ring = b.revolve(name, section, { axisDirection: [0, 1] });
  const featureId = b.boolean(target, [ring], 'cut', `${name} cut`);
  return { ...g, featureId };
}
