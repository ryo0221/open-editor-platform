import { nodesPerElement, type FemMesh } from './fem';
import {
  boundaryFaceList,
  boundaryFacePoints,
  detAt,
  ElasticError,
  jacobianRatio,
  shapeValues,
  gaussPoints,
  gaussWeight,
  tetRule,
} from './elastic';
import type { CalculixHeatFace, CalculixHeatModel } from './calculix-heat';
import { CsrMatrix, pcg } from './sparse';
import { radiosityFlux, viewFactors, type RadiationLimits, type ViewFactors } from './radiation';
import { assembleConduction, type ThermalMaterial } from './thermal';

/**
 * VS11a (docs/cad/vehicle-simulation.md, VS11): transient heat conduction in an isotropic solid on
 * a FEM 1 mesh. Units follow mm–N–MPa–t–s as the steady solver (`thermal.ts`): power mW, energy
 * mJ, density t/mm³, specific heat mm²/(s²·K) (1 J/(kg·K) = 10⁶ mm²/(s²·K)), so ρ c is in
 * mJ/(mm³·K). Temperatures are absolute K: radiation needs them.
 */
export interface TransientMaterial extends ThermalMaterial {
  /** t/mm³. */
  density: number;
  /** mm²/(s²·K); 460 J/(kg·K) of steel is 4.6e8. */
  specificHeat: number;
}

/** σ in mW/(mm²·K⁴): 5.670374419e-8 W/(m²·K⁴). */
export const stefanBoltzmann = 5.670374419e-11;

/**
 * A factor over time (s), linear between the points and held at the first and last outside them
 * (the CalculiX `*AMPLITUDE` with that meaning). Times strictly increase.
 */
export interface Amplitude {
  times: number[];
  factors: number[];
}

/** The factor of an amplitude at `t`; 1 without one. */
export function amplitudeAt(a: Amplitude | undefined, t: number): number {
  if (!a) return 1;
  const { times, factors } = a;
  if (t <= times[0]!) return factors[0]!;
  const last = times.length - 1;
  if (t >= times[last]!) return factors[last]!;
  let lo = 0,
    hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const s = (t - times[lo]!) / (times[hi]! - times[lo]!);
  return factors[lo]! + s * (factors[hi]! - factors[lo]!);
}

/** A transient condition. `amplitude` scales the held temperature, the flux, or the film coefficient. */
export type TransientCondition =
  | {
      kind: 'temperature';
      faces: number[];
      edges: number[];
      temperature: number;
      amplitude?: Amplitude;
    }
  | { kind: 'heat-flux'; faces: number[]; flux: number; amplitude?: Amplitude }
  | {
      kind: 'convection';
      faces: number[];
      coefficient: number;
      ambient: number;
      amplitude?: Amplitude;
    }
  /** Gray radiation ε σ (T∞⁴ − T⁴) into the body from surroundings at T∞ (K). */
  | { kind: 'radiation'; faces: number[]; emissivity: number; ambient: number }
  /**
   * VS11b: faces that radiate to each other (gray, diffuse, emissivity ε) and to the surroundings
   * at `TransientInput.enclosure.ambient`. All enclosure conditions form one enclosure.
   */
  | { kind: 'enclosure'; faces: number[]; emissivity: number };

/** An area-mean temperature over faces, recorded every step. */
export interface TransientProbe {
  name: string;
  faces: number[];
}

export interface TransientInput {
  mesh: FemMesh;
  material: TransientMaterial;
  conditions: TransientCondition[];
  /** K: one value, or one per node. */
  initialTemperature: number | Float64Array;
  /**
   * `end` and `step` in s; the last step is shortened to end at `end`. `theta` weighs the new
   * time (1 backward Euler, 0.5 Crank–Nicolson), between 0.5 and 1.
   */
  time: { end: number; step: number; theta: number };
  /** The field is kept at t = 0, every `every` steps and at the end. */
  output: { every: number };
  probes?: TransientProbe[];
  /** Each linear solve (PCG). */
  solver: { tolerance: number; maxIterations: number };
  /** Newton on radiation: until the largest change is ≤ `tolerance` K. */
  nonlinear?: { tolerance: number; maxIterations: number };
  limits?: Partial<TransientLimits>;
  /**
   * VS11b: the enclosure's surroundings (K) and the rays cast from each patch for its view
   * factors; needed when a condition is an `enclosure`.
   */
  enclosure?: { ambient: number; raysPerPatch: number; limits?: Partial<RadiationLimits> };
  /**
   * VS11d-3: the temperatures (K per node) of every step 1…steps, solved elsewhere (CalculiX on a
   * Host), taken in place of solving: the run keeps, records and balances them as its own, and
   * `replayResidual` says how well each step solves this solver's equations.
   */
  replay?: readonly ArrayLike<number>[];
  /**
   * VS11d-3 (Codex on #1272): the capacity's quadrature. `exact` (the default) integrates
   * ∫ ρc N_a N_b dV exactly and keeps C full rank; `conduction` takes the conduction's own rule, as
   * CalculiX integrates its capacity (1 point on a tet4, 4 on a tet10, where C is rank deficient),
   * and is what a Host run and its replay solve. With `replay` the default is `conduction`.
   */
  capacityRule?: 'exact' | 'conduction';
}

/**
 * CalculiX writes temperatures to the `.frd` with 6 significant digits (E12.5): a replayed value
 * is within this relative rounding of what it solved.
 */
export const frdRounding = 1e-5;

export interface TransientLimits {
  steps: number;
  /** Kept fields, and kept fields × nodes. */
  snapshots: number;
  snapshotValues: number;
  newtonIterations: number;
  amplitudePoints: number;
}
export const transientLimits: Readonly<TransientLimits> = Object.freeze({
  steps: 20_000,
  snapshots: 400,
  snapshotValues: 20_000_000,
  newtonIterations: 50,
  amplitudePoints: 10_000,
});

