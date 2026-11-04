import {
  checkEpmMesh,
  encodeEpm,
  epmLimits,
  MeshAssetError,
  type EpmLimits,
  type EpmMesh,
} from './epm';
import {
  edgeKey,
  edgeOfKey,
  editFail,
  faceNormal,
  faceVertices,
  meshTopology,
  nextHalfEdge,
  prevHalfEdge,
  type MeshTopology,
} from './topology';

/**
 * C3's edit limits. A part is edited up to 200,000 vertices (the EPM asset itself allows
 * 500,000); an imported mesh past that is shown but not edited.
 */
export const meshEditLimits = Object.freeze({ vertices: 200_000 });

export type Vec3 = [number, number, number];

/** The input of every edit: the mesh, its topology (checked manifold), and the limits. */
export interface EditInput {
  mesh: EpmMesh;
  topology: MeshTopology;
}
/** Checks a mesh can be edited and builds its topology once; edits take the result. */
export function editInput(mesh: EpmMesh, limits: EpmLimits = { ...epmLimits }): EditInput {
  checkEpmMesh(mesh, limits);
  const v = mesh.positions.length / 3;
  if (v > meshEditLimits.vertices)
    editFail('limit', `${v} vertices; parts are edited up to ${meshEditLimits.vertices}`);
  return { mesh, topology: meshTopology(mesh) };
}

/** A blend of input vertices, `[vertex, weight]` with weights summing to 1. */
export type VertexBlend = [number, number][];

/**
 * A mesh under edit. Vertices are blends of input vertices (so skin weights and morph deltas
 * follow), faces carry their corners' UVs. `finish` drops unused vertices and checks the result.
 */
export class MeshBuilder {
  readonly positions: number[] = [];
  /** Per vertex, the input vertices it blends (null: an input vertex kept as it is). */
  private readonly sources: (VertexBlend | null)[] = [];
  readonly faces: { vertices: number[]; uvs: number[] | null; material: number }[] = [];
  /** Creases by `edgeKey` of builder vertices. */
  readonly creases = new Map<number, number>();

  constructor(readonly input: EditInput) {
    const { mesh } = input;
    const v = mesh.positions.length / 3;
    for (let i = 0; i < mesh.positions.length; i++) this.positions.push(mesh.positions[i]);
    for (let i = 0; i < v; i++) this.sources.push(null);
    if (mesh.creases)
      for (let i = 0; i < mesh.creases.values.length; i++)
        this.creases.set(
          edgeKey(mesh.creases.edges[2 * i], mesh.creases.edges[2 * i + 1]),
          mesh.creases.values[i],
        );
  }

  /** Starts from the input's faces; edits then replace or add faces. */
  copyFaces(skip?: Set<number>) {
    const { mesh, topology: t } = this.input;
    for (let f = 0; f < mesh.faceSizes.length; f++) {
      if (skip?.has(f)) continue;
      this.faces.push({
        vertices: faceVertices(mesh, t, f),
        uvs: this.faceUvs(f),
        material: mesh.faceMaterials[f],
      });
    }
  }
  faceUvs(f: number): number[] | null {
    const { mesh, topology: t } = this.input;
    if (!mesh.uvs) return null;
    const s = t.faceStart[f];
    return Array.from(mesh.uvs.subarray(2 * s, 2 * (s + t.faceSizes[f])));
  }
  position(v: number): Vec3 {
    return [this.positions[3 * v], this.positions[3 * v + 1], this.positions[3 * v + 2]];
  }
  setPosition(v: number, p: Vec3) {
    this.positions[3 * v] = p[0];
    this.positions[3 * v + 1] = p[1];
    this.positions[3 * v + 2] = p[2];
  }
  /** A new vertex at `p`, carrying the attributes of `blend` (builder vertices). */
  addVertex(p: Vec3, blend: VertexBlend): number {
    const input: VertexBlend = [];
    for (const [v, w] of blend) {
      const src = this.sources[v];
      if (src === null) input.push([v, w]);
      else for (const [u, x] of src) input.push([u, x * w]);
    }
    this.sources.push(input);
    this.positions.push(p[0], p[1], p[2]);
    return this.sources.length - 1;
  }
  get vertexCount() {
    return this.sources.length;
  }

