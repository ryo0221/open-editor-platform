import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import {
  sameLocalRevision,
  type EditorSession,
  type LocalDraftRevision,
} from '@editor-platform/editor-core';
import type { CadAssemblyEvaluation } from './assembly-port';
import { cadEditorCommand, assertCadOperation } from './commands';
import type { CadDocument, Vec3 } from './model';
import { applyCadOperation, cadContentHash, type CadOperation } from './operations';
import { poseOf, posesDiffer, stepPose } from './assembly';
import {
  jointRefPath,
  jointValues,
  placeHint,
  type CadConnectorFrame,
  type CadJoint,
} from './joints';
import { parameterValues, resolvePosition, type ParameterValues } from './graph';
import type { CadReferenceProblem, CadTopoName, CadTopologyRef } from './topology';
import { assertCad } from './validation';

export interface CadSolidEvaluation {
  kind: 'solid';
  /** The body's total over its solids. */
  volumeMm3: number;
  areaMm2: number;
  bounds: [Vec3, Vec3];
  /** K1: the number of disjoint solids, when more than one. */
  solids?: number;
}
/** R2a: a sheet has no volume; its free (boundary) edges are counted and measured. */
export interface CadSheetEvaluation {
  kind: 'sheet';
  areaMm2: number;
  bounds: [Vec3, Vec3];
  freeEdges: number;
  freeEdgeLengthMm: number;
}
export type CadBodyEvaluation = CadSolidEvaluation | CadSheetEvaluation;
/** Kernel output for one exact document. Meshes/pick tables travel beside it, keyed by the same hash. */
export type CadEvaluation =
  | {
      status: 'ok';
      contentHash: string;
      /** Build that evaluated: the document's own, or the substitute of a reference evaluation. */
      buildHash: string;
      geometryDigest: string;
      bodies: Record<string, CadBodyEvaluation>;
      /**
       * Evaluated by a Host-approved newer build because the document's exact build is not
       * available (docs/cad/model.md, kernel update). Read-only display: never a basis for an
       * edit, measurement, shape export or D3 publication.
       */
      reference?: true;
      /** R2b: the placed parts' versions, each evaluated once with this build. */
      assembly?: CadAssemblyEvaluation;
      /** R2b-2: the frame of each reference the request's `connectors` named, in order. */
      connectors?: CadConnectorFrame[];
    }
  | {
      status: 'error';
      contentHash: string;
      code: string;
      featureId?: string;
      retryable: boolean;
      /** `reference-ambiguous` / `reference-missing`: every reference of the feature that broke. */
      references?: CadReferenceProblem[];
      /** R2b-2b: every joint whose connector does not resolve on the candidate, in order. */
      brokenJoints?: string[];
      /** `fillet-failed` / `chamfer-failed`: paths in the feature's args of the edges it could not build. */
      failedPaths?: (string | number)[][];
      /** `sew-gap` (R2a-3): the input edges left apart, by the input's feature and edge name. */
      edges?: { featureId: string; name: CadTopoName }[];
      /**
       * U4 (docs/cad/complex-models.md): the active bodies outside the failure, evaluated as in
       * an `ok` result (measured and picked; never exported). A failed body has none: its mesh,
       * if any, is the shape before the failure, marked `beforeFailure`.
       */
      partial?: Record<string, CadBodyEvaluation>;
    };
export interface CadEvaluateRequest {
  requestId: string;
  generation: number;
  baseHash: string;
  candidateHash: string;
  document: CadDocument;
  /** R2b-2: references on the active bodies whose connector frames to return (`connectors`). */
  connectors?: CadTopologyRef[];
  /** R2b-4: also a coarse display mesh of each body (LOD); display only. */
  coarse?: true;
}
/** Worker/kernel boundary. `cancel` is a request; the coordinator stops trusting the job immediately. */
export interface CadKernelPort {
  evaluate(request: CadEvaluateRequest): Promise<CadEvaluation>;
  cancel(requestId: string): void;
}
/**
 * The editing session the coordinator drives: an `EditorSession`, or a Host's own session that
 * keeps the same revision, history and validation contract (e.g. an artifact Host editor).
 */
