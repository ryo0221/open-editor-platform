import { BoxGeometry, Group, Mesh, MeshStandardMaterial, SRGBColorSpace, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  disposeViewTextures,
  setViewTextures,
  ViewTextureCache,
  viewTextureBytes,
} from './textures';
import { instancesBytes, instancesGroup } from './instances';

const image = (width: number, height: number) => new Texture({ width, height } as never);

describe('image textures (#662)', () => {
  it('repeats each map at its real size and flips a DirectX normal map', () => {
    const color = image(1024, 1024);
    const normal = image(1024, 1024);
    const material = setViewTextures(new MeshStandardMaterial(), {
      maps: { color, normal },
      sizeMm: [2000, 1000],
      rotationRad: Math.PI / 2,
      normal: 'dx',
    });
    expect(material.map?.source).toBe(color.source);
    expect(material.map).not.toBe(color);
    expect(material.map?.repeat.toArray()).toEqual([1 / 2000, 1 / 1000]);
    expect(material.map?.rotation).toBeCloseTo(Math.PI / 2);
    expect(material.map?.colorSpace).toBe(SRGBColorSpace);
    expect(material.normalMap?.colorSpace).not.toBe(SRGBColorSpace);
    expect(material.normalScale.toArray()).toEqual([1, -1]);
    expect(material.roughnessMap).toBeNull();
    // Each image counts once, with its mipmaps.
    const seen = new Set();
    expect(viewTextureBytes(material, seen)).toBe(2 * Math.ceil((1024 * 1024 * 16) / 3));
    expect(viewTextureBytes(material.clone(), seen)).toBe(0);
    // Taken off: the copies are disposed, the decoded images are not.
    const copy = material.map!;
    const disposed = vi.fn();
    copy.addEventListener('dispose', disposed);
    const original = vi.fn();
    color.addEventListener('dispose', original);
    setViewTextures(material, undefined);
    expect(material.map).toBeNull();
    expect(disposed).toHaveBeenCalledOnce();
    expect(original).not.toHaveBeenCalled();
  });

  it('counts the maps of instanced solids in their GPU bytes', () => {
    const material = setViewTextures(new MeshStandardMaterial(), {
      maps: { color: image(512, 256) },
      sizeMm: [1000, 1000],
    });
    const group = new Group().add(new Mesh(new BoxGeometry(), material));
    const plain = instancesBytes(new Group().add(new Mesh(new BoxGeometry())));
    expect(instancesBytes(group) - plain).toBe(Math.ceil((512 * 256 * 16) / 3));
    disposeViewTextures(material);
  });

  /** The start of a PNG: signature and IHDR with its size, enough for the header check. */
  const pngHead = (w: number, h: number) => {
    const b = new Uint8Array(33);
    b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };

  it('decodes each image once and calls back when it is ready', async () => {
    const decode = vi.fn(async () => ({ width: 4, height: 4 }));
    const onLoad = vi.fn();
    const cache = new ViewTextureCache(onLoad, decode);
    const read = () => ({ bytes: pngHead(4, 4), mediaType: 'image/png' });
    expect(cache.get('sha256:a', read)).toBeUndefined();
    expect(cache.get('sha256:a', read)).toBeUndefined();
    expect(cache.get('sha256:missing', () => undefined)).toBeUndefined();
    await cache.settled();
    expect(decode).toHaveBeenCalledOnce();
    expect(onLoad).toHaveBeenCalledOnce();
    expect(cache.get('sha256:a', read)?.image).toEqual({ width: 4, height: 4 });
    expect(cache.failed('sha256:missing')).toBe(true);
    const bad = new ViewTextureCache(onLoad, async () => {
      throw new Error('not an image');
    });
    bad.get('sha256:b', read);
    await bad.settled();
    expect(bad.failed('sha256:b')).toBe(true);
    cache.dispose();
  });

  it('refuses an image over 2048 px from its header, before decoding it (Codex)', async () => {
    const decode = vi.fn(async () => ({ width: 4096, height: 4096 }));
    const cache = new ViewTextureCache(() => {}, decode);
    cache.get('sha256:big', () => ({ bytes: pngHead(4096, 16), mediaType: 'image/png' }));
    cache.get('sha256:junk', () => ({ bytes: new Uint8Array([1, 2]), mediaType: 'image/png' }));
    expect(decode).not.toHaveBeenCalled();
    expect(cache.failed('sha256:big')).toBe(true);
    expect(cache.failed('sha256:junk')).toBe(true);
    // A header that understates the size: the decoded image is checked and closed.
    const close = vi.fn();
    const liar = new ViewTextureCache(
      () => {},
      async () => ({ width: 4096, height: 4096, close }),
    );
    liar.get('sha256:liar', () => ({ bytes: pngHead(16, 16), mediaType: 'image/png' }));
    await liar.settled();
    expect(liar.failed('sha256:liar')).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('frees the images a build no longer asks for (Codex)', async () => {
    const closed: string[] = [];
    const cache = new ViewTextureCache(
      () => {},
      async (bytes) => ({ width: 4, height: 4, close: () => closed.push(String(bytes[16 + 3])) }),
    );
    const read = (n: number) => () => ({ bytes: pngHead(n, 4), mediaType: 'image/png' });
    cache.get('sha256:1', read(1));
    cache.get('sha256:2', read(2));
    await cache.settled();
    cache.sweep();
    expect(cache.size).toBe(2);
    // The next build draws only the second image (the first was replaced).
    cache.get('sha256:2', read(2));
    cache.sweep();
    expect(cache.size).toBe(1);
    expect(closed).toEqual(['1']);
    // The build after draws only a third: the second is freed, and the third, swept while it
    // decodes, is closed when it arrives.
    cache.get('sha256:3', read(3));
    cache.sweep();
    cache.sweep();
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toEqual(['1', '2', '3']);
    expect(cache.size).toBe(0);
    cache.dispose();
  });

  it('draws a mesh made without texture coordinates without its maps', () => {
    const mesh = {
      origin: [0, 0, 0] as [number, number, number],
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const textures = { maps: { color: image(4, 4) }, sizeMm: [10, 10] as [number, number] };
    const maps = (uvs?: Float32Array) => {
      const group = instancesGroup([
        {
          meshes: [
            {
              mesh: { ...mesh, ...(uvs ? { uvs } : {}) },
              color: '#ffffff',
              opacity: 1,
              sheet: false,
              textures,
            },
          ],
          bounds: [
            [0, 0, 0],
            [1, 1, 0],
          ],
          instances: [
            {
              path: ['a'],
              matrix: new Array(16).fill(0).map((_, i) => (i % 5 ? 0 : 1)),
              selected: false,
            },
          ],
        },
      ]);
      const found: unknown[] = [];
      group.traverse((o) => {
        const m = (o as Mesh).material as MeshStandardMaterial | undefined;
        if (m?.isMeshStandardMaterial) found.push(m.map);
      });
      return found;
    };
    expect(maps()).toEqual([null]);
    expect(maps(new Float32Array(6))[0]).not.toBeNull();
  });
});
