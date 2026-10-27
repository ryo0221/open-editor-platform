// Frozen pre-D1 evaluator from 7c9b6413; independent regression oracle, not runtime code.
import type { VectorPath2 } from './model';
type Segment = { from: [number, number]; points: number[]; type: 'L' | 'C' | 'Q' };
const segmentsCache = new WeakMap<VectorPath2, Segment[]>();
/** Segment-uniform Bezier parameterization; speed is controlled by key timing, not hidden arc-length resampling. */
export function baselinePointOnAnimationPath2(path: VectorPath2, progress: number) {
  let segments = segmentsCache.get(path);
  if (!segments) {
    segments = [];
    let current: [number, number] = [0, 0],
      start: [number, number] = [0, 0];
    for (const command of path) {
      if (command[0] === 'M') {
        current = [command[1], command[2]];
        start = current;
      } else {
        const type = command[0] === 'Z' ? 'L' : command[0];
        const points = command[0] === 'Z' ? [...start] : (command.slice(1) as number[]);
        segments.push({ type, from: current, points });
        current = [points.at(-2)!, points.at(-1)!];
      }
    }
    if (Object.isFrozen(path) && path.every(Object.isFrozen)) segmentsCache.set(path, segments);
  }
  if (!segments.length) throw Error('empty-motion-path');
  const value = Math.min(1, Math.max(0, progress)) * segments.length,
    index = Math.min(segments.length - 1, Math.floor(value)),
    t = value - index;
  const segment = segments[index],
    p = segment.points,
    from = segment.from;
  const coordinate = (axis: number, t: number) => {
    const a = from[axis],
      b = p[axis];
    if (segment.type === 'L') return { value: a + (b - a) * t, delta: b - a };
    const c = p[axis + 2];
    if (segment.type === 'Q')
      return {
        value: (1 - t) ** 2 * a + 2 * (1 - t) * t * b + t * t * c,
        delta: 2 * (1 - t) * (b - a) + 2 * t * (c - b),
      };
    const d = p[axis + 4];
    return {
      value: (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d,
      delta: 3 * (1 - t) ** 2 * (b - a) + 6 * (1 - t) * t * (c - b) + 3 * t * t * (d - c),
    };
  };
  const x = coordinate(0, t),
    y = coordinate(1, t);
  let dx = x.delta,
    dy = y.delta;
  if (dx === 0 && dy === 0) {
    if (t === 0 || t === 1) {
      const controls = [
        from,
        ...Array.from({ length: p.length / 2 }, (_, i) => [p[i * 2], p[i * 2 + 1]]),
      ];
      const endpoint = t === 0 ? controls[0] : controls.at(-1)!;
      for (const point of t === 0 ? controls.slice(1) : controls.slice(0, -1).reverse()) {
        dx = t === 0 ? point[0] - endpoint[0] : endpoint[0] - point[0];
        dy = t === 0 ? point[1] - endpoint[1] : endpoint[1] - point[1];
        if (dx !== 0 || dy !== 0) break;
      }
    } else {
      dx = coordinate(0, Math.min(1, t + 1e-6)).value - x.value;
      dy = coordinate(1, Math.min(1, t + 1e-6)).value - y.value;
    }
  }
  return { x: x.value, y: y.value, rotation: (Math.atan2(dy, dx) * 180) / Math.PI };
}
