import {
  resolveKernelBuild,
  type KernelCatalog,
  type KernelResolution,
} from '@editor-platform/geometry-kernel-occt';
import type {
  CadEvaluateRequest,
  CadEvaluation,
  CadKernelPort,
  CadStepPlan,
} from '@editor-platform/cad-core';
import { WorkerKernelPort, type WorkerKernelPortOptions } from './port';
import type {
  CadBodyCurvature,
  CadBrepExport,
  CadCombResult,
  CadContinuityResult,
  CadKernelBuild,
  CadMesh,
  CadStepAssemblyResult,
} from './protocol';
import type { CadStepAssemblyImportResult } from './step-assembly-import';
import type { CadStepImportResult } from './step-import';

/** A build the Host serves, with the `kernelProfile.id` it gives documents. */
export interface CadCatalogBuild extends CadKernelBuild {
  id: string;
}
/**
 * Host-managed kernel builds (docs/cad/model.md, kernel update), resolved by
 * `geometry-kernel-occt`'s `resolveKernelBuild`.
 */
export type CadKernelCatalog = KernelCatalog<CadCatalogBuild>;
export type CadKernelResolution = KernelResolution<CadCatalogBuild>;
export { resolveKernelBuild };

const failed = (request: CadEvaluateRequest, code: string): CadEvaluation => ({
  status: 'error',
  contentHash: request.candidateHash,
  code,
  retryable: false,
});

/**
 * Routes each request to a Worker of the build the catalog resolves for its document: exact,
 * reference (read-only substitute) or refused. One WorkerKernelPort per build, started on
 * first use, so a migration preview runs on the new build while the old version stays shown.
 */
