import { defaultGeoBackgroundSettings } from '@editor-platform/geo-core/backgrounds';
import {
  assertGeoExtent,
  emptyGeoWorkspace,
  fitGeoExtent,
  type GeoAction,
  type GeoDocument,
} from '@editor-platform/geo-core';
import type { ControlledSurfaceController } from '@editor-platform/extension-contract/controlled-surface';
import type { GeoWorkspaceHost } from './port';
import { buildGeoInputActions } from './surface-actions';
import type {
  GeoFormControls,
  GeoFormControl,
  GeoInputBinding,
  GeoSurfaceContext,
  GeoSurfaceElements,
  GeoSurfaceState,
} from './surface-context';
import { createGeoDomKit, geoWorkspaceCss, type GeoDomKit } from './surface-dom';
import { renderGeoForms } from './surface-forms';
import { renderGeoMapTable } from './surface-map';
import { buildGeoAssetPanel, buildGeoImageExportPanel } from './surface-outputs';
import {
  buildGeoAnalysisPanel,
  buildGeoCameraPanel,
  buildGeoComparisonPanel,
  buildGeoCreationPanel,
  renderGeoBackgroundControls,
} from './surface-panels';

function buildBackgroundPanel(kit: GeoDomKit, mapPanel: HTMLElement) {
  const { node } = kit;
  // Below the map so the map stays in the first screen; open, so every setting stays reachable.
  const backgroundDetails = node('details'),
    backgroundPanel = node('fieldset'),
    backgroundControls = node('div'),
    backgroundStatus = node('p');
  backgroundDetails.open = true;
  backgroundPanel.append(
    node('legend', 'Read-only boundary backgrounds'),
    backgroundControls,
    backgroundStatus,
    node(
      'p',
      'Save a named view to use these backgrounds in PNG and Slide. Boundaries are simplified historical outlines; they cannot be selected or edited and are excluded from GeoJSON/CSV.',
    ),
  );
  backgroundStatus.setAttribute('role', 'status');
  backgroundStatus.setAttribute('aria-label', 'Boundary background status');
  backgroundDetails.append(node('summary', 'Boundary backgrounds'), backgroundPanel);
  mapPanel.append(backgroundDetails);
  return { backgroundControls, backgroundStatus };
}

function buildPanels(kit: GeoDomKit) {
  const { node } = kit;
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
  return { sourcePanel, mapPanel, inspector, tablePanel, map, legend, form, presentation, table };
}

function buildSkeleton(kit: GeoDomKit): GeoSurfaceElements {
  const { node } = kit;
  const root = node('section');
  root.className = 'geo-workspace';
  root.setAttribute('aria-label', 'Geographic editor');
  const style = node('style', geoWorkspaceCss);
  const status = node('p', 'Choose a feature in the map or table.');
  status.className = 'geo-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-label', 'Geo edit status');
  const toolbar = node('div'),
    tabs = node('div'),
    layout = node('div');
  layout.className = 'geo-layout';
  const panels = buildPanels(kit);
  layout.append(panels.sourcePanel, panels.mapPanel, panels.inspector);
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
    panels.tablePanel,
  );
  const background = buildBackgroundPanel(kit, panels.mapPanel);
  return { root, status, toolbar, tabs, ...panels, ...background, downloads: node('div') };
}

const initialState = (): GeoSurfaceState => ({
  closed: false,
  featureDirty: false,
  styleDirty: false,
  base: undefined,
  selected: null,
  scalarField: '',
  styleLayer: '',
  extent: [-180, -90, 180, 90],
  activeView: '',
  // World countries are on from the start so a map has context, not just bare lines.
  // A named view saved from here keeps what is shown.
  backgroundSettings: defaultGeoBackgroundSettings().map((b) =>
    b.id === 'world-countries' ? { ...b, enabled: true } : b,
  ),
  backgroundTouched: true,
  png: undefined,
  outputGeneration: 0,
});

function retireOutputs(ctx: GeoSurfaceContext) {
  ctx.state.outputGeneration++;
  for (const url of ctx.urls) URL.revokeObjectURL(url);
  ctx.urls.clear();
  ctx.el.downloads.replaceChildren();
  ctx.state.png = undefined;
}

async function runGuarded(ctx: GeoSurfaceContext, work: () => unknown) {
  try {
    const result = await work();
    if (result && typeof result === 'object' && 'state' in result && result.state === 'refused')
      throw Error('message' in result ? String(result.message) : 'Operation refused');
  } catch (error) {
    ctx.showError(error);
  }
}

