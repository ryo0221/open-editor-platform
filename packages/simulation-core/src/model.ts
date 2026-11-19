import type { CadTopologyRef } from '@editor-platform/cad-core';

/** x, y, z. */
export type Vec3 = [number, number, number];

/**
 * A face or an edge of the source body, by its F1 reference on the body's result feature in the
 * source version (docs/cad/r3-analysis.md, TargetRef). Evaluation resolves it; the document only
 * stores it.
 */
export interface SimulationTarget {
  kind: 'face' | 'edge';
  ref: CadTopologyRef;
  /**
   * R3j-2 (schema 2, docs/cad/r3-analysis.md A4): the body the face or edge is on, one of
   * `bodies`; absent, the source body (`source.bodyId`), as every schema 1 target is.
   */
  body?: string;
}

/** Linear elastic, isotropic. E and stresses in MPa, density in t/mm³ (mm–N–MPa–t–s). */
export interface SimulationMaterial {
  id: string;
  name: string;
  model: 'linear-elastic-isotropic';
  youngsModulus: number;
  poissonsRatio: number;
  density: number;
  /**
   * R3h: thermal conductivity in mW/(mm·K), the same number as W/(m·K) (power is mW in
   * mm–N–MPa–t–s). Needed by a thermal study only.
   */
  conductivity?: number;
  /**
   * VS7b (docs/cad/vehicle-simulation.md, VS5・VS7): J2 plasticity for a crash study, as the
   * explicit solver's: the flow stress (MPa) against the equivalent plastic strain, piecewise
   * linear from strain 0 (the yield stress) and flat past the last point; Cowper–Symonds
   * (C in 1/s, p) and the strain at which a shell is erased, when given. Without it a crash study
   * is refused (an elastic car only springs back).
   */
  plasticity?: SimulationPlasticity;
  /**
   * VS11d (docs/cad/vehicle-simulation.md): specific heat in mm²/(s²·K) (1 J/(kg·K) = 10⁶; steel
   * 460 J/(kg·K) is 4.6e8). Needed by a transient thermal study only.
   */
  specificHeat?: number;
  /** VS11d: linear thermal expansion (1/K, steel 1.2e-5), for a transient study's thermal stress. */
  expansion?: number;
}
export interface SimulationPlasticity {
  strain: number[];
  stress: number[];
  cowperSymonds?: { C: number; p: number };
  failureStrain?: number;
}

/**
 * VS11d: a factor over time (s), linear between the points and held at the ends (CalculiX
 * `*AMPLITUDE`). Times strictly increase; at most `simulationLimits.amplitudePoints` points.
 */
export interface SimulationAmplitude {
  times: number[];
  factors: number[];
}

export type SimulationLoad =
  /** A total force (N) spread over the targets by area (faces) or length (edges). */
  | { id: string; name: string; kind: 'force'; targets: SimulationTarget[]; force: Vec3 }
  /** A pressure (MPa) on faces; positive pushes into the body along the inward normal. */
  | { id: string; name: string; kind: 'pressure'; targets: SimulationTarget[]; pressure: number }
  /** An acceleration of the whole body (mm/s²), e.g. [0, 0, -9806.65]. */
  | { id: string; name: string; kind: 'gravity'; acceleration: Vec3 }
  /** R3h: heat into the body through faces, mW/mm² (= kW/m²); negative takes heat out. */
  | {
      id: string;
      name: string;
      kind: 'heat-flux';
      targets: SimulationTarget[];
      flux: number;
      /** VS11d: the flux over time (a transient study only). */
      amplitude?: SimulationAmplitude;
    }
  /**
   * R3h: convection h (T∞ − T) into the body on faces: h in mW/(mm²·K) (= kW/(m²·K)), the
   * ambient T∞ in K.
   */
  | {
      id: string;
      name: string;
      kind: 'convection';
      targets: SimulationTarget[];
      coefficient: number;
      ambient: number;
      /** VS11d: the film coefficient over time (a transient study only). */
      amplitude?: SimulationAmplitude;
    }
  /** VS11d: gray radiation ε σ (T∞⁴ − T⁴) from surroundings at T∞ (K), a transient study only. */
  | {
      id: string;
      name: string;
      kind: 'radiation';
      targets: SimulationTarget[];
      emissivity: number;
      ambient: number;
    }
  /**
   * VS11d: faces that radiate to each other (gray, diffuse) and to the study's surroundings
   * (`transient.enclosure`); view factors by rays, blocked by any face between. Transient only.
   */
  | {
      id: string;
      name: string;
      kind: 'enclosure';
      targets: SimulationTarget[];
      emissivity: number;
    };
export type SimulationLoadKind = SimulationLoad['kind'];
/** R3h: the loads and constraints a thermal study takes; the others take the rest. */
export const thermalLoadKinds: readonly SimulationLoadKind[] = Object.freeze([
  'heat-flux',
  'convection',
]);
export const thermalConstraintKinds: readonly SimulationConstraintKind[] = Object.freeze([
  'temperature',
]);
/** VS11d: the loads a transient thermal study takes (the steady one takes `thermalLoadKinds`). */
export const transientLoadKinds: readonly SimulationLoadKind[] = Object.freeze([
  'heat-flux',
  'convection',
  'radiation',
  'enclosure',
]);
/**
 * VS11d: the structural constraints a transient study with thermal stress holds its body by (its
 * temperatures are `thermalConstraintKinds`).
 */
export const thermalStressConstraintKinds: readonly SimulationConstraintKind[] = Object.freeze([
  'fixed',
  'roller',
  'displacement',
]);

export type SimulationConstraint =
  /** Every displacement of the targets is zero. */
  | { id: string; name: string; kind: 'fixed'; targets: SimulationTarget[] }
  /** Only the displacement along a planar face's normal is zero (a symmetry plane). */
  | { id: string; name: string; kind: 'roller'; targets: SimulationTarget[] }
  /**
   * R3i-4: every displacement is zero and the rotations are free (a hinge or simple support of a
   * shell). A solid has no rotations: on a solid study it holds as `fixed` does.
   */
  | { id: string; name: string; kind: 'pinned'; targets: SimulationTarget[] }
  /** Given displacements (mm); a null component is free. */
  | {
      id: string;
      name: string;
      kind: 'displacement';
      targets: SimulationTarget[];
      displacement: [number | null, number | null, number | null];
    }
  /** R3h: a held temperature (K) on the targets. */
  | {
      id: string;
      name: string;
      kind: 'temperature';
      targets: SimulationTarget[];
      temperature: number;
      /** VS11d: the held temperature over time (a transient study only). */
      amplitude?: SimulationAmplitude;
    };
