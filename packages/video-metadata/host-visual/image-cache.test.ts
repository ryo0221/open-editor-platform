import { expect, it, vi } from 'vitest';
import { time, add, multiply } from '@editor-platform/video-core';
import { v2Fixture } from '../file-backed-storage/portable/v2-fixture';
import { scan } from '../file-backed-storage/io';
import { decodedFrameRealm } from '../host-media/indexed-media/frame-budget';
vi.mock('../host-media/m2/verify-original-v2.mjs', () => ({
  verifyOriginal: async () => 'iphone-sdr-v1',
}));
vi.mock('../host-media/indexed-media/video-window.mjs', async () => {
  const { decodedFrameRealm, FRAME_SESSION_CAPACITY } = await import(
    '../host-media/indexed-media/frame-budget'
  );
  return {
    createVideoWindow: async () => {
      const budget = decodedFrameRealm.session(FRAME_SESSION_CAPACITY);
      let cache: { release(): void } | undefined;
      let cachedSecond = -1;
      return {
        clock: { scale: 25 },
        rotation: 0,
        frameAt: async (raw: { value: number; timescale: number }) => {
          cachedSecond = Math.floor(raw.value / raw.timescale);
          const count = cachedSecond === 0 ? 64 : 1;
          cache ??= budget.reserve({ pixels: 1920 * 1112 * count, bytes: 1920 * 1112 * count * 4 });
          return { frame: {}, release() {} };
        },
        releaseCachedFrames(times: { value: number; timescale: number }[] = []) {
          if (
            times.length &&
            times.every((raw) => Math.floor(raw.value / raw.timescale) === cachedSecond)
          )
            return;
          cache?.release();
          cache = undefined;
        },
        async dispose() {
          cache?.release();
          budget.close();
        },
      };
    },
  };
});
import { createVisualV2 } from '../host-media/m2/visual-v2.mjs';
it('releases inactive 64-frame source caches before an admitted 4096-square image reservation', async () => {
  const content = structuredClone((await v2Fixture(scan)).versions[0].content);
  const source = content.sources.find((s) => s.streams.some((x) => x.kind === 'video'))!;
  const clip = content.sequence.clips.find((c) => c.kind === 'video')!;
  delete clip.linkGroupId;
  clip.start = time(0);
  clip.duration = time(2);
  clip.sourceOut = add(clip.sourceIn, multiply(clip.duration, clip.rate));
  content.sources = [source, { ...structuredClone(source), id: 'second-source' }];
  content.sequence.clips = [
    clip,
    { ...structuredClone(clip), id: 'second-clip', sourceId: 'second-source', start: time(2) },
  ];
  content.sequence.duration = time(5);
  const owner = await createVisualV2(content, new Map(), new AbortController().signal);
  const before = decodedFrameRealm.snapshot();
  try {
    (await owner.frameAt(time(0), new AbortController().signal))!.release();
    (await owner.frameAt(time(2), new AbortController().signal))!.release();
    expect(decodedFrameRealm.snapshot().pixels - before.pixels).toBe(1920 * 1112 * 64);
    expect(await owner.frameAt(time(4), new AbortController().signal)).toBeNull();
    expect(decodedFrameRealm.snapshot()).toEqual(before);
    const image = decodedFrameRealm.session({ pixels: 4096 ** 2, bytes: 4096 ** 2 * 4 });
    const reservation = image.reserve({ pixels: 4096 ** 2, bytes: 4096 ** 2 * 4 });
    reservation.release();
    image.close();
    // Returning to a released source may decode again; it is not treated as a stale cache hit.
    (await owner.frameAt(time(0), new AbortController().signal))!.release();
  } finally {
    await owner.dispose();
  }
  expect(decodedFrameRealm.snapshot()).toEqual(before);
});

it('evicts obsolete GOPs of still-active sources before image allocation', async () => {
  const content = structuredClone((await v2Fixture(scan)).versions[0].content);
  const source = content.sources.find((s) => s.streams.some((x) => x.kind === 'video'))!;
  const clip = content.sequence.clips.find((c) => c.kind === 'video')!;
  delete clip.linkGroupId;
  clip.start = time(0);
  clip.sourceIn = time(0);
  clip.duration = time(2);
  clip.sourceOut = multiply(clip.duration, clip.rate);
  content.sources = [source, { ...structuredClone(source), id: 'second-source' }];
  content.sequence.tracks.push({ id: 'overlay', kind: 'visual', enabled: true, locked: false });
  content.sequence.clips = [
    clip,
    { ...structuredClone(clip), id: 'second-clip', sourceId: 'second-source', trackId: 'overlay' },
  ];
  content.sequence.duration = time(2);
  const before = decodedFrameRealm.snapshot();
  const signal = new AbortController().signal;
  const owner = await createVisualV2(content, new Map(), signal);
  const image = decodedFrameRealm.session({ pixels: 4096 ** 2, bytes: 4096 ** 2 * 4 });
  let reservation: { release(): void } | undefined;
  try {
    for (const row of await owner.framesAt(time(0), signal)) row.release();
    expect(decodedFrameRealm.snapshot().pixels - before.pixels).toBe(2 * 64 * 1920 * 1112);
    owner.releaseInactive(time(0));
    expect(decodedFrameRealm.snapshot().pixels - before.pixels).toBe(2 * 64 * 1920 * 1112);
    owner.releaseInactive(time(1));
    expect(decodedFrameRealm.snapshot().pixels).toBe(before.pixels);
    reservation = image.reserve({ pixels: 4096 ** 2, bytes: 4096 ** 2 * 4 });
    for (const row of await owner.framesAt(time(1), signal)) row.release();
    expect(decodedFrameRealm.snapshot().pixels - before.pixels).toBe(4096 ** 2 + 2 * 1920 * 1112);
  } finally {
    reservation?.release();
    image.close();
    await owner.dispose();
  }
  expect(decodedFrameRealm.snapshot()).toEqual(before);
});
