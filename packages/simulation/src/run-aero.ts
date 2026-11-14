/**
 * VS4b (docs/cad/vehicle-simulation.md, VS4): a wind-tunnel study run. The kernel gives each
 * analysed body's closed analysis surface (the source body and `bodies`: wheels, mirrors), they
 * are joined into one outside shape, and the air runs past it either in the browser (the LBM of
 * geometry-cfd, on WebGPU when there is one) or on the compute Host (OpenFOAM, `kind: 'aero'`).
 * The result is the force coefficients per level and the `surface` and `solver` checks; it is
 * always `reference` in V1 (`studyStatus`).
 */
import {
  aeroDomain,
  CfdError,
  mergeSurfaces,
  runWindTunnel,
  surfacePressure,
  type AeroHostResult,
  type AeroJob,
  type GpuLike,
  type TriangleSurface,
  type WindTunnelProgress,
  type WindTunnelRequest,
} from '@editor-platform/geometry-cfd';
import { nearestSamples, triangleToPoint, type AeroRunFields } from './aero-view';
import type {
  RunCheck,
  SimulationAeroStudy,
  SimulationDocument,
  SimulationMetric,
} from '@editor-platform/simulation-core';

/** The browser lattice: speed and viscosity in lattice units, an LES at Smagorinsky 0.17 (VS2). */
export const aeroLattice = Object.freeze({ speed: 0.1, viscosity: 0.0005, smagorinsky: 0.17 });

/** The tunnel around the bodies, as multiples of their length L (VS2's 凪 runs). */
export const aeroTunnel = Object.freeze({ upstream: 0.75, downstream: 1.75, side: 0.6, top: 0.45 });

/** The kernel's chordal deflection for a body's surface in a tunnel of `cellMm` cells. */
export const aeroDeflectionMm = (cellMm: number) => Math.min(10, Math.max(0.5, cellMm / 4));

const bounds = (p: Float64Array) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, p[i + a]!);
      hi[a] = Math.max(hi[a]!, p[i + a]!);
    }
  return { lo, hi };
};

/**
 * The area the bodies show the wind from ahead (mm²), on a raster of `cellMm` across the wind
 * (the y–z plane after turning the bodies by the yaw). Used as the reference area unless the
 * study gives one. The raster is 5 mm, finer for a body under 250 mm across (at least 50 cells
 * over its smaller side, so a thin body still covers cells: Codex on #1182).
 */
export function frontalAreaMm2(shape: TriangleSurface, yawDeg = 0, cellMm?: number): number {
  const yaw = (yawDeg * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const p = shape.positions;
  // Across the wind: y turned by the yaw (the air comes from +x, turned towards −y when positive).
  const u = (i: number) => p[3 * i]! * s + p[3 * i + 1]! * c;
  const v = (i: number) => p[3 * i + 2]!;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < p.length / 3; i++) {
    u0 = Math.min(u0, u(i));
    u1 = Math.max(u1, u(i));
    v0 = Math.min(v0, v(i));
    v1 = Math.max(v1, v(i));
  }
  if (cellMm === undefined) {
    const small = Math.min(u1 - u0, v1 - v0);
    cellMm = small > 0 ? Math.min(5, small / 50) : 5;
  }
  const nu = Math.max(1, Math.ceil((u1 - u0) / cellMm));
  const nv = Math.max(1, Math.ceil((v1 - v0) / cellMm));
  if (nu * nv > 16_000_000) return frontalAreaMm2(shape, yawDeg, cellMm * 2);
  const hit = new Uint8Array(nu * nv);
  const t = shape.triangles;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, d] = [t[k]!, t[k + 1]!, t[k + 2]!];
    const ax = u(a),
      ay = v(a),
      bx = u(b),
      by = v(b),
      dx = u(d),
      dy = v(d);
    const area = (bx - ax) * (dy - ay) - (dx - ax) * (by - ay);
    if (area === 0) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, dx) - u0) / cellMm));
    const i1 = Math.min(nu - 1, Math.floor((Math.max(ax, bx, dx) - u0) / cellMm));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, dy) - v0) / cellMm));
    const j1 = Math.min(nv - 1, Math.floor((Math.max(ay, by, dy) - v0) / cellMm));
    for (let j = j0; j <= j1; j++) {
      const y = v0 + (j + 0.5) * cellMm;
      for (let i = i0; i <= i1; i++) {
        const x = u0 + (i + 0.5) * cellMm;
        const w0 = (bx - x) * (dy - y) - (dx - x) * (by - y);
        const w1 = (dx - x) * (ay - y) - (ax - x) * (dy - y);
        const w2 = (ax - x) * (by - y) - (bx - x) * (ay - y);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) hit[j * nu + i] = 1;
      }
    }
  }
  let n = 0;
  for (const h of hit) n += h;
  return n * cellMm * cellMm;
}

