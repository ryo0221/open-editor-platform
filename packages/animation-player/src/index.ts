import {
  evaluateAnimation,
  type PreparedAnimation,
  type EvaluatedScene,
} from '@editor-platform/animation-core';
/** Scene-only prototype. No renderer, scheduler, history or permanent Host registration. */
export interface ControlledAnimationPlayer {
  sceneAt(tick: number): EvaluatedScene;
}
export function createControlledAnimationPlayer(
  source: PreparedAnimation,
  compositionId: string,
): ControlledAnimationPlayer {
  // Validate source and composition immediately, even before the first requested frame.
  evaluateAnimation(source, compositionId, 0);
  return Object.freeze({
    sceneAt: (tick: number) => evaluateAnimation(source, compositionId, tick),
  });
}