export interface TransientResult {
  /** The times (s) of the kept fields, from 0. */
  times: number[];
  /** K per node at each kept time. */
  temperatures: Float64Array[];
  /** Per step, from t = 0 (steps + 1 entries). */
  history: {
    time: Float64Array;
    maxTemperature: Float64Array;
    minTemperature: Float64Array;
    /** Energy stored above the start (mJ). */
    stored: Float64Array;
    /** Heat in by all conditions since the start (mJ), held temperatures included. */
    heatIn: Float64Array;
    /** The probes' area-mean temperatures (K), in `probes` order. */
    probes: Float64Array[];
  };
  /** Heat each condition put in over the run (mJ; negative took it out). */
  conditionHeat: number[];
  /** Each condition's area (mm²; 0 for a temperature on edges only), and each probe's. */
  conditionAreas: number[];
  probeAreas: number[];
  /** Nodes each temperature condition holds (0 for the others). */
  constrainedNodes: number[];
  /** The largest |stored − heatIn| over the run (mJ), and the energy scale it is measured on. */
  balance: number;
  energyScale: number;
  /** Total PCG iterations, the most Newton iterations of a step, the largest PCG residual. */
  iterations: number;
  newtonIterations: number;
  residual: number;
  /** Every solve met its tolerance. */
  converged: boolean;
  /** Each condition's power at the end (mW, θ-weighted over the last step). */
  conditionPower: number[];
  /**
   * The body's heat capacity Σ ρ c V (mJ/K): times a temperature, the size of the stored energy
   * whose roundoff a balance cannot go below.
   */
  heatCapacity: number;
  /** VS11b: the enclosure's view factors (absent without one). */
  viewFactors?: ViewFactors;
  /**
   * VS11d-3: with `replay`, the largest free-node residual of a step, C (T − Tⁿ)/Δt + θF + (1 − θ)Fⁿ,
   * relative to the largest of its terms over the run (0 when it solves these equations exactly).
   */
  replayResidual?: number;
}

function checkAmplitude(a: Amplitude | undefined, i: number, limit: number) {
  if (!a) return;
  const { times, factors } = a;
  if (!Array.isArray(times) || !Array.isArray(factors) || times.length !== factors.length)
    throw new ElasticError('material', `condition ${i}: amplitude times and factors differ`);
  if (!times.length) throw new ElasticError('material', `condition ${i}: amplitude has no point`);
  if (times.length > limit)
    throw new ElasticError('limit', `condition ${i}: amplitude has more than ${limit} points`);
  times.forEach((t, k) => {
    if (!Number.isFinite(t) || !Number.isFinite(factors[k]!))
      throw new ElasticError('material', `condition ${i}: amplitude point ${k} is not finite`);
    if (k > 0 && !(t > times[k - 1]!))
      throw new ElasticError('material', `condition ${i}: amplitude times must increase`);
  });
}

const finitePositive = (v: number) => v > 0 && Number.isFinite(v);

/**
 * Solves C Ṫ + K T = Q(t, T) by the θ-method with Newton on radiation: per step
 * C (Tⁿ⁺¹ − Tⁿ)/Δt + θ F(tⁿ⁺¹, Tⁿ⁺¹) + (1 − θ) F(tⁿ, Tⁿ) = 0 on the free nodes, F = K T − Q, the
 * held temperatures set at each time. C is the consistent capacity ∫ ρ c N_a N_b dV.
 * Refuses before solving: a value that is not finite or out of range (`material`), a condition on
 * no face (`empty-target`), two temperatures on one node at once (`constraint-conflict`), a folded
 * element (`mesh-quality`), and inputs beyond `transientLimits` (`limit`). Unlike the steady solver
 * it needs no held temperature: the capacity fixes the level.
 */
/**
 * VS11d-3: what a transient run checks and builds before stepping: the limits, the conditions'
 * faces and held nodes (each node held by one condition), the conduction K and the capacity C.
 * Shared by the solver and the CalculiX model of the same input (`transientCalculixModel`).
 */
