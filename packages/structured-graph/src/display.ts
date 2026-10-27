import { type Bounds, type Point } from '@editor-platform/editor-core';
import { type GraphRoute } from './routing';

export interface GraphNodeSize {
  width: number;
  height: number;
}
export interface GraphCamera extends Point {
  /** x/y are canvas-space CSS pixel translation; zoom is a scale ratio. */
  zoom: number;
}
/** Drawing dimensions are Host view state; invalid sizes fall back to the legacy size. */
export function graphNodeSize(size?: GraphNodeSize): GraphNodeSize {
  return size && [size.width, size.height].every((n) => Number.isFinite(n) && n >= 40 && n <= 4000)
    ? size
    : { width: 200, height: 70 };
}
/** Shows the whole drawing as large as it fits, up to 2×, centred in the viewport. */
export function fitGraphView(boxes: Bounds[], viewport: GraphNodeSize): GraphCamera {
  if (!boxes.length) return { x: 0, y: 0, zoom: 1 };
  const minX = Math.min(...boxes.map((box) => box.x)),
    minY = Math.min(...boxes.map((box) => box.y)),
    maxX = Math.max(...boxes.map((box) => box.x + box.width)),
    maxY = Math.max(...boxes.map((box) => box.y + box.height));
  const zoom = Math.max(
    0.001,
    Math.min(
      2,
      Math.max(1, viewport.width - 40) / (maxX - minX),
      Math.max(1, viewport.height - 40) / (maxY - minY),
    ),
  );
  return {
    x: Math.max(20, (viewport.width - (maxX - minX) * zoom) / 2) - minX * zoom,
    y: Math.max(20, (viewport.height - (maxY - minY) * zoom) / 2) - minY * zoom,
    zoom,
  };
}
export const graphBoxesOverlap = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
/** Headless fallback estimate; the browser supplies measured glyph dimensions. */
export function graphEdgeLabelWidth(text: string): number {
  return Math.max(
    50,
    [...text].reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 13 : 9), 16),
  );
}
export interface GraphEdgeLabel {
  point: Point;
  bounds: Bounds;
  deferred: boolean;
}
/** Stable placements along each route. Crowded labels are revealed only on interaction. */
export function placeGraphEdgeLabels(
  edges: { id: string; route: GraphRoute; text: string }[],
  nodes: Bounds[],
): Map<string, GraphEdgeLabel> {
  return placeMeasuredGraphEdgeLabels(edges, nodes);
}
/** Internal browser layout port, deliberately absent from the package entrypoints. */
export function placeMeasuredGraphEdgeLabels(
  edges: { id: string; route: GraphRoute; text: string; size?: GraphNodeSize }[],
  nodes: Bounds[],
): Map<string, GraphEdgeLabel> {
  const occupied = nodes.map((box) => ({
    x: box.x - 4,
    y: box.y - 4,
    width: box.width + 8,
    height: box.height + 8,
  }));
  const result = new Map<string, GraphEdgeLabel>();
  for (const { id, route, text, size } of edges) {
    const measured = size && [size.width, size.height].every((n) => Number.isFinite(n) && n > 0);
    const width = measured ? Math.max(50, size.width) : graphEdgeLabelWidth(text);
    const height = measured ? Math.max(22, size.height) : 22;
    const bounds = (point: Point): Bounds => ({
      x: point.x - width / 2,
      y: point.y - height / 2,
      width,
      height,
    });
    const segments = route.points
      .slice(1)
      .map((b, i) => ({ a: route.points[i], b }))
      .sort(
        (a, b) =>
          Math.abs(b.b.x - b.a.x) +
          Math.abs(b.b.y - b.a.y) -
          (Math.abs(a.b.x - a.a.x) + Math.abs(a.b.y - a.a.y)),
      );
    const candidates = [
      route.label,
      ...segments.flatMap(({ a, b }) =>
        [0.25, 0.75, 0.125, 0.875].map((fraction) => ({
          x: a.x + (b.x - a.x) * fraction,
          y: a.y + (b.y - a.y) * fraction,
        })),
      ),
    ];
    const point = route.path
      ? candidates.find((point) => !occupied.some((box) => graphBoxesOverlap(bounds(point), box)))
      : undefined;
    const box = bounds(point ?? route.label);
    if (point)
      occupied.push({ x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 });
    result.set(id, { point: point ?? route.label, bounds: box, deferred: !point });
  }
  return result;
}
