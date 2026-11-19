/**
 * CLF4 (docs/cad/car-look-process.md): simple aerodynamic indicators on display meshes, for a
 * body's look before any flow solution (CL-U2: no CFD). Each is geometry only:
 *
 * - the incidence of each node to the flow (the surface facing the oncoming air, running along
 *   it, or turning away from it more steeply than a slope the flow is taken to follow);
 * - where the surface turns away from the flow sharply (a convex bend of small radius along the
 *   flow, or a convex edge between faces), the places a flow is likely to leave the surface;
 * - the frontal area: the shown bodies projected along the flow (their union, on a grid);
 * - the underbody's rise toward the tail (a diffuser's angle).
 *
 * Values depend on how fine the mesh is, as the part checks (`part-checks.ts`). Pure data and
 * Three.js maths; no rendering.
 */
import { Vector3 } from 'three';
import type { PartCheckMesh } from './part-checks';

/** Limits and defaults of the aero settings. */
export const aeroLimits = Object.freeze({
  /** The steepest slope away from the flow it is taken to follow (degrees). */
  slope: [5, 60] as const,
  slopeDefault: 15,
  /** The smallest radius of a bend away from the flow it is taken to follow (mm). */
  radius: [5, 2000] as const,
  radiusDefault: 100,
  /** A node faces the flow above this incidence (degrees). */
  facingDeg: 10,
  /** Nodes closer than this are one place: an edge between faces or bodies (mm). */
  sameMm: 0.5,
  /** Normals across an edge between faces differ by more than this: a sharp edge (degrees). */
  edgeDeg: 20,
  /** An edge of the mesh counts as along the flow when it runs within this of it (cosine). */
  alongCos: 0.7,
  /** The frontal area's grid (mm per cell), and its most cells each way. */
  gridMm: 5,
  gridMax: 2000,
  /** An underside node's normal points down by more than this (cosine to −Z). */
  undersideCos: 0.5,
  /** The underside rises toward the tail by more than this to count as a diffuser (degrees). */
  diffuserMinDeg: 1,
  /** Warnings closer than this along the flow are reported as one spot (mm). */
  spotGapMm: 150,
});

/** Linear RGB (0–1) colours of the aero shading. */
export const aeroColors = Object.freeze({
  facing: [0.96, 0.55, 0.1] as const,
  along: [0.3, 0.69, 0.31] as const,
  away: [0.15, 0.39, 0.92] as const,
  /** A node where the flow is likely to leave the surface (a sharp bend or edge). */
  leaves: [0.86, 0.15, 0.15] as const,
  none: [0.6, 0.64, 0.69] as const,
});

export type AeroFlow = 1 | -1;
export type AeroClass = 'facing' | 'along' | 'away';

/**
 * The incidence of each node to the flow along X (`flow` +1: the air moves toward +X, the car
 * toward −X), in degrees from −90 to 90: 90 a face looking straight into the oncoming air, 0 a
 * surface along the flow, negative one looking away from it (downstream).
 */
export function flowIncidence(mesh: PartCheckMesh, flow: AeroFlow): Float32Array {
  const count = mesh.positions.length / 3;
  const values = new Float32Array(count);
  const n = new Vector3();
  for (let i = 0; i < count; i++) {
    n.fromArray(mesh.normals, i * 3);
    const length = n.length();
    values[i] =
      length === 0
        ? NaN
        : (Math.asin(Math.max(-1, Math.min(1, (-flow * n.x) / length))) * 180) / Math.PI;
  }
  return values;
}

/** The class of an incidence: facing the flow, along it, or away more steeply than `slopeDeg`. */
export function incidenceClass(deg: number, slopeDeg: number): AeroClass {
  if (deg > aeroLimits.facingDeg) return 'facing';
  return deg < -slopeDeg ? 'away' : 'along';
}

/** A place where the flow is likely to leave: its kind and its extent (model mm). */
export interface AeroSpot {
  kind: 'bend' | 'edge';
  x: [number, number];
  z: [number, number];
}

export interface AeroLeaves {
  /** 1 at each node where the flow is likely to leave the surface. */
  flags: Uint8Array;
  /** The flagged nodes gathered along the flow into spots, upstream first. */
  spots: AeroSpot[];
}

/**
 * Where the flow is likely to leave the surface: along each mesh edge running with the flow, a
 * convex bend away from it (the downstream node looking further away, and already away) of a
 * radius under `radiusMm` (the edge's length over the turn of its normals); and at each edge
 * between faces (nodes within `aeroLimits.sameMm` of each other, in one mesh or two, with
 * normals more than `aeroLimits.edgeDeg` apart), a convex edge whose downstream face looks away
 * from the flow. Only the downstream node is flagged: the colours blend across a triangle, and
 * the upstream side of a coarse mesh's last triangle would read as leaving too.
 */
