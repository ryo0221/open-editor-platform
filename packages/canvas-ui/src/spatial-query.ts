import { intersectsRotated, type Bounds, type GeometryItem } from '@editor-platform/editor-core';
import { createSpatialIndex, type SpatialIndex } from '@editor-platform/spatial-index';
import { getWasmFactory } from '@editor-platform/spatial-index/experimental';

/** Conservative hull. Exact rotation semantics remain in editor-core. */
function hull(item: GeometryItem): Bounds {
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
  private eligible: GeometryItem[] = [];
  get backend() {
    return this.index?.backend ?? 'typescript';
  }
  query<T extends GeometryItem>(items: readonly T[], bounds: Bounds): T[] {
    const legacy = () =>
      items.filter(
        (t) => !t.locked && !t.hidden && intersectsRotated(bounds, t.bounds, t.rotation),
      );
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
        .filter((t) => intersectsRotated(bounds, t.bounds, t.rotation));
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
