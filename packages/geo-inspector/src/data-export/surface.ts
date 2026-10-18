import {
  geoFields,
  prepareGeoDataExport,
  confirmGeoDataExport,
  parseGeo,
  serializeGeo,
  type DeepReadonly,
  type GeoDataExportBundle,
  type GeoDataExportLimits,
  type GeoExportCapture,
  type GeoExportWarning,
  type PreparedGeoDataExport,
} from '@editor-platform/geo-core';

/** Opt-in domain experiment. Host owns Inputs, version/hash/source verification and IO. */
export interface GeoDataExportHost {
  signal: AbortSignal;
  /** Flush inputs first; refuse invalid/composing input. Resolve a retained immutable version. */
  capture(signal: AbortSignal): Promise<GeoExportCapture>;
  /** Exact verified content hash, required source closure and current export grant. */
  authorize(capture: DeepReadonly<GeoExportCapture>): boolean;
  /** Retire Host-owned volatile links when selection/preview is invalidated. */
  retire?(): void;
  /** Synchronous handoff; recheck authorization at the actual download/write boundary. */
  deliver(bundle: DeepReadonly<GeoDataExportBundle>, capture: DeepReadonly<GeoExportCapture>): void;
}
export const geoExportWarningText: Record<GeoExportWarning, string> = {
  'native-document-not-preserved':
    'This is data exchange. Other layers, original source bytes, native history, styles, views, asset notes, photos and comparisons are not included. Keep the native artifact and retained originals.',
  'attributes-omitted':
    'Unchecked attributes are omitted, including attributes hidden in other views.',
  'geometry-omitted': 'Attribute CSV omits geometry. Stable feature and row IDs remain in the CSV.',
  'csv-json-scalars':
    'CSV data cells contain JSON scalars. Parse each cell as JSON to preserve leading zeros, empty strings, null, numbers and booleans. This is not plain spreadsheet text.',
  'source-metadata-in-receipt':
    'The receipt includes source pins, resource IDs, attribution and original external IDs. Review these before sharing.',
  'topology-not-checked':
    'Polygon coordinates are preserved. Polygon topology has not been checked; this export does not certify valid boundaries.',
};

