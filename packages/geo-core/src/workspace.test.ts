import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import {
  applyGeoCommand,
  assertGeo,
  compareGeoVersions,
  createPinnedGeoJoin,
  defaultGeoStyle,
  emptyGeoWorkspace,
  fitGeoExtent,
  geoEditorCommand,
  geoMetricValue,
  geoValue,
  joinedFieldId,
  parseGeo,
  previewGeoRefresh,
  renderGeoSvg,
  serializeGeo,
  type Budgets,
  type GeoDocument,
  type Geometry,
  type Pin,
} from './index';
const budgets: Budgets = {
  actions: 30,
  bytes: 65536,
  depth: 24,
  layers: 10,
  features: 200,
  vertices: 1000,
};
const pin: Pin = { artifactId: 'geo', versionId: 'v1', contentHash: 'sha256:' + 'a'.repeat(64) };
const revision = { sessionId: 'local', sequence: 0 },
  context = { revision, canEdit: true, budgets };
function fixture(): GeoDocument {
  return {
    schemaVersion: 1,
    sources: [],
    layers: [
      {
        id: 'regions',
        name: 'Regions',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: [{ id: 'code', name: 'Code', type: 'string' }],
        features: Array.from({ length: 47 }, (_, i) => ({
          id: `region-${i}`,
          rowId: `region-row-${i}`,
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [i, 0],
                [i + 0.5, 0],
                [i + 0.5, 0.5],
                [i, 0.5],
                [i, 0],
              ],
            ],
          },
          values: { code: String(i + 1).padStart(2, '0') },
        })),
      },
      {
        id: 'table',
        name: 'Counts',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: [
          { id: 'code', name: 'Code', type: 'string' },
          { id: 'count', name: 'Count', type: 'number' },
          { id: 'population', name: 'Population', type: 'number' },
        ],
        features: Array.from({ length: 47 }, (_, i) => ({
          id: `table-${i}`,
          rowId: `table-row-${i}`,
          geometry: null,
          values: {
            code: String(i + 1).padStart(2, '0'),
            count: i === 2 ? null : i,
            population: i === 3 ? 0 : 100,
          },
        })),
      },
    ],
  };
}
const options = {
  id: 'join',
  layerId: 'regions',
  tableLayerId: 'table',
  leftFieldId: 'code',
  rightFieldId: 'code',
  cardinality: 'one-to-one' as const,
};
function joined() {
  const content = fixture();
  content.workspace = emptyGeoWorkspace();
  content.workspace.joins.push(createPinnedGeoJoin(content, pin, options, budgets));
  return content;
}
describe('Issue97 complete native workspace', () => {
  it('keeps old schema1 bytes unchanged and rejects unknown workspace schemas/fields', () => {
    const content = fixture(),
      bytes = JSON.stringify(content);
    expect(serializeGeo(parseGeo(bytes, budgets), budgets)).toBe(bytes);
    const value = { ...content, workspace: { ...emptyGeoWorkspace(), schemaVersion: 2 } };
    expect(() => assertGeo(value, budgets)).toThrow('workspace-schema');
    expect(() =>
      assertGeo(
        { ...content, workspace: { ...emptyGeoWorkspace(), secret: 'unexpected' } },
        budgets,
      ),
    ).toThrow('workspace-shape');
  });
  it('UC2 AC05 pins47 typed keys and preserves leading zeros without mutating inputs', () => {
    const content = fixture(),
      before = structuredClone(content),
      join = createPinnedGeoJoin(content, pin, options, budgets);
    expect(join.rows).toHaveLength(47);
    expect(join.rows.every((r) => r.status === 'matched')).toBe(true);
    expect(join.rows[0].values.code).toBe('01');
    expect(join.inputs).toEqual({ left: pin, right: pin });
    expect(content).toEqual(before);
    content.layers[1].features[0].values.code = '1';
    content.layers[0].features[1].values.code = null;
    const result = createPinnedGeoJoin(content, pin, options, budgets);
    expect(result.rows[0].status).toBe('unmatched');
    expect(result.rows[1].status).toBe('null-key');
  });
  it('UC2 AC05 duplicate/right type conflicts block all output; no first match', () => {
    const content = fixture();
    content.layers[1].features[1].values.code = '01';
    expect(() => createPinnedGeoJoin(content, pin, options, budgets)).toThrow('duplicate-key');
    content.layers[1].fields[0].type = 'number';
    expect(() => createPinnedGeoJoin(content, pin, options, budgets)).toThrow();
  });
  it('AC06 zero, missing, denominator zero, unmatched and invalid rates are separate', () => {
    const content = joined(),
      s = defaultGeoStyle('regions');
    s.mode = 'classes';
    s.metric = {
      kind: 'rate',
      numerator: joinedFieldId('join', 'count'),
      denominator: joinedFieldId('join', 'population'),
      multiplier: 100,
      indicator: 'Inspection rate',
      unit: '%',
      period: '2026',
    };
    s.boundaries = [1, 10];
    s.colors = ['#aaaaaa', '#bbbbbb', '#cccccc'];
    content.workspace!.styles = [s];
    expect(geoMetricValue(content, 'regions', content.layers[0].features[0], s)).toEqual({
      status: 'value',
      value: 0,
    });
    expect(geoMetricValue(content, 'regions', content.layers[0].features[2], s).status).toBe(
      'missing',
    );
    expect(geoMetricValue(content, 'regions', content.layers[0].features[3], s).status).toBe(
      'zero-denominator',
    );
    content.workspace!.joins[0].rows[4].status = 'unmatched';
    expect(geoMetricValue(content, 'regions', content.layers[0].features[4], s).status).toBe(
      'unmatched',
    );
    expect(parseGeo(serializeGeo(content, budgets), budgets)).toEqual(content);
    const svg = renderGeoSvg(
      content,
      { extent: [-1, -1, 48, 2], width: 960, height: 600 },
      budgets,
    );
    expect(svg).toContain('Inspection rate');
    expect(svg).toContain('% · 2026');
    expect(svg).toContain('zero-denominator: 1');
  });
  it('AC03 simple polygon and attributes commit atomically with existing Undo/Redo', () => {
    const session = new EditorSession(fixture()),
      before = session.content;
    const command = geoEditorCommand(
      {
        expectedRevision: session.revision,
        actions: [
          {
            type: 'replaceGeometry',
            layerId: 'regions',
            featureId: 'region-0',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [2, 0],
                  [2, 2],
                  [0, 0],
                ],
              ],
            },
          },
          {
            type: 'setAttribute',
            layerId: 'regions',
            featureId: 'region-0',
            fieldId: 'code',
            value: 'changed',
          },
        ],
      },
      () => ({ revision: session.revision, canEdit: true, budgets }),
    );
    session.execute(command);
    expect(session.content.layers[0].features[0].values.code).toBe('changed');
    const after = session.content;
    expect(session.undo()).toEqual(before);
    expect(session.redo()).toEqual(after);
  });
  it('AC03/04 invalid/self-intersecting polygon refuses the whole geometry+scalar batch', () => {
    const content = fixture(),
      before = structuredClone(content);
    expect(() =>
      applyGeoCommand(
        content,
        {
          expectedRevision: revision,
          actions: [
            {
              type: 'setAttribute',
              layerId: 'regions',
              featureId: 'region-0',
              fieldId: 'code',
              value: 'lost',
            },
            {
              type: 'replaceGeometry',
              layerId: 'regions',
              featureId: 'region-0',
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [0, 0],
                    [2, 2],
                    [0, 2],
                    [2, 0],
                    [0, 0],
                  ],
                ],
              },
            },
          ],
        },
        context,
      ),
    ).toThrow('self-intersection');
    expect(content).toEqual(before);
  });
  it.each<Geometry>([
    {
      type: 'MultiPoint',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 0],
        ],
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 1],
        ],
      ],
    },
  ])(
    'AC04 retains %s and refuses its geometry editing while scalar edits remain possible',
    (geometry) => {
      const content = fixture();
      content.layers[0].features[0].geometry = geometry;
      expect(
        parseGeo(serializeGeo(content, budgets), budgets).layers[0].features[0].geometry,
      ).toEqual(geometry);
      expect(() =>
        applyGeoCommand(
          content,
          {
            expectedRevision: revision,
            actions: [
              {
                type: 'replaceGeometry',
                layerId: 'regions',
                featureId: 'region-0',
                geometry: null,
              },
            ],
          },
          context,
        ),
      ).toThrow('geometry-readonly');
      expect(
        applyGeoCommand(
          content,
          {
            expectedRevision: revision,
            actions: [
              {
                type: 'setAttribute',
                layerId: 'regions',
                featureId: 'region-0',
                fieldId: 'code',
                value: 'kept',
              },
            ],
          },
          context,
        ).layers[0].features[0].geometry,
      ).toEqual(geometry);
    },
  );
  it('AC04/07/11 renders wrap and pole without changing native; untrusted text stays escaped', async () => {
    const content = fixture();
    content.layers[0].features = [
      {
        id: 'line',
        rowId: 'line-row',
        geometry: {
          type: 'LineString',
          coordinates: [
            [179, 89],
            [-179, 90],
          ],
        },
        values: { code: '<script>alert(1)</script>' },
      },
    ];
    content.layers[0].name = '<img src=x onerror=alert(1)>';
    const s = defaultGeoStyle('regions');
    s.labelFieldId = 'code';
    content.workspace = { ...emptyGeoWorkspace(), styles: [s] };
    const before = await contentHash(content),
      svg = renderGeoSvg(
        content,
        { extent: [-180, -90, 180, 90], width: 960, height: 600 },
        budgets,
      );
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<img ');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toMatch(/M718,[\d.]+ L722,0/);
    expect(fitGeoExtent(content)[2] - fitGeoExtent(content)[0]).toBeLessThan(100);
    expect(await contentHash(content)).toBe(before);
  });
  it('UC6 compares exact pinned inputs with explicit fields, coverage and numerical tolerance', () => {
    const a = fixture(),
      b = structuredClone(a);
    b.layers[0].features[0].values.code = 'new';
    b.layers[0].features.splice(1, 1);
    const result = compareGeoVersions(
      { content: a, pin },
      { content: b, pin: { ...pin, versionId: 'v2' } },
      { id: 'compare', fieldIds: ['code'], toleranceDegrees: 0, completeCoverage: false },
      budgets,
    );
    expect(result.changes.map((c) => c.kind)).toEqual(['changed', 'no-counterpart']);
    expect(result.before).toEqual(pin);
    expect(a.layers[0].features).toHaveLength(47);
    expect(
      compareGeoVersions(
        { content: a, pin },
        { content: b, pin },
        { id: 'compare', fieldIds: [], toleranceDegrees: 0, completeCoverage: true },
        budgets,
      ).changes.map((c) => c.kind),
    ).toEqual(['removed']);
  });
  it('M2 refresh previews preserve stable IDs by typed external ID; missing/duplicates refuse', () => {
    const content = fixture(),
      old = content.layers[0],
      incoming = structuredClone(old);
    old.features.forEach(
      (f, i) => (f.sourceRef = { sourceId: 'old', externalId: String(i).padStart(2, '0') }),
    );
    incoming.features = old.features
      .slice()
      .reverse()
      .map((f) => ({
        ...structuredClone(f),
        id: `new-${f.id}`,
        rowId: `new-${f.rowId}`,
        sourceRef: { ...f.sourceRef!, sourceId: 'new' },
      }));
    incoming.features[0].values.code = 'changed';
    const preview = previewGeoRefresh(old, incoming);
    expect(preview.layer.features[0].id).toBe('region-46');
    expect(preview.layer.features[0].rowId).toBe('region-row-46');
    expect(preview.changes[0].kind).toBe('changed');
    incoming.features[1].sourceRef!.externalId = incoming.features[0].sourceRef!.externalId;
    expect(() => previewGeoRefresh(old, incoming)).toThrow('duplicate');
  });
  it('AC07 named views are explicit native commands and snapshot classes/annotations', () => {
    const content = joined(),
      w = structuredClone(content.workspace!);
    w.views.push({
      id: 'view',
      name: 'Fixed comparison',
      extent: [0, -1, 47, 2],
      styles: [defaultGeoStyle('regions')],
      annotations: [{ id: 'note', text: 'Synthetic only', position: [1, 1] }],
    });
    const next = applyGeoCommand(
      content,
      { expectedRevision: revision, actions: [{ type: 'setWorkspace', workspace: w }] },
      context,
    );
    expect(content.workspace!.views).toHaveLength(0);
    expect(next.workspace!.views).toHaveLength(1);
    w.views[0].extent[0] = 999;
    expect(next.workspace!.views[0].extent[0]).toBe(0);
  });
  it('AC11 rejects executable colors, unknown photos, non-finite/duplicate boundaries and stale authority', () => {
    const content = fixture(),
      w = emptyGeoWorkspace(),
      s = defaultGeoStyle('regions');
    s.color = 'url(https://bad.test/tile)';
    w.styles = [s];
    expect(() => assertGeo({ ...content, workspace: w }, budgets)).toThrow('layer-style');
    s.color = '#ffffff';
    s.boundaries = [1, 1];
    expect(() => assertGeo({ ...content, workspace: w }, budgets)).toThrow('class-boundaries');
    expect(() =>
      applyGeoCommand(
        content,
        { expectedRevision: revision, actions: [] },
        { ...context, canEdit: false },
      ),
    ).toThrow('permission-denied');
    expect(() =>
      applyGeoCommand(
        content,
        { expectedRevision: { ...revision, sequence: 1 }, actions: [] },
        context,
      ),
    ).toThrow('stale-revision');
  });
});