export type SimulationConstraintKind = SimulationConstraint['kind'];

/** Defeaturing and region splits (R3c); applied in this order before meshing. */
export interface SimulationPreparation {
  /** Cylindrical holes with a smaller diameter (mm) are removed; null keeps them all. */
  removeHolesBelow: number | null;
  /** Fillets with a smaller radius (mm) are removed; null keeps them all. */
  removeFilletsBelow: number | null;
  /** Faces removed explicitly. */
  removeFaces: SimulationTarget[];
}

export interface SimulationMeshSettings {
  order: 2;
  /** Target element size (mm), the smallest it may go, and growth between neighbours (≥ 1). */
  size: number;
  minSize: number;
  grading: number;
  /** A smaller size on faces or edges. */
  local: { target: SimulationTarget; size: number }[];
}

export type SimulationMetric =
  | 'max-displacement'
  | 'max-von-mises'
  | 'reaction-force'
  /** R3g: the lowest natural frequency (Hz) of a modal study. */
  | 'first-frequency'
  /** R3h: the highest temperature (K) and the largest heat flux (mW/mm²) of a thermal study. */
  | 'max-temperature'
  | 'max-heat-flux'
  /**
   * CR5c: a stiffness test's result (N·m/deg for torsion, N/mm for bending), measured on every
   * level of a static study with a `test` and only there.
   */
  | 'stiffness'
  /**
   * VS4a (docs/cad/vehicle-simulation.md): the force coefficients of a wind-tunnel study, on the
   * study's reference area and the air's dynamic pressure: drag along the wind, lift up, side
   * force across.
   */
  | 'drag-coefficient'
  | 'lift-coefficient'
  | 'side-force-coefficient'
  /**
   * VS7b: a crash study's measures at its accelerometer: the largest deceleration through CFC 60
   * (g), the occupant load criterion (g), the crush (mm, how far it moved on after the barrier
   * was first hit) and the largest intrusion of its pairs (mm, 0 without any).
   */
  | 'peak-deceleration'
  | 'occupant-load-criterion'
  | 'crush'
  | 'max-intrusion'
  /**
   * VS8b: a head impact's measures at the headform's centre: HIC15 and the peak resultant
   * acceleration (g), both from CFC 1000, and the dynamic deflection (mm, how far the centre went
   * on after the first touch).
   */
  | 'hic15'
  | 'head-peak-acceleration'
  | 'head-deflection'
  /**
   * VS9 (docs/cad/vehicle-simulation.md, V3): a seal study's smallest and largest compression
   * where its seals touch (shares of the free height), and the length of seal line that leaks
   * (mm): pressed less than the range, a gap past the threshold, no closure, or a break.
   */
  | 'min-compression'
  | 'max-compression'
  | 'leak-length'
  /**
   * VS10 (V3): a shower study's water that went in through the seals and the water left ponding
   * (mm³, each particle carrying the flow over the particles a second: a scale, not a prediction).
   */
  | 'entered-volume'
  | 'pond-volume';
export const simulationMetrics: readonly SimulationMetric[] = Object.freeze([
  'max-displacement',
  'max-von-mises',
  'reaction-force',
  'first-frequency',
  'max-temperature',
  'max-heat-flux',
  'stiffness',
  'drag-coefficient',
  'lift-coefficient',
  'side-force-coefficient',
  'peak-deceleration',
  'occupant-load-criterion',
  'crush',
  'max-intrusion',
  'hic15',
  'head-peak-acceleration',
  'head-deflection',
  'min-compression',
  'max-compression',
  'leak-length',
  'entered-volume',
  'pond-volume',
]);
export type SimulationStudyKind =
  | 'linear-static'
  | 'modal'
  | 'thermal'
  | 'aero'
  | 'transient-thermal'
  | 'seal'
  | 'shower'
  | 'crash';
/** The metrics a run of each kind of study measures on every level. */
export const studyMetrics: Readonly<Record<SimulationStudyKind, readonly SimulationMetric[]>> =
  Object.freeze({
    'linear-static': Object.freeze([
      'max-displacement',
      'max-von-mises',
      'reaction-force',
    ] as const),
    modal: Object.freeze(['first-frequency'] as const),
    thermal: Object.freeze(['max-temperature', 'max-heat-flux'] as const),
    // VS11d: the highest temperature over the run and the largest flux at its end; with thermal
    // stress a level may also record `max-von-mises` (at the end).
    'transient-thermal': Object.freeze(['max-temperature', 'max-heat-flux'] as const),
    aero: Object.freeze([
      'drag-coefficient',
      'lift-coefficient',
      'side-force-coefficient',
    ] as const),
    crash: Object.freeze([
      'peak-deceleration',
      'occupant-load-criterion',
      'crush',
      'max-intrusion',
    ] as const),
    seal: Object.freeze(['min-compression', 'max-compression', 'leak-length'] as const),
    shower: Object.freeze([
      'min-compression',
      'max-compression',
      'leak-length',
      'entered-volume',
      'pond-volume',
    ] as const),
  });
/** VS8b: a head impact (a crash study whose barrier is `head`) measures these instead. */
export const headImpactMetrics: readonly SimulationMetric[] = Object.freeze([
  'hic15',
  'head-peak-acceleration',
  'head-deflection',
] as const);
/** The metrics a run of this study measures on every level (a head impact's are its own). */
export function metricsOfStudy(study: {
  kind: SimulationStudyKind;
  crash?: { barrier: string };
}): readonly SimulationMetric[] {
  return study.kind === 'crash' && study.crash?.barrier === 'head'
    ? headImpactMetrics
    : studyMetrics[study.kind];
}

