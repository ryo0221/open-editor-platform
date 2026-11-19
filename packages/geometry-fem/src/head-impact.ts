import {
  cfcFilter,
  headInjuryCriterion,
  resample,
  standardGravity,
  type HicResult,
} from './crash-metrics';
import { kmhToMmPerS } from './crash-setup';
import type { ExplicitModel, ExplicitResult } from './explicit';

/**
 * VS8b (docs/cad/vehicle-simulation.md, VS8): the pedestrian head impact on a vehicle at rest. A
 * headform, a rigid sphere of shells with the headform's mass and inertia (a node at its centre
 * gives the centre's motion), comes in at `speed` along a line through the aim point `target`
 * on the vehicle's outer surface, square to y and `angleDeg` below the horizontal, travelling
 * rearward (−x; the vehicle frame of `crashSetup`: x forward, z up). It starts `gap` clear of the
 * nearest contact surface. The vehicle keeps its held nodes (a hood held at its hinges and
 * latch, or the edges of a panel) and is otherwise free and at rest.
 *
 * The headforms are the public ones of UN GTR 9 (adult 4.5 kg, 65°; child 3.5 kg, 50°; both
 * 165 mm; both 40 km/h). The real headform's vinyl skin is not modelled: the sphere is
 * rigid, and the contact's penalty spring stands for the skin (out of scope in the plan:
 * dummies, VS-U7).
 */
export type Headform = 'adult' | 'child';

export const headforms = {
  adult: { mass: 4.5, diameter: 165, angleDeg: 65 },
  child: { mass: 3.5, diameter: 165, angleDeg: 50 },
} as const;
/** The impact speed of both headforms (km/h). */
export const headImpactSpeed = 40;

export interface HeadImpactOptions {
  /** The aim point on the vehicle's outer surface (mm). */
  target: [number, number, number];
  headform?: Headform;
  /** Overrides of the headform's: kg, mm, degrees below the horizontal (over 0, at most 90). */
  mass?: number;
  diameter?: number;
  angleDeg?: number;
  /** mm/s, 40 km/h by default. */
  speed?: number;
  /** mm, 1 by default. */
  gap?: number;
  /** Quads along each edge of the sphere's six cube faces (2–24, 8 by default). */
  perFace?: number;
  /** Coulomb friction of the contact (the vehicle's contact's by default). */
  friction?: number;
}

export interface HeadImpactSetup {
  model: ExplicitModel;
  /** The unit direction of travel. */
  direction: [number, number, number];
  /** The node at the headform's centre (a history node for `headImpactMeasures`). */
  centre: number;
  /** Where its centre starts (mm), and the headform's nodes and shells in the model. */
  start: [number, number, number];
  nodes: { first: number; count: number };
  shells: { first: number; count: number };
  /** How far the centre travels along `direction` from its start to the first touch (mm). */
  approach: number;
  /** The headform used: kg, mm. */
  mass: number;
  diameter: number;
}

/** The headform's shell thickness (mm): its midsurface is half this inside its diameter. */
const skin = 1;

function refuse(detail: string): never {
  throw new RangeError(`headImpactSetup: ${detail}`);
}

const sub = (a: readonly number[], b: readonly number[]) => [
  a[0]! - b[0]!,
  a[1]! - b[1]!,
  a[2]! - b[2]!,
];
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];

/**
 * The largest s at which a sphere centred at t − s·d (d a unit vector) touches the model: radius
 * `reach` plus each node's half thickness `half` at the nodes, plus each shell's own half
 * thickness on its edges and faces; −Infinity when it never does.
 */
