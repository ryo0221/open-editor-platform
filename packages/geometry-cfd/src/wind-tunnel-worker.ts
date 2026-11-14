import { CfdError } from './errors';
import type { GpuLike } from './gpu-flow';
import { runWindTunnel, type WindTunnelRequest } from './wind-tunnel';
import type { WindTunnelMessage } from './wind-tunnel-job';

// VS2b: the browser wind tunnel off the page's thread. One run per worker: the page ends a run by
// terminating the worker, so nothing here listens for a cancel.
onmessage = async ({ data }: MessageEvent<{ request: WindTunnelRequest }>) => {
  const send = (m: WindTunnelMessage, transfer: Transferable[] = []) =>
    postMessage(m, { transfer });
  try {
    // WebGPU in a worker, where the browser offers it (the run falls back to the CPU otherwise).
    const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
    const result = await runWindTunnel(data.request, {
      onProgress: (progress) => send({ kind: 'progress', progress }),
      ...(gpu ? { gpu } : {}),
    });
    send({ kind: 'done', result }, [
      result.rho.buffer,
      result.velocity.buffer,
      result.solid.buffer,
    ]);
  } catch (e) {
    send({
      kind: 'failed',
      code: e instanceof CfdError ? e.code : undefined,
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
