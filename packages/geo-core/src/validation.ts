import { checkedJson } from './json-boundary';
import type { Budgets, Diagnostic, GeoDocument } from './model';
export const record = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
export const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
export const hash = (v: unknown): boolean =>
  typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export function validateGeo(value: unknown, limits: Budgets): Diagnostic[] {
  const d: Diagnostic[] = [];
  const error = (code: string, path: string) => {
    d.push({ code, path, severity: 'error' });
  };
  try {
    checkedJson(value, limits);
  } catch (cause) {
    error(cause instanceof Error ? cause.message : 'unsafe-json-or-depth', '$');
    return d;
  }
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.layers) ||
    !Array.isArray(value.sources)
  ) {
    error('schema', '$');
    return d;
  }
  const keys = (v: Record<string, unknown>, allowed: string[], path: string) => {
    if (Object.keys(v).some((k) => !allowed.includes(k))) error('unknown-field', path);
  };
  keys(value, ['schemaVersion', 'layers', 'sources'], '$');
  const sourceIds = new Set<string>();
  for (const [i, s] of value.sources.entries()) {
    const p = `sources[${i}]`;
    if (
      !record(s) ||
      !id(s.id) ||
      sourceIds.has(s.id) ||
      !id(s.resourceId) ||
      !hash(s.bytesHash) ||
      !record(s.pin) ||
      !id(s.pin.artifactId) ||
      !id(s.pin.versionId) ||
      !hash(s.pin.contentHash) ||
      typeof s.format !== 'string' ||
      !['geojson', 'csv'].includes(s.format) ||
      typeof s.adapterVersion !== 'string' ||
      s.declaredCrs !== 'OGC:CRS84' ||
      s.axis !== 'longitude-latitude' ||
      typeof s.attribution !== 'string'
    )
      error('source-pin', p);
    else {
      keys(
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
      keys(s.pin as Record<string, unknown>, ['artifactId', 'versionId', 'contentHash'], p);
      sourceIds.add(s.id);
    }
  }
  let vertices = 0,
    features = 0;
  function position(v: unknown, p: string): boolean {
    vertices++;
    if (
      !Array.isArray(v) ||
      v.length !== 2 ||
      !Object.hasOwn(v, 0) ||
      !Object.hasOwn(v, 1) ||
      !Number.isFinite(v[0]) ||
      !Number.isFinite(v[1])
    ) {
      error('position-or-dimension', p);
      return false;
    }
    if (Math.abs(v[0]) > 180 || Math.abs(v[1]) > 90) {
      error('coordinate-range', p);
      return false;
    }
    return true;
  }
  function line(v: unknown, p: string, ring = false) {
    if (!Array.isArray(v) || v.length < (ring ? 4 : 2)) {
      error('vertices', p);
      return;
    }
    v.forEach((x, i) => position(x, `${p}[${i}]`));
    if (ring && JSON.stringify(v[0]) !== JSON.stringify(v.at(-1))) error('ring-not-closed', p);
    if (ring) d.push({ code: 'topology-not-checked', path: p, severity: 'warning' });
  }
  function polygon(v: unknown, p: string) {
    if (!Array.isArray(v) || !v.length) {
      error('rings', p);
      return;
    }
    v.forEach((r, i) => line(r, `${p}[${i}]`, true));
  }
  function geometry(v: unknown, p: string) {
    if (v === null) return;
    if (!record(v)) {
      error('geometry', p);
      return;
    }
    keys(v, ['type', 'coordinates'], p);
    const c = v.coordinates;
    switch (v.type) {
      case 'Point':
        position(c, p);
        break;
      case 'LineString':
        line(c, p);
        break;
      case 'Polygon':
        polygon(c, p);
        break;
      case 'MultiPoint':
      case 'MultiLineString':
      case 'MultiPolygon':
        if (!Array.isArray(c) || !c.length) {
          error('multi', p);
          break;
        }
        c.forEach((x, i) =>
          v.type === 'MultiPoint'
            ? position(x, `${p}[${i}]`)
            : v.type === 'MultiLineString'
              ? line(x, `${p}[${i}]`)
              : polygon(x, `${p}[${i}]`),
        );
        break;
      default:
        error('unsupported-geometry', p);
    }
  }
  const layerIds = new Set<string>(),
    featureIds = new Set<string>(),
    rowIds = new Set<string>();
  if (value.layers.length > limits.layers) error('layer-limit', 'layers');
  for (const [i, l] of value.layers.entries()) {
    const p = `layers[${i}]`;
    if (
      !record(l) ||
      !id(l.id) ||
      layerIds.has(l.id) ||
      typeof l.name !== 'string' ||
      !Array.isArray(l.fields) ||
      !Array.isArray(l.features)
    ) {
      error('layer', p);
      continue;
    }
    layerIds.add(l.id);
    keys(l, ['id', 'name', 'crs', 'axis', 'fields', 'features'], p);
    if (l.crs !== 'OGC:CRS84' || l.axis !== 'longitude-latitude') error('crs-axis', p);
    const fields = new Map<string, string>();
    for (const f of l.fields) {
      if (
        !record(f) ||
        !id(f.id) ||
        fields.has(f.id) ||
        typeof f.name !== 'string' ||
        typeof f.type !== 'string' ||
        !['string', 'number', 'boolean'].includes(f.type)
      )
        error('field', p);
      else {
        fields.set(f.id, f.type as string);
        keys(f, ['id', 'name', 'type'], p);
      }
    }
    for (const [j, f] of l.features.entries()) {
      features++;
      const fp = `${p}.features[${j}]`;
      if (
        !record(f) ||
        !id(f.id) ||
        featureIds.has(f.id) ||
        !id(f.rowId) ||
        rowIds.has(f.rowId) ||
        !record(f.values)
      ) {
        error('feature-or-duplicate-id', fp);
        continue;
      }
      featureIds.add(f.id);
      rowIds.add(f.rowId);
      keys(f, ['id', 'rowId', 'geometry', 'values', 'sourceRef'], fp);
      if (
        Object.keys(f.values).length !== fields.size ||
        [...fields].some(
          ([k, t]) =>
            !Object.hasOwn(f.values as object, k) ||
            ((f.values as Record<string, unknown>)[k] !== null &&
              typeof (f.values as Record<string, unknown>)[k] !== t),
        )
      )
        error('scalar-schema', fp);
      if (f.sourceRef !== undefined) {
        const s = f.sourceRef;
        if (
          !record(s) ||
          !Object.hasOwn(s, 'sourceId') ||
          !id(s.sourceId) ||
          !sourceIds.has(s.sourceId) ||
          !(
            s.externalId === null ||
            typeof s.externalId === 'string' ||
            typeof s.externalId === 'number'
          )
        )
          error('source-ref', fp);
        else keys(s, ['sourceId', 'externalId'], fp);
      }
      geometry(f.geometry, fp);
    }
  }
  if (features > limits.features) error('feature-limit', '$');
  if (vertices > limits.vertices) error('vertex-limit', '$');
  return d;
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
