import { checkedJson } from './json-boundary';
import { prepareImport, type ImportCandidate, type ImportPlan } from './import';
import { id, record, validateGeo } from './validation';
import type {
  Budgets,
  Diagnostic,
  Feature,
  Field,
  Geometry,
  Pin,
  Scalar,
  SourceSnapshot,
} from './model';
import type { Revision } from './commands';
import { parseCsv, parseGeoJson } from './import-parser';
import { exactKeys, validRevision } from './schema';

export interface ImportLimits {
  native: Budgets;
  sourceBytes: number;
  rows: number;
  columns: number;
  pendingPlans: number;
}
export interface ImportField extends Field {
  input: string;
}
export interface ImportRequest {
  planId: string;
  revision: Revision;
  format: 'csv' | 'geojson';
  crs: 'OGC:CRS84';
  layerId: string;
  layerName: string;
  source: { id: string; resourceId: string; pin: Pin; attribution: string };
  fields: ImportField[];
  csv?: {
    idColumn: string | null;
    firstCoordinate: string;
    secondCoordinate: string;
    axis: 'longitude-latitude' | 'latitude-longitude';
    missingCoordinates: 'reject' | 'preserve-null' | 'attribute-table';
  };
}
export interface IdAssignment {
  inputRow: number;
  externalId: string | number | null;
  featureId: string;
  rowId: string;
}
export interface AdaptedImport {
  plan: ImportPlan;
  assignments: IdAssignment[];
  request: ImportRequest;
}
const diagnostic = (
  code: string,
  path: string,
  severity: Diagnostic['severity'] = 'error',
): Diagnostic => ({ code, path, severity });
const requestKeys = [
  'planId',
  'revision',
  'format',
  'crs',
  'layerId',
  'layerName',
  'source',
  'fields',
];
const reservedFieldIds = ['__proto__', 'constructor', 'prototype', 'toJSON'];
const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const numeric = (v: unknown): v is string =>
  typeof v === 'string' && decimal.test(v) && Number.isFinite(Number(v));
/** Callers reject non-record, `crs` and `format` first, so this does not re-check them. */
const validRequestShape = (value: Record<string, unknown>, limits: ImportLimits) =>
  exactKeys(value, value.format === 'csv' ? [...requestKeys, 'csv'] : requestKeys) &&
  id(value.planId) &&
  value.planId.length <= 80 &&
  id(value.layerId) &&
  typeof value.layerName === 'string' &&
  validRevision(value.revision) &&
  record(value.source) &&
  exactKeys(value.source, ['id', 'resourceId', 'pin', 'attribution']) &&
  Array.isArray(value.fields) &&
  value.fields.length <= limits.columns;
function assertImportFields(fields: unknown[]) {
  const seen = new Set<string>(),
    inputs = new Set<string>();
  for (const field of fields) {
    if (
      !record(field) ||
      !exactKeys(field, ['id', 'name', 'type', 'input']) ||
      !id(field.id) ||
      reservedFieldIds.includes(field.id) ||
      seen.has(field.id) ||
      typeof field.name !== 'string' ||
      typeof field.input !== 'string' ||
      !field.input ||
      inputs.has(field.input) ||
      typeof field.type !== 'string' ||
      !['string', 'number', 'boolean'].includes(field.type)
    )
      throw new Error('import-field');
    seen.add(field.id);
    inputs.add(field.input);
  }
}
function validCsvMapping(csv: unknown) {
  if (
    !record(csv) ||
    !exactKeys(csv, [
      'idColumn',
      'firstCoordinate',
      'secondCoordinate',
      'axis',
      'missingCoordinates',
    ])
  )
    return false;
  const { idColumn, firstCoordinate: first, secondCoordinate: second } = csv;
  // Attribute-table mode has no coordinate columns, so they may be empty or equal.
  const coordinates =
    csv.missingCoordinates === 'attribute-table' || (!!first && !!second && first !== second);
  return (
    (idColumn === null || (typeof idColumn === 'string' && idColumn.length > 0)) &&
    typeof first === 'string' &&
    typeof second === 'string' &&
    coordinates &&
    ['longitude-latitude', 'latitude-longitude'].includes(csv.axis as string) &&
    ['reject', 'preserve-null', 'attribute-table'].includes(csv.missingCoordinates as string)
  );
}
const snapshot = (
  request: Pick<ImportRequest, 'source' | 'format'>,
  bytesHash: string,
): SourceSnapshot => ({
  ...request.source,
  bytesHash,
  format: request.format,
  adapterVersion: 'geo-import-m0-v1',
  declaredCrs: 'OGC:CRS84',
  axis: 'longitude-latitude',
});
export function validateRequest(
  value: unknown,
  limits: ImportLimits,
): asserts value is ImportRequest {
  checkedJson(value, limits.native);
  if (!record(value)) throw new Error('import-request');
  if (value.crs !== 'OGC:CRS84') throw new Error('crs-unsupported');
  if (value.format !== 'csv' && value.format !== 'geojson') throw new Error('format-unsupported');
  if (!validRequestShape(value, limits)) throw new Error('import-request');
  assertImportFields(value.fields as unknown[]);
  if (value.format === 'csv' && !validCsvMapping(value.csv)) throw new Error('csv-mapping');
  const source = snapshot(value as unknown as ImportRequest, `sha256:${'0'.repeat(64)}`);
  const errors = validateGeo(
    { schemaVersion: 1, layers: [], sources: [source] },
    limits.native,
  ).filter((d) => d.severity === 'error');
  if (errors.length) throw new Error('source-pin');
}