export function createGeoDataExportWorkbench(
  doc: Document,
  host: GeoDataExportHost,
  limits: GeoDataExportLimits,
) {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const root = node('section');
  root.setAttribute('aria-label', 'Export geographic data');
  const load = node('button', 'Load saved geographic version'),
    layerLabel = node('label', 'Export layer'),
    layer = node('select'),
    formatLabel = node('label', 'Export format'),
    format = node('select'),
    fields = node('fieldset'),
    previewButton = node('button', 'Preview data export'),
    cancel = node('button', 'Cancel data export'),
    summary = node('section'),
    confirm = node('button', 'Export data and receipt'),
    status = node('p');
  for (const button of [load, previewButton, cancel, confirm]) button.type = 'button';
  layer.setAttribute('aria-label', 'Export layer');
  format.setAttribute('aria-label', 'Export format');
  for (const [value, text] of [
    ['geojson', 'GeoJSON'],
    ['csv', 'Attribute CSV (JSON scalar cells)'],
  ]) {
    const option = node('option', text);
    option.value = value;
    format.append(option);
  }
  layerLabel.append(layer);
  formatLabel.append(format);
  summary.setAttribute('aria-label', 'Export preview');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-label', 'Geo export status');
  root.append(
    node('h2', 'Export geographic data'),
    node(
      'p',
      'Choose one saved layer and its attributes explicitly. Data and a provenance receipt are exported together. No external service is used.',
    ),
    load,
    layerLabel,
    formatLabel,
    fields,
    previewButton,
    cancel,
    summary,
    confirm,
    status,
  );
  let capture: GeoExportCapture | undefined,
    preview: PreparedGeoDataExport | undefined,
    sequence = 0,
    pending = false,
    closed = host.signal.aborted,
    request: AbortController | undefined;
  const chosen = new Map<string, HTMLInputElement>();
  const acknowledgements = new Map<GeoExportWarning, HTMLInputElement>();
  const authorized = (value: DeepReadonly<GeoExportCapture>, ticket: number) => {
    if (closed || sequence !== ticket) return false;
    const granted = host.authorize(value) === true;
    return granted && !closed && sequence === ticket;
  };
  const update = () => {
    load.disabled = closed || pending;
    layer.disabled = closed || !capture;
    format.disabled = closed;
    for (const checkbox of chosen.values()) checkbox.disabled = closed;
    for (const checkbox of acknowledgements.values()) checkbox.disabled = closed || pending;
    previewButton.disabled = closed || pending || !capture || !layer.value;
    confirm.disabled =
      closed ||
      pending ||
      !preview ||
      [...acknowledgements.values()].some((checkbox) => !checkbox.checked);
    cancel.disabled = closed;
  };
  const invalidate = () => {
    sequence++;
    request?.abort();
    request = undefined;
    pending = false;
    preview = undefined;
    acknowledgements.clear();
    summary.replaceChildren();
    host.retire?.();
    status.textContent = 'Choose attributes and preview the export.';
    update();
  };
  const failure = (error: unknown) => {
    status.textContent = `Export refused: ${error instanceof Error ? error.message : String(error)}`;
  };
  const renderFields = () => {
    chosen.clear();
    fields.replaceChildren(node('legend', 'Attributes to export (none selected by default)'));
    const selected = capture?.content.layers.find((l) => l.id === layer.value);
    for (const field of selected && capture ? geoFields(capture.content, selected) : []) {
      const label = node('label', `${field.name} — ${field.id} (${field.type})`),
        checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.setAttribute('aria-label', `Include attribute ${field.id}`);
      checkbox.onchange = () => {
        if (!closed) invalidate();
      };
      chosen.set(field.id, checkbox);
      label.prepend(checkbox);
      fields.append(label);
    }
  };
  load.onclick = async () => {
    if (closed || pending) return;
    invalidate();
    capture = undefined;
    layer.replaceChildren();
    renderFields();
    const ticket = sequence,
      controller = new AbortController();
    request = controller;
    pending = true;
    status.textContent = 'Preparing saved version and checking inputs…';
    update();
    try {
      const value = await host.capture(controller.signal);
      if (closed || sequence !== ticket) return;
      // Own and validate native data before rendering any field/label.
      capture = {
        content: parseGeo(serializeGeo(value.content, limits.native), limits.native),
        pin: structuredClone(value.pin),
      };
      const placeholder = node('option', 'Choose a layer');
      placeholder.value = '';
      layer.append(placeholder);
      for (const candidate of capture.content.layers) {
        const option = node('option', candidate.name);
        option.value = candidate.id;
        layer.append(option);
      }
      status.textContent = capture.content.layers.length
        ? 'Saved version loaded. Choose a layer and attributes.'
        : 'Saved version has no layers.';
    } catch (error) {
      if (!closed && sequence === ticket) failure(error);
    } finally {
      if (!closed && sequence === ticket) {
        pending = false;
        update();
      }
    }
  };
  layer.onchange = () => {
    if (!closed) {
      invalidate();
      renderFields();
    }
  };
  format.onchange = () => {
    if (!closed) invalidate();
  };
  cancel.onclick = () => {
    if (!closed) invalidate();
  };
  previewButton.onclick = () => {
    if (closed || pending || !capture || !layer.value) return;
    invalidate();
    const ticket = sequence;
    try {
      const candidate = prepareGeoDataExport(
        capture,
        {
          layerId: layer.value,
          fieldIds: [...chosen]
            .filter(([, checkbox]) => checkbox.checked)
            .map(([fieldId]) => fieldId),
          format: format.value === 'csv' ? 'csv' : 'geojson',
        },
        limits,
      );
      if (!authorized(candidate.capture, ticket)) throw new Error('export-not-authorized');
      preview = candidate;
      summary.append(
        node('h3', 'Review data export'),
        node(
          'p',
          `${candidate.featureCount} features; ${candidate.nullGeometryCount} null geometries. Fields: ${candidate.fields.map((f) => `${f.name} (${f.id}: ${f.type})`).join(', ') || 'none'}. Omitted: ${candidate.omittedFieldIds.join(', ') || 'none'}.`,
        ),
        node(
          'p',
          `Version ${candidate.capture.pin.versionId}; ${candidate.capture.pin.contentHash}`,
        ),
      );
      const selected = candidate.capture.content.layers.find((l) => l.id === layer.value)!;
      const sourceIds = new Set(
        selected.features.flatMap((f) => (f.sourceRef ? [f.sourceRef.sourceId] : [])),
      );
      for (const source of candidate.capture.content.sources.filter((s) => sourceIds.has(s.id)))
        summary.append(
          node('p', `Source ${source.id}: ${source.attribution}; ${source.bytesHash}`),
        );
      for (const warning of candidate.warnings) {
        const label = node('label', geoExportWarningText[warning]),
          checkbox = node('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', `Acknowledge ${warning}`);
        checkbox.onchange = update;
        label.prepend(checkbox);
        acknowledgements.set(warning, checkbox);
        summary.append(label);
      }
      status.textContent = 'Preview ready. Review and acknowledge each output condition.';
    } catch (error) {
      if (!closed && sequence === ticket) {
        preview = undefined;
        failure(error);
      }
    }
    update();
  };
  confirm.onclick = async () => {
    if (closed || pending || !preview) return;
    const candidate = preview,
      ticket = sequence;
    pending = true;
    update();
    try {
      const bundle = await confirmGeoDataExport(
        candidate,
        [...acknowledgements]
          .filter(([, checkbox]) => checkbox.checked)
          .map(([warning]) => warning),
        (value) => authorized(value, ticket),
      );
      if (closed || sequence !== ticket) return;
      if (!authorized(candidate.capture, ticket)) throw new Error('export-not-authorized');
      host.deliver(bundle, candidate.capture);
      if (!closed && sequence === ticket)
        status.textContent = 'Exported data and provenance receipt.';
    } catch (error) {
      if (!closed && sequence === ticket) failure(error);
    } finally {
      if (!closed && sequence === ticket) {
        pending = false;
        update();
      }
    }
  };
  const dispose = () => {
    closed = true;
    invalidate();
    capture = undefined;
    chosen.clear();
    fields.replaceChildren();
    layer.replaceChildren();
    status.textContent = 'Export scope closed.';
    update();
    host.signal.removeEventListener('abort', dispose);
  };
  host.signal.addEventListener('abort', dispose, { once: true });
  update();
  if (closed) dispose();
  return { element: root, dispose };
}