/** One analysis case: which loads and constraints, how it is solved and how convergence is judged. */
export type SimulationStudy =
  | SimulationStaticStudy
  | SimulationModalStudy
  | SimulationThermalStudy
  | SimulationAeroStudy
  | SimulationCrashStudy
  | SimulationTransientStudy
  | SimulationSealStudy
  | SimulationShowerStudy;
interface SimulationStudyBase {
  id: string;
  name: string;
  loadIds: string[];
  constraintIds: string[];
  /** Static: the PCG's relative residual. Modal: each mode's ‖Kφ − λMφ‖ / ‖Kφ‖. */
  solver: { tolerance: number; maxIterations: number };
  /** Mesh levels (each refines the size by 1/√2) and the metrics compared between the last two. */
  convergence: { levels: number; metrics: SimulationMetric[]; tolerance: number };
}
/**
 * R3i-4 (docs/cad/r3-analysis.md, A3): how a structural study models the body. `solid` (the
 * default when absent) meshes it with tetrahedra; `shell` with triangles on its midsurface, which
 * the body's thicken, shell or extrude must give (`midsurface-unsupported` otherwise).
 */
export type SimulationIdealisation = 'solid' | 'shell';
export interface SimulationStaticStudy extends SimulationStudyBase {
  kind: 'linear-static';
  idealisation?: SimulationIdealisation;
  /** CR5c: the stiffness test the study was made as; its result is summed up as that test's. */
  test?: SimulationStiffnessTest;
  /** VS13: stress-life fatigue of the result under a load history (a solid study only). */
  fatigue?: SimulationFatigue;
}
/**
 * VS13 (docs/cad/vehicle-simulation.md, VS13, VS-U7): the study's loads scale by `history` (one
 * pass, e.g. a road's input over a km); each node's signed von Mises stress over it is rainflow
 * counted, its cycles judged on a Basquin S-N line with Goodman's mean correction (`sn`, MPa)
 * and their damages summed (Miner). The result: damage per pass and passes to failure.
 */
export interface SimulationFatigue {
  /** Factor of the study's loads at each point; at most `simulationLimits.fatiguePoints`. */
  history: number[];
  sn: {
    /** Stress amplitude (MPa) lasting `cycles` cycles, fully reversed. */
    amplitude: number;
    cycles: number;
    /** Inverse slope m of log N against log S. */
    slope: number;
    /** Amplitude with no damage (MPa); 0 for none. */
    endurance: number;
    /** Tensile strength for the mean correction (MPa). */
    ultimate: number;
  };
}
/**
 * CR5c (docs/cad/car-design.md, S3・S4): what a stiffness test's result is summed from. A torsion
 * test drives two `displacement` constraints of the study in opposite directions (`left`,
 * `right`): the reactions' moment about the axis between them over the twist angle. A bending
 * test pushes one `force` load of the study (`load`): its force over the faces' mean deflection.
 */
export type SimulationStiffnessTest =
  | { kind: 'torsion'; left: string; right: string }
  | { kind: 'bending'; load: string };
/**
 * R3g: natural frequencies and mode shapes of the held body (docs/cad/r3-analysis.md 固有値).
 * Its constraints hold DOFs at 0 (a displacement constraint's other values are refused when it
 * runs); it has no loads. Thermal (R3h) comes later.
 */
export interface SimulationModalStudy extends SimulationStudyBase {
  kind: 'modal';
  /** How many of the lowest modes, 1 to `simulationLimits.modes`. */
  modes: number;
  idealisation?: SimulationIdealisation;
}
/**
 * R3h: steady heat conduction (docs/cad/r3-analysis.md 熱). Its loads are heat fluxes and
 * convections, its constraints held temperatures; it needs a held temperature or a convection.
 * The checks are those of a static run, `load` for each condition's area and `equilibrium` for the
 * heat balance.
 */
export interface SimulationThermalStudy extends SimulationStudyBase {
  kind: 'thermal';
}
/**
 * VS11d (docs/cad/vehicle-simulation.md, VS11): transient heat conduction of one solid body by the
 * θ-method (`geometry-fem` `solveTransientThermal`). Its loads are `transientLoadKinds`, its
 * constraints held temperatures and, with `transient.stress`, the structural constraints that hold
 * the body for the thermal stress of the last temperature field. Solved in the browser.
 */
export interface SimulationTransientStudy extends SimulationStudyBase {
  kind: 'transient-thermal';
  transient: SimulationTransientSettings;
}
export interface SimulationTransientSettings {
  /** s. */
  endS: number;
  stepS: number;
  /** 1 backward Euler … 0.5 Crank–Nicolson. */
  theta: number;
  /** K, the whole body at t = 0. */
  initialTemperature: number;
  /** The field is kept every this many steps (and at the end). */
  outputEvery: number;
  /** The surroundings (K) of the `enclosure` loads and the rays from each patch; null without. */
  enclosure: { ambient: number; raysPerPatch: number } | null;
  /** Thermal stress of the last field from the strain-free temperature (K); null without. */
  stress: { reference: number } | null;
}

/** VS11d: a new transient thermal study: 10 min in 10 s steps, backward Euler, from 293.15 K. */
export function transientStudy(id: string, name = 'Transient heat'): SimulationTransientStudy {
  return {
    id,
    name,
    kind: 'transient-thermal',
    loadIds: [],
    constraintIds: [],
    solver: { tolerance: 1e-8, maxIterations: 20_000 },
    convergence: { levels: 1, metrics: ['max-temperature'], tolerance: 0.05 },
    transient: {
      endS: 600,
      stepS: 10,
      theta: 1,
      initialTemperature: 293.15,
      outputEvery: 6,
      enclosure: null,
      stress: null,
    },
  };
}

/**
 * VS4a (docs/cad/vehicle-simulation.md, VS4): a wind tunnel around the source body and the other
 * analysed bodies (`bodies`), as one closed outside surface in the vehicle frame (x forward to the
 * nose, z up, the ground at z = 0). No loads, constraints or material. The browser runs it on the
 * LBM (`browserCellMm`, each convergence level × 1/√2); the Host on OpenFOAM (`host`). Its run is
 * always `reference` in V1: the numbers are not claimed to be right, only computed by the method
 * the Ahmed body checks (docs/verification/vehicle-sim). `solver.maxIterations` is the browser's
 * lattice steps on each level (the last fifth is averaged); `solver.tolerance` is not used by
 * the flow and keeps the structural range.
 */
