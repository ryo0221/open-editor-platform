import { VideoExport, type Mp4Codec, type ExportSnapshot } from './export';
import { expect, it } from 'vitest';
import { EditorSession, EditorInputs, command } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import { time, type VideoContent } from '@editor-platform/video-core';
import { videoTimelineExtension } from '@editor-platform/video-metadata/edit';
import { ReferenceRegistry, type WriteRequest } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import {
  SchemaEditExperimentRegistry,
  createSchemaEditController,
} from '@editor-platform/extension-runtime/schema-edit-experiment';
import {
  importOriginal,
  prepareImportSet,
  ImportLeasePool,
  digest,
  type ImportSet,
  type ImportBinding,
} from './import';
import { MediaStore, VideoBundleStorage, openBundle, type BundleTarget } from './bundle';
import { StagedBlobTarget } from './staging';
const signal = () => new AbortController().signal;
const empty = (): VideoContent => ({
  schema: 'video-core-prototype-v0',
  sources: [],
  sequence: {
    id: 'sequence',
    duration: time(0),
    frameRate: time(30000, 1001),
    clips: [],
    tracks: [
      { id: 'visual', kind: 'visual', locked: false, enabled: true },
      { id: 'audio', kind: 'audio', locked: false, enabled: true },
    ],
  },
});
const av = (): ImportSet => ({
  streams: [
    {
      id: 'v',
      kind: 'video',
      destination: 'visual',
      mediaStart: time(2),
      mediaEnd: time(3),
      presentationStart: time(1, 8),
    },
    {
      id: 'a',
      kind: 'audio',
      destination: 'audio',
      mediaStart: time(1024, 44100),
      mediaEnd: time(45124, 44100),
      presentationStart: time(1, 4),
      sampleRate: 44100,
    },
  ],
});
const original = new Blob(['test original bytes: not a codec acceptance fixture']);
function host(
  content = empty(),
  store = new MediaStore(),
  target: BundleTarget = new StagedBlobTarget(),
) {
  const owner = new ReferenceRegistry(new ManualClock());
  const schemaIdentity = { kind: 'literal', value: 'video-core-prototype-v0' } as const;
  const registry = new SchemaEditExperimentRegistry(owner, [
    { artifactKind: 'video', schemaIdentity },
  ]);
  const definition = videoTimelineExtension('a'.repeat(64), {
    createController: createSchemaEditController,
    onError: () => {},
  });
  const session = new EditorSession(content),
    inputs = new EditorInputs();
  const storage = new VideoBundleStorage('project', store, target);
  let allowed = true;
  const opened = registry
    .install(definition, {
      trust: 'trusted',
      verifiedPin: {
        id: definition.manifest.id,
        version: definition.manifest.version,
        packageHash: definition.manifest.packageHash,
      },
    })
    .open({
      artifactId: 'project',
      artifactKind: 'video',
      schemaIdentity,
      session,
      inputs,
      storage,
      allowed: () => allowed,
      subscribePermissions: () => () => {},
      recovery: {
        codecs: [],
        perBoundaryBytes: 2048,
        totalBytes: 8192,
        ttlMs: 1000,
        onRevoke: 'discard',
      },
    });
  if (opened.state !== 'opened') throw Error(opened.code);
  const handle = opened.handle,
    editor = createSchemaEditController(handle.context, { onError: () => {} });
  const binding: ImportBinding = {
    read: () => handle.context.basic.read(),
    view: () => editor.getSnapshot(),
    execute: (v) => editor.execute(v),
    check: () => {
      if (!allowed) throw Error('Authority revoked');
      handle.context.basic.read();
    },
  };
  const add = (set = av(), bytes = original) =>
    importOriginal(bytes, { inspect: async () => set }, store, binding, signal());
  const snapshot = () => handle.context.basic.read();
  const save = () => {
    const grant = handle.context.addons.save;
    if (grant.state !== 'granted') throw Error('No save');
    return grant.api.save();
  };
  return {
    owner,
    session,
    store,
    storage,
    target,
    handle,
    editor,
    binding,
    add,
    snapshot,
    save,
    deny: () => {
      allowed = false;
    },
  };
}
it('atomic selected video/audio preserves rational relative placement and one Undo/Redo retains originals', async () => {
  const h = host(),
    result = await h.add();
  expect(h.session.content.sources).toHaveLength(1);
  expect(h.session.content.sequence.clips.map((c) => c.start)).toEqual([time(0), time(1, 8)]);
  expect(new Set(h.session.content.sequence.clips.map((c) => c.linkGroupId)).size).toBe(1);
  expect(h.editor.undo().state).toBe('applied');
  expect(h.session.content.sources).toHaveLength(0);
  expect(await h.store.get(result.hash)!.text()).toBe(await original.text());
  expect(h.editor.redo().state).toBe('applied');
  expect(h.session.content.sequence.clips).toHaveLength(2);
});
it.each(['invalid-audio', 'locked', 'alternate-audio', 'fractional'])(
  '%s rejects the whole import without retained assets',
  async (mode) => {
    const h = host(),
      set = av();
    if (mode === 'invalid-audio') set.streams[1].sampleRate = 0;
    if (mode === 'locked') set.streams[1].destination = 'missing';
    if (mode === 'alternate-audio') set.streams.push({ ...set.streams[1], id: 'alternate' });
    if (mode === 'fractional') set.streams[1].mediaEnd = time(3, 29);
    await expect(h.add(set)).rejects.toThrow();
    expect(h.session.content).toEqual(empty());
    expect(h.store.get(await digest(original))).toBeUndefined();
  },
);
it('opaque leases reject foreign Host, reuse, stale revision and revoked authority', async () => {
  const h = host(),
    pool = new ImportLeasePool(h.store, h.binding),
    foreign = new ImportLeasePool(h.store, h.binding);
  const token = await pool.stage(original, { inspect: async () => av() }, signal());
  expect(() => foreign.commit(token, signal())).toThrow('Foreign');
  h.editor.execute({
    baseRevision: h.session.revision,
    command: command('edit', 'edit', (v) => ({ ...v, sequence: { ...v.sequence, id: 'changed' } })),
  });
  expect(() => pool.commit(token, signal())).toThrow('refused');
  expect(() => pool.commit(token, signal())).toThrow('consumed');
  expect(h.store.get(await digest(original))).toBeUndefined();
  const next = await pool.stage(original, { inspect: async () => av() }, signal());
  h.deny();
  expect(() => pool.commit(next, signal())).toThrow('ScopeRevoked');
  pool.dispose();
  foreign.dispose();
});
it('cancel during probe and quota admission never alter the native draft', async () => {
  const h = host(),
    abort = new AbortController();
  await expect(
    importOriginal(
      original,
      {
        inspect: async () => {
          abort.abort();
          return av();
        },
      },
      h.store,
      h.binding,
      abort.signal,
    ),
  ).rejects.toThrow();
  await expect(h.add(av(), new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]))).rejects.toThrow(
    'budget',
  );
  expect(h.session.content).toEqual(empty());
});
it('two independent Host instances reopen only bundle bytes including retained native envelopes and original closure', async () => {
  const a = host(),
    imported = await a.add();
  expect((await a.save()).state).toBe('committed');
  const firstVersion = structuredClone(a.storage.versions[0]);
  // Current root no longer mentions the original. The immutable retained root still requires it.
  a.editor.execute({
    baseRevision: a.session.revision,
    command: command('clear', 'clear', () => empty()),
  });
  expect((await a.save()).state).toBe('committed');
  const bytes = (a.target as StagedBlobTarget).latest!;
  a.handle.revoke('host-close');
  const reopened = await openBundle(new Blob([await bytes.arrayBuffer()]), signal());
  const b = host(reopened.selected.content, reopened.store);
  b.storage.versions = reopened.versions;
  b.storage.selectedVersionId = reopened.selected.versionId;
  expect(b.session.content).toEqual(empty());
  expect(reopened.versions[0]).toEqual(firstVersion);
  expect(reopened.selected.parentVersionId).toBe(firstVersion.versionId);
  expect(await b.store.get(imported.hash)!.text()).toBe(await original.text());
  expect((await b.save()).state).toBe('committed');
  const selectedEntry = reopened.manifest.entries.find(
    (e) => e.id === 'version:' + reopened.selected.versionId,
  )!;
  expect(selectedEntry.sha256).not.toBe(reopened.selected.contentHash);
  expect(reopened.selected.contentHash).toBe(await contentHash(empty()));
});
async function mutateManifest(bytes: Blob, change: (m: Record<string, unknown>) => void) {
  const head = new DataView(await bytes.slice(0, 8).arrayBuffer()),
    n = head.getUint32(4);
  const manifest = JSON.parse(await bytes.slice(8, 8 + n).text());
  change(manifest);
  const text = new TextEncoder().encode(JSON.stringify(manifest)),
    header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, 0x56425030);
  new DataView(header.buffer).setUint32(4, text.length);
  return new Blob([header, text, bytes.slice(8 + n)]);
}
it.each(['tamper', 'missing', 'extra', 'plan', 'capture', 'quota'])(
  '%s bundle refuses before activating a new Host',
  async (mode) => {
    const h = host();
    await h.add();
    await h.save();
    let bytes = (h.target as StagedBlobTarget).latest!;
    if (mode === 'tamper') bytes = new Blob([bytes.slice(0, bytes.size - 1), '!']);
    if (mode === 'missing') bytes = bytes.slice(0, bytes.size - 1);
    if (mode === 'extra') bytes = new Blob([bytes, '!']);
    if (mode === 'plan')
      bytes = await mutateManifest(bytes, (m) => {
        m.plans = [];
      });
    if (mode === 'capture')
      bytes = await mutateManifest(bytes, (m) => {
        (m.capture as { scope: { artifactId: string } }).scope.artifactId = 'foreign';
      });
    if (mode === 'quota') bytes = new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]);
    await expect(openBundle(bytes, signal())).rejects.toThrow();
  },
);
it('save unknown keeps existing coordinator lock and reconciles exact operation/capture after scope close', async () => {
  const base = new StagedBlobTarget();
  let hidden = true;
  const target: BundleTarget = {
    begin: async (id) => {
      const stage = await base.begin(id);
      return {
        ...stage,
        commit: async () => {
          await stage.commit();
          throw Error('lost ack');
        },
      };
    },
    inspect: async (id) => (hidden ? 'unknown' : base.inspect(id)),
  };
  const h = host(empty(), new MediaStore(), target);
  await h.add();
  const result = await h.save();
  expect(result.state).toBe('indeterminate');
  if (result.state !== 'indeterminate') throw Error('Expected unknown');
  await expect(h.save()).rejects.toThrow('SaveBusy');
  h.handle.revoke('host-close');
  expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({ state: 'incomplete' });
  hidden = false;
  const evidence = await h.storage.reconcile(result.operationId);
  expect(evidence).toMatchObject({
    state: 'committed',
    operationId: result.operationId,
    capture: result.capture,
  });
  h.owner.saves.reconcile(result.operationId, evidence);
  expect(await h.handle.drain({ deadlineMs: 1000 })).toMatchObject({ state: 'drained' });
});
it('failed staged write preserves previous completed bundle and returns definite no-write', async () => {
  const base = new StagedBlobTarget();
  let fail = false;
  const target: BundleTarget = {
    inspect: (id) => base.inspect(id),
    begin: async (id) => {
      const s = await base.begin(id);
      return {
        ...s,
        write: async (b, abort) => {
          if (fail) throw Error('quota fault');
          await s.write(b, abort);
        },
      };
    },
  };
  const h = host(empty(), new MediaStore(), target);
  await h.add();
  await h.save();
  const previous = base.latest;
  fail = true;
  expect((await h.save()).state).toBe('aborted-before-write');
  expect(base.latest).toBe(previous);
});
it('captured content and original closure remain frozen while current draft changes', async () => {
  const h = host();
  await h.add();
  const snapshot = h.snapshot(),
    release = h.storage.retainCapture(snapshot);
  const request: WriteRequest<VideoContent> = {
    operationId: 'manual-capture',
    content: snapshot.content,
    capture: {
      scope: snapshot.scope,
      revision: snapshot.revision,
      contentHash: await contentHash(snapshot.content),
    },
  };
  h.editor.undo();
  expect((await h.storage.write(request, signal())).state).toBe('committed');
  release();
  const opened = await openBundle((h.target as StagedBlobTarget).latest!, signal());
  expect(opened.selected.content.sources).toHaveLength(1);
  expect(h.session.content.sources).toHaveLength(0);
});

