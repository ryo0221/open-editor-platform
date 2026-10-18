import { geoFields, geoValue } from './workspace-analysis';
import type { Budgets, Field, GeoDocument, Pin } from './model';
import type { DeepReadonly } from './key-join';
import { checkedJson } from './json-boundary';
import { assertGeo, hash, id, record, validateGeo } from './validation';

/** Experimental data exchange, separate from native persistence and PNG receipts. */
export interface GeoDataExportLimits {
  native: Budgets;
  /** Combined UTF-8 bytes of data and receipt. Not a throughput guarantee. */
  outputBytes: number;
}
export interface GeoExportCapture {
  content: GeoDocument;
  /** Host-verified immutable native version, not an unsaved draft or a source pin. */
  pin: Pin;
}
export interface GeoDataExportSelection {
  layerId: string;
  fieldIds: string[];
  format: 'geojson' | 'csv';
}
export interface GeoExportFile {
  name: string;
  mediaType: string;
  text: string;
}
export type GeoExportWarning =
  | 'native-document-not-preserved'
  | 'attributes-omitted'
  | 'geometry-omitted'
  | 'csv-json-scalars'
  | 'source-metadata-in-receipt'
  | 'topology-not-checked';
interface Prepared {
  capture: GeoExportCapture;
  selection: GeoDataExportSelection;
  fields: Field[];
  omittedFieldIds: string[];
  featureCount: number;
  nullGeometryCount: number;
  warnings: GeoExportWarning[];
  data: GeoExportFile;
}
export type PreparedGeoDataExport = DeepReadonly<Prepared>;
export interface GeoDataExportBundle {
  data: GeoExportFile;
  receipt: GeoExportFile;
}
const issued = new WeakMap<object, GeoDataExportLimits>();
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
const utf8 = (text: string) => new TextEncoder().encode(text);
const csvCell = (text: string) => `"${text.replaceAll('"', '""')}"`;

/** No IO, network, mutation, implicit field selection, or source-property merge. */
export function prepareGeoDataExport(
  capture: GeoExportCapture,
  selection: GeoDataExportSelection,
  limits: GeoDataExportLimits,
): PreparedGeoDataExport {
  if (!Number.isSafeInteger(limits.outputBytes) || limits.outputBytes <= 0)
    throw new Error('export-limits');
  checkedJson({ capture, selection }, limits.native);
  if (
    !record(capture) ||
    Object.keys(capture).length !== 2 ||
    !record(capture.pin) ||
    Object.keys(capture.pin).length !== 3 ||
    !id(capture.pin.artifactId) ||
    !id(capture.pin.versionId) ||
    !hash(capture.pin.contentHash)
  )
    throw new Error('export-pin');
  assertGeo(capture.content, limits.native);
  if (
    !record(selection) ||
    Object.keys(selection).length !== 3 ||
    !id(selection.layerId) ||
    !['geojson', 'csv'].includes(selection.format) ||
    !Array.isArray(selection.fieldIds) ||
    selection.fieldIds.some((f) => !id(f)) ||
    new Set(selection.fieldIds).size !== selection.fieldIds.length
  )
    throw new Error('export-selection');
  const owned = structuredClone(capture),
    chosen = structuredClone(selection),
    layer = owned.content.layers.find((l) => l.id === chosen.layerId);
  if (!layer) throw new Error('export-layer');
  const fields = chosen.fieldIds.map((fieldId) => {
    const field = geoFields(owned.content, layer).find((f) => f.id === fieldId);
    if (!field) throw new Error('export-field');
    return field;
  });
  const omittedFieldIds = geoFields(owned.content, layer)
    .filter((f) => !chosen.fieldIds.includes(f.id))
    .map((f) => f.id);
  const warnings: GeoExportWarning[] = ['native-document-not-preserved'];
  if (omittedFieldIds.length) warnings.push('attributes-omitted');
  if (chosen.format === 'csv') warnings.push('geometry-omitted', 'csv-json-scalars');
  if (layer.features.some((f) => f.sourceRef)) warnings.push('source-metadata-in-receipt');
  if (
    validateGeo(
      { schemaVersion: 1, sources: owned.content.sources, layers: [layer] },
      limits.native,
    ).some((d) => d.code === 'topology-not-checked')
  )
    warnings.push('topology-not-checked');
  let text: string;
  if (chosen.format === 'geojson') {
    text = checkedJson(
      {
        type: 'FeatureCollection',
        features: layer.features.map((f) => ({
          type: 'Feature',
          id: f.id,
          geometry: f.geometry,
          // Stable field IDs avoid collisions from duplicate/renamed display names.
          properties: Object.fromEntries(
            fields.map((field) => [field.id, geoValue(owned.content, layer.id, f, field.id)]),
          ),
        })),
      },
      { ...limits.native, bytes: limits.outputBytes },
    );
  } else {
    // CSV alone cannot distinguish null/empty/string/number. JSON-scalar cells
    // preserve those values and keep formula-like strings as quoted JSON strings.
    const lines = [
      ['_feature_id', '_row_id', ...fields.map((f) => f.id)].map(csvCell).join(',') + '\r\n',
    ];
    let bytes = utf8(lines[0]).length;
    for (const feature of layer.features) {
      const line =
        [
          feature.id,
          feature.rowId,
          ...fields.map((f) => geoValue(owned.content, layer.id, feature, f.id)),
        ]
          .map((value) => csvCell(JSON.stringify(value)))
          .join(',') + '\r\n';
      bytes += utf8(line).length;
      if (bytes > limits.outputBytes) throw new Error('export-byte-limit');
      lines.push(line);
    }
    text = lines.join('');
  }
  if (utf8(text).length > limits.outputBytes) throw new Error('export-byte-limit');
  const preview = freeze({
    capture: owned,
    selection: chosen,
    fields,
    omittedFieldIds,
    featureCount: layer.features.length,
    nullGeometryCount: layer.features.filter((f) => f.geometry === null).length,
    warnings,
    data: {
      name: `geographic-data.${chosen.format === 'geojson' ? 'geojson' : 'csv'}`,
      mediaType: chosen.format === 'geojson' ? 'application/geo+json' : 'text/csv;charset=utf-8',
      text,
    },
  });
  issued.set(preview, structuredClone(limits));
  return preview;
}

