import { describe, expect, it } from 'vitest';
import { decimal, add, multiply, divide, quantize, formatDecimal, numberDecimal } from './decimal';
import { convert } from './units';
import { assertJson } from './json';
const d = decimal,
  f = formatDecimal;
describe('exact decimal contract AN02', () => {
  it('preserves exact decimal sums and multiplication', () => {
    expect(f(add(d('0.1'), d('0.2')))).toBe('0.3');
    expect(f(multiply(d('9007199254740993'), d('2')))).toBe('18014398509481986');
    expect(f(convert(d('1000'), 'mm', 'm'))).toBe('1');
    expect(f(convert(d('2'), 'hour', 'minute'))).toBe('120');
  });
  it('requires explicit rounding and handles negative ties', () => {
    expect(f(divide(d('1'), d('3'), 12, 'half-even'))).toBe('0.333333333333');
    expect(f(quantize(d('2.5'), 0, 'half-even'))).toBe('2');
    expect(f(quantize(d('-2.5'), 0, 'half-up'))).toBe('-3');
    expect(f(quantize(d('-2.1'), 0, 'floor'))).toBe('-3');
    expect(f(quantize(d('-2.1'), 0, 'ceil'))).toBe('-2');
    expect(() => divide(d('1'), d('0'), 2, 'half-even')).toThrow('division-by-zero');
  });
  it('rejects noncanonical inputs, overflow and dimension mismatches', () => {
    for (const value of [
      '-0',
      '01',
      '1.0',
      '1e2',
      'NaN',
      'Infinity',
      '0.0000000000001',
      '1'.repeat(35),
    ])
      expect(() => d(value)).toThrow();
    expect(() => convert(d('1'), 'm', 'm2')).toThrow('unit-mismatch');
    expect(() => numberDecimal(9007199254740992)).toThrow('unsafe-source-number');
    expect(numberDecimal(1e-7)).toBe('0.0000001');
  });
});
it('rejects getters without executing them and rejects sparse arrays AN03', () => {
  let called = false;
  const value = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      called = true;
      return 1;
    },
  });
  expect(() => assertJson(value)).toThrow('non-json');
  expect(called).toBe(false);
  expect(() => assertJson(Array(2))).toThrow('non-json');
});
it('converts whole hours exactly after reducing the rational factor', () => {
  expect(f(convert(d('60'), 'minute', 'hour'))).toBe('1');
  expect(() => convert(d('1'), 'minute', 'hour')).toThrow('explicit-rounding-required');
});