  /**
   * The edited mesh: vertices no face uses are dropped (the rest keep their order), creases stay
   * on edges that still exist. Refuses a result past the limits or no longer manifold.
   */
  finish(
    limits: EpmLimits = { ...epmLimits },
    vertexCap: number = meshEditLimits.vertices,
  ): EpmMesh {
    const { mesh } = this.input;
    if (this.faces.length === 0) editFail('degenerate', 'the edit leaves no faces');
    const used = new Int32Array(this.vertexCount).fill(-1);
    let count = 0;
    for (const f of this.faces) for (const v of f.vertices) if (used[v] < 0) used[v] = 0;
    for (let v = 0; v < used.length; v++) if (used[v] === 0) used[v] = count++;
    if (count > vertexCap) editFail('limit', `${count} vertices; the limit is ${vertexCap}`);
    const positions = new Float32Array(count * 3);
    for (let v = 0; v < used.length; v++) {
      if (used[v] < 0) continue;
      for (let k = 0; k < 3; k++) {
        const x = this.positions[3 * v + k];
        if (!Number.isFinite(x) || Math.abs(x) > 1e12)
          editFail('degenerate', 'a vertex would leave the finite range');
        positions[3 * used[v] + k] = x;
      }
    }
    const corners = this.faces.reduce((s, f) => s + f.vertices.length, 0);
    const out: EpmMesh = {
      positions,
      faceSizes: new Uint32Array(this.faces.map((f) => f.vertices.length)),
      faceIndices: new Uint32Array(corners),
      faceMaterials: new Uint16Array(this.faces.map((f) => f.material)),
      boneIds: mesh.boneIds.slice(),
      morphs: [],
    };
    const edges = new Set<number>();
    let c = 0;
    for (const f of this.faces) {
      if (f.vertices.length < 3 || f.vertices.length > limits.faceSize)
        editFail('limit', `a face of ${f.vertices.length} vertices`);
      for (let k = 0; k < f.vertices.length; k++) {
        out.faceIndices[c + k] = used[f.vertices[k]];
        edges.add(edgeKey(f.vertices[k], f.vertices[(k + 1) % f.vertices.length]));
      }
      c += f.vertices.length;
    }
    if (mesh.uvs) {
      out.uvs = new Float32Array(corners * 2);
      let u = 0;
      for (const f of this.faces) {
        const uv = f.uvs ?? new Array<number>(f.vertices.length * 2).fill(0);
        for (let k = 0; k < uv.length; k++) out.uvs[u++] = uv[k];
      }
    }
    const creases = [...this.creases]
      .filter(([k, w]) => w > 0 && edges.has(k))
      .map(([k, w]) => {
        const [a, b] = edgeOfKey(k).map((v) => used[v]);
        return [Math.min(a, b), Math.max(a, b), w] as const;
      })
      .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    if (creases.length)
      out.creases = {
        edges: new Uint32Array(creases.flatMap(([a, b]) => [a, b])),
        values: new Float32Array(creases.map(([, , w]) => w)),
      };
    if (mesh.weights) out.weights = this.blendWeights(used, count, limits.influences);
    for (const m of mesh.morphs) {
      const deltas = new Float32Array(count * 3);
      for (let v = 0; v < used.length; v++) {
        if (used[v] < 0) continue;
        const src = this.sources[v] ?? [[v, 1]];
        for (const [u, w] of src)
          for (let k = 0; k < 3; k++) deltas[3 * used[v] + k] += w * m.deltas[3 * u + k];
      }
      out.morphs.push({ id: m.id, deltas });
    }
    try {
      // Encoding checks every array and the byte budget, so the result can become an asset.
      encodeEpm(out, limits);
    } catch (e) {
      if (e instanceof MeshAssetError)
        editFail(
          e.problem === 'limit' || e.problem === 'too-large' ? 'limit' : 'degenerate',
          e.detail,
        );
      throw e;
    }
    meshTopology(out);
    return out;
  }