export function flowLeaves(
  mesh: PartCheckMesh,
  incidence: Float32Array,
  flow: AeroFlow,
  radiusMm: number,
): AeroLeaves {
  return flowLeavesOf([mesh], [incidence], flow, radiusMm)[0]!;
}

/** `flowLeaves` over several meshes at once: edges between two bodies count too. */
export function flowLeavesOf(
  meshes: readonly PartCheckMesh[],
  incidences: readonly Float32Array[],
  flow: AeroFlow,
  radiusMm: number,
): AeroLeaves[] {
  const pi = new Vector3();
  const pj = new Vector3();
  const ni = new Vector3();
  const nj = new Vector3();
  const d = new Vector3();
  const all = meshes.map((mesh, m) => {
    const p = mesh.positions;
    const count = p.length / 3;
    // Each node's neighbourhood: the mean of its triangles' centroids (for an edge's convexity).
    // In model mm (the origin added), in double precision: a small part far from the origin
    // keeps its neighbourhoods apart (Codex, #1276).
    const centre = new Float64Array(count * 3);
    const uses = new Uint32Array(count);
    const idx = mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
      for (const v of [a, b, c]) {
        for (let k = 0; k < 3; k++)
          centre[v * 3 + k]! += (p[a * 3 + k]! + p[b * 3 + k]! + p[c * 3 + k]!) / 3;
        uses[v]!++;
      }
    }
    for (let v = 0; v < count; v++)
      if (uses[v])
        for (let k = 0; k < 3; k++)
          centre[v * 3 + k] = centre[v * 3 + k]! / uses[v]! + mesh.origin[k]!;
    return {
      index: m,
      mesh,
      incidence: incidences[m]!,
      centre,
      uses,
      flags: new Uint8Array(count),
      kinds: new Uint8Array(count), // 1 bend, 2 edge
    };
  });
  type One = (typeof all)[number];
  const flag = (o: One, i: number, kind: 1 | 2) => {
    o.flags[i] = 1;
    o.kinds[i] = Math.max(o.kinds[i]!, kind);
  };
  // Bends along the flow, in each mesh.
  for (const o of all) {
    const { positions: p, normals: nrm, indices: idx } = o.mesh;
    const inc = o.incidence;
    const bend = (a: number, b: number) => {
      pi.fromArray(p, a * 3);
      pj.fromArray(p, b * 3);
      d.subVectors(pj, pi);
      const length = d.length();
      if (!(length > 0)) return;
      const along = (flow * d.x) / length;
      if (Math.abs(along) < aeroLimits.alongCos) return;
      // Upstream first.
      const [u, w] = along > 0 ? [a, b] : [b, a];
      if (!(inc[w]! < inc[u]!) || !(inc[w]! < 0)) return;
      ni.fromArray(nrm, u * 3).normalize();
      nj.fromArray(nrm, w * 3).normalize();
      const turn = Math.acos(Math.max(-1, Math.min(1, ni.dot(nj))));
      if (!(turn > 1e-6) || length / turn >= radiusMm) return;
      // Convex: the normals spread apart along the way (from u to w).
      pi.fromArray(p, u * 3);
      pj.fromArray(p, w * 3);
      if (nj.clone().sub(ni).dot(pj.sub(pi)) <= 0) return;
      flag(o, w, 1);
    };
    for (let t = 0; t < idx.length; t += 3) {
      bend(idx[t]!, idx[t + 1]!);
      bend(idx[t + 1]!, idx[t + 2]!);
      bend(idx[t + 2]!, idx[t]!);
    }
  }
  // Edges between faces: nodes within `sameMm` (model mm), found on a grid of that size.
  const size = aeroLimits.sameMm;
  const cells = new Map<string, [One, number][]>();
  const at = (o: One, v: number, k: number) => o.mesh.origin[k]! + o.mesh.positions[v * 3 + k]!;
  for (const o of all)
    for (let v = 0; v < o.uses.length; v++) {
      if (!o.uses[v]) continue;
      const key = [0, 1, 2].map((k) => Math.floor(at(o, v, k) / size)).join(',');
      const list = cells.get(key);
      if (list) list.push([o, v]);
      else cells.set(key, [[o, v]]);
    }
  const edgeCos = Math.cos((aeroLimits.edgeDeg * Math.PI) / 180);
  const ci = new Vector3();
  const cj = new Vector3();
  for (const [key, list] of cells) {
    const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
    const near: [One, number][] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          near.push(...(cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []));
    for (const [oa, a] of list)
      for (const [ob, b] of near) {
        // Each pair once: from the node of the lower (mesh, node) order.
        if (ob.index < oa.index || (ob.index === oa.index && b <= a)) continue;
        const gap = Math.hypot(...[0, 1, 2].map((k) => at(oa, a, k) - at(ob, b, k)));
        if (gap > size) continue;
        ni.fromArray(oa.mesh.normals, a * 3).normalize();
        nj.fromArray(ob.mesh.normals, b * 3).normalize();
        if (ni.dot(nj) > edgeCos) continue;
        ci.fromArray(oa.centre, a * 3);
        cj.fromArray(ob.centre, b * 3);
        // Convex: each face's normal leans toward its own side of the edge.
        if (ni.clone().sub(nj).dot(ci.sub(cj)) <= 0) continue;
        // The downstream face (lower incidence) looks away from the flow.
        const [od, vd] = oa.incidence[a]! < ob.incidence[b]! ? [oa, a] : [ob, b];
        if (!(od.incidence[vd]! < 0)) continue;
        flag(od, vd, 2);
      }
  }
  return all.map((o) => ({ flags: o.flags, spots: spotsOf(o.mesh, o.flags, o.kinds, flow) }));
}