export interface SimulationAeroStudy extends SimulationStudyBase {
  kind: 'aero';
  aero: SimulationAeroSettings;
}
export type SimulationAeroGround = 'moving' | 'fixed' | 'slip';
export interface SimulationAeroSettings {
  /** Air speed (m/s). */
  speed: number;
  /** Side-wind angle (degrees), positive with the air coming from the left (−y) side. */
  yawDeg: number;
  ground: SimulationAeroGround;
  /** The browser's lattice cell (mm) on the first convergence level. */
  browserCellMm: number;
  /** The Host's background cell (mm), refinement level on the body and SIMPLE iterations. */
  host: { baseMm: number; level: number; iterations: number };
  /** The coefficients' reference area (mm²); null for the bodies' frontal area. */
  referenceAreaMm2: number | null;
}

/**
 * VS7b (docs/cad/vehicle-simulation.md, VS7): a crash test of the analysed bodies as shells on
 * their midsurfaces (welded by the document's spot weld rows, with its added masses), run on the
 * explicit solver from its initial velocity until `endTimeMs`. The barrier is a full-width rigid
 * wall square to x ahead of the nose, or a vertical rigid pole on one side met at `pole.angleDeg`
 * to the long axis along the line through the point (`pole.xMm`, `pole.zMm`) on that side. The
 * vehicle frame is the analysis one (x from the tail to the nose, y left, z up). The measures are
 * read at the node nearest `accelerometer` (on the floor or the sill, away from the crush); each
 * intrusion is the displacement of the node nearest `point` relative to the one nearest
 * `reference`. No loads or constraints; the run is `reference` in V2. `solver.maxIterations` is
 * not used (the end time bounds the steps); `solver.tolerance` keeps the structural range.
 *
 * VS8b: the barrier `head` is a pedestrian head impact instead: the vehicle stands still (no
 * gravity, its nodes farther than `head.holdBeyondMm` from the target held, standing for the rest
 * of the car) and the UN GTR 9 headform comes in at `speedKmh` (40) along the line through
 * `head.targetMm` at `head.angleDeg` below the horizontal, travelling rearward. The measures are
 * the headform's (HIC15, peak acceleration, deflection); the accelerometer is not read.
 */
export interface SimulationCrashStudy extends SimulationStudyBase {
  kind: 'crash';
  crash: SimulationCrashSettings;
}
export type SimulationCrashBarrier = 'wall' | 'pole' | 'head';
export interface SimulationHeadImpact {
  headform: 'adult' | 'child';
  /** The aim point on the vehicle's outer surface (vehicle frame, mm). */
  targetMm: Vec3;
  /** Below the horizontal, over 0 and at most 90 (65 adult, 50 child). */
  angleDeg: number;
  /** Nodes farther than this from the target are held (mm); null holds none. */
  holdBeyondMm: number | null;
}
export interface SimulationCrashSettings {
  barrier: SimulationCrashBarrier;
  /** km/h */
  speedKmh: number;
  /** The pole's (null for a wall). */
  pole: {
    diameterMm: number;
    angleDeg: number;
    side: 'left' | 'right';
    xMm: number;
    zMm: number;
  } | null;
  gravity: boolean;
  /** Coulomb friction on the barrier and the ground, and between the shells. */
  friction: number;
  endTimeMs: number;
  accelerometer: Vec3;
  intrusions: { name: string; point: Vec3; reference: Vec3 }[];
  /** VS8b: the head impact's (only with the barrier `head`; absent or null otherwise). */
  head?: SimulationHeadImpact | null;
}

/**
 * VS9 (docs/cad/vehicle-simulation.md, V3): the document's seals (`seals`, or those of
 * `sealIds`) measured in the closed pose, each closure turned by its seal's hinge. No loads,
 * constraints or material; one level (the measure is geometric: `convergence.levels` is 1). Every
 * point along each line is rated against its section (`geometry-cfd` `measureSeal`); a point
 * leaks where the seal is pressed less than its range, where the gap past it is wider than
 * `gapThresholdMm`, where no closure is in reach, and along a break of the line. The run is
 * `reference`: the leak is a candidate place, not a predicted amount (the plan's VS-U5).
 * `solver` keeps the structural range and is not used.
 */
export interface SimulationSealStudy extends SimulationStudyBase {
  kind: 'seal';
  seal: SimulationSealSettings;
}
export interface SimulationSealSettings {
  /** The seals measured; empty for every seal of the document. */
  sealIds: string[];
  /** Spacing of the measured points along each line (mm). */
  stepMm: number;
  /** The widest gap that still holds water out (mm; the plan's 0.5). */
  gapThresholdMm: number;
}

/**
 * VS10 (docs/cad/vehicle-simulation.md, V3): water on the analysed bodies. The seals are measured
 * as a seal study does (`seal`), then rain and nozzles throw drops that run off the surfaces as
 * film (`geometry-cfd` `runShower`): a closed seal stops the film, a leaking stretch lets it in.
 * The ground slopes by `slopeDeg` (pitch: the +x end up, roll: the +y side up). One level; its
 * metrics are the seal's and the water that went in and ponded. The run is `reference` (VS-U5).
 */
export interface SimulationShowerStudy extends SimulationStudyBase {
  kind: 'shower';
  seal: SimulationSealSettings;
  shower: SimulationShowerSettings;
}
export interface SimulationShowerSettings {
  /**
   * Rain over the bodies' plan (with a margin) from above them: its rate (mm/h), its angle from
   * the vertical and the direction it blows to in plan (degrees from +x towards +y); null for none.
   */
  rain: { rateMmPerH: number; angleDeg: number; azimuthDeg: number } | null;
  nozzles: SimulationShowerNozzle[];
  /** The ground's slope (degrees): pitch lifts the +x end, roll the +y side. */
  slopeDeg: [number, number];
  /** Particles started a second over every emitter, the time simulated and its step (s). */
  particlesPerS: number;
  durationS: number;
  stepS: number;
  /** The emitters stop at this time (s), so the water left can run off. */
  emitUntilS: number;
  /** The film's speed down a vertical face (mm/s). */
  filmSpeedMmPerS: number;
  seed: number;
}
/** A nozzle: from `origin` along `direction`, in a cone of half angle `coneDeg`. */
export interface SimulationShowerNozzle {
  id: string;
  name: string;
  origin: Vec3;
  direction: Vec3;
  coneDeg: number;
  speedMmPerS: number;
  flowLPerMin: number;
}

