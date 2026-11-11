import type { CalculixEquation, CalculixModel, FrdResult } from './calculix';
import { ElasticError, vonMisesOf, type ElasticMaterial } from './elastic';
import { shellBalance, type ShellMesh, type ShellPrepared, type ShellResult } from './shell';

/**
 * R3j-5a (docs/cad/r3-analysis.md, A4): a shell on the reference Host. CalculiX's own 3-node
 * shell (S3) is expanded inside CalculiX into one layer of 6-node wedges, which lock in bending
 * (measured: a 100 × 20 × 1 mm cantilever bends 0.35–0.54 of its 0.95 mm), and CalculiX leaves
 * rotations out of `*EQUATION` on shell nodes, which the bonds (R3j-5b) need. So the editor
 * expands the shell itself, as CalculiX does for its 6-node shell S6: each triangle becomes a
 * 15-node wedge (C3D15) over the wall, its corners at −t/2, 0 and +t/2 along the node normal and
 * its straight mid-edges at −t/2 and +t/2. The Host gets an ordinary solid model; the result is
 * folded back onto the shell's nodes: the translation of the middle node, the rotation from the
 * top and bottom ones, and the stresses of the three layers.
 */
export interface ShellExpansion {
  /** x, y, z per expanded node (mm). */
  nodes: Float64Array;
  /** 15 expanded nodes per triangle, in CalculiX C3D15 order. */
  wedges: Uint32Array;
  /**
   * Bottom (−t/2), middle and top (+t/2) expanded node of each copy of a shell node: the first
   * copy of shell node p is p, the further copies of a creased node (`creases`) follow the
   * mesh's nodes.
   */
  layers: Uint32Array;
  /** Unit normal per copy: the area-weighted mean of its triangles'. */
  normals: Float64Array;
  /** Wall thickness per copy (mm). */
  thickness: Float64Array;
  /** Per triangle side: its two shell nodes, its two copies and its bottom and top expanded nodes. */
  sides: { ends: Uint32Array; copies: Uint32Array; layers: Uint32Array };
  /**
   * CR4f: the nodes on a crease (a triangle beyond 30° from the mean normal, `shellCreaseMinCos`), split into one copy per
   * smooth side. `node` is the shell node of each further copy (copy n + j); `ties` the pairs of
   * copies on the two sides of a crease edge with that edge's unit direction (a, b, x, y, z), whose
   * rotations about it are the same.
   */
  creases: { node: Uint32Array; ties: Float64Array };
}

/** The largest turn between a node's normal and one of its triangles' the wedges accept (60°). */
export const shellExpansionMinCos = 0.5;

/**
 * CR4f: a node splits when one of its triangles turns more than 30° from its mean normal (a
 * single normal there would thin the wall to t cos 30° at a mitred corner: a 90° box corner turns
 * 45°), and two of its triangles are on different sides of the crease when they turn more than
 * 30° from each other across their shared side.
 */
export const shellCreaseMinCos = Math.cos(Math.PI / 6);

interface ShellCopies {
  /** Copies in all (shell nodes first). */
  count: number;
  /** The copy of each triangle's corner. */
  corner: Uint32Array;
  /** Shell node of each further copy. */
  node: Uint32Array;
  /** Unit normal per copy. */
  normals: Float64Array;
  /** (a, b, e) per tie: see `ShellExpansion.creases`. */
  ties: Float64Array;
}

function triangleNormal(mesh: ShellMesh, e: number): [number, number, number] {
  const P = mesh.nodes;
  const [a, b, c] = [0, 1, 2].map((k) => mesh.triangles[3 * e + k]!) as [number, number, number];
  const u = [0, 1, 2].map((i) => P[3 * b + i]! - P[3 * a + i]!);
  const v = [0, 1, 2].map((i) => P[3 * c + i]! - P[3 * a + i]!);
  return [
    u[1]! * v[2]! - u[2]! * v[1]!,
    u[2]! * v[0]! - u[0]! * v[2]!,
    u[0]! * v[1]! - u[1]! * v[0]!,
  ];
}

const cosTo = (w: readonly number[], n: ArrayLike<number>, at: number) =>
  (w[0]! * n[at]! + w[1]! * n[at + 1]! + w[2]! * n[at + 2]!) / Math.hypot(w[0]!, w[1]!, w[2]!);

/**
 * The copies of a shell mesh's nodes: one per node whose triangles all turn up to 30° from its
 * mean normal, else one per smooth side (triangles joined across sides that turn up to 30°).
 * Returns the refusal's text for a node on no triangle and for a side still beyond 60°.
 */
