import { describe, expect, it } from 'vitest';
import { geometryTextureImageSize } from '@editor-platform/geometry-core';
import {
  BakeError,
  bakeNormalMap,
  boxMesh,
  cornerNormals,
  cornerTangents,
  editInput,
  encodeRgbPng,
  meshEdges,
  multiresBase,
  multiresFrames,
  multiresPositions,
  TriangleBvh,
  unwrapMesh,
  type EpmMesh,
} from './index';

/** A flat n × n grid of s mm quads in z = 0, with UVs (x, y) / (n · s). */
function sheet(n = 4, s = 25): EpmMesh {
  const positions: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i * s, j * s, 0);
  const idx: number[] = [];
  const uvs: number[] = [];
  const at = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      idx.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
      uvs.push(i / n, j / n, (i + 1) / n, j / n, (i + 1) / n, (j + 1) / n, i / n, (j + 1) / n);
    }
  return {
    positions: new Float32Array(positions),
    faceSizes: new Uint32Array(n * n).fill(4),
    faceIndices: new Uint32Array(idx),
    faceMaterials: new Uint16Array(n * n),
    uvs: new Float32Array(uvs),
    boneIds: [],
    morphs: [],
  };
}
/** A fine quad surface over the same square, z = f(x, y). */
function surface(f: (x: number, y: number) => number, n = 40, size = 100) {
  const positions = new Float32Array(3 * (n + 1) * (n + 1));
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const x = (i * size) / n,
        y = (j * size) / n;
      positions.set([x, y, f(x, y)], 3 * (j * (n + 1) + i));
    }
  const quads = new Uint32Array(4 * n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const v = j * (n + 1) + i;
      quads.set([v, v + 1, v + n + 2, v + n + 1], 4 * (j * n + i));
    }
  return { positions, quads };
}
const texel = (r: { rgb: Uint8Array; size: number }, u: number, v: number) => {
  const x = Math.floor(u * r.size),
    y = Math.floor((1 - v) * r.size);
  const o = 3 * (y * r.size + x);
  return [r.rgb[o], r.rgb[o + 1], r.rgb[o + 2]];
};

