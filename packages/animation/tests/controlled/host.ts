/** Test-only Host stub; not the #76 production controller or independent Host acceptance. */
import { EditorInputs, EditorSession, sameLocalRevision } from '@editor-platform/editor-core';
import {
  readAnimationV1,
  prepareRectangleAnimationV1,
  putRectangleLayerV1,
  type AnimationContent,
} from '@editor-platform/animation-core';
import {
  mountRectanglePlayerV1,
  type RectanglePlayerV1,
} from '@editor-platform/animation-player/v1';
import type {
  AnimationPlaybackPort,
  AnimationPlaybackSnapshot,
} from '@editor-platform/animation/controlled-contract';
import type {
  AtomicSurfaceInputs,
  ControlledSurfaceController,
  ControlledSurfaceSnapshot,
  SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
import { controlledFixture, controlledMultiFixture } from './data';
export function testHost(readOnly = false, multi = false) {
  const inputs = new EditorInputs();
  let synchronousFlushes = 0;
  const session = new EditorSession<AnimationContent>(
      multi ? controlledMultiFixture() : controlledFixture(),
    ),
    listeners = new Set<() => void>(),
    players = new Set<() => void>();
  const scope = { artifactId: 'test-artifact', sessionId: 'test-host', generation: '1' };
  let saveMode: 'committed' | 'aborted-before-write' | 'indeterminate' = 'committed';
  let group: AtomicSurfaceInputs<AnimationContent> | null = null,
    revoked = false,
    saving = false,
    view: ControlledSurfaceSnapshot<AnimationContent>,
    stored: string | null = null,
    bound = 0,
    attached = 0,
    detached = 0;
  let container: HTMLElement | null = null,
    p: RectanglePlayerV1 | undefined,
    frame = 0,
    generation = 0;
  let playbackView: AnimationPlaybackSnapshot = {
    compositionId: 'root',
    tick: 0,
    duration: 960000,
    ticksPerSecond: 240000,
    playing: false,
    ready: false,
  };
  const snapshot = () => ({ scope, revision: session.revision, content: session.content });
  const publish = () => {
    view = revoked
      ? { state: 'revoked', code: 'ScopeRevoked' }
      : { state: 'open', snapshot: snapshot(), canEdit: !readOnly, canSave: !readOnly, saving };
    listeners.forEach((l) => l());
  };
  const playbackPublish = () => players.forEach((l) => l());
  const pause = () => {
    p?.pause();
    if (p) playbackView = { ...playbackView, tick: p.tick, playing: false };
    playbackPublish();
  };
  const dispose = () => {
    generation++;
    cancelAnimationFrame(frame);
    p?.dispose();
    p = undefined;
    playbackView = { ...playbackView, ready: false, playing: false };
  };
  const rebuild = async () => {
    const g = ++generation;
    cancelAnimationFrame(frame);
    p?.dispose();
    p = undefined;
    playbackView = { ...playbackView, ready: false };
    playbackPublish();
    const source = await prepareRectangleAnimationV1(session.content);
    if (g !== generation || revoked || !container) return;
    p = mountRectanglePlayerV1(container, {
      source,
      compositionId: playbackView.compositionId,
      label: 'Host-owned Player',
    });
    p.seek(playbackView.tick);
    playbackView = { ...playbackView, ready: true };
    playbackPublish();
    const sync = () => {
      if (!p || revoked) return;
      playbackView = { ...playbackView, tick: p.tick, playing: p.playing };
      playbackPublish();
      frame = requestAnimationFrame(sync);
    };
    frame = requestAnimationFrame(sync);
  };
  const refuse = (message: string): Extract<SurfaceOperation, { state: 'refused' }> => ({
    state: 'refused',
    code: 'TestRefusal',
    message,
  });
  const pending = () => !!group && (group.read().dirty || group.read().composing);
  function apply(): SurfaceOperation {
    if (revoked || readOnly) return refuse('Editing unavailable');
    try {
      const prepared = group?.prepare(snapshot());
      if (prepared && !sameLocalRevision(prepared.baseRevision, session.revision))
        return refuse('Stale revision');
      pause();
      if (prepared?.command) session.execute(prepared.command);
      group?.committed(snapshot());
      publish();
      void rebuild();
      return { state: prepared?.command ? 'applied' : 'unchanged' };
    } catch (e) {
      group?.focus();
      return refuse(String(e));
    }
  }
  const editor: ControlledSurfaceController<AnimationContent> = {
    version: 'controlled-surface@0-experiment',
    getSnapshot: () => view,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    bindInputs: (g) => {
      if (group) throw new Error('Duplicate input group');
      group = g;
      bound++;
      const unregister = inputs.register({
        label: g.label,
        read: () => g.read(),
        prepare: () => {
          g.prepare(snapshot());
          return () => apply().state !== 'refused';
        },
        focus: () => g.focus(),
      });
      return {
        changed: () => {
          publish();
          inputs.changed();
        },
        unregister: () => {
          unregister();
          group = null;
          bound--;
        },
      };
    },
    applyInputs: apply,
    execute(prepared) {
      if (revoked || readOnly || saving || pending())
        return refuse('Blocked authority or pending input');
      if (!sameLocalRevision(prepared.baseRevision, session.revision))
        return refuse('Stale revision');
      try {
        pause();
        if (prepared.command) session.execute(prepared.command);
        publish();
        void rebuild();
        return { state: prepared.command ? 'applied' : 'unchanged' };
      } catch (e) {
        return refuse(String(e));
      }
    },
    undo() {
      if (revoked || readOnly || saving || pending()) return refuse('Pending input');
      pause();
      session.undo();
      publish();
      void rebuild();
      return { state: 'applied' };
    },
    redo() {
      if (revoked || readOnly || saving || pending()) return refuse('Pending input');
      pause();
      session.redo();
      publish();
      void rebuild();
      return { state: 'applied' };
    },
    async save() {
      if (revoked || readOnly || saving) return refuse('Save unavailable');
      const applied = apply();
      if (applied.state === 'refused') return applied;
      saving = true;
      publish();
      const captured = snapshot();
      const source = await prepareRectangleAnimationV1(captured.content);
      if (revoked) {
        saving = false;
        return refuse('Scope revoked');
      }
      if (saveMode === 'committed') stored = JSON.stringify(captured.content);
      saving = false;
      publish();
      const capture = { scope, revision: captured.revision, contentHash: source.contentHash };
      if (saveMode === 'aborted-before-write')
        return {
          state: 'outcome',
          outcome: { state: saveMode, operationId: 'test-save', capture, proof: 'not-dispatched' },
        };
      if (saveMode === 'indeterminate')
        return {
          state: 'outcome',
          outcome: {
            state: saveMode,
            operationId: 'test-save',
            capture,
            reason: 'adapter-unknown',
          },
        };
      return {
        state: 'outcome',
        outcome: {
          state: 'committed',
          operationId: 'test-save',
          capture: { scope, revision: captured.revision, contentHash: source.contentHash },
          receipt: { adapterReceiptId: 'volatile-test', durability: 'adapter-acknowledged' },
        },
      };
    },
  };
  const playback: AnimationPlaybackPort = {
    getSnapshot: () => playbackView,
    subscribe: (l) => {
      players.add(l);
      return () => {
        players.delete(l);
      };
    },
    attach: (el) => {
      attached++;
      container = el;
      void rebuild();
      return () => {
        detached++;
        container = null;
        dispose();
      };
    },
    selectComposition: (id) => {
      if (pending()) return refuse('Pending input');
      playbackView = { ...playbackView, compositionId: id, tick: 0 };
      void rebuild();
      return { state: 'applied' };
    },
    play: () => {
      p?.play();
      return { state: 'applied' };
    },
    pause: () => {
      pause();
      return { state: 'applied' };
    },
    seek: (tick) => {
      p?.seek(tick);
      playbackView = { ...playbackView, tick };
      playbackPublish();
      return { state: 'applied' };
    },
    setRate: (rate) => {
      p?.setRate(rate);
      return { state: 'applied' };
    },
  };
  publish();
  return {
    editor,
    playback,
    cloneView: publish,
    armSynchronousFlush(mode: 'applyInputs' | 'flush') {
      const unsubscribe = inputs.subscribe(() => {
        if (!inputs.getSnapshot().dirty) return;
        unsubscribe();
        synchronousFlushes++;
        if (mode === 'flush') inputs.flush();
        else editor.applyInputs();
      });
    },
    setSaveMode(mode: typeof saveMode) {
      saveMode = mode;
    },
    revoke() {
      revoked = true;
      dispose();
      publish();
    },
    inspect: () => ({
      synchronousFlushes,
      content: session.content,
      revision: session.revision,
      stored,
      bound,
      attached,
      detached,
      pending: pending(),
    }),
    nonUI() {
      const c = readAnimationV1(session.content),
        l = c.compositions[0].layers[0];
      return editor.execute({
        baseRevision: session.revision,
        command: putRectangleLayerV1(
          c,
          'root',
          { ...l, transform: { ...l.transform, y: 200 } },
          { canEdit: () => !revoked && !readOnly },
        ),
      });
    },
  };
}
