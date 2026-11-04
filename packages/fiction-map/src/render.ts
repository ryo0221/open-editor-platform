import type { FictionMapBounds } from './model';
import { createFictionMapProjection, FictionMapRenderError } from './output-projection';
export {
  createFictionMapProjection,
  hitFictionMapProjection,
  FictionMapRenderError,
} from './output-projection';
export type { FictionMapProjection } from './output-projection';
export type FictionMapOutputView = { kind: 'document' } | { kind: 'named'; id: string };
export interface FictionMapRenderOptions {
  width: number;
  height: number;
  view?: FictionMapOutputView;
  featureIds?: readonly string[];
  background?: 'transparent' | string;
}
export interface FictionMapSvg {
  svg: string;
  width: number;
  height: number;
  extent: FictionMapBounds;
  view: FictionMapOutputView;
}
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
/** Deterministic static SVG: no camera, DOM, selection, hover or in-progress preview. */
export function renderFictionMapSvg(
  input: unknown,
  options: FictionMapRenderOptions,
): FictionMapSvg {
  const projection = createFictionMapProjection(input, options);
  const {
    width,
    height,
    extent,
    view,
    scale,
    offset,
    features,
    project,
    background: bg,
  } = projection;
  const w = extent.maxX - extent.minX,
    h = extent.maxY - extent.minY;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Fiction Map"><title>Fiction Map</title><defs><clipPath id="fiction-map-output"><rect x="${offset.x}" y="${offset.y}" width="${w * scale}" height="${h * scale}"/></clipPath></defs>`,
    bg === 'transparent' ? '' : `<rect width="${width}" height="${height}" fill="${bg}"/>`,
    '<g clip-path="url(#fiction-map-output)">',
  ];
  for (const f of features) {
    const g = f.geometry,
      ps = (
        g.type === 'point' ? [g.coordinates] : g.type === 'polyline' ? g.coordinates : g.outer
      ).map(project),
      color = f.style?.color ?? '#386b80',
      stroke = f.style?.lineWidth ?? (g.type === 'polyline' ? 7 : 2),
      points = ps.map((p) => `${p.x},${p.y}`).join(' ');
    parts.push(`<g data-feature-id="${escape(f.id)}">`);
    if (g.type === 'point')
      parts.push(
        `<circle cx="${ps[0].x}" cy="${ps[0].y}" r="7" fill="${color}" stroke="${color}" stroke-width="${stroke}"/>`,
      );
    else if (g.type === 'polyline')
      parts.push(
        `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    else
      parts.push(
        `<polygon points="${points}" fill="${color}" fill-opacity="0.24" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round"/>`,
      );
    if (f.style?.label !== false)
      parts.push(
        `<text x="${ps[0].x + 12}" y="${ps[0].y - 12}" font-family="system-ui, sans-serif" font-size="12" fill="#183341" stroke="white" stroke-width="3" paint-order="stroke">${escape(f.name)}</text>`,
      );
    parts.push('</g>');
  }
  parts.push('</g></svg>');
  const svg = parts.join('');
  if (new TextEncoder().encode(svg).length > 2_097_152)
    throw new FictionMapRenderError('output-budget', 'SVG exceeds 2 MiB');
  return { svg, width, height, extent: { ...extent }, view: { ...view } };
}
