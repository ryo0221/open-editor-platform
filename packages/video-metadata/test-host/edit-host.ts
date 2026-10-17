import { contentHash as hashContent } from '@editor-platform/artifact-core';
/** Test-only supplied ports. NOT the schema-edit runtime or a SaveCoordinator implementation. */
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import type { VideoContent, VideoEdit, Time } from '@editor-platform/video-core';
import {
  SCHEMA_EDIT_EXPERIMENT_VERSION,
  type SchemaEditContext,
} from '@editor-platform/extension-contract/schema-edit-experiment';
import {
  CONTROLLED_SURFACE_VERSION,
  type ControlledSurfaceController,
  type ControlledSurfaceSnapshot,
  type AtomicSurfaceInputs,
  type PreparedSurfaceCommand,
  type SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
import type { LocalReadSnapshot, SaveOutcome } from '@editor-platform/extension-contract/draft2';
import { submitVideoTimelineEdit, videoTimelineExtension, videoTimelineFixture } from '../src/edit';
export type TestMode =
  | 'normal'
  | 'readonly'
  | 'locked'
  | 'missing-inputs'
  | 'delayed-save'
  | 'indeterminate'
  | 'aborted';
function controllerDouble<T>(context: SchemaEditContext<T>): ControlledSurfaceController<T> {
  let group: AtomicSurfaceInputs<T> | undefined;
  const listeners = new Set<() => void>();
  let view: ControlledSurfaceSnapshot<T>;
  let saving = false;
  const publish = () => {
    view = context.addons.lifecycle.api.signal.aborted
      ? { state: 'revoked', code: 'ScopeRevoked' }
      : {
          state: 'open',
          snapshot: context.basic.read(),
          canEdit:
            context.addons.edit.state === 'granted' && context.addons.inputs.state === 'granted',
          canSave: context.addons.save.state === 'granted',
          saving,
        };
    for (const listener of listeners) listener();
  };
  const refuse = (error: unknown): SurfaceOperation => ({
    state: 'refused',
    code: 'TestBoundary',
    message: String(error),
  });
  const dirty = () => {
    const state = group?.read();
    return !!state && (state.dirty || state.composing);
  };
  const commit = (prepared: PreparedSurfaceCommand<T>): SurfaceOperation => {
    context.addons.lifecycle.api.assertCurrent();
    if (context.addons.edit.state !== 'granted' || context.addons.inputs.state !== 'granted')
      throw Error('ReadOnly');
    if (JSON.stringify(prepared.baseRevision) !== JSON.stringify(context.basic.read().revision))
      throw Error('StaleInput');
    if (!prepared.command) return { state: 'unchanged' };
    context.addons.edit.api.execute(prepared.command);
    return { state: 'applied' };
  };
  const apply = (): SurfaceOperation => {
    context.addons.lifecycle.api.assertCurrent();
    if (!group) return commit({ baseRevision: context.basic.read().revision, command: null });
    if (group.read().composing) throw Error('InputComposing');
    const result = commit(group.prepare(context.basic.read()));
    group.committed(context.basic.read());
    return result;
  };
  publish();
  context.addons.lifecycle.api.signal.addEventListener('abort', publish, { once: true });
  return {
    version: CONTROLLED_SURFACE_VERSION,
    getSnapshot: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    execute(prepared) {
      try {
        if (dirty()) throw Error('PendingInputs');
        const result = commit(prepared);
        publish();
        return result;
      } catch (error) {
        return refuse(error);
      }
    },
    applyInputs() {
      try {
        const result = apply();
        publish();
        return result;
      } catch (error) {
        return refuse(error);
      }
    },
    undo() {
      try {
        context.addons.lifecycle.api.assertCurrent();
        if (dirty()) throw Error('PendingInputs');
        if (context.addons.edit.state !== 'granted') throw Error('ReadOnly');
        context.addons.edit.api.undo();
        publish();
        return { state: 'applied' };
      } catch (error) {
        return refuse(error);
      }
    },
    redo() {
      try {
        context.addons.lifecycle.api.assertCurrent();
        if (dirty()) throw Error('PendingInputs');
        if (context.addons.edit.state !== 'granted') throw Error('ReadOnly');
        context.addons.edit.api.redo();
        publish();
        return { state: 'applied' };
      } catch (error) {
        return refuse(error);
      }
    },
    async save() {
      try {
        if (dirty()) apply();
        if (context.addons.save.state !== 'granted') throw Error('SaveUnavailable');
        saving = true;
        publish();
        const outcome = await context.addons.save.api.save();
        return { state: 'outcome', outcome };
      } catch (error) {
        return { state: 'refused', code: 'TestSave', message: String(error) };
      } finally {
        saving = false;
        publish();
      }
    },
    bindInputs(value) {
      if (group) throw Error('DuplicateInputs');
      group = value;
      // Mirror the supplied Inputs notification boundary; controller behavior
      // remains a test double, not the installed schema-edit implementation.
      const registered =
        context.addons.inputs.state === 'granted'
          ? context.addons.inputs.api.register('test-controller-inputs', {
              label: value.label,
              read: value.read,
              focus: value.focus,
              prepare() {
                const prepared = value.prepare(context.basic.read());
                return () => {
                  commit(prepared);
                  value.committed(context.basic.read());
                  publish();
                };
              },
            })
          : undefined;
      let sequence = 0;
      return {
        changed() {
          publish();
          registered?.changed(++sequence);
        },
        unregister() {
          group = undefined;
          registered?.unregister();
        },
      };
    },
  };
}
export function startVideoTest(mode: TestMode = 'normal', saved?: string) {
  const session = new EditorSession<VideoContent>(
    saved ? JSON.parse(saved) : videoTimelineFixture(mode === 'locked'),
  );
  const abort = new AbortController(),
    inputs = new EditorInputs(),
    disposers: (() => void | Promise<void>)[] = [];
  const scope = { artifactId: 'video', sessionId: 'host-session', generation: crypto.randomUUID() };
  let saveSettled = false;
  let saveCurrentHook: (() => void) | undefined;
  const current = () => {
    if (abort.signal.aborted) throw Error('ScopeRevoked');
  };
  let receipt: SaveOutcome | undefined,
    savedBytes: string | undefined,
    writes = 0,
    executions = 0;
  let release = () => {};
  let savePending = false;
  const context: SchemaEditContext<VideoContent> = {
    contractVersion: SCHEMA_EDIT_EXPERIMENT_VERSION,
    basic: {
      scope,
      read: () => {
        current();
        return { scope, revision: session.revision, content: session.content };
      },
    },
    addons: {
      lifecycle: {
        state: 'granted',
        api: {
          version: 'lifecycle@0-draft',
          scope,
          signal: abort.signal,
          assertCurrent() {
            current();
            if (saveSettled) {
              const hook = saveCurrentHook;
              saveCurrentHook = undefined;
              hook?.();
            }
            current();
          },
          registerDisposable(_id, dispose) {
            disposers.push(dispose);
          },
        },
      },
      edit:
        mode === 'readonly'
          ? { state: 'unavailable', reason: 'permission-denied' }
          : {
              state: 'granted',
              api: {
                version: 'local-edit@0-draft',
                execute(command) {
                  current();
                  executions++;
                  session.execute(command);
                },
                undo() {
                  current();
                  session.undo();
                },
                redo() {
                  current();
                  session.redo();
                },
              },
            },
      inputs:
        mode === 'missing-inputs'
          ? { state: 'unavailable', reason: 'unsupported' }
          : {
              state: 'granted',
              api: {
                version: 'inputs@0-draft',
                getSnapshot: inputs.getSnapshot,
                subscribe: inputs.subscribe,
                register(_id, boundary) {
                  const stop = inputs.register(boundary);
                  return {
                    changed: inputs.changed,
                    unregister: stop,
                    checkpoint() {
                      return { state: 'refused', reason: 'policy' };
                    },
                  };
                },
              },
            },
      save: {
        state: 'granted',
        api: {
          version: 'local-persistence@0-draft',
          async save() {
            current();
            const revision = session.revision,
              bytes = JSON.stringify(session.content);
            const contentHash = await hashContent(JSON.parse(bytes));
            if (mode === 'delayed-save')
              await new Promise<void>((resolve) => {
                savePending = true;
                release = resolve;
              });
            const common = { operationId: 'test-save', capture: { scope, revision, contentHash } };
            if (mode === 'aborted')
              receipt = { ...common, state: 'aborted-before-write', proof: 'not-dispatched' };
            else if (mode === 'indeterminate')
              receipt = { ...common, state: 'indeterminate', reason: 'transport' };
            else {
              writes++;
              savedBytes = bytes;
              receipt = {
                ...common,
                state: 'committed',
                receipt: { adapterReceiptId: 'test-receipt', durability: 'adapter-acknowledged' },
              };
            }
            return receipt;
          },
        },
      },
    },
  };
  let timelineIntents = 0;
  let intentHook: (() => void) | undefined;
  const seekTimes: Time[] = [];
  let editor!: ControlledSurfaceController<VideoContent>;
  const errors: string[] = [];
  videoTimelineExtension('b'.repeat(64), {
    createController(context) {
      const controller = controllerDouble(context);
      return {
        ...controller,
        async save() {
          saveSettled = false;
          const result = await controller.save();
          // Test-only hook targets the Surface continuation, after controller
          // settlement notifications, like a synchronous Host authority callback.
          saveSettled = true;
          return result;
        },
      };
    },
    onTimelineIntent: () => {
      timelineIntents++;
      const hook = intentHook;
      intentHook = undefined;
      hook?.();
    },
    onPlayhead: (at) => {
      seekTimes.push(at);
    },
    onError: (error) => errors.push(String(error)),
    mounted: (value) => {
      editor = value;
    },
  }).mount!(document.querySelector('main')!, context);
  const snapshot = () => context.basic.read();
  return {
    content: () => session.content,
    revision: () => session.revision,
    snapshot,
    errors,
    nonUI: (edit: VideoEdit, base: LocalReadSnapshot<VideoContent> = snapshot()) =>
      submitVideoTimelineEdit(editor, base, edit),
    canRedo: () => session.canRedo,
    // Test-only access to the real Inputs notification boundary for reentry probes.
    subscribeInputs: inputs.subscribe,
    getInputsSnapshot: inputs.getSnapshot,
    controllerSnapshot: () => editor.getSnapshot(),
    timelineEvidence: () => ({ timelineIntents, seekTimes }),
    setIntentHook(hook: () => void) {
      intentHook = hook;
    },
    setSaveCurrentHook(hook: () => void) {
      saveCurrentHook = hook;
    },
    disposeSurface() {
      for (const dispose of disposers) void dispose();
    },
    executions: () => executions,
    saveEvidence: () => ({ receipt, savedBytes, writes }),
    releaseSave: () => release(),
    savePending: () => savePending,
    revoke() {
      abort.abort();
      for (const dispose of disposers) void dispose();
    },
    // Deliberate outside-controller mutation used ONLY to test retained dirty revision refusal.
    drift() {
      session.execute({ type: 'test', label: 'test', apply: (value) => value });
    },
  };
}
type StartTest = typeof startVideoTest;
type TestHost = ReturnType<StartTest>;
declare global {
  var startVideoTest: StartTest;
  var videoTest: TestHost;
}
Object.assign(globalThis, { startVideoTest });
