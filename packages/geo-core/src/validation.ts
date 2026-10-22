import { checkedJson } from './json-boundary';
import type { Budgets, Diagnostic, GeoDocument } from './model';
import { assertGeoWorkspace } from './workspace-validation';
export const record = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
export const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
export const hash = (v: unknown): boolean =>
  typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
interface Check {
  d: Diagnostic[];
  vertices: number;
  features: number;
}
const error = (c: Check, code: string, path: string) => {
  c.d.push({ code, path, severity: 'error' });
};
const keys = (c: Check, v: Record<string, unknown>, allowed: string[], path: string) => {
  if (Object.keys(v).some((k) => !allowed.includes(k))) error(c, 'unknown-field', path);
};
const oneOf = (v: unknown, allowed: readonly string[]) =>
  typeof v === 'string' && allowed.includes(v);
const sourcePinned = (
  s: unknown,
  seen: Set<string>,
): s is Record<string, unknown> & { id: string } =>
  record(s) &&
  id(s.id) &&
  !seen.has(s.id) &&
  id(s.resourceId) &&
  hash(s.bytesHash) &&
  record(s.pin) &&
  id(s.pin.artifactId) &&
  id(s.pin.versionId) &&
  hash(s.pin.contentHash) &&
  oneOf(s.format, ['geojson', 'csv', 'png', 'jpeg']) &&
  typeof s.adapterVersion === 'string' &&
  s.declaredCrs === 'OGC:CRS84' &&
  s.axis === 'longitude-latitude' &&
  typeof s.attribution === 'string';
function validateSources(c: Check, sources: unknown[]) {
  const sourceIds = new Set<string>();
  for (const [i, s] of sources.entries()) {
    const p = `sources[${i}]`;
    if (!sourcePinned(s, sourceIds)) {
      error(c, 'source-pin', p);
      continue;
    }
    keys(
      c,
      s,
      [
        'id',
        'pin',
        'resourceId',
        'bytesHash',
        'format',
        'adapterVersion',
        'declaredCrs',
        'axis',
        'attribution',
      ],
      p,
    );
    keys(c, s.pin as Record<string, unknown>, ['artifactId', 'versionId', 'contentHash'], p);
    sourceIds.add(s.id);
  }
  return sourceIds;
}
function position(c: Check, v: unknown, p: string): boolean {
  c.vertices++;
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    !Object.hasOwn(v, 0) ||
    !Object.hasOwn(v, 1) ||
    !Number.isFinite(v[0]) ||
    !Number.isFinite(v[1])
  ) {
    error(c, 'position-or-dimension', p);
    return false;
  }
  if (Math.abs(v[0]) > 180 || Math.abs(v[1]) > 90) {
    error(c, 'coordinate-range', p);
    return false;
  }
  return true;
}
function line(c: Check, v: unknown, p: string, ring = false) {
  if (!Array.isArray(v) || v.length < (ring ? 4 : 2)) {
    error(c, 'vertices', p);
    return;
  }
  v.forEach((x, i) => position(c, x, `${p}[${i}]`));
  if (ring && JSON.stringify(v[0]) !== JSON.stringify(v.at(-1))) error(c, 'ring-not-closed', p);
  if (ring) c.d.push({ code: 'topology-not-checked', path: p, severity: 'warning' });
}
function polygon(c: Check, v: unknown, p: string) {
  if (!Array.isArray(v) || !v.length) {
    error(c, 'rings', p);
    return;
  }
  v.forEach((r, i) => line(c, r, `${p}[${i}]`, true));
}
const parts = {
  MultiPoint: position,
  MultiLineString: (c: Check, v: unknown, p: string) => line(c, v, p),
  MultiPolygon: polygon,
} as const;
function geometry(c: Check, v: unknown, p: string) {
  if (v === null) return;
  if (!record(v)) {
    error(c, 'geometry', p);
    return;
  }
  keys(c, v, ['type', 'coordinates'], p);
  const coordinates = v.coordinates;
  if (v.type === 'Point') position(c, coordinates, p);
  else if (v.type === 'LineString') line(c, coordinates, p);
  else if (v.type === 'Polygon') polygon(c, coordinates, p);
  else if (v.type === 'MultiPoint' || v.type === 'MultiLineString' || v.type === 'MultiPolygon') {
    if (!Array.isArray(coordinates) || !coordinates.length) error(c, 'multi', p);
    else {
      const part = parts[v.type];
      coordinates.forEach((x, i) => part(c, x, `${p}[${i}]`));
    }
  } else error(c, 'unsupported-geometry', p);
}
function layerFields(c: Check, fields: unknown[], p: string) {
  const types = new Map<string, string>();
  for (const f of fields) {
    if (
      !record(f) ||
      !id(f.id) ||
      types.has(f.id) ||
      typeof f.name !== 'string' ||
      !oneOf(f.type, ['string', 'number', 'boolean'])
    )
      error(c, 'field', p);
    else {
      types.set(f.id, f.type as string);
      keys(c, f, ['id', 'name', 'type'], p);
    }
  }
  return types;
}
const scalarsMatch = (values: Record<string, unknown>, fields: Map<string, string>) =>
  Object.keys(values).length === fields.size &&
  [...fields].every(
    ([k, t]) => Object.hasOwn(values, k) && (values[k] === null || typeof values[k] === t),
  );