function shellCopies(mesh: ShellMesh): ShellCopies | string {
  const n = mesh.nodes.length / 3;
  const m = mesh.triangles.length / 3;
  const T = mesh.triangles;
  const W = Array.from({ length: m }, (_, e) => triangleNormal(mesh, e));
  const around: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < m; e++) for (let k = 0; k < 3; k++) around[T[3 * e + k]!]!.push(e);
  const normals: number[] = new Array<number>(3 * n).fill(0);
  const corner = new Uint32Array(3 * m);
  for (let e = 0; e < m; e++) for (let k = 0; k < 3; k++) corner[3 * e + k] = T[3 * e + k]!;
  const node: number[] = [];
  const ties: number[] = [];
  const mean = (tris: readonly number[], out: number[], at: number) => {
    const s = [0, 0, 0];
    for (const e of tris) for (let i = 0; i < 3; i++) s[i]! += W[e]![i]!;
    const l = Math.hypot(s[0]!, s[1]!, s[2]!);
    if (!(l > 0)) return false;
    for (let i = 0; i < 3; i++) out[at + i] = s[i]! / l;
    return true;
  };
  const worst = (tris: readonly number[], at: number) => {
    let c = 1,
      e0 = -1;
    for (const e of tris) {
      const ce = cosTo(W[e]!, normals, at);
      if (!(ce >= c)) [c, e0] = [ce, e];
    }
    return { c, e: e0 };
  };
  const turn = (c: number) =>
    `${((Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI).toFixed(1)}°`;
  for (let p = 0; p < n; p++) {
    const tris = around[p]!;
    if (!mean(tris, normals, 3 * p)) return `node ${p} is on no triangle`;
    if (worst(tris, 3 * p).c >= shellCreaseMinCos) continue;
    // The triangles at p by their other corners: those sharing a side p–q.
    const bySide = new Map<number, number[]>();
    for (const e of tris)
      for (let k = 0; k < 3; k++) {
        const q = T[3 * e + k]!;
        if (q !== p) bySide.set(q, [...(bySide.get(q) ?? []), e]);
      }
    const root = new Map(tris.map((e) => [e, e]));
    const find = (e: number): number => {
      while (root.get(e) !== e) e = root.get(e)!;
      return e;
    };
    const unit = (w: readonly number[]) => {
      const l = Math.hypot(w[0]!, w[1]!, w[2]!);
      return w.map((v) => v / l);
    };
    for (const share of bySide.values())
      for (let i = 0; i < share.length; i++)
        for (let j = i + 1; j < share.length; j++) {
          const [a, b] = [unit(W[share[i]!]!), unit(W[share[j]!]!)];
          if (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! >= shellCreaseMinCos)
            root.set(find(share[i]!), find(share[j]!));
        }
    const groups = new Map<number, number[]>();
    for (const e of tris) groups.set(find(e), [...(groups.get(find(e)) ?? []), e]);
    const copyOf = new Map<number, number>();
    let first = true;
    for (const [g, list] of groups) {
      const c = first ? p : n + node.length;
      if (!first) node.push(p);
      first = false;
      copyOf.set(g, c);
      mean(list, normals, 3 * c);
      const w = worst(list, 3 * c);
      if (!(w.c >= shellExpansionMinCos))
        return `node ${p}: triangle ${w.e} turns ${turn(w.c)} from its side's normal (the Host takes up to 60°)`;
      for (const e of list)
        for (let k = 0; k < 3; k++) if (T[3 * e + k] === p) corner[3 * e + k] = c;
    }
    const tied = new Set<string>();
    for (const [q, share] of bySide)
      for (let i = 0; i < share.length; i++)
        for (let j = i + 1; j < share.length; j++) {
          const [a, b] = [copyOf.get(find(share[i]!))!, copyOf.get(find(share[j]!))!];
          const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
          if (a === b || tied.has(key)) continue;
          tied.add(key);
          const d = [0, 1, 2].map((k) => mesh.nodes[3 * q + k]! - mesh.nodes[3 * p + k]!);
          const l = Math.hypot(d[0]!, d[1]!, d[2]!);
          ties.push(Math.min(a, b), Math.max(a, b), d[0]! / l, d[1]! / l, d[2]! / l);
        }
  }
  return {
    count: n + node.length,
    corner,
    node: Uint32Array.from(node),
    normals: Float64Array.from(normals),
    ties: Float64Array.from(ties),
  };
}