it('native parent follows the explicitly selected retained root, never archive order', async () => {
  const h = host();
  await h.add();
  await h.save();
  const first = h.storage.selectedVersionId;
  await h.save();
  const second = h.storage.selectedVersionId;
  h.storage.selectedVersionId = first;
  await h.save();
  expect(h.storage.versions.at(-1)!.parentVersionId).toBe(first);
  expect(h.storage.versions.at(-1)!.parentVersionId).not.toBe(second);
  // A duplicate old receipt cannot roll the adapter's selected root backwards.
  const latest = h.storage.selectedVersionId,
    op = h.owner.saves.observations()[0].operationId;
  await h.storage.reconcile(op);
  expect(h.storage.selectedVersionId).toBe(latest);
});

it('repeated 16 MiB saves reject cumulative quota before commit, settle and permit retry', async () => {
  const firstTarget = new StagedBlobTarget();
  let destination = firstTarget;
  const port: BundleTarget = {
    begin: (id) => destination.begin(id),
    inspect: (id) => destination.inspect(id),
  };
  const h = host(empty(), new MediaStore(), port);
  await h.add(av(), new Blob([new Uint8Array(16 * 1024 * 1024)]));
  for (let i = 0; i < 3; i++) expect((await h.save()).state).toBe('committed');
  const previous = firstTarget.latest,
    previousHash = await digest(previous!);
  const rejected = await h.save();
  expect(rejected.state).toBe('aborted-before-write');
  expect(rejected).toMatchObject({ proof: 'adapter-no-write-guarantee' });
  expect(firstTarget.latest).toBe(previous);
  expect(await firstTarget.inspect(rejected.operationId)).toBeUndefined();
  // A definitive no-write needs no invented target receipt or claim unlock.
  expect(
    h.owner.saves.observations().find((j) => j.operationId === rejected.operationId)?.outcome,
  ).toEqual(rejected);
  await expect(h.storage.reconcile(rejected.operationId)).rejects.toThrow(
    'Unknown bundle operation',
  );
  // Same exhausted destination can be retried: it refuses definitely, never SaveBusy.
  expect((await h.save()).state).toBe('aborted-before-write');
  // Host selects a fresh staging destination; old completed bundle is retained intact.
  destination = new StagedBlobTarget();
  expect((await h.save()).state).toBe('committed');
  expect(await digest(firstTarget.latest!)).toBe(previousHash);
  expect((await openBundle(destination.latest!, signal())).versions).toHaveLength(4);
}, 30000);