export type CadSession = Pick<
  EditorSession<CadDocument>,
  'content' | 'revision' | 'canUndo' | 'canRedo' | 'execute' | 'undo' | 'redo'
>;
export interface CadCoordinatorOptions {
  /** Owned by the coordinator: Hosts must not execute geometry commands on it directly. */
  session: CadSession;
  kernel: CadKernelPort;
  /** Trusted: attached to this Artifact, not closed or read-only, edit permission currently valid. */
  canEdit(): boolean;
  /** Trusted counter that changes whenever authority is re-evaluated or revoked. */
  permissionGeneration(): number;
  newRequestId?: () => string;
  /** Exact evaluations kept for current/candidate/history; initial main-thread entry budget is 3. */
  cacheEntries?: number;
  /** Host admission of the stored size (docs/cad/model.md, 総容量admission; CAD23). */
  admission?: CadAdmission;
}
/**
 * The Host counts a candidate's stored bytes while it evaluates and returns a receipt; directly
 * before the edit applies, `admit` sums its small ledger again for the latest record (versions,
 * a pending save) and returns a refusal code when the candidate does not fit. Nothing is guessed:
 * a receipt it cannot use is counted again or refused.
 */
export interface CadAdmission {
  prepare(candidate: CadDocument, candidateHash: string): Promise<unknown>;
  admit(receipt: unknown, candidate: CadDocument): string | undefined;
}
/** Opaque, in-memory only. Never serialized, sent or imported. */
declare const ticketBrand: unique symbol;
export type CadTicket = { readonly [ticketBrand]: true };
export interface CadReceipt {
  candidateHash: string;
  revision: LocalDraftRevision;
}
export type CadPrepareResult =
  | {
      status: 'ready';
      ticket: CadTicket;
      candidate: CadDocument;
      evaluation: CadEvaluation & { status: 'ok' };
    }
  | { status: 'rejected'; code: string }
  | {
      status: 'geometry-error';
      evaluation: CadEvaluation & { status: 'error' };
      /** The content that failed, so its feature and body names can be shown. */
      candidate: CadDocument;
    }
  | { status: 'stale' };
export type CadApplyResult =
  | { status: 'applied' | 'already-applied'; receipt: CadReceipt }
  | { status: 'rejected'; code: string };
export type CadGeometryState = 'ready' | 'reevaluating' | 'geometry-error';

interface TicketRecord {
  op: CadOperation;
  candidate: CadDocument;
  /** The Host's size receipt, when it admits candidates. */
  size?: unknown;
  base: LocalDraftRevision;
  baseHash: string;
  candidateHash: string;
  /** Build of the base content; a migration's candidate names another one. */
  baseBuildHash: string;
  generation: number;
  permission: number;
  state: 'ready' | 'consumed' | 'cancelled';
  receipt?: CadReceipt;
}

/**
 * One per Artifact session: async prepare → final synchronous revalidation → one ordinary
 * EditorSession transaction (docs/cad/operations.md). No second history; only in-flight
 * work, tickets and an exact-hash evaluation cache.
 */
export class CadCoordinator {
  private readonly tickets = new WeakMap<object, TicketRecord>();
  private readonly cache = new Map<string, CadEvaluation>();
  private generation = 0;
  private inFlight: string | undefined;
  private requests = 0;
  /** Latest refresh(); an older one's answer is discarded. */
  private refreshes = 0;
  /** The running refresh's request and content, for `stop` (CM-4). */
  private refreshing: { requestId: string; contentHash: string } | undefined;
  /** Last retryable failure (e.g. Worker crash); never cached as the document's evaluation. */
  private failure: CadEvaluation | undefined;
  constructor(private readonly options: CadCoordinatorOptions) {}

