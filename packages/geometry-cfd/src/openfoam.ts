/**
 * VS3 (docs/cad/vehicle-simulation.md, VS-U3): the wind-tunnel job the browser sends to the Host,
 * its check, and the OpenFOAM case the Host writes from it. The browser sends numbers, an enum and
 * a closed surface only; the Host checks them again here and writes every dictionary from these
 * fixed templates, so no text from the browser reaches OpenFOAM (no `#include`, `#codeStream`,
 * library, path or dictionary text can be sent: there is no field for it, and unknown fields are
 * refused). `allowSystemOperations` is off in the case's controlDict.
 *
 * Frame: the vehicle's (x forward to the nose, y across, z up, the ground at z = 0), mm. The air
 * comes from the front (+x side) at `speed`, turned by `yawDeg` about z (positive: from the left).
 */
import { CfdError } from './errors';
import { cfdLimits, checkSurface, type TriangleSurface } from './voxelize';

export type AeroGround = 'moving' | 'fixed' | 'slip';

export interface AeroJob {
  kind: 'aero';
  /** Closed surface of the body (mm, vehicle frame), wound outward; above the ground (z ≥ 0). */
  surface: { positions: number[]; triangles: number[] };
  /** Air speed (m/s). */
  speed: number;
  /** Side-wind angle (degrees), positive with the air coming from the left (−y) side. */
  yawDeg: number;
  ground: AeroGround;
  /** The background cell (mm) and the surface's refinement level (each level halves the cell). */
  mesh: { baseMm: number; level: number };
  /** SIMPLE iterations. */
  iterations: number;
  /** Reference area for the coefficients (mm²): usually the frontal area. */
  referenceAreaMm2: number;
}

export interface AeroLimits {
  /** Request size (bytes) the Host reads. */
  bytes: number;
  triangles: number;
  /** Background cells (blockMesh) and all cells after refinement (snappyHexMesh stops there). */
  backgroundCells: number;
  cells: number;
  iterations: number;
  /** Wall-clock limit of one job (ms). */
  timeoutMs: number;
  /** Processes for the solver (VS-U10: 4 cores). */
  processes: number;
}

/** The reference Host's limits (VS-U10: 4 cores, 15 GB, one job at a time). */
export const aeroLimits: Readonly<AeroLimits> = Object.freeze({
  bytes: 64 * 1024 * 1024,
  triangles: 400_000,
  backgroundCells: 400_000,
  cells: 3_000_000,
  iterations: 3000,
  timeoutMs: 90 * 60_000,
  processes: 4,
});

const invalid = (message: string): never => {
  throw new CfdError('job-invalid', message);
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const keysOnly = (o: Record<string, unknown>, keys: string[], where: string) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) invalid(`${where}: unknown field "${k}"`);
};
const number = (v: unknown, where: string, lo: number, hi: number, integer = false) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
    invalid(`${where} must be a number in [${lo}, ${hi}]`);
  if (integer && !Number.isInteger(v)) invalid(`${where} must be a whole number`);
  return v as number;
};

/** The domain around a body (mm): `[min, max]` per axis, and the background cells per axis. */
export function aeroDomain(lo: number[], hi: number[], baseMm: number) {
  const L = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  const min = [lo[0]! - 5 * L, Math.min(lo[1]!, -hi[1]!) - 1.5 * L, 0];
  const max = [hi[0]! + 2 * L, Math.max(hi[1]!, -lo[1]!) + 1.5 * L, hi[2]! + 1.5 * L];
  const cells = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a]! - min[a]!) / baseMm)));
  // Whole cells: the far sides move out to the next cell.
  for (let a = 0; a < 3; a++) max[a] = min[a]! + cells[a]! * baseMm;
  return { min, max, cells, length: L };
}

/**
 * The job, checked: its fields, ranges and the surface (closed, every point finite, above the
 * ground, inside its limits). Throws `job-invalid` (or the surface's own code) otherwise.
 */
