/** Private frame selection shared by preview/export; no canvas fitting policy. */
import { assertVideoContentV2 } from '@editor-platform/video-core';
import { prepareSourceRequests } from './requests';
import { verifyOriginal } from './verify-original-v2.mjs';
import { createVideoWindow } from '../indexed-media/video-window.mjs';
export async function createVisualV2(content, originals, caller) {
  assertVideoContentV2(content);
  caller.throwIfAborted();
  const owned = globalThis.structuredClone(content),
    files = new Map(originals);
  const timing = {
    ...owned,
    schema: 'video-core-prototype-v1',
    sequence: {
      ...owned.sequence,
      clips: owned.sequence.clips.map((c) => {
        if (c.kind === 'video') return c;
        const { gain, fade, ...base } = c;
        void gain;
        void fade;
        return base;
      }),
    },
  };
  const requests = prepareSourceRequests(timing),
    stop = new globalThis.AbortController(),
    signal = globalThis.AbortSignal.any([caller, stop.signal]),
    owners = new Map(),
    pending = new Set();
  const enabled = new Set(owned.sequence.tracks.filter((t) => t.enabled).map((t) => t.id));
  const needed = new Set(
    owned.sequence.clips
      .filter((c) => c.kind === 'video' && enabled.has(c.trackId))
      .map((c) => c.sourceId),
  );
  // Existing reader realm allows two readers. No new admission or compositing policy.
  if (needed.size > 2) throw Error('V2 visual source admission');
  let closed = false,
    closing;
  const dispose = () => {
    if (closing) return closing;
    closed = true;
    stop.abort();
    return (closing = (async () => {
      await Promise.allSettled([...pending]);
      const done = await Promise.allSettled([...owners.values()].map((o) => o.dispose()));
      const errors = done.filter((r) => r.status === 'rejected').map((r) => r.reason);
      if (errors.length) throw new AggregateError(errors, 'V2 visual cleanup failed');
    })());
  };
  try {
    for (const source of owned.sources.filter((s) => needed.has(s.id))) {
      const bytes = files.get(source.asset.sha256);
      if ((await verifyOriginal(source, bytes, signal)) !== 'iphone-sdr-v1')
        throw Error('V2 visual profile');
      const owner = await createVideoWindow(bytes, signal, 'iphone-sdr-v1');
      owners.set(source.id, owner);
    }
    signal.throwIfAborted();
    return {
      frameAt(at, call) {
        if (closed || pending.size) return Promise.reject(Error('V2 visual request admission'));
        const combined = globalThis.AbortSignal.any([signal, call]);
        const job = (async () => {
          combined.throwIfAborted();
          const rows = requests.videoAt(at);
          if (rows.length > 1) throw Error('V2 visual overlap unsupported');
          if (!rows.length) return null;
          const request = rows[0],
            owner = owners.get(request.sourceId);
          if (!owner) throw Error('V2 visual owner missing');
          const row = await owner.frameAt(request.rawTime, combined);
          try {
            combined.throwIfAborted();
            return {
              ...row,
              sourceId: request.sourceId,
              clipId: request.clipId,
              sourceTime: request.sourceTime,
              rawTime: request.rawTime,
              rotation: owner.rotation,
              scale: owner.clock.scale,
            };
          } catch (e) {
            row.release();
            throw e;
          }
        })();
        pending.add(job);
        job.then(
          () => pending.delete(job),
          () => pending.delete(job),
        );
        return job;
      },
      dispose,
    };
  } catch (e) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([e, cleanup], 'V2 visual preparation/cleanup failed');
    }
    throw e;
  }
}
