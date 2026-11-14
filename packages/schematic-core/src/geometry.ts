import {
  schematicGridMm,
  type SchematicDocument,
  type SchematicPart,
  type SchematicPin,
  type SchematicRotation,
  type SchematicSymbol,
  type Vec2,
} from './model';

/**
 * Grid arithmetic (SL1). Points are kept in mm in the document but compared in whole grid steps,
 * so float noise never decides whether two ends meet.
 */
export type GridPoint = [number, number];

/** True when `v` mm is a whole number of grid steps (to 1 nm). */
export function onGrid(v: number): boolean {
  const k = v / schematicGridMm;
  return Math.abs(k - Math.round(k)) * schematicGridMm < 1e-6;
}
export const toGrid = (p: Vec2): GridPoint => [
  Math.round(p[0] / schematicGridMm),
  Math.round(p[1] / schematicGridMm),
];
/** mm of a grid point, rounded to 1 nm so the stored numbers stay short. */
export const fromGrid = (g: GridPoint): Vec2 => [
  Math.round(g[0] * schematicGridMm * 1e6) / 1e6 + 0,
  Math.round(g[1] * schematicGridMm * 1e6) / 1e6 + 0,
];
/** Snaps a sheet point to the nearest grid point. */
export const snapSchematic = (p: Vec2): Vec2 => fromGrid(toGrid(p));
export const gridKey = (g: GridPoint) => `${g[0]},${g[1]}`;

/** A symbol-frame point on the sheet: mirrored (x → −x), turned clockwise (y down), moved. */
export function partPoint(
  part: Pick<SchematicPart, 'at' | 'rotationDeg' | 'mirror'>,
  p: Vec2,
): Vec2 {
  return fromGrid(partGridPoint(part, toGrid(p)));
}
function turn([x, y]: GridPoint, rotation: SchematicRotation): GridPoint {
  // Clockwise on a y-down sheet: right → down → left → up.
  switch (rotation) {
    case 90:
      return [-y, x];
    case 180:
      return [-x, -y];
    case 270:
      return [y, -x];
    default:
      return [x, y];
  }
}
export function partGridPoint(
  part: Pick<SchematicPart, 'at' | 'rotationDeg' | 'mirror'>,
  g: GridPoint,
): GridPoint {
  const m: GridPoint = part.mirror ? [-g[0], g[1]] : g;
  const t = turn(m, part.rotationDeg);
  const at = toGrid(part.at);
  return [t[0] + at[0] + 0, t[1] + at[1] + 0];
}
/** Any symbol-frame point (not only grid points) on the sheet, for drawing. */
export function partDrawPoint(
  part: Pick<SchematicPart, 'at' | 'rotationDeg' | 'mirror'>,
  [x, y]: Vec2,
): Vec2 {
  const mx = part.mirror ? -x : x;
  const r = part.rotationDeg;
  const [tx, ty] = r === 90 ? [-y, mx] : r === 180 ? [-mx, -y] : r === 270 ? [y, -mx] : [mx, y];
  return [tx + part.at[0], ty + part.at[1]];
}

export interface PlacedPin {
  part: string;
  pin: SchematicPin;
  /** The connection end on the sheet, in grid steps. */
  end: GridPoint;
}
/** Every pin end of every part whose symbol exists. */
export function placedPins(doc: SchematicDocument): PlacedPin[] {
  const symbols = new Map<string, SchematicSymbol>(doc.symbols.map((s) => [s.id, s]));
  const out: PlacedPin[] = [];
  for (const part of doc.parts) {
    const symbol = symbols.get(part.symbol);
    if (!symbol) continue;
    for (const pin of symbol.pins)
      out.push({ part: part.id, pin, end: partGridPoint(part, toGrid(pin.at)) });
  }
  return out;
}

/** True when grid point `p` lies on the segment a–b (ends included); segments are orthogonal. */
export function onSegment(p: GridPoint, a: GridPoint, b: GridPoint): boolean {
  if (a[0] === b[0])
    return p[0] === a[0] && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
  if (a[1] === b[1])
    return p[1] === a[1] && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]);
  return false;
}
/** True when `p` lies on the wire strictly between its vertices (not on any vertex). */
export function onWireInterior(p: GridPoint, points: readonly GridPoint[]): boolean {
  if (points.some((q) => q[0] === p[0] && q[1] === p[1])) return false;
  for (let i = 1; i < points.length; i++) if (onSegment(p, points[i - 1], points[i])) return true;
  return false;
}
/** True when `p` is on the wire at all (a vertex or between). */
export function onWire(p: GridPoint, points: readonly GridPoint[]): boolean {
  for (let i = 1; i < points.length; i++) if (onSegment(p, points[i - 1], points[i])) return true;
  return false;
}

/** Drops repeated points and the middle of three collinear points (an orthogonal polyline). */
export function simplifyWire(points: readonly GridPoint[]): GridPoint[] {
  const out: GridPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push([p[0], p[1]]);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const straight = (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
      if (!straight) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}
