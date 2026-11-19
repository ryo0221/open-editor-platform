/**
 * VS5a (docs/cad/vehicle-simulation.md, VS5): explicit dynamics of thin shells for crash
 * analysis. Central differences in time on lumped masses; four-node Belytschko–Tsay shells (one
 * point in the plane, Gauss points through the thickness, a corotational frame per element, a
 * three-node triangle as a quad with its last node repeated) with stiffness hourglass control
 * (Belytschko–Tsay); added point masses, fixed components, initial velocities, constant nodal
 * forces and gravity. The step comes from the smallest element and the plate wave speed; the run
 * keeps the kinetic, internal, hourglass and external energies and checks their balance.
 *
 * Units mm–N–MPa–t–s, as the rest of geometry-fem (steel: E 210 000 MPa, ρ 7.85e-9 t/mm³; the
 * plate wave speed is then about 5.4e6 mm/s and a 5 mm element steps about 1 µs).
 *
 * VS5b adds J2 plasticity in plane stress (piecewise linear hardening, Cowper–Symonds strain
 * rate; the transverse shear stays elastic and the thickness is not updated), erasing shells past
 * their failure strain, mass scaling to a smallest step, and prescribed velocities (a held
 * component keeps its initial velocity; its work counts as external).
 *
 * VS5c adds two-node beams (corotational, elastic resultants, Timoshenko shear at one point) and
 * rigid bodies (sets of nodes moving as one, with their own mass, inertia and held components).
 *
 * VS6a adds contact (`explicit-contact.ts`); VS6b spot welds as rigid links: each weld ties the
 * nodes of its two sheets around its point into one rigid body, so it follows finite rotations,
 * keeps the offset between the sheets' midsurfaces turning with them and carries mass, inertia,
 * forces and moments.
 *
 * Out of scope here: weld failure; beam plasticity. Warped quads are taken
 * flat in their mean plane (no warping correction): keep quads near planar.
 */

import {
  ContactSet,
  type ExplicitContact,
  type ExplicitPole,
  type ExplicitWall,
} from './explicit-contact';

export type { ExplicitContact, ExplicitPole, ExplicitWall } from './explicit-contact';

export type ExplicitProblem =
  | 'model-invalid'
  | 'element-inverted'
  | 'unstable'
  | 'too-large'
  | 'cancelled';

export class ExplicitError extends Error {
  constructor(
    readonly problem: ExplicitProblem,
    readonly detail: string,
  ) {
    super(`${problem}: ${detail}`);
    this.name = 'ExplicitError';
  }
}

/** A material: linear elastic, or with J2 (von Mises) plasticity (VS5b). */
export interface ExplicitMaterial {
  /** t/mm³ */
  density: number;
  /** MPa */
  youngsModulus: number;
  poissonRatio: number;
  plastic?: ExplicitPlasticity;
}

/**
 * VS5b: J2 plasticity with isotropic hardening. The flow stress against the equivalent plastic
 * strain is piecewise linear through the points (the first at strain 0 is the yield stress),
 * flat past the last; Cowper–Symonds scales it with the strain rate; a shell is erased when
 * more than half its thickness points pass the failure strain.
 */
export interface ExplicitPlasticity {
  /** Equivalent plastic strain, from 0, rising. */
  strain: number[];
  /** Flow stress (MPa) at each strain, not falling. */
  stress: number[];
  /** σ = σ₀(εp)·(1 + (ε̇/C)^(1/p)), C in 1/s. */
  cowperSymonds?: { C: number; p: number };
  failureStrain?: number;
}

/** VS5c: a beam's cross-section, about its local axes 2 and 3. */
export interface ExplicitBeamSection {
  /** mm² */
  area: number;
  /** Second moments of area about the local axes 2 and 3 (mm⁴). */
  i2: number;
  i3: number;
  /** Torsion constant (mm⁴). */
  j: number;
}

/**
 * VS5c: nodes that move as one rigid body. Its mass and inertia are its nodes' (from the shells,
 * beams and point masses on them) plus `mass` at their centroid and `inertia` (principal, about
 * the global axes through the body's centre). Its own velocities replace its nodes'.
 */
export interface ExplicitRigidBody {
  nodes: number[];
  /** t */
  mass?: number;
  /** t·mm² about x, y, z through the centre. */
  inertia?: [number, number, number];
  /** mm/s of its centre; rad/s. */
  velocity?: [number, number, number];
  rotation?: [number, number, number];
  /**
   * Held components (kept at the initial velocity): bits 0–2 the centre's x, y, z, bits 3–5 the
   * rotation (all three or none).
   */
  held?: number;
}

/**
 * VS6b: a spot weld at `point` between the shells of `parts` (indices into `shellPart`): on each
 * part the nodes within `radius` of the point, or the nodes of its shell nearest the point where
 * none is that near (the node choice of the static welds, CR5b).
 */
export interface ExplicitWeld {
  point: [number, number, number];
  /** mm */
  radius: number;
  parts: [number, number];
  /**
   * VS8c-2: with no node within the radius on a part, take that part's nearest node alone, not
   * the nearest shell's corners: on a mesh coarser than the weld pitch, neighbouring welds' shells
   * share corners and would join a row of welds into one rigid body.
   */
  nearestNode?: boolean;
}

export interface ExplicitModel {
  /** x, y, z per node (mm). */
  nodes: Float64Array;
  /**
   * Four nodes per shell, counter-clockwise about the normal; a triangle repeats its third node
   * as the fourth.
   */
  shells: Uint32Array;
  /** Thickness per shell (mm). */
  thickness: Float64Array;
  /** Material index per shell (into `materials`). */
  shellMaterial: Uint16Array;
  materials: ExplicitMaterial[];
  /** Point masses (t) on nodes, with no rotational inertia of their own. */
  masses?: { node: number; mass: number }[];
  /**
   * Held components per node: bits 0–2 the x, y, z translations, bits 3–5 the rotations (global
   * axes). A held component keeps its initial velocity (0 unless `velocity` or `rotation` gives
   * one): 63 clamps a node, a held component with a velocity is a prescribed velocity.
   */
  fixed?: Uint8Array;
  /** Initial translational velocity per node (mm/s, 3 per node). */
  velocity?: Float64Array;
  /** Initial angular velocity per node (rad/s about the global axes, 3 per node). */
  rotation?: Float64Array;
  /** Constant nodal forces (N). */
  forces?: { node: number; force: [number, number, number] }[];
  /** Gravity (mm/s²) on every mass. */
  gravity?: [number, number, number];
  /** VS5c: two nodes per beam. */
  beams?: Uint32Array;
  /** Section and material index per beam. */
  beamSection?: Uint16Array;
  beamMaterial?: Uint16Array;
  sections?: ExplicitBeamSection[];
  /** Per beam a vector off its axis that sets its local axis 2 (3 per beam). */
  beamOrientation?: Float64Array;
  /** VS5c: rigid bodies; a node belongs to one at most and is not `fixed`. */
  rigidBodies?: ExplicitRigidBody[];
  /** VS6b: a part index per shell (for welds), and the spot welds. */
  shellPart?: Uint16Array;
  welds?: ExplicitWeld[];
  /**
   * VS8c: node ties, pairs of a follower node and the node it follows (a bond's seam in a crash
   * run): the follower moves with that node as on a rigid arm (its velocity the other's plus the
   * other's turn across the arm, the same turn), its mass, inertia and loads carried by it. Each
   * tie stays local: a node follows one node, a chain of ties follows its last node, and only a
   * tie that touches a rigid body or a weld's link joins that body. A followed node held must be
   * held in all six components (its followers then are too).
   */
  ties?: Uint32Array;
  /** VS6a: contact of every shell with every node (self contact included). */
  contact?: ExplicitContact;
  /** VS6a: fixed rigid walls and poles against the nodes. */
  walls?: ExplicitWall[];
  poles?: ExplicitPole[];
}

export interface ExplicitSettings {
  /** s */
  endTime: number;
  /** The step as a share of the stable one (≤ 0.95). */
  stepScale: number;
  /** Hourglass coefficient (stiffness form), 0.01–0.15. */
  hourglass: number;
  /** Gauss points through the thickness, 2–5. */
  thicknessPoints: number;
  /** Frames (displacements) every this many seconds, and at the end. */
  frameEvery: number;
  /**
   * VS5b: mass scaling: shells whose stable step is below this (s) get mass added to their nodes
   * so that it is this; the added share of the mass is reported (`mass-scaling`).
   */
  minStep?: number;
  /**
   * VS8c: without `minStep`, mass scaling to the longest smallest step that adds no more than
   * this share of the model's mass (0–0.05, as the `mass-scaling` check counts it) and no longer
   * than the 25th percentile shell's step: the small or thin shells of a CAD mesh (a sliver
   * would set the whole run's step) get mass, the rest none.
   */
  massScalingShare?: number;
  /** Nodes whose displacement and velocity are kept every `historyEvery` steps. */
  historyNodes?: number[];
  historyEvery?: number;
}

export const explicitDefaults: Readonly<Omit<ExplicitSettings, 'endTime' | 'frameEvery'>> = {
  stepScale: 0.9,
  hourglass: 0.1,
  thicknessPoints: 5,
};

export const explicitLimits = {
  /** Shells in one model (the browser's share is set by the run, VS7). */
  shells: 2_000_000,
  beams: 500_000,
  rigidBodies: 10_000,
  welds: 100_000,
  ties: 1_000_000,
  steps: 5_000_000,
  frames: 2_000,
};

export interface ExplicitEnergies {
  time: number;
  kinetic: number;
  internal: number;
  hourglass: number;
  /** Work done on the model by its forces and gravity. */
  external: number;
  /** VS6a: energy taken by the contacts (penalty springs and friction). */
  contact: number;
  /**
   * VS7a: with `shellPart`, the internal energy (strain and plastic work, no hourglass) of each
   * part's shells, indexed by part.
   */
  parts?: number[];
}

export interface ExplicitCheck {
  name: 'energy-balance' | 'hourglass-energy' | 'mass-scaling';
  pass: boolean;
  detail: string;
}

export interface ExplicitResult {
  /** s */
  step: number;
  steps: number;
  /**
   * Frame times (s), displacements (3 per node, mm), the largest equivalent plastic strain
   * through each shell's thickness and the shells erased by then (1).
   */
  frames: {
    time: number;
    displacement: Float32Array;
    plasticStrain: Float32Array;
    erased: Uint8Array;
  }[];
  /** Mass added by mass scaling (t) and its share of the model's mass. */
  addedMass: number;
  addedMassShare: number;
  /** Energies at each frame. */
  energies: ExplicitEnergies[];
  /** Per history node: times and its displacement and velocity (3 each per sample). */
  history: {
    node: number;
    time: Float64Array;
    displacement: Float64Array;
    velocity: Float64Array;
  }[];
  /** VS6a: the force on each wall and pole (N, 3 per sample) at the history times. */
  barriers: { kind: 'wall' | 'pole'; index: number; time: Float64Array; force: Float64Array }[];
  checks: ExplicitCheck[];
}

/** Gauss–Legendre points and weights on [−1, 1]. */
const gauss: Record<number, [number[], number[]]> = {
  2: [
    [-1 / Math.sqrt(3), 1 / Math.sqrt(3)],
    [1, 1],
  ],
  3: [
    [-Math.sqrt(0.6), 0, Math.sqrt(0.6)],
    [5 / 9, 8 / 9, 5 / 9],
  ],
  4: [
    [-0.8611363115940526, -0.3399810435848563, 0.3399810435848563, 0.8611363115940526],
    [0.3478548451374538, 0.6521451548625461, 0.6521451548625461, 0.3478548451374538],
  ],
  5: [
    [-0.906179845938664, -0.5384693101056831, 0, 0.5384693101056831, 0.906179845938664],
    [
      0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665,
      0.2369268850561891,
    ],
  ],
};

const noReturn = { stress: [0, 0, 0] as [number, number, number], dEps: 0 };

/** Shear correction factor of the transverse shear. */
const shearFactor = 5 / 6;
const hourglassVector = [1, -1, 1, -1];

function invalid(detail: string): never {
  throw new ExplicitError('model-invalid', detail);
}

function checkPlasticity(p: ExplicitPlasticity) {
  const { strain, stress } = p;
  if (
    !Array.isArray(strain) ||
    !Array.isArray(stress) ||
    strain.length < 1 ||
    strain.length !== stress.length ||
    strain[0] !== 0 ||
    ![...strain, ...stress].every(Number.isFinite) ||
    !(stress[0]! > 0)
  )
    invalid('a flow curve needs matching strains from 0 and a positive yield stress');
  for (let k = 1; k < strain.length; k++)
    if (!(strain[k]! > strain[k - 1]!) || stress[k]! < stress[k - 1]!)
      invalid('a flow curve needs rising strains and stresses that do not fall');
  const cs = p.cowperSymonds;
  if (cs && !(cs.C > 0 && cs.p > 0 && Number.isFinite(cs.C) && Number.isFinite(cs.p)))
    invalid('Cowper–Symonds needs positive C and p');
  if (p.failureStrain !== undefined && !(p.failureStrain > 0 && Number.isFinite(p.failureStrain)))
    invalid('the failure strain must be positive');
}

/** The flow stress at an equivalent plastic strain (flat past the last point). */
export function flowStress(p: ExplicitPlasticity, eps: number): number {
  const { strain, stress } = p;
  const last = strain.length - 1;
  if (eps >= strain[last]!) return stress[last]!;
  let k = 0;
  while (strain[k + 1]! <= eps) k++;
  return (
    stress[k]! +
    ((stress[k + 1]! - stress[k]!) * (eps - strain[k]!)) / (strain[k + 1]! - strain[k]!)
  );
}

/**
 * Plane-stress J2 return (Simo & Taylor 1985): the trial stress (σx, σy, τxy) back onto the
 * yield surface. In the eigenbasis of the projection P the stress shrinks by 1/(1 + EΔγ/(3(1−ν)))
 * (the mean of σx, σy) and 1/(1 + 2GΔγ) (the rest); the consistency condition on Δγ is solved by
 * Illinois regula falsi. `scale` multiplies the flow stress (Cowper–Symonds). Returns the stress
 * and the equivalent plastic strain increment; the trial itself when it does not yield.
 */
