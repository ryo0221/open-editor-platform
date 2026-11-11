/**
 * R3j-4 (docs/cad/r3-analysis.md, A4-U2): where analysed bodies touch, as bonds to offer. A face
 * of one body whose every sample (the corners and centres of its display triangles) lies within
 * the tolerance of the other body's faces is a candidate to follow them; the candidates of one
 * pair of bodies are offered as one bond. Nothing is bonded until the user takes a candidate.
 *
 * A follower must be a face a bond can make follow: a solid face cannot follow a shell
 * (`bond-kind` in the solver), so a solid face lying on a shell's wall is not offered (bond the
 * shell's rim, or make the other body solid); when both faces lie on each other, the shell's (or
 * else the smaller) follows.
 */
import { topologyRefOf, type CadTopologyTable } from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import {
  freshSimulationId,
  type SimulationBond,
  type SimulationDocument,
  type SimulationTarget,
} from '@editor-platform/simulation-core';

export interface BondCandidateBody {
  bodyId: string;
  /** The body's standard display mesh (its pick table's faces). */
  mesh: CadMesh;
  /** Whether the body is solved as a shell (its idealisation in the study). */
  shell: boolean;
}

export interface BondCandidate {
  follower: { bodyId: string; faces: number[] };
  on: { bodyId: string; faces: number[] };
  /** The largest distance from a follower sample to the faces it follows (mm). */
  gap: number;
  /** The follower faces' area (mm²). */
  area: number;
  /**
   * CR4a: with an allowance, every face of the other body within the widened bounds of a
   * follower face: the faces the exact search measures (the nearest on the display triangles
   * need not be the nearest on the exact surfaces, Codex on #960).
   */
  reach?: number[];
  /**
   * CR5f: a contact. The shell's faces lie on the solid's only in part (a mount on part of a
   * panel's face, neither face wholly on the other): only their nodes within the tolerance follow.
   */
  contact?: true;
  /**
   * CR5f (Codex on #1022): with an allowance, each contact follower face's samples (x, y, z
   * each), in `follower.faces` order: the points the exact search measures.
   */
  samples?: number[][];
}

export interface BondCandidateResult {
  candidates: BondCandidate[];
  /** Touching faces not offered: a solid face on a shell, by body and face. */
  notOffered: { bodyId: string; face: number; onBodyId: string; reason: string }[];
}

/** Samples a follower face may have beyond the tolerance (none: the run refuses a gap). */
const coverage = 1;

interface Face {
  face: number;
  /** World triangles, 9 numbers each. */
  tris: Float64Array;
  samples: Float64Array;
  min: [number, number, number];
  max: [number, number, number];
  area: number;
}

function facesOf(mesh: CadMesh): Face[] {
  const byFace = new Map<number, number[]>();
  const tris = mesh.indices.length / 3;
  for (let t = 0; t < tris; t++) {
    const face = mesh.faceIds[t]! - mesh.faceBase - 1;
    if (face < 0 || face >= mesh.topology.faces.length) continue;
    let list = byFace.get(face);
    if (!list) byFace.set(face, (list = []));
    list.push(t);
  }
  const [ox, oy, oz] = mesh.origin;
  const out: Face[] = [];
  for (const [face, list] of byFace) {
    const tri = new Float64Array(9 * list.length);
    const samples: number[] = [];
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let area = 0;
    list.forEach((t, k) => {
      const c = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const v = mesh.indices[3 * t + a]!;
        const p = [
          mesh.positions[3 * v]! + ox,
          mesh.positions[3 * v + 1]! + oy,
          mesh.positions[3 * v + 2]! + oz,
        ];
        for (let i = 0; i < 3; i++) {
          tri[9 * k + 3 * a + i] = p[i]!;
          c[i]! += p[i]! / 3;
          min[i] = Math.min(min[i]!, p[i]!);
          max[i] = Math.max(max[i]!, p[i]!);
        }
        samples.push(...p);
      }
      samples.push(...c);
      const u = [0, 1, 2].map((i) => tri[9 * k + 3 + i]! - tri[9 * k + i]!);
      const w = [0, 1, 2].map((i) => tri[9 * k + 6 + i]! - tri[9 * k + i]!);
      area +=
        Math.hypot(
          u[1]! * w[2]! - u[2]! * w[1]!,
          u[2]! * w[0]! - u[0]! * w[2]!,
          u[0]! * w[1]! - u[1]! * w[0]!,
        ) / 2;
    });
    out.push({ face, tris: tri, samples: Float64Array.from(samples), min, max, area });
  }
  return out.sort((a, b) => a.face - b.face);
}