/** VS10b: a new shower study over every seal: rain 50 mm/h straight down for 2 s, 2 s to run off. */
export function showerStudy(id: string, name = 'Shower'): SimulationShowerStudy {
  return {
    ...sealStudy(id, name),
    kind: 'shower',
    shower: {
      rain: { rateMmPerH: 50, angleDeg: 0, azimuthDeg: 0 },
      nozzles: [],
      slopeDeg: [0, 0],
      particlesPerS: 2000,
      durationS: 4,
      stepS: 0.004,
      emitUntilS: 2,
      filmSpeedMmPerS: 150,
      seed: 1,
    },
  };
}

/**
 * VS9: a seal's section: a hollow bulb of free height `diameterMm` (its size across the gap
 * before it is pressed), pressed within `compression` (shares of the free height, e.g. 0.3–0.5),
 * bending round no tighter than `minBendRadiusMm`.
 */
export interface SimulationSealSection {
  diameterMm: number;
  compression: [number, number];
  minBendRadiusMm: number;
}

/**
 * VS9 (docs/cad/vehicle-simulation.md, V3): a seal round an opening. It runs along the `line`
 * edges (an opening's flange, on one analysed body), `insetMm` into the `base` faces it sits on,
 * and stands along their outward normal against the `mating` faces of the closure (another
 * analysed body). The closure is modelled shut; `hinge` turns it about an axis (a door's hinge
 * line) by `angleDeg` before measuring: 0 is the shut pose, a positive angle opens it (right hand
 * about `axis`).
 */
export interface SimulationSeal {
  id: string;
  name: string;
  line: SimulationTarget[];
  base: SimulationTarget[];
  mating: SimulationTarget[];
  insetMm: number;
  section: SimulationSealSection;
  hinge?: { origin: Vec3; axis: Vec3; angleDeg: number };
}

/** VS9a: the section the seals start from: a 16 mm bulb pressed 30–50 %, bent no tighter than 10 mm. */
export const simulationSealSectionDefault: Readonly<SimulationSealSection> = Object.freeze({
  diameterMm: 16,
  compression: Object.freeze([0.3, 0.5]) as unknown as [number, number],
  minBendRadiusMm: 10,
});

/** VS9a: a new seal study over every seal: points every 5 mm, the plan's 0.5 mm gap threshold. */
export function sealStudy(id: string, name = 'Seals'): SimulationSealStudy {
  return {
    id,
    name,
    kind: 'seal',
    loadIds: [],
    constraintIds: [],
    solver: { tolerance: 1e-6, maxIterations: 1 },
    convergence: { levels: 1, metrics: [], tolerance: 0.05 },
    seal: { sealIds: [], stepMm: 5, gapThresholdMm: 0.5 },
  };
}

/**
 * The user's choice for one ambiguous target (docs/cad/r3-analysis.md, 選び直し): which of the
 * analysis-shape elements it became the target applies to. Analysis-shape indices are fixed by
 * the version, the preparation settings and the kernel build, so the choice applies to those only;
 * any change makes the target ambiguous again.
 */
export interface SimulationOverride {
  /** The load or constraint ID, or `preparation` / `mesh` for their settings' targets. */
  owner: string;
  target: SimulationTarget;
  versionId: string;
  preparationHash: string;
  kernelBuild: string;
  chosen: number[];
}

/**
 * The checks a run makes, by name (検査). A modal run checks `mass` (the mesh's mass against the
 * shape's) and `orthogonality` (of the mode shapes) instead of `load` and `equilibrium`.
 */
export type SimulationRunCheckName =
  | 'mapping'
  | 'load'
  | 'quality'
  | 'solver'
  | 'equilibrium'
  | 'mass'
  | 'orthogonality'
  /** VS4a: the wind-tunnel surface is closed (every edge on two triangles) and above the ground. */
  | 'surface'
  /**
   * VS7b: a crash run's explicit checks: the energy balance (within 5 %), the hourglass energy
   * (at most 10 % of the internal) and the mass added by mass scaling (reported).
   */
  | 'energy-balance'
  | 'hourglass-energy'
  | 'mass-scaling'
  /** VS13: a fatigue study's worst node, its damage per pass and life. */
  | 'fatigue'
  /** VS9: every seal's line, base and closure resolved and the line measured end to end. */
  | 'seal'
  /** VS10: the water's particles run to the end within their limits. */
  | 'shower';

/**
 * R3e-5c: a study's run as recorded (評価記録), one per study, the latest. It names its inputs
 * (the document without its records, the CAD version and the builds), so a later edit shows it as
 * out of date. The mesh and result assets are not kept yet: the result is exported as VTU.
 */
export interface SimulationRunRecord {
  id: string;
  studyId: string;
  inputs: {
    /** `simulationInputHash` of the document the run solved. */
    simulationHash: string;
    cadContentHash: string;
    kernelBuild: string;
    mesherBuild: string;
    solverBuild: string;
  };
  /** Each solved level, coarse first: its element size (mm), size and its kind's metrics. */
  levels: {
    size: number;
    nodes: number;
    elements: number;
    metrics: Partial<Record<SimulationMetric, number>>;
  }[];
  /** The finest level's checks. */
  checks: { name: SimulationRunCheckName; pass: boolean; detail: string }[];
  status: 'verified' | 'reference';
  reasons: string[];
}

/**
 * R3j-2: another body of the source version analysed with the source body, with its own material
 * and, optionally, its own idealisation (absent: the study's).
 */
export interface SimulationBody {
  bodyId: string;
  materialId: string | null;
  idealisation?: SimulationIdealisation;
}

