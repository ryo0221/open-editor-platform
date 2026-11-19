import type { Vec2, Vec3 } from './model';

/**
 * DW5b (docs/cad/drawing-editor.md): the exact section of a column's solid by a level plane, and
 * of that section by a roof's underside, as closed loops (outer and holes, either way round).
 *
 * The solid is its profile's loops at the base, square to the axis, joined to the same loops,
 * scaled by `topScale`, at the top: each side face is a flat trapezoid (an edge and its scaled
 * copy are parallel) and each end cap is flat. The plane cuts each face it crosses in segments
 * whose ends lie on the face's edges; every crossed edge is shared by exactly two faces, so the
 * segments join into closed loops by those edges. A point on the plane counts as above it,
 * everywhere, so a cap lying in the plane gives one consistent outline (Codex on #1238).
 */
export interface BimColumnAxes {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  /** Unit, base to top. */
  z: Vec3;
  length: number;
}

/** How far below the cutting plane a point still counts as on it (mm, Codex on #1238). */
export const bimSectionSnapMm = 1e-6;

/** Points by key, and links between keys: each key in exactly two links. */
type Graph = { at: Map<string, Vec2>; links: [string, string][] };

/** The loops the links close (undefined when a key is not in exactly two links). */
function walk({ at, links }: Graph): Vec2[][] | undefined {
  const next = new Map<string, string[]>();
  for (const [a, b] of links) {
    if (a === b) continue;
    next.set(a, [...(next.get(a) ?? []), b]);
    next.set(b, [...(next.get(b) ?? []), a]);
  }
  for (const n of next.values()) if (n.length !== 2) return undefined;
  const seen = new Set<string>();
  const loops: Vec2[][] = [];
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const keys = [start];
    seen.add(start);
    let prev = start;
    let cur = next.get(start)![0]!;
    while (cur !== start) {
      if (seen.has(cur)) return undefined;
      seen.add(cur);
      keys.push(cur);
      const [a, b] = next.get(cur)!;
      [prev, cur] = [cur, a === prev ? b! : a!];
    }
    if (keys.length >= 3) loops.push(keys.map((k) => at.get(k)!));
  }
  return loops;
}

/**
 * The section of a tapered (or straight) extruded profile at height `z`: its loops in plan
 * (x, y): none when the solid does not reach the plane; undefined when the cut does not close.
 */
