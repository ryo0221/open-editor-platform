import { contentHash } from '@editor-platform/artifact-core';
import { sameLocalRevision } from '@editor-platform/editor-core';
import {
  assertEditableGeometry,
  compareGeoVersions,
  createPinnedGeoJoin,
  defaultGeoStyle,
  emptyGeoWorkspace,
  fitGeoExtent,
  geoFields,
  geoLegend,
  geoMetricValue,
  geoValue,
  previewGeoRefresh,
  renderGeoSvg,
  type GeoAction,
  type GeoAsset,
  type GeoDocument,
  type GeoExtent,
  type GeoLayerStyle,
  type Geometry,
  type Scalar,
} from '@editor-platform/geo-core';
import type { ControlledSurfaceController } from '@editor-platform/extension-contract/controlled-surface';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import { createGeoPng, type GeoPngBundle } from './png';
import type { GeoWorkspaceHost } from './port';

/** One controller/input group, one native history; camera, panels and selection stay private. */
export function createGeoWorkspaceSurface(
  doc: Document,
  editor: ControlledSurfaceController<GeoDocument>,
  host: GeoWorkspaceHost,
) {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const value = doc.createElement(tag);
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const root = node('section');
  root.className = 'geo-workspace';
  root.setAttribute('aria-label', 'Geographic editor');
  const style = node(
    'style',
    `.geo-workspace{font:15px/1.5 system-ui;color:#173247;background:white;padding:16px;border:1px solid #a9bdc9;border-radius:8px}.geo-workspace *{box-sizing:border-box;min-width:0;max-width:100%}.geo-workspace button,.geo-workspace input,.geo-workspace select,.geo-workspace textarea{font:inherit;padding:8px;margin:4px 0}.geo-workspace label{display:block}.geo-workspace textarea{display:block;width:100%;min-height:80px}.geo-workspace .geo-layout{display:grid;grid-template-columns:minmax(130px,.7fr) minmax(0,2fr) minmax(220px,1fr);gap:16px}.geo-workspace svg{width:100%;height:auto}.geo-workspace svg [role=button]{cursor:pointer}.geo-workspace :focus-visible{outline:3px solid #005fcc;outline-offset:2px}.geo-workspace [aria-selected=true],.geo-workspace [aria-pressed=true]{background:#ffe6bb}.geo-workspace .geo-table{overflow:auto;max-height:360px}.geo-workspace table{border-collapse:collapse;width:100%}.geo-workspace th,.geo-workspace td{padding:6px;border:1px solid #bccbd4;text-align:left}.geo-workspace fieldset{margin:12px 0}.geo-workspace .geo-status{padding:8px;background:#eef4f8}.geo-workspace button:disabled{opacity:.5}@media(max-width:700px){.geo-workspace .geo-layout{display:block}.geo-workspace [hidden]{display:none}}`,
  );
  const status = node('p', 'Choose a feature in the map or table.');
  status.className = 'geo-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-label', 'Geo edit status');
  const toolbar = node('div'),
    tabs = node('div'),
    layout = node('div');
  layout.className = 'geo-layout';
  const sourcePanel = node('aside'),
    mapPanel = node('section'),
    inspector = node('section'),
    tablePanel = node('section');
  sourcePanel.setAttribute('aria-label', 'Layers and sources');
  mapPanel.setAttribute('aria-label', 'Map');
  inspector.setAttribute('aria-label', 'Feature and presentation');
  tablePanel.setAttribute('aria-label', 'Geographic attribute table');
  const map = node('div'),
    legend = node('div'),
    form = node('div'),
    presentation = node('div'),
    table = node('div');
  table.className = 'geo-table';
  mapPanel.append(map, legend);
  inspector.append(form, presentation);
  tablePanel.append(table);
  layout.append(sourcePanel, mapPanel, inspector);
  root.append(
    style,
    node('h2', 'Geographic editor'),
    node(
      'p',
      'Offline CRS84 longitude → latitude. Equirectangular display; no distance, travel-time or area inference. Retained Multi/hole geometry stays read-only.',
    ),
    status,
    toolbar,
    tabs,
    layout,
    tablePanel,
  );
  let closed = false,
    featureDirty = false,
    styleDirty = false,
    base: LocalReadSnapshot<GeoDocument> | undefined;
  let selected: { layerId: string; featureId: string } | null = null,
    scalarField = '',
    styleLayer = '';
  let extent: GeoExtent = [-180, -90, 180, 90],
    activeView = '';
  const composing = new Set<EventTarget>(),
    urls = new Set<string>();
  let png: { bundle: GeoPngBundle; stamp: string } | undefined;
  let outputGeneration = 0;
  const downloads = node('div');
  const retire = () => {
    outputGeneration++;
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    downloads.replaceChildren();
    png = undefined;
  };
  const inputChanged = (event: Event) => {
    retire();
    // Adoption consent is intentionally supplied after preview; it changes no input capture.
    if (!(event.target instanceof HTMLElement && event.target.dataset.adoptionConsent === 'true'))
      host.inputChanged?.();
  };
  for (const event of ['input', 'change', 'compositionstart', 'compositionend'])
    root.addEventListener(event, inputChanged, true);
  const open = () => {
    const v = editor.getSnapshot();
    if (closed || host.signal.aborted || v.state !== 'open') throw Error('ScopeRevoked');
    return v;
  };
  const pending = () => featureDirty || styleDirty || composing.size > 0;
  const requireClean = () => {
    if (pending()) throw Error('Apply or Cancel pending input first');
  };
  const workspace = () => structuredClone(open().snapshot.content.workspace ?? emptyGeoWorkspace());
  const showError = (error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error);
  };
  const run = async (work: () => unknown) => {
    try {
      const result = await work();
      if (result && typeof result === 'object' && 'state' in result && result.state === 'refused')
        throw Error('message' in result ? String(result.message) : 'Operation refused');
    } catch (error) {
      showError(error);
    }
  };
  const button = (parent: HTMLElement, name: string, work: () => unknown) => {
    const b = node('button', name);
    b.type = 'button';
    b.onclick = () => {
      if (!closed) void run(work);
    };
    parent.append(b);
    return b;
  };
  const input = (parent: HTMLElement, name: string, value = '', type = 'text') => {
    const label = node('label', name),
      field = node('input');
    field.type = type;
    field.value = value;
    label.append(field);
    parent.append(label);
    return field;
  };
  const select = (
    parent: HTMLElement,
    name: string,
    values: { value: string; label: string }[],
    value = '',
  ) => {
    const label = node('label', name),
      field = node('select');
    field.setAttribute('aria-label', name);
    for (const v of values) {
      const o = node('option', v.label);
      o.value = v.value;
      field.append(o);
    }
    field.value = value;
    label.append(field);
    parent.append(label);
    return field;
  };
  const textArea = (parent: HTMLElement, name: string, value = '') => {
    const label = node('label', name),
      field = node('textarea');
    field.value = value;
    label.append(field);
    parent.append(label);
    return field;
  };
  const numeric = (text: string) => {
    if (
      !text.trim() ||
      !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(text) ||
      !Number.isFinite(Number(text))
    )
      throw Error('Invalid finite number; input retained');
    return Number(text);
  };
  const currentFeature = () => {
    const content = open().snapshot.content,
      layer = content.layers.find((l) => l.id === selected?.layerId),
      feature = layer?.features.find((f) => f.id === selected?.featureId);
    if (!layer || !feature) throw Error('Feature missing');
    return { content, layer, feature };
  };
  let longitude: HTMLInputElement,
    latitude: HTMLInputElement,
    value: HTMLInputElement,
    isNull: HTMLInputElement,
    geometry: HTMLTextAreaElement;
  let mode: HTMLSelectElement,
    field: HTMLSelectElement,
    labelField: HTMLSelectElement,
    color: HTMLInputElement,
    missingColor: HTMLInputElement,
    radius: HTMLInputElement,
    categories: HTMLTextAreaElement,
    boundaries: HTMLInputElement,
    colors: HTMLInputElement,
    visible: HTMLInputElement,
    metricKind: HTMLSelectElement,
    numerator: HTMLSelectElement,
    denominator: HTMLSelectElement,
    multiplier: HTMLInputElement,
    indicator: HTMLInputElement,
    unit: HTMLInputElement,
    period: HTMLInputElement,
    filterField: HTMLSelectElement,
    filterValue: HTMLInputElement;
  const mark = (kind: 'feature' | 'style') => {
    if (!pending()) base = open().snapshot;
    if (kind === 'feature') featureDirty = true;
    else styleDirty = true;
    binding.changed();
    retire();
    updateButtons();
  };
  const watch = (
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    kind: 'feature' | 'style',
  ) => {
    element.addEventListener('input', () => mark(kind));
    element.addEventListener('change', () => mark(kind));
    element.addEventListener('compositionstart', () => {
      mark(kind);
      composing.add(element);
      binding.changed();
      updateButtons();
    });
    element.addEventListener('compositionend', () => {
      composing.delete(element);
      binding.changed();
      updateButtons();
    });
  };
  function buildActions(snapshot: LocalReadSnapshot<GeoDocument>): GeoAction[] {
    if (composing.size) throw Error('GeoInputComposing');
    if (!base || !sameLocalRevision(base.revision, snapshot.revision))
      throw Error('GeoStaleBuffer; input retained');
    const actions: GeoAction[] = [];
    if (featureDirty) {
      const { layer, feature } = currentFeature();
      const f = layer.fields.find((f) => f.id === scalarField);
      if (f) {
        let scalar: Scalar = null;
        if (!isNull.checked)
          scalar =
            f.type === 'number'
              ? numeric(value.value)
              : f.type === 'boolean'
                ? value.value === 'true'
                  ? true
                  : value.value === 'false'
                    ? false
                    : (() => {
                        throw Error('Boolean must be true or false');
                      })()
                : value.value;
        actions.push({
          type: 'setAttribute',
          layerId: layer.id,
          featureId: feature.id,
          fieldId: f.id,
          value: scalar,
        });
      }
      if (!geometry.disabled) {
        const next: Geometry | null =
          feature.geometry?.type === 'Point'
            ? { type: 'Point', coordinates: [numeric(longitude.value), numeric(latitude.value)] }
            : JSON.parse(geometry.value);
        actions.push({
          type: 'replaceGeometry',
          layerId: layer.id,
          featureId: feature.id,
          geometry: next,
        });
      }
    }
    if (styleDirty) {
      const w = structuredClone(snapshot.content.workspace ?? emptyGeoWorkspace());
      const s: GeoLayerStyle = {
        layerId: styleLayer,
        visible: visible.checked,
        mode: mode.value as GeoLayerStyle['mode'],
        color: color.value,
        missingColor: missingColor.value,
        radius: numeric(radius.value),
        fieldId: field.value || null,
        labelFieldId: labelField.value || null,
        categories: JSON.parse(categories.value),
        boundaries: boundaries.value.trim()
          ? boundaries.value.split(',').map((s) => numeric(s.trim()))
          : [],
        colors: colors.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        filter: filterField.value
          ? { fieldId: filterField.value, value: JSON.parse(filterValue.value) }
          : null,
        metric:
          metricKind.value === 'none'
            ? null
            : {
                kind: metricKind.value as 'count' | 'rate',
                numerator: numerator.value,
                denominator: metricKind.value === 'rate' ? denominator.value : null,
                multiplier: numeric(multiplier.value),
                indicator: indicator.value,
                unit: unit.value,
                period: period.value,
              },
      };
      w.styles = [...w.styles.filter((s) => s.layerId !== styleLayer), s];
      actions.push({ type: 'setWorkspace', workspace: w });
    }
    return actions;
  }
  const binding = editor.bindInputs({
    label: 'Geographic feature and presentation',
    read: () => ({ dirty: featureDirty || styleDirty, composing: composing.size > 0 }),
    prepare: (snapshot) => host.prepare(snapshot, buildActions(snapshot)),
    committed: (snapshot) => {
      featureDirty = styleDirty = false;
      composing.clear();
      base = snapshot;
    },
    focus: () => form.querySelector<HTMLElement>('input,textarea')?.focus(),
  });
  const apply = button(toolbar, 'Apply', () => editor.applyInputs());
  const cancel = button(toolbar, 'Cancel', () => {
    if (composing.size) throw Error('Finish composition first');
    featureDirty = styleDirty = false;
    base = open().snapshot;
    binding.changed();
    renderForms();
    status.textContent = 'Cancelled. Native unchanged.';
    updateButtons();
  });
  const undo = button(toolbar, 'Undo', () => editor.undo()),
    redo = button(toolbar, 'Redo', () => editor.redo());
  const mutate = (actions: GeoAction[]) => {
    requireClean();
    const v = open();
    return editor.execute(host.prepare(v.snapshot, actions));
  };
  function updateButtons() {
    const v = editor.getSnapshot(),
      editable = !closed && v.state === 'open' && v.canEdit;
    apply.disabled = !editable || !pending() || composing.size > 0;
    cancel.disabled = !pending() || composing.size > 0;
    undo.disabled = redo.disabled = !editable || pending();
  }
  const choose = (layerId: string, featureId: string) => {
    requireClean();
    const focusOrigin = map.contains(doc.activeElement)
      ? map
      : table.contains(doc.activeElement)
        ? table
        : null;
    selected = { layerId, featureId };
    scalarField = '';
    renderForms();
    renderMapTable();
    if (focusOrigin === map) {
      const target = [...map.querySelectorAll<SVGGElement>('[data-feature-id]')].find(
        (n) => n.dataset.featureId === featureId && n.dataset.layerId === layerId,
      );
      target?.focus();
    } else if (focusOrigin === table)
      [...table.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.startsWith(featureId + ' · '))
        ?.focus();
    status.textContent = `Selected ${layerId}/${featureId}`;
  };
  const panelButtons: HTMLButtonElement[] = [];
  for (const [label, panel] of [
    ['Map', mapPanel],
    ['Table', tablePanel],
    ['Inspector', inspector],
  ] as const)
    panelButtons.push(
      button(tabs, label, () => {
        // Panels stay mounted so mobile switching preserves input, composition and selection.
        for (const p of [mapPanel, tablePanel, inspector]) p.hidden = p !== panel;
        sourcePanel.hidden = panel !== mapPanel;
        for (const b of panelButtons)
          b.setAttribute('aria-pressed', String(b.textContent === label));
      }),
    );
  button(tabs, 'Show all panels', () => {
    for (const p of [sourcePanel, mapPanel, tablePanel, inspector]) p.hidden = false;
  });
  function renderForms() {
    if (closed || pending()) return;
    const v = open();
    base = v.snapshot;
    const content = v.snapshot.content;
    if (
      !selected ||
      !content.layers
        .find((l) => l.id === selected?.layerId)
        ?.features.some((f) => f.id === selected?.featureId)
    ) {
      const layer = content.layers.find((l) => l.features.length);
      selected = layer ? { layerId: layer.id, featureId: layer.features[0].id } : null;
    }
    form.replaceChildren();
    if (selected) {
      const { layer, feature } = currentFeature();
      form.append(
        node('h3', 'Feature'),
        node('p', `${layer.id} / ${feature.id} / row ${feature.rowId}`),
      );
      const ownFields = layer.fields;
      if (!ownFields.some((f) => f.id === scalarField)) scalarField = ownFields[0]?.id ?? '';
      const fieldSelect = select(
        form,
        'Scalar field',
        ownFields.map((f) => ({ value: f.id, label: `${f.name} (${f.type})` })),
        scalarField,
      );
      fieldSelect.onchange = () => {
        const next = fieldSelect.value;
        void run(() => {
          requireClean();
          scalarField = next;
          renderForms();
        });
        if (pending()) fieldSelect.value = scalarField;
      };
      const scalar = feature.values[scalarField] ?? null;
      value = input(form, 'Scalar value', scalar === null ? '' : String(scalar));
      isNull = input(form, 'Scalar is null', '', 'checkbox');
      isNull.checked = scalar === null;
      longitude = input(
        form,
        'Longitude',
        feature.geometry?.type === 'Point' ? String(feature.geometry.coordinates[0]) : '',
      );
      latitude = input(
        form,
        'Latitude',
        feature.geometry?.type === 'Point' ? String(feature.geometry.coordinates[1]) : '',
      );
      geometry = textArea(form, 'Geometry JSON', JSON.stringify(feature.geometry));
      let geometryReadonly = false;
      try {
        assertEditableGeometry(feature.geometry);
      } catch {
        geometryReadonly = true;
      }
      geometry.disabled = geometryReadonly || !v.canEdit;
      longitude.disabled = latitude.disabled =
        geometryReadonly || feature.geometry?.type !== 'Point' || !v.canEdit;
      geometry.hidden = feature.geometry?.type === 'Point';
      if (geometryReadonly)
        form.append(
          node(
            'p',
            'Multi/holes are preserved; geometry editing is unavailable. Scalar attributes remain editable.',
          ),
        );
      for (const control of [value, isNull, longitude, latitude, geometry])
        watch(control, 'feature');
      value.disabled = isNull.disabled = !v.canEdit || !ownFields.length;
      button(form, 'Delete selected feature', () => {
        const w = workspace();
        w.assets = w.assets.filter((a) => a.layerId !== layer.id || a.featureId !== feature.id);
        return mutate([
          { type: 'setWorkspace', workspace: w },
          { type: 'deleteFeature', layerId: layer.id, featureId: feature.id },
        ]);
      });
    } else form.append(node('p', 'Import a layer or create a feature.'));
    presentation.replaceChildren();
    presentation.append(node('h3', 'Layer presentation'));
    if (!content.layers.some((l) => l.id === styleLayer))
      styleLayer = selected?.layerId ?? content.layers[0]?.id ?? '';
    const layerSelect = select(
      presentation,
      'Style layer',
      content.layers.map((l) => ({ value: l.id, label: l.name })),
      styleLayer,
    );
    layerSelect.onchange = () => {
      const next = layerSelect.value;
      void run(() => {
        requireClean();
        styleLayer = next;
        renderForms();
      });
      if (pending()) layerSelect.value = styleLayer;
    };
    const layer = content.layers.find((l) => l.id === styleLayer);
    if (!layer) return;
    const s =
        content.workspace?.styles.find((s) => s.layerId === layer.id) ?? defaultGeoStyle(layer.id),
      fields = geoFields(content, layer);
    const choices = [
      { value: '', label: '(none)' },
      ...fields.map((f) => ({ value: f.id, label: f.name })),
    ];
    visible = input(presentation, 'Layer visible', '', 'checkbox');
    visible.checked = s.visible;
    mode = select(
      presentation,
      'Symbol mode',
      ['single', 'category', 'classes', 'proportional'].map((x) => ({ value: x, label: x })),
      s.mode,
    );
    field = select(presentation, 'Style field', choices, s.fieldId ?? '');
    labelField = select(presentation, 'Label field', choices, s.labelFieldId ?? '');
    color = input(presentation, 'Symbol color', s.color);
    missingColor = input(presentation, 'Missing color', s.missingColor);
    radius = input(presentation, 'Symbol radius', String(s.radius));
    categories = textArea(presentation, 'Categories JSON', JSON.stringify(s.categories));
    boundaries = input(presentation, 'Class boundaries', s.boundaries.join(','));
    colors = input(presentation, 'Class colors', s.colors.join(','));
    metricKind = select(
      presentation,
      'Metric kind',
      ['none', 'count', 'rate'].map((x) => ({ value: x, label: x })),
      s.metric?.kind ?? 'none',
    );
    numerator = select(presentation, 'Numerator field', choices, s.metric?.numerator ?? '');
    denominator = select(presentation, 'Denominator field', choices, s.metric?.denominator ?? '');
    multiplier = input(presentation, 'Rate multiplier', String(s.metric?.multiplier ?? 1));
    indicator = input(presentation, 'Indicator', s.metric?.indicator ?? '');
    unit = input(presentation, 'Unit', s.metric?.unit ?? '');
    period = input(presentation, 'Period', s.metric?.period ?? '');
    filterField = select(presentation, 'Filter field', choices, s.filter?.fieldId ?? '');
    filterValue = input(
      presentation,
      'Filter value (JSON scalar)',
      JSON.stringify(s.filter?.value ?? null),
    );
    for (const control of [
      visible,
      mode,
      field,
      labelField,
      color,
      missingColor,
      radius,
      categories,
      boundaries,
      colors,
      metricKind,
      numerator,
      denominator,
      multiplier,
      indicator,
      unit,
      period,
      filterField,
      filterValue,
    ]) {
      control.disabled = !v.canEdit;
      watch(control, 'style');
    }
    presentation.append(
      node(
        'p',
        'Choose denominator, unit, period and class boundaries explicitly. Zero is a value; missing and zero denominator are separate diagnostics. Joined fields are read-only.',
      ),
    );
  }
  function renderMapTable() {
    if (closed || editor.getSnapshot().state !== 'open') return;
    const content = open().snapshot.content,
      view = content.workspace?.views.find((v) => v.id === activeView);
    // The SVG comes exclusively from the escaped, validated domain serializer.
    map.innerHTML = renderGeoSvg(
      content,
      { extent, width: 960, height: 560, selected, view, includeLegend: false, interactive: true },
      host.budgets,
    );
    for (const target of map.querySelectorAll<SVGGElement>('[data-feature-id]')) {
      const selectTarget = () => choose(target.dataset.layerId!, target.dataset.featureId!);
      target.addEventListener('click', () => void run(selectTarget));
      target.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void run(selectTarget);
        }
      });
    }
    sourcePanel.replaceChildren(node('h3', 'Layers and sources'));
    for (const l of content.layers) {
      const section = node('section');
      section.append(
        node('strong', l.name),
        node('p', `${l.features.length} features · ${l.fields.length} scalar fields · ${l.crs}`),
      );
      button(section, `Inspect layer ${l.name}`, () => {
        requireClean();
        styleLayer = l.id;
        renderForms();
      });
      const fields = node('details'),
        summary = node('summary', 'Field definitions');
      fields.append(
        summary,
        node('pre', l.fields.map((f) => `${f.name}: ${f.type} (${f.id})`).join('\n')),
      );
      section.append(fields);
      sourcePanel.append(section);
    }
    for (const source of content.sources) {
      const detail = node('details'),
        summary = node('summary', source.id + ' · ' + source.format);
      detail.append(
        summary,
        node('p', source.attribution),
        node('p', source.adapterVersion),
        node('code', JSON.stringify(source.pin)),
      );
      if (host.original)
        button(detail, `Export original ${source.id}`, () => {
          requireClean();
          const stamp = host.stamp(),
            original = host.original!(source.id),
            url = URL.createObjectURL(
              new Blob([new Uint8Array(original.bytes)], { type: original.mediaType }),
            ),
            link = node(
              'a',
              'Download selected original (includes its original attributes/photos)',
            );
          urls.add(url);
          link.href = url;
          link.download = original.name;
          link.onclick = (e) => {
            try {
              if (!urls.has(url) || host.stamp() !== stamp)
                throw Error('Original download retired');
            } catch {
              e.preventDefault();
              retire();
            }
          };
          downloads.append(link, node('br'));
          status.textContent =
            'Selected original ready. Original files may include attributes excluded from data exchange.';
        });
      sourcePanel.append(detail);
    }
    legend.replaceChildren();
    table.replaceChildren();
    for (const layer of content.layers) {
      const s =
        view?.styles.find((s) => s.layerId === layer.id) ??
        content.workspace?.styles.find((s) => s.layerId === layer.id) ??
        defaultGeoStyle(layer.id);
      const description = node(
        'p',
        `${layer.name}: ${s.metric ? `${s.metric.indicator} · ${s.metric.unit} · ${s.metric.period}` : s.mode}. ${geoLegend(
          s,
        )
          .map((e) => e.label)
          .join('; ')}`,
      );
      legend.append(description);
      const heading = node('h3', layer.name),
        grid = node('table'),
        head = node('thead'),
        header = node('tr'),
        body = node('tbody');
      grid.setAttribute('aria-label', `${layer.name} attributes`);
      const fields = geoFields(content, layer);
      for (const title of [
        'Feature / geometry',
        ...fields.map((f) => `${f.name} (${f.type})`),
        'Metric status',
      ])
        header.append(node('th', title));
      head.append(header);
      grid.append(head, body);
      let shown = 0;
      for (const feature of layer.features) {
        if (s.filter && geoValue(content, layer.id, feature, s.filter.fieldId) !== s.filter.value)
          continue;
        shown++;
        const row = node('tr');
        row.setAttribute(
          'aria-selected',
          String(selected?.featureId === feature.id && selected.layerId === layer.id),
        );
        const first = node('td');
        const b = button(
          first,
          `${feature.id} · ${feature.geometry?.type ?? 'null geometry'}`,
          () => choose(layer.id, feature.id),
        );
        b.setAttribute(
          'aria-pressed',
          String(selected?.featureId === feature.id && selected.layerId === layer.id),
        );
        row.append(first);
        for (const f of fields)
          row.append(node('td', JSON.stringify(geoValue(content, layer.id, feature, f.id))));
        const metric = geoMetricValue(content, layer.id, feature, s);
        row.append(
          node('td', `${metric.status}${metric.value === null ? '' : `: ${metric.value}`}`),
        );
        body.append(row);
      }
      table.append(
        heading,
        node(
          'p',
          `${shown} / ${layer.features.length} rows; hidden/null geometry records are retained.`,
        ),
        grid,
      );
    }
  }
  const camera = node('fieldset');
  camera.append(node('legend', 'Camera and saved views'));
  root.append(camera);
  const move = (x: number, y: number, zoom = 1) => {
    const dx = Math.min(360, (extent[2] - extent[0]) / zoom),
      dy = Math.min(180, (extent[3] - extent[1]) / zoom);
    let cx = (extent[0] + extent[2]) / 2 + x * (extent[2] - extent[0]),
      cy = (extent[1] + extent[3]) / 2 + y * (extent[3] - extent[1]);
    cx = ((((cx + 180) % 360) + 360) % 360) - 180;
    cy = Math.max(-90 + dy / 2, Math.min(90 - dy / 2, cy));
    extent = [
      Math.max(-180, cx - dx / 2),
      cy - dy / 2,
      Math.max(-180, cx - dx / 2) + Math.min(360, dx),
      cy + dy / 2,
    ];
    activeView = '';
    renderMapTable();
  };
  button(toolbar, 'Fit map', () => {
    extent = fitGeoExtent(open().snapshot.content);
    activeView = '';
    renderMapTable();
  });
  for (const [name, x, y, z] of [
    ['Pan west', -0.2, 0, 1],
    ['Pan east', 0.2, 0, 1],
    ['Pan north', 0, 0.2, 1],
    ['Pan south', 0, -0.2, 1],
    ['Zoom in', 0, 0, 2],
    ['Zoom out', 0, 0, 0.5],
  ] as const)
    button(toolbar, name, () => move(x, y, z));
  const viewName = input(camera, 'View name', 'Comparison view'),
    viewSelect = select(camera, 'Saved view', [], '');
  button(camera, 'Save named view', () => {
    const w = workspace(),
      id = `view-${crypto.randomUUID()}`;
    w.views.push({
      id,
      name: viewName.value,
      extent: [...extent],
      styles: open().snapshot.content.layers.map((l) =>
        structuredClone(w.styles.find((s) => s.layerId === l.id) ?? defaultGeoStyle(l.id)),
      ),
      annotations: structuredClone(w.annotations),
    });
    return mutate([{ type: 'setWorkspace', workspace: w }]);
  });
  button(camera, 'Use saved view', () => {
    const v = workspace().views.find((v) => v.id === viewSelect.value);
    if (!v) throw Error('Choose a saved view');
    activeView = v.id;
    extent = [...v.extent];
    renderMapTable();
  });
  const annotationText = input(camera, 'Annotation text'),
    annotationLon = input(camera, 'Annotation longitude', '0'),
    annotationLat = input(camera, 'Annotation latitude', '0');
  button(camera, 'Add annotation', () => {
    const w = workspace();
    w.annotations.push({
      id: `annotation-${crypto.randomUUID()}`,
      text: annotationText.value,
      position: [numeric(annotationLon.value), numeric(annotationLat.value)],
    });
    return mutate([{ type: 'setWorkspace', workspace: w }]);
  });
  const creation = node('fieldset');
  creation.append(node('legend', 'Create geometry'));
  root.append(creation);
  const createLayer = select(creation, 'Creation layer', []),
    kind = select(
      creation,
      'Geometry type',
      ['Point', 'LineString', 'Polygon'].map((x) => ({ value: x, label: x })),
      'Point',
    );
  const coordinates = textArea(creation, 'New coordinates JSON', '[0,0]');
  button(creation, 'Create feature', () => {
    const content = open().snapshot.content,
      layer = content.layers.find((l) => l.id === createLayer.value),
      id = crypto.randomUUID();
    const feature = {
      id: `feature-${id}`,
      rowId: `row-${id}`,
      geometry: { type: kind.value, coordinates: JSON.parse(coordinates.value) } as Geometry,
      values: Object.fromEntries((layer?.fields ?? []).map((f) => [f.id, null])),
    };
    const action: GeoAction = layer
      ? { type: 'addFeature', layerId: layer.id, feature }
      : {
          type: 'createLayer',
          layer: {
            id: `layer-${id}`,
            name: 'Manual layer',
            crs: 'OGC:CRS84',
            axis: 'longitude-latitude',
            fields: [{ id: 'name', name: 'Name', type: 'string' }],
            features: [{ ...feature, values: { name: null } }],
          },
        };
    return mutate([action]);
  });
  const analysis = node('fieldset');
  analysis.append(node('legend', 'Pinned region comparison'));
  root.append(analysis);
  const joinLeft = select(analysis, 'Boundary layer', []),
    joinRight = select(analysis, 'Table layer', []),
    leftKey = input(analysis, 'Boundary key field ID'),
    rightKey = input(analysis, 'Table key field ID');
  const cardinality = select(
    analysis,
    'Join cardinality',
    ['one-to-one', 'many-to-one'].map((x) => ({ value: x, label: x })),
    'one-to-one',
  );
  button(analysis, 'Create pinned join', async () => {
    requireClean();
    const request = {
      id: `join-${crypto.randomUUID()}`,
      layerId: joinLeft.value,
      tableLayerId: joinRight.value,
      leftFieldId: leftKey.value,
      rightFieldId: rightKey.value,
      cardinality: cardinality.value as 'one-to-one' | 'many-to-one',
    };
    const stamp = host.stamp(),
      capture = await host.capture();
    if (host.stamp() !== stamp) throw Error('Scope or input changed');
    if ('sha256:' + (await contentHash(open().snapshot.content)) !== capture.pin.contentHash)
      throw Error('Save current native version before joining');
    if (host.stamp() !== stamp) throw Error('Scope or input changed');
    const join = createPinnedGeoJoin(capture.content, capture.pin, request, host.budgets);
    const w = workspace();
    w.joins.push(join);
    const result = mutate([{ type: 'setWorkspace', workspace: w }]);
    status.textContent = `Join: ${join.rows.filter((r) => r.status === 'matched').length} matched; ${join.rows.filter((r) => r.status === 'unmatched').length} unmatched; ${join.rows.filter((r) => r.status === 'null-key').length} null keys. No duplicate first-match.`;
    return result;
  });
  const refreshTarget = select(analysis, 'Refresh original layer', []),
    refreshIncoming = select(analysis, 'Refresh imported candidate', []),
    refreshPreview = node('pre');
  analysis.append(refreshPreview);
  let refreshTicket: { stamp: string; target: string; incoming: string } | undefined;
  const replacementFile = input(analysis, 'Replacement source file', '', 'file');
  replacementFile.accept = '.csv,.geojson,.json';
  const replacementPartial = input(
    analysis,
    'Explicitly exclude the listed invalid replacement rows',
    '',
    'checkbox',
  );
  replacementPartial.dataset.adoptionConsent = 'true';
  let replacementToken: string | undefined;
  replacementFile.addEventListener('change', () => {
    replacementToken = undefined;
    refreshPreview.textContent = '';
  });
  refreshTarget.addEventListener('change', () => {
    replacementToken = undefined;
    refreshPreview.textContent = '';
  });
  button(analysis, 'Preview replacement file', async () => {
    requireClean();
    const file = replacementFile.files?.[0],
      target = refreshTarget.value,
      stamp = host.stamp();
    if (!file || file.size > 100000)
      throw Error('Choose a replacement CSV/GeoJSON up to 100,000 bytes');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (stamp !== host.stamp()) throw Error('Replacement scope changed');
    const result = await host.previewRefreshFile(target, bytes, file.name);
    replacementToken = result.token;
    replacementPartial.checked = false;
    refreshPreview.textContent = JSON.stringify(result, null, 2);
  });
  button(analysis, 'Apply previewed replacement', () => {
    requireClean();
    if (!replacementToken) throw Error('Preview the replacement first');
    return host.applyRefreshFile(replacementToken, replacementPartial.checked);
  });
  button(analysis, 'Preview source refresh', () => {
    requireClean();
    const content = open().snapshot.content,
      a = content.layers.find((l) => l.id === refreshTarget.value),
      b = content.layers.find((l) => l.id === refreshIncoming.value);
    if (!a || !b || a === b) throw Error('Choose two distinct imported layers');
    const preview = previewGeoRefresh(a, b);
    refreshPreview.textContent = JSON.stringify(preview.changes, null, 2);
    refreshTicket = { stamp: host.stamp(), target: a.id, incoming: b.id };
  });
  button(analysis, 'Apply previewed source refresh', () => {
    if (!refreshTicket || host.stamp() !== refreshTicket.stamp)
      throw Error('Refresh preview is stale; preview again');
    const result = host.refresh(refreshTicket.target, refreshTicket.incoming);
    refreshTicket = undefined;
    return result;
  });
  const comparison = node('fieldset');
  comparison.append(node('legend', 'Two retained versions'));
  root.append(comparison);
  const beforeVersion = select(comparison, 'Before version', []),
    afterVersion = select(comparison, 'After version', []),
    comparisonFields = input(comparison, 'Comparison field IDs (comma separated)'),
    tolerance = input(comparison, 'Coordinate tolerance (degrees)', '0'),
    coverage = input(comparison, 'Both captures have complete coverage', '', 'checkbox'),
    comparisonResults = node('pre');
  comparison.append(comparisonResults);
  button(comparison, 'Compare retained versions', async () => {
    requireClean();
    const requestedBefore = beforeVersion.value,
      requestedAfter = afterVersion.value;
    const request = {
      id: `comparison-${crypto.randomUUID()}`,
      fieldIds: comparisonFields.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      toleranceDegrees: numeric(tolerance.value),
      completeCoverage: coverage.checked,
    };
    const stamp = host.stamp(),
      before = await host.capture(requestedBefore),
      after = await host.capture(requestedAfter);
    if (host.stamp() !== stamp) throw Error('Comparison scope changed');
    const result = compareGeoVersions(before, after, request, host.budgets);
    const w = workspace();
    w.comparisons.push(result);
    comparisonResults.textContent = JSON.stringify(result, null, 2);
    return mutate([{ type: 'setWorkspace', workspace: w }]);
  });
  const assetPanel = node('fieldset');
  assetPanel.append(node('legend', 'Selected asset inspection'));
  root.append(assetPanel);
  const assetId = input(assetPanel, 'Asset ID'),
    inspectionDate = input(assetPanel, 'Inspection date'),
    accuracy = input(assetPanel, 'Location accuracy (meters)'),
    notes = textArea(assetPanel, 'Asset notes'),
    photoFile = input(assetPanel, 'Local inspection photo', '', 'file');
  photoFile.accept = 'image/png,image/jpeg';
  const asset = (): GeoAsset => {
    if (!selected) throw Error('Select an asset feature');
    const old = workspace().assets.find(
      (a) => a.layerId === selected!.layerId && a.featureId === selected!.featureId,
    );
    return {
      ...selected,
      assetId: assetId.value,
      inspectedAt: inspectionDate.value,
      accuracyMeters: accuracy.value.trim() ? numeric(accuracy.value) : null,
      notes: notes.value,
      photos: old?.photos ?? [],
    };
  };
  button(assetPanel, 'Save asset inspection', () => {
    const a = asset(),
      w = workspace();
    w.assets = [
      ...w.assets.filter((x) => x.layerId !== a.layerId || x.featureId !== a.featureId),
      a,
    ];
    return mutate([{ type: 'setWorkspace', workspace: w }]);
  });
  button(assetPanel, 'Attach selected local photo', async () => {
    requireClean();
    const target = asset(),
      stamp = host.stamp();
    const file = photoFile.files?.[0];
    if (!file || file.size > 100000) throw Error('Choose a local PNG/JPEG up to 100,000 bytes');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (host.stamp() !== stamp) throw Error('Photo input changed');
    return host.attachPhoto(target, bytes, file.name);
  });
  button(assetPanel, 'Inspect retained photos', async () => {
    const a = asset();
    for (const p of a.photos) {
      const bytes = host.photo(p.sourceId);
      const image = node('img');
      const source = open().snapshot.content.sources.find((s) => s.id === p.sourceId);
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], {
          type: source?.format === 'png' ? 'image/png' : 'image/jpeg',
        }),
      );
      urls.add(url);
      image.src = url;
      image.alt = p.name;
      image.width = 160;
      downloads.append(image);
      await image.decode();
    }
  });
  const imageExport = node('fieldset');
  imageExport.append(node('legend', 'Fixed PNG and Slide image'));
  root.append(imageExport);
  const pngView = select(imageExport, 'PNG saved view', []),
    pngWidth = input(imageExport, 'PNG width', '960'),
    pngHeight = input(imageExport, 'PNG height', '600');
  imageExport.append(
    node(
      'p',
      'PNG uses the explicitly selected saved native version and named view. Source bytes, hidden attributes, inspection notes and photos are omitted. Export native to preserve all data. Download the receipt alongside the image.',
    ),
  );
  button(imageExport, 'Generate fixed PNG', async () => {
    requireClean();
    retire();
    const generation = outputGeneration,
      viewId = pngView.value;
    const pixels: [number, number] = [numeric(pngWidth.value), numeric(pngHeight.value)];
    const check = () => {
      if (generation !== outputGeneration || host.stamp() !== stamp)
        throw Error('PNG scope changed');
    };
    const stamp = host.stamp(),
      capture = await host.capture();
    check();
    const bundle = await createGeoPng(doc, capture, viewId, pixels, host.budgets, check);
    check();
    png = { bundle, stamp };
    for (const [blob, name, label] of [
      [
        new Blob([new Uint8Array(bundle.bytes)], { type: 'image/png' }),
        'map.png',
        'Download fixed PNG',
      ],
      [
        new Blob([JSON.stringify(bundle.receipt, null, 2)], { type: 'application/json' }),
        'map.receipt.json',
        'Download PNG receipt',
      ],
    ] as const) {
      const url = URL.createObjectURL(blob),
        a = node('a', label);
      urls.add(url);
      a.href = url;
      a.download = name;
      a.onclick = (e) => {
        try {
          if (host.stamp() !== stamp || !urls.has(url)) throw Error('PNG no longer authorized');
        } catch {
          e.preventDefault();
          retire();
        }
      };
      downloads.append(a, node('br'));
    }
    status.textContent = 'PNG and provenance receipt ready.';
  });
  button(imageExport, 'Place PNG on Slide', async () => {
    const issued = png;
    if (!issued || host.stamp() !== issued.stamp)
      throw Error('Generate an authorized fixed PNG first');
    const artifact = await host.placeOnSlide(issued.bundle);
    if (png !== issued || host.stamp() !== issued.stamp)
      throw Error('Slide transfer scope changed');
    const url = URL.createObjectURL(new Blob([artifact.text], { type: 'application/json' })),
      link = node('a', 'Download Slide with fixed map image');
    urls.add(url);
    link.href = url;
    link.download = artifact.name;
    link.onclick = (e) => {
      try {
        if (!urls.has(url) || host.stamp() !== issued.stamp) throw Error('Slide transfer retired');
      } catch {
        e.preventDefault();
        retire();
      }
    };
    downloads.append(
      link,
      node(
        'p',
        'Open the downloaded native file in Slide. The fixed PNG and its provenance receipt are retained in the slide image and notes.',
      ),
    );
  });
  imageExport.append(downloads);
  const fillSelect = (target: HTMLSelectElement, values: { value: string; label: string }[]) => {
    const prior = target.value;
    target.replaceChildren(
      ...values.map((v) => {
        const o = node('option', v.label);
        o.value = v.value;
        return o;
      }),
    );
    if (values.some((v) => v.value === prior)) target.value = prior;
  };
  let refreshEpoch = 0;
  function refresh() {
    if (closed || editor.getSnapshot().state !== 'open') {
      retire();
      updateButtons();
      return;
    }
    renderForms();
    renderMapTable();
    updateButtons();
    const content = open().snapshot.content,
      choices = content.layers.map((l) => ({ value: l.id, label: l.name }));
    for (const s of [createLayer, joinLeft, joinRight, refreshTarget, refreshIncoming])
      fillSelect(s, choices);
    const views = (content.workspace?.views ?? []).map((v) => ({ value: v.id, label: v.name }));
    for (const s of [viewSelect, pngView]) fillSelect(s, views);
    const token = ++refreshEpoch;
    void host
      .versions()
      .then((v) => {
        if (closed || token !== refreshEpoch) return;
        const list = v.versionIds.map((id) => ({
          value: id,
          label: id + (id === v.head ? ' (latest)' : ''),
        }));
        fillSelect(beforeVersion, list);
        fillSelect(afterVersion, list);
      })
      .catch(showError);
    if (selected && !pending()) {
      const a = content.workspace?.assets.find(
        (a) => a.layerId === selected!.layerId && a.featureId === selected!.featureId,
      );
      assetId.value = a?.assetId ?? selected.featureId;
      inspectionDate.value = a?.inspectedAt ?? '';
      accuracy.value =
        a?.accuracyMeters === null || a?.accuracyMeters === undefined
          ? ''
          : String(a.accuracyMeters);
      notes.value = a?.notes ?? '';
    }
    comparisonResults.textContent = JSON.stringify(content.workspace?.comparisons ?? [], null, 2);
  }
  const stop = editor.subscribe(() => {
    retire();
    refresh();
  });
  const dispose = () => {
    if (closed) return;
    closed = true;
    retire();
    stop();
    binding.unregister();
    host.signal.removeEventListener('abort', dispose);
    root.replaceChildren(node('p', 'Scope closed.'));
  };
  host.signal.addEventListener('abort', dispose, { once: true });
  refresh();
  return { element: root, retire, dispose };
}