/**
 * R3j-4 (schema 2): two bodies, or two parts of one, joined where they touch. Each node of the
 * `follower` faces or edges follows the `on` faces or edges under it (docs/cad/r3-analysis.md
 * A4-U3); one that lies farther than `tolerance` (mm) from them refuses the run. Each side is on
 * one body. A shell's side face (its rim) bonds through the midsurface edge it maps onto, and a
 * shell's wall face through its midsurface face; the tolerance is on the CAD faces, so the run
 * allows each shell side its half thickness more (its midsurface lies that far inside). Every
 * structural study solves every bond.
 */
export interface SimulationBond {
  id: string;
  name: string;
  follower: SimulationTarget[];
  on: SimulationTarget[];
  tolerance: number;
  /**
   * CR5f (docs/cad/car-design.md): a contact. Only the follower nodes within the tolerance of
   * `on` follow it and the others are free: a mount sitting on part of a panel's face, where
   * neither face lies wholly on the other. At least one node must. Absent, every node must.
   */
  contact?: true;
}

/**
 * CR5a (docs/cad/car-design.md, S2b): a mass (t) carried by faces, spread over their nodes by
 * area, apart from the loads: the inertia of a part left out of the model (an engine, a seat).
 * It is in every study: the mass matrix of a modal study, a static study's gravity, the mass
 * totals and checks.
 */
export interface SimulationMass {
  id: string;
  name: string;
  targets: SimulationTarget[];
  mass: number;
}

/**
 * CR5b (docs/cad/car-design.md, S5): a row of spot welds of the source CAD version (`weldId`),
 * taken into the analysis. Its points come from the CAD row at each run; the nodes of the first
 * flange (`follower`) within `radiusMm` of each point follow the second flange (`on`) as a bond's
 * do. `tolerance` is the largest distance (mm) from a tied node to the second flange's CAD face;
 * the run allows each shell side its half thickness more, as for a bond.
 */
export interface SimulationSpotWeld {
  id: string;
  name: string;
  weldId: string;
  follower: SimulationTarget[];
  on: SimulationTarget[];
  radiusMm: number;
  tolerance: number;
}

/** CR5e: a sheet body's thickness (mm), 0 < t ≤ `simulationLimits.sheetThicknessMm`. */
export interface SimulationSheet {
  bodyId: string;
  thicknessMm: number;
}

/** Schema 2 (R3j-2) adds `bodies` and a target's `body`; schema 1 has neither. */
export type SimulationSchemaVersion = 1 | 2;
export interface SimulationDocument {
  schemaVersion: SimulationSchemaVersion;
  units: 'mm-N-MPa-t-s';
  name: string;
  /** One solid body of one CAD version, fixed by version and content hash (ADR 020). */
  source: { artifactId: string; versionId: string; contentHash: string; bodyId: string };
  materials: SimulationMaterial[];
  /** The material of the source body, or null before one is chosen. */
  materialId: string | null;
  /**
   * R3j-2 (schema 2): the other bodies of the source version analysed with the source body,
   * joined to it by bonds (R3j-4). Absent when the source body is analysed alone.
   */
  bodies?: SimulationBody[];
  /** R3j-4 (schema 2): the bonds between the analysed bodies. Absent when there are none. */
  bonds?: SimulationBond[];
  /** CR5a (schema 2): added masses on faces. Absent when there are none. */
  masses?: SimulationMass[];
  /** CR5b (schema 2): spot weld rows taken from the source version. Absent when there are none. */
  spotWelds?: SimulationSpotWeld[];
  /**
   * VS9 (schema 2): the seals round the openings, each between two analysed bodies. Absent when
   * there are none.
   */
  seals?: SimulationSeal[];
  /**
   * CR5e (schema 2): the thickness of each analysed sheet body (a CAD sheet, not a solid). A sheet
   * is solved as a shell on itself at this thickness, whatever the study's idealisation; one
   * without a thickness is refused (`source-body-kind`). Absent when no sheet is analysed.
   */
  sheets?: SimulationSheet[];
  preparation: SimulationPreparation;
  mesh: SimulationMeshSettings;
  loads: SimulationLoad[];
  constraints: SimulationConstraint[];
  studies: SimulationStudy[];
  /**
   * R3c: re-selections of targets the preparation split or merged (ambiguous), each for one
   * version, preparation and kernel build. Absent when there are none.
   */
  overrides?: SimulationOverride[];
  /** R3e-5c: the recorded run of each study (at most one per study). Absent when there are none. */
  runs?: SimulationRunRecord[];
  /** IDs of removed elements: never given to a new element of this document. */
  retiredIds?: string[];
}

