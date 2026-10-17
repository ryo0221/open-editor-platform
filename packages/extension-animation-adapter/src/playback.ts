import {
  readAnimationV1,
  prepareRectangleAnimationV1,
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
  ControlledSurfaceController,
  SurfaceOperation,
} from '@editor-platform/extension-contract/controlled-surface';
import type { Context } from '@editor-platform/extension-contract/draft2';
/** Player presentation is adapter-owned; native mutation/history still belong to Core. */
export function createPlayback(
  editor: ControlledSurfaceController<AnimationContent>,
  context: Context<AnimationContent, never>,
  onError: (error: unknown) => void,
): AnimationPlaybackPort {
  if (context.addons.lifecycle.state !== 'granted') throw Error('LifecycleUnavailable');
  const lifecycle = context.addons.lifecycle.api,
    listeners = new Set<() => void>(),
    pending = new Set<Promise<void>>();
  let player: RectanglePlayerV1 | undefined,
    container: HTMLElement | undefined,
    closed = false,
    generation = 0,
    frame = 0,
    rate = 1,
    revision = -1;
  const initial = editor.getSnapshot();
  if (initial.state !== 'open') throw Error('ScopeRevoked');
  const native = readAnimationV1(initial.snapshot.content),
    composition = native.compositions.find((c) => c.id === native.rootCompositionId)!;
  let view: AnimationPlaybackSnapshot = Object.freeze({
    compositionId: composition.id,
    tick: 0,
    duration: composition.duration,
    ticksPerSecond: 240000,
    playing: false,
    ready: false,
  });
  const failures: unknown[] = [];
  const report = (error: unknown) => {
    failures.push(error);
    try {
      onError(error);
    } catch (failure) {
      failures.push(failure);
    }
  };
  const publish = (next: Partial<AnimationPlaybackSnapshot>) => {
    view = Object.freeze({ ...view, ...next });
    for (const listener of [...listeners])
      try {
        listener();
      } catch (error) {
        report(error);
      }
  };
  const current = () => {
    if (closed) throw Error('ScopeRevoked');
    lifecycle.assertCurrent();
    const snapshot = editor.getSnapshot();
    if (snapshot.state !== 'open') throw Error('ScopeRevoked');
    return snapshot;
  };
  const stopPlayer = () => {
    generation++;
    cancelAnimationFrame(frame);
    frame = 0;
    player?.dispose();
    player = undefined;
  };
  const pause = () => {
    if (player) {
      player.pause();
      publish({ tick: player.tick, playing: false });
    }
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const pump = (token: number) => {
    if (closed || token !== generation) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      try {
        if (closed || token !== generation) return;
        current();
        if (!player) return;
        publish({ tick: player.tick, playing: player.playing });
        if (!closed && token === generation && player?.playing) pump(token);
      } catch (error) {
        stopPlayer();
        if (!lifecycle.signal.aborted) report(error);
      }
    });
  };
  const rebuild = () => {
    if (closed || !container) return;
    const snapshot = current();
    stopPlayer();
    const token = generation;
    const native = readAnimationV1(snapshot.snapshot.content),
      composition =
        native.compositions.find((c) => c.id === view.compositionId) ??
        native.compositions.find((c) => c.id === native.rootCompositionId)!;
    revision = snapshot.snapshot.revision.sequence;
    // Own acquisition before publishing: a synchronous subscriber may revoke the scope.
    let done!: () => void;
    const hold = new Promise<void>((resolve) => {
      done = resolve;
    });
    pending.add(hold);
    publish({
      compositionId: composition.id,
      duration: composition.duration,
      tick: Math.min(view.tick, composition.duration),
      playing: false,
      ready: false,
      error: undefined,
    });
    const work = async () => {
      try {
        const source = await prepareRectangleAnimationV1(snapshot.snapshot.content);
        if (closed || token !== generation || !container) return;
        const next = current();
        if (next.snapshot.revision.sequence !== revision) return;
        player = mountRectanglePlayerV1(container, {
          source,
          compositionId: composition.id,
          label: 'Adapter-owned Animation Player',
          signal: lifecycle.signal,
        });
        current();
        if (closed || token !== generation) {
          player.dispose();
          player = undefined;
          return;
        }
        player.setRate(rate);
        player.seek(view.tick);
        publish({ tick: player.tick, ready: true });
      } catch (error) {
        if (!closed && token === generation) {
          stopPlayer();
          publish({ ready: false, error: String(error) });
          report(error);
        }
      } finally {
        pending.delete(hold);
        done();
      }
    };
    void work();
  };
  const stop = editor.subscribe(() => {
    const snapshot = editor.getSnapshot();
    if (snapshot.state === 'revoked') return;
    if (snapshot.snapshot.revision.sequence !== revision) rebuild();
  });
  const abort = () => {
    if (closed) return;
    closed = true;
    stopPlayer();
    container = undefined;
    stop();
    publish({ ready: false, playing: false, error: 'ScopeRevoked' });
  };
  lifecycle.registerDisposable('animation-player', async () => {
    abort();
    lifecycle.signal.removeEventListener('abort', abort);
    await Promise.all([...pending]);
    listeners.clear();
    if (failures.length) throw new AggregateError(failures, 'Animation Player failures');
  });
  lifecycle.signal.addEventListener('abort', abort, { once: true });
  const act = (work: () => void): SurfaceOperation => {
    try {
      current();
      work();
      return { state: 'applied' };
    } catch (error) {
      return {
        state: 'refused',
        code: error instanceof Error ? error.message : 'PlaybackFailed',
        message: String(error),
      };
    }
  };
  return Object.freeze({
    getSnapshot: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach(element: HTMLElement) {
      current();
      if (container) throw Error('PlayerAlreadyAttached');
      container = element;
      rebuild();
      return () => {
        if (container !== element) return;
        stopPlayer();
        container = undefined;
        publish({ ready: false, playing: false });
      };
    },
    selectComposition(id: string) {
      return act(() => {
        if (context.addons.inputs.state === 'granted') {
          const inputs = context.addons.inputs.api.getSnapshot();
          if (inputs.dirty || inputs.composing) throw Error('PendingInputs');
        }
        const native = readAnimationV1(current().snapshot.content);
        if (!native.compositions.some((c) => c.id === id)) throw Error('CompositionMissing');
        pause();
        publish({ compositionId: id, tick: 0 });
        rebuild();
      });
    },
    play: () =>
      act(() => {
        if (!player) throw Error('PlayerNotReady');
        const token = generation;
        player.play();
        publish({ playing: player.playing });
        pump(token);
      }),
    pause: () => act(pause),
    seek: (tick: number) =>
      act(() => {
        if (!player) throw Error('PlayerNotReady');
        player.seek(tick);
        publish({ tick: player.tick, playing: player.playing });
      }),
    setRate: (next: number) =>
      act(() => {
        if (!player) throw Error('PlayerNotReady');
        player.setRate(next);
        rate = next;
      }),
  });
}