  /** Blended skin weights, the largest `influences` kept and renormalised. */
  private blendWeights(used: Int32Array, count: number, influences: number) {
    const w = this.input.mesh.weights!;
    const offsets = new Uint32Array(count + 1);
    const bones: number[] = [];
    const values: number[] = [];
    for (let v = 0; v < used.length; v++) {
      if (used[v] < 0) continue;
      const acc = new Map<number, number>();
      for (const [u, x] of this.sources[v] ?? [[v, 1]])
        for (let k = w.offsets[u]; k < w.offsets[u + 1]; k++)
          acc.set(w.bones[k], (acc.get(w.bones[k]) ?? 0) + x * w.values[k]);
      const kept = [...acc]
        .filter(([, x]) => x > 1e-6)
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, influences);
      const sum = kept.reduce((s, [, x]) => s + x, 0);
      for (const [b, x] of kept) {
        bones.push(b);
        values.push(Math.min(1, x / sum));
      }
      offsets[used[v] + 1] = bones.length;
    }
    return { offsets, bones: new Uint16Array(bones), values: new Float32Array(values) };
  }
}

/** Checks a list of vertex or face indices: integers in range, no repeats, not empty. */
export function checkSelection(list: readonly number[], size: number, what: string): Set<number> {
  if (list.length === 0) editFail('selection', `no ${what} selected`);
  const out = new Set<number>();
  for (const i of list) {
    if (!Number.isInteger(i) || i < 0 || i >= size) editFail('selection', `${what} ${i}`);
    if (out.has(i)) editFail('selection', `${what} ${i} is selected twice`);
    out.add(i);
  }
  return out;
}
const finiteVec = (v: readonly number[], what: string) => {
  if (v.length !== 3 || !v.every((x) => Number.isFinite(x))) editFail('selection', what);
};

/**
 * Moves vertices by an affine matrix (column-major 4×4, mm). Morph deltas and UVs are kept.
 */
export function transformVertices(
  input: EditInput,
  vertices: readonly number[],
  matrix: readonly number[],
  limits?: EpmLimits,
): EpmMesh {
  const chosen = checkSelection(vertices, input.topology.vertexCount, 'vertex');
  if (matrix.length !== 16 || !matrix.every(Number.isFinite)) editFail('selection', 'matrix');
  const b = new MeshBuilder(input);
  b.copyFaces();
  for (const v of chosen) {
    const [x, y, z] = b.position(v);
    b.setPosition(v, [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ]);
  }
  return b.finish(limits);
}
/** Moves vertices by `delta` (mm). */
export const translateVertices = (
  input: EditInput,
  vertices: readonly number[],
  delta: Vec3,
  limits?: EpmLimits,
) => {
  finiteVec(delta, 'delta');
  return transformVertices(
    input,
    vertices,
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, delta[0], delta[1], delta[2], 1],
    limits,
  );
};

/** The vertices of the given faces, in first-use order. */
export function verticesOfFaces(input: EditInput, faces: Iterable<number>): number[] {
  const out = new Set<number>();
  for (const f of faces) for (const v of faceVertices(input.mesh, input.topology, f)) out.add(v);
  return [...out];
}
/** Faces that use any of the given vertices. */
export function facesOfVertices(input: EditInput, vertices: Iterable<number>): number[] {
  const t = input.topology;
  const out = new Set<number>();
  for (const v of vertices)
    for (let k = t.outgoingStart[v]; k < t.outgoingStart[v + 1]; k++)
      out.add(t.halfEdgeFace[t.outgoing[k]]);
  return [...out].sort((a, b) => a - b);
}

/**
 * Extrudes faces by `distance` (mm). Faces joined by edges form a region that moves along its own
 * mean normal (so mirrored selections move apart). Vertices on a region's outline are doubled and joined to the originals by a quad per outline edge; vertices inside
 * the region just move. Each new side face takes the material of the face it rises from. Faces
 * that meet only at a corner are refused (the result would not be manifold).
 */
