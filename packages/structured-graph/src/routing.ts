import { type Bounds, type Point } from '@editor-platform/editor-core';
export interface GraphRoute {
  points: Point[];
  path: string;
  source: Point;
  target: Point;
  label: Point;
}
const margin = 14;
const inflate = (box: Bounds): Bounds => ({
  x: box.x - margin,
  y: box.y - margin,
  width: box.width + margin * 2,
  height: box.height + margin * 2,
});
const center = (box: Bounds): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
export function routeIntersects(a: Point, b: Point, box: Bounds): boolean {
  if (a.x === b.x)
    return (
      a.x > box.x &&
      a.x < box.x + box.width &&
      Math.max(a.y, b.y) > box.y &&
      Math.min(a.y, b.y) < box.y + box.height
    );
  return (
    a.y > box.y &&
    a.y < box.y + box.height &&
    Math.max(a.x, b.x) > box.x &&
    Math.min(a.x, b.x) < box.x + box.width
  );
}
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
/** Orthogonal visibility-grid search. Routes are private drawing data, never native layout. */
function search(start: Point, end: Point, boxes: Bounds[]): Point[] | undefined {
  const xs = [
    ...new Set([start.x, end.x, ...boxes.flatMap((box) => [box.x, box.x + box.width])]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([start.y, end.y, ...boxes.flatMap((box) => [box.y, box.y + box.height])]),
  ].sort((a, b) => a - b);
  const key = (x: number, y: number) => y * xs.length + x;
  const origin = key(xs.indexOf(start.x), ys.indexOf(start.y));
  const destination = key(xs.indexOf(end.x), ys.indexOf(end.y));
  const point = (id: number): Point => ({
    x: xs[id % xs.length],
    y: ys[Math.floor(id / xs.length)],
  });
  const cost = new Map([[origin, 0]]),
    previous = new Map<number, number>();
  const open = new Set([origin]);
  while (open.size) {
    let current = -1,
      best = Infinity;
    for (const id of open) {
      const score = cost.get(id)! + distance(point(id), end);
      if (score < best) {
        best = score;
        current = id;
      }
    }
    if (current === destination) {
      const path = [end];
      while (current !== origin) {
        current = previous.get(current)!;
        path.unshift(point(current));
      }
      return path;
    }
    open.delete(current);
    const x = current % xs.length,
      y = Math.floor(current / xs.length),
      a = point(current);
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
      const next = key(nx, ny),
        b = point(next);
      if (boxes.some((box) => routeIntersects(a, b, box))) continue;
      const nextCost = cost.get(current)! + distance(a, b);
      if (nextCost >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, nextCost);
      previous.set(next, current);
      open.add(next);
    }
  }
}
export function routeGraphEdge(
  source: Bounds,
  target: Bounds,
  obstacles: Bounds[],
  self = false,
): GraphRoute {
  const a = center(source),
    b = center(target),
    horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const direction = horizontal ? (b.x >= a.x ? 1 : -1) : b.y >= a.y ? 1 : -1;
  const from = self
    ? { x: source.x + source.width * 0.75, y: source.y }
    : horizontal
      ? { x: direction > 0 ? source.x + source.width : source.x, y: a.y }
      : { x: a.x, y: direction > 0 ? source.y + source.height : source.y };
  const to = self
    ? { x: source.x + source.width * 0.25, y: source.y }
    : horizontal
      ? { x: direction > 0 ? target.x : target.x + target.width, y: b.y }
      : { x: b.x, y: direction > 0 ? target.y : target.y + target.height };
  const start = self
    ? { ...from, y: from.y - margin * 2 }
    : {
        x: from.x + (horizontal ? direction * margin : 0),
        y: from.y + (horizontal ? 0 : direction * margin),
      };
  const end = self
    ? { ...to, y: to.y - margin * 2 }
    : {
        x: to.x - (horizontal ? direction * margin : 0),
        y: to.y - (horizontal ? 0 : direction * margin),
      };
  const all = obstacles.map(inflate);
  const region = {
    x: Math.min(start.x, end.x) - 60,
    y: Math.min(start.y, end.y) - 60,
    width: Math.abs(start.x - end.x) + 120,
    height: Math.abs(start.y - end.y) + 120,
  };
  const relevant = new Set(
    all.filter(
      (box) =>
        box.x <= region.x + region.width &&
        box.x + box.width >= region.x &&
        box.y <= region.y + region.height &&
        box.y + box.height >= region.y,
    ),
  );
  let middle: Point[] | undefined;
  // Add an obstacle when a detour reaches it; the successful result is checked against all nodes.
  for (;;) {
    middle = search(start, end, [...relevant]);
    if (!middle) break;
    const crossed = all.filter(
      (box) =>
        !relevant.has(box) &&
        middle!.some((point, i) => i > 0 && routeIntersects(middle![i - 1], point, box)),
    );
    if (!crossed.length) break;
    crossed.forEach((box) => relevant.add(box));
  }
  const points = middle
    ? [from, ...middle, to].filter(
        (point, i, points) => !i || point.x !== points[i - 1].x || point.y !== points[i - 1].y,
      )
    : [];
  const simplified = points.filter(
    (point, i) =>
      !i ||
      i === points.length - 1 ||
      !(
        (points[i - 1].x === point.x && points[i + 1].x === point.x) ||
        (points[i - 1].y === point.y && points[i + 1].y === point.y)
      ),
  );
  let label = center(source),
    longest = 0;
  for (let i = 1; i < simplified.length; i++) {
    const length = distance(simplified[i - 1], simplified[i]);
    if (length > longest) {
      longest = length;
      label = {
        x: (simplified[i - 1].x + simplified[i].x) / 2,
        y: (simplified[i - 1].y + simplified[i].y) / 2,
      };
    }
  }
  return {
    points: simplified,
    source: from,
    target: to,
    label,
    path: simplified.map((point, i) => `${i ? 'L' : 'M'}${point.x},${point.y}`).join(' '),
  };
}