function transientSetup(input: TransientInput) {
  const { mesh, material, conditions } = input;
  const limits = { ...transientLimits, ...input.limits };
  const { conductivity: k, density, specificHeat } = material;
  if (!finitePositive(k)) throw new ElasticError('material', 'conductivity > 0');
  if (!finitePositive(density)) throw new ElasticError('material', 'density > 0');
  if (!finitePositive(specificHeat)) throw new ElasticError('material', 'specific heat > 0');
  const { end, step, theta } = input.time;
  if (!finitePositive(end) || !finitePositive(step))
    throw new ElasticError('material', 'end time and time step > 0');
  if (!(theta >= 0.5 && theta <= 1)) throw new ElasticError('material', 'θ in 0.5..1');
  const steps = Math.max(1, Math.ceil(end / step - 1e-9));
  if (steps > limits.steps)
    throw new ElasticError('limit', `${steps} steps, more than ${limits.steps}`);
  const every = input.output.every;
  if (!Number.isSafeInteger(every) || every < 1)
    throw new ElasticError('material', 'output every ≥ 1 step');
  const npe = nodesPerElement(mesh.type);
  const n = mesh.nodes.length / 3;
  const m = mesh.elements.length / npe;
  const kept = Math.floor(steps / every) + (steps % every ? 1 : 0) + 1;
  if (kept > limits.snapshots || kept * n > limits.snapshotValues)
    throw new ElasticError(
      'limit',
      `${kept} kept fields of ${n} nodes, more than ${limits.snapshots} or ${limits.snapshotValues} values`,
    );
  const replay = input.replay;
  if (replay) {
    if (replay.length !== steps)
      throw new ElasticError('material', `replay: ${replay.length} fields for ${steps} steps`);
    if (steps * n > limits.snapshotValues)
      throw new ElasticError(
        'limit',
        `replay: ${steps} steps of ${n} nodes, more than ${limits.snapshotValues} values`,
      );
    replay.forEach((T, s) => {
      if (T.length !== n)
        throw new ElasticError(
          'material',
          `replay step ${s + 1}: ${T.length} values for ${n} nodes`,
        );
      for (let p = 0; p < n; p++)
        if (!(T[p]! >= 0) || !Number.isFinite(T[p]!))
          throw new ElasticError(
            'material',
            `replay step ${s + 1} node ${p}: not a temperature ≥ 0 K`,
          );
    });
  }
  const newtonLimit = input.nonlinear?.maxIterations ?? 20;
  const newtonTolerance = input.nonlinear?.tolerance ?? 1e-6;
  if (
    !Number.isSafeInteger(newtonLimit) ||
    newtonLimit < 1 ||
    newtonLimit > limits.newtonIterations
  )
    throw new ElasticError('limit', `Newton iterations in 1..${limits.newtonIterations}`);
  if (!finitePositive(newtonTolerance)) throw new ElasticError('material', 'Newton tolerance > 0');
  conditions.forEach((c, i) => {
    const values =
      c.kind === 'temperature'
        ? [c.temperature]
        : c.kind === 'heat-flux'
          ? [c.flux]
          : c.kind === 'convection'
            ? [c.coefficient, c.ambient]
            : c.kind === 'radiation'
              ? [c.emissivity, c.ambient]
              : [c.emissivity];
    if (!values.every(Number.isFinite))
      throw new ElasticError('material', `condition ${i} has a value that is not finite`);
    if (c.kind === 'convection' && !(c.coefficient > 0))
      throw new ElasticError('material', `condition ${i}: film coefficient > 0`);
    if (
      (c.kind === 'radiation' || c.kind === 'enclosure') &&
      !(c.emissivity > 0 && c.emissivity <= 1)
    )
      throw new ElasticError('material', `condition ${i}: emissivity in (0, 1]`);
    if (c.kind === 'radiation' && !(c.ambient >= 0))
      throw new ElasticError('material', `condition ${i}: ambient ≥ 0 K`);
    // Temperatures are absolute: a held or ambient one below 0 K is refused.
    if ((c.kind === 'convection' || c.kind === 'radiation') && !(c.ambient >= 0))
      throw new ElasticError('material', `condition ${i}: ambient ≥ 0 K`);
    if (c.kind !== 'radiation' && c.kind !== 'enclosure') {
      checkAmplitude(c.amplitude, i, limits.amplitudePoints);
      if (
        c.kind === 'temperature' &&
        (!(c.temperature >= 0) ||
          (c.amplitude?.factors ?? [1]).some((f) => !(c.temperature * f >= 0)))
      )
        throw new ElasticError('material', `condition ${i}: held temperature ≥ 0 K at every time`);
      if (c.kind === 'convection' && c.amplitude?.factors.some((f) => f < 0))
        throw new ElasticError('material', `condition ${i}: film amplitude ≥ 0`);
    }
  });
  const T0 = input.initialTemperature;
  if (
    typeof T0 === 'number'
      ? !Number.isFinite(T0) || T0 < 0
      : T0.length !== n || !T0.every((v) => Number.isFinite(v) && v >= 0)
  )
    throw new ElasticError('material', `initial temperature: one value ≥ 0 K or ${n}`);
  if (mesh.type === 'tet10')
    for (let e = 0; e < m; e++)
      if (!(jacobianRatio(mesh, e) > 0))
        throw new ElasticError('mesh-quality', `element ${e} may fold (det J bound ≤ 0)`);

  // Faces and held nodes.
  const faceSets = conditions.map((c, ci) => {
    const faces = boundaryFaceList(mesh, c.faces);
    if (c.kind !== 'temperature' && !faces.length)
      throw new ElasticError('empty-target', `condition ${ci} is on no face`);
    return faces;
  });
  const heldNodes: number[][] = [];
  const constrainedNodes: number[] = [];
  const owner = new Int32Array(n).fill(-1);
  conditions.forEach((c, ci) => {
    if (c.kind !== 'temperature') {
      heldNodes.push([]);
      constrainedNodes.push(0);
      return;
    }
    const nodes = new Set<number>();
    for (const { e, lf } of faceSets[ci]!)
      for (const p of boundaryFacePoints(mesh, e, lf).nodes) nodes.add(p);
    for (const edge of c.edges) {
      if (!Number.isInteger(edge) || edge < 0 || edge >= mesh.shapeEdges)
        throw new ElasticError('target-index', `edge ${edge} is not in 0..${mesh.shapeEdges - 1}`);
      for (const p of mesh.edges.nodes.subarray(
        mesh.edges.offsets[edge]!,
        mesh.edges.offsets[edge + 1]!,
      ))
        nodes.add(p);
    }
    if (!nodes.size) throw new ElasticError('empty-target', `condition ${ci} holds no node`);
    const own: number[] = [];
    for (const p of nodes) {
      const before = owner[p]!;
      if (before >= 0) {
        // Two conditions may hold one node only if they agree at every time.
        const b = conditions[before] as Extract<TransientCondition, { kind: 'temperature' }>;
        if (!sameHeld(b, c, end))
          throw new ElasticError(
            'constraint-conflict',
            `conditions ${before} and ${ci} hold node ${p} at different temperatures`,
          );
        continue;
      }
      owner[p] = ci;
      own.push(p);
    }
    heldNodes.push(own);
    constrainedNodes.push(nodes.size);
  });
  const free = new Uint8Array(n).fill(1);
  for (const own of heldNodes) for (const p of own) free[p] = 0;
  const probes = (input.probes ?? []).map((p, i) => {
    const faces = boundaryFaceList(mesh, p.faces);
    if (!faces.length) throw new ElasticError('empty-target', `probe ${i} is on no face`);
    return faces;
  });

  // Matrices on one pattern: conduction K, capacity C, and ∫ N_a N_b dA of each convection.
  const K = assembleConduction(mesh, k);
  const pattern = K.pattern;
  const C = new CsrMatrix(pattern);
  const rc = density * specificHeat;
  const ce = new Float64Array(npe * npe);
  // VS11d-3: exact by default (C full rank); on a Host and its replay the conduction's own rule, as
  // CalculiX integrates its capacity, so both solve the same equations. Either way the row sums
  // (the stored energy) stay exact.
  const capacityRule = input.capacityRule ?? (input.replay ? 'conduction' : 'exact');
  const rule: readonly (readonly [number, number, number, number])[] =
    capacityRule === 'exact'
      ? tetRule
      : mesh.type === 'tet4'
        ? [[0.25, 0.25, 0.25, 1 / 6]]
        : gaussPoints.map(([x, y, z]) => [x, y, z, gaussWeight] as const);
  for (let e = 0; e < m; e++) {
    ce.fill(0);
    for (const [x, y, z, w] of rule) {
      const dV = detAt(mesh, e, npe, [x, y, z]) * w * rc;
      const N = shapeValues(mesh.type, x, y, z);
      for (let a = 0; a < npe; a++)
        for (let b = 0; b < npe; b++) ce[a * npe + b]! += N[a]! * N[b]! * dV;
    }
    const nodes = mesh.elements.subarray(e * npe, (e + 1) * npe);
    for (let a = 0; a < npe; a++)
      for (let b = 0; b < npe; b++) C.add(nodes[a]!, nodes[b]!, ce[a * npe + b]!);
  }
  const capacity = new Float64Array(n); // row sums: 1ᵀ C T is the stored energy
  for (let i = 0; i < n; i++)
    for (let q = pattern.rowPtr[i]!; q < pattern.rowPtr[i + 1]!; q++) capacity[i]! += C.values[q]!;

  return {
    mesh,
    conditions,
    end,
    step,
    theta,
    steps,
    every,
    n,
    replay,
    newtonLimit,
    newtonTolerance,
    T0,
    faceSets,
    heldNodes,
    constrainedNodes,
    free,
    probes,
    K,
    pattern,
    C,
    capacity,
  };
}

