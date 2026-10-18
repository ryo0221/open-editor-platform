import type { Budgets, Feature, GeoDocument, Pin, Scalar, VectorLayer } from './model';
import type { GeoComparison, GeoLayerStyle, PinnedGeoJoin } from './workspace-model';
import { captureKeyJoinSnapshot, runReadonlyKeyJoin } from './key-join';
import { joinedFieldId } from './workspace-validation';
import { geometryPositions, unwrapLongitude } from './geometry';
import { assertGeo } from './validation';

export function createPinnedGeoJoin(
  content: GeoDocument,
  pin: Pin,
  options: Pick<
    PinnedGeoJoin,
    'id' | 'layerId' | 'tableLayerId' | 'leftFieldId' | 'rightFieldId' | 'cardinality'
  >,
  budgets: Budgets,
): PinnedGeoJoin {
  return createPinnedGeoJoinBetween({ content, pin }, { content, pin }, options, budgets);
}
/** Host verifies both immutable native inputs, then supplies a pure tabular projection. */
export function createPinnedGeoJoinBetween(
  leftInput: { content: GeoDocument; pin: Pin },
  rightInput: { content: GeoDocument; pin: Pin },
  options: Pick<
    PinnedGeoJoin,
    'id' | 'layerId' | 'tableLayerId' | 'leftFieldId' | 'rightFieldId' | 'cardinality'
  >,
  budgets: Budgets,
): PinnedGeoJoin {
  assertGeo(leftInput.content, budgets);
  assertGeo(rightInput.content, budgets);
  const limits = {
    native: { ...budgets, bytes: budgets.bytes * 3, features: budgets.features * 2 },
    inputRows: budgets.features * 2,
    outputRows: budgets.features,
    diagnostics: budgets.features * 4,
    outputBytes: budgets.bytes * 2,
  };
  const left = captureKeyJoinSnapshot(leftInput.content, options.layerId, leftInput.pin, limits);
  const right = captureKeyJoinSnapshot(
    rightInput.content,
    options.tableLayerId,
    rightInput.pin,
    limits,
  );
  const keyType = left.layer.fields.find((f) => f.id === options.leftFieldId)?.type;
  if (keyType !== 'string' && keyType !== 'number') throw Error('join-key-type');
  const result = runReadonlyKeyJoin(
    {
      left: leftInput.pin,
      right: rightInput.pin,
      leftFieldId: options.leftFieldId,
      rightFieldId: options.rightFieldId,
      keyType,
      cardinality: options.cardinality,
      normalization: 'none',
      nullPolicy: 'unmatched',
      duplicatePolicy: 'reject',
      resultAccess: 'readonly',
    },
    left,
    right,
    limits,
  );
  if (result.status !== 'ready')
    throw Error('join-blocked: ' + result.diagnostics.map((d) => d.code).join(', '));
  return {
    ...options,
    inputs: { left: { ...leftInput.pin }, right: { ...rightInput.pin } },
    fields: structuredClone(right.layer.fields) as PinnedGeoJoin['fields'],
    rows: result.rows.map((row) => ({
      featureId: row.featureId,
      status: row.status,
      values: Object.fromEntries(
        right.layer.fields.map((f) => [f.id, row.right?.values[f.id] ?? null]),
      ),
    })),
  };
}
export function geoFields(content: GeoDocument, layer: VectorLayer) {
  return [
    ...layer.fields,
    ...(content.workspace?.joins ?? [])
      .filter((j) => j.layerId === layer.id)
      .flatMap((j) =>
        j.fields.map((f) => ({
          ...f,
          id: joinedFieldId(j.id, f.id),
          name: `${j.id}: ${f.name} (readonly)`,
        })),
      ),
  ];
}
export function geoValue(
  content: GeoDocument,
  layerId: string,
  feature: Feature,
  fieldId: string | null,
): Scalar {
  if (!fieldId) return null;
  if (Object.hasOwn(feature.values, fieldId)) return feature.values[fieldId];
  for (const j of content.workspace?.joins ?? []) {
    if (j.layerId !== layerId) continue;
    const field = j.fields.find((f) => joinedFieldId(j.id, f.id) === fieldId);
    if (field) {
      const row = j.rows.find((row) => row.featureId === feature.id);
      if (row?.status === 'matched' && feature.values[j.leftFieldId] !== row.values[j.rightFieldId])
        return null;
      return row?.values[field.id] ?? null;
    }
  }
  return null;
}
export type MetricValue = {
  status:
    | 'value'
    | 'missing'
    | 'zero-denominator'
    | 'negative-denominator'
    | 'non-finite'
    | 'unmatched'
    | 'null-key'
    | 'stale-key';
  value: number | null;
};
export function geoMetricValue(
  content: GeoDocument,
  layerId: string,
  feature: Feature,
  style: GeoLayerStyle,
): MetricValue {
  const fieldId = style.metric?.numerator ?? style.fieldId;
  for (const j of content.workspace?.joins ?? []) {
    if (j.layerId !== layerId || !j.fields.some((f) => joinedFieldId(j.id, f.id) === fieldId))
      continue;
    const row = j.rows.find((row) => row.featureId === feature.id);
    if (row && row.status !== 'matched') return { status: row.status, value: null };
    if (row?.status === 'matched' && feature.values[j.leftFieldId] !== row.values[j.rightFieldId])
      return { status: 'stale-key', value: null };
  }
  const numerator = geoValue(content, layerId, feature, fieldId);
  if (typeof numerator !== 'number') return { status: 'missing', value: null };
  let value = numerator;
  if (style.metric?.kind === 'rate') {
    const denominator = geoValue(content, layerId, feature, style.metric.denominator);
    if (typeof denominator !== 'number') return { status: 'missing', value: null };
    if (denominator === 0) return { status: 'zero-denominator', value: null };
    if (denominator < 0) return { status: 'negative-denominator', value: null };
    value = numerator / denominator;
  }
  value *= style.metric?.multiplier ?? 1;
  return Number.isFinite(value)
    ? { status: 'value', value }
    : { status: 'non-finite', value: null };
}
export function compareGeoVersions(
  before: { content: GeoDocument; pin: Pin },
  after: { content: GeoDocument; pin: Pin },
  options: Pick<GeoComparison, 'id' | 'fieldIds' | 'toleranceDegrees' | 'completeCoverage'>,
  budgets: Budgets,
): GeoComparison {
  assertGeo(before.content, budgets);
  assertGeo(after.content, budgets);
  if (
    !Number.isFinite(options.toleranceDegrees) ||
    options.toleranceDegrees < 0 ||
    options.toleranceDegrees > 1
  )
    throw Error('comparison-tolerance');
  const result: GeoComparison = {
    ...structuredClone(options),
    before: { ...before.pin },
    after: { ...after.pin },
    changes: [],
  };
  const index = (document: GeoDocument) =>
    new Map(
      document.layers.flatMap((l) =>
        l.features.map((f) => [JSON.stringify([l.id, f.id]), { layerId: l.id, f }] as const),
      ),
    );
  const old = index(before.content),
    current = index(after.content);
  for (const [key, entry] of old) {
    const next = current.get(key);
    if (!next) {
      result.changes.push({
        layerId: entry.layerId,
        featureId: entry.f.id,
        kind: options.completeCoverage ? 'removed' : 'no-counterpart',
        fields: [],
        geometryChanged: false,
      });
      continue;
    }
    const fields = options.fieldIds.filter(
      (id) => JSON.stringify(entry.f.values[id]) !== JSON.stringify(next.f.values[id]),
    );
    const a = geometryPositions(entry.f.geometry),
      b = geometryPositions(next.f.geometry);
    // Structural changes are never hidden by a numerical tolerance.
    const skeleton = (v: unknown): unknown =>
      typeof v === 'number'
        ? 0
        : Array.isArray(v)
          ? v.map(skeleton)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, skeleton(x)]))
            : v;
    const geometryChanged =
      JSON.stringify(skeleton(entry.f.geometry)) !== JSON.stringify(skeleton(next.f.geometry)) ||
      a.length !== b.length ||
      a.some(
        (p, i) =>
          Math.abs(unwrapLongitude(b[i][0], p[0]) - p[0]) > options.toleranceDegrees ||
          Math.abs(p[1] - b[i][1]) > options.toleranceDegrees,
      );
    if (fields.length || geometryChanged)
      result.changes.push({
        layerId: entry.layerId,
        featureId: entry.f.id,
        kind: 'changed',
        fields,
        geometryChanged,
      });
  }
  for (const [key, entry] of current)
    if (!old.has(key))
      result.changes.push({
        layerId: entry.layerId,
        featureId: entry.f.id,
        kind: options.completeCoverage ? 'added' : 'no-counterpart',
        fields: [],
        geometryChanged: false,
      });
  return result;
}
/** Reimport identity is typed external ID, never row order/name/coordinates. */
export function previewGeoRefresh(previous: VectorLayer, incoming: VectorLayer) {
  const index = (layer: VectorLayer) => {
    const values = new Map<string, Feature>();
    for (const feature of layer.features) {
      const id = feature.sourceRef?.externalId;
      if (id === undefined || id === null) throw Error('refresh-missing-external-id');
      const key = JSON.stringify([typeof id, id]);
      if (values.has(key)) throw Error('refresh-duplicate-external-id');
      values.set(key, feature);
    }
    return values;
  };
  const old = index(previous),
    next = index(incoming);
  if (JSON.stringify(previous.fields) !== JSON.stringify(incoming.fields))
    throw Error('refresh-field-mapping-conflict');
  const layer: VectorLayer = {
    ...structuredClone(incoming),
    id: previous.id,
    name: previous.name,
    features: [],
  };
  const changes: { externalId: Scalar; kind: 'added' | 'removed' | 'changed' | 'unchanged' }[] = [];
  for (const [key, f] of next) {
    const prior = old.get(key);
    layer.features.push({
      ...structuredClone(f),
      ...(prior ? { id: prior.id, rowId: prior.rowId } : {}),
    });
    changes.push({
      externalId: f.sourceRef!.externalId,
      kind: !prior
        ? 'added'
        : JSON.stringify([prior.geometry, prior.values]) === JSON.stringify([f.geometry, f.values])
          ? 'unchanged'
          : 'changed',
    });
  }
  for (const [key, f] of old)
    if (!next.has(key)) changes.push({ externalId: f.sourceRef!.externalId, kind: 'removed' });
  return { layer, changes };
}
