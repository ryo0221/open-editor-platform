import { describe, expect, it } from 'vitest';
import {
  boxMesh,
  decodeEpm,
  encodeEpm,
  epmLimits,
  epmSha256,
  fourInfluences,
  meshBounds,
  meshDisplay,
  MeshAssetError,
  type EpmMesh,
} from './index';

function riggedBox(): EpmMesh {
  const m = boxMesh([100, 200, 300]);
  const offsets = new Uint32Array(9);
  const bones: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < 8; i++) {
    if (i < 4) {
      bones.push(0);
      values.push(1);
    } else {
      bones.push(0, 1);
      values.push(0.25, 0.75);
    }
    offsets[i + 1] = bones.length;
  }
  m.weights = { offsets, bones: new Uint16Array(bones), values: new Float32Array(values) };
  m.boneIds = ['hip', 'spine'];
  m.uvs = new Float32Array(48).map((_, i) => (i % 7) / 7);
  m.creases = { edges: new Uint32Array([0, 1, 2, 3]), values: new Float32Array([1, 0.5]) };
  m.morphs = [{ id: 'puff', deltas: new Float32Array(24).fill(2) }];
  return m;
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof MeshAssetError) return `${e.problem}:${e.detail}`;
    throw e;
  }
  return 'accepted';
};
function patch(bytes: Uint8Array, edit: (view: DataView) => void) {
  const copy = bytes.slice();
  edit(new DataView(copy.buffer));
  return copy;
}
/** The byte offset of a section's data. */
function sectionAt(bytes: Uint8Array, tag: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const n = view.getUint32(8, true);
  for (let i = 0; i < n; i++) {
    const c = view.getUint32(16 + i * 12, true);
    const name = String.fromCharCode(c & 255, (c >> 8) & 255, (c >> 16) & 255, c >>> 24);
    if (name === tag) return { entry: 16 + i * 12, at: view.getUint32(16 + i * 12 + 4, true) };
  }
  throw new Error(tag);
}