/** A body turned by the yaw so the wind runs along +x, as the browser tunnel takes it (VS2). */
function toTunnel(body: TriangleSurface, yawDeg: number): TriangleSurface {
  const yaw = (yawDeg * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const p = body.positions;
  const positions = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    // Turned by the yaw so the wind (−cos, sin, 0) runs along −x, then x → −x so it runs along +x;
    // the mirror reverses the triangles' winding, which voxelize does not use (ray parity).
    positions[i] = -(p[i]! * c - p[i + 1]! * s);
    positions[i + 1] = p[i]! * s + p[i + 1]! * c;
    positions[i + 2] = p[i + 2]!;
  }
  return { positions, triangles: body.triangles };
}

/**
 * The browser tunnel for one level: the bodies (kept apart, so overlapping ones such as wheels in
 * their arches are joined by voxelize) in a grid of `cellMm` cells with the margins of
 * `aeroTunnel`, the ground plane one cell below z = 0.
 */
export function aeroBrowserRequest(
  bodies: readonly TriangleSurface[],
  study: SimulationAeroStudy,
  cellMm: number,
): WindTunnelRequest {
  const turned = bodies.map((b) => toTunnel(b, study.aero.yawDeg));
  const yaw = (study.aero.yawDeg * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const b of turned) {
    const r = bounds(b.positions);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, r.lo[a]!);
      hi[a] = Math.max(hi[a]!, r.hi[a]!);
    }
  }
  const L = hi[0]! - lo[0]!;
  const steps = study.solver.maxIterations;
  return {
    bodies: turned,
    grid: {
      origin: [lo[0]! - aeroTunnel.upstream * L, lo[1]! - aeroTunnel.side * L, -cellMm],
      spacing: cellMm,
      dims: [
        Math.ceil(((1 + aeroTunnel.upstream + aeroTunnel.downstream) * L) / cellMm),
        Math.ceil((hi[1]! - lo[1]! + 2 * aeroTunnel.side * L) / cellMm),
        Math.ceil((hi[2]! + aeroTunnel.top * L) / cellMm) + 1,
      ],
    },
    flow: {
      ...aeroLattice,
      ground: study.aero.ground,
      // The road runs with the car (along its −x at the wind's speed along it, as on the Host),
      // turned into the tunnel: (−U cos, 0) → (U cos², −U cos sin).
      road: [aeroLattice.speed * c * c, -aeroLattice.speed * c * s],
    },
    steps,
    averageSteps: Math.max(1, Math.floor(steps / 5)),
    progressEvery: Math.max(1, Math.min(500, Math.floor(steps / 10))),
  };
}

/** The Host's job for the study (`checkAeroJob` checks it again there). */
export function aeroHostJob(
  shape: TriangleSurface,
  study: SimulationAeroStudy,
  level: number,
  referenceAreaMm2: number,
): AeroJob {
  return {
    kind: 'aero',
    surface: { positions: Array.from(shape.positions), triangles: Array.from(shape.triangles) },
    speed: study.aero.speed,
    yawDeg: study.aero.yawDeg,
    ground: study.aero.ground,
    mesh: { baseMm: study.aero.host.baseMm, level },
    iterations: study.aero.host.iterations,
    referenceAreaMm2,
  };
}

