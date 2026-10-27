import {
  CalculationError,
  decimal,
  multiply,
  divide,
  formatDecimal,
  type Decimal,
  type Rounding,
} from './decimal';
export interface UnitInfo {
  dimensions: Record<string, number>;
  numerator: bigint;
  denominator: bigint;
}
const units: Record<string, [string, number, bigint, bigint]> = {
  dimensionless: ['', 0, 1n, 1n],
  count: ['count', 1, 1n, 1n],
  mm: ['length', 1, 1n, 1000n],
  cm: ['length', 1, 1n, 100n],
  m: ['length', 1, 1n, 1n],
  mm2: ['length', 2, 1n, 1000000n],
  m2: ['length', 2, 1n, 1n],
  mm3: ['length', 3, 1n, 1000000000n],
  m3: ['length', 3, 1n, 1n],
  g: ['mass', 1, 1n, 1000n],
  kg: ['mass', 1, 1n, 1n],
  minute: ['time', 1, 1n, 1n],
  hour: ['time', 1, 60n, 1n],
  workday: ['workday', 1, 1n, 1n],
};
/** Bounded product/quotient of declared units; currency is explicit (currency:JPY:0). */
export function unitInfo(unit = 'dimensionless'): UnitInfo {
  if (unit.length > 256 || !unit) throw new CalculationError('invalid-unit');
  const result: UnitInfo = { dimensions: {}, numerator: 1n, denominator: 1n };
  const tokens = unit.split(/([*/])/);
  let direction = 1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i % 2) {
      direction = token === '/' ? -1 : 1;
      continue;
    }
    const currency = /^currency:([A-Z]{3}):([0-4])$/.exec(token);
    const spec = currency
      ? ([`currency:${currency[1]}:${currency[2]}`, 1, 1n, 1n] as const)
      : units[token];
    if (!spec) throw new CalculationError('unknown-unit', token);
    const [dimension, exponent, numerator, denominator] = spec;
    if (dimension)
      result.dimensions[dimension] = (result.dimensions[dimension] ?? 0) + exponent * direction;
    result.numerator *= direction > 0 ? numerator : denominator;
    result.denominator *= direction > 0 ? denominator : numerator;
  }
  for (const key of Object.keys(result.dimensions))
    if (!result.dimensions[key]) delete result.dimensions[key];
  return result;
}
export function sameDimension(a?: string, b?: string): boolean {
  const x = unitInfo(a).dimensions,
    y = unitInfo(b).dimensions;
  return Object.keys({ ...x, ...y }).every((k) => x[k] === y[k]);
}
export function convert(
  a: Decimal,
  from: string,
  to: string,
  rounding?: { scale: number; rounding: Rounding },
): Decimal {
  if (!sameDimension(from, to)) throw new CalculationError('unit-mismatch');
  const f = unitInfo(from),
    t = unitInfo(to),
    numerator = f.numerator * t.denominator,
    denominator = f.denominator * t.numerator;
  const n = multiply(a, decimal(numerator.toString(), false));
  if (rounding)
    return divide(n, decimal(denominator.toString(), false), rounding.scale, rounding.rounding);
  // All initial conversion ratios terminate; reject a non-terminating implicit conversion.
  let divisor = denominator,
    coefficient = n.coefficient;
  let left = coefficient < 0n ? -coefficient : coefficient,
    right = divisor;
  while (right) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  if (left) {
    divisor /= left;
    coefficient /= left;
  }
  const reduced = { coefficient, scale: n.scale };
  let d = divisor,
    twos = 0,
    fives = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    twos++;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives++;
  }
  if (d !== 1n) throw new CalculationError('explicit-rounding-required');
  const scale = Math.max(twos, fives);
  return multiply(
    reduced,
    decimal(
      formatDecimal({
        coefficient: 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives),
        scale,
      }),
      false,
    ),
  );
}
