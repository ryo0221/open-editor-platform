import {
  assertEditableGeometry,
  defaultGeoStyle,
  geoFields,
  type GeoDocument,
  type GeoLayerStyle,
} from '@editor-platform/geo-core';
import type { GeoSurfaceContext } from './surface-context';
import { geoChoices, type GeoChoice } from './surface-dom';

type GeoLayer = GeoDocument['layers'][number];
type GeoFeature = GeoLayer['features'][number];

function ensureSelection(ctx: GeoSurfaceContext, content: GeoDocument) {
  const { state } = ctx;
  if (
    !state.selected ||
    !content.layers
      .find((l) => l.id === state.selected?.layerId)
      ?.features.some((f) => f.id === state.selected?.featureId)
  ) {
    const layer = content.layers.find((l) => l.features.length);
    state.selected = layer ? { layerId: layer.id, featureId: layer.features[0].id } : null;
  }
}

/** A select whose change re-renders through `run`, restoring the prior choice while input is pending. */
function guardedSelect(
  ctx: GeoSurfaceContext,
  field: HTMLSelectElement,
  get: () => string,
  set: (value: string) => void,
) {
  field.onchange = () => {
    const next = field.value;
    void ctx.run(() => {
      ctx.requireClean();
      set(next);
      ctx.renderForms();
    });
    if (ctx.pending()) field.value = get();
  };
}

function isReadonlyGeometry(feature: GeoFeature) {
  try {
    assertEditableGeometry(feature.geometry);
  } catch {
    return true;
  }
  return false;
}

const pointCoordinate = (feature: GeoFeature, index: 0 | 1) =>
  feature.geometry?.type === 'Point' ? String(feature.geometry.coordinates[index]) : '';

function renderGeometryControls(ctx: GeoSurfaceContext, feature: GeoFeature, canEdit: boolean) {
  const { kit, controls: c } = ctx,
    form = ctx.el.form;
  c.longitude = kit.input(form, 'Longitude', pointCoordinate(feature, 0));
  c.latitude = kit.input(form, 'Latitude', pointCoordinate(feature, 1));
  c.geometry = kit.textArea(form, 'Geometry JSON', JSON.stringify(feature.geometry));
  const geometryReadonly = isReadonlyGeometry(feature);
  c.geometry.disabled = geometryReadonly || !canEdit;
  c.longitude.disabled = c.latitude.disabled =
    geometryReadonly || feature.geometry?.type !== 'Point' || !canEdit;
  c.geometry.hidden = feature.geometry?.type === 'Point';
  if (geometryReadonly)
    form.append(
      kit.node(
        'p',
        'Multi/holes are preserved; geometry editing is unavailable. Scalar attributes remain editable.',
      ),
    );
}

function renderFeatureForm(ctx: GeoSurfaceContext, canEdit: boolean) {
  const { kit, state, controls: c } = ctx,
    form = ctx.el.form;
  const { layer, feature } = ctx.currentFeature();
  form.append(
    kit.node('h3', 'Feature'),
    kit.node('p', `${layer.id} / ${feature.id} / row ${feature.rowId}`),
  );
  const ownFields = layer.fields;
  if (!ownFields.some((f) => f.id === state.scalarField))
    state.scalarField = ownFields[0]?.id ?? '';
  const fieldSelect = kit.select(
    form,
    'Scalar field',
    ownFields.map((f) => ({ value: f.id, label: `${f.name} (${f.type})` })),
    state.scalarField,
  );
  guardedSelect(
    ctx,
    fieldSelect,
    () => state.scalarField,
    (next) => (state.scalarField = next),
  );
  const scalar = feature.values[state.scalarField] ?? null;
  c.value = kit.input(form, 'Scalar value', scalar === null ? '' : String(scalar));
  c.isNull = kit.input(form, 'Scalar is null', '', 'checkbox');
  c.isNull.checked = scalar === null;
  renderGeometryControls(ctx, feature, canEdit);
  for (const control of [c.value, c.isNull, c.longitude, c.latitude, c.geometry])
    ctx.watch(control, 'feature');
  c.value.disabled = c.isNull.disabled = !canEdit || !ownFields.length;
  ctx.button(form, 'Delete selected feature', () => {
    const w = ctx.workspace();
    w.assets = w.assets.filter((a) => a.layerId !== layer.id || a.featureId !== feature.id);
    return ctx.mutate([
      { type: 'setWorkspace', workspace: w },
      { type: 'deleteFeature', layerId: layer.id, featureId: feature.id },
    ]);
  });
}

