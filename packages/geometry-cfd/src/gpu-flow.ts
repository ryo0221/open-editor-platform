import { collideD3Q27Wgsl } from './d3q27-wgsl.generated';
import { CfdError } from './errors';
import * as lattice from './lattice';
import { checkFlowSetup, flowLimits, roadVelocity, type FlowSetup, type FlowState } from './lbm';

const Q = lattice.Q;
const cx = lattice.cx;
const cy = lattice.cy;
const cz = lattice.cz;
const equilibrium = lattice.equilibrium;

/**
 * The flow of `Flow` (lbm.ts) on WebGPU (VS2b-3, docs/cad/vehicle-simulation.md): the same
 * collision (generated from the same source), the same streaming with the same walls, inlet,
 * outlet and ground, and the same momentum exchange, in single precision on the GPU. The force of
 * every step is reduced on the GPU and read back per `run`; the fields are read back on request.
 *
 * The WebGPU objects are typed here by the few members this file uses (TypeScript's DOM library
 * has no WebGPU yet), so any WebGPU device fits.
 */

// The members of WebGPU used below.
interface GpuBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
interface GpuPass {
  setPipeline(p: unknown): void;
  setBindGroup(i: number, g: unknown): void;
  dispatchWorkgroups(x: number): void;
  end(): void;
}
interface GpuEncoder {
  beginComputePass(): GpuPass;
  copyBufferToBuffer(a: GpuBuffer, ao: number, b: GpuBuffer, bo: number, size: number): void;
  finish(): unknown;
}
export interface GpuDeviceLike {
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
  queue: {
    writeBuffer(b: GpuBuffer, offset: number, data: ArrayBufferView): void;
    submit(list: unknown[]): void;
    onSubmittedWorkDone(): Promise<void>;
  };
  createBuffer(d: { size: number; usage: number }): GpuBuffer;
  createShaderModule(d: { code: string }): unknown;
  createComputePipeline(d: { layout: 'auto'; compute: { module: unknown; entryPoint: string } }): {
    getBindGroupLayout(i: number): unknown;
  };
  createBindGroup(d: {
    layout: unknown;
    entries: { binding: number; resource: { buffer: GpuBuffer } }[];
  }): unknown;
  createCommandEncoder(): GpuEncoder;
  destroy(): void;
  lost?: Promise<{ message: string }>;
}
export interface GpuLike {
  requestAdapter(): Promise<{
    limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
    requestDevice(d?: { requiredLimits?: Record<string, number> }): Promise<GpuDeviceLike>;
  } | null>;
}

const STORAGE = 0x80,
  COPY_SRC = 0x4,
  COPY_DST = 0x8,
  UNIFORM = 0x40,
  MAP_READ = 0x1;
/** Waits for a read buffer; a failure there means the device is gone (`gpu-unavailable`). */
const mapped = async (read: GpuBuffer) => {
  try {
    await read.mapAsync(MAP_READ);
  } catch (e) {
    throw new CfdError(
      'gpu-unavailable',
      `the GPU stopped during the run (${e instanceof Error ? e.message : String(e)})`,
    );
  }
};

const WG = 64;
/** Steps one `run` can record (force and largest speed per step). */
const maxChunk = 4096;
/** Steps in one queue submission. */
const perSubmit = 8;
const NONE = 0xffffffff;

const common = /* wgsl */ `
struct Params {
  nx: u32, ny: u32, nz: u32, n: u32,
  speed: f32, tau0: f32, cs: f32, wall: f32,
  ground: u32, groups: u32, wallY: f32, pad1: u32,
};
fn cxOf(d: u32) -> i32 { return i32(d % 3u) - 1; }
fn cyOf(d: u32) -> i32 { return i32((d / 3u) % 3u) - 1; }
fn czOf(d: u32) -> i32 { return i32(d / 9u) - 1; }
fn wOf(d: u32) -> f32 {
  let m = abs(cxOf(d)) + abs(cyOf(d)) + abs(czOf(d));
  if (m == 0) { return 8.0 / 27.0; }
  if (m == 1) { return 2.0 / 27.0; }
  if (m == 2) { return 1.0 / 54.0; }
  return 1.0 / 216.0;
}
fn feq(d: u32, rho: f32, ux: f32, uy: f32, uz: f32) -> f32 {
  let cu = f32(cxOf(d)) * ux + f32(cyOf(d)) * uy + f32(czOf(d)) * uz;
  return wOf(d) * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * (ux * ux + uy * uy + uz * uz));
}
`;

