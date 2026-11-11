import { localFaces, tet10Edges, cornerVolume6, type FemElementType, type FemMesh } from './fem';

/**
 * Shape faces of `boxTetMesh`, by index: the box's planes x = 0, x = X, y = 0, y = Y, z = 0, z = Z.
 * Shape edges are the box's 12 edges, `boxEdges` order.
 */
export const boxFaces = Object.freeze(['x0', 'x1', 'y0', 'y1', 'z0', 'z1'] as const);
/** Each box edge as the two shape faces it lies on. */
export const boxEdges: readonly (readonly [number, number])[] = Object.freeze([
  [2, 4],
  [3, 4],
  [2, 5],
  [3, 5],
  [0, 4],
  [1, 4],
  [0, 5],
  [1, 5],
  [0, 2],
  [1, 2],
  [0, 3],
  [1, 3],
]);

export interface BoxTetOptions {
  /** Box size (mm); the box spans [0, size] on each axis. */
  size: readonly [number, number, number];
  divisions: readonly [number, number, number];
  type: FemElementType;
}

/**
 * A structured tetrahedral mesh of a box: each grid cell is split into six tetrahedra around its
 * main diagonal (Kuhn), so neighbouring cells share faces. A fixture for the solver and the
 * format, and the stand-in until the mesher (R3b) exists; it is not a general mesher.
 */
export function boxTetMesh(options: BoxTetOptions): FemMesh {
  const [X, Y, Z] = options.size;
  const [nx, ny, nz] = options.divisions;
  for (const d of options.divisions)
    if (!Number.isSafeInteger(d) || d < 1 || d > 200) throw new RangeError('divisions');
  for (const s of options.size) if (!(s > 0) || !Number.isFinite(s)) throw new RangeError('size');
  const coords: number[] = [];
  const grid = (i: number, j: number, k: number) => (k * (ny + 1) + j) * (nx + 1) + i;
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) coords.push((X * i) / nx, (Y * j) / ny, (Z * k) / nz);
  const corners: number[] = [];
  const perms = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const nodes0 = new Float64Array(coords);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        for (const p of perms) {
          const at = [i, j, k];
          const tet = [grid(i, j, k)];
          for (const axis of p) {
            at[axis]!++;
            tet.push(grid(at[0]!, at[1]!, at[2]!));
          }
          if (cornerVolume6(nodes0, new Uint32Array(tet), 4, 0) < 0)
            [tet[1], tet[2]] = [tet[2]!, tet[1]!];
          corners.push(...tet);
        }
  const m = corners.length / 4;
  let elements: Uint32Array;
  let nodes: Float64Array;
  if (options.type === 'tet4') {
    elements = new Uint32Array(corners);
    nodes = nodes0;
  } else {
    const mids = new Map<string, number>();
    const all = [...coords];
    elements = new Uint32Array(m * 10);
    for (let e = 0; e < m; e++) {
      for (let c = 0; c < 4; c++) elements[e * 10 + c] = corners[e * 4 + c]!;
      tet10Edges.forEach(([a, b], s) => {
        const na = corners[e * 4 + a]!,
          nb = corners[e * 4 + b]!;
        const key = na < nb ? `${na},${nb}` : `${nb},${na}`;
        let id = mids.get(key);
        if (id === undefined) {
          id = all.length / 3;
          mids.set(key, id);
          for (let d = 0; d < 3; d++) all.push((coords[na * 3 + d]! + coords[nb * 3 + d]!) / 2);
        }
        elements[e * 10 + 4 + s] = id;
      });
    }
    nodes = new Float64Array(all);
  }
  const npe = options.type === 'tet4' ? 4 : 10;
  const size = [X, Y, Z];
  const eps = 1e-9 * Math.max(X, Y, Z);
  const planeOf = (pts: number[]): number => {
    for (let axis = 0; axis < 3; axis++)
      for (const side of [0, 1]) {
        const v = side ? size[axis]! : 0;
        if (pts.every((n) => Math.abs(nodes[n * 3 + axis]! - v) < eps)) return axis * 2 + side;
      }
    return -1;
  };
  // A face is on the boundary when its three corners lie on one box plane.
  const be: number[] = [],
    bl: number[] = [],
    bt: number[] = [];
  for (let e = 0; e < m; e++)
    localFaces.forEach((f, lf) => {
      const tag = planeOf(f.map((c) => elements[e * npe + c]!));
      if (tag >= 0) {
        be.push(e);
        bl.push(lf);
        bt.push(tag);
      }
    });
  // Edge chains: every node on both planes of the edge, ordered along it.
  const offsets = [0];
  const chain: number[] = [];
  const n = nodes.length / 3;
  for (const [fa, fb] of boxEdges) {
    const on = (node: number, face: number) =>
      Math.abs(nodes[node * 3 + (face >> 1)]! - (face & 1 ? size[face >> 1]! : 0)) < eps;
    const axis = [0, 1, 2].find((a) => a !== fa >> 1 && a !== fb >> 1)!;
    const list: number[] = [];
    for (let node = 0; node < n; node++) if (on(node, fa) && on(node, fb)) list.push(node);
    list.sort((p, q) => nodes[p * 3 + axis]! - nodes[q * 3 + axis]!);
    chain.push(...list);
    offsets.push(chain.length);
  }
  return {
    type: options.type,
    nodes,
    elements,
    shapeFaces: 6,
    shapeEdges: boxEdges.length,
    boundary: {
      elements: new Uint32Array(be),
      localFaces: new Uint8Array(bl),
      tags: new Uint32Array(bt),
    },
    edges: { offsets: new Uint32Array(offsets), nodes: new Uint32Array(chain) },
  };
}
