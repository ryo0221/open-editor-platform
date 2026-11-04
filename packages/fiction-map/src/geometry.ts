import { deepFreeze } from '@editor-platform/artifact-core';
import { copyData } from './input';
import { checkGeometry, isOwnedGeometry, markGeometry } from './geometry-validation';
import {
  checkBounds,
  checkCoordinate,
  contains,
  finite,
  pointsOf,
  readBounds,
  readGeometry,
  readPoint,
  readPrecision,
} from './schema';
import { attempt, fail } from './result';
import { evenOdd, exact, exactPoint, nearSegment, snapped, squared, subtract } from './numeric';
import type {
  FictionMapBounds,
  FictionMapGeometry,
  FictionMapPoint,
  FictionMapPrecision,
  FictionMapResult,
} from './types';

function queryPoint(input: unknown, path: string): FictionMapPoint {
  const p = readPoint(copyData(input), path);
  checkCoordinate(p[0], path + '/0');
  checkCoordinate(p[1], path + '/1');
  return p;
}
function radius(value: unknown): number {
  const r = finite(value, '/radius');
  if (r < 0) fail('invalid-field', '/radius');
  return r;
}
function admitGeometry(input: unknown, precision: unknown, bounds: unknown): FictionMapGeometry {
  const g = readGeometry(copyData(input), '/geometry'),
    p = readPrecision(copyData(precision)),
    b = readBounds(copyData(bounds), '/bounds');
  checkBounds(b, '/bounds');
  for (const [i, point] of pointsOf(g).entries()) {
    checkCoordinate(point[0], `/geometry/${i}/0`);
    checkCoordinate(point[1], `/geometry/${i}/1`);
    if (!contains(b, point)) fail('coordinate-out-of-range', `/geometry/${i}`);
  }
  checkGeometry(g, p, '/geometry');
  deepFreeze(g);
  markGeometry(g);
  return g;
}
export function validateFictionMapGeometry(
  input: unknown,
  precision: FictionMapPrecision,
  bounds: FictionMapBounds,
): FictionMapResult<FictionMapGeometry> {
  return attempt('input', () => admitGeometry(input, precision, bounds));
}
export function isFictionMapPointNear(
  a: unknown,
  b: unknown,
  r: number,
): FictionMapResult<boolean> {
  return attempt('input', () => {
    const p = exactPoint(queryPoint(a, '/a')),
      q = exactPoint(queryPoint(b, '/b')),
      rr = exact(radius(r));
    return squared(subtract(p, q)) <= rr * rr;
  });
}
export function snapFictionMapPoint(
  input: unknown,
  precision: FictionMapPrecision,
  bounds: FictionMapBounds,
): FictionMapResult<FictionMapPoint> {
  return attempt('input', () => {
    const p = queryPoint(input, '/point'),
      profile = readPrecision(copyData(precision)),
      b = readBounds(copyData(bounds), '/bounds');
    checkBounds(b, '/bounds');
    if (!contains(b, p)) fail('coordinate-out-of-range', '/point');
    if (!profile.snapGrid) fail('invalid-precision', '/precision/snapGrid');
    const step = profile.snapGrid.step,
      result: FictionMapPoint = [snapped(p[0], step), snapped(p[1], step)];
    if (!contains(b, result)) fail('snap-out-of-bounds', '/point');
    return deepFreeze(result);
  });
}
export function hitTestFictionMapGeometry(
  input: FictionMapGeometry,
  point: unknown,
  r: number,
): FictionMapResult<boolean> {
  return attempt('input', () => {
    if (!isOwnedGeometry(input)) fail('invalid-data', '/geometry');
    const p = exactPoint(queryPoint(point, '/point')),
      rr = exact(radius(r)),
      r2 = rr * rr;
    const points = pointsOf(input).map(exactPoint);
    if (input.type === 'point') return squared(subtract(points[0], p)) <= r2;
    for (let i = 0; i < points.length - 1; i++)
      if (nearSegment(p, points[i], points[i + 1], r2)) return true;
    return input.type === 'polygon' && evenOdd(p, points);
  });
}
/** Explicit coordinate construction; native admission validates the represented result. */
export function translateFictionMapGeometry(
  g: FictionMapGeometry,
  dx: number,
  dy: number,
  precision: FictionMapPrecision,
  bounds: FictionMapBounds,
): FictionMapResult<FictionMapGeometry> {
  return attempt('candidate', () => {
    if (!isOwnedGeometry(g)) fail('invalid-data', '/geometry');
    return admitGeometry(translateCoordinates(g, dx, dy), precision, bounds);
  });
}
/** Internal cheap construction for a Change; prepare performs deep geometry admission once. */
export function translateCoordinates(
  g: FictionMapGeometry,
  dx: number,
  dy: number,
): FictionMapGeometry {
  finite(dx, '/dx');
  finite(dy, '/dy');
  const translated = pointsOf(g).map((p, i): FictionMapPoint => {
    const x = p[0] + dx,
      y = p[1] + dy;
    if ((dx !== 0 && x === p[0]) || (dy !== 0 && y === p[1]))
      fail('coordinate-precision-loss', `/geometry/${i}`);
    return [x, y];
  });
  return g.type === 'point'
    ? { type: 'point', coordinates: translated[0] }
    : g.type === 'polyline'
      ? { type: 'polyline', coordinates: translated }
      : { type: 'polygon', outer: translated };
}
