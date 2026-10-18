import { importDiagnosticText } from './diagnostic-copy';
import {
  createGeoImporter,
  type ImportLimits,
  type ImportRequest,
  type ImportPreview,
  type ExecutionContext,
} from '@editor-platform/geo-core';
import type { SurfaceOperation } from '@editor-platform/extension-contract/controlled-surface';

type Importer = ReturnType<typeof createGeoImporter>;
type Confirmed = Awaited<ReturnType<Importer['confirm']>>;
export interface StagedImportSource {
  source: ImportRequest['source'];
  /** Release private preparation only; committed original retention is owned separately by Host. */
  release(): void;
}
/** Private domain integration seam, not a new shared contract or storage implementation. */
export interface ImportWorkbenchHost {
  /** Host-owned capability description; does not grant edit or persistence. */
  importedNotice?: string;
  current(): ExecutionContext;
  source(
    bytes: Uint8Array,
    name: string,
    format: 'csv' | 'geojson',
    signal: AbortSignal,
  ): Promise<StagedImportSource>;
  /** Trusted Host must keep original bytes available with adopted source pins. */
  commit(
    result: Confirmed,
    material: {
      bytes: Uint8Array;
      pin: ImportRequest['source']['pin'];
      recipe: {
        format: ImportRequest['format'];
        crs: ImportRequest['crs'];
        fields: ImportRequest['fields'];
        csv?: ImportRequest['csv'];
        decision: { mode: 'all' } | { mode: 'partial'; excludedRows: number[] };
      };
    },
  ): SurfaceOperation;
  signal: AbortSignal;
}
/** Local-file mapping/diagnostics/explicit commit over the existing bounded importer. */
export function createImportWorkbench(
  doc: Document,
  host: ImportWorkbenchHost,
  limits: ImportLimits,
) {
  const importer = createGeoImporter(limits),
    root = doc.createElement('section');
  root.setAttribute('aria-label', 'Import geographic data');
  root.className = 'geo-import-workbench';
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const input = (parent: HTMLElement, title: string, initial = '') => {
    const label = node('label', title),
      value = node('input');
    value.value = initial;
    label.append(value);
    parent.append(label);
    return value;
  };
  const select = (parent: HTMLElement, title: string, values: string[]) => {
    const label = node('label', title),
      value = node('select');
    value.setAttribute('aria-label', title);
    for (const text of values) {
      const option = node('option', text);
      option.value = text;
      value.append(option);
    }
    label.append(value);
    parent.append(label);
    return value;
  };
  root.append(
    node('h2', 'Import local CSV or GeoJSON'),
    node(
      'p',
      'Preview before importing. The Host retains source references and reports which editing and saving capabilities are available.',
    ),
  );
  const controls = node('div'),
    diagnostics = node('div');
  const file = input(controls, 'Local file');
  file.type = 'file';
  file.accept = '.csv,.json,.geojson';
  const format = select(controls, 'Format', ['csv', 'geojson']);
  const name = input(controls, 'Layer name', 'Imported layer');
  controls.append(
    node(
      'p',
      'Coordinates: OGC:CRS84 decimal degrees. No CRS conversion. Map every property/column; no silent omissions.',
    ),
  );
  const csv = node('fieldset');
  csv.append(node('legend', 'CSV coordinates and external ID'));
  const id = input(csv, 'ID column (optional)'),
    first = input(csv, 'First coordinate column'),
    second = input(csv, 'Second coordinate column');
  const axis = select(csv, 'CSV coordinate order', ['longitude-latitude', 'latitude-longitude']);
  const missing = select(csv, 'Missing coordinate policy', [
    'reject',
    'preserve-null',
    'attribute-table',
  ]);
  csv.append(
    node(
      'p',
      'For a join-only CSV choose attribute-table and map all columns as scalar fields. Coordinate columns are then unnecessary.',
    ),
  );
  controls.append(csv);
  const fields = node('fieldset');
  fields.append(node('legend', 'Scalar column/property mapping'));
  const mappings: {
    row: HTMLElement;
    column: HTMLInputElement;
    name: HTMLInputElement;
    type: HTMLSelectElement;
    fieldId: string;
    remove: HTMLButtonElement;
    removed: boolean;
  }[] = [];
  let fieldSequence = 0;
  const add = node('button', 'Add field');
  add.type = 'button';
  const addField = () => {
    const row = node('div'),
      index = ++fieldSequence;
    const column = input(row, `Input column/property ${index}`),
      fieldName = input(row, `Display name ${index}`);
    const type = select(row, `Type ${index}`, ['string', 'number', 'boolean']);
    const remove = node('button', `Remove field ${index}`);
    remove.type = 'button';
    const mapping = {
      row,
      column,
      name: fieldName,
      type,
      fieldId: `field-${index}`,
      remove,
      removed: false,
    };
    mappings.push(mapping);
    remove.onclick = () => {
      if (closed || composing.size || mapping.removed) return;
      const position = mappings.indexOf(mapping);
      if (position < 0) return;
      mapping.removed = true;
      remove.onclick = null;
      mappings.splice(position, 1);
      row.remove();
      invalidate();
    };
    row.append(remove);
    fields.append(row);
    invalidate();
  };
  controls.append(fields, add);
  const prepare = node('button', 'Preview import');
  prepare.type = 'button';
  const cancel = node('button', 'Cancel import');
  cancel.type = 'button';
  controls.append(prepare, cancel);
  root.append(controls);
  const status = node('p', 'Choose a file and specify its columns.');
  status.setAttribute('role', 'status');
  const partialLabel = node('label', 'Import only valid rows; exclude the listed problem rows'),
    partial = node('input');
  partial.type = 'checkbox';
  partialLabel.prepend(partial);
  const commit = node('button', 'Import previewed data');
  commit.type = 'button';
  commit.disabled = true;
  root.append(status, diagnostics, partialLabel, commit);
  let closed = false,
    epoch = 0,
    sequence = 0,
    activePlan: string | null = null,
    busy = false;
  const composing = new Set<EventTarget>();
  let preview: ImportPreview | null = null;
  let preparation: AbortController | null = null,
    sourceLease: StagedImportSource | null = null;
  const releaseSource = () => {
    preparation?.abort();
    preparation = null;
    sourceLease?.release();
    sourceLease = null;
  };
  const live = () => {
    if (closed || host.signal.aborted) throw new Error('ImportScopeClosed');
    if (!host.current().canEdit) throw new Error('permission-denied');
  };
  const eligibility = () => {
    const blocked = closed || composing.size > 0;
    partial.disabled = blocked || busy;
    prepare.disabled = blocked || busy;
    cancel.disabled = add.disabled = blocked;
    for (const mapping of mappings) mapping.remove.disabled = blocked;
    commit.disabled =
      blocked ||
      busy ||
      !preview ||
      preview.plan.diagnostics.some((d) => d.severity === 'error') ||
      (!!preview?.plan.counts.problem && !partial.checked);
  };
  function invalidate() {
    epoch++;
    releaseSource();
    busy = false;
    if (activePlan) importer.release(activePlan);
    activePlan = null;
    preview = null;
    partial.checked = false;
    diagnostics.replaceChildren();
    status.textContent = composing.size
      ? 'Finish text composition before previewing or changing mappings.'
      : 'Preview required after file or mapping changes.';
    eligibility();
  }
  const changed = () => {
    if (closed) return;
    invalidate();
    csv.disabled = format.value !== 'csv';
  };
  const compositionStart = (event: CompositionEvent) => {
    if (closed || !(event.target instanceof HTMLInputElement) || !controls.contains(event.target))
      return;
    composing.add(event.target);
    invalidate();
  };
  const compositionEnd = (event: CompositionEvent) => {
    if (closed || !event.target || !composing.delete(event.target)) return;
    invalidate();
  };
  controls.addEventListener('compositionstart', compositionStart);
  controls.addEventListener('compositionend', compositionEnd);
  controls.addEventListener('input', changed);
  controls.addEventListener('change', changed);
  partial.onchange = () => {
    if (closed) return;
    eligibility();
  };
  add.onclick = () => {
    if (!closed && !composing.size) {
      addField();
      if (doc.activeElement === add) add.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  cancel.onclick = () => {
    if (!closed && !composing.size) {
      invalidate();
      status.textContent = 'Import cancelled. Native unchanged.';
    }
  };
  const rowNumberHelp = (format: ImportRequest['format']) =>
    format === 'csv'
      ? 'CSV row numbers count data records after the header, not physical file lines (quoted cells may span lines).'
      : 'GeoJSON row numbers count features starting at 1.';
  const show = (value: ImportPreview) => {
    diagnostics.replaceChildren();
    const counts = value.plan.counts;
    diagnostics.append(
      node('p', `Read ${counts.read}; valid ${counts.valid}; problem ${counts.problem}.`),
      node('p', rowNumberHelp(value.request.format)),
    );
    const list = node('ul');
    for (const d of value.plan.diagnostics)
      list.append(node('li', `${d.severity}: ${importDiagnosticText(d.code)} — ${d.path}`));
    for (const candidate of value.plan.candidates)
      for (const d of candidate.diagnostics)
        list.append(
          node(
            'li',
            `Row ${candidate.inputRow}: ${d.severity} ${importDiagnosticText(d.code)} — ${d.path}`,
          ),
        );
    diagnostics.append(list);
    const sample = node('ul');
    sample.setAttribute('aria-label', 'Mapped coordinate sample');
    diagnostics.append(
      node(
        'p',
        'Check mapped coordinates before import (first 3 input records). A valid range does not prove the intended axis order.',
      ),
      sample,
    );
    for (const candidate of value.plan.candidates.slice(0, 3)) {
      const geometry = candidate.feature.geometry;
      const description = candidate.diagnostics.some((d) => d.severity === 'error')
        ? 'Blocked; see row diagnostics.'
        : geometry?.type === 'Point'
          ? `longitude ${geometry.coordinates[0]}; latitude ${geometry.coordinates[1]}`
          : geometry === null
            ? 'No location (null geometry).'
            : geometry.type;
      sample.append(node('li', `Row ${candidate.inputRow}: ${description}`));
    }
    status.textContent = counts.problem
      ? 'Import held. Review every problem row; partial import requires explicit consent.'
      : 'Preview ready. Native unchanged until Import previewed data.';
    eligibility();
  };
  prepare.onclick = async () => {
    if (closed || busy || composing.size) return;
    invalidate();
    const token = epoch;
    const operation = new AbortController();
    preparation = operation;
    busy = true;
    eligibility();
    status.textContent = 'Preparing private preview…';
    try {
      live();
      const selected = file.files?.[0];
      if (!selected) throw new Error('Choose a local file');
      if (selected.size > limits.sourceBytes) throw new Error('source-byte-limit');
      // Full 128-bit identity, encoded compactly so200 four-attribute records fit
      // the existing controlled/save envelope. Existing imported IDs never change.
      const planId = 'i' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      activePlan = planId;
      const selectedFormat = format.value as 'csv' | 'geojson';
      const mapping = mappings.map((f) => ({
        id: f.fieldId,
        input: f.column.value,
        name: f.name.value || f.column.value,
        type: f.type.value as 'string' | 'number' | 'boolean',
      }));
      const requestBase = {
        planId,
        revision: host.current().revision,
        format: selectedFormat,
        crs: 'OGC:CRS84' as const,
        layerId: `layer-${++sequence}-${planId}`,
        layerName: name.value,
        fields: mapping,
        ...(selectedFormat === 'csv'
          ? {
              csv: {
                idColumn: id.value || null,
                firstCoordinate: first.value,
                secondCoordinate: second.value,
                axis: axis.value as 'longitude-latitude' | 'latitude-longitude',
                missingCoordinates: missing.value as 'reject' | 'preserve-null' | 'attribute-table',
              },
            }
          : {}),
      };
      const bytes = new Uint8Array(await selected.arrayBuffer());
      if (token !== epoch || closed) return;
      live();
      const lease = await host.source(
        bytes.slice(),
        selected.name,
        selectedFormat,
        operation.signal,
      );
      if (token !== epoch || closed) {
        lease.release();
        return;
      }
      sourceLease = lease;
      live();
      const result = await importer.prepare(bytes, { ...requestBase, source: lease.source });
      if (token !== epoch || closed) return;
      live();
      preview = result;
      show(result);
    } catch (error) {
      if (!closed && token === epoch) {
        releaseSource();
        if (activePlan) importer.release(activePlan);
        activePlan = null;
        status.textContent = importDiagnosticText(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (token === epoch) {
        busy = false;
        if (!closed) eligibility();
      }
    }
  };
  commit.onclick = async () => {
    if (closed || busy || composing.size || !preview || commit.disabled) return;
    const candidate = preview,
      token = epoch;
    busy = true;
    eligibility();
    try {
      live();
      const excludedRows = candidate.plan.candidates
        .filter((c) => c.diagnostics.some((d) => d.severity === 'error'))
        .map((c) => c.inputRow);
      const decision = partial.checked
        ? { mode: 'partial' as const, excludedRows }
        : { mode: 'all' as const };
      const material = {
        bytes: importer.sourceBytes(candidate.request.planId),
        pin: candidate.request.source.pin,
      };
      const result = await importer.confirm(candidate, decision, material, host.current);
      if (closed || token !== epoch) return;
      live();
      const request = candidate.request;
      const applied = host.commit(result, {
        ...material,
        recipe: structuredClone({
          format: request.format,
          crs: request.crs,
          fields: request.fields,
          ...(request.csv ? { csv: request.csv } : {}),
          decision,
        }),
      });
      if (applied.state === 'refused') throw new Error(`${applied.code}: ${applied.message}`);
      if (applied.state !== 'applied') throw new Error('ImportNotApplied');
      invalidate();
      status.textContent = `Imported ${result.imported}; excluded ${result.excluded.length}. ${host.importedNotice ?? 'Source retained by Host; source-backed editing/save not enabled.'}`;
      if (result.excluded.length)
        diagnostics.append(node('p', rowNumberHelp(candidate.request.format)));
      const log = node('ul');
      for (const row of result.excluded)
        log.append(
          node(
            'li',
            `Excluded row ${row.inputRow}: ${row.diagnostics
              .filter((d) => d.severity === 'error')
              .map((d) => importDiagnosticText(d.code))
              .join(', ')}`,
          ),
        );
      diagnostics.append(log);
    } catch (error) {
      if (!closed && token === epoch)
        status.textContent = importDiagnosticText(
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      if (token === epoch) {
        busy = false;
        if (!closed) eligibility();
      }
    }
  };
  function dispose() {
    if (closed) return;
    closed = true;
    epoch++;
    releaseSource();
    for (const mapping of mappings) {
      mapping.removed = true;
      mapping.remove.onclick = null;
    }
    importer.dispose();
    composing.clear();
    controls.removeEventListener('compositionstart', compositionStart);
    controls.removeEventListener('compositionend', compositionEnd);
    controls.removeEventListener('input', changed);
    controls.removeEventListener('change', changed);
    host.signal.removeEventListener('abort', dispose);
    prepare.onclick = cancel.onclick = commit.onclick = add.onclick = partial.onchange = null;
    root.remove();
  }
  host.signal.addEventListener('abort', dispose, { once: true });
  if (host.signal.aborted) dispose();
  return { element: root, dispose };
}
