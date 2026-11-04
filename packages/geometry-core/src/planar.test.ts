import { describe, expect, it } from 'vitest';
import * as root from '@editor-platform/geometry-core';
import {
  classifySegments,
  planarLimits,
  pointOnSegment,
  validatePlanarPoint,
  validateRing,
  type PlanarPoint,
  type RingOptions,
} from '@editor-platform/geometry-core/planar';

const options: RingOptions = { maxVertices: 1000 };
const triangle: readonly PlanarPoint[] = [
  [0, 0],
  [4, 0],
  [0, 3],
  [0, 0],
];
const valid = (vertexCount: number, winding = 'positive') => ({
  ok: true,
  value: { vertexCount, winding },
});
const geometry = (
  code: string,
  indices?: { vertexIndices?: number[]; edgeIndices?: number[] },
) => ({ ok: false, diagnostic: { kind: 'geometry', code, ...indices } });
const tiny = Number.MIN_VALUE;
const max = Number.MAX_VALUE;

describe('public planar ring contract F01–F21', () => {
  it.each([
    ['F01 triangle', triangle, 3],
    [
      'F02 rectangle',
      [
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
        [0, 0],
      ],
      4,
    ],
    [
      'F03 concave',
      [
        [0, 0],
        [4, 0],
        [4, 1],
        [1, 1],
        [1, 4],
        [0, 4],
        [0, 0],
      ],
      6,
    ],
    [
      'F09 redundant collinear vertex',
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
      5,
    ],
    [
      'F12 subnormal',
      [
        [0, 0],
        [tiny, 0],
        [0, tiny],
        [0, 0],
      ],
      3,
    ],
    ['F12 tiny area', triangle.map(([x, y]) => [x * 2 ** -600, y * 2 ** -600]), 3],
    [
      'F13 finite inputs with overflowing float differences',
      [
        [-max, -max],
        [max, -max],
        [0, max],
        [-max, -max],
      ],
      3,
    ],
    [
      'F14 large origin with representable ULP',
      [
        [1e20, 1e20],
        [1e20 + 16384, 1e20],
        [1e20, 1e20 + 16384],
        [1e20, 1e20],
      ],
      3,
    ],
    [
      'F16 near collinear',
      [
        [0, 0],
        [1, 1],
        [2, 2 + 2 ** -50],
        [0, 0],
      ],
      3,
    ],
    [
      'F17 near duplicate',
      [
        [0, 0],
        [2 ** -40, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
      4,
    ],
    [
      'F20 signed-zero closure',
      [
        [0, 0],
        [4, 0],
        [0, 3],
        [-0, 0],
      ],
      3,
    ],
  ] as const)('%s', (_name, input, count) => {
    const before = structuredClone(input);
    expect(validateRing(input, options)).toEqual(valid(count));
    expect(validateRing([...input].reverse(), options)).toEqual(valid(count, 'negative'));
    expect(input).toEqual(before);
  });

  it.each([
    [
      'F04 bow-tie diagnosed before algebraic area zero',
      [
        [0, 0],
        [2, 2],
        [0, 2],
        [2, 0],
        [0, 0],
      ],
      geometry('self-crossing', { edgeIndices: [0, 2] }),
    ],
    [
      'F05 adjacent duplicate',
      [
        [0, 0],
        [2, 0],
        [2, 0],
        [0, 2],
        [0, 0],
      ],
      geometry('adjacent-duplicate', { vertexIndices: [1, 2] }),
    ],
    [
      'F06 repeated non-closing vertex',
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 0],
        [0, 2],
        [0, 0],
      ],
      geometry('repeated-vertex', { vertexIndices: [0, 3] }),
    ],
    ['F07 implicit closure', triangle.slice(0, -1), geometry('ring-not-closed')],
    [
      'F07 near closure',
      [
        [0, 0],
        [4, 0],
        [0, 3],
        [0, 2 ** -42],
      ],
      geometry('ring-not-closed'),
    ],
    [
      'F08 all collinear',
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 0],
      ],
      geometry('zero-area'),
    ],
    [
      'F10 adjacent backtracking',
      [
        [0, 0],
        [3, 0],
        [1, 0],
        [1, 2],
        [0, 2],
        [0, 0],
      ],
      geometry('edge-overlap', { edgeIndices: [0, 1] }),
    ],
    [
      'F11 nonadjacent T contact',
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 0],
        [0, 4],
        [0, 0],
      ],
      geometry('self-contact', { edgeIndices: [0, 2] }),
    ],
    [
      'F15 lost increment remains duplicate',
      [
        [1e20, 1e20],
        [1e20 + 1, 1e20],
        [1e20, 1e20 + 1],
        [1e20, 1e20],
      ],
      geometry('adjacent-duplicate', { vertexIndices: [0, 1] }),
    ],
    ['F19 empty', [], geometry('too-few-vertices')],
    [
      'F19 two distinct vertices',
      [
        [0, 0],
        [1, 0],
        [0, 0],
      ],
      geometry('too-few-vertices'),
    ],
  ])('%s', (_name, input, expected) => {
    expect(validateRing(input, options)).toEqual(expected);
  });

  it('F18 rejects nonfinite values and raw closure errors before geometry checks', () => {
    for (const value of [NaN, Infinity, -Infinity, max * 2])
      expect(
        validateRing(
          [
            [0, 0],
            [4, 0],
            [0, 3],
            [value, 0],
          ],
          options,
        ),
      ).toEqual({
        ok: false,
        diagnostic: { kind: 'input', code: 'coordinate-not-finite', vertexIndices: [3] },
      });
    for (const point of [[0, 0, 0], ['0', 0], null, new Float64Array([0, 0])])
      expect(validateRing([point, [1, 0], [0, 1], [0, 0]], options)).toEqual({
        ok: false,
        diagnostic: { kind: 'input', code: 'invalid-input', vertexIndices: [0] },
      });
  });

  it('F21 counts non-closing vertices; budget precedes point getters and closure', () => {
    expect(validateRing(triangle, { maxVertices: 3 })).toEqual(valid(3));
    let calls = 0;
    const long = Array(5);
    Object.defineProperty(long, '0', {
      get: () => {
        calls++;
        throw Error('must not read');
      },
    });
    expect(validateRing(long, { maxVertices: 3 })).toEqual({
      ok: false,
      diagnostic: { kind: 'budget', code: 'vertex-limit' },
    });
    expect(calls).toBe(0);
    expect(
      validateRing(
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        { maxVertices: 3 },
      ),
    ).toEqual(geometry('ring-not-closed'));
    expect(Reflect.set(planarLimits, 'maxVertices', Infinity)).toBe(false);
    for (const config of [
      undefined,
      null,
      [],
      {},
      { maxVertices: '3' },
      { maxVertices: 2 },
      { maxVertices: 3.5 },
      { maxVertices: 1001 },
      { maxVertices: Infinity },
      { maxVertices: NaN },
    ])
      expect(validateRing(triangle, config as RingOptions)).toEqual({
        ok: false,
        diagnostic: { kind: 'input', code: 'invalid-limit' },
      });
  });

  it('F21 validates a simple ring at the hard ceiling without removing straight vertices', () => {
    const points: PlanarPoint[] = [];
    for (let i = 0; i < 250; i++) points.push([i, 0]);
    for (let i = 0; i < 250; i++) points.push([250, i]);
    for (let i = 0; i < 250; i++) points.push([250 - i, 250]);
    for (let i = 0; i < 250; i++) points.push([0, 250 - i]);
    points.push(points[0]);
    expect(validateRing(points, options)).toEqual(valid(1000));
    expect(validateRing([...points, points[0]], options)).toEqual({
      ok: false,
      diagnostic: { kind: 'budget', code: 'vertex-limit' },
    });
  });

  it('does not execute outer/point/option accessors or read inherited coordinates', () => {
    let calls = 0;
    const ring = [...triangle];
    Object.defineProperty(ring, '0', {
      get: () => {
        calls++;
        return [0, 0];
      },
    });
    expect(validateRing(ring, options)).toEqual({
      ok: false,
      diagnostic: { kind: 'input', code: 'invalid-input', vertexIndices: [0] },
    });
    const config = Object.defineProperty({}, 'maxVertices', {
      get: () => {
        calls++;
        return 3;
      },
    });
    expect(validateRing(triangle, config as RingOptions)).toEqual({
      ok: false,
      diagnostic: { kind: 'input', code: 'invalid-limit' },
    });
    expect(validateRing(Array(4), options)).toEqual({
      ok: false,
      diagnostic: { kind: 'input', code: 'invalid-input', vertexIndices: [0] },
    });
    expect(calls).toBe(0);
    expect(validateRing({ 0: [0, 0], length: 4 }, options)).toEqual({
      ok: false,
      diagnostic: { kind: 'input', code: 'invalid-input' },
    });
  });

  it('returns independent metadata; success does not brand a future mutable input', () => {
    const input = triangle.map((p) => [...p]);
    expect(
      validateRing(Object.freeze(triangle.map((p) => Object.freeze([...p]))), options),
    ).toEqual(valid(3));
    const result = validateRing(input, options);
    input[1] = [0, 0];
    expect(result).toEqual(valid(3));
    expect(validateRing(input, options)).toEqual(
      geometry('adjacent-duplicate', { vertexIndices: [0, 1] }),
    );
    expect(root).not.toHaveProperty('validateRing');
  });
});

