/**
 * DW2: the kernel triangles a drawing projects, from each version's exact kernel build (a
 * reference substitute is never drawn: a drawing measures the shape). A version is evaluated
 * once for its size, then again as an export at a deflection fixed by that size, so a view of
 * one version always projects the same triangles. Jobs run one after another (an export
 * supersedes the one waiting), and the results are kept by hash while the drawing is open.
 */
import { cadContentHash, type CadDocument } from '@editor-platform/cad-core';
import {
  resolveKernelBuild,
  WorkerKernelPort,
  type CadCatalogBuild,
  type CadMesh,
} from '@editor-platform/cad-kernel-occt';
import KernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import { cadKernel, cadKernels } from '../model';

export function drawingKernel(content: CadDocument): { build: CadCatalogBuild } | { code: string } {
  if (!cadKernel) return { code: 'kernel-build-unavailable' };
  const absolute = (b: CadCatalogBuild): CadCatalogBuild => ({
    ...b,
    moduleUrl: new URL(b.moduleUrl, location.href).href,
    wasmUrl: new URL(b.wasmUrl, location.href).href,
  });
  const r = resolveKernelBuild(
    { ...cadKernels, current: absolute(cadKernel), retained: cadKernels.retained?.map(absolute) },
    content.kernelProfile,
  );
  if (r.mode === 'exact') return { build: r.build };
  return { code: r.mode === 'reference' ? 'kernel-build-reference-only' : r.code };
}

/** Deflection (mm) for a version of this size: a share of its diagonal, within 2 µm … 50 mm. */
export const drawingDeflection = (diagonalMm: number) =>
  Math.min(50, Math.max(0.002, diagonalMm * 2e-4));

export class DrawingMeshes {
  /**
   * DW3c-2: `assets` gives the bytes of an asset the drawing keeps (an imported feature's STEP or
   * BRep), by `sha256:<hex>`.
   */
  constructor(
    private readonly assets: (sha256: string) => Uint8Array | undefined = () => undefined,
  ) {}
  private readonly ports = new Map<string, WorkerKernelPort>();
  private readonly kept = new Map<string, Promise<CadMesh[] | { code: string }>>();
  private queue: Promise<unknown> = Promise.resolve();

  private port(build: CadCatalogBuild) {
    let port = this.ports.get(build.buildHash);
    if (!port) {
      port = new WorkerKernelPort({
        spawn: () => new KernelWorker() as never,
        build,
        assets: (sha) => this.assets(sha),
        // The drawing's own jobs: the editor's evaluation memory is left alone.
      });
      this.ports.set(build.buildHash, port);
    }
    return port;
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The meshes of one exact version (all its own bodies), or why there are none. */
  meshes = (content: CadDocument, contentHash: string): Promise<CadMesh[] | { code: string }> => {
    const have = this.kept.get(contentHash);
    if (have) return have;
    const made = this.make(content, contentHash);
    this.kept.set(contentHash, made);
    // A failure may be the Worker's (a timeout): the next view asks again.
    void made.then((r) => {
      if (!Array.isArray(r)) this.kept.delete(contentHash);
    });
    return made;
  };

  private async make(content: CadDocument, hash: string): Promise<CadMesh[] | { code: string }> {
    if (cadContentHash(content) !== hash) return { code: 'source-hash-mismatch' };
    const kernel = drawingKernel(content);
    if ('code' in kernel) return kernel;
    const port = this.port(kernel.build);
    const request = {
      requestId: `drawing-${hash}`,
      generation: 1,
      baseHash: '',
      candidateHash: hash,
      document: content,
    };
    const first = await this.serial(() => port.evaluate(request, { part: true }));
    if (first.status !== 'ok') return { code: first.code };
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const b of Object.values(first.bodies))
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i]!, b.bounds[0][i]!);
        hi[i] = Math.max(hi[i]!, b.bounds[1][i]!);
      }
    if (!Number.isFinite(lo[0]!))
      [lo, hi] = [
        [0, 0, 0],
        [1, 1, 1],
      ];
    const diagonal = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
    const r = await this.serial(() => port.exportMeshes(request, drawingDeflection(diagonal)));
    if (r.evaluation.status !== 'ok') return { code: r.evaluation.code };
    return r.meshes;
  }

  /** Stops the Workers; a later request starts them again. */
  dispose() {
    for (const p of this.ports.values()) p.dispose();
    this.ports.clear();
    this.kept.clear();
  }
}