function markDirty(ctx: GeoSurfaceContext, kind: 'feature' | 'style') {
  const { state } = ctx;
  if (!ctx.pending()) state.base = ctx.open().snapshot;
  if (kind === 'feature') state.featureDirty = true;
  else state.styleDirty = true;
  ctx.binding.changed();
  ctx.retire();
  ctx.updateButtons();
}

function watchControl(ctx: GeoSurfaceContext, element: GeoFormControl, kind: 'feature' | 'style') {
  element.addEventListener('input', () => markDirty(ctx, kind));
  element.addEventListener('change', () => markDirty(ctx, kind));
  element.addEventListener('compositionstart', () => {
    markDirty(ctx, kind);
    ctx.composing.add(element);
    ctx.binding.changed();
    ctx.updateButtons();
  });
  element.addEventListener('compositionend', () => {
    ctx.composing.delete(element);
    ctx.binding.changed();
    ctx.updateButtons();
  });
}

function updateActionButtons(ctx: GeoSurfaceContext) {
  const { apply, cancel, undo, redo } = ctx.actionButtons;
  const v = ctx.editor.getSnapshot(),
    editable = !ctx.state.closed && v.state === 'open' && v.canEdit;
  apply.disabled = !editable || !ctx.pending() || ctx.composing.size > 0;
  cancel.disabled = !ctx.pending() || ctx.composing.size > 0;
  undo.disabled = redo.disabled = !editable || ctx.pending();
}

function focusChosen(
  ctx: GeoSurfaceContext,
  origin: HTMLElement,
  layerId: string,
  featureId: string,
) {
  const { map, table } = ctx.el;
  if (origin === map) {
    const target = [...map.querySelectorAll<SVGGElement>('[data-feature-id]')].find(
      (n) => n.dataset.featureId === featureId && n.dataset.layerId === layerId,
    );
    target?.focus();
  } else
    [...table.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.startsWith(featureId + ' · '))
      ?.focus();
}

function chooseFeature(ctx: GeoSurfaceContext, layerId: string, featureId: string) {
  const { map, table } = ctx.el;
  ctx.requireClean();
  const active = ctx.doc.activeElement;
  const focusOrigin = map.contains(active) ? map : table.contains(active) ? table : null;
  ctx.state.selected = { layerId, featureId };
  ctx.state.scalarField = '';
  ctx.renderForms();
  ctx.renderMapTable();
  if (focusOrigin) focusChosen(ctx, focusOrigin, layerId, featureId);
  ctx.el.status.textContent = `Selected ${layerId}/${featureId}`;
}

function createContext(
  doc: Document,
  editor: ControlledSurfaceController<GeoDocument>,
  host: GeoWorkspaceHost,
): GeoSurfaceContext {
  const kit = createGeoDomKit(doc);
  const ctx: GeoSurfaceContext = {
    doc,
    editor,
    host,
    kit,
    el: buildSkeleton(kit),
    state: initialState(),
    controls: {} as GeoFormControls,
    composing: new Set<EventTarget>(),
    urls: new Set<string>(),
    binding: undefined as unknown as GeoInputBinding,
    actionButtons: undefined as unknown as GeoSurfaceContext['actionButtons'],
    retire: () => retireOutputs(ctx),
    open: () => {
      const v = editor.getSnapshot();
      if (ctx.state.closed || host.signal.aborted || v.state !== 'open')
        throw Error('ScopeRevoked');
      return v;
    },
    pending: () => ctx.state.featureDirty || ctx.state.styleDirty || ctx.composing.size > 0,
    requireClean: () => {
      if (ctx.pending()) throw Error('Apply or Cancel pending input first');
    },
    workspace: () => structuredClone(ctx.open().snapshot.content.workspace ?? emptyGeoWorkspace()),
    showError: (error) => {
      ctx.el.status.textContent = error instanceof Error ? error.message : String(error);
    },
    run: (work) => runGuarded(ctx, work),
    button: (parent, name, work) => {
      const b = kit.node('button', name);
      b.type = 'button';
      b.onclick = () => {
        if (!ctx.state.closed) void ctx.run(work);
      };
      parent.append(b);
      return b;
    },
    mutate: (actions: GeoAction[]) => {
      ctx.requireClean();
      const v = ctx.open();
      return editor.execute(host.prepare(v.snapshot, actions));
    },
    currentFeature: () => {
      const selected = ctx.state.selected;
      const content = ctx.open().snapshot.content,
        layer = content.layers.find((l) => l.id === selected?.layerId),
        feature = layer?.features.find((f) => f.id === selected?.featureId);
      if (!layer || !feature) throw Error('Feature missing');
      return { content, layer, feature };
    },
    watch: (element, kind) => watchControl(ctx, element, kind),
    choose: (layerId, featureId) => chooseFeature(ctx, layerId, featureId),
    updateButtons: () => updateActionButtons(ctx),
    renderForms: () => renderGeoForms(ctx),
    renderMapTable: () => renderGeoMapTable(ctx),
    renderBackgroundControls: () => renderGeoBackgroundControls(ctx),
  };
  return ctx;
}

