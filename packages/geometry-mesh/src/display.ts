import type { EpmMesh } from './epm';

/**
 * The triangles a viewport draws for one mesh. Each face corner becomes its own display vertex
 * (UVs are per corner); `cornerVertex` maps it back to the mesh vertex, so morphs and skins apply
 * through it. Polygons are split by ear clipping in the plane of their Newell normal, so concave
 * faces keep their outline and winding.
 */
export interface MeshDisplay {
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  indices: Uint32Array;
  cornerVertex: Uint32Array;
  /** Triangle groups by material slot, in slot order: [start index, count, slot]. */
  groups: [number, number, number][];
  /** Up to four influences per display vertex, the largest kept and renormalised. */
  skinIndex?: Uint16Array;
  skinWeight?: Float32Array;
  /** One delta array per morph, per display vertex. */
  morphPositions: Float32Array[];
}

export function meshDisplay(mesh: EpmMesh): MeshDisplay {
  const corners = mesh.faceIndices.length;
  const cornerVertex = mesh.faceIndices.slice();
  const positions = new Float32Array(corners * 3);
  for (let c = 0; c < corners; c++) {
    const v = cornerVertex[c];
    positions[3 * c] = mesh.positions[3 * v];
    positions[3 * c + 1] = mesh.positions[3 * v + 1];
    positions[3 * c + 2] = mesh.positions[3 * v + 2];
  }
  const normals = cornerNormals(mesh);
  const bySlot = new Map<number, number[]>();
  let start = 0;
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const n = mesh.faceSizes[f];
    const list = bySlot.get(mesh.faceMaterials[f]) ?? [];
    for (const k of triangulateFace(mesh, start, n)) list.push(start + k);
    bySlot.set(mesh.faceMaterials[f], list);
    start += n;
  }
  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  const total = slots.reduce((s, k) => s + bySlot.get(k)!.length, 0);
  const indices = new Uint32Array(total);
  const groups: [number, number, number][] = [];
  let at = 0;
  for (const slot of slots) {
    const list = bySlot.get(slot)!;
    indices.set(list, at);
    groups.push([at, list.length, slot]);
    at += list.length;
  }
  const out: MeshDisplay = {
    positions,
    normals,
    indices,
    cornerVertex,
    groups,
    morphPositions: mesh.morphs.map((m) => {
      const d = new Float32Array(corners * 3);
      for (let c = 0; c < corners; c++)
        for (let k = 0; k < 3; k++) d[3 * c + k] = m.deltas[3 * cornerVertex[c] + k];
      return d;
    }),
  };
  if (mesh.uvs) out.uvs = mesh.uvs.slice();
  if (mesh.weights) {
    const { skinIndex, skinWeight } = fourInfluences(mesh);
    out.skinIndex = new Uint16Array(corners * 4);
    out.skinWeight = new Float32Array(corners * 4);
    for (let c = 0; c < corners; c++) {
      out.skinIndex.set(skinIndex.subarray(4 * cornerVertex[c], 4 * cornerVertex[c] + 4), 4 * c);
      out.skinWeight.set(skinWeight.subarray(4 * cornerVertex[c], 4 * cornerVertex[c] + 4), 4 * c);
    }
  }
  return out;
}

/** Per vertex, the four largest weights renormalised to sum 1 (glTF's and three.js's form). */
export function fourInfluences(mesh: EpmMesh): {
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
} {
  const v = mesh.positions.length / 3;
  const skinIndex = new Uint16Array(v * 4);
  const skinWeight = new Float32Array(v * 4);
  const w = mesh.weights;
  if (!w) return { skinIndex, skinWeight };
  for (let i = 0; i < v; i++) {
    const list: [number, number][] = [];
    for (let k = w.offsets[i]; k < w.offsets[i + 1]; k++) list.push([w.bones[k], w.values[k]]);
    list.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const kept = list.slice(0, 4);
    const sum = kept.reduce((s, [, x]) => s + x, 0);
    kept.forEach(([bone, x], k) => {
      skinIndex[4 * i + k] = bone;
      skinWeight[4 * i + k] = sum > 0 ? x / sum : 0;
    });
  }
  return { skinIndex, skinWeight };
}

/**
 * Triangles of one face as corner offsets (0 … n−1), in the face's winding. Ear clipping in the
 * plane of the Newell normal; a face with no valid ear left (self-crossing or degenerate) has its
 * rest split as a fan, so every face still gives n − 2 triangles.
 */
