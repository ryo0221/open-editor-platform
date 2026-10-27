/**
 * Per-part evaluation of an assembly (docs/cad/r2b-assembly.md, 評価と差分再評価): the
 * assembly's own document evaluates as before, then every version it reaches is evaluated once,
 * by content hash, with the assembly's build (R2b-U6), and cached. Placement edits evaluate no
 * part again; a version not seen before is the only new kernel job. With `background` (R2b-4,
 * 段階的な表示), the result waits only for the versions its joints read; the others evaluate
 * after it, one at a time, largest on screen first.
 */
import {
  expandAssembly,
  occurrenceAccess,
  type CadPartLookup,
  type CadSolvedPose,
} from './assembly';
import type {
  CadBodyEvaluation,
  CadEvaluateRequest,
  CadEvaluation,
  CadKernelPort,
} from './coordinator';
import { parameterValues } from './graph';
import {
  connectorRefKey,
  jointTargets,
  solveJoints,
  type CadConnectorFrame,
  type CadJointSolution,
} from './joints';
import type { CadDocument, CadKernelProfile } from './model';
import { cadContentHash } from './operations';
import type { CadTopologyRef } from './topology';

/**
 * `available`: evaluated exactly with the assembly's build. `substitute`: the part's build differs
 * and the Host approved the assembly's build as its reference display. `unavailable`: its source
 * cannot be read (missing from the closure, hash mismatch, access revoked) or its build is
 * neither. `failed`: its evaluation failed (that part only).
 */
export type CadPartState = 'available' | 'substitute' | 'unavailable' | 'failed';
export interface CadVersionEvaluation {
  state: CadPartState;
  code?: string;
  /** A failure that may pass on another try (a timeout, a crashed Worker): never cached. */
  retryable?: true;
  /** Build that evaluated it. */
  buildHash?: string;
  bodies?: Record<string, CadBodyEvaluation>;
  /** R2b-2: connector frames the joints read on it, by `connectorRefKey`. */
  frames?: Record<string, CadConnectorFrame>;
}
/** The parts of one assembly evaluation, by the content hash of each version reached. */
export interface CadAssemblyEvaluation {
  versions: Record<string, CadVersionEvaluation>;
  /** R2b-2, when the document has joints: how each solved, by joint ID. */
  joints?: Record<string, CadJointSolution>;
  /** Every direct component's pose as the joints solve it now (stored where one cannot). */
  poses?: Record<string, CadSolvedPose>;
  /**
   * Joints whose child's stored pose differs from its solved pose. A document evaluated with
   * any is a reference display until the poses are explicitly solved again (R2b-U5).
   */
  poseMismatch?: string[];
  /**
   * R2b-4: versions left to evaluate after this result (no joint reads them), shown as pending
   * until the port reports them (`version`). Measurement waits for them.
   */
  pending?: string[];
}
/** A kernel that can evaluate a part with the build of the assembly that places it. */
export interface CadPartKernelPort extends CadKernelPort {
  /**
   * Exact when the part names the assembly's build; a reference display when the Host approves
   * the assembly's build as a substitute for the part's; otherwise `part-build-mismatch`.
   */
  evaluatePart(
    request: CadEvaluateRequest,
    assembly: Pick<CadKernelProfile, 'buildHash' | 'semanticsVersion'>,
  ): Promise<CadEvaluation>;
}
export interface CadAssemblyPortOptions {
  kernel: CadPartKernelPort;
  /** The Host's retained closure: a version's content by its content hash. */
  parts: CadPartLookup;
  /** The Host's current read access to a part's Artifact (true when it cannot tell). */
  access?(artifactId: string): boolean;
  /** R2b-4: evaluate the versions no joint reads after the result (`pending`). */
  background?: boolean;
  /** R2b-4: ask each part job for a coarse display mesh too (LOD). */
  coarse?: boolean;
}
/** R2b-4: a document's versions evaluated so far, for 「部品 n / N を計算中」. */
export interface CadPartProgress {
  /** The content hash of the document whose versions these are. */
  contentHash: string;
  done: number;
  total: number;
}

