import { describe, expect, it, vi } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import {
  prepareGeoDataExport,
  confirmGeoDataExport,
  type GeoExportCapture,
  type GeoDataExportLimits,
  type GeoDataExportSelection,
} from './data-export';
import { parseCsv } from './import-parser';

const hash = `sha256:${'a'.repeat(64)}`;
const limits: GeoDataExportLimits = {
  native: { actions: 10, bytes: 100000, depth: 24, layers: 10, features: 200, vertices: 2000 },
  outputBytes: 100000,
};
function capture(): GeoExportCapture {
  return {
    pin: { artifactId: 'native', versionId: 'v1', contentHash: hash },
    content: {
      schemaVersion: 1,
      layers: [
        {
          id: 'sites',
          name: '合成地域',
          crs: 'OGC:CRS84',
          axis: 'longitude-latitude',
          fields: [
            { id: 'code', name: 'Same name', type: 'string' },
            { id: 'amount', name: 'Same name', type: 'number' },
            { id: 'active', name: '<img src=x onerror=alert(1)>', type: 'boolean' },
          ],
          features: [
            {
              id: 'f1',
              rowId: 'r1',
              geometry: { type: 'Point', coordinates: [12, 34] },
              values: { code: '001', amount: 0, active: false },
              sourceRef: { sourceId: 'source', externalId: '001' },
            },
            {
              id: 'f2',
              rowId: 'r2',
              geometry: null,
              values: { code: '', amount: null, active: null },
            },
            {
              id: 'f3',
              rowId: 'r3',
              geometry: {
                type: 'MultiPoint',
                coordinates: [
                  [179, 80],
                  [-179, 80],
                ],
              },
              values: {
                code: '=HYPERLINK("https://invalid.example")\r\n日本',
                amount: 3,
                active: true,
              },
            },
          ],
        },
      ],
      sources: [
        {
          id: 'source',
          resourceId: 'resource',
          bytesHash: hash,
          pin: { artifactId: 'source', versionId: 'sv1', contentHash: hash },
          format: 'geojson',
          adapterVersion: 'test',
          declaredCrs: 'OGC:CRS84',
          axis: 'longitude-latitude',
          attribution: 'Synthetic only',
        },
      ],
    },
  };
}
const selection: GeoDataExportSelection = {
  layerId: 'sites',
  fieldIds: ['code', 'amount', 'active'],
  format: 'geojson',
};
const prepare = (input = capture(), chosen = selection, budget = limits) =>
  prepareGeoDataExport(input, chosen, budget);

