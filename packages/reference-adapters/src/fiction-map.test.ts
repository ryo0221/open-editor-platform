import { describe, it, expect } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import {
  ReferenceResolver,
  ReferenceError,
  validReferenceSource,
  type ReferenceHost,
  type ReferenceSnapshot,
  type ReferenceSource,
} from '@editor-platform/artifact-references';
import { createFictionMap, validateFictionMap } from '@editor-platform/fiction-map/model';
import { fictionMapReferenceAdapter } from './fiction-map';
async function fixture() {
  const r = validateFictionMap({
    ...createFictionMap(),
    layers: [{ id: 'l', name: 'L', purpose: 'annotation', visibleByDefault: true }],
    features: [
      {
        id: 'p',
        layerId: 'l',
        name: 'Original',
        featureKind: 'place',
        geometry: { type: 'point', coordinates: [180, 90] },
        worldEntityRef: { namespace: 'world', entityId: 'opaque' },
      },
    ],
    namedViews: [
      {
        id: 'default',
        name: 'Named',
        extent: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
        visibleLayerIds: ['l'],
      },
    ],
  });
  if (!r.ok) throw Error('fixture');
  let snapshot: ReferenceSnapshot = {
      artifactId: 'map',
      domain: 'fiction-map',
      versionId: 'v1',
      revision: 1,
      content: r.value,
      contentHash: await contentHash(r.value),
      dependencies: [],
    },
    access: 'ready' | 'forbidden' | 'offline' = 'ready';
  const source: ReferenceSource = {
    artifactId: 'map',
    domain: 'fiction-map',
    target: { kind: 'fiction-map-document', viewId: 'document', featureIds: ['p'] },
  };
  const host: ReferenceHost = {
    list: async () => [{ source, label: 'Map' }],
    read: async () => snapshot,
    checkAccess: () => {
      if (access !== 'ready') throw new ReferenceError(access, access);
    },
    subscribe: () => () => {},
  };
  return {
    source,
    host,
    resolver: new ReferenceResolver(host, [fictionMapReferenceAdapter], 'story'),
    snapshot,
    setSnapshot: (v: ReferenceSnapshot) => (snapshot = v),
    setAccess: (v: typeof access) => (access = v),
  };
}
describe('D3 exact fixed Fiction Map references', () => {
  it('renders a fixed version and preserves old names/positions after new saves', async () => {
    const f = await fixture(),
      ref = await f.resolver.create(f.source, 'fixed'),
      first = await f.resolver.refresh(ref);
    expect(first.status).toBe('ready');
    f.setSnapshot({
      ...f.snapshot,
      revision: 2,
      versionId: 'v2',
      content: { ...(f.snapshot.content as object), features: [] },
      contentHash: await contentHash({ ...(f.snapshot.content as object), features: [] }),
    });
    const next = await f.resolver.refresh(ref);
    expect(next.projection).toEqual(first.projection);
    expect(ref.snapshot.versionId).toBe('v1');
    expect(next.projection?.src).toContain('data:image/svg');
  });
  it('separates a named view called default from document bounds and validates feature IDs', async () => {
    const f = await fixture();
    const named = {
      ...f.source,
      target: { kind: 'fiction-map-view', viewId: 'default', featureIds: ['p'] },
    };
    expect((await f.resolver.create(named, 'fixed')).snapshot.versionId).toBe('v1');
    for (const target of [
      { kind: 'fiction-map-view', viewId: 'missing' },
      { kind: 'fiction-map-document', viewId: 'document', featureIds: ['missing'] },
    ])
      await expect(f.resolver.create({ ...f.source, target }, 'fixed')).rejects.toMatchObject({
        status: 'missing-target',
      });
    expect(
      validReferenceSource({ ...f.source, target: { ...f.source.target, featureIds: ['p', 'p'] } }),
    ).toBe(false);
    expect(validReferenceSource({ ...f.source, domain: 'geo' })).toBe(false);
  });
  it('rejects implicit follow and row/node ID aliases', async () => {
    const f = await fixture();
    await expect(f.resolver.create(f.source, 'follow')).rejects.toMatchObject({
      status: 'unsupported',
    });
    await expect(
      f.resolver.create({ ...f.source, target: { ...f.source.target, nodeIds: ['p'] } }, 'fixed'),
    ).rejects.toMatchObject({ status: 'unsupported' });
    const ref = await f.resolver.create(f.source, 'fixed');
    expect((await f.resolver.refresh({ ...ref, mode: 'follow' })).status).toBe('unsupported');
    await expect(
      f.resolver.capture([{ id: 'i', reference: { ...ref, mode: 'follow' } }]),
    ).rejects.toMatchObject({ status: 'unsupported' });
  });
  it('hides cached pixels for forbidden, warns with verified cache only for offline', async () => {
    const f = await fixture(),
      ref = await f.resolver.create(f.source, 'fixed');
    await f.resolver.refresh(ref);
    f.setAccess('forbidden');
    const denied = await f.resolver.refresh(ref);
    expect(denied.status).toBe('forbidden');
    expect(denied.projection).toBeUndefined();
    f.setAccess('offline');
    const offline = await f.resolver.refresh(ref);
    expect(offline.status).toBe('offline');
    expect(offline.projection).toBeDefined();
    expect(offline.message).toBeTruthy();
  });
  it('rejects hash contradiction and permission revoked while awaiting source', async () => {
    const f = await fixture();
    f.setSnapshot({ ...f.snapshot, contentHash: '0'.repeat(64) });
    await expect(f.resolver.create(f.source, 'fixed')).rejects.toMatchObject({ status: 'error' });
    const good = await fixture();
    let release: (s: ReferenceSnapshot) => void = () => {};
    good.host.read = () => new Promise((resolve) => (release = resolve));
    const p = good.resolver.create(good.source, 'fixed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    good.setAccess('forbidden');
    release(good.snapshot);
    await expect(p).rejects.toMatchObject({ status: 'forbidden' });
  });
});
it('checks exact retained versions without following and rechecks access after a pending check', async () => {
  const f = await fixture();
  let missing = false;
  f.host.checkSnapshot = async (_source, snapshot) => {
    if (missing) throw new ReferenceError('missing-target', 'Saved version is missing');
    expect(snapshot.versionId).toBe('v1');
  };
  const ref = await f.resolver.create(f.source, 'fixed');
  missing = true;
  const state = await f.resolver.refresh(ref);
  expect(state.status).toBe('missing-target');
  expect(state.projection).toBeUndefined();
  await expect(f.resolver.capture([{ id: 'ref', reference: ref }])).rejects.toMatchObject({
    status: 'missing-target',
  });
  let release = () => {};
  let entered = () => {};
  const started = new Promise<void>((r) => (entered = r));
  f.host.checkSnapshot = () =>
    new Promise<void>((r) => {
      release = r;
      entered();
    });
  const pending = f.resolver.refresh(ref);
  await started;
  f.setAccess('forbidden');
  release();
  expect((await pending).status).toBe('forbidden');
});
