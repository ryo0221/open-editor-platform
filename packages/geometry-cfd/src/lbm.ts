import { CfdError } from './errors';
import * as kernel from './d3q27-kernel.generated';
import * as lattice from './lattice';

// Module-local copies: some loaders turn every use of an imported binding into a property read.
const Q = lattice.Q;
const REST = lattice.REST;
const cx = lattice.cx;
const cy = lattice.cy;
const cz = lattice.cz;
const opposite = lattice.opposite;
const weights = lattice.weights;
const equilibrium = lattice.equilibrium;
const collideD3Q27 = kernel.collideD3Q27;
import type { Voxelization } from './voxelize';

/**
 * A wind tunnel on the D3Q27 lattice (VS2, docs/cad/vehicle-simulation.md): the flow enters at
 * x = 0 with the speed U along +x and leaves at the far x end, where the density is held at 1 (a
 * pressure outlet: the velocity is carried out and the non-equilibrium part kept). The
 * sides and the top are free-slip walls; the ground is free-slip, fixed or moving with the flow
 * (a rolling road). Collision is regularised BGK (the non-equilibrium part projected on its second
 * moment) with a Smagorinsky eddy viscosity; the body is a wall with Bouzidi's linearly interpolated
 * bounce-back, and the force on it is the momentum exchanged across its links. Everything is in
 * lattice units (spacing 1, step 1, density 1).
 */
export interface FlowSetup {
  vox: Voxelization;
  /** Inflow speed in lattice units, 0 < U ≤ 0.15 (Mach ≤ 0.26). */
  speed: number;
  /** Molecular viscosity in lattice units (relaxation time τ = 3ν + ½), ν > 0. */
  viscosity: number;
  /** Smagorinsky constant (0 = none), 0 ≤ C ≤ 0.3. */
  smagorinsky: number;
  ground: 'slip' | 'fixed' | 'moving';
  /**
   * The moving ground's velocity along the grid's x and y (lattice units); by default the inflow
   * speed along x. A yawed tunnel gives the road the vehicle's direction, not the wind's.
   */
  road?: [number, number];
}

/** The moving ground's velocity (zero for a fixed one). */
export function roadVelocity(setup: Omit<FlowSetup, 'vox'>): [number, number] {
  if (setup.ground !== 'moving') return [0, 0];
  return setup.road ?? [setup.speed, 0];
}

export interface FlowState {
  step: number;
  /** Force on the body over the last step (lattice units: density × spacing⁴ / step²). */
  force: [number, number, number];
  /** Largest speed in the last collision. */
  maxSpeed: number;
}

export const flowLimits = {
  maxSpeed: 0.15,
  /** A speed past this in the field stops the run (`unstable`). */
  blowUpSpeed: 0.45,
};

/** Refuses a flow setting out of its range (`config`); the CPU and WebGPU flows share it. */
export function checkFlowSetup(setup: FlowSetup): void {
  const { speed, viscosity, smagorinsky, ground } = setup;
  if (!(speed > 0 && speed <= flowLimits.maxSpeed))
    throw new CfdError('config', `the lattice speed must be in (0, ${flowLimits.maxSpeed}]`);
  if (!(viscosity > 0 && viscosity < 1))
    throw new CfdError('config', 'the lattice viscosity must be in (0, 1)');
  if (!(smagorinsky >= 0 && smagorinsky <= 0.3))
    throw new CfdError('config', 'the Smagorinsky constant must be in [0, 0.3]');
  if (!['slip', 'fixed', 'moving'].includes(ground))
    throw new CfdError('config', `unknown ground ${String(ground)}`);
  const road = setup.road;
  if (
    road !== undefined &&
    !(
      Array.isArray(road) &&
      road.length === 2 &&
      road.every(Number.isFinite) &&
      Math.hypot(road[0], road[1]) <= flowLimits.maxSpeed
    )
  )
    throw new CfdError('config', `the road speed must be at most ${flowLimits.maxSpeed}`);
}

export class Flow {
  readonly n: number;
  readonly tau0: number;
  private f: Float32Array;
  private post: Float32Array;
  /** 1 = fluid with every neighbour fluid and inside the grid (the fast path). */
  private interior: Uint8Array;
  /** Q × (offset of the source cell) per direction, for the interior pull. */
  private shift = new Int32Array(Q);
  private stepCount = 0;
  private lastForce: [number, number, number] = [0, 0, 0];
  private lastMax = 0;
  private sum: [number, number, number] = [0, 0, 0];
  private sumSteps = 0;

