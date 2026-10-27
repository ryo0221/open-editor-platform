import {
  intersectsRotated,
  type Bounds,
  type GeometryItem,
  type Point,
} from '@editor-platform/editor-core';
import { createSpatialIndex, type SpatialIndex } from '@editor-platform/spatial-index';
import { getWasmFactory } from '@editor-platform/spatial-index/experimental';

type SpatialTarget = GeometryItem & {
  hitBounds?: Bounds;
  hitClipBounds?: Array<Bounds & { rotation?: number }>;
};

/** Intersect the marquee/hit hull with every oriented ancestor clip. Pairwise
 * overlap alone can admit an empty common intersection, including nested clips. */
function matches(item: SpatialTarget, bounds: Bounds): boolean {
  const hit = item.hitBounds ?? item.bounds;
  if (!intersectsRotated(bounds, hit, item.hitBounds ? 0 : item.rotation)) return false;
  if (!item.hitBounds || !item.hitClipBounds?.length) return true;
  const left = Math.max(bounds.x, hit.x),
    top = Math.max(bounds.y, hit.y),
    right = Math.min(bounds.x + bounds.width, hit.x + hit.width),
    bottom = Math.min(bounds.y + bounds.height, hit.y + hit.height);
  let polygon: Point[] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  for (const clip of item.hitClipBounds) {
    const angle = ((clip.rotation ?? 0) * Math.PI) / 180,
      cos = Math.cos(angle),
      sin = Math.sin(angle),
      cx = clip.x + clip.width / 2,
      cy = clip.y + clip.height / 2;
    const tolerance =
      Number.EPSILON * 64 * Math.max(1, Math.abs(cx), Math.abs(cy), clip.width, clip.height);
    for (const [nx, ny, extent] of [
      [cos, sin, clip.width / 2],
      [-cos, -sin, clip.width / 2],
      [-sin, cos, clip.height / 2],
      [sin, -cos, clip.height / 2],
    ]) {
      const distance = (p: Point) => extent - (p.x - cx) * nx - (p.y - cy) * ny;
      const clipped: Point[] = [];
      let previous = polygon.at(-1)!,
        before = distance(previous);
      for (const point of polygon) {
        const after = distance(point),
          previousInside = before >= -tolerance,
          currentInside = after >= -tolerance;
        if (previousInside !== currentInside) {
          const t = Math.max(0, Math.min(1, before / (before - after)));
          clipped.push({
            x: previous.x + (point.x - previous.x) * t,
            y: previous.y + (point.y - previous.y) * t,
          });
        }
        if (currentInside) clipped.push(point);
        previous = point;
        before = after;
      }
      if (!clipped.length) return false;
      polygon = clipped;
    }
  }
  return true;
}
/** Conservative hull. Exact rotation semantics remain in editor-core. */
function hull(item: SpatialTarget): Bounds {
  if (item.hitBounds) return item.hitBounds;
  const b = item.bounds,
    angle = ((item.rotation ?? 0) * Math.PI) / 180;
  const width = Math.abs(Math.cos(angle)) * b.width + Math.abs(Math.sin(angle)) * b.height;
  const height = Math.abs(Math.sin(angle)) * b.width + Math.abs(Math.cos(angle)) * b.height;
  const x = b.x + b.width / 2 - width / 2,
    y = b.y + b.height / 2 - height / 2;
  // Roundoff must never remove an edge-touching SAT hit. Extra candidates are harmless.
  const pad = Number.EPSILON * 64 * Math.max(1, Math.abs(x), Math.abs(y), width, height);
  return { x: x - pad, y: y - pad, width: width + 2 * pad, height: height + 2 * pad };
}
export class CanvasSpatialQuery {
  private source?: readonly GeometryItem[];
  private index?: SpatialIndex;
  private eligible: SpatialTarget[] = [];
  get backend() {
    return this.index?.backend ?? 'typescript';
  }
  query<T extends SpatialTarget>(items: readonly T[], bounds: Bounds): T[] {
    const legacy = () => items.filter((t) => !t.locked && !t.hidden && matches(t, bounds));
    // Keep the normal Host's existing TS path, including its cost and ownership.
    if (!getWasmFactory()) {
      this.dispose();
      return legacy();
    }
    try {
      if (this.source !== items) {
        this.dispose();
        this.eligible = items.filter((t) => !t.locked && !t.hidden);
        this.index = createSpatialIndex(this.eligible.map(hull));
        this.source = items;
      }
      return this.index!.query(bounds)
        .map((i) => this.eligible[i] as T)
        .filter((t) => matches(t, bounds));
    } catch {
      this.dispose();
      return legacy();
    } // Oversize/unsupported projections retain old behavior.
  }
  dispose() {
    this.index?.dispose();
    this.index = undefined;
    this.source = undefined;
    this.eligible = [];
  }
}
