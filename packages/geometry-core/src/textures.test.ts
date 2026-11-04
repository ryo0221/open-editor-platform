import { describe, expect, it } from 'vitest';
import {
  geometryPlanarTextureUv,
  geometryTextureImageSize,
  geometryTextureFileRole,
  geometryTextureMediaType,
} from './textures';

describe('texture files (#662)', () => {
  it('reads the map of ambientCG and Poly Haven file names', () => {
    expect(geometryTextureFileRole('Bricks076C_1K-JPG_Color.jpg')).toEqual({ role: 'color' });
    expect(geometryTextureFileRole('Bricks076C_1K-JPG/Bricks076C_1K-JPG_NormalGL.jpg')).toEqual({
      role: 'normal',
      normal: 'gl',
    });
    expect(geometryTextureFileRole('Bricks076C_1K-JPG_NormalDX.jpg')).toEqual({
      role: 'normal',
      normal: 'dx',
    });
    expect(geometryTextureFileRole('Bricks076C_1K-JPG_Roughness.jpg')).toEqual({
      role: 'roughness',
    });
    expect(geometryTextureFileRole('Metal032_2K-PNG_Metalness.png')).toEqual({
      role: 'metalness',
    });
    expect(geometryTextureFileRole('Bricks076C_1K-JPG_AmbientOcclusion.jpg')).toEqual({
      role: 'occlusion',
    });
    expect(geometryTextureFileRole('Bricks076C_1K-JPG_Displacement.jpg')).toEqual({
      ignored: 'displacement',
    });
    expect(geometryTextureFileRole('red_brick_diff_1k.jpg')).toEqual({ role: 'color' });
    expect(geometryTextureFileRole('red_brick_nor_gl_1k.png')).toEqual({
      role: 'normal',
      normal: 'gl',
    });
    expect(geometryTextureFileRole('red_brick_rough_1k.jpg')).toEqual({ role: 'roughness' });
    expect(geometryTextureFileRole('red_brick_ao_1k.jpg')).toEqual({ role: 'occlusion' });
    expect(geometryTextureFileRole('red_brick_arm_1k.jpg')).toEqual({ ignored: 'other' });
    expect(geometryTextureFileRole('Bricks076C.png')).toBeUndefined();
    expect(geometryTextureMediaType('a.JPG')).toBe('image/jpeg');
    expect(geometryTextureMediaType('a.png')).toBe('image/png');
    expect(geometryTextureMediaType('a.exr')).toBeUndefined();
  });

  it('reads a PNG or JPEG size from its header without decoding (Codex)', () => {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(png.buffer).setUint32(16, 1024);
    new DataView(png.buffer).setUint32(20, 512);
    expect(geometryTextureImageSize(png)).toEqual([1024, 512]);
    // SOI, an APP0 segment, then SOF0: precision, height 300, width 400.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 44, 1, 144, 3, 0, 0, 0,
    ]);
    expect(geometryTextureImageSize(jpeg)).toEqual([400, 300]);
    // DHT (0xc4) is not a frame.
    const dht = new Uint8Array([0xff, 0xd8, 0xff, 0xc4, 0, 2, 0xff, 0xc2, 0, 11, 8, 0, 10, 0, 20]);
    expect(geometryTextureImageSize(dht)).toEqual([20, 10]);
    expect(geometryTextureImageSize(png.subarray(0, 20))).toBeUndefined();
    expect(
      geometryTextureImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])),
    ).toBeUndefined();
    expect(geometryTextureImageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('gives a planar face real-size coordinates anchored to the model axes', () => {
    // A floor seen from above: x right, y up.
    expect(geometryPlanarTextureUv([120, 30, 0], [0, 0, 1])).toEqual([120, 30]);
    // A soffit seen from below is not mirrored.
    expect(geometryPlanarTextureUv([120, 30, 0], [0, 0, -1])).toEqual([-120, 30]);
    // A wall facing −y: x right, z up.
    const [u, v] = geometryPlanarTextureUv([500, 0, 2000], [0, -1, 0]);
    expect(u).toBeCloseTo(500);
    expect(v).toBeCloseTo(2000);
    // A wall facing +x: y right, z up.
    const [u2, v2] = geometryPlanarTextureUv([0, 400, 300], [1, 0, 0]);
    expect(u2).toBeCloseTo(400);
    expect(v2).toBeCloseTo(300);
    // A shallow roof (normal within 25° of z) keeps its real size along the slope.
    const shallow = [0, -Math.sqrt(0.19), 0.9] as const;
    const p0 = geometryPlanarTextureUv([0, 0, 0], shallow);
    // 1000 mm up the slope: along y by 0.9 × 1000 and z by √0.19 × 1000.
    const p1 = geometryPlanarTextureUv([0, 900, Math.sqrt(0.19) * 1000], shallow);
    expect(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])).toBeCloseTo(1000, 6);
    // One mm along the face is one mm of texture, on a sloped roof too.
    const n = [0, -Math.SQRT1_2, Math.SQRT1_2] as const;
    const a = geometryPlanarTextureUv([0, 0, 0], n);
    const b = geometryPlanarTextureUv([0, 100, 100], n);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(Math.hypot(100, 100));
  });
});