/** Distance from p to triangle abc (Ericson 5.1.5, the point's region on the triangle). */
function triangleDistance(p: number[], t: Float64Array, o: number): number {
  const a = [t[o]!, t[o + 1]!, t[o + 2]!];
  const b = [t[o + 3]!, t[o + 4]!, t[o + 5]!];
  const c = [t[o + 6]!, t[o + 7]!, t[o + 8]!];
  const sub = (x: number[], y: number[]) => [x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!];
  const dot = (x: number[], y: number[]) => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const at = (u: number, v: number) => {
    const q = [0, 1, 2].map((i) => a[i]! + u * ab[i]! + v * ac[i]!);
    return Math.hypot(...sub(p, q));
  };
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(1 - w, w);
  }
  const den = 1 / (va + vb + vc);
  return at(vb * den, vc * den);
}

const near = (f: Face, g: Face, tol: number) =>
  [0, 1, 2].every((i) => f.min[i]! <= g.max[i]! + tol && g.min[i]! <= f.max[i]! + tol);

/** The largest distance of f's samples to the faces gs, or Infinity when one is beyond `tol`. */
function lies(f: Face, gs: Face[], tol: number): number {
  let worst = 0;
  let beyond = 0;
  const samples = f.samples.length / 3;
  for (let s = 0; s < samples; s++) {
    const p = [f.samples[3 * s]!, f.samples[3 * s + 1]!, f.samples[3 * s + 2]!];
    let d = Infinity;
    for (const g of gs)
      for (let o = 0; o < g.tris.length && d > 0; o += 9)
        d = Math.min(d, triangleDistance(p, g.tris, o));
    if (d > tol) {
      beyond++;
      if (beyond > (1 - coverage) * samples) return Infinity;
    } else worst = Math.max(worst, d);
  }
  return worst;
}

/**
 * The candidates between every pair of the bodies, within `tolerance` mm of the display
 * triangles. `widen` (CR4a) widens the search between two bodies by how far their triangles
 * may lie off the exact surfaces, so that `exactBondCandidates` sees every face that may touch.
 */