it('pinned external table projection exports readonly joined values and both input pins without rewriting native', async () => {
  const { createPinnedGeoJoinBetween, prepareGeoDataExport, confirmGeoDataExport } = await import(
    './index'
  );
  const content = fixture(),
    table = { ...fixture(), layers: [fixture().layers[1]] };
  const external = { ...pin, artifactId: 'data', versionId: 'sales-v1' };
  const join = createPinnedGeoJoinBetween(
    { content, pin },
    { content: table, pin: external },
    {
      id: 'sales',
      layerId: 'regions',
      tableLayerId: 'table',
      leftFieldId: 'code',
      rightFieldId: 'code',
      cardinality: 'one-to-one',
    },
    budgets,
  );
  content.layers = [content.layers[0]];
  content.workspace = { ...emptyGeoWorkspace(), joins: [join] };
  assertGeo(content, budgets);
  const original = serializeGeo(content, budgets),
    field = joinedFieldId('sales', 'count');
  const preview = prepareGeoDataExport(
    { content, pin },
    { layerId: 'regions', fieldIds: [field], format: 'csv' },
    { native: budgets, outputBytes: 200000 },
  );
  expect(preview.fields.map((f) => f.id)).toEqual([field]);
  expect(preview.data.text).not.toContain('undefined');
  const bundle = await confirmGeoDataExport(preview, preview.warnings, () => true);
  expect(JSON.parse(bundle.receipt.text).derivedJoins[0].inputs.right).toEqual(external);
  expect(serializeGeo(content, budgets)).toBe(original);
});