export function extrudeFaces(
  input: EditInput,
  faces: readonly number[],
  distance: number,
  limits?: EpmLimits,
): EpmMesh {
  const { mesh, topology: t } = input;
  const chosen = checkSelection(faces, mesh.faceSizes.length, 'face');
  if (!Number.isFinite(distance)) editFail('selection', 'distance');
  // Faces joined by edges form one region; each region moves along its own mean normal.
  const region = new Map<number, number>();
  const dirs: Vec3[] = [];
  for (const start of chosen) {
    if (region.has(start)) continue;
    const id = dirs.length;
    const n: Vec3 = [0, 0, 0];
    const stack = [start];
    region.set(start, id);
    while (stack.length) {
      const f = stack.pop()!;
      const fn = faceNormal(mesh, t, f);
      for (let k = 0; k < 3; k++) n[k] += fn[k];
      for (let h = t.faceStart[f]; h < t.faceStart[f] + t.faceSizes[f]; h++) {
        const tw = t.twin[h];
        if (tw < 0) continue;
        const g = t.halfEdgeFace[tw];
        if (chosen.has(g) && !region.has(g)) {
          region.set(g, id);
          stack.push(g);
        }
      }
    }
    const len = Math.hypot(...n);
    if (!(len > 1e-9)) editFail('degenerate', 'a region of faces has no mean direction');
    dirs.push(n.map((x) => (x / len) * distance) as Vec3);
  }
  const vertexRegion = new Map<number, number>();
  for (const f of chosen)
    for (const v of faceVertices(mesh, t, f)) {
      const r = vertexRegion.get(v);
      if (r !== undefined && r !== region.get(f))
        editFail('non-manifold', `selected faces meet only at vertex ${v}`);
      vertexRegion.set(v, region.get(f)!);
    }
  const b = new MeshBuilder(input);
  b.copyFaces(chosen);
  // Outline: half-edges of chosen faces whose twin is not chosen.
  const outline: number[] = [];
  const inner = new Set<number>();
  const dup = new Map<number, number>();
  for (const f of chosen)
    for (let h = t.faceStart[f]; h < t.faceStart[f] + t.faceSizes[f]; h++) {
      const tw = t.twin[h];
      if (tw >= 0 && chosen.has(t.halfEdgeFace[tw])) {
        inner.add(edgeKey(mesh.faceIndices[h], mesh.faceIndices[nextHalfEdge(t, h)]));
        continue;
      }
      outline.push(h);
      dup.set(mesh.faceIndices[h], -1);
      dup.set(mesh.faceIndices[nextHalfEdge(t, h)], -1);
    }
  for (const v of dup.keys()) dup.set(v, b.addVertex(b.position(v), [[v, 1]]));
  for (const [v, r] of vertexRegion) {
    const to = dup.get(v) ?? v;
    const dir = dirs[r];
    const p = b.position(v);
    b.setPosition(to, [p[0] + dir[0], p[1] + dir[1], p[2] + dir[2]]);
  }
  for (const f of chosen)
    b.faces.push({
      vertices: faceVertices(mesh, t, f).map((v) => dup.get(v) ?? v),
      uvs: b.faceUvs(f),
      material: mesh.faceMaterials[f],
    });
  for (const h of outline) {
    const f = t.halfEdgeFace[h];
    const next = nextHalfEdge(t, h);
    const a = mesh.faceIndices[h],
      c = mesh.faceIndices[next];
    const uv = mesh.uvs
      ? [
          mesh.uvs[2 * h],
          mesh.uvs[2 * h + 1],
          mesh.uvs[2 * next],
          mesh.uvs[2 * next + 1],
          mesh.uvs[2 * next],
          mesh.uvs[2 * next + 1],
          mesh.uvs[2 * h],
          mesh.uvs[2 * h + 1],
        ]
      : null;
    b.faces.push({
      vertices: [a, c, dup.get(c)!, dup.get(a)!],
      uvs: uv,
      material: mesh.faceMaterials[f],
    });
  }
  // A crease inside the region rides up with its faces.
  for (const [k, w] of [...b.creases]) {
    const [x, y] = edgeOfKey(k);
    if (!inner.has(k) || (!dup.has(x) && !dup.has(y))) continue;
    b.creases.delete(k);
    b.creases.set(edgeKey(dup.get(x) ?? x, dup.get(y) ?? y), w);
  }
  return b.finish(limits);
}