/** Verified lookup: content whose hash is not the one named reads as a mismatch. */
const verified = (lookup: CadPartLookup) => {
  const checked = new Map<string, CadDocument | 'mismatch' | undefined>();
  return (hash: string) => {
    if (!checked.has(hash)) {
      const doc = lookup(hash);
      checked.set(hash, doc && (cadContentHash(doc) === hash ? doc : 'mismatch'));
    }
    return checked.get(hash);
  };
};

interface Run {
  requestId: string;
  /** A background run: the document's hash and its versions left, with their content. */
  later?: { contentHash: string; left: Map<string, CadDocument>; total: number };
  /** Why it stops at the next part: superseded or cancelled. */
  stopped?: string;
  /** The part job it waits on. */
  job?: string;
}
/**
 * A CadKernelPort for assemblies over a part-capable kernel. One assembly evaluation runs at a
 * time: a newer request makes an older one stop between parts (`superseded`), and `cancel`
 * stops it and the part job it is waiting on.
 */
export class CadAssemblyPort implements CadKernelPort {
  /** Ok and final part results by content hash, for `cacheBuild`; dropped with `forget`. */
  private readonly cache = new Map<string, CadVersionEvaluation>();
  /** Connector references asked of each version so far: a later evaluation asks them all again. */
  private readonly refs = new Map<string, Map<string, CadTopologyRef>>();
  /** The assembly build the cached results were evaluated with; another build starts afresh. */
  private cacheBuild = '';
  private active: Run | undefined;
  /** Content hashes of part jobs in flight: their meshes belong to the parts, not the editor. */
  readonly partJobs = new Set<string>();
  /** Part jobs sent to the kernel; diagnostics for the per-part cache (CAD50). */
  partEvaluations = 0;
  /** Version jobs in flight, with the references they ask: a second asker waits for the same. */
  private readonly inflight = new Map<
    string,
    { build: string; keys: Set<string>; result: Promise<CadVersionEvaluation> }
  >();
  /** R2b-4: the background run, while versions are left. */
  private background: Run | undefined;
  /**
   * R2b-4: background results that may pass on another try, until the next evaluation tries
   * them again (a resumed run does not, so a lasting failure is not tried in a loop).
   */
  private readonly retryLater = new Map<string, CadVersionEvaluation>();
  private readonly listeners = new Set<() => void>();
  /**
   * R2b-4: the order the background evaluates versions in, first first (the Surface gives the
   * largest on screen, those out of view last). Asked again before each part.
   */
  order: ((hashes: string[]) => string[]) | undefined;
  constructor(private readonly options: CadAssemblyPortOptions) {}
  /** Called after each background part and when a background run ends or stops. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private emit() {
    for (const l of this.listeners) l();
  }
  /** A version's cached result: a pending version's, once the background evaluated it. */
  version(contentHash: string) {
    return this.cache.get(contentHash) ?? this.retryLater.get(contentHash);
  }