export function solveTransientThermal(input: TransientInput): TransientResult {
  const {
    mesh,
    conditions,
    end,
    step,
    theta,
    steps,
    every,
    n,
    replay,
    newtonLimit,
    newtonTolerance,
    T0,
    faceSets,
    heldNodes,
    constrainedNodes,
    free,
    probes,
    K,
    pattern,
    C,
    capacity,
  } = transientSetup(input);
  // Face quadrature, once: nodes, N at each point and dA.
  type FacePoints = { nodes: number[]; points: { N: number[]; dA: number }[] };
  const facePoints = (list: { e: number; lf: number }[]): FacePoints[] =>
    list.map(({ e, lf }) => {
      const { nodes, points } = boundaryFacePoints(mesh, e, lf);
      return { nodes, points: points.map(({ N, normal }) => ({ N, dA: Math.hypot(...normal) })) };
    });
  const faceQuad = faceSets.map(facePoints);
  const conditionAreas = faceQuad.map((fs) =>
    fs.reduce((s, f) => s + f.points.reduce((t, p) => t + p.dA, 0), 0),
  );
  const probeQuad = probes.map(facePoints);
  const probeAreas = probeQuad.map((fs) =>
    fs.reduce((s, f) => s + f.points.reduce((t, p) => t + p.dA, 0), 0),
  );
  const unitFilm = conditions.map((c, ci) => {
    if (c.kind !== 'convection') return null;
    const H = new CsrMatrix(pattern);
    const q = new Float64Array(n);
    for (const { nodes, points } of faceQuad[ci]!)
      for (const { N, dA } of points)
        N.forEach((na, a) => {
          q[nodes[a]!]! += na * dA;
          N.forEach((nb, b) => H.add(nodes[a]!, nodes[b]!, na * nb * dA));
        });
    return { H, q };
  });
  const unitFlux = conditions.map((c, ci) => {
    if (c.kind !== 'heat-flux') return null;
    const q = new Float64Array(n);
    for (const { nodes, points } of faceQuad[ci]!)
      for (const { N, dA } of points) N.forEach((na, a) => (q[nodes[a]!]! += na * dA));
    return q;
  });
  // VS11b: one enclosure from every enclosure condition; a face may radiate by one condition only.
  const radiantFaces = new Map<number, number>();
  conditions.forEach((c, ci) => {
    if (c.kind !== 'radiation' && c.kind !== 'enclosure') return;
    for (const f of c.faces) {
      const before = radiantFaces.get(f);
      if (before !== undefined && before !== ci)
        throw new ElasticError(
          'constraint-conflict',
          `face ${f} radiates by conditions ${before} and ${ci}`,
        );
      radiantFaces.set(f, ci);
    }
  });
  const enclosed = conditions.flatMap((c, ci) => (c.kind === 'enclosure' ? [ci] : []));
  let vf: ViewFactors | undefined;
  let patchCondition: Int32Array | undefined;
  let patchEmissivity: Float64Array | undefined;
  let enclosureAmbient = 0;
  if (enclosed.length) {
    const setup = input.enclosure;
    if (!setup) throw new ElasticError('material', 'an enclosure condition needs `enclosure`');
    if (!(setup.ambient >= 0) || !Number.isFinite(setup.ambient))
      throw new ElasticError('material', 'enclosure ambient ≥ 0 K');
    enclosureAmbient = setup.ambient;
    const faces = [...new Set(enclosed.flatMap((ci) => conditions[ci]!.faces))].sort(
      (a, b) => a - b,
    );
    vf = viewFactors(mesh, faces, setup.raysPerPatch, setup.limits);
    patchCondition = new Int32Array(vf.patches.length).map(
      (_, i) => radiantFaces.get(vf!.patches[i]!.face)!,
    );
    patchEmissivity = new Float64Array(vf.patches.length).map(
      (_, i) => (conditions[patchCondition![i]!] as { emissivity: number }).emissivity,
    );
  }
  const patchTemperatures = (T: Float64Array) =>
    vf!.patches.map(
      (p) => p.nodes.reduce((s, node, a) => s + p.weights[a]! * T[node]!, 0) / p.area,
    );
  const radiating = conditions.some((c) => c.kind === 'radiation' || c.kind === 'enclosure');

  /**
   * F(t, T) = K T + Σ h f (H T − T∞ q) − Σ q f − Σ ∫ ε σ (T∞⁴ − T⁴) N dA, and the heat each
   * non-held condition puts in at (t, T) (mW).
   */
  const nnz = pattern.cols.length;
  const forces = (t: number, T: Float64Array) => {
    const F = K.multiply(T);
    const heat = conditions.map(() => 0);
    conditions.forEach((c, ci) => {
      if (c.kind === 'heat-flux') {
        const f = c.flux * amplitudeAt(c.amplitude, t);
        const q = unitFlux[ci]!;
        for (let p = 0; p < n; p++) F[p]! -= f * q[p]!;
        heat[ci] = f * conditionAreas[ci]!;
      } else if (c.kind === 'convection') {
        const h = c.coefficient * amplitudeAt(c.amplitude, t);
        const { H, q } = unitFilm[ci]!;
        const HT = H.multiply(T);
        let into = 0;
        for (let p = 0; p < n; p++) {
          const flow = h * (c.ambient * q[p]! - HT[p]!);
          F[p]! -= flow;
          into += flow;
        }
        heat[ci] = into;
      } else if (c.kind === 'radiation') {
        const a4 = c.ambient ** 4;
        const es = c.emissivity * stefanBoltzmann;
        for (const { nodes, points } of faceQuad[ci]!)
          for (const { N, dA } of points) {
            let th = 0;
            N.forEach((na, a) => (th += na * T[nodes[a]!]!));
            const flow = es * (a4 - th ** 4) * dA;
            heat[ci]! += flow;
            N.forEach((na, a) => (F[nodes[a]!]! -= na * flow));
          }
      }
    });
    if (vf) {
      const Tp = patchTemperatures(T);
      const { flux, converged: ok } = radiosityFlux(
        vf,
        Tp,
        patchEmissivity!,
        enclosureAmbient,
        stefanBoltzmann,
      );
      if (!ok) radiosityFailed = true;
      vf.patches.forEach((p, i) => {
        heat[patchCondition![i]!]! += flux[i]! * p.area;
        p.nodes.forEach((node, a) => (F[node]! -= flux[i]! * p.weights[a]!));
      });
    }
    return { F, heat };
  };
  let radiosityFailed = false;
  const heldAt = (t: number, T: Float64Array) => {
    conditions.forEach((c, ci) => {
      if (c.kind !== 'temperature') return;
      const v = c.temperature * amplitudeAt(c.amplitude, t);
      for (const p of heldNodes[ci]!) T[p] = v;
    });
  };

  let T = typeof T0 === 'number' ? new Float64Array(n).fill(T0) : Float64Array.from(T0);
  heldAt(0, T);
  const energy = (x: Float64Array) => {
    let s = 0;
    for (let p = 0; p < n; p++) s += capacity[p]! * x[p]!;
    return s;
  };
  const E0 = energy(T);
  const probeMean = (pi: number, x: Float64Array) => {
    let s = 0;
    for (const { nodes, points } of probeQuad[pi]!)
      for (const { N, dA } of points) N.forEach((na, a) => (s += na * x[nodes[a]!]! * dA));
    return s / probeAreas[pi]!;
  };

  const history = {
    time: new Float64Array(steps + 1),
    maxTemperature: new Float64Array(steps + 1),
    minTemperature: new Float64Array(steps + 1),
    stored: new Float64Array(steps + 1),
    heatIn: new Float64Array(steps + 1),
    probes: probes.map(() => new Float64Array(steps + 1)),
  };
  const record = (s: number, t: number, x: Float64Array, heatIn: number) => {
    let lo = Infinity,
      hi = -Infinity;
    for (let p = 0; p < n; p++) {
      lo = Math.min(lo, x[p]!);
      hi = Math.max(hi, x[p]!);
    }
    history.time[s] = t;
    history.maxTemperature[s] = hi;
    history.minTemperature[s] = lo;
    history.stored[s] = energy(x) - E0;
    history.heatIn[s] = heatIn;
    probes.forEach((_, pi) => (history.probes[pi]![s] = probeMean(pi, x)));
  };
  record(0, 0, T, 0);
  const times = [0];
  const temperatures = [T.slice()];
  const conditionHeat = conditions.map(() => 0);
  let conditionPower = conditions.map(() => 0);

  let old = forces(0, T);
  let heatIn = 0;
  let balance = 0;
  let energyScale = 0;
  let iterations = 0;
  let newtonMost = 0;
  let worstResidual = 0;
  let converged = true;
  const J = new CsrMatrix(pattern);
  let tPrev = 0;
  let replayWorst = 0;
  let replayScale = 0;
  for (let s = 1; s <= steps; s++) {
    const t = s === steps ? end : s * step;
    const dt = t - tPrev;
    const next = replay ? Float64Array.from(replay[s - 1]!) : T.slice();
    if (replay)
      // A replayed field must hold what the conditions hold, to the `.frd`'s rounding.
      conditions.forEach((c, ci) => {
        if (c.kind !== 'temperature') return;
        const v = c.temperature * amplitudeAt(c.amplitude, t);
        for (const p of heldNodes[ci]!)
          if (Math.abs(next[p]! - v) > frdRounding * Math.max(Math.abs(v), 1))
            throw new ElasticError(
              'material',
              `replay step ${s}: node ${p} is at ${next[p]} K, held at ${v} K`,
            );
      });
    heldAt(t, next);
    // Film matrices at t (they do not depend on T).
    const film = new Float64Array(nnz);
    conditions.forEach((c, ci) => {
      if (c.kind !== 'convection') return;
      const h = c.coefficient * amplitudeAt(c.amplitude, t);
      const H = unitFilm[ci]!.H.values;
      for (let q = 0; q < nnz; q++) film[q]! += h * H[q]!;
    });
    let cur = forces(t, next);
    let newton = 0;
    if (replay) {
      // Not solved: how far the given field is from solving this step.
      const dT = new Float64Array(n);
      for (let p = 0; p < n; p++) dT[p] = next[p]! - T[p]!;
      const CdT = C.multiply(dT);
      const KT = K.multiply(next);
      // What the `.frd`'s rounding of the field alone can leave in each row:
      // ε (|C| (|T| + |Tⁿ|)/Δt + θ |K + H| |T| + (1 − θ) |K + Hⁿ| |Tⁿ|), films H included.
      const allow = new Float64Array(n);
      for (let p = 0; p < n; p++) {
        if (!free[p]) continue;
        let a = 0;
        for (let q = pattern.rowPtr[p]!; q < pattern.rowPtr[p + 1]!; q++) {
          const j = pattern.cols[q]!;
          const now = Math.abs(next[j]!);
          const was = Math.abs(T[j]!);
          a +=
            (Math.abs(C.values[q]!) * (now + was)) / dt +
            Math.abs(K.values[q]! + film[q]!) * (now + was);
        }
        allow[p] = frdRounding * a;
      }
      // Radiation to the surroundings: the rounding moves ε σ T⁴ by at most 4 ε σ T⁴ times it
      // (Codex on #1272). The Host takes no enclosure, so that part is not replayed.
      conditions.forEach((c, ci) => {
        if (c.kind !== 'radiation') return;
        const es4 = 4 * c.emissivity * stefanBoltzmann * frdRounding;
        for (const { nodes, points } of faceQuad[ci]!)
          for (const { N, dA } of points) {
            let now = 0;
            let was = 0;
            N.forEach((na, k) => {
              now += na * next[nodes[k]!]!;
              was += na * T[nodes[k]!]!;
            });
            const g = es4 * (now ** 4 + was ** 4) * dA;
            N.forEach((na, k) => (allow[nodes[k]!]! += Math.abs(na) * g));
          }
      });
      for (let p = 0; p < n; p++) {
        if (!free[p]) continue;
        const r = CdT[p]! / dt + theta * cur.F[p]! + (1 - theta) * old.F[p]!;
        replayWorst = Math.max(replayWorst, Math.abs(r) - allow[p]!);
        replayScale = Math.max(
          replayScale,
          Math.abs(CdT[p]! / dt),
          Math.abs(KT[p]!),
          Math.abs(cur.F[p]! - KT[p]!),
        );
      }
    }
    for (; !replay; ) {
      newton++;
      // R = C (T − Tⁿ)/Δt + θ F(t, T) + (1 − θ) F(tⁿ, Tⁿ)
      const dT = new Float64Array(n);
      for (let p = 0; p < n; p++) dT[p] = next[p]! - T[p]!;
      const CdT = C.multiply(dT);
      const b = new Float64Array(n);
      for (let p = 0; p < n; p++)
        b[p] = free[p] ? -(CdT[p]! / dt + theta * cur.F[p]! + (1 - theta) * old.F[p]!) : 0;
      for (let q = 0; q < nnz; q++)
        J.values[q] = C.values[q]! / dt + theta * (K.values[q]! + film[q]!);
      if (radiating)
        conditions.forEach((c, ci) => {
          if (c.kind !== 'radiation') return;
          const es4 = 4 * c.emissivity * stefanBoltzmann * theta;
          for (const { nodes, points } of faceQuad[ci]!)
            for (const { N, dA } of points) {
              let th = 0;
              N.forEach((na, a) => (th += na * next[nodes[a]!]!));
              const g = es4 * th ** 3 * dA;
              N.forEach((na, a) =>
                N.forEach((nb, bb) => J.add(nodes[a]!, nodes[bb]!, g * na * nb)),
              );
            }
        });
      if (vf) {
        // The self part of each patch's emission, −4 ε σ T³, as the tangent (the exchange with the
        // other patches is left to the iterations).
        const Tp = patchTemperatures(next);
        vf.patches.forEach((p, i) => {
          const g = (4 * patchEmissivity![i]! * stefanBoltzmann * theta * Tp[i]! ** 3) / p.area;
          p.nodes.forEach((na, a) =>
            p.nodes.forEach((nb, bb) => J.add(na, nb, g * p.weights[a]! * p.weights[bb]!)),
          );
        });
      }
      const solved = pcg(J, b, free, input.solver.tolerance, input.solver.maxIterations);
      iterations += solved.iterations;
      worstResidual = Math.max(worstResidual, solved.residual);
      if (!solved.converged) converged = false;
      let change = 0;
      for (let p = 0; p < n; p++)
        if (free[p]) {
          next[p]! += solved.x[p]!;
          change = Math.max(change, Math.abs(solved.x[p]!));
        }
      cur = forces(t, next);
      if (!radiating || change <= newtonTolerance) break;
      if (newton >= newtonLimit) {
        converged = false;
        break;
      }
    }
    newtonMost = Math.max(newtonMost, newton);

    // Heat over the step: the conditions (θ-weighted) and the held nodes' reactions.
    const dT = new Float64Array(n);
    for (let p = 0; p < n; p++) dT[p] = next[p]! - T[p]!;
    const CdT = C.multiply(dT);
    const stepHeat = conditions.map(() => 0);
    conditions.forEach((c, ci) => {
      if (c.kind === 'temperature') {
        let r = 0;
        for (const p of heldNodes[ci]!)
          r += CdT[p]! / dt + theta * cur.F[p]! + (1 - theta) * old.F[p]!;
        stepHeat[ci] = r * dt;
        conditionHeat[ci]! += r * dt;
        heatIn += r * dt;
      } else {
        const h = (theta * cur.heat[ci]! + (1 - theta) * old.heat[ci]!) * dt;
        stepHeat[ci] = h;
        conditionHeat[ci]! += h;
        heatIn += h;
      }
    });
    conditionPower = stepHeat.map((h) => h / dt);
    T = next;
    old = cur;
    tPrev = t;
    record(s, t, T, heatIn);
    energyScale = Math.max(
      energyScale,
      Math.abs(history.stored[s]!),
      ...conditionHeat.map(Math.abs),
    );
    balance = Math.max(balance, Math.abs(history.stored[s]! - heatIn));
    if (s % every === 0 || s === steps) {
      times.push(t);
      temperatures.push(T.slice());
    }
  }
  return {
    times,
    temperatures,
    history,
    conditionHeat,
    conditionAreas,
    probeAreas,
    constrainedNodes,
    balance,
    energyScale,
    iterations,
    newtonIterations: newtonMost,
    residual: worstResidual,
    converged: converged && !radiosityFailed,
    conditionPower,
    heatCapacity: capacity.reduce((a, b) => a + b, 0),
    ...(vf ? { viewFactors: vf } : {}),
    ...(replay ? { replayResidual: Math.max(0, replayWorst) / Math.max(replayScale, 1e-300) } : {}),
  };
}