/** One parsed input row before scalar coercion and native validation. */
interface ImportRow {
  inputRow: number;
  externalId: string | number | null;
  geometry: unknown;
  properties: Record<string, unknown>;
  diagnostics: Diagnostic[];
}
type ParserLimits = { rows: number; columns: number; depth: number; vertices: number };
function coerceScalar(
  field: ImportField,
  raw: unknown,
  format: ImportRequest['format'],
  path: string,
  diagnostics: Diagnostic[],
): Scalar {
  if (raw === null || (format === 'csv' && raw === '' && field.type !== 'string')) return null;
  if (format === 'csv') {
    if (field.type === 'string') return raw as string;
    if (field.type === 'number' && numeric(raw)) return Number(raw);
    if (field.type === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true';
    diagnostics.push(diagnostic('attribute-type', path));
    return null;
  }
  if (typeof raw === field.type && (typeof raw !== 'number' || Number.isFinite(raw)))
    return raw as Scalar;
  diagnostics.push(
    diagnostic(typeof raw === 'object' ? 'nested-property' : 'attribute-type', path),
  );
  return null;
}
/** Explicit table mode has no coordinate columns; all rows remain selectable. */
function csvPoint(
  csv: NonNullable<ImportRequest['csv']>,
  first: unknown,
  second: unknown,
  path: string,
  diagnostics: Diagnostic[],
): Geometry | null {
  if (first === '' && second === '' && csv.missingCoordinates === 'preserve-null') {
    diagnostics.push(diagnostic('null-geometry', path, 'warning'));
    return null;
  }
  if (!numeric(first) || !numeric(second)) {
    diagnostics.push(diagnostic('coordinate-number', path));
    return null;
  }
  return {
    type: 'Point',
    coordinates:
      csv.axis === 'longitude-latitude'
        ? [Number(first), Number(second)]
        : [Number(second), Number(first)],
  };
}
function* csvRows(
  text: string,
  request: ImportRequest,
  limits: ImportLimits,
  parserLimits: ParserLimits,
): Generator<ImportRow> {
  const records = parseCsv(text, parserLimits);
  const firstRecord = records.next();
  if (firstRecord.done) throw new Error('csv-header');
  const header = firstRecord.value,
    csv = request.csv!;
  if (header.some((h) => !h) || new Set(header).size !== header.length)
    throw new Error('csv-header');
  const tableOnly = csv.missingCoordinates === 'attribute-table';
  const mapped = new Set([
    ...request.fields.map((f) => f.input),
    ...(tableOnly ? [] : [csv.firstCoordinate, csv.secondCoordinate]),
    ...(csv.idColumn ? [csv.idColumn] : []),
  ]);
  if ([...mapped].some((h) => !header.includes(h)) || header.some((h) => !mapped.has(h)))
    throw new Error('csv-column-mapping');
  let i = 0,
    pointCount = 0;
  for (const row of records) {
    i++;
    const diagnostics: Diagnostic[] = [];
    if (row.length !== header.length) diagnostics.push(diagnostic('csv-column-count', `row:${i}`));
    const properties: Record<string, unknown> = {};
    header.forEach((key, j) =>
      Object.defineProperty(properties, key, { value: row[j] ?? null, enumerable: true }),
    );
    const first = properties[csv.firstCoordinate],
      second = properties[csv.secondCoordinate];
    const geometry = tableOnly ? null : csvPoint(csv, first, second, `row:${i}`, diagnostics);
    if (geometry && ++pointCount > limits.native.vertices) throw new Error('vertex-limit');
    const external = csv.idColumn ? properties[csv.idColumn] : null;
    yield {
      inputRow: i,
      externalId: typeof external === 'string' && external !== '' ? external : null,
      geometry,
      properties,
      diagnostics,
    };
  }
}
function geoJsonRow(raw: unknown, inputRow: number, request: ImportRequest): ImportRow {
  const row: ImportRow = {
    inputRow,
    externalId: null,
    geometry: null,
    properties: {},
    diagnostics: [],
  };
  const report = (code: string) => row.diagnostics.push(diagnostic(code, `row:${inputRow}`));
  if (
    !record(raw) ||
    raw.type !== 'Feature' ||
    !Object.hasOwn(raw, 'geometry') ||
    !Object.hasOwn(raw, 'properties')
  ) {
    report('geojson-feature');
    return row;
  }
  row.geometry = raw.geometry;
  if (Object.keys(raw).some((k) => !['type', 'id', 'geometry', 'properties'].includes(k)))
    report('geojson-foreign-member');
  if (raw.id !== undefined && raw.id !== null) {
    if (typeof raw.id === 'string' || (typeof raw.id === 'number' && Number.isFinite(raw.id)))
      row.externalId = raw.id;
    else report('external-id-type');
  }
  if (raw.properties !== null && !record(raw.properties)) report('geojson-properties');
  else row.properties = (raw.properties ?? {}) as Record<string, unknown>;
  if (Object.keys(row.properties).some((k) => !request.fields.some((f) => f.input === k)))
    report('unmapped-property');
  return row;
}
function* geoJsonRows(
  text: string,
  request: ImportRequest,
  parserLimits: ParserLimits,
): Generator<ImportRow> {
  const data = parseGeoJson(text, parserLimits);
  if (!record(data) || data.type !== 'FeatureCollection' || !Array.isArray(data.features))
    throw new Error('geojson-collection');
  if (Object.hasOwn(data, 'crs')) throw new Error('geojson-legacy-crs');
  if (!exactKeys(data, ['type', 'features'])) throw new Error('geojson-foreign-member');
  for (let i = 0; i < data.features.length; i++) yield geoJsonRow(data.features[i], i + 1, request);
}

export function adaptImport(
  text: string,
  request: ImportRequest,
  bytesHash: string,
  limits: ImportLimits,
): AdaptedImport {
  const source = snapshot(request, bytesHash);
  const metadata = {
    id: request.layerId,
    name: request.layerName,
    crs: 'OGC:CRS84' as const,
    axis: 'longitude-latitude' as const,
    fields: request.fields.map(({ input: _input, ...f }) => f),
  };
  const candidates: ImportCandidate[] = [];
  const assignments: IdAssignment[] = [];
  const externalRows = new Map<string, number[]>();
  const parserLimits = {
    rows: Math.min(limits.rows, limits.native.features),
    columns: limits.columns,
    depth: limits.native.depth,
    vertices: limits.native.vertices,
  };
  function add({ inputRow, externalId, geometry, properties, diagnostics }: ImportRow) {
    const values: Record<string, Scalar> = {};
    for (const f of request.fields) {
      const raw = Object.hasOwn(properties, f.input) ? properties[f.input] : null;
      const path = `row:${inputRow}.${f.input}`;
      Object.defineProperty(values, f.id, {
        value: coerceScalar(f, raw, request.format, path, diagnostics),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    const feature: Feature = {
      id: `${request.planId}:f:${inputRow}`,
      rowId: `${request.planId}:r:${inputRow}`,
      geometry: geometry as Geometry | null,
      values,
      sourceRef: { sourceId: source.id, externalId },
    };
    const validation = validateGeo(
      { schemaVersion: 1, layers: [{ ...metadata, features: [feature] }], sources: [source] },
      limits.native,
    );
    diagnostics.push(...validation.map((d) => ({ ...d, path: `row:${inputRow}.${d.path}` })));
    // Invalid geometry never becomes an accepted null geometry. This excluded candidate
    // holds a placeholder; the rejected original structure remains in retained source bytes.
    if (validation.some((d) => d.severity === 'error')) feature.geometry = null;
    if (externalId === null)
      diagnostics.push(diagnostic('missing-external-id', `row:${inputRow}`, 'warning'));
    else {
      const key = `${typeof externalId}:${externalId}`;
      const rows = externalRows.get(key) ?? [];
      rows.push(candidates.length);
      externalRows.set(key, rows);
    }
    assignments.push({ inputRow, externalId, featureId: feature.id, rowId: feature.rowId });
    candidates.push({ inputRow, feature, diagnostics });
  }
  const rows =
    request.format === 'csv'
      ? csvRows(text, request, limits, parserLimits)
      : geoJsonRows(text, request, parserLimits);
  for (const row of rows) add(row);
  for (const indexes of externalRows.values())
    if (indexes.length > 1)
      for (const index of indexes)
        candidates[index].diagnostics.push(
          diagnostic('duplicate-external-id', `row:${candidates[index].inputRow}`, 'warning'),
        );
  return { plan: prepareImport(metadata, source, candidates, limits.native), assignments, request };
}