export function planeStressReturn(
  trial: [number, number, number],
  E: number,
  nu: number,
  p: ExplicitPlasticity,
  eps: number,
  scale = 1,
): { stress: [number, number, number]; dEps: number } {
  const [sx, sy, txy] = trial;
  const G = E / (2 * (1 + nu));
  const a1 = (sx + sy) ** 2 / 2;
  const a2 = (sy - sx) ** 2 / 2;
  const a3 = txy * txy;
  // ½σᵀPσ = σ₁²/6 + σ₂²/2 + τ² with σ₁ = (σx + σy)/√2, σ₂ = (σy − σx)/√2.
  const half = (g: number) => {
    const m = 1 + (E * g) / (3 * (1 - nu));
    const d = 1 + 2 * G * g;
    return a1 / (6 * m * m) + (a2 / 2 + a3) / (d * d);
  };
  // Δεp = (2/3) Δγ σeq with σeq² = 3·½σᵀPσ.
  const dEpsOf = (g: number) => (2 / 3) * g * Math.sqrt(3 * half(g));
  const f = (g: number) => {
    const y = scale * flowStress(p, eps + dEpsOf(g));
    return half(g) - (y * y) / 3;
  };
  let lo = 0;
  let flo = f(0);
  if (flo <= 0) return { stress: trial, dEps: 0 };
  let hi = 1 / E;
  let fhi = f(hi);
  while (fhi > 0) {
    lo = hi;
    flo = fhi;
    hi *= 4;
    fhi = f(hi);
  }
  const tol = 1e-12 * (scale * p.stress[0]!) ** 2;
  let g = hi;
  let side = 0;
  for (let it = 0; it < 100; it++) {
    g = (lo * fhi - hi * flo) / (fhi - flo);
    const fg = f(g);
    if (Math.abs(fg) <= tol) break;
    if (fg > 0) {
      lo = g;
      flo = fg;
      if (side === 1) fhi /= 2;
      side = 1;
    } else {
      hi = g;
      fhi = fg;
      if (side === -1) flo /= 2;
      side = -1;
    }
  }
  const m = 1 + (E * g) / (3 * (1 - nu));
  const d = 1 + 2 * G * g;
  const s1 = (sx + sy) / 2 / m;
  const s2 = (sy - sx) / 2 / d;
  return { stress: [s1 - s2, s1 + s2, txy / d], dEps: dEpsOf(g) };
}

function checkBeamsAndBodies(model: ExplicitModel, n: number) {
  const beams = model.beams;
  if (beams) {
    const nb = beams.length / 2;
    if (!Number.isInteger(nb)) invalid('beams must be two nodes each');
    if (nb > explicitLimits.beams)
      throw new ExplicitError('too-large', `${nb} beams exceed ${explicitLimits.beams}`);
    const sections = model.sections ?? [];
    if (
      model.beamSection?.length !== nb ||
      model.beamMaterial?.length !== nb ||
      model.beamOrientation?.length !== 3 * nb
    )
      invalid('one section, one material and one orientation per beam');
    for (const q of sections)
      if (![q.area, q.i2, q.i3, q.j].every((v) => v > 0 && Number.isFinite(v)))
        invalid('a section needs a positive area, second moments and torsion constant');
    for (let b = 0; b < nb; b++) {
      const i = beams[2 * b]!;
      const j = beams[2 * b + 1]!;
      if (i >= n || j >= n) invalid('a beam names a node that is not there');
      if (i === j) invalid(`beam ${b} has one node twice`);
      if (model.beamSection![b]! >= sections.length) invalid(`beam ${b} has no section`);
      if (model.beamMaterial![b]! >= model.materials.length) invalid(`beam ${b} has no material`);
      const d = [0, 1, 2].map((a) => model.nodes[3 * j + a]! - model.nodes[3 * i + a]!);
      const o = [0, 1, 2].map((a) => model.beamOrientation![3 * b + a]!);
      const l = norm(d);
      if (!(l > 0)) invalid(`beam ${b} has no length`);
      if (!o.every(Number.isFinite) || !(norm(cross(d, o)) > 1e-6 * l * norm(o)))
        invalid(`beam ${b}'s orientation lies along its axis`);
    }
  }
  const bodies = model.rigidBodies ?? [];
  if (bodies.length > explicitLimits.rigidBodies)
    throw new ExplicitError(
      'too-large',
      `${bodies.length} rigid bodies exceed ${explicitLimits.rigidBodies}`,
    );
  const seen = new Uint8Array(n);
  for (const r of bodies) {
    if (!Array.isArray(r.nodes) || r.nodes.length < 1) invalid('a rigid body needs nodes');
    for (const i of r.nodes) {
      if (!(Number.isInteger(i) && i >= 0 && i < n)) invalid('a rigid body names a missing node');
      if (seen[i]) invalid(`node ${i} is in two rigid bodies, or twice in one`);
      seen[i] = 1;
      if (model.fixed?.[i]) invalid(`node ${i} is in a rigid body and fixed: hold the body`);
    }
    if (r.mass !== undefined && !(r.mass >= 0 && Number.isFinite(r.mass)))
      invalid('a rigid body mass must not be negative');
    if (r.inertia && !r.inertia.every((v) => v >= 0 && Number.isFinite(v)))
      invalid('a rigid body inertia must not be negative');
    for (const v of [r.velocity, r.rotation])
      if (v && !(v.length === 3 && v.every(Number.isFinite)))
        invalid('a rigid body velocity needs three finite components');
    const held = r.held ?? 0;
    if (!(Number.isInteger(held) && held >= 0 && held < 64) || ![0, 56].includes(held & 56))
      invalid('a rigid body holds its x, y, z and all of its rotation or none of it');
  }
}

function checkWelds(model: ExplicitModel, shells: number) {
  if (model.shellPart && model.shellPart.length !== shells)
    invalid('shellPart needs a part per shell');
  const welds = model.welds ?? [];
  if (!welds.length) return;
  if (welds.length > explicitLimits.welds)
    throw new ExplicitError('too-large', `${welds.length} welds exceed ${explicitLimits.welds}`);
  if (model.shellPart?.length !== shells) invalid('welds need a part per shell');
  const parts = new Set(model.shellPart);
  for (const w of welds)
    if (
      !(Array.isArray(w.point) && w.point.length === 3 && w.point.every(Number.isFinite)) ||
      !(w.radius > 0 && Number.isFinite(w.radius)) ||
      !(Array.isArray(w.parts) && w.parts.length === 2) ||
      w.parts[0] === w.parts[1] ||
      !w.parts.every((q) => parts.has(q)) ||
      (w.nearestNode !== undefined && typeof w.nearestNode !== 'boolean')
    )
      invalid(
        'a weld needs a point, a positive radius, two parts with shells and nearestNode a boolean',
      );
}

/**
 * VS6b: the nodes a weld ties on one part: those within its radius, else the nearest shell's
 * (VS8c-2, `nearestNode`: else that shell's nearest corner alone).
 */
export function explicitWeldNodes(
  model: ExplicitModel,
  shellsOfPart: readonly number[],
  point: readonly number[],
  radius: number,
  nearestNode = false,
): number[] {
  const x = model.nodes;
  const at = (i: number) => [x[3 * i]!, x[3 * i + 1]!, x[3 * i + 2]!];
  const nodes = new Set<number>();
  for (const e of shellsOfPart)
    for (let k = 0; k < 4; k++) {
      const i = model.shells[4 * e + k]!;
      const p = at(i);
      if (Math.hypot(p[0]! - point[0]!, p[1]! - point[1]!, p[2]! - point[2]!) <= radius)
        nodes.add(i);
    }
  if (nodes.size) return [...nodes].sort((a, b) => a - b);
  let best = shellsOfPart[0]!;
  let bestD = Infinity;
  for (const e of shellsOfPart) {
    const s = model.shells.subarray(4 * e, 4 * e + 4);
    for (const t of s[3] === s[2]
      ? [[0, 1, 2]]
      : [
          [0, 1, 2],
          [0, 2, 3],
        ]) {
      const [a, b, c] = t.map((k) => at(s[k]!)) as [number[], number[], number[]];
      const [u, v] = closestOnTriangle(point, a, b, c);
      const d = Math.hypot(
        ...[0, 1, 2].map((q) => point[q]! - ((1 - u - v) * a[q]! + u * b[q]! + v * c[q]!)),
      );
      if (d < bestD) [best, bestD] = [e, d];
    }
  }
  const corners = [...new Set(model.shells.subarray(4 * best, 4 * best + 4))];
  if (nearestNode) {
    const d = (i: number) => {
      const p = at(i);
      return Math.hypot(p[0]! - point[0]!, p[1]! - point[1]!, p[2]! - point[2]!);
    };
    return [corners.reduce((a, b) => (d(b) < d(a) ? b : a))];
  }
  return corners.sort((a, b) => a - b);
}

/**
 * VS6b: the rigid bodies with the welds' links: welds that share a node, or a node of a rigid
 * body, become one body (a body keeps its own mass, velocities and holding); a weld alone moves
 * with its nodes' mean velocity. Two given bodies joined by welds are refused.
 */