/** The initial safety limits of the design (docs/cad/r3-analysis.md); reviewed before acceptance. */
export const simulationLimits = Object.freeze({
  idCodePoints: 128,
  nameCodePoints: 256,
  materials: 64,
  loads: 128,
  constraints: 128,
  studies: 32,
  targetsPerItem: 256,
  localSizes: 256,
  removeFaces: 256,
  /** R3j-2: other bodies analysed with the source body. */
  bodies: 63,
  /** R3j-4: bonds between the analysed bodies. */
  bonds: 256,
  /** CR5a: added masses, and the largest one (t). */
  masses: 128,
  massT: 1_000,
  /** CR5b: spot weld rows (as many as a CAD document has), and the largest weld radius (mm). */
  spotWelds: 256,
  weldRadiusMm: 50,
  /** CR5e: sheet thicknesses (one per analysed body), and the thickest sheet (mm). */
  sheets: 64,
  sheetThicknessMm: 100,
  /**
   * VS9: seals, a seal's free height and inset (mm), its smallest bend radius (mm), the measured
   * points' spacing (mm, finest and coarsest) and the widest gap threshold (mm).
   */
  seals: 64,
  sealDiameterMm: 100,
  sealInsetMm: 200,
  sealBendRadiusMm: 1_000,
  sealStepMinMm: 0.5,
  sealStepMaxMm: 100,
  sealGapThresholdMm: 10,
  /** VS9: a hinge's largest turn (degrees). */
  sealHingeDeg: 90,
  /**
   * VS10: a shower's nozzles, rain rate (mm/h), slope (degrees), particles a second, time (s) and
   * step (s, finest and coarsest), a nozzle's flow (L/min) and speed (mm/s), the film's speed.
   * 15 nozzles: with the rain, the particle model's 16 emitters (Codex on #1271).
   */
  showerNozzles: 15,
  showerRainMmPerH: 1_000,
  showerSlopeDeg: 30,
  showerParticlesPerS: 50_000,
  showerDurationS: 60,
  showerStepMinS: 0.0005,
  showerStepMaxS: 0.05,
  showerFlowLPerMin: 100,
  showerSpeedMmPerS: 50_000,
  showerFilmMmPerS: 2_000,
  convergenceLevels: 4,
  /** R3g: modes a modal study asks for. */
  modes: 20,
  /**
   * VS4a: a wind-tunnel study's air speed (m/s), side wind (degrees), browser cell (mm), Host
   * mesh (as the Host's `aeroLimits`) and reference area (mm²).
   */
  aeroSpeed: 70,
  aeroYawDeg: 20,
  aeroCellMm: 1_000,
  aeroHostBaseMmMin: 10,
  aeroHostBaseMmMax: 2_000,
  aeroHostLevel: 6,
  aeroHostIterations: 3_000,
  aeroReferenceAreaMm2: 1e8,
  /**
   * VS7b: a crash study's speed (km/h), end time (ms), pole diameter (mm), friction, intrusion
   * pairs, and a plasticity curve's points.
   */
  crashSpeedKmh: 120,
  crashEndTimeMs: 300,
  crashPoleDiameterMm: 1_000,
  crashFriction: 1,
  crashIntrusions: 32,
  plasticityPoints: 64,
  /** R3h: K, mW/mm² (kW/m²), mW/(mm²·K) (kW/(m²·K)) and mW/(mm·K) (W/(m·K)). */
  temperatureK: 100_000,
  heatFlux: 1e9,
  filmCoefficient: 1e6,
  conductivity: 1e5,
  /**
   * VS11d: specific heat (mm²/(s²·K)), expansion (1/K), a transient run's end (s) and steps, kept
   * fields, amplitude points and rays per patch, as `geometry-fem`'s transient and radiation limits.
   */
  specificHeat: 1e11,
  expansion: 1e-3,
  transientEndS: 1e7,
  transientSteps: 20_000,
  /** VS13: points of a fatigue load history. */
  fatiguePoints: 100_000,
  transientOutputs: 400,
  amplitudePoints: 10_000,
  raysPerPatch: 1024,
  overrides: 1024,
  /** A run record's checks and reasons, and the length of each detail or reason. */
  runChecks: 16,
  runReasons: 64,
  runTextCodePoints: 2048,
  overrideChoices: 256,
  retiredIds: 65_536,
  contentBytes: 4 * 1024 * 1024,
  jsonDepth: 24,
  /** Forces (N), pressures and moduli (MPa), lengths (mm) and accelerations (mm/s²). */
  forceN: 1e12,
  pressureMPa: 1e7,
  modulusMPa: 1e8,
  lengthMm: 10_000_000,
  accelerationMmS2: 1e9,
  /** t/mm³ (steel is 7.85e-9). */
  densityMax: 1e-6,
  maxIterations: 1_000_000,
  /**
   * Browser solves (R3d): larger meshes are refused (`mesh-too-large`). Lowered from 60 000 / 40 000
   * by the measurement in docs/verification/cad-r3-performance (60 s with the Jacobi PCG).
   */
  browserNodes: 30_000,
  browserElements: 20_000,
  /**
   * R3g: a modal run solves several modes at once (LOBPCG, six modes on 6 561 nodes took 31 s in
   * Node), so the browser takes smaller meshes for it.
   */
  browserModalNodes: 10_000,
  browserModalElements: 7_000,
});

/** Common materials, as starting values the user may edit. */
export const simulationMaterialPresets: readonly Omit<SimulationMaterial, 'id'>[] = Object.freeze([
  {
    name: 'Structural steel',
    model: 'linear-elastic-isotropic',
    youngsModulus: 210_000,
    poissonsRatio: 0.3,
    density: 7.85e-9,
    conductivity: 50,
    specificHeat: 4.6e8,
    expansion: 1.2e-5,
  },
  {
    name: 'Aluminium 6061-T6',
    model: 'linear-elastic-isotropic',
    youngsModulus: 68_900,
    poissonsRatio: 0.33,
    density: 2.7e-9,
    conductivity: 167,
    specificHeat: 8.96e8,
    expansion: 2.36e-5,
  },
  {
    name: 'Stainless steel 304',
    model: 'linear-elastic-isotropic',
    youngsModulus: 193_000,
    poissonsRatio: 0.29,
    density: 8.0e-9,
    conductivity: 16.2,
    specificHeat: 5.0e8,
    expansion: 1.73e-5,
  },
  {
    name: 'Titanium Ti-6Al-4V',
    model: 'linear-elastic-isotropic',
    youngsModulus: 113_800,
    poissonsRatio: 0.342,
    density: 4.43e-9,
    conductivity: 6.7,
    specificHeat: 5.26e8,
    expansion: 8.6e-6,
  },
  /** VS12: grey cast iron (EN-GJL-250), the brake-disc iron. */
  {
    name: 'Grey cast iron',
    model: 'linear-elastic-isotropic',
    youngsModulus: 110_000,
    poissonsRatio: 0.26,
    density: 7.2e-9,
    conductivity: 48,
    specificHeat: 5.0e8,
    expansion: 1.1e-5,
  },
  // VS7c-2: car-body sheet with its plasticity for a crash study: typical true flow curves
  // against the equivalent plastic strain, Cowper–Symonds rate terms from the literature (mild
  // steel C 40.4/s p 5; DP590 C 802/s p 3.585) and the strain a shell is erased at. They are
  // starting values: a test of the actual sheet's curve should replace them.
  {
    name: 'Mild steel SPCC (crash)',
    model: 'linear-elastic-isotropic',
    youngsModulus: 210_000,
    poissonsRatio: 0.3,
    density: 7.85e-9,
    conductivity: 50,
    plasticity: {
      strain: [0, 0.02, 0.05, 0.1, 0.2, 0.4],
      stress: [200, 265, 315, 360, 410, 465],
      cowperSymonds: { C: 40.4, p: 5 },
      failureStrain: 0.5,
    },
  },
  {
    name: 'High-strength steel DP590 (crash)',
    model: 'linear-elastic-isotropic',
    youngsModulus: 210_000,
    poissonsRatio: 0.3,
    density: 7.85e-9,
    conductivity: 45,
    plasticity: {
      strain: [0, 0.02, 0.05, 0.1, 0.2, 0.4],
      stress: [380, 520, 590, 640, 690, 730],
      cowperSymonds: { C: 802, p: 3.585 },
      failureStrain: 0.3,
    },
  },
  {
    name: 'Aluminium 6061-T6 (crash)',
    model: 'linear-elastic-isotropic',
    youngsModulus: 68_900,
    poissonsRatio: 0.33,
    density: 2.7e-9,
    conductivity: 167,
    plasticity: {
      strain: [0, 0.02, 0.05, 0.1, 0.2],
      stress: [276, 295, 310, 320, 330],
      cowperSymonds: { C: 6500, p: 4 },
      failureStrain: 0.12,
    },
  },
]);