/** Flagged nodes gathered along the flow: one spot per kind and run of nodes close in x. */
function spotsOf(
  mesh: PartCheckMesh,
  flags: Uint8Array,
  kinds: Uint8Array,
  flow: AeroFlow,
): AeroSpot[] {
  const [ox, , oz] = mesh.origin;
  const spots: AeroSpot[] = [];
  for (const [kind, code] of [
    ['bend', 1],
    ['edge', 2],
  ] as const) {
    const nodes: [number, number][] = [];
    for (let v = 0; v < flags.length; v++)
      if (flags[v] && kinds[v] === code)
        nodes.push([ox + mesh.positions[v * 3]!, oz + mesh.positions[v * 3 + 2]!]);
    nodes.sort((a, b) => a[0] - b[0]);
    let spot: AeroSpot | undefined;
    for (const [x, z] of nodes) {
      if (spot && x - spot.x[1] <= aeroLimits.spotGapMm) {
        spot.x[1] = x;
        spot.z = [Math.min(spot.z[0], z), Math.max(spot.z[1], z)];
      } else {
        spot = { kind, x: [x, x], z: [z, z] };
        spots.push(spot);
      }
    }
  }
  return spots.sort((a, b) => flow * (a.x[0] - b.x[0]));
}

/**
 * A sheet's mesh with its normals turned to look away from `centre` (a sheet has no inside, so
 * its normals may point either way): flipped all together when, weighted by area, more of them
 * point toward the centre than away. A closed solid's normals already point out.
 */
export function outwardFrom(
  mesh: PartCheckMesh,
  centre: readonly [number, number, number],
): PartCheckMesh {
  let sum = 0;
  const c = new Vector3();
  const node = new Vector3();
  forTriangles(mesh, (i, j, k, area) => {
    c.set(0, 0, 0);
    node.set(0, 0, 0);
    for (const v of [i, j, k]) {
      c.x += mesh.positions[v * 3]! / 3;
      c.y += mesh.positions[v * 3 + 1]! / 3;
      c.z += mesh.positions[v * 3 + 2]! / 3;
      node.x += mesh.normals[v * 3]!;
      node.y += mesh.normals[v * 3 + 1]!;
      node.z += mesh.normals[v * 3 + 2]!;
    }
    c.x += mesh.origin[0] - centre[0];
    c.y += mesh.origin[1] - centre[1];
    c.z += mesh.origin[2] - centre[2];
    const l = node.length();
    if (l > 0) sum += (area * node.dot(c)) / l;
  });
  if (sum >= 0) return mesh;
  return { ...mesh, normals: mesh.normals.map((x) => -x) };
}

/** The colour of a node: where the flow leaves, else its incidence's class. */
export function aeroColor(deg: number, leaves: boolean, slopeDeg: number) {
  if (leaves) return [...aeroColors.leaves] as [number, number, number];
  if (!Number.isFinite(deg)) return [...aeroColors.none] as [number, number, number];
  return [...aeroColors[incidenceClass(deg, slopeDeg)]] as [number, number, number];
}

/** Mesh area (mm²) by incidence class, each triangle by the mean of its nodes' incidences. */
export function incidenceSummary(
  mesh: PartCheckMesh,
  incidence: Float32Array,
  slopeDeg: number,
): Record<AeroClass, number> {
  const out = { facing: 0, along: 0, away: 0 };
  forTriangles(mesh, (i, j, k, area) => {
    const deg = (incidence[i]! + incidence[j]! + incidence[k]!) / 3;
    if (Number.isFinite(deg)) out[incidenceClass(deg, slopeDeg)] += area;
  });
  return out;
}

