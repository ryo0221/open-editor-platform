/**
 * Three.js objects for instanced solids (docs/cad/r2c-architecture.md, R2bとの境界; first built
 * for CAD assemblies, docs/cad/r2b-assembly.md, Instancing): every instance of one solid shares
 * one set of buffers, drawn as one InstancedMesh per mesh; solids without meshes are boxes from
 * their bounds. Display only: picking returns the instance's path (and, for a pick on the
 * solid's own mesh, that mesh and the instance's frame); a drag moves instances by their
 * matrices only. Domain-free: CAD and bim give their meshes and paths.
 */
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Intersection,
} from 'three';
import type { GeometryVec3 as Vec3 } from '@editor-platform/geometry-core';

/** A triangle mesh in its solid's frame: positions relative to `origin` (mm). */
export interface ViewMesh {
  origin: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}
export interface ViewInstance {
  /** The instance's IDs from the document down (CAD: component IDs; bim: the element ID). */
  path: string[];
  /** Column-major world matrix of the solid's origin (mm). */
  matrix: number[];
  selected: boolean;
}
export interface ViewSolidMesh<M extends ViewMesh = ViewMesh> {
  mesh: M;
  color: string;
  opacity: number;
  sheet: boolean;
}
export interface ViewSolid<M extends ViewMesh = ViewMesh> {
  /** The solid's meshes, or undefined (and no `coarse`) to draw boxes. */
  meshes?: ViewSolidMesh<M>[];
  /**
   * R2b-4 (LOD): coarser meshes of the same solid, for instances small on screen. Display only:
   * a pick on one gives its path but no mesh to pick on.
   */
  coarse?: ViewSolidMesh<M>[];
  /** Box bounds in the solid's own frame. */
  bounds: [Vec3, Vec3];
  /** Why a box is drawn: still evaluating, too large for the budget, or not readable. */
  box?: 'pending' | 'simplified' | 'unavailable';
  /** A reference display (another build): drawn faded. */
  dim?: boolean;
  instances: ViewInstance[];
}
const boxColors = { pending: '#94a3b8', simplified: '#64748b', unavailable: '#dc2626' };
// A light tint: the outline marks the selection, the part keeps its own colour.
const selectedColor = new Color('#d6e2ff');

/** R2b-4: how an instance is drawn, by its size on screen (LOD). */
export type ViewLevel = 'standard' | 'coarse' | 'box';
/**
 * LOD thresholds (px across the screen): the standard mesh from `standardPx`, the coarse one
 * from `coarsePx`, a box below. An instance keeps its level until it passes a threshold by
 * `margin` (× going up, ÷ going down), so it does not flicker at the edge.
 */
export const viewLod = Object.freeze({ standardPx: 64, coarsePx: 8, margin: 1.25 });
/** The level of an instance `px` across the screen that was drawn at `previous`. */
export function lodLevel(px: number, previous?: ViewLevel): ViewLevel {
  const { standardPx, coarsePx, margin } = viewLod;
  const rank = { box: 0, coarse: 1, standard: 2 } as const;
  const was = previous ? rank[previous] : -1;
  const up = (t: number, level: number) =>
    px >= (was >= level ? t / margin : t * (was < 0 ? 1 : margin));
  return up(standardPx, 2) ? 'standard' : up(coarsePx, 1) ? 'coarse' : 'box';
}