/** The sides of the triangles by their corners' copies: key → side, and the copies' pairs. */
function copySides(mesh: ShellMesh, copies: ShellCopies) {
  const C = copies.count;
  const sideOf = new Map<number, number>();
  const pairs: number[] = [];
  for (let e = 0; e < mesh.triangles.length / 3; e++)
    for (let a = 0; a < 3; a++) {
      const p = copies.corner[3 * e + a]!,
        q = copies.corner[3 * e + ((a + 1) % 3)]!;
      const key = Math.min(p, q) * C + Math.max(p, q);
      if (!sideOf.has(key)) {
        sideOf.set(key, pairs.length / 2);
        pairs.push(Math.min(p, q), Math.max(p, q));
      }
    }
  return { sideOf, pairs };
}

/** The expanded size of a shell mesh, for the Host's limits before anything is built. */
export function shellExpansionSize(mesh: ShellMesh): { nodes: number; elements: number } {
  const copies = shellCopies(mesh);
  const elements = mesh.triangles.length / 3;
  if (typeof copies === 'string') {
    // Refused when it is built: counted as one copy per node.
    const n = mesh.nodes.length / 3;
    const sides = new Set<number>();
    for (let e = 0; e < elements; e++)
      for (let a = 0; a < 3; a++) {
        const p = mesh.triangles[3 * e + a]!,
          q = mesh.triangles[3 * e + ((a + 1) % 3)]!;
        sides.add(Math.min(p, q) * n + Math.max(p, q));
      }
    return { nodes: 3 * n + 2 * sides.size, elements };
  }
  return { nodes: 3 * copies.count + copySides(mesh, copies).pairs.length, elements };
}

/**
 * The wedges of a shell mesh. A node whose triangles turn more than 30° from its normal (a crease,
 * CR4f) becomes one copy per smooth side, each with its own normal; `expandShellStudy` ties their
 * translations and their rotations about the crease. Refuses (`host-shell`) a node no triangle
 * uses, one whose triangles differ in thickness, and a side whose triangles still turn more than
 * 60° from its normal.
 */
export function expandShell(mesh: ShellMesh): ShellExpansion {
  const n = mesh.nodes.length / 3;
  const m = mesh.triangles.length / 3;
  const P = mesh.nodes;
  const shellThickness = new Float64Array(n).fill(Number.NaN);
  for (let e = 0; e < m; e++) {
    const t = mesh.thickness[e]!;
    for (let k = 0; k < 3; k++) {
      const p = mesh.triangles[3 * e + k]!;
      if (Number.isNaN(shellThickness[p]!)) shellThickness[p] = t;
      else if (Math.abs(shellThickness[p]! - t) > 1e-9 * Math.max(t, shellThickness[p]!))
        throw new ElasticError(
          'host-shell',
          `node ${p} is on walls of ${shellThickness[p]} and ${t} mm: the Host takes one thickness per node`,
        );
    }
  }
  const copies = shellCopies(mesh);
  if (typeof copies === 'string') throw new ElasticError('host-shell', copies);
  const C = copies.count;
  const shellNode = (c: number) => (c < n ? c : copies.node[c - n]!);
  const normals = copies.normals;
  const thickness = Float64Array.from({ length: C }, (_, c) => shellThickness[shellNode(c)]!);

  const { sideOf, pairs } = copySides(mesh, copies);
  const s = pairs.length / 2;
  const nodes = new Float64Array(3 * (3 * C + 2 * s));
  const layers = new Uint32Array(3 * C);
  for (let c = 0; c < C; c++) {
    const p = shellNode(c);
    for (let k = 0; k < 3; k++) {
      const x = 3 * c + k;
      layers[x] = x;
      const z = ((k - 1) * thickness[c]!) / 2;
      for (let i = 0; i < 3; i++) nodes[3 * x + i] = P[3 * p + i]! + z * normals[3 * c + i]!;
    }
  }
  const sideLayers = new Uint32Array(2 * s);
  for (let k = 0; k < s; k++)
    for (let l = 0; l < 2; l++) {
      const x = 3 * C + 2 * k + l;
      sideLayers[2 * k + l] = x;
      // Straight: the middle of the two corners' nodes of the same layer.
      const a = layers[3 * pairs[2 * k]! + 2 * l]!,
        b = layers[3 * pairs[2 * k + 1]! + 2 * l]!;
      for (let i = 0; i < 3; i++) nodes[3 * x + i] = (nodes[3 * a + i]! + nodes[3 * b + i]!) / 2;
    }
  const wedges = new Uint32Array(15 * m);
  for (let e = 0; e < m; e++) {
    const c = [0, 1, 2].map((k) => copies.corner[3 * e + k]!);
    const side = (a: number, l: number) => {
      const p = c[a]!,
        q = c[(a + 1) % 3]!;
      return sideLayers[2 * sideOf.get(Math.min(p, q) * C + Math.max(p, q))! + l]!;
    };
    wedges.set(
      [
        ...c.map((p) => layers[3 * p]!),
        ...c.map((p) => layers[3 * p + 2]!),
        side(0, 0),
        side(1, 0),
        side(2, 0),
        side(0, 1),
        side(1, 1),
        side(2, 1),
        ...c.map((p) => layers[3 * p + 1]!),
      ],
      15 * e,
    );
  }
  return {
    nodes,
    wedges,
    layers,
    normals,
    thickness,
    sides: {
      ends: Uint32Array.from(pairs, shellNode),
      copies: Uint32Array.from(pairs),
      layers: sideLayers,
    },
    creases: { node: copies.node, ties: copies.ties },
  };
}

