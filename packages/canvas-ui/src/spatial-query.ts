import {
  intersectsRotated,
  type Bounds,
  type GeometryItem,
  type Drawing,
} from '@editor-platform/editor-core';
import { intersectsClips } from './spatial-clips';
import { createSpatialIndex, type SpatialIndex } from '@editor-platform/spatial-index';
import { getWasmFactory } from '@editor-platform/spatial-index/experimental';

type SpatialTarget = GeometryItem & {
  hitBounds?: Bounds;
  hitClipBounds?: Drawing['clipBounds'];
};

/** Intersect the marquee/hit hull with every oriented ancestor clip. Pairwise
 * overlap alone can admit an empty common intersection, including nested clips. */
function matches(item: SpatialTarget, bounds: Bounds): boolean {
  const hit = item.hitBounds ?? item.bounds;
  if (!intersectsRotated(bounds, hit, item.hitBounds ? 0 : item.rotation)) return false;
  if (!item.hitClipBounds?.length) return true;
  const paint = item.hitBounds ?? hull(item);
  const left = Math.max(bounds.x, paint.x),
    top = Math.max(bounds.y, paint.y),
    right = Math.min(bounds.x + bounds.width, paint.x + paint.width),
    bottom = Math.min(bounds.y + bounds.height, paint.y + paint.height);
  return intersectsClips(
    [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
    item.hitBounds
      ? item.hitClipBounds
      : [{ ...item.bounds, rotation: item.rotation }, ...item.hitClipBounds],
  );
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
