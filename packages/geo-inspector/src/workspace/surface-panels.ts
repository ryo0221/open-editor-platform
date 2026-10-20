import { contentHash } from '@editor-platform/artifact-core';
import {
  bundledGeoBackgrounds,
  defaultGeoBackgroundSettings,
} from '@editor-platform/geo-core/backgrounds';
import {
  compareGeoVersions,
  createPinnedGeoJoin,
  defaultGeoStyle,
  fitGeoExtent,
  previewGeoRefresh,
  type GeoAction,
  type GeoExtent,
  type Geometry,
} from '@editor-platform/geo-core';
import type { GeoSurfaceContext } from './surface-context';
import { geoChoices, parseGeoNumber, splitGeoList } from './surface-dom';

const fieldset = (ctx: GeoSurfaceContext, legend: string) => {
  const set = ctx.kit.node('fieldset');
  set.append(ctx.kit.node('legend', legend));
  ctx.el.root.append(set);
  return set;
};

const saveWorkspace = (ctx: GeoSurfaceContext, w: ReturnType<GeoSurfaceContext['workspace']>) =>
  ctx.mutate([{ type: 'setWorkspace', workspace: w }]);

export function movedGeoExtent(extent: GeoExtent, x: number, y: number, zoom = 1): GeoExtent {
  const dx = Math.min(360, (extent[2] - extent[0]) / zoom),
    dy = Math.min(180, (extent[3] - extent[1]) / zoom);
  let cx = (extent[0] + extent[2]) / 2 + x * (extent[2] - extent[0]),
    cy = (extent[1] + extent[3]) / 2 + y * (extent[3] - extent[1]);
  cx = ((((cx + 180) % 360) + 360) % 360) - 180;
  cy = Math.max(-90 + dy / 2, Math.min(90 - dy / 2, cy));
  return [
    Math.max(-180, cx - dx / 2),
    cy - dy / 2,
    Math.max(-180, cx - dx / 2) + Math.min(360, dx),
    cy + dy / 2,
  ];
}

function buildCameraButtons(ctx: GeoSurfaceContext) {
  const { state, el } = ctx;
  const move = (x: number, y: number, zoom = 1) => {
    state.extent = movedGeoExtent(state.extent, x, y, zoom);
    state.activeView = '';
    ctx.renderMapTable();
  };
  ctx.button(el.toolbar, 'Fit map', () => {
    state.extent = fitGeoExtent(ctx.open().snapshot.content);
    state.activeView = '';
    ctx.renderMapTable();
  });
  for (const [name, x, y, z] of [
    ['Pan west', -0.2, 0, 1],
    ['Pan east', 0.2, 0, 1],
    ['Pan north', 0, 0.2, 1],
    ['Pan south', 0, -0.2, 1],
    ['Zoom in', 0, 0, 2],
    ['Zoom out', 0, 0, 0.5],
  ] as const)
    ctx.button(el.toolbar, name, () => move(x, y, z));
}

function buildSavedViews(ctx: GeoSurfaceContext, camera: HTMLFieldSetElement) {
  const { state, kit } = ctx;
  const viewName = kit.input(camera, 'View name', 'Comparison view'),
    viewSelect = kit.select(camera, 'Saved view', [], '');
  ctx.button(camera, 'Save named view', () => {
    const w = ctx.workspace(),
      id = `view-${crypto.randomUUID()}`;
    w.views.push({
      id,
      name: viewName.value,
      extent: [...state.extent],
      styles: ctx
        .open()
        .snapshot.content.layers.map((l) =>
          structuredClone(w.styles.find((s) => s.layerId === l.id) ?? defaultGeoStyle(l.id)),
        ),
      annotations: structuredClone(w.annotations),
      ...(state.backgroundTouched
        ? { backgrounds: structuredClone(state.backgroundSettings) }
        : {}),
    });
    return saveWorkspace(ctx, w);
  });
  ctx.button(camera, 'Use saved view', () => {
    const v = ctx.workspace().views.find((v) => v.id === viewSelect.value);
    if (!v) throw Error('Choose a saved view');
    state.activeView = v.id;
    state.extent = [...v.extent];
    state.backgroundSettings = structuredClone(v.backgrounds ?? defaultGeoBackgroundSettings());
    state.backgroundTouched = v.backgrounds !== undefined;
    ctx.renderBackgroundControls();
    ctx.renderMapTable();
  });
  return viewSelect;
}

