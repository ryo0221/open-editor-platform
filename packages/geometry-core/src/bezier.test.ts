import { describe, expect, it } from 'vitest';
import {
  boundsBezier3,
  derivativeBezier3,
  evaluateBezier3,
  secondDerivativeBezier3,
  splitBezier3,
  type Bezier3,
} from '@editor-platform/geometry-core/bezier';
const arch: Bezier3 = [
  [0, 0],
  [0, 100],
  [100, 100],
  [100, 0],
];
describe('unit-free cubic Bézier', () => {
  it('matches analytic endpoints, midpoint and derivatives', () => {
    expect(evaluateBezier3(arch, 0)).toEqual([0, 0]);
    expect(evaluateBezier3(arch, 1)).toEqual([100, 0]);
    expect(evaluateBezier3(arch, 0.5)).toEqual([50, 75]);
    expect(derivativeBezier3(arch, 0.5)).toEqual([150, 0]);
    expect(secondDerivativeBezier3(arch, 0.5)).toEqual([0, -600]);
    expect(boundsBezier3(arch)).toEqual({ min: [0, 0], max: [100, 75] });
  });
  it('preserves geometry under de Casteljau subdivision', () => {
    for (const at of [0, 0.01, 0.37, 0.5, 1]) {
      const [left, right] = splitBezier3(arch, at);
      for (let i = 0; i <= 50; i++)
        for (const [part, parameter] of [
          [left, (at * i) / 50],
          [right, at + ((1 - at) * i) / 50],
        ] as const) {
          const actual = evaluateBezier3(part, i / 50),
            expected = evaluateBezier3(arch, parameter);
          actual.forEach((v, axis) => expect(v).toBeCloseTo(expected[axis], 10));
        }
    }
  });
  it('bounds degenerate, linear and two-extrema cubics without flattening', () => {
    const curves: Bezier3[] = [
      arch,
      [
        [2, 3],
        [2, 3],
        [2, 3],
        [2, 3],
      ],
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      [
        [-1, 0],
        [200, -300],
        [-200, 300],
        [1, 0],
      ],
    ];
    for (const curve of curves) {
      const bounds = boundsBezier3(curve);
      for (let i = 0; i <= 1000; i++)
        evaluateBezier3(curve, i / 1000).forEach((v, axis) => {
          expect(v).toBeGreaterThanOrEqual(bounds.min[axis] - 1e-10);
          expect(v).toBeLessThanOrEqual(bounds.max[axis] + 1e-10);
        });
    }
  });
  it('refuses nonfinite, out-of-range coordinates and parameters explicitly', () => {
    for (const t of [-1, 1.01, NaN, Infinity])
      for (const fn of [evaluateBezier3, derivativeBezier3, secondDerivativeBezier3, splitBezier3])
        expect(() => fn(arch, t)).toThrow('bezier-parameter');
    for (const x of [NaN, Infinity, -Infinity, 1e12 + 1]) {
      const bad: Bezier3 = [[x, 0], arch[1], arch[2], arch[3]];
      for (const fn of [evaluateBezier3, derivativeBezier3, secondDerivativeBezier3, splitBezier3])
        expect(() => fn(bad, 0.5)).toThrow('bezier-coordinate');
      expect(() => boundsBezier3(bad)).toThrow('bezier-coordinate');
    }
  });
});

it('retains both lobes at very small scales without discriminant underflow', () => {
  const small: Bezier3 = [
      [0, 0],
      [1e-200, 0],
      [-1e-200, 0],
      [0, 0],
    ],
    box = boundsBezier3(small),
    peak = Math.sqrt(3) / 6;
  expect(box.min[0] / 1e-200).toBeCloseTo(-peak, 14);
  expect(box.max[0] / 1e-200).toBeCloseTo(peak, 14);
});
it('preserves exact endpoint splits across large differences in magnitude', () => {
  const curve: Bezier3 = [
    [0, -0],
    [-1e12, 10],
    [-1e12, -10],
    [0.1, 0],
  ];
  const [left, right] = splitBezier3(curve, 1);
  expect(left).toEqual(curve);
  for (const p of right) p.forEach((value, i) => expect(Object.is(value, curve[3][i])).toBe(true));
  const [start, rest] = splitBezier3(curve, 0);
  expect(rest).toEqual(curve);
  for (const p of start) p.forEach((value, i) => expect(Object.is(value, curve[0][i])).toBe(true));
});
