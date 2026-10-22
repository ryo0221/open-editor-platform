import type { Budgets, Feature, GeoDocument, Geometry, Position } from './model';
import type { GeoExtent, GeoLayerStyle, NamedGeoView } from './workspace-model';
import { defaultGeoStyle } from './workspace-model';
import { assertGeo } from './validation';
import { assertGeoExtent } from './workspace-validation';
import { geoMetricValue, geoValue } from './workspace-analysis';
import { geometryPositions, unwrapLongitude } from './geometry';
import type { GeoBackgroundResolution } from './background';

export const GEO_RENDERER_VERSION = 'geo-svg-equirectangular@2';
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
interface Projector {
  center: number;
  project(position: Position): Position;
  number(n: number): string;
  paths(g: Geometry, offset: number, background?: boolean): string[];
}
function createProjector(extent: GeoExtent, mapWidth: number, mapHeight: number): Projector {
  const center = (extent[0] + extent[2]) / 2;
  const project = ([x, y]: Position): Position => [
    ((x - extent[0]) / (extent[2] - extent[0])) * mapWidth,
    ((extent[3] - y) / (extent[3] - extent[1])) * mapHeight,
  ];
  const number = (n: number) => String(Math.round(n * 1000) / 1000);
  const line = (points: Position[], offset: number, ring = false, background = false) => {
    let previous = center;
    let previousProjected = '';
    return (
      points
        .map((p) => {
          const x = unwrapLongitude(p[0], previous);
          previous = x;
          const [px, py] = project([x + offset, p[1]]);
          const format = background ? (n: number) => String(Math.round(n)) : number;
          const coordinate = `${format(px)},${format(py)}`;
          if (background && coordinate === previousProjected) return '';
          const result = `${previousProjected ? 'L' : 'M'}${coordinate}`;
          previousProjected = coordinate;
          return result;
        })
        .filter(Boolean)
        .join(' ') + (ring ? ' Z' : '')
    );
  };
  const paths = (g: Geometry, offset: number, background = false): string[] => {
    if (g.type === 'LineString') return [line(g.coordinates, offset)];
    if (g.type === 'MultiLineString') return g.coordinates.map((p) => line(p, offset));
    if (g.type === 'Polygon')
      return [g.coordinates.map((p) => line(p, offset, true, background)).join(' ')];
    if (g.type === 'MultiPolygon')
      return g.coordinates.map((p) => p.map((r) => line(r, offset, true, background)).join(' '));
    return [];
  };
  return { center, project, number, paths };
}
const wrapCredits = (credits: readonly string[]) =>
  [...new Set(credits)].flatMap((s) => s.match(/.{1,90}/gs) ?? []);
