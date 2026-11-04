/** Unit-free, exact topology of represented finite binary64 coordinates. */
import { areaSign, exactPoints, orientation } from './planar/exact';
import { readFinitePoint, type Point } from './planar/input';
import {
  pointRelation,
  segmentRelation,
  type PointRelation,
  type SegmentRelation as InternalSegmentRelation,
} from './planar/predicates';

export type PlanarPoint = Point;
export type SegmentPointRelation = PointRelation;
export type SegmentRelation = InternalSegmentRelation;
export type PlanarCode =
  | 'invalid-input'
  | 'coordinate-not-finite'
  | 'invalid-limit'
  | 'vertex-limit'
  | 'ring-not-closed'
  | 'too-few-vertices'
  | 'adjacent-duplicate'
  | 'repeated-vertex'
  | 'zero-area'
  | 'edge-overlap'
  | 'self-crossing'
  | 'self-contact';
export interface PlanarDiagnostic {
  readonly kind: 'input' | 'budget' | 'geometry';
  readonly code: PlanarCode;
  readonly vertexIndices?: readonly number[];
  readonly edgeIndices?: readonly number[];
}
export type PlanarResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostic: PlanarDiagnostic };
export interface RingOptions {
  readonly maxVertices: number;
}
export interface ValidRingInfo {
  readonly vertexCount: number;
  readonly winding: 'positive' | 'negative';
}

// Independent of any domain's aggregate document budget. No UI latency promise.
const MAX_VERTICES = 1000;
export const planarLimits = Object.freeze({ maxVertices: MAX_VERTICES } as const);
const failure = (diagnostic: PlanarDiagnostic): { ok: false; diagnostic: PlanarDiagnostic } => ({
  ok: false,
  diagnostic,
});
const equal = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];

export function validatePlanarPoint(value: unknown): PlanarResult<PlanarPoint> {
  const point = readFinitePoint(value);
  return point.ok ? point : failure({ kind: 'input', code: point.code });
}

function readPoints(values: readonly unknown[]): PlanarResult<readonly Point[]> {
  const points: Point[] = [];
  for (let i = 0; i < values.length; i++) {
    const point = readFinitePoint(values[i]);
    if (!point.ok) return failure({ kind: 'input', code: point.code, vertexIndices: [i] });
    points.push(point.value);
  }
  return { ok: true, value: points };
}

export function pointOnSegment(
  point: PlanarPoint,
  start: PlanarPoint,
  end: PlanarPoint,
): PlanarResult<SegmentPointRelation> {
  const input = readPoints([point, start, end]);
  if (!input.ok) return input;
  const [p, a, b] = exactPoints(input.value);
  return { ok: true, value: pointRelation(p, a, b) };
}

export function classifySegments(
  a: PlanarPoint,
  b: PlanarPoint,
  c: PlanarPoint,
  d: PlanarPoint,
): PlanarResult<SegmentRelation> {
  const input = readPoints([a, b, c, d]);
  if (!input.ok) return input;
  const [p, q, r, s] = exactPoints(input.value);
  return { ok: true, value: segmentRelation(p, q, r, s) };
}

function vertexLimit(options: RingOptions): number | undefined {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return;
  const slot = Object.getOwnPropertyDescriptor(options, 'maxVertices');
  if (
    slot &&
    'value' in slot &&
    Number.isSafeInteger(slot.value) &&
    slot.value >= 3 &&
    slot.value <= MAX_VERTICES
  )
    return slot.value;
}

/**
 * One explicit closed, simple, nonzero-area ring. No repair, epsilon or domain
 * rules. The length guard precedes point inspection and exact conversion.
 */
export function validateRing(value: unknown, options: RingOptions): PlanarResult<ValidRingInfo> {
  const maxVertices = vertexLimit(options);
  if (maxVertices === undefined) return failure({ kind: 'input', code: 'invalid-limit' });
  if (!Array.isArray(value)) return failure({ kind: 'input', code: 'invalid-input' });
  if (value.length > maxVertices + 1) return failure({ kind: 'budget', code: 'vertex-limit' });
  const points: Point[] = [];
  for (let i = 0; i < value.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(value, String(i));
    if (!slot || !('value' in slot))
      return failure({ kind: 'input', code: 'invalid-input', vertexIndices: [i] });
    const point = readFinitePoint(slot.value);
    if (!point.ok) return failure({ kind: 'input', code: point.code, vertexIndices: [i] });
    points.push(point.value);
  }
  if (points.length === 0) return failure({ kind: 'geometry', code: 'too-few-vertices' });
  if (!equal(points[0], points[points.length - 1]))
    return failure({ kind: 'geometry', code: 'ring-not-closed' });
  const n = points.length - 1;
  if (n < 3) return failure({ kind: 'geometry', code: 'too-few-vertices' });
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (equal(points[i], points[j]))
      return failure({ kind: 'geometry', code: 'adjacent-duplicate', vertexIndices: [i, j] });
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (equal(points[i], points[j]))
        return failure({ kind: 'geometry', code: 'repeated-vertex', vertexIndices: [i, j] });
  const exact = exactPoints(points.slice(0, n));
  if (exact.every((p) => orientation(exact[0], exact[1], p) === 0))
    return failure({ kind: 'geometry', code: 'zero-area' });
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const relation = segmentRelation(exact[i], exact[(i + 1) % n], exact[j], exact[(j + 1) % n]);
      if (relation === 'overlap')
        return failure({ kind: 'geometry', code: 'edge-overlap', edgeIndices: [i, j] });
      if (j === i + 1 || (i === 0 && j === n - 1)) {
        if (relation !== 'touch') throw new Error('planar-internal-adjacent');
      } else if (relation !== 'disjoint')
        return failure({
          kind: 'geometry',
          code: relation === 'cross' ? 'self-crossing' : 'self-contact',
          edgeIndices: [i, j],
        });
    }
  const area = areaSign(exact);
  if (area === 0) throw new Error('planar-internal-zero-area');
  return { ok: true, value: { vertexCount: n, winding: area > 0 ? 'positive' : 'negative' } };
}
