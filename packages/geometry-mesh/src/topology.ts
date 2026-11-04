import type { EpmMesh } from './epm';

/**
 * The half-edge view of an EPM mesh (C3). Half-edge `h` is face corner `h`: it runs from the
 * corner's vertex to the next corner's vertex in the same face. `twin` pairs it with the opposite
 * half-edge of the neighbouring face, or -1 on an open border.
 */
export interface MeshTopology {
  readonly vertexCount: number;
  readonly faceStart: Uint32Array;
  readonly faceSizes: Uint32Array;
  /** The face of each half-edge. */
  readonly halfEdgeFace: Uint32Array;
  /** The opposite half-edge, or -1 on a border. */
  readonly twin: Int32Array;
  /** Outgoing half-edges of vertex v: `outgoing[outgoingStart[v] .. outgoingStart[v + 1]]`. */
  readonly outgoingStart: Uint32Array;
  readonly outgoing: Uint32Array;
}

export type MeshEditProblem = 'non-manifold' | 'selection' | 'degenerate' | 'limit';
/** Every refusal of a mesh edit; the input mesh is never changed. */
export class MeshEditError extends Error {
  constructor(
    readonly problem: MeshEditProblem,
    readonly detail: string,
  ) {
    super(`mesh-edit-refused: ${problem}: ${detail}`);
    this.name = 'MeshEditError';
  }
}
export const editFail = (problem: MeshEditProblem, detail: string): never => {
  throw new MeshEditError(problem, detail);
};

/** Vertex counts below 2^20 (EPM allows 500,000), so a pair packs into one safe integer. */
const K = 1 << 20;
export const edgeKey = (a: number, b: number) => (a < b ? a * K + b : b * K + a);
export const directedKey = (a: number, b: number) => a * K + b;
export const edgeOfKey = (k: number): [number, number] => [Math.floor(k / K), k % K];

/** The next half-edge around the same face. */
export function nextHalfEdge(t: MeshTopology, h: number) {
  const f = t.halfEdgeFace[h];
  return h + 1 === t.faceStart[f] + t.faceSizes[f] ? t.faceStart[f] : h + 1;
}
export function prevHalfEdge(t: MeshTopology, h: number) {
  const f = t.halfEdgeFace[h];
  return h === t.faceStart[f] ? t.faceStart[f] + t.faceSizes[f] - 1 : h - 1;
}
/** The vertex a half-edge ends at. */
export const halfEdgeTo = (mesh: EpmMesh, t: MeshTopology, h: number) =>
  mesh.faceIndices[nextHalfEdge(t, h)];

/**
 * Builds the half-edge view, refusing a mesh that is not an oriented 2-manifold (with borders):
 * an edge used by more than two faces or twice in the same direction (flipped neighbours), or a
 * vertex whose faces do not form one fan (two cones touching at a point). Vertices no face uses
 * are allowed.
 */
export function meshTopology(mesh: EpmMesh): MeshTopology {
  const vertexCount = mesh.positions.length / 3;
  const faces = mesh.faceSizes.length;
  const corners = mesh.faceIndices.length;
  const faceStart = new Uint32Array(faces);
  const halfEdgeFace = new Uint32Array(corners);
  for (let f = 0, c = 0; f < faces; f++) {
    faceStart[f] = c;
    for (let k = 0; k < mesh.faceSizes[f]; k++) halfEdgeFace[c + k] = f;
    c += mesh.faceSizes[f];
  }
  const t: MeshTopology = {
    vertexCount,
    faceStart,
    faceSizes: mesh.faceSizes,
    halfEdgeFace,
    twin: new Int32Array(corners).fill(-1),
    outgoingStart: new Uint32Array(vertexCount + 1),
    outgoing: new Uint32Array(corners),
  };
  const directed = new Map<number, number>();
  for (let h = 0; h < corners; h++) {
    const a = mesh.faceIndices[h];
    const b = halfEdgeTo(mesh, t, h);
    const key = directedKey(a, b);
    if (directed.has(key))
      editFail('non-manifold', `edge ${a}-${b} is used twice in one direction`);
    directed.set(key, h);
    t.outgoingStart[a + 1]++;
  }
  for (let h = 0; h < corners; h++) {
    const a = mesh.faceIndices[h];
    const b = halfEdgeTo(mesh, t, h);
    const o = directed.get(directedKey(b, a));
    if (o !== undefined) t.twin[h] = o;
  }
  for (let v = 0; v < vertexCount; v++) t.outgoingStart[v + 1] += t.outgoingStart[v];
  const fill = t.outgoingStart.slice(0, vertexCount);
  for (let h = 0; h < corners; h++) t.outgoing[fill[mesh.faceIndices[h]]++] = h;
  // One fan per vertex: walk around it both ways and reach every outgoing half-edge.
  for (let v = 0; v < vertexCount; v++) {
    const s = t.outgoingStart[v],
      e = t.outgoingStart[v + 1];
    if (e === s) continue;
    const start = t.outgoing[s];
    let reached = 1;
    let h = start;
    let closed = false;
    for (;;) {
      const r = t.twin[prevHalfEdge(t, h)];
      if (r < 0) break;
      if (r === start) {
        closed = true;
        break;
      }
      h = r;
      if (++reached > e - s) break;
    }
    if (!closed) {
      h = start;
      for (;;) {
        const tw = t.twin[h];
        if (tw < 0) break;
        h = nextHalfEdge(t, tw);
        if (++reached > e - s) break;
      }
    }
    if (reached !== e - s) editFail('non-manifold', `vertex ${v} joins separate fans of faces`);
  }
  return t;
}

/** The Newell normal of face f (not normalised; its length is twice the area). */
export function faceNormal(mesh: EpmMesh, t: MeshTopology, f: number): [number, number, number] {
  const s = t.faceStart[f],
    n = t.faceSizes[f];
  const p = mesh.positions;
  let x = 0,
    y = 0,
    z = 0;
  for (let k = 0; k < n; k++) {
    const a = 3 * mesh.faceIndices[s + k];
    const b = 3 * mesh.faceIndices[s + ((k + 1) % n)];
    x += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
    y += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
    z += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
  }
  return [x, y, z];
}

/** The vertices of face f, in order. */
export function faceVertices(mesh: EpmMesh, t: MeshTopology, f: number): number[] {
  return Array.from(mesh.faceIndices.subarray(t.faceStart[f], t.faceStart[f] + t.faceSizes[f]));
}

/** Every edge once, as `edgeKey`s, in the order faces first use them. */
export function meshEdges(mesh: EpmMesh, t: MeshTopology): number[] {
  const out: number[] = [];
  for (let h = 0; h < mesh.faceIndices.length; h++) {
    const tw = t.twin[h];
    if (tw < 0 || tw > h) out.push(edgeKey(mesh.faceIndices[h], halfEdgeTo(mesh, t, h)));
  }
  return out;
}
