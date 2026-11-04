import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import oracle from '../../test-fixtures/planar-oracle.json';
import { areaSign, exactPoints, orientation, type Sign } from './exact';
import { readFinitePoint, type Point } from './input';
import { pointRelation, segmentRelation } from './predicates';

function numberFromBits(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`), false);
  return view.getFloat64(0, false);
}

const negate = (value: Sign): Sign => (value === 0 ? 0 : value === 1 ? -1 : 1);

describe('private planar input snapshots', () => {
  it('accepts the entire finite range and copies without changing signed zero', () => {
    for (const value of [
      0,
      -0,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
    ]) {
      const input = Object.freeze([value, -value]);
      const result = readFinitePoint(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      expect(result.value).not.toBe(input);
      expect(Object.is(result.value[0], value)).toBe(true);
      expect(Object.is(result.value[1], -value)).toBe(true);
    }
  });

  it('rejects malformed, sparse and nonfinite input rather than coercing it', () => {
    for (const value of [
      null,
      {},
      [],
      [1],
      [1, 2, 3],
      [1, '2'],
      [new Number(1), 2],
      [1n, 2],
      new Float64Array([1, 2]),
      Array(2),
    ])
      expect(readFinitePoint(value)).toEqual({ ok: false, code: 'invalid-input' });
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE * 2])
      for (const input of [
        [value, 0],
        [0, value],
      ])
        expect(readFinitePoint(input)).toEqual({ ok: false, code: 'coordinate-not-finite' });
    // This is represented-value validation: precision lost upstream stays lost.
    expect(readFinitePoint([1e20 + 1, 1e20])).toEqual(readFinitePoint([1e20, 1e20]));
  });

  it('does not execute accessors, inherited coordinates or coercion hooks', () => {
    let calls = 0;
    const accessor = [0, 1];
    Object.defineProperty(accessor, '0', {
      get: () => {
        calls++;
        return 0;
      },
    });
    const inherited = [0, 1];
    delete inherited[0];
    Object.setPrototypeOf(
      inherited,
      Object.create(Array.prototype, {
        0: {
          get: () => {
            calls++;
            return 0;
          },
        },
      }),
    );
    const coercion = {
      valueOf: () => {
        calls++;
        return 1;
      },
    };
    for (const input of [accessor, inherited, [coercion, 0]])
      expect(readFinitePoint(input)).toEqual({ ok: false, code: 'invalid-input' });
    expect(calls).toBe(0);
  });
});

describe('private exact planar arithmetic', () => {
  it('uses the least canonical exponent of the whole call, with an all-zero case', () => {
    expect(
      exactPoints([
        [1, 2],
        [0.5, -4],
      ]),
    ).toEqual([
      [2n, 4n],
      [1n, -8n],
    ]);
    expect(
      exactPoints([
        [0, -0],
        [-0, 0],
      ]),
    ).toEqual([
      [0n, 0n],
      [0n, 0n],
    ]);
    expect(exactPoints([])).toEqual([]);
    const [small, large] = exactPoints([
      [Number.MIN_VALUE, 0],
      [Number.MAX_VALUE, 0],
    ]);
    expect(small).toEqual([1n, 0n]);
    expect(large[0].toString(2).length).toBe(2098);
    for (const coordinate of [NaN, Infinity, -Infinity])
      expect(() => exactPoints([[coordinate, 0]])).toThrow('planar-internal-nonfinite');
  });

  it('retains triangle orientation and area at every finite exponent field', () => {
    for (let exponent = 0; exponent < 2047; exponent++) {
      const word = (BigInt(exponent) << 52n) | (exponent === 0 ? 1n : 0n);
      const value = numberFromBits(word.toString(16));
      for (const direction of [1, -1]) {
        const points = exactPoints([
          [0, 0],
          [direction * value, 0],
          [0, value],
        ]);
        expect(orientation(points[0], points[1], points[2])).toBe(direction);
        expect(areaSign(points)).toBe(direction);
      }
    }
  });

  it('keeps predicates stable under exact representable scale and translation', () => {
    const points: readonly Point[] = [
      [0, 0],
      [4, 4],
      [0, 4],
      [4, 0],
    ];
    for (const power of [-1000, -600, 0, 600, 1000]) {
      for (const offset of [0, 64]) {
        const input = points.map(
          ([x, y]) =>
            Object.freeze([(x + offset) * 2 ** power, (y - offset) * 2 ** power]) as Point,
        );
        const before = input.map((p) => [...p]);
        const [a, b, c, d] = exactPoints(Object.freeze(input));
        expect(segmentRelation(a, b, c, d)).toBe('cross');
        expect(orientation(a, b, c)).toBe(1);
        expect(areaSign([a, b, c, d])).toBe(0); // Bow-tie, not a valid-ring claim.
        expect(input).toEqual(before);
      }
    }
  });

  it('does not mistake a rounded float determinant for exact collinearity', () => {
    const u = 2 ** -52;
    const input: readonly Point[] = [
      [0, 0],
      [1, 1 + u],
      [1 - u, 1],
    ];
    expect(input[1][0] * input[2][1] - input[1][1] * input[2][0]).toBe(0);
    const [a, b, c] = exactPoints(input);
    expect(orientation(a, b, c)).toBe(1);
    expect(areaSign([a, b, c])).toBe(1);
  });
});

describe('independent Python Fraction golden (Node-only consumption)', () => {
  it('pins the reviewed generator source and preserves all four segment outcomes', () => {
    const source = readFileSync(
      new URL('../../test-fixtures/generate-planar-oracle.py', import.meta.url),
    );
    expect(createHash('sha256').update(source).digest('hex')).toBe(oracle.generatorSha256);
    expect(oracle.schema).toBe(1);
    expect(new Set(oracle.cases.map((row) => row.id)).size).toBe(oracle.cases.length);
    expect(new Set(oracle.cases.map((row) => row.segmentRelation))).toEqual(
      new Set(['disjoint', 'touch', 'cross', 'overlap']),
    );
  });

  it.each(oracle.cases)('$id', (row) => {
    const input = row.points.map(([x, y]) => [numberFromBits(x), numberFromBits(y)] as const);
    for (const point of input) expect(readFinitePoint(point).ok).toBe(true);
    const points = exactPoints(input);
    const [a, b, c, d] = points;
    expect(orientation(a, b, c)).toBe(row.orientation);
    expect(pointRelation(a, b, c)).toBe(row.pointRelation);
    expect(segmentRelation(a, b, c, d)).toBe(row.segmentRelation);
    expect(areaSign(points)).toBe(row.areaSign);
    expect(orientation(a, c, b)).toBe(negate(row.orientation as Sign));
    expect(pointRelation(a, c, b)).toBe(row.pointRelation);
    for (const args of [
      [b, a, c, d],
      [a, b, d, c],
      [c, d, a, b],
      [d, c, b, a],
    ] as const)
      expect(segmentRelation(...args)).toBe(row.segmentRelation);
    expect(areaSign([...points].reverse())).toBe(negate(row.areaSign as Sign));
    expect(areaSign([...points.slice(1), points[0]])).toBe(row.areaSign);
  });
});
