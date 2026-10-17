import { preparePointScene, createPointMap, type PointScene } from './point-map';
import { contentHash, deepFreeze } from '@editor-platform/artifact-core';
import {
  assertGeo,
  validateGeo,
  type Budgets,
  type DeepReadonly,
  type Diagnostic,
  type GeoDocument,
} from '@editor-platform/geo-core';
export interface PreparedGeoInspection {
  readonly content: DeepReadonly<GeoDocument>;
  readonly nativeContentHash: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly pointScenes: readonly PointScene[];
}
const preparedInputs = new WeakSet<object>();
/** Detached native snapshot; computed hash is not a package hash or remote-source attestation. */
export async function prepareGeoInspection(
  input: unknown,
  budgets: Budgets,
): Promise<PreparedGeoInspection> {
  assertGeo(input, budgets);
  const content = deepFreeze(structuredClone(input));
  const nativeContentHash = await contentHash(content);
  const result = deepFreeze({
    content,
    nativeContentHash,
    diagnostics: validateGeo(content, budgets),
    pointScenes: content.layers.map(preparePointScene),
  });
  preparedInputs.add(result);
  return result;
}
export interface InspectorCaptureLabel {
  artifactId: string;
  sequence: number;
  packageHash: string;
}
/** Readonly local Point frame plus native inspector. Caller owns insertion and lifecycle. */
export function createGeoInspectorSurface(
  doc: Document,
  prepared: PreparedGeoInspection,
  label: InspectorCaptureLabel,
) {
  if (!preparedInputs.has(prepared)) throw new Error('GeoInspectorPrepared');
  const root = doc.createElement('section');
  root.className = 'geo-inspector';
  root.setAttribute('aria-label', 'Geo inspector');
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const value = doc.createElement(tag);
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const style = node('style');
  style.textContent = `.geo-inspector{font:15px/1.5 system-ui,sans-serif;color:#172c3b;background:#fff;border:1px solid #b7c9d5;border-radius:10px;padding:16px;box-sizing:border-box;max-width:100%;min-width:0;overflow-wrap:anywhere}.geo-inspector *{box-sizing:border-box;min-width:0;max-width:100%}.geo-inspector h2,.geo-inspector h3{line-height:1.25}.geo-inspector dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:6px 12px;margin:12px 0}.geo-inspector dt{font-weight:600}.geo-inspector dd{margin:0;white-space:pre-wrap}.geo-inspector details{border-top:1px solid #d7e2e9;padding:10px 0}.geo-inspector summary{cursor:pointer;font-weight:600}.geo-inspector summary:focus-visible{outline:3px solid #286aa4;outline-offset:3px}.geo-inspector p{margin:8px 0}@media(max-width:480px){.geo-inspector{padding:12px}.geo-inspector dl{grid-template-columns:minmax(0,1fr);gap:2px}.geo-inspector dd{margin-bottom:8px}}`;
  style.textContent += `.geo-point-map svg{display:block;width:100%;height:auto;max-height:360px}.geo-point-map circle{fill:#176a93;stroke:#fff;stroke-width:3}.geo-point-map [aria-pressed=true] circle{fill:#a34200;stroke:#231400;stroke-width:4}.geo-point-map [role=button]{cursor:pointer}.geo-point-map [role=button]:focus circle{stroke:#000;stroke-width:5}.geo-inspector button{padding:8px;border:1px solid #406780;border-radius:4px;background:#f2f8fc;color:#172c3b;font:inherit;cursor:pointer}.geo-inspector button[aria-pressed=true]{background:#fce3c6}.geo-inspector button:focus-visible{outline:3px solid #286aa4;outline-offset:2px}.geo-inspector details[data-selected=true]{border-left:4px solid #a34200;padding-left:8px}`;
  const list = (items: readonly (readonly [string, string])[]) => {
    const dl = node('dl');
    for (const [key, value] of items) dl.append(node('dt', key), node('dd', value));
    return dl;
  };
  const content = prepared.content;
  let removed = false;
  const maps = new Map<string, ReturnType<typeof createPointMap>>();
  const rows = new Map<
    string,
    Map<string, { details: HTMLDetailsElement; button: HTMLButtonElement }>
  >();
  const stops: (() => void)[] = [];
  const selection = node('p', 'No feature selected.');
  selection.setAttribute('role', 'status');
  selection.setAttribute('aria-label', 'Geo selection');
  const select = (layerId: string, featureId: string) => {
    if (removed) return;
    const row = rows.get(layerId)?.get(featureId);
    if (!row) return;
    for (const [lid, entries] of rows)
      for (const [fid, r] of entries) {
        const selected = lid === layerId && fid === featureId;
        r.button.setAttribute('aria-pressed', String(selected));
        r.details.dataset.selected = String(selected);
      }
    for (const [lid, map] of maps) map.select(lid === layerId ? featureId : null);
    row.details.open = true;
    selection.textContent = `Selected layer ${layerId}, feature ${featureId}. Selection is private; native data unchanged.`;
  };
  root.append(
    style,
    node('h2', 'Geo inspector'),
    node('p', 'Read-only Geo inspector with a limited local Point map. No editing or saving.'),
    node(
      'p',
      `${content.layers.length} layers · ${content.layers.reduce((n, l) => n + l.features.length, 0)} features · ${content.sources.length} sources`,
    ),
  );
  root.append(
    list([
      ['Artifact', label.artifactId],
      ['Captured local revision', String(label.sequence)],
      ['Package pin (Host admitted)', label.packageHash],
      ['Computed native snapshot hash', prepared.nativeContentHash],
    ]),
  );
  if (prepared.diagnostics.length) {
    const notes = node('ul');
    notes.setAttribute('aria-label', 'Geometry validation notes');
    for (const d of prepared.diagnostics) notes.append(node('li', `${d.code} — ${d.path}`));
    root.append(notes);
  }
  root.append(selection);
  for (const [layerIndex, layer] of content.layers.entries()) {
    const section = node('section');
    section.setAttribute('aria-label', `Layer ${layer.id}`);
    section.append(
      node('h3', layer.name),
      list([
        ['Layer ID', layer.id],
        ['Features', String(layer.features.length)],
        ['Coordinates', `${layer.crs} · longitude, latitude (degrees)`],
      ]),
    );
    const map = createPointMap(doc, prepared.pointScenes[layerIndex], (featureId) =>
      select(layer.id, featureId),
    );
    maps.set(layer.id, map);
    section.append(map.element);
    const layerRows = new Map<string, { details: HTMLDetailsElement; button: HTMLButtonElement }>();
    rows.set(layer.id, layerRows);
    for (const [index, feature] of layer.features.entries()) {
      const details = node('details');
      details.open = index === 0;
      details.append(node('summary', `Feature ${feature.id}`));
      const button = node('button', `Select feature ${feature.id}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      const click = () => select(layer.id, feature.id);
      button.addEventListener('click', click);
      stops.push(() => button.removeEventListener('click', click));
      details.append(button);
      layerRows.set(feature.id, { details, button });
      const geometry = feature.geometry;
      const items: [string, string][] = [
        ['Feature ID', feature.id],
        ['Row ID', feature.rowId],
        ['Geometry', geometry?.type ?? 'null — location unknown'],
      ];
      if (geometry?.type === 'Point')
        items.push(
          ['Longitude', String(geometry.coordinates[0])],
          ['Latitude', String(geometry.coordinates[1])],
        );
      else if (geometry)
        items.push(['Coordinates (longitude, latitude)', JSON.stringify(geometry.coordinates)]);
      if (feature.sourceRef)
        items.push(
          ['Source ID', feature.sourceRef.sourceId],
          ['External ID', JSON.stringify(feature.sourceRef.externalId)],
        );
      details.append(list(items));
      const attrs = node('dl');
      attrs.setAttribute('aria-label', `Attributes ${feature.id}`);
      for (const field of layer.fields)
        attrs.append(
          node('dt', `${field.name} [${field.id}] · ${field.type}`),
          node('dd', JSON.stringify(feature.values[field.id])),
        );
      details.append(attrs);
      section.append(details);
    }
    root.append(section);
  }
  const provenance = node('section');
  provenance.setAttribute('aria-label', 'Source provenance');
  provenance.append(node('h3', 'Source provenance'));
  for (const source of content.sources) {
    const details = node('details');
    details.append(node('summary', `Source ${source.id}`));
    details.append(
      list([
        ['Source ID', source.id],
        ['Resource reference', source.resourceId],
        ['Source artifact', source.pin.artifactId],
        ['Fixed source version', source.pin.versionId],
        ['Declared source content hash', source.pin.contentHash],
        ['Declared raw byte hash', source.bytesHash],
        ['Format / adapter', `${source.format} / ${source.adapterVersion}`],
        ['CRS / axis', `${source.declaredCrs} / ${source.axis}`],
        ['Attribution', source.attribution],
      ]),
    );
    provenance.append(details);
  }
  provenance.append(
    node(
      'p',
      'Source pins are displayed as stored metadata. No source resource is fetched or independently verified.',
    ),
  );
  root.append(provenance);
  return Object.freeze({
    element: root,
    dispose() {
      if (!removed) {
        removed = true;
        for (const stop of stops) stop();
        for (const map of maps.values()) map.dispose();
        root.remove();
      }
    },
  });
}