it('does not present old joined values after the current native key changes', () => {
  const content = fixture(),
    join = createPinnedGeoJoin(content, pin, options, budgets);
  content.workspace = { ...emptyGeoWorkspace(), joins: [join] };
  const layer = content.layers[0],
    feature = layer.features[0],
    field = joinedFieldId(join.id, 'count');
  expect(geoValue(content, layer.id, feature, field)).toBe(0);
  feature.values.code = '02';
  expect(geoValue(content, layer.id, feature, field)).toBe(null);
  const style = defaultGeoStyle(layer.id);
  style.fieldId = field;
  expect(geoMetricValue(content, layer.id, feature, style).status).toBe('stale-key');
});

it('#378 Fit leaves room for edge symbols and labels; lines are labelled half way along', () => {
  const content: GeoDocument = {
    schemaVersion: 1,
    sources: [],
    layers: [
      {
        id: 'sites',
        name: 'Sites',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: [{ id: 'name', name: 'Name', type: 'string' }],
        features: [
          {
            id: 'north',
            rowId: 'north-row',
            geometry: { type: 'Point', coordinates: [140, 40] },
            values: { name: 'North site' },
          },
          {
            id: 'route',
            rowId: 'route-row',
            geometry: {
              type: 'LineString',
              coordinates: [
                [100, 10],
                [120, 10],
                [120, 30],
              ],
            },
            values: { name: 'Route' },
          },
          {
            id: 'area',
            rowId: 'area-row',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [179, 40],
                  [-179, 40],
                  [-179, 44],
                  [179, 44],
                  [179, 40],
                ],
              ],
            },
            values: { name: 'Area' },
          },
          {
            id: 'wrap',
            rowId: 'wrap-row',
            geometry: {
              type: 'LineString',
              coordinates: [
                [170, 20],
                [-170, 20],
              ],
            },
            values: { name: 'Wrap' },
          },
        ],
      },
    ],
  };
  const sites = {
    ...content,
    layers: [{ ...content.layers[0], features: content.layers[0].features.slice(0, 2) }],
  };
  const [west, south, east, north] = fitGeoExtent(sites);
  // 40° by 30° of features: 8% of each span on every side.
  expect([west, east]).toEqual([100 - 3.2, 140 + 3.2]);
  expect(south).toBeCloseTo(10 - 2.4);
  expect(north).toBeCloseTo(40 + 2.4);
  const style = defaultGeoStyle('sites');
  style.labelFieldId = 'name';
  content.workspace = { ...emptyGeoWorkspace(), styles: [style] };
  const svg = renderGeoSvg(
    content,
    { extent: [90, 0, 190, 50], width: 1000, height: 520, includeLegend: false },
    budgets,
  );
  const label = (text: string) => {
    const match = new RegExp(
      `<text x="([\\d.]+)" y="([\\d.]+)"( text-anchor="end")?[^>]*>${text}<`,
    ).exec(svg)!;
    return { x: Number(match[1]), y: Number(match[2]), end: !!match[3] };
  };
  const { x: px, y: py } = (() => {
    const m = /<circle cx="([\d.]+)" cy="([\d.]+)"/.exec(svg)!;
    return { x: Number(m[1]), y: Number(m[2]) };
  })();
  // Half way along the 40° route is its corner at 120°E 10°N.
  const route = label('Route');
  expect(route.x).toBeCloseTo(300 + 8);
  expect(route.end).toBe(false);
  // The antimeridian line is labelled on itself, at 180°, not at 0°.
  expect(label('Wrap').x).toBeCloseTo(900 - 8);
  expect(label('Wrap').end).toBe(true);
  // An area across the antimeridian is labelled on itself too.
  expect(label('Area').x).toBeCloseTo(900 - 8);
  // A label left of the right quarter runs rightwards from its point.
  expect(label('North site')).toEqual({ x: px + 8, y: py - 8, end: false });
});
