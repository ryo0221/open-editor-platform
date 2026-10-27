import { type Bounds, type Point } from '@editor-platform/editor-core';
import { type GraphNodeShape } from './model';
import { graphShapeEndpoint, graphShapeMetrics } from './shape';
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
const lane = 8,
  maxLaneOffset = 12,
  portLane = 40;
interface SharedSegment {
  id: string;
  index: number;
  /** Leaves or enters a node, so its port can slide along that node's side. */
  port: boolean;
  vertical: boolean;
  at: number;
  from: number;
  to: number;
  order: number;
}
function routeSegments(id: string, points: Point[]): SharedSegment[] {
  return points.slice(1).flatMap((b, index) => {
    const a = points[index],
      vertical = a.x === b.x;
    if (vertical === (a.y === b.y)) return [];
    const near = points[index - 1] ?? points[index + 2] ?? a;
    return [
      {
        id,
        index,
        port: index === 0 || index === points.length - 2,
        vertical,
        at: vertical ? a.x : a.y,
        from: Math.min(vertical ? a.y : a.x, vertical ? b.y : b.x),
        to: Math.max(vertical ? a.y : a.x, vertical ? b.y : b.x),
        order: vertical ? near.x : near.y,
      },
    ];
  });
}
function routeFromPoints(shifted: Point[]): GraphRoute {
  // Drop repeated points and the middle of straight runs, as routeGraphEdge does.
  const unique = shifted.filter(
    (point, i) => !i || point.x !== shifted[i - 1].x || point.y !== shifted[i - 1].y,
  );
  const points = unique.filter(
    (point, i) =>
      !i ||
      i === unique.length - 1 ||
      !(
        (unique[i - 1].x === point.x && unique[i + 1].x === point.x) ||
        (unique[i - 1].y === point.y && unique[i + 1].y === point.y)
      ),
  );
  let label = points[0],
    longest = -1;
  for (let i = 1; i < points.length; i++) {
    const length = distance(points[i - 1], points[i]);
    if (length > longest) {
      longest = length;
      label = { x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2 };
    }
  }
  return {
    points,
    source: points[0],
    target: points[points.length - 1],
    label,
    path: points.map((point, i) => `${i ? 'L' : 'M'}${point.x},${point.y}`).join(' '),
  };
}
/** Lane offsets for segments of different routes that run along the same stretch of line. */
function sharedLaneOffsets(
  segments: SharedSegment[],
  wide: boolean,
  ends: Map<string, GraphRouteEnds>,
) {
  // Room along the node side a port segment touches, within the shape's port range.
  const side = (s: SharedSegment) => {
    const end = ends.get(s.id),
      box = s.index === 0 ? end?.source : end?.target;
    if (!box) return 0;
    const [low, high] = portSpan(
      box,
      s.vertical,
      s.index === 0 ? end?.sourceShape : end?.targetShape,
    );
    return high - low;
  };
  const lines = new Map<string, SharedSegment[]>();
  for (const s of segments) {
    const key = `${s.vertical ? 'v' : 'h'}${s.at}`;
    lines.set(key, [...(lines.get(key) ?? []), s]);
  }
  const offsets = new Map<string, number>();
  for (const line of lines.values()) {
    line.sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
    let group: SharedSegment[] = [],
      reach = -Infinity;
    const flush = () => {
      if (new Set(group.map((s) => s.id)).size > 1) {
        const ordered = [...group].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        // A trunk into one node side spreads its ports apart; elsewhere lanes stay in the margin.
        const step =
          wide && ordered.every((s) => s.port)
            ? Math.min(portLane, Math.min(...ordered.map(side)) / (ordered.length - 1))
            : Math.min(lane, (maxLaneOffset * 2) / (ordered.length - 1));
        ordered.forEach((s, i) =>
          offsets.set(`${s.id}:${s.index}`, (i - (ordered.length - 1) / 2) * step),
        );
      }
      group = [];
    };
    // Segments that only touch end to end are not shared.
    for (const s of line) {
      if (group.length && s.from >= reach) flush();
      reach = group.length ? Math.max(reach, s.to) : s.to;
      group.push(s);
    }
    flush();
  }
  return offsets;
}
/** Ends of a route: node boxes and, when not rectangles, their shapes. */
export interface GraphRouteEnds {
  source: Bounds;
  target: Bounds;
  sourceShape?: GraphNodeShape;
  targetShape?: GraphNodeShape;
}
/** Where a port may sit along a node side: the shape's range, and 6px clear of each corner. */
function portSpan(box: Bounds, vertical: boolean, shape: GraphNodeShape = 'rectangle') {
  const start = vertical ? box.x : box.y,
    length = vertical ? box.width : box.height,
    half = length * graphShapeMetrics(shape).portRange;
  return [
    Math.max(start + 6, start + length / 2 - half),
    Math.min(start + length - 6, start + length / 2 + half),
  ];
}
function shiftedRoute(
  id: string,
  route: GraphRoute,
  offsets: Map<string, number>,
  ends: GraphRouteEnds | undefined,
): Point[] {
  const points = route.points.map((point) => ({ ...point }));
  for (const s of routeSegments(id, route.points)) {
    let offset = offsets.get(`${id}:${s.index}`);
    if (!offset) continue;
    // A segment that leaves or enters a node moves its port along that node's side.
    for (const [box, shape] of [
      [s.index === 0 ? ends?.source : undefined, ends?.sourceShape],
      [s.index === route.points.length - 2 ? ends?.target : undefined, ends?.targetShape],
    ] as const) {
      if (!box) continue;
      const [low, high] = portSpan(box, s.vertical, shape);
      offset = Math.max(low, Math.min(high, s.at + offset)) - s.at;
    }
    for (const point of [points[s.index], points[s.index + 1]])
      if (s.vertical) point.x = s.at + offset;
      else point.y = s.at + offset;
  }
  return points;
}
/**
 * Connections that run along the same line are drawn side by side so each keeps its own line
 * and label: ports on a shared node side spread apart, other shared stretches sit a few pixels
 * apart inside the routing margin. A shifted route that would cross a node keeps its route.
 * Deterministic for the same routes.
 */