describe('public point and closed segment results', () => {
  it('copies finite values without coercion', () => {
    const point = [0, -0];
    const result = validatePlanarPoint(point);
    expect(result).toEqual({ ok: true, value: point });
    if (result.ok) expect(result.value).not.toBe(point);
    expect(validatePlanarPoint([Infinity, 0])).toEqual({
      ok: false,
      diagnostic: { kind: 'input', code: 'coordinate-not-finite' },
    });
  });
  it('distinguishes point positions and degenerate segments', () => {
    expect(pointOnSegment([1, 0], [0, 0], [2, 0])).toEqual({ ok: true, value: 'interior' });
    expect(pointOnSegment([2, 0], [0, 0], [2, 0])).toEqual({ ok: true, value: 'endpoint' });
    expect(pointOnSegment([1, 2 ** -42], [0, 0], [2, 0])).toEqual({ ok: true, value: 'outside' });
    expect(pointOnSegment([1, 0], [1, 0], [1, 0])).toEqual({ ok: true, value: 'endpoint' });
    expect(classifySegments([0, 0], [0, 0], [1, 0], [1, 0])).toEqual({
      ok: true,
      value: 'disjoint',
    });
    expect(classifySegments([1, 0], [1, 0], [0, 0], [2, 0])).toEqual({ ok: true, value: 'touch' });
    expect(classifySegments([0, 0], [2, 0], [1, 0], [3, 0])).toEqual({
      ok: true,
      value: 'overlap',
    });
    expect(classifySegments([0, 0], [2, 2], [0, 2], [2, 0])).toEqual({ ok: true, value: 'cross' });
  });
  it('returns input failures rather than disguising them as disjoint/outside', () => {
    expect(pointOnSegment([0, 0], [Infinity, 0], [1, 1])).toEqual({
      ok: false,
      diagnostic: { kind: 'input', code: 'coordinate-not-finite', vertexIndices: [1] },
    });
    expect(classifySegments([0, 0], [1, 0], null as unknown as PlanarPoint, [1, 1])).toEqual({
      ok: false,
      diagnostic: { kind: 'input', code: 'invalid-input', vertexIndices: [2] },
    });
  });
});
