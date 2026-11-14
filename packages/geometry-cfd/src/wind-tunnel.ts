import { CfdError } from './errors';
import { GpuFlow, requestFlowDevice, type GpuDeviceLike, type GpuLike } from './gpu-flow';
import { Flow, forceCoefficient, type FlowSetup, type FlowState } from './lbm';
import { frontalArea, voxelize, type Grid, type TriangleSurface } from './voxelize';

/**
 * One browser wind-tunnel run (VS2b, docs/cad/vehicle-simulation.md): the closed surfaces are
 * made into cells, the flow runs `steps`, and the force is averaged over the last
 * `averageSteps`. Plain data, so a worker can receive it.
 */
export interface WindTunnelRequest {
  bodies: TriangleSurface[];
  grid: Grid;
  flow: Omit<FlowSetup, 'vox'>;
  steps: number;
  averageSteps: number;
  /** Steps between progress reports (and between yields to the caller's event loop). */
  progressEvery?: number;
  /** `auto` (the default) uses WebGPU when the caller has it and the grid fits, else the CPU. */
  backend?: 'auto' | 'cpu';
}

export interface WindTunnelProgress {
  step: number;
  steps: number;
  /** Coefficients of the force averaged since the last report. */
  cd: number;
  cl: number;
  cs: number;
  maxSpeed: number;
}

export interface WindTunnelResult {
  /** Drag (x), side (y) and lift (z) coefficients over the last `averageSteps`, on the frontal area. */
  cd: number;
  cs: number;
  cl: number;
  frontalAreaMm2: number;
  /** Mean density and velocity of the last `averageSteps` (lattice units), for Cp and streamlines. */
  rho: Float32Array;
  velocity: Float32Array;
  /** The far-field density Cp is measured against (`Flow.referenceDensity`). */
  referenceDensity: number;
  /** 1 where the cell is in a body, as `voxelize` gives it. */
  solid: Uint8Array;
  history: WindTunnelProgress[];
  /** Where it ran; with `gpuUnavailable`, why WebGPU was not used although it was asked for. */
  backend: 'webgpu' | 'cpu';
  gpuUnavailable?: string;
}

/** What a run needs of a flow, on the CPU (`Flow`) or the GPU (`GpuFlow`). */
interface RunningFlow {
  run(count: number): unknown;
  readonly averageForce: [number, number, number];
  readonly state: FlowState;
  resetAverage(): void;
  fields(): Promise<{ rho: Float32Array; velocity: Float32Array; referenceDensity: number }>;
  dispose(): void;
}

const onCpu = (flow: Flow): RunningFlow => ({
  run: (count) => flow.run(count),
  get averageForce() {
    return flow.averageForce;
  },
  get state() {
    return flow.state;
  },
  resetAverage: () => flow.resetAverage(),
  fields: async () => ({ ...flow.fields(), referenceDensity: flow.referenceDensity() }),
  dispose: () => undefined,
});

const coefficients = (flow: RunningFlow, speed: number, areaCells: number) => {
  const [fx, fy, fz] = flow.averageForce;
  return {
    cd: forceCoefficient(fx, speed, areaCells),
    cs: forceCoefficient(fy, speed, areaCells),
    cl: forceCoefficient(fz, speed, areaCells),
  };
};

/**
 * Runs `request`, reporting progress every `progressEvery` steps and then awaiting `pause()`
 * (a worker passes nothing; the page's fallback passes a yield to its event loop). Stops with
 * `cancelled` when `signal` aborts between chunks. With `gpu` (and `backend` not `cpu`) it runs on
 * WebGPU when an adapter holds the grid, else on the CPU, and says why in `gpuUnavailable`.
 * Errors are `CfdError`s (`config`, `grid-too-large`, `body-outside`, `surface-open`, `unstable`, …).
 */
