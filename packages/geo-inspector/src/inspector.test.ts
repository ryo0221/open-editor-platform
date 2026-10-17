import { describe, expect, it } from 'vitest';
import { command } from '@editor-platform/editor-core';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import { assertGeo, type GeoDocument } from '@editor-platform/geo-core';
import { geoInspectorExtension, prepareGeoInspection } from './index';
import { budgets, fixture, nativeBinding, packageHash } from '../test-host/fixture';
function harness(content = fixture()) {
  const registry = new ReferenceRegistry(new ManualClock());
  const definition = geoInspectorExtension(packageHash, budgets);
  const installed = registry.install(definition, {
    trust: 'trusted',
    verifiedPin: definition.manifest,
  });
  const host = nativeBinding(content);
  const result = installed.open(host.binding);
  if (result.state !== 'opened') throw new Error(result.code);
  return { ...host, definition, installed, handle: result.handle };
}
const nodes = (value: unknown): number =>
  1 +
  (value && typeof value === 'object'
    ? Object.values(value).reduce<number>((n, v) => n + nodes(v), 0)
    : 0);
describe('Geo inspector actual draft.2 Basic contract (FR03/08/10)', () => {
  it('uses genuine numeric schema 1, only read and required lifecycle', () => {
    const h = harness();
    expect(h.definition.manifest.schemaVersion).toBe(1);
    expect(h.definition.manifest.permissions).toEqual(['artifact:read']);
    expect(Object.keys(h.definition.manifest.addons)).toEqual(['lifecycle']);
    const context = h.handle.context;
    expect(context.addons.lifecycle.state).toBe('granted');
    for (const id of ['edit', 'save', 'inputs', 'resources'] as const)
      expect(context.addons[id]).toMatchObject({ state: 'unavailable', reason: 'not-requested' });
    expect(context.basic.read().content).toEqual(fixture());
    expect(h.binding.session.canUndo).toBe(false);
    h.handle.revoke('host-close');
    expect(h.listeners()).toBe(0);
    expect(() => context.basic.read()).toThrow();
  });
  it('refuses wrong native kind/schema and missing read permission', () => {
    const h = harness();
    for (const schemaVersion of [2, '1'] as unknown as number[])
      expect(h.installed.open({ ...h.binding, schemaVersion })).toEqual({
        state: 'refused',
        code: 'schema',
      });
    expect(h.installed.open({ ...h.binding, artifactKind: 'graph' })).toEqual({
      state: 'refused',
      code: 'schema',
    });
    expect(h.installed.open({ ...h.binding, allowed: () => false })).toEqual({
      state: 'refused',
      code: 'grant',
    });
    expect(h.definition.validate({ ...fixture(), schemaVersion: '1' })).toBe(false);
    expect(h.definition.validate({ ...fixture(), unexpected: true })).toBe(false);
  });
  it('refuses untrusted/mismatched pins and missing required lifecycle', () => {
    const definition = geoInspectorExtension(packageHash, budgets);
    expect(() =>
      new ReferenceRegistry(new ManualClock()).install(definition, {
        trust: 'untrusted',
        verifiedPin: definition.manifest,
      }),
    ).toThrow('trust');
    expect(() =>
      new ReferenceRegistry(new ManualClock()).install(definition, {
        trust: 'trusted',
        verifiedPin: { ...definition.manifest, packageHash: 'd'.repeat(64) },
      }),
    ).toThrow('pin');
    const installed = new ReferenceRegistry(new ManualClock(), []).install(definition, {
      trust: 'trusted',
      verifiedPin: definition.manifest,
    });
    expect(installed.open(nativeBinding().binding)).toMatchObject({
      state: 'refused',
      code: 'required-addon',
      addon: 'lifecycle',
    });
  });
  it('prepares detached frozen native hash, separate from package/source hashes', async () => {
    const input = fixture();
    const prepared = await prepareGeoInspection(input, budgets);
    expect(prepared.content).toEqual(input);
    input.layers[0].name = 'Host changed';
    expect(prepared.content.layers[0].name).toBe('Synthetic sites');
    expect(Object.isFrozen(prepared.content.layers[0].features[0])).toBe(true);
    expect(prepared.nativeContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect([
      packageHash,
      prepared.content.sources[0].bytesHash,
      prepared.content.sources[0].pin.contentHash,
    ]).not.toContain(prepared.nativeContentHash);
  });
  it('validates before clone/hash without invoking getters', async () => {
    let calls = 0;
    const input = {
      get schemaVersion() {
        calls++;
        return 1;
      },
      layers: [],
      sources: [],
    };
    await expect(prepareGeoInspection(input, budgets)).rejects.toThrow();
    expect(calls).toBe(0);
    const sparse = fixture();
    sparse.layers[0].features = new Array(2);
    await expect(prepareGeoInspection(sparse, budgets)).rejects.toThrow();
  });
  it('Basic.read validates actual content and rejects depth 25 before native schema', () => {
    const h = harness();
    h.binding.session.execute(
      command(
        'invalid-schema',
        'Host test',
        () => ({ ...fixture(), schemaVersion: 2 }) as unknown as GeoDocument,
      ),
    );
    expect(() => h.handle.context.basic.read()).toThrow('InvalidContent');
    const nested = (depth: number): unknown => (depth ? { child: nested(depth - 1) } : 0);
    // These are deliberately invalid Geo inputs: depth 24 reaches the native validator;
    // depth 25 fails copyData first. No claim of a valid nested-attribute Geo capability.
    for (const [depth, code] of [
      [24, 'InvalidContent'],
      [25, 'DataLimit'],
    ] as const) {
      h.binding.session.execute(
        command('invalid-depth', 'Host test', () => nested(depth) as GeoDocument),
      );
      expect(() => h.handle.context.basic.read()).toThrow(code);
    }
  });
  it('actual Basic.read accepts 65536 UTF8 bytes and refuses 65537 without truncation', () => {
    const input = fixture();
    input.layers[0].name = '';
    const base = new TextEncoder().encode(JSON.stringify(input)).length;
    input.layers[0].name = '界' + 'x'.repeat(65536 - base - 3);
    expect(new TextEncoder().encode(JSON.stringify(input)).length).toBe(65536);
    expect(harness(input).handle.context.basic.read().content).toEqual(input);
    input.layers[0].name += 'x';
    assertGeo(input, budgets);
    const rejected = harness(input);
    expect(() => rejected.handle.context.basic.read()).toThrow('DataLimit');
    expect(rejected.binding.session.content).toEqual(input);
    expect(rejected.binding.session.canUndo).toBe(false);
  });
  it('actual Basic.read accepts 4096 nodes and refuses 4097 below byte limit', () => {
    const input: GeoDocument = {
      schemaVersion: 1,
      layers: [
        {
          id: 'l',
          name: 'line',
          crs: 'OGC:CRS84',
          axis: 'longitude-latitude',
          fields: [],
          features: [
            { id: 'f', rowId: 'r', geometry: { type: 'LineString', coordinates: [] }, values: {} },
          ],
        },
      ],
      sources: [],
    };
    const layer = input.layers[0],
      feature = layer.features[0];
    while ((4096 - nodes(input)) % 3) {
      const id = `f${layer.fields.length}`;
      layer.fields.push({ id, name: id, type: 'number' });
      feature.values[id] = 0;
    }
    if (feature.geometry?.type !== 'LineString') throw new Error('fixture');
    feature.geometry.coordinates = Array.from({ length: (4096 - nodes(input)) / 3 }, (_, i) => [
      i % 180,
      0,
    ]);
    expect(nodes(input)).toBe(4096);
    expect(harness(input).handle.context.basic.read().content).toEqual(input);
    feature.geometry = { type: 'MultiLineString', coordinates: [feature.geometry.coordinates] };
    expect(nodes(input)).toBe(4097);
    assertGeo(input, budgets);
    const rejected = harness(input);
    expect(() => rejected.handle.context.basic.read()).toThrow('DataLimit');
    expect(rejected.binding.session.content).toEqual(input);
  });
});