  constructor(readonly setup: FlowSetup) {
    checkFlowSetup(setup);
    const { vox, speed, viscosity } = setup;
    const [nx, ny, nz] = vox.grid.dims;
    this.n = nx * ny * nz;
    this.tau0 = 3 * viscosity + 0.5;
    this.f = new Float32Array(Q * this.n);
    this.post = new Float32Array(Q * this.n);
    this.interior = new Uint8Array(this.n);
    for (let d = 0; d < Q; d++) this.shift[d] = Q * (cx[d]! + nx * (cy[d]! + ny * cz[d]!));
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j++)
        for (let i = 1; i < nx - 1; i++) {
          const c = i + nx * (j + ny * k);
          if (vox.solid[c]) continue;
          let ok = 1;
          for (let d = 0; d < Q && ok; d++)
            if (d !== REST && vox.solid[c + cx[d]! + nx * (cy[d]! + ny * cz[d]!)]) ok = 0;
          this.interior[c] = ok;
        }
    for (let c = 0; c < this.n; c++) {
      if (vox.solid[c]) continue;
      for (let d = 0; d < Q; d++) this.f[c * Q + d] = equilibrium(d, 1, speed, 0, 0);
    }
  }

  get state(): FlowState {
    return { step: this.stepCount, force: [...this.lastForce], maxSpeed: this.lastMax };
  }

  /** The force averaged since the last `resetAverage` (or the start). */
  get averageForce(): [number, number, number] {
    const s = Math.max(1, this.sumSteps);
    return [this.sum[0] / s, this.sum[1] / s, this.sum[2] / s];
  }

  get averagedSteps(): number {
    return this.sumSteps;
  }

  resetAverage(): void {
    this.sum = [0, 0, 0];
    this.sumSteps = 0;
  }

  /** Runs `count` steps (collide, then stream with the boundaries). */
  run(count: number): FlowState {
    for (let s = 0; s < count; s++) this.step();
    return this.state;
  }

  step(): void {
    this.collide();
    this.stream();
    this.stepCount++;
  }

  private collide(): void {
    const { vox, speed, smagorinsky } = this.setup;
    const [nx] = vox.grid.dims;
    const n = this.n;
    const f = this.f;
    const post = this.post;
    const tau0 = this.tau0;
    const cs = 18 * Math.SQRT2 * smagorinsky * smagorinsky;
    let maxU2 = 0;
    for (let c = 0; c < n; c++) {
      if (vox.solid[c]) continue;
      if (c % nx === 0) {
        // The inlet plane is held at equilibrium with the inflow speed.
        for (let d = 0; d < Q; d++) post[c * Q + d] = equilibrium(d, 1, speed, 0, 0);
        continue;
      }
      const u2 = collideD3Q27(f, post, c * Q, tau0, cs);
      if (u2 > maxU2) maxU2 = u2;
      else if (!(u2 === u2)) {
        // Not a number: the run stops below, whatever the cells after this one give.
        maxU2 = NaN;
        break;
      }
    }
    this.lastMax = Math.sqrt(maxU2);
    if (!(this.lastMax <= flowLimits.blowUpSpeed))
      throw new CfdError(
        'unstable',
        `speed ${this.lastMax} at step ${this.stepCount} (refine the grid, lower the speed or raise the viscosity)`,
      );
  }

  private stream(): void {
    const { vox, speed, ground } = this.setup;
    const [nx, ny, nz] = vox.grid.dims;
    const f = this.f;
    const post = this.post;
    const solid = vox.solid;
    const links = vox.links;
    let fx = 0,
      fy = 0,
      fz = 0;
    const [wallX, wallY] = roadVelocity(this.setup);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 1; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          if (solid[c]) continue;
          if (this.interior[c]) {
            for (let d = 0; d < Q; d++) f[c * Q + d] = post[c * Q + d - this.shift[d]!]!;
            continue;
          }
          for (let d = 0; d < Q; d++) {
            let si = i - cx[d]!,
              sj = j - cy[d]!,
              sk = k - cz[d]!;
            let e = d;
            if (si >= nx) si = nx - 1;
            if (sk < 0 && ground !== 'slip') {
              // Half-way bounce-back on the ground, moving with the road when asked.
              const o = opposite[d]!;
              f[c * Q + d] = post[c * Q + o]! + 6 * weights[d]! * (cx[d]! * wallX + cy[d]! * wallY);
              continue;
            }
            const ex = cx[d]!;
            let ey = cy[d]!,
              ez = cz[d]!;
            if (sj < 0 || sj >= ny) {
              ey = -ey;
              sj = j;
            }
            if (sk < 0 || sk >= nz) {
              ez = -ez;
              sk = k;
            }
            if (ey !== cy[d] || ez !== cz[d]) e = (ez + 1) * 9 + (ey + 1) * 3 + (ex + 1);
            const s = si + nx * (sj + ny * sk);
            if (!solid[s]) {
              f[c * Q + d] = post[s * Q + e]!;
              continue;
            }
            if (e !== d) {
              // A reflected population whose source is in the body: plain bounce-back.
              f[c * Q + d] = post[c * Q + opposite[d]!]!;
              continue;
            }
            // A link into the body: interpolated bounce-back (Bouzidi), q measured from c.
            const o = opposite[d]!;
            const q = links.get(c * Q + o) ?? 0.5;
            let v: number;
            if (q < 0.5) {
              const fi = i + cx[d]!,
                fj = j + cy[d]!,
                fk = k + cz[d]!;
              const far =
                fi >= 0 && fj >= 0 && fk >= 0 && fi < nx && fj < ny && fk < nz
                  ? fi + nx * (fj + ny * fk)
                  : -1;
              const behind = far >= 0 && !solid[far] ? post[far * Q + o]! : post[c * Q + o]!;
              v = 2 * q * post[c * Q + o]! + (1 - 2 * q) * behind;
            } else {
              v = (1 / (2 * q)) * post[c * Q + o]! + ((2 * q - 1) / (2 * q)) * post[c * Q + d]!;
            }
            f[c * Q + d] = v;
            // Momentum given to the body along c_o = −c_d.
            const m = post[c * Q + o]! + v;
            fx -= m * cx[d]!;
            fy -= m * cy[d]!;
            fz -= m * cz[d]!;
          }
        }
    // The inlet plane keeps its equilibrium.
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) {
        const c = nx * (j + ny * k);
        if (solid[c]) continue;
        for (let d = 0; d < Q; d++) f[c * Q + d] = equilibrium(d, 1, speed, 0, 0);
      }
    // The outlet plane is held at density 1 with its own velocity, keeping the non-equilibrium
    // part, so the mass the body pushes back does not pile up in the tunnel (VS2b: without it the
    // density drifted and every Cp read below −1 on F95).
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) {
        const c = nx - 1 + nx * (j + ny * k);
        if (solid[c]) continue;
        let r = 0,
          jx = 0,
          jy = 0,
          jz = 0;
        for (let d = 0; d < Q; d++) {
          const v = f[c * Q + d]!;
          r += v;
          jx += v * cx[d]!;
          jy += v * cy[d]!;
          jz += v * cz[d]!;
        }
        const ux = jx / r,
          uy = jy / r,
          uz = jz / r;
        for (let d = 0; d < Q; d++)
          f[c * Q + d] =
            f[c * Q + d]! + equilibrium(d, 1, ux, uy, uz) - equilibrium(d, r, ux, uy, uz);
      }
    this.lastForce = [fx, fy, fz];
    this.sum[0] += fx;
    this.sum[1] += fy;
    this.sum[2] += fz;
    this.sumSteps++;
  }

  /** Density and velocity of every cell (solid cells: density 1, velocity 0). */
  fields(): { rho: Float32Array; velocity: Float32Array } {
    const n = this.n;
    const rho = new Float32Array(n);
    const velocity = new Float32Array(3 * n);
    for (let c = 0; c < n; c++) {
      if (this.setup.vox.solid[c]) {
        rho[c] = 1;
        continue;
      }
      let r = 0,
        jx = 0,
        jy = 0,
        jz = 0;
      for (let d = 0; d < Q; d++) {
        const v = this.f[c * Q + d]!;
        r += v;
        jx += v * cx[d]!;
        jy += v * cy[d]!;
        jz += v * cz[d]!;
      }
      rho[c] = r;
      velocity[3 * c] = jx / r;
      velocity[3 * c + 1] = jy / r;
      velocity[3 * c + 2] = jz / r;
    }
    return { rho, velocity };
  }

  /**
   * The far-field density for Cp: the mean over the fluid cells of the plane next to the inlet,
   * where the flow has not met the body yet (the outlet holds 1; the inlet side carries the
   * tunnel's pressure drop on top).
   */
  referenceDensity(): number {
    const [nx, ny, nz] = this.setup.vox.grid.dims;
    let sum = 0,
      count = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) {
        const c = 1 + nx * (j + ny * k);
        if (this.setup.vox.solid[c]) continue;
        for (let d = 0; d < Q; d++) sum += this.f[c * Q + d]!;
        count++;
      }
    return count ? sum / count : 1;
  }

  /** Total mass of the fluid (lattice units). */
  mass(): number {
    let m = 0;
    for (let c = 0; c < this.n; c++)
      if (!this.setup.vox.solid[c]) for (let d = 0; d < Q; d++) m += this.f[c * Q + d]!;
    return m;
  }
}

/** Force coefficient F / (½ ρ U² A) with A in cells² (frontal area ÷ spacing²). */
export function forceCoefficient(force: number, speed: number, areaCells: number): number {
  return force / (0.5 * speed * speed * areaCells);
}