const collideShader = /* wgsl */ `
${common}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> fin: array<f32>;
@group(0) @binding(2) var<storage, read_write> post: array<f32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<storage, read_write> maxBits: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> counter: array<u32>;
var<workgroup> groupMax: atomic<u32>;
${collideD3Q27Wgsl}
fn cell(c: u32) -> f32 {
  if (c >= P.n || solid[c] != 0u) { return 0.0; }
  if (c % P.nx == 0u) {
    for (var d = 0u; d < 27u; d++) { post[c * 27u + d] = feq(d, 1.0, P.speed, 0.0, 0.0); }
    return 0.0;
  }
  return collide(c * 27u, P.tau0, P.cs);
}
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&groupMax, 0u); }
  workgroupBarrier();
  let u2 = cell(gid.x);
  // u² ≥ 0, so its bits order as the values; a NaN's bits are above every finite value's.
  atomicMax(&groupMax, bitcast<u32>(u2) & 0x7fffffffu);
  workgroupBarrier();
  if (li == 0u) { atomicMax(&maxBits[counter[0]], atomicLoad(&groupMax)); }
}
`;

const streamShader = /* wgsl */ `
${common}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<storage, read> wallIndex: array<u32>;
@group(0) @binding(5) var<storage, read> wallQ: array<f32>;
@group(0) @binding(6) var<storage, read_write> partial: array<f32>;
var<workgroup> sums: array<vec3<f32>, ${WG}>;
fn isSolid(i: i32, j: i32, k: i32) -> bool {
  return solid[u32(i) + P.nx * (u32(j) + P.ny * u32(k))] != 0u;
}
fn cell(c: u32) -> vec3<f32> {
  var force = vec3<f32>(0.0);
  if (c >= P.n || solid[c] != 0u) { return force; }
  let nx = i32(P.nx); let ny = i32(P.ny); let nz = i32(P.nz);
  let i = i32(c % P.nx); let j = i32((c / P.nx) % P.ny); let k = i32(c / (P.nx * P.ny));
  if (i == 0) {
    // The inlet plane keeps its equilibrium.
    for (var d = 0u; d < 27u; d++) { dst[c * 27u + d] = feq(d, 1.0, P.speed, 0.0, 0.0); }
    return force;
  }
  for (var d = 0u; d < 27u; d++) {
    let ex = cxOf(d);
    var ey = cyOf(d);
    var ez = czOf(d);
    var si = i - ex; var sj = j - ey; var sk = k - ez;
    let o = 26u - d;
    if (si >= nx) { si = nx - 1; }
    if (sk < 0 && P.ground != 0u) {
      // Half-way bounce-back on the ground, moving with the road when asked.
      dst[c * 27u + d] = src[c * 27u + o] + 6.0 * wOf(d) * (f32(ex) * P.wall + f32(cyOf(d)) * P.wallY);
      continue;
    }
    if (sj < 0 || sj >= ny) { ey = -ey; sj = j; }
    if (sk < 0 || sk >= nz) { ez = -ez; sk = k; }
    var e = d;
    if (ey != cyOf(d) || ez != czOf(d)) { e = u32((ez + 1) * 9 + (ey + 1) * 3 + (ex + 1)); }
    let s = u32(si) + P.nx * (u32(sj) + P.ny * u32(sk));
    if (solid[s] == 0u) { dst[c * 27u + d] = src[s * 27u + e]; continue; }
    if (e != d) {
      // A reflected population whose source is in the body: plain bounce-back.
      dst[c * 27u + d] = src[c * 27u + o];
      continue;
    }
    // A link into the body: interpolated bounce-back (Bouzidi), q measured from c.
    var q = 0.5;
    let slot = wallIndex[c];
    if (slot != ${NONE}u) { let v = wallQ[slot * 27u + o]; if (v > 0.0) { q = v; } }
    var v: f32;
    if (q < 0.5) {
      let fi = i + ex; let fj = j + cyOf(d); let fk = k + czOf(d);
      var behind = src[c * 27u + o];
      if (fi >= 0 && fj >= 0 && fk >= 0 && fi < nx && fj < ny && fk < nz && !isSolid(fi, fj, fk)) {
        behind = src[(u32(fi) + P.nx * (u32(fj) + P.ny * u32(fk))) * 27u + o];
      }
      v = 2.0 * q * src[c * 27u + o] + (1.0 - 2.0 * q) * behind;
    } else {
      v = (1.0 / (2.0 * q)) * src[c * 27u + o] + ((2.0 * q - 1.0) / (2.0 * q)) * src[c * 27u + d];
    }
    dst[c * 27u + d] = v;
    // Momentum given to the body along c_o = −c_d.
    let m = src[c * 27u + o] + v;
    force -= m * vec3<f32>(f32(cxOf(d)), f32(cyOf(d)), f32(czOf(d)));
  }
  if (i == nx - 1) {
    // The outlet plane is held at density 1 with its own velocity, keeping the non-equilibrium part.
    var r = 0.0; var jx = 0.0; var jy = 0.0; var jz = 0.0;
    for (var d = 0u; d < 27u; d++) {
      let v = dst[c * 27u + d];
      r += v; jx += v * f32(cxOf(d)); jy += v * f32(cyOf(d)); jz += v * f32(czOf(d));
    }
    let ux = jx / r; let uy = jy / r; let uz = jz / r;
    for (var d = 0u; d < 27u; d++) {
      dst[c * 27u + d] = dst[c * 27u + d] + feq(d, 1.0, ux, uy, uz) - feq(d, r, ux, uy, uz);
    }
  }
  return force;
}
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32,
        @builtin(workgroup_id) wid: vec3<u32>) {
  sums[li] = cell(gid.x);
  workgroupBarrier();
  for (var s = ${WG / 2}u; s > 0u; s = s / 2u) {
    if (li < s) { sums[li] = sums[li] + sums[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    partial[wid.x * 3u] = sums[0].x;
    partial[wid.x * 3u + 1u] = sums[0].y;
    partial[wid.x * 3u + 2u] = sums[0].z;
  }
}
`;

