import { deepFreeze } from '@editor-platform/artifact-core';
import {
  validateFictionMap,
  hitTestFictionMapGeometry,
  type FictionMapContent,
  type FictionMapPoint,
} from './model';
import { isOwnedContent } from './admission';
import type { FictionMapRenderOptions } from './render';
export class FictionMapRenderError extends Error {
  constructor(
    readonly code:
      | 'invalid-native'
      | 'missing-view'
      | 'missing-feature'
      | 'output-budget'
      | 'invalid-output'
      | 'unprojectable-view',
    message: string,
  ) {
    super(message);
  }
}
/** Shared immutable projection for saved SVG, read-only overlays and hit testing. */
export function createFictionMapProjection(input: unknown, options: FictionMapRenderOptions) {
  let content: FictionMapContent;
  if (isOwnedContent(input)) content = input;
  else {
    const r = validateFictionMap(input);
    if (!r.ok) throw new FictionMapRenderError('invalid-native', r.diagnostic.code);
    content = r.value;
  }
  const { width, height } = options;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 16_777_216
  )
    throw new FictionMapRenderError(
      'output-budget',
      'Output requires integer dimensions 1..4096 and at most 16 Mi pixels',
    );
  const view = options.view ?? { kind: 'document' },
    named = view.kind === 'named' ? content.namedViews.find((v) => v.id === view.id) : undefined;
  if (view.kind !== 'document' && view.kind !== 'named')
    throw new FictionMapRenderError('invalid-output', 'Unknown view kind');
  if (view.kind === 'named' && !named)
    throw new FictionMapRenderError('missing-view', 'Saved view is missing');
  const extent = named?.extent ?? content.coordinateSpace.bounds,
    visible = new Set(
      named?.visibleLayerIds ?? content.layers.filter((l) => l.visibleByDefault).map((l) => l.id),
    );
  const ids = options.featureIds;
  if (
    ids &&
    (!Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 200 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string'))
  )
    throw new FictionMapRenderError(
      'invalid-output',
      'Feature IDs must be a nonempty unique set of at most 200',
    );
  if (ids?.some((id) => !content.features.some((f) => f.id === id)))
    throw new FictionMapRenderError('missing-feature', 'Saved feature ID is missing');
  const wanted = ids ? new Set(ids) : undefined,
    bg = options.background ?? '#ffffff';
  if (bg !== 'transparent' && !/^#[a-f\d]{6}$/i.test(bg))
    throw new FictionMapRenderError('invalid-output', 'Background must be transparent or hex RGB');
  const w = extent.maxX - extent.minX,
    h = extent.maxY - extent.minY,
    scale = Math.min(width / w, height / h),
    offset = { x: (width - w * scale) / 2, y: (height - h * scale) / 2 };
  if (!Number.isFinite(scale) || scale <= 0)
    throw new FictionMapRenderError(
      'unprojectable-view',
      'This view cannot be projected reliably at the requested size',
    );
  const project = (p: readonly [number, number]) => {
    const x = offset.x + (p[0] - extent.minX) * scale,
      y =
        offset.y +
        (content.coordinateSpace.yAxis === 'down' ? p[1] - extent.minY : extent.maxY - p[1]) *
          scale;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > 2 ** 24 ||
      Math.abs(y) > 2 ** 24
    )
      throw new FictionMapRenderError(
        'unprojectable-view',
        'Projected coordinates exceed the static SVG range',
      );
    return { x: Object.is(x, -0) ? 0 : x, y: Object.is(y, -0) ? 0 : y };
  };
  const features = content.layers.flatMap((layer) =>
    visible.has(layer.id)
      ? content.features.filter(
          (feature) => feature.layerId === layer.id && (!wanted || wanted.has(feature.id)),
        )
      : [],
  );
  const clip = { x: offset.x, y: offset.y, width: w * scale, height: h * scale };
  const contains = (p: { x: number; y: number }) =>
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= clip.x &&
    p.x <= clip.x + clip.width &&
    p.y >= clip.y &&
    p.y <= clip.y + clip.height;
  return deepFreeze({
    content,
    features,
    width,
    height,
    view: { ...view },
    extent: { ...extent },
    scale,
    offset,
    clip,
    background: bg,
    project,
    unproject(p: { x: number; y: number }): FictionMapPoint | undefined {
      if (!contains(p)) return undefined;
      const x = extent.minX + (p.x - offset.x) / scale;
      const y =
        content.coordinateSpace.yAxis === 'down'
          ? extent.minY + (p.y - offset.y) / scale
          : extent.maxY - (p.y - offset.y) / scale;
      return [x, y];
    },
    visiblePoint(p: FictionMapPoint) {
      if (
        !Number.isFinite(p[0]) ||
        !Number.isFinite(p[1]) ||
        p[0] < extent.minX ||
        p[0] > extent.maxX ||
        p[1] < extent.minY ||
        p[1] > extent.maxY
      )
        return undefined;
      const pixel = project(p);
      return contains(pixel) ? pixel : undefined;
    },
  });
}
export type FictionMapProjection = ReturnType<typeof createFictionMapProjection>;
/** Hit only painted geometry inside the same saved-view clip; labels are not invented geometry. */
export function hitFictionMapProjection(
  projection: FictionMapProjection,
  point: { x: number; y: number },
): string[] {
  const native = projection.unproject(point);
  if (!native) return [];
  return [...projection.features]
    .reverse()
    .filter((feature) => {
      const stroke = feature.style?.lineWidth ?? (feature.geometry.type === 'polyline' ? 7 : 2);
      const radius = ((feature.geometry.type === 'point' ? 7 : 0) + stroke / 2) / projection.scale;
      const hit = hitTestFictionMapGeometry(feature.geometry, native, radius);
      return hit.ok && hit.value;
    })
    .map((feature) => feature.id);
}
