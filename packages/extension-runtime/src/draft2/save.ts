import { contentHash } from '@editor-platform/artifact-core';
import type {
  LocalReadSnapshot,
  SaveCapture,
  SaveOutcome,
  Scope,
} from '@editor-platform/extension-contract/draft2';
import {
  aborted,
  deferred,
  delivery,
  finite,
  frozen,
  requireThat,
  type Clock,
  type Ownership,
} from './primitives';

export interface WriteRequest<T> {
  operationId: string;
  capture: SaveCapture;
  content: T;
}
export type WriteEvidence =
  | { state: 'committed'; operationId: string; capture: SaveCapture; adapterReceiptId: string }
  | { state: 'no-write'; operationId: string; capture: SaveCapture; guarantee: 'never-writes' }
  | { state: 'unknown' };
/** Host-reviewed adapter; a digest-shaped string is not independent proof of storage. */
export interface Storage<T> {
  key: string;
  settlementMs: number;
  write(request: WriteRequest<T>, signal: AbortSignal): Promise<WriteEvidence>;
  /** Deterministic fake handoff gate, not an extension callback. */
  beforeDispatch?(): Promise<void>;
  retainCapture?(snapshot: LocalReadSnapshot<T>): () => void;
  markSaved?(capture: SaveCapture): void;
}
interface Job {
  request: WriteRequest<unknown>;
  key: string;
  outcome?: SaveOutcome;
  finish(evidence: WriteEvidence): void;
}
export class SaveCoordinator {
  private claims = new Set<string>();
  private admissionListeners = new Set<(id: string) => void>();
  nextAdmission(): Promise<string> {
    return new Promise((resolve) => {
      const listener = (id: string) => {
        this.admissionListeners.delete(listener);
        resolve(id);
      };
      this.admissionListeners.add(listener);
    });
  }
  private jobs = new Map<string, Job>();
  constructor(
    private readonly clock: Clock,
    private readonly maxJobs = 64,
  ) {}
  observations(): readonly { operationId: string; outcome?: SaveOutcome }[] {
    return [...this.jobs].map(([operationId, job]) =>
      frozen({ operationId, ...(job.outcome ? { outcome: job.outcome } : {}) }),
    );
  }
  reconcile(operationId: string, evidence: WriteEvidence): void {
    const job = this.jobs.get(operationId);
    requireThat(job, 'UnknownOperation');
    job.finish(evidence);
  }
  forget(operationId: string): void {
    const job = this.jobs.get(operationId);
    requireThat(job?.outcome && job.outcome.state !== 'indeterminate', 'UnresolvedOperation');
    this.jobs.delete(operationId);
  }
  async save<T>(options: {
    storage: Storage<T>;
    scope: Scope;
    signal: AbortSignal;
    caller?: AbortSignal;
    ownership: Ownership;
    check(): void;
    flush(): void;
    capture(): LocalReadSnapshot<T>;
    isCurrent(capture: SaveCapture): boolean;
  }): Promise<SaveOutcome> {
    const { storage, signal, caller, ownership, check } = options;
    check();
    aborted(caller);
    requireThat(finite(storage.settlementMs), 'DeadlinePolicy');
    requireThat(!this.claims.has(storage.key), 'SaveBusy');
    requireThat(this.jobs.size + this.claims.size < this.maxJobs, 'JobLimit');
    const preparation = ownership.hold(`save-preparation:${crypto.randomUUID()}`);
    this.claims.add(storage.key);
    let snapshot: LocalReadSnapshot<T>;
    let hash: string;
    let capture: SaveCapture;
    let operationId: string;
    let request: WriteRequest<T>;
    let hold: ReturnType<Ownership['hold']> | undefined;
    let release = () => {};
    try {
      options.flush();
      check();
      aborted(caller);
      snapshot = frozen(options.capture());
      release = storage.retainCapture?.(snapshot) ?? release;
      hash = await contentHash(snapshot.content);
      check();
      aborted(caller);
      // Capture/request envelopes add budgeted fields beyond the read snapshot.
      // Any failure here is still before dispatch and must release both ownership and key claim.
      capture = frozen({ scope: options.scope, revision: snapshot.revision, contentHash: hash });
      operationId = crypto.randomUUID();
      request = frozen({ operationId, capture, content: snapshot.content });
      hold = ownership.hold(`save:${operationId}`);
      preparation.done();
    } catch (error) {
      this.claims.delete(storage.key);
      try {
        release();
        hold?.done();
        preparation.done();
      } catch (cleanupError) {
        hold?.fail(String(cleanupError));
        preparation.fail(String(cleanupError));
      }
      throw error;
    }
    const ownedWrite = hold;
    const result = deferred<SaveOutcome>();
    const controller = new AbortController();
    let dispatched = false;
    let definitive = false;
    const deadline = this.clock.now() + storage.settlementMs;
    let unsubscribe = () => {};
    const clean = () => {
      unsubscribe();
      signal.removeEventListener('abort', cancel);
      caller?.removeEventListener('abort', cancel);
    };
    const settle = (outcome: SaveOutcome) => {
      if (definitive) return;
      job.outcome = frozen(outcome);
      result.resolve(job.outcome);
      if (outcome.state !== 'indeterminate') {
        definitive = true;
        clean();
        this.claims.delete(storage.key);
        try {
          release();
          ownedWrite.done();
        } catch (error) {
          ownedWrite.fail(String(error));
        }
        if (outcome.state === 'committed' && options.isCurrent(capture))
          storage.markSaved?.(capture);
      } else {
        unsubscribe();
      }
    };
    const unknown = (reason: Extract<SaveOutcome, { state: 'indeterminate' }>['reason']) =>
      settle({ state: 'indeterminate', operationId, capture, reason });
    const finish = (evidence: WriteEvidence) => {
      if (definitive) return;
      if (evidence.state === 'unknown') {
        unknown('adapter-unknown');
        return;
      }
      if (
        evidence.operationId !== operationId ||
        JSON.stringify(evidence.capture) !== JSON.stringify(capture) ||
        (evidence.state === 'committed'
          ? !evidence.adapterReceiptId
          : evidence.guarantee !== 'never-writes')
      ) {
        unknown('invalid-receipt');
        return;
      }
      if (evidence.state === 'no-write')
        settle({
          state: 'aborted-before-write',
          operationId,
          capture,
          proof: 'adapter-no-write-guarantee',
        });
      else
        settle({
          state: 'committed',
          operationId,
          capture,
          receipt: {
            adapterReceiptId: evidence.adapterReceiptId,
            durability: 'adapter-acknowledged',
          },
        });
    };
    const job: Job = { request, key: storage.key, finish };
    this.jobs.set(operationId, job);
    for (const listener of [...this.admissionListeners]) listener(operationId);
    const cancel = () => {
      controller.abort();
      if (!dispatched)
        settle({ state: 'aborted-before-write', operationId, capture, proof: 'not-dispatched' });
    };
    signal.addEventListener('abort', cancel);
    caller?.addEventListener('abort', cancel);
    const tick = () => {
      if (this.clock.now() >= deadline) {
        if (dispatched) unknown('deadline');
        else cancel();
      }
    };
    unsubscribe = this.clock.subscribe(tick);
    const handoff = async () => {
      try {
        await storage.beforeDispatch?.();
        if (definitive) return;
        tick();
        if (definitive) return;
        if (signal.aborted || caller?.aborted) {
          cancel();
          return;
        }
        check();
        // Host permission callbacks can synchronously settle/revoke this handoff.
        // Do not dispatch after not-dispatched proof has released capture ownership.
        if (definitive) return;
        if (signal.aborted || caller?.aborted || controller.signal.aborted) {
          cancel();
          return;
        }
        dispatched = true;
        const evidence = await storage.write(request, controller.signal);
        finish(evidence);
      } catch {
        if (dispatched) unknown('transport');
        else cancel();
      }
    };
    void handoff();
    return delivery(result.promise, signal, check);
  }
}
