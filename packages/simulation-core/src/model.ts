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
}

export type SimulationLoad =
  /** A total force (N) spread over the targets by area (faces) or length (edges). */
  | { id: string; name: string; kind: 'force'; targets: SimulationTarget[]; force: Vec3 }
  /** A pressure (MPa) on faces; positive pushes into the body along the inward normal. */
  | { id: string; name: string; kind: 'pressure'; targets: SimulationTarget[]; pressure: number }
  /** An acceleration of the whole body (mm/s²), e.g. [0, 0, -9806.65]. */
  | { id: string; name: string; kind: 'gravity'; acceleration: Vec3 }
  /** R3h: heat into the body through faces, mW/mm² (= kW/m²); negative takes heat out. */
  | { id: string; name: string; kind: 'heat-flux'; targets: SimulationTarget[]; flux: number }
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
  | 'stiffness';
export const simulationMetrics: readonly SimulationMetric[] = Object.freeze([
  'max-displacement',
  'max-von-mises',
  'reaction-force',
  'first-frequency',
  'max-temperature',
  'max-heat-flux',
  'stiffness',
]);
export type SimulationStudyKind = 'linear-static' | 'modal' | 'thermal';
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
  });

/** One analysis case: which loads and constraints, how it is solved and how convergence is judged. */
export type SimulationStudy = SimulationStaticStudy | SimulationModalStudy | SimulationThermalStudy;
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
  | 'orthogonality';

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
  convergenceLevels: 4,
  /** R3g: modes a modal study asks for. */
  modes: 20,
  /** R3h: K, mW/mm² (kW/m²), mW/(mm²·K) (kW/(m²·K)) and mW/(mm·K) (W/(m·K)). */
  temperatureK: 100_000,
  heatFlux: 1e9,
  filmCoefficient: 1e6,
  conductivity: 1e5,
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
  },
  {
    name: 'Aluminium 6061-T6',
    model: 'linear-elastic-isotropic',
    youngsModulus: 68_900,
    poissonsRatio: 0.33,
    density: 2.7e-9,
    conductivity: 167,
  },
  {
    name: 'Stainless steel 304',
    model: 'linear-elastic-isotropic',
    youngsModulus: 193_000,
    poissonsRatio: 0.29,
    density: 8.0e-9,
    conductivity: 16.2,
  },
  {
    name: 'Titanium Ti-6Al-4V',
    model: 'linear-elastic-isotropic',
    youngsModulus: 113_800,
    poissonsRatio: 0.342,
    density: 4.43e-9,
    conductivity: 6.7,
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