export function bondCandidates(
  bodies: readonly BondCandidateBody[],
  tolerance: number,
  widen?: (body: BondCandidateBody) => number,
  /**
   * CR5f (Codex on #1022): look for contacts on every shell face, also those a whole-face
   * candidate takes here, for a caller whose exact measure may still refuse that candidate.
   */
  everyContact = false,
): BondCandidateResult {
  const tolerance0 = tolerance;
  const widened = widen !== undefined;
  const allowance = widen ?? (() => 0);
  const faces = bodies.map((b) => facesOf(b.mesh));
  const candidates: BondCandidate[] = [];
  const notOffered: BondCandidateResult['notOffered'] = [];
  /** Body index : face of every follower face offered whole. */
  const taken = new Set<string>();
  /** The faces of body `x` lying on body `y`: each with the faces it lies on and its gap. */
  const lying = (x: number, y: number) => {
    const out = new Map<number, { face: Face; on: number[]; gap: number; reach: number[] }>();
    const tolerance = tolerance0 + allowance(bodies[x]!) + allowance(bodies[y]!);
    for (const f of faces[x]!) {
      const close = faces[y]!.filter((g) => near(f, g, tolerance));
      if (!close.length) continue;
      if (!Number.isFinite(lies(f, close, tolerance))) continue;
      // The faces it lies on: the nearest to each triangle's centre (a corner on the edge between
      // two faces would name both), then, for any sample those leave beyond the tolerance, the
      // face nearest it, so that the faces kept cover every sample.
      const on = new Set<number>();
      const point = (s: number) => [
        f.samples[3 * s]!,
        f.samples[3 * s + 1]!,
        f.samples[3 * s + 2]!,
      ];
      const faceDistance = (p: number[], g: Face) => {
        let d = Infinity;
        for (let o = 0; o < g.tris.length && d > 0; o += 9)
          d = Math.min(d, triangleDistance(p, g.tris, o));
        return d;
      };
      /**
       * The face nearest sample s; of faces as near (a corner on the edges of several), the one
       * nearest a point just inside its triangle from it.
       */
      const nearest = (s: number) => {
        const p = point(s);
        const ds = close.map((g) => faceDistance(p, g));
        const best = Math.min(...ds);
        const c = point(4 * Math.floor(s / 4) + 3);
        const inside = p.map((x, i) => x + 0.01 * (c[i]! - x));
        let pick = -1,
          pickD = Infinity;
        close.forEach((g, k) => {
          if (ds[k]! > best + 1e-9) return;
          const d = faceDistance(inside, g);
          if (d < pickD) [pick, pickD] = [g.face, d];
        });
        return pick;
      };
      for (let s = 3; s < f.samples.length / 3; s += 4) {
        const g = nearest(s);
        if (g >= 0) on.add(g);
      }
      const covered = (s: number) =>
        close.some((g) => on.has(g.face) && faceDistance(point(s), g) <= tolerance);
      for (let s = 0; s < f.samples.length / 3; s++)
        if (!covered(s)) {
          const g = nearest(s);
          if (g >= 0) on.add(g);
        }
      const gap = lies(
        f,
        close.filter((g) => on.has(g.face)),
        tolerance,
      );
      if (!Number.isFinite(gap)) continue;
      out.set(f.face, { face: f, on: [...on], gap, reach: close.map((g) => g.face) });
    }
    return out;
  };
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++) {
      const ab = lying(i, j),
        ba = lying(j, i);
      // Faces lying on each other: one follows. The shell's, else the smaller face.
      for (const [a, x] of ab)
        for (const b of x.on) {
          const y = ba.get(b);
          if (!y || !y.on.includes(a)) continue;
          // Widened (CR4a), two of a kind both stay: the exact measure picks (Codex on #960).
          if (widened && bodies[i]!.shell === bodies[j]!.shell) continue;
          const keepA =
            bodies[i]!.shell !== bodies[j]!.shell ? bodies[i]!.shell : x.face.area <= y.face.area;
          if (keepA) ba.delete(b);
          else ab.delete(a);
        }
      for (const [fi, oi, map] of [
        [i, j, ab],
        [j, i, ba],
      ] as const) {
        const offered = [...map.values()].filter((x) => {
          if (bodies[fi]!.shell || !bodies[oi]!.shell) return true;
          notOffered.push({
            bodyId: bodies[fi]!.bodyId,
            face: x.face.face,
            onBodyId: bodies[oi]!.bodyId,
            reason:
              'a solid face cannot follow a shell: bond the shell’s rim, or solve it as a solid',
          });
          return false;
        });
        if (!offered.length) continue;
        for (const x of offered) taken.add(`${fi}:${x.face.face}`);
        candidates.push({
          follower: { bodyId: bodies[fi]!.bodyId, faces: offered.map((x) => x.face.face) },
          on: {
            bodyId: bodies[oi]!.bodyId,
            faces: [...new Set(offered.flatMap((x) => x.on))].sort((p, q) => p - q),
          },
          gap: Math.max(...offered.map((x) => x.gap)),
          area: offered.reduce((s, x) => s + x.face.area, 0),
          ...(widened
            ? { reach: [...new Set(offered.flatMap((x) => x.reach))].sort((p, q) => p - q) }
            : {}),
        });
      }
    }
  // CR5f: a shell face on a solid face in part only (neither wholly on the other), as a contact:
  // at least `contactSamples` points of the shell face within the tolerance of the solid face.
  for (let i = 0; i < bodies.length; i++)
    for (let j = 0; j < bodies.length; j++) {
      if (i === j || !bodies[i]!.shell || bodies[j]!.shell) continue;
      const tolerance = tolerance0 + allowance(bodies[i]!) + allowance(bodies[j]!);
      const follower: number[] = [];
      const samples: number[][] = [];
      const on = new Set<number>();
      let gap = 0,
        area = 0;
      for (const f of faces[i]!) {
        if (!everyContact && taken.has(`${i}:${f.face}`)) continue;
        const points: number[] = [];
        /** The samples on each face of the solid, and the farthest of them. */
        const byFace = new Map<number, { points: number[]; worst: number }>();
        for (const g of faces[j]!) {
          if (!near(f, g, tolerance)) continue;
          // The shell's display triangles can be far larger than the solid face (a 750 mm hat top
          // under an 80 mm bracket): sample those over the face's box on a grid of a twentieth
          // of its diagonal.
          // (Codex on #1022: however small or narrow the face; the grid stays within 400 a
          // direction.)
          // A narrow face is crossed by 4 samples at least, in its own plane: its triangles'
          // least height (a strip's two triangles are as high as it is wide), whatever the
          // face's direction; never finer than a thousandth of its diagonal.
          const diagonal = Math.hypot(...[0, 1, 2].map((a) => g.max[a]! - g.min[a]!));
          let least = Infinity;
          for (let o = 0; o < g.tris.length; o += 9) {
            const c = [0, 1, 2].map((e) =>
              [0, 1, 2].map((a) => g.tris[o + 3 * ((e + 1) % 3) + a]! - g.tris[o + 3 * e + a]!),
            );
            const [u, v] = [c[0]!, c[2]!];
            const twice = Math.hypot(
              u[1]! * v[2]! - u[2]! * v[1]!,
              u[2]! * v[0]! - u[0]! * v[2]!,
              u[0]! * v[1]! - u[1]! * v[0]!,
            );
            const longest = Math.max(...c.map((x) => Math.hypot(...x)));
            if (longest > 0 && twice / longest > 2 * tolerance0)
              least = Math.min(least, twice / longest);
          }
          const step = Math.max(1e-6, diagonal / 1000, Math.min(diagonal / 20, least / 4));
          for (let o = 0; o < f.tris.length; o += 9) {
            const t = f.tris.subarray(o, o + 9);
            if (
              ![0, 1, 2].every(
                (a) =>
                  Math.min(t[a]!, t[a + 3]!, t[a + 6]!) <= g.max[a]! + tolerance &&
                  Math.max(t[a]!, t[a + 3]!, t[a + 6]!) >= g.min[a]! - tolerance,
              )
            )
              continue;
            // Codex on #1022: only the part of the triangle over the solid face's box, so a
            // small mount on a large panel triangle is sampled at its own step: the (u, v) range
            // of the box's corners taken onto the triangle's plane, within the triangle.
            const e1 = [0, 1, 2].map((a) => t[3 + a]! - t[a]!);
            const e2 = [0, 1, 2].map((a) => t[6 + a]! - t[a]!);
            const dot = (x: number[], y: number[]) => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
            const [a11, a12, a22] = [dot(e1, e1), dot(e1, e2), dot(e2, e2)];
            const det = a11 * a22 - a12 * a12;
            if (!(det > 0)) continue;
            let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
            for (let k = 0; k < 8; k++) {
              const w = [0, 1, 2].map(
                (a) => (k & (1 << a) ? g.max[a]! + tolerance : g.min[a]! - tolerance) - t[a]!,
              );
              const [b1, b2] = [dot(w, e1), dot(w, e2)];
              const u = (a22 * b1 - a12 * b2) / det;
              const v = (a11 * b2 - a12 * b1) / det;
              [u0, u1, v0, v1] = [
                Math.min(u0, u),
                Math.max(u1, u),
                Math.min(v0, v),
                Math.max(v1, v),
              ];
            }
            [u0, v0] = [Math.max(0, u0), Math.max(0, v0)];
            [u1, v1] = [Math.min(1, u1), Math.min(1, v1)];
            if (u0 > u1 || v0 > v1) continue;
            const nu = Math.min(400, Math.max(1, Math.ceil(((u1 - u0) * Math.sqrt(a11)) / step)));
            const nv = Math.min(400, Math.max(1, Math.ceil(((v1 - v0) * Math.sqrt(a22)) / step)));
            for (let i = 0; i <= nu; i++)
              for (let k = 0; k <= nv; k++) {
                const u = u0 + ((u1 - u0) * i) / nu;
                const v = v0 + ((v1 - v0) * k) / nv;
                if (u + v > 1 + 1e-12) continue;
                const p = [0, 1, 2].map((a) => t[a]! + u * e1[a]! + v * e2[a]!);
                if (
                  ![0, 1, 2].every(
                    (a) => p[a]! >= g.min[a]! - tolerance && p[a]! <= g.max[a]! + tolerance,
                  )
                )
                  continue;
                let d = Infinity,
                  at = -1;
                for (let q = 0; q < g.tris.length && d > tolerance; q += 9) {
                  const e = triangleDistance(p, g.tris, q);
                  if (e < d) [d, at] = [e, q];
                }
                // Lying on it, not crossing or meeting it along an edge: the faces are parallel.
                if (d <= tolerance && parallel(t, g.tris.subarray(at, at + 9))) {
                  points.push(p[0]!, p[1]!, p[2]!);
                  const own = byFace.get(g.face) ?? { points: [], worst: 0 };
                  own.points.push(p[0]!, p[1]!, p[2]!);
                  own.worst = Math.max(own.worst, d);
                  byFace.set(g.face, own);
                }
              }
          }
        }
        // An area, not a line where the faces only meet: on some one face of the solid
        // (Codex on #1022: separate edge contacts on several faces are no area), at least
        // `contactSamples` samples spread more than twice the asked tolerance (not the display
        // allowance, which would refuse a small mount on a large panel) across the line through
        // the two furthest apart, whatever the face's direction.
        const areas = [...byFace].filter(
          ([, x]) =>
            x.points.length / 3 >= contactSamples && spreadAcross(x.points) > 2 * tolerance0,
        );
        if (!areas.length) continue;
        follower.push(f.face);
        samples.push(points);
        for (const [g, x] of areas) {
          on.add(g);
          gap = Math.max(gap, x.worst);
        }
        area += f.area;
      }
      if (!follower.length) continue;
      candidates.push({
        follower: { bodyId: bodies[i]!.bodyId, faces: follower },
        on: { bodyId: bodies[j]!.bodyId, faces: [...on].sort((p, q) => p - q) },
        gap,
        area,
        contact: true,
        ...(widened ? { samples } : {}),
      });
    }
  return { candidates, notOffered };
}

