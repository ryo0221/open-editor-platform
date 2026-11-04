import { convexShapePoints, type Drawing, type Point } from '@editor-platform/editor-core';

type Clip = NonNullable<Drawing['clipBounds']>[number];
const tolerance = 1e-10;
function cut(polygon: Point[], distance: (p: Point) => number): Point[] {
  const clipped: Point[] = [];
  let previous = polygon.at(-1)!;
  let before = distance(previous);
  for (const point of polygon) {
    const after = distance(point);
    if (before >= -tolerance !== after >= -tolerance) {
      const t = Math.max(0, Math.min(1, before / (before - after)));
      clipped.push({
        x: previous.x + (point.x - previous.x) * t,
        y: previous.y + (point.y - previous.y) * t,
      });
    }
    if (after >= -tolerance) clipped.push(point);
    previous = point;
    before = after;
  }
  return clipped;
}
function local(p: Point, c: Clip): Point {
  const angle = ((c.rotation ?? 0) * Math.PI) / 180;
  const x = p.x - c.x - c.width / 2,
    y = p.y - c.y - c.height / 2;
  return {
    x: ((x * Math.cos(angle) + y * Math.sin(angle)) * (c.flipX ? -1 : 1)) / c.width + 0.5,
    y: ((-x * Math.sin(angle) + y * Math.cos(angle)) * (c.flipY ? -1 : 1)) / c.height + 0.5,
  };
}
function ellipsePoint(p: Point, c: Clip): Point {
  const q = local(p, c);
  return { x: q.x * 2 - 1, y: q.y * 2 - 1 };
}
const squared = (p: Point) => p.x * p.x + p.y * p.y;
/** Closest point in a convex polygon to the origin, including line/point marquees. */
function closest(polygon: Point[]): Point {
  let best = polygon[0],
    positive = false,
    negative = false,
    area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const cross = a.x * b.y - a.y * b.x;
    area += cross;
    positive ||= cross > tolerance;
    negative ||= cross < -tolerance;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy || 1)));
    const p = { x: a.x + t * dx, y: a.y + t * dy };
    if (squared(p) < squared(best)) best = p;
  }
  return Math.abs(area) > tolerance && !(positive && negative) ? { x: 0, y: 0 } : best;
}

/** Common intersection, not independent overlap with each ancestor. Ellipse tests
 * use analytic distances and tangent half-planes, never an inscribed polygon that
 * loses visible boundary hits. All coordinates/tolerances are normalized per clip. */
export function intersectsClips(
  polygon: Point[],
  clips: NonNullable<Drawing['clipBounds']>,
): boolean {
  const ellipses: Clip[] = [];
  for (const c of clips) {
    if (c.width <= 0 || c.height <= 0) return false;
    if (c.shape === 'ellipse') {
      ellipses.push(c);
      continue;
    }
    const vertices = c.polygon?.map((p) => [p.x, p.y]) ||
      (c.shape && convexShapePoints(c.shape)) || [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
    for (let i = 0; i < vertices.length; i++) {
      const [ax, ay] = vertices[i],
        [bx, by] = vertices[(i + 1) % vertices.length];
      polygon = cut(polygon, (p) => {
        const q = local(p, c);
        return (bx - ax) * (q.y - ay) - (by - ay) * (q.x - ax);
      });
      if (!polygon.length) return false;
    }
  }
  // The Design panel hierarchy currently supplies at most one oval ancestor.
  // Refinement also preserves common-intersection semantics for nested ovals.
  for (let round = 0; round < 128; round++) {
    let refined = false;
    for (const c of ellipses) {
      const points = polygon.map((p) => ellipsePoint(p, c));
      if (squared(closest(points)) > 1 + tolerance) return false;
      if (ellipses.length === 1) return true;
      const farthest = points.reduce((a, b) => (squared(a) > squared(b) ? a : b));
      const length = Math.sqrt(squared(farthest));
      if (length <= 1 + tolerance) continue;
      polygon = cut(polygon, (p) => {
        const q = ellipsePoint(p, c);
        return 1 - (q.x * farthest.x + q.y * farthest.y) / length;
      });
      if (!polygon.length) return false;
      refined = true;
    }
    if (!refined) return true;
  }
  // Only a numerically unresolved boundary contact can survive refinement.
  return ellipses.every(
    (c) => squared(closest(polygon.map((p) => ellipsePoint(p, c)))) <= 1 + tolerance,
  );
}