/** The copies of each shell node (`ShellExpansion.layers`): the node itself, then its further ones. */
export function shellNodeCopies(expansion: ShellExpansion): readonly (readonly number[])[] {
  const known = nodeCopies.get(expansion);
  if (known) return known;
  const { node } = expansion.creases;
  const n = expansion.layers.length / 3 - node.length;
  const out = Array.from({ length: n }, (_, p) => [p]);
  node.forEach((p, j) => out[p]!.push(n + j));
  nodeCopies.set(expansion, out);
  return out;
}
const nodeCopies = new WeakMap<ShellExpansion, number[][]>();

/**
 * CR4f: the copy of triangle e's corner a (0..2, the mesh's order): its wedge's first three
 * nodes are its corners' bottom layers, copy c's at 3c (`expandShell`).
 */
export function shellCornerCopy(expansion: ShellExpansion, e: number, a: number): number {
  return expansion.wedges[15 * e + a]! / 3;
}

/**
 * A prepared shell study (`prepareShell`) as a solid model on the wedges. A held translation holds
 * the middle node; held rotations (all three, with the translations: `fixed`) hold the top and
 * bottom nodes at u ± t/2 θ × n too. A side whose two corners hold a layer holds it at their mean;
 * one whose corners hold only the middle keeps the mean of its top and bottom there by an
 * equation. Nodal forces go on the middle nodes. The copies of a creased node (CR4f) hold as the
 * node does; equations keep their middles together and their turns n × (u_top − u_bottom) / t
 * the parts of one rotation square to each copy's normal. Refuses (`host-shell`) a node with some of its
 * rotations held but not all of them and its translations.
 */
