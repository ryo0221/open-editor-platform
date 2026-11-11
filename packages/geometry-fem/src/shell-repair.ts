import { shellQualityMin, type ShellMesh } from './shell';

/**
 * CR1a (docs/cad/car-design.md): mends the slivers of a shell mesh that the kernel's
 * triangulation leaves where shape edges' chains meet at a shallow angle (the seam ends between
 * section-spline faces of a car skin: chain points about 1 mm apart beside 20–50 mm triangles).
 * Three local steps, each taken only if it raises the worst triangle it touches:
 *
 * - flip an edge inside one shape face (never a chain edge or a face border);
 * - collapse an edge, removing one node onto the other: a node inside a face, or a chain node
 *   next to another node of the same chain; never a chain end, a node of two chains or an open
 *   border node off a chain. The surface moves by at most that edge;
 * - absorb a flat sliver's apex into the chain edge it nearly lies on: the apex moves onto the
 *   chord (by the sliver's height), joins the chain between the edge's ends, the sliver goes and
 *   the triangle across the chain splits in two.
 *
 * A step that would turn a triangle over (its normal past 60° from before), break the mesh's
 * manifold (the link condition) or leave a triangle with no area is refused. Face tags, the
 * winding, thicknesses and the chains carry over; removed nodes leave the node list (indices
 * renumbered, in their old order).
 */
export interface ShellRepair {
  mesh: ShellMesh;
  flips: number;
  collapses: number;
  absorbs: number;
  /** CR5e: nodes moved to their ring's mean inside a flat patch. */
  moves: number;
  /** The triangles (of the repaired mesh) still past `shellQualityMin`. */
  below: number[];
}

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));

