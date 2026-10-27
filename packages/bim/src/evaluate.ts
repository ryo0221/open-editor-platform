import {
  bimGeometry,
  bimNodeRole,
  deriveBim,
  type BimDocument,
  type BimPlacement,
} from '@editor-platform/bim-core';
import {
  geometryNodeKey,
  geometryOrder,
  type GeometryGraph,
  type GeometryOp,
  type GeometryRequest,
} from '@editor-platform/geometry-core';
import {
  evaluateGeometry,
  type GeometryEvaluation,
  type GeometryMeasure,
  type GeometryMesh,
  type OcModule,
} from '@editor-platform/geometry-kernel-occt';

/**
 * Evaluation of a building (docs/cad/r2c-architecture.md, 評価と規模; R2c-3a): every element's
 * solid from `bimGeometry`, keyed by its recipe (`geometryNodeKey`). Only solids whose key is
 * not cached go to the kernel, so an edit re-evaluates what it changed, and elements of one type
 * and size share one solid and its mesh. An element that fails is named with its reason; the
 * others still evaluate.
 */

/**
 * What the kernel side answers for one batch: the evaluation, a job past the time limit, a job
 * stopped by `signal`, or a kernel that cannot run at all (`code`, e.g. `kernel-load-failed`).
 */
export type BimKernelOutcome =
  | GeometryEvaluation
  | { status: 'timeout' }
  | { status: 'cancelled' }
  | { status: 'error'; code: string };

/** The kernel side: one batch of the graph per call, within the job time limit. */
export interface BimKernel {
  run(
    graph: GeometryGraph,
    requests: GeometryRequest[],
    assets: Map<string, Uint8Array>,
    /** Aborted when a later evaluation overtakes this one. */
    signal?: AbortSignal,
    /** `timeoutMs`: this job's limit, where the kernel has one (a drawing's projection). */
    options?: { timeoutMs?: number },
  ): Promise<BimKernelOutcome>;
}

/**
 * The kernel in this thread, without a time limit or cancel: for tests and tools. The Surface
 * runs the kernel in a Worker that stops a job past the limit (`WorkerBimKernel`).
 */
export const bimDirectKernel = (oc: OcModule): BimKernel => ({
  run: (graph, requests, assets) => evaluateGeometry(oc, graph, requests, { assets }),
});

/** Display mesh of every solid: absolute, since building solids are mostly planar. */
export const bimDisplayMesh = Object.freeze({ deflectionMm: 1, angularDeflectionRad: 0.2 });

export const bimEvaluationLimits = Object.freeze({
  /** Triangles of one solid (an element, or a type's shared solid), as in CAD. */
  triangles: 500_000,
  /** Solids per kernel job; a job that times out is split until one solid is left. */
  batch: 64,
  /** Cached solids beyond those the latest document uses, least recently used first out. */
  retained: 2_000,
});

export type BimSolid =
  | { status: 'ok'; mesh?: GeometryMesh; measure: GeometryMeasure }
  /** `role` is the failing node's part of the element (see `BimElementResult`). */
  | { status: 'error'; code: string; role?: string };

export type BimElementResult =
  | {
      status: 'ok';
      /** The solid's key: elements with one key share the mesh. */
      solid: string;
      /** Where the shared solid goes; absent when the solid is in place. */
      placement?: BimPlacement;
      mesh: GeometryMesh;
      /** In the solid's own coordinates when placed. */
      measure: GeometryMeasure;
    }
  /**
   * `role`: the failing part of the element (`solid`, `opening:<id>`, `clip0`, …). `placement`:
   * where its solid would go, so a part whose shape is missing is shown as its bounds there.
   */
  | { status: 'error'; code: string; role?: string; placement?: BimPlacement };

export type BimEvaluation =
  | {
      status: 'ok';
      elements: Map<string, BimElementResult>;
      /** Quantities the kernel measured for elements the analytic ones cannot cover (clipped). */
      kernelQuantities: Map<string, Record<string, number>>;
      /** What this call sent to the kernel: solids built and graph nodes sent. */
      sent: { solids: number; nodes: number };
    }
  /** A later call started: this one's results are cached but not adopted. */
  | { status: 'superseded' };

interface Want {
  key: string;
  node: string;
  mesh: boolean;
}

export class BimEvaluator {
  private readonly cache = new Map<string, BimSolid>();
  private generation = 0;
  /** Stops the running call's kernel job when a later call starts. */
  private abort: AbortController | undefined;

  constructor(
    private readonly kernel: BimKernel,
    private readonly limits: {
      [K in keyof typeof bimEvaluationLimits]: number;
    } = bimEvaluationLimits,
  ) {}

  /** Cached solids, for tests and the display budget. */
  get cachedSolids() {
    return this.cache.size;
  }