export function expandShellStudy(
  mesh: ShellMesh,
  expansion: ShellExpansion,
  material: ElasticMaterial,
  prepared: ShellPrepared,
): CalculixModel {
  const n = mesh.nodes.length / 3;
  const { layers, normals, thickness } = expansion;
  const copiesOf = shellNodeCopies(expansion);
  const prescribed = new Map<number, number>();
  for (let p = 0; p < n; p++) {
    const d = [0, 1, 2, 3, 4, 5].map((i) => prepared.prescribed.get(6 * p + i));
    const rotations = d.slice(3).filter((v) => v !== undefined).length;
    const translations = d.slice(0, 3).filter((v) => v !== undefined).length;
    if (rotations && (rotations < 3 || translations < 3))
      throw new ElasticError(
        'host-shell',
        `node ${p} holds ${rotations} of its rotations and ${translations} of its translations: the Host holds rotations only with all of both`,
      );
    for (const c of copiesOf[p]!) {
      for (let i = 0; i < 3; i++) {
        const v = d[i];
        if (v !== undefined) prescribed.set(3 * layers[3 * c + 1]! + i, v);
      }
      if (rotations) {
        const r = d.slice(3) as number[];
        const nn = [0, 1, 2].map((i) => normals[3 * c + i]!);
        const rxn = [
          r[1]! * nn[2]! - r[2]! * nn[1]!,
          r[2]! * nn[0]! - r[0]! * nn[2]!,
          r[0]! * nn[1]! - r[1]! * nn[0]!,
        ];
        const h = thickness[c]! / 2;
        for (let i = 0; i < 3; i++) {
          prescribed.set(3 * layers[3 * c]! + i, d[i]! - h * rxn[i]!);
          prescribed.set(3 * layers[3 * c + 2]! + i, d[i]! + h * rxn[i]!);
        }
      }
    }
  }
  const equations: CalculixEquation[] = [];
  const { copies: sideCopies, layers: sideLayers } = expansion.sides;
  // Side k's component i whose layers' mean the supports already set (held or tied to its held
  // corners), `3k + i`: a crease's mean tie between two such would repeat them (Codex on #962).
  const meanHeld = new Set<number>();
  for (let k = 0; k < sideCopies.length / 2; k++) {
    const a = sideCopies[2 * k]!,
      b = sideCopies[2 * k + 1]!;
    for (let i = 0; i < 3; i++) {
      const at = (p: number, l: number) => prescribed.get(3 * layers[3 * p + l]! + i);
      const bottom = 3 * sideLayers[2 * k]! + i,
        top = 3 * sideLayers[2 * k + 1]! + i;
      const [ab, bb, at2, bt] = [at(a, 0), at(b, 0), at(a, 2), at(b, 2)];
      if (ab !== undefined && bb !== undefined && at2 !== undefined && bt !== undefined) {
        prescribed.set(bottom, (ab + bb) / 2);
        prescribed.set(top, (at2 + bt) / 2);
        meanHeld.add(3 * k + i);
      } else if (at(a, 1) !== undefined && at(b, 1) !== undefined) {
        meanHeld.add(3 * k + i);
        // (top + bottom) / 2 = (middle a + middle b) / 2.
        equations.push([
          [top, 1],
          [bottom, 1],
          [3 * layers[3 * a + 1]! + i, -1],
          [3 * layers[3 * b + 1]! + i, -1],
        ]);
      }
    }
  }
  // CR4f: a creased node's further copies follow its first one's middle.
  for (const list of copiesOf)
    for (const c of list.slice(1))
      for (let i = 0; i < 3; i++) {
        const d = 3 * layers[3 * c + 1]! + i;
        if (!prescribed.has(d))
          equations.push([
            [d, 1],
            [3 * layers[3 * list[0]! + 1]! + i, -1],
          ]);
      }
  // And the two sides of a crease turn alike about it: (u_top − u_bottom) · (d × n) / t, with d
  // the crease line square to both sides' normals (n_a × n_b, along the edge), so a rigid turn θ
  // gives θ · d on both (with the edge itself, θ · e − (θ · n)(n · e) differs where n · e ≠ 0:
  // Codex on #962). A crease side's middles (its own nodes per smooth side, CR4f) are tied too:
  // their layers' mean together, and their turn about the crease alike.
  const dependent = new Set(equations.map((e) => e[0]![0]));
  const unit = (v: number[]) => {
    const l = Math.hypot(v[0]!, v[1]!, v[2]!);
    return l > 0 ? v.map((x) => x / l) : v;
  };
  const crossOf = (a: readonly number[], b: readonly number[]) => [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
  /** Pushes an equation (sum of terms = 0) with its free term of largest weight first. */
  const tie = (row: [number, number][]) => {
    if (row.some(([d]) => prescribed.has(d))) return;
    let best = -1;
    for (let r = 0; r < row.length; r++)
      if (
        !dependent.has(row[r]![0]) &&
        (best < 0 || Math.abs(row[r]![1]) > Math.abs(row[best]![1]))
      )
        best = r;
    if (best < 0) return;
    dependent.add(row[best]![0]);
    equations.push([row[best]!, ...row.filter((_, r) => r !== best)]);
  };
  /** The crease line between normals na and nb, along e (e itself when they are parallel). */
  const creaseLine = (na: readonly number[], nb: readonly number[], e: readonly number[]) => {
    const d = crossOf(na, nb);
    if (!(Math.hypot(d[0]!, d[1]!, d[2]!) > 1e-6)) return e;
    const u = unit(d);
    return u[0]! * e[0]! + u[1]! * e[1]! + u[2]! * e[2]! < 0 ? u.map((x) => -x) : u;
  };
  /** (top − bottom) · (d × n) / t as terms, times `sign`. */
  const turn = (
    top: number,
    bottom: number,
    nn: readonly number[],
    t: number,
    d: readonly number[],
    sign: number,
  ) => {
    const axis = crossOf(d, nn);
    const out: [number, number][] = [];
    for (let i = 0; i < 3; i++) {
      const w = (sign * axis[i]!) / t;
      if (Math.abs(w) < 1e-12) continue;
      out.push([3 * top + i, w], [3 * bottom + i, -w]);
    }
    return out;
  };
  const normalOf = (c: number) => [0, 1, 2].map((i) => normals[3 * c + i]!);
  // A creased node's copies turn as one rotation θ (Codex on #962): each copy's tangential turn
  // n × w (w = (u_top − u_bottom) / t) is θ's part square to its normal. The first copy and the
  // one whose normal parts most from it give θ (with their turns about d = n_1 × n_2 alike); each
  // further copy's two tangential turns are θ's.
  const dotOf = (a: readonly number[], b: readonly number[]) =>
    a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  /** Terms of g · θ, θ from copies c1 and c2 (θ = v1 + n1 (v2 − v1) · e / s², v = n × w). */
  const theta = (c1: number, c2: number, g: readonly number[]) => {
    const [n1, n2] = [normalOf(c1), normalOf(c2)];
    const c = dotOf(n1, n2);
    const e = n1.map((x, i) => x - c * n2[i]!);
    const s2 = 1 - c * c;
    // g · θ = g · v1 + (g · n1)(e · v2 − e · v1) / s², and a · v = a · (n × w) = w · (a × n).
    const k = dotOf(g, n1) / s2;
    const on1 = crossOf(
      g.map((x, i) => x - k * e[i]!),
      n1,
    );
    const on2 = crossOf(
      e.map((x) => k * x),
      n2,
    );
    const out: [number, number][] = [];
    for (const [cp, w] of [
      [c1, on1],
      [c2, on2],
    ] as const)
      for (let i = 0; i < 3; i++) {
        const v = w[i]! / thickness[cp]!;
        if (Math.abs(v) < 1e-12) continue;
        out.push([3 * layers[3 * cp + 2]! + i, v], [3 * layers[3 * cp]! + i, -v]);
      }
    return out;
  };
  for (const list of copiesOf) {
    if (list.length < 2) continue;
    const c1 = list[0]!;
    const n1 = normalOf(c1);
    let c2 = list[1]!;
    for (const c of list.slice(1))
      if (Math.hypot(...crossOf(n1, normalOf(c))) > Math.hypot(...crossOf(n1, normalOf(c2))))
        c2 = c;
    const n2 = normalOf(c2);
    if (!(Math.hypot(...crossOf(n1, n2)) > 1e-6)) continue;
    const d = unit(crossOf(n1, n2));
    const side = (c: number, sign: number) =>
      turn(layers[3 * c + 2]!, layers[3 * c]!, normalOf(c), thickness[c]!, d, sign);
    tie([...side(c2, 1), ...side(c1, -1)]);
    for (const c of list) {
      if (c === c1 || c === c2) continue;
      const n = normalOf(c);
      // Two directions square to the copy's normal.
      const g1 = unit(Math.abs(n[0]!) < 0.9 ? crossOf(n, [1, 0, 0]) : crossOf(n, [0, 1, 0]));
      const g2 = crossOf(n, g1);
      for (const g of [g1, g2]) {
        // g · (n × w) = w · (g × n).
        const own = crossOf(g, n);
        const terms: [number, number][] = [];
        for (let i = 0; i < 3; i++) {
          const v = own[i]! / thickness[c]!;
          if (Math.abs(v) < 1e-12) continue;
          terms.push([3 * layers[3 * c + 2]! + i, v], [3 * layers[3 * c]! + i, -v]);
        }
        tie([...terms, ...theta(c1, c2, g).map(([q, v]) => [q, -v] as [number, number])]);
      }
    }
  }
  // The crease sides: those with the same two shell nodes, tied to the first of them.
  const { ends: sideEnds } = expansion.sides;
  const byEnds = new Map<string, number[]>();
  for (let k = 0; k < sideCopies.length / 2; k++) {
    const key = `${Math.min(sideEnds[2 * k]!, sideEnds[2 * k + 1]!)}:${Math.max(sideEnds[2 * k]!, sideEnds[2 * k + 1]!)}`;
    byEnds.set(key, [...(byEnds.get(key) ?? []), k]);
  }
  // A crease side's layers lie at its corners' mean, so their distance apart sets its normal and
  // thickness (shorter than t where the corners' normals part).
  const across = (k: number) =>
    [0, 1, 2].map(
      (i) =>
        expansion.nodes[3 * sideLayers[2 * k + 1]! + i]! -
        expansion.nodes[3 * sideLayers[2 * k]! + i]!,
    );
  const sideNormal = (k: number) => unit(across(k));
  const sideThickness = (k: number) => Math.hypot(...across(k));
  for (const list of byEnds.values()) {
    if (list.length < 2) continue;
    const k0 = list[0]!;
    const [p, q] = [sideEnds[2 * k0]!, sideEnds[2 * k0 + 1]!];
    const e = unit([0, 1, 2].map((i) => mesh.nodes[3 * q + i]! - mesh.nodes[3 * p + i]!));
    for (const k of list.slice(1)) {
      for (let i = 0; i < 3; i++)
        if (!(meanHeld.has(3 * k + i) && meanHeld.has(3 * k0 + i)))
          tie([
            [3 * sideLayers[2 * k + 1]! + i, 1],
            [3 * sideLayers[2 * k]! + i, 1],
            [3 * sideLayers[2 * k0 + 1]! + i, -1],
            [3 * sideLayers[2 * k0]! + i, -1],
          ]);
      const d = creaseLine(sideNormal(k0), sideNormal(k), e);
      const side = (x: number, sign: number) =>
        turn(sideLayers[2 * x + 1]!, sideLayers[2 * x]!, sideNormal(x), sideThickness(x), d, sign);
      tie([...side(k, 1), ...side(k0, -1)]);
    }
  }
  const force = new Float64Array(expansion.nodes.length);
  for (let p = 0; p < n; p++)
    for (let i = 0; i < 3; i++) force[3 * layers[3 * p + 1]! + i] = prepared.force[6 * p + i]!;
  return {
    nodes: expansion.nodes,
    parts: [{ type: 'wedge15', elements: expansion.wedges, material }],
    prescribed,
    force,
    equations,
  };
}

/**
 * The shell's 6 DOFs per node from its wedges' displacements `U` (x, y, z per expanded node):
 * the middle node's translation and the rotation n × (u_top − u_bottom) / t. A creased node's
 * copies each give the rotation in their own tangent plane; its rotation is the one that fits
 * them all in least squares, (Σ (I − n nᵀ)) θ = Σ θ_c.
 */
export function foldShellDisplacement(
  expansion: ShellExpansion,
  U: ArrayLike<number>,
): Float64Array {
  const { layers, normals, thickness } = expansion;
  const copiesOf = shellNodeCopies(expansion);
  const n = copiesOf.length;
  const out = new Float64Array(6 * n);
  const tangent = (c: number) => {
    const [b, t] = [layers[3 * c]!, layers[3 * c + 2]!];
    const w = [0, 1, 2].map((i) => (U[3 * t + i]! - U[3 * b + i]!) / thickness[c]!);
    const nn = [0, 1, 2].map((i) => normals[3 * c + i]!);
    return [
      nn[1]! * w[2]! - nn[2]! * w[1]!,
      nn[2]! * w[0]! - nn[0]! * w[2]!,
      nn[0]! * w[1]! - nn[1]! * w[0]!,
    ];
  };
  for (let p = 0; p < n; p++) {
    const c = layers[3 * p + 1]!;
    for (let i = 0; i < 3; i++) out[6 * p + i] = U[3 * c + i]!;
    const list = copiesOf[p]!;
    if (list.length === 1) {
      out.set(tangent(p), 6 * p + 3);
      continue;
    }
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const r = [0, 0, 0];
    for (const k of list) {
      const th = tangent(k);
      for (let i = 0; i < 3; i++) {
        r[i]! += th[i]!;
        for (let j = 0; j < 3; j++)
          A[3 * i + j]! += (i === j ? 1 : 0) - normals[3 * k + i]! * normals[3 * k + j]!;
      }
    }
    out.set(solve3(A, r), 6 * p + 3);
  }
  return out;
}

/** x of A x = r for a 3 × 3 A (row major), by Cramer's rule. */
function solve3(A: readonly number[], r: readonly number[]): number[] {
  const det = (M: readonly number[]) =>
    M[0]! * (M[4]! * M[8]! - M[5]! * M[7]!) -
    M[1]! * (M[3]! * M[8]! - M[5]! * M[6]!) +
    M[2]! * (M[3]! * M[7]! - M[4]! * M[6]!);
  const d = det(A);
  return [0, 1, 2].map((k) => det(A.map((v, x) => (x % 3 === k ? r[Math.floor(x / 3)]! : v))) / d);
}

/**
 * The shell result from the Host's `.frd` on the wedges: per shell node the middle node's
 * translation, the rotation n × (u_top − u_bottom) / t (none about the normal: the wedges have no
 * drilling rotation), the three layers' stresses, and the reactions at the held DOFs: the internal
 * forces of the node's three layers and half of each of its sides' (moments about the middle node)
 * less the load. A creased node's copies (CR4f) add up; its stresses are its most stressed copy's.
 */
export function shellResultFromFrd(
  mesh: ShellMesh,
  expansion: ShellExpansion,
  prepared: ShellPrepared,
  frd: FrdResult,
): ShellResult {
  const n = mesh.nodes.length / 3;
  const { layers, thickness, nodes: X } = expansion;
  const U = frd.displacement,
    S = frd.stress,
    F = frd.force;
  const displacement = new Float64Array(6 * n);
  const top = new Float64Array(6 * n),
    middle = new Float64Array(6 * n),
    bottom = new Float64Array(6 * n);
  // Internal force and moment (about the middle node) of each shell node's layers and half sides.
  const internal = new Float64Array(6 * n);
  /** Σ |layer force| per node: the precision the `.frd`'s 6 digits give its sums. */
  const magnitude = new Float64Array(n);
  const addForce = (p: number, x: number, scale: number) => {
    const mid = layers[3 * p + 1]!;
    const r = [0, 1, 2].map((i) => X[3 * x + i]! - X[3 * mid + i]!);
    const f = [0, 1, 2].map((i) => scale * F[3 * x + i]!);
    for (let i = 0; i < 3; i++) internal[6 * p + i]! += f[i]!;
    magnitude[p]! += Math.hypot(f[0]!, f[1]!, f[2]!);
    internal[6 * p + 3]! += r[1]! * f[2]! - r[2]! * f[1]!;
    internal[6 * p + 4]! += r[2]! * f[0]! - r[0]! * f[2]!;
    internal[6 * p + 5]! += r[0]! * f[1]! - r[1]! * f[0]!;
  };
  displacement.set(foldShellDisplacement(expansion, U));
  const copiesOf = shellNodeCopies(expansion);
  for (let p = 0; p < n; p++) {
    // A creased node (CR4f): the stresses of its most stressed copy, the forces of all of them.
    let worst = -1,
      chosen = p;
    for (const k of copiesOf[p]!) {
      const [b, c, t] = [0, 1, 2].map((l) => layers[3 * k + l]!) as [number, number, number];
      for (const x of [b, c, t]) addForce(p, x, 1);
      const v = Math.max(vonMisesOf(S, 6 * t), vonMisesOf(S, 6 * b));
      if (v > worst) [worst, chosen] = [v, k];
    }
    const [b, c, t] = [0, 1, 2].map((l) => layers[3 * chosen + l]!) as [number, number, number];
    top.set(S.subarray(6 * t, 6 * t + 6), 6 * p);
    middle.set(S.subarray(6 * c, 6 * c + 6), 6 * p);
    bottom.set(S.subarray(6 * b, 6 * b + 6), 6 * p);
  }
  const { ends, layers: sideLayers } = expansion.sides;
  for (let k = 0; k < ends.length / 2; k++)
    for (const x of [sideLayers[2 * k]!, sideLayers[2 * k + 1]!]) {
      addForce(ends[2 * k]!, x, 0.5);
      addForce(ends[2 * k + 1]!, x, 0.5);
    }
  const reaction = new Float64Array(6 * n);
  const held = new Set<number>();
  for (const d of prepared.prescribed.keys()) {
    reaction[d] = internal[d]! - prepared.force[d]!;
    held.add(Math.floor(d / 6));
  }
  // The moments of those forces about the centre of the nodes: the moment check's scale likewise.
  const centre = [0, 1, 2].map((i) => {
    let c = 0;
    for (let p = 0; p < n; p++) c += mesh.nodes[3 * p + i]! / n;
    return c;
  });
  let forceScale = 0,
    layerMoments = 0;
  for (const p of held) {
    forceScale += magnitude[p]!;
    const r = Math.hypot(...[0, 1, 2].map((i) => mesh.nodes[3 * p + i]! - centre[i]!));
    layerMoments += (r + thickness[p]! / 2) * magnitude[p]!;
  }
  const balance = shellBalance(mesh.nodes, prepared.force, reaction);
  const vmTop = new Float64Array(n),
    vmBottom = new Float64Array(n),
    vmMax = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    vmTop[p] = vonMisesOf(top, 6 * p);
    vmBottom[p] = vonMisesOf(bottom, 6 * p);
    vmMax[p] = Math.max(vmTop[p]!, vmBottom[p]!);
  }
  return {
    displacement,
    stress: { top, middle, bottom },
    vonMises: { top: vmTop, bottom: vmBottom, max: vmMax },
    reaction,
    ...balance,
    momentScale: Math.max(balance.momentScale, layerMoments),
    forceScale,
    loadChecks: prepared.loadChecks,
    constrainedNodes: prepared.constrainedNodes,
    iterations: 0,
    residual: 0,
    converged: true,
  };
}