function sourceRef(c: Check, s: unknown, sourceIds: Set<string>, fp: string) {
  if (
    !record(s) ||
    !Object.hasOwn(s, 'sourceId') ||
    !id(s.sourceId) ||
    !sourceIds.has(s.sourceId) ||
    !(s.externalId === null || typeof s.externalId === 'string' || typeof s.externalId === 'number')
  )
    error(c, 'source-ref', fp);
  else keys(c, s, ['sourceId', 'externalId'], fp);
}
interface LayerScope {
  sourceIds: Set<string>;
  layerIds: Set<string>;
  featureIds: Set<string>;
  rowIds: Set<string>;
}
function feature(c: Check, f: unknown, fields: Map<string, string>, scope: LayerScope, fp: string) {
  c.features++;
  if (
    !record(f) ||
    !id(f.id) ||
    scope.featureIds.has(f.id) ||
    !id(f.rowId) ||
    scope.rowIds.has(f.rowId) ||
    !record(f.values)
  ) {
    error(c, 'feature-or-duplicate-id', fp);
    return;
  }
  scope.featureIds.add(f.id);
  scope.rowIds.add(f.rowId);
  keys(c, f, ['id', 'rowId', 'geometry', 'values', 'sourceRef'], fp);
  if (!scalarsMatch(f.values as Record<string, unknown>, fields)) error(c, 'scalar-schema', fp);
  if (f.sourceRef !== undefined) sourceRef(c, f.sourceRef, scope.sourceIds, fp);
  geometry(c, f.geometry, fp);
}
function layer(c: Check, l: unknown, scope: LayerScope, p: string) {
  if (
    !record(l) ||
    !id(l.id) ||
    scope.layerIds.has(l.id) ||
    typeof l.name !== 'string' ||
    !Array.isArray(l.fields) ||
    !Array.isArray(l.features)
  ) {
    error(c, 'layer', p);
    return;
  }
  scope.layerIds.add(l.id);
  keys(c, l, ['id', 'name', 'crs', 'axis', 'fields', 'features'], p);
  if (l.crs !== 'OGC:CRS84' || l.axis !== 'longitude-latitude') error(c, 'crs-axis', p);
  const fields = layerFields(c, l.fields, p);
  for (const [j, f] of (l.features as unknown[]).entries())
    feature(c, f, fields, scope, `${p}.features[${j}]`);
}
export function validateGeo(value: unknown, limits: Budgets): Diagnostic[] {
  const c: Check = { d: [], vertices: 0, features: 0 };
  try {
    checkedJson(value, limits);
  } catch (cause) {
    error(c, cause instanceof Error ? cause.message : 'unsafe-json-or-depth', '$');
    return c.d;
  }
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.layers) ||
    !Array.isArray(value.sources)
  ) {
    error(c, 'schema', '$');
    return c.d;
  }
  keys(c, value, ['schemaVersion', 'layers', 'sources', 'workspace'], '$');
  const scope: LayerScope = {
    sourceIds: validateSources(c, value.sources),
    layerIds: new Set(),
    featureIds: new Set(),
    rowIds: new Set(),
  };
  if (value.layers.length > limits.layers) error(c, 'layer-limit', 'layers');
  for (const [i, l] of value.layers.entries()) layer(c, l, scope, `layers[${i}]`);
  if (c.features > limits.features) error(c, 'feature-limit', '$');
  if (c.vertices > limits.vertices) error(c, 'vertex-limit', '$');
  if (value.workspace !== undefined && !c.d.some((item) => item.severity === 'error')) {
    try {
      assertGeoWorkspace(value.workspace, value as unknown as GeoDocument, limits);
    } catch (cause) {
      error(c, cause instanceof Error ? cause.message : 'workspace', 'workspace');
    }
  }
  return c.d;
}
export function assertGeo(value: unknown, limits: Budgets): asserts value is GeoDocument {
  const errors = validateGeo(value, limits).filter((d) => d.severity === 'error');
  if (errors.length) throw new Error(JSON.stringify(errors));
}
export function serializeGeo(value: GeoDocument, limits: Budgets): string {
  assertGeo(value, limits);
  return checkedJson(value, limits);
}
export function parseGeo(text: string, limits: Budgets): GeoDocument {
  if (text.length > limits.bytes || new TextEncoder().encode(text).length > limits.bytes)
    throw new Error('byte-limit');
  const value: unknown = JSON.parse(text);
  assertGeo(value, limits);
  return value;
}