export function renderGeoBackgroundControls(ctx: GeoSurfaceContext) {
  const { state, kit } = ctx,
    backgroundControls = ctx.el.backgroundControls;
  backgroundControls.replaceChildren();
  for (const setting of state.backgroundSettings) {
    const label = bundledGeoBackgrounds.find((e) => e.id === setting.id)?.label ?? setting.id;
    const enabled = kit.input(backgroundControls, `Show ${label}`, '', 'checkbox');
    enabled.checked = setting.enabled;
    const color = kit.input(backgroundControls, `${label} boundary color`, setting.color, 'color');
    const change = () => {
      setting.enabled = enabled.checked;
      setting.color = color.value;
      state.backgroundTouched = true;
      ctx.retire();
      ctx.renderMapTable();
    };
    enabled.onchange = color.onchange = change;
  }
}

function buildAnnotations(ctx: GeoSurfaceContext, camera: HTMLFieldSetElement) {
  const { kit } = ctx;
  const annotationText = kit.input(camera, 'Annotation text'),
    annotationLon = kit.input(camera, 'Annotation longitude', '0'),
    annotationLat = kit.input(camera, 'Annotation latitude', '0');
  ctx.button(camera, 'Add annotation', () => {
    const w = ctx.workspace();
    w.annotations.push({
      id: `annotation-${crypto.randomUUID()}`,
      text: annotationText.value,
      position: [parseGeoNumber(annotationLon.value), parseGeoNumber(annotationLat.value)],
    });
    return saveWorkspace(ctx, w);
  });
}

export function buildGeoCameraPanel(ctx: GeoSurfaceContext) {
  const camera = fieldset(ctx, 'Camera and saved views');
  buildCameraButtons(ctx);
  const viewSelect = buildSavedViews(ctx, camera);
  buildAnnotations(ctx, camera);
  return { viewSelect };
}

export function buildGeoCreationPanel(ctx: GeoSurfaceContext) {
  const { kit } = ctx;
  const creation = fieldset(ctx, 'Create geometry');
  const createLayer = kit.select(creation, 'Creation layer', []),
    kind = kit.select(
      creation,
      'Geometry type',
      geoChoices(['Point', 'LineString', 'Polygon']),
      'Point',
    );
  const coordinates = kit.textArea(creation, 'New coordinates JSON', '[0,0]');
  ctx.button(creation, 'Create feature', () => {
    const content = ctx.open().snapshot.content,
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
    return ctx.mutate([action]);
  });
  return { createLayer };
}

const joinSummary = (rows: { status: string }[]) => {
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  return `Join: ${count('matched')} matched; ${count('unmatched')} unmatched; ${count('null-key')} null keys. No duplicate first-match.`;
};

function buildJoin(ctx: GeoSurfaceContext, analysis: HTMLFieldSetElement) {
  const { kit, host } = ctx;
  const joinLeft = kit.select(analysis, 'Boundary layer', []),
    joinRight = kit.select(analysis, 'Table layer', []),
    leftKey = kit.input(analysis, 'Boundary key field ID'),
    rightKey = kit.input(analysis, 'Table key field ID');
  const cardinality = kit.select(
    analysis,
    'Join cardinality',
    geoChoices(['one-to-one', 'many-to-one']),
    'one-to-one',
  );
  ctx.button(analysis, 'Create pinned join', async () => {
    ctx.requireClean();
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
    if ('sha256:' + (await contentHash(ctx.open().snapshot.content)) !== capture.pin.contentHash)
      throw Error('Save current native version before joining');
    if (host.stamp() !== stamp) throw Error('Scope or input changed');
    const join = createPinnedGeoJoin(capture.content, capture.pin, request, host.budgets);
    const w = ctx.workspace();
    w.joins.push(join);
    const result = saveWorkspace(ctx, w);
    ctx.el.status.textContent = joinSummary(join.rows);
    return result;
  });
  return { joinLeft, joinRight };
}