export function triangulateFace(mesh: EpmMesh, start: number, n: number): number[] {
  if (n === 3) return [0, 1, 2];
  const p = mesh.positions;
  const at = (k: number) => 3 * mesh.faceIndices[start + k];
  let nx = 0,
    ny = 0,
    nz = 0;
  for (let k = 0; k < n; k++) {
    const a = at(k),
      b = at((k + 1) % n);
    nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
    ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
    nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
  }
  // Project onto the two axes the normal is least aligned with, keeping orientation.
  const ax = Math.abs(nx),
    ay = Math.abs(ny),
    az = Math.abs(nz);
  const [u, v, sign] = az >= ax && az >= ay ? [0, 1, nz] : ax >= ay ? [1, 2, nx] : [2, 0, ny];
  const flip = sign < 0 ? -1 : 1;
  const xy = (k: number): [number, number] => [p[at(k) + u], flip * p[at(k) + v]];
  const cross = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const ring = Array.from({ length: n }, (_, k) => k);
  const out: number[] = [];
  while (ring.length > 3) {
    let cut = -1;
    for (let i = 0; i < ring.length && cut < 0; i++) {
      const a = ring[(i + ring.length - 1) % ring.length],
        b = ring[i],
        c = ring[(i + 1) % ring.length];
      const pa = xy(a),
        pb = xy(b),
        pc = xy(c);
      if (cross(pa, pb, pc) <= 0) continue; // reflex or flat corner
      const inside = ring.some((k) => {
        if (k === a || k === b || k === c) return false;
        const q = xy(k);
        return cross(pa, pb, q) >= 0 && cross(pb, pc, q) >= 0 && cross(pc, pa, q) >= 0;
      });
      if (!inside) cut = i;
    }
    if (cut < 0) break;
    const len = ring.length;
    out.push(ring[(cut + len - 1) % len], ring[cut], ring[(cut + 1) % len]);
    ring.splice(cut, 1);
  }
  for (let k = 1; k < ring.length - 1; k++) out.push(ring[0], ring[k], ring[k + 1]);
  return out;
}

/**
 * Smooth normals, per face corner: each vertex averages the area-weighted normals of the faces
 * around it (exported so a morphed or deformed copy of the mesh can be shaded again).
 */
export function cornerNormals(mesh: EpmMesh): Float32Array {
  const v = mesh.positions.length / 3;
  const acc = new Float64Array(v * 3);
  const p = mesh.positions;
  let start = 0;
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const n = mesh.faceSizes[f];
    // Newell's method: robust for non-planar polygons.
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let k = 0; k < n; k++) {
      const a = mesh.faceIndices[start + k],
        b = mesh.faceIndices[start + ((k + 1) % n)];
      nx += (p[3 * a + 1] - p[3 * b + 1]) * (p[3 * a + 2] + p[3 * b + 2]);
      ny += (p[3 * a + 2] - p[3 * b + 2]) * (p[3 * a] + p[3 * b]);
      nz += (p[3 * a] - p[3 * b]) * (p[3 * a + 1] + p[3 * b + 1]);
    }
    for (let k = 0; k < n; k++) {
      const a = mesh.faceIndices[start + k];
      acc[3 * a] += nx;
      acc[3 * a + 1] += ny;
      acc[3 * a + 2] += nz;
    }
    start += n;
  }
  const out = new Float32Array(mesh.faceIndices.length * 3);
  for (let c = 0; c < mesh.faceIndices.length; c++) {
    const a = mesh.faceIndices[c];
    const len = Math.hypot(acc[3 * a], acc[3 * a + 1], acc[3 * a + 2]);
    if (len > 0) for (let k = 0; k < 3; k++) out[3 * c + k] = acc[3 * a + k] / len;
    else out[3 * c + 2] = 1;
  }
  return out;
}

/** The axis-aligned bounds of a mesh (mm), or null when it has no vertices. */
export function meshBounds(
  mesh: EpmMesh,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const p = mesh.positions;
  if (!p.length) return null;
  const min: [number, number, number] = [p[0], p[1], p[2]];
  const max: [number, number, number] = [p[0], p[1], p[2]];
  for (let i = 3; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[i + k]);
      max[k] = Math.max(max[k], p[i + k]);
    }
  return { min, max };
}