export class CatalogKernelPort implements CadKernelPort {
  private readonly ports = new Map<string, WorkerKernelPort>();
  private disposed = false;
  constructor(
    private readonly catalog: CadKernelCatalog,
    private readonly options: Omit<WorkerKernelPortOptions, 'build'>,
  ) {}
  private port(build: CadKernelBuild) {
    let port = this.ports.get(build.buildHash);
    if (!port)
      this.ports.set(build.buildHash, (port = new WorkerKernelPort({ ...this.options, build })));
    return port;
  }
  resolve(profile: { buildHash: string; semanticsVersion: number }) {
    return resolveKernelBuild(this.catalog, profile);
  }
  evaluate(request: CadEvaluateRequest): Promise<CadEvaluation> {
    if (this.disposed)
      return Promise.resolve({ ...failed(request, 'kernel-unavailable'), retryable: true });
    const resolved = this.resolve(request.document.kernelProfile);
    if (resolved.mode === 'unavailable') return Promise.resolve(failed(request, resolved.code));
    return this.port(resolved.build).evaluate(
      request,
      resolved.mode === 'reference' ? { reference: true } : {},
    );
  }
  /**
   * R2b: a part placed by an assembly, evaluated only by the assembly's build (R2b-U6), so one
   * Worker serves the whole assembly. Exact when both name that build; a reference display when
   * the Host approves the assembly's build as a substitute for the part's; otherwise refused.
   */
  evaluatePart(
    request: CadEvaluateRequest,
    assembly: { buildHash: string; semanticsVersion: number },
  ): Promise<CadEvaluation> {
    if (this.disposed)
      return Promise.resolve({ ...failed(request, 'kernel-unavailable'), retryable: true });
    const own = this.resolve(assembly);
    if (own.mode === 'unavailable') return Promise.resolve(failed(request, own.code));
    const part = request.document.kernelProfile;
    if (part.buildHash === assembly.buildHash)
      return this.port(own.build).evaluate(request, {
        part: true,
        ...(own.mode === 'reference' ? { reference: true as const } : {}),
      });
    const resolved = this.resolve(part);
    if (resolved.mode === 'unavailable' && resolved.code === 'kernel-build-revoked')
      return Promise.resolve(failed(request, resolved.code));
    const approved = (this.catalog.substitutes ?? []).some(
      (s) =>
        s.from === part.buildHash &&
        s.to === own.build.buildHash &&
        s.semanticsVersion === part.semanticsVersion,
    );
    return approved
      ? this.port(own.build).evaluate(request, { reference: true, part: true })
      : Promise.resolve(failed(request, 'part-build-mismatch'));
  }
  /** Exact builds only: a reference evaluation is never exported. */
  exportMeshes(
    request: CadEvaluateRequest,
    deflectionMm: number,
  ): Promise<{ evaluation: CadEvaluation; meshes: CadMesh[] }> {
    const resolved = this.resolve(request.document.kernelProfile);
    if (this.disposed || resolved.mode !== 'exact')
      return Promise.resolve({
        evaluation: failed(
          request,
          resolved.mode === 'unavailable' ? resolved.code : 'kernel-reference-only',
        ),
        meshes: [],
      });
    return this.port(resolved.build).exportMeshes(request, deflectionMm);
  }
  /** Exact builds only, like exportMeshes. */
  exportStep(
    request: CadEvaluateRequest,
  ): Promise<{ evaluation: CadEvaluation; step?: Uint8Array }> {
    const resolved = this.resolve(request.document.kernelProfile);
    if (this.disposed || resolved.mode !== 'exact')
      return Promise.resolve({
        evaluation: failed(
          request,
          resolved.mode === 'unavailable' ? resolved.code : 'kernel-reference-only',
        ),
      });
    return this.port(resolved.build).exportStep(request);
  }
  /** Exact builds only, like exportStep: a part's BRep for an assembly's STEP (R2b-5). */
  exportBrep(
    request: CadEvaluateRequest,
  ): Promise<{ evaluation: CadEvaluation; brep?: CadBrepExport }> {
    const resolved = this.resolve(request.document.kernelProfile);
    if (this.disposed || resolved.mode !== 'exact')
      return Promise.resolve({
        evaluation: failed(
          request,
          resolved.mode === 'unavailable' ? resolved.code : 'kernel-reference-only',
        ),
      });
    return this.port(resolved.build).exportBrep(request);
  }
  /** R2b-5: the assembly's STEP, written by its own exact build (every part shares it, R2b-U6). */
  exportAssemblyStep(
    profile: { buildHash: string; semanticsVersion: number },
    requestId: string,
    plan: CadStepPlan,
    breps: ReadonlyMap<string, Uint8Array>,
  ): Promise<CadStepAssemblyResult> {
    const resolved = this.resolve(profile);
    if (this.disposed || resolved.mode !== 'exact')
      return Promise.resolve({
        status: 'error',
        code: resolved.mode === 'unavailable' ? resolved.code : 'kernel-reference-only',
        retryable: false,
      });
    return this.port(resolved.build).exportAssemblyStep(requestId, plan, breps);
  }
  /** Exact builds only, like exportMeshes: the judgement reads the document's own build (R2a-4). */
  analyzeContinuity(
    request: CadEvaluateRequest,
    edge: { bodyId: string; edge: number },
  ): Promise<{ evaluation: CadEvaluation; continuity?: CadContinuityResult }> {
    const resolved = this.resolve(request.document.kernelProfile);
    if (this.disposed || resolved.mode !== 'exact')
      return Promise.resolve({
        evaluation: failed(
          request,
          resolved.mode === 'unavailable' ? resolved.code : 'kernel-reference-only',
        ),
      });
    return this.port(resolved.build).analyzeContinuity(request, edge);
  }
  /** Exact builds only: the curvature reads the document's own build (R2a-4). */
  analyzeCurvature(
    request: CadEvaluateRequest,
  ): Promise<{ evaluation: CadEvaluation; curvature?: CadBodyCurvature[] }> {
    const resolved = this.resolve(request.document.kernelProfile);
    if (this.disposed || resolved.mode !== 'exact')
      return Promise.resolve({
        evaluation: failed(
          request,
          resolved.mode === 'unavailable' ? resolved.code : 'kernel-reference-only',
        ),
      });
    return this.port(resolved.build).analyzeCurvature(request);
  }
  /** Exact builds only, like analyzeContinuity (R2a-4). */
  analyzeComb(
    request: CadEvaluateRequest,
    edge: { bodyId: string; edge: number },
  ): Promise<{ evaluation: CadEvaluation; comb?: CadCombResult }> {
    const resolved = this.resolve(request.document.kernelProfile);
    if (this.disposed || resolved.mode !== 'exact')
      return Promise.resolve({
        evaluation: failed(
          request,
          resolved.mode === 'unavailable' ? resolved.code : 'kernel-reference-only',
        ),
      });
    return this.port(resolved.build).analyzeComb(request, edge);
  }
  /**
   * D2: reads STEP with the document's own exact build, which the imported feature then names
   * as its importer. Never with a reference substitute.
   */
  importStep(
    profile: { buildHash: string; semanticsVersion: number },
    requestId: string,
    bytes: Uint8Array,
  ): Promise<CadStepImportResult> {
    const resolved = this.resolve(profile);
    if (this.disposed || resolved.mode !== 'exact')
      return Promise.resolve({
        status: 'rejected',
        code: resolved.mode === 'unavailable' ? resolved.code : 'kernel-reference-only',
      });
    return this.port(resolved.build).importStep(requestId, bytes);
  }
  /** R2b-5: reads a STEP assembly with the document's own exact build, as `importStep`. */
  importStepAssembly(
    profile: { buildHash: string; semanticsVersion: number },
    requestId: string,
    bytes: Uint8Array,
  ): Promise<CadStepAssemblyImportResult> {
    const resolved = this.resolve(profile);
    if (this.disposed || resolved.mode !== 'exact')
      return Promise.resolve({
        status: 'rejected',
        code: resolved.mode === 'unavailable' ? resolved.code : 'kernel-reference-only',
      });
    return this.port(resolved.build).importStepAssembly(requestId, bytes);
  }
  cancel(requestId: string) {
    for (const port of this.ports.values()) port.cancel(requestId);
  }
  /** Worker instances created across builds; diagnostics. */
  get spawned() {
    return [...this.ports.values()].reduce((n, p) => n + p.spawned, 0);
  }
  dispose() {
    this.disposed = true;
    for (const port of this.ports.values()) port.dispose();
  }
}
