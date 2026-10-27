import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { time, type VideoContentV3, type ImageSourceV3 } from '@editor-platform/video-core';
import { decodedFrameRealm } from '../host-media/indexed-media/frame-budget';
vi.mock('./image-source', () => ({
  inspectImageBytesV3(bytes: Uint8Array) {
    const size = bytes[0] ? 4096 : 1;
    return { mime: 'image/png', width: size, height: size, orientation: 1 };
  },
}));
import { createImageFramesV3 } from './image-frames.mjs';
it('evicts all replaced image caches before allocating a composition that fits the unchanged realm', async () => {
  // Stub native allocation only; use production frame owners and the actual ledger.
  // 17 real maximum-size native surfaces would obscure this ownership regression with memory load.
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const size = new Uint8Array(await blob.arrayBuffer())[0] ? 4096 : 1;
    return { width: size, height: size, close() {} };
  });
  const before = decodedFrameRealm.snapshot(),
    signal = new AbortController().signal;
  const owners: ReturnType<typeof createImageFramesV3>[] = [];
  const rows: { release(): void }[] = [];
  try {
    for (let i = 0; i < 17; i++) {
      const values = [i === 0 ? 0 : 1, i === 16 ? 0 : 1];
      const sources: ImageSourceV3[] = values.map((value, n) => {
        const sha256 = createHash('sha256').update(Uint8Array.of(value)).digest('hex'),
          size = value ? 4096 : 1;
        return {
          id: `${i}-${n}`,
          kind: 'image',
          asset: { assetId: sha256, sha256, byteLength: 1 },
          mime: 'image/png',
          width: size,
          height: size,
          orientation: 1,
        };
      });
      const content: VideoContentV3 = {
        schema: 'video-core-prototype-v3',
        sources,
        sequence: {
          id: 'sequence',
          duration: time(2),
          frameRate: time(25),
          tracks: [{ id: 'track', kind: 'visual', enabled: true, locked: false }],
          clips: sources.map((source, n) => ({
            id: 'clip' + n,
            kind: 'image',
            sourceId: source.id,
            trackId: 'track',
            start: time(n),
            duration: time(1),
            sourceIn: time(0),
            sourceOut: time(1),
            rate: time(1),
          })),
        },
      };
      owners.push(
        createImageFramesV3(
          content,
          sources.map((source, n) => ({
            sourceId: source.id,
            bytes: new Blob([Uint8Array.of(values[n])]),
          })),
          signal,
        ),
      );
    }
    for (const at of [time(0), time(1)]) {
      for (const owner of owners) owner.releaseInactive(at);
      expect(decodedFrameRealm.snapshot()).toEqual(before);
      for (const owner of owners) rows.push((await owner.frameAt(at, signal))!);
      expect(decodedFrameRealm.snapshot().pixels - before.pixels).toBe(16 * 4096 ** 2 + 1);
      for (const row of rows.splice(0)) row.release();
    }
  } finally {
    for (const row of rows) row.release();
    await Promise.all(owners.map((owner) => owner.dispose()));
    vi.unstubAllGlobals();
  }
  expect(decodedFrameRealm.snapshot()).toEqual(before);
});