export function checkAeroJob(value: unknown, limits: Readonly<AeroLimits> = aeroLimits): AeroJob {
  if (!isObject(value)) return invalid('the job must be an object');
  keysOnly(
    value,
    ['kind', 'surface', 'speed', 'yawDeg', 'ground', 'mesh', 'iterations', 'referenceAreaMm2'],
    'job',
  );
  if (value.kind !== 'aero') invalid('kind must be "aero"');
  const s = value.surface;
  if (!isObject(s)) return invalid('surface must be an object');
  keysOnly(s, ['positions', 'triangles'], 'surface');
  if (!Array.isArray(s.positions) || !Array.isArray(s.triangles))
    return invalid('surface positions and triangles must be arrays');
  if (s.triangles.length / 3 > limits.triangles)
    invalid(`the surface has more than ${limits.triangles} triangles`);
  for (const v of s.positions)
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6)
      invalid('surface positions must be numbers within ±1,000,000 mm');
  for (const v of s.triangles)
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= s.positions.length / 3)
      invalid('surface triangles must be point indices');
  const surface: TriangleSurface = {
    positions: Float64Array.from(s.positions as number[]),
    triangles: Uint32Array.from(s.triangles as number[]),
  };
  checkSurface(surface, { ...cfdLimits, maxTriangles: limits.triangles });
  const speed = number(value.speed, 'speed', 1, 70);
  const yawDeg = number(value.yawDeg, 'yawDeg', -20, 20);
  if (value.ground !== 'moving' && value.ground !== 'fixed' && value.ground !== 'slip')
    invalid('ground must be "moving", "fixed" or "slip"');
  const m = value.mesh;
  if (!isObject(m)) return invalid('mesh must be an object');
  keysOnly(m, ['baseMm', 'level'], 'mesh');
  const baseMm = number(m.baseMm, 'mesh.baseMm', 10, 2000);
  const level = number(m.level, 'mesh.level', 0, 6, true);
  const iterations = number(value.iterations, 'iterations', 10, limits.iterations, true);
  const referenceAreaMm2 = number(value.referenceAreaMm2, 'referenceAreaMm2', 1, 1e8);
  const { lo, hi } = bounds(surface.positions);
  if (lo[2]! < 0) invalid('the body must be above the ground (z ≥ 0)');
  if (hi[0]! - lo[0]! <= 0 || hi[1]! - lo[1]! <= 0 || hi[2]! - lo[2]! <= 0)
    invalid('the body must have a size along every axis');
  const domain = aeroDomain(lo, hi, baseMm);
  const background = domain.cells[0]! * domain.cells[1]! * domain.cells[2]!;
  if (background > limits.backgroundCells)
    invalid(`${background} background cells exceed ${limits.backgroundCells}: a larger baseMm`);
  // The smallest cell must still be a few across the body's smallest size.
  if (baseMm / 2 ** level > (domain.length as number) / 4)
    invalid('the refined cell is larger than a quarter of the body: a higher level');
  return {
    kind: 'aero',
    surface: { positions: s.positions as number[], triangles: s.triangles as number[] },
    speed,
    yawDeg,
    ground: value.ground as AeroGround,
    mesh: { baseMm, level },
    iterations,
    referenceAreaMm2,
  };
}

function bounds(p: ArrayLike<number>) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3]!, p[i]!);
    hi[i % 3] = Math.max(hi[i % 3]!, p[i]!);
  }
  return { lo, hi };
}

/** A number as OpenFOAM reads it (never NaN: every value here was checked). */
const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : v.toPrecision(10));
const header = (cls: string, object: string, location?: string) =>
  `FoamFile\n{\n    version 2.0;\n    format ascii;\n    class ${cls};\n${
    location ? `    location "${location}";\n` : ''
  }    object ${object};\n}\n`;

/** The ASCII STL of the surface in metres, one solid named `body`. */
export function aeroStl(job: AeroJob): string {
  const p = job.surface.positions;
  const t = job.surface.triangles;
  const out: string[] = ['solid body'];
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i]!, t[i + 1]!, t[i + 2]!].map((k) => 3 * k);
    const u = [0, 1, 2].map((k) => p[b! + k]! - p[a! + k]!);
    const v = [0, 1, 2].map((k) => p[c! + k]! - p[a! + k]!);
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    out.push(`facet normal ${n.map((x) => (x / l).toPrecision(7)).join(' ')}`, 'outer loop');
    for (const q of [a!, b!, c!])
      out.push(
        `vertex ${[0, 1, 2].map((k) => ((p[q + k]! as number) / 1000).toPrecision(10)).join(' ')}`,
      );
    out.push('endloop', 'endfacet');
  }
  out.push('endsolid body', '');
  return out.join('\n');
}

