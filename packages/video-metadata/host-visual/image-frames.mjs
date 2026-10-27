import { add, compare } from '@editor-platform/video-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { decodedFrameRealm } from '../host-media/indexed-media/frame-budget';
import { inspectImageBytesV3 } from './image-source';
/** One bounded still decoder, shared by normal preview/play/export; owns every bitmap/frame. */
export function createImageFramesV3(content, originals, caller) {
  const clips = content.sequence.clips.filter((c) => c.kind === 'image');
  const stop = new globalThis.AbortController();
  const budget = decodedFrameRealm.session({ pixels: 32 * 1024 * 1024, bytes: 128 * 1024 * 1024 });
  let loaded,
    outstanding,
    pending,
    closed = false,
    closing;
  function drop() {
    loaded?.bitmap.close();
    loaded?.reservation.release();
    loaded = undefined;
  }
  function activeAt(at, active) {
    return clips.filter(
      (c) =>
        content.sequence.tracks.find((t) => t.id === c.trackId).enabled &&
        (active
          ? active.has(c.id)
          : compare(at, c.start) >= 0 && compare(at, add(c.start, c.duration)) < 0),
    );
  }
  function releaseInactive(at, active) {
    if (closed || pending || outstanding) throw Error('Image frame owner busy or closed');
    const next = activeAt(at, active);
    if (next.length > 1) throw Error('Multiple image clips require compositing');
    if (!next.length || loaded?.id !== next[0].sourceId) drop();
  }
  async function frameAt(at, call, selected) {
    if (closed || pending || outstanding) throw Error('Image frame owner busy or closed');
    const signal = globalThis.AbortSignal.any([caller, call, stop.signal]);
    const job = (async () => {
      signal.throwIfAborted();
      const active = activeAt(at, selected);
      if (active.length > 1) throw Error('Multiple image clips require compositing');
      if (!active.length) {
        drop();
        return null;
      }
      const clip = active[0],
        source = content.sources.find((s) => s.id === clip.sourceId);
      const original = originals.find((o) => o.sourceId === source.id);
      if (!original) throw Error('Image original unavailable');
      if (loaded?.id !== source.id) {
        drop();
        if (original.bytes.size > 16 * 1024 * 1024) throw Error('Image exceeds 16 MiB');
        const bytes = new Uint8Array(await original.bytes.arrayBuffer());
        signal.throwIfAborted();
        const plan = inspectImageBytesV3(bytes);
        if (
          bytes.length !== source.asset.byteLength ||
          bytesToHex(sha256(bytes)) !== source.asset.sha256 ||
          ['mime', 'width', 'height', 'orientation'].some((k) => plan[k] !== source[k])
        )
          throw Error('Image original/interpretation mismatch');
        const pixels = source.width * source.height;
        const reservation = budget.reserve({ pixels, bytes: pixels * 4 });
        let bitmap;
        try {
          bitmap = await globalThis.createImageBitmap(original.bytes, {
            imageOrientation: 'from-image',
          });
          signal.throwIfAborted();
          const swap = source.orientation >= 5;
          if (
            bitmap.width !== (swap ? source.height : source.width) ||
            bitmap.height !== (swap ? source.width : source.height)
          )
            throw Error('Image decode dimensions/orientation differ');
          loaded = { id: source.id, bitmap, reservation };
        } catch (error) {
          bitmap?.close();
          reservation.release();
          throw error;
        }
      }
      // Drawing the owned bitmap avoids an unnecessary ImageBitmap -> VideoFrame
      // conversion (Chromium can premultiply alpha again on that conversion).
      // One outstanding lease prevents cache replacement until the draw completes.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        outstanding = undefined;
      };
      outstanding = release;
      return {
        frame: loaded.bitmap,
        rotation: 0,
        sourceId: source.id,
        clipId: clip.id,
        pts: 0,
        scale: 1,
        release,
      };
    })();
    pending = job;
    try {
      return await job;
    } finally {
      pending = undefined;
    }
  }
  return {
    releaseInactive,
    frameAt,
    dispose() {
      return (closing ??= (async () => {
        closed = true;
        stop.abort();
        await pending?.catch(() => {});
        outstanding?.();
        drop();
        budget.close();
      })());
    },
  };
}
