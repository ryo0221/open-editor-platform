import { nodesPerElement, type FemMesh } from './fem';

/** docs/cad/r3-analysis.md, meshingと品質: the initial lower limits of an element's shape. */
export const shapeQualityMin = Object.freeze({ radiusRatio: 0.05, dihedralDeg: 2 });

export interface ShapeQuality {
  /** 3 × inradius / circumradius of the corner tetrahedron: 1 for a regular one, 0 for a flat one. */
  minRadiusRatio: number;
  /** The smallest angle between two faces of a corner tetrahedron (degrees). */
  minDihedralDeg: number;
  /** Elements below `shapeQualityMin` (either measure), in order. */
  below: number[];
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V) => Math.hypot(a[0], a[1], a[2]);

/** One corner tetrahedron's radius ratio and smallest dihedral angle (degrees). */
export function tetShape(p: readonly [V, V, V, V]): { radiusRatio: number; dihedralDeg: number } {
  const [a, b, c] = [sub(p[1], p[0]), sub(p[2], p[0]), sub(p[3], p[0])];
  const six = dot(a, cross(b, c));
  // Face normals (unnormalised, outward for positive volume), each opposite its vertex.
  const faces: V[] = [
    cross(sub(p[2], p[1]), sub(p[3], p[1])),
    cross(sub(p[3], p[0]), sub(p[2], p[0])),
    cross(sub(p[1], p[0]), sub(p[3], p[0])),
    cross(sub(p[2], p[0]), sub(p[1], p[0])),
  ];
  const areas2 = faces.map(norm);
  const area = areas2.reduce((s, x) => s + x, 0) / 2;
  if (!(six > 0) || !(area > 0)) return { radiusRatio: 0, dihedralDeg: 0 };
  const inradius = six / 2 / area; // 3V / A with V = six / 6
  const circ: V = [0, 1, 2].map(
    (k) => dot(a, a) * cross(b, c)[k]! + dot(b, b) * cross(c, a)[k]! + dot(c, c) * cross(a, b)[k]!,
  ) as V;
  const circumradius = norm(circ) / (2 * six);
  let dihedral = Math.PI;
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++) {
      const cos = dot(faces[i]!, faces[j]!) / (areas2[i]! * areas2[j]!);
      dihedral = Math.min(dihedral, Math.PI - Math.acos(Math.max(-1, Math.min(1, cos))));
    }
  return { radiusRatio: (3 * inradius) / circumradius, dihedralDeg: (dihedral * 180) / Math.PI };
}

/** Every element's corner-tetrahedron shape (curved tet10 elements are judged by `jacobianRatio`). */
export function meshShapeQuality(
  mesh: FemMesh,
  min: { radiusRatio: number; dihedralDeg: number } = shapeQualityMin,
): ShapeQuality {
  const npe = nodesPerElement(mesh.type);
  const at = (n: number): V => [mesh.nodes[3 * n]!, mesh.nodes[3 * n + 1]!, mesh.nodes[3 * n + 2]!];
  let minRadiusRatio = Infinity;
  let minDihedralDeg = Infinity;
  const below: number[] = [];
  for (let e = 0; e < mesh.elements.length / npe; e++) {
    const q = tetShape([0, 1, 2, 3].map((k) => at(mesh.elements[npe * e + k]!)) as [V, V, V, V]);
    minRadiusRatio = Math.min(minRadiusRatio, q.radiusRatio);
    minDihedralDeg = Math.min(minDihedralDeg, q.dihedralDeg);
    if (!(q.radiusRatio >= min.radiusRatio) || !(q.dihedralDeg >= min.dihedralDeg)) below.push(e);
  }
  return { minRadiusRatio, minDihedralDeg, below };
}
