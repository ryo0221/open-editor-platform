import { assertGeoBackgroundSettings } from './background';
import type { Budgets, GeoDocument, Pin, Scalar } from './model';
import type { GeoWorkspace, GeoLayerStyle, GeoAnnotation } from './workspace-model';
import { id, hash, record } from './validation';

const requireValue = (ok: unknown, code: string): void => {
  if (!ok) throw Error(code);
};
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValue(
    record(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
    'workspace-shape',
  );
}
const text = (v: unknown) => typeof v === 'string' && v.length <= 1024;
const scalar = (v: unknown): v is Scalar =>
  v === null ||
  ['string', 'boolean'].includes(typeof v) ||
  (typeof v === 'number' && Number.isFinite(v));
const color = (v: unknown) => typeof v === 'string' && /^#[a-fA-F0-9]{6}$/.test(v);
function array(value: unknown, max: number): asserts value is unknown[] {
  requireValue(Array.isArray(value) && value.length <= max, 'workspace-array-limit');
}
function pin(value: unknown): asserts value is Pin {
  object(value, ['artifactId', 'versionId', 'contentHash']);
  requireValue(
    id(value.artifactId) && id(value.versionId) && hash(value.contentHash),
    'workspace-pin',
  );
}
export function assertGeoExtent(value: unknown): asserts value is [number, number, number, number] {
  requireValue(
    Array.isArray(value) &&
      value.length === 4 &&
      value.every(Number.isFinite) &&
      value[0] >= -180 &&
      value[0] <= 180 &&
      value[2] > value[0] &&
      value[2] - value[0] <= 360 &&
      value[1] >= -90 &&
      value[3] <= 90 &&
      value[3] > value[1],
    'view-extent',
  );
}
function annotation(value: unknown): asserts value is GeoAnnotation {
  object(value, ['id', 'text', 'position']);
  requireValue(
    id(value.id) &&
      text(value.text) &&
      Array.isArray(value.position) &&
      value.position.length === 2 &&
      value.position.every(Number.isFinite) &&
      Math.abs(value.position[0]) <= 180 &&
      Math.abs(value.position[1]) <= 90,
    'annotation',
  );
}
export const joinedFieldId = (joinId: string, fieldId: string) => `join:${joinId}:${fieldId}`;
const unique = (values: unknown[], key: string) => {
  const ids = values.map((v) => (v as Record<string, unknown>)[key]);
  requireValue(ids.every(id) && new Set(ids).size === ids.length, 'workspace-duplicate-id');
};
type GeoJoin = GeoWorkspace['joins'][number];
type FieldLookup = (layerId: string, fieldId: unknown) => { type: string } | undefined;
function assertJoin(join: GeoJoin, content: GeoDocument, limits: Budgets) {
  object(join, [
    'id',
    'layerId',
    'tableLayerId',
    'leftFieldId',
    'rightFieldId',
    'cardinality',
    'inputs',
    'fields',
    'rows',
  ]);
  requireValue(
    content.layers.some((l) => l.id === join.layerId) &&
      id(join.tableLayerId) &&
      id(join.leftFieldId) &&
      id(join.rightFieldId) &&
      ['one-to-one', 'many-to-one'].includes(join.cardinality),
    'join-layer',
  );
  object(join.inputs, ['left', 'right']);
  pin(join.inputs.left);
  pin(join.inputs.right);
  array(join.fields, 32);
  unique(join.fields, 'id');
  for (const f of join.fields) {
    object(f, ['id', 'name', 'type']);
    requireValue(text(f.name) && ['string', 'number', 'boolean'].includes(f.type), 'join-field');
  }
  array(join.rows, limits.features);
  unique(join.rows, 'featureId');
  for (const row of join.rows) {
    object(row, ['featureId', 'status', 'values']);
    object(
      row.values,
      join.fields.map((f) => f.id),
    );
    requireValue(['matched', 'unmatched', 'null-key'].includes(row.status), 'join-row');
    for (const f of join.fields)
      requireValue(
        scalar(row.values[f.id]) &&
          (row.values[f.id] === null || typeof row.values[f.id] === f.type),
        'join-value',
      );
  }
}
/** Native layer fields plus the namespaced fields contributed by joins on that layer. */
const fieldLookup =
  (content: GeoDocument, joins: readonly GeoJoin[]): FieldLookup =>
  (layerId, fieldId) =>
    content.layers.find((l) => l.id === layerId)?.fields.find((f) => f.id === fieldId) ||
    joins
      .filter((j) => j.layerId === layerId)
      .flatMap((j) => j.fields.map((f) => ({ ...f, id: joinedFieldId(j.id, f.id) })))
      .find((f) => f.id === fieldId);