export async function runWindTunnel(
  request: WindTunnelRequest,
  options: {
    onProgress?: (p: WindTunnelProgress) => void;
    pause?: () => Promise<void>;
    signal?: AbortSignal;
    /** The browser's WebGPU (`navigator.gpu`), when it has one. */
    gpu?: GpuLike;
  } = {},
): Promise<WindTunnelResult> {
  const { steps, averageSteps } = request;
  if (!(Number.isInteger(steps) && steps > 0))
    throw new CfdError('config', 'steps must be a positive whole number');
  if (!(Number.isInteger(averageSteps) && averageSteps > 0 && averageSteps <= steps))
    throw new CfdError('config', 'averageSteps must be a whole number in [1, steps]');
  const every = request.progressEvery ?? 100;
  if (!(Number.isInteger(every) && every > 0))
    throw new CfdError('config', 'progressEvery must be a positive whole number');
  const vox = voxelize(request.bodies, request.grid);
  const area = frontalArea(vox);
  if (!(area > 0)) throw new CfdError('config', 'the bodies have no frontal area on this grid');
  const setup = { ...request.flow, vox };
  let flow: GpuFlow | undefined;
  let device: GpuDeviceLike | undefined;
  let gpuUnavailable: string | undefined;
  if (options.gpu && request.backend !== 'cpu') {
    try {
      device = await requestFlowDevice(options.gpu, vox.solid.length);
      flow = new GpuFlow(setup, device);
    } catch (e) {
      device?.destroy();
      device = undefined;
      // A setting out of range is refused the same on the CPU; anything else falls back to it.
      if (e instanceof CfdError && e.code === 'config') throw e;
      gpuUnavailable = e instanceof Error ? e.message : String(e);
    }
  }
  if (flow) {
    try {
      return await runFlow(flow, request, vox, area, options, 'webgpu', undefined);
    } catch (e) {
      // The GPU went away during the run (a lost device, a reset): the run starts again on the
      // CPU, and says why. Cancelling, divergence and every other error stop the run as they are.
      if (!(e instanceof CfdError && e.code === 'gpu-unavailable')) throw e;
      gpuUnavailable = e.message;
    } finally {
      flow.dispose();
      device?.destroy();
    }
  }
  return runFlow(onCpu(new Flow(setup)), request, vox, area, options, 'cpu', gpuUnavailable);
}

async function runFlow(
  flow: RunningFlow,
  request: WindTunnelRequest,
  vox: ReturnType<typeof voxelize>,
  area: number,
  options: Parameters<typeof runWindTunnel>[1] & object,
  backend: 'webgpu' | 'cpu',
  gpuUnavailable: string | undefined,
): Promise<WindTunnelResult> {
  const { steps, averageSteps } = request;
  const every = request.progressEvery ?? 100;
  const h = request.grid.spacing;
  const areaCells = area / (h * h);
  const speed = request.flow.speed;
  const history: WindTunnelProgress[] = [];
  const n = vox.solid.length;
  const rho = new Float32Array(n);
  const velocity = new Float32Array(3 * n);
  let sampled = 0;
  let reference = 0;
  const settle = steps - averageSteps;
  const check = () => {
    if (options.signal?.aborted) throw new CfdError('cancelled', 'the run was cancelled');
  };
  // Settling, in chunks with a report after each.
  let done = 0;
  while (done < settle) {
    check();
    flow.resetAverage();
    const chunk = Math.min(every, settle - done);
    await flow.run(chunk);
    done += chunk;
    const p = {
      step: done,
      steps,
      ...coefficients(flow, speed, areaCells),
      maxSpeed: flow.state.maxSpeed,
    };
    history.push(p);
    options.onProgress?.(p);
    await options.pause?.();
  }
  // Averaging: the force over every step, the fields at the end of each chunk.
  const total = [0, 0, 0];
  let averaged = 0;
  while (done < steps) {
    check();
    flow.resetAverage();
    const chunk = Math.min(every, steps - done);
    await flow.run(chunk);
    done += chunk;
    const f = flow.averageForce;
    for (let a = 0; a < 3; a++) total[a]! += f[a]! * chunk;
    averaged += chunk;
    const fields = await flow.fields();
    for (let c = 0; c < n; c++) rho[c]! += fields.rho[c]!;
    for (let c = 0; c < 3 * n; c++) velocity[c]! += fields.velocity[c]!;
    reference += fields.referenceDensity;
    sampled++;
    const p = {
      step: done,
      steps,
      ...coefficients(flow, speed, areaCells),
      maxSpeed: flow.state.maxSpeed,
    };
    history.push(p);
    options.onProgress?.(p);
    await options.pause?.();
  }
  // A cancel during the last report or yield still ends the run.
  check();
  for (let c = 0; c < n; c++) rho[c]! /= sampled;
  for (let c = 0; c < 3 * n; c++) velocity[c]! /= sampled;
  return {
    cd: forceCoefficient(total[0]! / averaged, speed, areaCells),
    cs: forceCoefficient(total[1]! / averaged, speed, areaCells),
    cl: forceCoefficient(total[2]! / averaged, speed, areaCells),
    frontalAreaMm2: area,
    rho,
    velocity,
    referenceDensity: reference / sampled,
    solid: vox.solid,
    history,
    backend,
    ...(gpuUnavailable ? { gpuUnavailable } : {}),
  };
}