export interface SimulationDiagnostic {
  code: string;
  path: string;
  message: string;
}
export class SimulationValidationError extends Error {
  constructor(readonly diagnostics: SimulationDiagnostic[]) {
    super(diagnostics.map((d) => `${d.code} ${d.path}`).join('; '));
    this.name = 'SimulationValidationError';
  }
}

export function emptySimulation(
  source: SimulationDocument['source'],
  name = 'Analysis',
): SimulationDocument {
  return {
    schemaVersion: 1,
    units: 'mm-N-MPa-t-s',
    name,
    source: { ...source },
    materials: [],
    materialId: null,
    preparation: { removeHolesBelow: null, removeFilletsBelow: null, removeFaces: [] },
    mesh: { order: 2, size: 5, minSize: 0.5, grading: 1.5, local: [] },
    loads: [],
    constraints: [],
    studies: [],
  };
}

/**
 * The Host's background cell for bodies `lengthMm` long (their largest side): the Ahmed-checked
 * mesh (160 mm at level 6 on the 1044 mm body, TS-2205) scaled to the bodies, so the tunnel holds
 * as many cells as the checked one (a 4 m car: about 610 mm, not 160 mm, which would pass the
 * Host's background limit). Rounded to 10 mm, within the limits.
 */
export function aeroHostBaseMm(lengthMm: number): number {
  const base = Math.round((160 * lengthMm) / 1044 / 10) * 10;
  return Number.isFinite(base)
    ? Math.min(
        simulationLimits.aeroHostBaseMmMax,
        Math.max(simulationLimits.aeroHostBaseMmMin, base),
      )
    : 160;
}

/**
 * VS4a: a new wind-tunnel study with the settings the 凪 runs start from: 30 m/s straight on, a
 * moving road, 60 mm cells in the browser and the Host's Ahmed-checked mesh (160 mm, level 6), or
 * that mesh scaled to the bodies' length (`lengthMm`, `aeroHostBaseMm`) when it is known.
 */
export function aeroStudy(
  id: string,
  name = 'Wind tunnel',
  lengthMm?: number,
): SimulationAeroStudy {
  return {
    id,
    name,
    kind: 'aero',
    loadIds: [],
    constraintIds: [],
    solver: { tolerance: 1e-6, maxIterations: 4_000 },
    convergence: { levels: 1, metrics: ['drag-coefficient'], tolerance: 0.05 },
    aero: {
      speed: 30,
      yawDeg: 0,
      ground: 'moving',
      browserCellMm: 60,
      host: { baseMm: lengthMm ? aeroHostBaseMm(lengthMm) : 160, level: 6, iterations: 400 },
      referenceAreaMm2: null,
    },
  };
}

/**
 * VS7b: a new crash study with the plan's test: a full-width wall at 56 km/h, or a 254 mm pole
 * at 32 km/h and 75° on `pole.side` through (`pole.xMm`, `pole.zMm`); gravity, friction 0.1 and
 * 120 ms (long enough for the OLC of a car stopping within about 60 ms).
 */
export function crashStudy(
  id: string,
  accelerometer: Vec3,
  pole?: { side: 'left' | 'right'; xMm: number; zMm: number },
  name = pole ? 'Pole crash' : 'Frontal crash',
): SimulationCrashStudy {
  return {
    id,
    name,
    kind: 'crash',
    loadIds: [],
    constraintIds: [],
    solver: { tolerance: 1e-6, maxIterations: 1 },
    convergence: { levels: 1, metrics: ['peak-deceleration'], tolerance: 0.05 },
    crash: {
      barrier: pole ? 'pole' : 'wall',
      speedKmh: pole ? 32 : 56,
      pole: pole ? { diameterMm: 254, angleDeg: 75, ...pole } : null,
      gravity: true,
      friction: 0.1,
      endTimeMs: 120,
      accelerometer,
      intrusions: [],
    },
  };
}

/**
 * VS8b: a new head impact study: the adult headform at 40 km/h and 65° on `targetMm`, nodes
 * beyond `holdBeyondMm` held, friction 0.1 and 20 ms (HIC15's window and the rebound).
 */
export function headImpactStudy(
  id: string,
  targetMm: Vec3,
  holdBeyondMm: number | null,
  name = 'Head impact',
): SimulationCrashStudy {
  return {
    id,
    name,
    kind: 'crash',
    loadIds: [],
    constraintIds: [],
    solver: { tolerance: 1e-6, maxIterations: 1 },
    convergence: { levels: 1, metrics: ['hic15'], tolerance: 0.05 },
    crash: {
      barrier: 'head',
      speedKmh: 40,
      pole: null,
      gravity: false,
      friction: 0.1,
      endTimeMs: 20,
      accelerometer: [...targetMm],
      intrusions: [],
      head: { headform: 'adult', targetMm: [...targetMm], angleDeg: 65, holdBeyondMm },
    },
  };
}
