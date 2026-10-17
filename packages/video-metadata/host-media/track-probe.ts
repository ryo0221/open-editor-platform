import { createProbeHost } from './finalize-probe';
import { importOriginal } from './import';
import { mp4Probe } from './mp4-probe';
// @ts-expect-error Inspect private ownership for the source-backed lifecycle gate.
import { encodingState, beginEncoding, endEncoding } from './encoder-state.mjs';
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type Encoder = {
  pendingMessages: Map<number, unknown>;
  ctx: number;
  worker: unknown;
  videoHostClosed?: boolean;
};
const hooks = globalThis as typeof globalThis & {
  __holdAacFlush?: () => Promise<void>;
  __holdInitReply?: (encoder: Encoder, data: unknown, resume: () => void) => boolean;
  __aacClosed?: () => void;
};
export async function trackProbe(
  bytes: number[],
  mode: 'aac-fails-video-held' | 'video-fails-aac-held' | 'init-reply-held',
) {
  const host = createProbeHost(),
    audioEntered = latch(),
    videoEntered = latch(),
    release = latch(),
    failed = latch();
  let observedOwner: unknown;
  let settled = false,
    closed = 0,
    videoClosed = 0,
    held = true,
    lateReply: (() => void) | undefined,
    encoder: Encoder | undefined;
  hooks.__aacClosed = () => {
    closed++;
  };
  const videoPrototype = (
    globalThis as unknown as {
      VideoEncoder: { prototype: { flush(): Promise<void>; close(): void } };
    }
  ).VideoEncoder.prototype;
  const originalFlush = videoPrototype.flush,
    originalClose = videoPrototype.close;
  videoPrototype.close = function () {
    originalClose.call(this);
    videoClosed++;
  };
  videoPrototype.flush = async function () {
    observedOwner ??= encodingState();
    videoEntered.resolve();
    if (mode === 'aac-fails-video-held') {
      await release.promise;
      held = false;
    }
    if (mode === 'video-fails-aac-held') {
      await audioEntered.promise;
      failed.resolve();
      throw Error('Injected video track failure');
    }
    return originalFlush.call(this);
  };
  hooks.__holdAacFlush = async () => {
    observedOwner ??= encodingState();
    audioEntered.resolve();
    if (mode === 'aac-fails-video-held') {
      await videoEntered.promise;
      failed.resolve();
      throw Error('Injected AAC track failure');
    }
    if (mode === 'video-fails-aac-held') {
      await release.promise;
      held = false;
    }
  };
  if (mode === 'init-reply-held')
    hooks.__holdInitReply = (value, _data, resume) => {
      encoder = value;
      lateReply = resume;
      observedOwner ??= encodingState();
      audioEntered.resolve();
      return true;
    };
  const original = new Blob([new Uint8Array(bytes)]);
  await importOriginal(original, mp4Probe, host.store, host.binding, new AbortController().signal);
  const run = host.job.run(new AbortController().signal).then(
    () => {
      settled = true;
      return 'published';
    },
    () => {
      settled = true;
      return 'rejected';
    },
  );
  if (mode === 'init-reply-held') await audioEntered.promise;
  else await failed.promise;
  const owner = observedOwner;
  const pendingRpcBefore = encoder?.pendingMessages.size;
  host.handle.revoke('permission-expired');
  await new Promise((r) => setTimeout(r, 0));
  let stateHeld = false,
    competingRefused = false;
  try {
    stateHeld = encodingState() === owner;
  } catch {
    /* original defect observation */
  }
  try {
    const other = beginEncoding(1);
    endEncoding(other);
  } catch {
    competingRefused = true;
  }
  const before = {
    settled,
    held,
    stateHeld,
    competingRefused,
    closed,
    videoClosed,
    drain: (await host.handle.drain({ deadlineMs: 0 })).state,
    pendingRpcBefore,
    pendingRpcAfter: encoder?.pendingMessages.size,
  };
  hooks.__holdInitReply = undefined;
  if (lateReply) {
    lateReply();
    await new Promise((r) => setTimeout(r, 0));
    held = false;
  }
  release.resolve();
  const outcome = await Promise.race([
    run,
    new Promise<string>((r) => setTimeout(() => r('stuck'), 2000)),
  ]);
  const after = {
    settled,
    outcome,
    drain: (await host.handle.drain({ deadlineMs: 0 })).state,
    closed,
    videoClosed,
    published: !!host.job.completed,
    lateInitCtx: encoder?.ctx,
    workerRetained: encoder?.worker != null,
  };
  hooks.__holdAacFlush = undefined;
  videoPrototype.flush = originalFlush;
  videoPrototype.close = originalClose;
  let recovered = 0;
  if (outcome !== 'stuck') {
    const fresh = createProbeHost();
    await importOriginal(
      original,
      mp4Probe,
      fresh.store,
      fresh.binding,
      new AbortController().signal,
    );
    const result = await fresh.job.run(new AbortController().signal);
    recovered = result.bytes.size;
    await fresh.job.dispose();
  }
  return { mode, before, after, recovered };
}
(globalThis as typeof globalThis & { trackProbe: typeof trackProbe }).trackProbe = trackProbe;
