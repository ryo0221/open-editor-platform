import { sameLocalRevision } from '@editor-platform/editor-core';
import {
  emptyGeoWorkspace,
  type GeoAction,
  type GeoDocument,
  type GeoLayerStyle,
  type Geometry,
  type Scalar,
} from '@editor-platform/geo-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { GeoFeatureControls, GeoStyleControls, GeoSurfaceContext } from './surface-context';
import { parseGeoNumber, splitGeoList } from './surface-dom';

type GeoFieldType = GeoDocument['layers'][number]['fields'][number]['type'];

function parseBoolean(text: string) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw Error('Boolean must be true or false');
}

export function parseGeoScalar(type: GeoFieldType, text: string): Scalar {
  if (type === 'number') return parseGeoNumber(text);
  if (type === 'boolean') return parseBoolean(text);
  return text;
}

function featureActions(ctx: GeoSurfaceContext, c: GeoFeatureControls): GeoAction[] {
  const actions: GeoAction[] = [];
  const { layer, feature } = ctx.currentFeature();
  const f = layer.fields.find((f) => f.id === ctx.state.scalarField);
  if (f) {
    const scalar: Scalar = c.isNull.checked ? null : parseGeoScalar(f.type, c.value.value);
    actions.push({
      type: 'setAttribute',
      layerId: layer.id,
      featureId: feature.id,
      fieldId: f.id,
      value: scalar,
    });
  }
  if (!c.geometry.disabled) {
    const next: Geometry | null =
      feature.geometry?.type === 'Point'
        ? {
            type: 'Point',
            coordinates: [parseGeoNumber(c.longitude.value), parseGeoNumber(c.latitude.value)],
          }
        : JSON.parse(c.geometry.value);
    actions.push({
      type: 'replaceGeometry',
      layerId: layer.id,
      featureId: feature.id,
      geometry: next,
    });
  }
  return actions;
}

function styleMetric(c: GeoStyleControls): GeoLayerStyle['metric'] {
  if (c.metricKind.value === 'none') return null;
  return {
    kind: c.metricKind.value as 'count' | 'rate',
    numerator: c.numerator.value,
    denominator: c.metricKind.value === 'rate' ? c.denominator.value : null,
    multiplier: parseGeoNumber(c.multiplier.value),
    indicator: c.indicator.value,
    unit: c.unit.value,
    period: c.period.value,
  };
}

function readStyle(layerId: string, c: GeoStyleControls): GeoLayerStyle {
  return {
    layerId,
    visible: c.visible.checked,
    mode: c.mode.value as GeoLayerStyle['mode'],
    color: c.color.value,
    missingColor: c.missingColor.value,
    radius: parseGeoNumber(c.radius.value),
    fieldId: c.field.value || null,
    labelFieldId: c.labelField.value || null,
    categories: JSON.parse(c.categories.value),
    boundaries: c.boundaries.value.trim()
      ? c.boundaries.value.split(',').map((s) => parseGeoNumber(s.trim()))
      : [],
    colors: splitGeoList(c.colors.value),
    filter: c.filterField.value
      ? { fieldId: c.filterField.value, value: JSON.parse(c.filterValue.value) }
      : null,
    metric: styleMetric(c),
  };
}

function styleAction(ctx: GeoSurfaceContext, snapshot: LocalReadSnapshot<GeoDocument>): GeoAction {
  const styleLayer = ctx.state.styleLayer;
  const w = structuredClone(snapshot.content.workspace ?? emptyGeoWorkspace());
  const s = readStyle(styleLayer, ctx.controls);
  w.styles = [...w.styles.filter((s) => s.layerId !== styleLayer), s];
  return { type: 'setWorkspace', workspace: w };
}

export function buildGeoInputActions(
  ctx: GeoSurfaceContext,
  snapshot: LocalReadSnapshot<GeoDocument>,
): GeoAction[] {
  const { state } = ctx;
  if (ctx.composing.size) throw Error('GeoInputComposing');
  if (!state.base || !sameLocalRevision(state.base.revision, snapshot.revision))
    throw Error('GeoStaleBuffer; input retained');
  const actions: GeoAction[] = [];
  if (state.featureDirty) actions.push(...featureActions(ctx, ctx.controls));
  if (state.styleDirty) actions.push(styleAction(ctx, snapshot));
  return actions;
}
