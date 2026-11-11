/**
 * R3c-2b: which faces of a body the analysis preparation removes (docs/cad/r3-analysis.md,
 * 形状準備), decided from samples of each face's own surface (evaluator `prepareAnalysisBody`).
 * Pure, so the rules are tested without the kernel. Nothing here is matched by nearness to a
 * reference: a face is removed for what its surface is, and the kernel's defeaturing history then
 * says what became of every face and edge.
 */
export type Xyz = [number, number, number];

/** What the evaluator read from one face. */
export interface FaceSample {
  /** The face's surface: a revolved blend or hole surface, or anything else. */
  kind: 'cylinder' | 'torus' | 'sphere' | 'other';
  /** 1 / the largest principal curvature (mm) at a point of the face; NaN when not measured. */
  radius: number;
  /**
   * For a revolved surface: its axis (a point on it and its unit direction; a sphere's passes
   * through its centre) and whether the material lies outside the surface (the outward normal
   * points to the axis: a hole's wall, a concave fillet).
   */
  axis?: { point: Xyz; dir: Xyz };
  concave?: boolean;
  /**
   * For a revolved surface: the point at the middle of the face's own parameter range in its
   * turning direction (world coordinates). Without it, the middle of the arc its nodes cover.
   */
  middle?: Xyz;
  /** The face's triangulation nodes (world coordinates), for every kind of face. */
  nodes?: Xyz[];
}

export interface PreparationSettings {
  /** Holes of a smaller diameter (mm) are removed; null keeps them all. */
  removeHolesBelow: number | null;
  /** Fillets of a smaller radius (mm) are removed; null keeps them all. */
  removeFilletsBelow: number | null;
  /** Faces removed explicitly, by topology face index. */
  removeFaces: number[];
}

/**
 * The angle of each point around an axis, in one frame fixed by the axis direction alone, so the
 * nodes of several faces on one axis are comparable whatever their surfaces' own parameter
 * origins (#797 review).
 */
export function anglesAround(axis: { point: Xyz; dir: Xyz }, points: Xyz[]): number[] {
  const d = axis.dir;
  const seed: Xyz = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const c = cross(d, seed);
  const e1: Xyz = [c[0] / Math.hypot(...c), c[1] / Math.hypot(...c), c[2] / Math.hypot(...c)];
  const e2 = cross(d, e1);
  return points.map((p) => {
    const v = sub(p, axis.point);
    return Math.atan2(dot(v, e2), dot(v, e1));
  });
}

/** The largest angle (radians) between consecutive node angles around the axis, wrapping. */
export function largestGap(angles: number[]): number {
  if (angles.length === 0) return 2 * Math.PI;
  const a = angles
    .map((x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))
    .sort((p, q) => p - q);
  let gap = a[0]! + 2 * Math.PI - a[a.length - 1]!;
  for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i]! - a[i - 1]!);
  return gap;
}

/**
 * A hole's wall goes all the way round: the nodes of its faces leave no gap of a quarter turn or
 * more (a triangulation at the analysis angle of at most π/2 puts nodes closer). A fillet turns
 * through clearly less than half a turn (a gap over 1.05 π), so half of a hole's wall, which the
 * kernel often keeps as its own face, is never taken for one.
 */
const holeGap = Math.PI / 2;
const filletGap = 1.05 * Math.PI;

/**
 * The faces the settings remove, sorted: the explicit ones; every connected patch of concave
 * cylinders on one axis and radius that closes on itself (a hole's wall: its faces' nodes leave no
 * gap of `holeGap`, and its faces wind once round the axis, see `closesRing`) and whose diameter is below
 * `removeHolesBelow`, with the tori on its axis next to it (rim blends); every torus, every
 * cylinder that turns through clearly less than half a turn and every sphere patch within less than
 * a quarter turn of its middle, with a radius below `removeFilletsBelow`; then, repeatedly, any
 * connected set of the other faces that only removed faces border, one of them a hole's, and that
 * lies inside a removed hole's cylinder (a blind hole's bottom, in one face or several).
 * `tolerance` (mm) decides when two axes, radii and distances are the same.
 */
