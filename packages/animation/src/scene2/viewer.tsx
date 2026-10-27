import { useMemo, useRef, useState } from 'react';
import {
  frameStep2,
  prepareAnimation2,
  type AnimationContent2,
  type AnimationInputValues2,
  type AnimationEmbed2,
} from '@editor-platform/animation-core/v2';
import { useAnimationPlayer2 } from './use-player';
const seconds = (tick: number) => (tick / 240000).toFixed(2) + ' s';
/** Playback position for people: seconds of the whole and the frame on the composition grid. */
export function animationPositionLabel2(tick: number, duration: number, step: number) {
  return `${seconds(tick)} / ${seconds(duration)} · Frame ${Math.floor(tick / step)}`;
}
export interface AnimationReactPlayerProps2 {
  content: AnimationContent2;
  compositionId?: string;
  inputs?: AnimationInputValues2;
  label: string;
  posterTick?: number;
  loop?: boolean;
  autoPlay?: boolean;
  controls?: boolean;
}
/** Thin React wrapper over the same resource/evaluation/clock implementation as all other consumers. */
export function AnimationReactPlayer2(props: AnimationReactPlayerProps2) {
  const source = useMemo(() => prepareAnimation2(props.content), [props.content]),
    stage = useRef<HTMLDivElement>(null),
    [state, setState] = useState({ tick: props.posterTick ?? 0, playing: false, ready: false }),
    [error, setError] = useState('');
  const id = props.compositionId ?? props.content.rootCompositionId,
    c = props.content.compositions.find((c) => c.id === id)!,
    position = animationPositionLabel2(state.tick, c.duration, frameStep2(c));
  const player = useAnimationPlayer2(stage, {
    source,
    compositionId: id,
    label: props.label,
    inputs: props.inputs,
    loop: props.loop,
    initialTick: props.posterTick ?? 0,
    autoPlay: props.autoPlay,
    onPreparing: () => setState((s) => ({ ...s, ready: false })),
    onTick: (tick, playing) => setState({ tick, playing, ready: true }),
    onError: (error) => {
      setError(String(error));
      setState((s) => ({ ...s, ready: false, playing: false }));
    },
    onInputError: (error) => setError(String(error)),
    onInputsApplied: () => setError(''),
    onReady: (p) => {
      setState({ tick: p.tick, playing: p.playing, ready: true });
      setError('');
    },
  });
  return (
    <section
      aria-label={`Animation: ${props.label}`}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <div ref={stage} style={{ position: 'absolute', inset: 0 }} />
      {error && <p role="alert">{error}</p>}
      {props.controls !== false && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            display: 'flex',
            gap: 6,
            background: '#ffffffed',
            width: '100%',
            alignItems: 'center',
          }}
        >
          <button
            aria-label={state.playing ? 'Pause animation' : 'Play animation'}
            disabled={!state.ready}
            onClick={() => {
              const p = player.current!;
              if (p.playing) p.pause();
              else {
                p.play();
                setState((s) => ({ ...s, playing: true }));
              }
            }}
          >
            {state.playing ? 'Pause' : 'Play'}
          </button>
          <input
            aria-label="Animation tick"
            type="range"
            min={0}
            max={c.duration}
            value={state.tick}
            aria-valuetext={position}
            disabled={!state.ready}
            style={{ minWidth: 0, flex: 1 }}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') e.stopPropagation();
            }}
            onChange={(e) => {
              try {
                player.current?.pause();
                player.current?.seek(Number(e.target.value));
              } catch (error) {
                // The common Player already reported a refused draw and disposed
                // its resources; the synchronous seek refusal must stay in the UI.
                setError((message) => message || String(error));
                setState((s) => ({ ...s, ready: false, playing: false }));
              }
            }}
          />
          <output style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {position}
          </output>
        </div>
      )}
    </section>
  );
}
export function AnimationViewer2({
  animation,
  ...props
}: {
  animation: AnimationEmbed2;
  autoPlay?: boolean;
  controls?: boolean;
}) {
  return (
    <AnimationReactPlayer2
      content={animation.snapshot}
      compositionId={animation.source.compositionId}
      inputs={animation.inputs}
      label={animation.label}
      loop={animation.loop}
      posterTick={animation.posterTick}
      {...props}
    />
  );
}