function instanced(
  geometry: BufferGeometry,
  material: MeshStandardMaterial | MeshBasicMaterial,
  part: ViewSolid,
  offset: Matrix4,
  source?: ViewMesh,
) {
  const mesh = new InstancedMesh(geometry, material, part.instances.length);
  const base = part.instances.map((inst) => new Matrix4().fromArray(inst.matrix).multiply(offset));
  part.instances.forEach((inst, i) => {
    mesh.setMatrixAt(i, base[i]!);
    mesh.setColorAt(i, inst.selected ? selectedColor : new Color('#ffffff'));
  });
  mesh.userData.paths = part.instances.map((x) => x.path);
  // Each instance's matrix as placed, which a joint drag's preview moves from.
  mesh.userData.base = base;
  if (source) {
    // A pick on the solid's own mesh (a CAD connector, with its pick table) at the instance's frame.
    mesh.userData.mesh = source;
    mesh.userData.frames = part.instances.map((inst) => new Matrix4().fromArray(inst.matrix));
  }
  mesh.computeBoundingSphere();
  return mesh;
}
/** Edges of one shared geometry at every instance (lines are not instanced in three.js). */
function edgesAt(edges: BufferGeometry, part: ViewSolid, offset: Matrix4, opacity: number) {
  return part.instances.map((inst) => {
    const line = new LineSegments(
      edges,
      new LineBasicMaterial({
        color: inst.selected ? '#2563eb' : '#33414f',
        transparent: opacity < 1,
        opacity,
      }),
    );
    line.matrixAutoUpdate = false;
    line.matrix.fromArray(inst.matrix).multiply(offset);
    // An outline is one instance's: a click on it picks that instance, like its surface.
    line.userData.path = inst.path;
    line.userData.base = line.matrix.clone();
    return line;
  });
}

/**
 * One group for all instanced solids; dispose it with `disposeInstances`. `level` (R2b-4, LOD)
 * draws each instance with its solid's standard mesh, its coarse one (without outlines), or as
 * a box in its colour; without it every instance is drawn with the standard mesh.
 */
export function instancesGroup(
  parts: ViewSolid[],
  level?: (part: ViewSolid, instance: ViewInstance, index: number) => ViewLevel,
): Group {
  const group = new Group();
  for (const part of parts) {
    if (!part.instances.length) continue;
    const standard = part.meshes?.length ? part.meshes : undefined;
    const coarse = part.coarse?.length ? part.coarse : undefined;
    if ((part.meshes || part.coarse) && !part.box) {
      // A level whose meshes the solid lacks draws with the other one (a simplified solid may
      // keep its coarse meshes only).
      const by: Record<ViewLevel, ViewInstance[]> = { standard: [], coarse: [], box: [] };
      part.instances.forEach((inst, i) => {
        const l = level?.(part, inst, i) ?? 'standard';
        by[
          l === 'box' ? 'box' : coarse && (l === 'coarse' || !standard) ? 'coarse' : 'standard'
        ].push(inst);
      });
      if (by.standard.length)
        meshesAt(group, { ...part, instances: by.standard }, part.meshes ?? [], true);
      if (by.coarse.length) meshesAt(group, { ...part, instances: by.coarse }, coarse!, false);
      if (by.box.length)
        boxesAt(
          group,
          { ...part, instances: by.box },
          (standard ?? coarse)?.[0]?.color ?? boxColors.simplified,
          true,
        );
      continue;
    }
    boxesAt(group, part, boxColors[part.box ?? 'pending'], false);
  }
  return group;
}
/** One solid's meshes at its instances; `pickable` keeps the mesh for picks on it, and outlines. */
function meshesAt(group: Group, part: ViewSolid, meshes: ViewSolidMesh[], pickable: boolean) {
  for (const { mesh, color, opacity: native, sheet } of meshes) {
    const opacity = native * (part.dim ? 0.45 : 1);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
    geometry.setIndex(new BufferAttribute(mesh.indices, 1));
    const material = new MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.05,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    // Positions are relative to the mesh origin, inside the solid's frame.
    const offset = new Matrix4().makeTranslation(...mesh.origin);
    const source = pickable ? mesh : undefined;
    group.add(instanced(geometry, material, part, offset, source));
    if (sheet)
      group.add(
        instanced(
          geometry,
          Object.assign(material.clone(), {
            side: BackSide,
            color: new Color(color).multiplyScalar(0.55),
          }),
          part,
          offset,
          source,
        ),
      );
    if (pickable) group.add(...edgesAt(new EdgesGeometry(geometry, 25), part, offset, opacity));
  }
}
/**
 * One solid's box at its instances: from its bounds, a faint fill with outlines (still
 * evaluating, simplified, unavailable), or for an instance too small for a mesh (`lod`) a solid
 * box in its colour.
 */