/** Two held temperatures agree at every time when their values and amplitudes give the same. */
function sameHeld(
  a: Extract<TransientCondition, { kind: 'temperature' }>,
  b: Extract<TransientCondition, { kind: 'temperature' }>,
  end: number,
): boolean {
  // Both are linear between their breakpoints, so agreeing at the ends and at every breakpoint
  // inside the run means agreeing throughout it; points outside [0, end] do not matter.
  const inside = (x: Amplitude | undefined) => (x?.times ?? []).filter((t) => t > 0 && t < end);
  const ts = new Set([0, end, ...inside(a.amplitude), ...inside(b.amplitude)]);
  for (const t of ts) {
    const va = a.temperature * amplitudeAt(a.amplitude, t);
    const vb = b.temperature * amplitudeAt(b.amplitude, t);
    if (va !== vb) return false;
  }
  return true;
}

/**
 * VS11d-3: the CalculiX model of a transient input (`writeCalculixHeat`), solving the same
 * equations as `solveTransientThermal` with θ = 1: the held nodes of each temperature condition,
 * the face conditions on their element faces, the start with the held values at t = 0, and the
 * capacity coupling of a held temperature that changes, C_fh (T_hⁿ⁺¹ − T_hⁿ)/Δt, which CalculiX
 * leaves out, given back as nodal heats on the free nodes next to it with one amplitude value per
 * step. Radiation between faces (`enclosure`) is the browser's only.
 */