export function firstTouch(
  model: Pick<ExplicitModel, 'nodes' | 'shells' | 'thickness'>,
  t: readonly number[],
  d: readonly number[],
  reach: number,
  half: Float64Array,
): number {
  const x = model.nodes;
  const p = (i: number) => [x[3 * i]!, x[3 * i + 1]!, x[3 * i + 2]!];
  let best = -Infinity;
  // A point a: |t − a − s·d| = ρ, the larger root.
  const vertex = (a: number[], rho: number) => {
    const w = sub(t, a);
    const wd = dot(w, d);
    const disc = wd * wd - dot(w, w) + rho * rho;
    if (disc >= 0) best = Math.max(best, wd + Math.sqrt(disc));
  };
  // Only the shells' nodes: the contact leaves a node off the shells (a point mass, a beam's)
  // out, so it never stops the headform.
  const onShell = new Uint8Array(x.length / 3);
  for (const i of model.shells) onShell[i] = 1;
  for (let i = 0; i < onShell.length; i++) if (onShell[i]) vertex(p(i), reach + half[i]!);
  // A segment a–b: the distance to its line is ρ, where the foot is within the segment.
  const edge = (a: number[], b: number[], rho: number) => {
    const e = sub(b, a);
    const len = Math.hypot(e[0]!, e[1]!, e[2]!);
    if (!(len > 0)) return;
    const u = e.map((q) => q / len);
    const w = sub(t, a);
    const wu = dot(w, u);
    const du = dot(d, u);
    const wp = w.map((q, k) => q - wu * u[k]!);
    const dp = d.map((q, k) => q - du * u[k]!);
    const A = dot(dp, dp);
    if (!(A > 1e-18)) return;
    const B = dot(wp, dp);
    const disc = B * B - A * (dot(wp, wp) - rho * rho);
    if (disc < 0) return;
    const s = (B + Math.sqrt(disc)) / A;
    const along = wu - s * du;
    if (along >= 0 && along <= len) best = Math.max(best, s);
  };
  // A triangle's face: the plane offset by ρ, where the foot is inside the triangle.
  const face = (a: number[], b: number[], c: number[], rho: number) => {
    const ab = sub(b, a);
    const ac = sub(c, a);
    const nn = cross(ab, ac);
    const area2 = Math.hypot(nn[0]!, nn[1]!, nn[2]!);
    if (!(area2 > 0)) return;
    const nu = nn.map((q) => q / area2);
    const dn = dot(d, nu);
    if (!(Math.abs(dn) > 1e-12)) return;
    const h0 = dot(sub(t, a), nu);
    for (const side of [1, -1]) {
      const s = (h0 - side * rho) / dn;
      // The foot on the triangle's plane, in barycentric terms.
      const foot = [0, 1, 2].map((k) => t[k]! - s * d[k]! - side * rho * nu[k]!);
      const ap = sub(foot, a);
      const v = dot(cross(ap, ac), nu) / area2;
      const w = dot(cross(ab, ap), nu) / area2;
      if (v >= 0 && w >= 0 && v + w <= 1) best = Math.max(best, s);
    }
  };
  const shells = model.shells;
  for (let e = 0; e < model.thickness.length; e++) {
    const rho = reach + model.thickness[e]! / 2;
    const q = [0, 1, 2, 3].map((c) => shells[4 * e + c]!);
    const pts = q.map(p);
    for (let c = 0; c < 4; c++) if (q[c] !== q[(c + 1) % 4]) edge(pts[c]!, pts[(c + 1) % 4]!, rho);
    face(pts[0]!, pts[1]!, pts[2]!, rho);
    if (q[3] !== q[2]) {
      face(pts[0]!, pts[2]!, pts[3]!, rho);
      edge(pts[0]!, pts[2]!, rho);
    }
  }
  return best;
}

/**
 * A sphere of quads (a cube's six faces of k × k, pushed out to the radius `mid`) about `c`,
 * outward-facing, and its nodes, the centre first.
 */
function sphere(c: readonly number[], mid: number, k: number) {
  const keys = new Map<string, number>();
  const points: number[] = [...c];
  const at = (p: number[]) => {
    const key = p.map((v) => v.toFixed(9)).join(',');
    let i = keys.get(key);
    if (i === undefined) {
      i = points.length / 3;
      keys.set(key, i);
      const len = Math.hypot(p[0]!, p[1]!, p[2]!);
      points.push(...p.map((v, a) => c[a]! + (mid * v) / len));
    }
    return i;
  };
  const quads: number[] = [];
  // Each face: its normal axis a and sign s, and its two in-plane axes (u, v) with u × v = s·e_a.
  for (let a = 0; a < 3; a++)
    for (const s of [1, -1]) {
      const u = (a + 1) % 3;
      const v = (a + 2) % 3;
      const corner = (i: number, j: number) => {
        // Equal angles across the face, so the quads are of like size.
        const p = [0, 0, 0];
        p[a] = s;
        p[u] = Math.tan(-Math.PI / 4 + (Math.PI / 2) * (i / k));
        p[v] = s * Math.tan(-Math.PI / 4 + (Math.PI / 2) * (j / k));
        return at(p);
      };
      for (let i = 0; i < k; i++)
        for (let j = 0; j < k; j++)
          quads.push(corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1));
    }
  return { points, quads };
}

