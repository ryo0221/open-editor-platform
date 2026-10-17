import {
  sameLocalRevision,
  type EditorInputs,
  type EditorInputBoundary,
  type EditorCommand,
  type LocalDraftRevision,
} from '@editor-platform/editor-core';
import type {
  InputCheckpoint,
  Inputs,
  RecoverySummary,
  Scope,
} from '@editor-platform/extension-contract/draft2';
import { copyData, frozen, requireThat, type Ownership, type Clock } from './primitives';
export interface RecoveryPolicy {
  codecs: readonly { id: string; version: string }[];
  perBoundaryBytes: number;
  totalBytes: number;
  ttlMs: number;
  onRevoke: 'retain' | 'discard';
}
interface RecordEntry {
  scope: Scope;
  boundaryId: string;
  checkpoint: InputCheckpoint;
  bytes: number;
  expires: number;
  state: 'retained' | 'discarded-by-policy';
}
/** Bounded last checkpoints only. Host-only; not another input registry or edit log. */
export class RecoveryStore {
  private records = new Map<string, RecordEntry>();
  constructor(
    private readonly clock: Clock,
    private readonly maxRecords = 64,
  ) {}
  private key(scope: Scope, id: string) {
    return `${scope.generation}:${id}`;
  }
  put(scope: Scope, id: string, checkpoint: InputCheckpoint, policy: RecoveryPolicy): void {
    const value = copyData(checkpoint, policy.perBoundaryBytes);
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    const key = this.key(scope, id);
    const total = [...this.records].reduce(
      (sum, [other, record]) =>
        sum + (other !== key && record.state === 'retained' ? record.bytes : 0),
      0,
    );
    requireThat(
      (this.records.has(key) || this.records.size < this.maxRecords) &&
        total + bytes <= policy.totalBytes,
      'DataLimit',
    );
    this.records.set(key, {
      scope,
      boundaryId: id,
      checkpoint: frozen(value),
      bytes,
      expires: this.clock.now() + policy.ttlMs,
      state: 'retained',
    });
  }
  inspect(scope: Scope, id: string): Readonly<RecordEntry> | undefined {
    const record = this.records.get(this.key(scope, id));
    if (!record) return;
    if (record.expires <= this.clock.now()) {
      this.records.delete(this.key(scope, id));
      return;
    }
    return frozen(record);
  }
  discard(scope: Scope, id: string): void {
    this.records.delete(this.key(scope, id));
  }
  apply<T>(options: {
    oldScope: Scope;
    boundaryId: string;
    newScope: Scope;
    policy: RecoveryPolicy;
    revision: LocalDraftRevision;
    check(): void;
    command(payload: InputCheckpoint['payload']): EditorCommand<T>;
    execute(command: EditorCommand<T>): void;
  }): void {
    options.check();
    requireThat(
      options.oldScope.artifactId === options.newScope.artifactId &&
        options.oldScope.generation !== options.newScope.generation,
      'RecoveryScope',
    );
    const record = this.inspect(options.oldScope, options.boundaryId);
    requireThat(
      record &&
        record.state === 'retained' &&
        options.policy.codecs.some(
          (codec) =>
            codec.id === record.checkpoint.codec.id &&
            codec.version === record.checkpoint.codec.version,
        ),
      'RecoveryPolicy',
    );
    requireThat(
      sameLocalRevision(record.checkpoint.baseRevision, options.revision),
      'RecoveryConflict',
    );
    const cmd = options.command(copyData(record.checkpoint.payload));
    options.check();
    options.execute(cmd);
  }
}
interface BoundaryState {
  id: string;
  boundary: EditorInputBoundary;
  flags: ReturnType<EditorInputBoundary['read']>;
  sequence: number;
  unregister(): void;
  checkpoint?: InputCheckpoint;
  refused: boolean;
}
export function createInputs(options: {
  scope: Scope;
  registry: EditorInputs;
  policy: RecoveryPolicy;
  store: RecoveryStore;
  ownership: Ownership;
  ownershipFailure(error: unknown): void;
  check(): void;
  currentRevision(): LocalDraftRevision;
  issued(revision: LocalDraftRevision): boolean;
}) {
  const states = new Map<string, BoundaryState>();
  const subscriptions = new Set<() => void>();
  let closed = false;
  const api: Inputs = {
    version: 'inputs@0-draft',
    register(id, boundary) {
      options.check();
      requireThat(
        !closed && id.length > 0 && id.length <= 128 && !states.has(id) && states.size < 32,
        'InputAdmission',
      );
      const registrationHold = options.ownership.hold(`input-registration:${crypto.randomUUID()}`);
      let release: (() => void) | undefined;
      let detachRequested = false;
      const detach = () => {
        detachRequested = true;
        const stop = release;
        release = undefined;
        try {
          stop?.();
        } catch (error) {
          registrationHold.fail(String(error));
          throw error;
        }
      };
      const state: BoundaryState = {
        id,
        boundary,
        flags: { dirty: false },
        sequence: 0,
        unregister: detach,
        refused: false,
      };
      const refresh = () => {
        options.check();
        state.flags = copyData(boundary.read());
        options.check();
      };
      const wrapped: EditorInputBoundary = {
        label: boundary.label,
        read: () => state.flags,
        prepare: () => {
          options.check();
          const commit = boundary.prepare();
          options.check();
          return () => {
            options.check();
            const result = commit();
            options.check();
            refresh();
            return result;
          };
        },
        focus: () => {
          options.check();
          boundary.focus();
        },
        ...(boundary.history
          ? {
              history: (direction: 'undo' | 'redo') => {
                options.check();
                const result = boundary.history!(direction);
                refresh();
                return result;
              },
            }
          : {}),
      };
      states.set(id, state);
      try {
        refresh();
        release = options.registry.register(wrapped);
        if (detachRequested || closed || states.get(id) !== state) detach();
        options.check();
        registrationHold.done();
      } catch (error) {
        if (states.get(id) === state) states.delete(id);
        try {
          detach();
          registrationHold.done();
        } catch (cleanupError) {
          registrationHold.fail(String(cleanupError));
        }
        throw error;
      }
      return {
        changed(sequence) {
          options.check();
          requireThat(
            states.get(id) === state &&
              Number.isSafeInteger(sequence) &&
              sequence >= state.sequence,
            'InputSequence',
          );
          state.sequence = sequence;
          refresh();
          options.registry.changed();
        },
        checkpoint(value) {
          try {
            options.check();
          } catch {
            return { state: 'refused', reason: 'revoked' };
          }
          if (states.get(id) !== state) return { state: 'refused', reason: 'revoked' };
          try {
            const checkpoint = copyData(value, options.policy.perBoundaryBytes);
            if (
              !Number.isSafeInteger(checkpoint.sequence) ||
              checkpoint.sequence !== state.sequence ||
              checkpoint.sequence < 0
            )
              return { state: 'refused', reason: 'stale' };
            if (
              checkpoint.baseRevision.kind !== 'local-draft' ||
              !options.issued(checkpoint.baseRevision) ||
              !options.policy.codecs.some(
                (codec) =>
                  codec.id === checkpoint.codec.id && codec.version === checkpoint.codec.version,
              )
            ) {
              state.refused = true;
              return { state: 'refused', reason: 'policy' };
            }
            options.store.put(options.scope, id, checkpoint, options.policy);
            state.checkpoint = frozen(checkpoint);
            state.refused = false;
            return { state: 'retained', sequence: checkpoint.sequence };
          } catch {
            state.refused = true;
            return { state: 'refused', reason: 'limit' };
          }
        },
        unregister() {
          if (closed || states.get(id) !== state) return;
          options.check();
          requireThat(!state.flags.dirty && !state.flags.composing, 'DirtyInput');
          states.delete(id);
          state.unregister();
        },
      };
    },
    getSnapshot() {
      options.check();
      return { ...options.registry.getSnapshot() };
    },
    subscribe(listener) {
      options.check();
      const stop = options.registry.subscribe(() => {
        if (!closed) {
          options.check();
          listener();
        }
      });
      subscriptions.add(stop);
      return () => {
        stop();
        subscriptions.delete(stop);
      };
    },
  };
  return {
    api,
    revoke(): readonly RecoverySummary[] {
      if (closed) return [];
      closed = true;
      for (const stop of subscriptions) stop();
      subscriptions.clear();
      const report: RecoverySummary[] = [];
      const failures: unknown[] = [];
      for (const state of states.values()) {
        const retained = options.store.inspect(options.scope, state.id);
        let status: RecoverySummary['state'] = retained
          ? retained.checkpoint.sequence !== state.sequence ||
            !sameLocalRevision(retained.checkpoint.baseRevision, options.currentRevision())
            ? 'stale'
            : 'retained'
          : state.refused
            ? 'policy-denied'
            : 'missing';
        if (options.policy.onRevoke === 'discard') {
          options.store.discard(options.scope, state.id);
          status = 'discarded-by-policy';
        }
        if (state.flags.dirty || state.flags.composing)
          report.push({
            boundaryId: state.id,
            state: status,
            ...(retained ? { sequence: retained.checkpoint.sequence } : {}),
          });
        try {
          state.unregister();
        } catch (error) {
          failures.push(error);
        }
      }
      states.clear();
      if (failures.length)
        options.ownershipFailure(new AggregateError(failures, 'Input detach notification failed'));
      return frozen(report);
    },
  };
}
