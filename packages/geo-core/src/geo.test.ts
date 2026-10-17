import { describe, expect, it, vi } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  applyGeoCommand,
  confirmImport,
  emptyGeo,
  geoEditorCommand,
  parseGeo,
  prepareImport,
  serializeGeo,
  validateGeo,
  type Budgets,
  type GeoCommand,
  type GeoAction,
  type Feature,
  type GeoDocument,
  type Geometry,
  type SourceSnapshot,
  type VectorLayer,
} from './index';
const budgets: Budgets = {
  actions: 1000,
  bytes: 1_000_000,
  depth: 20,
  layers: 10,
  features: 1000,
  vertices: 10000,
};
const hash = `sha256:${'a'.repeat(64)}`;
const source: SourceSnapshot = {
  id: 'source',
  pin: { artifactId: 'synthetic', versionId: 'v1', contentHash: hash },
  resourceId: 'resource',
  bytesHash: hash,
  format: 'csv',
  adapterVersion: 'm0',
  declaredCrs: 'OGC:CRS84',
  axis: 'longitude-latitude',
  attribution: 'Synthetic fixture; no real locations',
};
const feature = (n = 0): Feature => ({
  id: `f${n}`,
  rowId: `r${n}`,
  geometry: { type: 'Point', coordinates: [n % 180, 0] },
  values: { code: String(n).padStart(2, '0') },
  sourceRef: { sourceId: 'source', externalId: n },
});
const layer: VectorLayer = {
  id: 'layer',
  name: 'Synthetic',
  crs: 'OGC:CRS84',
  axis: 'longitude-latitude',
  fields: [{ id: 'code', name: 'Code', type: 'string' }],
  features: [feature()],
};
const document = (): GeoDocument =>
  structuredClone({ schemaVersion: 1, layers: [layer], sources: [source] });
const revision = { sessionId: 'test', sequence: 0 };
const context = { revision, canEdit: true, budgets };
const errors = (v: unknown, b = budgets) =>
  validateGeo(v, b)
    .filter((d) => d.severity === 'error')
    .map((d) => d.code);