describe('EPM 1', () => {
  it('round-trips every array and gives the same bytes for the same mesh', () => {
    const mesh = riggedBox();
    const bytes = encodeEpm(mesh);
    expect(bytes.length % 4).toBe(0);
    const back = decodeEpm(bytes);
    expect(back).toEqual(mesh);
    expect(encodeEpm(back)).toEqual(bytes);
    expect(epmSha256(bytes)).toBe(epmSha256(encodeEpm(riggedBox())));
    expect(epmSha256(bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('round-trips a plain mesh with only the required sections', () => {
    const mesh = boxMesh([10, 10, 10], [5, 5, 5]);
    expect(decodeEpm(encodeEpm(mesh))).toEqual(mesh);
    expect(meshBounds(mesh)).toEqual({ min: [0, 0, 0], max: [10, 10, 10] });
  });
  it('refuses broken headers and section tables', () => {
    const bytes = encodeEpm(riggedBox());
    expect(code(() => decodeEpm(bytes.subarray(0, 8)))).toBe('header:short');
    expect(code(() => decodeEpm(patch(bytes, (v) => v.setUint8(0, 0x46))))).toBe('header:magic');
    expect(code(() => decodeEpm(patch(bytes, (v) => v.setUint32(4, 2, true))))).toBe(
      'header:version',
    );
    expect(code(() => decodeEpm(patch(bytes, (v) => v.setUint32(8, 999, true))))).toBe(
      'sections:count',
    );
    const { entry } = sectionAt(bytes, 'UVCO');
    expect(code(() => decodeEpm(patch(bytes, (v) => v.setUint32(entry, 0x58585858, true))))).toBe(
      'sections:unknown XXXX',
    );
    expect(
      code(() =>
        decodeEpm(patch(bytes, (v) => v.setUint32(entry + 4, sectionAt(bytes, 'POSI').at, true))),
      ),
    ).toBe('sections:overlap');
    expect(code(() => decodeEpm(patch(bytes, (v) => v.setUint32(entry + 4, 18, true))))).toBe(
      'sections:range UVCO',
    );
    expect(code(() => decodeEpm(bytes, { ...epmLimits, bytes: 100 }))).toMatch(/^too-large/);
  });
  it('refuses data that does not match the mesh, without repairing it', () => {
    const bytes = encodeEpm(riggedBox());
    const idx = sectionAt(bytes, 'FIDX').at;
    expect(code(() => decodeEpm(patch(bytes, (v) => v.setUint32(idx, 8, true))))).toBe(
      'index:faces[0]',
    );
    expect(code(() => decodeEpm(patch(bytes, (v) => v.setUint32(idx, 2, true))))).toBe(
      'face:faces[0] repeats a vertex',
    );
    const pos = sectionAt(bytes, 'POSI').at;
    expect(code(() => decodeEpm(patch(bytes, (v) => v.setFloat32(pos, NaN, true))))).toBe(
      'not-finite:positions[0]',
    );
    const w = sectionAt(bytes, 'WVAL').at;
    expect(code(() => decodeEpm(patch(bytes, (v) => v.setFloat32(w, 0.5, true))))).toBe(
      'weights:vertex 0 sum',
    );
    const crease = sectionAt(bytes, 'CRSV').at;
    expect(code(() => decodeEpm(patch(bytes, (v) => v.setFloat32(crease, 2, true))))).toBe(
      'crease:creases[0] value',
    );
  });
  it('refuses meshes over the limits and broken arrays before writing them', () => {
    const big = riggedBox();
    expect(code(() => decodeEpm(encodeEpm(big), { ...epmLimits, vertices: 7 }))).toBe(
      'limit:vertices',
    );
    expect(code(() => decodeEpm(encodeEpm(big), { ...epmLimits, influences: 1 }))).toBe(
      'limit:vertex 4 influences',
    );
    const dupBone = riggedBox();
    dupBone.boneIds = ['hip', 'hip'];
    expect(code(() => encodeEpm(dupBone))).toBe('ids:boneIds');
    const triangle = boxMesh([1, 1, 1]);
    triangle.faceSizes[0] = 2;
    expect(code(() => encodeEpm(triangle))).toBe('face:faces[0] size');
    const morph = riggedBox();
    morph.morphs[0].deltas = new Float32Array(3);
    expect(code(() => encodeEpm(morph))).toBe('length:morphs[0]');
    // Every count within its limit, but the metadata or the whole asset past the reader's: the
    // writer refuses, so nothing it returns is unreadable.
    const longIds = boxMesh([1, 1, 1]);
    longIds.boneIds = Array.from(
      { length: 512 },
      (_, i) =>
        String.fromCodePoint(0x1f400 + (i % 256), 0x1f500 + (i >> 8)) + '\u{1F9B4}'.repeat(126),
    );
    expect(code(() => encodeEpm(longIds))).toBe('meta:size');
    expect(code(() => encodeEpm(riggedBox(), { ...epmLimits, bytes: 256 }))).toMatch(
      /^too-large:\d+ bytes$/,
    );
  });
});

describe('mesh display', () => {
  it('splits corners, fans quads and keeps per-corner UVs and morphs', () => {
    const mesh = riggedBox();
    const d = meshDisplay(mesh);
    expect(d.positions.length).toBe(24 * 3);
    expect(d.indices.length).toBe(6 * 2 * 3);
    expect(d.groups).toEqual([[0, 36, 0]]);
    expect(d.uvs).toEqual(mesh.uvs);
    expect(d.morphPositions[0].every((x) => x === 2)).toBe(true);
    // A corner of the 100 × 200 × 300 box averages its three faces by area.
    expect([...d.normals.subarray(0, 3)].map((x) => Math.round(x * 1000) / 1000)).toEqual([
      -0.857, -0.429, -0.286,
    ]);
  });
  it('splits a concave face without crossing its outline or turning a triangle over', () => {
    // An arrow-head pentagon in the XY plane, area 2.5, with a reflex corner at (1, 0.5).
    const mesh: EpmMesh = {
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 1, 0.5, 0, 0, 2, 0]),
      faceSizes: new Uint32Array([5]),
      faceIndices: new Uint32Array([0, 1, 2, 3, 4]),
      faceMaterials: new Uint16Array([0]),
      boneIds: [],
      morphs: [],
    };
    const d = meshDisplay(mesh);
    expect(d.indices.length).toBe(9);
    const areas: number[] = [];
    for (let t = 0; t < d.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => d.indices[t + k] * 3);
      const p = d.positions;
      areas.push(
        ((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2,
      );
    }
    expect(areas.every((x) => x > 0)).toBe(true);
    expect(areas.reduce((x, y) => x + y, 0)).toBeCloseTo(2.5, 6);
  });
  it('keeps the four largest weights, renormalised', () => {
    const mesh = boxMesh([1, 1, 1]);
    mesh.boneIds = ['a', 'b', 'c', 'd', 'e'];
    const offsets = new Uint32Array(9);
    const bones: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < 8; i++) {
      bones.push(0, 1, 2, 3, 4);
      values.push(0.1, 0.4, 0.2, 0.2, 0.1);
      offsets[i + 1] = bones.length;
    }
    mesh.weights = { offsets, bones: new Uint16Array(bones), values: new Float32Array(values) };
    const { skinIndex, skinWeight } = fourInfluences(mesh);
    expect([...skinIndex.subarray(0, 4)]).toEqual([1, 2, 3, 0]);
    expect([...skinWeight.subarray(0, 4)].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});