it('concurrent reconciles of A cannot publish A after a newer save B', async () => {
  const base = new StagedBlobTarget();
  let firstOperation = '',
    callsA = 0,
    releaseFirst!: () => void,
    releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const target: BundleTarget = {
    begin: async (id) => {
      const s = await base.begin(id);
      if (!firstOperation) firstOperation = id;
      return {
        ...s,
        commit: async () => {
          await s.commit();
          if (id === firstOperation) throw Error('lost ack A');
        },
      };
    },
    inspect: async (id) => {
      if (id === firstOperation) {
        callsA++;
        await (callsA === 1 ? firstGate : secondGate);
      }
      return base.inspect(id);
    },
  };
  const h = host(empty(), new MediaStore(), target);
  await h.add();
  const a = await h.save();
  expect(a.state).toBe('indeterminate');
  const a1 = h.storage.reconcile(a.operationId),
    a2 = h.storage.reconcile(a.operationId);
  await Promise.resolve();
  await Promise.resolve();
  releaseFirst();
  h.owner.saves.reconcile(a.operationId, await a1);
  const b = await h.save();
  expect(b.state).toBe('committed');
  const selectedB = h.storage.selectedVersionId,
    versionsB = structuredClone(h.storage.versions);
  releaseSecond();
  expect(await a2).toMatchObject({ state: 'committed', operationId: a.operationId });
  expect(h.storage.selectedVersionId).toBe(selectedB);
  expect(h.storage.versions).toEqual(versionsB);
  expect(callsA).toBe(1);
});

