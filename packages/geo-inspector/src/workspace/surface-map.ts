import { resolveGeoBackgrounds } from '@editor-platform/geo-core/backgrounds';
import {
  defaultGeoStyle,
  geoFields,
  geoLegend,
  geoMetricValue,
  geoValue,
  renderGeoSvg,
  type GeoDocument,
  type GeoLayerStyle,
} from '@editor-platform/geo-core';
import type { GeoSurfaceContext } from './surface-context';

type GeoLayer = GeoDocument['layers'][number];
type GeoFeature = GeoLayer['features'][number];
type GeoSource = GeoDocument['sources'][number];
type GeoView = NonNullable<GeoDocument['workspace']>['views'][number];
type GeoResolvedBackgrounds = ReturnType<typeof resolveGeoBackgrounds>;

/** Download link that retires all outputs when clicked after its authorization lapsed. */
export function guardedDownloadLink(
  ctx: GeoSurfaceContext,
  text: string,
  url: string,
  name: string,
  authorized: () => boolean,
) {
  const link = ctx.kit.node('a', text);
  ctx.urls.add(url);
  link.href = url;
  link.download = name;
  link.onclick = (e) => {
    try {
      if (!authorized()) throw Error('Download retired');
    } catch {
      e.preventDefault();
      ctx.retire();
    }
  };
  return link;
}

function backgroundStatusText(backgrounds: GeoResolvedBackgrounds) {
  if (backgrounds.diagnostics.length)
    return backgrounds.diagnostics.map((d) => `${d.id}: ${d.reason}`).join('; ');
  if (backgrounds.layers.length)
    return [...new Set(backgrounds.layers.map((l) => l.attribution))].join('; ');
  return 'Boundary backgrounds off.';
}

function renderMapSvg(ctx: GeoSurfaceContext, content: GeoDocument, view: GeoView | undefined) {
  const { state, el } = ctx;
  // The SVG comes exclusively from the escaped, validated domain serializer.
  const backgrounds = resolveGeoBackgrounds(state.backgroundSettings);
  el.backgroundStatus.textContent = backgroundStatusText(backgrounds);
  el.map.innerHTML = renderGeoSvg(
    content,
    {
      extent: state.extent,
      width: 960,
      height: 560,
      selected: state.selected,
      view,
      includeLegend: false,
      interactive: true,
      backgrounds,
    },
    ctx.host.budgets,
  );
  for (const target of el.map.querySelectorAll<SVGGElement>('[data-feature-id]')) {
    const selectTarget = () => ctx.choose(target.dataset.layerId!, target.dataset.featureId!);
    target.addEventListener('click', () => void ctx.run(selectTarget));
    target.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void ctx.run(selectTarget);
      }
    });
  }
}

function renderLayerSource(ctx: GeoSurfaceContext, l: GeoLayer) {
  const { node } = ctx.kit;
  const section = node('section');
  section.append(
    node('strong', l.name),
    node('p', `${l.features.length} features · ${l.fields.length} scalar fields · ${l.crs}`),
  );
  ctx.button(section, `Inspect layer ${l.name}`, () => {
    ctx.requireClean();
    ctx.state.styleLayer = l.id;
    ctx.renderForms();
  });
  const fields = node('details'),
    summary = node('summary', 'Field definitions');
  fields.append(
    summary,
    node('pre', l.fields.map((f) => `${f.name}: ${f.type} (${f.id})`).join('\n')),
  );
  section.append(fields);
  ctx.el.sourcePanel.append(section);
}

function exportOriginal(ctx: GeoSurfaceContext, sourceId: string) {
  const { host } = ctx;
  ctx.requireClean();
  const stamp = host.stamp(),
    original = host.original!(sourceId),
    url = URL.createObjectURL(
      new Blob([new Uint8Array(original.bytes)], { type: original.mediaType }),
    ),
    link = guardedDownloadLink(
      ctx,
      'Download selected original (includes its original attributes/photos)',
      url,
      original.name,
      () => ctx.urls.has(url) && host.stamp() === stamp,
    );
  ctx.el.downloads.append(link, ctx.kit.node('br'));
  ctx.el.status.textContent =
    'Selected original ready. Original files may include attributes excluded from data exchange.';
}

