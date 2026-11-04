import { orientation, type ExactPoint } from './exact';

export type PointRelation = 'outside' | 'endpoint' | 'interior';
export type SegmentRelation = 'disjoint' | 'cross' | 'touch' | 'overlap';

const equal = (a: ExactPoint, b: ExactPoint) => a[0] === b[0] && a[1] === b[1];
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** Closed segments, including a segment consisting of a single point. */
export function pointRelation(p: ExactPoint, a: ExactPoint, b: ExactPoint): PointRelation {
  if (equal(p, a) || equal(p, b)) return 'endpoint';
  if (orientation(a, b, p) !== 0) return 'outside';
  return p[0] >= min(a[0], b[0]) &&
    p[0] <= max(a[0], b[0]) &&
    p[1] >= min(a[1], b[1]) &&
    p[1] <= max(a[1], b[1])
    ? 'interior'
    : 'outside';
}

export function segmentRelation(
  a: ExactPoint,
  b: ExactPoint,
  c: ExactPoint,
  d: ExactPoint,
): SegmentRelation {
  if (equal(a, b)) return pointRelation(a, c, d) === 'outside' ? 'disjoint' : 'touch';
  if (equal(c, d)) return pointRelation(c, a, b) === 'outside' ? 'disjoint' : 'touch';
  const abc = orientation(a, b, c);
  const abd = orientation(a, b, d);
  const cda = orientation(c, d, a);
  const cdb = orientation(c, d, b);
  if (abc * abd < 0 && cda * cdb < 0) return 'cross';
  if (abc === 0 && abd === 0 && cda === 0 && cdb === 0) {
    const axis = a[0] !== b[0] ? 0 : 1;
    const start = max(min(a[axis], b[axis]), min(c[axis], d[axis]));
    const end = min(max(a[axis], b[axis]), max(c[axis], d[axis]));
    return start > end ? 'disjoint' : start === end ? 'touch' : 'overlap';
  }
  if (
    (abc === 0 && pointRelation(c, a, b) !== 'outside') ||
    (abd === 0 && pointRelation(d, a, b) !== 'outside') ||
    (cda === 0 && pointRelation(a, c, d) !== 'outside') ||
    (cdb === 0 && pointRelation(b, c, d) !== 'outside')
  )
    return 'touch';
  return 'disjoint';
}