export function separateGraphRoutes(
  routes: Map<string, GraphRoute>,
  ends: Map<string, GraphRouteEnds>,
  obstacles: Bounds[],
): Map<string, GraphRoute> {
  const segments = [...routes]
    .filter(([, route]) => route.path)
    .flatMap(([id, route]) => routeSegments(id, route.points));
  const wide = sharedLaneOffsets(segments, true, ends),
    narrow = sharedLaneOffsets(segments, false, ends);
  const result = new Map<string, GraphRoute>();
  for (const [id, route] of routes) {
    result.set(id, route);
    if (!route.path) continue;
    for (const offsets of [wide, narrow]) {
      const points = shiftedRoute(id, route, offsets, ends.get(id));
      const crosses = points.some(
        (point, i) => i > 0 && obstacles.some((box) => routeIntersects(points[i - 1], point, box)),
      );
      if (!crosses) {
        result.set(id, routeFromPoints(points));
        break;
      }
    }
  }
  return result;
}

/**
 * Ends each route on its nodes' outlines. Runs after the ports are final (after
 * separateGraphRoutes): from each port, the end segment is extended inward, perpendicular to
 * the node side, to the first outline crossing, so routes stay orthogonal. Arrows, hit paths,
 * labels and endpoint handles all use the returned points.
 */
export function fitGraphRoutesToShapes(
  routes: Map<string, GraphRoute>,
  ends: Map<string, GraphRouteEnds>,
): Map<string, GraphRoute> {
  const result = new Map<string, GraphRoute>();
  for (const [id, route] of routes) {
    const end = ends.get(id);
    if (!route.path || route.points.length < 2 || !end) {
      result.set(id, route);
      continue;
    }
    const points = route.points.map((point) => ({ ...point }));
    const inward = (port: Point, next: Point) => ({
      x: Math.sign(port.x - next.x),
      y: Math.sign(port.y - next.y),
    });
    const last = points.length - 1;
    if (end.sourceShape && end.sourceShape !== 'rectangle')
      points[0] = graphShapeEndpoint(
        end.sourceShape,
        end.source,
        points[0],
        inward(points[0], points[1]),
      );
    if (end.targetShape && end.targetShape !== 'rectangle')
      points[last] = graphShapeEndpoint(
        end.targetShape,
        end.target,
        points[last],
        inward(points[last], points[last - 1]),
      );
    result.set(id, routeFromPoints(points));
  }
  return result;
}
