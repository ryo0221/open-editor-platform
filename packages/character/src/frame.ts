import {
  poseAt,
  skinMatrices,
  worldMatrices,
  type CharacterAction,
  type CharacterDocument,
  type Mat4,
} from '@editor-platform/character-core';
import {
  cornerNormals,
  cornerTangents,
  meshDisplay,
  type EpmMesh,
  type MeshDisplay,
} from '@editor-platform/geometry-mesh';

/** A part's mesh and the triangles drawn for it, prepared once per mesh asset. */
export interface PreparedMesh {
  mesh: EpmMesh;
  display: MeshDisplay;
  /**
   * With UVs, per display corner the tangent (xyz, w handedness) that a normal map is baked
   * against and that the GLB writes (C7d), so the view reads a baked map in the same frame.
   */
  tangents?: Float32Array;
}
export function prepareMesh(mesh: EpmMesh): PreparedMesh {
  const display = meshDisplay(mesh);
  const tangents = mesh.uvs ? cornerTangents(mesh, display.normals) : undefined;
  return { mesh, display, ...(tangents ? { tangents } : {}) };
}

/** One part as drawn at one tick: per display corner, character space (mm, Z-up). */
export interface PartFrame {
  partId: string;
  visible: boolean;
  positions: Float32Array;
  normals: Float32Array;
  /**
   * Per triangle of the display (1 = yes), whether it is drawn through a mirroring matrix (most
   * of its corners): it must be wound the other way to keep its outside facing out. Per triangle,
   * so one reflected limb does not turn the rest of a skin inside out.
   */
  flipped: Uint8Array;
  /** With UVs: per display corner the posed tangent (xyz, w handedness), as `PreparedMesh`. */
  tangents?: Float32Array;
}

/**
 * Every part at `tick` of `action` (or at rest): morphs first, then the skin (glTF's rule, the
 * part's own transform does not move skinned vertices) or the part's world matrix. The same
 * sampling as `character-core`'s `poseAt` and `skinnedPositions`, so the view shows what the
 * tests check.
 */
export function characterFrame(
  doc: CharacterDocument,
  meshes: ReadonlyMap<string, PreparedMesh>,
  action: CharacterAction | null,
  tick: number,
  /** False draws the keys without solving IK (the rest view of mesh editing and painting). */
  ik = true,
): PartFrame[] {
  const pose = poseAt(doc, action, tick);
  const { parts, bones } = worldMatrices(doc, pose, { ik });
  const skins = new Map(doc.skins.map((s) => [s.partId, s]));
  const out: PartFrame[] = [];
  for (const part of doc.parts) {
    const prepared = meshes.get(part.mesh);
    if (!prepared) continue;
    const { mesh, display, tangents: rest } = prepared;
    const base = mesh.positions.slice();
    let morphed = false;
    for (const m of mesh.morphs) {
      const w = pose.morphs.get(m.id) ?? 0;
      if (w) for (let i = 0; i < base.length; i++) base[i] += w * m.deltas[i];
      if (w) morphed = true;
    }
    // A morph can turn faces: their normals come from the morphed shape, before skin or part.
    const source = morphed ? cornerNormals({ ...mesh, positions: base }) : display.normals;
    // The tangents too, so a normal map's frame stays on the morphed faces.
    const restTangents =
      rest && morphed ? cornerTangents({ ...mesh, positions: base }, source)! : rest;
    const skin = skins.get(part.id);
    const blended = vertexMatrices(
      mesh,
      skin ? skinMatrices(skin, mesh, bones) : undefined,
      parts.get(part.id)!,
    );
    const reflected = new Uint8Array(blended.length / 12);
    for (let v = 0; v < reflected.length; v++) if (det3(blended, 12 * v) < 0) reflected[v] = 1;
    const flipped = new Uint8Array(display.indices.length / 3);
    for (let t = 0; t < flipped.length; t++) {
      const i = display.indices;
      const n =
        reflected[display.cornerVertex[i[3 * t]]] +
        reflected[display.cornerVertex[i[3 * t + 1]]] +
        reflected[display.cornerVertex[i[3 * t + 2]]];
      if (n >= 2) flipped[t] = 1;
    }
    const corners = display.cornerVertex.length;
    const positions = new Float32Array(corners * 3);
    const normals = new Float32Array(corners * 3);
    const tangents = rest ? new Float32Array(corners * 4) : undefined;
    for (let c = 0; c < corners; c++) {
      const v = display.cornerVertex[c];
      const m = blended.subarray(12 * v, 12 * v + 12);
      const x = base[3 * v],
        y = base[3 * v + 1],
        z = base[3 * v + 2];
      positions[3 * c] = m[0] * x + m[3] * y + m[6] * z + m[9];
      positions[3 * c + 1] = m[1] * x + m[4] * y + m[7] * z + m[10];
      positions[3 * c + 2] = m[2] * x + m[5] * y + m[8] * z + m[11];
      const nx = source[3 * c],
        ny = source[3 * c + 1],
        nz = source[3 * c + 2];
      // Normals take the inverse transpose (as cofactors: columns b×c, c×a, a×b), so a
      // non-uniform scale keeps them perpendicular; a mirroring matrix keeps them outward.
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = m;
      const bcx = by * cz - bz * cy,
        bcy = bz * cx - bx * cz,
        bcz = bx * cy - by * cx;
      const cax = cy * az - cz * ay,
        cay = cz * ax - cx * az,
        caz = cx * ay - cy * ax;
      const abx = ay * bz - az * by,
        aby = az * bx - ax * bz,
        abz = ax * by - ay * bx;
      const sign = ax * bcx + ay * bcy + az * bcz < 0 ? -1 : 1;
      const ox = sign * (bcx * nx + cax * ny + abx * nz),
        oy = sign * (bcy * nx + cay * ny + aby * nz),
        oz = sign * (bcz * nx + caz * ny + abz * nz);
      const len = Math.hypot(ox, oy, oz) || 1;
      normals[3 * c] = ox / len;
      normals[3 * c + 1] = oy / len;
      normals[3 * c + 2] = oz / len;
      if (restTangents && tangents) {
        // Tangents follow the surface (the matrix itself); a mirroring matrix flips handedness.
        const tx = restTangents[4 * c],
          ty = restTangents[4 * c + 1],
          tz = restTangents[4 * c + 2];
        const qx = ax * tx + bx * ty + cx * tz,
          qy = ay * tx + by * ty + cy * tz,
          qz = az * tx + bz * ty + cz * tz;
        const tl = Math.hypot(qx, qy, qz) || 1;
        tangents[4 * c] = qx / tl;
        tangents[4 * c + 1] = qy / tl;
        tangents[4 * c + 2] = qz / tl;
        tangents[4 * c + 3] = sign * restTangents[4 * c + 3];
      }
    }
    out.push({
      partId: part.id,
      visible: part.visible,
      positions,
      normals,
      flipped,
      ...(tangents ? { tangents } : {}),
    });
  }
  return out;
}