  get content(): CadDocument {
    return this.options.session.content;
  }
  get revision(): LocalDraftRevision {
    return this.options.session.revision;
  }
  /** Evaluation of exactly the current content, if any. Older results are never returned as current. */
  get evaluation(): CadEvaluation | undefined {
    return this.cache.get(cadContentHash(this.options.session.content));
  }
  /** The current evaluation is a read-only reference display by a substitute build. */
  get reference(): boolean {
    const current = this.evaluation;
    return current?.status === 'ok' && current.reference === true;
  }
  /** Content hashes whose evaluations are retained; lets a Surface keep matching meshes. */
  cachedContentHashes(): string[] {
    return [...this.cache.keys()];
  }
  /**
   * Drops one retained evaluation whose derived data the Surface released (a memory budget):
   * that content is evaluated again when it is shown next. Content and history are untouched.
   */
  forget(contentHash: string) {
    this.cache.delete(contentHash);
  }
  get geometryState(): CadGeometryState {
    const current = this.evaluation;
    if (current) return current.status === 'ok' ? 'ready' : 'geometry-error';
    const hash = cadContentHash(this.options.session.content);
    return this.failure?.contentHash === hash ? 'geometry-error' : 'reevaluating';
  }

  /** Why the current content has no shape, cached or retryable; undefined unless geometry-error. */
  get geometryFailure(): (CadEvaluation & { status: 'error' }) | undefined {
    const current = this.evaluation;
    if (current) return current.status === 'error' ? current : undefined;
    const hash = cadContentHash(this.options.session.content);
    return this.failure?.contentHash === hash && this.failure.status === 'error'
      ? this.failure
      : undefined;
  }

  private nextRequestId() {
    return this.options.newRequestId?.() ?? `cad-request-${++this.requests}`;
  }
  /** Records an owned, deeply frozen copy, so callers can never alter retained results. */
  private remember<T extends CadEvaluation>(result: T): T {
    const evaluation = deepFreeze(structuredClone(result));
    if (evaluation.status === 'error' && evaluation.retryable) {
      this.failure = evaluation;
      return evaluation;
    }
    this.cache.delete(evaluation.contentHash);
    this.cache.set(evaluation.contentHash, evaluation);
    const keep = this.options.cacheEntries ?? 3;
    const current = cadContentHash(this.options.session.content);
    for (const key of this.cache.keys()) {
      if (this.cache.size <= keep) break;
      if (key !== current && key !== evaluation.contentHash) this.cache.delete(key);
    }
    return evaluation;
  }
  /** Starts a new generation: in-flight work and unconsumed tickets become stale. */
  invalidate() {
    this.generation++;
    if (this.inFlight) this.options.kernel.cancel(this.inFlight);
    this.inFlight = undefined;
  }

