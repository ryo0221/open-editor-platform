import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import type { VideoContent } from '@editor-platform/video-core';
import { FileTarget } from './target';
import { memory, MAX_ARCHIVE, scan } from './io';
import { openProject, prepareProject, type Project } from './project';
import { writeZip } from './zip64';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  vi.clearAllMocks();
});
const signal = () => new AbortController().signal;
async function path() {
  const d = await mkdtemp(join(tmpdir(), 'video-review-'));
  dirs.push(d);
  return join(d, 'complete.zip');
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(): Promise<Project> {
  const content: VideoContent = {
    schema: 'video-core-prototype-v0',
    sources: [],
    sequence: {
      id: 'sequence',
      duration: { value: 0, timescale: 1 },
      frameRate: { value: 25, timescale: 1 },
      clips: [],
      tracks: [],
    },
  };
  const hash = await contentHash(content);
  return {
    operationId: 'A',
    capture: {
      scope: { artifactId: 'video', sessionId: 'session', generation: 'g1' },
      revision: { kind: 'local-draft', sessionId: 'session', sequence: 1 },
      contentHash: hash,
    },
    selectedVersionId: 'v1',
    versions: [
      {
        artifactId: 'video',
        versionId: 'v1',
        parentVersionId: null,
        schemaVersion: 1,
        content,
        contentHash: hash,
        createdAt: '2026-10-13',
        createdBy: null,
        reason: null,
      },
    ],
    plans: [],
    originals: new Map(),
  };
}
it.each(['success', 'reject'])(
  'R01 held replace acknowledgement %s cannot release A ownership or corrupt B',
  async (late) => {
    const destination = await path(),
      p = await fixture(),
      renamed = deferred(),
      ack = deferred();
    let calls = 0;
    const target = new FileTarget(destination, MAX_ARCHIVE, async (a, b) => {
      await rename(a, b);
      if (++calls === 1) {
        renamed.resolve();
        await ack.promise;
        if (late === 'reject') throw Error('late A rejection');
      }
    });
    const saving = target.save(p, signal());
    await renamed.promise;
    try {
      const observed = await target.reconcile('A');
      expect(observed.state).toBe('unknown');
      if (observed.state === 'unknown') expect(observed.receipt.operationId).toBe('A');
      await expect(target.save({ ...p, operationId: 'B' }, signal())).rejects.toThrow('Busy');
    } finally {
      ack.resolve();
    }
    const result = await saving;
    expect(result.state).toBe(late === 'success' ? 'saved' : 'unknown');
    if (result.state !== 'not-written') expect(result.receipt.operationId).toBe('A');
    if (late === 'reject') {
      await expect(target.save({ ...p, operationId: 'B' }, signal())).rejects.toThrow('Busy');
      expect((await target.reconcile('A')).state).toBe('saved');
    }
    expect((await target.save({ ...p, operationId: 'B' }, signal())).state).toBe('saved');
    expect((await openProject(memory(await readFile(destination)), signal())).operationId).toBe(
      'B',
    );
  },
);
function malformed(p: Project, kind: string) {
  if (kind === 'comma-key')
    Object.assign(p.capture, { scope: { artifactId: 'video', 'generation,sessionId': 'g' } });
  else Object.assign(p.capture, { revision: { ...p.capture.revision, sessionId: 'foreign' } });
}
it.each(['comma-key', 'session-mismatch'])('R02 writer rejects %s capture', async (kind) => {
  const p = await fixture();
  malformed(p, kind);
  await expect(prepareProject(p, signal())).rejects.toThrow();
});
it.each(['comma-key', 'session-mismatch'])(
  'R03 reader rejects %s despite valid ZIP CRC and entry SHA',
  async (kind) => {
    const entries = await prepareProject(await fixture(), signal());
    const manifest = JSON.parse(
      new TextDecoder().decode(await entries[0].reader.read(0n, Number(entries[0].size), signal())),
    );
    malformed(manifest, kind);
    const r = memory(new TextEncoder().encode(canonicalJson(manifest)));
    entries[0] = { name: 'manifest.json', reader: r, size: r.size, ...(await scan(r, signal())) };
    const chunks: Uint8Array[] = [];
    await writeZip(
      entries,
      {
        async write(b) {
          chunks.push(Uint8Array.from(b));
        },
      },
      signal(),
    );
    await expect(openProject(memory(Buffer.concat(chunks)), signal())).rejects.toThrow();
  },
);
it.each(['ENOSPC', 'EMFILE', 'ENOENT'])(
  'R04 unacquired stage open %s settles no-write and permits retry',
  async (code) => {
    const destination = await path(),
      p = await fixture(),
      target = new FileTarget(destination, MAX_ARCHIVE);
    expect((await target.save(p, signal())).state).toBe('saved');
    const before = await readFile(destination);
    vi.mocked(open).mockRejectedValueOnce(Object.assign(Error('injected open failure'), { code }));
    vi.mocked(unlink).mockClear();
    const retry = { ...p, operationId: 'retry' };
    expect((await target.save(retry, signal())).state).toBe('not-written');
    expect(unlink).not.toHaveBeenCalled();
    expect(await readFile(destination)).toEqual(before);
    expect((await target.save(retry, signal())).state).toBe('saved');
  },
);
it('R05 a genuinely acquired stage that cannot be removed retains its lock', async () => {
  const destination = await path(),
    p = await fixture(),
    target = new FileTarget(destination, MAX_ARCHIVE);
  expect((await target.save(p, signal())).state).toBe('saved');
  const before = await readFile(destination);
  const abort = new AbortController(),
    realOpen = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await realOpen.open(...args);
    abort.abort();
    return handle;
  });
  vi.mocked(unlink).mockRejectedValueOnce(
    Object.assign(Error('injected unlink failure'), { code: 'EACCES' }),
  );
  await expect(target.save({ ...p, operationId: 'blocked' }, abort.signal)).rejects.toThrow(
    'cleanup unresolved',
  );
  expect(await readFile(destination)).toEqual(before);
  await expect(target.save({ ...p, operationId: 'later' }, signal())).rejects.toThrow('Busy');
});
it('R06 deferred reader close retains A ownership until reconciliation cleanup settles', async () => {
  const destination = await path(),
    p = await fixture(),
    closing = deferred(),
    release = deferred();
  const target = new FileTarget(destination, MAX_ARCHIVE, async (a, b) => {
    await rename(a, b);
    throw Error('lost acknowledgement');
  });
  expect((await target.save(p, signal())).state).toBe('unknown');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      closing.resolve();
      await release.promise;
      await close();
    };
    return handle;
  });
  const reconciling = target.reconcile('A');
  await closing.promise;
  try {
    await expect(target.save({ ...p, operationId: 'B' }, signal())).rejects.toThrow('Busy');
    expect(target.reconcile('A')).toBe(reconciling);
  } finally {
    release.resolve();
    await reconciling;
  }
  expect((await target.save({ ...p, operationId: 'B' }, signal())).state).toBe('unknown');
  const result = await target.reconcile('B');
  expect(result.state).toBe('saved');
  if (result.state !== 'not-written') expect(result.receipt.operationId).toBe('B');
});
