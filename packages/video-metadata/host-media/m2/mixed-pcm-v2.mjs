/** Private original-owning multi-source PCM adapter. */
import { assertVideoContentV2 } from '@editor-platform/video-core';
import { prepareMixV2 } from './mix-v2';
import { verifyOriginal } from './verify-original-v2.mjs';
import { createPcmFile } from '../indexed-media/pcm-file.mjs';
import { selectedPcmSession } from '../../../video-core/experiments/pcm-wasm-v1/selection';
import { sourcePort } from '../../../video-core/experiments/pcm-wasm-m2/source-port';
import {
  ConsumerOwner,
  m2PcmDiagnostics,
} from '../../../video-core/experiments/pcm-wasm-m2/owners';
const need = (ok, msg) => {
  if (!ok) throw Error(msg);
};
export async function createMixedPcmV2(content, originals, caller) {
  assertVideoContentV2(content);
  caller.throwIfAborted();
  const owned = globalThis.structuredClone(content),
    files = new Map(originals),
    stop = new globalThis.AbortController(),
    signal = globalThis.AbortSignal.any([caller, stop.signal]),
    prepareOwner = new ConsumerOwner('source-preparation', 288 * 1024),
    mixOwner = new ConsumerOwner('mix', 64 * 1024),
    owners = [],
    bySource = new Map(),
    pending = new Set();
  let closing,
    closed = false;
  async function dispose() {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve().then(async () => {
      stop.abort();
      await Promise.allSettled([...pending]);
      const failures = [];
      for (const owner of owners) {
        for (const action of [
          () => (owner.port ? owner.port.dispose() : owner.renderer?.dispose()),
          () => owner.lease?.release(),
          () => owner.index.dispose(),
        ]) {
          try {
            await action();
          } catch (e) {
            failures.push(e);
          }
        }
      }
      prepareOwner.close();
      mixOwner.close();
      if (failures.length) throw new AggregateError(failures, 'V2 PCM cleanup failed');
    });
    return closing;
  }
  try {
    const enabled = new Set(owned.sequence.tracks.filter((t) => t.enabled).map((t) => t.id));
    const needed = new Set(
      owned.sequence.clips
        .filter((c) => c.kind === 'audio' && enabled.has(c.trackId))
        .map((c) => c.sourceId),
    );
    const deduplicated = new Map();
    for (const source of owned.sources.filter((s) => needed.has(s.id))) {
      signal.throwIfAborted();
      const bytes = files.get(source.asset.sha256),
        profile = await verifyOriginal(source, bytes, signal),
        audio = source.streams.find((s) => s.kind === 'audio'),
        key = source.asset.sha256 + ':' + audio.id;
      let owner = deduplicated.get(key);
      if (!owner) {
        // Bound existing PCM callback planes and queued writes during preflight.
        // 256KiB queue + one pre-admission16KiB interleaved +16KiB planar copy.
        const releasePrepare = prepareOwner.reserve(288 * 1024, 'decode-write-overlap');
        let index;
        try {
          index = await createPcmFile(
            bytes,
            signal,
            {
              originalHash: source.asset.sha256,
              streamId: audio.id,
              decodePolicy: 'native-aac-continuous-v1',
            },
            profile,
          );
        } finally {
          releasePrepare();
        }
        // Acquired index remains owned even if the following lease/renderer setup fails.
        owner = { index, lease: undefined, renderer: undefined };
        owners.push(owner);
        owner.lease = index.acquire();
        owner.renderer = await selectedPcmSession(owner.lease, 'edge-hold-v0', signal);
        owner.port = sourcePort(owner.renderer);
        deduplicated.set(key, owner);
      }
      bySource.set(source.id, owner);
    }
    signal.throwIfAborted();
    const mixer = prepareMixV2(
      owned,
      async (request, call) => {
        const owner = bySource.get(request.sourceId);
        need(owner, 'Missing v2 audio owner');
        // The old JS renderer's per-sample mono f64 accumulator is also managed.
        const releaseSums = mixOwner.reserve(8, 'source-js-accumulator');
        try {
          return await owner.port.render(request, call);
        } finally {
          releaseSums();
        }
      },
      mixOwner,
    );
    return {
      evidence: owners.map((o) => ({
        ...o.index.evidence,
        identity: o.index.identity,
        get backend() {
          return o.renderer.diagnostics();
        },
      })),
      diagnostics: m2PcmDiagnostics,
      render(first, end, call) {
        if (closed) return Promise.reject(Error('V2 PCM disposed'));
        if (pending.size) return Promise.reject(Error('V2 PCM render admission'));
        const combined = globalThis.AbortSignal.any([signal, call]);
        const job = mixer.render(first, end, combined);
        pending.add(job);
        job.then(
          () => pending.delete(job),
          () => pending.delete(job),
        );
        return job;
      },
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'V2 PCM preparation/cleanup failed');
    }
    throw error;
  }
}
