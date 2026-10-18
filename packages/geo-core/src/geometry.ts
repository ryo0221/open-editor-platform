import type { Geometry, Position } from './model';

export const unwrapLongitude = (longitude: number, center: number) =>
  longitude + 360 * Math.round((center - longitude) / 360);
export function geometryPositions(geometry: Geometry | null): Position[] {
  if (!geometry) return [];
  if (geometry.type === 'Point') return [geometry.coordinates];
  if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') return geometry.coordinates;
  if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString')
    return geometry.coordinates.flat();
  return (geometry.coordinates as Position[][][]).flat(2);
}
const cross = (a: Position, b: Position, c: Position) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(a: Position, b: Position, p: Position) {
  return (
    Math.abs(cross(a, b, p)) < 1e-10 &&
    p[0] >= Math.min(a[0], b[0]) - 1e-10 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-10 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-10 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-10
  );
}
function intersects(a: Position, b: Position, c: Position, d: Position) {
  return (
    (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}
/** Editing only: retained holes/Multi remain unchanged and explicitly read-only. */
export function assertEditableGeometry(geometry: Geometry | null): void {
  if (!geometry || geometry.type === 'Point' || geometry.type === 'LineString') return;
  if (geometry.type !== 'Polygon' || geometry.coordinates.length !== 1)
    throw Error('geometry-readonly-topology-pending');
  const input = geometry.coordinates[0];
  if (input.length < 4 || JSON.stringify(input[0]) !== JSON.stringify(input.at(-1)))
    throw Error('ring-not-closed');
  const ring = input.map(([x, y]) => [unwrapLongitude(x, input[0][0]), y] as Position);
  if (Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0])) >= 180)
    throw Error('polygon-ambiguous-wrap');
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    if (JSON.stringify(ring[i]) === JSON.stringify(ring[i + 1])) throw Error('duplicate-vertex');
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    for (let j = i + 1; j < ring.length - 1; j++) {
      if (j === i + 1 || (i === 0 && j === ring.length - 2)) continue;
      if (intersects(ring[i], ring[i + 1], ring[j], ring[j + 1]))
        throw Error('polygon-self-intersection');
    }
  }
  if (Math.abs(area) < 1e-10) throw Error('polygon-zero-area');
}