/** The vehicle model with the headform added, moving towards the target. */
export function headImpactSetup(model: ExplicitModel, options: HeadImpactOptions): HeadImpactSetup {
  const form = headforms[options.headform ?? 'adult'];
  if (!form) refuse(`no headform ${String(options.headform)}`);
  const massKg = options.mass ?? form.mass;
  const diameter = options.diameter ?? form.diameter;
  const angle = options.angleDeg ?? form.angleDeg;
  const speed = options.speed ?? headImpactSpeed * kmhToMmPerS;
  const gap = options.gap ?? 1;
  const k = options.perFace ?? 8;
  const positive = (v: number) => v > 0 && Number.isFinite(v);
  if (!positive(massKg)) refuse('the headform mass must be positive');
  if (!positive(diameter) || diameter <= 2 * skin)
    refuse(`the headform diameter must be over ${2 * skin} mm`);
  if (!(angle > 0 && angle <= 90)) refuse('the angle must be over 0° and at most 90°');
  if (!positive(speed)) refuse('the speed must be positive');
  if (!positive(gap)) refuse('the gap must be positive');
  if (!(Number.isInteger(k) && k >= 2 && k <= 24)) refuse('perFace must be a whole 2–24');
  const friction = options.friction ?? model.contact?.friction;
  if (friction !== undefined && (!(friction >= 0) || !Number.isFinite(friction)))
    refuse('the friction must be 0 or more');
  if (!options.target.every(Number.isFinite) || options.target.length !== 3)
    refuse('the target must be three numbers');
  if (model.velocity?.some((v) => v !== 0) || model.rotation?.some((v) => v !== 0))
    refuse('the vehicle must be at rest');
  if (
    model.rigidBodies?.some(
      (b) => b.velocity?.some((v) => v !== 0) || b.rotation?.some((v) => v !== 0),
    )
  )
    refuse('the vehicle’s rigid bodies must be at rest');
  if (!model.contact) refuse('the vehicle has no contact (the headform touches it by contact)');
  const n = model.nodes.length / 3;
  if (!n) refuse('the model has no nodes');

  const a = (angle * Math.PI) / 180;
  const d: [number, number, number] = [-Math.cos(a), 0, -Math.sin(a)];
  // Clean −0 and the round-off of cos 90°.
  if (Math.abs(d[0]) < 1e-15) d[0] = 0;
  const radius = diameter / 2;
  const x = model.nodes;
  const half = new Float64Array(n);
  for (let e = 0; e < model.thickness.length; e++)
    for (let c = 0; c < 4; c++) {
      const i = model.shells[4 * e + c]!;
      half[i] = Math.max(half[i]!, model.thickness[e]! / 2);
    }
  // The centre on the line target − s·d, coming in from far back (large s): the first touch is
  // at the largest s at which the sphere of ρ = radius + gap + half thickness meets a node, a
  // shell's edge or a shell's face (each quad as two triangles).
  const hi = firstTouch(model, options.target, d, radius + gap, half);
  if (hi === -Infinity) refuse('the impact line misses the vehicle');
  // How far the centre goes along the line before the headform itself (no gap) first touches:
  // the gap is a clearance, which an oblique line takes longer to close.
  const approach = hi - firstTouch(model, options.target, d, radius, half);
  const [tx, ty, tz] = options.target;
  const start: [number, number, number] = [tx - hi * d[0], ty - hi * d[1], tz - hi * d[2]];

  const ball = sphere(start, radius - skin / 2, k);
  const first = n;
  const count = ball.points.length / 3;
  const nodes = new Float64Array(3 * (n + count));
  nodes.set(x);
  nodes.set(ball.points, 3 * n);
  const shellsBefore = model.thickness.length;
  const quadCount = ball.quads.length / 4;
  const shells = new Uint32Array(4 * (shellsBefore + quadCount));
  shells.set(model.shells);
  shells.set(
    ball.quads.map((i) => i + first),
    4 * shellsBefore,
  );
  const thickness = new Float64Array(shellsBefore + quadCount);
  thickness.set(model.thickness);
  thickness.fill(skin, shellsBefore);
  // The headform's own material: steel-stiff but of next to no mass (the body's mass is given);
  // its shells move rigidly, so only their mass and contact thickness count.
  const materials = [
    ...model.materials,
    { density: 1e-15, youngsModulus: 210_000, poissonRatio: 0.3 },
  ];
  if (materials.length > 65_535) refuse('too many materials');
  const shellMaterial = new Uint16Array(shellsBefore + quadCount);
  shellMaterial.set(model.shellMaterial);
  shellMaterial.fill(materials.length - 1, shellsBefore);
  let shellPart: Uint16Array | undefined;
  if (model.shellPart) {
    const top = model.shellPart.reduce((p, q) => Math.max(p, q), 0);
    if (top + 1 > 65_535) refuse('too many parts');
    shellPart = new Uint16Array(shellsBefore + quadCount);
    shellPart.set(model.shellPart);
    shellPart.fill(top + 1, shellsBefore);
  }
  const grow = <T extends Uint8Array | Float64Array>(
    a: T | undefined,
    per: number,
    make: (n: number) => T,
  ) => {
    if (!a) return undefined;
    const b = make(per * (n + count));
    b.set(a);
    return b;
  };
  const mass = massKg / 1000; // t
  // A uniform solid sphere: 2/5·m·r² (the adult's 12.25 kg·cm² is within GTR 9's 0.010–0.013 kg·m²).
  const inertia = 0.4 * mass * radius * radius;
  const v = d.map((q) => q * speed) as [number, number, number];
  return {
    direction: d,
    centre: first,
    start,
    nodes: { first, count },
    shells: { first: shellsBefore, count: quadCount },
    approach,
    mass: massKg,
    diameter,
    model: {
      ...model,
      nodes,
      shells,
      thickness,
      shellMaterial,
      materials,
      shellPart,
      fixed: grow(model.fixed, 1, (m) => new Uint8Array(m)),
      velocity: grow(model.velocity, 3, (m) => new Float64Array(m)),
      rotation: grow(model.rotation, 3, (m) => new Float64Array(m)),
      rigidBodies: [
        ...(model.rigidBodies ?? []),
        {
          nodes: Array.from({ length: count }, (_, q) => first + q),
          mass,
          inertia: [inertia, inertia, inertia],
          velocity: v,
          rotation: [0, 0, 0],
        },
      ],
      contact: { ...model.contact, friction },
    },
  };
}

