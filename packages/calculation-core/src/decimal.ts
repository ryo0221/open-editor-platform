/** Exact finite decimal arithmetic. No implicit rounding, locale parsing or binary64 arithmetic. */
export class CalculationError extends Error {
  constructor(
    readonly code: string,
    readonly path = '',
    message = code,
  ) {
    super(`${message}${path ? ` (${path})` : ''}`);
  }
}
export type Rounding = 'half-even' | 'half-up' | 'floor' | 'ceil';
export interface Decimal {
  coefficient: bigint;
  scale: number;
}
const pow = (n: number) => 10n ** BigInt(n);
export function normalize(d: Decimal): Decimal {
  let { coefficient, scale } = d;
  if (!coefficient) return { coefficient: 0n, scale: 0 };
  while (scale && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale--;
  }
  const digits = coefficient.toString().replace('-', '').length;
  if (digits > 68 || scale > 24) throw new CalculationError('numeric-overflow');
  return { coefficient, scale };
}
export function decimal(text: string, persisted = true): Decimal {
  if (typeof text !== 'string' || text.length > 96 || !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text))
    throw new CalculationError('invalid-decimal');
  const [integer, fraction = ''] = text.split('.');
  const d = normalize({ coefficient: BigInt(integer + fraction), scale: fraction.length });
  if (formatDecimal(d) !== text) throw new CalculationError('noncanonical-decimal');
  if (persisted) assertPersistable(d);
  return d;
}
export function assertPersistable(d: Decimal): void {
  const n = normalize(d);
  if (n.coefficient.toString().replace('-', '').length > 34 || n.scale > 12)
    throw new CalculationError('numeric-overflow');
}
export function formatDecimal(d: Decimal): string {
  const n = normalize(d),
    negative = n.coefficient < 0n;
  const digits = (negative ? -n.coefficient : n.coefficient).toString().padStart(n.scale + 1, '0');
  return (
    (negative ? '-' : '') +
    (n.scale ? digits.slice(0, -n.scale) + '.' + digits.slice(-n.scale) : digits)
  );
}
export function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return normalize({
    coefficient: a.coefficient * pow(scale - a.scale) + b.coefficient * pow(scale - b.scale),
    scale,
  });
}
export const subtract = (a: Decimal, b: Decimal) => add(a, { ...b, coefficient: -b.coefficient });
export const multiply = (a: Decimal, b: Decimal) =>
  normalize({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale });
export function compare(a: Decimal, b: Decimal): number {
  const d = subtract(a, b).coefficient;
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}
function rounded(n: bigint, d: bigint, rounding: Rounding): bigint {
  if (!['half-even', 'half-up', 'floor', 'ceil'].includes(rounding))
    throw new CalculationError('invalid-rounding');
  if (!d) throw new CalculationError('division-by-zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d,
    r = n % d,
    sign = n < 0n ? -1n : 1n,
    abs = r < 0n ? -r : r;
  if (!r) return q;
  if (rounding === 'floor') return q + (sign < 0n ? -1n : 0n);
  if (rounding === 'ceil') return q + (sign > 0n ? 1n : 0n);
  return (
    q + (abs * 2n > d || (abs * 2n === d && (rounding === 'half-up' || q % 2n !== 0n)) ? sign : 0n)
  );
}
export function divide(a: Decimal, b: Decimal, scale: number, rounding: Rounding): Decimal {
  if (!Number.isInteger(scale) || scale < 0 || scale > 12)
    throw new CalculationError('invalid-scale');
  const exponent = b.scale + scale - a.scale;
  return normalize({
    coefficient: rounded(
      a.coefficient * pow(Math.max(0, exponent)),
      b.coefficient * pow(Math.max(0, -exponent)),
      rounding,
    ),
    scale,
  });
}
export const quantize = (a: Decimal, scale: number, rounding: Rounding) =>
  divide(a, decimal('1'), scale, rounding);
/** Expand JSON exponent notation before applying the decimal input limits. */
export function numberDecimal(value: number): string {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
    throw new CalculationError('unsafe-source-number');
  const text = JSON.stringify(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) return formatDecimal(decimal(text));
  const [, sign, whole, fraction = '', exponent] = match,
    digits = whole + fraction,
    point = whole.length + Number(exponent);
  const expanded =
    point <= 0
      ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point);
  const d = normalize({
    coefficient: BigInt(sign + expanded.replace('.', '')),
    scale: expanded.includes('.') ? expanded.split('.')[1].length : 0,
  });
  assertPersistable(d);
  return formatDecimal(d);
}