/** What a browser wind-tunnel run needs besides the kernel. */
export interface AeroRunEnvironment {
  /** The browser's WebGPU (`navigator.gpu`), when it has one; else the flow runs on the CPU. */
  gpu?: GpuLike;
}

/** One level of a wind-tunnel run, before it becomes a `RunLevel`. */
export interface AeroLevelResult {
  /** The tunnel's cell (browser) or the body's refined cell (Host), mm. */
  cellMm: number;
  /** Fluid cells of the browser tunnel (all its cells when it blew up); the Host's background cells. */
  cells: number;
  triangles: number;
  metrics: Partial<Record<SimulationMetric, number>>;
  checks: RunCheck[];
  /** VS4c: what the level shows (none when the flow blew up). */
  fields?: AeroRunFields;
}

/** The cell of browser level `level` (each level a factor √½ finer, as the meshes' levels). */
export const aeroBrowserCellMm = (study: SimulationAeroStudy, level: number) =>
  study.aero.browserCellMm * Math.SQRT1_2 ** level;

/**
 * The Host level of convergence level `level` of `levels`: the study's own at the finest, one
 * refinement level fewer for each coarser one (at least 0).
 */
export const aeroHostLevel = (study: SimulationAeroStudy, level: number, levels: number) =>
  Math.max(0, study.aero.host.level - (levels - 1 - level));

const coefficients = (cd: number, cl: number, cs: number) => ({
  'drag-coefficient': cd,
  'lift-coefficient': cl,
  'side-force-coefficient': cs,
});

/**
 * One level in the browser: the coefficients on the study's reference area (else `frontalMm2`,
 * the bodies' own), a flow that blows up as a failed `solver` check without them.
 */
export async function runAeroBrowserLevel(
  bodies: readonly TriangleSurface[],
  study: SimulationAeroStudy,
  cellMm: number,
  frontalMm2: number,
  options: { gpu?: GpuLike; onProgress?(p: WindTunnelProgress): void; pause?(): Promise<void> },
): Promise<AeroLevelResult> {
  const triangles = bodies.reduce((n, b) => n + b.triangles.length / 3, 0);
  const area = study.aero.referenceAreaMm2 ?? frontalMm2;
  const request = aeroBrowserRequest(bodies, study, cellMm);
  try {
    const r = await runWindTunnel(request, {
      ...(options.gpu ? { gpu: options.gpu } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.pause ? { pause: options.pause } : {}),
    });
    // The tunnel's coefficients are on its own (cell) frontal area.
    const scale = r.frontalAreaMm2 / area;
    // VS4c: Cp on the bodies (per triangle in the tunnel, the same triangles as the vehicle's),
    // and the mean velocity as a share of the inflow.
    const shape = mergeSurfaces([...bodies]);
    const pressure = surfacePressure(
      mergeSurfaces(request.bodies),
      { grid: request.grid, solid: r.solid } as Parameters<typeof surfacePressure>[1],
      r.rho,
      aeroLattice.speed,
      r.referenceDensity,
    );
    const velocity = new Float32Array(r.velocity.length);
    for (let i = 0; i < velocity.length; i++) velocity[i] = r.velocity[i]! / aeroLattice.speed;
    const fields: AeroRunFields = {
      kind: 'aero',
      points: shape.positions,
      triangles: shape.triangles,
      cp: triangleToPoint(shape.positions, shape.triangles, pressure.triangles),
      flow: { grid: request.grid, velocity, solid: r.solid, yawDeg: study.aero.yawDeg },
    };
    let fluid = 0;
    for (const s of r.solid) fluid += s ? 0 : 1;
    return {
      cellMm,
      cells: fluid,
      triangles,
      metrics: coefficients(r.cd * scale, r.cl * scale, r.cs * scale),
      fields,
      checks: [
        {
          name: 'solver',
          pass: true,
          detail: `LBM D3Q27 LES on ${r.backend === 'webgpu' ? 'WebGPU' : 'the CPU'}${r.gpuUnavailable ? ` (WebGPU: ${r.gpuUnavailable})` : ''}, ${request.grid.dims.join('×')} cells of ${round(cellMm)} mm, ${request.steps} steps, the last ${request.averageSteps} averaged`,
        },
      ],
    };
  } catch (e) {
    if (e instanceof CfdError && e.code === 'unstable')
      return {
        cellMm,
        cells: request.grid.dims[0] * request.grid.dims[1] * request.grid.dims[2],
        triangles,
        metrics: {},
        checks: [{ name: 'solver', pass: false, detail: e.message }],
      };
    throw e;
  }
}

