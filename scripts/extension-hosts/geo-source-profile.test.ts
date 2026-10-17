import { describe, expect, it } from 'vitest';
import { emptyGeo, type GeoDocument } from '@editor-platform/geo-core';
import { createSourceProfile } from '../../examples/reference-extension-host/geo-source-profile';
import { sourceRecord } from './geo-source-fixture';
async function setup() {
  const record = await sourceRecord(1, null, 'ID,lon,lat\n1,12,34');
  const content = record.request.content;
  content.layers[0].features.push({
    id: 'point-1',
    rowId: 'row-1',
    geometry: { type: 'Point', coordinates: [12, 34] },
    values: { value: 1 },
    sourceRef: { sourceId: 'source-1', externalId: '1' },
  });
  const originals = new Map(
    record.closure.map((entry) => [entry.resourceId, structuredClone(entry)]),
  );
  let active = true;
  const guard = createSourceProfile({
    originals,
    current() {
      if (!active) throw Error('ScopeClosed');
    },
  });
  guard.adopt(content);
  return {
    content,
    originals,
    guard,
    close: () => {
      active = false;
    },
  };
}
describe('whole-scope retained source profile', () => {
  it('allows geometry/scalar changes and ordinary history subsets with exact originals', async () => {
    const { content, guard } = await setup();
    const edited = structuredClone(content);
    edited.layers[0].features[0].geometry = { type: 'Point', coordinates: [13, 35] };
    edited.layers[0].features[0].values.value = 2;
    expect(Object.isFrozen(guard.profile)).toBe(true);
    expect(guard.profile.check(edited, 'edit')).toBe(true);
    expect(guard.profile.check(content, 'history')).toBe(true);
    expect(guard.profile.check(emptyGeo(), 'history')).toBe(true);
    expect(guard.checkHistory()).toBe(true);
  });
  it('refuses empty-current Undo/Redo when an original needed only by old history is missing', async () => {
    const { originals, guard } = await setup();
    originals.clear();
    expect(guard.profile.check(emptyGeo(), 'history')).toBe(false);
    expect(guard.profile.check(emptyGeo(), 'edit')).toBe(false);
    expect(guard.checkHistory()).toBe(false);
    expect(() => guard.adopt(emptyGeo())).toThrow('GeoSourceHistoryClosure');
  });
  it.each(['bytes', 'recipe', 'pin', 'manifest', 'version'] as const)(
    'detects mutated %s even when current is empty',
    async (part) => {
      const { originals, guard } = await setup();
      const entry = [...originals.values()][0];
      if (part === 'bytes') entry.bytes = btoa('changed');
      if (part === 'recipe') entry.recipe = { changed: true };
      if (part === 'pin') entry.pin.versionId = 'changed';
      if (part === 'manifest') entry.sourceVersion.content.name = 'changed';
      if (part === 'version') entry.sourceVersion.createdAt = '2026-10-13T00:00:00Z';
      expect(guard.checkHistory()).toBe(false);
      expect(guard.profile.check(emptyGeo(), 'history')).toBe(false);
    },
  );
  it('rejects source/pin/ref/row/layer identity changes while preserving the captured baseline', async () => {
    const { content, guard } = await setup();
    const mutations: ((d: GeoDocument) => void)[] = [
      (d) => {
        d.sources[0].attribution = 'different';
      },
      (d) => {
        d.sources[0].pin.versionId = 'different';
      },
      (d) => {
        d.layers[0].features[0].sourceRef!.externalId = 'different';
      },
      (d) => {
        delete d.layers[0].features[0].sourceRef;
      },
      (d) => {
        d.layers[0].features[0].rowId = 'different';
      },
      (d) => {
        d.layers[0].id = 'different';
      },
      (d) => {
        d.sources = [];
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(content);
      mutate(changed);
      expect(guard.profile.check(changed, 'edit')).toBe(false);
      expect(guard.profile.check(changed, 'history')).toBe(false);
    }
    expect(guard.profile.check(content, 'edit')).toBe(true);
    const changed = structuredClone(content);
    changed.layers[0].features[0].sourceRef!.externalId = 'different';
    expect(() => guard.adopt(changed)).toThrow('GeoSourceRefChanged');
    expect(guard.profile.check(content, 'history')).toBe(true);
  });
  it('requires adoption of newly verified sources, and rollback removes only failed additions', async () => {
    const { content, originals, guard } = await setup();
    const next = structuredClone(content),
      extra = structuredClone([...originals.values()][0]);
    extra.sourceId = 'source-2';
    extra.resourceId = 'resource-2';
    next.sources.push({
      ...structuredClone(content.sources[0]),
      id: extra.sourceId,
      resourceId: extra.resourceId,
    });
    next.layers[0].features.push({
      ...structuredClone(content.layers[0].features[0]),
      id: 'point-2',
      rowId: 'row-2',
      sourceRef: { sourceId: 'source-2', externalId: '2' },
    });
    expect(() => guard.adopt(next)).toThrow('GeoSourceAdoptionClosure');
    originals.set(extra.resourceId, extra);
    expect(guard.profile.check(next, 'edit')).toBe(false);
    const rollback = guard.adopt(next);
    expect(guard.profile.check(next, 'edit')).toBe(true);
    rollback();
    rollback();
    originals.delete(extra.resourceId);
    expect(guard.profile.check(next, 'history')).toBe(false);
    expect(guard.profile.check(content, 'history')).toBe(true);
    expect(guard.checkHistory()).toBe(true);
  });
  it('tracks provenance of source-free features too and refuses unadmitted references', async () => {
    const { content, originals } = await setup();
    const native = structuredClone(content);
    native.sources = [];
    delete native.layers[0].features[0].sourceRef;
    const guard = createSourceProfile({ originals, current: () => {} });
    guard.adopt(native);
    expect(guard.profile.check(native, 'edit')).toBe(true);
    expect(guard.profile.check(content, 'edit')).toBe(false);
    const unknown = structuredClone(native);
    unknown.layers[0].features[0].id = 'unknown';
    expect(guard.profile.check(unknown, 'history')).toBe(false);
  });
  it('closes with its owning scope and cannot silently rebaseline tampered originals', async () => {
    const { content, guard, close } = await setup();
    close();
    expect(guard.checkHistory()).toBe(false);
    expect(guard.profile.check(content, 'edit')).toBe(false);
    expect(() => guard.adopt(content)).toThrow('ScopeClosed');
  });
  it('refuses stale rollback rather than deleting a later adoption requirement', async () => {
    const { content, originals } = await setup();
    const guard = createSourceProfile({ originals, current: () => {} });
    const old = guard.adopt(content);
    guard.adopt(content);
    expect(() => old()).toThrow('GeoSourceRollbackAfterAdoption');
    expect(guard.profile.check(content, 'history')).toBe(true);
  });
});
