import { boundaryFaceList, ElasticError } from './elastic';
import { localFaces, nodesPerElement, tet10Edges, type FemMesh } from './fem';
import type { ShellMesh } from './shell';

/**
 * CR5b (docs/cad/car-design.md, S5): the nodes a spot weld ties. For each weld point, the nodes of
 * the first flange's faces within `radius` of it; where none is that near (a mesh coarser than the
 * weld), the nodes of the flange's element face nearest the point. They become the dependent nodes
 * of a bond onto the second flange (`BondSide.nodes`), so a weld follows the other sheet as a face
 * bond does, only around its points.
 */
export interface SpotWeldNodes {
  /** Every tied node, once, in order. */
  nodes: number[];
  /** Per point: how many nodes it ties, and whether they came from the nearest face (`fallback`). */
  points: { nodes: number; fallback: boolean }[];
}

type Vec = [number, number, number];
const at = (xs: ArrayLike<number>, p: number): Vec => [xs[3 * p]!, xs[3 * p + 1]!, xs[3 * p + 2]!];

/** The distance from `p` to the triangle a, b, c (Ericson, closest point on a triangle). */
function triangleDistance(p: Vec, a: Vec, b: Vec, c: Vec): number {
  const sub = (x: Vec, y: Vec): Vec => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const dot = (x: Vec, y: Vec) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  const point = (q: Vec) => Math.hypot(...sub(p, q));
  const along = (o: Vec, d: Vec, t: number): Vec => [
    o[0] + t * d[0],
    o[1] + t * d[1],
    o[2] + t * d[2],
  ];
  if (d1 <= 0 && d2 <= 0) return point(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return point(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return point(along(a, ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return point(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return point(along(a, ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return point(along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  const v = vb * denom,
    w = vc * denom;
  return point([
    a[0] + ab[0] * v + ac[0] * w,
    a[1] + ab[1] * v + ac[1] * w,
    a[2] + ab[2] * v + ac[2] * w,
  ]);
}

/**
 * The element faces of `faces` on a shell (its triangles) or a solid (its boundary faces, with a
 * tet10's mid-edge nodes): each as its corner triangle, to measure, and all its nodes, to tie.
 * Refuses a face the mesh does not have (`target-index`).
 */
function flangeFaces(
  part: { kind: 'shell'; mesh: ShellMesh } | { kind: 'solid'; mesh: FemMesh },
  faces: readonly number[],
): { corners: [number, number, number]; nodes: number[] }[] {
  const out: { corners: [number, number, number]; nodes: number[] }[] = [];
  if (part.kind === 'shell') {
    const m = part.mesh;
    for (const f of faces)
      if (!Number.isInteger(f) || f < 0 || f >= m.shapeFaces)
        throw new ElasticError('target-index', `face ${f} is not in 0..${m.shapeFaces - 1}`);
    const want = new Set(faces);
    for (let e = 0; e < m.triangles.length / 3; e++)
      if (want.has(m.faces[e]!)) {
        const c: [number, number, number] = [
          m.triangles[3 * e]!,
          m.triangles[3 * e + 1]!,
          m.triangles[3 * e + 2]!,
        ];
        out.push({ corners: c, nodes: [...c] });
      }
    return out;
  }
  const m = part.mesh;
  const npe = nodesPerElement(m.type);
  for (const { e, lf } of boundaryFaceList(m, faces)) {
    const el = m.elements.subarray(e * npe, (e + 1) * npe);
    const face = localFaces[lf]!;
    const nodes = face.map((k) => el[k]!);
    if (m.type === 'tet10')
      tet10Edges.forEach(([a, b], i) => {
        if (face.includes(a) && face.includes(b)) nodes.push(el[4 + i]!);
      });
    out.push({ corners: [el[face[0]!]!, el[face[1]!]!, el[face[2]!]!], nodes });
  }
  return out;
}

/**
 * The nodes the weld points `points` (x, y, z each, mm) tie on the first flange's `faces`.
 * Refuses a radius ≤ 0 (`bond-gap`), no point and faces with no element (`empty-target`).
 */
export function spotWeldNodes(
  part: { kind: 'shell'; mesh: ShellMesh } | { kind: 'solid'; mesh: FemMesh },
  faces: readonly number[],
  points: ArrayLike<number>,
  radius: number,
): SpotWeldNodes {
  if (!(radius > 0) || !Number.isFinite(radius))
    throw new ElasticError('bond-gap', `a spot weld radius of ${radius} mm: it must be > 0`);
  const count = points.length / 3;
  if (!Number.isInteger(count) || count < 1)
    throw new ElasticError('empty-target', 'a spot weld row with no point');
  const elements = flangeFaces(part, faces);
  if (!elements.length)
    throw new ElasticError('empty-target', 'a spot weld flange with no element');
  const xs = part.mesh.nodes;
  const candidates = [...new Set(elements.flatMap((f) => f.nodes))];
  const tied = new Set<number>();
  const perPoint: SpotWeldNodes['points'] = [];
  for (let k = 0; k < count; k++) {
    const p = at(points, k);
    const near = candidates.filter(
      (q) => Math.hypot(...at(xs, q).map((x, i) => x - p[i]!)) <= radius,
    );
    if (near.length) {
      for (const q of near) tied.add(q);
      perPoint.push({ nodes: near.length, fallback: false });
      continue;
    }
    let best = elements[0]!,
      bestD = Infinity;
    for (const f of elements) {
      const d = triangleDistance(p, ...(f.corners.map((q) => at(xs, q)) as [Vec, Vec, Vec]));
      if (d < bestD) [best, bestD] = [f, d];
    }
    for (const q of best.nodes) tied.add(q);
    perPoint.push({ nodes: best.nodes.length, fallback: true });
  }
  return { nodes: [...tied].sort((a, b) => a - b), points: perPoint };
}