/** Host checks exact version/hash, required originals, live grant and flushed inputs.
 * Only literal synchronous true authorizes output. Recheck after asynchronous hashing.
 * Host must also recheck immediately before its actual download/write boundary. */
export async function confirmGeoDataExport(
  preview: PreparedGeoDataExport,
  acknowledged: readonly GeoExportWarning[],
  authorize: (capture: DeepReadonly<GeoExportCapture>) => boolean,
): Promise<DeepReadonly<GeoDataExportBundle>> {
  const limits = issued.get(preview);
  if (!limits) throw new Error('export-unknown-preview');
  checkedJson(acknowledged, limits.native);
  if (
    !Array.isArray(acknowledged) ||
    acknowledged.length !== preview.warnings.length ||
    new Set(acknowledged).size !== acknowledged.length ||
    preview.warnings.some((w) => !acknowledged.includes(w))
  )
    throw new Error('export-confirmation-required');
  const accepted = [...preview.warnings];
  const check = () => {
    if (authorize(preview.capture) !== true) throw new Error('export-not-authorized');
  };
  check();
  const bytes = utf8(preview.data.text),
    digest = await crypto.subtle.digest('SHA-256', bytes);
  check();
  const layer = preview.capture.content.layers.find((l) => l.id === preview.selection.layerId)!;
  const sourceIds = new Set(
    layer.features.flatMap((f) => (f.sourceRef ? [f.sourceRef.sourceId] : [])),
  );
  const usedJoins = (preview.capture.content.workspace?.joins ?? []).filter(
    (j) =>
      j.layerId === layer.id &&
      j.fields.some((f) => preview.selection.fieldIds.includes(`join:${j.id}:${f.id}`)),
  );
  for (const j of usedJoins)
    for (const f of preview.capture.content.layers.find((l) => l.id === j.tableLayerId)?.features ??
      [])
      if (f.sourceRef) sourceIds.add(f.sourceRef.sourceId);
  const receiptText = checkedJson(
    {
      profile: 'geo-data-export-experiment-v1',
      input: preview.capture.pin,
      derivedJoins: usedJoins.map((j) => ({
        id: j.id,
        inputs: j.inputs,
        leftFieldId: j.leftFieldId,
        rightFieldId: j.rightFieldId,
        cardinality: j.cardinality,
      })),
      layer: { id: layer.id, name: layer.name, crs: layer.crs, axis: layer.axis },
      fields: preview.fields,
      omittedFieldIds: preview.omittedFieldIds,
      featureCount: preview.featureCount,
      nullGeometryCount: preview.nullGeometryCount,
      acknowledged: accepted,
      csvEncoding:
        preview.selection.format === 'csv' ? 'RFC4180; UTF-8; JSON scalar per data cell' : null,
      sources: preview.capture.content.sources.filter((s) => sourceIds.has(s.id)),
      // Original external IDs are provenance, never replacements for stable native IDs.
      rows: layer.features.map((f) => ({
        featureId: f.id,
        rowId: f.rowId,
        sourceRef: f.sourceRef ?? null,
      })),
      output: {
        name: preview.data.name,
        mediaType: preview.data.mediaType,
        bytes: bytes.length,
        bytesHash: `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`,
      },
    },
    { ...limits.native, bytes: limits.outputBytes },
  );
  if (bytes.length + utf8(receiptText).length > limits.outputBytes)
    throw new Error('export-byte-limit');
  check();
  return freeze({
    data: { ...preview.data },
    receipt: {
      name: 'geographic-data.receipt.json',
      mediaType: 'application/json',
      text: receiptText,
    },
  });
}