  /** Validates and evaluates a candidate without touching live content or history. */
  async prepare(op: CadOperation): Promise<CadPrepareResult> {
    const { session, kernel } = this.options;
    // Any newer input supersedes older work and tickets, even one that is rejected below.
    this.invalidate();
    let candidate: CadDocument;
    // Snapshot once: the candidate and the ticket use the same operation, whatever the caller
    // does with its object while the kernel runs.
    let snapshot: CadOperation;
    try {
      assertCadOperation(op);
      snapshot = structuredClone(op);
      candidate = applyCadOperation(session.content, snapshot);
    } catch (error) {
      return { status: 'rejected', code: (error as Error).message };
    }
    const generation = this.generation;
    const base = session.revision;
    const baseHash = cadContentHash(session.content);
    const baseBuildHash = session.content.kernelProfile.buildHash;
    const permission = this.options.permissionGeneration();
    // R2b-2: stored poses that do not match their joints hold every edit but the explicit
    // "solve poses again" (R2b-U5), which in turn needs such a mismatch.
    if (session.content.joints.length) {
      if (!this.cache.has(baseHash)) await this.refresh();
      if (generation !== this.generation) return { status: 'stale' };
      const current = this.cache.get(baseHash);
      const mismatch = current?.status === 'ok' && !!current.assembly?.poseMismatch?.length;
      const solving = (snapshot.type === 'withSolvedPoses' ? snapshot.edit : snapshot).type;
      if (mismatch && solving !== 'solveAssemblyPoses')
        return { status: 'rejected', code: 'assembly-pose-mismatch' };
      if (!mismatch && solving === 'solveAssemblyPoses' && current?.status === 'ok')
        return { status: 'rejected', code: 'assembly-poses-match' };
    }
    let candidateHash = cadContentHash(candidate);
    let evaluation: CadEvaluation;
    let counted: { receipt: unknown } | undefined;
    let size: Promise<{ receipt: unknown } | undefined> | undefined;
    for (let round = 0; ; round++) {
      const requestId = this.nextRequestId();
      this.inFlight = requestId;
      try {
        const evaluating = kernel.evaluate({
          requestId,
          generation,
          baseHash,
          candidateHash,
          document: candidate,
        });
        // Counted while the kernel evaluates; a failed count refuses the edit, never passes it.
        size = this.options.admission?.prepare(candidate, candidateHash).then(
          (receipt) => ({ receipt }),
          () => undefined,
        );
        evaluation = await evaluating;
      } catch {
        evaluation = {
          status: 'error',
          contentHash: candidateHash,
          code: 'kernel-unavailable',
          retryable: true,
        };
      } finally {
        if (this.inFlight === requestId) this.inFlight = undefined;
      }
      counted = await size;
      if (generation !== this.generation || evaluation.contentHash !== candidateHash)
        return { status: 'stale' };
      if (evaluation.status === 'error')
        return { status: 'geometry-error', evaluation: this.remember(evaluation), candidate };
      // A substitute build may show a document, never decide an edit of it.
      if (evaluation.reference) return { status: 'rejected', code: 'kernel-reference-only' };
      if (evaluation.buildHash !== candidate.kernelProfile.buildHash)
        return { status: 'rejected', code: 'kernel-build-mismatch' };
      const assembly = evaluation.assembly;
      // A connector that no longer resolves refuses the edit that broke it (R2b-2). The first
      // broken joint's references are chosen again in the same edit (R2b-2b), one joint at a
      // time like features. An error of this candidate only, not remembered: its shapes did
      // evaluate.
      const brokenJoints = candidate.joints.filter(
        (j) => assembly?.joints?.[j.id]?.status === 'broken',
      );
      const first = brokenJoints[0] && assembly!.joints![brokenJoints[0].id];
      if (first?.status === 'broken') {
        const jointId = brokenJoints[0]!.id;
        const references: CadReferenceProblem[] = first.problems.flatMap((p) =>
          p.candidates
            ? [
                {
                  featureId: jointId,
                  path: jointRefPath(p.side),
                  status: p.code === 'connector-ambiguous' ? 'ambiguous' : 'missing',
                  // Shown where the part lies in this document; each `ref` keeps its own hint.
                  candidates: p.placed
                    ? p.candidates.map((c) => ({ ...c, hint: placeHint(c.hint, p.placed!) }))
                    : p.candidates,
                },
              ]
            : [],
        );
        const error: CadEvaluation = {
          status: 'error',
          contentHash: candidateHash,
          code: first.problems[0]!.code,
          featureId: jointId,
          retryable: false,
          brokenJoints: brokenJoints.map((j) => j.id),
          ...(references.length === first.problems.length ? { references } : {}),
        };
        return { status: 'geometry-error', evaluation: deepFreeze(error), candidate };
      }
      // A joint whose part cannot be read here keeps its child's stored pose: an edit that would
      // move that child (the joint itself, its values or offsets, where its parent connector is,
      // or a pose supplied for it) cannot be checked, so it is refused.
      if (!round && assembly?.joints) {
        const before = session.content;
        const current = this.evaluation;
        const solvedBefore = current?.status === 'ok' ? current.assembly?.joints : undefined;
        const was = parameterValues(before);
        const now = parameterValues(candidate);
        const inputs = (j: CadJoint, params: ParameterValues) =>
          canonicalJson([
            jointValues(j, params),
            resolvePosition(j.parent.offset.translation, params),
            resolvePosition(j.child.connector.offset.translation, params),
          ]);
        const moved = candidate.joints.some((j) => {
          const solution = assembly.joints![j.id];
          if (solution?.status !== 'unavailable') return false;
          const b = before.joints.find((x) => x.id === j.id);
          if (!b || canonicalJson(b) !== canonicalJson(j) || inputs(b, was) !== inputs(j, now))
            return true;
          // Its child stays at its stored pose, whatever poses the edit itself supplies.
          const kept = poseOf(before.solvedPoses, j.child.componentId);
          const placed = poseOf(candidate.solvedPoses, j.child.componentId);
          if (!kept || !placed || posesDiffer(kept, placed)) return true;
          // The parent connector, when it still resolves; otherwise the component it is on.
          if (solution.parent) {
            const prior = solvedBefore?.[j.id];
            return (
              !prior ||
              prior.status === 'broken' ||
              !prior.parent ||
              posesDiffer(prior.parent, solution.parent)
            );
          }
          const [on] = j.parent.componentPath;
          if (on === undefined) return false;
          const from = stepPose(before, before.solvedPoses, on, was);
          const to = assembly.poses && stepPose(candidate, assembly.poses, on, now);
          return !from || !to || posesDiffer(from, to);
        });
        if (moved) return { status: 'rejected', code: 'joint-part-unavailable' };
      }
      if (!assembly?.poseMismatch?.length) break;
      if (round) return { status: 'rejected', code: 'assembly-pose-unstable' };
      // The joints solved on this candidate's evaluation: their poses join the same edit, and
      // that candidate is evaluated in turn, so the ticket's edit reproduces what was checked.
      const children = candidate.joints.map((j) => j.child.componentId);
      snapshot = {
        type: 'withSolvedPoses',
        edit: snapshot.type === 'withSolvedPoses' ? snapshot.edit : snapshot,
        poses: Object.fromEntries(children.map((id) => [id, assembly.poses![id]!])),
      };
      try {
        candidate = applyCadOperation(session.content, snapshot);
      } catch (error) {
        return { status: 'rejected', code: (error as Error).message };
      }
      candidateHash = cadContentHash(candidate);
    }
    if (size && !counted) return { status: 'rejected', code: 'native-size-unavailable' };
    const owned = this.remember(evaluation);
    const ticket = Object.freeze(Object.create(null)) as CadTicket;
    this.tickets.set(ticket, {
      op: snapshot,
      // The ticket's own frozen copy: a caller changing the returned preview cannot change
      // what admission checks.
      candidate: deepFreeze(structuredClone(candidate)),
      ...(counted ? { size: counted.receipt } : {}),
      base,
      baseHash,
      candidateHash,
      baseBuildHash,
      generation,
      permission,
      state: 'ready',
    });
    return { status: 'ready', ticket, candidate, evaluation: owned };
  }

