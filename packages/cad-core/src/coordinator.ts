import { deepFreeze } from '@editor-platform/artifact-core';
import {
  sameLocalRevision,
  type EditorSession,
  type LocalDraftRevision,
} from '@editor-platform/editor-core';
import { cadEditorCommand, assertCadOperation } from './commands';
import type { CadDocument, Vec3 } from './model';
import { applyCadOperation, cadContentHash, type CadOperation } from './operations';
import { assertCad } from './validation';

export interface CadBodyEvaluation {
  volumeMm3: number;
  areaMm2: number;
  bounds: [Vec3, Vec3];
}
/** Kernel output for one exact document. Meshes/pick tables travel beside it, keyed by the same hash. */
export type CadEvaluation =
  | {
      status: 'ok';
      contentHash: string;
      buildHash: string;
      geometryDigest: string;
      bodies: Record<string, CadBodyEvaluation>;
    }
  | { status: 'error'; contentHash: string; code: string; featureId?: string; retryable: boolean };
export interface CadEvaluateRequest {
  requestId: string;
  generation: number;
  baseHash: string;
  candidateHash: string;
  document: CadDocument;
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
  | { status: 'geometry-error'; evaluation: CadEvaluation & { status: 'error' } }
  | { status: 'stale' };
export type CadApplyResult =
  | { status: 'applied' | 'already-applied'; receipt: CadReceipt }
  | { status: 'rejected'; code: string };
export type CadGeometryState = 'ready' | 'reevaluating' | 'geometry-error';

interface TicketRecord {
  op: CadOperation;
  base: LocalDraftRevision;
  baseHash: string;
  candidateHash: string;
  buildHash: string;
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
  /** Content hashes whose evaluations are retained; lets a Surface keep matching meshes. */
  cachedContentHashes(): string[] {
    return [...this.cache.keys()];
  }
  get geometryState(): CadGeometryState {
    const current = this.evaluation;
    if (current) return current.status === 'ok' ? 'ready' : 'geometry-error';
    const hash = cadContentHash(this.options.session.content);
    return this.failure?.contentHash === hash ? 'geometry-error' : 'reevaluating';
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
    const requestId = this.nextRequestId();
    const base = session.revision;
    const baseHash = cadContentHash(session.content);
    const candidateHash = cadContentHash(candidate);
    const permission = this.options.permissionGeneration();
    this.inFlight = requestId;
    let evaluation: CadEvaluation;
    try {
      evaluation = await kernel.evaluate({
        requestId,
        generation,
        baseHash,
        candidateHash,
        document: candidate,
      });
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
    if (generation !== this.generation || evaluation.contentHash !== candidateHash)
      return { status: 'stale' };
    if (evaluation.status === 'error')
      return { status: 'geometry-error', evaluation: this.remember(evaluation) };
    if (evaluation.buildHash !== candidate.kernelProfile.buildHash)
      return { status: 'rejected', code: 'kernel-build-mismatch' };
    const owned = this.remember(evaluation);
    const ticket = Object.freeze(Object.create(null)) as CadTicket;
    this.tickets.set(ticket, {
      op: snapshot,
      base,
      baseHash,
      candidateHash,
      buildHash: owned.buildHash,
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
    if (content.kernelProfile.buildHash !== record.buildHash)
      return { status: 'rejected', code: 'kernel-build-mismatch' };
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
        // A superseded refresh, an answer for other content, or one for content a newer prepare
        // already evaluated records nothing.
        if (refresh !== this.refreshes || evaluation.contentHash !== hash || this.cache.has(hash))
          return this.geometryState;
        // Geometry from another kernel build is never presented for this document.
        if (evaluation.status === 'ok' && evaluation.buildHash !== document.kernelProfile.buildHash)
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
