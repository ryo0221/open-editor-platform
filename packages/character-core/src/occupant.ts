/**
 * CR7d (docs/cad/car-design.md, CR7の分け方): the occupant check of a character seated in a prop
 * (a car). Pure: the figure's posed meshes and the props' meshes, all in character space (mm,
 * z up), give
 *
 * - the figure's interference with each prop piece (MR3's `checkInterference`, each shell of the
 *   figure a body of one group, the pieces another group, so neither is checked within itself);
 * - the headroom: from the head's top vertex straight up (+z) to the first prop surface;
 * - the H-point (a point of the seat part) to the hip bone;
 * - the sight line: from the eye along its direction, to the first prop surface it meets (only a
 *   line, no standard is judged).
 *
 * All on the display meshes, so the values are as fine as their tessellation (as MR3).
 */
import {
  checkInterference,
  interferenceWeld,
  type InterferenceBody,
  type InterferenceMesh,
} from '@editor-platform/geometry-core/interference';
import { triangulateFace, type EpmMesh } from '@editor-platform/geometry-mesh';
import { skinMatrices, worldMatrices, type CharacterPose } from './evaluate';
import { transformPoint, type Mat4 } from './math';
import type { CharacterDocument, Vec3 } from './model';

/** A mesh in its own coordinates and the matrix (column-major) into character space. */
export interface OccupantMesh {
  positions: ArrayLike<number>;
  /** Three vertex indices per triangle. */
  indices: ArrayLike<number>;
  /** Identity when absent. */
  matrix?: Mat4;
  /** A sheet's surface (MR3: contains nothing, open shells are not holes). */
  sheet?: boolean;
  /**
   * The solid body it draws, within its piece: the meshes of one body are read as one solid, and
   * separate bodies of a piece each as their own (overlapping bodies do not cancel each other's
   * inside under ray parity). One body for the whole piece when absent.
   */
  body?: string;
}
/** One piece of a prop (one part occurrence), named for the results. */
export interface OccupantPiece {
  id: string;
  meshes: readonly OccupantMesh[];
}
export interface OccupantInput {
  /** The figure's posed meshes. */
  figure: readonly OccupantMesh[];
  /** The head's top vertex (character space). */
  headTop?: Vec3;
  /** The hip bone's position. */
  hip?: Vec3;
  /** The seat's H-point, in character space. */
  hPoint?: Vec3;
  /** The eye and the direction it looks. */
  eye?: { origin: Vec3; direction: Vec3 };
  pieces: readonly OccupantPiece[];
}
export interface OccupantFinding {
  piece: string;
  kind: 'intersect' | 'contain' | 'unknown';
  depthMm: number;
}
export interface OccupantHit {
  piece: string;
  distanceMm: number;
  at: Vec3;
}
export interface OccupantReport {
  interference:
    | {
        status: 'ok';
        findings: OccupantFinding[];
      }
    | { status: 'refused'; code: 'interference-limit'; triangles: number };
  /** Undefined without a head top; `hit` undefined when nothing of the props is above. */
  headroom?: { from: Vec3; hit?: OccupantHit };
  hPoint?: { distanceMm: number; offsetMm: Vec3 };
  sight?: { from: Vec3; to: Vec3; hit?: OccupantHit };
}

/** How far the sight line is drawn when it meets nothing (mm). */
export const occupantSightLengthMm = 5000;

const still = {
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  translationMm: [0, 0, 0] as Vec3,
};

/** A mesh's positions in character space. */
function worldPositions(m: OccupantMesh): ArrayLike<number> {
  const M = m.matrix;
  if (!M) return m.positions;
  const out = new Float64Array(m.positions.length);
  for (let i = 0; i < out.length; i += 3) {
    const [x, y, z] = [m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!];
    out[i] = M[0]! * x + M[4]! * y + M[8]! * z + M[12]!;
    out[i + 1] = M[1]! * x + M[5]! * y + M[9]! * z + M[13]!;
    out[i + 2] = M[2]! * x + M[6]! * y + M[10]! * z + M[14]!;
  }
  return out;
}