function captureInputChanges(ctx: GeoSurfaceContext) {
  const inputChanged = (event: Event) => {
    ctx.retire();
    // Adoption consent is intentionally supplied after preview; it changes no input capture.
    if (!(event.target instanceof HTMLElement && event.target.dataset.adoptionConsent === 'true'))
      ctx.host.inputChanged?.();
  };
  for (const event of ['input', 'change', 'compositionstart', 'compositionend'])
    ctx.el.root.addEventListener(event, inputChanged, true);
}

function bindGeoInputs(ctx: GeoSurfaceContext): GeoInputBinding {
  const { state } = ctx;
  return ctx.editor.bindInputs({
    label: 'Geographic feature and presentation',
    read: () => ({
      dirty: state.featureDirty || state.styleDirty,
      composing: ctx.composing.size > 0,
    }),
    prepare: (snapshot) => ctx.host.prepare(snapshot, buildGeoInputActions(ctx, snapshot)),
    committed: (snapshot) => {
      state.featureDirty = state.styleDirty = false;
      ctx.composing.clear();
      state.base = snapshot;
    },
    focus: () => ctx.el.form.querySelector<HTMLElement>('input,textarea')?.focus(),
  });
}

function buildActionButtons(ctx: GeoSurfaceContext): GeoSurfaceContext['actionButtons'] {
  const { editor, state, el } = ctx;
  const apply = ctx.button(el.toolbar, 'Apply', () => editor.applyInputs());
  const cancel = ctx.button(el.toolbar, 'Cancel', () => {
    if (ctx.composing.size) throw Error('Finish composition first');
    state.featureDirty = state.styleDirty = false;
    state.base = ctx.open().snapshot;
    ctx.binding.changed();
    ctx.renderForms();
    el.status.textContent = 'Cancelled. Native unchanged.';
    ctx.updateButtons();
  });
  const undo = ctx.button(el.toolbar, 'Undo', () => editor.undo()),
    redo = ctx.button(el.toolbar, 'Redo', () => editor.redo());
  return { apply, cancel, undo, redo };
}

function buildPanelTabs(ctx: GeoSurfaceContext) {
  const { tabs, mapPanel, tablePanel, inspector, sourcePanel } = ctx.el;
  const layout = mapPanel.parentElement!;
  const panelButtons: HTMLButtonElement[] = [];
  for (const [label, panel] of [
    ['Map', mapPanel],
    ['Table', tablePanel],
    ['Inspector', inspector],
  ] as const)
    panelButtons.push(
      ctx.button(tabs, label, () => {
        // Panels stay mounted so mobile switching preserves input, composition and selection.
        // The chosen panel alone takes the full width.
        for (const p of [sourcePanel, mapPanel, tablePanel, inspector]) p.hidden = p !== panel;
        layout.dataset.panel = label.toLowerCase();
        for (const b of panelButtons)
          b.setAttribute('aria-pressed', String(b.textContent === label));
      }),
    );
  ctx.button(tabs, 'Show all panels', () => {
    for (const p of [sourcePanel, mapPanel, tablePanel, inspector]) p.hidden = false;
    delete layout.dataset.panel;
    for (const b of panelButtons) b.setAttribute('aria-pressed', 'false');
  });
}

type GeoRefreshTargets = ReturnType<typeof buildGeoCameraPanel> &
  ReturnType<typeof buildGeoCreationPanel> &
  ReturnType<typeof buildGeoAnalysisPanel> &
  ReturnType<typeof buildGeoComparisonPanel> &
  ReturnType<typeof buildGeoAssetPanel> &
  ReturnType<typeof buildGeoImageExportPanel>;