  async evaluate(request: CadEvaluateRequest): Promise<CadEvaluation> {
    const doc = request.document;
    // Any newer request stops an older assembly before its next part job, which would otherwise
    // replace the newer request's job in the kernel's queue.
    if (this.active) this.active.stopped ??= 'superseded';
    this.active = undefined;
    this.stopBackground();
    this.retryLater.clear();
    if (!doc.components.length) return this.options.kernel.evaluate(request);
    const run: Run = { requestId: request.requestId };
    this.active = run;
    try {
      const lookup = verified(this.options.parts);
      const read: CadPartLookup = (h) => {
        const x = lookup(h);
        return x === 'mismatch' ? undefined : x;
      };
      // Connector references, where each resolves: this document's bodies or a version. A
      // sub-assembly's own bodies are its version (`self`).
      const asked = new Map<string, Map<string, CadTopologyRef>>();
      // Versions a joint's connector lies on, origins too: the joints solve only on them.
      const touched = new Set<string>();
      const ask = (d: CadDocument, self: string) => {
        for (const joint of d.joints) {
          const targets = jointTargets(d, joint, read);
          for (const [target, connector] of [
            [targets.parent, joint.parent],
            [targets.child, joint.child.connector],
          ] as const) {
            if (target.status !== 'found') continue;
            const key = target.at === 'own' ? self : target.at;
            for (const p of target.through) touched.add(p.contentHash);
            if ('origin' in connector.ref) continue;
            let at = asked.get(key);
            if (!at) asked.set(key, (at = new Map()));
            at.set(connectorRefKey(connector.ref), connector.ref);
          }
        }
      };
      ask(doc, 'own');
      const ownRefs = [...(asked.get('own')?.values() ?? [])];
      const evaluated = await this.options.kernel.evaluate(
        ownRefs.length ? { ...request, connectors: ownRefs } : request,
      );
      if (evaluated.status !== 'ok') return evaluated;
      const { connectors: ownFrames, ...own } = evaluated;
      const expansion = expandAssembly(doc, read);
      if (expansion.limit) return this.stopped(request, expansion.limit, false);
      const versions: Record<string, CadVersionEvaluation> = {};
      // The same content may be placed from several Artifacts, each with its own access (and
      // that of the sub-assemblies around it). The version is evaluated when any occurrence may
      // be shown; each occurrence's display checks its own path.
      const access = this.options.access ?? (() => true);
      const allowed = occurrenceAccess(expansion.occurrences, access);
      const sources = new Map<string, boolean>();
      expansion.occurrences.forEach((o, i) => {
        const hash = o.part.source.contentHash;
        sources.set(hash, (sources.get(hash) ?? false) || allowed[i]!);
      });
      // Sub-assemblies with joints: their stored poses are checked like this document's.
      const jointed = [...sources.keys()].flatMap((hash) => {
        const content = read(hash);
        return content?.joints.length ? [[hash, content] as const] : [];
      });
      for (const [hash, content] of jointed) ask(content, hash);
      // R2b-4: a version no joint reads, of this build and not cached, may evaluate later. One
      // of another build may be a reference display, which decides the whole result now.
      const later = new Map<string, CadDocument>();
      const needed = (hash: string, content: CadDocument) =>
        !this.options.background ||
        this.cache.has(hash) ||
        touched.has(hash) ||
        jointed.some(([h]) => h === hash) ||
        content.kernelProfile.buildHash !== doc.kernelProfile.buildHash;
      for (const [hash, readable] of sources) {
        if (run.stopped) return this.stopped(request, run.stopped);
        const content = lookup(hash);
        if (readable && content && content !== 'mismatch' && !needed(hash, content)) {
          later.set(hash, content);
          continue;
        }
        if (content === 'mismatch')
          versions[hash] = { state: 'unavailable', code: 'part-source-mismatch' };
        else if (!content) versions[hash] = { state: 'unavailable', code: 'part-source-missing' };
        else if (!readable) versions[hash] = { state: 'unavailable', code: 'part-access-revoked' };
        else
          versions[hash] = await this.part(request, run, hash, content, [
            ...(asked.get(hash)?.values() ?? []),
          ]);
      }
      if (run.stopped) return this.stopped(request, run.stopped);
      const available = (at: string) =>
        versions[at]?.state === 'available' || versions[at]?.state === 'substitute';
      // A joint reads its connector through one path: each Artifact on it must still be
      // readable, even when the same content is evaluated for another occurrence.
      const reachable = (p: { contentHash: string; artifactId: string | undefined }) =>
        available(p.contentHash) && (p.artifactId === undefined || access(p.artifactId));
      // A saved sub-assembly whose stored poses its joints do not solve to (or whose connectors
      // no longer resolve) is that part's failure: it is not rewritten, and is not shown.
      for (const [hash, content] of jointed) {
        if (!available(hash)) continue;
        const nested = solveJoints(
          content,
          parameterValues(content),
          read,
          (at, ref) => versions[at === 'own' ? hash : at]?.frames?.[connectorRefKey(ref)],
          reachable,
        );
        const broken = Object.values(nested.joints).some((j) => j.status === 'broken');
        if (broken || nested.mismatch.length)
          versions[hash] = {
            state: 'failed',
            code: broken ? 'part-joint-broken' : 'part-pose-mismatch',
          };
      }
      // A part shown only as a reference display makes the whole assembly one: no edit,
      // measurement or shape export is decided on it (r2b-assembly.md, substitute).
      const reference = Object.values(versions).some((v) => v.state === 'substitute');
      const assembly: CadAssemblyEvaluation = {
        versions,
        ...(later.size ? { pending: [...later.keys()] } : {}),
      };
      if (doc.joints.length) {
        const owned = new Map(ownRefs.map((r, i) => [connectorRefKey(r), ownFrames?.[i]]));
        const solved = solveJoints(
          doc,
          parameterValues(doc),
          read,
          (at, ref) => {
            const key = connectorRefKey(ref);
            return at === 'own' ? owned.get(key) : versions[at]?.frames?.[key];
          },
          reachable,
        );
        assembly.joints = solved.joints;
        assembly.poses = solved.poses;
        assembly.poseMismatch = solved.mismatch;
      }
      if (later.size) this.startBackground(request, later);
      return { ...own, ...(reference ? { reference: true as const } : {}), assembly };
    } finally {
      if (this.active === run) this.active = undefined;
    }
  }
  /**
   * R2b-4: evaluates a result's pending versions that are not cached, when no background run
   * works on that document (history returned to it, or a stopped run). `parts` is the lookup.
   */
  resume(document: CadDocument, evaluation: CadEvaluation) {
    const pending = evaluation.status === 'ok' ? evaluation.assembly?.pending : undefined;
    const contentHash = evaluation.contentHash;
    if (!pending?.length || this.active) return false;
    const running = this.background?.later;
    if (!this.background?.stopped && running?.contentHash === contentHash) return false;
    const left = new Map<string, CadDocument>();
    for (const hash of pending) {
      const content = this.version(hash) ? undefined : this.options.parts(hash);
      if (content && cadContentHash(content) === hash) left.set(hash, content);
    }
    if (!left.size) return false;
    this.stopBackground();
    this.startBackground(
      {
        requestId: `resume/${contentHash}`,
        generation: 0,
        baseHash: contentHash,
        candidateHash: contentHash,
        document,
      },
      left,
    );
    return true;
  }
  private stopBackground() {
    const run = this.background;
    if (!run) return;
    run.stopped ??= 'superseded';
    this.background = undefined;
    this.emit();
  }
  /** Resolves once no background run is under way (it ended or was stopped). */
  idle() {
    return new Promise<void>((resolve) => {
      if (!this.background) return resolve();
      const off = this.subscribe(() => {
        if (this.background) return;
        off();
        resolve();
      });
    });
  }
  /**
   * One version at a time, in `order`, until all are evaluated or a newer request or a cancel
   * stops the run between parts. A job already running finishes and is cached; a waiting one
   * is replaced by the newer request in the kernel's queue.
   */
  private startBackground(request: CadEvaluateRequest, left: Map<string, CadDocument>) {
    const run: Run = {
      requestId: request.requestId,
      later: { contentHash: request.candidateHash, left, total: left.size },
    };
    this.background = run;
    const profile = request.document.kernelProfile;
    void (async () => {
      // The result is returned first: its evaluation is shown before the first part job.
      await Promise.resolve();
      while (!run.stopped && left.size) {
        const keys = [...left.keys()];
        const hash = this.order?.(keys).find((k) => left.has(k)) ?? keys[0]!;
        const content = left.get(hash)!;
        const entry = await this.evaluateVersion(content, profile, {
          requestId: `${request.requestId}/later`,
          generation: request.generation,
          hash,
          run,
        });
        if (run.stopped) break;
        if (entry.retryable) this.retryLater.set(hash, entry);
        left.delete(hash);
        this.emit();
      }
      if (this.background === run) {
        this.background = undefined;
        this.emit();
      }
    })();
  }
  private stopped(request: CadEvaluateRequest, code: string, retryable = true): CadEvaluation {
    return { status: 'error', contentHash: request.candidateHash, code, retryable };
  }
  private part(
    request: CadEvaluateRequest,
    run: Run,
    hash: string,
    content: CadDocument,
    connectors: CadTopologyRef[],
  ) {
    return this.evaluateVersion(content, request.document.kernelProfile, {
      requestId: request.requestId,
      generation: request.generation,
      hash,
      run,
      connectors,
    });
  }
  /**
   * One version's own bodies with the assembly's build, cached by its content hash. Also used
   * before an insert, so the new part's bounds are known and its result is ready.
   */
  async evaluateVersion(
    content: CadDocument,
    assembly: Pick<CadKernelProfile, 'buildHash' | 'semanticsVersion'>,
    {
      requestId,
      generation = 0,
      hash = cadContentHash(content),
      run,
      connectors = [],
    }: {
      requestId: string;
      generation?: number;
      hash?: string;
      run?: Run;
      /** Connector references whose frames the result must hold (R2b-2). */
      connectors?: CadTopologyRef[];
    },
  ): Promise<CadVersionEvaluation> {
    // A migrated assembly (another build) may need another display of the same version.
    const build = `${assembly.buildHash} ${assembly.semanticsVersion}`;
    if (build !== this.cacheBuild) {
      this.cache.clear();
      this.refs.clear();
      this.cacheBuild = build;
    }
    let refs = this.refs.get(hash);
    if (!refs) this.refs.set(hash, (refs = new Map()));
    for (const r of connectors) refs.set(connectorRefKey(r), r);
    const cached = this.cache.get(hash);
    // A cached result answers every frame asked before; a new reference evaluates it again.
    if (cached && [...refs.keys()].every((k) => Object.hasOwn(cached.frames ?? {}, k)))
      return cached;
    if (cached && cached.state !== 'available' && cached.state !== 'substitute') return cached;
    // The same version for another request (a stopped background run's job, still running).
    const running = this.inflight.get(hash);
    if (running?.build === build && [...refs.keys()].every((k) => running.keys.has(k)))
      return running.result;
    const result = this.job(content, assembly, hash, build, requestId, generation, refs, run);
    this.inflight.set(hash, { build, keys: new Set(refs.keys()), result });
    try {
      return await result;
    } finally {
      if (this.inflight.get(hash)?.result === result) this.inflight.delete(hash);
    }
  }
  private async job(
    content: CadDocument,
    assembly: Pick<CadKernelProfile, 'buildHash' | 'semanticsVersion'>,
    hash: string,
    build: string,
    requestId: string,
    generation: number,
    refs: Map<string, CadTopologyRef>,
    run: Run | undefined,
  ): Promise<CadVersionEvaluation> {
    const asked = [...refs.values()];
    const jobId = `${requestId}/part/${hash}`;
    if (run) run.job = jobId;
    this.partJobs.add(hash);
    this.partEvaluations++;
    let result: CadEvaluation;
    try {
      result = await this.options.kernel.evaluatePart(
        {
          requestId: jobId,
          generation,
          baseHash: hash,
          candidateHash: hash,
          document: content,
          ...(asked.length ? { connectors: asked } : {}),
          ...(this.options.coarse ? { coarse: true as const } : {}),
        },
        assembly,
      );
    } catch {
      result = { status: 'error', contentHash: hash, code: 'kernel-unavailable', retryable: true };
    } finally {
      this.partJobs.delete(hash);
      if (run) run.job = undefined;
    }
    const entry: CadVersionEvaluation =
      result.status === 'ok'
        ? {
            state: result.reference ? 'substitute' : 'available',
            buildHash: result.buildHash,
            bodies: result.bodies,
            ...(asked.length
              ? {
                  frames: Object.fromEntries(
                    asked.map((r, i) => [
                      connectorRefKey(r),
                      result.connectors?.[i] ?? { status: 'unsupported' as const },
                    ]),
                  ),
                }
              : {}),
          }
        : result.code === 'part-build-mismatch' ||
            result.code === 'kernel-build-unavailable' ||
            result.code === 'kernel-build-revoked'
          ? { state: 'unavailable', code: result.code }
          : {
              state: 'failed',
              code: result.code,
              ...(result.retryable ? { retryable: true } : {}),
            };
    // A retryable failure (cancelled, superseded, a crash) is tried again next time.
    if ((result.status === 'ok' || !result.retryable) && build === this.cacheBuild)
      this.cache.set(hash, entry);
    return entry;
  }
  cancel(requestId: string) {
    for (const run of [this.active, this.background])
      if (run?.requestId === requestId) {
        run.stopped = 'cancelled';
        if (run.job) this.options.kernel.cancel(run.job);
      }
    if (this.background?.stopped) this.stopBackground();
    this.options.kernel.cancel(requestId);
  }
  /** Stops the background run between parts (the Surface closed). */
  dispose() {
    const job = this.background?.job;
    this.stopBackground();
    if (job) this.options.kernel.cancel(job);
  }
  /** Drops a part's cached result (its meshes were released): it evaluates again when shown. */
  forget(contentHash: string) {
    this.cache.delete(contentHash);
  }
  /** Whether a part's result is cached. */
  has(contentHash: string) {
    return this.cache.has(contentHash);
  }
}