/**
 * Free-stream turbulence: 0.5% intensity and an eddy viscosity ten times the air's (a wind tunnel's
 * quiet stream; a larger one thickens the boundary layers and moves the separation).
 */
/** Kinematic viscosity of air at 20 °C (m²/s). */
const airViscosity = 1.5e-5;
/** Density (kg/m³) and specific heat (J/(kg·K)) of air at 20 °C, for forces and the heat transfer coefficient. */
export const airDensity = 1.2;
export const airSpecificHeat = 1005;

function freestream(job: AeroJob) {
  const k = 1.5 * (0.005 * job.speed) ** 2;
  const omega = k / (10 * airViscosity);
  return { k, omega };
}

/**
 * The OpenFOAM v1912 case for the job: path → text. Every value comes from the checked job; the
 * Host writes the files into an empty folder and runs `aeroCommands`.
 */
export function aeroCase(job: AeroJob, limits: Readonly<AeroLimits> = aeroLimits) {
  const { lo, hi } = bounds(job.surface.positions);
  const d = aeroDomain(lo, hi, job.mesh.baseMm);
  const m = (v: number) => v / 1000;
  const yaw = (job.yawDeg * Math.PI) / 180;
  // The air moves toward −x (from the nose), turned by the yaw: from the left (−y) when positive.
  const U = [-job.speed * Math.cos(yaw), job.speed * Math.sin(yaw), 0];
  const lengthM = m(hi[0]! - lo[0]!);
  const { k, omega } = freestream(job);
  const nu = airViscosity;
  const level = job.mesh.level;
  const [x0, y0, z0] = d.min.map(m) as [number, number, number];
  const [x1, y1, z1] = d.max.map(m) as [number, number, number];
  const vec = (v: number[]) => `(${v.map(f).join(' ')})`;
  // A point in the air: near the outlet corner, off every cell face.
  const inside = [
    x0 + 0.37 * (m(lo[0]!) - x0),
    y0 + 0.31 * (y1 - y0) * 0.5,
    z1 - 0.29 * (z1 - z0) * 0.5,
  ];
  const wake = {
    min: [m(lo[0]!) - 1.5 * lengthM, m(lo[1]!) - 0.25 * lengthM, 0],
    max: [m(hi[0]!) + 0.25 * lengthM, m(hi[1]!) + 0.25 * lengthM, m(hi[2]!) + 0.25 * lengthM],
  };
  const groundU =
    job.ground === 'moving'
      ? `type fixedValue; value uniform ${vec([U[0]!, 0, 0])};`
      : job.ground === 'fixed'
        ? 'type noSlip;'
        : 'type slip;';
  const wallFn = (field: 'k' | 'omega' | 'nut', v: number) =>
    job.ground === 'slip'
      ? field === 'nut'
        ? 'type calculated; value uniform 0;'
        : 'type zeroGradient;'
      : field === 'k'
        ? `type kqRWallFunction; value uniform ${f(v)};`
        : field === 'omega'
          ? `type omegaWallFunction; value uniform ${f(v)};`
          : 'type nutkWallFunction; value uniform 0;';
  const field = (
    name: string,
    cls: string,
    dims: string,
    internal: string,
    bc: Record<string, string>,
  ) =>
    header(cls, name, '0') +
    `dimensions ${dims};\ninternalField uniform ${internal};\nboundaryField\n{\n${Object.entries(bc)
      .map(([p, s]) => `    ${p} { ${s} }`)
      .join('\n')}\n}\n`;
  // The top is a slip wall. The sides are too while the wind is straight; with a yaw the
  // crosswind must pass through them, so they take the free stream (in where the air comes in,
  // out where it leaves).
  const yawed = job.yawDeg !== 0;
  const outer = (inlet: string, outlet: string, top: string, sides = top) => ({
    inlet,
    outlet,
    sides: yawed ? sides : top,
    top,
  });
  const processes = Math.max(1, Math.min(limits.processes, 64));
  const files: Record<string, string> = {
    'constant/triSurface/body.stl': aeroStl(job),
    'constant/transportProperties':
      header('dictionary', 'transportProperties', 'constant') +
      `transportModel Newtonian;\nnu ${f(nu)};\n`,
    'constant/turbulenceProperties':
      header('dictionary', 'turbulenceProperties', 'constant') +
      'simulationType RAS;\nRAS\n{\n    RASModel kOmegaSST;\n    turbulence on;\n    printCoeffs off;\n}\n',
    'system/blockMeshDict':
      header('dictionary', 'blockMeshDict', 'system') +
      `scale 1;\nvertices\n(\n${[
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ]
        .map((v) => `    ${vec(v)}`)
        .join(
          '\n',
        )}\n);\nblocks\n(\n    hex (0 1 2 3 4 5 6 7) (${d.cells.join(' ')}) simpleGrading (1 1 1)\n);\nedges ();\nboundary\n(\n` +
      '    outlet { type patch; faces ((0 4 7 3)); }\n' +
      '    inlet { type patch; faces ((1 2 6 5)); }\n' +
      '    ground { type wall; faces ((0 3 2 1)); }\n' +
      '    top { type patch; faces ((4 5 6 7)); }\n' +
      '    sides { type patch; faces ((0 1 5 4) (3 7 6 2)); }\n' +
      ');\nmergePatchPairs ();\n',
    'system/snappyHexMeshDict':
      header('dictionary', 'snappyHexMeshDict', 'system') +
      `castellatedMesh true;\nsnap true;\naddLayers false;\n` +
      `geometry\n{\n    body.stl { type triSurfaceMesh; name body; }\n    wake { type searchableBox; min ${vec(wake.min)}; max ${vec(wake.max)}; }\n}\n` +
      `castellatedMeshControls\n{\n    maxLocalCells ${limits.cells};\n    maxGlobalCells ${limits.cells};\n    minRefinementCells 10;\n    maxLoadUnbalance 0.10;\n    nCellsBetweenLevels 3;\n    features ();\n` +
      `    refinementSurfaces { body { level (${level} ${level}); patchInfo { type wall; } } }\n    resolveFeatureAngle 30;\n` +
      `    refinementRegions { wake { mode inside; levels ((1E15 ${Math.max(0, level - 2)})); } }\n` +
      `    locationInMesh ${vec(inside)};\n    allowFreeStandingZoneFaces true;\n}\n` +
      'snapControls\n{\n    nSmoothPatch 3;\n    tolerance 2.0;\n    nSolveIter 50;\n    nRelaxIter 5;\n    nFeatureSnapIter 10;\n    implicitFeatureSnap true;\n    explicitFeatureSnap false;\n    multiRegionFeatureSnap false;\n}\n' +
      'addLayersControls\n{\n    relativeSizes true;\n    layers {}\n    expansionRatio 1.0;\n    finalLayerThickness 0.3;\n    minThickness 0.1;\n    nGrow 0;\n    featureAngle 60;\n    nRelaxIter 3;\n    nSmoothSurfaceNormals 1;\n    nSmoothNormals 3;\n    nSmoothThickness 10;\n    maxFaceThicknessRatio 0.5;\n    maxThicknessToMedialRatio 0.3;\n    minMedialAxisAngle 90;\n    nBufferCellsNoExtrude 0;\n    nLayerIter 50;\n}\n' +
      'meshQualityControls\n{\n    maxNonOrtho 65;\n    maxBoundarySkewness 20;\n    maxInternalSkewness 4;\n    maxConcave 80;\n    minVol 1e-13;\n    minTetQuality 1e-15;\n    minArea -1;\n    minTwist 0.02;\n    minDeterminant 0.001;\n    minFaceWeight 0.05;\n    minVolRatio 0.01;\n    minTriangleTwist -1;\n    nSmoothScale 4;\n    errorReduction 0.75;\n}\n' +
      'mergeTolerance 1e-6;\n',
    'system/controlDict':
      header('dictionary', 'controlDict', 'system') +
      // Nothing in this case runs system commands or compiles code.
      'InfoSwitches { allowSystemOperations 0; }\n' +
      `application simpleFoam;\nstartFrom startTime;\nstartTime 0;\nstopAt endTime;\nendTime ${job.iterations};\ndeltaT 1;\n` +
      `writeControl timeStep;\nwriteInterval ${job.iterations};\npurgeWrite 0;\nwriteFormat ascii;\nwritePrecision 8;\nwriteCompression off;\ntimeFormat general;\ntimePrecision 6;\nrunTimeModifiable false;\n` +
      // forceCoeffs writes every coefficient; a `coefficients` list is left out, since its names
      // (Cd(f), Cl(r), …) are not valid words in a dictionary.
      `functions\n{\n    forceCoeffs\n    {\n        type forceCoeffs;\n        libs ("libforces.so");\n        writeControl timeStep;\n        writeInterval 1;\n        patches (body);\n        rho rhoInf;\n        rhoInf ${f(airDensity)};\n        liftDir (0 0 1);\n        dragDir ${vec(U.map((u) => u / job.speed))};\n        CofR ${vec([m((lo[0]! + hi[0]!) / 2), 0, 0])};\n        pitchAxis (0 1 0);\n        magUInf ${f(job.speed)};\n        lRef ${f(lengthM)};\n        Aref ${f(job.referenceAreaMm2 / 1e6)};\n    }\n` +
      // VS-U9: the wall shear on the body, from which the Host gives the heat transfer
      // coefficient by the Reynolds analogy (`parseSurfaceSample`). OpenFOAM's own
      // heatTransferCoeff (ReynoldsAnalogy) asks for a thermo model even though that model does not
      // use it, so it cannot run with simpleFoam; the formula is the same.
      `    bodyShear\n    {\n        type wallShearStress;\n        libs ("libfieldFunctionObjects.so");\n        patches (body);\n        executeControl onEnd;\n        writeControl onEnd;\n    }\n` +
      `    bodyPressure\n    {\n        type surfaces;\n        libs ("libsampling.so");\n        writeControl onEnd;\n        surfaceFormat raw;\n        fields (p wallShearStress);\n        interpolationScheme cell;\n        surfaces\n        (\n            body { type patch; patches (body); interpolate false; }\n        );\n    }\n}\n`,
    'system/fvSchemes':
      header('dictionary', 'fvSchemes', 'system') +
      'ddtSchemes { default steadyState; }\ngradSchemes { default Gauss linear; grad(U) cellLimited Gauss linear 1; }\n' +
      'divSchemes\n{\n    default none;\n    div(phi,U) bounded Gauss linearUpwindV grad(U);\n    div(phi,k) bounded Gauss upwind;\n    div(phi,omega) bounded Gauss upwind;\n    div((nuEff*dev2(T(grad(U))))) Gauss linear;\n}\n' +
      'laplacianSchemes { default Gauss linear limited corrected 0.33; }\ninterpolationSchemes { default linear; }\nsnGradSchemes { default limited corrected 0.33; }\nwallDist { method meshWave; }\n',
    'system/fvSolution':
      header('dictionary', 'fvSolution', 'system') +
      'solvers\n{\n    p { solver GAMG; tolerance 1e-7; relTol 0.01; smoother GaussSeidel; }\n    Phi { $p; }\n    U { solver smoothSolver; smoother GaussSeidel; tolerance 1e-8; relTol 0.1; nSweeps 1; }\n    "(k|omega)" { $U; }\n}\n' +
      'SIMPLE { nNonOrthogonalCorrectors 0; consistent yes; }\npotentialFlow { nNonOrthogonalCorrectors 10; }\n' +
      'relaxationFactors { equations { U 0.9; "(k|omega)" 0.7; } }\ncache { grad(U); }\n',
    'system/decomposeParDict':
      header('dictionary', 'decomposeParDict', 'system') +
      `numberOfSubdomains ${processes};\nmethod simple;\nsimpleCoeffs { n (${processes} 1 1); delta 0.001; }\n`,
    '0/U': field('U', 'volVectorField', '[0 1 -1 0 0 0 0]', vec(U), {
      ...outer(
        `type fixedValue; value uniform ${vec(U)};`,
        'type inletOutlet; inletValue uniform (0 0 0); value uniform (0 0 0);',
        'type slip;',
        `type freestreamVelocity; freestreamValue uniform ${vec(U)}; value uniform ${vec(U)};`,
      ),
      ground: groundU,
      body: 'type noSlip;',
    }),
    '0/p': field('p', 'volScalarField', '[0 2 -2 0 0 0 0]', '0', {
      ...outer(
        'type zeroGradient;',
        'type fixedValue; value uniform 0;',
        'type slip;',
        'type freestreamPressure; freestreamValue uniform 0; value uniform 0;',
      ),
      ground: 'type zeroGradient;',
      body: 'type zeroGradient;',
    }),
    '0/k': field('k', 'volScalarField', '[0 2 -2 0 0 0 0]', f(k), {
      ...outer(
        `type fixedValue; value uniform ${f(k)};`,
        `type inletOutlet; inletValue uniform ${f(k)}; value uniform ${f(k)};`,
        'type slip;',
        `type inletOutlet; inletValue uniform ${f(k)}; value uniform ${f(k)};`,
      ),
      ground: wallFn('k', k),
      body: `type kqRWallFunction; value uniform ${f(k)};`,
    }),
    '0/omega': field('omega', 'volScalarField', '[0 0 -1 0 0 0 0]', f(omega), {
      ...outer(
        `type fixedValue; value uniform ${f(omega)};`,
        `type inletOutlet; inletValue uniform ${f(omega)}; value uniform ${f(omega)};`,
        'type slip;',
        `type inletOutlet; inletValue uniform ${f(omega)}; value uniform ${f(omega)};`,
      ),
      ground: wallFn('omega', omega),
      body: `type omegaWallFunction; value uniform ${f(omega)};`,
    }),
    '0/nut': field('nut', 'volScalarField', '[0 2 -1 0 0 0 0]', '0', {
      ...outer(
        'type calculated; value uniform 0;',
        'type calculated; value uniform 0;',
        'type calculated; value uniform 0;',
      ),
      ground: wallFn('nut', 0),
      body: 'type nutkWallFunction; value uniform 0;',
    }),
  };
  return { files, domain: d, processes };
}