/** One level on the Host: OpenFOAM's coefficients, the side force turned to the browser's sign. */
export async function runAeroHostLevel(
  shape: TriangleSurface,
  study: SimulationAeroStudy,
  hostLevel: number,
  frontalMm2: number,
  solve: (job: AeroJob) => Promise<AeroHostResult>,
): Promise<AeroLevelResult> {
  const area = study.aero.referenceAreaMm2 ?? frontalMm2;
  const r = await solve(aeroHostJob(shape, study, hostLevel, area));
  const { lo, hi } = bounds(shape.positions);
  return {
    cellMm: study.aero.host.baseMm / 2 ** hostLevel,
    // The Host gives no cell count: the background mesh's (snappyHexMesh refines it), so a
    // recorded level has a positive count (Codex on #1182).
    cells: aeroDomain(lo, hi, study.aero.host.baseMm).cells.reduce((a, b) => a * b, 1),
    triangles: shape.triangles.length / 3,
    // forceCoeffs' side axis is liftDir × dragDir: toward −y at no yaw; the browser's is +y.
    metrics: coefficients(r.cd, r.cl, -r.cs),
    // VS4c: the Host's face-centre values on the bodies' points (their nearest face).
    fields: (() => {
      const [cp, cf, htc] = nearestSamples(shape.positions, r.points, [r.cp, r.cf, r.htc]);
      return {
        kind: 'aero' as const,
        points: shape.positions,
        triangles: shape.triangles,
        cp: cp!,
        cf: cf!,
        htc: htc!,
      };
    })(),
    checks: [
      {
        name: 'solver',
        pass: true,
        detail: `OpenFOAM simpleFoam k-ω SST on the Host, refinement level ${hostLevel} of ${study.aero.host.baseMm} mm, ${r.history.length} iterations, the last fifth averaged`,
      },
    ],
  };
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * VS4d: the document with wind-tunnel study `studyId` at another yaw, for one run of a yaw sweep
 * (the document itself is not changed; the run's checks refuse a yaw out of range). Any other
 * study, or none, leaves the document as it is.
 */
export function aeroAtYaw(
  doc: SimulationDocument,
  studyId: string,
  yawDeg: number,
): SimulationDocument {
  return {
    ...doc,
    studies: doc.studies.map((s) =>
      s.id === studyId && s.kind === 'aero' ? { ...s, aero: { ...s.aero, yawDeg } } : s,
    ),
  };
}

/** The yaw angles of a sweep written as a list ("0, 5, 10"), or why not. */
export function parseYawSweep(text: string, limit: number): number[] | string {
  const parts = text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!parts.length) return 'Give one or more angles, e.g. 0, 5, 10, 15.';
  if (parts.length > 12) return 'At most 12 angles.';
  const out: number[] = [];
  for (const t of parts) {
    const v = Number(t);
    if (!Number.isFinite(v) || Math.abs(v) > limit) return `${t}: an angle within ±${limit}°.`;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}
