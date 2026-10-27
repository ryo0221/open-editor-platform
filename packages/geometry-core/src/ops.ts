/**
 * Geometry ops (docs/cad/r2c-architecture.md, 幾何op; ADR 017): the domain-independent recipe of
 * a shape as a graph of nodes. A domain (bim) builds the graph; a kernel adapter
 * (`geometry-kernel-occt`) only runs it. Nodes know no domain words. Units are mm and rad,
 * right-handed and Z-up.
 */

export type GeometryVec2 = [number, number];
export type GeometryVec3 = [number, number, number];
/**
 * A loop vertex in its plane: `[x, y]`, or `[x, y, bulge]` when the edge to the next vertex is a
 * circular arc. `bulge` is tan(θ / 4) of the arc's sweep θ (positive counter-clockwise),
 * 0 < |bulge| ≤ 1. A loop is closed: the last vertex joins the first.
 */
export type GeometryLoopVertex = [number, number] | [number, number, number];
export type GeometryLoop = GeometryLoopVertex[];

/** A plane's frame: its origin, its x direction and its normal (z). y is z × x. */
export interface GeometryFrame {
  origin: GeometryVec3;
  x: GeometryVec3;
  z: GeometryVec3;
}

export type GeometryOp =
  /**
   * A planar region (outer loop and holes in `frame`) swept along `vector`. A straight profile
   * sweep (a beam or a column) is a prism whose vector need not be the frame's normal; it must
   * not lie in the plane.
   */
  | {
      op: 'prism';
      frame: GeometryFrame;
      outer: GeometryLoop;
      holes?: GeometryLoop[];
      vector: GeometryVec3;
    }
  | { op: 'boolean'; kind: 'cut' | 'union' | 'common'; target: string; tools: string[] }
  /**
   * Keeps the part of `input` on the `keep` side of the plane: `below` is against `normal`. A
   * sheet (faces without a solid) keeps its faces on that side.
   */
  | {
      op: 'halfSpace';
      input: string;
      origin: GeometryVec3;
      normal: GeometryVec3;
      keep: 'below' | 'above';
    }
  /**
   * A rigid placement: `rotation` is a 3 × 3 row-major orthonormal matrix with determinant 1,
   * applied before `translation`.
   */
  | { op: 'transform'; input: string; rotation: number[]; translation: GeometryVec3 }
  /** A normalized BRep asset (a CAD part's shape), by its key in the evaluation's assets. */
  | { op: 'brep'; asset: string }
  /**
   * Several shapes kept apart in one (no boolean): what a drawing projects together, so one
   * shape hides another.
   */
  | { op: 'compound'; inputs: string[] }
  /**
   * The bodies of one kind in `input`: its solids (kept apart; a section outlines overlapping
   * solids once), or its sheet (the faces of no solid). A drawing cuts a part's solids and sheet
   * apart, so the solid's cut is filled once where bodies overlap, and the sheet's is a line.
   */
  | { op: 'bodies'; input: string; kind: 'solid' | 'sheet' };

/** Nodes by ID. Every reference names another node; the graph has no cycle. */
export interface GeometryGraph {
  nodes: Record<string, GeometryOp>;
}

/** What to compute from one node. */
export interface GeometryRequest {
  node: string;
  /** Triangles for display or drawings, at a fixed absolute deflection. */
  mesh?: { deflectionMm: number; angularDeflectionRad: number };
  /** Volume, area and bounds. */
  measure?: boolean;
  /**
   * The exact cut of the shape by a plane: its edges as polylines in model space. Overlapping
   * solids have one outline (their cut faces are fused in the plane).
   */
  section?: { origin: GeometryVec3; normal: GeometryVec3 };
  /**
   * Visible and hidden edges seen along `direction` (towards the scene), in the view plane's
   * coordinates (x along `up` × -`direction`, y along `up`), from a mesh at `deflectionMm`.
   */
  projection?: {
    direction: GeometryVec3;
    up: GeometryVec3;
    deflectionMm: number;
    angularDeflectionRad: number;
  };
}

export const geometryLimits = Object.freeze({
  /** Largest absolute coordinate, as in CAD. */
  coordinateMm: 1_000_000,
  nodes: 100_000,
  loopVertices: 10_000,
  holes: 1_000,
  tools: 10_000,
  /** Smallest length the ops tell apart (a vertex gap, a vector). */
  toleranceMm: 1e-6,
});

export type GeometryIssueCode =
  | 'node-missing'
  | 'node-cycle'
  | 'too-many'
  | 'not-finite'
  | 'coordinate-range'
  | 'frame-invalid'
  | 'loop-invalid'
  | 'bulge-invalid'
  | 'vector-in-plane'
  | 'rotation-invalid'
  | 'request-invalid';
export interface GeometryIssue {
  code: GeometryIssueCode;
  /** The node (or request node) the issue is about. */
  node: string;
  path: string;
}

