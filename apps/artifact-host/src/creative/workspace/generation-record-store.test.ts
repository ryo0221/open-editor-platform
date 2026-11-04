import { describe, expect, it, vi } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { WorldRecordStore } from './generation-record-store';
import {
  readCreativeWorldExecutionRecord,
  type CreativeWorldExecutionRecord,
  type CreativeWorldRecordStorage,
} from './generation-record';
import { compareCreativeWorldUsage } from './generation-impact';

const record = (): CreativeWorldExecutionRecord => ({
  schemaVersion: 1,
  operationId: 'operation',
  revision: 1,
  namespace: 'work-a',
  requestId: 'request',
  scope: {
    mode: 'character',
    itemId: 'CH-01',
    candidateContextId: 'candidate',
    artifactId: 'design-a',
    frameId: 'frame',
    address: { elementId: 'image' },
  },
  context: {
    fingerprint: '0'.repeat(64),
    payloadHash: '1'.repeat(64),
    adoptions: [
      { id: 'work', revision: 0 },
      { id: 'candidate', revision: 0 },
    ],
    references: [],
  },
  state: 'prepared',
  usages: [],
});
function fixture() {
  let saved: CreativeWorldExecutionRecord | undefined,
    fail = false,
    lost = false,
    readable = true;
  const io: CreativeWorldRecordStorage = {
    list: async () => (saved ? [clone(saved)] : []),
    write: async (next: Readonly<CreativeWorldExecutionRecord>, expected: number | null) => {
      if (fail) throw Error('disk full');
      if ((saved?.revision ?? null) !== expected) throw Error('conflict');
      saved = clone(next);
      if (lost) {
        lost = false;
        throw Error('response lost');
      }
    },
  };
  const store = new WorldRecordStore(
    'work-a',
    io,
    () => {
      if (!readable) throw Error('forbidden');
    },
    () => {},
  );
  return {
    store,
    io,
    get saved() {
      return saved;
    },
    set saved(v) {
      saved = v;
    },
    set fail(v: boolean) {
      fail = v;
    },
    set lost(v: boolean) {
      lost = v;
    },
    set readable(v: boolean) {
      readable = v;
    },
  };
}
describe('CW2 execution records: CAS, failures and delayed IO', () => {
  it('retries the exact operation and acknowledges only a matching lost response', async () => {
    const f = fixture();
    f.store.create(record());
    f.fail = true;
    await expect(f.store.flush()).rejects.toThrow('disk full');
    expect(f.store.state('operation').dirty).toBe(true);
    f.fail = false;
    f.lost = true;
    await f.store.flush();
    expect(f.saved?.revision).toBe(1);
    expect(f.store.state('operation').dirty).toBe(false);
    await f.store.flush();
    expect(f.saved?.revision).toBe(1);
  });
  it('preserves a newer local state while an older record write completes', async () => {
    const f = fixture();
    let release!: () => void;
    const io = {
      ...f.io,
      write: async (r: Readonly<CreativeWorldExecutionRecord>, e: number | null) => {
        if (e === null)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        await f.io.write(r, e);
      },
    };
    const store = new WorldRecordStore(
      'work-a',
      io,
      () => {},
      () => {},
    );
    store.create(record());
    const work = store.flush('operation');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    store.update('operation', (r) => {
      r.state = 'cancelled';
    });
    release();
    await work;
    expect(f.saved).toMatchObject({ state: 'cancelled', revision: 2 });
    expect(store.state('operation').dirty).toBe(false);
  });
  it('ignores a read started before a newer local write', async () => {
    const f = fixture();
    f.store.create(record());
    await f.store.flush();
    let release!: (v: unknown) => void;
    f.io.list = () =>
      new Promise((resolve) => {
        release = resolve as (v: unknown) => void;
      });
    const reading = f.store.load('design-a');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const old = clone(f.saved!);
    f.store.update('operation', (r) => {
      r.state = 'cancelled';
    });
    await f.store.flush();
    release([old]);
    await reading;
    expect(f.store.get('operation')).toMatchObject({ revision: 2, state: 'cancelled' });
  });
  it('does not overwrite a different remote row after a conflict', async () => {
    const f = fixture();
    f.store.create(record());
    await f.store.flush();
    f.saved = { ...f.saved!, revision: 2, state: 'rejected' };
    f.store.update('operation', (r) => {
      r.state = 'cancelled';
    });
    await expect(f.store.flush()).rejects.toThrow('conflict');
    expect(f.saved).toMatchObject({ revision: 2, state: 'rejected' });
    expect(f.store.get('operation').state).toBe('cancelled');
    expect(f.store.state('operation').dirty).toBe(true);
  });
  it('refuses a delayed read after revocation and never loads another namespace', async () => {
    const f = fixture();
    f.saved = record();
    let release!: (v: unknown) => void;
    f.io.list = () =>
      new Promise((resolve) => {
        release = resolve as (v: unknown) => void;
      });
    const reading = f.store.load('design-a');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.readable = false;
    release([record()]);
    await expect(reading).rejects.toThrow('forbidden');
    const other = new WorldRecordStore(
      'work-b',
      { ...f.io, list: async () => [record()] },
      () => {},
      () => {},
    );
    await expect(other.load('design-a')).rejects.toThrow('別作品');
  });
  it('marks a missing previously acknowledged record as unsaved', async () => {
    const f = fixture();
    f.store.create(record());
    await f.store.flush();
    f.saved = undefined;
    await f.store.load('design-a');
    expect(f.store.state('operation').dirty).toBe(true);
    await f.store.flush();
    expect(f.saved).toMatchObject({ operationId: 'operation' });
  });
  it('validates closed fields, contexts, addresses and immutable operation scope', () => {
    const f = fixture();
    f.store.create(record());
    expect(() => readCreativeWorldExecutionRecord({ ...record(), body: 'secret' })).toThrow();
    expect(() => readCreativeWorldExecutionRecord({ ...record(), result: null })).toThrow();
    expect(() =>
      readCreativeWorldExecutionRecord({
        ...record(),
        scope: { ...record().scope, address: { elementId: 'image', jsonPath: '*' } },
      }),
    ).toThrow();
    expect(() =>
      f.store.update('operation', (r) => {
        r.scope.artifactId = 'other';
      }),
    ).toThrow();
    expect(() =>
      readCreativeWorldExecutionRecord({
        ...record(),
        context: {
          ...record().context,
          adoptions: [
            { id: 'work', revision: 0 },
            { id: 'work', revision: 0 },
          ],
        },
      }),
    ).toThrow();
  });
  it('compares the actual selected projection instead of whole-version hashes or adoption revision', () => {
    const before = record(),
      ref = {
        contextId: 'work',
        reference: {
          id: 'facts',
          role: 'facts' as const,
          namespace: 'work-a',
          artifactId: 'document',
          versionId: 'version-1',
          contentHash: '2'.repeat(64),
          required: true,
          selector: { type: 'document-blocks' as const, blockIds: ['LO-01'] },
        },
        projectionHash: '3'.repeat(64),
      };
    before.context.references = [ref];
    const same = clone(ref);
    same.reference.versionId = 'version-2';
    same.reference.contentHash = '4'.repeat(64);
    expect(compareCreativeWorldUsage(before, [same])).toEqual({ state: 'current', reasons: [] });
    same.projectionHash = '5'.repeat(64);
    expect(compareCreativeWorldUsage(before, [same]).state).toBe('review');
    expect(compareCreativeWorldUsage(before, []).state).toBe('review');
    expect(before.context.references).toEqual([ref]);
  });
});

it('rejects record capacity overflow without changing existing desired records', () => {
  const f = fixture();
  for (let i = 0; i < 256; i++) f.store.create({ ...record(), operationId: 'op-' + i });
  const before = f.store.forArtifact('design-a');
  expect(() => f.store.create({ ...record(), operationId: 'overflow' })).toThrow('上限');
  expect(f.store.forArtifact('design-a')).toEqual(before);
});