/**
 * What a taken bond is known by in the candidate list: its follower faces, and for a contact
 * (`contactOn`, the faces it lies on) also the other body. A contact ties its follower faces only
 * where they lie on that body, so another mount on the same panel face is a bond of its own
 * (Codex on #1022).
 */
export function takenBondKey(
  follower: readonly { bodyId: string; face: number }[],
  contactOn?: readonly { bodyId: string; face: number }[],
): string {
  const faces = follower
    .map((f) => `${f.bodyId}:${f.face}`)
    .sort()
    .join();
  return contactOn
    ? `${faces}>${[...new Set(contactOn.map((f) => f.bodyId))].sort().join()}`
    : faces;
}

/**
 * CR5f: how far the points (x, y, z each) spread across a line: the line from the first to the
 * point furthest from it, then the furthest distance from that line (0 for collinear points).
 */
export function spreadAcross(points: readonly number[]): number {
  const n = points.length / 3;
  const at = (k: number) => [points[3 * k]!, points[3 * k + 1]!, points[3 * k + 2]!];
  if (n < 3) return 0;
  const a = at(0);
  let far = 0,
    best = -1;
  for (let k = 1; k < n; k++) {
    const d = Math.hypot(...at(k).map((x, i) => x - a[i]!));
    if (d > best) [best, far] = [d, k];
  }
  if (!(best > 0)) return 0;
  const b = at(far);
  const u = b.map((x, i) => (x - a[i]!) / best);
  let across = 0;
  for (let k = 1; k < n; k++) {
    const w = at(k).map((x, i) => x - a[i]!);
    const along = w[0]! * u[0]! + w[1]! * u[1]! + w[2]! * u[2]!;
    across = Math.max(
      across,
      Math.sqrt(Math.max(0, w[0]! ** 2 + w[1]! ** 2 + w[2]! ** 2 - along ** 2)),
    );
  }
  return across;
}