function fillLayerAndViewSelects(
  ctx: GeoSurfaceContext,
  t: GeoRefreshTargets,
  content: GeoDocument,
) {
  const choices = content.layers.map((l) => ({ value: l.id, label: l.name }));
  for (const s of [t.createLayer, t.joinLeft, t.joinRight, t.refreshTarget, t.refreshIncoming])
    ctx.kit.fillSelect(s, choices);
  const views = (content.workspace?.views ?? []).map((v) => ({ value: v.id, label: v.name }));
  for (const s of [t.viewSelect, t.pngView]) ctx.kit.fillSelect(s, views);
}

function loadVersionChoices(
  ctx: GeoSurfaceContext,
  t: GeoRefreshTargets,
  isCurrent: () => boolean,
) {
  void ctx.host
    .versions()
    .then((v) => {
      if (ctx.state.closed || !isCurrent()) return;
      const list = v.versionIds.map((id) => ({
        value: id,
        label: id + (id === v.head ? ' (latest)' : ''),
      }));
      ctx.kit.fillSelect(t.beforeVersion, list);
      ctx.kit.fillSelect(t.afterVersion, list);
    })
    .catch(ctx.showError);
}

function fillAssetInputs(ctx: GeoSurfaceContext, t: GeoRefreshTargets, content: GeoDocument) {
  const selected = ctx.state.selected;
  if (!selected || ctx.pending()) return;
  const a = content.workspace?.assets.find(
    (a) => a.layerId === selected.layerId && a.featureId === selected.featureId,
  );
  t.assetId.value = a?.assetId ?? selected.featureId;
  t.inspectionDate.value = a?.inspectedAt ?? '';
  t.accuracy.value =
    a?.accuracyMeters === null || a?.accuracyMeters === undefined ? '' : String(a.accuracyMeters);
  t.notes.value = a?.notes ?? '';
}

function createRefresh(ctx: GeoSurfaceContext, t: GeoRefreshTargets) {
  let refreshEpoch = 0;
  return () => {
    if (ctx.state.closed || ctx.editor.getSnapshot().state !== 'open') {
      ctx.retire();
      ctx.updateButtons();
      return;
    }
    ctx.renderForms();
    ctx.renderMapTable();
    ctx.updateButtons();
    const content = ctx.open().snapshot.content;
    fillLayerAndViewSelects(ctx, t, content);
    const token = ++refreshEpoch;
    loadVersionChoices(ctx, t, () => token === refreshEpoch);
    fillAssetInputs(ctx, t, content);
    t.comparisonResults.textContent = JSON.stringify(content.workspace?.comparisons ?? [], null, 2);
  };
}

/** Opens on the features' extent; content without a valid fit keeps the whole world. */
function fitInitialExtent(ctx: GeoSurfaceContext) {
  try {
    const extent = fitGeoExtent(ctx.open().snapshot.content);
    assertGeoExtent(extent);
    ctx.state.extent = extent;
  } catch {
    // A closed scope or an unrenderable fit leaves the world extent.
  }
}

/** One controller/input group, one native history; camera, panels and selection stay private. */
export function createGeoWorkspaceSurface(
  doc: Document,
  editor: ControlledSurfaceController<GeoDocument>,
  host: GeoWorkspaceHost,
) {
  const ctx = createContext(doc, editor, host);
  const { el, state } = ctx;
  captureInputChanges(ctx);
  ctx.binding = bindGeoInputs(ctx);
  ctx.actionButtons = buildActionButtons(ctx);
  buildPanelTabs(ctx);
  const targets: GeoRefreshTargets = {
    ...buildGeoCameraPanel(ctx),
    ...buildGeoCreationPanel(ctx),
    ...buildGeoAnalysisPanel(ctx),
    ...buildGeoComparisonPanel(ctx),
    ...buildGeoAssetPanel(ctx),
    ...buildGeoImageExportPanel(ctx),
  };
  const refresh = createRefresh(ctx, targets);
  const stop = editor.subscribe(() => {
    ctx.retire();
    refresh();
  });
  const dispose = () => {
    if (state.closed) return;
    state.closed = true;
    ctx.retire();
    stop();
    ctx.binding.unregister();
    host.signal.removeEventListener('abort', dispose);
    el.root.replaceChildren(ctx.kit.node('p', 'Scope closed.'));
  };
  host.signal.addEventListener('abort', dispose, { once: true });
  fitInitialExtent(ctx);
  ctx.renderBackgroundControls();
  refresh();
  return { element: el.root, retire: ctx.retire, dispose };
}
