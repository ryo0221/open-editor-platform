import { useEffect, useRef, type RefObject } from 'react';
import {
  mountAnimationPlayer2,
  type AnimationPlayerOptions2,
} from '@editor-platform/animation-player/v2';
export type MountedAnimationPlayer2 = Awaited<ReturnType<typeof mountAnimationPlayer2>>;
type InputValues = AnimationPlayerOptions2['inputs'];
/** One owner for resources/clock. Controlled input updates use the same atomic
 * setter as imperative consumers, including while an asynchronous mount is pending. */
export function useAnimationPlayer2(
  stage: RefObject<HTMLDivElement | null>,
  options: Omit<AnimationPlayerOptions2, 'signal' | 'initialTick'> & {
    initialTick?: number | (() => number);
    onPreparing(): void;
    onReady(player: MountedAnimationPlayer2): void;
    onInputError(error: unknown): void;
    onInputsApplied(): void;
  },
) {
  const latest = useRef(options);
  latest.current = options;
  const player = useRef<MountedAnimationPlayer2 | undefined>(undefined);
  const updateInputs = useRef<((inputs: InputValues) => void) | undefined>(undefined);
  const { source, compositionId, label, inputs, loop, workArea, autoPlay, clock } = options;
  // A live Host playhead is sampled on attachment, rather than restarting on ticks.
  const initialTick = typeof options.initialTick === 'number' ? options.initialTick : undefined;
  useEffect(() => {
    const abort = new AbortController();
    let owned: MountedAnimationPlayer2 | undefined;
    let preparing = false;
    let desired = latest.current.inputs;
    const release = () => {
      if (player.current === owned) player.current = undefined;
      owned?.dispose();
      owned = undefined;
    };
    const applyInputs = (values: InputValues) => {
      try {
        owned!.setInputs(values ?? []);
        latest.current.onInputsApplied();
      } catch (error) {
        // Refusal preserves the old frame, values, clock and usable controls.
        latest.current.onInputError(error);
      }
    };
    const prepare = async () => {
      preparing = true;
      const attempted = desired;
      latest.current.onPreparing();
      try {
        const mounted = await mountAnimationPlayer2(stage.current!, {
          source,
          compositionId,
          label,
          inputs: attempted,
          loop,
          workArea,
          initialTick:
            typeof latest.current.initialTick === 'function'
              ? latest.current.initialTick()
              : initialTick,
          autoPlay: false,
          clock,
          signal: abort.signal,
          onTick: (tick, playing) => {
            if (owned && !abort.signal.aborted) latest.current.onTick?.(tick, playing);
          },
          onError: (error) => {
            if (!abort.signal.aborted) {
              release();
              latest.current.onError?.(error);
            }
          },
        });
        if (abort.signal.aborted) {
          mounted.dispose();
          return;
        }
        preparing = false;
        owned = mounted;
        player.current = mounted;
        latest.current.onReady(mounted);
        if (desired !== attempted) applyInputs(desired);
        if (autoPlay) mounted.autoPlay();
      } catch (error) {
        if (abort.signal.aborted) return;
        preparing = false;
        release();
        // A newer input may have arrived during a refused asynchronous mount.
        // Retry that value once; an unchanged refusal waits for the next update.
        if (desired !== attempted) void prepare();
        else latest.current.onError?.(error);
      }
    };
    const update = (values: InputValues) => {
      desired = values;
      if (owned) applyInputs(values);
      else if (!preparing) void prepare();
    };
    updateInputs.current = update;
    update(desired);
    return () => {
      abort.abort();
      release();
      if (updateInputs.current === update) updateInputs.current = undefined;
    };
  }, [stage, source, compositionId, label, loop, workArea, autoPlay, clock, initialTick]);
  useEffect(() => updateInputs.current?.(inputs), [inputs]);
  return player;
}
