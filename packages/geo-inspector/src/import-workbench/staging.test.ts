import { expect, it } from 'vitest';
import { deferred } from '@editor-platform/extension-runtime/reference';
import { createSourceStaging } from '../../test-host/source-staging';
const bytes = new Uint8Array([1, 2, 3]);
const digest = 'a'.repeat(64),
  byteHash = `sha256:${digest}`;
const hashing = { hashBytes: async () => byteHash, hashManifest: async () => digest };
it('reserves identity and capacity synchronously; cancellation reuses capacity but never identity', async () => {
  const gate = deferred<void>();
  const stages = createSourceStaging({
    limit: 2,
    current() {},
    beforeHash: () => gate.promise,
    ...hashing,
  });
  const a = new AbortController(),
    b = new AbortController(),
    c = new AbortController();
  const first = stages.prepare(bytes, 'A', 'csv', a.signal).catch((e: Error) => e);
  const second = stages.prepare(bytes, 'B', 'csv', b.signal);
  expect(stages.size).toBe(2);
  await expect(stages.prepare(bytes, 'full', 'csv', new AbortController().signal)).rejects.toThrow(
    'TestHostStageLimit',
  );
  a.abort();
  expect(stages.size).toBe(1);
  const third = stages.prepare(bytes, 'C', 'csv', c.signal);
  expect(stages.size).toBe(2);
  gate.resolve();
  expect(await first).toMatchObject({ message: 'SourceStageReleased' });
  const bLease = await second,
    cLease = await third;
  expect([bLease.source.id, cLease.source.id]).toEqual(['source-2', 'source-3']);
  bLease.release();
  bLease.release();
  a.abort();
  expect(stages.size).toBe(1);
  expect(stages.ready(cLease.source.id)?.source).toEqual(cLease.source);
  c.abort();
  expect(stages.size).toBe(0);
});
it('deferred manifest A after Cancel cannot overwrite B, including a repeated late release', async () => {
  const blocked = deferred<void>(),
    finish = deferred<string>();
  const stages = createSourceStaging({
    limit: 1,
    current() {},
    ...hashing,
    hashManifest: async (m) => {
      if (m.name === 'A') {
        blocked.resolve();
        return finish.promise;
      }
      return digest;
    },
  });
  const a = new AbortController();
  const first = stages.prepare(bytes, 'A', 'csv', a.signal).catch((e: Error) => e);
  await blocked.promise;
  a.abort();
  const next = await stages.prepare(bytes, 'B', 'csv', new AbortController().signal);
  const ready = stages.ready(next.source.id);
  finish.resolve(digest);
  expect(await first).toMatchObject({ message: 'SourceStageReleased' });
  expect(next.source.id).toBe('source-2');
  expect(stages.ready(next.source.id)).toBe(ready);
  expect(stages.size).toBe(1);
  next.release();
  expect(stages.size).toBe(0);
});
it.each(['bytes', 'manifest'] as const)(
  'failed %s hashing releases its reservation and allows a fresh owner',
  async (phase) => {
    let fail = true;
    const stages = createSourceStaging({
      limit: 1,
      current() {},
      hashBytes: async () => {
        if (fail && phase === 'bytes') throw new Error('hash-failed');
        return byteHash;
      },
      hashManifest: async () => {
        if (fail && phase === 'manifest') throw new Error('hash-failed');
        return digest;
      },
    });
    await expect(stages.prepare(bytes, 'bad', 'csv', new AbortController().signal)).rejects.toThrow(
      'hash-failed',
    );
    expect(stages.size).toBe(0);
    fail = false;
    const next = await stages.prepare(bytes, 'good', 'csv', new AbortController().signal);
    expect(next.source.id).toBe('source-2');
    next.release();
    expect(stages.size).toBe(0);
  },
);
it('abort after ready and retired release cannot delete a later live reservation', async () => {
  const stages = createSourceStaging({ limit: 1, current() {}, ...hashing });
  const abort = new AbortController();
  const old = await stages.prepare(bytes, 'old', 'csv', abort.signal);
  expect(Object.isFrozen(old.source)).toBe(true);
  expect(Object.isFrozen(old.source.pin)).toBe(true);
  abort.abort();
  const fresh = await stages.prepare(bytes, 'fresh', 'csv', new AbortController().signal);
  old.release();
  expect(stages.ready(fresh.source.id)?.source).toEqual(fresh.source);
  stages.dispose();
  fresh.release();
  expect(stages.size).toBe(0);
});
it('scope disposal during deferred hashing prevents late publication and new admissions', async () => {
  const gate = deferred<void>();
  const stages = createSourceStaging({
    limit: 1,
    current() {},
    beforeHash: () => gate.promise,
    ...hashing,
  });
  const pending = stages
    .prepare(bytes, 'old', 'csv', new AbortController().signal)
    .catch((e: Error) => e);
  stages.dispose();
  expect(stages.size).toBe(0);
  gate.resolve();
  expect(await pending).toMatchObject({ message: 'SourceStageReleased' });
  expect(stages.size).toBe(0);
  await expect(stages.prepare(bytes, 'new', 'csv', new AbortController().signal)).rejects.toThrow(
    'SourceStageReleased',
  );
});