function renderSymbolControls(ctx: GeoSurfaceContext, s: GeoLayerStyle, choices: GeoChoice[]) {
  const { kit, controls: c } = ctx,
    p = ctx.el.presentation;
  c.visible = kit.input(p, 'Layer visible', '', 'checkbox');
  c.visible.checked = s.visible;
  c.mode = kit.select(
    p,
    'Symbol mode',
    geoChoices(['single', 'category', 'classes', 'proportional']),
    s.mode,
  );
  c.field = kit.select(p, 'Style field', choices, s.fieldId ?? '');
  c.labelField = kit.select(p, 'Label field', choices, s.labelFieldId ?? '');
  c.color = kit.input(p, 'Symbol color', s.color);
  c.missingColor = kit.input(p, 'Missing color', s.missingColor);
  c.radius = kit.input(p, 'Symbol radius', String(s.radius));
  c.categories = kit.textArea(p, 'Categories JSON', JSON.stringify(s.categories));
  c.boundaries = kit.input(p, 'Class boundaries', s.boundaries.join(','));
  c.colors = kit.input(p, 'Class colors', s.colors.join(','));
}

function renderMetricControls(ctx: GeoSurfaceContext, s: GeoLayerStyle, choices: GeoChoice[]) {
  const { kit, controls: c } = ctx,
    p = ctx.el.presentation;
  c.metricKind = kit.select(
    p,
    'Metric kind',
    geoChoices(['none', 'count', 'rate']),
    s.metric?.kind ?? 'none',
  );
  c.numerator = kit.select(p, 'Numerator field', choices, s.metric?.numerator ?? '');
  c.denominator = kit.select(p, 'Denominator field', choices, s.metric?.denominator ?? '');
  c.multiplier = kit.input(p, 'Rate multiplier', String(s.metric?.multiplier ?? 1));
  c.indicator = kit.input(p, 'Indicator', s.metric?.indicator ?? '');
  c.unit = kit.input(p, 'Unit', s.metric?.unit ?? '');
  c.period = kit.input(p, 'Period', s.metric?.period ?? '');
}

function renderFilterControls(ctx: GeoSurfaceContext, s: GeoLayerStyle, choices: GeoChoice[]) {
  const { kit, controls: c } = ctx,
    p = ctx.el.presentation;
  c.filterField = kit.select(p, 'Filter field', choices, s.filter?.fieldId ?? '');
  c.filterValue = kit.input(
    p,
    'Filter value (JSON scalar)',
    JSON.stringify(s.filter?.value ?? null),
  );
}

function renderStyleControls(
  ctx: GeoSurfaceContext,
  content: GeoDocument,
  layer: GeoLayer,
  canEdit: boolean,
) {
  const c = ctx.controls;
  const s =
      content.workspace?.styles.find((s) => s.layerId === layer.id) ?? defaultGeoStyle(layer.id),
    fields = geoFields(content, layer);
  const choices = [
    { value: '', label: '(none)' },
    ...fields.map((f) => ({ value: f.id, label: f.name })),
  ];
  renderSymbolControls(ctx, s, choices);
  renderMetricControls(ctx, s, choices);
  renderFilterControls(ctx, s, choices);
  for (const control of [
    c.visible,
    c.mode,
    c.field,
    c.labelField,
    c.color,
    c.missingColor,
    c.radius,
    c.categories,
    c.boundaries,
    c.colors,
    c.metricKind,
    c.numerator,
    c.denominator,
    c.multiplier,
    c.indicator,
    c.unit,
    c.period,
    c.filterField,
    c.filterValue,
  ]) {
    control.disabled = !canEdit;
    ctx.watch(control, 'style');
  }
  ctx.el.presentation.append(
    ctx.kit.node(
      'p',
      'Choose denominator, unit, period and class boundaries explicitly. Zero is a value; missing and zero denominator are separate diagnostics. Joined fields are read-only.',
    ),
  );
}

function renderPresentation(ctx: GeoSurfaceContext, content: GeoDocument, canEdit: boolean) {
  const { kit, state } = ctx,
    presentation = ctx.el.presentation;
  presentation.replaceChildren();
  presentation.append(kit.node('h3', 'Layer presentation'));
  if (!content.layers.some((l) => l.id === state.styleLayer))
    state.styleLayer = state.selected?.layerId ?? content.layers[0]?.id ?? '';
  const layerSelect = kit.select(
    presentation,
    'Style layer',
    content.layers.map((l) => ({ value: l.id, label: l.name })),
    state.styleLayer,
  );
  guardedSelect(
    ctx,
    layerSelect,
    () => state.styleLayer,
    (next) => (state.styleLayer = next),
  );
  const layer = content.layers.find((l) => l.id === state.styleLayer);
  if (layer) renderStyleControls(ctx, content, layer, canEdit);
}

export function renderGeoForms(ctx: GeoSurfaceContext) {
  const { state } = ctx;
  if (state.closed || ctx.pending()) return;
  const v = ctx.open();
  state.base = v.snapshot;
  const content = v.snapshot.content;
  ensureSelection(ctx, content);
  ctx.el.form.replaceChildren();
  if (state.selected) renderFeatureForm(ctx, v.canEdit);
  else ctx.el.form.append(ctx.kit.node('p', 'Import a layer or create a feature.'));
  renderPresentation(ctx, content, v.canEdit);
}
