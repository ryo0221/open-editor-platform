import { sameLocalRevision } from '@editor-platform/editor-core';
import {
  CONTROLLED_SURFACE_VERSION,
  type AtomicSurfaceInputs,
  type ControlledSurfaceController,
  type ControlledSurfaceSnapshot,
  type PreparedSurfaceCommand,
  type SurfaceOperation,
  type SurfaceSaveResult,
} from '@editor-platform/extension-contract/controlled-surface';
import type {
  Context,
  InputRegistration,
  LocalReadSnapshot,
  SaveOutcome,
} from '@editor-platform/extension-contract/draft2';
import { frozen, ReferenceError, requireThat } from './draft2/primitives';

export interface ControlledContext<T> {
  readonly basic: Context<T, never>['basic'];
  readonly addons: Pick<Context<T, never>['addons'], 'edit' | 'inputs' | 'save' | 'lifecycle'>;
}
/** Adapter-owned view/controller. No raw session, global subscription or domain branch. */
/** Internal execution shape is not an admission protocol. */
export function createControlledExecution<T>(
  context: ControlledContext<T>,
  options: { beforeMutation?(): void; onError(error: unknown): void },
): ControlledSurfaceController<T> {
  requireThat(context.addons.lifecycle.state === 'granted', 'LifecycleUnavailable');
  const lifecycle = context.addons.lifecycle.api;
  const listeners = new Set<() => void>(),
    observerFailures: unknown[] = [];
  let closed = false,
    mutating = false,
    saving = false;
  let lastOperation: SurfaceOperation | undefined, lastSave: SaveOutcome | undefined;
  let view: ControlledSurfaceSnapshot<T>;
  let group: AtomicSurfaceInputs<T> | undefined, registration: InputRegistration | undefined;
  let sequence = 0;
  const report = (error: unknown) => {
    observerFailures.push(error);
    try {
      options.onError(error);
    } catch (failure) {
      observerFailures.push(failure);
    }
  };
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    view = Object.freeze({ state: 'revoked', code: 'ScopeRevoked' });
    const stop = registration;
    registration = undefined;
    group = undefined;
    try {
      if (!lifecycle.signal.aborted) stop?.unregister();
    } catch (error) {
      report(error);
    }
    notify();
  };
  const read = () => {
    requireThat(!closed, 'ScopeRevoked');
    lifecycle.assertCurrent();
    return context.basic.read();
  };
  const canEdit = () =>
    context.addons.edit.state === 'granted' && context.addons.inputs.state === 'granted';
  const publish = (snapshot?: LocalReadSnapshot<T>) => {
    if (closed) return;
    try {
      view = frozen({
        state: 'open' as const,
        snapshot: snapshot ?? read(),
        canEdit: canEdit(),
        canSave: context.addons.save.state === 'granted',
        saving,
        ...(lastOperation ? { lastOperation } : {}),
        ...(lastSave ? { lastSave } : {}),
      });
    } catch {
      close();
      return;
    }
    notify();
  };
  const refused = (error: unknown): SurfaceOperation & { state: 'refused' } => ({
    state: 'refused',
    code: error instanceof ReferenceError ? error.code : 'OperationFailed',
    message: error instanceof Error ? error.message : String(error),
  });
  const pending = () => {
    const state = group?.read();
    return !!state && (state.dirty || state.composing);
  };
  const perform = (work: () => SurfaceOperation): SurfaceOperation => {
    if (mutating) return refused(new ReferenceError('SurfaceReentrancy'));
    mutating = true;
    let result: SurfaceOperation;
    try {
      read();
      result = work();
    } catch (error) {
      result = refused(error);
    } finally {
      mutating = false;
    }
    lastOperation = result;
    publish();
    return result;
  };
  const checkInputs = (inputSequence: number, clean: boolean) => {
    requireThat(inputSequence === sequence, 'InputChanged');
    if (clean) requireThat(!pending(), 'PendingInputs');
    requireThat(inputSequence === sequence, 'InputChanged');
  };
  const commit = (prepared: PreparedSurfaceCommand<T>, inputSequence: number, clean = false) => {
    const checkCurrentInputs = () => checkInputs(inputSequence, clean);
    checkCurrentInputs();
    requireThat(canEdit() && context.addons.edit.state === 'granted', 'EditUnavailable');
    const base = frozen(prepared.baseRevision),
      command = prepared.command && { ...prepared.command };
    requireThat(sameLocalRevision(base, read().revision), 'StaleInput');
    if (!command) return { state: 'unchanged' as const };
    options.beforeMutation?.();
    requireThat(sameLocalRevision(base, read().revision), 'StaleInput');
    checkCurrentInputs();
    context.addons.edit.api.execute({
      ...command,
      apply(content) {
        requireThat(sameLocalRevision(base, read().revision), 'StaleInput');
        checkCurrentInputs();
        return command.apply(content);
      },
    });
    return { state: 'applied' as const };
  };
  const prepareGroup = () => {
    const owner = group,
      ownRegistration = registration;
    requireThat(owner, 'InputsUnavailable');
    const state = owner.read();
    requireThat(!state.composing, 'InputComposing');
    const inputSequence = sequence;
    const prepared = owner.prepare(read());
    requireThat(inputSequence === sequence, 'InputChanged');
    return () =>
      perform(() => {
        requireThat(group === owner, 'InputOwnerChanged');
        requireThat(!owner.read().composing, 'InputComposing');
        const result = commit(prepared, inputSequence);
        const snapshot = read();
        // A view callback cannot retroactively turn an applied canonical command into refusal.
        try {
          owner.committed(snapshot);
          if (group === owner && registration === ownRegistration)
            ownRegistration?.changed(++sequence);
        } catch (error) {
          report(error);
        }
        return result;
      });
  };
  const controller: ControlledSurfaceController<T> = {
    version: CONTROLLED_SURFACE_VERSION,
    getSnapshot: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    execute: (prepared) =>
      perform(() => {
        const inputSequence = sequence;
        checkInputs(inputSequence, true);
        return commit(prepared, inputSequence, true);
      }),
    applyInputs() {
      try {
        read();
        requireThat(!mutating, 'SurfaceReentrancy');
        requireThat(canEdit(), 'EditUnavailable');
        if (!pending()) return perform(() => ({ state: 'unchanged' }));
        // Preflight is pure and cannot reenter this controller's mutation path.
        mutating = true;
        let apply: () => SurfaceOperation;
        try {
          apply = prepareGroup();
        } finally {
          mutating = false;
        }
        return apply();
      } catch (error) {
        const result = refused(error);
        lastOperation = result;
        publish();
        return result;
      }
    },
    undo: () =>
      perform(() => {
        requireThat(canEdit() && context.addons.edit.state === 'granted', 'EditUnavailable');
        const inputSequence = sequence;
        checkInputs(inputSequence, true);
        const before = read().revision;
        options.beforeMutation?.();
        requireThat(sameLocalRevision(before, read().revision), 'StaleInput');
        checkInputs(inputSequence, true);
        context.addons.edit.api.undo();
        return { state: sameLocalRevision(before, read().revision) ? 'unchanged' : 'applied' };
      }),
    redo: () =>
      perform(() => {
        requireThat(canEdit() && context.addons.edit.state === 'granted', 'EditUnavailable');
        const inputSequence = sequence;
        checkInputs(inputSequence, true);
        const before = read().revision;
        options.beforeMutation?.();
        requireThat(sameLocalRevision(before, read().revision), 'StaleInput');
        checkInputs(inputSequence, true);
        context.addons.edit.api.redo();
        return { state: sameLocalRevision(before, read().revision) ? 'unchanged' : 'applied' };
      }),
    async save(): Promise<SurfaceSaveResult> {
      try {
        read();
        requireThat(!mutating && !saving, 'SaveBusy');
        requireThat(context.addons.save.state === 'granted', 'SaveUnavailable');
        // Domain-owned buffers must not be silently omitted when Inputs is unavailable.
        requireThat(!pending() || context.addons.inputs.state === 'granted', 'InputsUnavailable');
        saving = true;
        publish();
        try {
          const outcome = await context.addons.save.api.save();
          lastSave = outcome;
          return { state: 'outcome', outcome };
        } finally {
          saving = false;
          publish();
        }
      } catch (error) {
        return refused(error);
      }
    },
    bindInputs(owner) {
      read();
      requireThat(!group, 'InputOwnerExists');
      group = owner;
      if (context.addons.inputs.state === 'granted') {
        try {
          registration = context.addons.inputs.api.register('controlled-surface', {
            label: owner.label,
            read: () => owner.read(),
            focus: () => owner.focus(),
            prepare: () => {
              requireThat(!mutating, 'SurfaceReentrancy');
              mutating = true;
              let apply: () => SurfaceOperation;
              try {
                apply = prepareGroup();
              } finally {
                mutating = false;
              }
              return () => {
                const result = apply();
                if (result.state === 'refused') throw new ReferenceError(result.code);
              };
            },
          });
        } catch (error) {
          group = undefined;
          throw error;
        }
      }
      const ownedRegistration = registration;
      return {
        changed() {
          read();
          requireThat(group === owner, 'InputOwnerChanged');
          ownedRegistration?.changed(++sequence);
        },
        unregister() {
          if (group !== owner) return;
          ownedRegistration?.unregister();
          group = undefined;
          registration = undefined;
        },
      };
    },
  };
  lifecycle.registerDisposable('controlled-surface-controller', () => {
    close();
    lifecycle.signal.removeEventListener('abort', close);
    listeners.clear();
    if (observerFailures.length)
      throw new AggregateError(observerFailures, 'Surface observer failures');
  });
  lifecycle.signal.addEventListener('abort', close, { once: true });
  publish();
  return Object.freeze(controller);
}
