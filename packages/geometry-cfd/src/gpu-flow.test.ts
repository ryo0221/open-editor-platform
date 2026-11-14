import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  boxSurface,
  gpuFlowBytes,
  runWindTunnel,
  type GpuDeviceLike,
  type GpuLike,
  type WindTunnelRequest,
} from './index';

// TS-2207 (ST-605): the browser wind tunnel on WebGPU, against the CPU flow.
const plate = (over: Partial<WindTunnelRequest> = {}): WindTunnelRequest => ({
  bodies: [boxSurface([12, 6, 6], [16, 14, 14])],
  grid: { origin: [0, 0, 0], spacing: 1, dims: [40, 20, 20] },
  flow: { speed: 0.05, viscosity: 0.05, smagorinsky: 0, ground: 'slip' },
  steps: 60,
  averageSteps: 20,
  progressEvery: 20,
  ...over,
});
const adapter = (max: number) => ({
  limits: { maxStorageBufferBindingSize: max, maxBufferSize: max },
  requestDevice: () => Promise.reject(new Error('not reached')),
});

describe('WebGPU fallback', () => {
  it('runs on the CPU and says why when WebGPU cannot hold the flow', async () => {
    const none: GpuLike = { requestAdapter: async () => null };
    const a = await runWindTunnel(plate(), { gpu: none });
    expect(a.backend).toBe('cpu');
    expect(a.gpuUnavailable).toMatch(/gpu-unavailable: .*no WebGPU adapter/);
    const small: GpuLike = { requestAdapter: async () => adapter(gpuFlowBytes(16000) - 4) };
    const b = await runWindTunnel(plate(), { gpu: small });
    expect(b.backend).toBe('cpu');
    expect(b.gpuUnavailable).toMatch(/needs 2 MiB buffers; the GPU allows 1 MiB/);
    // Asked for the CPU: WebGPU is not tried, and nothing is said about it.
    let asked = false;
    const c = await runWindTunnel(plate({ backend: 'cpu' }), {
      gpu: {
        requestAdapter: async () => {
          asked = true;
          return null;
        },
      },
    });
    expect([c.backend, c.gpuUnavailable, asked]).toEqual(['cpu', undefined, false]);
    // Without WebGPU: the CPU, nothing to explain.
    const d = await runWindTunnel(plate());
    expect([d.backend, d.gpuUnavailable]).toEqual(['cpu', undefined]);
    expect(a.cd).toBe(d.cd);
  }, 60_000);

  it('starts again on the CPU when the GPU stops during the run', async () => {
    // A device that takes the flow but whose reads fail, as after a reset.
    const buffer = () => ({
      mapAsync: () => Promise.reject(new Error('OperationError: device lost')),
      getMappedRange: () => new ArrayBuffer(0),
      unmap: () => undefined,
      destroy: () => undefined,
    });
    let destroyed = false;
    const device: GpuDeviceLike = {
      limits: { maxStorageBufferBindingSize: 2 ** 30, maxBufferSize: 2 ** 30 },
      queue: {
        writeBuffer: () => undefined,
        submit: () => undefined,
        onSubmittedWorkDone: async () => undefined,
      },
      createBuffer: buffer,
      createShaderModule: () => ({}),
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          dispatchWorkgroups: () => undefined,
          end: () => undefined,
        }),
        copyBufferToBuffer: () => undefined,
        finish: () => ({}),
      }),
      destroy: () => void (destroyed = true),
    };
    const gpu: GpuLike = {
      requestAdapter: async () => ({ ...adapter(2 ** 30), requestDevice: async () => device }),
    };
    const r = await runWindTunnel(plate(), { gpu });
    expect(r.backend).toBe('cpu');
    expect(r.gpuUnavailable).toMatch(
      /gpu-unavailable: the GPU stopped during the run \(OperationError: device lost\)/,
    );
    expect(destroyed).toBe(true);
    expect(r.cd).toBe((await runWindTunnel(plate())).cd);
  }, 60_000);

  it('refuses a setting out of range the same with WebGPU offered', async () => {
    const gpu: GpuLike = { requestAdapter: async () => adapter(2 ** 30) };
    await expect(
      runWindTunnel(
        plate({ flow: { speed: 0.5, viscosity: 0.05, smagorinsky: 0, ground: 'slip' } }),
        {
          gpu,
        },
      ),
    ).rejects.toThrow(/config/);
  });
});

