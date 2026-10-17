import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createGeoImporter,
  emptyGeo,
  type ImportLimits,
  type ImportRequest,
  type ImportPreview,
} from './index';
const limits: ImportLimits = {
  native: {
    bytes: 2_000_000,
    depth: 24,
    layers: 10,
    features: 2000,
    vertices: 10000,
    actions: 1000,
  },
  sourceBytes: 100_000,
  rows: 500,
  columns: 24,
  pendingPlans: 4,
};
const bytes = (s: string) => new TextEncoder().encode(s);
const hash = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
function setup(format: 'csv' | 'geojson' = 'csv', options = limits) {
  const importer = createGeoImporter(options),
    session = new EditorSession(emptyGeo());
  const request: ImportRequest = {
    planId: 'synthetic',
    revision: session.revision,
    format,
    crs: 'OGC:CRS84',
    layerId: 'sites',
    layerName: 'Synthetic sites',
    source: {
      id: 'source',
      resourceId: 'bytes',
      pin: { artifactId: 'input', versionId: 'v1', contentHash: `sha256:${'a'.repeat(64)}` },
      attribution: 'Synthetic test data',
    },
    fields: [{ id: 'name', name: 'Name', type: 'string', input: 'name' }],
  };
  if (format === 'csv')
    request.csv = {
      idColumn: 'id',
      firstCoordinate: 'lon',
      secondCoordinate: 'lat',
      axis: 'longitude-latitude',
      missingCoordinates: 'reject',
    };
  const current = () => ({ revision: session.revision, canEdit: true, budgets: options.native });
  return { importer, session, request, current };
}
const csv = 'id,lon,lat,name\n001,10,20,Alpha\n';
const collection = (features: unknown[]) =>
  bytes(JSON.stringify({ type: 'FeatureCollection', features }));
const point = (id: string | number | null = '001') => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [10, 20] },
  properties: { name: 'Alpha' },
});
const errors = (preview: ImportPreview) =>
  preview.plan.candidates
    .filter((c) => c.diagnostics.some((d) => d.severity === 'error'))
    .map((c) => c.inputRow);