function linkedBodies(model: ExplicitModel): LinkedBody[] {
  const user = model.rigidBodies ?? [];
  const welds = model.welds ?? [];
  const ties = model.ties ?? new Uint32Array();
  if (!welds.length && !(user.length && ties.length)) return user;
  const n = model.nodes.length / 3;
  const groups = user.length + welds.length;
  const parent = Int32Array.from({ length: groups }, (_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
  const owner = new Int32Array(n).fill(-1);
  const take = (i: number, g: number) => {
    if (owner[i]! < 0) owner[i] = g;
    else {
      const a = find(owner[i]!);
      const b = find(g);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  };
  user.forEach((r, k) => r.nodes.forEach((i) => take(i, k)));
  const byPart = new Map<number, number[]>();
  // The shells of each part, for the welds (ties alone need no parts).
  if (welds.length)
    model.shellPart!.forEach((q, e) => {
      if (!byPart.has(q)) byPart.set(q, []);
      byPart.get(q)!.push(e);
    });
  welds.forEach((w, k) => {
    for (const q of w.parts)
      for (const i of explicitWeldNodes(model, byPart.get(q)!, w.point, w.radius, w.nearestNode)) {
        if (model.fixed?.[i]) invalid(`node ${i} is in a weld and fixed`);
        take(i, user.length + k);
      }
  });
  // VS8c: a tie with a node in a body (or a weld's link) brings its other node into that body,
  // so a chain of ties into a body joins it whole.
  for (let changed = ties.length > 0; changed; ) {
    changed = false;
    for (let t = 0; t < ties.length; t += 2) {
      const [a, b] = [ties[t]!, ties[t + 1]!];
      if (owner[a]! < 0 === owner[b]! < 0) {
        if (owner[a]! >= 0 && find(owner[a]!) !== find(owner[b]!)) take(b, owner[a]!);
        continue;
      }
      const g = owner[a]! >= 0 ? owner[a]! : owner[b]!;
      for (const i of [a, b]) {
        if (model.fixed?.[i]) invalid(`node ${i} is tied into a rigid body and fixed`);
        take(i, g);
      }
      changed = true;
    }
  }
  const nodes = new Map<number, number[]>();
  for (let i = 0; i < n; i++)
    if (owner[i]! >= 0) {
      const g = find(owner[i]!);
      if (!nodes.has(g)) nodes.set(g, []);
      nodes.get(g)!.push(i);
    }
  for (let k = 1; k < user.length; k++)
    if (find(k) < user.length && find(k) !== k)
      invalid(`welds join rigid bodies ${find(k)} and ${k}`);
  // A given body keeps its added mass and its motion's reference at its own nodes.
  return [...nodes.entries()].map(([g, list]) =>
    g < user.length
      ? { ...user[g]!, nodes: list, ownNodes: user[g]!.nodes }
      : { nodes: list, fromNodes: true },
  );
}

/**
 * A rigid body as the solver builds it: a weld's link moves with its nodes (`fromNodes`); a
 * given body joined by welds (`ownNodes`, its own nodes) keeps its added mass at their centroid,
 * and its velocity stays that of its own centre (the joined body's centre moves on ω × the shift).
 */
type LinkedBody = ExplicitRigidBody & { fromNodes?: boolean; ownNodes?: number[] };

/** Checks the model and settings (`model-invalid`, `too-large`). */
export function checkExplicitModel(model: ExplicitModel, settings: ExplicitSettings): void {
  const n = model.nodes.length / 3;
  if (!Number.isInteger(n) || n < 1) invalid('nodes must be x, y, z triples');
  if (!model.nodes.every(Number.isFinite)) invalid('a node is not finite');
  const shells = model.shells.length / 4;
  if (!Number.isInteger(shells)) invalid('shells must be four nodes each');
  checkBeamsAndBodies(model, n);
  checkWelds(model, shells);
  if (shells + (model.beams?.length ?? 0) + (model.rigidBodies?.length ?? 0) < 1)
    invalid('a model needs a shell, a beam or a rigid body');
  if (shells > explicitLimits.shells)
    throw new ExplicitError('too-large', `${shells} shells exceed ${explicitLimits.shells}`);
  if (model.thickness.length !== shells || model.shellMaterial.length !== shells)
    invalid('one thickness and one material per shell');
  for (const v of model.shells) if (v >= n) invalid('a shell names a node that is not there');
  for (let e = 0; e < shells; e++) {
    const t = model.thickness[e]!;
    if (!(t > 0 && Number.isFinite(t))) invalid(`shell ${e} has no thickness`);
    if (model.shellMaterial[e]! >= model.materials.length) invalid(`shell ${e} has no material`);
    const s = model.shells.subarray(4 * e, 4 * e + 4);
    if (s[0] === s[1] || s[1] === s[2] || s[0] === s[2] || s[0] === s[3] || s[1] === s[3])
      invalid(`shell ${e} repeats a node other than a triangle's last`);
  }
  for (const m of model.materials)
    if (
      !(m.density > 0 && m.youngsModulus > 0 && m.poissonRatio >= 0 && m.poissonRatio < 0.5) ||
      ![m.density, m.youngsModulus, m.poissonRatio].every(Number.isFinite)
    )
      invalid('a material has no positive density and modulus, or ν outside [0, 0.5)');
  for (const m of model.materials) if (m.plastic) checkPlasticity(m.plastic);
  for (const p of model.masses ?? [])
    if (
      !(
        Number.isInteger(p.node) &&
        p.node >= 0 &&
        p.node < n &&
        p.mass > 0 &&
        Number.isFinite(p.mass)
      )
    )
      invalid('a point mass needs a node and a positive mass');
  if (model.fixed && model.fixed.length !== n) invalid('one fixed mask per node');
  if (model.velocity && (model.velocity.length !== 3 * n || !model.velocity.every(Number.isFinite)))
    invalid('three finite initial velocity components per node');
  if (model.rotation && (model.rotation.length !== 3 * n || !model.rotation.every(Number.isFinite)))
    invalid('three finite initial angular velocity components per node');
  for (const f of model.forces ?? [])
    if (!(Number.isInteger(f.node) && f.node >= 0 && f.node < n && f.force.every(Number.isFinite)))
      invalid('a force needs a node and three finite components');
  if (model.gravity && !model.gravity.every(Number.isFinite)) invalid('gravity is not finite');
  const c = model.contact;
  if (
    c &&
    ((c.friction !== undefined && !(c.friction >= 0 && Number.isFinite(c.friction))) ||
      (c.penalty !== undefined && !(c.penalty > 0 && c.penalty <= 1)) ||
      (c.ignoreInitial !== undefined && typeof c.ignoreInitial !== 'boolean'))
  )
    invalid(
      'contact friction must not be negative, the penalty must be in (0, 1] and ignoreInitial a boolean',
    );
  const finite3 = (p: unknown) =>
    Array.isArray(p) && p.length === 3 && p.every((q) => Number.isFinite(q));
  for (const w of model.walls ?? [])
    if (
      !finite3(w.point) ||
      !finite3(w.normal) ||
      !(Math.hypot(...w.normal) > 0) ||
      !((w.friction ?? 0) >= 0)
    )
      invalid('a wall needs a point, a normal and no negative friction');
  for (const q of model.poles ?? [])
    if (
      !finite3(q.point) ||
      !finite3(q.axis) ||
      !(Math.hypot(...q.axis) > 0) ||
      !(q.radius > 0 && Number.isFinite(q.radius)) ||
      !((q.friction ?? 0) >= 0)
    )
      invalid('a pole needs a point, an axis, a radius and no negative friction');
  const { endTime, stepScale, hourglass, thicknessPoints, frameEvery } = settings;
  if (!(endTime > 0 && Number.isFinite(endTime))) invalid('the end time must be positive');
  if (!(stepScale > 0 && stepScale <= 0.95)) invalid('the step scale must be in (0, 0.95]');
  if (!(hourglass >= 0.01 && hourglass <= 0.15))
    invalid('the hourglass coefficient must be in [0.01, 0.15]');
  if (!gauss[thicknessPoints]) invalid('2 to 5 points through the thickness');
  if (!(frameEvery > 0) || endTime / frameEvery > explicitLimits.frames)
    invalid(`at most ${explicitLimits.frames} frames`);
  for (const h of settings.historyNodes ?? [])
    if (!(Number.isInteger(h) && h >= 0 && h < n)) invalid('a history node is not there');
  if (
    settings.minStep !== undefined &&
    !(settings.minStep > 0 && Number.isFinite(settings.minStep))
  )
    invalid('the smallest step must be positive');
  if (
    settings.massScalingShare !== undefined &&
    !(settings.massScalingShare >= 0 && settings.massScalingShare <= 0.05)
  )
    invalid('the mass scaling share must be in 0..0.05');
  if (
    settings.historyEvery !== undefined &&
    !(Number.isInteger(settings.historyEvery) && settings.historyEvery >= 1)
  )
    invalid('history every whole number of steps');
}

/**
 * The explicit solver, steppable (a Worker runs it in chunks): `advance(steps)` moves it on;
 * `result()` gives what it has so far.
 */
export class ExplicitSolver {
  readonly nodeCount: number;
  readonly shellCount: number;
  /** The stable step × the scale (s), from the undeformed elements. */
  readonly step: number;
  /**
   * VS6c: per shell and beam, its stable step (with any added mass) and its characteristic
   * length at the start: the step follows the elements as they crush (step × length now / then).
   */
  private readonly stepOf: Float64Array;
  private readonly lengthOf: Float64Array;
  private readonly stepOfB: Float64Array;
  private readonly lengthOfB: Float64Array;
  /** The stable step of the current shapes (s), from the last force evaluation. */
  private nextStep = Infinity;
  time = 0;
  steps = 0;
  private readonly x0: Float64Array;
  /** Current coordinates. */
  private readonly x: Float64Array;
  /** Translational and rotational velocities (at the half step). */
  private readonly v: Float64Array;
  private readonly w: Float64Array;
  private readonly mass: Float64Array;
  private readonly inertia: Float64Array;
  private readonly fExt: Float64Array;
  private readonly fInt: Float64Array;
  private readonly mInt: Float64Array;
  private readonly free: Uint8Array;
  /** Per shell and thickness point: σx, σy, τxy, τxz, τyz (local frame). */
  private readonly stress: Float64Array;
  /** Per shell: hourglass resultants (membrane x, y; w; θx, θy). */
  private readonly hg: Float64Array;
  /** Each shell's normal at the last force evaluation, to catch it turning over in a step. */
  private readonly normal: Float64Array;
  /** The step whose history sample was last kept (−1 before any). */
  private historyStep = -1;
  private readonly zeta: number[];
  private readonly weight: number[];
  private kineticBack = 0;
  private internal = 0;
  /** VS7a: the internal energy per part (with `shellPart`). */
  private partInternal: Float64Array | null = null;
  private hourglassEnergy = 0;
  private external = 0;
  private readonly frames: ExplicitResult['frames'] = [];
  private readonly energies: ExplicitEnergies[] = [];
  private nextFrame = 0;
  private lastStep = 0;
  private readonly hist: { node: number; t: number[]; u: number[]; v: number[] }[];
  private readonly xl = new Float64Array(4);
  private readonly yl = new Float64Array(4);
  private readonly b1 = new Float64Array(4);
  private readonly b2 = new Float64Array(4);
  private readonly g = new Float64Array(4);
  private readonly vl = new Float64Array(12);
  private readonly wl = new Float64Array(12);
  private readonly fl = new Float64Array(12);
  private readonly ml = new Float64Array(12);

  private readonly historyEvery: number;
  /** Per shell and thickness point: the equivalent plastic strain. */
  private readonly plastic: Float64Array;
  /** Per shell: 1 once erased. */
  private readonly erased: Uint8Array;
  readonly addedMass: number;
  readonly totalMass: number;
  readonly beamCount: number;
  /** Per beam: N, Q2, Q3, T, M2, M3 (local axes). */
  private readonly beamForce: Float64Array;
  /** Per beam: its local axis 2 (global, unit), turned with its nodes. */
  private readonly beamAxis: Float64Array;
  /** Per shell / beam: 1 when all its nodes are in one rigid body (no forces). */
  private readonly shellInert: Uint8Array;
  private readonly beamInert: Uint8Array;
  /** Per node: its rigid body, −1 if none. */
  private readonly bodyOf: Int32Array;
  /** VS8c: per node 1 when it follows another (a tie), and the ties left out of the bodies. */
  private readonly follower: Uint8Array;
  private readonly tieFrom: Uint32Array;
  private readonly tieTo: Uint32Array;
  /** Each tie's arm (from the followed node to the follower, 3 per tie, mm). */
  private readonly tieArm: Float64Array;
  /**
   * The tie groups: a followed node and its followers (ties `groupStart[g]` to
   * `groupStart[g + 1]`), moving as one rigid piece about that node; per node 1 when it leads
   * one. The node's own mass and inertia (its `mass` and `inertia` carry the group's, for the
   * contacts), and each group's accelerations (a, α) from the last solve.
   */
  private readonly groupNode: Uint32Array;
  private readonly groupStart: Uint32Array;
  private readonly leader: Uint8Array;
  private readonly ownMass: Float64Array;
  private readonly ownInertia: Float64Array;
  private readonly groupAcc: Float64Array;
  private readonly bodies: RigidState[];
  /** VS6a: the contacts, their forces now and at the last call, their energy. */
  private readonly contacts: ContactSet | null;
  private readonly fCon: Float64Array;
  private readonly fConLast: Float64Array;
  private readonly mCon: Float64Array;
  private readonly mConLast: Float64Array;
  private contactEnergy = 0;
  private readonly barrierHist: {
    kind: 'wall' | 'pole';
    index: number;
    t: number[];
    f: number[];
  }[];

  constructor(
    readonly model: ExplicitModel,
    readonly settings: ExplicitSettings,
  ) {
    checkExplicitModel(model, settings);
    const n = (this.nodeCount = model.nodes.length / 3);
    const ne = (this.shellCount = model.shells.length / 4);
    this.x0 = Float64Array.from(model.nodes);
    this.x = Float64Array.from(model.nodes);
    this.v = model.velocity ? Float64Array.from(model.velocity) : new Float64Array(3 * n);
    this.w = model.rotation ? Float64Array.from(model.rotation) : new Float64Array(3 * n);
    this.mass = new Float64Array(n);
    this.inertia = new Float64Array(n);
    this.fExt = new Float64Array(3 * n);
    this.fInt = new Float64Array(3 * n);
    this.mInt = new Float64Array(3 * n);
    const [zeta, weight] = gauss[settings.thicknessPoints]!;
    this.zeta = zeta;
    this.weight = weight;
    this.stress = new Float64Array(ne * zeta.length * 5);
    this.hg = new Float64Array(ne * 5);
    this.normal = new Float64Array(3 * ne);
    this.plastic = new Float64Array(ne * zeta.length);
    this.erased = new Uint8Array(ne);
    const nb = (this.beamCount = (model.beams?.length ?? 0) / 2);
    this.beamForce = new Float64Array(6 * nb);
    this.beamAxis = new Float64Array(3 * nb);
    this.bodyOf = new Int32Array(n).fill(-1);
    const linked = linkedBodies(model);
    linked.forEach((r, k) => {
      for (const i of r.nodes) this.bodyOf[i] = k;
    });
    const sameBody = (nodes: ArrayLike<number>) => {
      const k = this.bodyOf[nodes[0]!]!;
      for (let q = 1; q < nodes.length; q++) if (this.bodyOf[nodes[q]!] !== k) return 0;
      return k >= 0 ? 1 : 0;
    };
    this.shellInert = new Uint8Array(ne);
    for (let e = 0; e < ne; e++)
      this.shellInert[e] = sameBody(model.shells.subarray(4 * e, 4 * e + 4));
    this.beamInert = new Uint8Array(nb);
    for (let b = 0; b < nb; b++)
      this.beamInert[b] = sameBody(model.beams!.subarray(2 * b, 2 * b + 2));
    // Lumped masses: a quarter of each shell's on each corner (a triangle's third corner takes
    // its repeated fourth's share too). Rotational inertia m·max(A, t²)/3, scaled up from the
    // plate's own (ρt³/12 per area) as explicit codes do: the transverse shear couples the
    // rotations at ω² ≈ 3κG/(ρA), which with m·A/12 would need a step a tenth of the
    // membrane's; with m·A/3 the membrane step stays stable. Only the highest modes change.
    let smallest = Infinity;
    const c = new Float64Array(12);
    // Each shell's stable step and corner mass, for mass scaling once the step is known.
    const own = new Float64Array(ne);
    const lengthOf = (this.lengthOf = new Float64Array(ne));
    const corner = new Float64Array(ne);
    const rotary = new Float64Array(ne);
    for (let e = 0; e < ne; e++) {
      const s = model.shells.subarray(4 * e, 4 * e + 4);
      for (let k = 0; k < 4; k++)
        for (let a = 0; a < 3; a++) c[3 * k + a] = this.x0[3 * s[k]! + a]!;
      const area = quadArea(c);
      if (!(area > 0)) invalid(`shell ${e} has no area`);
      const nrm = cross(
        [c[6]! - c[0]!, c[7]! - c[1]!, c[8]! - c[2]!],
        [c[9]! - c[3]!, c[10]! - c[4]!, c[11]! - c[5]!],
      );
      for (let a = 0; a < 3; a++) this.normal[3 * e + a] = nrm[a]! / (2 * area);
      const t = model.thickness[e]!;
      const mat = model.materials[model.shellMaterial[e]!]!;
      const m = (mat.density * t * area) / 4;
      for (let k = 0; k < 4; k++) {
        this.mass[s[k]!] += m;
        this.inertia[s[k]!] += (m * Math.max(area, t * t)) / 3;
      }
      corner[e] = m;
      rotary[e] = Math.max(area, t * t) / 3;
      // The characteristic length: the area over the longest side (or diagonal of a triangle).
      let longest = 0;
      for (let k = 0; k < 4; k++) {
        const j = (k + 1) % 4;
        longest = Math.max(
          longest,
          Math.hypot(
            c[3 * j]! - c[3 * k]!,
            c[3 * j + 1]! - c[3 * k + 1]!,
            c[3 * j + 2]! - c[3 * k + 2]!,
          ),
        );
      }
      const wave = Math.sqrt(mat.youngsModulus / (mat.density * (1 - mat.poissonRatio ** 2)));
      // A shell inside one rigid body does not deform: it sets no step.
      own[e] = this.shellInert[e] ? Infinity : (settings.stepScale * area) / longest / wave;
      lengthOf[e] = area / longest;
      smallest = Math.min(smallest, own[e]!);
    }
    // VS5c: beams: half the mass on each node, rotational inertia m·max(L², 3·max(I)/A)/3 (as
    // the shells', so that the shear–rotation and bending modes keep the axial step L/c).
    const ownB = new Float64Array(nb);
    const lengthOfB = (this.lengthOfB = new Float64Array(nb));
    const cornerB = new Float64Array(nb);
    const rotaryB = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      const i = model.beams![2 * b]!;
      const j = model.beams![2 * b + 1]!;
      const d = [0, 1, 2].map((a) => this.x0[3 * j + a]! - this.x0[3 * i + a]!);
      const l = norm(d);
      const q = model.sections![model.beamSection![b]!]!;
      const mat = model.materials[model.beamMaterial![b]!]!;
      const m = (mat.density * q.area * l) / 2;
      const r = Math.max(l * l, (3 * Math.max(q.i2, q.i3, q.j)) / q.area) / 3;
      for (const k of [i, j]) {
        this.mass[k] += m;
        this.inertia[k] += m * r;
      }
      cornerB[b] = m;
      rotaryB[b] = r;
      // Axis 2: the orientation off the axis.
      const o = [0, 1, 2].map((a) => model.beamOrientation![3 * b + a]!);
      const e1 = d.map((c) => c / l);
      const along = o[0]! * e1[0]! + o[1]! * e1[1]! + o[2]! * e1[2]!;
      const e2 = o.map((c, a) => c - along * e1[a]!);
      const n2 = norm(e2);
      for (let a = 0; a < 3; a++) this.beamAxis[3 * b + a] = e2[a]! / n2;
      if (this.beamInert[b]) continue;
      ownB[b] = (settings.stepScale * l) / Math.sqrt(mat.youngsModulus / mat.density);
      lengthOfB[b] = l;
      smallest = Math.min(smallest, ownB[b]!);
    }
    // VS5b: a shell below the smallest step gets mass so that its step is that one (the step goes
    // with √m): (target/own)² − 1 times its mass, on its corners.
    let added = 0;
    // The model's mass before any is added (its own, the added masses, the rigid bodies'): the
    // share's budget, as the `mass-scaling` check counts it.
    const modelMass =
      this.mass.reduce((a, b) => a + b, 0) +
      (model.masses ?? []).reduce((a, p) => a + p.mass, 0) +
      linked.reduce((a, r) => a + (r.mass ?? 0), 0);
    const target =
      settings.minStep ?? this.scaledStep(own, ownB, corner, modelMass, settings.massScalingShare);
    if (smallest < target)
      for (let e = 0; e < ne; e++) {
        if (own[e]! >= target) continue;
        const extra = corner[e]! * ((target / own[e]!) ** 2 - 1);
        for (let k = 0; k < 4; k++) {
          const node = model.shells[4 * e + k]!;
          this.mass[node] += extra;
          this.inertia[node] += extra * rotary[e]!;
        }
        added += 4 * extra;
      }
    if (smallest < target)
      for (let b = 0; b < nb; b++) {
        if (this.beamInert[b] || ownB[b]! >= target) continue;
        const extra = cornerB[b]! * ((target / ownB[b]!) ** 2 - 1);
        for (let k = 0; k < 2; k++) {
          const node = model.beams![2 * b + k]!;
          this.mass[node] += extra;
          this.inertia[node] += extra * rotaryB[b]!;
        }
        added += 2 * extra;
      }
    this.addedMass = added;
    for (const p of model.masses ?? []) this.mass[p.node] += p.mass;
    this.bodies = linked.map((r, k) => this.rigidBody(r, k));
    this.totalMass =
      this.mass.reduce((a, b) => a + b, 0) + linked.reduce((a, r) => a + (r.mass ?? 0), 0);
    if (smallest === Infinity && !(target > 0))
      invalid('a model of rigid bodies only needs a smallest step (minStep)');
    this.step = Math.max(smallest === Infinity ? target : smallest, target);
    this.stepOf = own.map((q) => (q === 0 ? Infinity : Math.max(q, target)));
    this.stepOfB = ownB.map((q, b) =>
      this.beamInert[b] || q === 0 ? Infinity : Math.max(q, target),
    );
    if (settings.endTime / this.step > explicitLimits.steps)
      throw new ExplicitError(
        'too-large',
        `${Math.ceil(settings.endTime / this.step)} steps exceed ${explicitLimits.steps}`,
      );
    this.free = new Uint8Array(6 * n).fill(1);
    for (let i = 0; i < n; i++) {
      // A rigid body's nodes move with it.
      if (this.bodyOf[i]! >= 0) {
        for (let d = 0; d < 6; d++) this.free[6 * i + d] = 0;
        continue;
      }
      const f = model.fixed?.[i] ?? 0;
      for (let d = 0; d < 6; d++) if (f & (1 << d)) this.free[6 * i + d] = 0;
      if (!(this.mass[i]! > 0)) for (let d = 0; d < 6; d++) this.free[6 * i + d] = 0;
      // A node without mass (in no shell) stays put.
      if (!(this.mass[i]! > 0))
        for (let d = 0; d < 3; d++) {
          this.v[3 * i + d] = 0;
          this.w[3 * i + d] = 0;
        }
    }
    for (const f of model.forces ?? [])
      for (let a = 0; a < 3; a++) this.fExt[3 * f.node + a] += f.force[a]!;
    if (model.gravity)
      for (let i = 0; i < n; i++)
        for (let a = 0; a < 3; a++) this.fExt[3 * i + a] += this.mass[i]! * model.gravity[a]!;
    for (const b of this.bodies) {
      if (model.gravity) for (let a = 0; a < 3; a++) b.force[a] = b.extra * model.gravity[a]!;
      this.placeBody(b);
    }
    // VS8c: the ties outside the bodies, each follower on the node its chain ends at; that node
    // takes the follower's mass and inertia (its own and its mass across the arm).
    {
      const ties = model.ties ?? new Uint32Array();
      if (ties.length % 2 || ties.length / 2 > explicitLimits.ties)
        invalid(`ties need node pairs, at most ${explicitLimits.ties}`);
      const to = new Int32Array(n).fill(-1);
      for (let t = 0; t < ties.length; t += 2) {
        const [a, b] = [ties[t]!, ties[t + 1]!];
        if (!(a < n && b < n) || a === b) invalid('a tie needs two different nodes of the model');
        if (this.bodyOf[a]! >= 0) continue;
        if (to[a]! >= 0 && to[a] !== b) invalid(`node ${a} follows two nodes`);
        to[a] = b;
      }
      const end = (i: number) => {
        let j = i;
        for (let q = 0; to[j]! >= 0; q++) {
          if (q > n) invalid(`the ties from node ${i} run in a circle`);
          j = to[j]!;
        }
        return j;
      };
      const from: number[] = [];
      const toEnd: number[] = [];
      for (let i = 0; i < n; i++)
        if (to[i]! >= 0) {
          from.push(i);
          toEnd.push(end(i));
        }
      // The ties by the node they follow, one group per node.
      const order = [...from.keys()].sort((a, b) => toEnd[a]! - toEnd[b]! || a - b);
      const leaders: number[] = [];
      const starts: number[] = [];
      order.forEach((q, k) => {
        if (k === 0 || toEnd[q] !== toEnd[order[k - 1]!]) {
          leaders.push(toEnd[q]!);
          starts.push(k);
        }
      });
      starts.push(order.length);
      this.follower = new Uint8Array(n);
      this.leader = new Uint8Array(n);
      for (const j of leaders) this.leader[j] = 1;
      this.groupNode = Uint32Array.from(leaders);
      this.groupStart = Uint32Array.from(starts);
      this.ownMass = Float64Array.from(leaders, (j) => this.mass[j]!);
      this.ownInertia = Float64Array.from(leaders, (j) => this.inertia[j]!);
      this.groupAcc = new Float64Array(6 * leaders.length);
      this.tieFrom = Uint32Array.from(order, (q) => from[q]!);
      this.tieTo = Uint32Array.from(order, (q) => toEnd[q]!);
      this.tieArm = new Float64Array(3 * from.length);
      const all = (i: number) => (model.fixed?.[i] ?? 0) === 63 || !(this.mass[i]! > 0);
      this.tieFrom.forEach((i, q) => {
        const j = this.tieTo[q]!;
        const fi = model.fixed?.[i] ?? 0;
        const fj = model.fixed?.[j] ?? 0;
        if (fj && !all(j))
          invalid(`node ${j} is followed by a tie and held in only some components`);
        if (fi && !(fi === 63 && all(j))) invalid(`node ${i} follows a tie and is fixed`);
        this.follower[i] = 1;
        let r2 = 0;
        for (let a = 0; a < 3; a++) {
          const d = this.x0[3 * i + a]! - this.x0[3 * j + a]!;
          this.tieArm[3 * q + a] = d;
          r2 += d * d;
        }
        this.mass[j] += this.mass[i]!;
        this.inertia[j] += this.inertia[i]! + this.mass[i]! * r2;
      });
      if (from.length) this.followTies(0);
    }
    this.historyEvery = settings.historyEvery ?? 1;
    this.hist = (settings.historyNodes ?? []).map((node) => ({ node, t: [], u: [], v: [] }));
    const walls = model.walls ?? [];
    const poles = model.poles ?? [];
    // A rigid body's nodes meet the contacts with their share of the body's mass.
    const contactMass = Float64Array.from(this.mass);
    for (const b of this.bodies) for (const i of b.nodes) contactMass[i] = b.mass / b.nodes.length;
    this.contacts =
      model.contact || walls.length || poles.length
        ? new ContactSet({
            nodeCount: n,
            shells: model.shells,
            thickness: model.thickness,
            mass: contactMass,
            massAt: (i, dx, dy, dz, ox, oy, oz) => this.massAt(i, dx, dy, dz, ox, oy, oz),
            x0: this.x0,
            bodyOf: this.bodyOf,
            erased: this.erased,
            contact: model.contact,
            walls,
            poles,
            step: this.step,
          })
        : null;
    this.fCon = new Float64Array(this.contacts ? 3 * n : 0);
    this.fConLast = new Float64Array(this.fCon.length);
    this.mCon = new Float64Array(this.fCon.length);
    this.mConLast = new Float64Array(this.fCon.length);
    this.barrierHist = [
      ...walls.map((_, index) => ({ kind: 'wall' as const, index, t: [], f: [] })),
      ...poles.map((_, index) => ({ kind: 'pole' as const, index, t: [], f: [] })),
    ];
    // The forces at the start; the stresses do not move yet.
    this.internalForces(0);
    this.contactForces(0);
    this.foldTies();
    this.kineticBack = 0;
    this.record();
  }

  /**
   * The kinetic energy at the current time: the half-step velocities (½ `back` before it)
   * brought on to it by the current accelerations.
   */
  private kineticAt(back: number): number {
    const { v, w, mass, inertia, free, fExt, fInt, mInt } = this;
    let k = 0;
    for (const b of this.bodies) {
      // The body's velocities brought on to the current time by its loads now.
      const { f, mo } = this.bodyLoads(b);
      const vt = [0, 1, 2].map((a) =>
        b.held & (1 << a) ? b.vc[a]! : b.vc[a]! + (0.5 * back * f[a]!) / b.mass,
      );
      const I = this.bodyInertia(b);
      const wt =
        b.held & 8
          ? b.w
          : solve3(
              I,
              [0, 1, 2].map((a) => b.L[a]! + 0.5 * back * mo[a]!),
            );
      const Iw = mul3(I, wt);
      k += 0.5 * b.mass * (vt[0]! ** 2 + vt[1]! ** 2 + vt[2]! ** 2);
      k += 0.5 * (wt[0]! * Iw[0]! + wt[1]! * Iw[1]! + wt[2]! * Iw[2]!);
    }
    // VS8c: a tie group's velocities brought on by its accelerations, each node's on its arm.
    if (this.groupNode.length) {
      this.groupAccelerations();
      const acc = this.groupAcc;
      this.groupNode.forEach((j, g) => {
        const held = !free[6 * j];
        const vt = [0, 1, 2].map((a) => v[3 * j + a]! + (held ? 0 : 0.5 * back * acc[6 * g + a]!));
        const wt = [0, 1, 2].map(
          (a) => w[3 * j + a]! + (held ? 0 : 0.5 * back * acc[6 * g + 3 + a]!),
        );
        const w2 = wt[0]! ** 2 + wt[1]! ** 2 + wt[2]! ** 2;
        k += 0.5 * this.ownMass[g]! * (vt[0]! ** 2 + vt[1]! ** 2 + vt[2]! ** 2);
        k += 0.5 * this.ownInertia[g]! * w2;
        for (let q = this.groupStart[g]!; q < this.groupStart[g + 1]!; q++) {
          const i = this.tieFrom[q]!;
          const r = [0, 1, 2].map((a) => this.tieArm[3 * q + a]!);
          const u = cross(wt, r);
          k +=
            0.5 *
            mass[i]! *
            ((vt[0]! + u[0]!) ** 2 + (vt[1]! + u[1]!) ** 2 + (vt[2]! + u[2]!) ** 2);
          k += 0.5 * inertia[i]! * w2;
        }
      });
    }
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.bodyOf[i]! >= 0 || this.follower[i] || this.leader[i]) continue;
      const m = mass[i]!;
      const I = inertia[i]!;
      for (let a = 0; a < 3; a++) {
        const j = 3 * i + a;
        const vt = free[6 * i + a] ? v[j]! + (0.5 * back * (fExt[j]! - fInt[j]!)) / m : v[j]!;
        const wt = free[6 * i + 3 + a] && I > 0 ? w[j]! - (0.5 * back * mInt[j]!) / I : w[j]!;
        k += 0.5 * m * vt * vt + 0.5 * I * wt * wt;
      }
    }
    return k;
  }

  /** Frames, energies and history at the current time when due. */
  private record(final = false) {
    if (
      (this.hist.length || this.barrierHist.length) &&
      this.historyStep !== this.steps &&
      (final || this.steps % this.historyEvery === 0)
    ) {
      this.historyStep = this.steps;
      for (const h of this.hist) {
        h.t.push(this.time);
        for (let a = 0; a < 3; a++) {
          h.u.push(this.x[3 * h.node + a]! - this.x0[3 * h.node + a]!);
          h.v.push(this.v[3 * h.node + a]!);
        }
      }
      this.barrierHist.forEach((b, k) => {
        b.t.push(this.time);
        for (let a = 0; a < 3; a++) b.f.push(this.contacts!.barrierForce[3 * k + a]!);
      });
    }
    if (this.time + 1e-12 * this.step >= this.nextFrame || final) {
      const u = new Float32Array(3 * this.nodeCount);
      for (let i = 0; i < u.length; i++) u[i] = this.x[i]! - this.x0[i]!;
      const np = this.zeta.length;
      const plasticStrain = new Float32Array(this.shellCount);
      for (let e = 0; e < this.shellCount; e++) {
        let most = 0;
        for (let q = 0; q < np; q++) most = Math.max(most, this.plastic[e * np + q]!);
        plasticStrain[e] = most;
      }
      this.frames.push({
        time: this.time,
        displacement: u,
        plasticStrain,
        erased: Uint8Array.from(this.erased),
      });
      this.energies.push(this.energy());
      while (this.nextFrame <= this.time + 1e-12 * this.step)
        this.nextFrame += this.settings.frameEvery;
    }
  }

  energy(): ExplicitEnergies {
    return {
      time: this.time,
      kinetic: this.kineticAt(this.kineticBack),
      contact: this.contactEnergy,
      internal: this.internal,
      hourglass: this.hourglassEnergy,
      external: this.external,
      ...(this.partInternal ? { parts: Array.from(this.partInternal) } : {}),
    };
  }

  get done() {
    return this.time >= this.settings.endTime - 1e-9 * this.step;
  }

  /** Moves on by up to `count` steps (stops at the end time); returns the steps taken. */
  advance(count: number): number {
    let taken = 0;
    while (taken < count && !this.done) {
      this.once();
      taken++;
    }
    if (this.done && this.frames.at(-1)?.time !== this.time) this.record(true);
    return taken;
  }

  /**
   * VS6a: the effective mass for a push along the unit d at the point o off node i. A rigid
   * body's node: the body's translation and turning about its centre (held components take
   * nothing: they are infinitely heavy). Another node: its mass and its rotary inertia (the
   * contacts ignore what holds it, which only makes them softer).
   */
  private massAt(
    i: number,
    dx: number,
    dy: number,
    dz: number,
    ox: number,
    oy: number,
    oz: number,
  ): number {
    const k = this.bodyOf[i]!;
    const { x } = this;
    if (k < 0) {
      const m = this.mass[i]!;
      const I = this.inertia[i]!;
      const cx = oy * dz - oz * dy,
        cy = oz * dx - ox * dz,
        cz = ox * dy - oy * dx;
      const turn = I > 0 ? (cx * cx + cy * cy + cz * cz) / I : 0;
      return 1 / (1 / m + turn);
    }
    const b = this.bodies[k]!;
    const rx = x[3 * i]! + ox - b.xc[0]!,
      ry = x[3 * i + 1]! + oy - b.xc[1]!,
      rz = x[3 * i + 2]! + oz - b.xc[2]!;
    let flex = 0;
    for (let a = 0; a < 3; a++) {
      const da = a === 0 ? dx : a === 1 ? dy : dz;
      if (!(b.held & (1 << a))) flex += (da * da) / b.mass;
    }
    if (!(b.held & 8)) {
      const c = [ry * dz - rz * dy, rz * dx - rx * dz, rx * dy - ry * dx];
      const q = solve3(this.bodyInertia(b), c);
      flex += c[0]! * q[0]! + c[1]! * q[1]! + c[2]! * q[2]!;
    }
    return flex > 0 ? 1 / flex : Infinity;
  }

  /**
   * VS6a: the step dt, or less when a node would move more than the contacts' `travel` in
   * it with the velocity this step gives it (the forces now accelerate it first: a body at rest
   * under gravity has no speed yet). The contacts keep the shorter step for their springs.
   */
  private contactStep(dt: number): number {
    const c = this.contacts;
    if (!c || !(c.band < Infinity)) return dt;
    const { v, mass, free, fExt, fInt } = this;
    const h = 0.5 * (this.lastStep + dt);
    let fastest = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.bodyOf[i]! >= 0 || !(mass[i]! > 0)) continue;
      let s = 0;
      for (let a = 0; a < 3; a++) {
        const k = 3 * i + a;
        const after = free[6 * i + a] ? v[k]! + (h * (fExt[k]! - fInt[k]!)) / mass[i]! : v[k]!;
        s += after * after;
      }
      fastest = Math.max(fastest, Math.sqrt(s));
    }
    for (const b of this.bodies) {
      const { f, mo } = this.bodyLoads(b);
      let s = 0;
      for (let a = 0; a < 3; a++) {
        const after = b.held & (1 << a) ? b.vc[a]! : b.vc[a]! + (h * f[a]!) / b.mass;
        s += after * after;
      }
      let speed = Math.sqrt(s);
      if (!(b.held & 8)) {
        const dw = solve3(this.bodyInertia(b), mo);
        const turn = Math.hypot(b.w[0]!, b.w[1]!, b.w[2]!) + h * Math.hypot(dw[0]!, dw[1]!, dw[2]!);
        let reach = 0;
        for (const i of b.nodes)
          reach = Math.max(
            reach,
            Math.hypot(
              this.x[3 * i]! - b.xc[0]!,
              this.x[3 * i + 1]! - b.xc[1]!,
              this.x[3 * i + 2]! - b.xc[2]!,
            ),
          );
        speed += turn * reach;
      }
      fastest = Math.max(fastest, speed);
    }
    if (!(fastest > 0)) return dt;
    const limit = c.travel / fastest;
    if (!(limit < dt)) return dt;
    c.stepNow = Math.min(c.stepNow, limit);
    return limit;
  }

  private once() {
    // The step: the stable one of the current shapes (less as the elements crush), or less while
    // the contacts need it (no node moves more than the contacts' `travel` in one step).
    const dt = this.contactStep(
      Math.min(
        this.step,
        this.nextStep,
        this.contacts ? this.contacts.stepNow : Infinity,
        this.settings.endTime - this.time,
      ),
    );
    if (this.steps >= explicitLimits.steps)
      throw new ExplicitError('too-large', `the run passed ${explicitLimits.steps} steps`);
    const { v, w, x, mass, inertia, free, fExt, fInt, mInt } = this;
    // The half-step velocities move on from the last step's middle to this one's: half of each
    // step (only half of this one on the first, from the initial velocity).
    const h = 0.5 * (this.lastStep + dt);
    let work = 0;
    let finite = true;
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.bodyOf[i]! >= 0 || this.follower[i] || this.leader[i]) continue;
      const m = mass[i]!;
      const I = inertia[i]!;
      for (let a = 0; a < 3; a++) {
        const k = 3 * i + a;
        const after = free[6 * i + a] ? v[k]! + (h * (fExt[k]! - fInt[k]!)) / m : v[k]!;
        v[k] = after;
        // The work of the external forces over this step's move (a held component's, with what
        // holds it, is the internal force's: below, from both ends of the step).
        if (free[6 * i + a]) work += fExt[k]! * dt * after;
        x[k] += dt * after;
        const wa = free[6 * i + 3 + a] && I > 0 ? w[k]! - (h * mInt[k]!) / I : w[k]!;
        w[k] = wa;
        if (!Number.isFinite(after) || !Number.isFinite(wa)) finite = false;
      }
    }
    for (const b of this.bodies) work += this.moveBody(b, h, dt);
    // VS8c: each tie group as one rigid piece about its node (that node's coupled translation
    // and turn), then the followers on their arms, and the work of their external forces.
    if (this.tieFrom.length) {
      const acc = this.groupAcc;
      this.groupAccelerations();
      this.groupNode.forEach((j, g) => {
        const held = !free[6 * j];
        for (let a = 0; a < 3; a++) {
          const k = 3 * j + a;
          if (!held) {
            v[k] += h * acc[6 * g + a]!;
            w[k] += h * acc[6 * g + 3 + a]!;
            work += fExt[k]! * dt * v[k]!;
          }
          x[k] += dt * v[k]!;
          if (!Number.isFinite(v[k]!) || !Number.isFinite(w[k]!)) finite = false;
        }
      });
      this.followTies(dt);
      for (const i of this.tieFrom)
        for (let a = 0; a < 3; a++) work += fExt[3 * i + a]! * dt * v[3 * i + a]!;
    }
    if (
      !finite ||
      !this.bodies.every((b) => b.vc.every(Number.isFinite) && b.w.every(Number.isFinite))
    )
      this.blowUp();
    this.lastStep = dt;
    this.time += dt;
    this.steps++;
    // Stresses move on over this step with its half-step velocities; the forces at its end.
    // A held component moving at its prescribed velocity: the internal force's work over the
    // step, with the mean of the forces at its two ends (as the stresses' work is).
    const heldBefore = this.heldPower();
    this.internalForces(dt);
    this.contactForces(dt);
    this.foldTies();
    work += 0.5 * dt * (heldBefore + this.heldPower());
    this.external += work;
    // VS8c-2: the kinetic energy is worked out when an energy is recorded (`energy`), not every
    // step (a tenth of a whole car's step).
    this.kineticBack = dt;
    this.record();
  }

  /**
   * VS8c: the longest step whose mass scaling (each shell below it given (step/own)² − 1 times
   * its corner masses) adds at most `share` of the model's mass, and no longer than the step of
   * the shell at the 25th percentile (only the smallest shells are scaled) or any beam's own
   * (beams get no mass from it); 0 without a share.
   */
  private scaledStep(
    own: Float64Array,
    beams: Float64Array,
    corner: Float64Array,
    modelMass: number,
    share?: number,
  ): number {
    if (!share) return 0;
    const order = [...own.keys()]
      .filter((e) => own[e]! < Infinity)
      .sort((a, b) => own[a]! - own[b]!);
    if (!order.length) return 0;
    const budget = share * modelMass;
    // At most the shortest quarter of the shells get mass (VS8c-2: F101's hat bends are some
    // 15 % of its shells). Beams are not in the budget: the target stays at or under the
    // shortest beam's own step (an inert beam's is 0: none).
    let cap = own[order[Math.floor(0.25 * order.length)]!]!;
    for (const b of beams) if (b > 0) cap = Math.min(cap, b);
    // Added mass for a target t: Σ 4·m·((t/own)² − 1) over the shells below t; with the shells
    // below t fixed it grows with t², so each interval of the sorted steps solves directly.
    let a = 0; // Σ 4m/own² of the shells below
    let b = 0; // Σ 4m of the shells below
    for (let k = 0; k < order.length; k++) {
      const e = order[k]!;
      a += (4 * corner[e]!) / own[e]! ** 2;
      b += 4 * corner[e]!;
      const next = k + 1 < order.length ? own[order[k + 1]!]! : Infinity;
      const t = Math.sqrt((budget + b) / a);
      if (t <= next || next > cap) return Math.min(cap, Math.max(t, own[order[0]!]!));
    }
    return cap;
  }

  /**
   * VS8c: each tie group's accelerations, as one rigid piece about its node P: with the group's
   * mass M, its centre c off P and inertia J about P (the nodes' own and their masses on their
   * arms), the net force F and moment Mo about P (folded onto P),
   *   M a − M c × α … : M (a + α × c + ω × (ω × c)) = F,
   *   M c × a + J α + ω × (J ω) = Mo,
   * solved for α with the inertia about the centre, J − M (|c|² 1 − c cᵀ), then a.
   */
  private groupAccelerations() {
    const { groupNode, groupStart, tieFrom, tieArm, mass, inertia, fExt, fInt, mInt, w } = this;
    const acc = this.groupAcc;
    const J = new Float64Array(9);
    for (let g = 0; g < groupNode.length; g++) {
      const j = groupNode[g]!;
      let M = this.ownMass[g]!;
      let cx = 0,
        cy = 0,
        cz = 0;
      J.fill(0);
      J[0] = J[4] = J[8] = this.ownInertia[g]!;
      for (let q = groupStart[g]!; q < groupStart[g + 1]!; q++) {
        const i = tieFrom[q]!;
        const m = mass[i]!;
        const rx = tieArm[3 * q]!,
          ry = tieArm[3 * q + 1]!,
          rz = tieArm[3 * q + 2]!;
        M += m;
        cx += m * rx;
        cy += m * ry;
        cz += m * rz;
        const r2 = rx * rx + ry * ry + rz * rz;
        const I = inertia[i]!;
        J[0] += I + m * (r2 - rx * rx);
        J[4] += I + m * (r2 - ry * ry);
        J[8] += I + m * (r2 - rz * rz);
        J[1] -= m * rx * ry;
        J[2] -= m * rx * rz;
        J[5] -= m * ry * rz;
      }
      J[3] = J[1]!;
      J[6] = J[2]!;
      J[7] = J[5]!;
      cx /= M;
      cy /= M;
      cz /= M;
      const wx = w[3 * j]!,
        wy = w[3 * j + 1]!,
        wz = w[3 * j + 2]!;
      // ω × (ω × c) and ω × (J ω).
      const ox = wy * cz - wz * cy,
        oy = wz * cx - wx * cz,
        oz = wx * cy - wy * cx;
      const qx = wy * oz - wz * oy,
        qy = wz * ox - wx * oz,
        qz = wx * oy - wy * ox;
      const jx = J[0]! * wx + J[1]! * wy + J[2]! * wz,
        jy = J[3]! * wx + J[4]! * wy + J[5]! * wz,
        jz = J[6]! * wx + J[7]! * wy + J[8]! * wz;
      const Fx = fExt[3 * j]! - fInt[3 * j]! - M * qx,
        Fy = fExt[3 * j + 1]! - fInt[3 * j + 1]! - M * qy,
        Fz = fExt[3 * j + 2]! - fInt[3 * j + 2]! - M * qz;
      // The moment less the gyroscopic one and c × F (the force's about the centre).
      const mx = -mInt[3 * j]! - (wy * jz - wz * jy) - (cy * Fz - cz * Fy),
        my = -mInt[3 * j + 1]! - (wz * jx - wx * jz) - (cz * Fx - cx * Fz),
        mz = -mInt[3 * j + 2]! - (wx * jy - wy * jx) - (cx * Fy - cy * Fx);
      // The inertia about the centre.
      const c2 = cx * cx + cy * cy + cz * cz;
      const a00 = J[0]! - M * (c2 - cx * cx),
        a11 = J[4]! - M * (c2 - cy * cy),
        a22 = J[8]! - M * (c2 - cz * cz),
        a01 = J[1]! + M * cx * cy,
        a02 = J[2]! + M * cx * cz,
        a12 = J[5]! + M * cy * cz;
      const d00 = a11 * a22 - a12 * a12,
        d01 = a02 * a12 - a01 * a22,
        d02 = a01 * a12 - a02 * a11;
      const det = a00 * d00 + a01 * d01 + a02 * d02;
      const d11 = a00 * a22 - a02 * a02,
        d12 = a01 * a02 - a00 * a12,
        d22 = a00 * a11 - a01 * a01;
      const ax = (d00 * mx + d01 * my + d02 * mz) / det,
        ay = (d01 * mx + d11 * my + d12 * mz) / det,
        az = (d02 * mx + d12 * my + d22 * mz) / det;
      // a = (F' + M c × α) / M … from M a − M c × α = F' (α × c = −c × α).
      acc[6 * g] = Fx / M + (cy * az - cz * ay);
      acc[6 * g + 1] = Fy / M + (cz * ax - cx * az);
      acc[6 * g + 2] = Fz / M + (cx * ay - cy * ax);
      acc[6 * g + 3] = ax;
      acc[6 * g + 4] = ay;
      acc[6 * g + 5] = az;
    }
  }

  /**
   * VS8c: each follower's net load moved onto the node it follows: its force there, and its own
   * moment plus the force's across the arm; the follower is left with none (its internal force
   * set to its external one), so the bodies, the holders and the contacts' step see it there.
   */
  private foldTies() {
    const { tieFrom, tieTo, tieArm, fExt, fInt, mInt } = this;
    for (let q = 0; q < tieFrom.length; q++) {
      const i = tieFrom[q]!;
      const j = tieTo[q]!;
      const fx = fExt[3 * i]! - fInt[3 * i]!,
        fy = fExt[3 * i + 1]! - fInt[3 * i + 1]!,
        fz = fExt[3 * i + 2]! - fInt[3 * i + 2]!;
      const rx = tieArm[3 * q]!,
        ry = tieArm[3 * q + 1]!,
        rz = tieArm[3 * q + 2]!;
      fInt[3 * j] -= fx;
      fInt[3 * j + 1] -= fy;
      fInt[3 * j + 2] -= fz;
      // The node turns against mInt: the follower's moment and r × f, with that sign.
      mInt[3 * j] += mInt[3 * i]! - (ry * fz - rz * fy);
      mInt[3 * j + 1] += mInt[3 * i + 1]! - (rz * fx - rx * fz);
      mInt[3 * j + 2] += mInt[3 * i + 2]! - (rx * fy - ry * fx);
      for (let a = 0; a < 3; a++) {
        fInt[3 * i + a] = fExt[3 * i + a]!;
        mInt[3 * i + a] = 0;
      }
    }
  }

  /**
   * VS8c: each follower on its arm from the node it follows, the arm turned by that node's turn
   * over `dt` (Rodrigues): its place, its velocity (the node's plus ω × the arm) and its turn.
   */
  private followTies(dt: number) {
    const { tieFrom, tieTo, tieArm, x, v, w } = this;
    for (let q = 0; q < tieFrom.length; q++) {
      const i = tieFrom[q]!;
      const j = tieTo[q]!;
      const wx = w[3 * j]!,
        wy = w[3 * j + 1]!,
        wz = w[3 * j + 2]!;
      let rx = tieArm[3 * q]!,
        ry = tieArm[3 * q + 1]!,
        rz = tieArm[3 * q + 2]!;
      const angle = Math.hypot(wx, wy, wz) * dt;
      if (angle > 0) {
        const s = Math.sin(angle) / angle,
          c = (1 - Math.cos(angle)) / (angle * angle);
        const [ax, ay, az] = [wx * dt, wy * dt, wz * dt];
        const cx = ay * rz - az * ry,
          cy = az * rx - ax * rz,
          cz = ax * ry - ay * rx;
        const dx = ay * cz - az * cy,
          dy = az * cx - ax * cz,
          dz = ax * cy - ay * cx;
        rx += s * cx + c * dx;
        ry += s * cy + c * dy;
        rz += s * cz + c * dz;
        tieArm[3 * q] = rx;
        tieArm[3 * q + 1] = ry;
        tieArm[3 * q + 2] = rz;
      }
      x[3 * i] = x[3 * j]! + rx;
      x[3 * i + 1] = x[3 * j + 1]! + ry;
      x[3 * i + 2] = x[3 * j + 2]! + rz;
      v[3 * i] = v[3 * j]! + (wy * rz - wz * ry);
      v[3 * i + 1] = v[3 * j + 1]! + (wz * rx - wx * rz);
      v[3 * i + 2] = v[3 * j + 2]! + (wx * ry - wy * rx);
      w[3 * i] = wx;
      w[3 * i + 1] = wy;
      w[3 * i + 2] = wz;
    }
  }

  /**
   * VS6a: the contact forces at the current positions, taken off the internal forces (so that
   * the bodies and the holders feel them), and the contacts' energy over the last step: their
   * mean force against the half-step velocities.
   */
  private contactForces(dt: number) {
    const c = this.contacts;
    if (!c) return;
    const { fCon, fConLast, mCon, mConLast, fInt, mInt, v, w } = this;
    fConLast.set(fCon);
    mConLast.set(mCon);
    c.forces(this.x, v, w, fCon, mCon);
    let work = 0;
    for (let k = 0; k < fCon.length; k++) {
      fInt[k] -= fCon[k]!;
      mInt[k] -= mCon[k]!;
      work += (fCon[k]! + fConLast[k]!) * v[k]! + (mCon[k]! + mConLast[k]!) * w[k]!;
    }
    this.contactEnergy -= 0.5 * dt * work;
  }

  /** The power of the internal forces and moments on the held components at their velocities. */
  private heldPower(): number {
    const { free, fInt, mInt, v, w } = this;
    let p = 0;
    for (let i = 0; i < this.nodeCount; i++)
      for (let a = 0; a < 3; a++) {
        if (this.bodyOf[i]! >= 0) break;
        if (!free[6 * i + a]) p += fInt[3 * i + a]! * v[3 * i + a]!;
        if (!free[6 * i + 3 + a]) p += mInt[3 * i + a]! * w[3 * i + a]!;
      }
    // What holds a body's held components works against the internal forces on it (against its
    // external loads: in moveBody, where their own work is).
    for (const b of this.bodies) {
      if (!(b.held & 63)) continue;
      const { f, mo } = this.bodyLoads(b, 'internal');
      for (let a = 0; a < 3; a++) if (b.held & (1 << a)) p -= f[a]! * b.vc[a]!;
      if (b.held & 8) p -= mo[0]! * b.w[0]! + mo[1]! * b.w[1]! + mo[2]! * b.w[2]!;
    }
    return p;
  }

  /** A rigid body's state from its nodes and its own mass and inertia (VS5c). */
  private rigidBody(r: LinkedBody, k: number): RigidState {
    const { mass, inertia, x0 } = this;
    const extra = r.mass ?? 0;
    let m = extra;
    const c = [0, 0, 0];
    const centroid = [0, 0, 0];
    for (const i of r.nodes)
      for (let a = 0; a < 3; a++) {
        c[a] += mass[i]! * x0[3 * i + a]!;
        centroid[a] += x0[3 * i + a]! / r.nodes.length;
      }
    // Where the added mass sits: its nodes' centroid (a welded body's own nodes').
    const own = r.ownNodes;
    if (own)
      for (let a = 0; a < 3; a++)
        centroid[a] = own.reduce((q, i) => q + x0[3 * i + a]!, 0) / own.length;
    for (const i of r.nodes) m += mass[i]!;
    if (!(m > 0)) invalid(`rigid body ${k} has no mass`);
    for (let a = 0; a < 3; a++) c[a] = (c[a]! + extra * centroid[a]!) / m;
    // Inertia about the centre: the nodes' masses and own inertia, the added mass at the centroid,
    // the given principal inertia.
    const I0 = new Float64Array(9);
    const add = (mm: number, p: number[]) => {
      const rr = p[0]! ** 2 + p[1]! ** 2 + p[2]! ** 2;
      for (let a = 0; a < 3; a++)
        for (let q = 0; q < 3; q++) I0[3 * a + q] += mm * ((a === q ? rr : 0) - p[a]! * p[q]!);
    };
    const r0 = new Float64Array(3 * r.nodes.length);
    r.nodes.forEach((i, q) => {
      const p = [0, 1, 2].map((a) => x0[3 * i + a]! - c[a]!);
      r0.set(p, 3 * q);
      add(mass[i]!, p);
      for (let a = 0; a < 3; a++) I0[4 * a] += inertia[i]!;
    });
    const offset = [0, 1, 2].map((a) => centroid[a]! - c[a]!);
    add(extra, offset);
    for (let a = 0; a < 3; a++) I0[4 * a] += r.inertia?.[a] ?? 0;
    if (!(det3(I0) > 1e-12 * Math.max(I0[0]!, I0[4]!, I0[8]!) ** 3))
      invalid(`rigid body ${k} has no rotational inertia about some axis`);
    let vc = [...(r.velocity ?? [0, 0, 0])];
    let w = [...(r.rotation ?? [0, 0, 0])];
    if (own) {
      // A given body joined by welds: its velocity is its own centre's (its own nodes and its
      // added mass); the joined centre moves at that plus ω × the shift. A held translation
      // with a turn would move the turn's pivot to the joined centre: refused.
      let m0 = extra;
      const c0 = centroid.map((q) => extra * q);
      for (const i of own) {
        m0 += mass[i]!;
        for (let a = 0; a < 3; a++) c0[a] += mass[i]! * x0[3 * i + a]!;
      }
      for (let a = 0; a < 3; a++) c0[a] /= m0;
      const shift = [0, 1, 2].map((a) => c[a]! - c0[a]!);
      const turning = w.some((q) => q !== 0);
      if (
        turning &&
        (r.held ?? 0) & 7 &&
        Math.hypot(...shift) > 1e-9 * Math.max(1, Math.hypot(...c0))
      )
        invalid(`welds move the pivot of rigid body ${k}'s held turn`);
      const extraV = cross(w, shift);
      vc = vc.map((q, a) => q + extraV[a]!);
    }
    if (r.fromNodes) {
      // A weld's link: its nodes' momentum, and their angular momentum about its centre (their
      // masses' moment of momentum and their own spins) over its inertia.
      const v0 = this.model.velocity;
      const w0 = this.model.rotation;
      for (const i of r.nodes)
        for (let a = 0; a < 3; a++) vc[a] += (mass[i]! * (v0?.[3 * i + a] ?? 0)) / m;
      const L = [0, 0, 0];
      r.nodes.forEach((i, q) => {
        const rel = [0, 1, 2].map((a) => (v0?.[3 * i + a] ?? 0) - vc[a]!);
        const turn = cross([r0[3 * q]!, r0[3 * q + 1]!, r0[3 * q + 2]!], rel);
        for (let a = 0; a < 3; a++)
          L[a] += mass[i]! * turn[a]! + inertia[i]! * (w0?.[3 * i + a] ?? 0);
      });
      w = solve3(I0, L);
    }
    return {
      nodes: Uint32Array.from(r.nodes),
      r0,
      mass: m,
      extra,
      offset,
      held: r.held ?? 0,
      I0,
      R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      xc: c,
      vc,
      w,
      L: mul3(I0, w),
      force: [0, 0, 0],
    };
  }

  /** The body's inertia about its centre in the global axes now: R I0 Rᵀ. */
  private bodyInertia(b: RigidState, R = b.R): Float64Array {
    const { I0 } = b;
    const RI = new Float64Array(9);
    for (let a = 0; a < 3; a++)
      for (let q = 0; q < 3; q++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += R[3 * a + k]! * I0[3 * k + q]!;
        RI[3 * a + q] = sum;
      }
    const out = new Float64Array(9);
    for (let a = 0; a < 3; a++)
      for (let q = 0; q < 3; q++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += RI[3 * a + k]! * R[3 * q + k]!;
        out[3 * a + q] = sum;
      }
    return out;
  }

  /** Where the added mass sits from the centre now. */
  private addedOffset(b: RigidState): number[] {
    return mul3(b.R, b.offset);
  }

  /**
   * The net force and the moment about the centre on a body (N, N·mm): of all its loads, or of
   * only the external ones or only the internal forces on its nodes.
   */
  private bodyLoads(
    b: RigidState,
    part: 'all' | 'external' | 'internal' = 'all',
  ): { f: number[]; mo: number[] } {
    const { x, fInt, mInt } = this;
    const fExt = part === 'internal' ? zeros3 : this.fExt;
    const own = part === 'external' ? 0 : 1;
    const ext = part === 'internal' ? 0 : 1;
    const f = b.force.map((g) => ext * g);
    // Gravity on the added mass acts where it sits, off the centre when the nodes' masses differ.
    const mo = cross(this.addedOffset(b), f);
    for (const i of b.nodes) {
      const j = part === 'internal' ? 0 : 3 * i;
      const fx = fExt[j]! - own * fInt[3 * i]!,
        fy = fExt[j + 1]! - own * fInt[3 * i + 1]!,
        fz = fExt[j + 2]! - own * fInt[3 * i + 2]!;
      const rx = x[3 * i]! - b.xc[0]!,
        ry = x[3 * i + 1]! - b.xc[1]!,
        rz = x[3 * i + 2]! - b.xc[2]!;
      f[0] += fx;
      f[1] += fy;
      f[2] += fz;
      mo[0] += ry * fz - rz * fy - own * mInt[3 * i]!;
      mo[1] += rz * fx - rx * fz - own * mInt[3 * i + 1]!;
      mo[2] += rx * fy - ry * fx - own * mInt[3 * i + 2]!;
    }
    return { f, mo };
  }

  /**
   * One step of a body: its centre velocity and angular momentum moved on by h (held components
   * kept), its angular velocity from the momentum and the inertia now, then its centre and turn
   * moved on by dt and its nodes placed. Returns the work of its external loads and holders.
   */
  private moveBody(b: RigidState, h: number, dt: number): number {
    const { f, mo } = this.bodyLoads(b);
    const I = this.bodyInertia(b);
    let work = 0;
    for (let a = 0; a < 3; a++) if (!(b.held & (1 << a))) b.vc[a] += (h * f[a]!) / b.mass;
    if (b.held & 8) b.L = mul3(I, b.w);
    else {
      for (let a = 0; a < 3; a++) b.L[a] += h * mo[a]!;
      // The angular velocity at the step's middle: from the inertia turned half way (twice, the
      // second with the new angular velocity), so that a free body keeps its energy.
      for (let it = 0; it < 2; it++) {
        const half = mul33(
          rotation(0.5 * dt * b.w[0]!, 0.5 * dt * b.w[1]!, 0.5 * dt * b.w[2]!),
          b.R,
        );
        b.w = solve3(this.bodyInertia(b, half), b.L);
      }
    }
    // The work over the step: the external forces on the nodes and the added mass, and what holds
    // the held components (against the net load).
    const { x, fExt } = this;
    const [wx, wy, wz] = b.w as [number, number, number];
    for (const i of b.nodes) {
      const rx = x[3 * i]! - b.xc[0]!,
        ry = x[3 * i + 1]! - b.xc[1]!,
        rz = x[3 * i + 2]! - b.xc[2]!;
      work +=
        dt *
        (fExt[3 * i]! * (b.vc[0]! + wy * rz - wz * ry) +
          fExt[3 * i + 1]! * (b.vc[1]! + wz * rx - wx * rz) +
          fExt[3 * i + 2]! * (b.vc[2]! + wx * ry - wy * rx));
    }
    const [ox, oy, oz] = this.addedOffset(b) as [number, number, number];
    work +=
      dt *
      (b.force[0]! * (b.vc[0]! + wy * oz - wz * oy) +
        b.force[1]! * (b.vc[1]! + wz * ox - wx * oz) +
        b.force[2]! * (b.vc[2]! + wx * oy - wy * ox));
    // What holds the held components against the external loads, at the same place and
    // velocities as their work above: the two cancel on a body held whole.
    if (b.held & 63) {
      const e = this.bodyLoads(b, 'external');
      for (let a = 0; a < 3; a++) if (b.held & (1 << a)) work -= dt * e.f[a]! * b.vc[a]!;
      if (b.held & 8) work -= dt * (e.mo[0]! * wx + e.mo[1]! * wy + e.mo[2]! * wz);
    }
    for (let a = 0; a < 3; a++) b.xc[a] += dt * b.vc[a]!;
    b.R = mul33(rotation(wx * dt, wy * dt, wz * dt), b.R);
    this.placeBody(b, dt);
    return work;
  }

  /**
   * The body's nodes at its centre and turn, moving with it. After a step of dt their velocities
   * are the chords over it, (x_new − x_old) / dt, as the beams and shells read them at the step's
   * middle: two nodes turning together then keep their distance exactly.
   */
  private placeBody(b: RigidState, dt?: number) {
    const { x, v, w } = this;
    const { R, r0, xc, vc } = b;
    const [wx, wy, wz] = b.w as [number, number, number];
    b.nodes.forEach((i, q) => {
      const p0 = r0[3 * q]!,
        p1 = r0[3 * q + 1]!,
        p2 = r0[3 * q + 2]!;
      const rx = R[0]! * p0 + R[1]! * p1 + R[2]! * p2,
        ry = R[3]! * p0 + R[4]! * p1 + R[5]! * p2,
        rz = R[6]! * p0 + R[7]! * p1 + R[8]! * p2;
      const nx = xc[0]! + rx,
        ny = xc[1]! + ry,
        nz = xc[2]! + rz;
      if (dt) {
        v[3 * i] = (nx - x[3 * i]!) / dt;
        v[3 * i + 1] = (ny - x[3 * i + 1]!) / dt;
        v[3 * i + 2] = (nz - x[3 * i + 2]!) / dt;
      } else {
        v[3 * i] = vc[0]! + wy * rz - wz * ry;
        v[3 * i + 1] = vc[1]! + wz * rx - wx * rz;
        v[3 * i + 2] = vc[2]! + wx * ry - wy * rx;
      }
      x[3 * i] = nx;
      x[3 * i + 1] = ny;
      x[3 * i + 2] = nz;
      w[3 * i] = wx;
      w[3 * i + 1] = wy;
      w[3 * i + 2] = wz;
    });
  }

  private blowUp(): never {
    throw new ExplicitError(
      'unstable',
      `a velocity is not finite at ${this.time.toExponential(3)} s (step ${this.steps})`,
    );
  }

  /**
   * Internal forces and moments at the current coordinates: each shell's strain rates from the
   * half-step velocities, its stresses moved on by dt, its resultants and hourglass forces.
   */
  private internalForces(dt: number) {
    const { model, x, v, w, zeta, weight, stress, hg } = this;
    const shells = model.shells;
    const fInt = this.fInt.fill(0);
    const mInt = this.mInt.fill(0);
    const np = zeta.length;
    const qh = this.settings.hourglass;
    const xl = this.xl;
    const yl = this.yl;
    const B1 = this.b1;
    const B2 = this.b2;
    const g = this.g;
    const vl = this.vl;
    const wl = this.wl;
    const fl = this.fl;
    const ml = this.ml;
    let internal = 0;
    let next = Infinity;
    let hourglassWork = 0;
    const plastic = this.plastic;
    const trial: [number, number, number] = [0, 0, 0];
    const shellPart = this.model.shellPart;
    if (shellPart && !this.partInternal)
      this.partInternal = new Float64Array(shellPart.reduce((m, q) => Math.max(m, q), -1) + 1);
    const partInternal = this.partInternal;
    for (let e = 0; e < this.shellCount; e++) {
      if (this.erased[e] || this.shellInert[e]) continue;
      const i0 = 3 * shells[4 * e]!;
      const i1 = 3 * shells[4 * e + 1]!;
      const i2 = 3 * shells[4 * e + 2]!;
      const i3 = 3 * shells[4 * e + 3]!;
      const t = model.thickness[e]!;
      const mat = model.materials[model.shellMaterial[e]!]!;
      const E = mat.youngsModulus;
      const nu = mat.poissonRatio;
      const G = E / (2 * (1 + nu));
      const D = E / (1 - nu * nu);
      // The corotational frame: e3 along the diagonals' cross product, e1 along the mean side.
      const ax31 = x[i2]! - x[i0]!,
        ay31 = x[i2 + 1]! - x[i0 + 1]!,
        az31 = x[i2 + 2]! - x[i0 + 2]!;
      const ax42 = x[i3]! - x[i1]!,
        ay42 = x[i3 + 1]! - x[i1 + 1]!,
        az42 = x[i3 + 2]! - x[i1 + 2]!;
      let e3x = ay31 * az42 - az31 * ay42,
        e3y = az31 * ax42 - ax31 * az42,
        e3z = ax31 * ay42 - ay31 * ax42;
      const n3 = Math.sqrt(e3x * e3x + e3y * e3y + e3z * e3z);
      if (!(n3 > 0)) throw new ExplicitError('element-inverted', `shell ${e} has collapsed`);
      e3x /= n3;
      e3y /= n3;
      e3z /= n3;
      // A step turns a shell's normal by a small angle at most: one that now points against the
      // last one has gone through zero area (the cross product's own sign cannot tell).
      const nrm = this.normal;
      if (!(e3x * nrm[3 * e]! + e3y * nrm[3 * e + 1]! + e3z * nrm[3 * e + 2]! > 0))
        throw new ExplicitError('element-inverted', `shell ${e} has turned inside out`);
      nrm[3 * e] = e3x;
      nrm[3 * e + 1] = e3y;
      nrm[3 * e + 2] = e3z;
      const s1x = 0.5 * (x[i1]! + x[i2]! - x[i0]! - x[i3]!),
        s1y = 0.5 * (x[i1 + 1]! + x[i2 + 1]! - x[i0 + 1]! - x[i3 + 1]!),
        s1z = 0.5 * (x[i1 + 2]! + x[i2 + 2]! - x[i0 + 2]! - x[i3 + 2]!);
      const d1 = s1x * e3x + s1y * e3y + s1z * e3z;
      let e1x = s1x - d1 * e3x,
        e1y = s1y - d1 * e3y,
        e1z = s1z - d1 * e3z;
      const n1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
      e1x /= n1;
      e1y /= n1;
      e1z /= n1;
      const e2x = e3y * e1z - e3z * e1y,
        e2y = e3z * e1x - e3x * e1z,
        e2z = e3x * e1y - e3y * e1x;
      const cx = 0.25 * (x[i0]! + x[i1]! + x[i2]! + x[i3]!),
        cy = 0.25 * (x[i0 + 1]! + x[i1 + 1]! + x[i2 + 1]! + x[i3 + 1]!),
        cz = 0.25 * (x[i0 + 2]! + x[i1 + 2]! + x[i2 + 2]! + x[i3 + 2]!);
      for (let k = 0; k < 4; k++) {
        const i = k === 0 ? i0 : k === 1 ? i1 : k === 2 ? i2 : i3;
        const rx = x[i]! - cx,
          ry = x[i + 1]! - cy,
          rz = x[i + 2]! - cz;
        xl[k] = rx * e1x + ry * e1y + rz * e1z;
        yl[k] = rx * e2x + ry * e2y + rz * e2z;
        const vx = v[i]!,
          vy = v[i + 1]!,
          vz = v[i + 2]!;
        const wx = w[i]!,
          wy = w[i + 1]!,
          wz = w[i + 2]!;
        vl[3 * k] = vx * e1x + vy * e1y + vz * e1z;
        vl[3 * k + 1] = vx * e2x + vy * e2y + vz * e2z;
        vl[3 * k + 2] = vx * e3x + vy * e3y + vz * e3z;
        wl[3 * k] = wx * e1x + wy * e1y + wz * e1z;
        wl[3 * k + 1] = wx * e2x + wy * e2y + wz * e2z;
      }
      const twoA = (xl[2]! - xl[0]!) * (yl[3]! - yl[1]!) + (xl[1]! - xl[3]!) * (yl[2]! - yl[0]!);
      if (!(twoA > 0))
        throw new ExplicitError('element-inverted', `shell ${e} has turned inside out`);
      const A = twoA / 2;
      // The stable step of the shape now: area over the longest side, against the start's.
      let longest2 = 0;
      for (let k = 0; k < 4; k++) {
        const j = (k + 1) & 3;
        const d2 = (xl[j]! - xl[k]!) ** 2 + (yl[j]! - yl[k]!) ** 2;
        if (d2 > longest2) longest2 = d2;
      }
      const stable = (this.stepOf[e]! * A) / Math.sqrt(longest2) / this.lengthOf[e]!;
      if (stable < next) next = stable;
      B1[0] = (yl[1]! - yl[3]!) / twoA;
      B1[1] = (yl[2]! - yl[0]!) / twoA;
      B1[2] = (yl[3]! - yl[1]!) / twoA;
      B1[3] = (yl[0]! - yl[2]!) / twoA;
      B2[0] = (xl[3]! - xl[1]!) / twoA;
      B2[1] = (xl[0]! - xl[2]!) / twoA;
      B2[2] = (xl[1]! - xl[3]!) / twoA;
      B2[3] = (xl[2]! - xl[0]!) / twoA;
      // Membrane (a) and bending (b) rates; transverse shear γ.
      let ax = 0,
        ay = 0,
        axy = 0,
        bx = 0,
        by = 0,
        bxy = 0,
        gxz = 0,
        gyz = 0;
      for (let k = 0; k < 4; k++) {
        const vx = vl[3 * k]!,
          vy = vl[3 * k + 1]!,
          vz = vl[3 * k + 2]!;
        const tx = wl[3 * k]!,
          ty = wl[3 * k + 1]!;
        const b1 = B1[k]!,
          b2 = B2[k]!;
        ax += b1 * vx;
        ay += b2 * vy;
        axy += b2 * vx + b1 * vy;
        bx += b1 * ty;
        by -= b2 * tx;
        bxy += b2 * ty - b1 * tx;
        gxz += b1 * vz + 0.25 * ty;
        gyz += b2 * vz - 0.25 * tx;
      }
      // Stresses through the thickness, moved on by the rates over dt; resultants N, M, Q.
      let Nx = 0,
        Ny = 0,
        Nxy = 0,
        Mx = 0,
        My = 0,
        Mxy = 0,
        Qx = 0,
        Qy = 0;
      const dgxz = gxz * dt;
      const dgyz = gyz * dt;
      const kG = shearFactor * G;
      const flow = mat.plastic;
      const cs = flow?.cowperSymonds;
      let failed = 0;
      // This shell's work over the step, and the part of it with the stresses at the step's start
      // only (what it does if it is erased at the step's end: its end forces are dropped).
      let own = 0;
      let ownStart = 0;
      for (let q = 0; q < np; q++) {
        const z = (zeta[q]! * t) / 2;
        const wt = (weight[q]! * t) / 2;
        const dex = (ax + z * bx) * dt;
        // Cowper–Symonds: this point's effective strain rate, membrane and bending (an
        // incompressible estimate of the thickness rate).
        let rateScale = 1;
        if (cs && dt > 0) {
          const rx = ax + z * bx,
            ry = ay + z * by,
            rxy = axy + z * bxy;
          const rz = -(rx + ry);
          const rate = Math.sqrt((2 / 3) * (rx * rx + ry * ry + rz * rz + 0.5 * rxy * rxy));
          rateScale = 1 + (rate / cs.C) ** (1 / cs.p);
        }
        const dey = (ay + z * by) * dt;
        const dgxy = (axy + z * bxy) * dt;
        const o = (e * np + q) * 5;
        const s0 = stress[o]!,
          s1 = stress[o + 1]!,
          s2 = stress[o + 2]!,
          s3 = stress[o + 3]!,
          s4 = stress[o + 4]!;
        let n0 = s0 + D * (dex + nu * dey);
        let n1s = s1 + D * (dey + nu * dex);
        let n2 = s2 + G * dgxy;
        if (flow && dt > 0) {
          // J2 in plane stress on the in-plane part; the transverse shear stays elastic.
          trial[0] = n0;
          trial[1] = n1s;
          trial[2] = n2;
          const pi = e * np + q;
          // Only a trial past the yield surface goes back to it.
          const y = rateScale * flowStress(flow, plastic[pi]!);
          const back =
            n0 * n0 + n1s * n1s - n0 * n1s + 3 * n2 * n2 > y * y
              ? planeStressReturn(trial, E, nu, flow, plastic[pi]!, rateScale)
              : noReturn;
          if (back.dEps > 0) {
            n0 = back.stress[0];
            n1s = back.stress[1];
            n2 = back.stress[2];
            plastic[pi] += back.dEps;
          }
          if (flow.failureStrain !== undefined && plastic[pi]! >= flow.failureStrain) failed++;
        }
        const n3s = s3 + kG * dgxz;
        const n4 = s4 + kG * dgyz;
        stress[o] = n0;
        stress[o + 1] = n1s;
        stress[o + 2] = n2;
        stress[o + 3] = n3s;
        stress[o + 4] = n4;
        // The work over the step with the mean stress (exact for a linear material; plastic
        // work is the trapezoid rule's).
        own +=
          0.5 *
          A *
          wt *
          ((s0 + n0) * dex +
            (s1 + n1s) * dey +
            (s2 + n2) * dgxy +
            (s3 + n3s) * dgxz +
            (s4 + n4) * dgyz);
        ownStart += 0.5 * A * wt * (s0 * dex + s1 * dey + s2 * dgxy + s3 * dgxz + s4 * dgyz);
        Nx += wt * n0;
        Ny += wt * n1s;
        Nxy += wt * n2;
        Mx += wt * z * n0;
        My += wt * z * n1s;
        Mxy += wt * z * n2;
        Qx += wt * n3s;
        Qy += wt * n4;
      }
      // Erased once more than half its thickness points pass the failure strain: no stress, no
      // force from the step's end on (its mass stays on the nodes). Its work over this step is
      // then the start forces' half of the trapezoid, as the held components' work is.
      const erase = 2 * failed > np;
      const done = erase ? ownStart : own;
      internal += done;
      if (partInternal) partInternal[shellPart![e]!] += done;
      // Hourglass control (Belytschko–Tsay, stiffness form): the hourglass shape vector γ, the
      // hourglass rates of the membrane, transverse and rotational motions, and resisting
      // resultants that grow with them.
      const hx = xl[0]! - xl[1]! + xl[2]! - xl[3]!;
      const hy = yl[0]! - yl[1]! + yl[2]! - yl[3]!;
      let bb = 0;
      let r0 = 0,
        r1 = 0,
        r2 = 0,
        r3 = 0,
        r4 = 0;
      for (let k = 0; k < 4; k++) {
        const gk = hourglassVector[k]! - hx * B1[k]! - hy * B2[k]!;
        g[k] = gk;
        bb += B1[k]! * B1[k]! + B2[k]! * B2[k]!;
        r0 += gk * vl[3 * k]!;
        r1 += gk * vl[3 * k + 1]!;
        r2 += gk * vl[3 * k + 2]!;
        r3 += gk * wl[3 * k]!;
        r4 += gk * wl[3 * k + 1]!;
      }
      const rm = (qh * E * t * A * bb) / 8;
      const rb = (qh * E * t * t * t * A * bb) / 192;
      // The transverse (w) mode moves the corners, not turns them: a force per length, the
      // rotational stiffness over the element's length squared (BB ~ 1/L²), as a plate's
      // bending stiffness D/L² goes.
      const rw = rb * bb;
      const h = 5 * e;
      const h0 = hg[h]!,
        h1 = hg[h + 1]!,
        h2 = hg[h + 2]!,
        h3 = hg[h + 3]!,
        h4 = hg[h + 4]!;
      const q0 = h0 + rm * r0 * dt,
        q1 = h1 + rm * r1 * dt,
        q2 = h2 + rw * r2 * dt,
        q3 = h3 + rb * r3 * dt,
        q4 = h4 + rb * r4 * dt;
      if (erase) {
        hourglassWork += 0.5 * dt * (h0 * r0 + h1 * r1 + h2 * r2 + h3 * r3 + h4 * r4);
        this.erased[e] = 1;
        stress.fill(0, e * np * 5, (e + 1) * np * 5);
        hg.fill(0, 5 * e, 5 * e + 5);
        continue;
      }
      hg[h] = q0;
      hg[h + 1] = q1;
      hg[h + 2] = q2;
      hg[h + 3] = q3;
      hg[h + 4] = q4;
      hourglassWork +=
        0.5 *
        dt *
        ((h0 + q0) * r0 + (h1 + q1) * r1 + (h2 + q2) * r2 + (h3 + q3) * r3 + (h4 + q4) * r4);
      for (let k = 0; k < 4; k++) {
        const b1 = B1[k]!,
          b2 = B2[k]!,
          gk = g[k]!;
        fl[3 * k] = A * (b1 * Nx + b2 * Nxy) + gk * q0;
        fl[3 * k + 1] = A * (b2 * Ny + b1 * Nxy) + gk * q1;
        fl[3 * k + 2] = A * (b1 * Qx + b2 * Qy) + gk * q2;
        ml[3 * k] = A * (-b2 * My - b1 * Mxy - 0.25 * Qy) + gk * q3;
        ml[3 * k + 1] = A * (b1 * Mx + b2 * Mxy + 0.25 * Qx) + gk * q4;
      }
      // Back to the global axes; a triangle's repeated node gathers both corners.
      for (let k = 0; k < 4; k++) {
        const i = k === 0 ? i0 : k === 1 ? i1 : k === 2 ? i2 : i3;
        const f1 = fl[3 * k]!,
          f2 = fl[3 * k + 1]!,
          f3 = fl[3 * k + 2]!;
        const m1 = ml[3 * k]!,
          m2 = ml[3 * k + 1]!;
        fInt[i] += f1 * e1x + f2 * e2x + f3 * e3x;
        fInt[i + 1] += f1 * e1y + f2 * e2y + f3 * e3y;
        fInt[i + 2] += f1 * e1z + f2 * e2z + f3 * e3z;
        mInt[i] += m1 * e1x + m2 * e2x;
        mInt[i + 1] += m1 * e1y + m2 * e2y;
        mInt[i + 2] += m1 * e1z + m2 * e2z;
      }
    }
    internal += this.beamForces(dt);
    next = Math.min(next, this.beamStep);
    // A shape whose step fell a thousandfold has collapsed (it would only stall the run).
    if (next < 1e-3 * this.step)
      throw new ExplicitError(
        'element-inverted',
        `an element has collapsed: its stable step fell to ${next.toExponential(2)} s`,
      );
    this.nextStep = next;
    this.internal += internal;
    this.hourglassEnergy += hourglassWork;
  }

  /**
   * VS5c: the beams' forces and moments, added to the nodes'; returns their work over dt. Each
   * beam's frame: axis 1 along it, axis 2 turned with its nodes' mean rotation and kept square to
   * axis 1. Rates from the half-step velocities: stretch, twist, the two curvatures and the two
   * shears at its middle (Timoshenko, one point: no spurious modes for two nodes); the resultants
   * move on with them (elastic).
   */
  private beamStep = Infinity;

  private beamForces(dt: number): number {
    const { model, x, v, w, fInt, mInt, beamForce, beamAxis } = this;
    const beams = model.beams;
    let work = 0;
    let beamNext = Infinity;
    for (let b = 0; b < this.beamCount; b++) {
      if (this.beamInert[b]) continue;
      const i = 3 * beams![2 * b]!;
      const j = 3 * beams![2 * b + 1]!;
      const dx = x[j]! - x[i]!,
        dy = x[j + 1]! - x[i + 1]!,
        dz = x[j + 2]! - x[i + 2]!;
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(L > 0)) throw new ExplicitError('element-inverted', `beam ${b} has collapsed`);
      const e1x = dx / L,
        e1y = dy / L,
        e1z = dz / L;
      const mx = 0.5 * (w[i]! + w[j]!),
        my = 0.5 * (w[i + 1]! + w[j + 1]!),
        mz = 0.5 * (w[i + 2]! + w[j + 2]!);
      // Axis 2 turned by the mean rotation over the step, then square to axis 1.
      const ox = beamAxis[3 * b]!,
        oy = beamAxis[3 * b + 1]!,
        oz = beamAxis[3 * b + 2]!;
      let ax = ox,
        ay = oy,
        az = oz;
      const tx = ax + dt * (my * az - mz * ay),
        ty = ay + dt * (mz * ax - mx * az),
        tz = az + dt * (mx * ay - my * ax);
      const along = tx * e1x + ty * e1y + tz * e1z;
      ax = tx - along * e1x;
      ay = ty - along * e1y;
      az = tz - along * e1z;
      const n2 = Math.sqrt(ax * ax + ay * ay + az * az);
      if (!(n2 > 0)) throw new ExplicitError('element-inverted', `beam ${b} lost its axis 2`);
      ax /= n2;
      ay /= n2;
      az /= n2;
      beamAxis[3 * b] = ax;
      beamAxis[3 * b + 1] = ay;
      beamAxis[3 * b + 2] = az;
      const e3x = e1y * az - e1z * ay,
        e3y = e1z * ax - e1x * az,
        e3z = e1x * ay - e1y * ax;
      const dvx = v[j]! - v[i]!,
        dvy = v[j + 1]! - v[i + 1]!,
        dvz = v[j + 2]! - v[i + 2]!;
      // The rates in the frame at the step's middle (where the half-step velocities belong): a
      // rigid turn then strains nothing to second order.
      const hx = dx - 0.5 * dt * dvx,
        hy = dy - 0.5 * dt * dvy,
        hz = dz - 0.5 * dt * dvz;
      const Lh = Math.sqrt(hx * hx + hy * hy + hz * hz);
      const own = (this.stepOfB[b]! * L) / this.lengthOfB[b]!;
      if (own < beamNext) beamNext = own;
      const f1x = hx / Lh,
        f1y = hy / Lh,
        f1z = hz / Lh;
      let f2x = ox + tx,
        f2y = oy + ty,
        f2z = oz + tz;
      const back = f2x * f1x + f2y * f1y + f2z * f1z;
      f2x -= back * f1x;
      f2y -= back * f1y;
      f2z -= back * f1z;
      const nf = Math.sqrt(f2x * f2x + f2y * f2y + f2z * f2z);
      f2x /= nf;
      f2y /= nf;
      f2z /= nf;
      const f3x = f1y * f2z - f1z * f2y,
        f3y = f1z * f2x - f1x * f2z,
        f3z = f1x * f2y - f1y * f2x;
      const dwx = w[j]! - w[i]!,
        dwy = w[j + 1]! - w[i + 1]!,
        dwz = w[j + 2]! - w[i + 2]!;
      const dot = (px: number, py: number, pz: number, qx: number, qy: number, qz: number) =>
        px * qx + py * qy + pz * qz;
      // Stretch, shears 12 and 13, twist, curvatures about 2 and 3.
      const rate0 = dot(dvx, dvy, dvz, f1x, f1y, f1z) / Lh;
      const rate1 = dot(dvx, dvy, dvz, f2x, f2y, f2z) / Lh - dot(mx, my, mz, f3x, f3y, f3z);
      const rate2 = dot(dvx, dvy, dvz, f3x, f3y, f3z) / Lh + dot(mx, my, mz, f2x, f2y, f2z);
      const rate3 = dot(dwx, dwy, dwz, f1x, f1y, f1z) / Lh;
      const rate4 = dot(dwx, dwy, dwz, f2x, f2y, f2z) / Lh;
      const rate5 = dot(dwx, dwy, dwz, f3x, f3y, f3z) / Lh;
      const q = model.sections![model.beamSection![b]!]!;
      const mat = model.materials[model.beamMaterial![b]!]!;
      const E = mat.youngsModulus;
      const G = E / (2 * (1 + mat.poissonRatio));
      const stiff = [
        E * q.area,
        shearFactor * G * q.area,
        shearFactor * G * q.area,
        G * q.j,
        E * q.i2,
        E * q.i3,
      ];
      const rates = [rate0, rate1, rate2, rate3, rate4, rate5];
      const o = 6 * b;
      for (let k = 0; k < 6; k++) {
        const before = beamForce[o + k]!;
        const after = before + stiff[k]! * rates[k]! * dt;
        beamForce[o + k] = after;
        work += 0.5 * Lh * dt * (before + after) * rates[k]!;
      }
      const N = beamForce[o]!,
        Q2 = beamForce[o + 1]!,
        Q3 = beamForce[o + 2]!,
        T = beamForce[o + 3]!,
        M2 = beamForce[o + 4]!,
        M3 = beamForce[o + 5]!;
      // Virtual power: the end force N e1 + Q2 e2 + Q3 e3; the end moments ±(T e1 + M2 e2 +
      // M3 e3) and, from the shears at the middle, L/2 (Q3 e2 − Q2 e3) on each node.
      for (let a = 0; a < 3; a++) {
        const e1 = a === 0 ? e1x : a === 1 ? e1y : e1z;
        const e2 = a === 0 ? ax : a === 1 ? ay : az;
        const e3 = a === 0 ? e3x : a === 1 ? e3y : e3z;
        const f = N * e1 + Q2 * e2 + Q3 * e3;
        fInt[j + a] += f;
        fInt[i + a] -= f;
        const m = T * e1 + M2 * e2 + M3 * e3;
        const sh = 0.5 * L * (Q3 * e2 - Q2 * e3);
        mInt[j + a] += m + sh;
        mInt[i + a] += sh - m;
      }
    }
    this.beamStep = beamNext;
    return work;
  }

  /**
   * The force the held components of these nodes take (N, global axes) at the current time: what
   * holds them against the shells' internal forces and the external ones. A held rigid body with
   * any node among them counts once, with the net load on its held components.
   */
  reaction(nodes: readonly number[]): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    const bodies = new Set<number>();
    for (const i of nodes) {
      const k = this.bodyOf[i]!;
      if (k >= 0) {
        bodies.add(k);
        continue;
      }
      for (let a = 0; a < 3; a++)
        if (!this.free[6 * i + a]) out[a] += this.fInt[3 * i + a]! - this.fExt[3 * i + a]!;
    }
    for (const k of bodies) {
      const b = this.bodies[k]!;
      if (!(b.held & 7)) continue;
      const { f } = this.bodyLoads(b);
      for (let a = 0; a < 3; a++) if (b.held & (1 << a)) out[a] -= f[a]!;
    }
    return out;
  }

  /** What the run has so far, with the energy checks. */
  result(): ExplicitResult {
    const last = this.energy();
    const first = this.energies[0]!;
    const total = (q: ExplicitEnergies) =>
      q.kinetic + q.internal + q.hourglass + q.contact - q.external;
    const scale = Math.max(
      ...this.energies.map((q) =>
        Math.max(q.kinetic, q.internal + q.hourglass + Math.abs(q.contact), Math.abs(q.external)),
      ),
      last.kinetic,
      1e-300,
    );
    const error = Math.abs(total(last) - total(first)) / scale;
    // Hourglass energy with no internal energy at all is all spurious (only rest is clean).
    const hgShare =
      last.internal > 0
        ? last.hourglass / last.internal
        : last.hourglass > 1e-12 * scale
          ? Infinity
          : 0;
    const share = this.addedMass / this.totalMass;
    return {
      step: this.step,
      steps: this.steps,
      frames: this.frames,
      addedMass: this.addedMass,
      addedMassShare: share,
      energies: this.energies,
      barriers: this.barrierHist.map((b) => ({
        kind: b.kind,
        index: b.index,
        time: Float64Array.from(b.t),
        force: Float64Array.from(b.f),
      })),
      history: this.hist.map((h) => ({
        node: h.node,
        time: Float64Array.from(h.t),
        displacement: Float64Array.from(h.u),
        velocity: Float64Array.from(h.v),
      })),
      checks: [
        {
          name: 'energy-balance',
          pass: error <= 0.05,
          detail: `energy error ${(100 * error).toFixed(2)} % of the largest energy (limit 5 %)`,
        },
        {
          name: 'hourglass-energy',
          // A trace of hourglass energy next to a trace of strain (a body moving rigidly) is noise:
          // under 0.1 % of the largest energy it passes whatever its share.
          pass: hgShare <= 0.1 || last.hourglass <= 1e-3 * scale,
          detail: Number.isFinite(hgShare)
            ? `hourglass energy ${(100 * hgShare).toFixed(2)} % of the internal energy (limit 10 %, or under 0.1 % of the largest energy)`
            : 'hourglass energy with no internal energy (limit 10 %, or under 0.1 % of the largest energy)',
        },
        {
          name: 'mass-scaling',
          pass: share <= 0.05,
          detail: `added mass ${(100 * share).toFixed(2)} % of the model (limit 5 %)`,
        },
      ],
    };
  }
}

