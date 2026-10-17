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
    missingCoordinates: 'reject' | 'preserve-null';
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
const exactKeys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k));
export function validateRequest(
  value: unknown,
  limits: ImportLimits,
): asserts value is ImportRequest {
  checkedJson(value, limits.native);
  if (record(value) && value.crs !== 'OGC:CRS84') throw new Error('crs-unsupported');
  if (record(value) && value.format !== 'csv' && value.format !== 'geojson')
    throw new Error('format-unsupported');
  if (
    !record(value) ||
    !exactKeys(
      value,
      value.format === 'csv'
        ? ['planId', 'revision', 'format', 'crs', 'layerId', 'layerName', 'source', 'fields', 'csv']
        : ['planId', 'revision', 'format', 'crs', 'layerId', 'layerName', 'source', 'fields'],
    ) ||
    !id(value.planId) ||
    value.planId.length > 80 ||
    !id(value.layerId) ||
    typeof value.layerName !== 'string' ||
    !['csv', 'geojson'].includes(value.format as string) ||
    value.crs !== 'OGC:CRS84' ||
    !record(value.revision) ||
    (!exactKeys(value.revision, ['sessionId', 'sequence']) &&
      !(
        exactKeys(value.revision, ['kind', 'sessionId', 'sequence']) &&
        value.revision.kind === 'local-draft'
      )) ||
    !id(value.revision.sessionId) ||
    !Number.isSafeInteger(value.revision.sequence) ||
    (value.revision.sequence as number) < 0 ||
    !record(value.source) ||
    !exactKeys(value.source, ['id', 'resourceId', 'pin', 'attribution']) ||
    !Array.isArray(value.fields) ||
    value.fields.length > limits.columns
  )
    throw new Error('import-request');
  const seen = new Set<string>(),
    inputs = new Set<string>();
  for (const field of value.fields) {
    if (
      !record(field) ||
      !exactKeys(field, ['id', 'name', 'type', 'input']) ||
      !id(field.id) ||
      ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(field.id) ||
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
  if (value.format === 'csv') {
    const csv = value.csv;
    if (
      !record(csv) ||
      !exactKeys(csv, [
        'idColumn',
        'firstCoordinate',
        'secondCoordinate',
        'axis',
        'missingCoordinates',
      ]) ||
      !(csv.idColumn === null || (typeof csv.idColumn === 'string' && csv.idColumn.length > 0)) ||
      typeof csv.firstCoordinate !== 'string' ||
      !csv.firstCoordinate ||
      typeof csv.secondCoordinate !== 'string' ||
      !csv.secondCoordinate ||
      csv.firstCoordinate === csv.secondCoordinate ||
      !['longitude-latitude', 'latitude-longitude'].includes(csv.axis as string) ||
      !['reject', 'preserve-null'].includes(csv.missingCoordinates as string)
    )
      throw new Error('csv-mapping');
  }
  const source = {
    ...value.source,
    bytesHash: `sha256:${'0'.repeat(64)}`,
    format: value.format,
    adapterVersion: 'geo-import-m0-v1',
    declaredCrs: value.crs,
    axis: 'longitude-latitude',
  };
  const errors = validateGeo(
    { schemaVersion: 1, layers: [], sources: [source] },
    limits.native,
  ).filter((d) => d.severity === 'error');
  if (errors.length) throw new Error('source-pin');
}

export function adaptImport(
  text: string,
  request: ImportRequest,
  bytesHash: string,
  limits: ImportLimits,
): AdaptedImport {
  const source: SourceSnapshot = {
    ...request.source,
    bytesHash,
    format: request.format,
    adapterVersion: 'geo-import-m0-v1',
    declaredCrs: 'OGC:CRS84',
    axis: 'longitude-latitude',
  };
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
  function add(
    inputRow: number,
    externalId: string | number | null,
    geometry: unknown,
    properties: Record<string, unknown>,
    diagnostics: Diagnostic[],
  ) {
    const values: Record<string, Scalar> = {};
    for (const f of request.fields) {
      const raw = Object.hasOwn(properties, f.input) ? properties[f.input] : null;
      let value: Scalar = null;
      if (raw === null || (request.format === 'csv' && raw === '' && f.type !== 'string'))
        value = null;
      else if (request.format === 'csv') {
        if (f.type === 'string') value = raw as string;
        else if (
          f.type === 'number' &&
          typeof raw === 'string' &&
          /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) &&
          Number.isFinite(Number(raw))
        )
          value = Number(raw);
        else if (f.type === 'boolean' && (raw === 'true' || raw === 'false'))
          value = raw === 'true';
        else diagnostics.push(diagnostic('attribute-type', `row:${inputRow}.${f.input}`));
      } else if (typeof raw === f.type && (typeof raw !== 'number' || Number.isFinite(raw)))
        value = raw as Scalar;
      else
        diagnostics.push(
          diagnostic(
            typeof raw === 'object' ? 'nested-property' : 'attribute-type',
            `row:${inputRow}.${f.input}`,
          ),
        );
      Object.defineProperty(values, f.id, {
        value,
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
  if (request.format === 'csv') {
    const records = parseCsv(text, parserLimits);
    const firstRecord = records.next();
    if (firstRecord.done) throw new Error('csv-header');
    const header = firstRecord.value,
      csv = request.csv!;
    if (header.some((h) => !h) || new Set(header).size !== header.length)
      throw new Error('csv-header');
    const mapped = new Set([
      ...request.fields.map((f) => f.input),
      csv.firstCoordinate,
      csv.secondCoordinate,
      ...(csv.idColumn ? [csv.idColumn] : []),
    ]);
    if ([...mapped].some((h) => !header.includes(h)) || header.some((h) => !mapped.has(h)))
      throw new Error('csv-column-mapping');
    let i = 0,
      pointCount = 0;
    for (const row of records) {
      i++;
      const diagnostics: Diagnostic[] = [];
      if (row.length !== header.length)
        diagnostics.push(diagnostic('csv-column-count', `row:${i}`));
      const properties: Record<string, unknown> = {};
      header.forEach((key, j) =>
        Object.defineProperty(properties, key, { value: row[j] ?? null, enumerable: true }),
      );
      const first = properties[csv.firstCoordinate],
        second = properties[csv.secondCoordinate];
      let geometry: Geometry | null = null;
      if (first === '' && second === '' && csv.missingCoordinates === 'preserve-null') {
        diagnostics.push(diagnostic('null-geometry', `row:${i}`, 'warning'));
      } else {
        const numeric = (v: unknown): v is string =>
          typeof v === 'string' &&
          /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v) &&
          Number.isFinite(Number(v));
        if (!numeric(first) || !numeric(second))
          diagnostics.push(diagnostic('coordinate-number', `row:${i}`));
        else
          geometry = {
            type: 'Point',
            coordinates:
              csv.axis === 'longitude-latitude'
                ? [Number(first), Number(second)]
                : [Number(second), Number(first)],
          };
      }
      if (geometry && ++pointCount > limits.native.vertices) throw new Error('vertex-limit');
      const external = csv.idColumn ? properties[csv.idColumn] : null;
      add(
        i,
        typeof external === 'string' && external !== '' ? external : null,
        geometry,
        properties,
        diagnostics,
      );
    }
  } else {
    const data = parseGeoJson(text, parserLimits);
    if (!record(data) || data.type !== 'FeatureCollection' || !Array.isArray(data.features))
      throw new Error('geojson-collection');
    if (Object.hasOwn(data, 'crs')) throw new Error('geojson-legacy-crs');
    if (!exactKeys(data, ['type', 'features'])) throw new Error('geojson-foreign-member');
    for (let i = 0; i < data.features.length; i++) {
      const raw = data.features[i],
        diagnostics: Diagnostic[] = [];
      let geometry: unknown = null,
        externalId: string | number | null = null,
        properties: Record<string, unknown> = {};
      if (
        !record(raw) ||
        raw.type !== 'Feature' ||
        !Object.hasOwn(raw, 'geometry') ||
        !Object.hasOwn(raw, 'properties')
      )
        diagnostics.push(diagnostic('geojson-feature', `row:${i + 1}`));
      else {
        geometry = raw.geometry;
        if (Object.keys(raw).some((k) => !['type', 'id', 'geometry', 'properties'].includes(k)))
          diagnostics.push(diagnostic('geojson-foreign-member', `row:${i + 1}`));
        if (raw.id !== undefined && raw.id !== null) {
          if (typeof raw.id === 'string' || (typeof raw.id === 'number' && Number.isFinite(raw.id)))
            externalId = raw.id;
          else diagnostics.push(diagnostic('external-id-type', `row:${i + 1}`));
        }
        if (raw.properties !== null && !record(raw.properties))
          diagnostics.push(diagnostic('geojson-properties', `row:${i + 1}`));
        else properties = (raw.properties ?? {}) as Record<string, unknown>;
        if (Object.keys(properties).some((k) => !request.fields.some((f) => f.input === k)))
          diagnostics.push(diagnostic('unmapped-property', `row:${i + 1}`));
      }
      add(i + 1, externalId, geometry, properties, diagnostics);
    }
  }
  for (const rows of externalRows.values())
    if (rows.length > 1)
      for (const index of rows)
        candidates[index].diagnostics.push(
          diagnostic('duplicate-external-id', `row:${candidates[index].inputRow}`, 'warning'),
        );
  return { plan: prepareImport(metadata, source, candidates, limits.native), assignments, request };
}
