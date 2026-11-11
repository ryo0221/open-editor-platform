/**
 * CR6b (docs/cad/car-design.md): a moulded part's checks on its display mesh, for the view's
 * analysis shadings: the wall thickness at each node (a ray from the node into the part, to the
 * wall it meets) and the draft angle of each node to a pull direction. Both are approximations
 * on the display mesh, not the exact B-rep: the values depend on how fine the mesh is, and the
 * view says so. Pure data and Three.js maths; no rendering.
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** The mesh a check reads: positions relative to `origin`, one normal per position (mm). */
export interface PartCheckMesh {
  origin: readonly [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** Limits of the check settings. */
export const partCheckLimits = Object.freeze({
  /** Thickness bounds (mm). */
  thickness: [0.1, 100] as const,
  /** Smallest draft angle (degrees). */
  draft: [0, 30] as const,
  /**
   * A ray starts at its node; hits on the node's own triangles, and closer than this (a
   * neighbouring face through the same place), are its own surface, not the wall across (mm).
   * Under the smallest CAD dimension (0.001 mm), so a thinner supported wall is still measured.
   */
  selfHitMm: 1e-4,
});

/** Linear RGB (0–1) colours of the checks. */
export const partCheckColors = Object.freeze({
  thin: [0.86, 0.15, 0.15] as const,
  ok: [0.3, 0.69, 0.31] as const,
  thick: [0.15, 0.39, 0.92] as const,
  /** No value there: the ray left the part (an open sheet, a hole in the mesh). */
  none: [0.6, 0.64, 0.69] as const,
  /** Draft: toward the pull direction, against it, too small, an undercut. */
  withPull: [0.3, 0.69, 0.31] as const,
  againstPull: [0.15, 0.39, 0.92] as const,
  tooSmall: [0.96, 0.7, 0.1] as const,
  undercut: [0.86, 0.15, 0.15] as const,
});

export interface ThicknessResult {
  /** Wall thickness at each node (mm); NaN where the ray met no wall. */
  values: Float32Array;
  /** Smallest and largest values with their nodes' places (model mm); undefined when none. */
  min?: { mm: number; at: [number, number, number] };
  max?: { mm: number; at: [number, number, number] };
  /** Nodes without a value. */
  missing: number;
}

/**
 * The wall thickness at each node: the distance along the inward normal from the node to the
 * first wall the ray meets (either side). It reads the mesh's own triangles only, so a wall of
 * another body does not count.
 */
export function partThickness(mesh: PartCheckMesh): ThicknessResult {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  // The BVH reorders its index in place: a copy, so the mesh's own triangles (and the face ids
  // that follow their order) stay as they are.
  geometry.setIndex(new BufferAttribute(Uint32Array.from(mesh.indices), 1));
  const bvh = new MeshBVH(geometry);
  const count = mesh.positions.length / 3;
  const values = new Float32Array(count);
  const ray = new Ray();
  const n = new Vector3();
  const self = partCheckLimits.selfHitMm;
  const hits: ReturnType<MeshBVH['raycast']> = [];
  let min: ThicknessResult['min'];
  let max: ThicknessResult['max'];
  let missing = 0;
  const at = (i: number): [number, number, number] => [
    mesh.origin[0] + mesh.positions[i * 3]!,
    mesh.origin[1] + mesh.positions[i * 3 + 1]!,
    mesh.origin[2] + mesh.positions[i * 3 + 2]!,
  ];
  for (let i = 0; i < count; i++) {
    n.fromArray(mesh.normals, i * 3);
    if (n.lengthSq() === 0) {
      values[i] = NaN;
      missing++;
      continue;
    }
    n.normalize().negate();
    ray.origin.fromArray(mesh.positions, i * 3);
    ray.direction.copy(n);
    hits.length = 0;
    hits.push(...bvh.raycast(ray, DoubleSide, 0, Infinity));
    let hit: (typeof hits)[number] | undefined;
    for (const h of hits) {
      const f = h.face;
      if (!f || f.a === i || f.b === i || f.c === i || h.distance < self) continue;
      if (!hit || h.distance < hit.distance) hit = h;
    }
    if (!hit) {
      values[i] = NaN;
      missing++;
      continue;
    }
    const mm = hit.distance;
    values[i] = mm;
    if (!min || mm < min.mm) min = { mm, at: at(i) };
    if (!max || mm > max.mm) max = { mm, at: at(i) };
  }
  geometry.dispose();
  return { values, ...(min ? { min } : {}), ...(max ? { max } : {}), missing };
}

/** The colour of a thickness against the wanted range: thin red, within green, thick blue. */
export function thicknessColor(mm: number, minMm: number, maxMm: number) {
  if (!Number.isFinite(mm)) return [...partCheckColors.none] as [number, number, number];
  return [
    ...(mm < minMm
      ? partCheckColors.thin
      : mm > maxMm
        ? partCheckColors.thick
        : partCheckColors.ok),
  ] as [number, number, number];
}

/**
 * The draft angle at each node to the pull direction `pull` (a unit vector, the way the mould's
 * half moves off the part), in degrees from −90 to 90: 90 a face looking along the pull, 0 a
 * wall along it, negative a face looking against it.
 */
export function partDraft(mesh: PartCheckMesh, pull: readonly [number, number, number]) {
  const d = new Vector3(...pull).normalize();
  const count = mesh.positions.length / 3;
  const values = new Float32Array(count);
  const n = new Vector3();
  for (let i = 0; i < count; i++) {
    n.fromArray(mesh.normals, i * 3);
    const length = n.length();
    values[i] =
      length === 0
        ? NaN
        : (Math.asin(Math.max(-1, Math.min(1, n.dot(d) / length))) * 180) / Math.PI;
  }
  return values;
}

/** A wall along the pull (no draft at all, within float rounding). */
const noDraft = (deg: number) => Math.abs(deg) < 1e-6;
/**
 * The class of a draft angle. In one half (not `split`), a face looking against the pull is an
 * undercut whatever the smallest draft: a larger minimum never hides one. Otherwise a draft
 * under the smallest one, or no draft at all (even when 0° is allowed), is too small.
 */
function draftClass(deg: number, minDeg: number, split: boolean): keyof DraftSummary {
  if (noDraft(deg)) return 'tooSmall';
  if (deg < 0 && !split) return 'undercut';
  if (Math.abs(deg) < minDeg) return 'tooSmall';
  return deg > 0 ? 'withPull' : 'againstPull';
}
/**
 * The colour of a draft angle: `split` for a mould in two halves along the pull (both sides of
 * the parting release; only a wall under `minDeg` is too small), otherwise one half moving along
 * the pull (a face looking against it is an undercut).
 */
export function draftColor(deg: number, minDeg: number, split: boolean) {
  const out = Number.isFinite(deg)
    ? partCheckColors[draftClass(deg, minDeg, split)]
    : partCheckColors.none;
  return [...out] as [number, number, number];
}

export interface DraftSummary {
  /** Mesh area (mm²) by class. */
  withPull: number;
  againstPull: number;
  tooSmall: number;
  undercut: number;
}

/** The area of each draft class, each triangle by the mean of its nodes' angles. */
export function draftSummary(
  mesh: PartCheckMesh,
  values: Float32Array,
  minDeg: number,
  split: boolean,
): DraftSummary {
  const out: DraftSummary = { withPull: 0, againstPull: 0, tooSmall: 0, undercut: 0 };
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const { positions: p, indices } = mesh;
  for (let t = 0; t < indices.length; t += 3) {
    const [i, j, k] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const deg = (values[i]! + values[j]! + values[k]!) / 3;
    if (!Number.isFinite(deg)) continue;
    a.fromArray(p, i * 3);
    b.fromArray(p, j * 3).sub(a);
    c.fromArray(p, k * 3).sub(a);
    const area = b.cross(c).length() / 2;
    out[draftClass(deg, minDeg, split)] += area;
  }
  return out;
}

/** Colours (linear RGB, three per node) from per-node values. */
export function partCheckColorsOf(
  values: Float32Array,
  color: (v: number) => [number, number, number],
) {
  const out = new Float32Array(values.length * 3);
  for (let i = 0; i < values.length; i++) out.set(color(values[i]!), i * 3);
  return out;
}