describe('M0 byte adapters and immutable preview binding', () => {
  it('UC1 FR01 AC01: real 200-row CSV default blocks, exact partial confirms 198 with ledger', async () => {
    const { importer, session, request, current } = setup();
    const data = bytes(
      'id,lon,lat,name\n' +
        Array.from(
          { length: 200 },
          (_, i) =>
            `${String(i).padStart(3, '0')},${i === 5 ? '' : 10},${i === 9 ? 91 : 20},Same name`,
        ).join('\n'),
    );
    const before = session.content,
      preview = await importer.prepare(data, request);
    expect(preview.plan.counts).toEqual({ read: 200, valid: 198, problem: 2 });
    expect(errors(preview)).toEqual([6, 10]);
    expect(preview.sourceBytesHash).toBe(hash(data));
    expect(preview.plan.source.bytesHash).toBe(hash(data));
    expect(session.content).toEqual(before);
    await expect(
      importer.confirm(preview, { mode: 'all' }, { bytes: data, pin: request.source.pin }, current),
    ).rejects.toThrow('import-blocked');
    await expect(
      importer.confirm(
        preview,
        { mode: 'partial', excludedRows: [6] },
        { bytes: data, pin: request.source.pin },
        current,
      ),
    ).rejects.toThrow('partial-selection-mismatch');
    const accepted = await importer.confirm(
      preview,
      { mode: 'partial', excludedRows: [6, 10] },
      { bytes: data, pin: request.source.pin },
      current,
    );
    expect(accepted.imported).toBe(198);
    expect(accepted.excluded.map((c) => c.inputRow)).toEqual([6, 10]);
    session.execute(accepted.editorCommand);
    expect(session.content.layers[0].features).toHaveLength(198);
    expect(session.content.layers[0].features[0].geometry).toEqual({
      type: 'Point',
      coordinates: [10, 20],
    });
    expect(session.undo()).toEqual(before);
  });
  it('UC1/2 FR01/03 AC02/05: BOM quotes multiline escaped quote and zero-prefixed string IDs', async () => {
    const { importer, request, current } = setup();
    const data = bytes(
      '\uFEFFid,lon,lat,name\r\n001,0,0,"A, B\r\n""quoted"""\r\n001,1,2,Second\r\n,3,4,Missing\r\n',
    );
    const preview = await importer.prepare(data, request);
    expect(preview.plan.candidates[0].feature.values.name).toBe('A, B\r\n"quoted"');
    expect(preview.assignments.map((a) => a.externalId)).toEqual(['001', '001', null]);
    expect(new Set(preview.assignments.map((a) => a.featureId)).size).toBe(3);
    expect(preview.plan.candidates.map((c) => c.diagnostics.map((d) => d.code))).toEqual([
      ['duplicate-external-id'],
      ['duplicate-external-id'],
      ['missing-external-id'],
    ]);
    expect(importer.sourceBytes(request.planId)).toEqual(data);
    expect(preview.sourceBytesHash).toBe(hash(data));
    const result = await importer.confirm(
      structuredClone(preview),
      { mode: 'all' },
      { bytes: data, pin: request.source.pin },
      current,
    );
    expect(result.command.actions[0]).toMatchObject({
      type: 'importLayer',
      layer: { features: preview.plan.layer.features },
    });
    await expect(importer.prepare(data, request)).rejects.toThrow('plan-id-in-use');
  });
  it('UC1 FR01 AC02: explicit reversed columns, blank null policy, typed missing values', async () => {
    const { importer, request } = setup();
    request.csv!.axis = 'latitude-longitude';
    request.csv!.missingCoordinates = 'preserve-null';
    request.fields.push({ id: 'metric', name: 'Metric', type: 'number', input: 'metric' });
    const preview = await importer.prepare(
      bytes('id,lon,lat,name,metric\n01,20,10,,0\n02,,,,\n03,,4,Unknown,NaN'),
      request,
    );
    expect(preview.plan.candidates[0].feature).toMatchObject({
      geometry: { type: 'Point', coordinates: [10, 20] },
      values: { name: '', metric: 0 },
    });
    expect(preview.plan.candidates[1].feature).toMatchObject({
      geometry: null,
      values: { name: '', metric: null },
    });
    expect(errors(preview)).toEqual([3]);
  });
  it('UC1 FR01 AC02: strict invalid numbers are diagnostics, never zero or accepted rows', async () => {
    const { importer, request } = setup();
    const invalid = ['', 'NaN', 'Infinity', '1e309', ' 1', '0x10', '1oops'];
    const preview = await importer.prepare(
      bytes('id,lon,lat,name\n' + invalid.map((n, i) => `${i},${n},0,N`).join('\n')),
      request,
    );
    expect(preview.plan.counts.valid).toBe(0);
    expect(errors(preview)).toHaveLength(invalid.length);
    expect(
      preview.plan.candidates.every((c) =>
        c.diagnostics.some((d) => d.code === 'coordinate-number'),
      ),
    ).toBe(true);
  });
  it('FR02/03 AC04/05: GeoJSON preserves null/Multi/holes/dateline/poles and typed IDs', async () => {
    const { importer, request, current } = setup('geojson');
    const shapes = [
      null,
      {
        type: 'MultiPoint',
        coordinates: [
          [180, 90],
          [-180, -90],
        ],
      },
      {
        type: 'LineString',
        coordinates: [
          [179, 0],
          [-179, 0],
        ],
      },
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [5, 0],
            [5, 5],
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
    ];
    const data = collection(
      shapes.map((geometry, i) => ({ ...point(i === 0 ? 1 : i === 1 ? '1' : null), geometry })),
    );
    const preview = await importer.prepare(data, request);
    expect(preview.plan.layer.features.map((f) => f.geometry)).toEqual(shapes);
    expect(preview.assignments.map((a) => a.externalId)).toEqual([1, '1', null, null]);
    expect(
      preview.plan.candidates
        .slice(0, 2)
        .every((c) => !c.diagnostics.some((d) => d.code === 'duplicate-external-id')),
    ).toBe(true);
    const result = await importer.confirm(
      preview,
      { mode: 'all' },
      { bytes: data, pin: request.source.pin },
      current,
    );
    expect(result.imported).toBe(4);
  });
  it('FR01 AC02: nested properties, extra dimensions and unsupported geometry never flatten', async () => {
    const { importer, request } = setup('geojson');
    const source = [
      { ...point('a'), properties: { name: { secret: 'nested' } } },
      { ...point('b'), geometry: { type: 'Point', coordinates: [0, 0, 3] } },
      { ...point('c'), geometry: { type: 'GeometryCollection', geometries: [] } },
    ];
    const data = collection(source),
      preview = await importer.prepare(data, request);
    expect(errors(preview)).toEqual([1, 2, 3]);
    expect(preview.plan.counts.valid).toBe(0);
    expect(importer.sourceBytes(request.planId)).toEqual(data);
  });
  it.each(['csv', 'geojson'] as const)(
    'FR01 AC02: %s raw bytes/rows/vertices bounds reject before malformed tail',
    async (format) => {
      const tiny = setup(format, { ...limits, sourceBytes: 1 });
      await expect(tiny.importer.prepare(bytes('xx'), tiny.request)).rejects.toThrow(
        'source-byte-limit',
      );
      const row = setup(format, { ...limits, rows: 1 });
      const malformed =
        format === 'csv'
          ? 'id,lon,lat,name\n1,0,0,A\n"unterminated'
          : '{"type":"FeatureCollection","features":[' + JSON.stringify(point()) + ',bad]}';
      await expect(row.importer.prepare(bytes(malformed), row.request)).rejects.toThrow(
        'row-limit',
      );
      const vertex = setup(format, { ...limits, native: { ...limits.native, vertices: 1 } });
      const many =
        format === 'csv'
          ? 'id,lon,lat,name\n1,0,0,A\n2,1,1,B\n"unterminated'
          : '{"type":"FeatureCollection","features":[' +
            JSON.stringify(point('a')) +
            ',' +
            JSON.stringify(point('b')) +
            ',bad]}';
      await expect(vertex.importer.prepare(bytes(many), vertex.request)).rejects.toThrow(
        'vertex-limit',
      );
    },
  );
  it('FR01 AC02: CRS, syntax, depth and duplicate object/header keys reject explicitly', async () => {
    for (const text of [
      'id,lon,lat,name\n1,0,0,"unclosed',
      'id,lon,lat,name\n1,0,0,"quoted"suffix',
      'id,lon,lat,id\n1,0,0,2',
    ]) {
      const { importer, request } = setup();
      await expect(importer.prepare(bytes(text), request)).rejects.toThrow(/csv-/);
    }
    const crs = setup('geojson');
    await expect(
      crs.importer.prepare(
        bytes('{"type":"FeatureCollection","features":[],"crs":{}}'),
        crs.request,
      ),
    ).rejects.toThrow('geojson-legacy-crs');
    const duplicate = setup('geojson');
    await expect(
      duplicate.importer.prepare(
        bytes('{"type":"FeatureCollection","features":[],"features":[]}'),
        duplicate.request,
      ),
    ).rejects.toThrow('duplicate-json-key');
    const deep = setup('geojson', { ...limits, native: { ...limits.native, depth: 12 } });
    await expect(
      deep.importer.prepare(
        bytes('{"type":"FeatureCollection","features":' + '['.repeat(20)),
        deep.request,
      ),
    ).rejects.toThrow('depth-limit');
    const unsupported = setup();
    unsupported.request.crs = 'EPSG:4326' as 'OGC:CRS84';
    await expect(unsupported.importer.prepare(bytes(csv), unsupported.request)).rejects.toThrow(
      'crs-unsupported',
    );
  });
  it('FR01/07/08 AC02/03/08: changing preview revision/pin/candidates/diagnostics/digest rejects', async () => {
    const { importer, request, current } = setup();
    const data = bytes(csv),
      preview = await importer.prepare(data, request);
    const changes: ((p: ImportPreview) => void)[] = [
      (p) => p.request.revision.sequence++,
      (p) => (p.request.source.pin.versionId = 'v2'),
      (p) => (p.plan.source.pin.versionId = 'v2'),
      (p) => (p.plan.candidates[0].feature.values.name = 'changed'),
      (p) =>
        p.plan.candidates[0].diagnostics.push({ code: 'invented', severity: 'warning', path: '$' }),
      (p) => (p.planDigest = `sha256:${'f'.repeat(64)}`),
    ];
    for (const change of changes) {
      const modified = structuredClone(preview);
      change(modified);
      await expect(
        importer.confirm(
          modified,
          { mode: 'all' },
          { bytes: data, pin: request.source.pin },
          current,
        ),
      ).rejects.toThrow('preview-changed-or-unknown');
    }
    expect(Object.isFrozen(preview.plan.candidates[0].feature.values)).toBe(true);
    const other = createGeoImporter(limits);
    await expect(
      other.confirm(preview, { mode: 'all' }, { bytes: data, pin: request.source.pin }, current),
    ).rejects.toThrow('preview-changed-or-unknown');
  });
  it('FR08/10 AC08/11: source bytes/pin mismatch, stale preview and async revoke reject', async () => {
    const { importer, request, current, session } = setup();
    const data = bytes(csv),
      preview = await importer.prepare(data, request);
    await expect(
      importer.confirm(
        preview,
        { mode: 'all' },
        { bytes: bytes(csv.replace('Alpha', 'Beta')), pin: request.source.pin },
        current,
      ),
    ).rejects.toThrow('source-bytes-changed');
    await expect(
      importer.confirm(
        preview,
        { mode: 'all' },
        { bytes: data, pin: { ...request.source.pin, versionId: 'v2' } },
        current,
      ),
    ).rejects.toThrow('source-pin-changed');
    await expect(
      importer.confirm(preview, { mode: 'all' }, { bytes: data, pin: request.source.pin }, () => ({
        ...current(),
        revision: { ...session.revision, sequence: 1 },
      })),
    ).rejects.toThrow('stale-preview');
    let canEdit = true;
    const pending = importer.confirm(
      preview,
      { mode: 'all' },
      { bytes: data, pin: request.source.pin },
      () => ({ ...current(), canEdit }),
    );
    canEdit = false;
    await expect(pending).rejects.toThrow('permission-denied');
    expect(session.content).toEqual(emptyGeo());
    expect(session.canUndo).toBe(false);
  });
  it('FR10 AC11: getter/hidden hook/sparse request/preview/byte material reject with zero calls', async () => {
    const { importer, request, current } = setup();
    let calls = 0;
    const bad = structuredClone(request);
    Object.defineProperty(bad, 'format', {
      enumerable: true,
      get() {
        calls++;
        return 'csv';
      },
    });
    await expect(importer.prepare(bytes(csv), bad)).rejects.toThrow('unsafe-json-or-depth');
    const sparse = structuredClone(request);
    sparse.fields = new Array(1);
    await expect(importer.prepare(bytes(csv), sparse)).rejects.toThrow('unsafe-json-or-depth');
    const data = bytes(csv),
      preview = await importer.prepare(data, request),
      hook = structuredClone(preview);
    Object.defineProperty(hook, 'toJSON', {
      value() {
        calls++;
        return preview;
      },
    });
    await expect(
      importer.confirm(hook, { mode: 'all' }, { bytes: data, pin: request.source.pin }, current),
    ).rejects.toThrow('unsafe-json-or-depth');
    const material = { bytes: data, pin: request.source.pin };
    Object.defineProperty(material, 'bytes', {
      enumerable: true,
      get() {
        calls++;
        return data;
      },
    });
    await expect(importer.confirm(preview, { mode: 'all' }, material, current)).rejects.toThrow(
      'source-material',
    );
    const attached = bytes(csv);
    Object.defineProperty(attached, 'byteLength', {
      get() {
        calls++;
        return 1;
      },
    });
    const fresh = setup();
    await expect(fresh.importer.prepare(attached, fresh.request)).rejects.toThrow(
      'source-bytes-properties',
    );
    expect(calls).toBe(0);
  });
  it('FR08/10 AC08/12: owned bytes, bounded registry, release/dispose reject late confirmations', async () => {
    const { importer, request, current } = setup('csv', { ...limits, pendingPlans: 1 });
    const data = bytes(csv),
      promise = importer.prepare(data, request);
    data.fill(0);
    const preview = await promise;
    expect(preview.sourceBytesHash).toBe(hash(bytes(csv)));
    const copy = importer.sourceBytes(request.planId);
    copy.fill(0);
    expect(importer.sourceBytes(request.planId)).toEqual(bytes(csv));
    await expect(importer.prepare(bytes(csv), { ...request, planId: 'other' })).rejects.toThrow(
      'pending-plan-limit',
    );
    const confirm = importer.confirm(
      preview,
      { mode: 'all' },
      { bytes: bytes(csv), pin: request.source.pin },
      current,
    );
    importer.release(request.planId);
    await expect(confirm).rejects.toThrow('preview-released');
    importer.dispose();
    await expect(importer.prepare(bytes(csv), request)).rejects.toThrow('importer-disposed');
  });
  it('UC2 FR03 AC05: 47 actual CSV keys keep zero prefixes and boolean/null types', async () => {
    const { importer, request } = setup();
    request.fields = [
      { id: 'code', name: 'Code', type: 'string', input: 'id' },
      { id: 'name', name: 'Name', type: 'string', input: 'name' },
      { id: 'active', name: 'Active', type: 'boolean', input: 'active' },
    ];
    const data = bytes(
      'id,lon,lat,name,active\n' +
        Array.from(
          { length: 47 },
          (_, i) =>
            `${String(i).padStart(2, '0')},0,0,Region ${i},${i === 2 ? '' : i % 2 ? 'true' : 'false'}`,
        ).join('\n'),
    );
    const preview = await importer.prepare(data, request);
    expect(preview.plan.counts).toEqual({ read: 47, valid: 47, problem: 0 });
    expect(preview.plan.layer.features[1].values).toEqual({
      code: '01',
      name: 'Region 1',
      active: true,
    });
    expect(preview.plan.layer.features[2].values.active).toBeNull();
    expect(preview.plan.layer.features[0].values.active).toBe(false);
  });
  it('FR08 AC08: source/transform/plan digests independently match owned exact snapshots', async () => {
    const { importer, request, current } = setup();
    const data = bytes(csv),
      prepare = importer.prepare(data, request);
    request.revision.sequence++;
    request.fields[0].name = 'Mutated after preparation';
    const preview = await prepare;
    expect(preview.request.fields[0].name).toBe('Name');
    expect(preview.request.revision.sequence).toBe(0);
    const { planDigest, ...payload } = preview;
    expect(planDigest).toBe(hash(bytes(JSON.stringify(payload))));
    expect(preview.transformedHash).toBe(hash(bytes(JSON.stringify(preview.plan.layer))));
    const pin = preview.request.source.pin;
    const result = await importer.confirm(
      preview,
      { mode: 'all' },
      {
        bytes: data,
        pin: { contentHash: pin.contentHash, versionId: pin.versionId, artifactId: pin.artifactId },
      },
      current,
    );
    expect(result.planDigest).toBe(planDigest);
  });
  it('FR10 AC11/12: confirmation snapshots partial choice before async source hashing', async () => {
    const { importer, request, current } = setup();
    const data = bytes(csv + '002,,0,Invalid\n'),
      preview = await importer.prepare(data, request);
    const choice = { mode: 'partial' as const, excludedRows: [2] };
    const pending = importer.confirm(
      preview,
      choice,
      { bytes: data, pin: request.source.pin },
      current,
    );
    choice.excludedRows.length = 0;
    const result = await pending;
    expect(result.imported).toBe(1);
    expect(result.excluded.map((c) => c.inputRow)).toEqual([2]);
  });
  it('FR07/10 AC03/12: accepted command remains detached and execution still checks revoke', async () => {
    const { importer, request, current, session } = setup();
    const data = bytes(csv),
      preview = await importer.prepare(data, request);
    let canEdit = true;
    const result = await importer.confirm(
      preview,
      { mode: 'all' },
      { bytes: data, pin: request.source.pin },
      () => ({ ...current(), canEdit }),
    );
    const action = result.command.actions[0];
    if (action.type === 'importLayer')
      action.layer.features[0].values.name = 'Caller changed returned data';
    canEdit = false;
    expect(() => session.execute(result.editorCommand)).toThrow('permission-denied');
    expect(session.canUndo).toBe(false);
    canEdit = true;
    session.execute(result.editorCommand);
    expect(session.content.layers[0].features[0].values.name).toBe('Alpha');
  });
  it('FR08/10 AC12: released preview cannot revive on reused plan ID; pending generation isolated', async () => {
    const { importer, request, current } = setup();
    const data = bytes(csv),
      old = await importer.prepare(data, request);
    importer.release(request.planId);
    const replacement = await importer.prepare(data, request);
    expect(replacement.sequence).not.toBe(old.sequence);
    await expect(
      importer.confirm(old, { mode: 'all' }, { bytes: data, pin: request.source.pin }, current),
    ).rejects.toThrow('preview-changed-or-unknown');
    importer.release(request.planId);
    const pending = importer.prepare(data, request);
    importer.release(request.planId);
    const next = importer.prepare(data, request);
    const outcomes = await Promise.allSettled([pending, next]);
    expect(outcomes[0].status).toBe('rejected');
    expect(outcomes[1].status).toBe('fulfilled');
    const dying = setup();
    const preparing = dying.importer.prepare(data, dying.request);
    dying.importer.dispose();
    await expect(preparing).rejects.toThrow('importer-disposed');
  });
  it('FR01 AC02: columns, UTF-8 and numeric GeoJSON overflow fail without repaired acceptance', async () => {
    const columns = setup('csv', { ...limits, columns: 4 });
    await expect(
      columns.importer.prepare(bytes('id,lon,lat,name,"unterminated'), columns.request),
    ).rejects.toThrow('column-limit');
    const utf = setup();
    await expect(utf.importer.prepare(new Uint8Array([0xff]), utf.request)).rejects.toThrow();
    const numeric = setup('geojson');
    const invalid = bytes(
      '{"type":"FeatureCollection","features":[{"type":"Feature","id":"1","geometry":{"type":"Point","coordinates":[1e309,0]},"properties":{"name":"A"}}]}',
    );
    const result = await numeric.importer.prepare(invalid, numeric.request);
    expect(result.plan.counts.valid).toBe(0);
    expect(errors(result)).toEqual([1]);
    const bom = setup('geojson');
    const data = bytes('\uFEFF' + new TextDecoder().decode(collection([point()])));
    const preview = await bom.importer.prepare(data, bom.request);
    expect(preview.sourceBytesHash).toBe(hash(data));
    expect(preview.plan.counts.valid).toBe(1);
  });
});
