import type { LabelOffset } from './label-layout';
import type { CanvasTarget } from '@editor-platform/canvas-ui';
import {
  hitTestFictionMapGeometry,
  type FictionMapContent,
  type FictionMapFeature,
  type FictionMapGeometry,
  type FictionMapPoint,
} from './model';
import type { TransformDelta, Bounds } from '@editor-platform/editor-core';

export const stagePoint = (p: FictionMapPoint, axis: 'up' | 'down') => ({
  x: p[0],
  y: axis === 'up' ? -p[1] : p[1],
});
export const nativePoint = (p: { x: number; y: number }, axis: 'up' | 'down'): FictionMapPoint => [
  p.x,
  axis === 'up' ? -p.y : p.y,
];
export function geometryPoints(g: FictionMapGeometry): readonly FictionMapPoint[] {
  return g.type === 'point' ? [g.coordinates] : g.type === 'polyline' ? g.coordinates : g.outer;
}
export function featureStroke(f: FictionMapFeature): number {
  return f.style?.lineWidth ?? (f.geometry.type === 'polyline' ? 7 : 2);
}
export function hitRadius(f: FictionMapFeature, zoom: number): number {
  return (f.geometry.type === 'point' ? 7 + featureStroke(f) / 2 : featureStroke(f) / 2) / zoom;
}
export function frame(g: FictionMapGeometry, axis: 'up' | 'down', zoom: number): Bounds {
  const ps = geometryPoints(g).map((p) => stagePoint(p, axis)),
    xs = ps.map((p) => p.x),
    ys = ps.map((p) => p.y);
  if (g.type === 'point') {
    const r = 7 / zoom;
    return { x: ps[0].x - r, y: ps[0].y - r, width: 2 * r, height: 2 * r };
  }
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}
export function paintOrder(content: FictionMapContent): FictionMapFeature[] {
  return content.layers.flatMap((l) => content.features.filter((f) => f.layerId === l.id));
}
export function projectTargets(
  content: FictionMapContent,
  zoom: number,
  visibility: ReadonlyMap<string, boolean>,
  locked: ReadonlySet<string>,
  labels?: ReadonlyMap<string, LabelOffset | null>,
): CanvasTarget[] {
  const axis = content.coordinateSpace.yAxis;
  return paintOrder(content).map((f) => {
    const b = frame(f.geometry, axis, zoom),
      padding = hitRadius(f, zoom),
      labelWidth = ([...f.name].length * 14 + 6) / zoom;
    const anchor = stagePoint(geometryPoints(f.geometry)[0], axis);
    const label = labels?.get(f.id);
    const lx = anchor.x + ((label?.x ?? 12) - 3) / zoom;
    const ly = anchor.y + ((label?.y ?? -12) - 15) / zoom;
    const minX = Math.min(b.x - padding, lx),
      minY = Math.min(b.y - padding, ly);
    const maxX = Math.max(b.x + b.width + padding, lx + labelWidth);
    const maxY = Math.max(b.y + b.height + padding, ly + 21 / zoom);
    return {
      id: f.id,
      label: f.name,
      bounds: b,
      hidden: !(
        visibility.get(f.layerId) ??
        content.layers.find((l) => l.id === f.layerId)!.visibleByDefault
      ),
      locked: locked.has(f.id),
      resizable: false,
      rotatable: false,
      paintBounds: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
    };
  });
}
/** Exact native predicates receive only explicit world-space radii; labels keep their owner. */
export function hitCandidates(
  content: FictionMapContent,
  point: FictionMapPoint,
  zoom: number,
  visibility: ReadonlyMap<string, boolean>,
  locked: ReadonlySet<string>,
  labelOwner?: string,
): string[] {
  if (!(zoom > 0) || !Number.isFinite(zoom)) return [];
  return paintOrder(content)
    .reverse()
    .filter((f) => {
      if (
        locked.has(f.id) ||
        !(
          visibility.get(f.layerId) ??
          content.layers.find((l) => l.id === f.layerId)!.visibleByDefault
        )
      )
        return false;
      if (f.id === labelOwner) return true;
      const result = hitTestFictionMapGeometry(f.geometry, point, hitRadius(f, zoom));
      return result.ok && result.value;
    })
    .map((f) => f.id);
}
export function documentFrame(content: FictionMapContent): Bounds {
  const b = content.coordinateSpace.bounds;
  return {
    x: b.minX,
    y: content.coordinateSpace.yAxis === 'up' ? -b.maxY : b.minY,
    width: b.maxX - b.minX,
    height: b.maxY - b.minY,
  };
}
export interface CameraMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}
export function queryAt(
  matrix: CameraMatrix,
  client: { x: number; y: number },
  axis: 'up' | 'down',
): { point: FictionMapPoint; zoom: number } | undefined {
  const { a, b, c, d, e, f } = matrix,
    det = a * d - b * c,
    zoom = Math.hypot(a, b);
  if (!Number.isFinite(det) || det === 0 || !Number.isFinite(zoom) || zoom <= 0) return;
  const x = (d * (client.x - e) - c * (client.y - f)) / det,
    y = (-b * (client.x - e) + a * (client.y - f)) / det;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  return { point: nativePoint({ x, y }, axis), zoom };
}

/** Move-only adapter: no generic resize ratios, including zero-width/height paths. */
export function translationPreview(
  targets: CanvasTarget[],
  ids: string[],
  delta: TransformDelta,
): Map<string, { bounds: Bounds; rotation: number }> {
  const out = new Map<string, { bounds: Bounds; rotation: number }>();
  if (
    !ids.length ||
    delta.dw !== 0 ||
    delta.dh !== 0 ||
    (delta.rotation ?? 0) !== 0 ||
    !Number.isFinite(delta.dx) ||
    !Number.isFinite(delta.dy)
  )
    return out;
  const chosen = ids.map((id) => targets.find((t) => t.id === id));
  if (chosen.some((t) => !t || t.hidden || t.locked)) return out;
  for (const t of chosen) {
    const target = t!;
    out.set(target.id, {
      bounds: { ...target.bounds, x: target.bounds.x + delta.dx, y: target.bounds.y + delta.dy },
      rotation: target.rotation ?? 0,
    });
  }
  return out;
}