function buildReplacementFile(
  ctx: GeoSurfaceContext,
  analysis: HTMLFieldSetElement,
  refreshTarget: HTMLSelectElement,
  refreshPreview: HTMLPreElement,
) {
  const { kit, host } = ctx;
  const replacementFile = kit.input(analysis, 'Replacement source file', '', 'file');
  replacementFile.accept = '.csv,.geojson,.json';
  const replacementPartial = kit.input(
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
  ctx.button(analysis, 'Preview replacement file', async () => {
    ctx.requireClean();
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
  ctx.button(analysis, 'Apply previewed replacement', () => {
    ctx.requireClean();
    if (!replacementToken) throw Error('Preview the replacement first');
    return host.applyRefreshFile(replacementToken, replacementPartial.checked);
  });
}

function buildSourceRefresh(
  ctx: GeoSurfaceContext,
  analysis: HTMLFieldSetElement,
  refreshTarget: HTMLSelectElement,
  refreshIncoming: HTMLSelectElement,
  refreshPreview: HTMLPreElement,
) {
  const { host } = ctx;
  let refreshTicket: { stamp: string; target: string; incoming: string } | undefined;
  ctx.button(analysis, 'Preview source refresh', () => {
    ctx.requireClean();
    const content = ctx.open().snapshot.content,
      a = content.layers.find((l) => l.id === refreshTarget.value),
      b = content.layers.find((l) => l.id === refreshIncoming.value);
    if (!a || !b || a === b) throw Error('Choose two distinct imported layers');
    const preview = previewGeoRefresh(a, b);
    refreshPreview.textContent = JSON.stringify(preview.changes, null, 2);
    refreshTicket = { stamp: host.stamp(), target: a.id, incoming: b.id };
  });
  ctx.button(analysis, 'Apply previewed source refresh', () => {
    if (!refreshTicket || host.stamp() !== refreshTicket.stamp)
      throw Error('Refresh preview is stale; preview again');
    const result = host.refresh(refreshTicket.target, refreshTicket.incoming);
    refreshTicket = undefined;
    return result;
  });
}

export function buildGeoAnalysisPanel(ctx: GeoSurfaceContext) {
  const { kit } = ctx;
  const analysis = fieldset(ctx, 'Pinned region comparison');
  const { joinLeft, joinRight } = buildJoin(ctx, analysis);
  const refreshTarget = kit.select(analysis, 'Refresh original layer', []),
    refreshIncoming = kit.select(analysis, 'Refresh imported candidate', []),
    refreshPreview = kit.node('pre');
  analysis.append(refreshPreview);
  buildReplacementFile(ctx, analysis, refreshTarget, refreshPreview);
  buildSourceRefresh(ctx, analysis, refreshTarget, refreshIncoming, refreshPreview);
  return { joinLeft, joinRight, refreshTarget, refreshIncoming };
}

export function buildGeoComparisonPanel(ctx: GeoSurfaceContext) {
  const { kit, host } = ctx;
  const comparison = fieldset(ctx, 'Two retained versions');
  const beforeVersion = kit.select(comparison, 'Before version', []),
    afterVersion = kit.select(comparison, 'After version', []),
    comparisonFields = kit.input(comparison, 'Comparison field IDs (comma separated)'),
    tolerance = kit.input(comparison, 'Coordinate tolerance (degrees)', '0'),
    coverage = kit.input(comparison, 'Both captures have complete coverage', '', 'checkbox'),
    comparisonResults = kit.node('pre');
  comparison.append(comparisonResults);
  ctx.button(comparison, 'Compare retained versions', async () => {
    ctx.requireClean();
    const requestedBefore = beforeVersion.value,
      requestedAfter = afterVersion.value;
    const request = {
      id: `comparison-${crypto.randomUUID()}`,
      fieldIds: splitGeoList(comparisonFields.value),
      toleranceDegrees: parseGeoNumber(tolerance.value),
      completeCoverage: coverage.checked,
    };
    const stamp = host.stamp(),
      before = await host.capture(requestedBefore),
      after = await host.capture(requestedAfter);
    if (host.stamp() !== stamp) throw Error('Comparison scope changed');
    const result = compareGeoVersions(before, after, request, host.budgets);
    const w = ctx.workspace();
    w.comparisons.push(result);
    comparisonResults.textContent = JSON.stringify(result, null, 2);
    return saveWorkspace(ctx, w);
  });
  return { beforeVersion, afterVersion, comparisonResults };
}