/**
 * Insets each face on its own: a smaller copy toward the face centre (`amount` 0–1 of the way)
 * and a ring of quads around it. UVs, skin weights and morph deltas are blended the same way.
 */
export function insetFaces(
  input: EditInput,
  faces: readonly number[],
  amount: number,
  limits?: EpmLimits,
): EpmMesh {
  const { mesh, topology: t } = input;
  const chosen = checkSelection(faces, mesh.faceSizes.length, 'face');
  if (!(amount > 0 && amount < 1)) editFail('selection', 'amount must be between 0 and 1');
  const b = new MeshBuilder(input);
  b.copyFaces(chosen);
  for (const f of chosen) {
    const vs = faceVertices(mesh, t, f);
    const size = vs.length;
    const uv = b.faceUvs(f);
    const centre: Vec3 = [0, 0, 0];
    for (const v of vs) {
      const p = b.position(v);
      for (let k = 0; k < 3; k++) centre[k] += p[k] / size;
    }
    const inner = vs.map((v) => {
      const p = b.position(v);
      const blend: VertexBlend = vs.map((u) => [u, amount / size]);
      blend.push([v, 1 - amount]);
      return b.addVertex([0, 1, 2].map((k) => p[k] + (centre[k] - p[k]) * amount) as Vec3, blend);
    });
    let innerUv: number[] | null = null;
    if (uv) {
      const cu = [0, 0];
      for (let k = 0; k < size; k++) {
        cu[0] += uv[2 * k] / size;
        cu[1] += uv[2 * k + 1] / size;
      }
      innerUv = [];
      for (let k = 0; k < size; k++)
        innerUv.push(
          uv[2 * k] + (cu[0] - uv[2 * k]) * amount,
          uv[2 * k + 1] + (cu[1] - uv[2 * k + 1]) * amount,
        );
    }
    for (let k = 0; k < size; k++) {
      const j = (k + 1) % size;
      b.faces.push({
        vertices: [vs[k], vs[j], inner[j], inner[k]],
        uvs:
          uv && innerUv
            ? [
                uv[2 * k],
                uv[2 * k + 1],
                uv[2 * j],
                uv[2 * j + 1],
                innerUv[2 * j],
                innerUv[2 * j + 1],
                innerUv[2 * k],
                innerUv[2 * k + 1],
              ]
            : null,
        material: mesh.faceMaterials[f],
      });
    }
    b.faces.push({ vertices: inner, uvs: innerUv, material: mesh.faceMaterials[f] });
  }
  return b.finish(limits);
}

/**
 * Deletes faces; vertices no remaining face uses go too. Refuses deleting every face, and a
 * deletion that leaves two fans of faces touching at one vertex.
 */
export function deleteFaces(
  input: EditInput,
  faces: readonly number[],
  limits?: EpmLimits,
): EpmMesh {
  const chosen = checkSelection(faces, input.mesh.faceSizes.length, 'face');
  const b = new MeshBuilder(input);
  b.copyFaces(chosen);
  return b.finish(limits);
}

/**
 * Merges vertices into one at `at` (default: their centre). Edges between merged vertices
 * collapse; a face left with fewer than three corners is removed. Refuses a merge that would make
 * a face use one vertex twice apart, or leave the mesh not manifold.
 */
export function mergeVertices(
  input: EditInput,
  vertices: readonly number[],
  at?: Vec3,
  limits?: EpmLimits,
): EpmMesh {
  if (at) finiteVec(at, 'at');
  return mergeVertexGroups(input, [vertices], at ? [at] : undefined, limits);
}