export function transientCalculixModel(input: TransientInput): CalculixHeatModel {
  if (input.time.theta !== 1)
    throw new ElasticError('material', 'CalculiX steps backward Euler: θ must be 1');
  if (input.conditions.some((c) => c.kind === 'enclosure'))
    throw new ElasticError('material', 'radiation between faces is solved in the browser only');
  const { mesh, conditions, end, step, steps, n, T0, faceSets, heldNodes, free, C, pattern } =
    transientSetup({ ...input, replay: undefined, capacityRule: 'conduction' });
  const amplitudes: Amplitude[] = [];
  const named = (a: Amplitude | undefined) => {
    if (!a) return undefined;
    amplitudes.push(a);
    return amplitudes.length - 1;
  };
  const times = Array.from({ length: steps }, (_, s) => (s + 1 === steps ? end : (s + 1) * step));
  const initial = typeof T0 === 'number' ? new Float64Array(n).fill(T0) : Float64Array.from(T0);
  const holds: CalculixHeatModel['holds'][number][] = [];
  const faces: CalculixHeatFace[] = [];
  const nodal: NonNullable<CalculixHeatModel['nodal']>[number][] = [];
  // The capacity coupling of each ramped hold, per free node: its weight Σ_h C_fh T and its rate.
  const coupling = new Map<number, { heat: number; rate: number[] }[]>();
  // The flux and film conditions on each element face, `kind element face` → condition indices.
  const onFace = new Map<string, number[]>();
  conditions.forEach((c, ci) => {
    if (c.kind === 'temperature') {
      const nodes = heldNodes[ci]!;
      for (const p of nodes) initial[p] = c.temperature * amplitudeAt(c.amplitude, 0);
      const a = named(c.amplitude);
      holds.push({
        nodes,
        temperature: c.temperature,
        ...(a === undefined ? {} : { amplitude: a }),
      });
      if (!c.amplitude) return;
      // The held value's change over each step, per kelvin of the condition's temperature.
      let before = amplitudeAt(c.amplitude, 0);
      let tPrev = 0;
      const rate = times.map((t) => {
        const now = amplitudeAt(c.amplitude, t);
        const r = (now - before) / (t - tPrev);
        before = now;
        tPrev = t;
        return r;
      });
      if (rate.every((r) => r === 0)) return;
      const held = new Uint8Array(n);
      for (const p of nodes) held[p] = 1;
      const g = new Map<number, number>();
      for (let p = 0; p < n; p++) {
        if (!free[p]) continue;
        let sum = 0;
        for (let q = pattern.rowPtr[p]!; q < pattern.rowPtr[p + 1]!; q++)
          if (held[pattern.cols[q]!]) sum += C.values[q]!;
        if (sum !== 0) g.set(p, sum);
      }
      for (const [p, sum] of g) {
        const list = coupling.get(p) ?? [];
        list.push({ heat: -sum * c.temperature, rate });
        coupling.set(p, list);
      }
      return;
    }
    if (c.kind === 'enclosure') return;
    for (const { e, lf } of faceSets[ci]!) {
      if (c.kind === 'radiation')
        faces.push({
          kind: 'radiation',
          element: e,
          face: lf,
          emissivity: c.emissivity,
          ambient: c.ambient,
        });
      else {
        const key = `${c.kind === 'heat-flux' ? 'flux' : 'film'} ${e} ${lf}`;
        const list = onFace.get(key) ?? [];
        list.push(ci);
        onFace.set(key, list);
      }
    }
  });
  // One flux and one film per element face: a second record on the same face would replace the
  // first's amplitude (Codex on #1272). A face under one condition shares that condition's
  // amplitude; one under several gets the sum of their histories, once per set of conditions.
  const conditionAmplitude = new Map<number, number | undefined>();
  const setAmplitude = new Map<string, { magnitude: number; amplitude: number | undefined }>();
  const amplitudeOf = (ci: number) => {
    const c = conditions[ci]!;
    return c.kind === 'heat-flux' || c.kind === 'convection' ? c.amplitude : undefined;
  };
  const magnitudeOf = (ci: number) => {
    const c = conditions[ci]!;
    return c.kind === 'heat-flux' ? c.flux : c.kind === 'convection' ? c.coefficient : 0;
  };
  for (const [key, list] of onFace) {
    const [kind, eText, lfText] = key.split(' ');
    const e = Number(eText);
    const lf = Number(lfText);
    let magnitude: number;
    let amplitude: number | undefined;
    if (list.length === 1) {
      const ci = list[0]!;
      if (!conditionAmplitude.has(ci)) conditionAmplitude.set(ci, named(amplitudeOf(ci)));
      magnitude = magnitudeOf(ci);
      amplitude = conditionAmplitude.get(ci);
    } else {
      const id = list.join(',');
      let set = setAmplitude.get(id);
      if (!set) {
        if (kind === 'film') {
          const ambients = new Set(
            list.map((ci) => {
              const c = conditions[ci]!;
              return c.kind === 'convection' ? c.ambient : NaN;
            }),
          );
          if (ambients.size > 1)
            throw new ElasticError(
              'material',
              `films to different surroundings on one face (element ${e}) are solved in the browser only`,
            );
        }
        // The sum is piecewise linear between the conditions' own times (held outside them).
        const at = [
          ...new Set([0, end, ...list.flatMap((ci) => amplitudeOf(ci)?.times ?? [])]),
        ].sort((x, y) => x - y);
        const sum = at.map((t) =>
          list.reduce((v, ci) => v + magnitudeOf(ci) * amplitudeAt(amplitudeOf(ci), t), 0),
        );
        const top = Math.max(...sum.map(Math.abs));
        set =
          top === 0
            ? { magnitude: 0, amplitude: undefined }
            : { magnitude: top, amplitude: named({ times: at, factors: sum.map((v) => v / top) }) };
        setAmplitude.set(id, set);
      }
      ({ magnitude, amplitude } = set);
      if (magnitude === 0) continue;
    }
    const a = amplitude === undefined ? {} : { amplitude };
    if (kind === 'flux') faces.push({ kind: 'flux', element: e, face: lf, flux: magnitude, ...a });
    else {
      const c = conditions[list[0]!]!;
      faces.push({
        kind: 'film',
        element: e,
        face: lf,
        coefficient: magnitude,
        ambient: c.kind === 'convection' ? c.ambient : 0,
        ...a,
      });
    }
  }
  // One CFLUX per node (a second on the same node and degree of freedom would replace the first):
  // a node next to one ramped hold shares that hold's rate; one next to several sums them.
  const shared = new Map<number[], number>();
  for (const [p, list] of coupling) {
    if (list.length === 1) {
      const { heat, rate } = list[0]!;
      let r = shared.get(rate);
      if (r === undefined) {
        r = named({ times: [0, ...times], factors: [rate[0]!, ...rate] })!;
        shared.set(rate, r);
      }
      nodal.push({ node: p, heat, amplitude: r });
      continue;
    }
    const sum = times.map((_, s) => list.reduce((acc, { heat, rate }) => acc + heat * rate[s]!, 0));
    const scale = Math.max(...sum.map(Math.abs));
    if (!(scale > 0)) continue;
    const factors = sum.map((v) => v / scale);
    const r = named({ times: [0, ...times], factors: [factors[0]!, ...factors] })!;
    nodal.push({ node: p, heat: scale, amplitude: r });
  }
  if (mesh.type !== 'tet4' && mesh.type !== 'tet10')
    throw new ElasticError(
      'material',
      `CalculiX heat transfer takes tet4 or tet10, not ${mesh.type}`,
    );
  return {
    nodes: mesh.nodes,
    type: mesh.type,
    elements: mesh.elements,
    material: input.material,
    initialTemperature: initial,
    time: { end, step },
    amplitudes,
    holds,
    faces,
    nodal,
  };
}
