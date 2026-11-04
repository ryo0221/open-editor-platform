import type { CharacterAction } from '@editor-platform/character-core';

/**
 * The view's transport: which action plays, where the playhead is (ticks, 240,000 per second)
 * and whether it runs. View state only; it never enters the document or its history.
 */
export interface Playback {
  actionId: string | null;
  tick: number;
  playing: boolean;
  loop: boolean;
}
export const ticksPerSecond = 240_000;
export const restPlayback = (actionId: string | null = null): Playback => ({
  actionId,
  tick: 0,
  playing: false,
  loop: true,
});

/** Moves the playhead by real time; at the end it wraps (loop) or stops on the last tick. */
export function advance(p: Playback, action: CharacterAction | null, elapsedMs: number): Playback {
  if (!p.playing || !action) return p;
  const step = Math.max(0, Math.round(elapsedMs * (ticksPerSecond / 1000)));
  const tick = p.tick + step;
  if (tick <= action.duration) return { ...p, tick };
  if (p.loop && action.duration > 0) return { ...p, tick: tick % action.duration };
  return { ...p, tick: action.duration, playing: false };
}
/** Play from where the playhead is; from the start again when it stopped at the end. */
export function play(p: Playback, action: CharacterAction | null): Playback {
  if (!action) return p;
  return { ...p, playing: true, tick: p.tick >= action.duration ? 0 : p.tick };
}
export const pause = (p: Playback): Playback => ({ ...p, playing: false });
/** Stop: halt and return to the start, where the action's first keys hold. */
export const stop = (p: Playback): Playback => ({ ...p, playing: false, tick: 0 });
export function seek(p: Playback, action: CharacterAction | null, tick: number): Playback {
  const end = action?.duration ?? 0;
  return { ...p, tick: Math.min(Math.max(Math.round(tick), 0), end) };
}
export const choose = (p: Playback, actionId: string | null): Playback => ({
  ...restPlayback(actionId),
  loop: p.loop,
});
/** Seconds with two decimals, for the readout beside the slider. */
export const formatTicks = (tick: number) => `${(tick / ticksPerSecond).toFixed(2)} s`;
