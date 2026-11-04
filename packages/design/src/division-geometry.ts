import type { Bounds, Point } from '@editor-platform/editor-core';

export interface DesignDividerLine {
  nx: number;
  ny: number;
  offset: number;
}
export type DesignDivisionNode =
  | { panelId: string }
  | {
      dividerId: string;
      line: DesignDividerLine;
      gap: number;
      a: DesignDivisionNode;
      b: DesignDivisionNode;
    };
export interface DesignPageDivision {
  region: Bounds;
  root: DesignDivisionNode;
}
export interface DesignPanelGeometry {
  polygon: Point[];
}
export const designDivisionLimits = Object.freeze({ leaves: 32, depth: 8, vertices: 12 });
export const divisionTolerance = 1e-7;
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const fields = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k));
const number = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e12;
const id = (x: unknown): x is string => typeof x === 'string' && !!x.trim() && x.length <= 4096;
export const nearDivision = (a: number, b: number) => Math.abs(a - b) <= divisionTolerance;
export function validDividerLine(x: unknown): x is DesignDividerLine {
  return (
    object(x) &&
    fields(x, ['nx', 'ny', 'offset']) &&
    number(x.nx) &&
    number(x.ny) &&
    number(x.offset) &&
    Math.abs(Math.hypot(x.nx, x.ny) - 1) < 1e-10
  );
}
export function validDivisionTree(x: unknown): x is DesignPageDivision {
  if (
    !object(x) ||
    !fields(x, ['region', 'root']) ||
    !object(x.region) ||
    !fields(x.region, ['x', 'y', 'width', 'height']) ||
    !Object.values(x.region).every(number) ||
    (x.region.width as number) < 1 ||
    (x.region.height as number) < 1
  )
    return false;
  const seen = new Set<unknown>(),
    ids = new Set<string>();
  let leaves = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (!object(node) || depth > designDivisionLimits.depth || seen.has(node)) return false;
    seen.add(node);
    const key = 'panelId' in node ? node.panelId : node.dividerId;
    if (!id(key) || ids.has(key)) return false;
    ids.add(key);
    if ('panelId' in node)
      return fields(node, ['panelId']) && ++leaves <= designDivisionLimits.leaves;
    return (
      fields(node, ['dividerId', 'line', 'gap', 'a', 'b']) &&
      validDividerLine(node.line) &&
      number(node.gap) &&
      node.gap >= 0 &&
      visit(node.a, depth + 1) &&
      visit(node.b, depth + 1)
    );
  };
  return visit(x.root, 0);
}
export function polygonArea(points: readonly Point[]): number {
  return (
    points.reduce((sum, a, i) => {
      const b = points[(i + 1) % points.length];
      return sum + a.x * b.y - b.x * a.y;
    }, 0) / 2
  );
}
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
/** SVG clockwise, lexicographically first vertex; no renderer-specific rounding. */
export function canonicalDivisionPolygon(input: readonly Point[]): Point[] {
  const points = input.map((p) => ({ x: p.x, y: p.y }));
  let changed = true;
  while (changed && points.length >= 3) {
    changed = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length],
        b = points[i],
        c = points[(i + 1) % points.length];
      const scale = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - b.x, c.y - b.y));
      if (
        Math.hypot(b.x - a.x, b.y - a.y) < divisionTolerance ||
        Math.abs(cross(a, b, c)) <= divisionTolerance * scale
      ) {
        points.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (polygonArea(points) < 0) points.reverse();
  let first = 0;
  points.forEach((p, i) => {
    if (p.x < points[first].x || (p.x === points[first].x && p.y < points[first].y)) first = i;
  });
  return [...points.slice(first), ...points.slice(0, first)];
}
export function validPanelGeometry(x: unknown): x is DesignPanelGeometry {
  if (
    !object(x) ||
    !fields(x, ['polygon']) ||
    !Array.isArray(x.polygon) ||
    x.polygon.length < 3 ||
    x.polygon.length > designDivisionLimits.vertices
  )
    return false;
  if (
    !x.polygon.every(
      (p) =>
        object(p) &&
        fields(p, ['x', 'y']) &&
        number(p.x) &&
        number(p.y) &&
        p.x >= 0 &&
        p.x <= 1 &&
        p.y >= 0 &&
        p.y <= 1,
    )
  )
    return false;
  const points = x.polygon as Point[];
  // Every other vertex must lie strictly on the interior side of each edge.
  if (
    points.some((a, i) =>
      points.some(
        (c, j) =>
          j !== i &&
          j !== (i + 1) % points.length &&
          cross(a, points[(i + 1) % points.length], c) <= 1e-12,
      ),
    )
  )
    return false;
  const canonical = canonicalDivisionPolygon(points);
  return (
    canonical.length === points.length &&
    points.every(
      (p, i) => nearDivision(p.x, canonical[i].x) && nearDivision(p.y, canonical[i].y),
    ) &&
    ['x', 'y'].every(
      (axis) =>
        Math.min(...points.map((p) => p[axis as 'x' | 'y'])) === 0 &&
        Math.max(...points.map((p) => p[axis as 'x' | 'y'])) === 1,
    )
  );
}
export function rectanglePolygon(b: Bounds): Point[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height },
  ];
}
/** Inset only for view labels. The native clip/stroke polygon is never changed. */
export function insetDivisionPolygon(polygon: Point[], distance: number): Point[] {
  let result = polygon;
  for (let i = 0; i < polygon.length; i++) {
    if (result.length < 3) return [];
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = (b.y - a.y) / length,
      ny = (a.x - b.x) / length;
    result = cut(result, { nx, ny, offset: 0 }, nx * a.x + ny * a.y - distance, 1);
  }
  return result;
}
function cut(points: Point[], line: DesignDividerLine, limit: number, sign: number): Point[] {
  const result: Point[] = [];
  let prev = points.at(-1)!;
  let before = sign * (line.nx * prev.x + line.ny * prev.y - limit);
  for (const point of points) {
    const after = sign * (line.nx * point.x + line.ny * point.y - limit);
    if (before <= 0 !== after <= 0) {
      const t = before / (before - after);
      result.push({ x: prev.x + t * (point.x - prev.x), y: prev.y + t * (point.y - prev.y) });
    }
    if (after <= 0) result.push(point);
    prev = point;
    before = after;
  }
  return canonicalDivisionPolygon(result);
}
export interface MaterializedPanel {
  panelId: string;
  bounds: Bounds;
  panelGeometry: DesignPanelGeometry;
}
export interface MaterializedDivider {
  dividerId: string;
  line: DesignDividerLine;
  gap: number;
  polygon: Point[];
}
export function materializeDivision(division: DesignPageDivision, page: Bounds) {
  if (!validDivisionTree(division)) throw Error('Invalid division tree or limit');
  const r = division.region;
  if (r.x < 0 || r.y < 0 || r.x + r.width > page.width || r.y + r.height > page.height)
    throw Error('Division region must fit inside the page');
  const panels: MaterializedPanel[] = [],
    dividers: MaterializedDivider[] = [];
  const visit = (node: DesignDivisionNode, points: Point[]) => {
    const x = Math.min(...points.map((p) => p.x)),
      y = Math.min(...points.map((p) => p.y));
    const width = Math.max(...points.map((p) => p.x)) - x,
      height = Math.max(...points.map((p) => p.y)) - y;
    if (
      points.length < 3 ||
      points.length > designDivisionLimits.vertices ||
      width < 1 ||
      height < 1 ||
      polygonArea(points) < 1
    )
      throw Error(
        `Division leaves a panel too small: ${'panelId' in node ? node.panelId : node.dividerId}`,
      );
    if ('panelId' in node) {
      const polygon = canonicalDivisionPolygon(
        points.map((p) => ({ x: (p.x - x) / width, y: (p.y - y) / height })),
      );
      if (!validPanelGeometry({ polygon })) throw Error(`Invalid panel polygon: ${node.panelId}`);
      panels.push({
        panelId: node.panelId,
        bounds: { x: page.x + x, y: page.y + y, width, height },
        panelGeometry: { polygon },
      });
    } else {
      dividers.push({ dividerId: node.dividerId, line: node.line, gap: node.gap, polygon: points });
      visit(node.a, cut(points, node.line, node.line.offset - node.gap / 2, 1));
      visit(node.b, cut(points, node.line, node.line.offset + node.gap / 2, -1));
    }
  };
  visit(division.root, rectanglePolygon(r));
  return { panels, dividers };
}
export function mapDivisionNode(
  node: DesignDivisionNode,
  map: (node: DesignDivisionNode) => DesignDivisionNode,
): DesignDivisionNode {
  const changed = map(node);
  return 'panelId' in changed
    ? changed
    : { ...changed, a: mapDivisionNode(changed.a, map), b: mapDivisionNode(changed.b, map) };
}
