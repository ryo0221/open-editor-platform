import { EditorSession, EditorInputs } from '@editor-platform/editor-core';
import { time, type VideoContent } from '@editor-platform/video-core';
import { videoTimelineExtension } from '@editor-platform/video-metadata/edit';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import {
  SchemaEditExperimentRegistry,
  createSchemaEditController,
} from '@editor-platform/extension-runtime/schema-edit-experiment';
import { importOriginal } from './import';
import { MediaStore, VideoBundleStorage } from './bundle';
import { StagedBlobTarget } from './staging';
import { mp4Probe } from './mp4-probe';
import { VideoExport } from './export';
// @ts-expect-error Fixed external candidate tested through its actual product adapter.
import { productCodec } from './product-codec.mjs';
// @ts-expect-error Private realm ownership is inspected only by this regression probe.
import { encodingState, beginEncoding, endEncoding } from './encoder-state.mjs';
const need = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export function createProbeHost() {
  const owner = new ReferenceRegistry(new ManualClock()),
    schemaIdentity = { kind: 'literal', value: 'video-core-prototype-v0' } as const;
  const registry = new SchemaEditExperimentRegistry(owner, [
    { artifactKind: 'video', schemaIdentity },
  ]);
  const definition = videoTimelineExtension('a'.repeat(64), {
    createController: createSchemaEditController,
    onError: () => {},
  });
  const content: VideoContent = {
    schema: 'video-core-prototype-v0',
    sources: [],
    sequence: {
      id: 'sequence',
      frameRate: time(25),
      duration: time(0),
      clips: [],
      tracks: [
        { id: 'visual', kind: 'visual', locked: false, enabled: true },
        { id: 'audio', kind: 'audio', locked: false, enabled: true },
      ],
    },
  };
  const store = new MediaStore(),
    storage = new VideoBundleStorage('project', store, new StagedBlobTarget());
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
      session: new EditorSession(content),
      inputs: new EditorInputs(),
      storage,
      allowed: () => true,
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
    editor = createSchemaEditController(handle.context, { onError: () => {} }),
    binding = {
      read: () => handle.context.basic.read(),
      view: () => editor.getSnapshot(),
      execute: editor.execute,
      check: () => {
        handle.context.basic.read();
      },
    };
  const job = new VideoExport(binding, store, productCodec),
    life = handle.context.addons.lifecycle;
  if (life.state !== 'granted') throw Error('Lifecycle missing');
  life.api.registerDisposable('actual-product-export', () => job.dispose());
  return { handle, binding, store, job };
}
export async function finalizeProbe(bytes: number[], mode: 'resolve' | 'reject') {
  const h = createProbeHost(),
    entered = deferred(),
    release = deferred();
  let gatePending = false,
    jobSettled = false,
    flushReleased = false,
    closedEncoders = 0;
  const hooks = globalThis as typeof globalThis & {
    __holdAacFlush?: () => Promise<void>;
    __aacClosed?: () => void;
  };
  hooks.__aacClosed = () => {
    closedEncoders++;
  };
  hooks.__holdAacFlush = async () => {
    gatePending = true;
    entered.resolve();
    await release.promise;
    gatePending = false;
    flushReleased = true;
    if (mode === 'reject') throw Error('Injected flush rejection');
  };
  await importOriginal(
    new Blob([new Uint8Array(bytes)]),
    mp4Probe,
    h.store,
    h.binding,
    new AbortController().signal,
  );
  const running = h.job.run(new AbortController().signal).then(
    () => {
      jobSettled = true;
      return 'published';
    },
    () => {
      jobSettled = true;
      return 'rejected';
    },
  );
  await entered.promise;
  const owned = encodingState(),
    packetsBefore = owned.rawPackets.length;
  h.handle.revoke('permission-expired');
  await new Promise((r) => setTimeout(r, 0));
  const before = {
    jobSettled,
    underlyingFinalizePending: gatePending,
    encoderStateCleared: false,
    drain: (await h.handle.drain({ deadlineMs: 0 })).state,
    competingJobRefused: false,
    closedEncoders,
  };
  try {
    before.encoderStateCleared = encodingState() !== owned;
  } catch {
    before.encoderStateCleared = true;
  }
  try {
    const other = beginEncoding(1);
    endEncoding(other);
  } catch {
    before.competingJobRefused = true;
  }
  release.resolve();
  const outcome = await running;
  hooks.__holdAacFlush = undefined;
  const after = {
    jobSettled,
    flushReleased,
    outcome,
    drain: (await h.handle.drain({ deadlineMs: 1000 })).state,
    published: !!h.job.completed,
    packetsBefore,
    packetsAfter: owned.rawPackets.length,
    closedEncoders,
  };
  const fresh = createProbeHost();
  await importOriginal(
    new Blob([new Uint8Array(bytes)]),
    mp4Probe,
    fresh.store,
    fresh.binding,
    new AbortController().signal,
  );
  const recovered = await fresh.job.run(new AbortController().signal);
  await fresh.job.dispose();
  const result = { mode, before, after, recoveredMp4Bytes: recovered.bytes.size };
  // Return original observations even on a regression; Node runner asserts and retains them.
  need(recovered.bytes.type === 'video/mp4', 'Fresh export did not recover');
  return result;
}
(globalThis as typeof globalThis & { finalizeProbe: typeof finalizeProbe }).finalizeProbe =
  finalizeProbe;