export function bimColumnSection(
  ax: BimColumnAxes,
  topScale: number,
  profile: readonly Vec2[][],
  z: number,
): Vec2[][] | undefined {
  const lift = (p: Vec2, k: number, w: number): Vec3 => [
    ax.origin[0] + ax.z[0] * w + k * (ax.x[0] * p[0] + ax.y[0] * p[1]),
    ax.origin[1] + ax.z[1] * w + k * (ax.x[1] * p[0] + ax.y[1] * p[1]),
    ax.origin[2] + ax.z[2] * w + k * (ax.x[2] * p[0] + ax.y[2] * p[1]),
  ];
  const loops = profile.map((l) => ({
    bottom: l.map((p) => lift(p, 1, 0)),
    top: l.map((p) => lift(p, topScale, ax.length)),
  }));
  // On the plane within a hair (a level's height rebuilt in floating point) counts as on it.
  const above = (v: Vec3) => v[2] - z >= -bimSectionSnapMm;
  const g: Graph = { at: new Map(), links: [] };
  /** The edge u → v's point on the plane, by its key, if it crosses. */
  const cross = (key: string, u: Vec3, v: Vec3) => {
    if (above(u) === above(v)) return undefined;
    if (!g.at.has(key)) {
      const t = Math.min(1, Math.max(0, (u[2] - z) / (u[2] - v[2])));
      g.at.set(key, [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t]);
    }
    return key;
  };
  // Side faces: b_i b_{i+1} t_{i+1} t_i, its edges B_i, L_{i+1}, T_i, L_i.
  let open = false;
  loops.forEach(({ bottom, top }, l) => {
    const n = bottom.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const hit = [
        cross(`B${l}:${i}`, bottom[i]!, bottom[j]!),
        cross(`L${l}:${j}`, bottom[j]!, top[j]!),
        cross(`T${l}:${i}`, top[i]!, top[j]!),
        cross(`L${l}:${i}`, bottom[i]!, top[i]!),
      ].filter((k): k is string => !!k);
      if (hit.length === 2) g.links.push([hit[0]!, hit[1]!]);
      else if (hit.length) open = true;
    }
  });
  if (open) return undefined;
  // Each cap: its crossed edges in order along the line it meets the plane, paired.
  for (const [cap, sign] of [
    ['B', -1],
    ['T', 1],
  ] as const) {
    const n: Vec3 = [ax.z[0] * sign, ax.z[1] * sign, ax.z[2] * sign];
    // Along the cap's line on the plane (level, square to its normal); a level cap has none.
    const d: Vec2 = [-n[1], n[0]];
    if (Math.hypot(d[0], d[1]) < 1e-12) continue;
    const hits: string[] = [];
    loops.forEach(({ bottom, top }, l) => {
      const ring = cap === 'B' ? bottom : top;
      for (let i = 0; i < ring.length; i++) {
        const k = cross(`${cap}${l}:${i}`, ring[i]!, ring[(i + 1) % ring.length]!);
        if (k) hits.push(k);
      }
    });
    if (hits.length % 2) return undefined;
    const along = (k: string) => {
      const p = g.at.get(k)!;
      return p[0] * d[0] + p[1] * d[1];
    };
    hits.sort((a, b) => along(a) - along(b));
    for (let i = 0; i + 1 < hits.length; i += 2) g.links.push([hits[i]!, hits[i + 1]!]);
  }
  // Not reaching the plane is no section, not a failed one (Codex on #1238).
  if (!g.links.length) return [];
  return walk(g);
}

/**
 * Loops (outer and holes, either way round) cut to where `side` is negative or zero, as the
 * region's own boundary: what lies inside of each loop, joined along the cutting line where it
 * passes through the region, so a cut across a hole opens it rather than closing it twice.
 * `side` is linear (a half-plane). Undefined when the cut does not close.
 */
export function bimClipRegion(
  loops: readonly Vec2[][],
  side: (p: Vec2) => number,
): Vec2[][] | undefined {
  const inside = (p: Vec2) => side(p) <= 0;
  const g: Graph = { at: new Map(), links: [] };
  const hits: string[] = [];
  const kept: Vec2[][] = [];
  loops.forEach((loop, l) => {
    if (loop.every(inside)) return void kept.push(loop);
    if (!loop.some(inside)) return;
    loop.forEach((a, i) => {
      const j = (i + 1) % loop.length;
      const b = loop[j]!;
      const [ia, ib] = [inside(a), inside(b)];
      if (ia) g.at.set(`P${l}:${i}`, a);
      if (ia && ib) g.links.push([`P${l}:${i}`, `P${l}:${j}`]);
      else if (ia !== ib) {
        const [da, db] = [side(a), side(b)];
        const t = da / (da - db);
        const k = `X${l}:${i}`;
        g.at.set(k, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        g.links.push([ia ? `P${l}:${i}` : `P${l}:${j}`, k]);
        hits.push(k);
      }
    });
  });
  if (hits.length % 2) return undefined;
  // Along the line: the gradient of `side` turned a quarter.
  const o = side([0, 0]);
  const n: Vec2 = [side([1, 0]) - o, side([0, 1]) - o];
  const along = (k: string) => {
    const p = g.at.get(k)!;
    return -p[0] * n[1] + p[1] * n[0];
  };
  hits.sort((a, b) => along(a) - along(b));
  for (let i = 0; i + 1 < hits.length; i += 2) g.links.push([hits[i]!, hits[i + 1]!]);
  if (!g.links.length) return kept;
  const cut = walk(g);
  return cut ? [...kept, ...cut] : undefined;
}