/** CR5f: whether two triangles (9 numbers each) are parallel, within 10°. */
function parallel(a: Float64Array, b: Float64Array): boolean {
  const normal = (t: Float64Array) => {
    const u = [t[3]! - t[0]!, t[4]! - t[1]!, t[5]! - t[2]!];
    const v = [t[6]! - t[0]!, t[7]! - t[1]!, t[8]! - t[2]!];
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    return n.map((x) => x / l);
  };
  const [m, n] = [normal(a), normal(b)];
  return Math.abs(m[0]! * n[0]! + m[1]! * n[1]! + m[2]! * n[2]!) >= Math.cos((10 * Math.PI) / 180);
}

/** CR5f: the points of a shell face that must lie on a solid face for a contact. */
const contactSamples = 3;

/**
 * A candidate as a bond to add: its faces as targets on each body's result feature (a target on
 * the source body names no body), named after the two bodies, with the tolerance it was found at.
 */
export function candidateBond(
  doc: SimulationDocument,
  candidate: BondCandidate,
  bodies: ReadonlyMap<string, { table: CadTopologyTable; featureId: string; name: string }>,
  tolerance: number,
): SimulationBond {
  const side = ({ bodyId, faces }: BondCandidate['on']): SimulationTarget[] => {
    const b = bodies.get(bodyId);
    if (!b) throw new Error(`no body ${bodyId}`);
    return faces.map((i) => ({
      kind: 'face',
      ref: topologyRefOf(b.table, 'face', i, b.featureId),
      ...(bodyId === doc.source.bodyId ? {} : { body: bodyId }),
    }));
  };
  const name = (id: string) => bodies.get(id)?.name ?? id;
  return {
    id: freshSimulationId(doc, 'bond'),
    name: `${name(candidate.follower.bodyId)} to ${name(candidate.on.bodyId)}`,
    follower: side(candidate.follower),
    on: side(candidate.on),
    tolerance,
    ...(candidate.contact ? { contact: true as const } : {}),
  };
}