/** Determinant of the 3 × 3 part of a 3 × 4 column-major matrix stored at `o`. */
function det3(m: Float32Array, o: number): number {
  return (
    m[o] * (m[o + 4] * m[o + 8] - m[o + 5] * m[o + 7]) -
    m[o + 3] * (m[o + 1] * m[o + 8] - m[o + 2] * m[o + 7]) +
    m[o + 6] * (m[o + 1] * m[o + 5] - m[o + 2] * m[o + 4])
  );
}

/**
 * Per mesh vertex, the 3 × 4 matrix (column-major, 12 numbers) that places it: the weighted sum
 * of its joint matrices (linear blend skinning), or the part's world matrix when it has none.
 */
function vertexMatrices(mesh: EpmMesh, joints: Mat4[] | undefined, world: Mat4): Float32Array {
  const n = mesh.positions.length / 3;
  const out = new Float32Array(n * 12);
  const w = mesh.weights;
  const put = (i: number, m: Mat4, s: number) => {
    const o = 12 * i;
    out[o] += s * m[0];
    out[o + 1] += s * m[1];
    out[o + 2] += s * m[2];
    out[o + 3] += s * m[4];
    out[o + 4] += s * m[5];
    out[o + 5] += s * m[6];
    out[o + 6] += s * m[8];
    out[o + 7] += s * m[9];
    out[o + 8] += s * m[10];
    out[o + 9] += s * m[12];
    out[o + 10] += s * m[13];
    out[o + 11] += s * m[14];
  };
  for (let i = 0; i < n; i++) {
    if (!joints || !w || w.offsets[i] === w.offsets[i + 1]) {
      // A skinned mesh's unweighted vertex stays in character space, as glTF draws it.
      put(i, joints ? identity : world, 1);
      continue;
    }
    for (let k = w.offsets[i]; k < w.offsets[i + 1]; k++) put(i, joints[w.bones[k]], w.values[k]);
  }
  return out;
}
const identity: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** The box around every visible part of a frame, or undefined when nothing is shown. */
export function frameBounds(
  frame: readonly PartFrame[],
): [[number, number, number], [number, number, number]] | undefined {
  const lo = [Infinity, Infinity, Infinity] as [number, number, number];
  const hi = [-Infinity, -Infinity, -Infinity] as [number, number, number];
  for (const p of frame) {
    if (!p.visible) continue;
    for (let i = 0; i < p.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p.positions[i + k]);
        hi[k] = Math.max(hi[k], p.positions[i + k]);
      }
  }
  return lo[0] <= hi[0] ? [lo, hi] : undefined;
}
