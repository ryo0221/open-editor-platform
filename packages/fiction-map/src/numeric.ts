/** Domain-local arithmetic. One integer unit is 2^-1074; all finite binary64 values are exact. */
const view = new DataView(new ArrayBuffer(8));
export const quantum = 1n << 1074n;
export type ExactPoint = readonly [bigint, bigint];
export function exact(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error('fiction-map-numeric-nonfinite');
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const e = Number((bits >> 52n) & 2047n),
    f = bits & ((1n << 52n) - 1n);
  const n = e === 0 ? f : ((1n << 52n) | f) << BigInt(e - 1);
  return bits >> 63n ? -n : n;
}
export const exactPoint = (p: readonly [number, number]): ExactPoint => [exact(p[0]), exact(p[1])];
export const abs = (n: bigint) => (n < 0n ? -n : n);
export const cross = (a: ExactPoint, b: ExactPoint) => a[0] * b[1] - a[1] * b[0];
export const subtract = (a: ExactPoint, b: ExactPoint): ExactPoint => [a[0] - b[0], a[1] - b[1]];
export const squared = (v: ExactPoint) => v[0] * v[0] + v[1] * v[1];
export function twiceArea(points: readonly ExactPoint[]): bigint {
  let sum = 0n;
  for (let i = 0; i < points.length - 1; i++) sum += cross(points[i], points[i + 1]);
  return abs(sum);
}
export function nearSegment(p: ExactPoint, a: ExactPoint, b: ExactPoint, r2: bigint): boolean {
  const v = subtract(b, a),
    w = subtract(p, a),
    l = squared(v),
    dot = v[0] * w[0] + v[1] * w[1];
  if (dot <= 0n) return squared(w) <= r2;
  if (dot >= l) return squared(subtract(p, b)) <= r2;
  const determinant = cross(v, w);
  return determinant * determinant <= r2 * l;
}
export function evenOdd(p: ExactPoint, ring: readonly ExactPoint[]): boolean {
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i],
      b = ring[i + 1];
    if (a[1] > p[1] !== b[1] > p[1]) {
      const sign = cross(subtract(b, a), subtract(p, a));
      if (sign > 0n === b[1] > a[1]) inside = !inside;
    }
  }
  return inside;
}
export function snapped(value: number, step: number): number {
  const v = exact(value),
    s = exact(step),
    m = abs(v);
  let n = m / s;
  const rem = m % s;
  if (rem * 2n > s || (rem * 2n === s && n % 2n === 1n)) n++;
  return Number(v < 0n ? -n : n) * step;
}