/** The first crossing of a ray (unit `d`) with the triangles, beyond `from` (Möller–Trumbore). */
function rayHit(
  pieces: readonly { id: string; meshes: InterferenceMesh[] }[],
  from: Vec3,
  d: Vec3,
  maxMm = Infinity,
): OccupantHit | undefined {
  let best: OccupantHit | undefined;
  let bestT = maxMm;
  for (const p of pieces)
    for (const m of p.meshes) {
      const P = m.positions;
      const I = m.indices;
      for (let t = 0; t + 2 < I.length; t += 3) {
        const a = 3 * I[t]!,
          b = 3 * I[t + 1]!,
          c = 3 * I[t + 2]!;
        const e1 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
        const e2 = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
        const px = d[1] * e2[2]! - d[2] * e2[1]!,
          py = d[2] * e2[0]! - d[0] * e2[2]!,
          pz = d[0] * e2[1]! - d[1] * e2[0]!;
        const det = e1[0]! * px + e1[1]! * py + e1[2]! * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const sx = from[0] - P[a]!,
          sy = from[1] - P[a + 1]!,
          sz = from[2] - P[a + 2]!;
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1[2]! - sz * e1[1]!,
          qy = sz * e1[0]! - sx * e1[2]!,
          qz = sx * e1[1]! - sy * e1[0]!;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const dist = (e2[0]! * qx + e2[1]! * qy + e2[2]! * qz) * inv;
        if (dist < 0 || dist >= bestT) continue;
        bestT = dist;
        best = {
          piece: p.id,
          distanceMm: dist,
          at: [from[0] + d[0] * dist, from[1] + d[1] * dist, from[2] + d[2] * dist],
        };
      }
    }
  return best;
}

/**
 * A triangle list split into its connected shells: triangles sharing a vertex, vertices at one
 * position counted as one (a mesh with hard edges repeats its corners, as MR3 welds them).
 */
function shells(indices: ArrayLike<number>, positions: ArrayLike<number>): number[][] {
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(v, r);
    return r;
  };
  const join = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };
  // Vertices welded as the check welds them (within its weld size): a seam whose repeated
  // corners differ by a rounding stays one shell.
  const welded = interferenceWeld(positions);
  const first = new Map<number, number>();
  for (let t = 0; t < indices.length; t++) {
    const v = indices[t]!;
    const w = welded[v]!;
    const was = first.get(w);
    if (was === undefined) first.set(w, v);
    else join(was, v);
  }
  for (let t = 0; t + 2 < indices.length; t += 3) {
    join(indices[t]!, indices[t + 1]!);
    join(indices[t]!, indices[t + 2]!);
  }
  const out = new Map<number, number[]>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const root = find(indices[t]!);
    let list = out.get(root);
    if (!list) out.set(root, (list = []));
    list.push(indices[t]!, indices[t + 1]!, indices[t + 2]!);
  }
  return [...out.values()];
}

/** Triangles over their own vertices only (their bounds are their own, not the buffer's). */
function compact(positions: ArrayLike<number>, indices: ArrayLike<number>) {
  const at = new Map<number, number>();
  const out: number[] = [];
  const remapped = Array.from(indices, (v) => {
    let n = at.get(v);
    if (n === undefined) {
      at.set(v, (n = at.size));
      out.push(positions[3 * v]!, positions[3 * v + 1]!, positions[3 * v + 2]!);
    }
    return n;
  });
  return { positions: new Float64Array(out), indices: remapped };
}

const unit = (v: Vec3): Vec3 | undefined => {
  const n = Math.hypot(...v);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : undefined;
};