describe('Geo M0 functional contracts', () => {
  it('UC1 FR01 AC01: 200 candidates, default block, explicit 198 and exclusion ledger', () => {
    const candidates = Array.from({ length: 200 }, (_, i) => ({
      inputRow: i + 1,
      feature: feature(i),
      diagnostics: [],
    }));
    candidates[5].feature.geometry = { type: 'Point', coordinates: [181, 0] };
    candidates[9].feature.geometry = { type: 'Point', coordinates: [0, 91] };
    const plan = prepareImport(layer, source, candidates, budgets);
    expect(plan.counts).toEqual({ read: 200, valid: 198, problem: 2 });
    expect(() => confirmImport(plan, revision, false, budgets)).toThrow('import-blocked');
    const confirmed = confirmImport(plan, revision, true, budgets);
    expect(confirmed.excluded.map((c) => c.inputRow)).toEqual([6, 10]);
    const input = emptyGeo();
    const before = structuredClone(input);
    expect(applyGeoCommand(input, confirmed.command, context).layers[0].features).toHaveLength(198);
    expect(input).toEqual(before);
  });
  it('UC1 FR01 AC02: duplicates remain fatal even with partial confirmation', () => {
    const plan = prepareImport(
      layer,
      source,
      [1, 2].map((inputRow) => ({ inputRow, feature: feature(), diagnostics: [] })),
      budgets,
    );
    expect(() => confirmImport(plan, revision, true, budgets)).toThrow('import-blocked');
  });
  it('UC1/3 FR03/07 AC03: atomic edit, native roundtrip, same ID, shared local Undo', () => {
    const session = new EditorSession(document());
    const before = session.content;
    const command = geoEditorCommand(
      {
        expectedRevision: session.revision,
        actions: [
          {
            type: 'replaceGeometry',
            layerId: 'layer',
            featureId: 'f0',
            geometry: { type: 'Point', coordinates: [10, 20] },
          },
          { type: 'setAttribute', layerId: 'layer', featureId: 'f0', fieldId: 'code', value: '01' },
        ],
      },
      () => ({ revision: session.revision, canEdit: true, budgets }),
    );
    session.execute(command);
    const after = session.content;
    expect(after.layers[0].features[0]).toMatchObject({
      id: 'f0',
      rowId: 'r0',
      values: { code: '01' },
      geometry: { type: 'Point', coordinates: [10, 20] },
    });
    expect(parseGeo(serializeGeo(after, budgets), budgets)).toEqual(after);
    expect(session.undo()).toEqual(before);
    expect(session.redo()).toEqual(after);
    expect(() => session.execute(command)).toThrow('stale-revision');
    expect(session.content).toEqual(after);
  });
  it('FR07 AC03: failed second action leaves content and history untouched', () => {
    const session = new EditorSession(document());
    expect(() =>
      session.execute(
        geoEditorCommand(
          {
            expectedRevision: session.revision,
            actions: [
              { type: 'deleteFeature', layerId: 'layer', featureId: 'f0' },
              {
                type: 'setAttribute',
                layerId: 'layer',
                featureId: 'f0',
                fieldId: 'code',
                value: 'x',
              },
            ],
          },
          () => ({ revision: session.revision, canEdit: true, budgets }),
        ),
      ),
    ).toThrow('missing-feature');
    expect(session.content).toEqual(document());
    expect(session.canUndo).toBe(false);
    expect(() =>
      applyGeoCommand(
        document(),
        { expectedRevision: revision, actions: [] },
        { ...context, canEdit: false },
      ),
    ).toThrow('permission-denied');
  });
  it.each([
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
  ] as (Geometry | null)[])(
    'FR02 AC04: preserves null, multi, dateline, polar and holes: %j',
    (geometry) => {
      const d = document();
      d.layers[0].features[0].geometry = geometry;
      expect(errors(d)).toEqual([]);
      expect(parseGeo(serializeGeo(d, budgets), budgets)).toEqual(d);
      if (geometry?.type === 'Polygon' || geometry?.type === 'MultiPoint')
        expect(() =>
          applyGeoCommand(
            d,
            {
              expectedRevision: revision,
              actions: [
                { type: 'replaceGeometry', layerId: 'layer', featureId: 'f0', geometry: null },
              ],
            },
            context,
          ),
        ).toThrow('geometry-readonly');
    },
  );
  it('UC2 FR03 AC05: 47 region codes preserve leading zeros and typed null', () => {
    const d = document();
    d.layers[0].features = Array.from({ length: 47 }, (_, i) => feature(i));
    d.layers[0].features[2].values.code = null;
    expect(parseGeo(serializeGeo(d, budgets), budgets).layers[0].features[1].values.code).toBe(
      '01',
    );
    expect(
      parseGeo(serializeGeo(d, budgets), budgets).layers[0].features[2].values.code,
    ).toBeNull();
  });
  it('FR01/08 AC02/08: rejects axis, schema, dimensions, nonfinite, bounds and scalar loss', () => {
    const d = document();
    expect(errors({ ...d, schemaVersion: 2 })).toContain('schema');
    d.layers[0].crs = 'EPSG:4326' as 'OGC:CRS84';
    expect(errors(d)).toContain('crs-axis');
    for (const coordinates of [
      [0, 0, 1],
      [NaN, 0],
      [Infinity, 0],
      [0, 91],
    ]) {
      const v = document();
      v.layers[0].features[0].geometry = { type: 'Point', coordinates } as Geometry;
      expect(errors(v).length).toBeGreaterThan(0);
    }
    const nested = document();
    nested.layers[0].features[0].values.code = {} as never;
    expect(errors(nested)).toContain('scalar-schema');
    expect(errors(document(), { ...budgets, bytes: 10 })).toContain('byte-limit');
    expect(errors(document(), { ...budgets, depth: 2 })).toContain('unsafe-json-or-depth');
    const duplicate = document();
    duplicate.layers[0].features.push(feature());
    expect(errors(duplicate)).toContain('feature-or-duplicate-id');
  });
  it('FR10 AC11: strings remain inert, unknown executable fields rejected', () => {
    const d = document();
    d.layers[0].features[0].values.code = '<script>throw 1</script>';
    expect(errors(d)).toEqual([]);
    expect(errors({ ...d, url: 'https://example.invalid' })).toContain('unknown-field');
  });
  it('FR07/10 AC03/11: permission is rechecked at execution, invalid final type rolls back', () => {
    const session = new EditorSession(document());
    let canEdit = true;
    const command = geoEditorCommand(
      {
        expectedRevision: session.revision,
        actions: [
          { type: 'setAttribute', layerId: 'layer', featureId: 'f0', fieldId: 'code', value: 42 },
        ],
      },
      () => ({ revision: session.revision, canEdit, budgets }),
    );
    canEdit = false;
    expect(() => session.execute(command)).toThrow('permission-denied');
    canEdit = true;
    expect(() => session.execute(command)).toThrow('scalar-schema');
    expect(session.content).toEqual(document());
    expect(session.canUndo).toBe(false);
  });
  it('FR01/08 AC02/08: limits, source refs and ring failures are explicit', () => {
    const d = document();
    d.layers[0].features.push(feature(1));
    expect(errors(d, { ...budgets, features: 1 })).toContain('feature-limit');
    expect(errors(d, { ...budgets, vertices: 1 })).toContain('vertex-limit');
    d.layers.push({ ...structuredClone(layer), id: 'second', features: [] });
    expect(errors(d, { ...budgets, layers: 1 })).toContain('layer-limit');
    const missing = document();
    missing.sources = [];
    expect(errors(missing)).toContain('source-ref');
    const corrupt = document();
    corrupt.sources[0].bytesHash = 'bad';
    expect(errors(corrupt)).toContain('source-pin');
    const ring = document();
    ring.layers[0].features[0].geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
    };
    expect(errors(ring)).toContain('ring-not-closed');
    expect(() => parseGeo(serializeGeo(document(), budgets), { ...budgets, bytes: 1 })).toThrow(
      'byte-limit',
    );
  });
  it('review R1: sparse coordinates reject before roundtrip can substitute null', () => {
    const missingLast = [0, 0];
    delete missingLast[1];
    const missingFirst = [0, 0];
    delete missingFirst[0];
    for (const coordinates of [new Array(2), missingLast, missingFirst]) {
      const d = document();
      d.layers[0].features[0].geometry = { type: 'Point', coordinates } as Geometry;
      expect(errors(d)).toContain('unsafe-json-or-depth');
      expect(() => serializeGeo(d, budgets)).toThrow('unsafe-json-or-depth');
    }
  });
  it('review R2: descriptors reject accessors and hidden serialization hooks without calls', () => {
    let calls = 0;
    const getter = document();
    Object.defineProperty(getter.layers[0].features[0].values, 'code', {
      enumerable: true,
      get() {
        calls++;
        return 'evil';
      },
    });
    const hook = document();
    Object.defineProperty(hook, 'toJSON', {
      value() {
        calls++;
        return { schemaVersion: 99 };
      },
    });
    const hidden = document();
    Object.defineProperty(hidden, 'hidden', { value: 1 });
    const arrayHook = document();
    Object.defineProperty(arrayHook.layers, 'toJSON', {
      value() {
        calls++;
        return [];
      },
    });
    for (const d of [getter, hook, hidden, arrayHook]) {
      expect(errors(d)).toContain('unsafe-json-or-depth');
      expect(() => serializeGeo(d, budgets)).toThrow('unsafe-json-or-depth');
    }
    expect(() =>
      prepareImport(
        layer,
        source,
        [{ inputRow: 1, feature: getter.layers[0].features[0], diagnostics: [] }],
        budgets,
      ),
    ).toThrow('unsafe-json-or-depth');
    expect(calls).toBe(0);
    const valid = document();
    valid.layers[0].features[0].values.code = '漢字😀\n"\\\ud800';
    const serialized = serializeGeo(valid, budgets);
    expect(serialized).toBe(JSON.stringify(valid));
    expect(parseGeo(serialized, budgets)).toEqual(valid);
    const exact = new TextEncoder().encode(serialized).length;
    expect(serializeGeo(valid, { ...budgets, bytes: exact })).toBe(serialized);
    expect(() => serializeGeo(valid, { ...budgets, bytes: exact - 1 })).toThrow('byte-limit');
  });
  it('review R3: limits stop before visiting later values or cloning candidate input', () => {
    // Instrumentation only: Proxy is not a supported untrusted-input sandbox.
    let visits = 0;
    const late = new Proxy(
      {},
      {
        getPrototypeOf() {
          visits++;
          throw new Error('late-value-visited');
        },
      },
    );
    const many = document();
    many.layers[0].features = [feature(), late as Feature];
    expect(errors(many, { ...budgets, features: 1 })).toEqual(['feature-limit']);
    const bytes = document();
    bytes.layers[0].name = 'x'.repeat(10000);
    bytes.layers[0].features = [late as Feature];
    expect(errors(bytes, { ...budgets, bytes: 1000 })).toEqual(['byte-limit']);
    const vertices = document();
    vertices.layers[0].features[0].geometry = {
      type: 'LineString',
      coordinates: [[0, 0], late],
    } as Geometry;
    expect(errors(vertices, { ...budgets, vertices: 1 })).toEqual(['vertex-limit']);
    expect(() =>
      prepareImport(
        layer,
        source,
        [
          { inputRow: 1, feature: feature(), diagnostics: [] },
          { inputRow: 2, feature: late as Feature, diagnostics: [] },
        ],
        { ...budgets, features: 1 },
      ),
    ).toThrow('feature-limit');
    expect(visits).toBe(0);
  });
  it('review R3: cumulative vertices across candidates stop at the limit', () => {
    const metadata = { ...layer, features: [] };
    const candidates = [0, 1, 2].map((i) => ({
      inputRow: i + 1,
      feature: feature(i),
      diagnostics: [],
    }));
    expect(() => prepareImport(metadata, source, candidates, { ...budgets, vertices: 2 })).toThrow(
      'vertex-limit',
    );
    const many = document();
    many.layers.push({ ...structuredClone(layer), id: 'second', features: [feature(1)] });
    expect(errors(many, { ...budgets, features: 1 })).toEqual(['feature-limit']);
  });
  it('review R4: parsed JSON arrays cannot impersonate enums or source IDs', () => {
    const format = JSON.parse(JSON.stringify(document()));
    format.sources[0].format = ['csv'];
    const type = JSON.parse(JSON.stringify(document()));
    type.layers[0].fields[0].type = ['string'];
    const ref = JSON.parse(JSON.stringify(document()));
    ref.layers[0].features[0].sourceRef.sourceId = ['source'];
    expect(errors(format)).toContain('source-pin');
    expect(errors(type)).toContain('field');
    expect(errors(ref)).toContain('source-ref');
    delete ref.layers[0].features[0].sourceRef.sourceId;
    expect(errors(ref)).toContain('source-ref');
    ref.layers[0].features[0].sourceRef.sourceId = 1;
    expect(errors(ref)).toContain('source-ref');
  });
  it('review R5: interactive creation refuses polygons/Multi; import preserves them', () => {
    for (const geometry of [
      { type: 'MultiPoint', coordinates: [[0, 0]] },
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    ] as Geometry[]) {
      const f = { ...feature(1), geometry };
      const before = document();
      expect(() =>
        applyGeoCommand(
          before,
          {
            expectedRevision: revision,
            actions: [{ type: 'addFeature', layerId: 'layer', feature: f }],
          },
          context,
        ),
      ).toThrow('geometry-readonly');
      expect(before).toEqual(document());
      const { features: _features, ...metadata } = layer;
      const plan = prepareImport(
        metadata,
        source,
        [{ inputRow: 1, feature: f, diagnostics: [] }],
        budgets,
      );
      const imported = applyGeoCommand(
        emptyGeo(),
        confirmImport(plan, revision, false, budgets).command,
        context,
      );
      expect(imported.layers[0].features[0].geometry).toEqual(geometry);
    }
  });
  it.each(['prepare', 'direct'] as const)(
    'review R6 %s: executable command data rejects before any clone or hook call',
    (entry) => {
      let calls = 0;
      const action: GeoAction = {
        type: 'setAttribute',
        layerId: 'layer',
        featureId: 'f0',
        fieldId: 'code',
        value: '01',
      };
      const command = (): GeoCommand => ({
        expectedRevision: revision,
        actions: [structuredClone(action)],
      });
      const rootGetter = command();
      Object.defineProperty(rootGetter, 'expectedRevision', {
        enumerable: true,
        get() {
          calls++;
          return revision;
        },
      });
      const actionsGetter = command();
      Object.defineProperty(actionsGetter, 'actions', {
        enumerable: true,
        get() {
          calls++;
          return [];
        },
      });
      const typeGetter = command();
      Object.defineProperty(typeGetter.actions[0], 'type', {
        enumerable: true,
        get() {
          calls++;
          return 'setAttribute';
        },
      });
      const hiddenHook = command();
      Object.defineProperty(hiddenHook, 'toJSON', {
        value() {
          calls++;
          return {};
        },
      });
      const featureGetter = command();
      const f = feature(1);
      Object.defineProperty(f, 'geometry', {
        enumerable: true,
        get() {
          calls++;
          return null;
        },
      });
      featureGetter.actions.push({ type: 'addFeature', layerId: 'layer', feature: f });
      const geometryHook = command();
      const geometry = { type: 'Point', coordinates: [0, 0] };
      Object.defineProperty(geometry, 'toJSON', {
        value() {
          calls++;
          return null;
        },
      });
      geometryHook.actions.push({
        type: 'replaceGeometry',
        layerId: 'layer',
        featureId: 'f0',
        geometry: geometry as Geometry,
      });
      const sourceGetter = command();
      const src = { ...source };
      Object.defineProperty(src, 'bytesHash', {
        enumerable: true,
        get() {
          calls++;
          return hash;
        },
      });
      sourceGetter.actions.push({
        type: 'importLayer',
        layer: structuredClone(layer),
        source: src,
      });
      const layerGetter = command();
      const imported = structuredClone(layer);
      Object.defineProperty(imported, 'features', {
        enumerable: true,
        get() {
          calls++;
          return [];
        },
      });
      layerGetter.actions.push({ type: 'importLayer', layer: imported, source });
      const input = document();
      const before = structuredClone(input);
      for (const payload of [
        rootGetter,
        actionsGetter,
        typeGetter,
        hiddenHook,
        featureGetter,
        geometryHook,
        sourceGetter,
        layerGetter,
      ]) {
        const descriptors = Object.getOwnPropertyDescriptors(payload);
        const clone = vi.spyOn(globalThis, 'structuredClone');
        try {
          expect(() =>
            entry === 'prepare'
              ? geoEditorCommand(payload, () => context)
              : applyGeoCommand(input, payload, context),
          ).toThrow('unsafe-json-or-depth');
          expect(clone).not.toHaveBeenCalled();
        } finally {
          clone.mockRestore();
        }
        expect(Object.getOwnPropertyDescriptors(payload)).toEqual(descriptors);
        expect(input).toEqual(before);
      }
      expect(calls).toBe(0);
    },
  );
  it.each(['prepare', 'direct'] as const)(
    'review R6 %s: total command/action budgets reject before clone or later inspection',
    (entry) => {
      let visits = 0;
      const late = new Proxy(
        {},
        {
          getPrototypeOf() {
            visits++;
            throw new Error('late-command-visited');
          },
        },
      );
      const set: GeoAction = {
        type: 'setAttribute',
        layerId: 'layer',
        featureId: 'f0',
        fieldId: 'code',
        value: 'x'.repeat(600),
      };
      const cases: { actions: GeoAction[]; limits: Budgets; code: string }[] = [
        {
          actions: [set, late as GeoAction],
          limits: { ...budgets, actions: 1 },
          code: 'action-limit',
        },
        {
          actions: [set, set, late as GeoAction],
          limits: { ...budgets, bytes: 1000 },
          code: 'byte-limit',
        },
        {
          actions: [
            { type: 'addFeature', layerId: 'layer', feature: feature(1) },
            { type: 'addFeature', layerId: 'layer', feature: feature(2) },
            late as GeoAction,
          ],
          limits: { ...budgets, features: 1 },
          code: 'feature-limit',
        },
        {
          actions: [
            { type: 'importLayer', layer, source },
            { type: 'importLayer', layer, source },
            late as GeoAction,
          ],
          limits: { ...budgets, layers: 1 },
          code: 'layer-limit',
        },
        {
          actions: [
            {
              type: 'replaceGeometry',
              layerId: 'layer',
              featureId: 'f0',
              geometry: { type: 'LineString', coordinates: [[0, 0], late] } as Geometry,
            },
          ],
          limits: { ...budgets, vertices: 1 },
          code: 'vertex-limit',
        },
      ];
      const input = document();
      const before = structuredClone(input);
      for (const test of cases) {
        const payload = { expectedRevision: revision, actions: test.actions };
        const ctx = { ...context, budgets: test.limits };
        const originalActions = payload.actions.slice();
        const clone = vi.spyOn(globalThis, 'structuredClone');
        try {
          expect(() =>
            entry === 'prepare'
              ? geoEditorCommand(payload, () => ctx)
              : applyGeoCommand(input, payload, ctx),
          ).toThrow(test.code);
          expect(clone).not.toHaveBeenCalled();
        } finally {
          clone.mockRestore();
        }
        expect(input).toEqual(before);
        expect(payload.actions.length).toBe(originalActions.length);
        payload.actions.forEach((a, i) => expect(a).toBe(originalActions[i]));
      }
      expect(visits).toBe(0);
    },
  );
  it('review R6: prepared batch rechecks current limits with no apply clone/history change', () => {
    const session = new EditorSession(document());
    const before = session.content;
    const beforeRevision = session.revision;
    let limits = budgets;
    const payload: GeoCommand = {
      expectedRevision: beforeRevision,
      actions: [
        { type: 'setAttribute', layerId: 'layer', featureId: 'f0', fieldId: 'code', value: '01' },
        {
          type: 'replaceGeometry',
          layerId: 'layer',
          featureId: 'f0',
          geometry: { type: 'Point', coordinates: [1, 2] },
        },
      ],
    };
    const unchanged = structuredClone(payload);
    const prepared = geoEditorCommand(payload, () => ({
      revision: session.revision,
      canEdit: true,
      budgets: limits,
    }));
    limits = { ...budgets, actions: 1 };
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      expect(() => session.executeView(prepared)).toThrow('action-limit');
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
    expect(session.content).toEqual(before);
    expect(session.revision).toEqual(beforeRevision);
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(false);
    expect(payload).toEqual(unchanged);
    limits = budgets;
    session.execute(prepared);
    expect(session.content.layers[0].features[0]).toMatchObject({
      values: { code: '01' },
      geometry: { type: 'Point', coordinates: [1, 2] },
    });
    expect(session.undo()).toEqual(before);
  });
  it('review R6: malformed action/revision data refuses at both entrypoints', () => {
    for (const payload of [
      { expectedRevision: revision, actions: [null] },
      { expectedRevision: { sessionId: revision.sessionId, sequence: -1 }, actions: [] },
      {
        expectedRevision: revision,
        actions: [{ type: ['deleteFeature'], layerId: 'layer', featureId: 'f0' }],
      },
      {
        expectedRevision: revision,
        actions: [{ type: 'addFeature', layerId: 'layer', feature: null }],
      },
    ]) {
      expect(() => geoEditorCommand(payload as unknown as GeoCommand, () => context)).toThrow();
      expect(() =>
        applyGeoCommand(document(), payload as unknown as GeoCommand, context),
      ).toThrow();
    }
  });
});