const reduceShader = /* wgsl */ `
${common}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> partial: array<f32>;
@group(0) @binding(2) var<storage, read_write> forces: array<f32>;
@group(0) @binding(3) var<storage, read_write> counter: array<u32>;
var<workgroup> sums: array<vec3<f32>, ${WG}>;
@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_index) li: u32) {
  var s = vec3<f32>(0.0);
  for (var g = li; g < P.groups; g += ${WG}u) {
    s += vec3<f32>(partial[g * 3u], partial[g * 3u + 1u], partial[g * 3u + 2u]);
  }
  sums[li] = s;
  workgroupBarrier();
  for (var h = ${WG / 2}u; h > 0u; h = h / 2u) {
    if (li < h) { sums[li] = sums[li] + sums[li + h]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    let step = counter[0];
    forces[step * 3u] = sums[0].x;
    forces[step * 3u + 1u] = sums[0].y;
    forces[step * 3u + 2u] = sums[0].z;
    counter[0] = step + 1u;
  }
}
`;

/** Bytes a WebGPU flow on `cells` cells needs in its largest buffer (the populations). */
export const gpuFlowBytes = (cells: number) => cells * Q * 4;

/**
 * Asks `gpu` for a device that holds a flow of `cells` cells. Throws `gpu-unavailable` with the
 * reason when there is no adapter, or its buffers are too small.
 */
export async function requestFlowDevice(gpu: GpuLike, cells: number): Promise<GpuDeviceLike> {
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new CfdError('gpu-unavailable', 'the browser offers no WebGPU adapter');
  const need = gpuFlowBytes(cells);
  const { maxStorageBufferBindingSize, maxBufferSize } = adapter.limits;
  if (need > maxStorageBufferBindingSize || need > maxBufferSize)
    throw new CfdError(
      'gpu-unavailable',
      `the grid needs ${Math.ceil(need / 2 ** 20)} MiB buffers; the GPU allows ${Math.floor(Math.min(maxStorageBufferBindingSize, maxBufferSize) / 2 ** 20)} MiB`,
    );
  return adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: need, maxBufferSize: need },
  });
}

export class GpuFlow {
  readonly n: number;
  private readonly groups: number;
  private readonly buffers: GpuBuffer[] = [];
  private readonly f: GpuBuffer;
  private readonly forces: GpuBuffer;
  private readonly maxBits: GpuBuffer;
  private readonly counter: GpuBuffer;
  private readonly steps: unknown[];
  private stepCount = 0;
  private lastForce: [number, number, number] = [0, 0, 0];
  private lastMax = 0;
  private sum: [number, number, number] = [0, 0, 0];
  private sumSteps = 0;