/**
 * CR4a (docs/cad/car-design.md, 86A1): the share of a body's bounding-box diagonal its display
 * triangles may lie off its exact surface (the kernel's `meshDeflection.relative`).
 */
export const displayDeflectionShare = 0.001;
/** CR4a: the least deflection the kernel meshes at (its `meshDeflection.minMm`). */
export const displayDeflectionMinMm = 0.001;

/** CR4a: the exact distances from points to one body's faces, one result per query (the kernel). */
export type BondDistanceMeasure = (
  queries: {
    bodyId: string;
    faces: number[];
    points: Float64Array;
    /** Each point first moved to its nearest point on these faces. */
    via?: { bodyId: string; faces: number[] };
  }[],
) => Promise<({ distances: Float64Array } | { code: string })[]>;

/** How far a body's display triangles may lie off its surface (mm). */
export function displayDeflection(mesh: CadMesh): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const a = i % 3;
    min[a] = Math.min(min[a]!, mesh.positions[i]!);
    max[a] = Math.max(max[a]!, mesh.positions[i]!);
  }
  // As the kernel's `displayDeflectionMm`, never below its 0.001 mm (Codex on #960).
  return Math.max(
    displayDeflectionShare * Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!),
    displayDeflectionMinMm,
  );
}

/**
 * CR4a: the candidates measured on the exact surfaces. The display triangles of a large curved
 * body lie up to its deflection off its surface (2–4 mm on a car's skin), so a search on them
 * misses faces that touch within 0.5 mm. The search runs first on the triangles widened by both
 * bodies' deflections; then each follower face is measured by the kernel to each exact face of
 * the other body within those widened bounds (`reach`): its display nodes (which lie on its exact
 * surface) and its triangles' centres taken onto its exact surface (a flat face's interior may
 * leave a curved one where its corners touch it). A face is kept when every point lies within
 * `tolerance` of the nearest of those faces; it follows the faces nearest its triangles' centres
 * (and, for a node those leave beyond the tolerance, its nearest), and the gap is the largest of
 * those distances.
 */
