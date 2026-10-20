import { useLayoutEffect, useRef, useState } from 'react';
import type { AnimationContentV1 } from '@editor-platform/animation-core';
import type { EditorCommand, EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { AnimationControlledSurface } from './controlled';
import { createAnimationPlayback } from './playback';
import { createLocalAnimationController } from './local-controller';
import type { AnimationPlaybackPort } from './controlled-contract';
export interface AnimationSurfaceProps {
  artifactId: string;
  content: AnimationContentV1;
  session: EditorSession<AnimationContentV1>;
  inputs: EditorInputs;
  readOnly: boolean;
  saving?: boolean;
  execute(command: EditorCommand<AnimationContentV1>): boolean | void;
  history(direction: 'undo' | 'redo'): void;
  onError(error: unknown): void;
}
export function AnimationSurface(props: AnimationSurfaceProps) {
  const latest = useRef(props);
  latest.current = props;
  const bridge = useRef<ReturnType<typeof createLocalAnimationController>>(undefined);
  const [mounted, setMounted] = useState<{
    bridge: ReturnType<typeof createLocalAnimationController>;
    playback: AnimationPlaybackPort;
  }>();
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    let alive = true;
    const adapter = createLocalAnimationController({
      artifactId: props.artifactId,
      session: props.session,
      inputs: props.inputs,
      isSaving: () => !!latest.current.saving,
      canEdit: () =>
        latest.current.session === props.session &&
        latest.current.artifactId === props.artifactId &&
        !latest.current.readOnly,
      execute: (command) => latest.current.execute(command),
      history: (direction) => latest.current.history(direction),
      beforeMutation: () => {
        playback?.pause();
      },
      onError: (error) => latest.current.onError(error),
    });
    bridge.current = adapter;
    const playback = createAnimationPlayback(
      adapter.controller,
      adapter.lifecycle,
      (error) => {
        if (alive) setError(String(error));
        latest.current.onError(error);
      },
      () => {
        const state = props.inputs.getSnapshot();
        return !!(state.dirty || state.composing);
      },
    );
    setMounted({ bridge: adapter, playback });
    return () => {
      alive = false;
      bridge.current = undefined;
      void adapter.dispose().catch((error) => latest.current.onError(error));
    };
  }, [props.artifactId, props.session, props.inputs]);
  useLayoutEffect(() => {
    bridge.current?.notify();
  }, [props.content, props.readOnly, props.saving]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {mounted && (
        <AnimationControlledSurface
          editor={mounted.bridge.controller}
          playback={mounted.playback}
          hostActions="external"
        />
      )}
    </>
  );
}