const dot = (a: GeometryVec3, b: GeometryVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossOf = (a: GeometryVec3, b: GeometryVec3): GeometryVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: GeometryVec3) => Math.hypot(a[0], a[1], a[2]);
/** Unit vector of `a`. */
export const geometryUnit = (a: GeometryVec3): GeometryVec3 => {
  const l = norm(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const geometryCross = crossOf;

/** Whether `id` names a node of the graph (its own key, never an inherited name). */
export const geometryHasNode = (graph: GeometryGraph, id: string) =>
  Object.prototype.hasOwnProperty.call(graph.nodes, id);

/**
 * Walks the nodes `root` reads, children first, without recursion (a chain may be as long as
 * the node limit), calling `done` once per node. Nodes `state` already holds are not walked
 * again, so one `state` shared across roots keeps the whole graph linear. Missing children are
 * skipped. Returns false when the walk comes back to a node on its path (a cycle).
 */
function walk(
  graph: GeometryGraph,
  root: string,
  state: Map<string, 1 | 2>,
  done: (id: string) => void = () => {},
): boolean {
  if (state.has(root) || !geometryHasNode(graph, root)) return true;
  const stack: { id: string; children: string[]; next: number }[] = [];
  const enter = (id: string) => {
    state.set(id, 1);
    stack.push({ id, children: geometryChildren(graph.nodes[id]!), next: 0 });
  };
  enter(root);
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    if (top.next < top.children.length) {
      const child = top.children[top.next++]!;
      if (!geometryHasNode(graph, child)) continue;
      const seen = state.get(child);
      if (seen === 1) {
        for (const s of stack) state.set(s.id, 2);
        return false;
      }
      if (seen === undefined) enter(child);
    } else {
      state.set(top.id, 2);
      done(top.id);
      stack.pop();
    }
  }
  return true;
}

/**
 * The nodes `id` reads and `id` itself, each once, children before the nodes that read them,
 * for building a node without recursion. Assumes a graph `validateGeometry` accepted.
 */
export function geometryOrder(graph: GeometryGraph, id: string): string[] {
  const order: string[] = [];
  walk(graph, id, new Map(), (n) => order.push(n));
  return order;
}

/** The children a node reads. */
export function geometryChildren(op: GeometryOp): string[] {
  switch (op.op) {
    case 'boolean':
      return [op.target, ...op.tools];
    case 'halfSpace':
    case 'transform':
    case 'bodies':
      return [op.input];
    case 'compound':
      return op.inputs;
    default:
      return [];
  }
}

/** Checks a graph and its requests; an empty list means the kernel may run them. */
export function validateGeometry(
  graph: GeometryGraph,
  requests: GeometryRequest[] = [],
): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  const ids = Object.keys(graph.nodes);
  const issue = (code: GeometryIssueCode, node: string, path: string) =>
    issues.push({ code, node, path });
  if (ids.length > geometryLimits.nodes) issue('too-many', '', 'nodes');
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const vec = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(finite);
  const point = (v: unknown, node: string, path: string) => {
    if (!vec(v, 3)) return (issue('not-finite', node, path), false);
    if ((v as number[]).some((c) => Math.abs(c) > geometryLimits.coordinateMm))
      return (issue('coordinate-range', node, path), false);
    return true;
  };
  const direction = (v: unknown, node: string, path: string) => {
    if (!point(v, node, path)) return false;
    if (norm(v as GeometryVec3) < geometryLimits.toleranceMm)
      return (issue('frame-invalid', node, path), false);
    return true;
  };
  const loop = (l: unknown, node: string, path: string) => {
    if (!Array.isArray(l) || l.length > geometryLimits.loopVertices)
      return issue(Array.isArray(l) ? 'too-many' : 'loop-invalid', node, path);
    const arcs = l.filter((v) => Array.isArray(v) && v.length === 3).length;
    if (l.length < (arcs ? 2 : 3)) return issue('loop-invalid', node, path);
    l.forEach((v, i) => {
      if (!Array.isArray(v) || (v.length !== 2 && v.length !== 3) || !v.every(finite))
        return issue('not-finite', node, `${path}[${i}]`);
      if (
        Math.abs(v[0]) > geometryLimits.coordinateMm ||
        Math.abs(v[1]) > geometryLimits.coordinateMm
      )
        return issue('coordinate-range', node, `${path}[${i}]`);
      if (v.length === 3 && !(v[2] !== 0 && Math.abs(v[2]) <= 1))
        issue('bulge-invalid', node, `${path}[${i}]`);
      const next = l[(i + 1) % l.length] as number[];
      if (
        Array.isArray(next) &&
        Math.hypot(next[0]! - v[0], next[1]! - v[1]) < geometryLimits.toleranceMm
      )
        issue('loop-invalid', node, `${path}[${i}]`);
    });
  };
  for (const id of ids) {
    const op = graph.nodes[id]!;
    const at = `nodes.${id}`;
    for (const child of geometryChildren(op))
      if (!geometryHasNode(graph, child)) issue('node-missing', id, `${at}`);
    switch (op.op) {
      case 'prism': {
        const f = op.frame;
        if (
          !f ||
          !point(f.origin, id, `${at}.frame.origin`) ||
          !direction(f.x, id, `${at}.frame.x`) ||
          !direction(f.z, id, `${at}.frame.z`)
        )
          break;
        if (Math.abs(dot(geometryUnit(f.x), geometryUnit(f.z))) > 1e-9)
          issue('frame-invalid', id, `${at}.frame`);
        loop(op.outer, id, `${at}.outer`);
        if ((op.holes?.length ?? 0) > geometryLimits.holes) issue('too-many', id, `${at}.holes`);
        op.holes?.forEach((h, i) => loop(h, id, `${at}.holes[${i}]`));
        if (!direction(op.vector, id, `${at}.vector`)) break;
        // The sweep must leave the plane, by more than the tolerance along the normal.
        if (Math.abs(dot(op.vector, geometryUnit(f.z))) < geometryLimits.toleranceMm)
          issue('vector-in-plane', id, `${at}.vector`);
        break;
      }
      case 'boolean':
        if (op.tools.length === 0 || op.tools.length > geometryLimits.tools)
          issue(op.tools.length ? 'too-many' : 'node-missing', id, `${at}.tools`);
        break;
      case 'halfSpace':
        point(op.origin, id, `${at}.origin`);
        direction(op.normal, id, `${at}.normal`);
        break;
      case 'transform': {
        point(op.translation, id, `${at}.translation`);
        const r = op.rotation;
        if (!vec(r, 9)) {
          issue('rotation-invalid', id, `${at}.rotation`);
          break;
        }
        const rows: GeometryVec3[] = [0, 1, 2].map(
          (i) => r.slice(3 * i, 3 * i + 3) as GeometryVec3,
        );
        const orthonormal = rows.every((a, i) =>
          rows.every((b, j) => Math.abs(dot(a, b) - (i === j ? 1 : 0)) < 1e-9),
        );
        if (!orthonormal || dot(crossOf(rows[0]!, rows[1]!), rows[2]!) < 0)
          issue('rotation-invalid', id, `${at}.rotation`);
        break;
      }
      case 'brep':
        if (typeof op.asset !== 'string' || !op.asset) issue('node-missing', id, `${at}.asset`);
        break;
      case 'compound':
        if (op.inputs.length === 0 || op.inputs.length > geometryLimits.tools)
          issue(op.inputs.length ? 'too-many' : 'node-missing', id, `${at}.inputs`);
        break;
    }
  }
  // Cycles: a walk that comes back to a node on its path.
  const state = new Map<string, 1 | 2>();
  for (const id of ids) if (!walk(graph, id, state)) issue('node-cycle', id, `nodes.${id}`);
  requests.forEach((r, i) => {
    const at = `requests[${i}]`;
    if (!geometryHasNode(graph, r.node)) issue('node-missing', r.node, at);
    const positive = (v: unknown) => finite(v) && v > 0;
    if (r.mesh && !(positive(r.mesh.deflectionMm) && positive(r.mesh.angularDeflectionRad)))
      issue('request-invalid', r.node, `${at}.mesh`);
    if (r.section) {
      point(r.section.origin, r.node, `${at}.section.origin`);
      direction(r.section.normal, r.node, `${at}.section.normal`);
    }
    const p = r.projection;
    if (p) {
      if (
        !direction(p.direction, r.node, `${at}.projection.direction`) ||
        !direction(p.up, r.node, `${at}.projection.up`)
      )
        return;
      if (norm(crossOf(geometryUnit(p.direction), geometryUnit(p.up))) < 1e-9)
        issue('request-invalid', r.node, `${at}.projection.up`);
      if (!(positive(p.deflectionMm) && positive(p.angularDeflectionRad)))
        issue('request-invalid', r.node, `${at}.projection`);
    }
  });
  return issues;
}

/**
 * A canonical text of a node and everything it reads, for a cache key: equal keys build equal
 * shapes. Object keys are sorted, so the order a graph was written in does not matter.
 */
export function geometryNodeKey(graph: GeometryGraph, id: string): string {
  const canonical = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : v && typeof v === 'object'
        ? `{${Object.keys(v)
            .sort()
            .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
            .join(',')}}`
        : JSON.stringify(v);
  // One line per distinct node, children first; a node names its children by their line, so a
  // node read many times is written once and the key grows with the graph, not its paths.
  const lines: string[] = [];
  const lineOf = new Map<string, number>();
  const index = new Map<string, number>();
  walk(graph, id, new Map(), (n) => {
    const op = graph.nodes[n]!;
    const own = { ...op } as Record<string, unknown>;
    delete own.target;
    delete own.tools;
    delete own.input;
    delete own.inputs;
    const line = `${canonical(own)}<${geometryChildren(op)
      .map((c) => index.get(c))
      .join(',')}>`;
    let at = lineOf.get(line);
    if (at === undefined) lineOf.set(line, (at = lines.push(line) - 1));
    index.set(n, at);
  });
  return lines.join('\n');
}