/** The occupant check (see the module comment). */
export function occupantCheck(input: OccupantInput): OccupantReport {
  const pieces = input.pieces.map((p) => ({
    id: p.id,
    // Each mesh over its own vertices only: a body's bounds are its own, not those of a buffer
    // it shares with other bodies (a view may keep one vertex buffer for a part's bodies).
    meshes: p.meshes.map((m) => {
      const own = compact(m.positions, m.indices);
      return {
        positions: worldPositions({ ...m, positions: own.positions }),
        indices: own.indices,
        ...(m.sheet ? { sheet: true } : {}),
      };
    }),
  }));
  // Each connected shell of the figure its own body (one group): overlapping limbs stay solids
  // of their own, not one body whose shells cancel each other's inside (MR3's ray parity).
  const figureGroup = '\u0000figure';
  const figure: InterferenceBody[] = input.figure.flatMap((m, i) => {
    const positions = worldPositions(m);
    return shells(m.indices, positions).map((indices, j) => ({
      id: `${figureGroup}:${i}:${j}`,
      meshes: [compact(positions, indices)],
      pose: still,
      group: figureGroup,
    }));
  });
  // Each piece split by its bodies (one group: a piece's bodies, and pieces, are not checked
  // against each other), mapped back to the piece for the findings.
  const pieceOf = new Map<string, string>();
  const props: InterferenceBody[] = pieces.flatMap((p, i) => {
    const byBody = new Map<string, (typeof p.meshes)[number][]>();
    p.meshes.forEach((m, k) => {
      const key = input.pieces[i]!.meshes[k]!.body ?? '';
      let list = byBody.get(key);
      if (!list) byBody.set(key, (list = []));
      list.push(m);
    });
    return [...byBody.values()].map((meshes, j) => {
      const id = `\u0000prop:${i}:${j}`;
      pieceOf.set(id, p.id);
      return { id, meshes, pose: still, group: '\u0000props' };
    });
  });
  const bodies: InterferenceBody[] = [...figure, ...props];
  const r = checkInterference(bodies);
  let interference: OccupantReport['interference'];
  if (r.status === 'refused')
    interference = { status: 'refused', code: r.code, triangles: r.triangles };
  else {
    // One finding per piece: the worst kind over the figure's shells, the deepest depth.
    const rank = { intersect: 2, contain: 1, unknown: 0 } as const;
    const byPiece = new Map<string, OccupantFinding>();
    for (const f of r.findings) {
      const piece = pieceOf.get(f.a.startsWith(figureGroup) ? f.b : f.a)!;
      const was = byPiece.get(piece);
      byPiece.set(piece, {
        piece,
        kind: was && rank[was.kind] > rank[f.kind] ? was.kind : f.kind,
        depthMm: Math.max(was?.depthMm ?? 0, f.depthMm),
      });
    }
    interference = { status: 'ok', findings: [...byPiece.values()] };
  }
  const report: OccupantReport = { interference };
  if (input.headTop)
    report.headroom = {
      from: input.headTop,
      ...optional('hit', rayHit(pieces, input.headTop, [0, 0, 1])),
    };
  if (input.hPoint && input.hip) {
    const offsetMm: Vec3 = [
      input.hip[0] - input.hPoint[0],
      input.hip[1] - input.hPoint[1],
      input.hip[2] - input.hPoint[2],
    ];
    report.hPoint = { distanceMm: Math.hypot(...offsetMm), offsetMm };
  }
  const d = input.eye && unit(input.eye.direction);
  if (input.eye && d) {
    const from = input.eye.origin;
    const hit = rayHit(pieces, from, d, occupantSightLengthMm);
    const length = hit?.distanceMm ?? occupantSightLengthMm;
    report.sight = {
      from,
      to: [from[0] + d[0] * length, from[1] + d[1] * length, from[2] + d[2] * length],
      ...optional('hit', hit),
    };
  }
  return report;
}

const optional = <K extends string, V>(k: K, v: V | undefined) =>
  (v === undefined ? {} : { [k]: v }) as Partial<Record<K, V>>;

/** Where the occupant check reads the figure: bones by ID, the eye in the head bone's frame. */
export interface OccupantFigureOptions {
  headBone: string;
  hipBone: string;
  /** The eye in the head bone's frame (mm), and the direction it looks in that frame. */
  eye?: { offset: Vec3; direction: Vec3 };
}