const label = (v: unknown) => text(v) && !!(v as string).trim();
function assertMetric(
  m: NonNullable<GeoLayerStyle['metric']>,
  layerId: string,
  field: FieldLookup,
) {
  object(m, ['kind', 'numerator', 'denominator', 'multiplier', 'indicator', 'unit', 'period']);
  requireValue(
    ['count', 'rate'].includes(m.kind) &&
      field(layerId, m.numerator)?.type === 'number' &&
      (m.kind === 'count'
        ? m.denominator === null
        : field(layerId, m.denominator)?.type === 'number') &&
      Number.isFinite(m.multiplier) &&
      m.multiplier > 0 &&
      label(m.indicator) &&
      label(m.unit) &&
      label(m.period),
    'metric-definition',
  );
}
function assertCategories(categories: GeoLayerStyle['categories']) {
  const seen = new Set<string>();
  for (const c of categories) {
    object(c, ['value', 'color']);
    const key = JSON.stringify(c.value);
    requireValue(scalar(c.value) && color(c.color) && !seen.has(key), 'category-style');
    seen.add(key);
  }
}
function assertStyle(s: GeoLayerStyle, content: GeoDocument, field: FieldLookup) {
  object(s, [
    'layerId',
    'visible',
    'mode',
    'color',
    'missingColor',
    'radius',
    'fieldId',
    'labelFieldId',
    'categories',
    'boundaries',
    'colors',
    'metric',
    'filter',
  ]);
  const optionalField = (fieldId: string | null) => fieldId === null || !!field(s.layerId, fieldId);
  requireValue(
    content.layers.some((l) => l.id === s.layerId) &&
      typeof s.visible === 'boolean' &&
      ['single', 'category', 'classes', 'proportional'].includes(s.mode) &&
      color(s.color) &&
      color(s.missingColor) &&
      Number.isFinite(s.radius) &&
      s.radius >= 1 &&
      s.radius <= 40 &&
      optionalField(s.fieldId) &&
      optionalField(s.labelFieldId),
    'layer-style',
  );
  array(s.categories, 64);
  array(s.boundaries, 16);
  array(s.colors, 17);
  assertCategories(s.categories);
  requireValue(
    s.colors.every(color) &&
      s.boundaries.every((n, i) => Number.isFinite(n) && (i === 0 || n > s.boundaries[i - 1])) &&
      (s.mode !== 'classes' || s.colors.length === s.boundaries.length + 1),
    'class-boundaries',
  );
  if (s.metric !== null) assertMetric(s.metric, s.layerId, field);
  if (s.filter !== null) {
    object(s.filter, ['fieldId', 'value']);
    requireValue(!!field(s.layerId, s.filter.fieldId) && scalar(s.filter.value), 'layer-filter');
  }
  if (s.mode !== 'single')
    requireValue(s.fieldId !== null || s.metric !== null, 'style-field-required');
}
function assertView(
  view: GeoWorkspace['views'][number],
  limits: Budgets,
  style: (s: GeoLayerStyle) => void,
) {
  object(view, [
    'id',
    'name',
    'extent',
    'styles',
    'annotations',
    ...('backgrounds' in view ? ['backgrounds'] : []),
  ]);
  if (view.backgrounds !== undefined) assertGeoBackgroundSettings(view.backgrounds);
  requireValue(label(view.name), 'view-name');
  assertGeoExtent(view.extent);
  array(view.styles, limits.layers);
  array(view.annotations, limits.features);
  unique(view.styles, 'layerId');
  unique(view.annotations, 'id');
  view.styles.forEach(style);
  view.annotations.forEach(annotation);
}
function assertAsset(a: GeoWorkspace['assets'][number], content: GeoDocument, seen: Set<string>) {
  object(a, [
    'layerId',
    'featureId',
    'assetId',
    'inspectedAt',
    'accuracyMeters',
    'notes',
    'photos',
  ]);
  const key = JSON.stringify([a.layerId, a.featureId]);
  requireValue(
    content.layers.find((l) => l.id === a.layerId)?.features.some((f) => f.id === a.featureId) &&
      id(a.assetId) &&
      !seen.has(key) &&
      text(a.notes) &&
      (a.inspectedAt === '' || Number.isFinite(Date.parse(a.inspectedAt))) &&
      (a.accuracyMeters === null || (Number.isFinite(a.accuracyMeters) && a.accuracyMeters >= 0)),
    'asset-reference',
  );
  seen.add(key);
  array(a.photos, 8);
  for (const p of a.photos) {
    object(p, ['sourceId', 'name', 'required']);
    requireValue(
      id(p.sourceId) &&
        text(p.name) &&
        typeof p.required === 'boolean' &&
        content.sources.some((s) => s.id === p.sourceId && ['png', 'jpeg'].includes(s.format)),
      'asset-photo',
    );
  }
}
function assertComparison(c: GeoWorkspace['comparisons'][number], limits: Budgets) {
  object(c, [
    'id',
    'before',
    'after',
    'fieldIds',
    'toleranceDegrees',
    'completeCoverage',
    'changes',
  ]);
  pin(c.before);
  pin(c.after);
  array(c.fieldIds, 64);
  array(c.changes, limits.features * 2);
  requireValue(
    c.fieldIds.every(id) &&
      new Set(c.fieldIds).size === c.fieldIds.length &&
      Number.isFinite(c.toleranceDegrees) &&
      c.toleranceDegrees >= 0 &&
      c.toleranceDegrees <= 1 &&
      typeof c.completeCoverage === 'boolean',
    'comparison-options',
  );
  for (const change of c.changes) {
    object(change, ['layerId', 'featureId', 'kind', 'fields', 'geometryChanged']);
    array(change.fields, 64);
    requireValue(
      id(change.layerId) &&
        id(change.featureId) &&
        ['added', 'removed', 'no-counterpart', 'changed'].includes(change.kind) &&
        change.fields.every(id) &&
        typeof change.geometryChanged === 'boolean',
      'comparison-change',
    );
  }
}
/** Invoked only after bounded JSON admission. Unknown optional extension versions refuse. */
export function assertGeoWorkspace(
  value: unknown,
  content: GeoDocument,
  limits: Budgets,
): asserts value is GeoWorkspace {
  object(value, [
    'schemaVersion',
    'styles',
    'annotations',
    'views',
    'joins',
    'assets',
    'comparisons',
  ]);
  requireValue(value.schemaVersion === 1, 'workspace-schema');
  for (const key of ['styles', 'annotations', 'views', 'joins', 'assets', 'comparisons'])
    array(value[key], limits.features);
  const w = value as unknown as GeoWorkspace;
  unique(w.joins, 'id');
  unique(w.views, 'id');
  unique(w.annotations, 'id');
  unique(w.comparisons, 'id');
  for (const join of w.joins) assertJoin(join, content, limits);
  const field = fieldLookup(content, w.joins);
  const style = (s: GeoLayerStyle) => assertStyle(s, content, field);
  unique(w.styles, 'layerId');
  w.styles.forEach(style);
  w.annotations.forEach(annotation);
  for (const view of w.views) assertView(view, limits, style);
  const assets = new Set<string>();
  for (const a of w.assets) assertAsset(a, content, assets);
  for (const c of w.comparisons) assertComparison(c, limits);
}