  constructor(
    readonly setup: FlowSetup,
    private readonly device: GpuDeviceLike,
  ) {
    checkFlowSetup(setup);
    const { vox, speed, viscosity, smagorinsky, ground } = setup;
    const [nx, ny, nz] = vox.grid.dims;
    this.n = nx * ny * nz;
    this.groups = Math.ceil(this.n / WG);
    const bytes = gpuFlowBytes(this.n);
    if (bytes > device.limits.maxStorageBufferBindingSize)
      throw new CfdError('gpu-unavailable', 'the device buffers are too small for this grid');
    const buffer = (size: number, usage: number) => {
      const b = device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
      this.buffers.push(b);
      return b;
    };
    const params = buffer(48, UNIFORM | COPY_DST);
    const p = new ArrayBuffer(48);
    const pu = new Uint32Array(p),
      pf = new Float32Array(p);
    pu[0] = nx;
    pu[1] = ny;
    pu[2] = nz;
    pu[3] = this.n;
    pf[4] = speed;
    pf[5] = 3 * viscosity + 0.5;
    pf[6] = 18 * Math.SQRT2 * smagorinsky * smagorinsky;
    const road = roadVelocity(setup);
    pf[7] = road[0];
    pu[8] = ground === 'slip' ? 0 : ground === 'fixed' ? 1 : 2;
    pu[9] = this.groups;
    pf[10] = road[1];
    device.queue.writeBuffer(params, 0, pu);
    // The populations start at the inflow's equilibrium, as on the CPU.
    const f0 = new Float32Array(this.n * Q);
    const eq = Array.from({ length: Q }, (_, d) => equilibrium(d, 1, speed, 0, 0));
    for (let c = 0; c < this.n; c++)
      if (!vox.solid[c]) for (let d = 0; d < Q; d++) f0[c * Q + d] = eq[d]!;
    this.f = buffer(bytes, STORAGE | COPY_SRC | COPY_DST);
    device.queue.writeBuffer(this.f, 0, f0);
    const post = buffer(bytes, STORAGE | COPY_SRC);
    const solid = buffer(this.n * 4, STORAGE | COPY_DST);
    device.queue.writeBuffer(solid, 0, Uint32Array.from(vox.solid));
    // The wall fractions of the cells next to the body, 27 per such cell (−1 = no link: ½).
    const wallIndex = new Uint32Array(this.n).fill(NONE);
    const slots: number[] = [];
    for (const key of vox.links.keys()) {
      const c = Math.floor(key / Q);
      if (wallIndex[c] === NONE) {
        wallIndex[c] = slots.length;
        slots.push(c);
      }
    }
    const wallQ = new Float32Array(Math.max(1, slots.length) * Q).fill(-1);
    for (const [key, q] of vox.links) wallQ[wallIndex[Math.floor(key / Q)]! * Q + (key % Q)] = q;
    const wallIndexBuffer = buffer(this.n * 4, STORAGE | COPY_DST);
    device.queue.writeBuffer(wallIndexBuffer, 0, wallIndex);
    const wallQBuffer = buffer(wallQ.length * 4, STORAGE | COPY_DST);
    device.queue.writeBuffer(wallQBuffer, 0, wallQ);
    const partial = buffer(this.groups * 12, STORAGE);
    this.forces = buffer(maxChunk * 12, STORAGE | COPY_SRC);
    this.maxBits = buffer(maxChunk * 4, STORAGE | COPY_SRC | COPY_DST);
    this.counter = buffer(4, STORAGE | COPY_DST);
    const pipeline = (code: string) =>
      device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      });
    const group = (pipe: { getBindGroupLayout(i: number): unknown }, list: GpuBuffer[]) =>
      device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: list.map((b, binding) => ({ binding, resource: { buffer: b } })),
      });
    const collide = pipeline(collideShader);
    const stream = pipeline(streamShader);
    const reduce = pipeline(reduceShader);
    this.steps = [
      [
        collide,
        group(collide, [params, this.f, post, solid, this.maxBits, this.counter]),
        this.groups,
      ],
      [
        stream,
        group(stream, [params, post, this.f, solid, wallIndexBuffer, wallQBuffer, partial]),
        this.groups,
      ],
      [reduce, group(reduce, [params, partial, this.forces, this.counter]), 1],
    ];
  }

  get state(): FlowState {
    return { step: this.stepCount, force: [...this.lastForce], maxSpeed: this.lastMax };
  }

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

  /** Runs `count` steps; resolves when the GPU has done them and their forces are read. */
  async run(count: number): Promise<FlowState> {
    for (let done = 0; done < count; ) {
      const chunk = Math.min(maxChunk, count - done);
      await this.chunk(chunk);
      done += chunk;
    }
    return this.state;
  }

  private async chunk(count: number): Promise<void> {
    const { device } = this;
    device.queue.writeBuffer(this.counter, 0, new Uint32Array([0]));
    device.queue.writeBuffer(this.maxBits, 0, new Uint32Array(count));
    // A few steps per submission, so no single one runs long enough for a driver's watchdog.
    for (let s0 = 0; s0 < count; s0 += perSubmit) {
      const encoder = device.createCommandEncoder();
      for (let s = s0; s < Math.min(count, s0 + perSubmit); s++)
        for (const [pipe, bind, groups] of this.steps as [unknown, unknown, number][]) {
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipe);
          pass.setBindGroup(0, bind);
          pass.dispatchWorkgroups(groups);
          pass.end();
        }
      device.queue.submit([encoder.finish()]);
    }
    const encoder = device.createCommandEncoder();
    const read = device.createBuffer({ size: count * 16, usage: MAP_READ | COPY_DST });
    encoder.copyBufferToBuffer(this.forces, 0, read, 0, count * 12);
    encoder.copyBufferToBuffer(this.maxBits, 0, read, count * 12, count * 4);
    device.queue.submit([encoder.finish()]);
    await mapped(read);
    const data = read.getMappedRange().slice(0);
    read.unmap();
    read.destroy();
    const forces = new Float32Array(data, 0, count * 3);
    const bits = new Float32Array(data, count * 12, count);
    for (let s = 0; s < count; s++) {
      const u = Math.sqrt(bits[s]!);
      if (!(u <= flowLimits.blowUpSpeed))
        throw new CfdError(
          'unstable',
          `speed ${u} at step ${this.stepCount + s} (refine the grid, lower the speed or raise the viscosity)`,
        );
      this.lastMax = u;
      this.lastForce = [forces[3 * s]!, forces[3 * s + 1]!, forces[3 * s + 2]!];
      this.sum[0] += forces[3 * s]!;
      this.sum[1] += forces[3 * s + 1]!;
      this.sum[2] += forces[3 * s + 2]!;
      this.sumSteps++;
    }
    this.stepCount += count;
  }

  /** The populations, read back from the GPU. */
  private async populations(): Promise<Float32Array> {
    const size = gpuFlowBytes(this.n);
    const read = this.device.createBuffer({ size, usage: MAP_READ | COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.f, 0, read, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await mapped(read);
    const f = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    read.destroy();
    return f;
  }

  /** Density and velocity of every cell (solid cells: density 1, velocity 0), as `Flow.fields`. */
  async fields(): Promise<{ rho: Float32Array; velocity: Float32Array; referenceDensity: number }> {
    const f = await this.populations();
    const { solid, grid } = this.setup.vox;
    const [nx, ny, nz] = grid.dims;
    const rho = new Float32Array(this.n);
    const velocity = new Float32Array(3 * this.n);
    for (let c = 0; c < this.n; c++) {
      if (solid[c]) {
        rho[c] = 1;
        continue;
      }
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
      rho[c] = r;
      velocity[3 * c] = jx / r;
      velocity[3 * c + 1] = jy / r;
      velocity[3 * c + 2] = jz / r;
    }
    // The far-field density: the plane next to the inlet, as `Flow.referenceDensity`.
    let sum = 0,
      count = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) {
        const c = 1 + nx * (j + ny * k);
        if (solid[c]) continue;
        sum += rho[c]!;
        count++;
      }
    return { rho, velocity, referenceDensity: count ? sum / count : 1 };
  }

  /** Frees the GPU buffers (the device stays the caller's). */
  dispose(): void {
    for (const b of this.buffers) b.destroy();
    this.buffers.length = 0;
  }
}
