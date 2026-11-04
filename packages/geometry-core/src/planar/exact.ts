import type { Point } from './input';

/** Exact integer coordinates at one common, positive power-of-two scale. */
export type ExactPoint = readonly [bigint, bigint];
export type Sign = -1 | 0 | 1;
type Dyadic = { mantissa: bigint; exponent: number };

function dyadic(value: number, view: DataView): Dyadic {
  // Internal precondition, not the future public validation result contract.
  if (!Number.isFinite(value)) throw new RangeError('planar-internal-nonfinite');
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const biasedExponent = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  let exponent = biasedExponent === 0 ? -1074 : biasedExponent - 1075;
  if (biasedExponent !== 0) mantissa |= 0x10000000000000n;
  if (mantissa === 0n) return { mantissa: 0n, exponent: 0 };
  while ((mantissa & 1n) === 0n) {
    mantissa >>= 1n;
    exponent++;
  }
  if (bits >> 63n !== 0n) mantissa = -mantissa;
  return { mantissa, exponent };
}

/**
 * Decode finite snapshots before any coordinate arithmetic. The least canonical
 * exponent across the whole call preserves every bit, including mixed extremes.
 * No integer division, float subtraction, rescaling, or epsilon is involved.
 */
export function exactPoints(points: readonly Point[]): readonly ExactPoint[] {
  const view = new DataView(new ArrayBuffer(8));
  const decoded = points.map(([x, y]) => [dyadic(x, view), dyadic(y, view)] as const);
  let exponent = Infinity;
  for (const point of decoded)
    for (const coordinate of point)
      if (coordinate.mantissa !== 0n) exponent = Math.min(exponent, coordinate.exponent);
  if (exponent === Infinity) exponent = 0;
  const integer = (value: Dyadic) =>
    value.mantissa === 0n ? 0n : value.mantissa << BigInt(value.exponent - exponent);
  return decoded.map(([x, y]) => [integer(x), integer(y)] as const);
}

export function sign(value: bigint): Sign {
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}

/** Mathematical y-up orientation; positive means counterclockwise. */
export function orientation(a: ExactPoint, b: ExactPoint, c: ExactPoint): Sign {
  return sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
}

/** Algebraic area sign only; this does not validate a ring or its closure. */
export function areaSign(points: readonly ExactPoint[]): Sign {
  let twiceArea = 0n;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twiceArea += a[0] * b[1] - a[1] * b[0];
  }
  return sign(twiceArea);
}