/**
 * Merges each group of vertices into its own new vertex, in one edit: the result is checked only
 * once every group is merged (two halves can be stitched where one alone would not be manifold).
 * `at` gives each group's position (default: its centre). Groups must not share a vertex.
 */
export function mergeVertexGroups(
  input: EditInput,
  groups: readonly (readonly number[])[],
  at?: readonly Vec3[],
  limits?: EpmLimits,
): EpmMesh {
  const { mesh, topology: t } = input;
  if (groups.length === 0) editFail('selection', 'no vertices selected');
  const into = new Map<number, number>();
  const b = new MeshBuilder(input);
  groups.forEach((group, g) => {
    const chosen = checkSelection(group, t.vertexCount, 'vertex');
    if (chosen.size < 2) editFail('selection', 'merge needs two vertices or more');
    for (const v of chosen)
      if (into.has(v)) editFail('selection', `vertex ${v} is in two merge groups`);
    const list = [...chosen];
    const centre: Vec3 = [0, 0, 0];
    for (const v of list) {
      const p = b.position(v);
      for (let k = 0; k < 3; k++) centre[k] += p[k] / list.length;
    }
    const target = at?.[g];
    if (target) finiteVec(target, 'at');
    const added = b.addVertex(
      target ?? centre,
      list.map((v) => [v, 1 / list.length]),
    );
    for (const v of list) into.set(v, added);
  });
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const vs = faceVertices(mesh, t, f).map((v) => into.get(v) ?? v);
    const uv = b.faceUvs(f);
    const keepV: number[] = [];
    const keepUv: number[] = [];
    for (let k = 0; k < vs.length; k++) {
      if (vs[k] === vs[(k + 1) % vs.length]) continue;
      keepV.push(vs[k]);
      if (uv) keepUv.push(uv[2 * k], uv[2 * k + 1]);
    }
    if (keepV.length < 3) continue;
    if (new Set(keepV).size !== keepV.length)
      editFail('non-manifold', `face ${f} would use one vertex twice`);
    b.faces.push({ vertices: keepV, uvs: uv ? keepUv : null, material: mesh.faceMaterials[f] });
  }
  // Creases on collapsed edges go; creases to a merged vertex move to the new one.
  for (const [k, w] of [...b.creases]) {
    const [x, y] = edgeOfKey(k);
    if (!into.has(x) && !into.has(y)) continue;
    b.creases.delete(k);
    const nx = into.get(x) ?? x;
    const ny = into.get(y) ?? y;
    if (nx === ny) continue;
    const key = edgeKey(nx, ny);
    b.creases.set(key, Math.max(w, b.creases.get(key) ?? 0));
  }
  return b.finish(limits);
}

/** Sets the crease (0–1) of edges, each given as a vertex pair joined by a face edge. */
export function setEdgeCreases(
  input: EditInput,
  edges: readonly [number, number][],
  value: number,
  limits?: EpmLimits,
): EpmMesh {
  const { mesh, topology: t } = input;
  if (!(value >= 0 && value <= 1)) editFail('selection', 'crease must be 0–1');
  if (edges.length === 0) editFail('selection', 'no edges selected');
  const b = new MeshBuilder(input);
  b.copyFaces();
  const seen = new Set<number>();
  for (const [x, y] of edges) {
    checkSelection([x, y], t.vertexCount, 'vertex');
    let joined = false;
    for (let k = t.outgoingStart[x]; k < t.outgoingStart[x + 1] && !joined; k++) {
      const h = t.outgoing[k];
      joined =
        mesh.faceIndices[nextHalfEdge(t, h)] === y || mesh.faceIndices[prevHalfEdge(t, h)] === y;
    }
    if (!joined) editFail('selection', `${x}-${y} is not an edge`);
    const key = edgeKey(x, y);
    if (seen.has(key)) editFail('selection', `edge ${x}-${y} is selected twice`);
    seen.add(key);
    if (value > 0) b.creases.set(key, value);
    else b.creases.delete(key);
  }
  return b.finish(limits);
}