it('valid short-ID 191-clip Host root rejects full-view overflow before ownership or mutation', async () => {
  const oldBytes = new Blob(['retained original']),
    hash = await digest(oldBytes),
    store = new MediaStore();
  const content = empty();
  content.sequence.tracks = content.sequence.tracks.slice(0, 1);
  content.sequence.duration = time(191);
  content.sources = [
    {
      id: 's',
      asset: { assetId: 'm', sha256: hash, byteLength: oldBytes.size },
      streams: [
        {
          id: 'v',
          kind: 'video',
          timebase: time(1),
          startPts: 0,
          endPts: 1,
          presentationOrigin: time(0),
        },
      ],
    },
  ];
  content.sequence.clips = Array.from({ length: 191 }, (_, i) => ({
    id: 'c' + i,
    kind: 'video' as const,
    sourceId: 's',
    streamId: 'v',
    trackId: 'visual',
    start: time(i),
    duration: time(1),
    sourceIn: time(0),
    sourceOut: time(1),
    rate: time(1),
  }));
  store.put(hash, oldBytes);
  store.putPlan('s', {
    streams: [
      {
        id: 'v',
        kind: 'video',
        destination: 'visual',
        mediaStart: time(0),
        mediaEnd: time(1),
        presentationStart: time(0),
      },
    ],
  });
  const h = host(content, store),
    before = h.snapshot(),
    nextBytes = new Blob(['new original']);
  expect(new TextEncoder().encode(JSON.stringify(content)).length).toBeLessThan(60000);
  expect(h.editor.getSnapshot().state).toBe('open');
  const videoOnly = { streams: [av().streams[0]] };
  const projected = prepareImportSet(
    content,
    videoOnly,
    { assetId: 'm2', sha256: await digest(nextBytes), byteLength: nextBytes.size },
    's2',
  );
  const nodes = (value: unknown): number =>
    1 +
    (value && typeof value === 'object'
      ? Object.values(value).reduce<number>((n, v) => n + nodes(v), 0)
      : 0);
  expect(nodes(projected)).toBeLessThanOrEqual(4096);
  expect(new TextEncoder().encode(JSON.stringify(projected)).length).toBeLessThan(60000);
  expect(
    nodes({
      ...h.editor.getSnapshot(),
      snapshot: { ...before, content: projected },
      lastOperation: { state: 'applied' },
    }),
  ).toBeGreaterThan(4096);
  await expect(h.add(videoOnly, nextBytes)).rejects.toThrow('VideoImportControlledCapacity');
  expect(h.snapshot()).toEqual(before);
  expect(h.editor.getSnapshot().state).toBe('open');
  expect(store.get(await digest(nextBytes))).toBeUndefined();
  expect(store.get(hash)).toBe(oldBytes);
  expect(h.editor.undo().state).toBe('unchanged');
  expect(
    h.editor.execute({
      baseRevision: h.session.revision,
      command: command('rename', 'rename', (v) => ({
        ...v,
        sequence: { ...v.sequence, id: 'renamed' },
      })),
    }).state,
  ).toBe('applied');
  expect(h.editor.undo().state).toBe('applied');
  expect(h.session.content).toEqual(content);
});