/**
 * The commands the Host runs in the case folder, in order: fixed programs and arguments, nothing
 * from the job. With more than one process the solver runs under MPI.
 */
export function aeroCommands(processes: number): { program: string; args: string[] }[] {
  const steps = [
    { program: 'blockMesh', args: [] as string[] },
    { program: 'snappyHexMesh', args: ['-overwrite'] },
    { program: 'checkMesh', args: ['-constant'] },
  ];
  if (processes <= 1) return [...steps, { program: 'simpleFoam', args: [] }];
  return [
    ...steps,
    { program: 'decomposePar', args: ['-force'] },
    { program: 'mpirun', args: ['-np', String(processes), 'simpleFoam', '-parallel'] },
  ];
}

export interface AeroResult {
  /** Coefficients averaged over the last fifth of the iterations. */
  cd: number;
  cl: number;
  cs: number;
  /** Front and rear lift (the two halves of Cl about the reference point). */
  clFront: number;
  clRear: number;
  /** Drag coefficient per iteration, for the convergence plot. */
  history: { iteration: number; cd: number; cl: number }[];
}

/** Reads `postProcessing/forceCoeffs/0/coefficient.dat` (v1912): columns named on the `# Time` line. */
export function parseForceCoeffs(text: string): AeroResult {
  const lines = text.split('\n');
  const head = lines.find((l) => /^#\s*Time\b/.test(l));
  if (!head) throw new CfdError('job-invalid', 'no column line in the force coefficients');
  const names = head.replace(/^#\s*/, '').split(/\s+/);
  const col = (n: string) => {
    const i = names.indexOf(n);
    if (i < 0) throw new CfdError('job-invalid', `no ${n} column in the force coefficients`);
    return i;
  };
  const [iT, iCd, iCl, iCs, iClf, iClr] = ['Time', 'Cd', 'Cl', 'Cs', 'Cl(f)', 'Cl(r)'].map(col);
  const rows = lines
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.trim().split(/\s+/).map(Number));
  // A non-finite row means the solver blew up: refuse the run rather than average what came before.
  if (rows.some((r) => !r.every(Number.isFinite)))
    throw new CfdError('unstable', 'the force coefficients hold a non-finite value');
  if (rows.length === 0) throw new CfdError('job-invalid', 'no force coefficients were written');
  const last = rows.slice(Math.floor(rows.length * 0.8));
  const mean = (i: number) => last.reduce((s, r) => s + r[i]!, 0) / last.length;
  return {
    cd: mean(iCd!),
    cl: mean(iCl!),
    cs: mean(iCs!),
    clFront: mean(iClf!),
    clRear: mean(iClr!),
    history: rows.map((r) => ({ iteration: r[iT!]!, cd: r[iCd!]!, cl: r[iCl!]! })),
  };
}

/**
 * Reads the raw surface sample of p (kinematic, m²/s²) on the body: `x y z p` per face centre,
 * as pressure coefficients Cp = p / (½ U²), with the points in mm.
 */
export function parseSurfacePressure(text: string, speed: number) {
  const points: number[] = [];
  const cp: number[] = [];
  const q = 0.5 * speed * speed;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const v = line.trim().split(/\s+/).map(Number);
    if (v.length < 4 || !v.every(Number.isFinite)) continue;
    points.push(v[0]! * 1000, v[1]! * 1000, v[2]! * 1000);
    cp.push(v[3]! / q);
  }
  return { points: Float64Array.from(points), cp: Float64Array.from(cp) };
}