  async evaluate(
    doc: BimDocument,
    options: { assets?: Map<string, Uint8Array> } = {},
  ): Promise<BimEvaluation> {
    const generation = ++this.generation;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const derived = deriveBim(doc);
    const geometry = bimGeometry(doc, derived);
    const { graph } = geometry;
    const keys = new Map<string, string>();
    const keyOf = (node: string) => {
      let k = keys.get(node);
      if (k === undefined) keys.set(node, (k = geometryNodeKey(graph, node)));
      return k;
    };

    // What each element needs, by solid key; a solid wanted for display needs its mesh.
    const wants = new Map<string, Want>();
    const want = (node: string, mesh: boolean) => {
      const key = keyOf(node);
      const w = wants.get(key);
      if (!w) wants.set(key, { key, node, mesh });
      else w.mesh ||= mesh;
    };
    for (const el of geometry.elements.values()) {
      want(el.node, true);
      if (el.gross) want(el.gross, false);
    }
    const missing = [...wants.values()].filter((w) => {
      const c = this.cache.get(w.key);
      return !c || (w.mesh && c.status === 'ok' && !c.mesh);
    });

    // This call's outcomes, read before the shared cache that overlapping calls also write.
    // A missing BRep asset (which may arrive later) is kept here only, not cached.
    const own = new Map<string, BimSolid>();
    const put = (key: string, solid: BimSolid, cache = true) => {
      own.set(key, solid);
      if (cache) this.store(key, solid);
    };
    const sent = { solids: 0, nodes: 0 };
    const queue: Want[][] = [];
    for (let i = 0; i < missing.length; i += this.limits.batch)
      queue.push(missing.slice(i, i + this.limits.batch));
    while (queue.length) {
      if (generation !== this.generation) return { status: 'superseded' };
      const batch = queue.shift()!;
      const sub: Record<string, GeometryOp> = {};
      for (const w of batch) for (const n of geometryOrder(graph, w.node)) sub[n] = graph.nodes[n]!;
      sent.solids += batch.length;
      sent.nodes += Object.keys(sub).length;
      const requests: GeometryRequest[] = batch.map((w) => ({
        node: w.node,
        measure: true,
        ...(w.mesh ? { mesh: bimDisplayMesh } : {}),
      }));
      const out = await this.kernel.run(
        { nodes: sub },
        requests,
        options.assets ?? new Map(),
        abort.signal,
      );
      if (out.status === 'cancelled') return { status: 'superseded' };
      // A kernel that cannot run fails the batch without splitting it; not cached.
      if (out.status === 'error')
        for (const w of batch) put(w.key, { status: 'error', code: out.code }, false);
      // A batch that timed out or failed validation is split until the solid at fault is alone.
      else if (out.status !== 'ok') {
        if (batch.length > 1) {
          const half = Math.ceil(batch.length / 2);
          queue.unshift(batch.slice(0, half), batch.slice(half));
        } else
          put(batch[0]!.key, {
            status: 'error',
            code: out.status === 'timeout' ? 'element-timeout' : 'graph-invalid',
          });
      } else
        out.results.forEach((r, i) => {
          const w = batch[i]!;
          if (r.status === 'error') {
            const solid: BimSolid = { status: 'error', code: r.code, role: bimNodeRole(r.node) };
            // A missing asset can arrive later: not cached.
            put(w.key, solid, r.code !== 'asset-missing');
          } else if (r.mesh && r.mesh.indices.length / 3 > this.limits.triangles)
            put(w.key, { status: 'error', code: 'shape-too-large' });
          else
            put(w.key, {
              status: 'ok',
              measure: r.measure!,
              ...(r.mesh ? { mesh: r.mesh } : {}),
            });
        });
      if (generation !== this.generation) return { status: 'superseded' };
    }

    const solidOf = (node: string) => {
      const key = keyOf(node);
      return own.get(key) ?? this.touch(key);
    };
    const elements = new Map<string, BimElementResult>();
    const kernelQuantities = new Map<string, Record<string, number>>();
    for (const [id, el] of geometry.elements) {
      const s = solidOf(el.node);
      if (!s || s.status === 'error') {
        elements.set(id, {
          status: 'error',
          code: s?.code ?? 'graph-invalid',
          ...(s?.role ? { role: s.role } : {}),
          ...(el.placement ? { placement: el.placement } : {}),
        });
        continue;
      }
      elements.set(id, {
        status: 'ok',
        solid: keyOf(el.node),
        ...(el.placement ? { placement: el.placement } : {}),
        mesh: s.mesh!,
        measure: s.measure,
      });
      if (derived.quantities.get(id)?.source !== 'kernel') continue;
      const gross = el.gross ? solidOf(el.gross) : undefined;
      kernelQuantities.set(
        id,
        gross?.status === 'ok'
          ? { grossVolume: gross.measure.volumeMm3, netVolume: s.measure.volumeMm3 }
          : { netVolume: s.measure.volumeMm3 },
      );
    }
    this.prune(new Set([...wants.keys()]));
    if (this.abort === abort) this.abort = undefined;
    return { status: 'ok', elements, kernelQuantities, sent };
  }

  private store(key: string, solid: BimSolid) {
    // Entries only gain: a failure (an overtaken call's timeout) never replaces a built solid,
    // and a measure without a mesh never replaces one with it.
    const known = this.cache.get(key);
    if (known?.status === 'ok' && (solid.status === 'error' || (known.mesh && !solid.mesh)))
      solid = known;
    this.cache.delete(key);
    this.cache.set(key, solid);
  }
  private touch(key: string) {
    const s = this.cache.get(key);
    if (s) this.store(key, s);
    return s;
  }
  /** Keeps the solids in use and the most recently used others, up to the limit. */
  private prune(inUse: Set<string>) {
    let spare = [...this.cache.keys()].filter((k) => !inUse.has(k)).length - this.limits.retained;
    for (const k of this.cache.keys()) {
      if (spare <= 0) break;
      if (inUse.has(k)) continue;
      this.cache.delete(k);
      spare--;
    }
  }
}