/**
 * The same three runs on WebGPU and on the CPU in Chromium (SwiftShader's WebGPU where there is no
 * GPU): a blunt plate, a sphere with the interpolated wall, LES and a moving road, and a box on a
 * fixed ground. A browser run of about a minute; only with CFD_WEBGPU=1.
 */
it.skipIf(!process.env.CFD_WEBGPU)(
  'gives the CPU flow’s force and fields on WebGPU',
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cfd-webgpu-'));
    try {
      const entry = path.join(dir, 'main.ts');
      writeFileSync(
        entry,
        `import { runWindTunnel, boxSurface, icosphere } from ${JSON.stringify(fileURLToPath(new URL('./index.ts', import.meta.url)))};
const cases = {
  plate: { bodies: [boxSurface([12, 6, 6], [16, 14, 14])], grid: { origin: [0, 0, 0], spacing: 1, dims: [40, 20, 20] }, flow: { speed: 0.05, viscosity: 0.05, smagorinsky: 0, ground: 'slip' }, steps: 300, averageSteps: 100, progressEvery: 50 },
  sphere: { bodies: [icosphere([20.3, 15.1, 12.7], 6.2, 3)], grid: { origin: [0, 0, 0], spacing: 1, dims: [60, 30, 26] }, flow: { speed: 0.08, viscosity: 0.002, smagorinsky: 0.17, ground: 'moving', road: [0.07, -0.03] }, steps: 400, averageSteps: 200, progressEvery: 100 },
  ground: { bodies: [boxSurface([10, 5, 1.5], [20, 15, 6.3])], grid: { origin: [0, 0, 0], spacing: 1, dims: [40, 20, 14] }, flow: { speed: 0.06, viscosity: 0.02, smagorinsky: 0.1, ground: 'fixed' }, steps: 300, averageSteps: 100, progressEvery: 100 },
};
(async () => {
  const out = {};
  for (const [name, req] of Object.entries(cases)) {
    const g = await runWindTunnel(req, { gpu: navigator.gpu });
    const c = await runWindTunnel({ ...req, backend: 'cpu' });
    let drho = 0;
    for (let i = 0; i < c.rho.length; i++) drho = Math.max(drho, Math.abs(c.rho[i] - g.rho[i]));
    out[name] = { backend: g.backend, why: g.gpuUnavailable, gpu: [g.cd, g.cl], cpu: [c.cd, c.cl], drho };
  }
  window.out = out;
})().catch((e) => (window.out = { error: String(e) }));
`,
      );
      const bundle = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        write: false,
      });
      const code = bundle.outputFiles[0]!.text;
      const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu'] });
      try {
        const page = await browser.newPage();
        // A secure origin: WebGPU is offered only there.
        await page.route('https://cfd.test/**', (r) =>
          r.request().url().endsWith('/main.js')
            ? r.fulfill({ body: code, contentType: 'text/javascript' })
            : r.fulfill({
                body: '<script type="module" src="main.js"></script>',
                contentType: 'text/html',
              }),
        );
        await page.goto('https://cfd.test/');
        await page.waitForFunction(() => (window as { out?: unknown }).out, null, {
          timeout: 600_000,
        });
        type Run = { backend: string; why?: string; gpu: number[]; cpu: number[]; drho: number };
        const out = (await page.evaluate(() => (window as { out?: unknown }).out)) as {
          error?: string;
          plate?: Run;
          sphere?: Run;
          ground?: Run;
        };
        expect(out.error).toBeUndefined();
        const runs = Object.entries(out) as [string, Run][];
        expect(runs.map(([name]) => name)).toEqual(['plate', 'sphere', 'ground']);
        for (const [name, r] of runs) {
          expect([name, r.backend, r.why]).toEqual([name, 'webgpu', undefined]);
          // Single precision on the GPU against double on the CPU: the laminar runs agree to the
          // last digits; the LES sphere (a turbulent model at ν = 0.002) to a fraction of a percent.
          const tol = name === 'sphere' ? 0.01 : 1e-4;
          expect(Math.abs(r.gpu[0]! - r.cpu[0]!) / Math.abs(r.cpu[0]!)).toBeLessThan(tol);
          expect(Math.abs(r.gpu[1]! - r.cpu[1]!)).toBeLessThan(
            tol * Math.max(1, Math.abs(r.cpu[0]!)),
          );
          expect(r.drho).toBeLessThan(name === 'sphere' ? 0.02 : 1e-5);
        }
      } finally {
        await browser.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  900_000,
);