function renderDataSource(ctx: GeoSurfaceContext, source: GeoSource) {
  const { node } = ctx.kit;
  const detail = node('details'),
    summary = node('summary', source.id + ' · ' + source.format);
  detail.append(
    summary,
    node('p', source.attribution),
    node('p', source.adapterVersion),
    node('code', JSON.stringify(source.pin)),
  );
  if (ctx.host.original)
    ctx.button(detail, `Export original ${source.id}`, () => exportOriginal(ctx, source.id));
  ctx.el.sourcePanel.append(detail);
}

function legendText(layer: GeoLayer, s: GeoLayerStyle) {
  const kind = s.metric ? `${s.metric.indicator} · ${s.metric.unit} · ${s.metric.period}` : s.mode;
  return `${layer.name}: ${kind}. ${geoLegend(s)
    .map((e) => e.label)
    .join('; ')}`;
}

function renderFeatureRow(
  ctx: GeoSurfaceContext,
  content: GeoDocument,
  layer: GeoLayer,
  feature: GeoFeature,
  fields: ReturnType<typeof geoFields>,
  s: GeoLayerStyle,
) {
  const { node } = ctx.kit,
    selected = ctx.state.selected;
  const row = node('tr');
  row.setAttribute(
    'aria-selected',
    String(selected?.featureId === feature.id && selected.layerId === layer.id),
  );
  const first = node('td');
  const b = ctx.button(first, `${feature.id} · ${feature.geometry?.type ?? 'null geometry'}`, () =>
    ctx.choose(layer.id, feature.id),
  );
  b.setAttribute(
    'aria-pressed',
    String(selected?.featureId === feature.id && selected.layerId === layer.id),
  );
  row.append(first);
  for (const f of fields)
    row.append(node('td', JSON.stringify(geoValue(content, layer.id, feature, f.id))));
  const metric = geoMetricValue(content, layer.id, feature, s);
  row.append(node('td', `${metric.status}${metric.value === null ? '' : `: ${metric.value}`}`));
  return row;
}

function renderLayerTable(
  ctx: GeoSurfaceContext,
  content: GeoDocument,
  layer: GeoLayer,
  view: GeoView | undefined,
) {
  const { node } = ctx.kit;
  const s =
    view?.styles.find((s) => s.layerId === layer.id) ??
    content.workspace?.styles.find((s) => s.layerId === layer.id) ??
    defaultGeoStyle(layer.id);
  ctx.el.legend.append(node('p', legendText(layer, s)));
  const heading = node('h3', layer.name),
    grid = node('table'),
    head = node('thead'),
    header = node('tr'),
    body = node('tbody');
  grid.setAttribute('aria-label', `${layer.name} attributes`);
  const fields = geoFields(content, layer);
  for (const title of [
    'Feature / geometry',
    ...fields.map((f) => `${f.name} (${f.type})`),
    'Metric status',
  ])
    header.append(node('th', title));
  head.append(header);
  grid.append(head, body);
  let shown = 0;
  for (const feature of layer.features) {
    if (s.filter && geoValue(content, layer.id, feature, s.filter.fieldId) !== s.filter.value)
      continue;
    shown++;
    body.append(renderFeatureRow(ctx, content, layer, feature, fields, s));
  }
  ctx.el.table.append(
    heading,
    node(
      'p',
      `${shown} / ${layer.features.length} rows; hidden/null geometry records are retained.`,
    ),
    grid,
  );
}

export function renderGeoMapTable(ctx: GeoSurfaceContext) {
  const { state, el } = ctx;
  if (state.closed || ctx.editor.getSnapshot().state !== 'open') return;
  const content = ctx.open().snapshot.content,
    view = content.workspace?.views.find((v) => v.id === state.activeView);
  renderMapSvg(ctx, content, view);
  el.sourcePanel.replaceChildren(ctx.kit.node('h3', 'Layers and sources'));
  for (const l of content.layers) renderLayerSource(ctx, l);
  for (const source of content.sources) renderDataSource(ctx, source);
  el.legend.replaceChildren();
  el.table.replaceChildren();
  for (const layer of content.layers) renderLayerTable(ctx, content, layer, view);
}