describe('Geo FR09 / AC10 bounded data export', () => {
  it('preserves holes/Multi polygons without repair and reports unverified topology', () => {
    const input = capture();
    input.content.layers[0].features[0].geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 0],
        ],
        [
          [0.5, 0.5],
          [1, 0.5],
          [1, 1],
          [0.5, 0.5],
        ],
      ],
    };
    const preview = prepare(input);
    expect(preview.warnings).toContain('topology-not-checked');
    expect(JSON.parse(preview.data.text).features[0].geometry).toEqual(
      input.content.layers[0].features[0].geometry,
    );
  });
  it('exports all 198 explicitly retained features without truncation or implicit filtering', async () => {
    const input = capture(),
      seed = input.content.layers[0].features[0];
    input.content.layers[0].features = Array.from({ length: 198 }, (_, i) => ({
      ...structuredClone(seed),
      id: `feature-${i}`,
      rowId: `row-${i}`,
      values: { code: String(i).padStart(3, '0'), amount: i, active: false },
    }));
    const preview = prepare(
      input,
      { ...selection, fieldIds: ['code', 'amount'] },
      { ...limits, outputBytes: 200000 },
    );
    const result = await confirmGeoDataExport(preview, preview.warnings, () => true);
    expect(JSON.parse(result.data.text).features).toHaveLength(198);
    expect(JSON.parse(result.receipt.text).rows).toHaveLength(198);
  });
  it('exports typed GeoJSON and receipt with exact native IDs, geometry, selected fields and source correspondence', async () => {
    const input = capture(),
      before = structuredClone(input),
      preview = prepare(input);
    const bundle = await confirmGeoDataExport(preview, preview.warnings, () => true);
    const output = JSON.parse(bundle.data.text),
      receipt = JSON.parse(bundle.receipt.text);
    expect(output.type).toBe('FeatureCollection');
    expect(output.features.map((f: { id: string }) => f.id)).toEqual(['f1', 'f2', 'f3']);
    expect(output.features.map((f: { geometry: unknown }) => f.geometry)).toEqual(
      input.content.layers[0].features.map((f) => f.geometry),
    );
    expect(output.features.map((f: { properties: unknown }) => f.properties)).toEqual(
      input.content.layers[0].features.map((f) => f.values),
    );
    expect(receipt.input).toEqual(input.pin);
    expect(receipt.sources).toEqual(input.content.sources);
    expect(receipt.rows[0]).toEqual({
      featureId: 'f1',
      rowId: 'r1',
      sourceRef: { sourceId: 'source', externalId: '001' },
    });
    expect(receipt.nullGeometryCount).toBe(1);
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bundle.data.text)),
    );
    expect(receipt.output.bytesHash).toBe(
      `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`,
    );
    expect(receipt.output.bytes).toBe(new TextEncoder().encode(bundle.data.text).length);
    expect(input).toEqual(before);
  });
  it('CSV round-trips JSON scalars without conflating null, empty, zero, false, leading zeros or formula-like strings', async () => {
    const input = capture(),
      preview = prepare(input, { ...selection, format: 'csv' });
    const bundle = await confirmGeoDataExport(preview, preview.warnings, () => true);
    const rows = [
      ...parseCsv(bundle.data.text, { rows: 10, columns: 10, depth: 24, vertices: 2000 }),
    ];
    expect(rows[0]).toEqual(['_feature_id', '_row_id', 'code', 'amount', 'active']);
    const values = rows.slice(1).map((r) => r.map((cell) => JSON.parse(cell)));
    expect(values).toEqual(
      input.content.layers[0].features.map((f) => [
        f.id,
        f.rowId,
        f.values.code,
        f.values.amount,
        f.values.active,
      ]),
    );
    expect(rows[3][2].startsWith('"=')).toBe(true);
    expect(preview.warnings).toContain('geometry-omitted');
    expect(JSON.parse(bundle.receipt.text).csvEncoding).toContain('JSON scalar');
  });
  it('requires exact acknowledgements and explicit attributes; omitted fields and other layers stay absent', async () => {
    const input = capture();
    input.content.layers.push({
      ...structuredClone(input.content.layers[0]),
      id: 'private',
      name: 'private',
      features: [],
    });
    input.content.sources.push({
      ...structuredClone(input.content.sources[0]),
      id: 'unused',
      attribution: 'unrelated-secret',
    });
    const preview = prepare(input, { ...selection, fieldIds: ['amount'] });
    expect(preview.omittedFieldIds).toEqual(['code', 'active']);
    expect(preview.warnings).toContain('attributes-omitted');
    await expect(confirmGeoDataExport(preview, [], () => true)).rejects.toThrow(
      'export-confirmation-required',
    );
    await expect(
      confirmGeoDataExport(preview, [...preview.warnings, preview.warnings[0]], () => true),
    ).rejects.toThrow('export-confirmation-required');
    const output = await confirmGeoDataExport(preview, preview.warnings, () => true);
    expect(JSON.parse(output.data.text).features[0].properties).toEqual({ amount: 0 });
    expect(output.receipt.text).not.toContain('unrelated-secret');
    expect(output.data.text).not.toContain('private');
  });
  it('supports no selected attributes and empty layers without inventing or dropping rows', async () => {
    const preview = prepare(capture(), { ...selection, fieldIds: [] });
    expect(
      JSON.parse(preview.data.text).features.map((f: { properties: unknown }) => f.properties),
    ).toEqual([{}, {}, {}]);
    const input = capture();
    input.content.layers[0].features = [];
    const empty = prepare(input, { ...selection, format: 'csv', fieldIds: [] });
    const result = await confirmGeoDataExport(empty, empty.warnings, () => true);
    expect(result.data.text).toBe('"_feature_id","_row_id"\r\n');
  });
  it('freezes detached inputs and selection; later native/source updates cannot alter old output', async () => {
    const input = capture(),
      chosen = structuredClone(selection),
      preview = prepare(input, chosen);
    input.content.layers[0].features[0].values.code = 'updated';
    input.content.sources[0].bytesHash = `sha256:${'b'.repeat(64)}`;
    chosen.fieldIds.length = 0;
    expect(Object.isFrozen(preview.capture.content.layers[0].features[0].values)).toBe(true);
    const a = await confirmGeoDataExport(preview, preview.warnings, () => true);
    const b = await confirmGeoDataExport(preview, preview.warnings, () => true);
    expect(a).toEqual(b);
    expect(JSON.parse(a.data.text).features[0].properties.code).toBe('001');
    expect(JSON.parse(a.receipt.text).sources[0].bytesHash).toBe(hash);
  });
  it('rejects invalid native/nested properties, unknown selections, duplicate fields, schema and fabricated previews', async () => {
    const input = capture();
    Object.assign(input.content.layers[0].features[0].values, { nested: { x: 1 } });
    expect(() => prepare(input)).toThrow('scalar-schema');
    expect(() => prepare(capture(), { ...selection, fieldIds: ['code', 'code'] })).toThrow(
      'export-selection',
    );
    expect(() => prepare(capture(), { ...selection, fieldIds: ['missing'] })).toThrow(
      'export-field',
    );
    expect(() => prepare(capture(), { ...selection, layerId: 'missing' })).toThrow('export-layer');
    const bad = capture();
    Object.assign(bad.content, { schemaVersion: 2 });
    expect(() => prepare(bad)).toThrow('schema');
    const invalidPin = capture();
    invalidPin.pin.contentHash = 'not-a-hash';
    expect(() => prepare(invalidPin)).toThrow('export-pin');
    const preview = prepare();
    await expect(
      confirmGeoDataExport(structuredClone(preview), preview.warnings, () => true),
    ).rejects.toThrow('export-unknown-preview');
  });
  it('does not invoke accessors or toJSON from untrusted native or selection values', () => {
    const input = capture(),
      getter = vi.fn(() => 0);
    Object.defineProperty(input.content.layers[0].features[0].values, 'amount', {
      enumerable: true,
      get: getter,
    });
    expect(() => prepare(input)).toThrow('unsafe-json');
    expect(getter).not.toHaveBeenCalled();
    const callback = vi.fn();
    expect(() =>
      prepare(capture(), { ...selection, toJSON: callback } as GeoDataExportSelection),
    ).toThrow('unsafe-json');
    expect(callback).not.toHaveBeenCalled();
  });
  it('enforces native, UTF-8 data and combined receipt budgets before producing a bundle', async () => {
    expect(() => prepare(capture(), selection, { ...limits, outputBytes: 10 })).toThrow();
    expect(() =>
      prepare(capture(), { ...selection, format: 'csv' }, { ...limits, outputBytes: 10 }),
    ).toThrow('export-byte-limit');
    expect(() =>
      prepare(capture(), selection, { ...limits, native: { ...limits.native, features: 2 } }),
    ).toThrow('feature-limit');
    for (const value of [0, -1, NaN, Infinity, 1.5])
      expect(() => prepare(capture(), selection, { ...limits, outputBytes: value })).toThrow(
        'export-limits',
      );
    const enoughForData = new TextEncoder().encode(prepare().data.text).length + 10;
    const preview = prepare(capture(), selection, { ...limits, outputBytes: enoughForData });
    await expect(confirmGeoDataExport(preview, preview.warnings, () => true)).rejects.toThrow();
  });
  it('requires live version/hash/closure/grant proof, before and after digest; no truthy/async bypass', async () => {
    const preview = prepare();
    for (const answer of [false, 1, Promise.resolve(true)]) {
      await expect(
        confirmGeoDataExport(preview, preview.warnings, () => answer as boolean),
      ).rejects.toThrow('export-not-authorized');
    }
    let allowed = true;
    const real = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      allowed = false;
      return real(...args);
    });
    try {
      await expect(confirmGeoDataExport(preview, preview.warnings, () => allowed)).rejects.toThrow(
        'export-not-authorized',
      );
    } finally {
      spy.mockRestore();
    }
  });
  it('Host verifies the exact native hash; declarations alone never establish authority', async () => {
    const input = capture();
    input.pin.contentHash = `sha256:${await contentHash(input.content)}`;
    const preview = prepare(input),
      actual = JSON.stringify(input);
    const bundle = await confirmGeoDataExport(
      preview,
      preview.warnings,
      (c) => JSON.stringify(c) === actual,
    );
    expect(JSON.parse(bundle.receipt.text).input.contentHash).toBe(input.pin.contentHash);
    const fake = capture();
    const refused = prepare(fake);
    await expect(
      confirmGeoDataExport(refused, refused.warnings, (c) => JSON.stringify(c) === actual),
    ).rejects.toThrow('export-not-authorized');
  });
});
