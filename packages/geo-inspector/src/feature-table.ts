import type { DeepReadonly, VectorLayer } from '@editor-platform/geo-core';

/** Native projection only. The owning editor controls selection, input guards and history. */
export function createFeatureTable(
  doc: Document,
  layer: DeepReadonly<VectorLayer>,
  select: (featureId: string) => void,
) {
  const element = doc.createElement('div');
  element.className = 'geo-feature-table';
  element.style.overflowX = 'auto';
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', `Attributes ${layer.id}`);
  element.tabIndex = 0;
  const hint = doc.createElement('p');
  hint.textContent = 'Scroll horizontally for all columns. Strings are quoted; null means missing.';
  element.append(hint);
  const table = doc.createElement('table');
  table.style.borderCollapse = 'collapse';
  table.style.width = '100%';
  table.style.minWidth = 'max-content';
  table.style.maxWidth = 'none';
  table.style.whiteSpace = 'nowrap';
  const caption = doc.createElement('caption');
  caption.textContent = `${layer.name} — ${layer.features.length} records.`;
  caption.style.textAlign = 'left';
  table.append(caption);
  const header = doc.createElement('thead'),
    headerRow = doc.createElement('tr');
  for (const title of [
    'Feature / row ID',
    'Geometry',
    'Longitude',
    'Latitude',
    ...layer.fields.map((f) => `${f.name} (${f.type})`),
  ]) {
    const th = doc.createElement('th');
    th.scope = 'col';
    th.textContent = title;
    th.style.textAlign = 'left';
    th.style.padding = '8px';
    headerRow.append(th);
  }
  header.append(headerRow);
  table.append(header);
  const body = doc.createElement('tbody'),
    buttons = new Map<string, HTMLButtonElement>();
  let disposed = false;
  for (const feature of layer.features) {
    const row = doc.createElement('tr');
    row.dataset.featureId = feature.id;
    const cell = doc.createElement('th');
    cell.scope = 'row';
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = `Select ${feature.id} (${feature.geometry?.type ?? 'null'})`;
    button.setAttribute('aria-pressed', 'false');
    button.onclick = () => {
      if (!disposed) select(feature.id);
    };
    cell.append(button);
    const rowId = doc.createElement('span');
    rowId.textContent = `Row ${feature.rowId}`;
    rowId.style.display = 'block';
    cell.append(rowId);
    row.append(cell);
    const point = feature.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
    const values = [
      feature.geometry?.type ?? 'null — location unknown',
      point ? String(point[0]) : '—',
      point ? String(point[1]) : '—',
      ...layer.fields.map((field) => {
        const value = feature.values[field.id];
        return value === null
          ? 'null'
          : typeof value === 'string'
            ? JSON.stringify(value)
            : String(value);
      }),
    ];
    for (const text of values) {
      const td = doc.createElement('td');
      td.textContent = text;
      td.style.padding = '8px';
      row.append(td);
    }
    buttons.set(feature.id, button);
    body.append(row);
  }
  table.append(body);
  element.append(table);
  return {
    element,
    select(featureId: string | null) {
      if (disposed) return;
      for (const [id, button] of buttons) {
        button.setAttribute('aria-pressed', String(id === featureId));
        button.closest('tr')!.style.background = id === featureId ? '#fff2df' : '';
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const button of buttons.values()) button.onclick = null;
      buttons.clear();
    },
  };
}