/**
 * The figure's side of the check at a pose: every visible part's posed triangles (morphs, then
 * the skin or the part's matrix, as the view draws), the top vertex of what the head bone and its
 * children carry most, the hip bone's position, and the eye. As `characterFrame` in the view.
 */
export function occupantFigure(
  doc: CharacterDocument,
  meshes: ReadonlyMap<string, EpmMesh>,
  pose: CharacterPose,
  options: OccupantFigureOptions,
): Pick<OccupantInput, 'figure' | 'headTop' | 'hip' | 'eye'> {
  const { parts, bones } = worldMatrices(doc, pose);
  const skins = new Map(doc.skins.map((s) => [s.partId, s]));
  // The head bone and the bones under it.
  const head = new Set<string>([options.headBone]);
  for (const s of doc.skeletons)
    for (let grown = true; grown; ) {
      grown = false;
      for (const b of s.bones)
        if (b.parentId && head.has(b.parentId) && !head.has(b.id)) {
          head.add(b.id);
          grown = true;
        }
    }
  const figure: OccupantMesh[] = [];
  let headTop: Vec3 | undefined;
  for (const part of doc.parts) {
    const mesh = meshes.get(part.mesh);
    if (!mesh || !part.visible) continue;
    const base = mesh.positions.slice();
    for (const m of mesh.morphs) {
      const w = pose.morphs.get(m.id) ?? 0;
      if (w) for (let i = 0; i < base.length; i++) base[i] += w * m.deltas[i]!;
    }
    const skin = skins.get(part.id);
    const positions = new Float64Array(base.length);
    const joints = skin ? skinMatrices(skin, mesh, bones) : undefined;
    const w = mesh.weights;
    for (let v = 0; v < base.length / 3; v++) {
      const p: Vec3 = [base[3 * v]!, base[3 * v + 1]!, base[3 * v + 2]!];
      let out: Vec3;
      let top = '';
      if (joints) {
        // A skinned mesh's unweighted vertex stays in character space (as the view draws it).
        out = p;
        if (w && w.offsets[v] !== w.offsets[v + 1]) {
          out = [0, 0, 0];
          let most = -1;
          for (let k = w.offsets[v]!; k < w.offsets[v + 1]!; k++) {
            const q = transformPoint(joints[w.bones[k]!]!, p);
            const s = w.values[k]!;
            out = [out[0] + s * q[0], out[1] + s * q[1], out[2] + s * q[2]];
            if (s > most) [most, top] = [s, mesh.boneIds[w.bones[k]!]!];
          }
        }
      } else out = transformPoint(parts.get(part.id)!, p);
      positions.set(out, 3 * v);
      if (head.has(top) && (!headTop || out[2] > headTop[2])) headTop = out;
    }
    // Faces triangulated as the view draws them (ear clipping keeps concave faces).
    const indices: number[] = [];
    let at = 0;
    for (const n of mesh.faceSizes) {
      for (const k of triangulateFace(mesh, at, n)) indices.push(mesh.faceIndices[at + k]!);
      at += n;
    }
    figure.push({ positions, indices });
  }
  const hipM = bones.get(options.hipBone);
  const headM = bones.get(options.headBone);
  let eye: OccupantInput['eye'];
  if (headM && options.eye) {
    const origin = transformPoint(headM, options.eye.offset);
    const tip = transformPoint(headM, [
      options.eye.offset[0] + options.eye.direction[0],
      options.eye.offset[1] + options.eye.direction[1],
      options.eye.offset[2] + options.eye.direction[2],
    ]);
    eye = { origin, direction: [tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]] };
  }
  return {
    figure,
    ...optional('headTop', headTop),
    ...optional('hip', hipM && ([hipM[12]!, hipM[13]!, hipM[14]!] as Vec3)),
    ...optional('eye', eye),
  };
}
