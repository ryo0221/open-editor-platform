import {
  sameLocalRevision,
  type EditorCommand,
  type EditorInputs,
  type EditorSession,
} from '@editor-platform/editor-core';
import {
  readAnimationV1,
  type AnimationContent,
  type AnimationContentV1,
} from '@editor-platform/animation-core';
import {
  CONTROLLED_SURFACE_VERSION,
  type AtomicSurfaceInputs,
  type ControlledSurfaceController,
  type ControlledSurfaceSnapshot,
  type PreparedSurfaceCommand,
  type SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
import type { AnimationPlaybackLifecycle } from './playback';

/** Thin facade over the caller's canonical session and input coordinator. No own history/storage. */
export function createLocalAnimationController(options: {
  artifactId: string;
  session: EditorSession<AnimationContentV1>;
  inputs: EditorInputs;
  canEdit(): boolean;
  isSaving?(): boolean;
  execute(command: EditorCommand<AnimationContentV1>): boolean | void;
  history(direction: 'undo' | 'redo'): void;
  beforeMutation(): void;
  onError?(error: unknown): void;
}) {
  const abort = new AbortController(),
    listeners = new Set<() => void>();
  const disposables = new Set<() => void | Promise<void>>();
  const scope = Object.freeze({
    artifactId: options.artifactId,
    sessionId: options.session.revision.sessionId,
    generation: crypto.randomUUID(),
  });
  let group: AtomicSurfaceInputs<AnimationContent> | undefined,
    unregister: (() => void) | undefined;
  let sequence = 0,
    mutating = false;
  let view: ControlledSurfaceSnapshot<AnimationContent>;
  const snapshot = () => ({
    scope,
    revision: options.session.revision,
    content: options.session.content,
  });
  const assertCurrent = () => {
    if (abort.signal.aborted) throw Error('Animation scope closed');
  };
  const assertEdit = () => {
    assertCurrent();
    if (options.isSaving?.()) throw Error('Animation is saving');
    if (!options.canEdit()) throw Error('Read only');
  };
  const notify = () => {
    view = abort.signal.aborted
      ? { state: 'revoked', code: 'ScopeRevoked' }
      : {
          state: 'open',
          snapshot: snapshot(),
          canEdit: options.canEdit() && !options.isSaving?.(),
          canSave: false,
          saving: options.isSaving?.() ?? false,
        };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        options.onError?.(error);
      }
    }
  };
  const refuse = (error: unknown): SurfaceOperation => ({
    state: 'refused',
    code: 'AnimationOperationRefused',
    message: error instanceof Error ? error.message : String(error),
  });
  const operation = (work: () => void): SurfaceOperation => {
    if (mutating) return refuse('Reentrant operation');
    mutating = true;
    try {
      assertEdit();
      work();
      notify();
      return { state: 'applied' };
    } catch (error) {
      return refuse(error);
    } finally {
      mutating = false;
    }
  };
  const apply = (prepared: PreparedSurfaceCommand<AnimationContent>, expectedSequence: number) => {
    assertEdit();
    if (
      !sameLocalRevision(prepared.baseRevision, options.session.revision) ||
      sequence !== expectedSequence
    )
      throw Error('Animation inputs changed; cancel or reapply');
    options.beforeMutation();
    assertEdit();
    if (
      !sameLocalRevision(prepared.baseRevision, options.session.revision) ||
      sequence !== expectedSequence
    )
      throw Error('Animation inputs changed; cancel or reapply');
    const command = prepared.command;
    if (
      command &&
      options.execute({
        ...command,
        apply: (content) => readAnimationV1(command.apply(content)),
      }) === false
    )
      throw Error('Animation change rejected');
  };
  const prepareGroup = () => {
    const owner = group,
      expectedSequence = sequence;
    assertEdit();
    if (!owner) return () => {};
    if (owner.read().composing) throw Error('入力変換・ドラッグを確定してください。');
    const prepared = owner.prepare(snapshot());
    return () => {
      if (owner !== group || owner.read().composing) throw Error('Animation input owner changed');
      apply(prepared, expectedSequence);
      owner.committed(snapshot());
      options.inputs.changed();
      notify();
    };
  };
  const controller: ControlledSurfaceController<AnimationContent> = {
    version: CONTROLLED_SURFACE_VERSION,
    getSnapshot: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    execute: (prepared) =>
      operation(() => {
        if (group?.read().dirty || group?.read().composing)
          throw Error('Apply or cancel pending inputs');
        apply(prepared, sequence);
      }),
    applyInputs: () =>
      operation(() => {
        prepareGroup()();
      }),
    undo: () =>
      operation(() => {
        options.inputs.flush();
        options.beforeMutation();
        options.history('undo');
      }),
    redo: () =>
      operation(() => {
        options.inputs.flush();
        options.beforeMutation();
        options.history('redo');
      }),
    async save() {
      return { state: 'refused', code: 'UseHostSave', message: 'Use the common version toolbar' };
    },
    bindInputs(value) {
      assertCurrent();
      if (group) throw Error('Animation input group already bound');
      group = value;
      unregister = options.inputs.register({
        label: value.label,
        read: value.read,
        focus: value.focus,
        prepare: prepareGroup,
      });
      return {
        changed() {
          if (group !== value || abort.signal.aborted) return;
          sequence++;
          options.inputs.changed();
        },
        unregister() {
          if (group !== value) return;
          group = undefined;
          const stop = unregister;
          unregister = undefined;
          stop?.();
        },
      };
    },
  };
  const lifecycle: AnimationPlaybackLifecycle = {
    signal: abort.signal,
    assertCurrent,
    registerDisposable(_name, dispose) {
      assertCurrent();
      disposables.add(dispose);
    },
  };
  notify();
  let drain: Promise<void> | undefined;
  return {
    controller,
    lifecycle,
    notify,
    dispose() {
      if (drain) return drain;
      abort.abort();
      unregister?.();
      unregister = undefined;
      group = undefined;
      notify();
      listeners.clear();
      drain = Promise.allSettled(
        [...disposables].map(async (dispose) => {
          await dispose();
        }),
      ).then((results) => {
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failures.length)
          throw new AggregateError(
            failures.map((r) => r.reason),
            'Animation cleanup failed',
          );
      });
      return drain;
    },
  };
}