  /** Synchronous: every check runs after the caller's last await and directly before execute. */
  apply(ticket: CadTicket): CadApplyResult {
    const { session } = this.options;
    const record = this.tickets.get(ticket as object);
    if (!record) return { status: 'rejected', code: 'invalid-ticket' };
    if (!this.options.canEdit()) return { status: 'rejected', code: 'permission-denied' };
    if (this.options.permissionGeneration() !== record.permission)
      return { status: 'rejected', code: 'permission-changed' };
    // A consumed receipt is checked before the base: after applying, the base never matches.
    if (record.state === 'consumed')
      return sameLocalRevision(session.revision, record.receipt!.revision)
        ? { status: 'already-applied', receipt: record.receipt! }
        : { status: 'rejected', code: 'ticket-result-outdated' };
    if (record.state === 'cancelled') return { status: 'rejected', code: 'cancelled' };
    if (record.generation !== this.generation) return { status: 'rejected', code: 'stale' };
    const content = session.content;
    if (
      !sameLocalRevision(session.revision, record.base) ||
      cadContentHash(content) !== record.baseHash
    )
      return { status: 'rejected', code: 'stale' };
    if (content.kernelProfile.buildHash !== record.baseBuildHash)
      return { status: 'rejected', code: 'kernel-build-mismatch' };
    const { admission } = this.options;
    if (admission) {
      const refused =
        'size' in record
          ? admission.admit(record.size, record.candidate)
          : 'native-size-unavailable';
      if (refused) return { status: 'rejected', code: refused };
    }
    try {
      session.execute(
        cadEditorCommand(record.op, {
          expectedHash: record.baseHash,
          expectedResultHash: record.candidateHash,
          canEdit: () => this.options.canEdit(),
        }),
      );
    } catch (error) {
      record.state = 'cancelled';
      return { status: 'rejected', code: (error as Error).message };
    }
    record.state = 'consumed';
    // Frozen and detached so a caller cannot alter the revision the ticket checks rely on.
    record.receipt = deepFreeze({
      candidateHash: record.candidateHash,
      revision: structuredClone(session.revision),
    });
    this.generation++;
    return { status: 'applied', receipt: record.receipt };
  }