/** Below 1: past `shellQualityMin` (by angle or by aspect ratio, whichever is worse). */
function score(P: V3[]): number {
  const l = [0, 1, 2].map((a) => len(sub(P[(a + 1) % 3]!, P[(a + 2) % 3]!)));
  const area = len(cross(sub(P[1]!, P[0]!), sub(P[2]!, P[0]!))) / 2;
  if (!(area > 0)) return 0;
  let smallest = 180;
  for (let a = 0; a < 3; a++) {
    const [x, y, z] = [l[a]!, l[(a + 1) % 3]!, l[(a + 2) % 3]!];
    const c = (y * y + z * z - x * x) / (2 * y * z);
    smallest = Math.min(smallest, (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI);
  }
  const aspect = (Math.max(...l) * (l[0]! + l[1]! + l[2]!)) / (4 * Math.sqrt(3) * area);
  return Math.min(smallest / shellQualityMin.minAngleDeg, shellQualityMin.maxAspect / aspect);
}

/** The cosine a changed triangle's normal must keep with its old one. */
const turnCos = Math.cos(Math.PI / 3);
/** CR5e: how flat a node's triangles must be (normals within 5°) for it to move in their plane. */
const flatCos = Math.cos((5 * Math.PI) / 180);

export function repairShellMesh(mesh: ShellMesh, maxSteps = 10000): ShellRepair {
  const nodeCount = mesh.nodes.length / 3;
  const xyz = Float64Array.from(mesh.nodes);
  const at = (p: number): V3 => [xyz[3 * p]!, xyz[3 * p + 1]!, xyz[3 * p + 2]!];
  const tri: number[][] = [];
  for (let e = 0; e < mesh.triangles.length / 3; e++)
    tri.push([mesh.triangles[3 * e]!, mesh.triangles[3 * e + 1]!, mesh.triangles[3 * e + 2]!]);
  const face = Array.from(mesh.faces);
  const origin = tri.map((_, e) => e);
  const alive = tri.map(() => true);
  const around: Set<number>[] = Array.from({ length: nodeCount }, () => new Set<number>());
  tri.forEach((t, e) => t.forEach((p) => around[p]!.add(e)));

  // Chains as node lists, the chain edges as a set, and the nodes that may not go.
  const key = (p: number, q: number) => (p < q ? p * nodeCount + q : q * nodeCount + p);
  const chains: number[][] = [];
  const chainEdge = new Set<number>();
  const chainsOf: number[] = new Array(nodeCount).fill(0);
  const fixed = new Uint8Array(nodeCount);
  for (let k = 0; k < mesh.shapeEdges; k++) {
    const c = Array.from(
      mesh.edges.nodes.subarray(mesh.edges.offsets[k]!, mesh.edges.offsets[k + 1]!),
    );
    chains.push(c);
    if (!c.length) continue;
    fixed[c[0]!] = fixed[c[c.length - 1]!] = 1;
    for (const p of new Set(c)) chainsOf[p]!++;
    for (let i = 1; i < c.length; i++) chainEdge.add(key(c[i - 1]!, c[i]!));
  }
  // An open border or a non-manifold edge off every chain pins its nodes.
  const edgeUse = new Map<number, number>();
  for (const t of tri)
    for (let a = 0; a < 3; a++) {
      const k = key(t[a]!, t[(a + 1) % 3]!);
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
    }
  for (const [k, n] of edgeUse)
    if (n !== 2 && !chainEdge.has(k)) fixed[Math.floor(k / nodeCount)] = fixed[k % nodeCount] = 1;
  for (let p = 0; p < nodeCount; p++) if (chainsOf[p]! > 1) fixed[p] = 1;

  const pos = (t: number[]) => t.map(at);
  const normal = (t: number[]) => {
    const [a, b, c] = pos(t);
    return cross(sub(b!, a!), sub(c!, a!));
  };
  const scoreOf = (e: number) => score(pos(tri[e]!));
  const thickness = (e: number) => mesh.thickness[origin[e]!]!;
  const shared = (p: number, q: number) => [...around[p]!].filter((e) => around[q]!.has(e));
  const setTri = (e: number, t: number[]) => {
    for (const p of tri[e]!) around[p]!.delete(e);
    tri[e] = t;
    for (const p of t) around[p]!.add(e);
  };
  const addTri = (t: number[], like: number) => {
    const e = tri.length;
    tri.push(t);
    face.push(face[like]!);
    origin.push(origin[like]!);
    alive.push(true);
    for (const p of t) around[p]!.add(e);
  };
  const kill = (e: number) => {
    for (const p of tri[e]!) around[p]!.delete(e);
    alive[e] = false;
  };
  const turned = (n0: V3, n1: V3) => {
    const l0 = len(n0),
      l1 = len(n1);
    return !(l1 > 0) || dot(n0, n1) < turnCos * l0 * l1;
  };
  const ring = (p: number) => {
    const s = new Set<number>();
    for (const e of around[p]!) for (const x of tri[e]!) if (x !== p) s.add(x);
    return s;
  };

  /** Flip edge p–q (of triangle e) if both sides are one face, it is no chain and it helps. */
  const tryFlip = (e: number, p: number, q: number): boolean => {
    if (chainEdge.has(key(p, q))) return false;
    const two = shared(p, q);
    if (two.length !== 2) return false;
    const t2 = two[0] === e ? two[1]! : two[0]!;
    // A flip moves area between the two triangles: only within one face and one thickness.
    if (face[e] !== face[t2] || thickness(e) !== thickness(t2)) return false;
    // Orient e as P → Q → R; t2 then runs Q → P → S.
    const a1 = tri[e]!,
      i = a1.indexOf(p);
    const [P, Q, R] = a1[(i + 1) % 3] === q ? [p, q, a1[(i + 2) % 3]!] : [q, p, a1[(i + 1) % 3]!];
    const S = tri[t2]!.find((x) => x !== P && x !== Q)!;
    if (shared(R, S).length) return false;
    const n1 = [P, S, R],
      n2 = [S, Q, R];
    if (turned(normal(tri[e]!), normal(n1)) || turned(normal(tri[t2]!), normal(n2))) return false;
    const before = Math.min(scoreOf(e), scoreOf(t2));
    const after = Math.min(score(pos(n1)), score(pos(n2)));
    if (!(after > before)) return false;
    setTri(e, n1);
    setTri(t2, n2);
    return true;
  };

  const removed = new Uint8Array(nodeCount);
  /** Collapse node b onto a, if b may go and every triangle it keeps stays sound and gets better. */
  const tryCollapse = (b: number, a: number): boolean => {
    if (fixed[b]) return false;
    const onChain = chainsOf[b]! > 0;
    if (onChain && !chainEdge.has(key(a, b))) return false;
    const gone = shared(a, b);
    if (gone.length === 0 || gone.length > 2) return false;
    // Link condition: a and b share exactly the neighbours of the triangles that go.
    const ra = ring(a),
      rb = ring(b);
    const common = [...rb].filter((x) => x !== a && ra.has(x));
    const opposite = gone.map((e) => tri[e]!.find((x) => x !== a && x !== b)!);
    if (common.length !== opposite.length || common.some((x) => !opposite.includes(x)))
      return false;
    const kept = [...around[b]!].filter((e) => !gone.includes(e));
    // Every node the collapse keeps must keep a triangle: never erase a component's last one.
    const survivors = new Set(gone.flatMap((e) => tri[e]!).filter((x) => x !== b));
    for (const x of survivors)
      if (![...around[x]!].some((e) => !gone.includes(e)) && !(x === a && kept.length))
        return false;
    // The full link condition: no moved triangle may land on a triangle a already has (the
    // vertex links can share an edge, as on a closed tetrahedron, with the common nodes right).
    const corners = (t: number[]) => [...t].sort((x, y) => x - y).join(',');
    const atA = new Set(
      [...around[a]!].filter((e) => !gone.includes(e)).map((e) => corners(tri[e]!)),
    );
    let before = Infinity,
      after = Infinity;
    for (const e of around[b]!) before = Math.min(before, scoreOf(e));
    for (const e of kept) {
      const t = tri[e]!.map((x) => (x === b ? a : x));
      if (turned(normal(tri[e]!), normal(t))) return false;
      const c = corners(t);
      if (atA.has(c)) return false;
      atA.add(c);
      after = Math.min(after, score(pos(t)));
    }
    if (!(after > before)) return false;
    for (const e of gone) kill(e);
    for (const e of kept)
      setTri(
        e,
        tri[e]!.map((x) => (x === b ? a : x)),
      );
    removed[b] = 1;
    if (onChain) {
      // b is no end, so it sits inside its one chain, next to a.
      for (const c of chains) {
        const i = c.indexOf(b);
        if (i >= 0) c.splice(i, 1);
      }
      chainEdge.delete(key(a, b));
      for (const x of rb)
        if (x !== a && chainEdge.has(key(b, x))) {
          chainEdge.delete(key(b, x));
          chainEdge.add(key(a, x));
        }
    }
    return true;
  };

  /**
   * CR5e: on an open border (no triangle across p–q, a sheet's free edge), the apex moves onto
   * the chord and joins the chain; the sliver goes and nothing is split.
   */
  const absorbOnBorder = (e: number, p: number, q: number, r: number): boolean => {
    // r inside the surface: after the sliver goes, p–r and r–q are each one triangle's border.
    if (shared(p, r).length !== 2 || shared(r, q).length !== 2) return false;
    const P = at(p),
      d = sub(at(q), P);
    const u = dot(sub(at(r), P), d) / dot(d, d);
    if (!(u > 0.05 && u < 0.95)) return false;
    const onto: V3 = [P[0] + u * d[0], P[1] + u * d[1], P[2] + u * d[2]];
    const others = [...around[r]!].filter((x) => x !== e);
    if (!others.length) return false;
    const old: V3 = at(r);
    let before = scoreOf(e);
    for (const x of others) before = Math.min(before, scoreOf(x));
    const normals = others.map((x) => normal(tri[x]!));
    xyz.set(onto, 3 * r);
    let after = Infinity,
      ok = true;
    others.forEach((x, i) => {
      if (turned(normals[i]!, normal(tri[x]!))) ok = false;
      after = Math.min(after, scoreOf(x));
    });
    if (!ok || !(after > before)) {
      xyz.set(old, 3 * r);
      return false;
    }
    kill(e);
    for (const c of chains)
      for (let i = 1; i < c.length; i++)
        if (key(c[i - 1]!, c[i]!) === key(p, q)) {
          c.splice(i, 0, r);
          break;
        }
    chainEdge.delete(key(p, q));
    chainEdge.add(key(p, r));
    chainEdge.add(key(r, q));
    chainsOf[r] = 1;
    return true;
  };

  /** Move apex r of flat triangle e onto chain edge p–q and split the triangle across it. */
  const tryAbsorb = (e: number, p: number, q: number): boolean => {
    if (!chainEdge.has(key(p, q))) return false;
    const r = tri[e]!.find((x) => x !== p && x !== q)!;
    if (fixed[r] || chainsOf[r]) return false;
    const two = shared(p, q);
    if (two.length === 1) return absorbOnBorder(e, p, q, r);
    if (two.length !== 2) return false;
    const t2 = two[0] === e ? two[1]! : two[0]!;
    const s = tri[t2]!.find((x) => x !== p && x !== q)!;
    if (s === r || ring(r).has(s)) return false;
    const P = at(p),
      d = sub(at(q), P);
    const u = dot(sub(at(r), P), d) / dot(d, d);
    if (!(u > 0.05 && u < 0.95)) return false;
    const onto: V3 = [P[0] + u * d[0], P[1] + u * d[1], P[2] + u * d[2]];
    // t2 runs Q → P → S (it is wound against e along p–q); r goes between Q and P.
    const b2 = tri[t2]!,
      j = b2.indexOf(p);
    const [Q, Pp, S] = b2[(j + 2) % 3] === q ? [q, p, b2[(j + 1) % 3]!] : [p, q, b2[(j + 2) % 3]!];
    const halves = [
      [Q, r, S],
      [r, Pp, S],
    ];
    const others = [...around[r]!].filter((x) => x !== e);
    const old: V3 = at(r);
    let before = Math.min(scoreOf(e), scoreOf(t2));
    for (const x of others) before = Math.min(before, scoreOf(x));
    const normals = others.map((x) => normal(tri[x]!));
    const n2 = normal(b2);
    xyz.set(onto, 3 * r);
    let after = Infinity,
      ok = true;
    others.forEach((x, i) => {
      if (turned(normals[i]!, normal(tri[x]!))) ok = false;
      after = Math.min(after, scoreOf(x));
    });
    for (const h of halves) {
      if (turned(n2, normal(h))) ok = false;
      after = Math.min(after, score(pos(h)));
    }
    if (!ok || !(after > before)) {
      xyz.set(old, 3 * r);
      return false;
    }
    kill(e);
    setTri(t2, halves[0]!);
    addTri(halves[1]!, t2);
    for (const c of chains)
      for (let i = 1; i < c.length; i++)
        if (key(c[i - 1]!, c[i]!) === key(p, q)) {
          c.splice(i, 0, r);
          break;
        }
    chainEdge.delete(key(p, q));
    chainEdge.add(key(p, r));
    chainEdge.add(key(r, q));
    chainsOf[r] = 1;
    return true;
  };

  /**
   * CR5e: move node p, inside one flat patch (its triangles' normals within `flatCos` of each
   * other, so the move stays on the surface) and on no chain, to its ring's mean in that plane.
   */
  const tryRelax = (p: number): boolean => {
    if (fixed[p] || chainsOf[p]) return false;
    const star = [...around[p]!];
    if (!star.length || star.some((e) => face[e] !== face[star[0]!])) return false;
    const normals = star.map((e) => normal(tri[e]!));
    const n = normals.reduce<V3>((s, x) => {
      const l = len(x);
      return [s[0] + x[0] / l, s[1] + x[1] / l, s[2] + x[2] / l];
    }, [0, 0, 0]);
    const ln = len(n);
    if (!(ln > 0)) return false;
    const unit: V3 = [n[0] / ln, n[1] / ln, n[2] / ln];
    if (normals.some((x) => dot(x, unit) < flatCos * len(x))) return false;
    const r = [...ring(p)];
    const mean = r.reduce<V3>((s, x) => {
      const q = at(x);
      return [s[0] + q[0] / r.length, s[1] + q[1] / r.length, s[2] + q[2] / r.length];
    }, [0, 0, 0]);
    const old = at(p);
    const off = dot(sub(mean, old), unit);
    const onto: V3 = [mean[0] - off * unit[0], mean[1] - off * unit[1], mean[2] - off * unit[2]];
    let before = Infinity;
    for (const e of star) before = Math.min(before, scoreOf(e));
    xyz.set(onto, 3 * p);
    let after = Infinity,
      ok = true;
    star.forEach((e, i) => {
      if (turned(normals[i]!, normal(tri[e]!))) ok = false;
      after = Math.min(after, scoreOf(e));
    });
    if (!ok || !(after > before)) {
      xyz.set(old, 3 * p);
      return false;
    }
    return true;
  };

  let flips = 0,
    collapses = 0,
    absorbs = 0,
    moves = 0,
    steps = 0;
  for (let pass = 0; pass < 8 && steps < maxSteps; pass++) {
    let changed = false;
    for (let e = 0; e < tri.length && steps < maxSteps; e++) {
      if (!alive[e] || scoreOf(e) >= 1) continue;
      const t = tri[e]!;
      // Edges longest first: a flip of the long edge mends a flat (obtuse) sliver.
      const edges = [0, 1, 2]
        .map((i) => [t[i]!, t[(i + 1) % 3]!] as [number, number])
        .sort((x, y) => len(sub(at(y[0]), at(y[1]))) - len(sub(at(x[0]), at(x[1]))));
      const [long, mid, short] = edges as [[number, number], [number, number], [number, number]];
      let step: 'flip' | 'collapse' | 'absorb' | 'move' | undefined;
      if (tryFlip(e, long[0], long[1])) step = 'flip';
      else if (tryCollapse(short[1], short[0]) || tryCollapse(short[0], short[1]))
        step = 'collapse';
      else if (tryAbsorb(e, long[0], long[1])) step = 'absorb';
      else if (tryFlip(e, mid[0], mid[1]) || tryFlip(e, short[0], short[1])) step = 'flip';
      else if (t.some((p) => tryRelax(p))) step = 'move';
      if (!step) continue;
      if (step === 'flip') flips++;
      else if (step === 'collapse') collapses++;
      else if (step === 'move') moves++;
      else absorbs++;
      steps++;
      changed = true;
    }
    if (!changed) break;
  }

  // Renumber: drop dead triangles and removed nodes, keep the rest in their old order.
  const keep: number[] = [];
  tri.forEach((_, e) => {
    if (alive[e]) keep.push(e);
  });
  const used = new Int32Array(nodeCount).fill(-1);
  let next = 0;
  for (let p = 0; p < nodeCount; p++) if (!removed[p]) used[p] = next++;
  const nodes = new Float64Array(3 * next);
  for (let p = 0; p < nodeCount; p++) if (used[p]! >= 0) nodes.set(at(p), 3 * used[p]!);
  const triangles = new Uint32Array(3 * keep.length);
  keep.forEach((e, i) => tri[e]!.forEach((p, a) => (triangles[3 * i + a] = used[p]!)));
  const offsets = new Uint32Array(mesh.shapeEdges + 1);
  const chainNodes: number[] = [];
  chains.forEach((c, k) => {
    offsets[k] = chainNodes.length;
    for (const p of c) chainNodes.push(used[p]!);
  });
  offsets[mesh.shapeEdges] = chainNodes.length;
  const repaired: ShellMesh = {
    nodes,
    triangles,
    thickness: Float64Array.from(keep, (e) => mesh.thickness[origin[e]!]!),
    faces: Int32Array.from(keep, (e) => face[e]!),
    shapeFaces: mesh.shapeFaces,
    shapeEdges: mesh.shapeEdges,
    edges: { offsets, nodes: Uint32Array.from(chainNodes) },
  };
  const below: number[] = [];
  keep.forEach((e, i) => {
    if (scoreOf(e) < 1) below.push(i);
  });
  return { mesh: repaired, flips, collapses, absorbs, moves, below };
}

/**
 * Where the triangles past `shellQualityMin` lie, for a refusal: each one's centroid (mm, one
 * decimal) and shape face tag, the first `max` of them.
 */
export function shellSliverPlaces(mesh: ShellMesh, below: readonly number[], max = 3): string {
  const places = below.slice(0, max).map((e) => {
    const c = [0, 1, 2].map(
      (axis) =>
        [0, 1, 2].reduce((s, a) => s + mesh.nodes[3 * mesh.triangles[3 * e + a]! + axis]!, 0) / 3,
    );
    return `(${c.map((v) => v.toFixed(1)).join(', ')}) mm on face ${mesh.faces[e]}`;
  });
  return places.join('; ') + (below.length > max ? `; ${below.length - max} more` : '');
}

/** ", mended slivers by 2 edge flips, 1 collapse and 0 absorbs" or nothing, for a check's detail. */
export function shellRepairNote(
  repair: Pick<ShellRepair, 'flips' | 'collapses' | 'absorbs'> & { moves?: number },
): string {
  const { flips, collapses, absorbs } = repair;
  const moves = repair.moves ?? 0;
  if (!flips && !collapses && !absorbs && !moves) return '';
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
  if (!moves)
    return `, mended slivers by ${n(flips, 'edge flip')}, ${n(collapses, 'collapse')} and ${n(absorbs, 'chain absorb')}`;
  return `, mended slivers by ${n(flips, 'edge flip')}, ${n(collapses, 'collapse')}, ${n(absorbs, 'chain absorb')} and ${n(moves, 'node move')}`;
}