export interface HeadImpactMeasures {
  /** Even sample times (s); the centre's resultant acceleration (g) unfiltered and in CFC 1000. */
  time: Float64Array;
  raw: Float64Array;
  cfc1000: Float64Array;
  peakG: number;
  /** HIC15 from the CFC 1000 resultant, and its window (s); null when the head never slowed. */
  hic15: HicResult | null;
  /** How far the centre went along the travel after the first touch (mm): the dynamic deflection. */
  deflection: number;
  /** The centre's speed along the travel at the end (m/s, negative rebounding). */
  endSpeed: number;
}

export interface HeadImpactMeasureOptions {
  centre: number;
  direction: [number, number, number];
  /** The centre's travel from its start to the first touch (mm, the setup's `approach`). */
  approach: number;
  /** Even sample step (s), 1e-5 by default (100 kHz). */
  sampleStep?: number;
}

/**
 * The head impact's measures from the centre node's history: the resultant of the three
 * components' accelerations, each through CFC 1000 (SAE J211 for the head), its peak and HIC15;
 * the deflection; the end speed.
 */
export function headImpactMeasures(
  result: ExplicitResult,
  options: HeadImpactMeasureOptions,
): HeadImpactMeasures {
  const h = result.history.find((r) => r.node === options.centre);
  if (!h) throw new RangeError(`headImpactMeasures: node ${options.centre} has no history`);
  const m = h.time.length;
  if (m < 3) throw new RangeError('headImpactMeasures: the history needs three samples or more');
  const step = options.sampleStep ?? 1e-5;
  const comps = [0, 1, 2].map((c) =>
    resample(
      h.time,
      Float64Array.from({ length: m }, (_, k) => h.velocity[3 * k + c]! / 1000),
      step,
    ),
  );
  const time = comps[0]!.t;
  const count = time.length;
  if (count < 3)
    throw new RangeError('headImpactMeasures: the run is shorter than three sample steps');
  const accel = comps.map(({ y }) => {
    const out = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const a = Math.max(0, k - 1);
      const b = Math.min(count - 1, k + 1);
      out[k] = (y[b]! - y[a]!) / ((b - a) * step) / standardGravity;
    }
    return out;
  });
  const filtered = accel.map((c) => cfcFilter(c, step, 1000));
  const resultant = (q: Float64Array[]) =>
    Float64Array.from({ length: count }, (_, k) => Math.hypot(q[0]![k]!, q[1]![k]!, q[2]![k]!));
  const raw = resultant(accel);
  const cfc1000 = resultant(filtered);
  const peakG = cfc1000.reduce((p, q) => Math.max(p, q), 0);
  const hic = headInjuryCriterion(time, cfc1000, 0.015);
  const [dx, dy, dz] = options.direction;
  let travel = 0;
  for (let k = 0; k < m; k++)
    travel = Math.max(
      travel,
      h.displacement[3 * k]! * dx +
        h.displacement[3 * k + 1]! * dy +
        h.displacement[3 * k + 2]! * dz,
    );
  const last = m - 1;
  const endSpeed =
    (h.velocity[3 * last]! * dx + h.velocity[3 * last + 1]! * dy + h.velocity[3 * last + 2]! * dz) /
    1000;
  return {
    time,
    raw,
    cfc1000,
    peakG,
    hic15: hic.hic > 0 ? hic : null,
    deflection: Math.max(0, travel - options.approach),
    endSpeed,
  };
}