  /**
   * Stops the running evaluation (CM-4, P3): an edit's (it is not applied) or the current
   * content's, which then reports `cancelled` until it is calculated again. Content and history
   * stay as they are.
   */
  stop() {
    this.invalidate();
    const refreshing = this.refreshing;
    this.refreshing = undefined;
    if (!refreshing) return;
    // A result already on its way is discarded: the stop is the outcome until Recalculate.
    this.refreshes++;
    this.options.kernel.cancel(refreshing.requestId);
    this.remember({
      status: 'error',
      contentHash: refreshing.contentHash,
      code: 'cancelled',
      retryable: true,
    });
  }

  /** Discards a candidate; never creates history. */
  cancel(ticket?: CadTicket) {
    const record = ticket && this.tickets.get(ticket as object);
    if (record && record.state === 'ready') record.state = 'cancelled';
    if (!ticket) this.invalidate();
  }

  /** Undo/Redo restore the recipe synchronously, then reuse a matching evaluation or re-evaluate. */
  undo() {
    return this.history('undo');
  }
  redo() {
    return this.history('redo');
  }
  private history(direction: 'undo' | 'redo') {
    // History is an edit: the same authority guard as apply, at the commit boundary.
    if (!this.options.canEdit()) throw new Error('permission-denied');
    this.invalidate();
    this.options.session[direction]((candidate) => assertCad(candidate));
    return this.refresh();
  }
  /**
   * Evaluates the current content when no exact evaluation is cached. `retry` (an explicit
   * Recalculate) also discards a cached failure, e.g. a timeout under temporary load.
   */
  refresh({ retry = false }: { retry?: boolean } = {}): Promise<CadGeometryState> {
    const cached = this.evaluation;
    if (cached?.status === 'error' && retry) this.cache.delete(cached.contentHash);
    else if (cached) return Promise.resolve(this.geometryState);
    const document = this.options.session.content;
    const hash = cadContentHash(document);
    const requestId = this.nextRequestId();
    const refresh = ++this.refreshes;
    this.refreshing = { requestId, contentHash: hash };
    let pending: Promise<CadEvaluation>;
    try {
      pending = this.options.kernel.evaluate({
        requestId,
        generation: this.generation,
        baseHash: hash,
        candidateHash: hash,
        document,
      });
    } catch (error) {
      // A synchronous throw from the port takes the same recovery path as a rejection.
      pending = Promise.reject(error);
    }
    return pending
      .catch(
        (): CadEvaluation => ({
          status: 'error',
          contentHash: hash,
          code: 'kernel-unavailable',
          retryable: true,
        }),
      )
      .then((evaluation) => {
        if (this.refreshing?.requestId === requestId) this.refreshing = undefined;
        // A superseded refresh, an answer for other content, or one for content a newer prepare
        // already evaluated records nothing.
        if (refresh !== this.refreshes || evaluation.contentHash !== hash || this.cache.has(hash))
          return this.geometryState;
        // Geometry from another kernel build is presented only as a declared reference display.
        if (
          evaluation.status === 'ok' &&
          !evaluation.reference &&
          evaluation.buildHash !== document.kernelProfile.buildHash
        )
          evaluation = {
            status: 'error',
            contentHash: hash,
            code: 'kernel-build-mismatch',
            retryable: false,
          };
        this.remember(evaluation);
        return this.geometryState;
      });
  }
}
