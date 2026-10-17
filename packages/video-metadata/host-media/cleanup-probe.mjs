import { contentHash } from '@editor-platform/artifact-core';
import { time } from '@editor-platform/video-core';
import { playTimeline } from './indexed-media/playback.mjs';
import { createProbeHost } from './finalize-probe';
import { importOriginal } from './import';
import { mp4Probe } from './mp4-probe';
import { encodingState } from './encoder-state.mjs';
import { videoStatus } from './indexed-media/video-window.mjs';
import { scratchStatus } from './indexed-media/scratch.mjs';
globalThis.cleanupProbe = async (bytes, mode) => {
  const host = createProbeHost(),
    original = new globalThis.Blob([new Uint8Array(bytes)]),
    prototype = globalThis.FileSystemDirectoryHandle.prototype,
    remove = prototype.removeEntry;
  await importOriginal(
    original,
    mp4Probe,
    host.store,
    host.binding,
    new globalThis.AbortController().signal,
  );
  let rejected = '',
    removedName;
  const observation = { context: undefined };
  const AudioContext = globalThis.AudioContext;
  globalThis.AudioContext = class extends AudioContext {
    constructor(...args) {
      super(...args);
      observation.context = this;
    }
  };
  prototype.removeEntry = async function (name, ...args) {
    if (name.startsWith('video-pcm-')) {
      removedName = name;
      throw new globalThis.DOMException(
        'Injected scratch cleanup refusal',
        'NoModificationAllowedError',
      );
    }
    return remove.call(this, name, ...args);
  };
  try {
    if (mode === 'playback') {
      const native = host.binding.read(),
        source = native.content.sources[0];
      await playTimeline(
        {
          native,
          hash: await contentHash(native.content),
          originals: [
            { sourceId: source.id, bytes: original, plan: host.store.getPlan(source.id) },
          ],
        },
        time(0),
        globalThis.document.createElement('canvas'),
        new globalThis.AbortController().signal,
      );
    } else await host.job.run(new globalThis.AbortController().signal);
  } catch (e) {
    rejected = String(e);
  } finally {
    prototype.removeEntry = remove;
    globalThis.AudioContext = AudioContext;
  }
  let encoderRetained = false;
  try {
    encodingState();
    encoderRetained = true;
  } catch {
    /* no realm owner */
  }
  const after = {
    rejected,
    published: !!host.job.completed,
    video: videoStatus(),
    scratch: scratchStatus(),
    encoderRetained,
    ...(mode === 'playback' ? { audioContext: observation.context?.state } : {}),
  };
  let recovered = 0,
    recoveryError;
  try {
    const fresh = createProbeHost();
    await importOriginal(
      original,
      mp4Probe,
      fresh.store,
      fresh.binding,
      new globalThis.AbortController().signal,
    );
    const result = await fresh.job.run(new globalThis.AbortController().signal);
    recovered = result.bytes.size;
    await fresh.job.dispose();
  } catch (e) {
    recoveryError = String(e);
  }
  // Remove test residue explicitly. The production reservation intentionally stays
  // quarantined after an unproven cleanup; this test does not falsify that budget.
  if (removedName) {
    const root = await globalThis.navigator.storage.getDirectory();
    await root.removeEntry(removedName);
  }
  return { mode, after, recovered, recoveryError };
};
