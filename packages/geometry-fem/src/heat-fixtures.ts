import type { FemMesh } from './fem';
import { boxTetMesh } from './primitives';

/**
 * Several meshes as one (separate pieces): nodes, elements and shape faces and edges are
 * renumbered after the ones before. Shape face f of mesh k becomes `faceOffsets[k] + f`.
 */
export function joinMeshes(meshes: readonly FemMesh[]): { mesh: FemMesh; faceOffsets: number[] } {
  if (!meshes.length) throw new RangeError('no mesh');
  const type = meshes[0]!.type;
  if (meshes.some((m) => m.type !== type)) throw new RangeError('one element type');
  const faceOffsets: number[] = [];
  let nodes = 0,
    elements = 0,
    boundary = 0,
    edgeNodes = 0,
    faces = 0,
    edges = 0;
  for (const m of meshes) {
    nodes += m.nodes.length;
    elements += m.elements.length;
    boundary += m.boundary.tags.length;
    edgeNodes += m.edges.nodes.length;
  }
  const out: FemMesh = {
    type,
    nodes: new Float64Array(nodes),
    elements: new Uint32Array(elements),
    shapeFaces: 0,
    shapeEdges: 0,
    boundary: {
      elements: new Uint32Array(boundary),
      localFaces: new Uint8Array(boundary),
      tags: new Uint32Array(boundary),
    },
    edges: { offsets: new Uint32Array(1), nodes: new Uint32Array(edgeNodes) },
  };
  const offsets: number[] = [0];
  let at = { n: 0, e: 0, b: 0, en: 0 };
  const npe = type === 'tet4' ? 4 : 10;
  for (const m of meshes) {
    faceOffsets.push(faces);
    const nodeBase = at.n / 3;
    const elemBase = at.e / npe;
    out.nodes.set(m.nodes, at.n);
    for (let i = 0; i < m.elements.length; i++) out.elements[at.e + i] = m.elements[i]! + nodeBase;
    for (let i = 0; i < m.boundary.tags.length; i++) {
      out.boundary.elements[at.b + i] = m.boundary.elements[i]! + elemBase;
      out.boundary.localFaces[at.b + i] = m.boundary.localFaces[i]!;
      out.boundary.tags[at.b + i] = m.boundary.tags[i]! + faces;
    }
    for (let i = 0; i < m.edges.nodes.length; i++)
      out.edges.nodes[at.en + i] = m.edges.nodes[i]! + nodeBase;
    for (let k = 1; k < m.edges.offsets.length; k++) offsets.push(m.edges.offsets[k]! + at.en);
    at = {
      n: at.n + m.nodes.length,
      e: at.e + m.elements.length,
      b: at.b + m.boundary.tags.length,
      en: at.en + m.edges.nodes.length,
    };
    faces += m.shapeFaces;
    edges += m.shapeEdges;
  }
  out.shapeFaces = faces;
  out.shapeEdges = edges;
  out.edges.offsets = Uint32Array.from(offsets);
  return { mesh: out, faceOffsets };
}

/** Moves a mesh's nodes by `by` (mm), in place, and returns it. */
export function translateMesh(mesh: FemMesh, by: readonly [number, number, number]): FemMesh {
  for (let p = 0; p < mesh.nodes.length; p += 3)
    for (let d = 0; d < 3; d++) mesh.nodes[p + d]! += by[d]!;
  return mesh;
}

export interface ShieldPlates {
  mesh: FemMesh;
  /** Shape faces: the hot plate's top, the cold plate's bottom, the shield's two sides (or []). */
  hotFace: number;
  coldFace: number;
  shieldFaces: number[];
  /** Every face of each plate (for holding its temperature). */
  hotFaces: number[];
  coldFaces: number[];
  shieldAll: number[];
}

/**
 * F100 (docs/cad/vehicle-simulation.md, VS11): two square plates facing each other across a gap,
 * with or without a thin shield plate half way. The hot plate lies on z ∈ [−t, 0], the cold one on
 * [gap, gap + t], the shield centred at gap / 2. Sizes in mm.
 */
export function shieldPlates(options: {
  side: number;
  gap: number;
  thickness: number;
  divisions: number;
  shield: boolean;
  type?: 'tet4' | 'tet10';
}): ShieldPlates {
  const { side, gap, thickness: t, divisions: d, shield } = options;
  const type = options.type ?? 'tet10';
  const plate = (z: number) =>
    translateMesh(boxTetMesh({ size: [side, side, t], divisions: [d, d, 1], type }), [0, 0, z]);
  const parts = [plate(-t), plate(gap)];
  if (shield) parts.push(plate(gap / 2 - t / 2));
  const { mesh, faceOffsets } = joinMeshes(parts);
  const all = (k: number) => [0, 1, 2, 3, 4, 5].map((f) => f + faceOffsets[k]!);
  return {
    mesh,
    hotFace: faceOffsets[0]! + 5,
    coldFace: faceOffsets[1]! + 4,
    shieldFaces: shield ? [faceOffsets[2]! + 4, faceOffsets[2]! + 5] : [],
    hotFaces: all(0),
    coldFaces: all(1),
    shieldAll: shield ? all(2) : [],
  };
}
