import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { contentHash } from '@editor-platform/artifact-core';
import {
  GeoSourceEnvelopeStore,
  checkedSourceEnvelope,
  type GeoSourceEnvelope,
} from '../../examples/reference-extension-host/geo-source-storage';
import { deferred } from '@editor-platform/extension-runtime/reference';
import { sourceRecord as record } from './geo-source-fixture';
let databaseName: string;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  databaseName = crypto.randomUUID();
});
const current = () => {};
const store = (guard = current) =>
  new GeoSourceEnvelopeStore({ databaseName, artifactId: 'geo', current: guard });
const signal = () => new AbortController().signal;
describe('private source-backed envelope storage', () => {
  it('commits exact full originals and reopens current/old immutable versions in a new adapter', async () => {
    const s = store();
    const a = await record(1, null, 'ID,lon,lat\n1,12,34\ninvalid,row,retained');
    expect((await s.commit(a, null, signal())).state).toBe('committed');
    const b = await record(2, 'v1', 'ID,lon,lat\n2,13,35');
    expect((await s.commit(b, 'v1', signal())).state).toBe('committed');
    expect(await store().load()).toEqual(b);
    expect(await store().load('v1')).toEqual(a);
  });
  it('replays old operations without moving head and refuses changed reuse', async () => {
    const s = store(),
      a = await record(),
      b = await record(2, 'v1');
    await s.commit(a, null, signal());
    await s.commit(b, 'v1', signal());
    expect(await s.commit(a, null, signal())).toMatchObject({
      state: 'committed',
      replay: true,
      versionId: 'v1',
    });
    expect((await s.inspect()).head).toBe('v2');
    a.request.capture.revision.sequence++;
    expect(await s.commit(a, 'v2', signal())).toEqual({
      state: 'no-write',
      code: 'SourceOperationConflict',
    });
    expect((await s.inspect()).versions).toBe(2);
  });
  it('acknowledges a no-op against the new capture without counting another version', async () => {
    const s = store(),
      a = await record();
    await s.commit(a, null, signal());
    const b = structuredClone(a);
    b.request.operationId = 'noop';
    b.receiptId = 'geo-source:noop';
    b.request.capture.revision.sequence++;
    b.nativeVersion.versionId = 'unused';
    b.nativeVersion.parentVersionId = 'v1';
    expect(await s.commit(b, 'v1', signal())).toMatchObject({
      state: 'committed',
      noop: true,
      versionId: 'v1',
      evidence: { capture: b.request.capture },
    });
    expect(await s.inspect()).toMatchObject({ versions: 1, acknowledgements: 2, head: 'v1' });
    expect(await s.load()).toEqual(a);
  });
  it('refuses stale tabs, duplicate immutable identity, and a seventeenth new version without deleting any', async () => {
    const s = store();
    for (let i = 1; i <= 16; i++)
      expect(
        (
          await s.commit(
            await record(i, i === 1 ? null : 'v' + (i - 1)),
            i === 1 ? null : 'v' + (i - 1),
            signal(),
          )
        ).state,
      ).toBe('committed');
    expect(await store().commit(await record(18, 'v1'), 'v1', signal())).toMatchObject({
      code: 'SourceHeadConflict',
    });
    const duplicate = await record(17, 'v16');
    duplicate.nativeVersion.versionId = 'v1';
    expect(await s.commit(duplicate, 'v16', signal())).toMatchObject({
      code: 'SourceImmutableVersion',
    });
    expect(await s.commit(await record(17, 'v16'), 'v16', signal())).toMatchObject({
      code: 'SourceVersionLimit',
    });
    expect(await s.inspect()).toMatchObject({ versions: 16, head: 'v16' });
    expect(await s.load('v1')).toEqual(await record());
  });
  it('refuses missing, extra, duplicate, mismatched and corrupted closure/byte/version data', async () => {
    const a = await record(1, null, 'original');
    const corruptions: ((r: GeoSourceEnvelope) => void)[] = [
      (r) => {
        r.closure = [];
      },
      (r) => {
        r.closure.push(structuredClone(r.closure[0]));
      },
      (r) => {
        r.closure[0].bytes = btoa('tampered');
      },
      (r) => {
        r.closure[0].resourceId = 'wrong';
      },
      (r) => {
        r.closure[0].sourceVersion.versionId = 'wrong';
      },
      (r) => {
        r.closureHash = '0'.repeat(64);
      },
      (r) => {
        r.request.content.layers[0].name = 'tampered';
      },
    ];
    for (const corrupt of corruptions) {
      const r = structuredClone(a);
      corrupt(r);
      await expect(checkedSourceEnvelope(JSON.stringify(r), 'geo')).rejects.toThrow();
    }
    await expect(checkedSourceEnvelope(' '.repeat(262145), 'geo')).rejects.toThrow(
      'SourceRecordLimit',
    );
    await expect(
      checkedSourceEnvelope(JSON.stringify(await record(1, null, 'x'.repeat(100001))), 'geo'),
    ).rejects.toThrow();
    expect(await store().load()).toBeUndefined();
  });
  it('checks authority again after async preparation and inside the transaction', async () => {
    let calls = 0;
    const s = store(() => {
      if (++calls >= 2) throw Error('AuthorityChanged');
    });
    expect(await s.commit(await record(), null, signal())).toEqual({
      state: 'no-write',
      code: 'AuthorityChanged',
    });
    expect(await store().load()).toBeUndefined();
    const abort = new AbortController();
    abort.abort();
    expect(await store().commit(await record(), null, abort.signal)).toMatchObject({
      state: 'no-write',
      code: 'SourceAborted',
    });
  });
  it('counts encoded version/index/ack bytes toward 4MiB without automatic deletion', async () => {
    const s = store();
    let accepted = 0;
    for (let i = 1; i <= 16; i++) {
      const r = await record(i, i === 1 ? null : 'v' + (i - 1), 'original');
      r.closure[0].recipe.explanation = '\n'.repeat(100000);
      r.closureHash = await contentHash(r.closure);
      const outcome = await s.commit(r, i === 1 ? null : 'v' + (i - 1), signal());
      if (outcome.state === 'no-write') {
        expect(outcome.code).toBe('SourceRetentionLimit');
        break;
      }
      expect(outcome.state).toBe('committed');
      accepted++;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(16);
    expect(await s.inspect()).toMatchObject({ versions: accepted, head: 'v' + accepted });
    expect((await s.inspect()).bytes).toBeLessThanOrEqual(4194304);
    expect((await s.load('v1'))!.closure[0].bytes).toBe(btoa('original'));
  });
  it('rejects corrupt persisted records on read and corrupt operation receipts on retry', async () => {
    const a = await record();
    const s = store();
    await s.commit(a, null, signal());
    const change = async (
      mutate: (b: {
        versions: { text: string }[];
        acknowledgements: { evidence: { capture: { contentHash: string } } }[];
      }) => void,
    ) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(databaseName, 1);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction('artifacts', 'readwrite'),
            os = tx.objectStore('artifacts'),
            read = os.get('geo');
          read.onsuccess = () => {
            const b = JSON.parse(read.result);
            mutate(b);
            os.put(JSON.stringify(b), 'geo');
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    };
    await change((b) => {
      b.acknowledgements[0].evidence.capture.contentHash = '0'.repeat(64);
    });
    expect(await s.commit(a, null, signal())).toMatchObject({
      state: 'no-write',
      code: 'SourceAcknowledgement',
    });
    await change((b) => {
      const r = JSON.parse(b.versions[0].text);
      r.request.content.layers[0].name = 'corruption';
      b.versions[0].text = JSON.stringify(r);
    });
    await expect(s.load()).rejects.toThrow('SourceNativeHash');
  });
  it('acknowledges overlapping identical operations once even when both prepared before either commit', async () => {
    const base = await record(0),
      candidate = await record(1, 'v0', 'complete original');
    const seed = store();
    await seed.commit(base, null, signal());
    const bothPrepared = deferred<void>(),
      release = deferred<void>();
    let arrivals = 0;
    const copies = [store(), store()];
    const spies = copies.map((copy) => {
      const checked = copy.checked;
      return vi.spyOn(copy, 'checked').mockImplementation(async (text) => {
        const result = await checked(text);
        if (result.request.operationId === base.request.operationId) {
          if (++arrivals === 2) bothPrepared.resolve();
          await release.promise;
        }
        return result;
      });
    });
    try {
      const operations = copies.map((copy) => copy.commit(candidate, 'v0', signal()));
      await bothPrepared.promise;
      release.resolve();
      const results = await Promise.all(operations);
      expect(results.every((r) => r.state === 'committed')).toBe(true);
      expect(results.filter((r) => r.state === 'committed' && r.replay)).toHaveLength(1);
      if (results[0].state !== 'committed' || results[1].state !== 'committed')
        throw Error('Commit');
      expect(results[0].evidence).toEqual(results[1].evidence);
      expect(await seed.inspect()).toMatchObject({ head: 'v1', versions: 2, acknowledgements: 2 });
      expect(await seed.load('v1')).toEqual(candidate);
    } finally {
      release.resolve();
      spies.forEach((spy) => spy.mockRestore());
    }
  });
  it.each(['new-version', 'no-op'] as const)(
    'returns a %s replay receipt when an unrelated save advances head during replay preparation',
    async (kind) => {
      const s = store(),
        first = await record(1, null, 'complete original');
      await s.commit(first, null, signal());
      const replay = structuredClone(first);
      if (kind === 'no-op') {
        replay.request.operationId = 'noop';
        replay.receiptId = 'geo-source:noop';
        replay.request.capture.revision.sequence++;
        replay.nativeVersion.versionId = 'unused';
        replay.nativeVersion.parentVersionId = 'v1';
        expect(await s.commit(replay, 'v1', signal())).toMatchObject({
          state: 'committed',
          noop: true,
          versionId: 'v1',
        });
      }
      const prepared = deferred<void>(),
        release = deferred<void>();
      const copy = store(),
        checked = copy.checked;
      let calls = 0;
      const spy = vi.spyOn(copy, 'checked').mockImplementation(async (text) => {
        const result = await checked(text);
        if (++calls === 2) {
          prepared.resolve();
          await release.promise;
        }
        return result;
      });
      try {
        const pending = copy.commit(replay, null, signal());
        await prepared.promise;
        expect((await s.commit(await record(2, 'v1'), 'v1', signal())).state).toBe('committed');
        const beforeReplay = await s.inspect();
        release.resolve();
        expect(await pending).toMatchObject({
          state: 'committed',
          replay: true,
          versionId: 'v1',
          evidence: { operationId: replay.request.operationId, capture: replay.request.capture },
        });
        expect(await s.inspect()).toEqual(beforeReplay);
        expect((await s.load())!.nativeVersion.versionId).toBe('v2');
        replay.request.capture.revision.sequence++;
        expect(await s.commit(replay, 'v2', signal())).toEqual({
          state: 'no-write',
          code: 'SourceOperationConflict',
        });
      } finally {
        release.resolve();
        spy.mockRestore();
      }
    },
  );
  it('refuses replay when persisted payload changes after hash preparation even if ack and claimed hashes match', async () => {
    const s = store(),
      candidate = await record(1, null, 'complete original');
    await s.commit(candidate, null, signal());
    const prepared = deferred<void>(),
      release = deferred<void>();
    const copy = store(),
      checked = copy.checked;
    let calls = 0;
    const spy = vi.spyOn(copy, 'checked').mockImplementation(async (text) => {
      const result = await checked(text);
      if (++calls === 2) {
        prepared.resolve();
        await release.promise;
      }
      return result;
    });
    try {
      const pending = copy.commit(candidate, null, signal());
      await prepared.promise;
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(databaseName, 1);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction('artifacts', 'readwrite');
          const os = tx.objectStore('artifacts'),
            request = os.get('geo');
          request.onsuccess = () => {
            const b = JSON.parse(request.result),
              saved = JSON.parse(b.versions[0].text);
            saved.closure[0].bytes = btoa('tampered original');
            b.versions[0].text = JSON.stringify(saved);
            os.put(JSON.stringify(b), 'geo');
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
      release.resolve();
      expect(await pending).toEqual({ state: 'no-write', code: 'SourceAcknowledgement' });
      expect(await s.inspect()).toMatchObject({ versions: 1, acknowledgements: 1, head: 'v1' });
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  });
  it.each([
    {
      name: 'native schema version',
      code: 'SourceVersionMetadata',
      mutate: (v: GeoSourceEnvelope) => {
        v.nativeVersion.schemaVersion = 2;
      },
    },
    {
      name: 'native creation metadata',
      code: 'SourceVersionMetadata',
      mutate: (v: GeoSourceEnvelope) => {
        v.nativeVersion.createdAt = 'not-a-date';
      },
    },
    {
      name: 'extra envelope member',
      code: 'SourceEnvelopeShape',
      mutate: (v: GeoSourceEnvelope) => {
        Object.assign(v, { unexpected: true });
      },
    },
    {
      name: 'extra request member',
      code: 'SourceEnvelopeShape',
      mutate: (v: GeoSourceEnvelope) => {
        Object.assign(v.request, { unexpected: true });
      },
    },
    {
      name: 'extra capture scope member',
      code: 'SourceEnvelopeShape',
      mutate: (v: GeoSourceEnvelope) => {
        Object.assign(v.request.capture.scope, { unexpected: true });
      },
    },
    {
      name: 'invalid original capture revision',
      code: 'SourceCapture',
      mutate: (v: GeoSourceEnvelope) => {
        v.request.capture.revision.sequence = -1;
      },
    },
  ])(
    'applies full read admission to nonhead replay after preparation: $name',
    async ({ code, mutate }) => {
      const s = store(),
        candidate = await record(1, null, 'complete original');
      await s.commit(candidate, null, signal());
      await s.commit(await record(2, 'v1'), 'v1', signal());
      const prepared = deferred<void>(),
        release = deferred<void>();
      const copy = store(),
        checked = copy.checked;
      let calls = 0;
      const spy = vi.spyOn(copy, 'checked').mockImplementation(async (text) => {
        const result = await checked(text);
        if (++calls === 2) {
          prepared.resolve();
          await release.promise;
        }
        return result;
      });
      try {
        const pending = copy.commit(candidate, null, signal());
        await prepared.promise;
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(databaseName, 1);
          open.onsuccess = () => {
            const db = open.result,
              tx = db.transaction('artifacts', 'readwrite');
            const os = tx.objectStore('artifacts'),
              request = os.get('geo');
            request.onsuccess = () => {
              const b = JSON.parse(request.result),
                entry = b.versions.find((v: { id: string }) => v.id === 'v1');
              const saved = JSON.parse(entry.text) as GeoSourceEnvelope;
              mutate(saved);
              entry.text = JSON.stringify(saved);
              os.put(JSON.stringify(b), 'geo');
            };
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
          };
        });
        release.resolve();
        expect(await pending).toEqual({ state: 'no-write', code });
        await expect(s.load('v1')).rejects.toThrow(code);
        expect(await s.inspect()).toMatchObject({ versions: 2, acknowledgements: 2, head: 'v2' });
      } finally {
        release.resolve();
        spy.mockRestore();
      }
    },
  );
  it('serializes competing tab transactions so exactly one wins', async () => {
    const outcomes = await Promise.all([
      store().commit(await record(1), null, signal()),
      store().commit(await record(2), null, signal()),
    ]);
    expect(outcomes.filter((o) => o.state === 'committed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.state === 'no-write')).toHaveLength(1);
    expect((await store().inspect()).versions).toBe(1);
  });
});