function forTriangles(
  mesh: PartCheckMesh,
  each: (i: number, j: number, k: number, area: number, normal: Vector3) => void,
) {
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const { positions: p, indices } = mesh;
  for (let t = 0; t < indices.length; t += 3) {
    const [i, j, k] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    a.fromArray(p, i * 3);
    b.fromArray(p, j * 3).sub(a);
    c.fromArray(p, k * 3).sub(a);
    const n = b.cross(c);
    const area = n.length() / 2;
    if (area > 0) each(i, j, k, area, n.normalize());
  }
}

/**
 * The frontal area (mm²): the meshes projected along X onto the YZ plane, their union counted
 * on a grid of `aeroLimits.gridMm` cells (coarser when the bodies span more than
 * `aeroLimits.gridMax` cells), with the projection's extent. Undefined without triangles.
 */
export function frontalArea(
  meshes: readonly PartCheckMesh[],
): { mm2: number; y: [number, number]; z: [number, number]; cellMm: number } | undefined {
  let [y0, y1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const m of meshes)
    for (let v = 0; v < m.positions.length; v += 3) {
      const y = m.origin[1] + m.positions[v + 1]!;
      const z = m.origin[2] + m.positions[v + 2]!;
      [y0, y1, z0, z1] = [Math.min(y0, y), Math.max(y1, y), Math.min(z0, z), Math.max(z1, z)];
    }
  if (!(y1 >= y0) || !(z1 >= z0)) return undefined;
  const cell = Math.max(
    aeroLimits.gridMm,
    (y1 - y0) / aeroLimits.gridMax,
    (z1 - z0) / aeroLimits.gridMax,
  );
  const ny = Math.max(1, Math.ceil((y1 - y0) / cell));
  const nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  const grid = new Uint8Array(ny * nz);
  for (const m of meshes) {
    const at = (v: number): [number, number] => [
      m.origin[1] + m.positions[v * 3 + 1]!,
      m.origin[2] + m.positions[v * 3 + 2]!,
    ];
    const idx = m.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [at(idx[t]!), at(idx[t + 1]!), at(idx[t + 2]!)];
      const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (det === 0) continue;
      const iy0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - y0) / cell));
      const iy1 = Math.min(ny - 1, Math.floor((Math.max(a[0], b[0], c[0]) - y0) / cell));
      const iz0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - z0) / cell));
      const iz1 = Math.min(nz - 1, Math.floor((Math.max(a[1], b[1], c[1]) - z0) / cell));
      for (let iy = iy0; iy <= iy1; iy++)
        for (let iz = iz0; iz <= iz1; iz++) {
          if (grid[iy * nz + iz]) continue;
          // The cell's centre inside the triangle (either winding).
          const py = y0 + (iy + 0.5) * cell;
          const pz = z0 + (iz + 0.5) * cell;
          const s = ((b[0] - py) * (c[1] - pz) - (c[0] - py) * (b[1] - pz)) / det;
          const u = ((c[0] - py) * (a[1] - pz) - (a[0] - py) * (c[1] - pz)) / det;
          const w = 1 - s - u;
          if (s >= 0 && u >= 0 && w >= 0) grid[iy * nz + iz] = 1;
        }
    }
  }
  let cells = 0;
  for (const g of grid) cells += g;
  return { mm2: cells * cell * cell, y: [y0, y1], z: [z0, z1], cellMm: cell };
}

/**
 * The underside's rise toward the tail (degrees): over triangles looking down (their normal
 * within 60° of −Z) that rise along the flow by more than `aeroLimits.diffuserMinDeg`, the
 * area-weighted mean and the largest angle, their area and their extent along X. Undefined
 * when no underside rises.
 */
export function diffuserAngle(
  mesh: PartCheckMesh,
  flow: AeroFlow,
): { meanDeg: number; maxDeg: number; mm2: number; x: [number, number] } | undefined {
  let [sum, area, max, x0, x1] = [0, 0, 0, Infinity, -Infinity];
  const p = mesh.positions;
  const node = new Vector3();
  forTriangles(mesh, (i, j, k, a, n) => {
    // Outward by the nodes' normals (the triangle's winding may run either way).
    node.fromArray(mesh.normals, i * 3).add(new Vector3().fromArray(mesh.normals, j * 3));
    node.add(new Vector3().fromArray(mesh.normals, k * 3));
    if (node.dot(n) < 0) n.negate();
    if (!(-n.z > aeroLimits.undersideCos)) return;
    const deg = (Math.atan((flow * n.x) / -n.z) * 180) / Math.PI;
    if (!(deg > aeroLimits.diffuserMinDeg)) return;
    sum += deg * a;
    area += a;
    max = Math.max(max, deg);
    for (const v of [i, j, k]) {
      const x = mesh.origin[0] + p[v * 3]!;
      [x0, x1] = [Math.min(x0, x), Math.max(x1, x)];
    }
  });
  return area > 0 ? { meanDeg: sum / area, maxDeg: max, mm2: area, x: [x0, x1] } : undefined;
}