/** Runs the model to its end time in one go. */
export function runExplicit(model: ExplicitModel, settings: ExplicitSettings): ExplicitResult {
  const solver = new ExplicitSolver(model, settings);
  while (!solver.done) solver.advance(10_000);
  return solver.result();
}

/**
 * A structured mesh of quads over a rectangle in the x–y plane at z = 0, `nx` × `ny` elements,
 * nodes row by row (node i + (nx + 1) j at (i·a/nx, j·b/ny)).
 */
export function quadPlate(a: number, b: number, nx: number, ny: number) {
  const nodes = new Float64Array(3 * (nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const k = i + (nx + 1) * j;
      nodes[3 * k] = (i * a) / nx;
      nodes[3 * k + 1] = (j * b) / ny;
    }
  const shells = new Uint32Array(4 * nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const e = i + nx * j;
      const n0 = i + (nx + 1) * j;
      shells.set([n0, n0 + 1, n0 + nx + 2, n0 + nx + 1], 4 * e);
    }
  return { nodes, shells };
}

function cross(a: number[], b: number[]): number[] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}
function norm(a: number[]): number {
  return Math.hypot(a[0]!, a[1]!, a[2]!);
}
/** Area of a quad (half the diagonals' cross product); a triangle with its last node repeated. */
function quadArea(c: Float64Array): number {
  const d1 = [c[6]! - c[0]!, c[7]! - c[1]!, c[8]! - c[2]!];
  const d2 = [c[9]! - c[3]!, c[10]! - c[4]!, c[11]! - c[5]!];
  return 0.5 * norm(cross(d1, d2));
}

