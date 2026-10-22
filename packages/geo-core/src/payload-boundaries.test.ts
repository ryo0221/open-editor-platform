import { describe, expect, it } from 'vitest';
import {
  applyGeoCommand,
  assertGeo,
  createPinnedGeoJoin,
  defaultGeoStyle,
  emptyGeoWorkspace,
  type Budgets,
  type GeoDocument,
  type GeoWorkspace,
  type Pin,
  type Position,
} from './index';
import { validateRequest, type ImportLimits } from './import-adapter';

const budgets: Budgets = {
  actions: 30,
  bytes: 200000,
  depth: 24,
  layers: 10,
  features: 200,
  vertices: 2000,
};
const pin: Pin = { artifactId: 'geo', versionId: 'v1', contentHash: 'sha256:' + 'a'.repeat(64) };
const context = { revision: { sessionId: 's', sequence: 0 }, canEdit: true, budgets };
const square = (x: number): Position[] => [
  [x, 0],
  [x + 0.5, 0],
  [x + 0.5, 0.5],
  [x, 0.5],
  [x, 0],
];
function fixture(): GeoDocument {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: 'photo',
        pin,
        resourceId: 'photo-bytes',
        bytesHash: 'sha256:' + 'b'.repeat(64),
        format: 'png',
        adapterVersion: 'm0',
        declaredCrs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        attribution: 'Synthetic photo',
      },
    ],
    layers: [
      {
        id: 'regions',
        name: 'Regions',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: [{ id: 'code', name: 'Code', type: 'string' }],
        features: [0, 1, 2].map((i) => ({
          id: `region-${i}`,
          rowId: `region-row-${i}`,
          geometry: { type: 'Polygon', coordinates: [square(i)] },
          values: { code: `0${i + 1}` },
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
        features: [0, 1, 2].map((i) => ({
          id: `table-${i}`,
          rowId: `table-row-${i}`,
          geometry: null,
          values: { code: `0${i + 1}`, count: i, population: 100 },
        })),
      },
    ],
  };
}
/** A workspace using every optional section: joins, metric styles, views, assets, comparisons. */
function complete(): GeoDocument & { workspace: GeoWorkspace } {
  const content = fixture();
  const workspace = emptyGeoWorkspace();
  workspace.joins.push(
    createPinnedGeoJoin(
      content,
      pin,
      {
        id: 'join',
        layerId: 'regions',
        tableLayerId: 'table',
        leftFieldId: 'code',
        rightFieldId: 'code',
        cardinality: 'one-to-one',
      },
      budgets,
    ),
  );
  const style = {
    ...defaultGeoStyle('regions'),
    mode: 'classes' as const,
    boundaries: [1, 3],
    colors: ['#111111', '#222222', '#333333'],
    categories: [{ value: '01', color: '#444444' }],
    metric: {
      kind: 'rate' as const,
      numerator: 'join:join:count',
      denominator: 'join:join:population',
      multiplier: 1000,
      indicator: 'Rate',
      unit: 'per 1000',
      period: '2024',
    },
    filter: { fieldId: 'code', value: '01' },
  };
  workspace.styles.push(style);
  workspace.annotations.push({ id: 'note', text: 'Note', position: [1, 1] });
  workspace.views.push({
    id: 'view',
    name: 'View',
    extent: [-10, -10, 20, 20],
    styles: [style],
    annotations: [],
  });
  workspace.assets.push({
    layerId: 'regions',
    featureId: 'region-0',
    assetId: 'asset',
    inspectedAt: '2024-01-01',
    accuracyMeters: 3,
    notes: 'Checked',
    photos: [{ sourceId: 'photo', name: 'Front', required: true }],
  });
  workspace.comparisons.push({
    id: 'compare',
    before: pin,
    after: { ...pin, versionId: 'v2' },
    fieldIds: ['code'],
    toleranceDegrees: 0.1,
    completeCoverage: true,
    changes: [
      {
        layerId: 'regions',
        featureId: 'region-0',
        kind: 'changed',
        fields: ['code'],
        geometryChanged: false,
      },
    ],
  });
  return { ...content, workspace };
}
type Workspace = ReturnType<typeof complete>['workspace'];
const rejects = (code: string, change: (w: Workspace) => void) => {
  const content = complete();
  change(content.workspace);
  expect(() => assertGeo(content, budgets), code).toThrow(code);
};

describe('Geo workspace payload boundary', () => {
  it('accepts a workspace that uses every optional section', () => {
    expect(() => assertGeo(complete(), budgets)).not.toThrow();
  });
  it('rejects malformed styles, metrics and filters with their own codes', () => {
    rejects('layer-style', (w) => (w.styles[0].radius = 41));
    rejects('layer-style', (w) => (w.styles[0].labelFieldId = 'missing'));
    rejects('category-style', (w) =>
      w.styles[0].categories.push({ value: '01', color: '#000000' }),
    );
    rejects('class-boundaries', (w) => (w.styles[0].boundaries = [3, 1]));
    rejects('class-boundaries', (w) => w.styles[0].colors.pop());
    rejects('metric-definition', (w) => (w.styles[0].metric!.unit = '  '));
    rejects('metric-definition', (w) => (w.styles[0].metric!.denominator = 'join:join:code'));
    rejects('metric-definition', (w) => {
      w.styles[0].metric!.kind = 'count';
    });
    rejects('layer-filter', (w) => (w.styles[0].filter = { fieldId: 'missing', value: null }));
    rejects('style-field-required', (w) => (w.styles[0].metric = null));
    rejects('workspace-duplicate-id', (w) => w.styles.push(defaultGeoStyle('regions')));
  });
  it('rejects malformed joins, views and annotations', () => {
    rejects('join-layer', (w) => (w.joins[0].layerId = 'missing'));
    rejects('workspace-pin', (w) => (w.joins[0].inputs.left.contentHash = 'sha256:x'));
    rejects('join-field', (w) => (w.joins[0].fields[0].type = 'date' as never));
    rejects('join-row', (w) => (w.joins[0].rows[0].status = 'partial' as never));
    rejects('join-value', (w) => (w.joins[0].rows[0].values.count = '1'));
    rejects('view-name', (w) => (w.views[0].name = ' '));
    rejects('view-extent', (w) => (w.views[0].extent = [10, 0, 5, 1]));
    rejects('annotation', (w) => (w.annotations[0].position = [181, 0]));
    rejects('workspace-shape', (w) => Object.assign(w.views[0], { extra: true }));
  });
  it('rejects asset references and photos that do not resolve', () => {
    rejects('asset-reference', (w) => (w.assets[0].featureId = 'missing'));
    rejects('asset-reference', (w) => w.assets.push(structuredClone(w.assets[0])));
    rejects('asset-reference', (w) => (w.assets[0].inspectedAt = 'yesterday'));
    rejects('asset-reference', (w) => (w.assets[0].accuracyMeters = -1));
    rejects('asset-photo', (w) => (w.assets[0].photos[0].sourceId = 'missing'));
    rejects('asset-photo', (w) => (w.assets[0].photos[0].required = 'yes' as never));
    rejects('workspace-array-limit', (w) => {
      w.assets[0].photos = Array.from({ length: 9 }, () => w.assets[0].photos[0]);
    });
  });
  it('rejects comparison options and changes outside the declared ranges', () => {
    rejects('comparison-options', (w) => (w.comparisons[0].toleranceDegrees = 2));
    rejects('comparison-options', (w) => (w.comparisons[0].fieldIds = ['code', 'code']));
    rejects('comparison-change', (w) => (w.comparisons[0].changes[0].kind = 'moved' as never));
    rejects('comparison-change', (w) => (w.comparisons[0].changes[0].fields = ['bad id']));
    rejects('workspace-pin', (w) => (w.comparisons[0].after = { ...pin, versionId: '' }));
  });
});

describe('Geo command payload boundary', () => {
  const feature = {
    id: 'new',
    rowId: 'new-row',
    geometry: null,
    values: { code: '09' },
  };
  const valid = [
    { type: 'addFeature', layerId: 'regions', feature },
    { type: 'deleteFeature', layerId: 'regions', featureId: 'region-0' },
    { type: 'replaceGeometry', layerId: 'regions', featureId: 'region-0', geometry: null },
    {
      type: 'setAttribute',
      layerId: 'regions',
      featureId: 'region-0',
      fieldId: 'code',
      value: 'x',
    },
    { type: 'deleteLayer', layerId: 'table' },
    { type: 'setWorkspace', workspace: emptyGeoWorkspace() },
  ];
  const run = (actions: unknown[], expectedRevision: unknown = context.revision) =>
    applyGeoCommand(fixture(), { expectedRevision, actions } as never, context);
  it('accepts each action shape and a local draft revision', () => {
    for (const action of valid) expect(() => run([action])).not.toThrow();
    expect(() => run([valid[0]], { kind: 'local-draft', ...context.revision })).not.toThrow();
  });
  it('rejects extra keys, wrong payload types and unknown action types', () => {
    for (const action of valid)
      expect(() => run([{ ...action, extra: true }]), action.type).toThrow('command-schema');
    expect(() => run([{ ...valid[0], layerId: 'bad id' }])).toThrow('command-schema');
    expect(() => run([{ ...valid[0], feature: { ...feature, geometry: [] } }])).toThrow(
      'command-schema',
    );
    expect(() => run([{ ...valid[3], value: {} }])).toThrow('command-schema');
    expect(() => run([{ type: 'importLayer', layer: {}, source: null }])).toThrow('command-schema');
    expect(() => run(['addFeature'])).toThrow('command-schema');
    expect(() => run([{ type: 'toString' }])).toThrow('unsupported-command');
    expect(() => run([{ type: 'renameLayer', layerId: 'regions' }])).toThrow('unsupported-command');
  });
  it('rejects revisions that are neither committed nor an explicit local draft', () => {
    for (const revision of [
      { kind: 'remote', sessionId: 's', sequence: 0 },
      { sessionId: 's', sequence: -1 },
      { sessionId: 's', sequence: 1.5 },
      { sessionId: '', sequence: 0 },
      null,
    ])
      expect(() => run([valid[1]], revision), JSON.stringify(revision)).toThrow('command-schema');
  });
});

type Raw = Record<string, unknown>;
type RawRequest = Raw & {
  revision: Raw;
  source: Raw & { pin: Raw };
  fields: Raw[];
  csv?: Raw;
};
describe('Geo import request boundary', () => {
  const limits: ImportLimits = {
    native: budgets,
    sourceBytes: 100000,
    rows: 50,
    columns: 4,
    pendingPlans: 4,
  };
  const request = (format: 'csv' | 'geojson' = 'csv'): RawRequest => ({
    planId: 'plan',
    revision: { sessionId: 's', sequence: 0 },
    format,
    crs: 'OGC:CRS84',
    layerId: 'sites',
    layerName: 'Sites',
    source: { id: 'source', resourceId: 'bytes', pin: { ...pin }, attribution: 'Synthetic' },
    fields: [{ id: 'name', name: 'Name', type: 'string', input: 'name' }],
    ...(format === 'csv'
      ? {
          csv: {
            idColumn: 'id',
            firstCoordinate: 'lon',
            secondCoordinate: 'lat',
            axis: 'longitude-latitude',
            missingCoordinates: 'reject',
          },
        }
      : {}),
  });
  const rejects = (code: string, change: (r: RawRequest) => void, format?: 'geojson') => {
    const value = request(format);
    change(value);
    expect(() => validateRequest(value, limits), code).toThrow(new Error(code));
  };
  it('accepts CSV, GeoJSON, local draft revisions and attribute-table CSV', () => {
    expect(() => validateRequest(request(), limits)).not.toThrow();
    expect(() => validateRequest(request('geojson'), limits)).not.toThrow();
    const draft = request();
    draft.revision = { kind: 'local-draft', sessionId: 's', sequence: 3 };
    expect(() => validateRequest(draft, limits)).not.toThrow();
    const table = request();
    Object.assign(table.csv!, {
      firstCoordinate: '',
      secondCoordinate: '',
      missingCoordinates: 'attribute-table',
    });
    expect(() => validateRequest(table, limits)).not.toThrow();
  });
  it('rejects CRS and format before the request shape', () => {
    rejects('crs-unsupported', (r) => (r.crs = 'EPSG:3857'));
    rejects('crs-unsupported', (r) => {
      r.crs = 'EPSG:3857';
      r.format = 'shp';
    });
    rejects('format-unsupported', (r) => (r.format = 'shp'));
    expect(() => validateRequest(null, limits)).toThrow(new Error('import-request'));
  });
  it('rejects request shapes, revisions and limits as import-request', () => {
    rejects('import-request', (r) => (r.extra = true));
    rejects('import-request', (r) => delete r.csv);
    rejects('import-request', (r) => (r.csv = request().csv), 'geojson');
    rejects('import-request', (r) => (r.planId = 'p'.repeat(81)));
    rejects('import-request', (r) => (r.layerId = 'bad id'));
    rejects('import-request', (r) => (r.layerName = 1));
    rejects(
      'import-request',
      (r) => (r.revision = { kind: 'remote', sessionId: 's', sequence: 0 }),
    );
    rejects('import-request', (r) => (r.revision.sequence = -1));
    rejects('import-request', (r) => (r.source.extra = true));
    rejects('import-request', (r) => {
      r.fields = Array.from({ length: 5 }, (_, i) => ({ ...r.fields[0], id: `f${i}` }));
    });
  });
  it('rejects fields, CSV mappings and source pins with their own codes', () => {
    rejects('import-field', (r) => (r.fields[0].id = 'toJSON'));
    rejects('import-field', (r) => r.fields.push({ ...r.fields[0], id: 'other' }));
    rejects('import-field', (r) => (r.fields[0].type = 'date'));
    rejects('csv-mapping', (r) => (r.csv!.secondCoordinate = 'lon'));
    rejects('csv-mapping', (r) => (r.csv!.firstCoordinate = ''));
    rejects('csv-mapping', (r) => (r.csv!.idColumn = ''));
    rejects('csv-mapping', (r) => (r.csv!.axis = 'x-y'));
    rejects('csv-mapping', (r) => (r.csv!.missingCoordinates = 'drop'));
    rejects('csv-mapping', (r) => delete r.csv!.axis);
    rejects('source-pin', (r) => (r.source.pin.contentHash = 'sha256:x'));
  });
});
