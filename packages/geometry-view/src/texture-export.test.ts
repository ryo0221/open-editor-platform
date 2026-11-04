import { describe, expect, it } from 'vitest';
import {
  flipGreenPixels,
  packMetallicRoughnessPixels,
  resizedPixels,
  viewTextureImageTools,
} from './texture-export';

const pixels = (...rgba: number[][]) => ({
  data: new Uint8ClampedArray(rgba.flat()),
  width: rgba.length,
  height: 1,
});

describe('GLB texture pixels (#663)', () => {
  it('packs roughness green and metalness blue, 255 where a map is missing', () => {
    const r = pixels([10, 20, 30, 40], [50, 60, 70, 80]);
    const m = pixels([1, 2, 3, 4], [5, 6, 7, 8]);
    expect(Array.from(packMetallicRoughnessPixels(r, m).data)).toEqual([
      ...[255, 20, 3, 255],
      ...[255, 60, 7, 255],
    ]);
    expect(Array.from(packMetallicRoughnessPixels(r, undefined).data)).toEqual([
      ...[255, 20, 255, 255],
      ...[255, 60, 255, 255],
    ]);
    expect(Array.from(packMetallicRoughnessPixels(undefined, m).data)).toEqual([
      ...[255, 255, 3, 255],
      ...[255, 255, 7, 255],
    ]);
  });
  it('flips a normal map’s green and keeps red and blue', () => {
    const n = pixels([128, 0, 255, 10], [10, 200, 30, 255]);
    expect(Array.from(flipGreenPixels(n).data)).toEqual([
      ...[128, 255, 255, 255],
      ...[10, 55, 30, 255],
    ]);
    expect(Array.from(n.data)).toEqual([128, 0, 255, 10, 10, 200, 30, 255]);
  });
  it('refuses an image over the limit from its header, before decoding it (Codex)', async () => {
    // A PNG signature and an IHDR of 4096 × 16 px: never decoded (no decoder here).
    const png = new Uint8Array(33);
    png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(png.buffer).setUint32(16, 4096);
    new DataView(png.buffer).setUint32(20, 16);
    const file = { bytes: png, mediaType: 'image/png' };
    await expect(viewTextureImageTools.flipNormalGreen(file)).rejects.toThrow('texture-image-size');
    await expect(viewTextureImageTools.packMetallicRoughness(undefined, file)).rejects.toThrow(
      'texture-image-size',
    );
  });
  it('scales by the nearest stored pixel, keeping values', () => {
    const two = pixels([10, 0, 0, 0], [20, 0, 0, 255]);
    expect(Array.from(resizedPixels(two, [4, 1]).data)).toEqual([
      ...[10, 0, 0, 0],
      ...[10, 0, 0, 0],
      ...[20, 0, 0, 255],
      ...[20, 0, 0, 255],
    ]);
  });
});
