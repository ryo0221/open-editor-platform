import type { Budgets, Feature, GeoDocument, Geometry, Position } from './model';
import type { GeoExtent, GeoLayerStyle, NamedGeoView } from './workspace-model';
import { defaultGeoStyle } from './workspace-model';
import { assertGeo } from './validation';
import { assertGeoExtent } from './workspace-validation';
import { geoMetricValue, geoValue } from './workspace-analysis';
import { geometryPositions, unwrapLongitude } from './geometry';

export const GEO_RENDERER_VERSION = 'geo-svg-equirectangular@1';
export function fitGeoExtent(content: GeoDocument): GeoExtent {
  const positions = content.layers.flatMap((l) =>
    l.features.flatMap((f) => geometryPositions(f.geometry)),
  );
  if (!positions.length) return [-180, -90, 180, 90];
  const xs = [...new Set(positions.map((p) => ((p[0] % 360) + 360) % 360))].sort((a, b) => a - b);
  let gap = -1,
    start = xs[0];
  for (let i = 0; i < xs.length; i++) {
    const next = i === xs.length - 1 ? xs[0] + 360 : xs[i + 1];
    if (next - xs[i] > gap) {
      gap = next - xs[i];
      start = next % 360;
    }
  }
  const west = start >= 180 ? start - 360 : start;
  const span = Math.max(1, 360 - gap),
    margin = Math.min(4, span * 0.05);
  const left = Math.max(-180, west - margin),
    right = Math.min(left + 360, west + span + margin);
  const ys = positions.map((p) => p[1]);
  const bottom = Math.max(-90, Math.min(...ys) - 0.5),
    top = Math.min(90, Math.max(...ys) + 0.5);
  return [left, bottom, right, top];
}
export function geoLegend(style: GeoLayerStyle) {
  const entries: { label: string; color: string }[] = [];
  if (style.mode === 'category')
    for (const c of style.categories)
      entries.push({ label: JSON.stringify(c.value), color: c.color });
  else if (style.mode === 'classes')
    for (let i = 0; i <= style.boundaries.length; i++)
      entries.push({
        label:
          i === 0
            ? `< ${style.boundaries[0] ?? '∞'}`
            : i === style.boundaries.length
              ? `≥ ${style.boundaries[i - 1]}`
              : `${style.boundaries[i - 1]} ≤ x < ${style.boundaries[i]}`,
        color: style.colors[i] ?? style.color,
      });
  else
    entries.push({
      label: style.mode === 'proportional' ? 'Area proportional to non-negative value' : 'Features',
      color: style.color,
    });
  entries.push({ label: 'Missing / unmatched / invalid rate', color: style.missingColor });
  return entries;
}
export function geoFeatureAppearance(
  content: GeoDocument,
  layerId: string,
  feature: Feature,
  style: GeoLayerStyle,
) {
  const metric = geoMetricValue(content, layerId, feature, style);
  let color = style.color,
    radius = style.radius;
  if (style.mode === 'category')
    color =
      style.categories.find((c) => c.value === geoValue(content, layerId, feature, style.fieldId))
        ?.color ?? style.missingColor;
  if (style.mode === 'classes') {
    const index = metric.value === null ? -1 : style.boundaries.findIndex((b) => metric.value! < b);
    color =
      metric.value === null
        ? style.missingColor
        : style.colors[index < 0 ? style.boundaries.length : index];
  }
  if (style.mode === 'proportional') {
    const layer = content.layers.find((l) => l.id === layerId)!;
    const max = Math.max(
      1,
      ...layer.features.map((f) => geoMetricValue(content, layerId, f, style).value ?? 0),
    );
    if (metric.value === null || metric.value < 0) color = style.missingColor;
    else radius = 2 + style.radius * Math.sqrt(metric.value / max);
  }
  return { color, radius, metric };
}
const xml = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
/** Generated SVG only: user text is escaped and never treated as markup or a URL. */
export function renderGeoSvg(
  content: GeoDocument,
  options: {
    extent: GeoExtent;
    width: number;
    height: number;
    view?: NamedGeoView;
    includeLegend?: boolean;
    interactive?: boolean;
    selected?: { layerId: string; featureId: string } | null;
  },
  budgets: Budgets,
): string {
  assertGeo(content, budgets);
  assertGeoExtent(options.extent);
  const { width, height } = options;
  if (![width, height].every((n) => Number.isSafeInteger(n) && n >= 240 && n <= 2048))
    throw Error('render-pixels');
  const extent = options.extent,
    center = (extent[0] + extent[2]) / 2;
  const legendWidth = width >= 700 && options.includeLegend !== false ? 240 : 0,
    mapWidth = width - legendWidth;
  const styles = options.view?.styles ?? content.workspace?.styles ?? [];
  const annotations = options.view?.annotations ?? content.workspace?.annotations ?? [];
  const credits = [...new Set(content.sources.map((s) => s.attribution))].flatMap(
    (s) => s.match(/.{1,90}/gs) ?? [],
  );
  if (credits.length > 16) throw Error('Attribution exceeds image budget');
  const footerHeight = (credits.length + 1) * 13 + 6;
  const mapHeight = height - footerHeight;
  const project = ([x, y]: Position): Position => [
    ((x - extent[0]) / (extent[2] - extent[0])) * mapWidth,
    ((extent[3] - y) / (extent[3] - extent[1])) * mapHeight,
  ];
  const number = (n: number) => String(Math.round(n * 1000) / 1000);
  const line = (points: Position[], offset: number, ring = false) => {
    let previous = center;
    return (
      points
        .map((p, i) => {
          const x = unwrapLongitude(p[0], previous);
          previous = x;
          const [px, py] = project([x + offset, p[1]]);
          return `${i ? 'L' : 'M'}${number(px)},${number(py)}`;
        })
        .join(' ') + (ring ? ' Z' : '')
    );
  };
  const paths = (g: Geometry, offset: number): string[] => {
    if (g.type === 'LineString') return [line(g.coordinates, offset)];
    if (g.type === 'MultiLineString') return g.coordinates.map((p) => line(p, offset));
    if (g.type === 'Polygon') return [g.coordinates.map((p) => line(p, offset, true)).join(' ')];
    if (g.type === 'MultiPolygon')
      return g.coordinates.map((p) => p.map((r) => line(r, offset, true)).join(' '));
    return [];
  };
  const shapes: string[] = [],
    legend: string[] = [];
  let legendY = 24;
  for (const layer of content.layers) {
    const style = styles.find((s) => s.layerId === layer.id) ?? defaultGeoStyle(layer.id);
    if (!style.visible) continue;
    const caption = (text: string, color?: string) => {
      if (color)
        legend.push(
          `<rect x="${mapWidth + 12}" y="${legendY - 11}" width="12" height="12" fill="${color}"/>`,
        );
      legend.push(
        `<text x="${mapWidth + (color ? 30 : 12)}" y="${legendY}" font-size="12">${xml(text)}</text>`,
      );
      legendY += 18;
    };
    caption(layer.name);
    if (style.metric)
      for (const t of [
        style.metric.indicator,
        `${style.metric.unit} · ${style.metric.period}`,
        style.metric.kind === 'rate'
          ? `Rate × ${style.metric.multiplier}; denominator explicit`
          : 'Count (no normalization)',
      ])
        caption(t);
    for (const entry of geoLegend(style)) caption(entry.label, entry.color);
    const statuses = new Map<string, number>();
    for (const feature of layer.features) {
      if (
        style.filter &&
        geoValue(content, layer.id, feature, style.filter.fieldId) !== style.filter.value
      )
        continue;
      const { color, radius, metric } = geoFeatureAppearance(content, layer.id, feature, style);
      statuses.set(
        feature.geometry ? metric.status : 'null-geometry',
        (statuses.get(feature.geometry ? metric.status : 'null-geometry') ?? 0) + 1,
      );
      if (!feature.geometry) continue;
      const selected =
        options.selected?.layerId === layer.id && options.selected.featureId === feature.id;
      const label = geoValue(content, layer.id, feature, style.labelFieldId);
      const geometry = feature.geometry,
        fills = !['LineString', 'MultiLineString'].includes(geometry.type);
      const markup: string[] = [];
      for (const offset of [-360, 0, 360]) {
        if (geometry.type === 'Point' || geometry.type === 'MultiPoint') {
          const ps = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
          for (const p of ps) {
            const [x, y] = project([unwrapLongitude(p[0], center) + offset, p[1]]);
            markup.push(
              `<circle cx="${number(x)}" cy="${number(y)}" r="${radius}" fill="${color}"/>`,
            );
          }
        } else
          for (const d of paths(geometry, offset))
            markup.push(
              `<path d="${d}" fill="${fills ? color : 'none'}" fill-rule="evenodd" stroke="${selected ? '#111111' : color}" stroke-width="${selected ? 4 : 2}"/>`,
            );
      }
      const anchor = geometryPositions(geometry)[0];
      if (label !== null && anchor) {
        const [x, y] = project([unwrapLongitude(anchor[0], center), anchor[1]]);
        markup.push(
          `<text x="${number(x + 8)}" y="${number(y - 8)}" font-size="13" fill="#142b3d" stroke="#ffffff" stroke-width="3" paint-order="stroke">${xml(label)}</text>`,
        );
      }
      shapes.push(
        `<g tabindex="0" role="button" aria-label="${xml(`${layer.name} / ${feature.id}`)}" aria-pressed="${!!selected}" data-layer-id="${xml(layer.id)}" data-feature-id="${xml(feature.id)}" stroke="${selected ? '#111111' : '#ffffff'}" stroke-width="${selected ? 4 : 1}">${markup.join('')}</g>`,
      );
    }
    for (const [status, count] of statuses) if (status !== 'value') caption(`${status}: ${count}`);
    legendY += 12;
  }
  for (const a of annotations) {
    const [x, y] = project([unwrapLongitude(a.position[0], center), a.position[1]]);
    shapes.push(
      `<text x="${number(x)}" y="${number(y)}" font-size="15" fill="#111111" stroke="#ffffff" stroke-width="3" paint-order="stroke">${xml(a.text)}</text>`,
    );
  }
  if (legendWidth && legendY > height - 28)
    throw Error('Legend exceeds PNG height; increase dimensions or simplify explicit styling');
  const footer =
    `<rect x="0" y="${height - footerHeight}" width="${mapWidth}" height="${footerHeight}" fill="#ffffff"/>` +
    [...credits, 'CRS84 · equirectangular · explanatory map; not distance/area measurement']
      .map(
        (t, i) =>
          `<text x="8" y="${height - footerHeight + 13 + i * 13}" font-size="10" fill="#333333">${xml(t)}</text>`,
      )
      .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="${options.interactive ? 'group' : 'img'}" aria-label="Geographic map, longitude latitude equirectangular display; distances and areas are not measurements"><defs><clipPath id="geo-map-clip"><rect width="${mapWidth}" height="${mapHeight}"/></clipPath></defs><rect width="${width}" height="${height}" fill="#ffffff"/><rect width="${mapWidth}" height="${mapHeight}" fill="#f1f5f7"/><g clip-path="url(#geo-map-clip)">${shapes.join('')}</g>${legendWidth ? `<g fill="#142b3d" font-family="sans-serif">${legend.join('')}</g>` : ''}${footer}</svg>`;
}
