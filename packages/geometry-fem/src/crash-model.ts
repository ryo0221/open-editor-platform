import type { ExplicitMaterial, ExplicitModel, ExplicitWeld } from './explicit';
import type { ShellMesh } from './shell';

/**
 * VS7c (docs/cad/vehicle-simulation.md, VS7): the explicit model of a crash run from the analysed
 * bodies' shell meshes, as the static runs mesh them. Each body is a part (its triangles as
 * shells with the fourth node repeated, its own material), the bodies' nodes one after another;
 * every shell touches every other (contact with friction); each spot weld point ties two parts
 * (the explicit solver picks the nodes within the radius, VS6b); an added mass is spread over its
 * faces' nodes by area, as the static runs spread it.
 */
export interface CrashPart {
  mesh: ShellMesh;
  material: ExplicitMaterial;
  /** Added masses (t) on shape faces of this mesh. */
  masses?: { faces: readonly number[]; mass: number }[];
}

export interface CrashWeldRow {
  /** The two parts (indices into the parts) and the weld points (x, y, z each). */
  parts: [number, number];
  points: readonly number[];
  radius: number;
  /**
   * VS8c: a seam (a bond): pairs of nodes, one of the first part (the follower) and one of the
   * second (each part's own numbering), each the model's tie, in place of `points` (`radius`
   * is not used).
   */
  ties?: readonly number[];
}

export interface CrashModel {
  model: ExplicitModel;
  /** Each part's first node and first shell in the model. */
  nodeOffset: number[];
  shellOffset: number[];
}

export function crashModel(
  parts: readonly CrashPart[],
  welds: readonly CrashWeldRow[],
  friction = 0,
): CrashModel {
  if (!parts.length) throw new RangeError('crashModel: no parts');
  if (parts.length > 65_535) throw new RangeError('crashModel: more parts than shell part indices');
  const nodeOffset: number[] = [];
  const shellOffset: number[] = [];
  let nodes = 0,
    shells = 0;
  for (const p of parts) {
    nodeOffset.push(nodes);
    shellOffset.push(shells);
    nodes += p.mesh.nodes.length / 3;
    shells += p.mesh.triangles.length / 3;
  }
  const x = new Float64Array(3 * nodes);
  const quads = new Uint32Array(4 * shells);
  const thickness = new Float64Array(shells);
  const shellMaterial = new Uint16Array(shells);
  const shellPart = new Uint16Array(shells);
  const masses = new Map<number, number>();
  parts.forEach((p, k) => {
    const n0 = nodeOffset[k]!;
    const e0 = shellOffset[k]!;
    const m = p.mesh;
    x.set(m.nodes, 3 * n0);
    const ne = m.triangles.length / 3;
    for (let e = 0; e < ne; e++) {
      const a = n0 + m.triangles[3 * e]!;
      const b = n0 + m.triangles[3 * e + 1]!;
      const c = n0 + m.triangles[3 * e + 2]!;
      quads.set([a, b, c, c], 4 * (e0 + e));
      thickness[e0 + e] = m.thickness[e]!;
      shellMaterial[e0 + e] = k;
      shellPart[e0 + e] = k;
    }
    // An added mass by area over its faces' triangles, a third of each to its corners.
    for (const added of p.masses ?? []) {
      const faces = new Set(added.faces);
      const share = new Map<number, number>();
      let total = 0;
      for (let e = 0; e < ne; e++) {
        if (!faces.has(m.faces[e]!)) continue;
        const t = [0, 1, 2].map((q) => m.triangles[3 * e + q]!);
        const p0 = [0, 1, 2].map((q) => m.nodes[3 * t[0]! + q]!);
        const u = [0, 1, 2].map((q) => m.nodes[3 * t[1]! + q]! - p0[q]!);
        const v = [0, 1, 2].map((q) => m.nodes[3 * t[2]! + q]! - p0[q]!);
        const area =
          0.5 *
          Math.hypot(
            u[1]! * v[2]! - u[2]! * v[1]!,
            u[2]! * v[0]! - u[0]! * v[2]!,
            u[0]! * v[1]! - u[1]! * v[0]!,
          );
        total += area;
        for (const i of t) share.set(i, (share.get(i) ?? 0) + area / 3);
      }
      if (!(total > 0))
        throw new RangeError(`crashModel: an added mass of part ${k} has no area on its faces`);
      for (const [i, a] of share)
        masses.set(n0 + i, (masses.get(n0 + i) ?? 0) + (added.mass * a) / total);
    }
  });
  const explicitWelds: ExplicitWeld[] = [];
  const ties: number[] = [];
  for (const w of welds) {
    if (w.parts[0] === w.parts[1] || !parts[w.parts[0]] || !parts[w.parts[1]])
      throw new RangeError('crashModel: a weld joins two different parts');
    if (w.ties) {
      const [a, b] = w.parts;
      const [na, nb] = [parts[a]!.mesh.nodes.length / 3, parts[b]!.mesh.nodes.length / 3];
      if (w.points.length || w.ties.length % 2)
        throw new RangeError('crashModel: a seam gives node pairs and no points');
      for (let k = 0; k < w.ties.length; k += 2) {
        const [i, j] = [w.ties[k]!, w.ties[k + 1]!];
        if (!(Number.isInteger(i) && i >= 0 && i < na && Number.isInteger(j) && j >= 0 && j < nb))
          throw new RangeError('crashModel: a seam names a missing node');
        ties.push(nodeOffset[a]! + i, nodeOffset[b]! + j);
      }
      continue;
    }
    for (let k = 0; k + 2 < w.points.length; k += 3)
      explicitWelds.push({
        point: [w.points[k]!, w.points[k + 1]!, w.points[k + 2]!],
        radius: w.radius,
        parts: w.parts,
        // A crash mesh is coarser than the weld pitch (no finer mesh around the points).
        nearestNode: true,
      });
  }
  return {
    nodeOffset,
    shellOffset,
    model: {
      nodes: x,
      shells: quads,
      thickness,
      shellMaterial,
      shellPart,
      materials: parts.map((p) => p.material),
      ...(masses.size ? { masses: [...masses].map(([node, mass]) => ({ node, mass })) } : {}),
      ...(explicitWelds.length ? { welds: explicitWelds } : {}),
      ...(ties.length ? { ties: Uint32Array.from(ties) } : {}),
      contact: { friction, ignoreInitial: true },
    },
  };
}

/** The node nearest a point (mm). */
export function nearestNode(nodes: Float64Array, point: readonly number[]): number {
  let best = -1,
    d = Infinity;
  for (let i = 0; i < nodes.length / 3; i++) {
    const e = Math.hypot(
      nodes[3 * i]! - point[0]!,
      nodes[3 * i + 1]! - point[1]!,
      nodes[3 * i + 2]! - point[2]!,
    );
    if (e < d) {
      d = e;
      best = i;
    }
  }
  return best;
}