export function preparationFaces(
  faces: FaceSample[],
  edges: PreparationEdge[],
  settings: PreparationSettings,
  tolerance: number,
): number[] {
  const out = new Set<number>(settings.removeFaces);
  /** Faces of removed holes: only what they enclose goes with them. */
  const hole = new Set<number>();
  const { removeHolesBelow: holes, removeFilletsBelow: fillets } = settings;
  const neighbours = neighboursOf(faces.length, edges);
  // Hole walls: concave cylinders on one axis line and radius that touch (a connected patch of
  // faces), whose nodes close a full turn. Found whatever the settings, so a wall in several
  // faces is never taken for fillets.
  // A boss (a convex cylinder closing a full turn) is grouped the same way: never a hole, and
  // never taken for fillets however its faces are split (#797 review).
  const wall = (i: number) => {
    const f = faces[i]!;
    return f.kind === 'cylinder' && f.concave !== undefined && f.axis !== undefined && f.radius > 0;
  };
  const walls: { faces: number[]; axis: { point: Xyz; dir: Xyz }; radius: number }[] = [];
  const closed = new Set<number>();
  /** The largest gap round the axis of each grouped cylinder's whole patch. */
  const patchGap = new Map<number, number>();
  const seen = new Set<number>();
  faces.forEach((f, start) => {
    if (seen.has(start) || !wall(start)) return;
    const group = { faces: [] as number[], axis: f.axis!, radius: f.radius };
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const i = stack.pop()!;
      group.faces.push(i);
      for (const j of neighbours[i]!) {
        const g = faces[j]!;
        if (
          seen.has(j) ||
          !wall(j) ||
          g.concave !== f.concave ||
          !(Math.abs(g.radius - group.radius) <= tolerance) ||
          !sameLine(group.axis, g.axis!, tolerance)
        )
          continue;
        seen.add(j);
        stack.push(j);
      }
    }
    const gap = largestGap(
      anglesAround(
        group.axis,
        group.faces.flatMap((i) => faces[i]!.nodes ?? []),
      ),
    );
    for (const i of group.faces) patchGap.set(i, gap);
    if (closesRing(group.faces, edges, faces, group.axis) && gap < holeGap) {
      for (const i of group.faces) closed.add(i);
      if (f.concave) walls.push(group);
    }
  });
  const removedWalls = holes === null ? [] : walls.filter((g) => 2 * g.radius < holes);
  if (holes !== null)
    for (const g of removedWalls) {
      for (const i of g.faces) {
        out.add(i);
        hole.add(i);
      }
      // A blend round the hole's rim (a torus on its axis, next to its wall) goes with it.
      for (const i of g.faces)
        for (const j of neighbours[i]!) {
          const f = faces[j]!;
          if (f.kind === 'torus' && f.axis && sameLine(g.axis, f.axis, tolerance)) {
            // Part of the hole: what it encloses (a blind bottom past a blend) goes too.
            out.add(j);
            hole.add(j);
          }
        }
    }
  // Spheres are measured as connected patches of one sphere (same centre and radius), so a
  // sphere split into octants is no set of corner blends (#797 review).
  const sphereCaps = new Map<number, number>();
  faces.forEach((f, start) => {
    if (f.kind !== 'sphere' || !f.axis || sphereCaps.has(start)) return;
    const centre = f.axis.point;
    const same = (g: FaceSample) =>
      g.kind === 'sphere' &&
      g.axis !== undefined &&
      Math.hypot(...sub(g.axis.point, centre)) <= tolerance &&
      Math.abs(g.radius - f.radius) <= tolerance;
    const group = [start];
    const found = new Set(group);
    for (let k = 0; k < group.length; k++)
      for (const j of neighbours[group[k]!]!)
        if (!found.has(j) && same(faces[j]!)) {
          found.add(j);
          group.push(j);
        }
    const cap = capAngle(
      centre,
      group.flatMap((i) => faces[i]!.nodes ?? []),
    );
    for (const i of group) sphereCaps.set(i, cap);
  });
  if (fillets !== null)
    faces.forEach((f, i) => {
      if (f.kind === 'other' || closed.has(i) || !(f.radius > 0) || !(f.radius < fillets)) return;
      // A torus is a blend however far it turns (a hole's rim); a cylinder only when it turns
      // through clearly less than half a turn; a sphere only when its patch stays within clearly
      // less than a quarter turn of its middle, measured from its centre whatever its parameter
      // axis (a corner blend reaches about 0.3 π).
      if (
        f.kind === 'torus' ||
        // A split patch is measured whole (#797 review): a groove in three faces is no fillet.
        (f.kind === 'cylinder' &&
          (patchGap.get(i) ?? largestGap(f.axis ? anglesAround(f.axis, f.nodes ?? []) : [])) >
            filletGap) ||
        (f.kind === 'sphere' && (sphereCaps.get(i) ?? Math.PI) < sphereCap)
      )
        out.add(i);
    });
  if (out.size === 0) return [];
  // What a removed hole leaves enclosed (its bottom, a drill point, in one face or several) goes
  // with it: a connected set of the other faces that only removed faces border, one of them a
  // hole's, and whose nodes all lie inside one removed hole's cylinder. Only a hole's: the top of
  // a block whose four edges are filleted is enclosed by fillets and stays; and the rest of a body
  // with a through hole is bordered by the hole alone but lies outside it.
  const inside = (set: number[]) =>
    removedWalls.some((g) =>
      set.every((i) => {
        const nodes = faces[i]!.nodes;
        return (
          nodes !== undefined &&
          nodes.length > 0 &&
          nodes.every((p) => distanceToLine(g.axis, p) <= g.radius + tolerance)
        );
      }),
    );
  for (let changed = true; changed; ) {
    changed = false;
    const visited = new Set<number>();
    for (let start = 0; start < faces.length; start++) {
      if (out.has(start) || visited.has(start)) continue;
      const set: number[] = [];
      const border = new Set<number>();
      const stack = [start];
      visited.add(start);
      while (stack.length) {
        const i = stack.pop()!;
        set.push(i);
        for (const j of neighbours[i]!) {
          if (out.has(j)) border.add(j);
          else if (!visited.has(j)) {
            visited.add(j);
            stack.push(j);
          }
        }
      }
      if ([...border].some((j) => hole.has(j)) && inside(set)) {
        for (const i of set) {
          out.add(i);
          hole.add(i);
        }
        changed = true;
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** An edge of the topology table: its faces, and its centroid (world coordinates). */
export interface PreparationEdge {
  faces: number[];
  centroid?: Xyz;
}

/**
 * The faces of a wall close a ring round their axis: one of them meets itself along a seam (an
 * edge with that face alone: a periodic face goes all the way round), or the faces joined by
 * their shared edges hold a cycle that winds once round the axis. Winding is followed through the
 * angles of the faces' middles and of the edges' centroids, each step less than half a turn, so an
 * open groove, however its faces are split (side by side, in a grid), never closes (#797 review).
 */
export function closesRing(
  group: number[],
  edges: PreparationEdge[],
  faces: FaceSample[],
  axis: { point: Xyz; dir: Xyz },
): boolean {
  const own = new Set(group);
  const inner = edges.filter((e) => e.faces.length > 0 && e.faces.every((f) => own.has(f)));
  if (inner.some((e) => e.faces.length === 1)) return true;
  const middle = new Map<number, number>();
  for (const i of group) {
    const f = faces[i]!;
    // The face's own middle: the largest gap between its nodes need not be what it leaves
    // uncovered (a narrow face next to a coarse one, #797 review).
    const m = f.middle
      ? anglesAround(axis, [f.middle])[0]
      : middleAngle(anglesAround(axis, f.nodes ?? []));
    if (m === undefined) return false;
    middle.set(i, m);
  }
  const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  const links = inner.flatMap((e) =>
    e.centroid && e.faces.length === 2
      ? [{ a: e.faces[0]!, b: e.faces[1]!, at: anglesAround(axis, [e.centroid])[0]! }]
      : [],
  );
  // Unwrapped angles of the faces along a spanning tree; an edge off the tree whose two sides
  // disagree by a turn closes a winding cycle.
  const unwrapped = new Map<number, number>();
  for (const root of group) {
    if (unwrapped.has(root)) continue;
    unwrapped.set(root, middle.get(root)!);
    const stack = [root];
    while (stack.length) {
      const f = stack.pop()!;
      for (const l of links) {
        if (l.a !== f && l.b !== f) continue;
        const g = l.a === f ? l.b : l.a;
        const via = unwrapped.get(f)! + wrap(l.at - middle.get(f)!);
        const there = via + wrap(middle.get(g)! - l.at);
        if (!unwrapped.has(g)) {
          unwrapped.set(g, there);
          stack.push(g);
        } else if (Math.abs(there - unwrapped.get(g)!) > Math.PI) return true;
      }
    }
  }
  return false;
}

/** The middle of the arc the angles cover (opposite their largest gap); none when empty. */
function middleAngle(angles: number[]): number | undefined {
  if (angles.length === 0) return undefined;
  const a = angles
    .map((x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))
    .sort((p, q) => p - q);
  // The covered arc runs from a[k] round to a[k - 1] (+ a turn), k after the largest gap.
  let k = 0;
  let gap = a[0]! + 2 * Math.PI - a[a.length - 1]!;
  for (let i = 1; i < a.length; i++) if (a[i]! - a[i - 1]! > gap) [gap, k] = [a[i]! - a[i - 1]!, i];
  const from = a[k]!;
  const to = k === 0 ? a[a.length - 1]! : a[k - 1]! + 2 * Math.PI;
  return (from + to) / 2;
}

/** Sphere fillets: their patch stays within this angle of its middle direction. */
const sphereCap = 0.45 * Math.PI;

/**
 * The largest angle (radians) between a point's direction from `centre` and the patch's middle
 * direction (the mean of all of them); π when there is no middle (no points, or a whole sphere).
 */
export function capAngle(centre: Xyz, points: Xyz[]): number {
  const dirs = points
    .map((p) => sub(p, centre))
    .filter((v) => Math.hypot(...v) > 0)
    .map((v): Xyz => {
      const l = Math.hypot(...v);
      return [v[0] / l, v[1] / l, v[2] / l];
    });
  const sum = dirs.reduce<Xyz>((a, d) => [a[0] + d[0], a[1] + d[1], a[2] + d[2]], [0, 0, 0]);
  const l = Math.hypot(...sum);
  if (dirs.length === 0 || !(l > 1e-9 * dirs.length)) return Math.PI;
  const m: Xyz = [sum[0] / l, sum[1] / l, sum[2] / l];
  // A loop, not Math.max(...): a dense patch has more nodes than a call takes arguments.
  let cap = 0;
  for (const d of dirs) cap = Math.max(cap, Math.acos(Math.min(1, Math.max(-1, dot(d, m)))));
  return cap;
}

function distanceToLine(axis: { point: Xyz; dir: Xyz }, p: Xyz): number {
  const d = sub(p, axis.point);
  const along = dot(d, axis.dir);
  return Math.hypot(
    d[0] - along * axis.dir[0],
    d[1] - along * axis.dir[1],
    d[2] - along * axis.dir[2],
  );
}

function neighboursOf(count: number, edges: { faces: number[] }[]): Set<number>[] {
  const out = Array.from({ length: count }, () => new Set<number>());
  for (const e of edges)
    for (const a of e.faces) for (const b of e.faces) if (a !== b) out[a]?.add(b);
  return out;
}

const sub = (a: Xyz, b: Xyz): Xyz => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Xyz, b: Xyz) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Xyz, b: Xyz): Xyz => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Two axes are the same line: parallel, and each point is on the other's line. */
function sameLine(a: { point: Xyz; dir: Xyz }, b: { point: Xyz; dir: Xyz }, tolerance: number) {
  if (Math.hypot(...cross(a.dir, b.dir)) > 1e-6) return false;
  const d = sub(b.point, a.point);
  const along = dot(d, a.dir);
  return (
    Math.hypot(d[0] - along * a.dir[0], d[1] - along * a.dir[1], d[2] - along * a.dir[2]) <=
    tolerance
  );
}