it('import reserves bundle envelope headroom instead of committing 32 MiB of originals', async () => {
  const h = host(),
    first = new Blob([new Uint8Array(16 * 1024 * 1024)]);
  const bytes = new Uint8Array(16 * 1024 * 1024);
  bytes[0] = 1;
  const second = new Blob([bytes]);
  await h.add(av(), first);
  const before = h.snapshot();
  await expect(h.add(av(), second)).rejects.toThrow('Host original quota');
  expect(h.snapshot()).toEqual(before);
  expect(h.store.get(await digest(second))).toBeUndefined();
  expect((await h.save()).state).toBe('committed');
}, 30000);

// These verify orchestration against the real import/history/bundle services.
// Stub encoded bytes are intentionally not an MP4 codec acceptance fixture.
const stubMp4 = () => new Blob(['orchestration-only'], { type: 'video/mp4' });
function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it('export pins imported originals and frozen native revision across edits, then bundle-only reopen uses the same service', async () => {
  const h = host();
  await h.add();
  const entered = latch<ExportSnapshot>(),
    finish = latch<Blob>();
  const codec: Mp4Codec = {
    encode: async (snapshot) => {
      entered.resolve(snapshot);
      return finish.promise;
    },
    verify: async () => {},
  };
  const job = new VideoExport(h.binding, h.store, codec),
    running = job.run(signal());
  const capture = await entered.promise;
  expect(Object.isFrozen(capture.native.content.sequence)).toBe(true);
  const capturedHash = await contentHash(h.snapshot().content);
  expect(h.editor.undo().state).toBe('applied');
  finish.resolve(stubMp4());
  const completed = await running;
  expect(completed.snapshot.hash).toBe(capturedHash);
  expect(completed.snapshot.native.content.sequence.clips).toHaveLength(2);
  expect(h.snapshot().content.sequence.clips).toHaveLength(0);
  expect(await capture.originals[0].bytes.text()).toBe(await original.text());
  expect(h.editor.redo().state).toBe('applied');
  expect((await h.save()).state).toBe('committed');
  const archive = (h.target as StagedBlobTarget).latest!;
  const opened = await openBundle(archive, signal());
  const fresh = host(opened.selected.content, opened.store);
  const restored = new VideoExport(fresh.binding, fresh.store, {
    encode: async (snapshot) => {
      expect(snapshot.hash).toBe(capturedHash);
      expect(await snapshot.originals[0].bytes.text()).toBe(await original.text());
      return stubMp4();
    },
    verify: async () => {},
  });
  await restored.run(signal());
  expect(restored.completed?.snapshot.hash).toBe(capturedHash);
});
it.each(['cancel', 'revoke', 'dispose', 'verify-failure'] as const)(
  'export %s during staged verification cannot replace previous output',
  async (mode) => {
    const h = host();
    await h.add();
    let delayed = false;
    const entered = latch<void>(),
      finish = latch<void>();
    const codec: Mp4Codec = {
      encode: async () => stubMp4(),
      verify: async () => {
        if (delayed) {
          entered.resolve();
          await finish.promise;
          if (mode === 'verify-failure') throw Error('Invalid MP4');
        }
      },
    };
    const job = new VideoExport(h.binding, h.store, codec);
    const prior = await job.run(signal());
    delayed = true;
    const running = job.run(signal());
    const rejected = expect(running).rejects.toThrow();
    await entered.promise;
    if (mode === 'cancel') job.cancel();
    if (mode === 'revoke') h.deny();
    if (mode === 'dispose') job.dispose();
    finish.resolve();
    await rejected;
    expect(job.completed).toBe(mode === 'dispose' ? undefined : prior);
  },
);
it('export checks pre-aborted caller and reentrant authority cancellation before codec work', async () => {
  const h = host();
  await h.add();
  let calls = 0;
  const codec: Mp4Codec = {
    encode: async () => {
      calls++;
      return stubMp4();
    },
    verify: async () => {},
  };
  const job = new VideoExport(
    {
      ...h.binding,
      check: () => {
        h.binding.check();
        job.cancel();
      },
    },
    h.store,
    codec,
  );
  await expect(job.run(signal())).rejects.toThrow();
  const caller = new AbortController();
  caller.abort();
  await expect(job.run(caller.signal)).rejects.toThrow();
  expect(calls).toBe(0);
  expect(job.completed).toBeUndefined();
});
it('existing Host lifecycle aborts an in-flight encoder and rejects its late result', async () => {
  const h = host();
  await h.add();
  const entered = latch<AbortSignal>(),
    finish = latch<Blob>();
  const job = new VideoExport(h.binding, h.store, {
    encode: async (_snapshot, signal) => {
      entered.resolve(signal);
      return finish.promise;
    },
    verify: async () => {
      throw Error('Must not verify after revoke');
    },
  });
  const life = h.handle.context.addons.lifecycle;
  if (life.state !== 'granted') throw Error('Missing lifecycle');
  life.api.registerDisposable('test-video-export', () => job.dispose());
  const running = job.run(signal()),
    rejected = expect(running).rejects.toThrow();
  const encoderSignal = await entered.promise;
  h.handle.revoke('permission-expired');
  expect(encoderSignal.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({ state: 'incomplete' });
  finish.resolve(stubMp4());
  await rejected;
  expect(await h.handle.drain({ deadlineMs: 1000 })).toMatchObject({ state: 'drained' });
  expect(job.completed).toBeUndefined();
});