/** Unwrapped longitude/latitude bounds of every ring, relative to the view center. */
function unwrappedBounds(g: Geometry, center: number) {
  let west = Infinity,
    east = -Infinity,
    south = Infinity,
    north = -Infinity;
  const rings =
    g.type === 'MultiPolygon'
      ? g.coordinates.flat()
      : g.type === 'Polygon'
        ? g.coordinates
        : [geometryPositions(g)];
  for (const ring of rings) {
    let previous = center;
    for (const p of ring) {
      const x = unwrapLongitude(p[0], previous);
      previous = x;
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, p[1]);
      north = Math.max(north, p[1]);
    }
  }
  return { west, east, south, north };
}
function renderBackgrounds(
  resolution: GeoBackgroundResolution | undefined,
  extent: GeoExtent,
  projector: Projector,
) {
  const fills: string[] = [],
    outlines: string[] = [];
  for (const layer of resolution?.layers ?? []) {
    const geometry: string[] = [];
    for (const g of layer.geometries) {
      const { west, east, south, north } = unwrappedBounds(g, projector.center);
      if (north < extent[1] || south > extent[3]) continue;
      for (const offset of [-360, 0, 360])
        if (east + offset >= extent[0] && west + offset <= extent[2])
          geometry.push(...projector.paths(g, offset, true));
    }
    const d = geometry.join(' ');
    if (layer.setting.id === 'world-countries')
      fills.push(
        `<g data-background-fill="world-countries" aria-hidden="true" pointer-events="none"><path d="${d}" fill="#e1e8e4" fill-rule="evenodd"/></g>`,
      );
    outlines.push(
      `<g data-background-id="${xml(layer.setting.id)}" aria-hidden="true" pointer-events="none"><path d="${d}" fill="none" stroke="${xml(layer.setting.color)}" stroke-width="0.8"/></g>`,
    );
  }
  return fills.join('') + outlines.join('');
}
/** Legend column that advances one line per caption. */
function createLegend(x: number) {
  const items: string[] = [];
  const legend = {
    y: 24,
    items,
    caption(text: string, color?: string) {
      if (color)
        items.push(
          `<rect x="${x + 12}" y="${legend.y - 11}" width="12" height="12" fill="${color}"/>`,
        );
      items.push(
        `<text x="${x + (color ? 30 : 12)}" y="${legend.y}" font-size="12">${xml(text)}</text>`,
      );
      legend.y += 18;
    },
  };
  return legend;
}
type Legend = ReturnType<typeof createLegend>;
function metricCaptions(metric: NonNullable<GeoLayerStyle['metric']>) {
  return [
    metric.indicator,
    `${metric.unit} · ${metric.period}`,
    metric.kind === 'rate'
      ? `Rate × ${metric.multiplier}; denominator explicit`
      : 'Count (no normalization)',
  ];
}
function featureMarkup(
  geometry: Geometry,
  appearance: { color: string; radius: number },
  selected: boolean,
  label: unknown,
  projector: Projector,
) {
  const { center, project, number, paths } = projector;
  const { color, radius } = appearance;
  const fills = !['LineString', 'MultiLineString'].includes(geometry.type);
  const markup: string[] = [];
  for (const offset of [-360, 0, 360]) {
    if (geometry.type === 'Point' || geometry.type === 'MultiPoint') {
      const ps = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
      for (const p of ps) {
        const [x, y] = project([unwrapLongitude(p[0], center) + offset, p[1]]);
        markup.push(`<circle cx="${number(x)}" cy="${number(y)}" r="${radius}" fill="${color}"/>`);
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
  return markup.join('');
}
/** Appends a visible layer's legend and returns its feature markup. */
function renderLayer(
  content: GeoDocument,
  layer: GeoDocument['layers'][number],
  style: GeoLayerStyle,
  selection: { layerId: string; featureId: string } | null | undefined,
  legend: Legend,
  projector: Projector,
) {
  legend.caption(layer.name);
  if (style.metric) for (const t of metricCaptions(style.metric)) legend.caption(t);
  for (const entry of geoLegend(style)) legend.caption(entry.label, entry.color);
  const shapes: string[] = [];
  const statuses = new Map<string, number>();
  for (const feature of layer.features) {
    if (
      style.filter &&
      geoValue(content, layer.id, feature, style.filter.fieldId) !== style.filter.value
    )
      continue;
    const appearance = geoFeatureAppearance(content, layer.id, feature, style);
    const status = feature.geometry ? appearance.metric.status : 'null-geometry';
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    if (!feature.geometry) continue;
    const selected = selection?.layerId === layer.id && selection.featureId === feature.id;
    const label = geoValue(content, layer.id, feature, style.labelFieldId);
    const markup = featureMarkup(feature.geometry, appearance, selected, label, projector);
    shapes.push(
      `<g tabindex="0" role="button" aria-label="${xml(`${layer.name} / ${feature.id}`)}" aria-pressed="${selected}" data-layer-id="${xml(layer.id)}" data-feature-id="${xml(feature.id)}" stroke="${selected ? '#111111' : '#ffffff'}" stroke-width="${selected ? 4 : 1}">${markup}</g>`,
    );
  }
  for (const [status, count] of statuses)
    if (status !== 'value') legend.caption(`${status}: ${count}`);
  legend.y += 12;
  return shapes.join('');
}
function renderFooter(credits: string[], width: number, height: number, lineHeight: number) {
  const footerHeight = (credits.length + 1) * lineHeight + 6;
  return (
    `<rect x="0" y="${height - footerHeight}" width="${width}" height="${footerHeight}" fill="#ffffff"/>` +
    [...credits, 'CRS84 · equirectangular · explanatory map; not distance/area measurement']
      .map(
        (t, i) =>
          `<text x="8" y="${height - footerHeight + (i + 1) * lineHeight}" font-size="${(10 * lineHeight) / 13}" fill="#333333">${xml(t)}</text>`,
      )
      .join('')
  );
}
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
    /** Verified catalog resolution, separate from native limits and hit-testing. */
    backgrounds?: GeoBackgroundResolution;
  },
  budgets: Budgets,
): string {
  assertGeo(content, budgets);
  assertGeoExtent(options.extent);
  const { width, height, extent } = options;
  if (![width, height].every((n) => Number.isSafeInteger(n) && n >= 240 && n <= 2048))
    throw Error('render-pixels');
  const legendWidth = width >= 700 && options.includeLegend !== false ? 240 : 0,
    mapWidth = width - legendWidth;
  const styles = options.view?.styles ?? content.workspace?.styles ?? [];
  const annotations = options.view?.annotations ?? content.workspace?.annotations ?? [];
  if (wrapCredits(content.sources.map((s) => s.attribution)).length > 16)
    throw Error('Attribution exceeds image budget');
  const credits = wrapCredits([
    ...content.sources.map((s) => s.attribution),
    ...(options.backgrounds?.layers ?? []).flatMap((layer) => [
      layer.attribution,
      layer.licenseUrl,
    ]),
    ...(options.backgrounds?.diagnostics ?? []).map((d) => `Background unavailable: ${d.id}`),
  ]);
  // Optional background credits never consume the existing native attribution budget.
  // Compact the footer at small output heights while retaining every credit and a map.
  const creditLineHeight = Math.min(13, (height - 30) / (credits.length + 1));
  const mapHeight = height - ((credits.length + 1) * creditLineHeight + 6);
  const projector = createProjector(extent, mapWidth, mapHeight);
  const backgrounds = renderBackgrounds(options.backgrounds, extent, projector);
  const legend = createLegend(mapWidth);
  let shapes = '';
  for (const layer of content.layers) {
    const style = styles.find((s) => s.layerId === layer.id) ?? defaultGeoStyle(layer.id);
    if (style.visible)
      shapes += renderLayer(content, layer, style, options.selected, legend, projector);
  }
  for (const a of annotations) {
    const [x, y] = projector.project([
      unwrapLongitude(a.position[0], projector.center),
      a.position[1],
    ]);
    shapes += `<text x="${projector.number(x)}" y="${projector.number(y)}" font-size="15" fill="#111111" stroke="#ffffff" stroke-width="3" paint-order="stroke">${xml(a.text)}</text>`;
  }
  if (legendWidth && legend.y > height - 28)
    throw Error('Legend exceeds PNG height; increase dimensions or simplify explicit styling');
  const footer = renderFooter(credits, mapWidth, height, creditLineHeight);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="${options.interactive ? 'group' : 'img'}" aria-label="Geographic map, longitude latitude equirectangular display; distances and areas are not measurements"><defs><clipPath id="geo-map-clip"><rect width="${mapWidth}" height="${mapHeight}"/></clipPath></defs><rect width="${width}" height="${height}" fill="#ffffff"/><rect width="${mapWidth}" height="${mapHeight}" fill="#f1f5f7"/><g clip-path="url(#geo-map-clip)">${backgrounds}${shapes}</g>${legendWidth ? `<g fill="#142b3d" font-family="sans-serif">${legend.items.join('')}</g>` : ''}${footer}</svg>`;
}
