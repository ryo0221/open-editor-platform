import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { assertGeo, type GeoDocument } from '@editor-platform/geo-core';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import {
  ManualClock,
  referenceBinding,
  toyManifest,
} from '@editor-platform/extension-runtime/reference';
import type { DefinitionD2 } from '@editor-platform/extension-contract/draft2';
import {
  GeoSourceStorage,
  assertSourceCaptureCapacity,
} from '../../examples/reference-extension-host/geo-source-adapter';
import {
  GeoSourceEnvelopeStore,
  sourceBudgets,
} from '../../examples/reference-extension-host/geo-source-storage';
import { sourceRecord } from './geo-source-fixture';
let databaseName: string;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  databaseName = crypto.randomUUID();
});
const signal = () => new AbortController().signal;
async function setup() {
  const fixture = await sourceRecord(
    1,
    null,
    'ID,lon,lat\n001,12,34\noriginal excluded row retained',
  );
  const live = new Map(fixture.closure.map((c) => [c.sourceId, c]));
  const storage = new GeoSourceStorage({
    key: 'geo',
    databaseName,
    current: () => {},
    closure: (content) =>
      content.sources.map((s) => {
        const c = live.get(s.id);
        if (!c) throw Error('OriginalMissing');
        return c;
      }),
  });
  const clock = new ManualClock(),
    registry = new ReferenceRegistry(clock);
  const binding = referenceBinding(fixture.request.content, 'geo');
  binding.storage = storage;
  const definition: DefinitionD2<GeoDocument, string> = {
    manifest: toyManifest,
    validate: (v): v is GeoDocument => {
      try {
        assertGeo(v, sourceBudgets);
        return true;
      } catch {
        return false;
      }
    },
  };
  const installed = registry.install(definition, {
    trust: 'trusted',
    verifiedPin: definition.manifest,
  });
  const opened = installed.open(binding);
  if (opened.state !== 'opened') throw Error(opened.code);
  const handle = opened.handle;
  const slot = handle.context.addons.save;
  if (slot.state !== 'granted') throw Error(slot.reason);
  return { fixture, live, storage, registry, clock, handle, save: () => slot.api.save() };
}
describe('source retention through the public registry SaveCoordinator', () => {
  it('copies original closure synchronously before dispatch and ignores cleared/mutated live resources', async () => {
    const h = await setup();
    h.storage.pauseBefore = true;
    const saved = h.save();
    await expect.poll(() => !!h.storage.pendingBefore).toBe(true);
    expect(h.storage.retained).toBe(1);
    const expected = structuredClone(h.fixture.closure);
    h.fixture.closure[0].bytes = btoa('mutated');
    h.fixture.closure[0].recipe.changed = true;
    h.live.clear();
    h.storage.pendingBefore!();
    expect(await saved).toMatchObject({ state: 'committed' });
    expect(h.storage.retained).toBe(0);
    expect((await h.storage.load())!.closure).toEqual(expected);
    expect(h.storage.saved).toBeDefined();
  });
  it('retains unknown capture after revoke/expired drain and releases only after definitive reconciliation', async () => {
    const h = await setup();
    h.storage.mode = 'uncertain';
    const outcome = await h.save();
    expect(outcome.state).toBe('indeterminate');
    expect(h.storage.retained).toBe(1);
    expect(h.storage.saved).toBeUndefined();
    const expected = structuredClone(h.fixture.closure);
    h.live.clear();
    h.handle.revoke('host-close');
    expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({ state: 'incomplete' });
    expect(h.storage.retained).toBe(1);
    expect((await h.storage.load())!.closure).toEqual(expected);
    const evidence = h.storage.lastEvidence!;
    if (evidence.state !== 'committed') throw Error('Evidence');
    h.registry.saves.reconcile(evidence.operationId, evidence);
    expect(h.storage.retained).toBe(0);
    expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({ state: 'drained' });
    expect(h.storage.saved).toBeUndefined();
  });
  it('retains a committed but delayed acknowledgement through revoke, then releases without marking revoked capture saved', async () => {
    const h = await setup();
    h.storage.mode = 'delayed';
    const result = h.save().catch((error: unknown) => error);
    await expect.poll(() => !!h.storage.pending).toBe(true);
    h.live.clear();
    h.handle.revoke('host-close');
    expect(h.storage.retained).toBe(1);
    expect(await result).toMatchObject({ code: 'ScopeRevoked' });
    h.storage.pending!();
    await expect.poll(() => h.storage.retained).toBe(0);
    expect(h.registry.saves.observations()[0].outcome).toMatchObject({ state: 'committed' });
    expect(h.storage.saved).toBeUndefined();
    expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({ state: 'drained' });
  });
  it('releases conclusive no-write immediately and creates no persisted record', async () => {
    const h = await setup();
    h.storage.mode = 'no-write';
    expect(await h.save()).toMatchObject({
      state: 'aborted-before-write',
      proof: 'adapter-no-write-guarantee',
    });
    expect(h.storage.retained).toBe(0);
    expect(h.storage.writes).toBe(0);
    expect(await h.storage.load()).toBeUndefined();
  });
  it('releases a retained capture when revoked before dispatch', async () => {
    const h = await setup();
    h.storage.pauseBefore = true;
    const result = h.save().catch((error: unknown) => error);
    await expect.poll(() => !!h.storage.pendingBefore).toBe(true);
    h.live.clear();
    h.handle.revoke('host-close');
    expect(await result).toMatchObject({ code: 'ScopeRevoked' });
    expect(h.storage.retained).toBe(0);
    h.storage.pendingBefore!();
    expect(h.storage.writes).toBe(0);
    expect(await h.storage.load()).toBeUndefined();
  });
  it('opening an old version keeps latest head as the next expected head', async () => {
    const h = await setup();
    const s = new GeoSourceEnvelopeStore({ databaseName, artifactId: 'geo', current: () => {} });
    const first = await sourceRecord(1),
      second = await sourceRecord(2, 'v1');
    await s.commit(first, null, signal());
    await s.commit(second, 'v1', signal());
    expect((await h.storage.load('v1'))!.nativeVersion.versionId).toBe('v1');
    expect(h.storage.head).toBe('v2');
    const snapshot = { ...first.request.capture, content: first.request.content };
    const release = h.storage.retainCapture(snapshot);
    const request = { ...first.request, operationId: 'save-old-as-new' };
    expect((await h.storage.write(request, signal())).state).toBe('committed');
    release();
    const reopened = await h.storage.load();
    expect(reopened!.nativeVersion.parentVersionId).toBe('v2');
    expect(reopened!.request.content).toEqual(first.request.content);
  });
  it('rejects a head change between read admission and load rather than adopting mismatched head', async () => {
    const h = await setup();
    const s = new GeoSourceEnvelopeStore({ databaseName, artifactId: 'geo', current: () => {} });
    await s.commit(await sourceRecord(1), null, signal());
    const original = GeoSourceEnvelopeStore.prototype.load;
    const spy = vi
      .spyOn(GeoSourceEnvelopeStore.prototype, 'load')
      .mockImplementationOnce(async function (this: GeoSourceEnvelopeStore, versionId?: string) {
        await s.commit(await sourceRecord(2, 'v1'), 'v1', signal());
        return original.call(this, versionId);
      });
    try {
      await expect(h.storage.load()).rejects.toThrow('SourceReadConflict');
      expect(h.storage.head).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

it('preflights a complete private recipe envelope before native import', async () => {
  const record = await sourceRecord(1, null, 'col\n12');
  const snapshot = { ...record.request.capture, content: record.request.content };
  expect(() => assertSourceCaptureCapacity(snapshot, record.closure)).not.toThrow();
  record.closure[0].recipe = { repeated: 'x'.repeat(262144) };
  expect(() => assertSourceCaptureCapacity(snapshot, record.closure)).toThrow('SourceRecordLimit');
});
