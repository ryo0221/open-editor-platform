import { validateRing } from '@editor-platform/geometry-core/planar';
import { fail } from './result';
import { exact, exactPoint, quantum, squared, subtract, twiceArea } from './numeric';
import { pointsOf } from './schema';
import type { FictionMapGeometry, FictionMapPrecision } from './types';

export function checkGeometry(
  g: FictionMapGeometry,
  precision: FictionMapPrecision,
  path: string,
): void {
  if (g.type === 'polygon') {
    const r = validateRing(g.outer, { maxVertices: 64 });
    if (!r.ok) fail('invalid-geometry', path + '/outer', { cause: r.diagnostic });
  } else if (g.type === 'polyline') {
    if (g.coordinates.length < 2) fail('invalid-geometry', path + '/coordinates');
    for (let i = 0; i < g.coordinates.length - 1; i++)
      if (
        g.coordinates[i][0] === g.coordinates[i + 1][0] &&
        g.coordinates[i][1] === g.coordinates[i + 1][1]
      )
        fail('zero-length-edge', path + `/coordinates/${i}`);
  }
  if (g.type !== 'point') {
    const points = pointsOf(g).map(exactPoint),
      d = exact(precision.minEdgeLength);
    for (let i = 0; i < points.length - 1; i++)
      if (squared(subtract(points[i + 1], points[i])) < d * d)
        fail('edge-below-minimum', path + (g.type === 'polygon' ? '/outer/' : '/coordinates/') + i);
    if (g.type === 'polygon' && twiceArea(points) < 2n * exact(precision.minPolygonArea) * quantum)
      fail('area-below-minimum', path + '/outer');
  }
}

const ownedGeometry = new WeakSet<object>();
/** Called only after full native admission has frozen every descendant. */
export function markGeometry(g: FictionMapGeometry): void {
  ownedGeometry.add(g);
}
export function isOwnedGeometry(g: unknown): g is FictionMapGeometry {
  return !!g && typeof g === 'object' && ownedGeometry.has(g);
}