/** What the Host gives back for a wind-tunnel job: the coefficients and the body's surface. */
export interface AeroHostResult extends AeroResult {
  /** Face centres on the body (mm, x y z each). */
  points: number[];
  /** Pressure coefficient per face. */
  cp: number[];
  /** Skin friction coefficient per face, |τw| / (½ U²). */
  cf: number[];
  /**
   * Heat transfer coefficient per face (W/(m²·K)) by the Reynolds analogy, h = ½ ρ cp |U| Cf
   * (VS-U9): what OpenFOAM's heatTransferCoeff with ReynoldsAnalogy gives, for air at 20 °C.
   */
  htc: number[];
}

/**
 * The body's raw samples of p and of the wall shear stress (both kinematic, per face in the same
 * order) as Cp, Cf and the heat transfer coefficient. Refuses samples that do not line up.
 */
export function parseSurfaceSample(pressure: string, shear: string, speed: number) {
  const rows = (text: string, columns: number) => {
    const out: number[][] = [];
    for (const line of text.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const v = line.trim().split(/\s+/).map(Number);
      if (v.length !== columns || !v.every(Number.isFinite))
        throw new CfdError('unstable', 'a surface sample holds a bad row');
      out.push(v);
    }
    return out;
  };
  const p = rows(pressure, 4);
  const t = rows(shear, 6);
  if (p.length !== t.length)
    throw new CfdError('job-invalid', 'the pressure and shear samples have different faces');
  // No sampled face (a missing or empty output): not a result of zeros.
  if (!p.length) throw new CfdError('job-invalid', 'the surface samples hold no face');
  const q = 0.5 * speed * speed;
  const points: number[] = [];
  const cp: number[] = [];
  const cf: number[] = [];
  const htc: number[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = t[i]!;
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2])
      throw new CfdError('job-invalid', 'the pressure and shear samples have different faces');
    points.push(a[0]! * 1000, a[1]! * 1000, a[2]! * 1000);
    cp.push(a[3]! / q);
    const tau = Math.hypot(b[3]!, b[4]!, b[5]!);
    cf.push(tau / q);
    // ½ ρ cp U · Cf = ρ cp |τ| / U (τ kinematic).
    htc.push((airDensity * airSpecificHeat * tau) / speed);
  }
  return { points, cp, cf, htc };
}
