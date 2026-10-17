/** Internal scope execution shared by distinct admission front doors. No schema coercion. */
import {
  sameLocalRevision,
  type EditorInputs,
  type EditorSession,
  type EditorCommand,
  type LocalDraftRevision,
} from '@editor-platform/editor-core';
import type {
  Basic,
  Grant,
  Scope,
  LocalReadSnapshot,
  Edit,
  Inputs,
  Save,
  Lifecycle,
  Resources,
  CloseResult,
  RevokeTicket,
  DrainReport,
} from '@editor-platform/extension-contract/draft2';
import {
  aborted,
  copyData,
  frozen,
  Ownership,
  ReferenceError,
  requireThat,
  type Clock,
} from './draft2/primitives';
import { createInputs, type RecoveryPolicy, type RecoveryStore } from './draft2/inputs';
import { createResources, type ResourceProvider } from './draft2/resources';
import type { SaveCoordinator, Storage } from './draft2/save';
export interface ExecutionOwner {
  readonly clock: Clock;
  readonly saves: SaveCoordinator;
  readonly recovery: RecoveryStore;
}
export interface ExecutionBinding<T, Ref> {
  readonly artifactId: string;
  readonly session: EditorSession<T>;
  readonly inputs: EditorInputs;
  allowed(grant: Grant): boolean;
  subscribePermissions(listener: () => void): () => void;
  readonly recovery?: RecoveryPolicy;
  readonly storage?: Storage<T>;
  readonly resources?: ResourceProvider<Ref>;
}
export interface ExecutionApis<T, Ref> {
  edit: Edit<T>;
  inputs: Inputs | undefined;
  lifecycle: Lifecycle;
  save: Save;
  resources: Resources<Ref> | undefined;
}
export interface ScopedHandle<C> {
  readonly scope: Scope;
  readonly context: C;
  mount(container: HTMLElement): void;
  requestClose(): CloseResult;
  revoke(reason: 'uninstall' | 'replace' | 'permission-expired' | 'host-close'): RevokeTicket;
  drain(options: { deadlineMs: number }): Promise<DrainReport>;
}
export function openScoped<T, Ref, C>(options: {
  owner: ExecutionOwner;
  binding: ExecutionBinding<T, Ref>;
  grants: ReadonlySet<Grant>;
  inputsAvailable: boolean;
  strict?: boolean;
  checkOwner?(): void;
  validate(content: T): void;
  surface: boolean;
  mount?: (container: HTMLElement, context: C) => void;
  contextFor(basic: Basic<T>, apis: ExecutionApis<T, Ref>): C;
  transition<R>(work: () => R): R;
  isTransitioning(): boolean;
  onActive(revoke: () => RevokeTicket): void;
  onRevoke(revoke: () => RevokeTicket): void;
}): ScopedHandle<C> {
  const {
    owner,
    binding,
    grants,
    validate,
    surface,
    mount,
    contextFor,
    transition,
    isTransitioning,
    onActive,
    onRevoke,
  } = options;
  const policy = binding.recovery;
  const scope: Scope = frozen({
    artifactId: binding.artifactId,
    sessionId: binding.session.revision.sessionId,
    generation: crypto.randomUUID(),
  });
  const controller = new AbortController();
  const ownership = new Ownership(scope, owner.clock);
  let ticket: RevokeTicket | undefined;
  let mounted = false;
  let stopPermissions: (() => void) | undefined;
  let stopRequested = false;
  const teardown = ownership.hold('host:teardown');
  const teardownErrors: string[] = [];
  const unsubscribe = () => {
    stopRequested = true;
    const stop = stopPermissions;
    stopPermissions = undefined;
    stop?.();
  };
  let inputOwner: ReturnType<typeof createInputs> | undefined;
  const issued = new Set<number>();
  const revoke = (): RevokeTicket => {
    if (ticket) return ticket;
    // Close logical gates before any callback, including abort listeners.
    ticket = frozen({ scope, recovery: [] });
    try {
      unsubscribe();
    } catch (error) {
      teardownErrors.push(String(error));
    }
    controller.abort();
    try {
      ticket = frozen({ scope, recovery: inputOwner?.revoke() ?? [] });
    } catch (error) {
      teardownErrors.push(String(error));
    }
    if (teardownErrors.length) teardown.fail(teardownErrors.join('; '));
    else teardown.done();
    ownership.revoke();
    onRevoke(revoke);
    return ticket;
  };
  const check = (grant: Grant = 'artifact:read') => {
    options.checkOwner?.();
    if (ticket || controller.signal.aborted) throw new ReferenceError('ScopeRevoked');
    if ([...grants].some((value) => !binding.allowed(value))) {
      if (isTransitioning()) revoke();
      else transition(revoke);
      throw new ReferenceError('ScopeRevoked');
    }
    requireThat(!ticket && !controller.signal.aborted, 'ScopeRevoked');
    requireThat(grants.has(grant), 'PermissionDenied');
    requireThat(binding.session.revision.sessionId === scope.sessionId, 'ScopeRevoked');
  };
  let validating = false;
  const validateCandidate = (content: T) => {
    if (!options.strict) return validate(content);
    requireThat(!validating, 'NativeValidationReentrancy');
    validating = true;
    try {
      validate(frozen(content));
    } finally {
      validating = false;
    }
  };
  const read = (): LocalReadSnapshot<T> => {
    check();
    const revision = frozen(binding.session.revision);
    const content = copyData(binding.session.content);
    validateCandidate(content);
    check();
    requireThat(sameLocalRevision(revision, binding.session.revision), 'ReadConflict');
    requireThat(issued.has(revision.sequence) || issued.size < 256, 'SnapshotLimit');
    issued.add(revision.sequence);
    return Object.freeze({ scope, revision, content });
  };
  const editCheck = () => {
    check('artifact:edit');
    if (options.strict) requireThat(options.inputsAvailable, 'InputsUnavailable');
  };
  let editing = false;
  const execute = (command: EditorCommand<T>) => {
    editCheck();
    if (options.strict) requireThat(!validating, 'NativeValidationReentrancy');
    requireThat(!editing, 'EditReentrancy');
    editing = true;
    try {
      binding.session.execute({
        ...command,
        apply: (content) => {
          editCheck();
          const revision = binding.session.revision;
          if (options.strict) {
            validateCandidate(content);
            editCheck();
            requireThat(sameLocalRevision(revision, binding.session.revision), 'EditConflict');
          }
          const next = copyData(command.apply(content));
          validateCandidate(next);
          editCheck();
          if (options.strict)
            requireThat(sameLocalRevision(revision, binding.session.revision), 'EditConflict');
          return next;
        },
      });
    } finally {
      editing = false;
    }
  };
  const flush = () => {
    check();
    const flags = binding.inputs.getSnapshot();
    if (flags.dirty || flags.composing) editCheck();
    binding.inputs.flush();
    check();
  };
  if (options.inputsAvailable)
    inputOwner = createInputs({
      scope,
      registry: binding.inputs,
      policy: policy!,
      store: owner.recovery,
      ownership,
      ownershipFailure: (error) => teardownErrors.push(String(error)),
      check: editCheck,
      currentRevision: () => binding.session.revision,
      issued: (revision: LocalDraftRevision) =>
        revision.kind === 'local-draft' &&
        revision.sessionId === scope.sessionId &&
        issued.has(revision.sequence),
    });
  const history = (direction: 'undo' | 'redo') => {
    editCheck();
    requireThat(!editing, 'EditReentrancy');
    if (!options.strict) {
      binding.session[direction]();
      return;
    }
    requireThat(!validating, 'NativeValidationReentrancy');
    const revision = binding.session.revision;
    editing = true;
    try {
      binding.session[direction]((candidate) => {
        validateCandidate(candidate);
        editCheck();
        requireThat(sameLocalRevision(revision, binding.session.revision), 'EditConflict');
      });
    } finally {
      editing = false;
    }
  };
  const apis = {
    edit: {
      version: 'local-edit@0-draft' as const,
      execute,
      undo: () => history('undo'),
      redo: () => history('redo'),
    },
    inputs: inputOwner?.api,
    lifecycle: {
      version: 'lifecycle@0-draft' as const,
      scope,
      signal: controller.signal,
      assertCurrent: () => check(),
      registerDisposable: (id: string, dispose: () => void | Promise<void>) => {
        check();
        ownership.register(`extension:${id}`, dispose);
      },
    },
    save: {
      version: 'local-persistence@0-draft' as const,
      save: (caller?: AbortSignal) => {
        aborted(caller);
        return owner.saves.save({
          storage: binding.storage!,
          scope,
          signal: controller.signal,
          caller,
          ownership,
          check: () => check('artifact:save'),
          flush,
          capture: read,
          isCurrent: (capture) =>
            !ticket &&
            !controller.signal.aborted &&
            [...grants].every((grant) => binding.allowed(grant)) &&
            // Host permission callbacks may synchronously revoke this scope.
            !ticket &&
            !controller.signal.aborted &&
            sameLocalRevision(capture.revision, binding.session.revision),
        });
      },
    },
    resources: binding.resources
      ? createResources({
          scope,
          signal: controller.signal,
          clock: owner.clock,
          ownership,
          provider: binding.resources,
          check: () => check('resource:read'),
        })
      : undefined,
  };
  const context = contextFor(Object.freeze({ scope, read }), apis);
  const handle: ScopedHandle<C> = {
    scope,
    context,
    mount: (container) => {
      check();
      requireThat(surface && !mounted, 'Mount');
      mounted = true;
      try {
        if (options.strict) read();
        mount!(container, context);
        check();
      } catch (error) {
        transition(revoke);
        throw error;
      }
    },
    requestClose: () =>
      transition(() => {
        try {
          check();
          flush();
        } catch (error) {
          return {
            state: 'blocked',
            reason: controller.signal.aborted
              ? 'scope'
              : error instanceof ReferenceError
                ? 'permission'
                : 'input',
          };
        }
        return { state: 'revoked', ticket: revoke() };
      }),
    revoke: (_reason) => transition(revoke),
    drain: (options) => ownership.drain(options),
  };
  onActive(revoke);
  const subscription = ownership.hold('host:permission-subscription');
  try {
    if (options.strict) read();
    stopPermissions = binding.subscribePermissions(() => {
      if (!controller.signal.aborted && [...grants].some((grant) => !binding.allowed(grant))) {
        if (isTransitioning()) revoke();
        else transition(revoke);
      }
    });
    if (stopRequested) unsubscribe();
    subscription.done();
  } catch (error) {
    subscription.fail(String(error));
    revoke();
    throw error;
  }
  check();
  return Object.freeze(handle);
}