/** A rigid body's state (VS5c). */
interface RigidState {
  nodes: Uint32Array;
  /** Its nodes' positions from the centre at the start (3 each). */
  r0: Float64Array;
  /** Its whole mass and the added part (t). */
  mass: number;
  extra: number;
  /** Where the added mass sits from the centre at the start (its nodes' centroid). */
  offset: number[];
  held: number;
  /** Inertia about the centre at the start, global axes (row-major 3 × 3). */
  I0: Float64Array;
  /** Its turn since the start (row-major 3 × 3). */
  R: Float64Array;
  xc: number[];
  /** Centre velocity, angular velocity and angular momentum at the half step. */
  vc: number[];
  w: number[];
  L: number[];
  /** Gravity on the added mass (N). */
  force: number[];
}

const zeros3 = new Float64Array(3);

function det3(m: Float64Array): number {
  return (
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
  );
}
function mul3(m: Float64Array, p: number[]): number[] {
  return [0, 1, 2].map((a) => m[3 * a]! * p[0]! + m[3 * a + 1]! * p[1]! + m[3 * a + 2]! * p[2]!);
}
function mul33(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      out[3 * r + c] = a[3 * r]! * b[c]! + a[3 * r + 1]! * b[3 + c]! + a[3 * r + 2]! * b[6 + c]!;
  return out;
}
/** m⁻¹ p by Cramer's rule. */
function solve3(m: Float64Array, p: number[]): number[] {
  const d = det3(m);
  return [0, 1, 2].map((k) => {
    const c = Float64Array.from(m);
    for (let a = 0; a < 3; a++) c[3 * a + k] = p[a]!;
    return det3(c) / d;
  });
}
/** The rotation by the vector θ (Rodrigues). */
function rotation(tx: number, ty: number, tz: number): Float64Array {
  const t = Math.hypot(tx, ty, tz);
  if (t === 0) return new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const [x, y, z] = [tx / t, ty / t, tz / t];
  const c = Math.cos(t);
  const s = Math.sin(t);
  const k = 1 - c;
  return new Float64Array([
    c + x * x * k,
    x * y * k - z * s,
    x * z * k + y * s,
    y * x * k + z * s,
    c + y * y * k,
    y * z * k - x * s,
    z * x * k - y * s,
    z * y * k + x * s,
    c + z * z * k,
  ]);
}

const closestOnTriangle = (p: readonly number[], a: number[], b: number[], c: number[]) =>
  ContactSet.closest([...p], a, b, c);