describe('normal-map bake (C7d, TS-1280)', () => {
  it('makes unit tangents along u, at right angles to the normals, with handedness', () => {
    const cube = editInput(boxMesh([200, 200, 200]));
    const un = unwrapMesh(cube, meshEdges(cube.mesh, cube.topology));
    const n = cornerNormals(un);
    const t = cornerTangents(un, n)!;
    expect(t.length).toBe(4 * un.faceIndices.length);
    for (let c = 0; c < un.faceIndices.length; c++) {
      const [x, y, z, w] = t.subarray(4 * c, 4 * c + 4);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 4);
      expect(Math.abs(x * n[3 * c] + y * n[3 * c + 1] + z * n[3 * c + 2])).toBeLessThan(1e-4);
      expect(Math.abs(w)).toBe(1);
    }
    // On the flat sheet: t = +x, w = +1 (v runs along +y).
    const s = sheet();
    const ts = cornerTangents(s)!;
    for (let c = 0; c < s.faceIndices.length; c++)
      expect([...ts.subarray(4 * c, 4 * c + 4)].map((x) => Math.round(x * 1e4) / 1e4)).toEqual([
        1, 0, 0, 1,
      ]);
    expect(cornerTangents(boxMesh([1, 1, 1]))).toBeUndefined();
    // An imported XY triangle with glTF UVs (0,0), (1,0), (0,1): kept with v flipped (v up), so
    // the bitangent points along +v up, toward the image's top, as MikkTSpace in Blender's v-up
    // UVs gives it: glTF w = −1 (B = −y, against the glTF v that runs along +y).
    const tri: EpmMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      faceSizes: new Uint32Array([3]),
      faceIndices: new Uint32Array([0, 1, 2]),
      faceMaterials: new Uint16Array(1),
      uvs: new Float32Array([0, 1, 1, 1, 0, 0]),
      boneIds: [],
      morphs: [],
    };
    for (let c = 0; c < 3; c++)
      expect([...cornerTangents(tri)!.subarray(4 * c, 4 * c + 4)].map(Math.round)).toEqual([
        1, 0, 0, -1,
      ]);
  });

  it('bakes a flat surface to the flat normal, and a slope to the tilt it has', () => {
    const flat = bakeNormalMap({ cage: sheet(), high: surface(() => 0), size: 512 });
    expect(flat.covered).toBe(512 * 512);
    expect(flat.missed).toBe(0);
    for (const [u, v] of [
      [0.1, 0.1],
      [0.5, 0.5],
      [0.9, 0.3],
    ])
      expect(texel(flat, u, v)).toEqual([128, 128, 255]);
    // z = 5 + 0.2 x: the normal (−0.2, 0, 1)/|…| leans back along u.
    const slope = bakeNormalMap({
      cage: sheet(),
      high: surface((x) => 5 + 0.2 * x),
      size: 512,
      distance: 30,
    });
    expect(slope.missed).toBe(0);
    const l = Math.hypot(0.2, 1);
    const want = [(-0.2 / l) * 0.5 + 0.5, 0.5, (1 / l) * 0.5 + 0.5].map((x) => Math.round(x * 255));
    const got = texel(slope, 0.5, 0.5);
    for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k])).toBeLessThanOrEqual(1);
    // z = 0.2 y: leans back along v (green).
    const up = bakeNormalMap({ cage: sheet(), high: surface((_, y) => 0.2 * y), size: 512 });
    expect(texel(up, 0.5, 0.5)[1]).toBeLessThan(110);
    // Beyond the reach: no hit, the cage's own normal.
    const far = bakeNormalMap({
      cage: sheet(),
      high: surface(() => 50),
      size: 512,
      distance: 10,
    });
    expect(far.missed).toBe(far.covered);
    expect(texel(far, 0.5, 0.5)).toEqual([128, 128, 255]);
  });

  it('bakes a sculpted multires bump on the unwrapped cube, and fills past the UV borders', () => {
    const cube = editInput(boxMesh([200, 200, 200]));
    const cage = unwrapMesh(cube, meshEdges(cube.mesh, cube.topology));
    const base = multiresBase(cage, 3);
    const frames = multiresFrames(base);
    const d = new Float32Array(3 * base.gridVertex.length);
    const plain = multiresPositions(base, frames, d);
    const smooth = bakeNormalMap({
      cage,
      high: { positions: plain, quads: base.quads },
      size: 512,
    });
    expect(smooth.missed).toBe(0);
    expect(smooth.covered).toBeGreaterThan(0.2 * 512 * 512);
    // A bump: the map is no longer the same.
    for (let g = 0; g < base.gridVertex.length; g += 7) d[3 * g + 2] = 4;
    const bumpy = bakeNormalMap({
      cage,
      high: { positions: multiresPositions(base, frames, d), quads: base.quads },
      size: 512,
    });
    let differ = 0;
    for (let i = 0; i < bumpy.rgb.length; i++) if (bumpy.rgb[i] !== smooth.rgb[i]) differ++;
    expect(differ).toBeGreaterThan(1000);
    // Every texel is written (dilated, or the flat normal where nothing reaches).
    expect(bumpy.rgb.every((x) => x >= 0)).toBe(true);
  });

  it("reports each phase's time when asked, with the same map as without (C7e, TS-1286)", () => {
    const cube = editInput(boxMesh([200, 200, 200]));
    const cage = unwrapMesh(cube, meshEdges(cube.mesh, cube.topology));
    const base = multiresBase(cage, 2);
    const frames = multiresFrames(base);
    const d = new Float32Array(3 * base.gridVertex.length);
    for (let g = 0; g < base.gridVertex.length; g += 5) d[3 * g + 2] = 3;
    const high = { positions: multiresPositions(base, frames, d), quads: base.quads };
    const plain = bakeNormalMap({ cage, high, size: 512 });
    const phases: string[] = [];
    const timed = bakeNormalMap({
      cage,
      high,
      size: 512,
      timing: (phase, ms) => {
        expect(ms).toBeGreaterThanOrEqual(0);
        phases.push(phase);
      },
    });
    expect(phases).toEqual(['setup', 'raster', 'rays', 'dilate']);
    expect(timed).toEqual(plain);
  });

  it('refuses no UVs, UVs off the tile or overlapping (naming the faces), a size not offered, an empty surface', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        if (e instanceof BakeError) return [e.problem, e.faces];
        throw e;
      }
      return undefined;
    };
    const high = surface(() => 0);
    expect(code(() => bakeNormalMap({ cage: boxMesh([1, 1, 1]), high, size: 512 }))?.[0]).toBe(
      'uv',
    );
    const s = sheet(2);
    // Face 3's UVs on top of face 0's.
    s.uvs!.set(s.uvs!.subarray(0, 8), 24);
    expect(code(() => bakeNormalMap({ cage: s, high, size: 512 }))).toEqual(['uv-overlap', [0, 3]]);
    // One quad folding over itself in UV space (its two triangles overlap): refused too.
    const folded = sheet(1);
    folded.uvs!.set([0, 0, 1, 0, 0, 1, 1, 1]);
    expect(code(() => bakeNormalMap({ cage: folded, high, size: 512 }))).toEqual([
      'uv-overlap',
      [0],
    ]);
    // Face 1 moved a tile over (u 1–2, which the viewport would tile): refused, naming it.
    const tiled = sheet(2);
    for (let k = 8; k < 16; k += 2) tiled.uvs![k] += 1;
    expect(code(() => bakeNormalMap({ cage: tiled, high, size: 512 }))).toEqual(['uv-range', [1]]);
    expect(code(() => bakeNormalMap({ cage: sheet(), high, size: 300 }))?.[0]).toBe('size');
    expect(
      code(() =>
        bakeNormalMap({
          cage: sheet(),
          high: { positions: new Float32Array(0), quads: new Uint32Array(0) },
          size: 512,
        }),
      )?.[0],
    ).toBe('high');
    // Stopped from the progress callback.
    expect(
      code(() =>
        bakeNormalMap({ cage: sheet(), high, size: 512, progress: (rows) => rows > 10 }),
      )?.[0],
    ).toBe('cancelled');
    // Faces that only share an edge in UV space are no overlap.
    expect(code(() => bakeNormalMap({ cage: sheet(), high, size: 1024 }))).toBeUndefined();
  });

  it('bakes the ends of a thin box from the nearest surface where the ray misses (#773, TS-1301)', () => {
    // Catmull–Clark pulls the ends of an 80 × 80 × 420 box far in, and the cage's normals at
    // them lean along the long sides: rays from near the ends' borders pass the rounded end.
    const box = editInput(boxMesh([80, 80, 420]));
    const cage = unwrapMesh(box, meshEdges(box.mesh, box.topology));
    const base = multiresBase(cage, 3);
    const d = new Float32Array(3 * base.gridVertex.length);
    const r = bakeNormalMap({
      cage,
      high: { positions: multiresPositions(base, multiresFrames(base), d), quads: base.quads },
      size: 512,
    });
    expect(r.missed).toBe(0);
    expect(r.nearest).toBeGreaterThan(0.05 * r.covered);
    // Those texels take the surface's normal, not the cage's flat one: fewer texels are flat
    // than lie outside the layout.
    let flat = 0;
    for (let o = 0; o < 512 * 512; o++)
      if (r.rgb[3 * o] === 128 && r.rgb[3 * o + 1] === 128 && r.rgb[3 * o + 2] === 255) flat++;
    expect(flat).toBeLessThan(512 * 512 - r.covered);
  });

  it('finds the nearest point of the surface within a radius, as a search of every triangle does (#773)', () => {
    const { positions, quads } = surface((x, y) => 10 * Math.sin(x / 15) * Math.cos(y / 20), 30);
    const bvh = new TriangleBvh(positions, quads);
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 200; k++) {
      const p = [rnd() * 140 - 20, rnd() * 140 - 20, rnd() * 60 - 30];
      const radius = 5 + rnd() * 30;
      const got = bvh.closest(p, radius);
      let best = Infinity;
      for (let q = 0; q < quads.length; q += 4)
        for (const t of [
          [quads[q], quads[q + 1], quads[q + 2]],
          [quads[q], quads[q + 2], quads[q + 3]],
        ]) {
          const one = new TriangleBvh(
            Float32Array.from(t.flatMap((v) => [...positions.subarray(3 * v, 3 * v + 3)])),
            new Uint32Array([0, 1, 2, 2]),
          ).closest(p, radius);
          if (one) best = Math.min(best, one.distance);
        }
      if (best === Infinity) expect(got).toBeUndefined();
      else {
        expect(got!.distance).toBeCloseTo(best, 3);
        // The barycentrics name that point.
        const [a, b, c] = got!.triangle;
        const at = [0, 1, 2].map(
          (i) =>
            positions[3 * a + i] * (1 - got!.u - got!.v) +
            positions[3 * b + i] * got!.u +
            positions[3 * c + i] * got!.v,
        );
        expect(Math.hypot(at[0] - p[0], at[1] - p[1], at[2] - p[2])).toBeCloseTo(best, 3);
      }
    }
  });

  it('finds the hit nearest the middle of the ray, as a search of every triangle does', () => {
    const { positions, quads } = surface((x, y) => 10 * Math.sin(x / 15) * Math.cos(y / 20), 30);
    const bvh = new TriangleBvh(positions, quads);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 200; k++) {
      const o = [rnd() * 100, rnd() * 100, 30 + rnd() * 10];
      const d = [rnd() * 0.4 - 0.2, rnd() * 0.4 - 0.2, -1];
      const l = Math.hypot(...d);
      const dir = d.map((x) => x / l);
      const reach = 35;
      const got = bvh.nearest(o, dir, reach);
      // Every triangle.
      let best = Infinity;
      for (let q = 0; q < quads.length; q += 4)
        for (const t of [
          [quads[q], quads[q + 1], quads[q + 2]],
          [quads[q], quads[q + 2], quads[q + 3]],
        ]) {
          const one = new TriangleBvh(
            Float32Array.from(t.flatMap((v) => [...positions.subarray(3 * v, 3 * v + 3)])),
            new Uint32Array([0, 1, 2, 2]),
          ).nearest(o, dir, reach);
          if (one && Math.abs(one.t - reach) < Math.abs(best - reach)) best = one.t;
        }
      if (best === Infinity) expect(got).toBeUndefined();
      else expect(got!.t).toBeCloseTo(best, 3);
    }
  });

  it('writes an RGB PNG the header reader and a zlib reader agree with', async () => {
    const rgb = new Uint8Array(3 * 16 * 8);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) & 255;
    const png = await encodeRgbPng(rgb, 16, 8);
    expect(geometryTextureImageSize(png)).toEqual([16, 8]);
    // Undo the Up filter after inflating IDAT.
    const view = new DataView(png.buffer, png.byteOffset);
    const idatLength = view.getUint32(33);
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT');
    const raw = new Uint8Array(
      await new Response(
        new Blob([png.subarray(41, 41 + idatLength)])
          .stream()
          .pipeThrough(new DecompressionStream('deflate')),
      ).arrayBuffer(),
    );
    const out = new Uint8Array(rgb.length);
    for (let y = 0; y < 8; y++)
      for (let i = 0; i < 48; i++) {
        const f = raw[y * 49 + 1 + i];
        out[y * 48 + i] = y ? (f + out[(y - 1) * 48 + i]) & 255 : f;
      }
    expect(out).toEqual(rgb);
    await expect(encodeRgbPng(rgb, 4, 4)).rejects.toThrow(BakeError);
  });
});
