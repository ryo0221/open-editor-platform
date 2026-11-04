import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { readTextureFiles } from './texture-files';

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
/** A JPEG header saying `px` × `px`, then `n` bytes of filler (distinct files, distinct n). */
const image = (n: number, px = 1024) =>
  new Uint8Array([
    ...[0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, px >> 8, px & 255, px >> 8, px & 255, 3, 0, 0, 0],
    ...bytes(n),
  ]);
/** The decoder's measure: what the header says (the header check runs first). */
const decoded: Uint8Array[] = [];
const measure = async (b: Uint8Array) => {
  decoded.push(b);
  return { width: (b[9]! << 8) | b[10]!, height: (b[7]! << 8) | b[8]! };
};

describe('reading downloaded texture files (#662)', () => {
  it('opens an ambientCG zip and gives each image its map', async () => {
    const zip = zipSync({
      'Bricks076C_1K-JPG_Color.jpg': image(10),
      'Bricks076C_1K-JPG_NormalGL.jpg': image(11),
      'Bricks076C_1K-JPG_NormalDX.jpg': image(12),
      'Bricks076C_1K-JPG_Roughness.jpg': image(13),
      'Bricks076C_1K-JPG_AmbientOcclusion.jpg': image(14),
      'Bricks076C_1K-JPG_Displacement.jpg': image(15),
      'Bricks076C_1K-JPG.usdc': bytes(16),
      'Bricks076C.png': image(17),
      '__MACOSX/._Bricks076C_1K-JPG_Color.jpg': image(18),
    });
    const read = await readTextureFiles([{ name: 'Bricks076C_1K-JPG.zip', bytes: zip }], measure);
    expect(read.name).toBe('Bricks076C');
    const by = Object.fromEntries(read.files.map((f) => [f.name, f]));
    expect(Object.keys(by).sort()).toEqual(
      [
        'Bricks076C.png',
        'Bricks076C_1K-JPG.usdc',
        'Bricks076C_1K-JPG_AmbientOcclusion.jpg',
        'Bricks076C_1K-JPG_Color.jpg',
        'Bricks076C_1K-JPG_Displacement.jpg',
        'Bricks076C_1K-JPG_NormalDX.jpg',
        'Bricks076C_1K-JPG_NormalGL.jpg',
        'Bricks076C_1K-JPG_Roughness.jpg',
      ].sort(),
    );
    expect(by['Bricks076C_1K-JPG_Color.jpg']).toMatchObject({
      role: 'color',
      mediaType: 'image/jpeg',
      width: 1024,
    });
    // The OpenGL normal map is kept; the DirectX one is the same map again.
    expect(by['Bricks076C_1K-JPG_NormalGL.jpg']).toMatchObject({ role: 'normal', normal: 'gl' });
    expect(by['Bricks076C_1K-JPG_NormalDX.jpg']).toMatchObject({ ignored: 'duplicate' });
    expect(by['Bricks076C_1K-JPG_NormalDX.jpg']!.role).toBeUndefined();
    expect(by['Bricks076C_1K-JPG_Roughness.jpg']!.role).toBe('roughness');
    expect(by['Bricks076C_1K-JPG_AmbientOcclusion.jpg']!.role).toBe('occlusion');
    expect(by['Bricks076C_1K-JPG_Displacement.jpg']).toMatchObject({ ignored: 'displacement' });
    expect(by['Bricks076C_1K-JPG.usdc']).toMatchObject({ ignored: 'not-image' });
    expect(by['Bricks076C.png']!.role).toBeUndefined();
  });

  it('refuses images over the limits or unreadable, and reads loose images', async () => {
    const read = await readTextureFiles(
      [
        { name: 'red_brick_diff_4k.jpg', bytes: image(1, 4096) },
        { name: 'red_brick_rough_1k.jpg', bytes: bytes(7) },
        { name: 'red_brick_nor_gl_1k.png', bytes: bytes(4 * 1024 * 1024 + 1) },
        { name: 'red_brick_ao_1k.jpg', bytes: image(20) },
      ],
      measure,
    );
    expect(read.files.map((f) => f.problem)).toEqual([
      'too-many-pixels',
      'unreadable',
      'too-large',
      undefined,
    ]);
    expect(read.files[3]!.role).toBe('occlusion');
    // The 4K image is refused from its header, never decoded (Codex).
    expect(read.files[0]).toMatchObject({ width: 4096, height: 4096 });
    expect(decoded.some((b) => b === read.files[0]!.bytes)).toBe(false);
    expect(read.name).toBe('red_brick_diff');
  });
});
