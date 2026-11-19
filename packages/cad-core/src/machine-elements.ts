/**
 * DW7c (docs/cad/drawing-editor.md, 動力系): machine elements as parameter shapes built from the
 * ordinary features (revolve, sphere, pattern, spur gear), so a part keeps them as editable
 * features: a deep-groove ball bearing of the ISO dimension series 02 (boundary dimensions only,
 * no maker's design), a radial lip oil seal, and a 30° involute spline (a short stub tooth).
 * Each is turned about +Z from `origin`, its back face there.
 */
import type { CadBuilder } from './builder';
import type { CadAppearance, Quaternion } from './model';

type V3 = [number, number, number];
/** The sketch plane holding +Z: its u is +X and its v is +Z (a quarter turn about +X). */
export const xzPlane: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/** ISO 15 dimension series 02 deep-groove bearings: bore code → d, D, B (mm). */
export const bearingSeries02: Readonly<Record<string, readonly [number, number, number]>> =
  Object.freeze({
    '6205': [25, 52, 15],
    '6206': [30, 62, 16],
    '6207': [35, 72, 17],
    '6208': [40, 80, 18],
    '6209': [45, 85, 19],
    '6210': [50, 90, 20],
    '6211': [55, 100, 21],
    '6212': [60, 110, 22],
  });

/**
 * A solid of revolution about the +Z axis through `origin`: the closed outline `rz` (radius,
 * height) turned once round. Radii must be ≥ 0 (a point on the axis closes the outline there).
 */
export function revolveOutline(
  b: CadBuilder,
  name: string,
  rz: [number, number][],
  origin: V3 = [0, 0, 0],
  look?: Partial<CadAppearance>,
): string {
  const section = b.polygon(`${name} outline`, { origin, orientation: xzPlane }, rz);
  return b.revolve(name, section, { axisDirection: [0, 1] }, look);
}

/** A ring of rectangular section with its corners chamfered by `c` (bearing rings, spacers). */
export function chamferedRing(
  b: CadBuilder,
  name: string,
  a: { inner: number; outer: number; z0: number; z1: number; c?: number; origin?: V3 },
  look?: Partial<CadAppearance>,
): string {
  const c = a.c ?? 0;
  const { inner: r0, outer: r1, z0, z1 } = a;
  const rz: [number, number][] =
    c > 0
      ? [
          [r0 + c, z0],
          [r1 - c, z0],
          [r1, z0 + c],
          [r1, z1 - c],
          [r1 - c, z1],
          [r0 + c, z1],
          [r0, z1 - c],
          [r0, z0 + c],
        ]
      : [
          [r0, z0],
          [r1, z0],
          [r1, z1],
          [r0, z1],
        ];
  return revolveOutline(b, name, rz, a.origin, look);
}

/**
 * A deep-groove ball bearing of series 02 by its code (e.g. '6208'), as one body: the outer and
 * inner rings and the balls between them, each ball sunk a little into both rings' grooves.
 */
export function ballBearing(
  b: CadBuilder,
  name: string,
  code: string,
  origin: V3 = [0, 0, 0],
): string {
  const dims = bearingSeries02[code];
  if (!dims) throw new Error(`bearing-code:${code}`);
  const [d, D, B] = dims;
  // Ring sections: each a quarter of the radial height; the balls fill the middle and sink 0.2 mm.
  const h = (D - d) / 2;
  const innerOuter = d / 2 + h * 0.3;
  const outerInner = D / 2 - h * 0.3;
  const pitch = (innerOuter + outerInner) / 2;
  const ball = (outerInner - innerOuter) / 2 + 0.2;
  const c = Math.min(0.6, B / 20);
  const steel = { color: '#9aa3ab', metalness: 0.9, roughness: 0.3 };
  const outer = chamferedRing(
    b,
    `${name} outer ring`,
    { inner: outerInner, outer: D / 2, z0: 0, z1: B, c, origin },
    steel,
  );
  const inner = chamferedRing(
    b,
    `${name} inner ring`,
    { inner: d / 2, outer: innerOuter, z0: 0, z1: B, c, origin },
    steel,
  );
  const balls = Math.max(7, Math.floor((2 * Math.PI * pitch) / (2 * ball * 1.35)));
  const at: V3 = [origin[0] + pitch, origin[1], origin[2] + B / 2];
  const ballId = b.sphere(`${name} ball`, { radius: ball, origin: at }, steel);
  // Copy i of the pattern sits i steps round from the tool, the tool itself copy 0.
  b.pattern(
    outer,
    ballId,
    {
      type: 'circular',
      axisOrigin: origin,
      axisDirection: [0, 0, 1],
      count: balls,
      angle: (2 * Math.PI) / balls,
    },
    'union',
  );
  b.boolean(outer, [inner], 'union', name);
  return outer;
}

/** A radial lip oil seal for a shaft of `d` in a bore of `D`, `B` wide: case and lip. */
export function oilSeal(
  b: CadBuilder,
  name: string,
  a: { d: number; D: number; B: number; origin?: V3 },
): string {
  const { d, D, B } = a;
  const r = d / 2;
  const R = D / 2;
  // The case (an L: outer wall and back plate) with the rubber lip running from the plate's
  // inner edge down to the shaft, its edge 0.3 mm in (the interference).
  const rz: [number, number][] = [
    [r + 1.5, 0],
    [R, 0],
    [R, B],
    [R - 1.5, B],
    [R - 1.5, 1.2],
    [r + 2.5, 1.2],
    [r + 0.6, B * 0.75],
    [r - 0.3, B * 0.75],
  ];
  return revolveOutline(b, name, rz, a.origin, { color: '#2b2b2b', roughness: 0.8 });
}

/**
 * A 30° involute external spline (stub tooth: addendum 0.5, dedendum 0.9 modules) on a shaft,
 * `length` long from `origin`: `teeth` × `module` is its pitch diameter.
 */
export function splineShaft(
  b: CadBuilder,
  name: string,
  a: { module: number; teeth: number; length: number; origin?: V3; orientation?: Quaternion },
): string {
  return b.spurGear(
    name,
    {
      module: a.module,
      teeth: a.teeth,
      faceWidth: a.length,
      pressureAngle: Math.PI / 6,
      addendum: 0.5,
      dedendum: 0.9,
      ...(a.origin && { origin: a.origin }),
      ...(a.orientation && { orientation: a.orientation }),
    },
    { color: '#8d959c', metalness: 0.85, roughness: 0.35 },
  );
}