function boxesAt(group: Group, part: ViewSolid, color: string, lod: boolean) {
  const [lo, hi] = part.bounds;
  const size = hi.map((v, k) => Math.max(v - lo[k]!, 0.01)) as Vec3;
  const center = new Matrix4().makeTranslation(
    (lo[0] + hi[0]) / 2,
    (lo[1] + hi[1]) / 2,
    (lo[2] + hi[2]) / 2,
  );
  const box = new BoxGeometry(...size);
  if (lod) {
    group.add(
      instanced(
        box,
        new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0 }),
        part,
        center,
      ),
    );
    return;
  }
  // A faint fill, so a box can be picked and reads as a volume.
  group.add(
    instanced(
      box,
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false }),
      part,
      center,
    ),
  );
  group.add(
    ...edgesAt(new EdgesGeometry(box), part, center, 1).map((l) => {
      (l.material as LineBasicMaterial).color.set(color);
      return l;
    }),
  );
}
/** The path of an instance hit, if the hit is on an instanced solid. */
export function instancePath(hit: Intersection | undefined): string[] | undefined {
  if (!hit) return undefined;
  if (hit.object.userData.path) return hit.object.userData.path as string[];
  if (hit.instanceId === undefined) return undefined;
  return (hit.object.userData.paths as string[][] | undefined)?.[hit.instanceId];
}
/**
 * Shows the instances under `moves` (the first step of their paths) moved by `delta` in
 * document coordinates, or all of them as placed: matrices only, no buffers.
 */
export function poseInstances(
  group: Group,
  moves: ReadonlySet<string>,
  /** One motion for every moved instance, or one per first path step. */
  delta?: Matrix4 | ReadonlyMap<string, Matrix4>,
) {
  const deltaOf = (path: string[] | undefined) =>
    !delta || !path || !moves.has(path[0]!)
      ? undefined
      : delta instanceof Matrix4
        ? delta
        : delta.get(path[0]!);
  for (const o of group.children) {
    const base = o.userData.base as Matrix4[] | Matrix4 | undefined;
    if (!base) continue;
    if (Array.isArray(base)) {
      const mesh = o as InstancedMesh;
      const paths = mesh.userData.paths as string[][];
      const m = new Matrix4();
      base.forEach((b, i) => {
        const d = deltaOf(paths[i]);
        mesh.setMatrixAt(i, d ? m.multiplyMatrices(d, b) : b);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    } else {
      const d = deltaOf(o.userData.path as string[]);
      o.matrix.copy(d ? new Matrix4().multiplyMatrices(d, base) : base);
      o.matrixWorldNeedsUpdate = true;
    }
  }
}
/** The placed matrices of the instances under `moves`: a drag's preview holds while they are. */
export const movedKey = (parts: readonly ViewSolid[], moves: ReadonlySet<string>) =>
  JSON.stringify(
    parts.map((p) => p.instances.filter((i) => moves.has(i.path[0]!)).map((i) => i.matrix)),
  );
/** GPU buffers of the group (each attribute once), for the display budget (CAD26). */
export function instancesBytes(group: Group, seen = new Set<unknown>()) {
  let bytes = 0;
  group.traverse((o) => {
    const g = (o as { geometry?: BufferGeometry }).geometry;
    if (!g) return;
    const arrays = [...Object.values(g.attributes), ...(g.index ? [g.index] : [])].map(
      (a) => a.array,
    );
    const im = o as InstancedMesh;
    if (im.isInstancedMesh)
      arrays.push(im.instanceMatrix.array, ...(im.instanceColor ? [im.instanceColor.array] : []));
    for (const a of arrays)
      if (!seen.has(a)) {
        seen.add(a);
        bytes += (a as unknown as { byteLength: number }).byteLength;
      }
  });
  return bytes;
}
export function disposeInstances(group: Group) {
  const done = new Set<unknown>();
  group.traverse((o) => {
    const x = o as { geometry?: BufferGeometry; material?: { dispose(): void } };
    for (const r of [x.geometry, x.material])
      if (r && !done.has(r)) {
        done.add(r);
        r.dispose();
      }
    if ((o as InstancedMesh).isInstancedMesh) (o as InstancedMesh).dispose();
  });
  group.clear();
}