export async function exactBondCandidates(
  bodies: readonly BondCandidateBody[],
  tolerance: number,
  measure: BondDistanceMeasure,
): Promise<BondCandidateResult> {
  const coarse = bondCandidates(bodies, tolerance, (b) => displayDeflection(b.mesh), true);
  const meshOf = new Map(bodies.map((b) => [b.bodyId, b.mesh]));
  // CR5f: a contact is not a whole face within the tolerance: the run ties its nodes that are.
  const byFace = coarse.candidates
    .filter((c) => !c.contact)
    .flatMap((c) =>
      c.follower.faces.map((face) => {
        const mesh = meshOf.get(c.follower.bodyId)!;
        const seen = new Set<number>();
        const centres: number[] = [];
        const at = (v: number, a: number) => mesh.positions[3 * v + a]! + mesh.origin[a]!;
        for (let t = 0; t < mesh.indices.length / 3; t++)
          if (mesh.faceIds[t]! - mesh.faceBase - 1 === face) {
            const vs = [0, 1, 2].map((k) => mesh.indices[3 * t + k]!);
            for (const v of vs) seen.add(v);
            for (let a = 0; a < 3; a++) centres.push(vs.reduce((s, v) => s + at(v, a), 0) / 3);
          }
        const nodes = new Float64Array(3 * seen.size);
        let i = 0;
        for (const v of seen) {
          for (let a = 0; a < 3; a++) nodes[3 * i + a] = at(v, a);
          i++;
        }
        return { candidate: c, face, nodes, centres: Float64Array.from(centres) };
      }),
    );
  const queries: Parameters<BondDistanceMeasure>[0] = byFace.flatMap(
    ({ candidate, face, nodes, centres }) =>
      (candidate.reach ?? candidate.on.faces).flatMap((g) => [
        { bodyId: candidate.on.bodyId, faces: [g], points: nodes },
        {
          bodyId: candidate.on.bodyId,
          faces: [g],
          points: centres,
          via: { bodyId: candidate.follower.bodyId, faces: [face] },
        },
      ]),
  );
  // CR5f (Codex on #1022): each contact face's samples, to each face of the other body it was
  // found on: kept only where enough of them lie within the tolerance on the exact surfaces.
  const contactFaces = coarse.candidates
    .filter((c) => c.contact)
    .flatMap((c) =>
      c.follower.faces.map((face, k) => ({
        candidate: c,
        face,
        points: Float64Array.from(c.samples?.[k] ?? []),
      })),
    );
  // Each sample first taken onto the follower's exact face (Codex on #1022: a curved
  // panel's display triangles lie off it).
  for (const { candidate, face, points } of contactFaces)
    for (const g of candidate.on.faces)
      queries.push({
        bodyId: candidate.on.bodyId,
        faces: [g],
        points,
        via: { bodyId: candidate.follower.bodyId, faces: [face] },
      });
  const results = queries.length ? await measure(queries) : [];
  const kept = new Map<BondCandidate, Map<number, { on: Set<number>; gap: number }>>();
  let q = 0;
  for (const { candidate, face, nodes, centres } of byFace) {
    const targets = candidate.reach ?? candidate.on.faces;
    const count = nodes.length / 3 + centres.length / 3;
    const best = new Float64Array(count).fill(Infinity);
    /** Each target face's distances, nodes then centres. */
    const byTarget = new Map<number, Float64Array>();
    for (const g of targets) {
      const all = new Float64Array(count);
      for (const part of [0, 1]) {
        const r = results[q++];
        if (!r || 'code' in r) throw new Error(r ? r.code : 'face-distance-missing');
        all.set(r.distances, part ? nodes.length / 3 : 0);
      }
      all.forEach((d, k) => (best[k] = Math.min(best[k]!, d)));
      byTarget.set(g, all);
    }
    let gap = 0;
    for (const d of best) gap = Math.max(gap, d);
    if (!(gap <= tolerance)) continue;
    // The faces it follows: the nearest to each triangle's centre (a node on the edge between
    // two faces is as near both), then for any node those leave beyond the tolerance, its nearest.
    const on = new Set<number>();
    const nearestTo = (k: number) => {
      let pick = -1;
      for (const [g, all] of byTarget) if (pick < 0 || all[k]! < byTarget.get(pick)![k]!) pick = g;
      return pick;
    };
    for (let k = nodes.length / 3; k < count; k++) on.add(nearestTo(k));
    for (let k = 0; k < nodes.length / 3; k++)
      if (![...on].some((g) => byTarget.get(g)![k]! <= tolerance)) on.add(nearestTo(k));
    const entry = kept.get(candidate) ?? new Map<number, { on: Set<number>; gap: number }>();
    entry.set(face, { on, gap });
    kept.set(candidate, entry);
  }
  // Faces lying on each other, both kept by the widened search: one follows, the smaller (as
  // `bondCandidates`), now that the exact measure says which of them lie within the tolerance.
  const shellOf = new Map(bodies.map((b) => [b.bodyId, b.shell]));
  for (const [x, xs] of kept)
    for (const [y, ys] of kept) {
      if (x.follower.bodyId !== y.on.bodyId || y.follower.bodyId !== x.on.bodyId) continue;
      if (x.follower.bodyId >= y.follower.bodyId) continue;
      if (shellOf.get(x.follower.bodyId) !== shellOf.get(y.follower.bodyId)) continue;
      for (const [a, fa] of [...xs])
        for (const b of [...fa.on]) {
          const fb = ys.get(b);
          if (!fb || !fb.on.has(a) || !xs.has(a)) continue;
          const keepA =
            faceArea(meshOf.get(x.follower.bodyId)!, a) <=
            faceArea(meshOf.get(y.follower.bodyId)!, b);
          if (keepA) ys.delete(b);
          else xs.delete(a);
        }
    }
  const contactKept = new Map<BondCandidate, Map<number, { on: number[]; gap: number }>>();
  for (const { candidate, face, points } of contactFaces) {
    // On each face of the other body apart (Codex on #1022: edge contacts on several faces are
    // no area): the samples within the tolerance of it, an area of at least `contactSamples`.
    const near: number[] = [];
    let gap = 0;
    for (const g of candidate.on.faces) {
      const r = results[q++];
      if (!r || 'code' in r) throw new Error(r ? r.code : 'face-distance-missing');
      const lying: number[] = [];
      let worst = 0;
      r.distances.forEach((d, k) => {
        if (!(d <= tolerance)) return;
        lying.push(points[3 * k]!, points[3 * k + 1]!, points[3 * k + 2]!);
        worst = Math.max(worst, d);
      });
      if (lying.length / 3 < contactSamples || !(spreadAcross(lying) > 2 * tolerance)) continue;
      near.push(g);
      gap = Math.max(gap, worst);
    }
    if (!near.length) continue;
    const entry = contactKept.get(candidate) ?? new Map<number, { on: number[]; gap: number }>();
    entry.set(face, { on: near, gap });
    contactKept.set(candidate, entry);
  }
  // Codex on #1022: a shell face is a contact only where the exact measure kept no whole-face
  // candidate of it on the same body.
  const wholeOn = new Set<string>();
  for (const [c, faces] of kept)
    for (const f of faces.keys()) wholeOn.add(`${c.follower.bodyId}:${f}:${c.on.bodyId}`);
  return {
    candidates: coarse.candidates.flatMap((candidate) => {
      if (candidate.contact) {
        const { samples: _samples, ...c } = candidate;
        const mesh = meshOf.get(c.follower.bodyId)!;
        const k = contactKept.get(candidate);
        const faces = c.follower.faces.filter(
          (f) => k?.has(f) && !wholeOn.has(`${c.follower.bodyId}:${f}:${c.on.bodyId}`),
        );
        if (!faces.length) return [];
        return [
          {
            ...c,
            follower: { ...c.follower, faces },
            on: {
              ...c.on,
              faces: [...new Set(faces.flatMap((f) => k!.get(f)!.on))].sort((a, b) => a - b),
            },
            gap: Math.max(...faces.map((f) => k!.get(f)!.gap)),
            area: faces.reduce((s, f) => s + faceArea(mesh, f), 0),
          },
        ];
      }
      const { reach: _reach, ...c } = candidate;
      const k = kept.get(candidate);
      if (!k?.size) return [];
      const mesh = meshOf.get(c.follower.bodyId)!;
      const faces = c.follower.faces.filter((f) => k.has(f));
      const on = new Set(faces.flatMap((f) => [...k.get(f)!.on]));
      return [
        {
          ...c,
          follower: { ...c.follower, faces },
          on: { ...c.on, faces: [...on].sort((p, r) => p - r) },
          gap: Math.max(...faces.map((f) => k.get(f)!.gap)),
          area: faces.reduce((sum, f) => sum + faceArea(mesh, f), 0),
        },
      ];
    }),
    notOffered: coarse.notOffered,
  };
}

const areas = new WeakMap<CadMesh, Map<number, number>>();
/** One face's area on its display mesh (mm²). */
function faceArea(mesh: CadMesh, face: number): number {
  let byFace = areas.get(mesh);
  if (!byFace) areas.set(mesh, (byFace = new Map(facesOf(mesh).map((f) => [f.face, f.area]))));
  return byFace.get(face) ?? 0;
}
